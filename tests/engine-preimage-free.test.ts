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
 * The preimage leaves the engine — plan items B1 step two and B2, finding A-1.
 *
 * The engine's routes on a real sequencer server with a stand-in service: `register-member` refuses
 * an identity preimage outright and takes the device's ownership proof; the two wallet-update routes
 * take only the signature of the wallet they name, in the query or the body; and the engine's source
 * writes no preimage to its state file and asks the device for a proof, not six fields.
 */
import fs from 'fs';
import { Field, MerkleTree } from 'o1js';
import { InMemoryStore } from '../src/storage/local-store.js';
import { WALLET_TREE_HEIGHT } from '../src/wallets/wallet-state.js';
import { L2Node } from '../src/l2/l2-node.js';
import { L2RpcServer } from '../src/l2/l2-rpc-server.js';
import { registerInteractiveRoutes } from '../src/adjudication/interactive-routes.js';
import { RegistrationRefused } from '../src/adjudication/interactive-service.js';
import { generateNodeKey } from '../src/security/node-roles.js';
import { signRequest, privateKeyFromSeedHex } from '../src/security/signed-request.js';
import { deriveWalletSigningKey, walletSigner } from '../src/security/wallet-key.js';

jest.setTimeout(60_000);

const OPERATOR = 'operator-token-for-tests';
const emptyRoot = new MerkleTree(WALLET_TREE_HEIGHT).getRoot();
const memberNode = generateNodeKey('member-node');
const EK = { alice: 'ek-alice-' + 'a'.repeat(32), bob: 'ek-bob-' + 'b'.repeat(32) };
const W = { alice: '1001', bob: '1002' };

const pendingForAlice = [{ updateId: 'wu-mint', walletId: W.alice, reason: 'credential mint', oldInventoryRoot: '0', newInventoryRoot: '42', credential: {}, forestLeaves: [], inventorySlot: '0', claimCommitted: false, createdAt: 1, phase: 'register', status: 'pending' }];

function standInService() {
  const calls: { registered: unknown[]; applied: unknown[] } = { registered: [], applied: [] };
  const svc = {
    async registerMemberFromEnrollment(opts: Record<string, unknown>) { calls.registered.push(opts); return { registered: true, walletId: opts.walletId }; },
    walletUpdatesFor(walletId: string) { return walletId === W.alice ? pendingForAlice : []; },
    markWalletUpdateApplied(walletId: string, updateId: string, receiptId: string) {
      calls.applied.push({ walletId, updateId, receiptId });
      if (updateId === 'wu-old') throw new RegistrationRefused(409, 'Update wu-older comes first');
      return { updateId, reason: 'fill', status: 'applied', receiptId };
    },
    getState() { return { compiled: true, enrolledMembers: [] }; },
    __calls: calls,
  };
  return new Proxy(svc, { get(t, p) { if (p in t) return (t as any)[p]; if (typeof p === 'string' && p !== 'then') throw new Error(`stand-in service has no ${p}`); return undefined; } });
}

let server: L2RpcServer;
let url: string;
let service: ReturnType<typeof standInService>;

async function call(method: string, p: string, body?: unknown, headers: Record<string, string> = {}) {
  const text = body === undefined ? undefined : JSON.stringify(body);
  const r = await fetch(url + p, { method, headers: { ...(text ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: text });
  let json: any = null;
  try { json = await r.json(); } catch { json = null; }
  return { status: r.status, json };
}
const asWallet = (ek: string, walletId: string, method: string, p: string, body?: string) =>
  signRequest({ ...walletSigner(ek, walletId), method, path: p, body });

beforeAll(async () => {
  const node = new L2Node({ batchIntervalMs: 999_999, autoSettle: false, nodeId: 'seq-preimage-test' }, new InMemoryStore(), emptyRoot, emptyRoot, Field(0));
  server = new L2RpcServer(node, { port: 0, host: '127.0.0.1', adminToken: OPERATOR, enableSSE: false });
  server.registerNodeKey(memberNode.nodeId, memberNode.publicKeyHex, 'member');
  service = standInService();
  registerInteractiveRoutes(server, service as any);
  await server.start();
  url = `http://127.0.0.1:${server.getPort()}`;
  // the two wallets register their signing keys, as a member node does at enrollment
  for (const [who, wallet] of [['alice', W.alice], ['bob', W.bob]] as const) {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'l2_registerEntity', params: { walletId: wallet, displayName: who, type: 'member', signingPublicKeyHex: deriveWalletSigningKey(EK[who]).publicKeyHex } });
    const headers = signRequest({ signerId: memberNode.nodeId, privateKey: privateKeyFromSeedHex(memberNode.seedHex), method: 'POST', path: '/rpc', body });
    const r = await fetch(`${url}/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
    const j = await r.json() as any;
    if (j.error) throw new Error(`fixture registration failed: ${j.error.message}`);
  }
});

afterAll(async () => { await server.stop(); });

describe('register-member', () => {
  test('refuses an identity preimage outright, and demands the ownership proof', async () => {
    const withPreimage = await call('POST', '/interactive/register-member', { walletId: W.alice, preimageFields: ['1', '2', '3', '4', '5', '6'], displayName: 'A' });
    expect(withPreimage.status).toBe(400);
    expect(withPreimage.json?.error).toMatch(/never sent/);
    const withoutProof = await call('POST', '/interactive/register-member', { walletId: W.alice, displayName: 'A' });
    expect(withoutProof.status).toBe(400);
    expect(withoutProof.json?.error).toMatch(/ownershipProofJson/);
    expect(service.__calls.registered).toHaveLength(0);
    const ok = await call('POST', '/interactive/register-member', { walletId: W.alice, ownershipProofJson: '{"stand-in":true}', displayName: 'A', publicKeyHex: 'ab'.repeat(32) });
    expect(ok.status).toBe(200);
    expect(service.__calls.registered).toHaveLength(1);
    expect(service.__calls.registered[0]).toMatchObject({ walletId: W.alice, ownershipProofJson: '{"stand-in":true}', displayName: 'A' });
    expect(Object.keys(service.__calls.registered[0] as object)).not.toContain('preimageFields');
  });
});

describe('the wallet-update routes take only the wallet\'s own signature', () => {
  test('GET /interactive/wallet-updates: unsigned 401, another wallet 401, the wallet itself 200', async () => {
    const p = `/interactive/wallet-updates?walletId=${W.alice}`;
    expect((await call('GET', p)).status).toBe(401);
    expect((await call('GET', p, undefined, { Authorization: `Bearer ${OPERATOR}` })).status).toBe(401);
    expect((await call('GET', p, undefined, asWallet(EK.bob, W.bob, 'GET', '/interactive/wallet-updates'))).status).toBe(401);
    const ok = await call('GET', p, undefined, asWallet(EK.alice, W.alice, 'GET', '/interactive/wallet-updates'));
    expect(ok.status).toBe(200);
    expect(ok.json.pending.map((u: any) => u.updateId)).toEqual(['wu-mint']);
    expect((await call('GET', '/interactive/wallet-updates?walletId=abc', undefined, asWallet(EK.alice, W.alice, 'GET', '/interactive/wallet-updates'))).status).toBe(401);
  });

  test('POST /interactive/wallet-update-applied: the body names the wallet that must have signed', async () => {
    const good = { walletId: W.alice, updateId: 'wu-mint', receiptId: 'rcpt-1' };
    const goodBody = JSON.stringify(good);
    expect((await call('POST', '/interactive/wallet-update-applied', good)).status).toBe(401);
    expect((await call('POST', '/interactive/wallet-update-applied', good, asWallet(EK.bob, W.bob, 'POST', '/interactive/wallet-update-applied', goodBody))).status).toBe(401);
    const ok = await call('POST', '/interactive/wallet-update-applied', good, asWallet(EK.alice, W.alice, 'POST', '/interactive/wallet-update-applied', goodBody));
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ updateId: 'wu-mint', status: 'applied', receiptId: 'rcpt-1' });
    // naming Bob's wallet in the body while signing as Alice is refused before the handler
    const swapped = { walletId: W.bob, updateId: 'wu-mint', receiptId: 'rcpt-1' };
    const swappedBody = JSON.stringify(swapped);
    expect((await call('POST', '/interactive/wallet-update-applied', swapped, asWallet(EK.alice, W.alice, 'POST', '/interactive/wallet-update-applied', swappedBody))).status).toBe(401);
    // a refusal from the engine keeps its status
    const old = { walletId: W.alice, updateId: 'wu-old', receiptId: 'rcpt-2' };
    const oldBody = JSON.stringify(old);
    const refused = await call('POST', '/interactive/wallet-update-applied', old, asWallet(EK.alice, W.alice, 'POST', '/interactive/wallet-update-applied', oldBody));
    expect(refused.status).toBe(409);
    expect(refused.json?.error).toMatch(/comes first/);
    expect(service.__calls.applied).toHaveLength(2);
  });
});

describe('the engine\'s source', () => {
  const src = fs.readFileSync('src/adjudication/interactive-service.ts', 'utf8');
  test('writes no preimage to its state file and asks the device for a proof, not six fields', () => {
    expect(src).not.toMatch(/preimageFields: m\.preimageFields/);
    expect(src).toMatch(/ownershipProofJson: typeof m\.cachedProofGateProof === 'string'/);
    expect(src).toMatch(/ownershipProofJson: string;/);
    expect(src).not.toMatch(/opts\.preimageFields/);
    // the one verification that counts: o1js verify() against the compiled key, never proof.verify()
    expect(src).toMatch(/await verify\(proof, this\.proofGateVk\)/);
  });
  test('the member node sends the proof and never the preimage', () => {
    const routes = fs.readFileSync('src/nodes/routes/member-routes.ts', 'utf8');
    const registration = routes.slice(routes.indexOf("path: '/proof/registration'"), routes.indexOf("path: '/pcp/assign'"));
    expect(registration).toMatch(/ownershipProofJson/);
    expect(registration).not.toMatch(/preimageFields: data\.preimageFields/);
  });
});
