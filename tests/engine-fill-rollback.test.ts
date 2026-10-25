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
 * A fill that fails before the ledger records it changes nothing: the member's record and the prescription are put
 * back exactly.
 *
 * What was wrong: dispensePrescription wrote the prescription's status slot before the claim proof, then moved the
 * member's accumulator, leaf 127 of its forest, its credential and the prescription's settlement slot, and only then
 * ran the ledger step (inventory slot 0, then the device's queued update with its claim committed on the sequencer, or
 * a fixture member's proved and submitted update). When that step threw, nothing was put back: the engine's record
 * stood one fill ahead of the ledger, and the prescription could not be filled again, as its next transaction slot was
 * no longer empty. reversePrescription already put its changes back around the same step. Found by the option A
 * specification (docs/research/a22-option-a-spec.md, 2026-10-24, section 5.1 item 4), as one of step 1's
 * prerequisites; its test 8 asks that a refused commit restore the full record and queue nothing.
 *
 * Now everything the fill changed before the ledger step is saved and, if the step throws, put back (the accumulator,
 * leaf 127, the credential, inventory slot 0 and both transaction slots) and the error surfaces. The prescription's
 * status and quantity and its fill record change only after the step, as before. The same fill can then be made again
 * and is charged once.
 *
 * That restore ran only when the ledger step threw. The status slot is written before the claim proof, so a claim proof
 * that failed (a proof-pool worker that exits, a prove that times out), an incomplete public output or the A-35 refusal
 * left the slot written while the prescription's credential still named the root before it: every retry of the fill was
 * refused by the status update's own proof ('Forest root mismatch'), and the prescription could no longer be dispensed.
 * Found by the review of option A step 1 (2026-10-24). Now the fill saves the whole set before it writes the status slot,
 * and one restore puts all of it back after any failure until the ledger has recorded the fill; the error surfaces.
 *
 * A real L2Node sequencer and a real AdjudicationService; programs not compiled. Every proof is skipped except the
 * fill, which is AccumulatorFulfillmentProgram's own method run on constants (every constraint checked, no proof),
 * and, in the cases of a failed claim proof, the status update, PrescriptionProgram's own method run the same way, which
 * holds a retry to the slot and the root it checks. The records are compared whole, every tree as its root and every
 * leaf.
 */
import { Field, MerkleTree } from 'o1js';

jest.setTimeout(300_000);

const ABACAVIR = '00378410591';
const DEVICE = '79800000000000000001';
const FIXTURE = '79800000000000000002';
const PROOF_FAILS = '79800000000000000003';   // a member with a device whose first claim proof throws
const REFUSED = '79800000000000000004';       // a member with a device whose first claim proofs are refused

let node: any;
let seq: any;
let svc: any;
let hashString: (s: string) => Field;
let ForestDomain: any;
let CredentialData: any;
/** Whether the status update runs as the circuit's own method (the failed claim proof cases) or is skipped. */
let proveStatusUpdates = false;
const events: Array<{ type: string; message: string }> = [];
const ndcHashOf = (ndc: string) => hashString(ndc).toString();

/** A value as plain data, for comparing whole records: each Merkle tree as its root and every leaf it holds. */
function plain(v: unknown): unknown {
  if (v instanceof Field) return v.toString();
  if (typeof v === 'bigint') return `${v}n`;
  if (v instanceof MerkleTree) {
    const leaves: string[] = [];
    for (let i = 0n; i < v.leafCount; i++) leaves.push(v.getLeaf(i).toString());
    return { root: v.getRoot().toString(), leaves };
  }
  if (v instanceof Map) return [...v.entries()].map(([k, x]) => [plain(k), plain(x)]);
  if (Array.isArray(v)) return v.map(plain);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]));
  return v;
}

/** Everything a fill may change: the member's record, the prescription, every fill, the engine's queue and the sequencer's committed claims. */
function recordOf(walletId: string, prescriptionId: string): unknown {
  return plain({
    member: svc.enrolledMembers.get(walletId),
    prescription: svc.prescriptions.get(prescriptionId),
    fills: svc.fulfillments,
    queue: svc.pendingWalletUpdates,
    committedClaims: seq.pendingClaimCount(),
  });
}

const paidOf = (m: any) => [m.accumulatorData.deductiblePaidCents, m.accumulatorData.oopPaidCents, m.accumulatorData.annualBenefitUsedCents].map((f: Field) => Number(f.toBigInt()));

/** Written by prescriber 0 for 30 EA of ABACAVIR and marked filled by pharmacy 0: ready to dispense. */
async function readyToDispense(walletId: string): Promise<string> {
  const rx = await svc.createPrescription({ prescriberIndex: 0, pharmacyIndex: 0, memberWalletId: walletId, ndcHash: ndcHashOf(ABACAVIR), quantity: 30, refills: 0 });
  svc.markFilled({ prescriptionId: rx.prescriptionId });
  return rx.prescriptionId;
}

/** A fixture member made from a registered one: served from the console's formulary, with the preimage the engine proves with, nothing queued. */
function fixtureFrom(walletId: string): any {
  const m = svc.enrolledMembers.get(walletId);
  m.memberIndex = 0;
  m.preimageFields = [1, 2, 3, 4, 5, 6].map((n) => Field(n));
  m.planId = 'PLAN-GOLD-2026';
  m.eligibilityData = svc.sharedEligibilityData;
  m.forest.setLeaf(ForestDomain.ACCESS_CONTROL, 0n, m.eligibilityData.commitment());
  const c = m.credentialData;
  m.credentialData = new CredentialData({ credentialType: c.credentialType, forestRoot: m.forest.getForestRoot(), issuerWalletId: c.issuerWalletId, subjectWalletId: c.subjectWalletId, issuedAt: c.issuedAt, expiresAt: c.expiresAt, revoked: c.revoked });
  m.credentialInventory.updateCredential(0n, m.credentialData);
  for (const u of svc.walletUpdatesFor(walletId)) svc.pendingWalletUpdates.delete(u.updateId);
  m.credentialInventoryRoot = m.credentialInventory.getRoot();
  return m;
}

beforeAll(async () => {
  process.env.ZKTRIDENT_FORMULARY_LIMIT = '100';
  const { InMemoryStore } = await import('../src/storage/local-store.js');
  const { WALLET_TREE_HEIGHT } = await import('../src/wallets/wallet-state.js');
  const { L2Node } = await import('../src/l2/l2-node.js');
  const { AdjudicationService } = await import('../src/adjudication/interactive-service.js');
  const { AccumulatorFulfillmentProgram } = await import('../src/fulfillment/accumulator-fulfillment-program.js');
  const { PrescriptionProgram } = await import('../src/prescription/prescription-program.js');
  const { getAllFormularyEntries } = await import('../src/data/index.js');
  const { publishedTermsFrom } = await import('../src/l2/plan-terms.js');
  const { buildPlanFormulary } = await import('../src/onboarding/plan-formulary.js');
  ({ hashString } = await import('../src/zkp/hash-utils.js'));
  ({ ForestDomain } = await import('../src/zkp/merkle-forest.js'));
  ({ CredentialData } = await import('../src/credentials/credential-data.js'));
  const LC = await import('../src/engine/lifecycle.js');

  const emptyRoot = new MerkleTree(WALLET_TREE_HEIGHT).getRoot();
  node = new L2Node({ batchIntervalMs: 999_999, autoSettle: false, nodeId: 'seq-fill-rollback' }, new InMemoryStore(), emptyRoot, emptyRoot, Field(0));
  seq = node.getSequencer();
  svc = new AdjudicationService((e: { type: string; message: string }) => events.push(e), () => {}, node);
  svc.compiled = true;
  svc.verifyOwnershipProof = async (_w: string, j: string) => j;
  // Every proof but the fill is skipped; the fill is the circuit's own method on constants, and so is the status update
  // when proveStatusUpdates is on.
  svc.dispatchProof = async (program: string, method: string, _types: string[], args: unknown[]) => {
    if (proveStatusUpdates && program === 'Prescription' && method === 'proveStatusUpdate') {
      await (PrescriptionProgram as any).rawMethods.proveStatusUpdate(...args);
      return { proofJson: null, publicOutput: null, proveTimeMs: 0 };
    }
    if (program !== 'AccumulatorFulfillment' || method !== 'proveFulfillmentWithAccumulator') return { proofJson: null, publicOutput: null, proveTimeMs: 0 };
    const r = await (AccumulatorFulfillmentProgram as any).rawMethods.proveFulfillmentWithAccumulator(...args);
    const out = r.publicOutput ?? r;
    const publicOutput: Record<string, string> = {};
    for (const [k, v] of Object.entries(out)) publicOutput[k] = String(v);
    return { proofJson: null, publicOutput, proveTimeMs: 0 };
  };

  const base: any = {
    planId: 'PLAN-FR', name: 'Fill rollback', coverageType: 1, copayAmountCents: 1500, deductibleAmountCents: 50000, oopMaxCents: 780000,
    annualBenefitMaxCents: 0, familyDeductibleAmountCents: 0, familyOopMaxCents: 0, familyAnnualBenefitMaxCents: 0, dispensingFeeCents: 1250,
    formularyNdcs: [ABACAVIR], networkProviderWalletIds: [], published: true, createdAt: 0, updatedAt: 0,
  };
  const root = buildPlanFormulary(base, getAllFormularyEntries()).root.toString();
  await node.storePlan({ ...base, formularyRoot: root, networkRoot: '0', publishedTerms: publishedTermsFrom(base, root, '0', 1) });
  for (const w of [DEVICE, FIXTURE, PROOF_FAILS, REFUSED]) {
    seq.adminMutate('test', ({ provision }: any) => { provision(Field(BigInt(w)), LC.LIFECYCLE_REGISTERED); });
    svc.approveMember({ walletId: w, groupIdHash: ndcHashOf('GRP-FR'), planIdHash: ndcHashOf('PLAN-FR'), planId: 'PLAN-FR', employerId: null, familyIdHash: null });
    await svc.registerMemberFromEnrollment({ walletId: w, ownershipProofJson: '{}', displayName: 'Fill rollback member' });
  }
  // consent at prescribing: prescriber 0 is the PCP
  for (const w of [DEVICE, PROOF_FAILS, REFUSED]) svc.enrolledMembers.get(w).pcpAssignment = { pcpWalletId: svc.prescriberWalletIds.get(0) };
  fixtureFrom(FIXTURE);
});

describe('a member with a device: the claim commit is refused', () => {
  let rx: string;

  test('the member\'s record, the prescription and the fills stay exactly as they were, nothing is queued, and the error surfaces', async () => {
    rx = await readyToDispense(DEVICE);
    const before = recordOf(DEVICE, rx);
    const commit = jest.spyOn(seq, 'commitPendingClaim').mockImplementation(() => { throw new Error('Claim refused: the stand-in refusal'); });
    events.length = 0;
    try {
      await expect(svc.dispensePrescription({ prescriptionId: rx, quantityDispensed: 30 })).rejects.toThrow('Claim refused: the stand-in refusal');
      expect(commit).toHaveBeenCalledTimes(1);
    } finally {
      commit.mockRestore();
    }
    expect(recordOf(DEVICE, rx)).toEqual(before);   // before: the accumulator, leaf 127, the credential, inventory slot 0 and both transaction slots one fill ahead
    expect(events.filter((e) => e.type === 'error').map((e) => e.message)).toContain('The ledger did not take the fill; nothing was filled: Claim refused: the stand-in refusal');   // before: no such line
  });

  test('the same fill is then made again, charged once, and queued with its claim', async () => {
    const m = svc.enrolledMembers.get(DEVICE);
    const n0 = svc.walletUpdatesFor(DEVICE).length;
    const claims0 = seq.pendingClaimCount();
    const fill = await svc.dispensePrescription({ prescriptionId: rx, quantityDispensed: 30 });   // before: refused, 'New TRANSACTION slot is not empty'
    expect([fill.adjudication.patientPayCents, fill.adjudication.planPayCents, fill.adjudication.totalCostCents]).toEqual([3051, 0, 3051]);
    expect(fill.accumulator.before).toEqual({ deductiblePaidCents: 0, oopPaidCents: 0, benefitUsedCents: 0 });
    expect(paidOf(m)).toEqual([3051, 3051, 0]);
    const updates = svc.walletUpdatesFor(DEVICE);
    expect(updates).toHaveLength(n0 + 1);
    expect(updates.at(-1)).toMatchObject({ reason: 'fill', claimCommitted: true, newInventoryRoot: m.credentialInventory.getRoot().toString() });
    expect(fill.walletUpdate).toEqual({ status: 'pending', updateId: updates.at(-1).updateId, newInventoryRoot: updates.at(-1).newInventoryRoot });
    expect(seq.pendingClaimCount()).toBe(claims0 + 1);
    expect(svc.prescriptions.get(rx)).toMatchObject({ status: 'DISPENSED', quantityDispensed: 30 });
    expect(svc.fulfillments.get(rx)).toHaveLength(1);
  });
});

describe('a fixture member: the sequencer does not take the proved update', () => {
  test('everything stays exactly as it was and the error surfaces; the retry lands and is charged once', async () => {
    const m = svc.enrolledMembers.get(FIXTURE);
    const rx = await readyToDispense(FIXTURE);
    const before = recordOf(FIXTURE, rx);
    svc.submitWalletUpdate = async () => { throw new Error('ledger unavailable'); };
    try {
      await expect(svc.dispensePrescription({ prescriptionId: rx, quantityDispensed: 30 })).rejects.toThrow('ledger unavailable');
      expect(recordOf(FIXTURE, rx)).toEqual(before);   // before: the accumulator, leaf 127, the credential, inventory slot 0 and both transaction slots one fill ahead

      svc.submitWalletUpdate = async () => ({ receiptId: 'r-fixture', sequenceNumber: 1n });
      const fill = await svc.dispensePrescription({ prescriptionId: rx, quantityDispensed: 30 });   // before: refused, 'New TRANSACTION slot is not empty'
      expect(fill.walletUpdate).toEqual({ status: 'applied', receiptId: 'r-fixture' });
      expect(fill.accumulator.before).toEqual({ deductiblePaidCents: 0, oopPaidCents: 0, benefitUsedCents: 0 });
      const after = fill.accumulator.after;
      expect(paidOf(m)).toEqual([after.deductiblePaidCents, after.oopPaidCents, after.benefitUsedCents]);
      expect(after.oopPaidCents).toBe(fill.adjudication.patientPayCents);
      expect(svc.prescriptions.get(rx).status).toBe('DISPENSED');
      expect(svc.fulfillments.get(rx)).toHaveLength(1);
    } finally {
      delete svc.submitWalletUpdate;
    }
  });
});

describe('a fill that fails before the ledger step: the claim proof throws, its output is incomplete, or the A-35 check refuses it', () => {
  beforeAll(() => { proveStatusUpdates = true; });
  afterAll(() => { proveStatusUpdates = false; });

  /** Run the next fill with the claim proof's dispatch changed by `change`, then put the stand-in back. */
  async function fillWithClaimProof(prescriptionId: string, change: (prove: any, args: [string, string, string[], unknown[]]) => Promise<any>): Promise<unknown> {
    const prove = svc.dispatchProof;
    svc.dispatchProof = async (program: string, method: string, types: string[], args: unknown[]) =>
      (program === 'AccumulatorFulfillment' ? change(prove, [program, method, types, args]) : prove(program, method, types, args));
    try {
      return await svc.dispensePrescription({ prescriptionId, quantityDispensed: 30 });
    } finally {
      svc.dispatchProof = prove;
    }
  }

  const errorLines = () => events.filter((e) => e.type === 'error').map((e) => e.message);

  test('a claim proof that throws (a proof-pool worker that exits) leaves everything exactly as it was, and the error surfaces; the retry is filled and charged once', async () => {
    const m = svc.enrolledMembers.get(PROOF_FAILS);
    const rx = await readyToDispense(PROOF_FAILS);
    const before = recordOf(PROOF_FAILS, rx);
    const crash = 'Worker 1 crashed during AccumulatorFulfillment.proveFulfillmentWithAccumulator (code 134, signal null)';
    events.length = 0;
    await expect(fillWithClaimProof(rx, async () => { throw new Error(crash); })).rejects.toThrow(crash);
    expect(recordOf(PROOF_FAILS, rx)).toEqual(before);   // before: the prescription's status slot stayed written
    expect(errorLines()).toContain(`The fill did not complete; nothing was filled: ${crash}`);   // before: no such line

    const fill = await svc.dispensePrescription({ prescriptionId: rx, quantityDispensed: 30 });   // before: refused by the status update, 'Forest root mismatch'
    expect(fill.accumulator.before).toEqual({ deductiblePaidCents: 0, oopPaidCents: 0, benefitUsedCents: 0 });
    const after = fill.accumulator.after;
    expect(paidOf(m)).toEqual([after.deductiblePaidCents, after.oopPaidCents, after.benefitUsedCents]);
    expect(after.oopPaidCents).toBe(fill.adjudication.patientPayCents);
    expect(svc.walletUpdatesFor(PROOF_FAILS).filter((u: any) => u.reason === 'fill')).toHaveLength(1);
    expect(svc.prescriptions.get(rx)).toMatchObject({ status: 'DISPENSED', quantityDispensed: 30 });
    expect(svc.fulfillments.get(rx)).toHaveLength(1);
  });

  test('a claim proof with an incomplete public output, then one the A-35 check refuses, each leave everything exactly as it was; the retry is filled and charged once', async () => {
    const m = svc.enrolledMembers.get(REFUSED);
    const rx = await readyToDispense(REFUSED);
    const before = recordOf(REFUSED, rx);

    // an output without its deductible credit: read where the claim is displayed, after the explicit checks
    await expect(fillWithClaimProof(rx, async (prove, args) => {
      const r = await prove(...args);
      delete r.publicOutput.deductibleCreditCents;
      return r;
    })).rejects.toThrow(TypeError);
    expect(recordOf(REFUSED, rx)).toEqual(before);   // before: the prescription's status slot stayed written

    // an eligibility root no accumulator update reaches: the A-35 check refuses the claim
    events.length = 0;
    const refusal = 'The fill proof\'s eligibility root does not match the engine\'s accumulator update; the claim was not recorded';
    await expect(fillWithClaimProof(rx, async (prove, args) => {
      const r = await prove(...args);
      r.publicOutput.newEligibilityForestRoot = '1';
      return r;
    })).rejects.toThrow(refusal);   // before: refused earlier, by the status update ('Forest root mismatch'), over the slot the first attempt left written
    expect(recordOf(REFUSED, rx)).toEqual(before);   // before: the status slot written
    expect(errorLines()).toContain(`The fill did not complete; nothing was filled: ${refusal}`);   // before: no such line

    const fill = await svc.dispensePrescription({ prescriptionId: rx, quantityDispensed: 30 });   // before: refused by the status update, 'Forest root mismatch'
    expect(fill.accumulator.before).toEqual({ deductiblePaidCents: 0, oopPaidCents: 0, benefitUsedCents: 0 });
    const after = fill.accumulator.after;
    expect(paidOf(m)).toEqual([after.deductiblePaidCents, after.oopPaidCents, after.benefitUsedCents]);
    expect(svc.walletUpdatesFor(REFUSED).filter((u: any) => u.reason === 'fill')).toHaveLength(1);
    expect(svc.prescriptions.get(rx)).toMatchObject({ status: 'DISPENSED', quantityDispensed: 30 });
    expect(svc.fulfillments.get(rx)).toHaveLength(1);
  });
});
