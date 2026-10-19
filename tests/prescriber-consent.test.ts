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
 * Consent at prescribing — plan item B5, findings A-16 (its prescribing-authority half) and A-18.
 *
 * A member with a device is prescribed for by the primary-care prescriber it consented to, or by a
 * prescriber its device authorized for the visit; a terminated member is not billable. The engine's
 * authorization route on a real sequencer server with a stand-in service: it takes only the
 * signature of the wallet it names, validates its body, passes the engine's refusals through with
 * their status, and hands the service exactly what the device sent. The engine's prescribing and
 * dispensing paths carry the checks in the right order, and the member node has the device route.
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
    async authorizePrescriber(opts: { walletId: string; prescriberWalletId: string; ndcHash?: string | null; hours?: number }) {
      calls.push(opts);
      if (opts.prescriberWalletId === '9999') throw new RegistrationRefused(404, 'The named wallet is not a credentialed prescriber');
      const hours = opts.hours ?? 24;
      return { memberWalletId: opts.walletId, prescriberWalletId: opts.prescriberWalletId, ndcHash: opts.ndcHash ?? null, grantedAt: 1000, expiresAt: 1000 + hours * 3_600_000 };
    },
    getState() { return { compiled: true, enrolledMembers: [] }; },
    __calls: calls,
  };
  return new Proxy(svc, { get(t, p) { if (p in t) return (t as any)[p]; if (typeof p === 'string' && p !== 'then') throw new Error(`stand-in service has no ${p}`); return undefined; } });
}

let server: L2RpcServer;
let url: string;
let service: ReturnType<typeof standInService>;
const P = '/interactive/prescriber-authorization';

async function post(body: unknown, headers: Record<string, string> = {}) {
  const text = JSON.stringify(body);
  const r = await fetch(url + P, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: text });
  let json: any = null;
  try { json = await r.json(); } catch { json = null; }
  return { status: r.status, json };
}
const asWallet = (ek: string, walletId: string, body: unknown) => signRequest({ ...walletSigner(ek, walletId), method: 'POST', path: P, body: JSON.stringify(body) });

beforeAll(async () => {
  const node = new L2Node({ batchIntervalMs: 999_999, autoSettle: false, nodeId: 'seq-consent-test' }, new InMemoryStore(), emptyRoot, emptyRoot, Field(0));
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

describe('POST /interactive/prescriber-authorization', () => {
  const good = { walletId: W.alice, prescriberWalletId: W.drP, ndcHash: '777', hours: 2 };

  test('takes only the named wallet\'s signature', async () => {
    expect((await post(good)).status).toBe(401);
    expect((await post(good, { Authorization: `Bearer ${OPERATOR}` })).status).toBe(401);
    expect((await post(good, asWallet(EK.bob, W.bob, good))).status).toBe(401);
    const swapped = { ...good, walletId: W.bob };
    expect((await post(swapped, asWallet(EK.alice, W.alice, swapped))).status).toBe(401);
    expect(service.__calls).toHaveLength(0);
  });

  test('validates its body, passes the engine\'s refusal through, and hands the service what the device sent', async () => {
    const missing = { walletId: W.alice };
    const r400 = await post(missing, asWallet(EK.alice, W.alice, missing));
    expect(r400.status).toBe(400);
    expect(r400.json?.error).toMatch(/prescriberWalletId/);
    const ok = await post(good, asWallet(EK.alice, W.alice, good));
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ memberWalletId: W.alice, prescriberWalletId: W.drP, ndcHash: '777', expiresAt: 1000 + 2 * 3_600_000 });
    expect(service.__calls[0]).toEqual(good);
    const bare = { walletId: W.alice, prescriberWalletId: W.drP };
    const defaults = await post(bare, asWallet(EK.alice, W.alice, bare));
    expect(defaults.status).toBe(200);
    expect(service.__calls[1]).toEqual({ ...bare, ndcHash: null, hours: undefined });
    expect(defaults.json?.ndcHash).toBeNull();
    const notADoctor = { ...good, prescriberWalletId: '9999' };
    const refused = await post(notADoctor, asWallet(EK.alice, W.alice, notADoctor));
    expect(refused.status).toBe(404);
    expect(refused.json?.error).toMatch(/not a credentialed prescriber/);
  });
});

describe('the engine\'s prescribing and dispensing paths', () => {
  const src = fs.readFileSync('src/adjudication/interactive-service.ts', 'utf8');

  test('createPrescription refuses a terminated member, then requires the PCP or a device authorization, before any record is made', () => {
    const fn = src.slice(src.indexOf('  async createPrescription('), src.indexOf('this.pendingPrescriptions.set(pendingRxId', src.indexOf('  async createPrescription(')));
    const lifecycle = fn.indexOf('refuseUnlessLedgerBillable(');
    const consent = fn.indexOf("is not this member's primary-care prescriber and holds no authorization");
    expect(lifecycle).toBeGreaterThan(0);
    expect(consent).toBeGreaterThan(lifecycle);
    expect(fn).toMatch(/enrolled\.memberIndex < 0/);
    expect(fn).toMatch(/pcpAssignment\.pcpWalletId\.equals\(prescriberWalletId\)/);
    expect(fn).toMatch(/prescriberAuthorizationFor\(/);
    const network = fn.indexOf('inNetworkPrescriberIndices.includes(opts.prescriberIndex)');
    expect(network).toBeGreaterThan(consent);
    expect(fn).toMatch(/inNetworkPharmacyIndices\.includes\(opts\.pharmacyIndex\)/);
  });

  test('the operator can terminate a member with a device: its lifecycle is set on the trees, not looked up in the fixture roster', () => {
    const fn = src.slice(src.indexOf('  terminateMember(opts: {'), src.indexOf('  terminateGroup(opts: {'));
    expect(fn).toMatch(/enrolled\.memberIndex >= 0/);
    expect(fn).toMatch(/setLifecycle\(enrolled\.walletId, LIFECYCLE_REVOKED\)/);
    expect(fn).toMatch(/enrollmentService\.terminateMember\(/);
  });

  test('dispensePrescription refuses a terminated member; reversal stays open', () => {
    const dispense = src.slice(src.indexOf('  async dispensePrescription('), src.indexOf('  async reversePrescription('));
    expect(dispense).toMatch(/refuseUnlessLedgerBillable\(/);
    const reverse = src.slice(src.indexOf('  async reversePrescription('), src.indexOf('  async reversePrescription(') + 4000);
    expect(reverse).not.toMatch(/enrolled\.lifecycle === 'REVOKED'/);
    expect(reverse).not.toMatch(/refuseUnlessLedgerBillable/);
  });

  test('an authorization is bound to a prescriber, optionally one medication, and expires', () => {
    const helper = src.slice(src.indexOf('private prescriberAuthorizationFor('), src.indexOf('activePrescriberAuthorizations('));
    expect(helper).toMatch(/a\.prescriberWalletId === prescriberWalletId/);
    expect(helper).toMatch(/a\.expiresAt > now/);
    expect(helper).toMatch(/a\.ndcHash === null \|\| a\.ndcHash === ndcHash/);
    const grant = src.slice(src.indexOf('  async authorizePrescriber('), src.indexOf('  async registerMemberFromEnrollment('));
    expect(grant).toMatch(/hours < 1 \|\| hours > 72/);
    expect(grant).toMatch(/ProviderLifecycle\.ACTIVE/);
    expect(grant).toMatch(/lifecycle === 'REVOKED'/);
  });

  test('the member node signs the authorization as the wallet and keeps what the engine recorded', () => {
    const routes = fs.readFileSync('src/nodes/routes/member-routes.ts', 'utf8');
    const start = routes.indexOf("path: '/authorizations/prescriber'");
    expect(start).toBeGreaterThan(0);
    const span = routes.slice(start, routes.indexOf('path: ', start + 10));
    expect(span).toMatch(/deviceOnly: true/);
    expect(span).toMatch(/walletSignedFetch\([^)]*\/interactive\/prescriber-authorization/);
    expect(span).toMatch(/data\.prescriberAuthorizations = /);
  });
});
