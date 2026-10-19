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
 * The engine prices every fill at NADAC x quantity plus the plan's dispensing fee, and the pharmacy cannot override it
 * (owner decision 2026-10-18).
 *
 * What was wrong: dispensePrescription took the ingredient cost and the fee from the request and filled in AWP x
 * quantity and $2.00 only when one was missing (a sent 0 was kept), so whoever dispensed set the price.
 *
 * Now the engine quotes the drug's NADAC price and the fee of the member's plan as published (the network default for
 * a fixture, whose PLAN-GOLD-2026 has no plan record), and a request that states different costs is refused with 409
 * before any proof; stating exactly the engine's price is accepted.
 *
 * A real L2Node sequencer and a real AdjudicationService on the plan-bound engine: a member registered against a
 * published plan with a $12.50 fee, programs not compiled; every proof dispatch is stopped, so each case ends right
 * after pricing. The formulary is cut to 100 drugs before anything loads src/data; its first drug is ABACAVIR 300 MG
 * TABLET at $0.60042 per tablet.
 */
import fs from 'fs';
import { Field, MerkleTree } from 'o1js';

jest.setTimeout(180_000);

const ABACAVIR = '00378410591';
const W = '78000000000000000001';
const FIXTURE_WALLET = '78000000000000000002';
let node: any;
let seq: any;
let svc: any;
let events: Array<{ message: string }> = [];
let plan: any;
let publishedTermsFrom: any;
let ndcHash: string;
let rxSeq = 0;

/** A FILLED prescription of 30 for this member at pharmacy 0, with the entry its formulary holds. */
function filled(memberWalletId: string): string {
  const id = `RX-NADAC-${++rxSeq}`;
  const enrolled = svc.enrolledMembers.get(memberWalletId);
  svc.prescriptions.set(id, {
    id, memberWalletId, ndcHash, pharmacyIndex: 0, prescriberIndex: 0, quantity: 30, quantityDispensed: 0, refills: 0, refillsUsed: 0,
    status: 'FILLED', statusHistory: [], formularyEntry: svc.formularyEntryFor(enrolled, ndcHash).entry,
  });
  return id;
}
const costLine = () => events.map((e) => e.message).find((m) => m.startsWith('  Cost: '));

beforeAll(async () => {
  process.env.ZKTRIDENT_FORMULARY_LIMIT = '100';
  const { InMemoryStore } = await import('../src/storage/local-store.js');
  const { WALLET_TREE_HEIGHT } = await import('../src/wallets/wallet-state.js');
  const { L2Node } = await import('../src/l2/l2-node.js');
  const { AdjudicationService } = await import('../src/adjudication/interactive-service.js');
  const { hashString } = await import('../src/zkp/hash-utils.js');
  const { buildPlanFormulary } = await import('../src/onboarding/plan-formulary.js');
  ({ publishedTermsFrom } = await import('../src/l2/plan-terms.js'));
  const { getAllFormularyEntries, MEDICATIONS } = await import('../src/data/index.js');
  const LC = await import('../src/engine/lifecycle.js');
  expect(MEDICATIONS[0].ndc).toBe(ABACAVIR);
  expect(MEDICATIONS[0].nadacPerUnit).toBe(0.60042);
  ndcHash = hashString(ABACAVIR).toString();

  const emptyRoot = new MerkleTree(WALLET_TREE_HEIGHT).getRoot();
  node = new L2Node({ batchIntervalMs: 999_999, autoSettle: false, nodeId: 'seq-nadac-dispense' }, new InMemoryStore(), emptyRoot, emptyRoot, Field(0));
  seq = node.getSequencer();
  svc = new AdjudicationService((e: { message: string }) => events.push(e), () => {}, node);
  svc.compiled = true;
  svc.verifyOwnershipProof = async (_w: string, j: string) => j;

  const base = {
    planId: 'PLAN-FEE', name: 'Fee plan', coverageType: 1, copayAmountCents: 1000, deductibleAmountCents: 50000, oopMaxCents: 780000,
    annualBenefitMaxCents: 0, familyDeductibleAmountCents: 0, familyOopMaxCents: 0, familyAnnualBenefitMaxCents: 0, dispensingFeeCents: 1250,
    formularyNdcs: [ABACAVIR], networkProviderWalletIds: [], published: true, createdAt: 0, updatedAt: 0,
  };
  const root = buildPlanFormulary(base, getAllFormularyEntries()).root.toString();
  plan = { ...base, formularyRoot: root, networkRoot: '0', publishedTerms: publishedTermsFrom(base, root, '0', 1) };
  await node.storePlan(plan);

  // a member with a device, registered against the published fee plan
  seq.adminMutate('test', ({ provision }: any) => { provision(Field(BigInt(W)), LC.LIFECYCLE_REGISTERED); });
  svc.approveMember({ walletId: W, groupIdHash: hashString('GRP-FEE').toString(), planIdHash: hashString('PLAN-FEE').toString(), planId: 'PLAN-FEE', employerId: null, familyIdHash: null });
  await svc.registerMemberFromEnrollment({ walletId: W, ownershipProofJson: '{}', displayName: 'Fee member' });

  // a fixture member: PLAN-GOLD-2026, no plan record on the sequencer, eligible on the ledger
  seq.adminMutate('test', ({ provision }: any) => { provision(Field(BigInt(FIXTURE_WALLET)), LC.LIFECYCLE_ELIGIBLE); });
  svc.enrolledMembers.set(FIXTURE_WALLET, {
    memberIndex: 0, walletId: Field(BigInt(FIXTURE_WALLET)), walletIdStr: FIXTURE_WALLET, displayName: 'Fixture', planId: 'PLAN-GOLD-2026',
    eligibilityData: svc.sharedEligibilityData, lifecycle: 'ELIGIBLE', inNetworkPrescriberIndices: [0], inNetworkPharmacyIndices: [0],
  });
});

beforeEach(() => {
  events = [];
  svc.dispatchProof = jest.fn().mockRejectedValue(new Error('stopped after pricing'));
});

describe('the engine prices the fill; the pharmacy does not set the price', () => {
  test('a dispense that states its own cost is refused before any proof', async () => {
    const id = filled(W);
    const refused = svc.dispensePrescription({ prescriptionId: id, statedIngredientCostCents: 0, statedDispensingFeeCents: 1300 });
    await expect(refused).rejects.toMatchObject({ name: 'RegistrationRefused', status: 409, message: expect.stringMatching(/does not set the price/) });
    await refused.catch((e: Error) => {
      expect(e.message).toContain('$18.01');
      expect(e.message).toContain('$12.50 (plan)');
    });
    expect(svc.dispatchProof).not.toHaveBeenCalled();
    expect(svc.prescriptions.get(id).status).toBe('FILLED');
    expect(svc.fulfillments.has(id)).toBe(false);
  });

  test('with no costs it is priced NADAC x quantity + the plan fee', async () => {
    await expect(svc.dispensePrescription({ prescriptionId: filled(W) })).rejects.toThrow('stopped after pricing');
    expect(costLine()).toBe('  Cost: NADAC $0.60042/EA x 30 = $18.01 + dispensing fee $12.50 (plan) = $30.51');
  });

  test('stating exactly the engine\'s price is accepted', async () => {
    await expect(svc.dispensePrescription({ prescriptionId: filled(W), statedIngredientCostCents: 1801, statedDispensingFeeCents: 1250 })).rejects.toThrow('stopped after pricing');
  });

  test('a fixture member pays the network default', async () => {
    await expect(svc.dispensePrescription({ prescriptionId: filled(FIXTURE_WALLET) })).rejects.toThrow('stopped after pricing');
    expect(costLine()).toBe('  Cost: NADAC $0.60042/EA x 30 = $18.01 + dispensing fee $10.00 (network default) = $28.01');
  });

  test('a numeric string is refused, never added', async () => {
    await expect(svc.dispensePrescription({ prescriptionId: filled(W), statedIngredientCostCents: '1801' })).rejects.toMatchObject({ status: 409 });
    expect(svc.dispatchProof).not.toHaveBeenCalled();
  });

  test('a partial fill is priced on the quantity dispensed', async () => {
    await expect(svc.dispensePrescription({ prescriptionId: filled(W), quantityDispensed: 10 })).rejects.toThrow('stopped after pricing');
    expect(costLine()).toBe('  Cost: NADAC $0.60042/EA x 10 = $6.00 + dispensing fee $12.50 (plan) = $18.50');
  });

  test('a fee the insurer is still drafting is not charged: the fill takes the fee the plan was published with', async () => {
    await node.storePlan({ ...plan, dispensingFeeCents: 9999, published: false });   // an edit; the published terms stay
    await expect(svc.dispensePrescription({ prescriptionId: filled(W) })).rejects.toThrow('stopped after pricing');
    expect(costLine()).toBe('  Cost: NADAC $0.60042/EA x 30 = $18.01 + dispensing fee $12.50 (plan) = $30.51');
    // published with no fee: the network default
    const noFee = { ...plan, dispensingFeeCents: null };
    await node.storePlan({ ...noFee, publishedTerms: publishedTermsFrom(noFee, plan.formularyRoot, '0', 2) });
    events = [];
    await expect(svc.dispensePrescription({ prescriptionId: filled(W) })).rejects.toThrow('stopped after pricing');
    expect(costLine()).toBe('  Cost: NADAC $0.60042/EA x 30 = $18.01 + dispensing fee $10.00 (network default) = $28.01');
    await node.storePlan(plan);
  });
});

describe('in source', () => {
  const engine = fs.readFileSync('src/adjudication/interactive-service.ts', 'utf8').replace(/\r\n/g, '\n');
  test('dispensePrescription prices from NADAC and checks stated costs before the first proof', () => {
    const fn = engine.slice(engine.indexOf('  async dispensePrescription('), engine.indexOf('  async reversePrescription('));
    expect(fn).not.toContain('awpUnitPriceCents');
    expect(fn).not.toContain('?? 200');
    expect(fn.indexOf('statedCostMismatch(')).toBeGreaterThan(0);
    expect(fn.indexOf('statedCostMismatch(')).toBeLessThan(fn.indexOf('dispatchProof('));
  });

  test('the pharmacy dashboard and the operator console send no costs', () => {
    const app = fs.readFileSync('dashboard-pharmacy/app.js', 'utf8').replace(/\r\n/g, '\n');
    const start = app.indexOf('function dispenseScript(');
    expect(start).toBeGreaterThan(0);
    const dispense = app.slice(start, app.indexOf('\n  function ', start + 10));
    expect(dispense).not.toContain('ingredientCostCents:');
    expect(dispense).not.toContain('1300');
    expect(fs.readFileSync('visualizer/src/js/interactive/pharmacy-phase.js', 'utf8')).not.toContain('dispensingFeeCents: 200');
  });
});
