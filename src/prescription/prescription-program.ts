import { Field, Struct, Poseidon, ZkProgram } from 'o1js';
import { NftData, NFT_TYPE_PRESCRIPTION } from '../nft/nft-data.js';
import { ForestRoots } from '../eligibility/forest-roots.js';
import { ForestMerkleWitness } from '../zkp/merkle-forest.js';
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
 *   1. proveStatusUpdate — valid status transition on a prescription NFT
 *   2. proveTransfer — valid pharmacy-to-pharmacy transfer
 *
 * The forest's TRANSACTION tree stores append-only status entries.
 * Each status change adds a new leaf; the forest root changes,
 * which changes the NFT commitment in the wallet inventory.
 */
export const PrescriptionProgram = ZkProgram({
  name: 'Prescription',
  publicOutput: PrescriptionOutput,

  methods: {
    /**
     * Prove a valid status transition on a prescription NFT.
     *
     * Verification chain:
     *   1. NFT type is PRESCRIPTION, not revoked
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
        NftData,
        PrescriptionData,
        PrescriptionStatusData,      // old status entry
        PrescriptionStatusData,      // new status entry
        ForestRoots,
        ForestMerkleWitness,         // MEDICATION: prescription at leaf
        ForestMerkleWitness,         // TRANSACTION: old status at leaf N
        ForestMerkleWitness,         // TRANSACTION: new slot N+1 (empty)
      ],
      async method(
        nftData: NftData,
        prescriptionData: PrescriptionData,
        oldStatus: PrescriptionStatusData,
        newStatus: PrescriptionStatusData,
        forestRoots: ForestRoots,
        medicationWitness: ForestMerkleWitness,
        oldStatusWitness: ForestMerkleWitness,
        newSlotWitness: ForestMerkleWitness,
      ) {
        // 1. NFT type is PRESCRIPTION
        nftData.nftType.assertEquals(
          NFT_TYPE_PRESCRIPTION,
          'NFT type must be PRESCRIPTION',
        );

        // 2. NFT is not revoked
        nftData.revoked.assertEquals(Field(0), 'NFT is revoked');

        // 3. Forest root integrity
        const computedForestRoot = forestRoots.computeForestRoot();
        computedForestRoot.assertEquals(
          nftData.forestRoot,
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
            oldForestRoot: nftData.forestRoot,
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
        NftData,
        PrescriptionData,
        PrescriptionStatusData,      // old status entry
        PrescriptionStatusData,      // transfer status entry
        ForestRoots,
        ForestMerkleWitness,         // MEDICATION: prescription
        ForestMerkleWitness,         // TRANSACTION: old status
        ForestMerkleWitness,         // TRANSACTION: transfer entry slot
        Field,                        // destination pharmacy wallet ID
      ],
      async method(
        nftData: NftData,
        prescriptionData: PrescriptionData,
        oldStatus: PrescriptionStatusData,
        transferStatus: PrescriptionStatusData,
        forestRoots: ForestRoots,
        medicationWitness: ForestMerkleWitness,
        oldStatusWitness: ForestMerkleWitness,
        transferSlotWitness: ForestMerkleWitness,
        destPharmacyWalletId: Field,
      ) {
        // 1. NFT type is PRESCRIPTION
        nftData.nftType.assertEquals(
          NFT_TYPE_PRESCRIPTION,
          'NFT type must be PRESCRIPTION',
        );

        // 2. NFT is not revoked
        nftData.revoked.assertEquals(Field(0), 'NFT is revoked');

        // 3. Forest root integrity
        const computedForestRoot = forestRoots.computeForestRoot();
        computedForestRoot.assertEquals(
          nftData.forestRoot,
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
            oldForestRoot: nftData.forestRoot,
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
