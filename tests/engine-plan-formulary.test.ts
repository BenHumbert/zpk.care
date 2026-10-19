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
 * The engine binds a member with a device to the plan the insurer published (plan-bound formularies).
 *
 * What was wrong: registerMemberFromEnrollment gave every member the console's shared EligibilityData (PLAN-GOLD-2026,
 * ACME-CORP, copay 3000, the console's formulary root), so the plan's copay and drug list were never bound, the
 * credential named neither the approved plan nor the employer group, and the fill charged the catalog's tier copay.
 *
 * Now the member's EligibilityData names the approved plan, the approval's group, the plan's copay and the formulary the
 * plan published; prescribing, PA approval and the fill resolve the member's entry from that formulary and refuse a
 * drug that is not on it before any proof; EligibilityProgram uses the member's own registry leaf; a republish rebinds
 * the member at its next action while a draft does not, also after a restart (the published terms are on the plan
 * record); a fixture member keeps the console's PLAN-GOLD-2026 formulary and its tier copays.
 *
 * A real L2Node sequencer and a real AdjudicationService, programs not compiled, nothing proved. The formulary is cut
 * to 100 drugs before anything loads src/data.
 */
import fs from 'fs';
import { Field, MerkleTree } from 'o1js';

jest.setTimeout(300_000);

let node: any;
let seq: any;
let svc: any;
let LC: any;
let hashString: (s: string) => Field;
let ForestDomain: any;
let buildPlanFormulary: any;
let publishedTermsFrom: any;
let AdjudicationService: any;
let catalog: any[];
let onPlan: string[];      // two tier-1 drugs and one tier-2 drug, claimable
let offPlan: string;       // another claimable drug, not on the plan
let paDrug: string;        // a prior-auth drug, not on the plan
let tier2: string;         // the tier-2 drug on the plan
let P: any;
let m: any;
const W = '77000000000000000001';
let nextWallet = 77_000_000_000_000_000_100n;
const ndcHashOf = (ndc: string) => hashString(ndc).toString();

function publishedPlan(over: Record<string, unknown>): any {
  const base: any = {
    planId: 'PLAN-PBF-1', name: 'Plan-bound', coverageType: 1, copayAmountCents: 1500, deductibleAmountCents: 50000, oopMaxCents: 780000,
    annualBenefitMaxCents: 0, familyDeductibleAmountCents: 0, familyOopMaxCents: 0, familyAnnualBenefitMaxCents: 0,
    formularyNdcs: onPlan, networkProviderWalletIds: [], published: true, createdAt: 0, updatedAt: 0, ...over,
  };
  const root = buildPlanFormulary(base, catalog).root.toString();
  return { ...base, formularyRoot: root, networkRoot: '0', publishedTerms: publishedTermsFrom(base, root, '0', 1) };
}

/** A wallet the member's own registration proof put at REGISTERED, approved by the insurer into `planId`. */
function approvedWallet(planId: string, planIdHash = ndcHashOf(planId)): string {
  const w = (nextWallet++).toString();
  seq.adminMutate('test', ({ provision }: any) => { provision(Field(BigInt(w)), LC.LIFECYCLE_REGISTERED); });
  svc.approveMember({ walletId: w, groupIdHash: ndcHashOf('GRP-PBF'), planIdHash, planId, employerId: null, familyIdHash: null });
  return w;
}

beforeAll(async () => {
  process.env.ZKTRIDENT_FORMULARY_LIMIT = '100';
  const { InMemoryStore } = await import('../src/storage/local-store.js');
  const { WALLET_TREE_HEIGHT } = await import('../src/wallets/wallet-state.js');
  const { L2Node } = await import('../src/l2/l2-node.js');
  ({ AdjudicationService } = await import('../src/adjudication/interactive-service.js'));
  ({ hashString } = await import('../src/zkp/hash-utils.js'));
  ({ ForestDomain } = await import('../src/zkp/merkle-forest.js'));
  ({ buildPlanFormulary } = await import('../src/onboarding/plan-formulary.js'));
  ({ publishedTermsFrom } = await import('../src/l2/plan-terms.js'));
  const { getAllFormularyEntries } = await import('../src/data/index.js');
  LC = await import('../src/engine/lifecycle.js');
  catalog = getAllFormularyEntries();
  const claimable = catalog.filter((d) => !d.requiresPriorAuth && !d.stepTherapyRequired && d.maxQuantityPerFill >= 30);
  const tier1 = claimable.filter((d) => d.tierLevel === 1);
  tier2 = claimable.find((d) => d.tierLevel === 2)!.ndc;
  onPlan = [tier1[0].ndc, tier1[1].ndc, tier2];
  offPlan = tier1[2].ndc;
  paDrug = catalog.find((d) => d.requiresPriorAuth)!.ndc;

  const emptyRoot = new MerkleTree(WALLET_TREE_HEIGHT).getRoot();
  node = new L2Node({ batchIntervalMs: 999_999, autoSettle: false, nodeId: 'seq-plan-formulary' }, new InMemoryStore(), emptyRoot, emptyRoot, Field(0));
  seq = node.getSequencer();
  svc = new AdjudicationService(() => {}, () => {}, node);
  svc.compiled = true;
  svc.verifyOwnershipProof = async (_w: string, j: string) => j;

  P = publishedPlan({});
  await node.storePlan(P);
  seq.adminMutate('test', ({ provision }: any) => { provision(Field(BigInt(W)), LC.LIFECYCLE_REGISTERED); });
  svc.approveMember({ walletId: W, groupIdHash: ndcHashOf('GRP-PBF'), planIdHash: ndcHashOf(P.planId), planId: P.planId, employerId: null, familyIdHash: null });
  await svc.registerMemberFromEnrollment({ walletId: W, ownershipProofJson: '{}', displayName: 'PBF' });
  m = svc.enrolledMembers.get(W);
});

describe('a member with a device is bound to the plan the insurer published', () => {
  test('the credential names the approved plan, the approval\'s group, the plan\'s copay and the published root', () => {
    expect(m).toBeDefined();
    expect(m.eligibilityData.planIdHash.toString()).toBe(ndcHashOf(P.planId));
    expect(m.eligibilityData.groupIdHash.toString()).toBe(ndcHashOf('GRP-PBF'));
    expect(m.eligibilityData.copayAmountCents.toBigInt()).toBe(1500n);
    expect(m.eligibilityData.coverageType.toBigInt()).toBe(1n);
    expect(m.eligibilityData.formularyRoot.toString()).toBe(P.formularyRoot);
    expect(m.eligibilityData.networkRoot.toString()).toBe('0');
    const leaf0 = m.forest.getLeaf(ForestDomain.ACCESS_CONTROL, 0n).toString();
    expect(leaf0).toBe(m.eligibilityData.commitment().toString());
    expect(leaf0).not.toBe(svc.sharedEligibilityData.commitment().toString());
    const mint = svc.walletUpdatesFor(W)[0];
    expect(mint.reason).toBe('credential mint');
    expect(mint.forestLeaves).toContainEqual({ domain: ForestDomain.ACCESS_CONTROL, index: '0', leaf: leaf0 });
  });

  test('a covered drug of any tier resolves to the plan entry at the plan copay, and its witness reaches the credential\'s root', () => {
    const c = svc.formularyEntryFor(m, ndcHashOf(tier2));
    expect(c.copayAmountCents).toBe(1500);
    expect(c.entry.tierLevel.toBigInt()).toBe(2n);
    expect(c.registry.getEntryWitness(c.leafIndex).calculateRoot(c.entry.commitment()).toString()).toBe(m.eligibilityData.formularyRoot.toString());
  });

  test('a drug the plan does not list is refused at prescribing, before any proof or pending prescription', async () => {
    m.pcpAssignment = { pcpWalletId: svc.prescriberWalletIds.get(0) };
    const r0 = svc.rxCounter;
    const rx0 = svc.prescriptions.size;
    const refused = svc.createPrescription({ prescriberIndex: 0, pharmacyIndex: 0, memberWalletId: W, ndcHash: ndcHashOf(offPlan), quantity: 30, refills: 0 });
    await expect(refused).rejects.toMatchObject({ name: 'RegistrationRefused', status: 403, message: expect.stringMatching(/not on the formulary of this member's plan \(PLAN-PBF-1\)/) });
    expect(svc.pendingPrescriptions.size).toBe(0);
    expect(svc.prescriptions.size).toBe(rx0);
    expect(svc.rxCounter).toBe(r0);
  });

  test('PA approval refuses a drug off the plan before writing the PA', async () => {
    const { paId } = svc.requestPriorAuth({ memberWalletId: W, prescriberIndex: 0, ndcHash: ndcHashOf(paDrug) });
    await expect(svc.approvePriorAuth(paId)).rejects.toMatchObject({ status: 403, message: expect.stringMatching(/not on the formulary/) });
    expect(m.forest.getLeaf(ForestDomain.ACCESS_CONTROL, 1n).toString()).toBe('0');
    expect(svc.nextPaLeafIndex.has(W)).toBe(false);
    expect(svc.priorAuths.get(paId).status).toBe('PENDING');
  });

  test('the EligibilityProgram witness is the member\'s own registry leaf; the console plan stays at 0', () => {
    const before = svc.benefitPlanRegistry.count;
    const i = svc.benefitPlanIndexOf(m.eligibilityData);
    expect(i).toBeGreaterThan(0n);
    expect(svc.benefitPlanIndexOf(m.eligibilityData)).toBe(i);
    expect(svc.benefitPlanRegistry.count).toBeLessThanOrEqual(before + 1);
    expect(svc.benefitPlanRegistry.getPlanWitness(i).calculateRoot(m.eligibilityData.commitment()).toString()).toBe(svc.benefitPlanRegistry.getRoot().toString());
    expect(svc.benefitPlanIndexOf(svc.sharedEligibilityData)).toBe(0n);
  });

  test('registration refuses a root the engine cannot rebuild, an unpublished plan, and a mismatched plan hash', async () => {
    const Q = { ...publishedPlan({ planId: 'PLAN-PBF-Q' }) };
    Q.publishedTerms = { ...Q.publishedTerms, formularyRoot: '1' };   // what publishing stored before plan binding
    Q.formularyRoot = '1';
    const R = { ...publishedPlan({ planId: 'PLAN-PBF-R' }), published: false, publishedTerms: undefined };
    await node.storePlan(Q);
    await node.storePlan(R);
    const cases: Array<[string, RegExp]> = [
      [approvedWallet('PLAN-PBF-Q'), /republish/],
      [approvedWallet('PLAN-PBF-R'), /not published/],
      [approvedWallet(P.planId, ndcHashOf('OTHER')), /plan hash/],
    ];
    for (const [w, why] of cases) {
      await expect(svc.registerMemberFromEnrollment({ walletId: w, ownershipProofJson: '{}', displayName: 'X' })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(why) });
      expect(svc.enrolledMembers.has(w)).toBe(false);
    }
  });

  test('a fixture member keeps the PLAN-GOLD-2026 formulary and its tier copays', () => {
    const f: any = { memberIndex: 0, planId: 'PLAN-GOLD-2026', eligibilityData: svc.sharedEligibilityData, lifecycle: 'ELIGIBLE' };
    const c = svc.formularyEntryFor(f, ndcHashOf(tier2));
    expect(c.copayAmountCents).toBe(3500);
    expect(c.registry).toBe(svc.formularyRegistry);
    const before = f.eligibilityData;
    svc.ensurePlanBinding(f, 'test');
    expect(f.eligibilityData).toBe(before);
  });

  test('republishing rebinds the member at its next action; a draft the insurer is editing does not', async () => {
    const P2 = publishedPlan({ copayAmountCents: 2500 });
    await node.storePlan(P2);
    const n0 = svc.walletUpdatesFor(W).length;
    svc.ensurePlanBinding(m, 'test');
    expect(m.eligibilityData.copayAmountCents.toBigInt()).toBe(2500n);
    expect(m.eligibilityData.formularyRoot.toString()).toBe(P2.formularyRoot);
    const leaf0 = m.forest.getLeaf(ForestDomain.ACCESS_CONTROL, 0n).toString();
    expect(leaf0).toBe(m.eligibilityData.commitment().toString());
    expect(m.credentialData.forestRoot.toString()).toBe(m.forest.getForestRoot().toString());
    const updates = svc.walletUpdatesFor(W);
    expect(updates.length).toBe(n0 + 1);
    const rebind = updates[updates.length - 1];
    expect(rebind.reason).toBe('plan binding');
    expect(rebind.forestLeaves).toContainEqual({ domain: ForestDomain.ACCESS_CONTROL, index: '0', leaf: leaf0 });
    expect(rebind.newInventoryRoot).toBe(m.credentialInventory.getRoot().toString());
    svc.ensurePlanBinding(m, 'test');
    expect(svc.walletUpdatesFor(W).length).toBe(n0 + 1);

    // A draft: the insurer edits the copay, which unpublishes the live record; the published terms stay.
    await node.storePlan({ ...P2, copayAmountCents: 3000, published: false });
    svc.ensurePlanBinding(m, 'test');
    expect(m.eligibilityData.copayAmountCents.toBigInt()).toBe(2500n);
    expect(svc.walletUpdatesFor(W).length).toBe(n0 + 1);
    expect(svc.formularyEntryFor(m, ndcHashOf(onPlan[0])).copayAmountCents).toBe(2500);
  });

  test('a member stays served at its published terms while the plan is a draft, also after a restart', async () => {
    // the plan is still the draft from the test above: live copay 3000, published false, published terms at 2500
    expect(seq.getPlan(P.planId).published).toBe(false);
    const restarted = new AdjudicationService(() => {}, () => {}, node);
    restarted.compiled = true;
    const pcp = m.pcpAssignment;   // the stand-in assignment of the prescribing test has no commitment to export
    delete m.pcpAssignment;
    const checkpoint = svc.exportState();
    m.pcpAssignment = pcp;
    restarted.restoreState(checkpoint);
    expect(restarted.planFormularies.size).toBe(0);   // nothing built in memory yet: only the plan record can serve it
    const m2 = restarted.enrolledMembers.get(W);
    const c = restarted.formularyEntryFor(m2, ndcHashOf(onPlan[1]));
    expect(c.copayAmountCents).toBe(2500);
    const commitment = m2.eligibilityData.commitment().toString();
    restarted.ensurePlanBinding(m2, 'test');
    expect(m2.eligibilityData.commitment().toString()).toBe(commitment);
  });

  test('the console\'s formulary change does not touch a member with a device', async () => {
    const commitment = m.eligibilityData.commitment().toString();
    const n0 = svc.walletUpdatesFor(W).length;
    await svc.updateFormularyEntry({ ndcHash: ndcHashOf(onPlan[0]), action: 'MODIFY', newCopayAmountCents: 1234 });
    expect(m.eligibilityData.commitment().toString()).toBe(commitment);
    expect(svc.walletUpdatesFor(W).length).toBe(n0);
    expect(svc.benefitPlanIndexOf(svc.sharedEligibilityData)).toBe(0n);
  });

  test('step therapy follows the member\'s plan entry, not the console\'s formulary', async () => {
    // the console now marks the tier-2 drug as needing step therapy; the member's plan entry does not
    await svc.updateFormularyEntry({ ndcHash: ndcHashOf(tier2), action: 'MODIFY', newStepTherapyRequired: true });
    expect(svc.checkStepTherapy(W, ndcHashOf(tier2)).message).toBe('Step therapy not required');
    const f: any = { memberIndex: 0, planId: 'PLAN-GOLD-2026', eligibilityData: svc.sharedEligibilityData, lifecycle: 'ELIGIBLE', walletIdStr: 'fixture' };
    svc.enrolledMembers.set('fixture-step', f);
    expect(svc.checkStepTherapy('fixture-step', ndcHashOf(tier2)).message).not.toBe('Step therapy not required');
    svc.enrolledMembers.delete('fixture-step');
  });

  test('a fill is refused, before any proof, for a drug a republish dropped from the plan', async () => {
    const dropped = onPlan[1];
    await node.storePlan(publishedPlan({ copayAmountCents: 2500, formularyNdcs: [onPlan[0], tier2] }));
    svc.prescriptions.set('RX-PBF-DROPPED', {
      id: 'RX-PBF-DROPPED', memberWalletId: W, ndcHash: ndcHashOf(dropped), pharmacyIndex: 0, prescriberIndex: 0,
      quantity: 30, quantityDispensed: 0, status: 'FILLED', statusHistory: [], formularyEntry: svc.formularyEntryFor(m, ndcHashOf(onPlan[0])).entry,
    });
    const proofs = jest.fn();
    svc.dispatchProof = proofs;
    await expect(svc.dispensePrescription({ prescriptionId: 'RX-PBF-DROPPED' })).rejects.toMatchObject({ status: 403, message: expect.stringMatching(/not on the formulary of this member's plan/) });
    expect(proofs).not.toHaveBeenCalled();
    expect(svc.prescriptions.get('RX-PBF-DROPPED').status).toBe('FILLED');
    // the member was brought onto the republished plan first
    expect(m.eligibilityData.formularyRoot.toString()).toBe(seq.getPlan(P.planId).formularyRoot);
  });
});

describe('the engine in source', () => {
  const src = fs.readFileSync('src/adjudication/interactive-service.ts', 'utf8').replace(/\r\n/g, '\n');
  test('the fill proves the member\'s plan entry with the plan registry\'s witness, and the argument types are unchanged', () => {
    const dispatch = src.slice(src.indexOf("'AccumulatorFulfillment', 'proveFulfillmentWithAccumulator',"), src.indexOf('const elapsedFulf'));
    expect(dispatch).toContain('fulfillmentData, coverage.entry, rxForestRoots');
    expect(src).toContain('const fulfFormWitness = coverage.registry.getEntryWitness(coverage.leafIndex);');
    expect(src).not.toContain('this.formularyRegistry.getEntryWitness(rxState.formularyLeafIndex)');
    expect(dispatch).toContain("['CredentialData', 'PrescriptionData', 'PrescriptionStatusData', 'FulfillmentData', 'FormularyEntry', 'ForestRoots', 'ForestMerkleWitness', 'ForestMerkleWitness', 'ForestMerkleWitness', 'FormularyMerkleWitness', 'Field',");
  });

  test('prescribing resolves the entry after the network check and before the pending entry', () => {
    const fn = src.slice(src.indexOf('  async createPrescription('), src.indexOf('this.pendingPrescriptions.set(pendingRxId', src.indexOf('  async createPrescription(')));
    const network = fn.indexOf('inNetworkPharmacyIndices.includes(opts.pharmacyIndex)');
    const coverage = fn.indexOf('const coverage = this.formularyEntryFor(enrolled, opts.ndcHash);');
    expect(network).toBeGreaterThan(0);
    expect(coverage).toBeGreaterThan(network);
    // the rxId check and the pending entry stay one synchronous stretch: no await between them (comments aside)
    expect(fn.replace(/\/\/[^\n]*/g, '')).not.toMatch(/\bawait\b/);
  });
});
