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
 * The step-therapy display read answers from the plan as published now, and rebinds no one.
 *
 * What was wrong: GET /interactive/step-therapy-check resolved the member's entry from the formulary its credential
 * names. After a republish the credential names the older root until the member's next prescribe, PA approval or fill;
 * the engine kept that version only in memory, so after a restart the read answered 409 ("credential names a formulary
 * plan P does not publish now") for a plan that is published, and without a restart it answered from the older
 * version, while the next prescribe enforced the new one.
 *
 * Now a display read for a member whose plan has published terms answers from the plan's current published formulary,
 * the version the next prescribe binds it to, without rebinding it; never a 409 for a plan with published terms.
 *
 * A real L2Node sequencer and RPC server and a real AdjudicationService with the engine's routes; nothing proved.
 */
import { Field, MerkleTree } from 'o1js';

jest.setTimeout(300_000);

const OPERATOR = 'operator-token-for-step-display';
const ABACAVIR = '00378410591';
const ACULAR = '00023218105';   // step therapy required in the catalog
const W = '79400000000000000001';
let node: any;
let seq: any;
let svc: any;
let server: any;
let url: string;
let AdjudicationService: any;
let registerInteractiveRoutes: any;
let L2RpcServer: any;
let hashString: (s: string) => Field;
let LC: any;
let publishedTermsFrom: any;
let buildPlanFormulary: any;
let catalog: any[];
const ndcHashOf = (ndc: string) => hashString(ndc).toString();

function publishedPlan(formularyNdcs: string[]): any {
  const base: any = {
    planId: 'PLAN-STEP', name: 'Step plan', coverageType: 1, copayAmountCents: 1500, deductibleAmountCents: 50000, oopMaxCents: 780000,
    annualBenefitMaxCents: 0, familyDeductibleAmountCents: 0, familyOopMaxCents: 0, familyAnnualBenefitMaxCents: 0,
    formularyNdcs, networkProviderWalletIds: [], published: true, createdAt: 0, updatedAt: 0,
  };
  const root = buildPlanFormulary(base, catalog).root.toString();
  return { ...base, formularyRoot: root, networkRoot: '0', publishedTerms: publishedTermsFrom(base, root, '0', Date.now()) };
}

async function startEngine(withServer: boolean): Promise<void> {
  svc = new AdjudicationService(() => {}, () => {}, node);
  svc.compiled = true;
  svc.verifyOwnershipProof = async (_w: string, j: string) => j;
  if (withServer) {
    server = new L2RpcServer(node, { port: 0, host: '127.0.0.1', adminToken: OPERATOR, enableSSE: false });
    registerInteractiveRoutes(server, svc);
    await server.start();
    url = `http://127.0.0.1:${server.getPort()}`;
  }
}

beforeAll(async () => {
  process.env.ZKTRIDENT_FORMULARY_LIMIT = '100';
  const { InMemoryStore } = await import('../src/storage/local-store.js');
  const { WALLET_TREE_HEIGHT } = await import('../src/wallets/wallet-state.js');
  const { L2Node } = await import('../src/l2/l2-node.js');
  ({ L2RpcServer } = await import('../src/l2/l2-rpc-server.js'));
  ({ registerInteractiveRoutes } = await import('../src/adjudication/interactive-routes.js'));
  ({ AdjudicationService } = await import('../src/adjudication/interactive-service.js'));
  ({ hashString } = await import('../src/zkp/hash-utils.js'));
  ({ publishedTermsFrom } = await import('../src/l2/plan-terms.js'));
  ({ buildPlanFormulary } = await import('../src/onboarding/plan-formulary.js'));
  const { getAllFormularyEntries } = await import('../src/data/index.js');
  LC = await import('../src/engine/lifecycle.js');
  catalog = getAllFormularyEntries();
  expect(catalog.find((d) => d.ndc === ACULAR)?.stepTherapyRequired).toBe(true);

  const emptyRoot = new MerkleTree(WALLET_TREE_HEIGHT).getRoot();
  node = new L2Node({ batchIntervalMs: 999_999, autoSettle: false, nodeId: 'seq-step-display' }, new InMemoryStore(), emptyRoot, emptyRoot, Field(0));
  seq = node.getSequencer();
  await startEngine(false);
  await node.storePlan(publishedPlan([ABACAVIR]));   // version 1: no ACULAR
  seq.adminMutate('test', ({ provision }: any) => { provision(Field(BigInt(W)), LC.LIFECYCLE_REGISTERED); });
  svc.approveMember({ walletId: W, groupIdHash: ndcHashOf('GRP-STEP'), planIdHash: ndcHashOf('PLAN-STEP'), planId: 'PLAN-STEP', employerId: null, familyIdHash: null });
  await svc.registerMemberFromEnrollment({ walletId: W, ownershipProofJson: '{}', displayName: 'Step member' });
  await node.storePlan(publishedPlan([ABACAVIR, ACULAR]));   // version 2 lists ACULAR; the member still names version 1
});

afterAll(async () => { await server?.stop(); });

test('before a restart: answered from the version published now, and the member is not rebound', () => {
  const m = svc.enrolledMembers.get(W);
  const commitment = m.eligibilityData.commitment().toString();
  const updates = svc.walletUpdatesFor(W).length;
  expect(m.eligibilityData.formularyRoot.toString()).not.toBe(seq.getPlan('PLAN-STEP').publishedTerms.formularyRoot);
  // ACULAR is not on version 1; the answer comes from version 2, where it is and needs step therapy
  expect(svc.checkStepTherapy(W, ndcHashOf(ACULAR)).message).not.toBe('Step therapy not required');
  expect(svc.checkStepTherapy(W, ndcHashOf(ABACAVIR)).message).toBe('Step therapy not required');
  expect(m.eligibilityData.commitment().toString()).toBe(commitment);
  expect(svc.walletUpdatesFor(W)).toHaveLength(updates);
});

test('after a restart, with no version held in memory: still answered, never a 409, over the route too', async () => {
  const checkpoint = svc.exportState();
  await startEngine(true);
  svc.restoreState(checkpoint);
  expect(svc.planFormularies.size).toBe(0);
  const m = svc.enrolledMembers.get(W);
  const commitment = m.eligibilityData.commitment().toString();
  expect(svc.checkStepTherapy(W, ndcHashOf(ACULAR)).allowed).toBe(true);   // no prerequisite class defined for it in the catalog
  const r = await fetch(`${url}/interactive/step-therapy-check?memberWalletId=${W}&ndcHash=${ndcHashOf(ABACAVIR)}`, { headers: { Authorization: `Bearer ${OPERATOR}` } });
  expect(r.status).toBe(200);
  expect((await r.json()).message).toBe('Step therapy not required');
  // a drug off the published plan is still refused, with its own status
  const off = await fetch(`${url}/interactive/step-therapy-check?memberWalletId=${W}&ndcHash=${ndcHashOf('00173071622')}`, { headers: { Authorization: `Bearer ${OPERATOR}` } });
  expect(off.status).toBe(403);
  expect(m.eligibilityData.commitment().toString()).toBe(commitment);
});
