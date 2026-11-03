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
 * The plan can hold a member's coverage while a report about its enrollment is reviewed (A-109, slice 4).
 *
 * When an employee reports that someone else used their invite, the plan freezes the wallet that used it until HR
 * confirms who the real employee is. There was no way to: the engine's members were eligible, active or revoked, and
 * revocation is for good, so a mistaken report could only be answered by terminating the real employee's coverage.
 *
 * Now the plan, or the operator, holds a member (POST /interactive/hold-member): while held, the member is quoted
 * nothing, and no prior authorization, prescription or fill goes through; released, everything does again. The hold
 * survives a restart of the engine's state.
 *
 * A real L2Node sequencer and a real AdjudicationService, programs not compiled and proofs skipped, as in
 * tests/prior-auth-review-fixes.test.ts.
 */
import { Field, MerkleTree } from 'o1js';

jest.setTimeout(300_000);

const OPERATOR = 'operator-token-for-member-hold';
const ABACAVIR = '00378410591';
const W1 = '79300000000000000011';

let node: any;
let seq: any;
let svc: any;
let server: any;
let url: string;
let hashString: (s: string) => Field;
let PRESCRIBERS: any[];
let signRequest: any;
let deriveWalletSigningKey: any;
let generateNodeKey: any;
let privateKeyFromSeedHex: any;
let insurerNode: any;
let prescriberNode: any;
const bearer = { Authorization: `Bearer ${OPERATOR}` };
const ndcHashOf = (ndc: string) => hashString(ndc).toString();
const prescriberWallet = (i: number): string => svc.getPrescriberWalletId(i).toString();
let rpcId = 1;

async function rpc(method: string, params: Record<string, unknown>, headers: Record<string, string> = bearer): Promise<any> {
  const body = JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params });
  const r = await fetch(`${url}/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
  return r.json();
}
const byNode = (key: any, method: string, path: string, body: string) =>
  signRequest({ signerId: key.nodeId, privateKey: privateKeyFromSeedHex(key.seedHex), method, path, body });
/** POST /interactive/hold-member, as `who` asks it. */
async function hold(walletId: string, held: boolean, who: 'plan' | 'operator' | 'prescriber' | 'nobody' = 'plan'): Promise<{ status: number; json: any }> {
  const body = JSON.stringify({ walletId, held, reason: 'An employee reported that someone else used their invite' });
  const headers = who === 'operator' ? bearer : who === 'plan' ? byNode(insurerNode, 'POST', '/interactive/hold-member', body)
    : who === 'prescriber' ? byNode(prescriberNode, 'POST', '/interactive/hold-member', body) : {};
  const r = await fetch(`${url}/interactive/hold-member`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
  const text = await r.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, json };
}
const prescribe = () => svc.createPrescription({ prescriberIndex: 0, pharmacyIndex: 0, memberWalletId: W1, ndcHash: ndcHashOf(ABACAVIR), quantity: 30, refills: 0 });

beforeAll(async () => {
  process.env.ZKTRIDENT_FORMULARY_LIMIT = '100';
  const { InMemoryStore } = await import('../src/storage/local-store.js');
  const { WALLET_TREE_HEIGHT } = await import('../src/wallets/wallet-state.js');
  const { L2Node } = await import('../src/l2/l2-node.js');
  const { L2RpcServer } = await import('../src/l2/l2-rpc-server.js');
  const { registerInteractiveRoutes } = await import('../src/adjudication/interactive-routes.js');
  const { AdjudicationService } = await import('../src/adjudication/interactive-service.js');
  const { formularyRaw } = await import('../src/data/formulary-loader.js');
  const data = await import('../src/data/index.js');
  ({ signRequest, privateKeyFromSeedHex } = await import('../src/security/signed-request.js'));
  ({ deriveWalletSigningKey } = await import('../src/security/wallet-key.js'));
  ({ generateNodeKey } = await import('../src/security/node-roles.js'));
  ({ hashString } = await import('../src/zkp/hash-utils.js'));
  const { publishedTermsFrom } = await import('../src/l2/plan-terms.js');
  const { buildPlanFormulary } = await import('../src/onboarding/plan-formulary.js');
  const LC = await import('../src/engine/lifecycle.js');
  PRESCRIBERS = data.PRESCRIBERS;

  const emptyRoot = new MerkleTree(WALLET_TREE_HEIGHT).getRoot();
  node = new L2Node({ batchIntervalMs: 999_999, autoSettle: false, nodeId: 'seq-member-hold' }, new InMemoryStore(), emptyRoot, emptyRoot, Field(0));
  await node.enableAttestations();
  seq = node.getSequencer();
  seq.getFormularyService().loadFromNadac(formularyRaw);
  svc = new AdjudicationService(() => {}, () => {}, node);
  svc.compiled = true;
  svc.verifyOwnershipProof = async (_w: string, j: string) => j;
  svc.dispatchProof = async () => ({ proofJson: null, publicOutput: null, proveTimeMs: 0 });

  server = new L2RpcServer(node, { port: 0, host: '127.0.0.1', adminToken: OPERATOR, enableSSE: false });
  insurerNode = generateNodeKey('insurer-node');
  prescriberNode = generateNodeKey('prescriber-node');
  server.registerNodeKey(insurerNode.nodeId, insurerNode.publicKeyHex, 'insurer');
  server.registerNodeKey(prescriberNode.nodeId, prescriberNode.publicKeyHex, 'prescriber');
  registerInteractiveRoutes(server, svc);
  await server.start();
  url = `http://127.0.0.1:${server.getPort()}`;

  const r = await rpc('l2_registerEntity', {
    walletId: prescriberWallet(0), displayName: 'Prescriber 0', type: 'prescriber', npi: String(PRESCRIBERS[0].localData.prescriberId),
    signingPublicKeyHex: deriveWalletSigningKey(PRESCRIBERS[0].enrollmentKey).publicKeyHex,
  });
  expect(r.error).toBeUndefined();
  const base: any = {
    planId: 'PLAN-HOLD', name: 'Hold plan', coverageType: 1, copayAmountCents: 1000, deductibleAmountCents: 50000, oopMaxCents: 780000,
    annualBenefitMaxCents: 0, familyDeductibleAmountCents: 0, familyOopMaxCents: 0, familyAnnualBenefitMaxCents: 0, dispensingFeeCents: 1300,
    formularyNdcs: [ABACAVIR], networkProviderWalletIds: [], published: true, createdAt: 0, updatedAt: 0,
  };
  const root = buildPlanFormulary(base, data.getAllFormularyEntries()).root.toString();
  await node.storePlan({ ...base, formularyRoot: root, networkRoot: '0', publishedTerms: publishedTermsFrom(base, root, '0', 1) });
  seq.adminMutate('test', ({ provision }: any) => { provision(Field(BigInt(W1)), LC.LIFECYCLE_REGISTERED); });
  svc.approveMember({ walletId: W1, groupIdHash: ndcHashOf('GRP-HOLD'), planIdHash: ndcHashOf(base.planId), planId: base.planId, employerId: null, familyIdHash: null });
  await svc.registerMemberFromEnrollment({ walletId: W1, ownershipProofJson: '{}', displayName: 'Hold member' });
  await svc.assignPcpForDevice({ walletId: W1, pcpWalletId: prescriberWallet(0), effectiveDate: '20261103', specialty: 'Family Medicine', consentScopeFlags: 7 });
});

afterAll(async () => { await server?.stop(); });

describe('the plan holds a member while a report about its enrollment is reviewed', () => {
  let written: string;

  test('before any hold, the member is quoted and prescribed for', async () => {
    expect(svc.quoteMemberCost(W1, ndcHashOf(ABACAVIR), 30)).toMatchObject({ covered: true });
    written = (await prescribe()).prescriptionId;
    expect(typeof written).toBe('string');
  });

  test('held: no quote, no prescription, no fill', async () => {
    const r = await hold(W1, true);
    expect(r.status).toBe(200);                                           // before: no such route
    expect(r.json).toMatchObject({ walletId: W1, held: true });
    expect(svc.quoteMemberCost(W1, ndcHashOf(ABACAVIR), 30)).toMatchObject({ covered: false, reason: expect.stringMatching(/held/) });
    await expect(prescribe()).rejects.toThrow(/held while a report about its enrollment is reviewed/);
    svc.markFilled({ prescriptionId: written });
    await expect(svc.dispensePrescription({ prescriptionId: written, quantityDispensed: 30 })).rejects.toThrow(/held while a report about its enrollment is reviewed/);
  });

  test('the hold survives a restart of the engine\'s state', () => {
    const state = svc.exportState();
    const saved = (state.enrolledMembers as any[]).find((m) => m.walletId === W1);
    expect(saved.held).toMatchObject({ reason: expect.stringMatching(/reported/) });
    svc.enrolledMembers.get(W1).held = undefined;
    svc.restoreState(state);
    expect(svc.enrolledMembers.get(W1).held).toMatchObject({ reason: expect.stringMatching(/reported/) });
  });

  test('released: quoted and prescribed for again', async () => {
    const r = await hold(W1, false, 'operator');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ walletId: W1, held: false });
    expect(svc.quoteMemberCost(W1, ndcHashOf(ABACAVIR), 30)).toMatchObject({ covered: true });
    await expect(prescribe()).resolves.toMatchObject({ prescriptionId: expect.any(String) });
  });

  test('only the plan and the operator hold a member, and only one the engine enrolled', async () => {
    expect((await hold(W1, true, 'nobody')).status).toBe(401);
    expect((await hold(W1, true, 'prescriber')).status).toBe(403);
    expect(svc.enrolledMembers.get(W1).held).toBeUndefined();
    expect((await hold('79300000000000000099', true)).status).toBe(404);
  });
});
