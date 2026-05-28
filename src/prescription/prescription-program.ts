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

import { Field, Struct, Poseidon, ZkProgram } from 'o1js';
import { CredentialData, CREDENTIAL_TYPE_PRESCRIPTION } from '../credentials/credential-data.js';
import { ForestRoots } from '../eligibility/forest-roots.js';
import { ForestMerkleWitness } from '../zkp/merkle-forest.js';
import { DOMAIN_TAG_PRESCRIBER } from '../wallets/wallet-derivation.js';
import {
  PrescriptionData,
  PrescriptionStatusData,
  RX_STATUS_TRANSFERRED,
  assertValidStatusTransition,
} from './prescription-data.js';

// ─── PrescriptionOutput ─────────────────────────────────────────

/**
 * PrescriptionOutput — public output of PrescriptionProgram methods.
 *
 * Contains prescription identity, forest root transition, current pharmacy,
 * and status information. Used by verifiers and the admin pipeline.
 */
export class PrescriptionOutput extends Struct({
  /** Links to PrescriptionData.commitment() */
  prescriptionHash: Field,
  /** Forest root before the update */
  oldForestRoot: Field,
  /** Forest root after the update (TRANSACTION tree changed) */
  newForestRoot: Field,
  /** Current/destination pharmacy wallet ID */
  pharmacyWalletId: Field,
  /** New status code */
  statusCode: Field,
  /** Field(1) = statusUpdate, Field(2) = transfer */
  operationType: Field,
  /** Patient wallet ID (for member queries) */
  memberWalletId: Field,
}) {}

// ─── PrescriptionProgram ────────────────────────────────────────

/**
 * PrescriptionProgram — ZkProgram for prescription lifecycle (Use Case D).
 *
 * STANDALONE (no recursion) — proves prescription status transitions
 * and pharmacy-to-pharmacy transfers. Two methods:
 *
 *   1. proveStatusUpdate — valid status transition on a prescription credential
 *   2. proveTransfer — valid pharmacy-to-pharmacy transfer
 *
 * The forest's TRANSACTION tree stores append-only status entries.
 * Each status change adds a new leaf; the forest root changes,
 * which changes the credential commitment in the wallet inventory.
 */
export const PrescriptionProgram = ZkProgram({
  name: 'Prescription',
  publicOutput: PrescriptionOutput,

  methods: {
    /**
     * Prove a valid status transition on a prescription credential.
     *
     * Verification chain:
     *   1. Credential type is PRESCRIPTION, not revoked
     *   2. Forest root integrity (6 roots → forestRoot)
     *   3. PrescriptionData in MEDICATION tree
     *   4. Old status entry in TRANSACTION tree
     *   5. New TRANSACTION slot is empty
     *   6. Status transition is valid (state machine)
     *   7. New status links to correct prescription
     *   8. Compute new forest root
     */
    proveStatusUpdate: {
      privateInputs: [
        CredentialData,
        PrescriptionData,
        PrescriptionStatusData,      // old status entry
        PrescriptionStatusData,      // new status entry
        ForestRoots,
        ForestMerkleWitness,         // MEDICATION: prescription at leaf
        ForestMerkleWitness,         // TRANSACTION: old status at leaf N
        ForestMerkleWitness,         // TRANSACTION: new slot N+1 (empty)
        Field,                        // M4: prescriber qualifier
        Field,                        // M4: prescriber serviceProviderIdHash
        Field,                        // M4: prescriber enrollmentKeyHash
      ],
      async method(
        credentialData: CredentialData,
        prescriptionData: PrescriptionData,
        oldStatus: PrescriptionStatusData,
        newStatus: PrescriptionStatusData,
        forestRoots: ForestRoots,
        medicationWitness: ForestMerkleWitness,
        oldStatusWitness: ForestMerkleWitness,
        newSlotWitness: ForestMerkleWitness,
        prescriberQualifier: Field,
        prescriberServiceProviderIdHash: Field,
        prescriberEnrollmentKeyHash: Field,
      ) {
        // 1. Credential type is PRESCRIPTION
        credentialData.credentialType.assertEquals(
          CREDENTIAL_TYPE_PRESCRIPTION,
          'Credential type must be PRESCRIPTION',
        );

        // 2. Credential is not revoked
        credentialData.revoked.assertEquals(Field(0), 'Credential is revoked');

        // 2b. M4 fix: Verify prescriber wallet identity binding
        const computedPrescriberWalletId = Poseidon.hash([
          DOMAIN_TAG_PRESCRIBER,
          prescriberQualifier,
          prescriberServiceProviderIdHash,
          prescriberEnrollmentKeyHash,
        ]);
        computedPrescriberWalletId.assertEquals(
          prescriptionData.prescriberWalletId,
          'Prescriber wallet identity binding failed',
        );

        // 3. Forest root integrity
        const computedForestRoot = forestRoots.computeForestRoot();
        computedForestRoot.assertEquals(
          credentialData.forestRoot,
          'Forest root mismatch',
        );

        // 4. Prescription data in MEDICATION tree
        const rxCommitment = prescriptionData.commitment();
        medicationWitness
          .calculateRoot(rxCommitment)
          .assertEquals(
            forestRoots.medicationRoot,
            'Prescription not in MEDICATION tree',
          );

        // 5. Old status entry in TRANSACTION tree
        oldStatusWitness
          .calculateRoot(oldStatus.commitment())
          .assertEquals(
            forestRoots.transactionRoot,
            'Old status not in TRANSACTION tree',
          );

        // 6. New TRANSACTION slot is empty
        newSlotWitness
          .calculateRoot(Field(0))
          .assertEquals(
            forestRoots.transactionRoot,
            'New TRANSACTION slot is not empty',
          );

        // 7. Status transition is valid
        assertValidStatusTransition(oldStatus.status, newStatus.status);

        // 8. New status links to correct prescription
        newStatus.prescriptionHash.assertEquals(
          rxCommitment,
          'New status prescriptionHash mismatch',
        );

        // 9. Compute new TRANSACTION root and forest root
        const newTransactionRoot = newSlotWitness.calculateRoot(
          newStatus.commitment(),
        );
        const newForestRoot = Poseidon.hash([
          forestRoots.memberRoot,
          forestRoots.prescriberRoot,
          forestRoots.pharmacyRoot,
          forestRoots.medicationRoot,
          forestRoots.accessControlRoot,
          newTransactionRoot,
        ]);

        return {
          publicOutput: new PrescriptionOutput({
            prescriptionHash: rxCommitment,
            oldForestRoot: credentialData.forestRoot,
            newForestRoot,
            pharmacyWalletId: newStatus.pharmacyWalletId,
            statusCode: newStatus.status,
            operationType: Field(1),
            memberWalletId: prescriptionData.memberWalletId,
          }),
        };
      },
    },

    /**
     * Prove a valid pharmacy-to-pharmacy transfer.
     *
     * Same verification as proveStatusUpdate, plus:
     *   - New status must be TRANSFERRED
     *   - Destination pharmacy wallet ID must match
     */
    proveTransfer: {
      privateInputs: [
        CredentialData,
        PrescriptionData,
        PrescriptionStatusData,      // old status entry
        PrescriptionStatusData,      // transfer status entry
        ForestRoots,
        ForestMerkleWitness,         // MEDICATION: prescription
        ForestMerkleWitness,         // TRANSACTION: old status
        ForestMerkleWitness,         // TRANSACTION: transfer entry slot
        Field,                        // destination pharmacy wallet ID
        Field,                        // M4: prescriber qualifier
        Field,                        // M4: prescriber serviceProviderIdHash
        Field,                        // M4: prescriber enrollmentKeyHash
      ],
      async method(
        credentialData: CredentialData,
        prescriptionData: PrescriptionData,
        oldStatus: PrescriptionStatusData,
        transferStatus: PrescriptionStatusData,
        forestRoots: ForestRoots,
        medicationWitness: ForestMerkleWitness,
        oldStatusWitness: ForestMerkleWitness,
        transferSlotWitness: ForestMerkleWitness,
        destPharmacyWalletId: Field,
        prescriberQualifier: Field,
        prescriberServiceProviderIdHash: Field,
        prescriberEnrollmentKeyHash: Field,
      ) {
        // 1. Credential type is PRESCRIPTION
        credentialData.credentialType.assertEquals(
          CREDENTIAL_TYPE_PRESCRIPTION,
          'Credential type must be PRESCRIPTION',
        );

        // 2. Credential is not revoked
        credentialData.revoked.assertEquals(Field(0), 'Credential is revoked');

        // 2b. M4 fix: Verify prescriber wallet identity binding
        const computedPrescriberWalletId = Poseidon.hash([
          DOMAIN_TAG_PRESCRIBER,
          prescriberQualifier,
          prescriberServiceProviderIdHash,
          prescriberEnrollmentKeyHash,
        ]);
        computedPrescriberWalletId.assertEquals(
          prescriptionData.prescriberWalletId,
          'Prescriber wallet identity binding failed',
        );

        // 3. Forest root integrity
        const computedForestRoot = forestRoots.computeForestRoot();
        computedForestRoot.assertEquals(
          credentialData.forestRoot,
          'Forest root mismatch',
        );

        // 4. Prescription data in MEDICATION tree
        const rxCommitment = prescriptionData.commitment();
        medicationWitness
          .calculateRoot(rxCommitment)
          .assertEquals(
            forestRoots.medicationRoot,
            'Prescription not in MEDICATION tree',
          );

        // 5. Old status entry in TRANSACTION tree
        oldStatusWitness
          .calculateRoot(oldStatus.commitment())
          .assertEquals(
            forestRoots.transactionRoot,
            'Old status not in TRANSACTION tree',
          );

        // 6. Transfer slot is empty
        transferSlotWitness
          .calculateRoot(Field(0))
          .assertEquals(
            forestRoots.transactionRoot,
            'Transfer slot is not empty',
          );

        // 7. Status transition: old → TRANSFERRED
        assertValidStatusTransition(oldStatus.status, transferStatus.status);

        // 8. Transfer status must be TRANSFERRED
        transferStatus.status.assertEquals(
          RX_STATUS_TRANSFERRED,
          'Transfer status must be TRANSFERRED',
        );

        // 9. Transfer status links to correct prescription
        transferStatus.prescriptionHash.assertEquals(
          rxCommitment,
          'Transfer status prescriptionHash mismatch',
        );

        // 10. Transfer status pharmacy matches destination
        transferStatus.pharmacyWalletId.assertEquals(
          destPharmacyWalletId,
          'Transfer pharmacy does not match destination',
        );

        // 11. Compute new TRANSACTION root and forest root
        const newTransactionRoot = transferSlotWitness.calculateRoot(
          transferStatus.commitment(),
        );
        const newForestRoot = Poseidon.hash([
          forestRoots.memberRoot,
          forestRoots.prescriberRoot,
          forestRoots.pharmacyRoot,
          forestRoots.medicationRoot,
          forestRoots.accessControlRoot,
          newTransactionRoot,
        ]);

        return {
          publicOutput: new PrescriptionOutput({
            prescriptionHash: rxCommitment,
            oldForestRoot: credentialData.forestRoot,
            newForestRoot,
            pharmacyWalletId: destPharmacyWalletId,
            statusCode: RX_STATUS_TRANSFERRED,
            operationType: Field(2),
            memberWalletId: prescriptionData.memberWalletId,
          }),
        };
      },
    },
  },
});

/** Named class for SmartContract compatibility (reflect-metadata needs named class) */
export class PrescriptionProof extends ZkProgram.Proof(PrescriptionProgram) {}
