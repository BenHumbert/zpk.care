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

import { Field, Poseidon, MerkleTree } from 'o1js';
import {
  PrescriptionData,
  PrescriptionStatusData,
  buildPrescriptionData,
  buildPrescriptionStatusData,
  RX_STATUS_ADJUDICATED,
  RX_STATUS_PARTIALLY_FILLED,
  RX_STATUS_FILLED,
  RX_STATUS_CANCELLED,
  RX_STATUS_REJECTED,
  RX_STATUS_REVERSED,
  RX_STATUS_TRANSFERRED,
  RX_STATUS_DISPENSED,
  EMERGENCY_FILL_HASH,
  isValidStatusTransition,
  assertValidStatusTransition,
} from '../src/prescription/prescription-data.js';
import type {
  PrescriptionLocalData,
  PrescriptionStatusLocalData,
} from '../src/prescription/prescription-data.js';
import {
  PrescriptionProgram,
  PrescriptionOutput,
  PrescriptionProof,
} from '../src/prescription/prescription-program.js';
import { PrescriptionService } from '../src/prescription/prescription-service.js';
import { PrescriptionVerificationService } from '../src/prescription/prescription-verification-service.js';
import { CredentialData, CREDENTIAL_TYPE_PRESCRIPTION, CREDENTIAL_TYPE_ELIGIBILITY } from '../src/credentials/credential-data.js';
import { CredentialInventory } from '../src/credentials/credential-inventory.js';
import { CredentialProgram, CredentialOperationProof, CREDENTIAL_OP_VERIFY } from '../src/credentials/credential-program.js';
import { ProofGateProgram } from '../src/wallets/proof-gate.js';
import { DOMAIN_TAG_PRESCRIBER } from '../src/wallets/wallet-derivation.js';
import { MerkleForest, ForestDomain } from '../src/zkp/merkle-forest.js';
import { ForestRoots } from '../src/eligibility/forest-roots.js';
import { hashString, dateToField, quantityToField } from '../src/zkp/hash-utils.js';
import { InMemoryStore } from '../src/storage/local-store.js';
import {
  WalletRegistry,
  WalletState,
  WALLET_TREE_HEIGHT,
} from '../src/wallets/wallet-state.js';
import { EMPTY_CREDENTIAL_ROOT } from '../src/engine/state-transition.js';
import {
  deriveEncryptionKeyPair,
  deriveSharedSecret,
  encryptMessage,
  decryptMessage,
  computeContentHash,
  publicKeyToFields,
} from '../src/messaging/encryption.js';
import {
  MessageRegistry,
  DelegationRegistry,
  KeyRegistry,
} from '../src/messaging/message-registry.js';
import { MessagingProgram } from '../src/messaging/messaging-program.js';
import { MessagingService } from '../src/messaging/messaging-service.js';
import { MSG_TYPE_PRESCRIPTION, MSG_TYPE_NOTIFICATION } from '../src/messaging/message-data.js';

// ─── Test Data ──────────────────────────────────────────────

const sampleRxLocal: PrescriptionLocalData = {
  ndcCode: '00071015523',       // Lisinopril 10mg
  prescriberWalletId: '111222333444555666',
  memberWalletId: '999888777666555444',
  writtenDate: '20260201',
  expirationDate: '20270201',
  quantityPrescribed: 30,
  refillsAuthorized: 5,
};

const sampleStatusLocal: PrescriptionStatusLocalData = {
  prescriptionHash: '12345',  // placeholder, will be overridden
  status: 1,
  updatedByWalletId: '111222333444555666',
  updatedAt: '20260201120000',
  pharmacyWalletId: '777666555444333222',
  fillQuantity: 0,
  notes: '',
};

// Prescriber wallet preimage constants (M4 fix: identity binding)
const PRESCRIBER_QUAL = Field(1);
const PRESCRIBER_ID_HASH = Field(333);
const PRESCRIBER_EK_HASH = Field(444);

// Wallet IDs as Fields
const prescriberWalletId = Poseidon.hash([DOMAIN_TAG_PRESCRIBER, PRESCRIBER_QUAL, PRESCRIBER_ID_HASH, PRESCRIBER_EK_HASH]);
const memberWalletId = Field(999888777666555444n);
const pharmacyWalletId = Field(777666555444333222n);
const pharmacy2WalletId = Field(888777666555444333n);
const adminWalletId = Field(100200300400500600n);

// ─── Helpers ────────────────────────────────────────────────

function createTestPrescriptionData(): PrescriptionData {
  return new PrescriptionData({
    ndcHash: hashString('00071015523'),
    prescriberWalletId,
    memberWalletId,
    writtenDate: dateToField('20260201'),
    expirationDate: dateToField('20270201'),
    quantityPrescribed: quantityToField(30),
    refillsAuthorized: Field(5),
  });
}

function createTestForest(): MerkleForest {
  return new MerkleForest();
}

function createTestWalletRegistry(): {
  registry: WalletRegistry;
  lifecycleTree: MerkleTree;
} {
  const registry = new WalletRegistry();
  const lifecycleTree = new MerkleTree(WALLET_TREE_HEIGHT);

  // Register pharmacy wallet
  registry.register(pharmacyWalletId);

  // Register pharmacy2 wallet
  registry.register(pharmacy2WalletId);

  return { registry, lifecycleTree };
}

// ─── Tests ──────────────────────────────────────────────────

describe('Layer 8 — Prescription Flow (Use Case D)', () => {

  // ── PrescriptionData Model ──────────────────────────────

  describe('PrescriptionData Model', () => {
    it('commitment is deterministic', () => {
      const rx1 = createTestPrescriptionData();
      const rx2 = createTestPrescriptionData();
      expect(rx1.commitment().toString()).toBe(rx2.commitment().toString());
    });

    it('commitment changes when any field changes', () => {
      const rx = createTestPrescriptionData();
      const base = rx.commitment().toString();

      const modified = new PrescriptionData({
        ndcHash: hashString('99999999999'),
        prescriberWalletId: rx.prescriberWalletId,
        memberWalletId: rx.memberWalletId,
        writtenDate: rx.writtenDate,
        expirationDate: rx.expirationDate,
        quantityPrescribed: rx.quantityPrescribed,
        refillsAuthorized: rx.refillsAuthorized,
      });
      expect(modified.commitment().toString()).not.toBe(base);
    });

    it('buildPrescriptionData from local data', () => {
      const rx = buildPrescriptionData(sampleRxLocal);
      expect(rx.ndcHash.toString()).toBe(hashString('00071015523').toString());
      expect(rx.prescriberWalletId.toString()).toBe('111222333444555666');
      expect(rx.refillsAuthorized.toString()).toBe('5');
    });

    it('commitment matches manual Poseidon.hash of 7 fields', () => {
      const rx = createTestPrescriptionData();
      const manual = Poseidon.hash([
        rx.ndcHash,
        rx.prescriberWalletId,
        rx.memberWalletId,
        rx.writtenDate,
        rx.expirationDate,
        rx.quantityPrescribed,
        rx.refillsAuthorized,
      ]);
      expect(rx.commitment().toString()).toBe(manual.toString());
    });
  });

  // ── PrescriptionStatusData Model ────────────────────────

  describe('PrescriptionStatusData Model', () => {
    it('commitment is deterministic', () => {
      const rxHash = createTestPrescriptionData().commitment();
      const s1 = new PrescriptionStatusData({
        prescriptionHash: rxHash,
        status: RX_STATUS_ADJUDICATED,
        updatedByWalletId: pharmacyWalletId,
        updatedAt: Field(20260201120000n),
        pharmacyWalletId,
        fillQuantity: Field(0),
        notesHash: Field(0),
      });
      const s2 = new PrescriptionStatusData({
        prescriptionHash: rxHash,
        status: RX_STATUS_ADJUDICATED,
        updatedByWalletId: pharmacyWalletId,
        updatedAt: Field(20260201120000n),
        pharmacyWalletId,
        fillQuantity: Field(0),
        notesHash: Field(0),
      });
      expect(s1.commitment().toString()).toBe(s2.commitment().toString());
    });

    it('commitment changes when any field changes', () => {
      const rxHash = createTestPrescriptionData().commitment();
      const s1 = new PrescriptionStatusData({
        prescriptionHash: rxHash,
        status: RX_STATUS_ADJUDICATED,
        updatedByWalletId: pharmacyWalletId,
        updatedAt: Field(20260201120000n),
        pharmacyWalletId,
        fillQuantity: Field(0),
        notesHash: Field(0),
      });
      const base = s1.commitment().toString();

      const s2 = new PrescriptionStatusData({
        prescriptionHash: rxHash,
        status: RX_STATUS_FILLED,
        updatedByWalletId: pharmacyWalletId,
        updatedAt: Field(20260201120000n),
        pharmacyWalletId,
        fillQuantity: Field(0),
        notesHash: Field(0),
      });
      expect(s2.commitment().toString()).not.toBe(base);
    });

    it('buildPrescriptionStatusData from local data', () => {
      const s = buildPrescriptionStatusData(sampleStatusLocal);
      expect(s.status.toString()).toBe('1');
      expect(s.fillQuantity.toString()).toBe('0');
    });

    it('status constants have correct values', () => {
      expect(RX_STATUS_ADJUDICATED.toString()).toBe('1');
      expect(RX_STATUS_PARTIALLY_FILLED.toString()).toBe('2');
      expect(RX_STATUS_FILLED.toString()).toBe('3');
      expect(RX_STATUS_CANCELLED.toString()).toBe('4');
      expect(RX_STATUS_REJECTED.toString()).toBe('5');
      expect(RX_STATUS_REVERSED.toString()).toBe('6');
      expect(RX_STATUS_TRANSFERRED.toString()).toBe('7');
    });
  });

  // ── Status Transition Validation ────────────────────────
  // The lifecycle the engine runs (VALID_TRANSITIONS in prescription-data.ts): ADJUDICATED -> FILLED (prepared,
  // mark-filled) -> DISPENSED (picked up and paid, the settlement proof), with partial fills, cancellation, rejection,
  // transfer and reversal. Every one of the 64 pairs of statuses is checked, off the circuit and in it.

  describe('Status Transition Validation', () => {
    const LIFECYCLE: Array<[bigint, bigint]> = [
      [1n, 3n], [1n, 4n], [1n, 5n], [1n, 7n],           // ADJUDICATED -> FILLED, CANCELLED, REJECTED, TRANSFERRED
      [2n, 2n], [2n, 3n], [2n, 4n], [2n, 6n], [2n, 7n], // PARTIALLY_FILLED -> itself, FILLED, CANCELLED, REVERSED, TRANSFERRED
      [2n, 8n],                                          // PARTIALLY_FILLED -> DISPENSED (the last part, A-148)
      [3n, 8n], [3n, 4n],                                // FILLED -> DISPENSED, CANCELLED
      [3n, 2n],                                          // FILLED -> PARTIALLY_FILLED (the first part, A-148)
      [8n, 6n],                                          // DISPENSED -> REVERSED
      [6n, 1n],                                          // REVERSED -> ADJUDICATED
    ];
    const inLifecycle = (from: bigint, to: bigint) => LIFECYCLE.some(([f, t]) => f === from && t === to);
    const STATUSES = [
      RX_STATUS_ADJUDICATED, RX_STATUS_PARTIALLY_FILLED, RX_STATUS_FILLED, RX_STATUS_CANCELLED,
      RX_STATUS_REJECTED, RX_STATUS_REVERSED, RX_STATUS_TRANSFERRED, RX_STATUS_DISPENSED,
    ];

    it("accepts exactly the lifecycle's transitions, off the circuit", () => {
      for (const from of STATUSES) {
        for (const to of STATUSES) {
          const pair = [from.toBigInt(), to.toBigInt()] as const;
          expect([...pair, isValidStatusTransition(...pair)]).toEqual([...pair, inLifecycle(...pair)]);
        }
      }
    });

    it('the circuit accepts and refuses the same transitions', () => {
      for (const from of STATUSES) {
        for (const to of STATUSES) {
          const check = () => assertValidStatusTransition(from, to);
          if (inLifecycle(from.toBigInt(), to.toBigInt())) expect(check).not.toThrow();
          else expect(check).toThrow('Invalid prescription status transition');
        }
      }
    });

    it('cancelled, rejected and transferred prescriptions are terminal', () => {
      for (const to of STATUSES) {
        for (const terminal of [RX_STATUS_CANCELLED, RX_STATUS_REJECTED, RX_STATUS_TRANSFERRED]) {
          expect(isValidStatusTransition(terminal.toBigInt(), to.toBigInt())).toBe(false);
        }
      }
    });
  });

  // ── PrescriptionService — build + mint ──────────────────

  describe('PrescriptionService — build + mint', () => {
    let service: PrescriptionService;
    let registry: WalletRegistry;
    let lifecycleTree: MerkleTree;

    beforeEach(() => {
      const result = createTestWalletRegistry();
      registry = result.registry;
      lifecycleTree = result.lifecycleTree;
      service = new PrescriptionService(
        new InMemoryStore(),
        registry,
        lifecycleTree,
      );
    });

    it('buildPrescriptionCredential creates correct CredentialData', () => {
      const rxData = createTestPrescriptionData();
      const forest = createTestForest();
      const { credentialData, initialStatus } = service.buildPrescriptionCredential(
        prescriberWalletId,
        memberWalletId,
        pharmacyWalletId,
        rxData,
        forest,
        0n,
        dateToField('20260201'),
        dateToField('20270201'),
      );

      expect(credentialData.credentialType.toString()).toBe(CREDENTIAL_TYPE_PRESCRIPTION.toString());
      expect(credentialData.issuerWalletId.toString()).toBe(prescriberWalletId.toString());
      expect(credentialData.subjectWalletId.toString()).toBe(pharmacyWalletId.toString());
      expect(credentialData.revoked.toString()).toBe('0');
      expect(initialStatus.status.toString()).toBe(RX_STATUS_ADJUDICATED.toString());
    });

    it('buildPrescriptionCredential inserts prescription + initial status into forest', () => {
      const rxData = createTestPrescriptionData();
      const forest = createTestForest();
      service.buildPrescriptionCredential(
        prescriberWalletId,
        memberWalletId,
        pharmacyWalletId,
        rxData,
        forest,
        0n,
        dateToField('20260201'),
      );

      // Prescription in MEDICATION tree
      const medLeaf = forest.getLeaf(ForestDomain.MEDICATION, 0n);
      expect(medLeaf.toString()).toBe(rxData.commitment().toString());

      // Initial status in TRANSACTION tree
      const txLeaf = forest.getLeaf(ForestDomain.TRANSACTION, 0n);
      expect(txLeaf.toString()).not.toBe('0');
    });

    it('mintPrescriptionToPharmacy updates inventory + registry', () => {
      const rxData = createTestPrescriptionData();
      const forest = createTestForest();
      const { credentialData } = service.buildPrescriptionCredential(
        prescriberWalletId,
        memberWalletId,
        pharmacyWalletId,
        rxData,
        forest,
        0n,
        dateToField('20260201'),
      );

      const inventory = new CredentialInventory();
      const { credentialIndex, newInventoryRoot, newRegistryRoot } =
        service.mintPrescriptionToPharmacy(pharmacyWalletId, credentialData, inventory);

      expect(credentialIndex).toBe(0n);
      expect(newInventoryRoot.toString()).not.toBe(EMPTY_CREDENTIAL_ROOT.toString());

      // Wallet registry updated
      const state = registry.getState(pharmacyWalletId);
      expect(state.nonce.toString()).toBe('1');
      expect(state.credentialInventoryRoot.toString()).toBe(newInventoryRoot.toString());
    });

    it('issuePrescription full flow returns correct result', async () => {
      const rxData = createTestPrescriptionData();
      const forest = createTestForest();
      const inventory = new CredentialInventory();

      const result = await service.issuePrescription(
        prescriberWalletId,
        memberWalletId,
        pharmacyWalletId,
        rxData,
        forest,
        inventory,
        0n,
        dateToField('20260201'),
        dateToField('20270201'),
      );

      expect(result.credentialData.credentialType.toString()).toBe(CREDENTIAL_TYPE_PRESCRIPTION.toString());
      expect(result.credentialIndex).toBe(0n);
      expect(result.prescriptionData.commitment().toString()).toBe(rxData.commitment().toString());
      expect(result.initialStatus.status.toString()).toBe(RX_STATUS_ADJUDICATED.toString());
    });

    it('cross-wallet: subjectWalletId = pharmacyWalletId', () => {
      const rxData = createTestPrescriptionData();
      const forest = createTestForest();
      const { credentialData } = service.buildPrescriptionCredential(
        prescriberWalletId,
        memberWalletId,
        pharmacyWalletId,
        rxData,
        forest,
        0n,
        dateToField('20260201'),
      );

      // issuer = prescriber, subject = pharmacy (NOT prescriber)
      expect(credentialData.issuerWalletId.toString()).toBe(prescriberWalletId.toString());
      expect(credentialData.subjectWalletId.toString()).toBe(pharmacyWalletId.toString());
      expect(credentialData.subjectWalletId.toString()).not.toBe(prescriberWalletId.toString());
    });

    it('verifyPrescriptionForest succeeds with valid data', () => {
      const rxData = createTestPrescriptionData();
      const forest = createTestForest();
      const { credentialData } = service.buildPrescriptionCredential(
        prescriberWalletId,
        memberWalletId,
        pharmacyWalletId,
        rxData,
        forest,
        0n,
        dateToField('20260201'),
      );

      expect(service.verifyPrescriptionForest(credentialData, rxData, forest, 0n)).toBe(true);
    });

    it('verifyPrescriptionForest rejects tampered data', () => {
      const rxData = createTestPrescriptionData();
      const forest = createTestForest();
      const { credentialData } = service.buildPrescriptionCredential(
        prescriberWalletId,
        memberWalletId,
        pharmacyWalletId,
        rxData,
        forest,
        0n,
        dateToField('20260201'),
      );

      // Tamper with prescription data
      const tampered = new PrescriptionData({
        ndcHash: hashString('99999999999'),
        prescriberWalletId: rxData.prescriberWalletId,
        memberWalletId: rxData.memberWalletId,
        writtenDate: rxData.writtenDate,
        expirationDate: rxData.expirationDate,
        quantityPrescribed: rxData.quantityPrescribed,
        refillsAuthorized: rxData.refillsAuthorized,
      });

      expect(service.verifyPrescriptionForest(credentialData, tampered, forest, 0n)).toBe(false);
    });
  });

  // ── PrescriptionService — transfer ──────────────────────

  describe('PrescriptionService — transfer (off-chain only)', () => {
    it('dest forest carries forward full TRANSACTION history', () => {
      const rxData = createTestPrescriptionData();
      const forest = createTestForest();
      const { registry, lifecycleTree } = createTestWalletRegistry();
      const service = new PrescriptionService(
        new InMemoryStore(),
        registry,
        lifecycleTree,
      );

      // Build and mint initial prescription
      const { credentialData, initialStatus } = service.buildPrescriptionCredential(
        prescriberWalletId,
        memberWalletId,
        pharmacyWalletId,
        rxData,
        forest,
        0n,
        dateToField('20260201'),
      );

      // Simulate adding a TRANSFERRED status (off-chain, without ZK proof)
      const transferStatus = new PrescriptionStatusData({
        prescriptionHash: rxData.commitment(),
        status: RX_STATUS_TRANSFERRED,
        updatedByWalletId: pharmacyWalletId,
        updatedAt: Field(20260301120000n),
        pharmacyWalletId: pharmacy2WalletId,
        fillQuantity: Field(0),
        notesHash: Field(0),
      });
      forest.setLeaf(ForestDomain.TRANSACTION, 1n, transferStatus.commitment());

      // Add dest ACTIVE entry
      const destActive = new PrescriptionStatusData({
        prescriptionHash: rxData.commitment(),
        status: RX_STATUS_ADJUDICATED,
        updatedByWalletId: pharmacy2WalletId,
        updatedAt: Field(20260301120000n),
        pharmacyWalletId: pharmacy2WalletId,
        fillQuantity: Field(0),
        notesHash: Field(0),
      });
      forest.setLeaf(ForestDomain.TRANSACTION, 2n, destActive.commitment());

      // Verify all 3 status entries in TRANSACTION tree
      expect(forest.getLeaf(ForestDomain.TRANSACTION, 0n).toString())
        .toBe(initialStatus.commitment().toString());
      expect(forest.getLeaf(ForestDomain.TRANSACTION, 1n).toString())
        .toBe(transferStatus.commitment().toString());
      expect(forest.getLeaf(ForestDomain.TRANSACTION, 2n).toString())
        .toBe(destActive.commitment().toString());
    });
  });

  // ── PrescriptionVerificationService ─────────────────────

  describe('PrescriptionVerificationService', () => {
    const verifier = new PrescriptionVerificationService();

    it('verifyPrescriptionData accepts valid prescription', () => {
      const rxData = createTestPrescriptionData();
      const forest = createTestForest();
      const { registry, lifecycleTree } = createTestWalletRegistry();
      const service = new PrescriptionService(
        new InMemoryStore(),
        registry,
        lifecycleTree,
      );
      const { credentialData } = service.buildPrescriptionCredential(
        prescriberWalletId,
        memberWalletId,
        pharmacyWalletId,
        rxData,
        forest,
        0n,
        dateToField('20260201'),
      );

      const result = verifier.verifyPrescriptionData(
        credentialData,
        rxData,
        forest,
        0n,
        dateToField('20260601'),
      );
      expect(result.isValid).toBe(true);
      expect(result.ndcHash!.toString()).toBe(rxData.ndcHash.toString());
    });

    it('verifyPrescriptionData rejects wrong type / revoked / expired', () => {
      const rxData = createTestPrescriptionData();
      const forest = createTestForest();
      const { registry, lifecycleTree } = createTestWalletRegistry();
      const service = new PrescriptionService(
        new InMemoryStore(),
        registry,
        lifecycleTree,
      );
      const { credentialData } = service.buildPrescriptionCredential(
        prescriberWalletId,
        memberWalletId,
        pharmacyWalletId,
        rxData,
        forest,
        0n,
        dateToField('20260201'),
        dateToField('20270201'),
      );

      // Wrong type
      const wrongType = new CredentialData({
        ...credentialData,
        credentialType: CREDENTIAL_TYPE_ELIGIBILITY,
      });
      expect(verifier.verifyPrescriptionData(
        wrongType, rxData, forest, 0n, dateToField('20260601'),
      ).isValid).toBe(false);

      // Revoked
      const revoked = new CredentialData({ ...credentialData, revoked: Field(1) });
      expect(verifier.verifyPrescriptionData(
        revoked, rxData, forest, 0n, dateToField('20260601'),
      ).isValid).toBe(false);

      // Expired (date past expiresAt)
      expect(verifier.verifyPrescriptionData(
        credentialData, rxData, forest, 0n, dateToField('20280601'),
      ).isValid).toBe(false);
    });

    it('extractStatusHistory returns ordered entries', () => {
      const rxData = createTestPrescriptionData();
      const forest = createTestForest();

      const entry0 = new PrescriptionStatusData({
        prescriptionHash: rxData.commitment(),
        status: RX_STATUS_ADJUDICATED,
        updatedByWalletId: pharmacyWalletId,
        updatedAt: Field(20260201120000n),
        pharmacyWalletId,
        fillQuantity: Field(0),
        notesHash: Field(0),
      });
      forest.setLeaf(ForestDomain.TRANSACTION, 0n, entry0.commitment());

      const entry1 = new PrescriptionStatusData({
        prescriptionHash: rxData.commitment(),
        status: RX_STATUS_FILLED,
        updatedByWalletId: pharmacyWalletId,
        updatedAt: Field(20260205100000n),
        pharmacyWalletId,
        fillQuantity: quantityToField(30),
        notesHash: Field(0),
      });
      forest.setLeaf(ForestDomain.TRANSACTION, 1n, entry1.commitment());

      const history = verifier.extractStatusHistory(forest, 2, [entry0, entry1]);
      expect(history.length).toBe(2);
      expect(history[0]!.status).toBe(RX_STATUS_ADJUDICATED.toString());
      expect(history[1]!.status).toBe(RX_STATUS_FILLED.toString());
    });

    it('isEmergencyPrescription detects emergency flag', () => {
      const rxData = createTestPrescriptionData();
      const forest = createTestForest();
      const { registry, lifecycleTree } = createTestWalletRegistry();
      const service = new PrescriptionService(
        new InMemoryStore(),
        registry,
        lifecycleTree,
      );

      // Standard prescription
      const { initialStatus: stdStatus } = service.buildPrescriptionCredential(
        prescriberWalletId,
        memberWalletId,
        pharmacyWalletId,
        rxData,
        forest,
        0n,
        dateToField('20260201'),
        dateToField('20270201'),
        false,
      );
      expect(verifier.isEmergencyPrescription(forest, stdStatus)).toBe(false);

      // Emergency prescription (new forest)
      const forest2 = createTestForest();
      const { initialStatus: emgStatus } = service.buildPrescriptionCredential(
        prescriberWalletId,
        memberWalletId,
        pharmacyWalletId,
        rxData,
        forest2,
        0n,
        dateToField('20260201'),
        dateToField('20270201'),
        true,
      );
      expect(verifier.isEmergencyPrescription(forest2, emgStatus)).toBe(true);
    });
  });

  // ── PrescriptionProgram — proveStatusUpdate ─────────────

  describe('PrescriptionProgram', () => {
    let compiled = false;

    beforeAll(async () => {
      await PrescriptionProgram.compile();
      compiled = true;
    }, 120_000);

    describe('proveStatusUpdate', () => {
      it('valid status update generates proof', async () => {
        const rxData = createTestPrescriptionData();
        const forest = createTestForest();

        // Insert prescription into MEDICATION tree
        forest.setLeaf(ForestDomain.MEDICATION, 0n, rxData.commitment());

        // Insert initial ACTIVE status at index 0
        const oldStatus = new PrescriptionStatusData({
          prescriptionHash: rxData.commitment(),
          status: RX_STATUS_ADJUDICATED,
          updatedByWalletId: prescriberWalletId,
          updatedAt: Field(20260201120000n),
          pharmacyWalletId,
          fillQuantity: Field(0),
          notesHash: Field(0),
        });
        forest.setLeaf(ForestDomain.TRANSACTION, 0n, oldStatus.commitment());

        // Build CredentialData
        const credentialData = new CredentialData({
          credentialType: CREDENTIAL_TYPE_PRESCRIPTION,
          forestRoot: forest.getForestRoot(),
          issuerWalletId: prescriberWalletId,
          subjectWalletId: pharmacyWalletId,
          issuedAt: dateToField('20260201'),
          expiresAt: dateToField('20270201'),
          revoked: Field(0),
        });

        // New status: FILLED
        const newStatus = new PrescriptionStatusData({
          prescriptionHash: rxData.commitment(),
          status: RX_STATUS_FILLED,
          updatedByWalletId: pharmacyWalletId,
          updatedAt: Field(20260205100000n),
          pharmacyWalletId,
          fillQuantity: quantityToField(30),
          notesHash: Field(0),
        });

        // Get witnesses BEFORE mutation
        const forestRoots = ForestRoots.fromForest(forest);
        const medWitness = forest.getWitness(ForestDomain.MEDICATION, 0n);
        const oldStatusWitness = forest.getWitness(ForestDomain.TRANSACTION, 0n);
        const newSlotWitness = forest.getWitness(ForestDomain.TRANSACTION, 1n);

        const result = await PrescriptionProgram.proveStatusUpdate(
          credentialData,
          rxData,
          oldStatus,
          newStatus,
          forestRoots,
          medWitness,
          oldStatusWitness,
          newSlotWitness,
          PRESCRIBER_QUAL,
          PRESCRIBER_ID_HASH,
          PRESCRIBER_EK_HASH,
        );

        const output = result.proof.publicOutput;
        expect(output.statusCode.toString()).toBe(RX_STATUS_FILLED.toString());
        expect(output.operationType.toString()).toBe('1');
        expect(output.memberWalletId.toString()).toBe(memberWalletId.toString());
      }, 60_000);

      it('proof verifies standalone', async () => {
        const rxData = createTestPrescriptionData();
        const forest = createTestForest();
        forest.setLeaf(ForestDomain.MEDICATION, 0n, rxData.commitment());

        // a full fill at pickup: FILLED (prepared) -> DISPENSED
        const oldStatus = new PrescriptionStatusData({
          prescriptionHash: rxData.commitment(),
          status: RX_STATUS_FILLED,
          updatedByWalletId: prescriberWalletId,
          updatedAt: Field(20260201120000n),
          pharmacyWalletId,
          fillQuantity: Field(0),
          notesHash: Field(0),
        });
        forest.setLeaf(ForestDomain.TRANSACTION, 0n, oldStatus.commitment());

        const credentialData = new CredentialData({
          credentialType: CREDENTIAL_TYPE_PRESCRIPTION,
          forestRoot: forest.getForestRoot(),
          issuerWalletId: prescriberWalletId,
          subjectWalletId: pharmacyWalletId,
          issuedAt: dateToField('20260201'),
          expiresAt: dateToField('20270201'),
          revoked: Field(0),
        });

        const newStatus = new PrescriptionStatusData({
          prescriptionHash: rxData.commitment(),
          status: RX_STATUS_DISPENSED,
          updatedByWalletId: pharmacyWalletId,
          updatedAt: Field(20260205100000n),
          pharmacyWalletId,
          fillQuantity: quantityToField(10),
          notesHash: Field(0),
        });

        const forestRoots = ForestRoots.fromForest(forest);
        const result = await PrescriptionProgram.proveStatusUpdate(
          credentialData, rxData, oldStatus, newStatus, forestRoots,
          forest.getWitness(ForestDomain.MEDICATION, 0n),
          forest.getWitness(ForestDomain.TRANSACTION, 0n),
          forest.getWitness(ForestDomain.TRANSACTION, 1n),
          PRESCRIBER_QUAL,
          PRESCRIBER_ID_HASH,
          PRESCRIBER_EK_HASH,
        );

        const ok = await PrescriptionProgram.verify(result.proof);
        expect(ok).toBe(true);
      }, 60_000);

      // A-148: a script handed over in parts proves FILLED -> PARTIALLY_FILLED for its first part and
      // PARTIALLY_FILLED -> DISPENSED for its last; the circuit refused both
      it.each([
        ['the first part of a prepared script', RX_STATUS_FILLED, RX_STATUS_PARTIALLY_FILLED],
        ['the last part of a partly filled script', RX_STATUS_PARTIALLY_FILLED, RX_STATUS_DISPENSED],
      ])('a partial fill proves and verifies: %s', async (_label, from, to) => {
        const rxData = createTestPrescriptionData();
        const forest = createTestForest();
        forest.setLeaf(ForestDomain.MEDICATION, 0n, rxData.commitment());
        const oldStatus = new PrescriptionStatusData({
          prescriptionHash: rxData.commitment(),
          status: from,
          updatedByWalletId: pharmacyWalletId,
          updatedAt: Field(20260205100000n),
          pharmacyWalletId,
          fillQuantity: Field(0),
          notesHash: Field(0),
        });
        forest.setLeaf(ForestDomain.TRANSACTION, 0n, oldStatus.commitment());
        const credentialData = new CredentialData({
          credentialType: CREDENTIAL_TYPE_PRESCRIPTION,
          forestRoot: forest.getForestRoot(),
          issuerWalletId: prescriberWalletId,
          subjectWalletId: pharmacyWalletId,
          issuedAt: dateToField('20260201'),
          expiresAt: dateToField('20270201'),
          revoked: Field(0),
        });
        const newStatus = new PrescriptionStatusData({
          prescriptionHash: rxData.commitment(),
          status: to,
          updatedByWalletId: pharmacyWalletId,
          updatedAt: Field(20260206100000n),
          pharmacyWalletId,
          fillQuantity: quantityToField(10),
          notesHash: Field(0),
        });
        const result = await PrescriptionProgram.proveStatusUpdate(
          credentialData, rxData, oldStatus, newStatus, ForestRoots.fromForest(forest),
          forest.getWitness(ForestDomain.MEDICATION, 0n),
          forest.getWitness(ForestDomain.TRANSACTION, 0n),
          forest.getWitness(ForestDomain.TRANSACTION, 1n),
          PRESCRIBER_QUAL,
          PRESCRIBER_ID_HASH,
          PRESCRIBER_EK_HASH,
        );
        expect(await PrescriptionProgram.verify(result.proof)).toBe(true);
        expect(result.proof.publicOutput.statusCode.toString()).toBe(to.toString());
      }, 120_000);

      it('rejects invalid transition (FILLED→ACTIVE)', async () => {
        const rxData = createTestPrescriptionData();
        const forest = createTestForest();
        forest.setLeaf(ForestDomain.MEDICATION, 0n, rxData.commitment());

        // Old status = FILLED
        const oldStatus = new PrescriptionStatusData({
          prescriptionHash: rxData.commitment(),
          status: RX_STATUS_FILLED,
          updatedByWalletId: pharmacyWalletId,
          updatedAt: Field(20260201120000n),
          pharmacyWalletId,
          fillQuantity: quantityToField(30),
          notesHash: Field(0),
        });
        forest.setLeaf(ForestDomain.TRANSACTION, 0n, oldStatus.commitment());

        const credentialData = new CredentialData({
          credentialType: CREDENTIAL_TYPE_PRESCRIPTION,
          forestRoot: forest.getForestRoot(),
          issuerWalletId: prescriberWalletId,
          subjectWalletId: pharmacyWalletId,
          issuedAt: dateToField('20260201'),
          expiresAt: dateToField('20270201'),
          revoked: Field(0),
        });

        // Try FILLED → ACTIVE (invalid)
        const newStatus = new PrescriptionStatusData({
          prescriptionHash: rxData.commitment(),
          status: RX_STATUS_ADJUDICATED,
          updatedByWalletId: pharmacyWalletId,
          updatedAt: Field(20260301120000n),
          pharmacyWalletId,
          fillQuantity: Field(0),
          notesHash: Field(0),
        });

        const forestRoots = ForestRoots.fromForest(forest);
        await expect(PrescriptionProgram.proveStatusUpdate(
          credentialData, rxData, oldStatus, newStatus, forestRoots,
          forest.getWitness(ForestDomain.MEDICATION, 0n),
          forest.getWitness(ForestDomain.TRANSACTION, 0n),
          forest.getWitness(ForestDomain.TRANSACTION, 1n),
          PRESCRIBER_QUAL,
          PRESCRIBER_ID_HASH,
          PRESCRIBER_EK_HASH,
        )).rejects.toThrow();
      }, 60_000);

      it('rejects wrong prescriptionHash', async () => {
        const rxData = createTestPrescriptionData();
        const forest = createTestForest();
        forest.setLeaf(ForestDomain.MEDICATION, 0n, rxData.commitment());

        const oldStatus = new PrescriptionStatusData({
          prescriptionHash: rxData.commitment(),
          status: RX_STATUS_ADJUDICATED,
          updatedByWalletId: prescriberWalletId,
          updatedAt: Field(20260201120000n),
          pharmacyWalletId,
          fillQuantity: Field(0),
          notesHash: Field(0),
        });
        forest.setLeaf(ForestDomain.TRANSACTION, 0n, oldStatus.commitment());

        const credentialData = new CredentialData({
          credentialType: CREDENTIAL_TYPE_PRESCRIPTION,
          forestRoot: forest.getForestRoot(),
          issuerWalletId: prescriberWalletId,
          subjectWalletId: pharmacyWalletId,
          issuedAt: dateToField('20260201'),
          expiresAt: dateToField('20270201'),
          revoked: Field(0),
        });

        // New status with WRONG prescriptionHash
        const newStatus = new PrescriptionStatusData({
          prescriptionHash: Field(999),
          status: RX_STATUS_FILLED,
          updatedByWalletId: pharmacyWalletId,
          updatedAt: Field(20260205100000n),
          pharmacyWalletId,
          fillQuantity: quantityToField(30),
          notesHash: Field(0),
        });

        const forestRoots = ForestRoots.fromForest(forest);
        await expect(PrescriptionProgram.proveStatusUpdate(
          credentialData, rxData, oldStatus, newStatus, forestRoots,
          forest.getWitness(ForestDomain.MEDICATION, 0n),
          forest.getWitness(ForestDomain.TRANSACTION, 0n),
          forest.getWitness(ForestDomain.TRANSACTION, 1n),
          PRESCRIBER_QUAL,
          PRESCRIBER_ID_HASH,
          PRESCRIBER_EK_HASH,
        )).rejects.toThrow();
      }, 60_000);

      it('rejects non-empty new slot', async () => {
        const rxData = createTestPrescriptionData();
        const forest = createTestForest();
        forest.setLeaf(ForestDomain.MEDICATION, 0n, rxData.commitment());

        const oldStatus = new PrescriptionStatusData({
          prescriptionHash: rxData.commitment(),
          status: RX_STATUS_ADJUDICATED,
          updatedByWalletId: prescriberWalletId,
          updatedAt: Field(20260201120000n),
          pharmacyWalletId,
          fillQuantity: Field(0),
          notesHash: Field(0),
        });
        forest.setLeaf(ForestDomain.TRANSACTION, 0n, oldStatus.commitment());

        // Put something in slot 1 (it should be empty)
        forest.setLeaf(ForestDomain.TRANSACTION, 1n, Field(42));

        const credentialData = new CredentialData({
          credentialType: CREDENTIAL_TYPE_PRESCRIPTION,
          forestRoot: forest.getForestRoot(),
          issuerWalletId: prescriberWalletId,
          subjectWalletId: pharmacyWalletId,
          issuedAt: dateToField('20260201'),
          expiresAt: dateToField('20270201'),
          revoked: Field(0),
        });

        const newStatus = new PrescriptionStatusData({
          prescriptionHash: rxData.commitment(),
          status: RX_STATUS_FILLED,
          updatedByWalletId: pharmacyWalletId,
          updatedAt: Field(20260205100000n),
          pharmacyWalletId,
          fillQuantity: quantityToField(30),
          notesHash: Field(0),
        });

        const forestRoots = ForestRoots.fromForest(forest);
        await expect(PrescriptionProgram.proveStatusUpdate(
          credentialData, rxData, oldStatus, newStatus, forestRoots,
          forest.getWitness(ForestDomain.MEDICATION, 0n),
          forest.getWitness(ForestDomain.TRANSACTION, 0n),
          forest.getWitness(ForestDomain.TRANSACTION, 1n),
          PRESCRIBER_QUAL,
          PRESCRIBER_ID_HASH,
          PRESCRIBER_EK_HASH,
        )).rejects.toThrow();
      }, 60_000);
    });

    // ── PrescriptionProgram — proveTransfer ─────────────

    describe('proveTransfer', () => {
      it('valid transfer generates proof', async () => {
        const rxData = createTestPrescriptionData();
        const forest = createTestForest();
        forest.setLeaf(ForestDomain.MEDICATION, 0n, rxData.commitment());

        const oldStatus = new PrescriptionStatusData({
          prescriptionHash: rxData.commitment(),
          status: RX_STATUS_ADJUDICATED,
          updatedByWalletId: prescriberWalletId,
          updatedAt: Field(20260201120000n),
          pharmacyWalletId,
          fillQuantity: Field(0),
          notesHash: Field(0),
        });
        forest.setLeaf(ForestDomain.TRANSACTION, 0n, oldStatus.commitment());

        const credentialData = new CredentialData({
          credentialType: CREDENTIAL_TYPE_PRESCRIPTION,
          forestRoot: forest.getForestRoot(),
          issuerWalletId: prescriberWalletId,
          subjectWalletId: pharmacyWalletId,
          issuedAt: dateToField('20260201'),
          expiresAt: dateToField('20270201'),
          revoked: Field(0),
        });

        const transferStatus = new PrescriptionStatusData({
          prescriptionHash: rxData.commitment(),
          status: RX_STATUS_TRANSFERRED,
          updatedByWalletId: pharmacyWalletId,
          updatedAt: Field(20260301120000n),
          pharmacyWalletId: pharmacy2WalletId,
          fillQuantity: Field(0),
          notesHash: Field(0),
        });

        const forestRoots = ForestRoots.fromForest(forest);
        const result = await PrescriptionProgram.proveTransfer(
          credentialData, rxData, oldStatus, transferStatus, forestRoots,
          forest.getWitness(ForestDomain.MEDICATION, 0n),
          forest.getWitness(ForestDomain.TRANSACTION, 0n),
          forest.getWitness(ForestDomain.TRANSACTION, 1n),
          pharmacy2WalletId,
          PRESCRIBER_QUAL,
          PRESCRIBER_ID_HASH,
          PRESCRIBER_EK_HASH,
        );

        const output = result.proof.publicOutput;
        expect(output.statusCode.toString()).toBe(RX_STATUS_TRANSFERRED.toString());
        expect(output.operationType.toString()).toBe('2');
        expect(output.pharmacyWalletId.toString()).toBe(pharmacy2WalletId.toString());
      }, 60_000);

      it('rejects transfer from terminal status', async () => {
        const rxData = createTestPrescriptionData();
        const forest = createTestForest();
        forest.setLeaf(ForestDomain.MEDICATION, 0n, rxData.commitment());

        // Old status = CANCELLED (terminal)
        const oldStatus = new PrescriptionStatusData({
          prescriptionHash: rxData.commitment(),
          status: RX_STATUS_CANCELLED,
          updatedByWalletId: prescriberWalletId,
          updatedAt: Field(20260201120000n),
          pharmacyWalletId,
          fillQuantity: Field(0),
          notesHash: Field(0),
        });
        forest.setLeaf(ForestDomain.TRANSACTION, 0n, oldStatus.commitment());

        const credentialData = new CredentialData({
          credentialType: CREDENTIAL_TYPE_PRESCRIPTION,
          forestRoot: forest.getForestRoot(),
          issuerWalletId: prescriberWalletId,
          subjectWalletId: pharmacyWalletId,
          issuedAt: dateToField('20260201'),
          expiresAt: dateToField('20270201'),
          revoked: Field(0),
        });

        const transferStatus = new PrescriptionStatusData({
          prescriptionHash: rxData.commitment(),
          status: RX_STATUS_TRANSFERRED,
          updatedByWalletId: pharmacyWalletId,
          updatedAt: Field(20260301120000n),
          pharmacyWalletId: pharmacy2WalletId,
          fillQuantity: Field(0),
          notesHash: Field(0),
        });

        const forestRoots = ForestRoots.fromForest(forest);
        await expect(PrescriptionProgram.proveTransfer(
          credentialData, rxData, oldStatus, transferStatus, forestRoots,
          forest.getWitness(ForestDomain.MEDICATION, 0n),
          forest.getWitness(ForestDomain.TRANSACTION, 0n),
          forest.getWitness(ForestDomain.TRANSACTION, 1n),
          pharmacy2WalletId,
          PRESCRIBER_QUAL,
          PRESCRIBER_ID_HASH,
          PRESCRIBER_EK_HASH,
        )).rejects.toThrow();
      }, 60_000);

      it('rejects mismatched dest pharmacy wallet ID', async () => {
        const rxData = createTestPrescriptionData();
        const forest = createTestForest();
        forest.setLeaf(ForestDomain.MEDICATION, 0n, rxData.commitment());

        const oldStatus = new PrescriptionStatusData({
          prescriptionHash: rxData.commitment(),
          status: RX_STATUS_ADJUDICATED,
          updatedByWalletId: prescriberWalletId,
          updatedAt: Field(20260201120000n),
          pharmacyWalletId,
          fillQuantity: Field(0),
          notesHash: Field(0),
        });
        forest.setLeaf(ForestDomain.TRANSACTION, 0n, oldStatus.commitment());

        const credentialData = new CredentialData({
          credentialType: CREDENTIAL_TYPE_PRESCRIPTION,
          forestRoot: forest.getForestRoot(),
          issuerWalletId: prescriberWalletId,
          subjectWalletId: pharmacyWalletId,
          issuedAt: dateToField('20260201'),
          expiresAt: dateToField('20270201'),
          revoked: Field(0),
        });

        // Transfer status says pharmacy2, but we pass a DIFFERENT dest
        const transferStatus = new PrescriptionStatusData({
          prescriptionHash: rxData.commitment(),
          status: RX_STATUS_TRANSFERRED,
          updatedByWalletId: pharmacyWalletId,
          updatedAt: Field(20260301120000n),
          pharmacyWalletId: pharmacy2WalletId,
          fillQuantity: Field(0),
          notesHash: Field(0),
        });

        const forestRoots = ForestRoots.fromForest(forest);
        // Pass wrong dest wallet ID (Field(999))
        await expect(PrescriptionProgram.proveTransfer(
          credentialData, rxData, oldStatus, transferStatus, forestRoots,
          forest.getWitness(ForestDomain.MEDICATION, 0n),
          forest.getWitness(ForestDomain.TRANSACTION, 0n),
          forest.getWitness(ForestDomain.TRANSACTION, 1n),
          Field(999),
          PRESCRIBER_QUAL,
          PRESCRIBER_ID_HASH,
          PRESCRIBER_EK_HASH,
        )).rejects.toThrow();
      }, 60_000);
    });
  });

  // ── CredentialProgram holding proofs ───────────────────────────

  describe('CredentialProgram holding proofs', () => {
    beforeAll(async () => {
      await ProofGateProgram.compile();
      await CredentialProgram.compile();
    }, 300_000);

    it('pharmacy proveHolding on prescription credential', async () => {
      // Set up pharmacy wallet
      const enrollmentKey = 'pharmacy-enroll-key-123';
      const { hashString: hs } = await import('../src/zkp/hash-utils.js');
      const pharmacyPreimage = [
        hs('PHARM-001'),
        hs('Test Pharmacy'),
        hs(enrollmentKey),
      ];
      const pharmacyId = Poseidon.hash([Field(2), ...pharmacyPreimage]);

      // Build prescription credential
      const rxData = createTestPrescriptionData();
      const forest = createTestForest();
      forest.setLeaf(ForestDomain.MEDICATION, 0n, rxData.commitment());
      const initStatus = new PrescriptionStatusData({
        prescriptionHash: rxData.commitment(),
        status: RX_STATUS_ADJUDICATED,
        updatedByWalletId: prescriberWalletId,
        updatedAt: Field(20260201120000n),
        pharmacyWalletId: pharmacyId,
        fillQuantity: Field(0),
        notesHash: Field(0),
      });
      forest.setLeaf(ForestDomain.TRANSACTION, 0n, initStatus.commitment());

      const credentialData = new CredentialData({
        credentialType: CREDENTIAL_TYPE_PRESCRIPTION,
        forestRoot: forest.getForestRoot(),
        issuerWalletId: prescriberWalletId,
        subjectWalletId: pharmacyId,
        issuedAt: dateToField('20260201'),
        expiresAt: dateToField('20270201'),
        revoked: Field(0),
      });

      // Mint into inventory
      const inventory = new CredentialInventory();
      inventory.mint(credentialData);

      // Generate ProofGateProof for pharmacy
      const pgResult = await ProofGateProgram.verifyPharmacy(
        pharmacyId,
        pharmacyPreimage[0]!,
        pharmacyPreimage[1]!,
        pharmacyPreimage[2]!,
      );

      // Prove holding
      const holdingResult = await CredentialProgram.proveHolding(
        pgResult.proof,
        credentialData,
        inventory.getWitness(0n),
        inventory.getRoot(),
      );

      const output = holdingResult.proof.publicOutput;
      expect(output.walletId.toString()).toBe(pharmacyId.toString());
      expect(output.operationType.toString()).toBe(CREDENTIAL_OP_VERIFY.toString());
    }, 120_000);

    it('pharmacy proveHoldingByType for CREDENTIAL_TYPE_PRESCRIPTION', async () => {
      const enrollmentKey = 'pharmacy-enroll-key-456';
      const { hashString: hs } = await import('../src/zkp/hash-utils.js');
      const pharmacyPreimage = [
        hs('PHARM-002'),
        hs('Another Pharmacy'),
        hs(enrollmentKey),
      ];
      const pharmacyId = Poseidon.hash([Field(2), ...pharmacyPreimage]);

      const rxData = createTestPrescriptionData();
      const forest = createTestForest();
      forest.setLeaf(ForestDomain.MEDICATION, 0n, rxData.commitment());
      const initStatus = new PrescriptionStatusData({
        prescriptionHash: rxData.commitment(),
        status: RX_STATUS_ADJUDICATED,
        updatedByWalletId: prescriberWalletId,
        updatedAt: Field(20260201120000n),
        pharmacyWalletId: pharmacyId,
        fillQuantity: Field(0),
        notesHash: Field(0),
      });
      forest.setLeaf(ForestDomain.TRANSACTION, 0n, initStatus.commitment());

      const credentialData = new CredentialData({
        credentialType: CREDENTIAL_TYPE_PRESCRIPTION,
        forestRoot: forest.getForestRoot(),
        issuerWalletId: prescriberWalletId,
        subjectWalletId: pharmacyId,
        issuedAt: dateToField('20260201'),
        expiresAt: dateToField('20270201'),
        revoked: Field(0),
      });

      const inventory = new CredentialInventory();
      inventory.mint(credentialData);

      const pgResult = await ProofGateProgram.verifyPharmacy(
        pharmacyId,
        pharmacyPreimage[0]!,
        pharmacyPreimage[1]!,
        pharmacyPreimage[2]!,
      );

      const result = await CredentialProgram.proveHoldingByType(
        pgResult.proof,
        credentialData,
        inventory.getWitness(0n),
        inventory.getRoot(),
        CREDENTIAL_TYPE_PRESCRIPTION,
      );

      expect(result.proof.publicOutput.credentialCommitment.toString())
        .toBe(credentialData.commitment().toString());
    }, 120_000);

    it('fullPrescriptionCheck end-to-end with real proofs', async () => {
      const enrollmentKey = 'pharmacy-enroll-key-789';
      const { hashString: hs } = await import('../src/zkp/hash-utils.js');
      const pharmacyPreimage = [
        hs('PHARM-003'),
        hs('Final Pharmacy'),
        hs(enrollmentKey),
      ];
      const pharmacyId = Poseidon.hash([Field(2), ...pharmacyPreimage]);

      const rxData = createTestPrescriptionData();
      const forest = createTestForest();
      forest.setLeaf(ForestDomain.MEDICATION, 0n, rxData.commitment());
      const initStatus = new PrescriptionStatusData({
        prescriptionHash: rxData.commitment(),
        status: RX_STATUS_ADJUDICATED,
        updatedByWalletId: prescriberWalletId,
        updatedAt: Field(20260201120000n),
        pharmacyWalletId: pharmacyId,
        fillQuantity: Field(0),
        notesHash: Field(0),
      });
      forest.setLeaf(ForestDomain.TRANSACTION, 0n, initStatus.commitment());

      const credentialData = new CredentialData({
        credentialType: CREDENTIAL_TYPE_PRESCRIPTION,
        forestRoot: forest.getForestRoot(),
        issuerWalletId: prescriberWalletId,
        subjectWalletId: pharmacyId,
        issuedAt: dateToField('20260201'),
        expiresAt: dateToField('20270201'),
        revoked: Field(0),
      });

      const inventory = new CredentialInventory();
      inventory.mint(credentialData);

      const pgResult = await ProofGateProgram.verifyPharmacy(
        pharmacyId,
        pharmacyPreimage[0]!,
        pharmacyPreimage[1]!,
        pharmacyPreimage[2]!,
      );

      const holdingResult = await CredentialProgram.proveHolding(
        pgResult.proof,
        credentialData,
        inventory.getWitness(0n),
        inventory.getRoot(),
      );

      const verifier = new PrescriptionVerificationService();
      const check = await verifier.fullPrescriptionCheck(
        holdingResult.proof,
        credentialData,
        rxData,
        forest,
        0n,
        dateToField('20260601'),
      );

      expect(check.holdingValid).toBe(true);
      expect(check.dataValid).toBe(true);
      expect(check.overallValid).toBe(true);
    }, 120_000);
  });

  // ── Messaging integration ───────────────────────────────

  describe('Messaging integration', () => {
    beforeAll(async () => {
      await MessagingProgram.compile();
    }, 120_000);

    it('prescriber sends encrypted prescription message to pharmacy', async () => {
      const store = new InMemoryStore();
      const msgService = new MessagingService(
        store,
        new MessageRegistry(),
        new DelegationRegistry(),
        new KeyRegistry(),
      );

      // Set up encryption keys
      const prescriberKeys = deriveEncryptionKeyPair('prescriber-enroll-001');
      const pharmacyKeys = deriveEncryptionKeyPair('pharmacy-enroll-001');

      msgService.registerEncryptionKey(0n, prescriberWalletId, prescriberKeys.publicKey);
      msgService.registerEncryptionKey(1n, pharmacyWalletId, pharmacyKeys.publicKey);

      // Prescription details as JSON
      const rxDetails = JSON.stringify({
        drugName: 'Lisinopril 10mg Tablet',
        ndc: '00071015523',
        sig: 'Take 1 tablet by mouth daily',
        interactions: [
          { drug: 'Ibuprofen', severity: 'Moderate', note: 'May reduce lisinopril effectiveness' },
        ],
      });

      // Send prescription message
      const result = await msgService.sendMessage(
        prescriberWalletId,
        pharmacyWalletId,
        rxDetails,
        MSG_TYPE_PRESCRIPTION,
        hashString('thread-rx-001'),
        prescriberKeys.privateKey,
        pharmacyKeys.publicKey,
      );

      expect(result.proof).toBeDefined();
      expect(result.messageData.messageType.toString()).toBe(MSG_TYPE_PRESCRIPTION.toString());
    }, 60_000);

    it('pharmacy sends status notification to member', async () => {
      const store = new InMemoryStore();
      const msgService = new MessagingService(
        store,
        new MessageRegistry(),
        new DelegationRegistry(),
        new KeyRegistry(),
      );

      const pharmacyKeys = deriveEncryptionKeyPair('pharmacy-enroll-002');
      const memberKeys = deriveEncryptionKeyPair('member-enroll-002');

      msgService.registerEncryptionKey(0n, pharmacyWalletId, pharmacyKeys.publicKey);
      msgService.registerEncryptionKey(1n, memberWalletId, memberKeys.publicKey);

      const notification = JSON.stringify({
        status: 'FILLED',
        message: 'Your prescription is ready for pickup',
        pharmacy: 'Pellam Apothecary',
        estimatedReadyTime: '2:30 PM',
        copay: '$10.00',
      });

      const result = await msgService.sendMessage(
        pharmacyWalletId,
        memberWalletId,
        notification,
        MSG_TYPE_NOTIFICATION,
        hashString('thread-rx-001'),
        pharmacyKeys.privateKey,
        memberKeys.publicKey,
      );

      // Member decrypts the message
      const { plaintext } = msgService.readMessage(
        result.messageIndex,
        memberKeys.privateKey,
        pharmacyKeys.publicKey,
        result.encryptedContent,
      );

      const parsed = JSON.parse(plaintext);
      expect(parsed.status).toBe('FILLED');
      expect(parsed.copay).toBe('$10.00');
    }, 60_000);
  });
});
