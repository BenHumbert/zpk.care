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
 * A republish moves the member in full at its next prescribe, PA approval or fill: its own limits too.
 *
 * What was wrong: ensurePlanBinding moved the copay, formulary and network to the republished terms, and the fee and the
 * family limits followed them too, but the member's own deductible, OOP maximum and annual benefit maximum stayed as
 * bound at registration, while l2_getPlanLimits and the estimate reported the republished ones. A member whose plan
 * lowered its deductible kept paying the old one.
 *
 * The rule now: a member follows its plan's current published terms at its next action, limits included; the amounts
 * it has paid are kept. The limits are rebound in ensurePlanBinding through the same queued wallet update as the
 * copay and formulary: the accumulator leaf (ACCESS_CONTROL 127), the credential's forest root and the device's update
 * change together. A limit lowered below what is already paid counts as met (the circuit compares before it subtracts),
 * shown here with the fill circuit's own method on constants and the engine's A-35 root check;
 * tests/plan-republish-limits-proof.test.ts shows it with compiled proofs.
 *
 * A real L2Node sequencer and RPC server and a real AdjudicationService; programs not compiled; every proof skipped
 * except the fill, which is AccumulatorFulfillmentProgram's own method run on constants.
 */
import { Field, MerkleTree } from 'o1js';

jest.setTimeout(300_000);

const OPERATOR = 'operator-token-for-republish-limits';
const ABACAVIR = '00378410591';
const LOWER_DEDUCTIBLE = '79100000000000000001';
const LOWER_OOP = '79100000000000000002';

let node: any;
let seq: any;
let svc: any;
let server: any;
let url: string;
let hashString: (s: string) => Field;
let LC: any;
let publishedTermsFrom: any;
let buildPlanFormulary: any;
let withAmountsPaid: any;
let withLimits: any;
let CredentialData: any;
let ForestDomain: any;
let ACCUMULATOR_LEAF_INDEX: bigint;
let catalog: any[];
const ndcHashOf = (ndc: string) => hashString(ndc).toString();

function publishedPlan(over: Record<string, unknown>): any {
  const base: any = {
    planId: 'PLAN-RL', name: 'Republished limits', coverageType: 1, copayAmountCents: 1500, deductibleAmountCents: 50000, oopMaxCents: 780000,
    annualBenefitMaxCents: 0, familyDeductibleAmountCents: 100000, familyOopMaxCents: 1600000, familyAnnualBenefitMaxCents: 0, dispensingFeeCents: 1250,
    formularyNdcs: [ABACAVIR], networkProviderWalletIds: [], published: true, createdAt: 0, updatedAt: 0, ...over,
  };
  const root = buildPlanFormulary(base, catalog).root.toString();
  return { ...base, formularyRoot: root, networkRoot: '0', publishedTerms: publishedTermsFrom(base, root, '0', Date.now()) };
}

async function enroll(walletId: string, planId: string): Promise<any> {
  seq.adminMutate('test', ({ provision }: any) => { provision(Field(BigInt(walletId)), LC.LIFECYCLE_REGISTERED); });
  svc.approveMember({ walletId, groupIdHash: ndcHashOf('GRP-RL'), planIdHash: ndcHashOf(planId), planId, employerId: null, familyIdHash: 'FAMILY-RL' });
  await svc.registerMemberFromEnrollment({ walletId, ownershipProofJson: '{}', displayName: 'Republish member' });
  const m = svc.enrolledMembers.get(walletId);
  m.pcpAssignment = { pcpWalletId: svc.prescriberWalletIds.get(0) };
  return m;
}

/** What earlier fills left: the member's accumulator with these amounts paid, in its forest and its credential. */
function havePaid(m: any, paid: { deductiblePaidCents: number; oopPaidCents: number; annualBenefitUsedCents: number }): void {
  m.accumulatorData = withAmountsPaid(m.accumulatorData, paid);
  m.forest.setLeaf(ForestDomain.ACCESS_CONTROL, ACCUMULATOR_LEAF_INDEX, m.accumulatorData.commitment());
  const c = m.credentialData;
  m.credentialData = new CredentialData({ credentialType: c.credentialType, forestRoot: m.forest.getForestRoot(), issuerWalletId: c.issuerWalletId, subjectWalletId: c.subjectWalletId, issuedAt: c.issuedAt, expiresAt: c.expiresAt, revoked: c.revoked });
  m.credentialInventory.updateCredential(0n, m.credentialData);
}

const limitsOf = (m: any) => [m.accumulatorData.deductibleAmountCents, m.accumulatorData.oopMaxCents, m.accumulatorData.annualBenefitMaxCents].map((f: Field) => Number(f.toBigInt()));
const paidOf = (m: any) => [m.accumulatorData.deductiblePaidCents, m.accumulatorData.oopPaidCents, m.accumulatorData.annualBenefitUsedCents].map((f: Field) => Number(f.toBigInt()));

async function prescribeAndFill(walletId: string, ndc: string, quantity: number): Promise<any> {
  const rx = await svc.createPrescription({ prescriberIndex: 0, pharmacyIndex: 0, memberWalletId: walletId, ndcHash: ndcHashOf(ndc), quantity, refills: 0 });
  svc.markFilled({ prescriptionId: rx.prescriptionId });
  return svc.dispensePrescription({ prescriptionId: rx.prescriptionId, quantityDispensed: quantity });
}

async function rpc(method: string, params: Record<string, unknown>): Promise<any> {
  const r = await fetch(`${url}/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPERATOR}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  return r.json();
}

beforeAll(async () => {
  process.env.ZKTRIDENT_FORMULARY_LIMIT = '100';
  const { InMemoryStore } = await import('../src/storage/local-store.js');
  const { WALLET_TREE_HEIGHT } = await import('../src/wallets/wallet-state.js');
  const { L2Node } = await import('../src/l2/l2-node.js');
  const { L2RpcServer } = await import('../src/l2/l2-rpc-server.js');
  const { registerInteractiveRoutes } = await import('../src/adjudication/interactive-routes.js');
  const { AdjudicationService } = await import('../src/adjudication/interactive-service.js');
  const { AccumulatorFulfillmentProgram } = await import('../src/fulfillment/accumulator-fulfillment-program.js');
  const { formularyRaw } = await import('../src/data/formulary-loader.js');
  const { getAllFormularyEntries } = await import('../src/data/index.js');
  ({ hashString } = await import('../src/zkp/hash-utils.js'));
  ({ publishedTermsFrom } = await import('../src/l2/plan-terms.js'));
  ({ buildPlanFormulary } = await import('../src/onboarding/plan-formulary.js'));
  ({ withAmountsPaid, withLimits, ACCUMULATOR_LEAF_INDEX } = await import('../src/access-control/accumulator-data.js'));
  ({ CredentialData } = await import('../src/credentials/credential-data.js'));
  ({ ForestDomain } = await import('../src/zkp/merkle-forest.js'));
  LC = await import('../src/engine/lifecycle.js');
  catalog = getAllFormularyEntries();

  const emptyRoot = new MerkleTree(WALLET_TREE_HEIGHT).getRoot();
  node = new L2Node({ batchIntervalMs: 999_999, autoSettle: false, nodeId: 'seq-republish-limits' }, new InMemoryStore(), emptyRoot, emptyRoot, Field(0));
  seq = node.getSequencer();
  seq.getFormularyService().loadFromNadac(formularyRaw);
  svc = new AdjudicationService(() => {}, () => {}, node);
  svc.compiled = true;
  svc.verifyOwnershipProof = async (_w: string, j: string) => j;
  svc.dispatchProof = async (program: string, method: string, _types: string[], args: unknown[]) => {
    if (program !== 'AccumulatorFulfillment' || method !== 'proveFulfillmentWithAccumulator') return { proofJson: null, publicOutput: null, proveTimeMs: 0 };
    const r = await (AccumulatorFulfillmentProgram as any).rawMethods.proveFulfillmentWithAccumulator(...args);
    const out = r.publicOutput ?? r;
    const publicOutput: Record<string, string> = {};
    for (const [k, v] of Object.entries(out)) publicOutput[k] = String(v);
    return { proofJson: null, publicOutput, proveTimeMs: 0 };
  };
  server = new L2RpcServer(node, { port: 0, host: '127.0.0.1', adminToken: OPERATOR, enableSSE: false });
  registerInteractiveRoutes(server, svc);
  await server.start();
  url = `http://127.0.0.1:${server.getPort()}`;
});

afterAll(async () => { await server?.stop(); });

describe('the member\'s own limits follow a republish at its next action, with the amounts paid kept', () => {
  test('a deductible lowered below the deductible paid: the next fill is in the copay phase and credits nothing', async () => {
    await node.storePlan(publishedPlan({}));
    const m = await enroll(LOWER_DEDUCTIBLE, 'PLAN-RL');
    havePaid(m, { deductiblePaidCents: 30000, oopPaidCents: 30000, annualBenefitUsedCents: 0 });
    await node.storePlan(publishedPlan({ deductibleAmountCents: 25000, familyOopMaxCents: 1500000 }));   // the insurer republishes

    // the published limits are reported at once; the member is bound to them from its next action
    expect((await rpc('l2_getPlanLimits', { planId: 'PLAN-RL' })).result).toMatchObject({ deductibleAmountCents: 25000, familyOopMaxCents: 1500000 });
    expect(limitsOf(m)).toEqual([50000, 780000, 0]);
    const quote = (await rpc('l2_estimateCost', { walletId: LOWER_DEDUCTIBLE, ndcHash: ndcHashOf(ABACAVIR), quantity: 30 })).result;
    expect(quote).toMatchObject({ memberPayCents: 1500, employerPayCents: 1551, phase: 'copay' });
    expect(limitsOf(m)).toEqual([50000, 780000, 0]);   // a quote changes nothing

    const fill = await prescribeAndFill(LOWER_DEDUCTIBLE, ABACAVIR, 30);   // the engine's A-35 root check passes inside
    expect([fill.adjudication.patientPayCents, fill.adjudication.planPayCents]).toEqual([1500, 1551]);
    expect(fill.accumulator.after.deductiblePaidCents).toBe(30000);   // no deductible credit: the lowered deductible is met
    expect(fill.accumulator.limits).toMatchObject({ deductibleAmountCents: 25000, oopMaxCents: 780000, familyOopMaxCents: 1500000 });
    expect(limitsOf(m)).toEqual([25000, 780000, 0]);
    expect(paidOf(m)).toEqual([30000, 31500, 1551]);
  });

  test('the rebinding is one queued wallet update: the accumulator leaf and the credential\'s forest root change together', async () => {
    const updates = svc.walletUpdatesFor(LOWER_DEDUCTIBLE);
    const binding = updates.filter((u: any) => u.reason === 'plan binding');
    expect(binding).toHaveLength(1);
    const rebound = withLimits(withAmountsPaid(svc.enrolledMembers.get(LOWER_DEDUCTIBLE).accumulatorData, { deductiblePaidCents: 30000, oopPaidCents: 30000, annualBenefitUsedCents: 0 }), { deductibleAmountCents: 25000, oopMaxCents: 780000, annualBenefitMaxCents: 0 });
    expect(binding[0].forestLeaves).toContainEqual({ domain: ForestDomain.ACCESS_CONTROL, index: String(ACCUMULATOR_LEAF_INDEX), leaf: rebound.commitment().toString() });
    // the fill's update comes after it, from the rebound credential
    expect(updates.indexOf(binding[0])).toBeLessThan(updates.length - 1);
    // the device can rebuild the root it is asked to prove from the parts it is sent (checked when queued); and a
    // second binding with nothing new queues nothing
    const n = updates.length;
    svc.ensurePlanBinding(svc.enrolledMembers.get(LOWER_DEDUCTIBLE), 'test');
    expect(svc.walletUpdatesFor(LOWER_DEDUCTIBLE)).toHaveLength(n);
  });

  test('an OOP maximum lowered below the OOP paid: the member pays nothing', async () => {
    await node.storePlan(publishedPlan({ planId: 'PLAN-RL-OOP' }));
    const m = await enroll(LOWER_OOP, 'PLAN-RL-OOP');
    havePaid(m, { deductiblePaidCents: 50000, oopPaidCents: 600000, annualBenefitUsedCents: 0 });
    await node.storePlan(publishedPlan({ planId: 'PLAN-RL-OOP', oopMaxCents: 500000 }));
    const quote = (await rpc('l2_estimateCost', { walletId: LOWER_OOP, ndcHash: ndcHashOf(ABACAVIR), quantity: 30 })).result;
    expect(quote).toMatchObject({ memberPayCents: 0, employerPayCents: 3051, phase: 'oop-max-reached' });
    const fill = await prescribeAndFill(LOWER_OOP, ABACAVIR, 30);
    expect([fill.adjudication.patientPayCents, fill.adjudication.planPayCents]).toEqual([0, 3051]);
    expect(limitsOf(m)).toEqual([50000, 500000, 0]);
    expect(paidOf(m)).toEqual([50000, 600000, 3051]);
  });
});
