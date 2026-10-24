/*
 * Copyright 2026 Ben Humbert
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * The engine reads no request body past the sequencer's own limit, and register-member checks a wallet ID before
 * anything parses it.
 *
 * What was wrong, found by the sweep of the open routes (2026-10-24): the engine's routes read their bodies with no
 * limit, while the sequencer's own reads stop at its limit. register-member and verify-credential take no credential,
 * so one request to either could make the sequencer hold any amount of text in memory, then parse it. register-member
 * also handed the caller's walletId to the engine, whose first step is BigInt(walletId): BigInt reads every digit it is
 * given, and ten million digits hold the sequencer's one thread for about four seconds.
 *
 * Now a body that declares more than the engine reads (the sequencer's own limit) is answered 413 before any of it is
 * read, nothing of it reaches the engine, and the sequencer serves the next request. A body sent in chunks, with no
 * length to answer from, is read no further than the same limit. register-member refuses a wallet ID that is not a field
 * element written in decimal (A-74), as it refuses a name that is not a short line of plain text (A-61), before the
 * engine sees either.
 *
 * A real sequencer server with a stand-in engine that records what reaches it; for the chunked body, the engine's own
 * handler on a plain Node server, so the sequencer's request budget does not outlive the connection the read closes.
 */
import http from 'http';
import type { AddressInfo } from 'net';
import { Field, MerkleTree } from 'o1js';
import { InMemoryStore } from '../src/storage/local-store.js';
import { WALLET_TREE_HEIGHT } from '../src/wallets/wallet-state.js';
import { L2Node } from '../src/l2/l2-node.js';
import { L2RpcServer, DEFAULT_RPC_SERVER_OPTIONS } from '../src/l2/l2-rpc-server.js';
import { registerInteractiveRoutes } from '../src/adjudication/interactive-routes.js';

jest.setTimeout(60_000);

const OPERATOR = 'operator-token-for-tests';
const bearer = { Authorization: `Bearer ${OPERATOR}` };
const emptyRoot = new MerkleTree(WALLET_TREE_HEIGHT).getRoot();
/** The sequencer's own body limit; the engine reads under the same one. */
const LIMIT = DEFAULT_RPC_SERVER_OPTIONS.maxBodyBytes;
/** Text that makes any body longer than LIMIT. */
const OVER = 'x'.repeat(LIMIT);
const MEMBER = { walletId: '1001', ownershipProofJson: '{"stand-in":true}', displayName: 'Avery' };

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;

/** What reached the stand-in engine, by method. */
const reached: Record<string, unknown[]> = { registerMemberFromEnrollment: [], verifyCredential: [], approveMember: [] };

/** Only what the routes under test call; anything else throws, so a wider dependency shows up. */
function standInEngine() {
  const l2 = { withProvingLock: (fn: () => Promise<unknown>) => Promise.resolve().then(fn) };
  const own: Record<string, unknown> = {
    isProvingReady: () => true,
    getL2Node: () => l2,
    getState: () => ({ compiled: true, enrolledMembers: [] }),
    registerMemberFromEnrollment: async (opts: { walletId: string; displayName: string }) => {
      reached.registerMemberFromEnrollment.push(opts);
      return { walletId: opts.walletId, displayName: opts.displayName };
    },
    verifyCredential: async (credentialJson: string) => { reached.verifyCredential.push(credentialJson); return { valid: true }; },
    approveMember: (approval: { walletId: string }) => { reached.approveMember.push(approval); return { approved: true, alreadyApproved: false }; },
  };
  return new Proxy(own, {
    get(t, p) {
      if (p in t) return t[p as string];
      if (typeof p === 'string' && p !== 'then') throw new Error(`stand-in engine has no ${p}`);
      return undefined;
    },
  });
}

let server: L2RpcServer;
let url: string;

async function post(p: string, body: string, headers: Record<string, string> = {}) {
  const r = await fetch(url + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
  const text = await r.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: r.status, json };
}

/** POST a body in chunks, with no Content-Length; resolves with the status and body, or the error the connection ended in. */
function postChunked(port: number, p: string, parts: string[]): Promise<string> {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
      let text = '';
      res.setEncoding('utf-8');
      res.on('data', (c: string) => { text += c; });
      res.on('end', () => resolve(`${res.statusCode} ${text}`));
    });
    req.on('error', (err: NodeJS.ErrnoException) => resolve(`error ${err.code ?? err.message}`));
    let i = 0;
    const pump = (): void => {
      while (i < parts.length) {
        if (!req.write(parts[i++])) { req.once('drain', pump); return; }
      }
      req.end();
    };
    pump();
  });
}

beforeAll(async () => {
  const node = new L2Node({ batchIntervalMs: 999_999, autoSettle: false, nodeId: 'seq-engine-body-limit' }, new InMemoryStore(), emptyRoot, emptyRoot, Field(0));
  server = new L2RpcServer(node, { port: 0, host: '127.0.0.1', adminToken: OPERATOR, enableSSE: false });
  registerInteractiveRoutes(server, standInEngine() as any);
  await server.start();
  url = `http://127.0.0.1:${server.getPort()}`;
});

afterAll(async () => { await server.stop(); });

beforeEach(() => { for (const calls of Object.values(reached)) calls.length = 0; });

describe('a body longer than the engine reads', () => {
  test('register-member answers 413 before reading it, hands the engine nothing, and serves the next request', async () => {
    const big = JSON.stringify({ ...MEMBER, ownershipProofJson: OVER });
    const refused = await post('/interactive/register-member', big);
    expect(refused.status).toBe(413);                                              // before: 200, the whole body read, parsed and handed to the engine
    expect(refused.json?.error).toBe(`The engine reads a request body of at most ${LIMIT} bytes; this one declares ${Buffer.byteLength(big)}`); // before: undefined, the engine's answer
    expect(reached.registerMemberFromEnrollment).toHaveLength(0);                 // before: 1, every byte of the body with it
    const next = await post('/interactive/register-member', JSON.stringify(MEMBER));
    expect(next.status).toBe(200);
    expect(reached.registerMemberFromEnrollment).toEqual([expect.objectContaining({ walletId: '1001', displayName: 'Avery' })]);
  });

  test('verify-credential answers 413 the same way, and verifies the next credential', async () => {
    const refused = await post('/interactive/verify-credential', JSON.stringify({ credentialJson: OVER }));
    expect(refused.status).toBe(413);                                              // before: 200, the whole body read and the credential verified under the proving lock
    expect(reached.verifyCredential).toHaveLength(0);                             // before: 1
    const next = await post('/interactive/verify-credential', JSON.stringify({ credentialJson: '{"stand-in":true}' }));
    expect(next.status).toBe(200);
    expect(next.json).toEqual({ valid: true });
    expect(reached.verifyCredential).toEqual(['{"stand-in":true}']);
  });

  test('the limit is every engine route\'s: the operator\'s own body to a gated write is answered 413 too', async () => {
    // The gate reads the body of a signed request only, so a bearer's body was the handler's to read, whole
    const approval = { walletId: '1001', groupIdHash: '777', planIdHash: '888', planId: 'PLAN-1' };
    const refused = await post('/interactive/approve-member', JSON.stringify({ ...approval, employerId: OVER }), bearer);
    expect(refused.status).toBe(413);                                              // before: 200, the whole body read and the approval kept
    expect(reached.approveMember).toHaveLength(0);                                // before: 1, its employerId twenty megabytes long
    expect((await post('/interactive/approve-member', JSON.stringify(approval), bearer)).status).toBe(200);
    expect(reached.approveMember).toHaveLength(1);
  });

  test('a body sent in chunks, with no length to answer from, is read no further than the limit, and the next request is served', async () => {
    // The handler the engine registers for register-member, as the sequencer calls it for a route that needs no credential
    const routes = new Map<string, Handler>();
    const capture = { registerRoute: (method: string, p: string, handler: Handler) => { routes.set(`${method}:${p}`, handler); }, setMemberCostQuoteProvider: () => {} };
    registerInteractiveRoutes(capture as any, standInEngine() as any);
    const registerMember = routes.get('POST:/interactive/register-member')!;
    const plain = http.createServer((req, res) => { void registerMember(req, res); });
    await new Promise<void>((resolve) => plain.listen(0, '127.0.0.1', resolve));
    const port = (plain.address() as AddressInfo).port;
    try {
      const head = '{"walletId":"1001","displayName":"Avery","ownershipProofJson":"';
      const chunk = 'x'.repeat(64 * 1024);
      const parts = [head, ...Array.from({ length: Math.ceil(LIMIT / chunk.length) + 16 }, () => chunk), '"}'];
      const outcome = await postChunked(port, '/interactive/register-member', parts);
      expect(outcome).toMatch(/^error /);                                          // before: 200, the whole body read, parsed and handed to the engine
      expect(reached.registerMemberFromEnrollment).toHaveLength(0);               // before: 1
      expect(await postChunked(port, '/interactive/register-member', [JSON.stringify(MEMBER)])).toMatch(/^200 /);
      expect(reached.registerMemberFromEnrollment).toHaveLength(1);
    } finally {
      await new Promise<void>((resolve) => plain.close(() => resolve()));
    }
  });
});

describe('register-member', () => {
  test('refuses a wallet ID that is not a field element written in decimal before the engine parses it', async () => {
    // Each reached the engine, whose first step is BigInt(walletId): the long one holds the sequencer's thread, and
    // several name another wallet once parsed (0x3e9, ' 1001' and '01001' are 1001; the modulus is 0 as a field element)
    for (const walletId of ['9'.repeat(100_000), '0x3e9', '1e3', ' 1001', '01001', '-1', Field.ORDER.toString(), 1001]) {
      const r = await post('/interactive/register-member', JSON.stringify({ ...MEMBER, walletId }));
      const shown = String(walletId).slice(0, 12);
      expect([shown, r.status, r.json?.error]).toEqual([shown, 400, expect.stringMatching(/^walletId must be /)]); // before: 200, handed to the engine
    }
    expect(reached.registerMemberFromEnrollment).toEqual([]);                    // before: all eight reached it
    expect((await post('/interactive/register-member', JSON.stringify(MEMBER))).status).toBe(200);
  });
});
