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
 * Verify Member at the pharmacy counter: POST /nfc/scan (screen audit, pharmacy item 1, the demo blocker).
 *
 * What was wrong: the pharmacy pinned the sequencer's attestation key from `publicKeyHex`, but the sequencer
 * answers `{ publicKey }`, so nothing was pinned and every pasted attestation got 403. Past that, the route read
 * the member's drug history twice in parallel and without the attestation, which the sequencer refuses since D1
 * (a 500 at the counter), and a bare wallet ID (typed, a v1 member-id tag, or its QR) was looked up as if it
 * identified someone. Now a valid attestation yields 200 with the history, read once, signed as the pharmacy and
 * carrying the tap; a wallet ID with no attestation yields 403, no history, and no request to the sequencer.
 *
 * A real sequencer server and a real PharmacyNode signing as the pharmacy's wallet; the route handler is called
 * with a fake node server (the pattern of provider-index-refusal.test.ts). No compile, no proof.
 */
import { Field, MerkleTree } from 'o1js';
import { InMemoryStore } from '../src/storage/local-store.js';
import { WALLET_TREE_HEIGHT } from '../src/wallets/wallet-state.js';
import { L2Node } from '../src/l2/l2-node.js';
import { L2RpcServer } from '../src/l2/l2-rpc-server.js';
import { LIFECYCLE_ELIGIBLE } from '../src/engine/lifecycle.js';
import { generateNodeKey } from '../src/security/node-roles.js';
import { signRequest, privateKeyFromSeedHex } from '../src/security/signed-request.js';
import { deriveWalletSigningKey, walletSigner } from '../src/security/wallet-key.js';
import { PharmacyNode } from '../src/nodes/pharmacy-node.js';
import { buildPharmacyRoutes } from '../src/nodes/routes/pharmacy-routes.js';

jest.setTimeout(60_000);

const emptyRoot = new MerkleTree(WALLET_TREE_HEIGHT).getRoot();
const memberNodeKey = generateNodeKey('member-node');
const pharmacyNodeKey = generateNodeKey('pharmacy-node');
const EK = { alice: 'ek-alice-' + 'a'.repeat(32), rx: 'ek-rx-' + 'd'.repeat(32) };
const W = { alice: '1001', rx: '3001' };
const v1Tag = JSON.stringify({ v: 1, t: 'member-id', w: W.alice, ts: 1 });

let seq: L2RpcServer;
let url: string;
let att: Record<string, unknown>;

const envelope = (method: string, params: Record<string, unknown>) => JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
async function rpcWith(headers: Record<string, string>, body: string) {
  const r = await fetch(`${url}/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
  return (await r.json()) as { result?: any; error?: { message: string } };
}

beforeAll(async () => {
  const node = new L2Node({ batchIntervalMs: 999_999, autoSettle: false, nodeId: 'seq-nfc-scan-test' }, new InMemoryStore(), emptyRoot, emptyRoot, Field(0));
  await node.enableAttestations();
  seq = new L2RpcServer(node, { port: 0, host: '127.0.0.1', adminToken: 'operator-token-for-tests', enableSSE: false });
  seq.registerNodeKey(memberNodeKey.nodeId, memberNodeKey.publicKeyHex, 'member');
  seq.registerNodeKey(pharmacyNodeKey.nodeId, pharmacyNodeKey.publicKeyHex, 'pharmacy');
  await seq.start();
  url = `http://127.0.0.1:${seq.getPort()}`;
  const fixtures = [[memberNodeKey, 'alice', 'member'], [pharmacyNodeKey, 'rx', 'pharmacy']] as const;
  for (const [key, who, type] of fixtures) {
    const body = envelope('l2_registerEntity', { walletId: W[who], displayName: who, type, signingPublicKeyHex: deriveWalletSigningKey(EK[who]).publicKeyHex });
    const j = await rpcWith(signRequest({ signerId: key.nodeId, privateKey: privateKeyFromSeedHex(key.seedHex), method: 'POST', path: '/rpc', body }), body);
    if (j.error) throw new Error(`fixture registration of ${who} failed: ${j.error.message}`);
  }
  // Alice exists on the ledger, so the sequencer issues her an attestation, signed with its attestation key.
  node.getSequencer().adminMutate('test: provision alice', ({ provision }) => { provision(Field(BigInt(W.alice)), LIFECYCLE_ELIGIBLE); });
  const ask = envelope('l2_requestAttestation', { walletId: W.alice });
  att = (await rpcWith(signRequest({ ...walletSigner(EK.alice, W.alice), method: 'POST', path: '/rpc', body: ask }), ask)).result;
  if (att?.w !== W.alice) throw new Error('the fixture attestation was not issued');
});

afterAll(async () => { await seq.stop(); });

/** The pharmacy node's /nfc/scan over a real PharmacyNode that signs as the pharmacy's wallet. */
function counter() {
  const sent: Array<{ status: number; ok: boolean; data?: any; error?: string }> = [];
  const pharmacy = new PharmacyNode({ role: 'pharmacy', walletId: W.rx, sequencerUrl: url });
  pharmacy.setWalletSignerSource(() => walletSigner(EK.rx, W.rx));
  const reads = jest.spyOn(pharmacy, 'getPatientFullDrugHistory');
  const server = {
    getEntityNode: () => pharmacy,
    getConfig: () => ({ sequencerUrl: url }),
    sendResponse(_res: unknown, status: number, ok: boolean, data?: unknown, error?: string) { sent.push({ status, ok, data, error }); },
  };
  const route = buildPharmacyRoutes(server as any).find((r) => r.method === 'POST' && r.path === '/nfc/scan')!;
  const scan = (body: unknown) => route.handler({ headers: {} } as any, {} as any, {}, new URLSearchParams(), body);
  return { sent, reads, scan };
}

test('a pasted attestation verifies the member: 200 with the drug history, from one signed read that carries the tap', async () => {
  const c = counter();
  await c.scan({ attestation: att });
  expect(c.sent).toHaveLength(1);
  expect(c.sent[0]).toMatchObject({ status: 200, ok: true });
  // The fields the dashboard's verifyMember checks before it enables Dispense.
  expect(c.sent[0].data).toMatchObject({
    walletId: W.alice, attestationVerified: true, attestationExpired: false,
    totalClaims: 0, fullHistory: [], activeMedications: [], activeMedicationCount: 0,
  });
  expect(c.reads).toHaveBeenCalledTimes(1);
  expect(c.reads).toHaveBeenCalledWith(W.alice, att);
});

test('the wrapper the member app copies verifies too', async () => {
  const c = counter();
  await c.scan({ type: 'credential-attestation', version: 2, walletId: W.alice, attestation: att });
  expect(c.sent[0]).toMatchObject({ status: 200, ok: true });
  expect(c.sent[0].data).toMatchObject({ walletId: W.alice, attestationVerified: true });
  expect(c.reads).toHaveBeenCalledTimes(1);
});

test.each([
  ['a typed wallet ID', { walletId: W.alice }],
  ['a v1 member-id tag', { payload: v1Tag }],
  ['the QR form of that tag', { payloadBase64: Buffer.from(v1Tag).toString('base64url') }],
])('%s returns no history and asks the sequencer nothing', async (_label, body) => {
  const c = counter();
  await c.scan(body);
  expect(c.sent).toHaveLength(1);
  expect(c.sent[0]).toMatchObject({ status: 403, ok: false });
  expect(c.sent[0].data).toBeUndefined();
  expect(c.sent[0].error).toMatch(/attestation/i);
  expect(c.reads).not.toHaveBeenCalled();
});
