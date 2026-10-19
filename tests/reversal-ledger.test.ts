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
 * A reversal the ledger did not take changes nothing and is not reported as done.
 *
 * What was wrong: reversePrescription rolled back the member's accumulator, moved the eligibility leaf, the
 * credential and inventory slot 0, wrote the reversal leaf, set the prescription REVERSED, lowered its quantity,
 * added a history entry and marked the fill reversed, and only then called the ledger step. When that step threw,
 * a catch logged a warning and the call returned success (the route answered 200) while the ledger still held the
 * fill as active. Now the ledger step runs before the prescription or the fill changes; when it fails the member's
 * record is put back exactly and the error surfaces. The result also reports the wallet update, as a fill does.
 *
 * Fast: the real reversePrescription on a bare engine, with an honest stand-in for the reversal proof (it computes
 * the root the A-35 check expects). No compile, no proving, no network.
 */
import { Field } from 'o1js';
import { AdjudicationService } from '../src/adjudication/interactive-service.js';
import { MerkleForest, ForestDomain } from '../src/zkp/merkle-forest.js';
import { ForestRoots, forestRootWithAccessControl } from '../src/eligibility/forest-roots.js';
import { buildAccumulatorData, withAmountsPaid, ACCUMULATOR_LEAF_INDEX, type AccumulatorData } from '../src/access-control/accumulator-data.js';
import { CredentialData } from '../src/credentials/credential-data.js';
import { CredentialInventory } from '../src/credentials/credential-inventory.js';

jest.setTimeout(120_000);

const cents = (f: Field) => Number(f.toBigInt());

/** A member with one dispensed fill, on a bare engine whose only stand-ins are the proof, the drug and the chain state. */
function engineWithOneFill({ fixture }: { fixture: boolean }) {
  const acc = buildAccumulatorData({
    planYear: '20260101', deductibleAmountCents: 50000, deductiblePaidCents: 1000, oopMaxCents: 600000, oopPaidCents: 1000,
    annualBenefitMaxCents: 0, annualBenefitUsedCents: 4000,
  });
  const forest = new MerkleForest();
  forest.setLeaf(ForestDomain.ACCESS_CONTROL, ACCUMULATOR_LEAF_INDEX, acc.commitment());
  const cred = new CredentialData({
    credentialType: Field(1), forestRoot: forest.getForestRoot(), issuerWalletId: Field(9), subjectWalletId: Field(123),
    issuedAt: Field(20260101), expiresAt: Field(0), revoked: Field(0),
  });
  const inventory = new CredentialInventory();
  inventory.mint(cred);
  const enrolled: any = {
    walletId: Field(123), displayName: 'T', planId: 'plan-a', forest, accumulatorData: acc, credentialData: cred,
    credentialInventory: inventory, credentialInventoryRoot: inventory.getRoot(),
    preimageFields: fixture ? [1, 2, 3, 4, 5, 6].map((n) => Field(n)) : undefined, nonce: 0, l2Receipts: [],
  };
  const rxForest = new MerkleForest();
  const rxCred = new CredentialData({
    credentialType: Field(2), forestRoot: rxForest.getForestRoot(), issuerWalletId: Field(66), subjectWalletId: Field(55),
    issuedAt: Field(20260101), expiresAt: Field(0), revoked: Field(0),
  });
  const rxState: any = {
    status: 'DISPENSED', pharmacyIndex: 0, prescriberIndex: 0, ndcHash: 'ndc', memberWalletId: '123', rxForest,
    rxCredentialData: rxCred, prescriptionData: {}, statusHistory: [], quantity: 30, quantityDispensed: 30,
  };
  const fill: any = {
    fillIndex: 0, patientPayCents: 1000, planPayCents: 4000, patientPayField: Field(1000), planPayField: Field(4000),
    deductibleCreditField: Field(1000), fulfillmentData: { commitment: () => Field(77) }, settlementLeafIndex: 3n,
    settlementCommitment: Field(88), quantityDispensed: 30, reversed: false, dateOfService: '20261019',
  };
  const svc: any = Object.create(AdjudicationService.prototype);
  Object.assign(svc, {
    consoleEmitter: () => {},
    vizEmitter: () => {},
    vizEventCounter: 0,
    prescriptions: new Map([['RX-1', rxState]]),
    fulfillments: new Map([['RX-1', [fill]]]),
    enrolledMembers: new Map([['123', enrolled]]),
    pharmacyWalletIds: new Map([[0, Field(55)]]),
    pharmacyPreimages: new Map([[0, [Field(1), Field(2), Field(3)]]]),
    prescriberWalletIds: new Map([[0, Field(66)]]),
    pendingWalletUpdates: new Map(),
    getMedicationByNdcHash: () => ({ brandName: 'Testdrug', genericName: 't', strength: '1 mg', ndc: '00000000001', formularyEntry: { tierLevel: 1 } }),
    getChainState: () => ({}),
    // An honest reversal proof: the accumulator it is given, less the fill's refunds, floored at 0, at the leaf it is given.
    dispatchProof: async (_program: string, _method: string, _types: string[], args: any[]) => {
      const [patient, plan, deductible] = (args.slice(8, 11) as Field[]).map(cents);
      const [roots, accumulator, witness] = args.slice(12, 15) as [ForestRoots, AccumulatorData, any];
      const rev = withAmountsPaid(accumulator, {
        deductiblePaidCents: Math.max(0, cents(accumulator.deductiblePaidCents) - deductible),
        oopPaidCents: Math.max(0, cents(accumulator.oopPaidCents) - patient),
        annualBenefitUsedCents: Math.max(0, cents(accumulator.annualBenefitUsedCents) - plan),
      });
      return { publicOutput: { newEligibilityForestRoot: forestRootWithAccessControl(roots, witness.calculateRoot(rev.commitment())).toString() } };
    },
  });
  const before = {
    accumulator: acc.commitment().toString(),
    forestRoot: forest.getForestRoot().toString(),
    credential: cred.commitment().toString(),
    inventoryRoot: inventory.getRoot().toString(),
    rxForestRoot: rxForest.getForestRoot().toString(),
    rxCredential: rxCred.commitment().toString(),
  };
  return { svc, enrolled, rxState, fill, forest, rxForest, before };
}

type Setup = ReturnType<typeof engineWithOneFill>;

/** Nothing about the prescription, the fill or the member's record changed. */
function expectUnchanged({ enrolled, rxState, fill, forest, rxForest, before }: Setup) {
  expect(fill.reversed).toBe(false);
  expect(rxState.status).toBe('DISPENSED');
  expect(rxState.quantityDispensed).toBe(30);
  expect(rxState.statusHistory).toHaveLength(0);
  expect(rxState.rxCredentialData.commitment().toString()).toBe(before.rxCredential);
  expect(rxForest.getForestRoot().toString()).toBe(before.rxForestRoot);
  expect(enrolled.accumulatorData.commitment().toString()).toBe(before.accumulator);
  expect(forest.getForestRoot().toString()).toBe(before.forestRoot);
  expect(enrolled.credentialData.commitment().toString()).toBe(before.credential);
  expect(enrolled.credentialInventory.getRoot().toString()).toBe(before.inventoryRoot);
}

describe('reversePrescription and the ledger step', () => {
  test('a fixture member\'s reversal whose ledger step fails changes nothing and surfaces the error', async () => {
    const s = engineWithOneFill({ fixture: true });
    s.svc.submitWalletUpdate = async () => { throw new Error('ledger unavailable'); };
    await expect(s.svc.reversePrescription({ prescriptionId: 'RX-1', reason: 'r' })).rejects.toThrow(/ledger unavailable/);
    expectUnchanged(s);
  });

  test('a member with a device: a reversal whose update cannot be queued changes nothing and surfaces the error', async () => {
    const s = engineWithOneFill({ fixture: false });
    s.svc.queueWalletUpdate = () => { throw new Error('ledger unavailable'); };
    await expect(s.svc.reversePrescription({ prescriptionId: 'RX-1', reason: 'r' })).rejects.toThrow(/ledger unavailable/);
    expectUnchanged(s);
    expect(s.svc.pendingWalletUpdates.size).toBe(0);
  });

  test('after a failed ledger step the reversal can be retried and lands', async () => {
    const s = engineWithOneFill({ fixture: true });
    s.svc.submitWalletUpdate = async () => { throw new Error('ledger unavailable'); };
    await expect(s.svc.reversePrescription({ prescriptionId: 'RX-1', reason: 'r' })).rejects.toThrow(/ledger unavailable/);
    s.svc.submitWalletUpdate = async () => ({ receiptId: 'r-1', sequenceNumber: 1n });
    const result = await s.svc.reversePrescription({ prescriptionId: 'RX-1', reason: 'r' });
    expect(result.newStatus).toBe('REVERSED');
    expect(result.walletUpdate).toEqual({ status: 'applied', receiptId: 'r-1' });
    expect(s.fill.reversed).toBe(true);
    const a = s.enrolled.accumulatorData;
    expect([cents(a.deductiblePaidCents), cents(a.oopPaidCents), cents(a.annualBenefitUsedCents)]).toEqual([0, 0, 0]);
    expect(s.forest.getForestRoot().toString()).not.toBe(s.before.forestRoot);
  });

  test('a member with a device: the reversal is queued for the device with its claim committed on the sequencer', async () => {
    const s = engineWithOneFill({ fixture: false });
    const commitPendingClaim = jest.fn();
    s.svc.l2Node = { getSequencer: () => ({ commitPendingClaim }) };
    const result = await s.svc.reversePrescription({ prescriptionId: 'RX-1', reason: 'r' });
    expect(result.walletUpdate.status).toBe('pending');
    expect(s.svc.pendingWalletUpdates.size).toBe(1);
    expect(commitPendingClaim).toHaveBeenCalledWith('123', result.walletUpdate.newInventoryRoot, expect.objectContaining({ operationType: '2' }));
    expect(s.fill.reversed).toBe(true);
    expect(s.rxState.status).toBe('REVERSED');
  });
});
