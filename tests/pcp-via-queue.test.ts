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
 * The device's primary-care assignment goes through the engine's queue — plan item B1 step two.
 *
 * The engine's route on a real sequencer server with a stand-in service: it takes only the
 * signature of the wallet it names, validates its body, passes the engine's refusals through with
 * their status, and hands the service exactly what the device sent. And the member node's proof
 * route no longer rebuilds a credential from an empty forest: it asks the engine and proves what
 * the engine queued.
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
const W = { alice: '1001', bob: '1002', drP: '2001' };

function standInService() {
  const calls: unknown[] = [];
  const svc = {
    async assignPcpForDevice(opts: { walletId: string; pcpWalletId: string; effectiveDate: string; specialty: string; consentScopeFlags: number }) {
      calls.push(opts);
      if (opts.pcpWalletId === '9999') throw new RegistrationRefused(404, 'The named wallet is not a credentialed prescriber');
      return { walletId: opts.walletId, pcpWalletId: opts.pcpWalletId, effectiveDate: opts.effectiveDate, commitment: '55', walletUpdate: { status: 'pending', updateId: 'wu-pcp', newInventoryRoot: '66' } };
    },
    getState() { return { compiled: true, enrolledMembers: [] }; },
    __calls: calls,
  };
  return new Proxy(svc, { get(t, p) { if (p in t) return (t as any)[p]; if (typeof p === 'string' && p !== 'then') throw new Error(`stand-in service has no ${p}`); return undefined; } });
}

let server: L2RpcServer;
let url: string;
let service: ReturnType<typeof standInService>;
const P = '/interactive/pcp-assignment';

async function post(body: unknown, headers: Record<string, string> = {}) {
  const text = JSON.stringify(body);
  const r = await fetch(url + P, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: text });
  let json: any = null;
  try { json = await r.json(); } catch { json = null; }
  return { status: r.status, json };
}
const asWallet = (ek: string, walletId: string, body: unknown) => signRequest({ ...walletSigner(ek, walletId), method: 'POST', path: P, body: JSON.stringify(body) });

beforeAll(async () => {
  const node = new L2Node({ batchIntervalMs: 999_999, autoSettle: false, nodeId: 'seq-pcp-test' }, new InMemoryStore(), emptyRoot, emptyRoot, Field(0));
  server = new L2RpcServer(node, { port: 0, host: '127.0.0.1', adminToken: OPERATOR, enableSSE: false });
  server.registerNodeKey(memberNode.nodeId, memberNode.publicKeyHex, 'member');
  service = standInService();
  registerInteractiveRoutes(server, service as any);
  await server.start();
  url = `http://127.0.0.1:${server.getPort()}`;
  for (const [who, wallet] of [['alice', W.alice], ['bob', W.bob]] as const) {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'l2_registerEntity', params: { walletId: wallet, displayName: who, type: 'member', signingPublicKeyHex: deriveWalletSigningKey(EK[who]).publicKeyHex } });
    const headers = signRequest({ signerId: memberNode.nodeId, privateKey: privateKeyFromSeedHex(memberNode.seedHex), method: 'POST', path: '/rpc', body });
    const r = await fetch(`${url}/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
    const j = await r.json() as any;
    if (j.error) throw new Error(`fixture registration failed: ${j.error.message}`);
  }
});

afterAll(async () => { await server.stop(); });

describe('POST /interactive/pcp-assignment', () => {
  const good = { walletId: W.alice, pcpWalletId: W.drP, effectiveDate: '20261018', specialty: 'Internal Medicine', consentScopeFlags: 7 };

  test('takes only the named wallet\'s signature', async () => {
    expect((await post(good)).status).toBe(401);
    expect((await post(good, { Authorization: `Bearer ${OPERATOR}` })).status).toBe(401);
    expect((await post(good, asWallet(EK.bob, W.bob, good))).status).toBe(401);
    const swapped = { ...good, walletId: W.bob };
    expect((await post(swapped, asWallet(EK.alice, W.alice, swapped))).status).toBe(401);
    expect(service.__calls).toHaveLength(0);
  });

  test('validates its body, passes the engine\'s refusal through, and hands the service what the device sent', async () => {
    const missing = { walletId: W.alice, pcpWalletId: W.drP };
    const r400 = await post(missing, asWallet(EK.alice, W.alice, missing));
    expect(r400.status).toBe(400);
    expect(r400.json?.error).toMatch(/effectiveDate/);
    const ok = await post(good, asWallet(EK.alice, W.alice, good));
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ walletId: W.alice, pcpWalletId: W.drP, walletUpdate: { status: 'pending', updateId: 'wu-pcp' } });
    expect(service.__calls[0]).toEqual(good);
    const bare = { walletId: W.alice, pcpWalletId: W.drP, effectiveDate: '20261018' };
    const defaults = await post(bare, asWallet(EK.alice, W.alice, bare));
    expect(defaults.status).toBe(200);
    expect(service.__calls[1]).toEqual({ ...bare, specialty: 'General Practice', consentScopeFlags: 7 });
    const notADoctor = { ...good, pcpWalletId: '9999' };
    const refused = await post(notADoctor, asWallet(EK.alice, W.alice, notADoctor));
    expect(refused.status).toBe(404);
    expect(refused.json?.error).toMatch(/not a credentialed prescriber/);
  });
});

describe('the member node\'s proof route', () => {
  test('asks the engine and proves what it queued, instead of rebuilding a credential from an empty forest', () => {
    const routes = fs.readFileSync('src/nodes/routes/member-routes.ts', 'utf8');
    const start = routes.indexOf("path: '/proof/pcp-assignment'");
    const end = routes.indexOf('path: ', start + 10);
    const span = routes.slice(start, end > 0 ? end : undefined);
    expect(span).toMatch(/\/interactive\/pcp-assignment/);
    expect(span).toMatch(/applyPendingWalletUpdates\(server\)/);
    expect(span).toMatch(/registerPcpAssignment\(/);
    expect(span).not.toMatch(/new MerkleForest\(\)/);
    expect(span).not.toMatch(/l2_syncWalletState/);
  });
  test('the engine checks the prescriber is credentialed and active before recording', () => {
    const src = fs.readFileSync('src/adjudication/interactive-service.ts', 'utf8');
    const fn = src.slice(src.indexOf('async assignPcpForDevice('), src.indexOf('async registerMemberFromEnrollment('));
    expect(fn).toMatch(/getProvider\(opts\.pcpWalletId\)/);
    expect(fn).toMatch(/ProviderLifecycle\.ACTIVE/);
    expect(fn).toMatch(/updateCredentialAndSubmitToL2\(enrolled, 'pcp'\)/);
  });
});
