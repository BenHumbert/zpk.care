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
 * Every engine write needs a credential, the no-proof claim path is gone, and the event streams
 * answer credentials only — plan item D2, finding A-27 and the auth inventory's open writes.
 *
 * On a real sequencer server with a stand-in engine: the console routes that write refuse an
 * anonymous caller; the operator passes the gate; a prescriber node key passes prescribe and not
 * fill, a pharmacy node key the reverse, a member key neither; register-member and
 * verify-credential stay reachable because they carry their own credential or change nothing; the
 * member-data reads among the GET routes — the console's and the `/node/*` mirror of the sequencer's
 * — need a credential while the chain's own state does not; `l2_recordFill` is not a method; the
 * admission registers answer the operator only; the event streams refuse an anonymous subscriber
 * and admit the operator's token and a node's signature.
 */
import { Field, MerkleTree } from 'o1js';
import { InMemoryStore } from '../src/storage/local-store.js';
import { WALLET_TREE_HEIGHT } from '../src/wallets/wallet-state.js';
import { L2Node } from '../src/l2/l2-node.js';
import { L2RpcServer, RPC_UNAUTHORIZED } from '../src/l2/l2-rpc-server.js';
import { registerInteractiveRoutes } from '../src/adjudication/interactive-routes.js';
import { generateNodeKey } from '../src/security/node-roles.js';
import { signRequest, privateKeyFromSeedHex } from '../src/security/signed-request.js';

jest.setTimeout(60_000);

const OPERATOR = 'operator-token-for-tests';
const emptyRoot = new MerkleTree(WALLET_TREE_HEIGHT).getRoot();
const prescriberNode = generateNodeKey('prescriber-node');
const pharmacyNode = generateNodeKey('pharmacy-node');
const memberNode = generateNodeKey('member-node');

let server: L2RpcServer;
let url: string;

/**
 * An engine that does nothing: every method is a no-op, so a request that passes the gate ends in
 * whatever the handler makes of an empty answer (200 or 500) and never in 401 or 403, which is the
 * only distinction this suite draws.
 */
function standInService() {
  const svc = { getState() { return { compiled: true, enrolledMembers: [] }; } };
  return new Proxy(svc, { get(t, p) { if (p in t) return (t as any)[p]; return typeof p === 'string' && p !== 'then' ? () => undefined : undefined; } });
}

async function post(p: string, body: unknown, headers: Record<string, string> = {}) {
  const text = JSON.stringify(body);
  const r = await fetch(url + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: text });
  return { status: r.status, text: await r.text() };
}
const bearer = { Authorization: `Bearer ${OPERATOR}` };
const byNode = (key: ReturnType<typeof generateNodeKey>, method: string, p: string, body?: unknown) =>
  signRequest({ signerId: key.nodeId, privateKey: privateKeyFromSeedHex(key.seedHex), method, path: p, body: body === undefined ? undefined : JSON.stringify(body) });

beforeAll(async () => {
  const node = new L2Node({ batchIntervalMs: 999_999, autoSettle: false, nodeId: 'seq-write-gates' }, new InMemoryStore(), emptyRoot, emptyRoot, Field(0));
  server = new L2RpcServer(node, { port: 0, host: '127.0.0.1', adminToken: OPERATOR, enableSSE: true, maxSseConnections: 10 });
  server.registerNodeKey(prescriberNode.nodeId, prescriberNode.publicKeyHex, 'prescriber');
  server.registerNodeKey(pharmacyNode.nodeId, pharmacyNode.publicKeyHex, 'pharmacy');
  server.registerNodeKey(memberNode.nodeId, memberNode.publicKeyHex, 'member');
  registerInteractiveRoutes(server, standInService() as any);
  await server.start();
  url = `http://127.0.0.1:${server.getPort()}`;
});

afterAll(async () => { await server.stop(); });

const gated = (s: number) => s === 401 || s === 403;

describe('the engine\'s write routes', () => {
  const writes: Array<[string, unknown]> = [
    ['/interactive/prescribe', { prescriberIndex: 0, pharmacyIndex: 0, memberWalletId: '1', ndcHash: '1', quantity: 1, refills: 0 }],
    ['/interactive/fill', { prescriptionId: 'RX-1' }],
    ['/interactive/mark-filled', { prescriptionId: 'RX-1' }],
    ['/interactive/reverse', { prescriptionId: 'RX-1' }],
    ['/interactive/enroll', { memberIndex: 0 }],
    ['/interactive/assign-pcp', { memberWalletId: '1', prescriberIndex: 0 }],
    ['/interactive/resolve-indices', { prescriberWalletId: '1' }],
    ['/interactive/request-prior-auth', { memberWalletId: '1', prescriberIndex: 0, ndcHash: '1' }],
    ['/interactive/send-message', { from: '1', to: '2', body: 'x' }],
    ['/node/force-batch', {}],
  ];

  test('refuse an anonymous caller, every one of them', async () => {
    for (const [p, body] of writes) {
      const r = await post(p, body);
      expect([p, r.status]).toEqual([p, 401]);
    }
  });

  test('pass the gate for the operator', async () => {
    for (const [p, body] of writes) {
      const r = await post(p, body, bearer);
      expect([p, gated(r.status)]).toEqual([p, false]);
    }
  });

  test('a prescriber key prescribes and resolves indices but does not fill; a pharmacy key the reverse; a member key neither', async () => {
    const rx = writes[0];
    const fill = writes[1];
    const resolve = writes[6];
    expect(gated((await post(rx[0], rx[1], byNode(prescriberNode, 'POST', rx[0], rx[1]))).status)).toBe(false);
    expect((await post(fill[0], fill[1], byNode(prescriberNode, 'POST', fill[0], fill[1]))).status).toBe(403);
    expect(gated((await post(fill[0], fill[1], byNode(pharmacyNode, 'POST', fill[0], fill[1]))).status)).toBe(false);
    expect((await post(rx[0], rx[1], byNode(pharmacyNode, 'POST', rx[0], rx[1]))).status).toBe(403);
    expect(gated((await post(resolve[0], resolve[1], byNode(pharmacyNode, 'POST', resolve[0], resolve[1]))).status)).toBe(false);
    expect((await post(rx[0], rx[1], byNode(memberNode, 'POST', rx[0], rx[1]))).status).toBe(403);
    expect((await post(fill[0], fill[1], byNode(memberNode, 'POST', fill[0], fill[1]))).status).toBe(403);
  });

  test('register-member and verify-credential stay reachable without a token: the first carries the device\'s proof, the second changes nothing', async () => {
    expect(gated((await post('/interactive/register-member', {})).status)).toBe(false);
    expect(gated((await post('/interactive/verify-credential', {})).status)).toBe(false);
  });

  test('the member-data reads need a credential; the chain\'s own state does not', async () => {
    for (const p of [
      '/interactive/member-history?walletId=1', '/interactive/family-history?familyId=1', '/interactive/threads?walletId=1',
      '/interactive/fill-status?prescriptionId=RX-1', '/interactive/enroll-status?memberIndex=0',
      '/node/state', '/node/claims-by-member?walletId=1', '/node/receipts-by-wallet?walletId=1', '/node/dur?memberWalletId=1',
      '/node/all-receipts', '/node/audit-log', '/node/claim-proof?leafIndex=0',
    ]) {
      expect([p, (await fetch(url + p)).status]).toEqual([p, 401]);
      expect([p, gated((await fetch(url + p, { headers: bearer })).status)]).toEqual([p, false]);
    }
    for (const p of ['/interactive/l2-status', '/node/chain-state', '/node/chain-proof', '/node/all-batches', '/node/formulary']) {
      expect([p, gated((await fetch(url + p)).status)]).toEqual([p, false]);
    }
  });
});

describe('the sequencer', () => {
  const rpc = async (method: string, params: Record<string, unknown>, headers: Record<string, string> = {}) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    const r = await fetch(`${url}/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
    return (await r.json()) as { result?: unknown; error?: { code: number; message: string } };
  };

  test('has no no-proof claim path any more', async () => {
    const r = await rpc('l2_recordFill', { memberWalletId: '1', ndcHash: '1', pharmacyWalletId: '1' }, bearer);
    expect(r.error).toBeDefined();
    expect(r.error?.message).toMatch(/not found|unknown/i);
  });

  test('lists node keys and pending admissions to the operator only', async () => {
    for (const method of ['l2_getAdminKeys', 'l2_getPendingAdmissions']) {
      expect((await rpc(method, {})).error?.code).toBe(RPC_UNAUTHORIZED);
      expect((await rpc(method, {}, bearer)).error).toBeUndefined();
    }
  });

  test('the engine console and the viz history answer a credential only; the console also takes the operator token in the query', async () => {
    const streams: AbortController[] = [];
    const openStream = async (p: string, headers: Record<string, string> = {}) => {
      const ctl = new AbortController(); streams.push(ctl);
      return (await fetch(url + p, { headers, signal: ctl.signal })).status;
    };
    try {
      expect(await openStream('/interactive/console')).toBe(401);
      expect(await openStream('/interactive/console?token=not-the-operator')).toBe(401);
      expect(await openStream(`/interactive/console?token=${encodeURIComponent(OPERATOR)}`)).toBe(200);
      expect(await openStream('/interactive/console', bearer)).toBe(200);
      expect(await openStream('/interactive/console', byNode(pharmacyNode, 'GET', '/interactive/console'))).toBe(403); // no node role reads it
    } finally {
      for (const ctl of streams) ctl.abort();
    }
    expect((await fetch(`${url}/viz/history`)).status).toBe(401);
    expect((await fetch(`${url}/viz/history`, { headers: bearer })).status).toBe(200);
    expect((await fetch(`${url}/viz/history`, { headers: byNode(pharmacyNode, 'GET', '/viz/history') })).status).toBe(403); // the operator's and the plan's
  });

  test('streams events to a credential only: a node\'s signature or the operator\'s token, in a header or in the query', async () => {
    expect((await fetch(`${url}/events`)).status).toBe(401);
    expect((await fetch(`${url}/viz/events`)).status).toBe(401);
    expect((await fetch(`${url}/events?token=not-the-operator`)).status).toBe(401);
    const opened: AbortController[] = [];
    const open = async (p: string, headers: Record<string, string> = {}) => {
      const ctl = new AbortController(); opened.push(ctl);
      const r = await fetch(url + p, { headers, signal: ctl.signal });
      return r.status;
    };
    expect(await open(`/events?token=${encodeURIComponent(OPERATOR)}`)).toBe(200);
    expect(await open('/events', bearer)).toBe(200);
    expect(await open('/events', byNode(memberNode, 'GET', '/events'))).toBe(200);
    expect(await open('/viz/events', byNode(pharmacyNode, 'GET', '/viz/events'))).toBe(403); // the viz stream is the operator's and the plan's
    for (const ctl of opened) ctl.abort();
  });
});
