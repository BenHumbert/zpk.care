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
 * The BenefitPlanRegistry when it is full (128 leaves at height 8).
 *
 * What was wrong: createPrescription took `this.benefitPlanRegistry.getPlanWitness(this.benefitPlanIndexOf(elig))`.
 * JavaScript reads the registry before it evaluates the argument, and benefitPlanIndexOf replaces the registry when it
 * is full, so the EligibilityProgram witness came from the discarded tree and the root from the new one: that
 * prescription failed. And when live members named more than 128 distinct EligibilityData, the rebuild itself threw
 * inside its loop ("Benefit plan registry full"), a 500 on every prescription of a member outside the first 128.
 *
 * Now the index is computed first and the witness and root are taken from the same registry; a member with a device
 * is registered before any proof, and when the live versions exceed the registry's capacity the request is refused
 * with a 409 that says why, before anything is rebuilt.
 *
 * A real L2Node sequencer and a real AdjudicationService; programs not compiled, nothing proved.
 */
import { Field, MerkleTree } from 'o1js';

jest.setTimeout(300_000);

const ABACAVIR = '00378410591';
const W = '79200000000000000001';
const W2 = '79200000000000000002';
let node: any;
let seq: any;
let svc: any;
let hashString: (s: string) => Field;
let LC: any;
let EligibilityData: any;
let catalog: any[];
const ndcHashOf = (ndc: string) => hashString(ndc).toString();

/** A distinct EligibilityData no member holds. */
const anotherPlanVersion = (i: number) => new EligibilityData({
  planIdHash: hashString(`PLAN-OTHER-${i}`), groupIdHash: hashString('GRP-OTHER'), effectiveDate: Field(20260101), terminationDate: Field(0),
  copayAmountCents: Field(1000 + i), coverageType: Field(1), formularyRoot: Field(i + 1), networkRoot: Field(0),
});

function fillRegistryToCapacity(): void {
  // index 0 is the console's plan; fill the other 127 leaves with versions no live member names
  for (let i = 1; svc.benefitPlanRegistry.count < 128; i++) svc.benefitPlanIndexOf(anotherPlanVersion(i));
  expect(svc.benefitPlanRegistry.count).toBe(128);
}

beforeAll(async () => {
  process.env.ZKTRIDENT_FORMULARY_LIMIT = '100';
  const { InMemoryStore } = await import('../src/storage/local-store.js');
  const { WALLET_TREE_HEIGHT } = await import('../src/wallets/wallet-state.js');
  const { L2Node } = await import('../src/l2/l2-node.js');
  const { AdjudicationService } = await import('../src/adjudication/interactive-service.js');
  const { buildPlanFormulary } = await import('../src/onboarding/plan-formulary.js');
  const { publishedTermsFrom } = await import('../src/l2/plan-terms.js');
  const { getAllFormularyEntries } = await import('../src/data/index.js');
  ({ EligibilityData } = await import('../src/eligibility/eligibility-data.js'));
  ({ hashString } = await import('../src/zkp/hash-utils.js'));
  LC = await import('../src/engine/lifecycle.js');
  catalog = getAllFormularyEntries();

  const emptyRoot = new MerkleTree(WALLET_TREE_HEIGHT).getRoot();
  node = new L2Node({ batchIntervalMs: 999_999, autoSettle: false, nodeId: 'seq-plan-registry' }, new InMemoryStore(), emptyRoot, emptyRoot, Field(0));
  seq = node.getSequencer();
  svc = new AdjudicationService(() => {}, () => {}, node);
  svc.compiled = true;
  svc.verifyOwnershipProof = async (_w: string, j: string) => j;

  const base: any = {
    planId: 'PLAN-REG', name: 'Registry plan', coverageType: 1, copayAmountCents: 1500, deductibleAmountCents: 50000, oopMaxCents: 780000,
    annualBenefitMaxCents: 0, familyDeductibleAmountCents: 0, familyOopMaxCents: 0, familyAnnualBenefitMaxCents: 0,
    formularyNdcs: [ABACAVIR], networkProviderWalletIds: [], published: true, createdAt: 0, updatedAt: 0,
  };
  const root = buildPlanFormulary(base, catalog).root.toString();
  await node.storePlan({ ...base, formularyRoot: root, networkRoot: '0', publishedTerms: publishedTermsFrom(base, root, '0', 1) });
  seq.adminMutate('test', ({ provision }: any) => { provision(Field(BigInt(W)), LC.LIFECYCLE_REGISTERED); });
  svc.approveMember({ walletId: W, groupIdHash: ndcHashOf('GRP-REG'), planIdHash: ndcHashOf('PLAN-REG'), planId: 'PLAN-REG', employerId: null, familyIdHash: null });
  await svc.registerMemberFromEnrollment({ walletId: W, ownershipProofJson: '{}', displayName: 'Registry member' });
  svc.enrolledMembers.get(W).pcpAssignment = { pcpWalletId: svc.prescriberWalletIds.get(0) };
});

test('a full registry is rebuilt before the witness is taken: the EligibilityProgram witness reaches the root it is proven with', async () => {
  fillRegistryToCapacity();
  const m = svc.enrolledMembers.get(W);
  let eligibilityArgs: any[] | null = null;
  svc.dispatchProof = async (program: string, _method: string, _types: string[], args: any[]) => {
    if (program === 'Eligibility') { eligibilityArgs = args; throw new Error('stop after the eligibility inputs'); }
    return { proofJson: null, publicOutput: null, proveTimeMs: 0 };
  };
  await expect(svc.createPrescription({ prescriberIndex: 0, pharmacyIndex: 0, memberWalletId: W, ndcHash: ndcHashOf(ABACAVIR), quantity: 30, refills: 0 }))
    .rejects.toThrow('stop after the eligibility inputs');
  expect(eligibilityArgs).not.toBeNull();
  const [, eligibilityData, , , planWitness, planRoot] = eligibilityArgs!;
  expect(eligibilityData.commitment().toString()).toBe(m.eligibilityData.commitment().toString());
  expect(planWitness.calculateRoot(eligibilityData.commitment()).toString()).toBe(planRoot.toString());
  expect(planRoot.toString()).toBe(svc.benefitPlanRegistry.getRoot().toString());
  // the versions no live member names dropped out; the console's plan kept index 0
  expect(svc.benefitPlanRegistry.count).toBe(2);
  expect(svc.benefitPlanIndexOf(svc.sharedEligibilityData)).toBe(0n);
});

test('more live versions than the registry holds: a 409 that says why, before anything is rebuilt or proved', async () => {
  // a second member with a device, in another group: its EligibilityData is in no registry leaf yet
  seq.adminMutate('test', ({ provision }: any) => { provision(Field(BigInt(W2)), LC.LIFECYCLE_REGISTERED); });
  svc.approveMember({ walletId: W2, groupIdHash: ndcHashOf('GRP-REG-2'), planIdHash: ndcHashOf('PLAN-REG'), planId: 'PLAN-REG', employerId: null, familyIdHash: null });
  await svc.registerMemberFromEnrollment({ walletId: W2, ownershipProofJson: '{}', displayName: 'Second registry member' });
  svc.enrolledMembers.get(W2).pcpAssignment = { pcpWalletId: svc.prescriberWalletIds.get(0) };
  // 128 live members, each naming its own plan version, and a registry already full
  for (let i = 0; i < 128; i++) svc.enrolledMembers.set(`live-${i}`, { lifecycle: 'ELIGIBLE', eligibilityData: anotherPlanVersion(1000 + i) });
  fillRegistryToCapacity();
  const before = svc.benefitPlanRegistry;
  const rootBefore = before.getRoot().toString();

  expect(() => svc.benefitPlanIndexOf(anotherPlanVersion(5000))).toThrow(expect.objectContaining({ name: 'RegistrationRefused', status: 409 }));
  // the console's plan, the 128, the two registered members and the new version: 132
  expect(() => svc.benefitPlanIndexOf(anotherPlanVersion(5000))).toThrow(/holds 128 plan versions and live members name 132/);
  expect(svc.benefitPlanRegistry).toBe(before);
  expect(svc.benefitPlanRegistry.getRoot().toString()).toBe(rootBefore);

  // through prescribing: refused before the pending entry and before the first proof
  const proofs = jest.fn();
  svc.dispatchProof = proofs;
  await expect(svc.createPrescription({ prescriberIndex: 0, pharmacyIndex: 0, memberWalletId: W2, ndcHash: ndcHashOf(ABACAVIR), quantity: 30, refills: 0 }))
    .rejects.toMatchObject({ name: 'RegistrationRefused', status: 409 });
  expect(proofs).not.toHaveBeenCalled();
  expect(svc.pendingPrescriptions.size).toBe(0);
  for (let i = 0; i < 128; i++) svc.enrolledMembers.delete(`live-${i}`);
});
