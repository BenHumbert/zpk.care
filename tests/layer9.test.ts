import { Field, Poseidon } from 'o1js';
import { DOMAIN_TAG_PHARMACY } from '../src/wallets/wallet-derivation.js';
import {
  FulfillmentData,
  buildFulfillmentData,
  ReversalData,
  buildReversalData,
} from '../src/fulfillment/fulfillment-data.js';
import type {
  FulfillmentLocalData,
  ReversalLocalData,
} from '../src/fulfillment/fulfillment-data.js';
import {
  FulfillmentProgram,
  FulfillmentOutput,
  FulfillmentProof,
  FULFILL_OP_CLAIM,
  FULFILL_OP_REVERSAL,
} from '../src/fulfillment/fulfillment-program.js';
import { FulfillmentService } from '../src/fulfillment/fulfillment-service.js';
import { FulfillmentVerificationService } from '../src/fulfillment/fulfillment-verification-service.js';
import {
  PrescriptionData,
  PrescriptionStatusData,
  RX_STATUS_ADJUDICATED,
  RX_STATUS_FILLED,
  RX_STATUS_PARTIALLY_FILLED,
} from '../src/prescription/prescription-data.js';
import { PrescriptionService } from '../src/prescription/prescription-service.js';
import { CredentialData, CREDENTIAL_TYPE_PRESCRIPTION } from '../src/credentials/credential-data.js';
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
  WALLET_TREE_HEIGHT,
} from '../src/wallets/wallet-state.js';
import { EMPTY_CREDENTIAL_ROOT } from '../src/engine/state-transition.js';
import { MerkleTree } from 'o1js';

// ─── Test Data ──────────────────────────────────────────────

// Pharmacy wallet preimage Fields (H2 fix)
const PHARM_QUAL = Field(2);
const PHARM_ID_HASH = Field(555);
const PHARM_EK_HASH = Field(666);
const pharmacyWalletId = Poseidon.hash([DOMAIN_TAG_PHARMACY, PHARM_QUAL, PHARM_ID_HASH, PHARM_EK_HASH]);
const prescriberWalletId = Field(111222333444555666n);
const memberWalletId = Field(999888777666555444n);
const adminWalletId = Field(100200300400500600n);

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
    maxQuantityPerFill: quantityToField(90), // max 90 units
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
    ingredientCostCents: centsToField(5000),  // $50.00 ingredient cost
    dispensingFeeCents: centsToField(500),     // $5.00 dispensing fee
    dateOfService: dateToField('20260215'),
  });
}

/** Compute settlement commitment matching what the ZK circuit stores in the TRANSACTION tree. */
function computeSettlementCommitment(
  fulfillment: FulfillmentData,
  patientPayCents: Field,
  planPayCents: Field,
): Field {
  return Poseidon.hash([fulfillment.commitment(), patientPayCents, planPayCents]);
}

function createTestWalletRegistry(): {
  registry: WalletRegistry;
  lifecycleTree: MerkleTree;
} {
  const registry = new WalletRegistry();
  const lifecycleTree = new MerkleTree(WALLET_TREE_HEIGHT);
  registry.register(
    pharmacyWalletId,
    new WalletState({
      walletId: pharmacyWalletId,
      credentialInventoryRoot: EMPTY_CREDENTIAL_ROOT,
      nonce: Field(0),
    }),
  );
  return { registry, lifecycleTree };
}

/** Set up a prescription credential that's been FILLED (ready for claim) */
function setupFilledPrescription(): {
  rxData: PrescriptionData;
  credentialData: CredentialData;
  forest: MerkleForest;
  filledStatus: PrescriptionStatusData;
  inventory: CredentialInventory;
  credentialSlotIndex: bigint;
  registry: WalletRegistry;
} {
  const rxData = createTestPrescriptionData();
  const forest = new MerkleForest();
  const inventory = new CredentialInventory();

  // Insert prescription into MEDICATION tree
  forest.setLeaf(ForestDomain.MEDICATION, 0n, rxData.commitment());

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
  forest.setLeaf(ForestDomain.TRANSACTION, 0n, activeStatus.commitment());

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
  forest.setLeaf(ForestDomain.TRANSACTION, 1n, filledStatus.commitment());

  // Build credential
  const credentialData = new CredentialData({
    credentialType: CREDENTIAL_TYPE_PRESCRIPTION,
    forestRoot: forest.getForestRoot(),
    issuerWalletId: prescriberWalletId,
    subjectWalletId: pharmacyWalletId,
    issuedAt: dateToField('20260201'),
    expiresAt: dateToField('20270201'),
    revoked: Field(0),
  });

  // Mint into inventory
  const { index: credentialSlotIndex } = inventory.mint(credentialData);

  // Register pharmacy
  const { registry } = createTestWalletRegistry();

  return { rxData, credentialData, forest, filledStatus, inventory, credentialSlotIndex, registry };
}

// ─── Tests ──────────────────────────────────────────────────

describe('Layer 9 — Fulfillment (Use Cases E + F)', () => {

  // ── FulfillmentData Model ─────────────────────────────────

  describe('FulfillmentData Model', () => {
    it('commitment is deterministic', () => {
      const rxHash = createTestPrescriptionData().commitment();
      const f1 = createTestFulfillmentData(rxHash);
      const f2 = createTestFulfillmentData(rxHash);
      expect(f1.commitment().toString()).toBe(f2.commitment().toString());
    });

    it('commitment changes when any field changes', () => {
      const rxHash = createTestPrescriptionData().commitment();
      const f1 = createTestFulfillmentData(rxHash);
      const base = f1.commitment().toString();

      const f2 = new FulfillmentData({
        prescriptionHash: rxHash,
        pharmacyWalletId,
        ndcHash,
        quantityDispensed: quantityToField(60), // changed
        ingredientCostCents: centsToField(5000),
        dispensingFeeCents: centsToField(500),
        dateOfService: dateToField('20260215'),
      });
      expect(f2.commitment().toString()).not.toBe(base);
    });

    it('buildFulfillmentData from local data', () => {
      const local: FulfillmentLocalData = {
        prescriptionHash: '12345',
        pharmacyWalletId: '777666555444333222',
        ndcCode: '00071015523',
        quantityDispensed: 30,
        ingredientCostCents: 5000,
        dispensingFeeCents: 500,
        dateOfService: '20260215',
      };
      const f = buildFulfillmentData(local);
      expect(f.ndcHash.toString()).toBe(hashString('00071015523').toString());
      expect(f.ingredientCostCents.toString()).toBe('5000');
      expect(f.dispensingFeeCents.toString()).toBe('500');
    });

    it('totalCostCents calculates correctly', () => {
      const rxHash = createTestPrescriptionData().commitment();
      const f = createTestFulfillmentData(rxHash);
      // $50 + $5 = $55 = 5500 cents
      expect(f.totalCostCents().toString()).toBe('5500');
    });
  });

  // ── ReversalData Model ────────────────────────────────────

  describe('ReversalData Model', () => {
    it('commitment is deterministic', () => {
      const fulfillHash = Field(99999n);
      const r1 = new ReversalData({
        fulfillmentHash: fulfillHash,
        pharmacyWalletId,
        patientRefundCents: centsToField(1000),
        planRefundCents: centsToField(4500),
        reversalDate: dateToField('20260301'),
        reasonCodeHash: Field(0),
        reversedByWalletId: pharmacyWalletId,
      });
      const r2 = new ReversalData({
        fulfillmentHash: fulfillHash,
        pharmacyWalletId,
        patientRefundCents: centsToField(1000),
        planRefundCents: centsToField(4500),
        reversalDate: dateToField('20260301'),
        reasonCodeHash: Field(0),
        reversedByWalletId: pharmacyWalletId,
      });
      expect(r1.commitment().toString()).toBe(r2.commitment().toString());
    });

    it('commitment changes when any field changes', () => {
      const fulfillHash = Field(99999n);
      const r1 = new ReversalData({
        fulfillmentHash: fulfillHash,
        pharmacyWalletId,
        patientRefundCents: centsToField(1000),
        planRefundCents: centsToField(4500),
        reversalDate: dateToField('20260301'),
        reasonCodeHash: Field(0),
        reversedByWalletId: pharmacyWalletId,
      });
      const base = r1.commitment().toString();

      const r2 = new ReversalData({
        fulfillmentHash: fulfillHash,
        pharmacyWalletId,
        patientRefundCents: centsToField(2000), // changed
        planRefundCents: centsToField(4500),
        reversalDate: dateToField('20260301'),
        reasonCodeHash: Field(0),
        reversedByWalletId: pharmacyWalletId,
      });
      expect(r2.commitment().toString()).not.toBe(base);
    });

    it('buildReversalData from local data', () => {
      const local: ReversalLocalData = {
        fulfillmentHash: '99999',
        pharmacyWalletId: '777666555444333222',
        patientRefundCents: 1000,
        planRefundCents: 4500,
        reversalDate: '20260301',
        reason: 'Wrong medication',
        reversedByWalletId: '777666555444333222',
      };
      const r = buildReversalData(local);
      expect(r.patientRefundCents.toString()).toBe('1000');
      expect(r.planRefundCents.toString()).toBe('4500');
      expect(r.reasonCodeHash.toString()).toBe(hashString('Wrong medication').toString());
    });
  });

  // ── FulfillmentService — calculateAmounts ─────────────────

  describe('FulfillmentService — calculateAmounts', () => {
    let service: FulfillmentService;

    beforeEach(() => {
      const { registry } = createTestWalletRegistry();
      const formularyRegistry = createTestFormularyRegistry();
      service = new FulfillmentService(
        new InMemoryStore(),
        registry,
        formularyRegistry,
      );
    });

    it('copay matches formulary for generic tier', () => {
      const rxHash = createTestPrescriptionData().commitment();
      const fulfillment = createTestFulfillmentData(rxHash);
      const formulary = createTestFormularyEntry();

      const { patientPayCents, planPayCents } = service.calculateAmounts(
        fulfillment,
        formulary,
      );

      // copay = $10 (1000 cents), total = $55 (5500 cents)
      // patientPay = 1000, planPay = 5500 - 1000 = 4500
      expect(patientPayCents.toString()).toBe('1000');
      expect(planPayCents.toString()).toBe('4500');
    });

    it('plan pays remainder after copay', () => {
      const rxHash = createTestPrescriptionData().commitment();
      const fulfillment = new FulfillmentData({
        prescriptionHash: rxHash,
        pharmacyWalletId,
        ndcHash,
        quantityDispensed: quantityToField(30),
        ingredientCostCents: centsToField(10000), // $100
        dispensingFeeCents: centsToField(1500),    // $15
        dateOfService: dateToField('20260215'),
      });
      const formulary = createTestFormularyEntry(); // copay = $10

      const { patientPayCents, planPayCents } = service.calculateAmounts(
        fulfillment,
        formulary,
      );

      // total = 11500, copay = 1000
      // patientPay = 1000, planPay = 10500
      expect(patientPayCents.toString()).toBe('1000');
      expect(planPayCents.toString()).toBe('10500');
    });

    it('member pays all when total claim < copay', () => {
      const rxHash = createTestPrescriptionData().commitment();
      const fulfillment = new FulfillmentData({
        prescriptionHash: rxHash,
        pharmacyWalletId,
        ndcHash,
        quantityDispensed: quantityToField(5),
        ingredientCostCents: centsToField(300),  // $3
        dispensingFeeCents: centsToField(200),    // $2
        dateOfService: dateToField('20260215'),
      });
      const formulary = createTestFormularyEntry(); // copay = $10

      const { patientPayCents, planPayCents } = service.calculateAmounts(
        fulfillment,
        formulary,
      );

      // total = 500, copay = 1000. total < copay
      // patientPay = 500 (total), planPay = 0
      expect(patientPayCents.toString()).toBe('500');
      expect(planPayCents.toString()).toBe('0');
    });
  });

  // ── FulfillmentService — submitFulfillment (fast) ─────────

  describe('FulfillmentService — submitFulfillment (off-chain validation)', () => {
    it('rejects fulfillment for non-filled prescription', async () => {
      const { registry } = createTestWalletRegistry();
      const formularyRegistry = createTestFormularyRegistry();
      const service = new FulfillmentService(
        new InMemoryStore(),
        registry,
        formularyRegistry,
      );

      const rxData = createTestPrescriptionData();
      const forest = new MerkleForest();
      forest.setLeaf(ForestDomain.MEDICATION, 0n, rxData.commitment());

      // Only ACTIVE status (not filled yet)
      const activeStatus = new PrescriptionStatusData({
        prescriptionHash: rxData.commitment(),
        status: RX_STATUS_ADJUDICATED,
        updatedByWalletId: prescriberWalletId,
        updatedAt: dateToField('20260201'),
        pharmacyWalletId,
        fillQuantity: Field(0),
        notesHash: Field(0),
      });
      forest.setLeaf(ForestDomain.TRANSACTION, 0n, activeStatus.commitment());

      const credentialData = new CredentialData({
        credentialType: CREDENTIAL_TYPE_PRESCRIPTION,
        forestRoot: forest.getForestRoot(),
        issuerWalletId: prescriberWalletId,
        subjectWalletId: pharmacyWalletId,
        issuedAt: dateToField('20260201'),
        expiresAt: dateToField('20270201'),
        revoked: Field(0),
      });

      const inventory = new CredentialInventory();
      const { index: credentialSlotIndex } = inventory.mint(credentialData);

      const fulfillment = createTestFulfillmentData(rxData.commitment());

      await expect(
        service.submitFulfillment(
          pharmacyWalletId,
          credentialData,
          rxData,
          activeStatus,
          fulfillment,
          forest,
          0n,
          0n,
          0n,
          inventory,
          credentialSlotIndex,
        ),
      ).rejects.toThrow('FILLED or PARTIALLY_FILLED');
    });
  });

  // ── FulfillmentVerificationService (fast) ─────────────────

  describe('FulfillmentVerificationService', () => {
    let verificationService: FulfillmentVerificationService;

    beforeEach(() => {
      verificationService = new FulfillmentVerificationService();
    });

    it('verifyAmountBalance accepts balanced amounts', () => {
      const rxHash = createTestPrescriptionData().commitment();
      const fulfillment = createTestFulfillmentData(rxHash);
      const formulary = createTestFormularyEntry();

      const result = verificationService.verifyAmountBalance(fulfillment, formulary);
      expect(result).toBe(true);
    });

    it('verifyAmountBalance accepts when total < copay', () => {
      const rxHash = createTestPrescriptionData().commitment();
      const fulfillment = new FulfillmentData({
        prescriptionHash: rxHash,
        pharmacyWalletId,
        ndcHash,
        quantityDispensed: quantityToField(5),
        ingredientCostCents: centsToField(300),
        dispensingFeeCents: centsToField(200),
        dateOfService: dateToField('20260215'),
      });
      const formulary = createTestFormularyEntry(); // copay $10

      const result = verificationService.verifyAmountBalance(fulfillment, formulary);
      expect(result).toBe(true);
    });

    it('extractClaimHistory returns fulfillment entries', () => {
      const rxData = createTestPrescriptionData();
      const forest = new MerkleForest();

      const fulfillment = createTestFulfillmentData(rxData.commitment());
      // Settlement commitment: copay=1000, total=5500 → patientPay=1000, planPay=4500
      const settlementLeaf = computeSettlementCommitment(
        fulfillment, centsToField(1000), centsToField(4500),
      );
      // Put fulfillment at index 2 (after ACTIVE at 0, FILLED at 1)
      forest.setLeaf(ForestDomain.TRANSACTION, 2n, settlementLeaf);

      const history = verificationService.extractClaimHistory(
        forest,
        2,
        [fulfillment],
        [settlementLeaf],
      );

      expect(history).toHaveLength(1);
      expect(history[0]!.type).toBe('fulfillment');
      expect(history[0]!.index).toBe(2);
    });

    it('extractClaimHistory returns fulfillment + reversal entries', () => {
      const rxData = createTestPrescriptionData();
      const fulfillment = createTestFulfillmentData(rxData.commitment());
      const reversal = new ReversalData({
        fulfillmentHash: fulfillment.commitment(),
        pharmacyWalletId,
        patientRefundCents: centsToField(1000),
        planRefundCents: centsToField(4500),
        reversalDate: dateToField('20260301'),
        reasonCodeHash: Field(0),
        reversedByWalletId: pharmacyWalletId,
      });

      const settlementLeaf = computeSettlementCommitment(
        fulfillment, centsToField(1000), centsToField(4500),
      );
      const forest = new MerkleForest();
      forest.setLeaf(ForestDomain.TRANSACTION, 2n, settlementLeaf);
      forest.setLeaf(ForestDomain.TRANSACTION, 3n, reversal.commitment());

      const history = verificationService.extractClaimHistory(
        forest,
        2,
        [fulfillment, reversal],
        [settlementLeaf, reversal.commitment()],
      );

      expect(history).toHaveLength(2);
      expect(history[0]!.type).toBe('fulfillment');
      expect(history[1]!.type).toBe('reversal');
    });
  });

  // ── FulfillmentProgram (slow — requires compile) ──────────

  describe('FulfillmentProgram', () => {
    let compiled = false;

    beforeAll(async () => {
      await FulfillmentProgram.compile();
      compiled = true;
    }, 180_000);

    describe('proveFulfillment', () => {
      it('valid fulfillment generates proof with correct amounts', async () => {
        const { rxData, credentialData, forest, filledStatus } = setupFilledPrescription();

        const fulfillment = createTestFulfillmentData(rxData.commitment());
        const formularyRegistry = createTestFormularyRegistry();
        const formularyEntry = formularyRegistry.getEntry(0n)!;
        const formularyWitness = formularyRegistry.getEntryWitness(0n);
        const formularyRoot = formularyRegistry.getRoot();

        const forestRoots = ForestRoots.fromForest(forest);
        const medicationWitness = forest.getWitness(ForestDomain.MEDICATION, 0n);
        const statusWitness = forest.getWitness(ForestDomain.TRANSACTION, 1n);
        const newSlotWitness = forest.getWitness(ForestDomain.TRANSACTION, 2n);

        const result = await FulfillmentProgram.proveFulfillment(
          credentialData,
          rxData,
          filledStatus,
          fulfillment,
          formularyEntry,
          forestRoots,
          medicationWitness,
          statusWitness,
          newSlotWitness,
          formularyWitness,
          formularyRoot,
          PHARM_QUAL,
          PHARM_ID_HASH,
          PHARM_EK_HASH,
        );

        const output = result.proof.publicOutput;
        expect(output.operationType.toString()).toBe(FULFILL_OP_CLAIM.toString());
        expect(output.prescriptionHash.toString()).toBe(rxData.commitment().toString());

        // total = 5500, copay = 1000 → patientPay = 1000, planPay = 4500
        expect(output.patientPayCents.toString()).toBe('1000');
        expect(output.planPayCents.toString()).toBe('4500');

        // Forest root changed
        expect(output.oldForestRoot.toString()).toBe(credentialData.forestRoot.toString());
        expect(output.newForestRoot.toString()).not.toBe(credentialData.forestRoot.toString());
      }, 120_000);

      it('rejects NDC mismatch', async () => {
        const { rxData, credentialData, forest, filledStatus } = setupFilledPrescription();

        // Wrong NDC in fulfillment
        const wrongFulfillment = new FulfillmentData({
          prescriptionHash: rxData.commitment(),
          pharmacyWalletId,
          ndcHash: hashString('99999999999'), // wrong NDC
          quantityDispensed: quantityToField(30),
          ingredientCostCents: centsToField(5000),
          dispensingFeeCents: centsToField(500),
          dateOfService: dateToField('20260215'),
        });

        const formularyRegistry = createTestFormularyRegistry();
        const formularyEntry = formularyRegistry.getEntry(0n)!;
        const formularyWitness = formularyRegistry.getEntryWitness(0n);
        const formularyRoot = formularyRegistry.getRoot();

        const forestRoots = ForestRoots.fromForest(forest);
        const medicationWitness = forest.getWitness(ForestDomain.MEDICATION, 0n);
        const statusWitness = forest.getWitness(ForestDomain.TRANSACTION, 1n);
        const newSlotWitness = forest.getWitness(ForestDomain.TRANSACTION, 2n);

        await expect(
          FulfillmentProgram.proveFulfillment(
            credentialData,
            rxData,
            filledStatus,
            wrongFulfillment,
            formularyEntry,
            forestRoots,
            medicationWitness,
            statusWitness,
            newSlotWitness,
            formularyWitness,
            formularyRoot,
            PHARM_QUAL,
            PHARM_ID_HASH,
            PHARM_EK_HASH,
          ),
        ).rejects.toThrow();
      }, 120_000);

      it('rejects quantity exceeding max per fill', async () => {
        const { rxData, credentialData, forest, filledStatus } = setupFilledPrescription();

        // Quantity exceeds max (90 units max, claiming 100)
        const tooMuchFulfillment = new FulfillmentData({
          prescriptionHash: rxData.commitment(),
          pharmacyWalletId,
          ndcHash,
          quantityDispensed: quantityToField(100), // exceeds max 90
          ingredientCostCents: centsToField(5000),
          dispensingFeeCents: centsToField(500),
          dateOfService: dateToField('20260215'),
        });

        const formularyRegistry = createTestFormularyRegistry();
        const formularyEntry = formularyRegistry.getEntry(0n)!;
        const formularyWitness = formularyRegistry.getEntryWitness(0n);
        const formularyRoot = formularyRegistry.getRoot();

        const forestRoots = ForestRoots.fromForest(forest);
        const medicationWitness = forest.getWitness(ForestDomain.MEDICATION, 0n);
        const statusWitness = forest.getWitness(ForestDomain.TRANSACTION, 1n);
        const newSlotWitness = forest.getWitness(ForestDomain.TRANSACTION, 2n);

        await expect(
          FulfillmentProgram.proveFulfillment(
            credentialData,
            rxData,
            filledStatus,
            tooMuchFulfillment,
            formularyEntry,
            forestRoots,
            medicationWitness,
            statusWitness,
            newSlotWitness,
            formularyWitness,
            formularyRoot,
            PHARM_QUAL,
            PHARM_ID_HASH,
            PHARM_EK_HASH,
          ),
        ).rejects.toThrow();
      }, 120_000);

      it('rejects non-FILLED status', async () => {
        const rxData = createTestPrescriptionData();
        const forest = new MerkleForest();

        // Only ACTIVE status (not filled)
        forest.setLeaf(ForestDomain.MEDICATION, 0n, rxData.commitment());
        const activeStatus = new PrescriptionStatusData({
          prescriptionHash: rxData.commitment(),
          status: RX_STATUS_ADJUDICATED,
          updatedByWalletId: prescriberWalletId,
          updatedAt: dateToField('20260201'),
          pharmacyWalletId,
          fillQuantity: Field(0),
          notesHash: Field(0),
        });
        forest.setLeaf(ForestDomain.TRANSACTION, 0n, activeStatus.commitment());

        const credentialData = new CredentialData({
          credentialType: CREDENTIAL_TYPE_PRESCRIPTION,
          forestRoot: forest.getForestRoot(),
          issuerWalletId: prescriberWalletId,
          subjectWalletId: pharmacyWalletId,
          issuedAt: dateToField('20260201'),
          expiresAt: dateToField('20270201'),
          revoked: Field(0),
        });

        const fulfillment = createTestFulfillmentData(rxData.commitment());
        const formularyRegistry = createTestFormularyRegistry();
        const formularyEntry = formularyRegistry.getEntry(0n)!;
        const formularyWitness = formularyRegistry.getEntryWitness(0n);
        const formularyRoot = formularyRegistry.getRoot();

        const forestRoots = ForestRoots.fromForest(forest);
        const medicationWitness = forest.getWitness(ForestDomain.MEDICATION, 0n);
        const statusWitness = forest.getWitness(ForestDomain.TRANSACTION, 0n);
        const newSlotWitness = forest.getWitness(ForestDomain.TRANSACTION, 1n);

        await expect(
          FulfillmentProgram.proveFulfillment(
            credentialData,
            rxData,
            activeStatus,
            fulfillment,
            formularyEntry,
            forestRoots,
            medicationWitness,
            statusWitness,
            newSlotWitness,
            formularyWitness,
            formularyRoot,
            PHARM_QUAL,
            PHARM_ID_HASH,
            PHARM_EK_HASH,
          ),
        ).rejects.toThrow();
      }, 120_000);
    });

    describe('proveReversal', () => {
      it('valid reversal generates proof with matching refund amounts', async () => {
        // Set up a fulfilled prescription
        const { rxData, forest, filledStatus } = setupFilledPrescription();
        const fulfillment = createTestFulfillmentData(rxData.commitment());

        // Insert settlement commitment at TRANSACTION index 2
        // copay=1000, total=5500 → patientPay=1000, planPay=4500
        const settlementLeaf = computeSettlementCommitment(
          fulfillment, centsToField(1000), centsToField(4500),
        );
        forest.setLeaf(ForestDomain.TRANSACTION, 2n, settlementLeaf);

        // Update CredentialData with new forest root
        const credentialDataPostFulfill = new CredentialData({
          credentialType: CREDENTIAL_TYPE_PRESCRIPTION,
          forestRoot: forest.getForestRoot(),
          issuerWalletId: prescriberWalletId,
          subjectWalletId: pharmacyWalletId,
          issuedAt: dateToField('20260201'),
          expiresAt: dateToField('20270201'),
          revoked: Field(0),
        });

        // Build reversal with correct amounts: copay=1000, planPay=4500
        const reversalData = new ReversalData({
          fulfillmentHash: fulfillment.commitment(),
          pharmacyWalletId,
          patientRefundCents: centsToField(1000),
          planRefundCents: centsToField(4500),
          reversalDate: dateToField('20260301'),
          reasonCodeHash: Field(0),
          reversedByWalletId: pharmacyWalletId,
        });

        const formularyRegistry = createTestFormularyRegistry();
        const formularyEntry = formularyRegistry.getEntry(0n)!;
        const formularyWitness = formularyRegistry.getEntryWitness(0n);
        const formularyRoot = formularyRegistry.getRoot();

        const forestRoots = ForestRoots.fromForest(forest);
        const medicationWitness = forest.getWitness(ForestDomain.MEDICATION, 0n);
        const fulfillmentWitness = forest.getWitness(ForestDomain.TRANSACTION, 2n);
        const reversalSlotWitness = forest.getWitness(ForestDomain.TRANSACTION, 3n);

        const result = await FulfillmentProgram.proveReversal(
          credentialDataPostFulfill,
          rxData,
          fulfillment,
          reversalData,
          formularyEntry,
          forestRoots,
          medicationWitness,
          fulfillmentWitness,
          reversalSlotWitness,
          formularyWitness,
          formularyRoot,
          PHARM_QUAL,
          PHARM_ID_HASH,
          PHARM_EK_HASH,
        );

        const output = result.proof.publicOutput;
        expect(output.operationType.toString()).toBe(FULFILL_OP_REVERSAL.toString());
        expect(output.patientPayCents.toString()).toBe('1000');
        expect(output.planPayCents.toString()).toBe('4500');
      }, 120_000);

      it('rejects reversal with wrong refund amounts', async () => {
        const { rxData, forest } = setupFilledPrescription();
        const fulfillment = createTestFulfillmentData(rxData.commitment());

        // Insert settlement commitment (correct amounts)
        const settlementLeaf = computeSettlementCommitment(
          fulfillment, centsToField(1000), centsToField(4500),
        );
        forest.setLeaf(ForestDomain.TRANSACTION, 2n, settlementLeaf);

        const credentialDataPostFulfill = new CredentialData({
          credentialType: CREDENTIAL_TYPE_PRESCRIPTION,
          forestRoot: forest.getForestRoot(),
          issuerWalletId: prescriberWalletId,
          subjectWalletId: pharmacyWalletId,
          issuedAt: dateToField('20260201'),
          expiresAt: dateToField('20270201'),
          revoked: Field(0),
        });

        // Wrong patient refund (should be 1000, using 2000)
        const wrongReversal = new ReversalData({
          fulfillmentHash: fulfillment.commitment(),
          pharmacyWalletId,
          patientRefundCents: centsToField(2000), // wrong!
          planRefundCents: centsToField(4500),
          reversalDate: dateToField('20260301'),
          reasonCodeHash: Field(0),
          reversedByWalletId: pharmacyWalletId,
        });

        const formularyRegistry = createTestFormularyRegistry();
        const formularyEntry = formularyRegistry.getEntry(0n)!;
        const formularyWitness = formularyRegistry.getEntryWitness(0n);
        const formularyRoot = formularyRegistry.getRoot();

        const forestRoots = ForestRoots.fromForest(forest);
        const medicationWitness = forest.getWitness(ForestDomain.MEDICATION, 0n);
        const fulfillmentWitness = forest.getWitness(ForestDomain.TRANSACTION, 2n);
        const reversalSlotWitness = forest.getWitness(ForestDomain.TRANSACTION, 3n);

        await expect(
          FulfillmentProgram.proveReversal(
            credentialDataPostFulfill,
            rxData,
            fulfillment,
            wrongReversal,
            formularyEntry,
            forestRoots,
            medicationWitness,
            fulfillmentWitness,
            reversalSlotWitness,
            formularyWitness,
            formularyRoot,
            PHARM_QUAL,
            PHARM_ID_HASH,
            PHARM_EK_HASH,
          ),
        ).rejects.toThrow();
      }, 120_000);

      it('rejects reversal when fulfillment not in tree', async () => {
        const rxData = createTestPrescriptionData();
        const forest = new MerkleForest();

        // Set up forest with only prescription and statuses (no fulfillment)
        forest.setLeaf(ForestDomain.MEDICATION, 0n, rxData.commitment());
        const filledStatus = new PrescriptionStatusData({
          prescriptionHash: rxData.commitment(),
          status: RX_STATUS_FILLED,
          updatedByWalletId: pharmacyWalletId,
          updatedAt: dateToField('20260215'),
          pharmacyWalletId,
          fillQuantity: quantityToField(30),
          notesHash: Field(0),
        });
        forest.setLeaf(ForestDomain.TRANSACTION, 0n, filledStatus.commitment());

        const credentialData = new CredentialData({
          credentialType: CREDENTIAL_TYPE_PRESCRIPTION,
          forestRoot: forest.getForestRoot(),
          issuerWalletId: prescriberWalletId,
          subjectWalletId: pharmacyWalletId,
          issuedAt: dateToField('20260201'),
          expiresAt: dateToField('20270201'),
          revoked: Field(0),
        });

        // Create a fulfillment that's NOT in the tree
        const fulfillment = createTestFulfillmentData(rxData.commitment());
        const reversalData = new ReversalData({
          fulfillmentHash: fulfillment.commitment(),
          pharmacyWalletId,
          patientRefundCents: centsToField(1000),
          planRefundCents: centsToField(4500),
          reversalDate: dateToField('20260301'),
          reasonCodeHash: Field(0),
          reversedByWalletId: pharmacyWalletId,
        });

        const formularyRegistry = createTestFormularyRegistry();
        const formularyEntry = formularyRegistry.getEntry(0n)!;
        const formularyWitness = formularyRegistry.getEntryWitness(0n);
        const formularyRoot = formularyRegistry.getRoot();

        const forestRoots = ForestRoots.fromForest(forest);
        const medicationWitness = forest.getWitness(ForestDomain.MEDICATION, 0n);
        // Fulfillment witness at index 2 — but no fulfillment exists there
        const fulfillmentWitness = forest.getWitness(ForestDomain.TRANSACTION, 2n);
        const reversalSlotWitness = forest.getWitness(ForestDomain.TRANSACTION, 3n);

        await expect(
          FulfillmentProgram.proveReversal(
            credentialData,
            rxData,
            fulfillment,
            reversalData,
            formularyEntry,
            forestRoots,
            medicationWitness,
            fulfillmentWitness,
            reversalSlotWitness,
            formularyWitness,
            formularyRoot,
            PHARM_QUAL,
            PHARM_ID_HASH,
            PHARM_EK_HASH,
          ),
        ).rejects.toThrow();
      }, 120_000);
    });
  });

  // ── End-to-end: FulfillmentService with proofs ────────────

  describe('FulfillmentService — end-to-end with proofs', () => {
    let compiled = false;

    beforeAll(async () => {
      // FulfillmentProgram should already be compiled from the previous block
      // But compile again just in case tests run in isolation
      if (!compiled) {
        await FulfillmentProgram.compile();
        compiled = true;
      }
    }, 180_000);

    it('full claim lifecycle: fill → submit fulfillment → verify amounts', async () => {
      const { rxData, credentialData, forest, filledStatus, inventory, credentialSlotIndex, registry } =
        setupFilledPrescription();

      const formularyRegistry = createTestFormularyRegistry();
      const service = new FulfillmentService(
        new InMemoryStore(),
        registry,
        formularyRegistry,
      );

      const fulfillment = createTestFulfillmentData(rxData.commitment());

      const result = await service.submitFulfillment(
        pharmacyWalletId,
        credentialData,
        rxData,
        filledStatus,
        fulfillment,
        forest,
        0n,  // rxLeafIndex
        1n,  // latestStatusIndex (FILLED at index 1)
        0n,  // formularyEntryIndex
        inventory,
        credentialSlotIndex,
        [PHARM_QUAL, PHARM_ID_HASH, PHARM_EK_HASH],
      );

      // Verify amounts
      expect(result.patientPayCents.toString()).toBe('1000');
      expect(result.planPayCents.toString()).toBe('4500');

      // Verify fulfillment was appended at index 2
      expect(result.fulfillmentIndex).toBe(2n);

      // Verify credential forestRoot changed
      expect(result.newCredentialData.forestRoot.toString())
        .not.toBe(credentialData.forestRoot.toString());

      // Verify the settlement commitment (not raw fulfillment) is in the TRANSACTION tree
      const storedLeaf = forest.getLeaf(ForestDomain.TRANSACTION, 2n);
      const expectedSettlement = computeSettlementCommitment(
        fulfillment, result.patientPayCents, result.planPayCents,
      );
      expect(storedLeaf.toString()).toBe(expectedSettlement.toString());
    }, 120_000);

    it('full reversal lifecycle: fulfill → reverse → verify refund', async () => {
      const { rxData, credentialData, forest, filledStatus, inventory, credentialSlotIndex, registry } =
        setupFilledPrescription();

      const formularyRegistry = createTestFormularyRegistry();
      const service = new FulfillmentService(
        new InMemoryStore(),
        registry,
        formularyRegistry,
      );

      const fulfillment = createTestFulfillmentData(rxData.commitment());

      // Step 1: Submit fulfillment
      const fulfillResult = await service.submitFulfillment(
        pharmacyWalletId,
        credentialData,
        rxData,
        filledStatus,
        fulfillment,
        forest,
        0n,
        1n,
        0n,
        inventory,
        credentialSlotIndex,
        [PHARM_QUAL, PHARM_ID_HASH, PHARM_EK_HASH],
      );

      // Step 2: Reverse fulfillment
      const reversalData = new ReversalData({
        fulfillmentHash: fulfillment.commitment(),
        pharmacyWalletId,
        patientRefundCents: centsToField(1000),
        planRefundCents: centsToField(4500),
        reversalDate: dateToField('20260301'),
        reasonCodeHash: Field(0),
        reversedByWalletId: pharmacyWalletId,
      });

      const reversalResult = await service.reverseFulfillment(
        pharmacyWalletId,
        fulfillResult.newCredentialData,
        rxData,
        fulfillment,
        reversalData,
        forest,
        0n,
        2n,  // fulfillment at index 2
        0n,  // formularyEntryIndex
        inventory,
        credentialSlotIndex,
        [PHARM_QUAL, PHARM_ID_HASH, PHARM_EK_HASH],
      );

      // Verify refund amounts match original
      expect(reversalResult.patientRefundCents.toString()).toBe('1000');
      expect(reversalResult.planRefundCents.toString()).toBe('4500');

      // Verify reversal was appended at index 3
      expect(reversalResult.reversalIndex).toBe(3n);

      // Verify the reversal commitment is in the TRANSACTION tree
      const storedLeaf = forest.getLeaf(ForestDomain.TRANSACTION, 3n);
      expect(storedLeaf.toString()).toBe(reversalData.commitment().toString());
    }, 120_000);
  });
});
