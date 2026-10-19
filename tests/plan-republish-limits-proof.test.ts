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
 * A limit a republish lowers below what the member has already paid is met, in a real fill proof (slow: compiles
 * AccumulatorFulfillmentProgram, about two to three minutes, then two proofs).
 *
 * The rule (ensurePlanBinding): a member follows its plan's current published terms at its next action, its own
 * deductible, OOP maximum and annual benefit maximum included, with the amounts paid kept (withLimits). The fill circuit
 * compares paid >= limit before it subtracts, so a lowered limit is simply met: proven here, and the engine's record
 * after the fill (withAmountsPaid over the rebound accumulator) reaches the eligibility root the proof committed to,
 * the A-35 check the engine makes before it records a claim.
 */
import { Field, Poseidon } from 'o1js';
import { AccumulatorData, ACCUMULATOR_LEAF_INDEX, buildAccumulatorData, withAmountsPaid, withLimits } from '../src/access-control/accumulator-data.js';
import { splitClaimCost, accumulatorAmountsOf } from '../src/access-control/accumulator-query-service.js';
import { AccumulatorFulfillmentProgram } from '../src/fulfillment/accumulator-fulfillment-program.js';
import { FulfillmentData } from '../src/fulfillment/fulfillment-data.js';
import { PrescriptionData, PrescriptionStatusData, RX_STATUS_ADJUDICATED, RX_STATUS_FILLED } from '../src/prescription/prescription-data.js';
import { CredentialData, CREDENTIAL_TYPE_PRESCRIPTION, CREDENTIAL_TYPE_ELIGIBILITY } from '../src/credentials/credential-data.js';
import { MerkleForest, ForestDomain } from '../src/zkp/merkle-forest.js';
import { ForestRoots, forestRootWithAccessControl } from '../src/eligibility/forest-roots.js';
import { FormularyEntry } from '../src/access-control/formulary-entry.js';
import { FormularyRegistry } from '../src/access-control/formulary-registry.js';
import { hashString, dateToField, centsToField, quantityToField } from '../src/zkp/hash-utils.js';
import { DOMAIN_TAG_PHARMACY } from '../src/wallets/wallet-derivation.js';

jest.setTimeout(900_000);

const PHARM = [Field(2), Field(555), Field(666)] as const;
const pharmacyWalletId = Poseidon.hash([DOMAIN_TAG_PHARMACY, ...PHARM]);
const prescriberWalletId = Field(111222333444555666n);
const memberWalletId = Field(999888777666555444n);
const ndcHash = hashString('00378410591');

/** A real fill proof of a $30.51 claim (ingredient $18.01 + fee $12.50) at a $15.00 copay against this accumulator. */
async function proveFill(accumulator: AccumulatorData) {
  const rxData = new PrescriptionData({
    ndcHash, prescriberWalletId, memberWalletId, writtenDate: dateToField('20260201'), expirationDate: dateToField('20270201'),
    quantityPrescribed: quantityToField(30), refillsAuthorized: Field(0),
  });
  const rxForest = new MerkleForest();
  rxForest.setLeaf(ForestDomain.MEDICATION, 0n, rxData.commitment());
  rxForest.setLeaf(ForestDomain.TRANSACTION, 0n, new PrescriptionStatusData({
    prescriptionHash: rxData.commitment(), status: RX_STATUS_ADJUDICATED, updatedByWalletId: prescriberWalletId, updatedAt: dateToField('20260201'),
    pharmacyWalletId, fillQuantity: Field(0), notesHash: Field(0),
  }).commitment());
  const filled = new PrescriptionStatusData({
    prescriptionHash: rxData.commitment(), status: RX_STATUS_FILLED, updatedByWalletId: pharmacyWalletId, updatedAt: dateToField('20260215'),
    pharmacyWalletId, fillQuantity: Field(0), notesHash: Field(0),
  });
  rxForest.setLeaf(ForestDomain.TRANSACTION, 1n, filled.commitment());
  const rxCredential = new CredentialData({
    credentialType: CREDENTIAL_TYPE_PRESCRIPTION, forestRoot: rxForest.getForestRoot(), issuerWalletId: prescriberWalletId,
    subjectWalletId: pharmacyWalletId, issuedAt: dateToField('20260201'), expiresAt: Field(0), revoked: Field(0),
  });
  const entry = new FormularyEntry({
    ndcHash, tierLevel: Field(1), copayAmountCents: centsToField(1500), requiresPriorAuth: Field(0),
    maxQuantityPerFill: quantityToField(90), maxDaySupply: Field(90), stepTherapyRequired: Field(0),
  });
  const registry = new FormularyRegistry();
  registry.addEntry(entry);
  const fulfillment = new FulfillmentData({
    prescriptionHash: rxData.commitment(), pharmacyWalletId, ndcHash, quantityDispensed: quantityToField(30),
    ingredientCostCents: centsToField(1801), dispensingFeeCents: centsToField(1250), dateOfService: dateToField('20260215'),
  });
  const eligForest = new MerkleForest();
  eligForest.setLeaf(ForestDomain.ACCESS_CONTROL, ACCUMULATOR_LEAF_INDEX, accumulator.commitment());
  const eligCredential = new CredentialData({
    credentialType: CREDENTIAL_TYPE_ELIGIBILITY, forestRoot: eligForest.getForestRoot(), issuerWalletId: Field(100200300400500600n),
    subjectWalletId: memberWalletId, issuedAt: dateToField('20260101'), expiresAt: Field(0), revoked: Field(0),
  });
  const eligForestRoots = ForestRoots.fromForest(eligForest);
  const accumWitness = eligForest.getWitness(ForestDomain.ACCESS_CONTROL, ACCUMULATOR_LEAF_INDEX);
  const { proof } = await AccumulatorFulfillmentProgram.proveFulfillmentWithAccumulator(
    rxCredential, rxData, filled, fulfillment, entry, ForestRoots.fromForest(rxForest),
    rxForest.getWitness(ForestDomain.MEDICATION, 0n), rxForest.getWitness(ForestDomain.TRANSACTION, 1n), rxForest.getWitness(ForestDomain.TRANSACTION, 2n),
    registry.getEntryWitness(0n), registry.getRoot(), eligCredential, eligForestRoots, accumulator, accumWitness, ...PHARM,
    Field(0), Field(0), Field(0), Field(0), Field(0), Field(0),
  );
  expect(await AccumulatorFulfillmentProgram.verify(proof)).toBe(true);
  return { output: proof.publicOutput, eligForestRoots, accumWitness };
}

/** The engine's record after the fill (the A-35 check): the rebound accumulator with the proof's amounts added. */
function engineRootAfter(accumulator: AccumulatorData, output: any, eligForestRoots: ForestRoots, accumWitness: any): string {
  const after = withAmountsPaid(accumulator, {
    deductiblePaidCents: Number(accumulator.deductiblePaidCents.add(output.deductibleCreditCents).toBigInt()),
    oopPaidCents: Number(accumulator.oopPaidCents.add(output.patientPayCents).toBigInt()),
    annualBenefitUsedCents: Number(accumulator.annualBenefitUsedCents.add(output.planPayCents).toBigInt()),
  });
  return forestRootWithAccessControl(eligForestRoots, accumWitness.calculateRoot(after.commitment())).toString();
}

beforeAll(async () => {
  await AccumulatorFulfillmentProgram.compile();
}, 600_000);

const registered = buildAccumulatorData({ planYear: '20260101', deductibleAmountCents: 50000, deductiblePaidCents: 0, oopMaxCents: 780000, oopPaidCents: 0, annualBenefitMaxCents: 0, annualBenefitUsedCents: 0 });

test('a deductible lowered below the deductible paid: the copay phase, no deductible credit, and the engine reaches the proof\'s root', async () => {
  const rebound = withLimits(withAmountsPaid(registered, { deductiblePaidCents: 30000, oopPaidCents: 30000, annualBenefitUsedCents: 0 }), { deductibleAmountCents: 25000, oopMaxCents: 780000, annualBenefitMaxCents: 0 });
  const { output, eligForestRoots, accumWitness } = await proveFill(rebound);
  expect([output.patientPayCents, output.planPayCents, output.deductibleCreditCents].map(String)).toEqual(['1500', '1551', '0']);
  expect(splitClaimCost({ totalCostCents: 3051, copayCents: 1500, accumulator: accumulatorAmountsOf(rebound) })).toMatchObject({ patientPayCents: 1500, planPayCents: 1551, deductibleCreditCents: 0 });
  expect(engineRootAfter(rebound, output, eligForestRoots, accumWitness)).toBe(output.newEligibilityForestRoot.toString());
});

test('an OOP maximum lowered below the OOP paid: the member pays nothing, and the engine reaches the proof\'s root', async () => {
  const rebound = withLimits(withAmountsPaid(registered, { deductiblePaidCents: 50000, oopPaidCents: 6000, annualBenefitUsedCents: 0 }), { deductibleAmountCents: 50000, oopMaxCents: 5000, annualBenefitMaxCents: 0 });
  const { output, eligForestRoots, accumWitness } = await proveFill(rebound);
  expect([output.patientPayCents, output.planPayCents, output.deductibleCreditCents].map(String)).toEqual(['0', '3051', '0']);
  expect(engineRootAfter(rebound, output, eligForestRoots, accumWitness)).toBe(output.newEligibilityForestRoot.toString());
});
