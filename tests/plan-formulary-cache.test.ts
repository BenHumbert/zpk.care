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
 * The plan formulary cache, and the refusals that run before a plan's formulary is built.
 *
 * What was wrong: the engine kept 32 plan formularies and dropped the oldest built, a hit not counting as use, so with
 * more than 32 live plans every prescription, PA approval and fill rebuilt one on the thread the sequencer shares
 * (about 11 s at the 1,024-drug cap). Refused requests paid it too: the plan binding ran before the consent, quantity,
 * duplicate and stated-cost checks.
 *
 * Now the cache drops the least recently used; it holds at least 32 versions and grows to the number of published
 * plans, up to a ceiling set by memory (about 0.23 MB a 100-drug plan, 2.0 MB at the cap), past which the engine warns
 * once per new count. Consent at prescribing, and the quantity, duplicate and stated-cost checks at dispense, run before
 * the binding, so a refused request builds nothing.
 *
 * A real L2Node sequencer and a real AdjudicationService; programs not compiled, nothing proved.
 */
import { Field, MerkleTree } from 'o1js';

jest.setTimeout(300_000);

const ABACAVIR = '00378410591';
const ADVAIR = '00173071622';
const W = '79300000000000000001';
let node: any;
let seq: any;
let svc: any;
let events: Array<{ type: string; message: string }> = [];
let AdjudicationService: any;
let hashString: (s: string) => Field;
let LC: any;
let publishedTermsFrom: any;
let buildPlanFormulary: any;
let catalog: any[];
const ndcHashOf = (ndc: string) => hashString(ndc).toString();

/** A plan published with these terms (one drug unless named), not necessarily stored on the sequencer. */
function publishedPlan(planId: string, over: Record<string, unknown> = {}): any {
  const base: any = {
    planId, name: planId, coverageType: 1, copayAmountCents: 1500, deductibleAmountCents: 50000, oopMaxCents: 780000,
    annualBenefitMaxCents: 0, familyDeductibleAmountCents: 0, familyOopMaxCents: 0, familyAnnualBenefitMaxCents: 0,
    formularyNdcs: [ABACAVIR], networkProviderWalletIds: [], published: true, createdAt: 0, updatedAt: 0, ...over,
  };
  const root = buildPlanFormulary(base, catalog).root.toString();
  return { ...base, formularyRoot: root, networkRoot: '0', publishedTerms: publishedTermsFrom(base, root, '0', 1) };
}

beforeAll(async () => {
  process.env.ZKTRIDENT_FORMULARY_LIMIT = '100';
  const { InMemoryStore } = await import('../src/storage/local-store.js');
  const { WALLET_TREE_HEIGHT } = await import('../src/wallets/wallet-state.js');
  const { L2Node } = await import('../src/l2/l2-node.js');
  ({ AdjudicationService } = await import('../src/adjudication/interactive-service.js'));
  ({ hashString } = await import('../src/zkp/hash-utils.js'));
  ({ publishedTermsFrom } = await import('../src/l2/plan-terms.js'));
  ({ buildPlanFormulary } = await import('../src/onboarding/plan-formulary.js'));
  const { getAllFormularyEntries } = await import('../src/data/index.js');
  LC = await import('../src/engine/lifecycle.js');
  catalog = getAllFormularyEntries();
  const emptyRoot = new MerkleTree(WALLET_TREE_HEIGHT).getRoot();
  node = new L2Node({ batchIntervalMs: 999_999, autoSettle: false, nodeId: 'seq-plan-cache' }, new InMemoryStore(), emptyRoot, emptyRoot, Field(0));
  seq = node.getSequencer();
  svc = new AdjudicationService((e: { type: string; message: string }) => events.push(e), () => {}, node);
  svc.compiled = true;
  svc.verifyOwnershipProof = async (_w: string, j: string) => j;
});

describe('the cache keeps the most recently used plan formularies', () => {
  test('a hit counts as use: past capacity the least recently used goes, not the first built', () => {
    svc.planFormularies.clear();
    const plans = Array.from({ length: 33 }, (_, i) => publishedPlan(`PLAN-LRU-${i}`, { copayAmountCents: 100 + i }));
    for (const p of plans.slice(0, 32)) svc.publishedPlanFormulary(p);   // 32 versions, none stored on the sequencer
    expect(svc.planFormularies.size).toBe(32);
    const first = svc.planFormularies.get(plans[0].formularyRoot);
    expect(svc.publishedPlanFormulary(plans[0])).toBe(first);            // a hit, no rebuild
    svc.publishedPlanFormulary(plans[32]);                               // one more: the least recently used goes
    expect(svc.planFormularies.size).toBe(32);
    expect(svc.planFormularies.has(plans[0].formularyRoot)).toBe(true);
    expect(svc.planFormularies.has(plans[1].formularyRoot)).toBe(false);
  });

  test('it grows to the number of published plans, so every live plan stays built', async () => {
    svc.planFormularies.clear();
    const plans = Array.from({ length: 40 }, (_, i) => publishedPlan(`PLAN-LIVE-${i}`, { copayAmountCents: 200 + i }));
    for (const p of plans) await node.storePlan(p);
    for (const p of plans) svc.publishedPlanFormulary(p);
    expect(svc.planFormularies.size).toBe(40);
    for (const p of plans) expect(svc.publishedPlanFormulary(p)).toBe(svc.planFormularies.get(p.formularyRoot));
    for (const p of plans) await node.deletePlan(p.planId);
  });

  test('past the memory ceiling it warns once per new count, naming it', async () => {
    const ceiling = AdjudicationService.PLAN_FORMULARY_CACHE_MAX;
    AdjudicationService.PLAN_FORMULARY_CACHE_MAX = 3;
    try {
      svc.planFormularies.clear();
      events = [];
      const plans = Array.from({ length: 5 }, (_, i) => publishedPlan(`PLAN-CEIL-${i}`, { copayAmountCents: 300 + i }));
      for (const p of plans.slice(0, 4)) await node.storePlan(p);
      for (const p of plans.slice(0, 4)) svc.publishedPlanFormulary(p);
      expect(svc.planFormularies.size).toBe(3);
      await node.storePlan(plans[4]);
      svc.publishedPlanFormulary(plans[4]);
      svc.publishedPlanFormulary(plans[0]);
      const warnings = events.filter((e) => e.type === 'warn').map((e) => e.message);
      expect(warnings).toHaveLength(2);
      expect(warnings[0]).toMatch(/^4 plans are published, more than the 3 plan formularies the engine keeps built/);
      expect(warnings[1]).toMatch(/^5 plans are published/);
      for (const p of plans) await node.deletePlan(p.planId);
    } finally {
      AdjudicationService.PLAN_FORMULARY_CACHE_MAX = ceiling;
    }
  });
});

describe('a refused request builds no plan formulary', () => {
  let builds: jest.SpyInstance;
  let abacavirEntry: any;   // the entry the member's prescriptions were proven with, before the republish
  beforeAll(async () => {
    await node.storePlan(publishedPlan('PLAN-CHEAP-REFUSALS', { formularyNdcs: [ABACAVIR, ADVAIR] }));
    seq.adminMutate('test', ({ provision }: any) => { provision(Field(BigInt(W)), LC.LIFECYCLE_REGISTERED); });
    svc.approveMember({ walletId: W, groupIdHash: ndcHashOf('GRP-CACHE'), planIdHash: ndcHashOf('PLAN-CHEAP-REFUSALS'), planId: 'PLAN-CHEAP-REFUSALS', employerId: null, familyIdHash: null });
    await svc.registerMemberFromEnrollment({ walletId: W, ownershipProofJson: '{}', displayName: 'Cache member' });
    abacavirEntry = svc.formularyEntryFor(svc.enrolledMembers.get(W), ndcHashOf(ABACAVIR)).entry;
    // the insurer republishes at another copay: the member's next action would build the new version
    await node.storePlan(publishedPlan('PLAN-CHEAP-REFUSALS', { formularyNdcs: [ABACAVIR, ADVAIR], copayAmountCents: 1750 }));
    svc.planFormularies.clear();
    builds = jest.spyOn(svc, 'publishedPlanFormulary');
  });
  beforeEach(() => { builds.mockClear(); svc.dispatchProof = jest.fn().mockRejectedValue(new Error('no proof in this test')); });
  afterAll(() => builds.mockRestore());

  /** A FILLED prescription of 30 ABACAVIR for the member at pharmacy 0. */
  function filled(id: string): string {
    svc.prescriptions.set(id, {
      id, memberWalletId: W, ndcHash: ndcHashOf(ABACAVIR), pharmacyIndex: 0, prescriberIndex: 0, quantity: 30, quantityDispensed: 0, refills: 0, refillsUsed: 0,
      status: 'FILLED', statusHistory: [], formularyEntry: abacavirEntry,
    });
    return id;
  }

  test('prescribing by a prescriber the member never consented to', async () => {
    await expect(svc.createPrescription({ prescriberIndex: 1, pharmacyIndex: 0, memberWalletId: W, ndcHash: ndcHashOf(ABACAVIR), quantity: 30, refills: 0 }))
      .rejects.toMatchObject({ status: 403, message: expect.stringMatching(/primary-care prescriber/) });
    expect(builds).not.toHaveBeenCalled();
  });

  test('a dispense that states its own cost', async () => {
    await expect(svc.dispensePrescription({ prescriptionId: filled('RX-CACHE-1'), statedIngredientCostCents: 0, statedDispensingFeeCents: 1300 }))
      .rejects.toMatchObject({ status: 409, message: expect.stringMatching(/does not set the price/) });
    expect(builds).not.toHaveBeenCalled();
  });

  test('a dispense of more than was prescribed, or of a quantity that is not one', async () => {
    await expect(svc.dispensePrescription({ prescriptionId: filled('RX-CACHE-2'), quantityDispensed: 31 })).rejects.toThrow(/exceeds remaining prescribed qty/);
    await expect(svc.dispensePrescription({ prescriptionId: filled('RX-CACHE-3'), quantityDispensed: 0 })).rejects.toMatchObject({ status: 400 });
    expect(builds).not.toHaveBeenCalled();
  });

  test('a request that passes those checks binds the member to the republished version', async () => {
    await expect(svc.dispensePrescription({ prescriptionId: filled('RX-CACHE-4') })).rejects.toThrow('no proof in this test');
    expect(builds).toHaveBeenCalled();
    expect(svc.enrolledMembers.get(W).eligibilityData.copayAmountCents.toBigInt()).toBe(1750n);
  });
});
