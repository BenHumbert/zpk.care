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

import { Field, Poseidon } from 'o1js';
import {
  AccumulatorData,
  buildAccumulatorData,
  ACCUMULATOR_LEAF_INDEX,
} from '../src/access-control/accumulator-data.js';
import { AccumulatorQueryService } from '../src/access-control/accumulator-query-service.js';
import { BenefitCheckService } from '../src/access-control/benefit-check-service.js';
import type { AccumulatorLocalData } from '../src/access-control/accumulator-data.js';
import {
  AccumulatorFulfillmentOutput,
  AccumulatorFulfillmentProgram,
  AccumulatorFulfillmentProof,
} from '../src/fulfillment/accumulator-fulfillment-program.js';
import { AccumulatorFulfillmentService } from '../src/fulfillment/accumulator-fulfillment-service.js';
import { FamilyAccumulatorService } from '../src/onboarding/family-accumulator-service.js';
import { FULFILL_OP_CLAIM, FULFILL_OP_REVERSAL } from '../src/fulfillment/fulfillment-program.js';
import {
  FulfillmentData,
  ReversalData,
} from '../src/fulfillment/fulfillment-data.js';
import {
  PrescriptionData,
  PrescriptionStatusData,
  RX_STATUS_ADJUDICATED,
  RX_STATUS_FILLED,
} from '../src/prescription/prescription-data.js';
import { CredentialData, CREDENTIAL_TYPE_PRESCRIPTION, CREDENTIAL_TYPE_ELIGIBILITY } from '../src/credentials/credential-data.js';
import { CredentialInventory } from '../src/credentials/credential-inventory.js';
import { MerkleForest, ForestDomain } from '../src/zkp/merkle-forest.js';
import { ForestRoots } from '../src/eligibility/forest-roots.js';
import { FormularyEntry } from '../src/access-control/formulary-entry.js';
import { FormularyRegistry } from '../src/access-control/formulary-registry.js';
import {
  hashString,
  dateToField,
  centsToField,
  quantityToField,
} from '../src/zkp/hash-utils.js';
import { InMemoryStore } from '../src/storage/local-store.js';
import {
  WalletRegistry,
  WalletState,
} from '../src/wallets/wallet-state.js';
import { EMPTY_CREDENTIAL_ROOT } from '../src/engine/state-transition.js';
import { DOMAIN_TAG_PHARMACY } from '../src/wallets/wallet-derivation.js';

// ─── Test Data ──────────────────────────────────────────────

// Pharmacy wallet preimage components (H2 fix)
const PHARM_QUAL = Field(2);
const PHARM_ID_HASH = Field(555);
const PHARM_EK_HASH = Field(666);
const pharmacyWalletId = Poseidon.hash([DOMAIN_TAG_PHARMACY, PHARM_QUAL, PHARM_ID_HASH, PHARM_EK_HASH]);

const prescriberWalletId = Field(111222333444555666n);
const memberWalletId = Field(999888777666555444n);

const ndcHash = hashString('00071015523'); // Lisinopril 10mg

function createTestPrescriptionData(): PrescriptionData {
  return new PrescriptionData({
    ndcHash,
    prescriberWalletId,
    memberWalletId,
    writtenDate: dateToField('20260201'),
    expirationDate: dateToField('20270201'),
    quantityPrescribed: quantityToField(30),
    refillsAuthorized: Field(5),
  });
}

function createTestFormularyEntry(): FormularyEntry {
  return new FormularyEntry({
    ndcHash,
    tierLevel: Field(1), // GENERIC
    copayAmountCents: centsToField(1000), // $10.00 copay
    requiresPriorAuth: Field(0),
    maxQuantityPerFill: quantityToField(90),
    maxDaySupply: Field(90),
    stepTherapyRequired: Field(0),
  });
}

function createTestFormularyRegistry(): FormularyRegistry {
  const registry = new FormularyRegistry();
  registry.addEntry(createTestFormularyEntry());
  return registry;
}

function createTestFulfillmentData(rxCommitment: Field): FulfillmentData {
  return new FulfillmentData({
    prescriptionHash: rxCommitment,
    pharmacyWalletId,
    ndcHash,
    quantityDispensed: quantityToField(30),
    ingredientCostCents: centsToField(5000),  // $50.00
    dispensingFeeCents: centsToField(500),     // $5.00
    dateOfService: dateToField('20260215'),
  });
}

function createTestAccumulator(overrides: Partial<{
  deductibleAmount: number;
  deductiblePaid: number;
  oopMax: number;
  oopPaid: number;
  benefitMax: number;
  benefitUsed: number;
}> = {}): AccumulatorData {
  return new AccumulatorData({
    planYear: dateToField('20260101'),
    deductibleAmountCents: Field(overrides.deductibleAmount ?? 0),
    deductiblePaidCents: Field(overrides.deductiblePaid ?? 0),
    oopMaxCents: Field(overrides.oopMax ?? 0),
    oopPaidCents: Field(overrides.oopPaid ?? 0),
    annualBenefitMaxCents: Field(overrides.benefitMax ?? 0),
    annualBenefitUsedCents: Field(overrides.benefitUsed ?? 0),
  });
}

function createTestWalletRegistry(): WalletRegistry {
  const registry = new WalletRegistry();
  registry.register(
    pharmacyWalletId,
    new WalletState({
      walletId: pharmacyWalletId,
      credentialInventoryRoot: EMPTY_CREDENTIAL_ROOT,
      nonce: Field(0),
    }),
  );
  registry.register(
    memberWalletId,
    new WalletState({
      walletId: memberWalletId,
      credentialInventoryRoot: EMPTY_CREDENTIAL_ROOT,
      nonce: Field(0),
    }),
  );
  return registry;
}

/**
 * Set up a prescription credential that's been FILLED (pharmacy side)
 * and an eligibility credential with accumulator (member side).
 */
function setupDualCredentialScenario(accumulator: AccumulatorData): {
  rxData: PrescriptionData;
  prescriptionCredential: CredentialData;
  prescriptionForest: MerkleForest;
  filledStatus: PrescriptionStatusData;
  pharmacyInventory: CredentialInventory;
  prescriptionCredentialSlot: bigint;
  eligibilityCredential: CredentialData;
  eligibilityForest: MerkleForest;
  memberInventory: CredentialInventory;
  eligibilityCredentialSlot: bigint;
  registry: WalletRegistry;
} {
  // ── Prescription side ──
  const rxData = createTestPrescriptionData();
  const prescriptionForest = new MerkleForest();
  const pharmacyInventory = new CredentialInventory();

  // Insert prescription into MEDICATION tree
  prescriptionForest.setLeaf(ForestDomain.MEDICATION, 0n, rxData.commitment());

  // Insert initial ACTIVE status at TRANSACTION leaf 0
  const activeStatus = new PrescriptionStatusData({
    prescriptionHash: rxData.commitment(),
    status: RX_STATUS_ADJUDICATED,
    updatedByWalletId: prescriberWalletId,
    updatedAt: dateToField('20260201'),
    pharmacyWalletId,
    fillQuantity: Field(0),
    notesHash: Field(0),
  });
  prescriptionForest.setLeaf(ForestDomain.TRANSACTION, 0n, activeStatus.commitment());

  // Insert FILLED status at TRANSACTION leaf 1
  const filledStatus = new PrescriptionStatusData({
    prescriptionHash: rxData.commitment(),
    status: RX_STATUS_FILLED,
    updatedByWalletId: pharmacyWalletId,
    updatedAt: dateToField('20260215'),
    pharmacyWalletId,
    fillQuantity: quantityToField(30),
    notesHash: Field(0),
  });
  prescriptionForest.setLeaf(ForestDomain.TRANSACTION, 1n, filledStatus.commitment());

  // Build prescription credential
  const prescriptionCredential = new CredentialData({
    credentialType: CREDENTIAL_TYPE_PRESCRIPTION,
    forestRoot: prescriptionForest.getForestRoot(),
    issuerWalletId: prescriberWalletId,
    subjectWalletId: pharmacyWalletId,
    issuedAt: dateToField('20260201'),
    expiresAt: dateToField('20270201'),
    revoked: Field(0),
  });
  const { index: prescriptionCredentialSlot } = pharmacyInventory.mint(prescriptionCredential);

  // ── Eligibility side ──
  const eligibilityForest = new MerkleForest();
  const memberInventory = new CredentialInventory();

  // Insert accumulator at leaf 127 of ACCESS_CONTROL tree
  eligibilityForest.setLeaf(
    ForestDomain.ACCESS_CONTROL,
    ACCUMULATOR_LEAF_INDEX,
    accumulator.commitment(),
  );

  // Build eligibility credential
  const eligibilityCredential = new CredentialData({
    credentialType: CREDENTIAL_TYPE_ELIGIBILITY,
    forestRoot: eligibilityForest.getForestRoot(),
    issuerWalletId: Field(100200300400500600n), // insurer admin
    subjectWalletId: memberWalletId,
    issuedAt: dateToField('20260101'),
    expiresAt: dateToField('20261231'),
    revoked: Field(0),
  });
  const { index: eligibilityCredentialSlot } = memberInventory.mint(eligibilityCredential);

  // Register both wallets
  const registry = createTestWalletRegistry();

  return {
    rxData,
    prescriptionCredential,
    prescriptionForest,
    filledStatus,
    pharmacyInventory,
    prescriptionCredentialSlot,
    eligibilityCredential,
    eligibilityForest,
    memberInventory,
    eligibilityCredentialSlot,
    registry,
  };
}

// ─── Tests ──────────────────────────────────────────────────

describe('Accumulator — Benefit Accumulators (Deductible, OOPM, Annual Max)', () => {

  // ── AccumulatorData Model ─────────────────────────────────

  describe('AccumulatorData Model', () => {
    it('commitment is deterministic', () => {
      const a1 = createTestAccumulator({ deductibleAmount: 50000, deductiblePaid: 10000 });
      const a2 = createTestAccumulator({ deductibleAmount: 50000, deductiblePaid: 10000 });
      expect(a1.commitment().toString()).toBe(a2.commitment().toString());
    });

    it('commitment changes when any field changes', () => {
      const a1 = createTestAccumulator({ deductibleAmount: 50000, deductiblePaid: 10000 });
      const base = a1.commitment().toString();

      const a2 = createTestAccumulator({ deductibleAmount: 50000, deductiblePaid: 20000 });
      expect(a2.commitment().toString()).not.toBe(base);

      const a3 = createTestAccumulator({ deductibleAmount: 50000, deductiblePaid: 10000, oopMax: 100000 });
      expect(a3.commitment().toString()).not.toBe(base);
    });

    it('buildAccumulatorData from local data', () => {
      const local: AccumulatorLocalData = {
        planYear: '20260101',
        deductibleAmountCents: 50000,
        deductiblePaidCents: 10000,
        oopMaxCents: 500000,
        oopPaidCents: 25000,
        annualBenefitMaxCents: 1000000,
        annualBenefitUsedCents: 100000,
      };
      const a = buildAccumulatorData(local);
      expect(a.deductibleAmountCents.toString()).toBe('50000');
      expect(a.deductiblePaidCents.toString()).toBe('10000');
      expect(a.oopMaxCents.toString()).toBe('500000');
      expect(a.oopPaidCents.toString()).toBe('25000');
      expect(a.annualBenefitMaxCents.toString()).toBe('1000000');
      expect(a.annualBenefitUsedCents.toString()).toBe('100000');
    });

    it('ACCUMULATOR_LEAF_INDEX is 127', () => {
      expect(ACCUMULATOR_LEAF_INDEX).toBe(127n);
    });
  });

  // ── AccumulatorFulfillmentOutput ──────────────────────────

  describe('AccumulatorFulfillmentOutput', () => {
    it('has 10 fields including newEligibilityForestRoot, deductibleCreditCents, and ndcHash', () => {
      const output = new AccumulatorFulfillmentOutput({
        prescriptionHash: Field(1),
        oldForestRoot: Field(2),
        newForestRoot: Field(3),
        entryCommitment: Field(4),
        patientPayCents: Field(5),
        planPayCents: Field(6),
        operationType: Field(7),
        newEligibilityForestRoot: Field(8),
        deductibleCreditCents: Field(9),
        ndcHash: Field(10),
      });
      expect(output.prescriptionHash.toString()).toBe('1');
      expect(output.newEligibilityForestRoot.toString()).toBe('8');
      expect(output.deductibleCreditCents.toString()).toBe('9');
    });
  });

  // ── Settlement Commitment ─────────────────────────────────

  describe('Settlement commitment', () => {
    it('is Poseidon.hash([fulfillment.commitment(), patientPay, planPay, deductibleCredit])', () => {
      const rxHash = createTestPrescriptionData().commitment();
      const fulfillment = createTestFulfillmentData(rxHash);
      const patientPay = Field(1000);
      const planPay = Field(4500);
      const deductibleCredit = Field(0);

      const expected = Poseidon.hash([
        fulfillment.commitment(),
        patientPay,
        planPay,
        deductibleCredit,
      ]);

      // Verify it differs from plain commitment
      expect(expected.toString()).not.toBe(fulfillment.commitment().toString());

      // Verify determinism
      const again = Poseidon.hash([
        fulfillment.commitment(),
        patientPay,
        planPay,
        deductibleCredit,
      ]);
      expect(again.toString()).toBe(expected.toString());
    });
  });

  // ── calculateAccumulatorAwareAmounts ──────────────────────

  describe('calculateAccumulatorAwareAmounts', () => {
    let service: AccumulatorFulfillmentService;

    beforeEach(() => {
      const registry = createTestWalletRegistry();
      const formularyRegistry = createTestFormularyRegistry();
      service = new AccumulatorFulfillmentService(
        new InMemoryStore(),
        registry,
        formularyRegistry,
      );
    });

    it('no accumulators (zero limits) → same as simple copay', () => {
      const rxHash = createTestPrescriptionData().commitment();
      const fulfillment = createTestFulfillmentData(rxHash); // total = 5500
      const formulary = createTestFormularyEntry(); // copay = 1000
      const accumulator = createTestAccumulator(); // all zeros

      const { patientPayCents, planPayCents } =
        service.calculateAccumulatorAwareAmounts(fulfillment, formulary, accumulator);

      // Normal copay: min(5500, 1000) = 1000
      expect(patientPayCents.toString()).toBe('1000');
      expect(planPayCents.toString()).toBe('4500');
    });

    it('deductible phase: patient pays remaining deductible', () => {
      const rxHash = createTestPrescriptionData().commitment();
      const fulfillment = createTestFulfillmentData(rxHash); // total = 5500
      const formulary = createTestFormularyEntry(); // copay = 1000
      const accumulator = createTestAccumulator({
        deductibleAmount: 50000, // $500 deductible
        deductiblePaid: 0,       // nothing paid yet
      });

      const { patientPayCents, planPayCents } =
        service.calculateAccumulatorAwareAmounts(fulfillment, formulary, accumulator);

      // Deductible phase: min(5500, 50000-0) = min(5500, 50000) = 5500
      expect(patientPayCents.toString()).toBe('5500');
      expect(planPayCents.toString()).toBe('0');
    });

    it('deductible partially met: patient pays remainder + copay on excess (C5 fix)', () => {
      const rxHash = createTestPrescriptionData().commitment();
      const fulfillment = createTestFulfillmentData(rxHash); // total = 5500
      const formulary = createTestFormularyEntry(); // copay = 1000
      const accumulator = createTestAccumulator({
        deductibleAmount: 50000, // $500 deductible
        deductiblePaid: 47000,   // $470 paid → $30 remaining
      });

      const { patientPayCents, planPayCents, deductibleCreditCents } =
        service.calculateAccumulatorAwareAmounts(fulfillment, formulary, accumulator);

      // remaining = 3000; deductiblePay = min(5500, 3000) = 3000
      // afterDeductible = 5500 - 3000 = 2500; copayOnRemainder = min(2500, 1000) = 1000
      // basePay = 3000 + 1000 = 4000; planPay = 1500
      expect(patientPayCents.toString()).toBe('4000');
      expect(planPayCents.toString()).toBe('1500');
      expect(deductibleCreditCents.toString()).toBe('3000');
    });

    it('deductible met → normal copay phase', () => {
      const rxHash = createTestPrescriptionData().commitment();
      const fulfillment = createTestFulfillmentData(rxHash); // total = 5500
      const formulary = createTestFormularyEntry(); // copay = 1000
      const accumulator = createTestAccumulator({
        deductibleAmount: 50000,
        deductiblePaid: 50000, // deductible fully met
      });

      const { patientPayCents, planPayCents } =
        service.calculateAccumulatorAwareAmounts(fulfillment, formulary, accumulator);

      // Normal copay: min(5500, 1000) = 1000
      expect(patientPayCents.toString()).toBe('1000');
      expect(planPayCents.toString()).toBe('4500');
    });

    it('OOPM met → patient pays $0', () => {
      const rxHash = createTestPrescriptionData().commitment();
      const fulfillment = createTestFulfillmentData(rxHash);
      const formulary = createTestFormularyEntry();
      const accumulator = createTestAccumulator({
        oopMax: 500000,    // $5000 OOPM
        oopPaid: 500000,   // fully met
      });

      const { patientPayCents, planPayCents } =
        service.calculateAccumulatorAwareAmounts(fulfillment, formulary, accumulator);

      expect(patientPayCents.toString()).toBe('0');
      expect(planPayCents.toString()).toBe('5500');
    });

    it('benefit exhausted → patient pays total', () => {
      const rxHash = createTestPrescriptionData().commitment();
      const fulfillment = createTestFulfillmentData(rxHash); // total = 5500
      const formulary = createTestFormularyEntry();
      const accumulator = createTestAccumulator({
        benefitMax: 100000,   // $1000 annual benefit max
        benefitUsed: 100000,  // fully used
      });

      const { patientPayCents, planPayCents } =
        service.calculateAccumulatorAwareAmounts(fulfillment, formulary, accumulator);

      // Plan won't pay any more → patient pays total
      expect(patientPayCents.toString()).toBe('5500');
      expect(planPayCents.toString()).toBe('0');
    });

    it('OOPM overrides benefit exhaustion', () => {
      const rxHash = createTestPrescriptionData().commitment();
      const fulfillment = createTestFulfillmentData(rxHash);
      const formulary = createTestFormularyEntry();
      const accumulator = createTestAccumulator({
        oopMax: 500000,       // OOPM set
        oopPaid: 500000,      // OOPM met
        benefitMax: 100000,   // benefit max set
        benefitUsed: 100000,  // benefit exhausted
      });

      const { patientPayCents, planPayCents } =
        service.calculateAccumulatorAwareAmounts(fulfillment, formulary, accumulator);

      // OOPM met → patient $0 (overrides benefit exhaustion)
      expect(patientPayCents.toString()).toBe('0');
      expect(planPayCents.toString()).toBe('5500');
    });
  });

  // ── AccumulatorFulfillmentProgram (slow — requires compile) ─

  describe('AccumulatorFulfillmentProgram', () => {

    beforeAll(async () => {
      await AccumulatorFulfillmentProgram.compile();
    }, 180_000);

    describe('proveFulfillmentWithAccumulator', () => {

      it('deductible phase: $55 claim, $500 deductible unpaid → patient pays $55', async () => {
        const accumulator = createTestAccumulator({
          deductibleAmount: 50000, // $500 deductible
          deductiblePaid: 0,
        });
        const scenario = setupDualCredentialScenario(accumulator);

        const fulfillment = createTestFulfillmentData(scenario.rxData.commitment());
        const formularyRegistry = createTestFormularyRegistry();
        const formularyEntry = formularyRegistry.getEntry(0n)!;
        const formularyWitness = formularyRegistry.getEntryWitness(0n);
        const formularyRoot = formularyRegistry.getRoot();

        const rxForestRoots = ForestRoots.fromForest(scenario.prescriptionForest);
        const medicationWitness = scenario.prescriptionForest.getWitness(ForestDomain.MEDICATION, 0n);
        const statusWitness = scenario.prescriptionForest.getWitness(ForestDomain.TRANSACTION, 1n);
        const newSlotWitness = scenario.prescriptionForest.getWitness(ForestDomain.TRANSACTION, 2n);

        const eligForestRoots = ForestRoots.fromForest(scenario.eligibilityForest);
        const accumulatorWitness = scenario.eligibilityForest.getWitness(
          ForestDomain.ACCESS_CONTROL,
          ACCUMULATOR_LEAF_INDEX,
        );

        const result = await AccumulatorFulfillmentProgram.proveFulfillmentWithAccumulator(
          scenario.prescriptionCredential,
          scenario.rxData,
          scenario.filledStatus,
          fulfillment,
          formularyEntry,
          rxForestRoots,
          medicationWitness,
          statusWitness,
          newSlotWitness,
          formularyWitness,
          formularyRoot,
          scenario.eligibilityCredential,
          eligForestRoots,
          accumulator,
          accumulatorWitness,
          PHARM_QUAL,
          PHARM_ID_HASH,
          PHARM_EK_HASH,
          Field(0), Field(0), Field(0), Field(0), Field(0), Field(0),   // B8: no family limits
        );

        const output = result.proof.publicOutput;
        expect(output.operationType.toString()).toBe(FULFILL_OP_CLAIM.toString());

        // total=5500, deductible remaining=50000 → min(5500, 50000) = 5500 patient pays all
        expect(output.patientPayCents.toString()).toBe('5500');
        expect(output.planPayCents.toString()).toBe('0');

        // Both forest roots changed
        expect(output.newForestRoot.toString()).not.toBe(scenario.prescriptionCredential.forestRoot.toString());
        expect(output.newEligibilityForestRoot.toString()).not.toBe(scenario.eligibilityCredential.forestRoot.toString());
      }, 120_000);

      it('normal phase: deductible met → patient pays $10 copay', async () => {
        const accumulator = createTestAccumulator({
          deductibleAmount: 50000,
          deductiblePaid: 50000, // fully met
        });
        const scenario = setupDualCredentialScenario(accumulator);

        const fulfillment = createTestFulfillmentData(scenario.rxData.commitment());
        const formularyRegistry = createTestFormularyRegistry();
        const formularyEntry = formularyRegistry.getEntry(0n)!;
        const formularyWitness = formularyRegistry.getEntryWitness(0n);
        const formularyRoot = formularyRegistry.getRoot();

        const rxForestRoots = ForestRoots.fromForest(scenario.prescriptionForest);
        const medicationWitness = scenario.prescriptionForest.getWitness(ForestDomain.MEDICATION, 0n);
        const statusWitness = scenario.prescriptionForest.getWitness(ForestDomain.TRANSACTION, 1n);
        const newSlotWitness = scenario.prescriptionForest.getWitness(ForestDomain.TRANSACTION, 2n);

        const eligForestRoots = ForestRoots.fromForest(scenario.eligibilityForest);
        const accumulatorWitness = scenario.eligibilityForest.getWitness(
          ForestDomain.ACCESS_CONTROL,
          ACCUMULATOR_LEAF_INDEX,
        );

        const result = await AccumulatorFulfillmentProgram.proveFulfillmentWithAccumulator(
          scenario.prescriptionCredential,
          scenario.rxData,
          scenario.filledStatus,
          fulfillment,
          formularyEntry,
          rxForestRoots,
          medicationWitness,
          statusWitness,
          newSlotWitness,
          formularyWitness,
          formularyRoot,
          scenario.eligibilityCredential,
          eligForestRoots,
          accumulator,
          accumulatorWitness,
          PHARM_QUAL,
          PHARM_ID_HASH,
          PHARM_EK_HASH,
          Field(0), Field(0), Field(0), Field(0), Field(0), Field(0),   // B8: no family limits
        );

        const output = result.proof.publicOutput;
        // deductible met → normal copay: min(5500, 1000) = 1000
        expect(output.patientPayCents.toString()).toBe('1000');
        expect(output.planPayCents.toString()).toBe('4500');
      }, 120_000);

      it('OOPM met → patient pays $0', async () => {
        const accumulator = createTestAccumulator({
          oopMax: 500000,
          oopPaid: 500000, // fully met
        });
        const scenario = setupDualCredentialScenario(accumulator);

        const fulfillment = createTestFulfillmentData(scenario.rxData.commitment());
        const formularyRegistry = createTestFormularyRegistry();
        const formularyEntry = formularyRegistry.getEntry(0n)!;
        const formularyWitness = formularyRegistry.getEntryWitness(0n);
        const formularyRoot = formularyRegistry.getRoot();

        const rxForestRoots = ForestRoots.fromForest(scenario.prescriptionForest);
        const medicationWitness = scenario.prescriptionForest.getWitness(ForestDomain.MEDICATION, 0n);
        const statusWitness = scenario.prescriptionForest.getWitness(ForestDomain.TRANSACTION, 1n);
        const newSlotWitness = scenario.prescriptionForest.getWitness(ForestDomain.TRANSACTION, 2n);

        const eligForestRoots = ForestRoots.fromForest(scenario.eligibilityForest);
        const accumulatorWitness = scenario.eligibilityForest.getWitness(
          ForestDomain.ACCESS_CONTROL,
          ACCUMULATOR_LEAF_INDEX,
        );

        const result = await AccumulatorFulfillmentProgram.proveFulfillmentWithAccumulator(
          scenario.prescriptionCredential,
          scenario.rxData,
          scenario.filledStatus,
          fulfillment,
          formularyEntry,
          rxForestRoots,
          medicationWitness,
          statusWitness,
          newSlotWitness,
          formularyWitness,
          formularyRoot,
          scenario.eligibilityCredential,
          eligForestRoots,
          accumulator,
          accumulatorWitness,
          PHARM_QUAL,
          PHARM_ID_HASH,
          PHARM_EK_HASH,
          Field(0), Field(0), Field(0), Field(0), Field(0), Field(0),   // B8: no family limits
        );

        const output = result.proof.publicOutput;
        expect(output.patientPayCents.toString()).toBe('0');
        expect(output.planPayCents.toString()).toBe('5500');
      }, 120_000);

      it('no accumulators → same as simple copay ($10)', async () => {
        const accumulator = createTestAccumulator(); // all zeros
        const scenario = setupDualCredentialScenario(accumulator);

        const fulfillment = createTestFulfillmentData(scenario.rxData.commitment());
        const formularyRegistry = createTestFormularyRegistry();
        const formularyEntry = formularyRegistry.getEntry(0n)!;
        const formularyWitness = formularyRegistry.getEntryWitness(0n);
        const formularyRoot = formularyRegistry.getRoot();

        const rxForestRoots = ForestRoots.fromForest(scenario.prescriptionForest);
        const medicationWitness = scenario.prescriptionForest.getWitness(ForestDomain.MEDICATION, 0n);
        const statusWitness = scenario.prescriptionForest.getWitness(ForestDomain.TRANSACTION, 1n);
        const newSlotWitness = scenario.prescriptionForest.getWitness(ForestDomain.TRANSACTION, 2n);

        const eligForestRoots = ForestRoots.fromForest(scenario.eligibilityForest);
        const accumulatorWitness = scenario.eligibilityForest.getWitness(
          ForestDomain.ACCESS_CONTROL,
          ACCUMULATOR_LEAF_INDEX,
        );

        const result = await AccumulatorFulfillmentProgram.proveFulfillmentWithAccumulator(
          scenario.prescriptionCredential,
          scenario.rxData,
          scenario.filledStatus,
          fulfillment,
          formularyEntry,
          rxForestRoots,
          medicationWitness,
          statusWitness,
          newSlotWitness,
          formularyWitness,
          formularyRoot,
          scenario.eligibilityCredential,
          eligForestRoots,
          accumulator,
          accumulatorWitness,
          PHARM_QUAL,
          PHARM_ID_HASH,
          PHARM_EK_HASH,
          Field(0), Field(0), Field(0), Field(0), Field(0), Field(0),   // B8: no family limits
        );

        const output = result.proof.publicOutput;
        // No accumulators → normal copay: min(5500, 1000) = 1000
        expect(output.patientPayCents.toString()).toBe('1000');
        expect(output.planPayCents.toString()).toBe('4500');
      }, 120_000);
    });

    // B8 (A-23): family pooling inside the circuit. The amounts the proof commits to are the amounts billed: the
    // new eligibility forest root the proof outputs is the one the engine reaches by adding the proof's own
    // amounts to the accumulator, with no rewrite after the proof.
    describe('family pooling inside the circuit (B8, A-23)', () => {
      type Family = { paid: [number, number, number]; limits: [number, number, number] };
      async function proveWithFamily(family: Family) {
        // deductible met, individual OOP far away: the individual rules give the $10 copay on a $55 claim
        const accumulator = createTestAccumulator({ deductibleAmount: 50000, deductiblePaid: 50000, oopMax: 800000, oopPaid: 0 });
        const scenario = setupDualCredentialScenario(accumulator);
        const fulfillment = createTestFulfillmentData(scenario.rxData.commitment());
        const formularyRegistry = createTestFormularyRegistry();
        const formularyEntry = formularyRegistry.getEntry(0n)!;
        const formularyWitness = formularyRegistry.getEntryWitness(0n);
        const formularyRoot = formularyRegistry.getRoot();
        const rxForestRoots = ForestRoots.fromForest(scenario.prescriptionForest);
        const medicationWitness = scenario.prescriptionForest.getWitness(ForestDomain.MEDICATION, 0n);
        const statusWitness = scenario.prescriptionForest.getWitness(ForestDomain.TRANSACTION, 1n);
        const newSlotWitness = scenario.prescriptionForest.getWitness(ForestDomain.TRANSACTION, 2n);
        const eligForestRoots = ForestRoots.fromForest(scenario.eligibilityForest);
        const accumulatorWitness = scenario.eligibilityForest.getWitness(ForestDomain.ACCESS_CONTROL, ACCUMULATOR_LEAF_INDEX);
        const result = await AccumulatorFulfillmentProgram.proveFulfillmentWithAccumulator(
          scenario.prescriptionCredential, scenario.rxData, scenario.filledStatus, fulfillment, formularyEntry, rxForestRoots,
          medicationWitness, statusWitness, newSlotWitness, formularyWitness, formularyRoot, scenario.eligibilityCredential,
          eligForestRoots, accumulator, accumulatorWitness, PHARM_QUAL, PHARM_ID_HASH, PHARM_EK_HASH,
          Field(family.paid[0]), Field(family.paid[1]), Field(family.paid[2]), Field(family.limits[0]), Field(family.limits[1]), Field(family.limits[2]),
        );
        const output = result.proof.publicOutput;
        // the A-23 property: the engine's accumulator after the fill, from the proof's own amounts, is the leaf the proof committed
        const after = new AccumulatorData({
          planYear: accumulator.planYear,
          deductibleAmountCents: accumulator.deductibleAmountCents,
          deductiblePaidCents: accumulator.deductiblePaidCents.add(output.deductibleCreditCents),
          oopMaxCents: accumulator.oopMaxCents,
          oopPaidCents: accumulator.oopPaidCents.add(output.patientPayCents),
          annualBenefitMaxCents: accumulator.annualBenefitMaxCents,
          annualBenefitUsedCents: accumulator.annualBenefitUsedCents.add(output.planPayCents),
        });
        scenario.eligibilityForest.setLeaf(ForestDomain.ACCESS_CONTROL, ACCUMULATOR_LEAF_INDEX, after.commitment());
        expect(output.newEligibilityForestRoot.toString()).toBe(scenario.eligibilityForest.getForestRoot().toString());
        const reference = FamilyAccumulatorService.computeFamilyAdjustedPay(1000, 5500,
          { deductiblePaidCents: family.paid[0], oopPaidCents: family.paid[1], annualBenefitUsedCents: family.paid[2], memberCount: 2 },
          { familyDeductibleAmountCents: family.limits[0], familyOopMaxCents: family.limits[1], familyAnnualBenefitMaxCents: family.limits[2] });
        expect(output.patientPayCents.toString()).toBe(String(reference.patientPayCents));
        expect(output.planPayCents.toString()).toBe(String(reference.planPayCents));
        expect(output.familyCommitment.toString()).toBe(Poseidon.hash([...family.paid, ...family.limits].map((n) => Field(n))).toString());
        return output;
      }

      it('no family limits: the individual split, rule 0', async () => {
        const output = await proveWithFamily({ paid: [0, 0, 0], limits: [0, 0, 0] });
        expect([output.patientPayCents.toString(), output.planPayCents.toString(), output.familyRule.toString()]).toEqual(['1000', '4500', '0']);
      }, 120_000);
      it('family out-of-pocket maximum met: the patient pays nothing', async () => {
        const output = await proveWithFamily({ paid: [100000, 1600000, 0], limits: [100000, 1600000, 0] });
        expect([output.patientPayCents.toString(), output.planPayCents.toString(), output.familyRule.toString()]).toEqual(['0', '5500', '1']);
      }, 120_000);
      it('patient pay capped at the family out-of-pocket remaining', async () => {
        const output = await proveWithFamily({ paid: [100000, 1599500, 0], limits: [100000, 1600000, 0] });
        expect([output.patientPayCents.toString(), output.planPayCents.toString(), output.familyRule.toString()]).toEqual(['500', '5000', '3']);
      }, 120_000);
      it('family annual benefit exhausted: the patient pays everything', async () => {
        const output = await proveWithFamily({ paid: [0, 0, 100000], limits: [0, 0, 100000] });
        expect([output.patientPayCents.toString(), output.planPayCents.toString(), output.familyRule.toString()]).toEqual(['5500', '0', '2']);
      }, 120_000);
      it('plan pay capped at the family benefit remaining', async () => {
        const output = await proveWithFamily({ paid: [0, 0, 97000], limits: [0, 0, 100000] });
        expect([output.patientPayCents.toString(), output.planPayCents.toString(), output.familyRule.toString()]).toEqual(['2500', '3000', '4']);
      }, 120_000);
    });

    describe('proveReversalWithAccumulator', () => {
      it('reverses amounts correctly', async () => {
        // First: fulfill with deductible not met (patient pays $55)
        const accumulator = createTestAccumulator({
          deductibleAmount: 50000,
          deductiblePaid: 0,
        });
        const scenario = setupDualCredentialScenario(accumulator);

        const fulfillment = createTestFulfillmentData(scenario.rxData.commitment());
        const formularyRegistry = createTestFormularyRegistry();
        const formularyEntry = formularyRegistry.getEntry(0n)!;
        const formularyWitness = formularyRegistry.getEntryWitness(0n);
        const formularyRoot = formularyRegistry.getRoot();

        // Generate fulfillment proof first
        const rxForestRoots = ForestRoots.fromForest(scenario.prescriptionForest);
        const medicationWitness = scenario.prescriptionForest.getWitness(ForestDomain.MEDICATION, 0n);
        const statusWitness = scenario.prescriptionForest.getWitness(ForestDomain.TRANSACTION, 1n);
        const newSlotWitness = scenario.prescriptionForest.getWitness(ForestDomain.TRANSACTION, 2n);

        const eligForestRoots = ForestRoots.fromForest(scenario.eligibilityForest);
        const accumulatorWitness = scenario.eligibilityForest.getWitness(
          ForestDomain.ACCESS_CONTROL,
          ACCUMULATOR_LEAF_INDEX,
        );

        const fulfillResult = await AccumulatorFulfillmentProgram.proveFulfillmentWithAccumulator(
          scenario.prescriptionCredential,
          scenario.rxData,
          scenario.filledStatus,
          fulfillment,
          formularyEntry,
          rxForestRoots,
          medicationWitness,
          statusWitness,
          newSlotWitness,
          formularyWitness,
          formularyRoot,
          scenario.eligibilityCredential,
          eligForestRoots,
          accumulator,
          accumulatorWitness,
          PHARM_QUAL,
          PHARM_ID_HASH,
          PHARM_EK_HASH,
          Field(0), Field(0), Field(0), Field(0), Field(0), Field(0),   // B8: no family limits
        );

        const origPatientPay = fulfillResult.proof.publicOutput.patientPayCents;
        const origPlanPay = fulfillResult.proof.publicOutput.planPayCents;

        const origDeductibleCredit = fulfillResult.proof.publicOutput.deductibleCreditCents;

        // Mutate prescription forest: insert settlement commitment at index 2
        const settlementCommitment = Poseidon.hash([
          fulfillment.commitment(),
          origPatientPay,
          origPlanPay,
          origDeductibleCredit,
        ]);
        scenario.prescriptionForest.setLeaf(
          ForestDomain.TRANSACTION,
          2n,
          settlementCommitment,
        );

        // Update prescription credential
        const postFulfillCredential = new CredentialData({
          credentialType: CREDENTIAL_TYPE_PRESCRIPTION,
          forestRoot: scenario.prescriptionForest.getForestRoot(),
          issuerWalletId: scenario.prescriptionCredential.issuerWalletId,
          subjectWalletId: scenario.prescriptionCredential.subjectWalletId,
          issuedAt: scenario.prescriptionCredential.issuedAt,
          expiresAt: scenario.prescriptionCredential.expiresAt,
          revoked: Field(0),
        });

        // Update accumulator in eligibility forest (C4: use deductibleCredit for deductible)
        const postFulfillAccumulator = new AccumulatorData({
          planYear: accumulator.planYear,
          deductibleAmountCents: accumulator.deductibleAmountCents,
          deductiblePaidCents: Field(BigInt(accumulator.deductiblePaidCents.toString()) + BigInt(origDeductibleCredit.toString())),
          oopMaxCents: accumulator.oopMaxCents,
          oopPaidCents: Field(BigInt(accumulator.oopPaidCents.toString()) + BigInt(origPatientPay.toString())),
          annualBenefitMaxCents: accumulator.annualBenefitMaxCents,
          annualBenefitUsedCents: Field(BigInt(accumulator.annualBenefitUsedCents.toString()) + BigInt(origPlanPay.toString())),
        });

        scenario.eligibilityForest.setLeaf(
          ForestDomain.ACCESS_CONTROL,
          ACCUMULATOR_LEAF_INDEX,
          postFulfillAccumulator.commitment(),
        );

        const postFulfillEligCredential = new CredentialData({
          credentialType: CREDENTIAL_TYPE_ELIGIBILITY,
          forestRoot: scenario.eligibilityForest.getForestRoot(),
          issuerWalletId: scenario.eligibilityCredential.issuerWalletId,
          subjectWalletId: scenario.eligibilityCredential.subjectWalletId,
          issuedAt: scenario.eligibilityCredential.issuedAt,
          expiresAt: scenario.eligibilityCredential.expiresAt,
          revoked: Field(0),
        });

        // Now reverse
        const reversalData = new ReversalData({
          fulfillmentHash: fulfillment.commitment(),
          pharmacyWalletId,
          patientRefundCents: origPatientPay,
          planRefundCents: origPlanPay,
          reversalDate: dateToField('20260301'),
          reasonCodeHash: Field(0),
          reversedByWalletId: pharmacyWalletId,
        });

        const rxForestRoots2 = ForestRoots.fromForest(scenario.prescriptionForest);
        const medicationWitness2 = scenario.prescriptionForest.getWitness(ForestDomain.MEDICATION, 0n);
        const fulfillmentWitness = scenario.prescriptionForest.getWitness(ForestDomain.TRANSACTION, 2n);
        const reversalSlotWitness = scenario.prescriptionForest.getWitness(ForestDomain.TRANSACTION, 3n);

        const eligForestRoots2 = ForestRoots.fromForest(scenario.eligibilityForest);
        const accWitness2 = scenario.eligibilityForest.getWitness(
          ForestDomain.ACCESS_CONTROL,
          ACCUMULATOR_LEAF_INDEX,
        );

        const reversalResult = await AccumulatorFulfillmentProgram.proveReversalWithAccumulator(
          postFulfillCredential,
          scenario.rxData,
          fulfillment,
          reversalData,
          rxForestRoots2,
          medicationWitness2,
          fulfillmentWitness,
          reversalSlotWitness,
          origPatientPay,
          origPlanPay,
          origDeductibleCredit,
          postFulfillEligCredential,
          eligForestRoots2,
          postFulfillAccumulator,
          accWitness2,
          PHARM_QUAL,
          PHARM_ID_HASH,
          PHARM_EK_HASH,
        );

        const output = reversalResult.proof.publicOutput;
        expect(output.operationType.toString()).toBe(FULFILL_OP_REVERSAL.toString());
        expect(output.patientPayCents.toString()).toBe(origPatientPay.toString());
        expect(output.planPayCents.toString()).toBe(origPlanPay.toString());

        // New eligibility forest root changed again (accumulator reversed)
        expect(output.newEligibilityForestRoot.toString())
          .not.toBe(postFulfillEligCredential.forestRoot.toString());
      }, 120_000);
    });
  });

  // ── AccumulatorFulfillmentService (end-to-end with proofs) ─

  describe('AccumulatorFulfillmentService — end-to-end', () => {

    beforeAll(async () => {
      // Should already be compiled from the AccumulatorFulfillmentProgram describe block
      // Compile again in case tests run in isolation
      await AccumulatorFulfillmentProgram.compile();
    }, 180_000);

    it('submit with accumulator → both credentials updated', async () => {
      const accumulator = createTestAccumulator({
        deductibleAmount: 50000,
        deductiblePaid: 50000, // met → normal copay
      });
      const scenario = setupDualCredentialScenario(accumulator);
      const formularyRegistry = createTestFormularyRegistry();

      const service = new AccumulatorFulfillmentService(
        new InMemoryStore(),
        scenario.registry,
        formularyRegistry,
      );

      const fulfillment = createTestFulfillmentData(scenario.rxData.commitment());

      const result = await service.submitFulfillmentWithAccumulator(
        pharmacyWalletId,
        memberWalletId,
        scenario.prescriptionCredential,
        scenario.eligibilityCredential,
        scenario.rxData,
        scenario.filledStatus,
        fulfillment,
        scenario.prescriptionForest,
        scenario.eligibilityForest,
        0n,  // rxLeafIndex
        1n,  // latestStatusIndex (FILLED at index 1)
        0n,  // formularyEntryIndex
        accumulator,
        ACCUMULATOR_LEAF_INDEX,
        scenario.pharmacyInventory,
        scenario.memberInventory,
        scenario.prescriptionCredentialSlot,
        scenario.eligibilityCredentialSlot,
        [PHARM_QUAL, PHARM_ID_HASH, PHARM_EK_HASH],
      );

      // Normal copay: patientPay=1000, planPay=4500
      expect(result.patientPayCents.toString()).toBe('1000');
      expect(result.planPayCents.toString()).toBe('4500');

      // Both credentials updated
      expect(result.newPrescriptionCredentialData.forestRoot.toString())
        .not.toBe(scenario.prescriptionCredential.forestRoot.toString());
      expect(result.newEligibilityCredentialData.forestRoot.toString())
        .not.toBe(scenario.eligibilityCredential.forestRoot.toString());

      // Accumulator updated (C4 fix): deductiblePaid unchanged because deductible was already met
      // (deductibleCredit=0), oopPaid increased by patientPay (1000), benefitUsed by planPay (4500)
      expect(result.newAccumulatorData.deductiblePaidCents.toString()).toBe('50000');
      expect(result.newAccumulatorData.oopPaidCents.toString()).toBe('1000');
      expect(result.newAccumulatorData.annualBenefitUsedCents.toString()).toBe('4500');

      // Fulfillment index
      expect(result.fulfillmentIndex).toBe(2n);
    }, 120_000);

    it('submit + reverse → accumulator restored', async () => {
      const accumulator = createTestAccumulator({
        deductibleAmount: 50000,
        deductiblePaid: 50000,
      });
      const scenario = setupDualCredentialScenario(accumulator);
      const formularyRegistry = createTestFormularyRegistry();

      const service = new AccumulatorFulfillmentService(
        new InMemoryStore(),
        scenario.registry,
        formularyRegistry,
      );

      const fulfillment = createTestFulfillmentData(scenario.rxData.commitment());

      // Step 1: Submit
      const fulfillResult = await service.submitFulfillmentWithAccumulator(
        pharmacyWalletId,
        memberWalletId,
        scenario.prescriptionCredential,
        scenario.eligibilityCredential,
        scenario.rxData,
        scenario.filledStatus,
        fulfillment,
        scenario.prescriptionForest,
        scenario.eligibilityForest,
        0n,
        1n,
        0n,
        accumulator,
        ACCUMULATOR_LEAF_INDEX,
        scenario.pharmacyInventory,
        scenario.memberInventory,
        scenario.prescriptionCredentialSlot,
        scenario.eligibilityCredentialSlot,
        [PHARM_QUAL, PHARM_ID_HASH, PHARM_EK_HASH],
      );

      // Step 2: Reverse
      const reversalData = new ReversalData({
        fulfillmentHash: fulfillment.commitment(),
        pharmacyWalletId,
        patientRefundCents: fulfillResult.patientPayCents,
        planRefundCents: fulfillResult.planPayCents,
        reversalDate: dateToField('20260301'),
        reasonCodeHash: Field(0),
        reversedByWalletId: pharmacyWalletId,
      });

      const reversalResult = await service.reverseFulfillmentWithAccumulator(
        pharmacyWalletId,
        memberWalletId,
        fulfillResult.newPrescriptionCredentialData,
        fulfillResult.newEligibilityCredentialData,
        scenario.rxData,
        fulfillment,
        reversalData,
        scenario.prescriptionForest,
        scenario.eligibilityForest,
        0n,  // rxLeafIndex
        2n,  // originalFulfillmentIndex
        fulfillResult.patientPayCents,
        fulfillResult.planPayCents,
        fulfillResult.deductibleCreditCents,
        fulfillResult.newAccumulatorData,
        ACCUMULATOR_LEAF_INDEX,
        scenario.pharmacyInventory,
        scenario.memberInventory,
        scenario.prescriptionCredentialSlot,
        scenario.eligibilityCredentialSlot,
        [PHARM_QUAL, PHARM_ID_HASH, PHARM_EK_HASH],
      );

      // Refund amounts match original
      expect(reversalResult.patientRefundCents.toString()).toBe('1000');
      expect(reversalResult.planRefundCents.toString()).toBe('4500');

      // Accumulator restored to original values
      expect(reversalResult.newAccumulatorData.deductiblePaidCents.toString())
        .toBe(accumulator.deductiblePaidCents.toString());
      expect(reversalResult.newAccumulatorData.oopPaidCents.toString())
        .toBe(accumulator.oopPaidCents.toString());
      expect(reversalResult.newAccumulatorData.annualBenefitUsedCents.toString())
        .toBe(accumulator.annualBenefitUsedCents.toString());

      // Reversal at index 3
      expect(reversalResult.reversalIndex).toBe(3n);
    }, 120_000);
  });

  // ── AccumulatorQueryService (fast — no ZkProgram) ──────

  describe('AccumulatorQueryService', () => {

    describe('getStatus', () => {
      test('returns correct values for fresh accumulator (no spending)', () => {
        const acc = createTestAccumulator({
          deductibleAmount: 50000, // $500
          oopMax: 500000,         // $5,000
          benefitMax: 10000000,   // $100,000
        });
        const status = AccumulatorQueryService.getStatus(acc);

        expect(status.planYear).toBe('20260101');
        expect(status.deductibleAmountCents).toBe(50000);
        expect(status.deductiblePaidCents).toBe(0);
        expect(status.deductibleRemainingCents).toBe(50000);
        expect(status.isDeductibleMet).toBe(false);
        expect(status.oopMaxCents).toBe(500000);
        expect(status.oopPaidCents).toBe(0);
        expect(status.oopRemainingCents).toBe(500000);
        expect(status.isOopMaxMet).toBe(false);
        expect(status.annualBenefitMaxCents).toBe(10000000);
        expect(status.annualBenefitUsedCents).toBe(0);
        expect(status.benefitRemainingCents).toBe(10000000);
        expect(status.isBenefitExhausted).toBe(false);
      });

      test('deductible met flag triggers when paid >= amount', () => {
        const acc = createTestAccumulator({
          deductibleAmount: 50000,
          deductiblePaid: 50000,
        });
        const status = AccumulatorQueryService.getStatus(acc);

        expect(status.isDeductibleMet).toBe(true);
        expect(status.deductibleRemainingCents).toBe(0);
      });

      test('OOPM met flag triggers when paid >= max', () => {
        const acc = createTestAccumulator({
          oopMax: 500000,
          oopPaid: 500000,
        });
        const status = AccumulatorQueryService.getStatus(acc);

        expect(status.isOopMaxMet).toBe(true);
        expect(status.oopRemainingCents).toBe(0);
      });

      test('benefit exhausted flag triggers when used >= max', () => {
        const acc = createTestAccumulator({
          benefitMax: 100000,
          benefitUsed: 100000,
        });
        const status = AccumulatorQueryService.getStatus(acc);

        expect(status.isBenefitExhausted).toBe(true);
        expect(status.benefitRemainingCents).toBe(0);
      });

      test('zero limits mean no accumulators (flags stay false)', () => {
        const acc = createTestAccumulator(); // all zeros
        const status = AccumulatorQueryService.getStatus(acc);

        expect(status.isDeductibleMet).toBe(false);
        expect(status.isOopMaxMet).toBe(false);
        expect(status.isBenefitExhausted).toBe(false);
      });

      test('partial spending shows correct remaining', () => {
        const acc = createTestAccumulator({
          deductibleAmount: 50000,
          deductiblePaid: 20000,
          oopMax: 500000,
          oopPaid: 150000,
          benefitMax: 10000000,
          benefitUsed: 3000000,
        });
        const status = AccumulatorQueryService.getStatus(acc);

        expect(status.deductibleRemainingCents).toBe(30000);
        expect(status.oopRemainingCents).toBe(350000);
        expect(status.benefitRemainingCents).toBe(7000000);
      });
    });

    describe('verifyInForest', () => {
      test('returns true when accumulator matches forest leaf', () => {
        const acc = createTestAccumulator({ deductibleAmount: 50000 });
        const forest = new MerkleForest();
        forest.setLeaf(
          ForestDomain.ACCESS_CONTROL,
          ACCUMULATOR_LEAF_INDEX,
          acc.commitment(),
        );

        expect(AccumulatorQueryService.verifyInForest(forest, acc)).toBe(true);
      });

      test('returns false when accumulator does not match forest', () => {
        const acc = createTestAccumulator({ deductibleAmount: 50000 });
        const differentAcc = createTestAccumulator({ deductibleAmount: 99999 });
        const forest = new MerkleForest();
        forest.setLeaf(
          ForestDomain.ACCESS_CONTROL,
          ACCUMULATOR_LEAF_INDEX,
          differentAcc.commitment(),
        );

        expect(AccumulatorQueryService.verifyInForest(forest, acc)).toBe(false);
      });

      test('returns false on empty forest (leaf is zero)', () => {
        const acc = createTestAccumulator({ deductibleAmount: 50000 });
        const forest = new MerkleForest();

        expect(AccumulatorQueryService.verifyInForest(forest, acc)).toBe(false);
      });
    });

    describe('estimatePatientCost', () => {
      test('OOPM met → patient pays $0', () => {
        const acc = createTestAccumulator({
          oopMax: 500000,
          oopPaid: 500000,
        });
        const { patientPayCents, planPayCents } =
          AccumulatorQueryService.estimatePatientCost(acc, 5500, 1000);

        expect(patientPayCents).toBe(0);
        expect(planPayCents).toBe(5500);
      });

      test('benefit exhausted → patient pays 100%', () => {
        const acc = createTestAccumulator({
          benefitMax: 100000,
          benefitUsed: 100000,
        });
        const { patientPayCents, planPayCents } =
          AccumulatorQueryService.estimatePatientCost(acc, 5500, 1000);

        expect(patientPayCents).toBe(5500);
        expect(planPayCents).toBe(0);
      });

      test('OOPM met overrides benefit exhausted (patient pays $0)', () => {
        const acc = createTestAccumulator({
          oopMax: 500000,
          oopPaid: 500000,
          benefitMax: 100000,
          benefitUsed: 100000,
        });
        const { patientPayCents, planPayCents } =
          AccumulatorQueryService.estimatePatientCost(acc, 5500, 1000);

        expect(patientPayCents).toBe(0);
        expect(planPayCents).toBe(5500);
      });

      test('deductible phase → patient pays toward remaining deductible', () => {
        const acc = createTestAccumulator({
          deductibleAmount: 50000,
          deductiblePaid: 0,
        });
        const { patientPayCents, planPayCents } =
          AccumulatorQueryService.estimatePatientCost(acc, 5500, 1000);

        // $55 total < $500 remaining deductible → patient pays $55
        expect(patientPayCents).toBe(5500);
        expect(planPayCents).toBe(0);
      });

      test('deductible almost met → patient pays remaining deductible + copay on excess (C5 fix)', () => {
        const acc = createTestAccumulator({
          deductibleAmount: 50000,
          deductiblePaid: 48000, // $20 remaining
        });
        const { patientPayCents, planPayCents } =
          AccumulatorQueryService.estimatePatientCost(acc, 5500, 1000);

        // remaining = 2000; deductiblePay = min(5500, 2000) = 2000
        // afterDeductible = 3500; copayOnRemainder = min(3500, 1000) = 1000
        // basePay = 2000 + 1000 = 3000
        expect(patientPayCents).toBe(3000);
        expect(planPayCents).toBe(2500);
      });

      test('deductible met → normal copay', () => {
        const acc = createTestAccumulator({
          deductibleAmount: 50000,
          deductiblePaid: 50000,
        });
        const { patientPayCents, planPayCents } =
          AccumulatorQueryService.estimatePatientCost(acc, 5500, 1000);

        expect(patientPayCents).toBe(1000);
        expect(planPayCents).toBe(4500);
      });

      test('no accumulators → normal copay', () => {
        const acc = createTestAccumulator(); // all zeros
        const { patientPayCents, planPayCents } =
          AccumulatorQueryService.estimatePatientCost(acc, 5500, 1000);

        expect(patientPayCents).toBe(1000);
        expect(planPayCents).toBe(4500);
      });

      test('copay exceeds total → patient pays total', () => {
        const acc = createTestAccumulator();
        const { patientPayCents, planPayCents } =
          AccumulatorQueryService.estimatePatientCost(acc, 500, 1000);

        expect(patientPayCents).toBe(500);
        expect(planPayCents).toBe(0);
      });
    });
  });

  // ── BenefitCheckService (fast — no ZkProgram) ─────────

  describe('BenefitCheckService', () => {

    function setupBenefitCheck(accumulator: AccumulatorData) {
      const forest = new MerkleForest();
      forest.setLeaf(
        ForestDomain.ACCESS_CONTROL,
        ACCUMULATOR_LEAF_INDEX,
        accumulator.commitment(),
      );

      const credential = new CredentialData({
        credentialType: CREDENTIAL_TYPE_ELIGIBILITY,
        forestRoot: forest.getForestRoot(),
        issuerWalletId: Field(100200300400500600n),
        subjectWalletId: memberWalletId,
        issuedAt: dateToField('20260101'),
        expiresAt: dateToField('20261231'),
        revoked: Field(0),
      });

      const formularyRegistry = createTestFormularyRegistry();

      return { credential, forest, formularyRegistry };
    }

    describe('lookupFormulary', () => {
      test('finds a covered medication by NDC hash', () => {
        const registry = createTestFormularyRegistry();
        const result = BenefitCheckService.lookupFormulary(ndcHash, registry);

        expect(result.covered).toBe(true);
        expect(result.tierLevel).toBe(1);
        expect(result.tierLabel).toBe('Generic');
        expect(result.copayCents).toBe(1000);
        expect(result.requiresPriorAuth).toBe(false);
        expect(result.formularyIndex).toBe(0n);
      });

      test('returns not-covered for unknown NDC', () => {
        const registry = createTestFormularyRegistry();
        const unknownNdc = hashString('99999999999');
        const result = BenefitCheckService.lookupFormulary(unknownNdc, registry);

        expect(result.covered).toBe(false);
        expect(result.tierLabel).toBe('Not Covered');
        expect(result.copayCents).toBe(0);
      });
    });

    describe('determineCostPhase', () => {
      test('deductible phase when deductible not met', () => {
        const acc = createTestAccumulator({ deductibleAmount: 50000 });
        const status = AccumulatorQueryService.getStatus(acc);
        expect(BenefitCheckService.determineCostPhase(status)).toBe('deductible');
      });

      test('copay phase when no accumulators', () => {
        const acc = createTestAccumulator();
        const status = AccumulatorQueryService.getStatus(acc);
        expect(BenefitCheckService.determineCostPhase(status)).toBe('copay');
      });

      test('copay phase when deductible met', () => {
        const acc = createTestAccumulator({ deductibleAmount: 50000, deductiblePaid: 50000 });
        const status = AccumulatorQueryService.getStatus(acc);
        expect(BenefitCheckService.determineCostPhase(status)).toBe('copay');
      });

      test('oop-max-met phase', () => {
        const acc = createTestAccumulator({ oopMax: 500000, oopPaid: 500000 });
        const status = AccumulatorQueryService.getStatus(acc);
        expect(BenefitCheckService.determineCostPhase(status)).toBe('oop-max-met');
      });

      test('benefit-exhausted phase', () => {
        const acc = createTestAccumulator({ benefitMax: 100000, benefitUsed: 100000 });
        const status = AccumulatorQueryService.getStatus(acc);
        expect(BenefitCheckService.determineCostPhase(status)).toBe('benefit-exhausted');
      });

      test('oop-max-met overrides benefit-exhausted', () => {
        const acc = createTestAccumulator({
          oopMax: 500000, oopPaid: 500000,
          benefitMax: 100000, benefitUsed: 100000,
        });
        const status = AccumulatorQueryService.getStatus(acc);
        expect(BenefitCheckService.determineCostPhase(status)).toBe('oop-max-met');
      });
    });

    describe('checkBenefit', () => {
      test('full benefit check — covered medication, copay phase', () => {
        const acc = createTestAccumulator(); // no accumulators
        const { credential, forest, formularyRegistry } = setupBenefitCheck(acc);

        const result = BenefitCheckService.checkBenefit(
          ndcHash, 5500, credential, forest, acc, formularyRegistry,
        );

        expect(result.formulary.covered).toBe(true);
        expect(result.formulary.tierLabel).toBe('Generic');
        expect(result.costPhase).toBe('copay');
        expect(result.estimatedPatientPayCents).toBe(1000); // $10 copay
        expect(result.estimatedPlanPayCents).toBe(4500);
        expect(result.totalCostCents).toBe(5500);
        expect(result.verification.credentialActive).toBe(true);
        expect(result.verification.accumulatorVerified).toBe(true);
        expect(result.verification.formularyVerified).toBe(true);
      });

      test('deductible phase — patient pays toward deductible', () => {
        const acc = createTestAccumulator({
          deductibleAmount: 50000,
          deductiblePaid: 0,
        });
        const { credential, forest, formularyRegistry } = setupBenefitCheck(acc);

        const result = BenefitCheckService.checkBenefit(
          ndcHash, 5500, credential, forest, acc, formularyRegistry,
        );

        expect(result.costPhase).toBe('deductible');
        expect(result.estimatedPatientPayCents).toBe(5500); // total < deductible remaining
        expect(result.estimatedPlanPayCents).toBe(0);
        expect(result.accumulator.deductibleRemainingCents).toBe(50000);
      });

      test('OOPM met — patient pays $0', () => {
        const acc = createTestAccumulator({
          oopMax: 500000,
          oopPaid: 500000,
        });
        const { credential, forest, formularyRegistry } = setupBenefitCheck(acc);

        const result = BenefitCheckService.checkBenefit(
          ndcHash, 5500, credential, forest, acc, formularyRegistry,
        );

        expect(result.costPhase).toBe('oop-max-met');
        expect(result.estimatedPatientPayCents).toBe(0);
        expect(result.estimatedPlanPayCents).toBe(5500);
      });

      test('not-covered medication — patient pays 100%', () => {
        const acc = createTestAccumulator();
        const { credential, forest, formularyRegistry } = setupBenefitCheck(acc);
        const unknownNdc = hashString('99999999999');

        const result = BenefitCheckService.checkBenefit(
          unknownNdc, 5500, credential, forest, acc, formularyRegistry,
        );

        expect(result.formulary.covered).toBe(false);
        expect(result.estimatedPatientPayCents).toBe(5500);
        expect(result.estimatedPlanPayCents).toBe(0);
      });

      test('revoked credential is flagged as inactive', () => {
        const acc = createTestAccumulator();
        const forest = new MerkleForest();
        forest.setLeaf(
          ForestDomain.ACCESS_CONTROL,
          ACCUMULATOR_LEAF_INDEX,
          acc.commitment(),
        );

        const revokedCredential = new CredentialData({
          credentialType: CREDENTIAL_TYPE_ELIGIBILITY,
          forestRoot: forest.getForestRoot(),
          issuerWalletId: Field(100200300400500600n),
          subjectWalletId: memberWalletId,
          issuedAt: dateToField('20260101'),
          expiresAt: dateToField('20261231'),
          revoked: Field(1), // revoked!
        });

        const registry = createTestFormularyRegistry();
        const result = BenefitCheckService.checkBenefit(
          ndcHash, 5500, revokedCredential, forest, acc, registry,
        );

        expect(result.verification.credentialActive).toBe(false);
      });

      test('mismatched accumulator fails verification', () => {
        const acc = createTestAccumulator({ deductibleAmount: 50000 });
        const wrongAcc = createTestAccumulator({ deductibleAmount: 99999 });
        const { credential, forest, formularyRegistry } = setupBenefitCheck(acc);

        // Pass wrong accumulator data — doesn't match forest
        const result = BenefitCheckService.checkBenefit(
          ndcHash, 5500, credential, forest, wrongAcc, formularyRegistry,
        );

        expect(result.verification.accumulatorVerified).toBe(false);
        // Still returns an estimate (best-effort), but caller knows it's unverified
        expect(result.estimatedPatientPayCents).toBeGreaterThan(0);
      });
    });
  });
});
