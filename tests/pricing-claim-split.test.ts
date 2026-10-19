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
 * The member's share of a claim, in one pure function that is the fill circuit's own rule (splitClaimCost).
 *
 * What was wrong: the prescriber's estimate split a claim with its own copy of the rules (no family limits), against
 * limits a caller named, so a quote could differ from what the fill proof then committed to.
 *
 * Now splitClaimCost holds the circuit's step 16 and the B8 family rules in plain integers, and the quote, the
 * estimate and AccumulatorQueryService.estimatePatientCost all use it. Checked against the run.ts claims (plan copay
 * $15, fee $12.50, $500 deductible), the family rules, and the fill circuit itself: AccumulatorFulfillmentProgram's
 * method run on constants (rawMethods, every constraint checked, no compile, no proof) over a grid of accumulator,
 * family, copay and total states, including limits already met or lowered below what is paid.
 */
import { Field, Poseidon } from 'o1js';
import { splitClaimCost, AccumulatorQueryService, type AccumulatorAmounts, type FamilyAmounts } from '../src/access-control/accumulator-query-service.js';
import { AccumulatorData, ACCUMULATOR_LEAF_INDEX } from '../src/access-control/accumulator-data.js';
import { AccumulatorFulfillmentProgram } from '../src/fulfillment/accumulator-fulfillment-program.js';
import { FulfillmentData } from '../src/fulfillment/fulfillment-data.js';
import { PrescriptionData, PrescriptionStatusData, RX_STATUS_ADJUDICATED, RX_STATUS_FILLED } from '../src/prescription/prescription-data.js';
import { CredentialData, CREDENTIAL_TYPE_PRESCRIPTION, CREDENTIAL_TYPE_ELIGIBILITY } from '../src/credentials/credential-data.js';
import { MerkleForest, ForestDomain } from '../src/zkp/merkle-forest.js';
import { ForestRoots } from '../src/eligibility/forest-roots.js';
import { FormularyEntry } from '../src/access-control/formulary-entry.js';
import { FormularyRegistry } from '../src/access-control/formulary-registry.js';
import { hashString, dateToField, centsToField, quantityToField } from '../src/zkp/hash-utils.js';
import { DOMAIN_TAG_PHARMACY } from '../src/wallets/wallet-derivation.js';

jest.setTimeout(120_000);

const PLAN = { copay: 1500, fee: 1250, deductible: 50000, oopMax: 780000 };
const acc = (o: Partial<AccumulatorAmounts> = {}): AccumulatorAmounts => ({
  deductibleAmountCents: 0, deductiblePaidCents: 0, oopMaxCents: 0, oopPaidCents: 0, annualBenefitMaxCents: 0, annualBenefitUsedCents: 0, ...o,
});
const fam = (o: Partial<FamilyAmounts> = {}): FamilyAmounts => ({
  deductiblePaidCents: 0, oopPaidCents: 0, annualBenefitUsedCents: 0, familyDeductibleAmountCents: 0, familyOopMaxCents: 0, familyAnnualBenefitMaxCents: 0, ...o,
});

describe('the run.ts claims: plan copay $15, fee $12.50, $500 deductible', () => {
  test('ABACAVIR 30, ADEFOVIR 30 and ABILIFY 10 MG 30 split as the fill proofs did, with the accumulator carried from claim to claim', () => {
    // ingredient = NADAC x 30, rounded half up: 1801, 71095, 56063 (tests/nadac-pricing.test.ts), plus the plan's fee
    const totals = [1801 + PLAN.fee, 71095 + PLAN.fee, 56063 + PLAN.fee];
    expect(totals).toEqual([3051, 72345, 57313]);
    let a = acc({ deductibleAmountCents: PLAN.deductible, oopMaxCents: PLAN.oopMax });
    const out: Array<[number, number, string]> = [];
    for (const total of totals) {
      const s = splitClaimCost({ totalCostCents: total, copayCents: PLAN.copay, accumulator: a });
      out.push([s.patientPayCents, s.planPayCents, s.phase]);
      a = { ...a, deductiblePaidCents: a.deductiblePaidCents + s.deductibleCreditCents, oopPaidCents: a.oopPaidCents + s.patientPayCents, annualBenefitUsedCents: a.annualBenefitUsedCents + s.planPayCents };
    }
    expect(out).toEqual([[3051, 0, 'deductible'], [48449, 23896, 'deductible'], [1500, 55813, 'copay']]);
    expect(a.deductiblePaidCents).toBe(50000);
  });
});

describe('the family rules (B8), as the circuit applies them after the individual split', () => {
  // deductible met, individual OOP far away: the individual rules give the $15 copay on a $55 claim
  const met = acc({ deductibleAmountCents: 50000, deductiblePaidCents: 50000, oopMaxCents: 800000 });
  const split = (family: FamilyAmounts) => splitClaimCost({ totalCostCents: 5500, copayCents: 1500, accumulator: met, family });

  test('no family limits: the individual split, rule 0', () => {
    expect(split(fam())).toMatchObject({ patientPayCents: 1500, planPayCents: 4000, familyRule: 0, phase: 'copay' });
  });
  test('family OOP max met: the member pays nothing (rule 1)', () => {
    expect(split(fam({ oopPaidCents: 1600000, familyOopMaxCents: 1600000 }))).toMatchObject({ patientPayCents: 0, planPayCents: 5500, familyRule: 1, phase: 'oop-max-reached' });
  });
  test('family benefit exhausted: the member pays everything (rule 2)', () => {
    expect(split(fam({ annualBenefitUsedCents: 100000, familyAnnualBenefitMaxCents: 100000 }))).toMatchObject({ patientPayCents: 5500, planPayCents: 0, familyRule: 2, phase: 'benefit-max-reached' });
  });
  test('the member pays only what is left of the family OOP max (rule 3)', () => {
    expect(split(fam({ oopPaidCents: 1599500, familyOopMaxCents: 1600000 }))).toMatchObject({ patientPayCents: 500, planPayCents: 5000, familyRule: 3, phase: 'oop-max-reached' });
  });
  test('the plan pays only what is left of the family benefit max (rule 4)', () => {
    expect(split(fam({ annualBenefitUsedCents: 97000, familyAnnualBenefitMaxCents: 100000 }))).toMatchObject({ patientPayCents: 2500, planPayCents: 3000, familyRule: 4, phase: 'benefit-max-reached' });
  });
});

describe('limits at or below what is already paid count as met', () => {
  test('a deductible lowered below the deductible paid: the copay phase, and no deductible credit', () => {
    expect(splitClaimCost({ totalCostCents: 3051, copayCents: 1500, accumulator: acc({ deductibleAmountCents: 25000, deductiblePaidCents: 30000, oopMaxCents: 780000, oopPaidCents: 30000 }) }))
      .toEqual({ patientPayCents: 1500, planPayCents: 1551, deductibleCreditCents: 0, familyRule: 0, phase: 'copay' });
  });
  test('an OOP maximum lowered below the OOP paid: the member pays nothing', () => {
    expect(splitClaimCost({ totalCostCents: 3051, copayCents: 1500, accumulator: acc({ deductibleAmountCents: 50000, deductiblePaidCents: 50000, oopMaxCents: 500000, oopPaidCents: 600000 }) }))
      .toEqual({ patientPayCents: 0, planPayCents: 3051, deductibleCreditCents: 0, familyRule: 0, phase: 'oop-max-reached' });
  });
});

test('estimatePatientCost is the same rule: splitClaimCost with no family', () => {
  const a = new AccumulatorData({
    planYear: dateToField('20260101'), deductibleAmountCents: Field(50000), deductiblePaidCents: Field(48000),
    oopMaxCents: Field(60000), oopPaidCents: Field(59000), annualBenefitMaxCents: Field(0), annualBenefitUsedCents: Field(0),
  });
  const s = splitClaimCost({ totalCostCents: 5500, copayCents: 1000, accumulator: { deductibleAmountCents: 50000, deductiblePaidCents: 48000, oopMaxCents: 60000, oopPaidCents: 59000, annualBenefitMaxCents: 0, annualBenefitUsedCents: 0 } });
  expect(AccumulatorQueryService.estimatePatientCost(a, 5500, 1000)).toEqual({ patientPayCents: s.patientPayCents, planPayCents: s.planPayCents });
  expect(s).toMatchObject({ patientPayCents: 1000, phase: 'oop-max-reached' });
});

// ─── The fill circuit itself, on constants ─────────────────

const PHARM_QUAL = Field(2);
const PHARM_ID_HASH = Field(555);
const PHARM_EK_HASH = Field(666);
const pharmacyWalletId = Poseidon.hash([DOMAIN_TAG_PHARMACY, PHARM_QUAL, PHARM_ID_HASH, PHARM_EK_HASH]);
const prescriberWalletId = Field(111222333444555666n);
const memberWalletId = Field(999888777666555444n);
const ndcHash = hashString('00378410591');

/** The fill circuit's amounts for one claim, from AccumulatorFulfillmentProgram's own method run on constants. */
async function circuitSplit(total: number, copay: number, a: AccumulatorAmounts, f: FamilyAmounts): Promise<{ patientPayCents: number; planPayCents: number; deductibleCreditCents: number; familyRule: number }> {
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
    ndcHash, tierLevel: Field(1), copayAmountCents: centsToField(copay), requiresPriorAuth: Field(0),
    maxQuantityPerFill: quantityToField(90), maxDaySupply: Field(90), stepTherapyRequired: Field(0),
  });
  const registry = new FormularyRegistry();
  registry.addEntry(entry);
  const fee = Math.min(total, 1250);
  const fulfillment = new FulfillmentData({
    prescriptionHash: rxData.commitment(), pharmacyWalletId, ndcHash, quantityDispensed: quantityToField(30),
    ingredientCostCents: centsToField(total - fee), dispensingFeeCents: centsToField(fee), dateOfService: dateToField('20260215'),
  });
  const accumulator = new AccumulatorData({
    planYear: dateToField('20260101'),
    deductibleAmountCents: Field(a.deductibleAmountCents), deductiblePaidCents: Field(a.deductiblePaidCents),
    oopMaxCents: Field(a.oopMaxCents), oopPaidCents: Field(a.oopPaidCents),
    annualBenefitMaxCents: Field(a.annualBenefitMaxCents), annualBenefitUsedCents: Field(a.annualBenefitUsedCents),
  });
  const eligForest = new MerkleForest();
  eligForest.setLeaf(ForestDomain.ACCESS_CONTROL, ACCUMULATOR_LEAF_INDEX, accumulator.commitment());
  const eligCredential = new CredentialData({
    credentialType: CREDENTIAL_TYPE_ELIGIBILITY, forestRoot: eligForest.getForestRoot(), issuerWalletId: Field(100200300400500600n),
    subjectWalletId: memberWalletId, issuedAt: dateToField('20260101'), expiresAt: Field(0), revoked: Field(0),
  });
  const raw = (AccumulatorFulfillmentProgram as unknown as { rawMethods: Record<string, (...args: unknown[]) => Promise<any>> }).rawMethods;
  const result = await raw.proveFulfillmentWithAccumulator(
    rxCredential, rxData, filled, fulfillment, entry, ForestRoots.fromForest(rxForest),
    rxForest.getWitness(ForestDomain.MEDICATION, 0n), rxForest.getWitness(ForestDomain.TRANSACTION, 1n), rxForest.getWitness(ForestDomain.TRANSACTION, 2n),
    registry.getEntryWitness(0n), registry.getRoot(), eligCredential, ForestRoots.fromForest(eligForest), accumulator,
    eligForest.getWitness(ForestDomain.ACCESS_CONTROL, ACCUMULATOR_LEAF_INDEX), PHARM_QUAL, PHARM_ID_HASH, PHARM_EK_HASH,
    Field(f.deductiblePaidCents), Field(f.oopPaidCents), Field(f.annualBenefitUsedCents),
    Field(f.familyDeductibleAmountCents), Field(f.familyOopMaxCents), Field(f.familyAnnualBenefitMaxCents),
  );
  const out = result.publicOutput ?? result;
  return {
    patientPayCents: Number(out.patientPayCents.toBigInt()),
    planPayCents: Number(out.planPayCents.toBigInt()),
    deductibleCreditCents: Number(out.deductibleCreditCents.toBigInt()),
    familyRule: Number(out.familyRule.toBigInt()),
  };
}

describe('splitClaimCost equals the fill circuit', () => {
  test('on the run.ts claims and the five family rules', async () => {
    const met = acc({ deductibleAmountCents: 50000, deductiblePaidCents: 50000, oopMaxCents: 800000 });
    const cases: Array<[number, number, AccumulatorAmounts, FamilyAmounts]> = [
      [3051, 1500, acc({ deductibleAmountCents: 50000, oopMaxCents: 780000 }), fam()],
      [72345, 1500, acc({ deductibleAmountCents: 50000, deductiblePaidCents: 3051, oopMaxCents: 780000, oopPaidCents: 3051 }), fam()],
      [57313, 1500, acc({ deductibleAmountCents: 50000, deductiblePaidCents: 50000, oopMaxCents: 780000, oopPaidCents: 51500, annualBenefitUsedCents: 23896 }), fam()],
      [5500, 1500, met, fam({ oopPaidCents: 1600000, familyOopMaxCents: 1600000 })],
      [5500, 1500, met, fam({ annualBenefitUsedCents: 100000, familyAnnualBenefitMaxCents: 100000 })],
      [5500, 1500, met, fam({ oopPaidCents: 1599500, familyOopMaxCents: 1600000 })],
      [5500, 1500, met, fam({ annualBenefitUsedCents: 97000, familyAnnualBenefitMaxCents: 100000 })],
    ];
    for (const [total, copay, a, f] of cases) {
      const s = splitClaimCost({ totalCostCents: total, copayCents: copay, accumulator: a, family: f });
      const c = await circuitSplit(total, copay, a, f);
      expect([total, s.patientPayCents, s.planPayCents, s.deductibleCreditCents, s.familyRule]).toEqual([total, c.patientPayCents, c.planPayCents, c.deductibleCreditCents, c.familyRule]);
    }
  });

  test('over a grid of states, limits met and lowered below what is paid among them', async () => {
    let seed = 20261019;
    const rnd = (n: number): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    const pick = <T>(xs: readonly T[]): T => xs[rnd(xs.length)];
    for (let i = 0; i < 48; i++) {
      const total = pick([0, 1, 1500, 3051, 9999, 57313, 72345, 150000]);
      const copay = pick([0, 1000, 1500, 3500, 15000]);
      const a = acc({
        deductibleAmountCents: pick([0, 25000, 50000]), deductiblePaidCents: pick([0, 3051, 24999, 25000, 30000, 50000, 60000]),
        oopMaxCents: pick([0, 5000, 60000, 780000]), oopPaidCents: pick([0, 4999, 5000, 6000, 59000, 600000]),
        annualBenefitMaxCents: pick([0, 50000, 100000]), annualBenefitUsedCents: pick([0, 49000, 100000, 120000]),
      });
      const f = fam({
        deductiblePaidCents: pick([0, 100000]), oopPaidCents: pick([0, 1500, 59900, 1600000]), annualBenefitUsedCents: pick([0, 97000, 100000]),
        familyDeductibleAmountCents: pick([0, 100000]), familyOopMaxCents: pick([0, 60000, 1600000]), familyAnnualBenefitMaxCents: pick([0, 100000]),
      });
      const s = splitClaimCost({ totalCostCents: total, copayCents: copay, accumulator: a, family: f });
      const c = await circuitSplit(total, copay, a, f);
      expect({ i, total, copay, a, f, split: [s.patientPayCents, s.planPayCents, s.deductibleCreditCents, s.familyRule] })
        .toEqual({ i, total, copay, a, f, split: [c.patientPayCents, c.planPayCents, c.deductibleCreditCents, c.familyRule] });
      expect(s.patientPayCents + s.planPayCents).toBe(total);
    }
  });
});
