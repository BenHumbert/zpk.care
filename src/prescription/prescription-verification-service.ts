import { Field, Poseidon } from 'o1js';
import { NftData, NFT_TYPE_PRESCRIPTION } from '../nft/nft-data.js';
import { NftProgram, NftOperationProof, NFT_OP_VERIFY } from '../nft/nft-program.js';
import { MerkleForest, ForestDomain } from '../zkp/merkle-forest.js';
import { hashString } from '../zkp/hash-utils.js';
import {
  PrescriptionData,
  PrescriptionStatusData,
  EMERGENCY_FILL_HASH,
} from './prescription-data.js';
import { PrescriptionProgram, PrescriptionProof } from './prescription-program.js';

// ─── Result Types ───────────────────────────────────────────────

/**
 * Result of verifying pharmacy NFT holding.
 */
export interface PrescriptionHoldingResult {
  isValid: boolean;
  reason?: string;
  walletId?: Field;
  nftCommitment?: Field;
}

/**
 * Result of verifying prescription data against forest.
 */
export interface PrescriptionDataResult {
  isValid: boolean;
  reason?: string;
  ndcHash?: Field;
  prescriberWalletId?: Field;
  memberWalletId?: Field;
  quantityPrescribed?: Field;
  refillsAuthorized?: Field;
}

/**
 * A single entry in the prescription status history.
 */
export interface StatusHistoryEntry {
  /** Index in the TRANSACTION tree */
  index: number;
  /** Status code */
  status: string;
  /** Who updated */
  updatedBy: string;
  /** When updated */
  updatedAt: string;
  /** Pharmacy at this point */
  pharmacyWalletId: string;
  /** Amount dispensed (0 if none) */
  fillQuantity: string;
  /** Notes hash */
  notesHash: string;
}

/**
 * Result of a full prescription verification check.
 */
export interface FullPrescriptionCheckResult {
  holdingValid: boolean;
  dataValid: boolean;
  overallValid: boolean;
  details: string[];
}

// ─── PrescriptionVerificationService ────────────────────────────

/**
 * PrescriptionVerificationService — pharmacy-side + member prescription verification.
 *
 * Verifies:
 *   1. Pharmacy holds a valid PRESCRIPTION NFT (NftProgram proof)
 *   2. Prescription data matches the NFT's forest root
 *   3. Status proof transitions are valid
 *   4. Emergency flag detection
 *   5. Status history extraction from TRANSACTION tree
 *
 * All verification is OFFLINE — no internet required.
 *
 * Preconditions:
 *   await NftProgram.compile();           // for holding verification
 *   await PrescriptionProgram.compile();  // for status proof verification
 */
export class PrescriptionVerificationService {
  /**
   * Verify that a pharmacy holds a valid PRESCRIPTION NFT.
   *
   * Checks: NftProgram proof is valid, operation type is VERIFY.
   */
  async verifyPharmacyHolding(
    holdingProof: InstanceType<typeof NftOperationProof>,
  ): Promise<PrescriptionHoldingResult> {
    try {
      const ok = await NftProgram.verify(holdingProof);
      if (!ok) {
        return { isValid: false, reason: 'NftProgram proof verification failed' };
      }

      const output = holdingProof.publicOutput;

      // Check operation type is VERIFY
      if (output.operationType.toString() !== NFT_OP_VERIFY.toString()) {
        return { isValid: false, reason: 'Expected VERIFY operation type' };
      }

      return {
        isValid: true,
        walletId: output.walletId,
        nftCommitment: output.nftCommitment,
      };
    } catch (e) {
      return {
        isValid: false,
        reason: e instanceof Error ? e.message : 'Unknown error',
      };
    }
  }

  /**
   * Verify prescription data against the NFT's forest.
   *
   * Off-chain checks:
   *   1. NFT type is PRESCRIPTION
   *   2. NFT is not revoked
   *   3. Prescription not expired (currentDate <= expirationDate)
   *   4. Prescription commitment at correct leaf in MEDICATION tree
   *   5. Forest root matches NftData.forestRoot
   */
  verifyPrescriptionData(
    nftData: NftData,
    prescriptionData: PrescriptionData,
    forest: MerkleForest,
    rxLeafIndex: bigint,
    currentDate: Field,
  ): PrescriptionDataResult {
    // 1. Check NFT type
    if (nftData.nftType.toString() !== NFT_TYPE_PRESCRIPTION.toString()) {
      return { isValid: false, reason: 'NFT type is not PRESCRIPTION' };
    }

    // 2. Check not revoked
    if (nftData.revoked.toString() !== '0') {
      return { isValid: false, reason: 'NFT is revoked' };
    }

    // 3. Check prescription not expired
    const expiration = BigInt(nftData.expiresAt.toString());
    const current = BigInt(currentDate.toString());
    if (expiration > 0n && current > expiration) {
      return { isValid: false, reason: 'Prescription has expired' };
    }

    // 4. Prescription commitment at correct leaf in MEDICATION tree
    const storedLeaf = forest.getLeaf(ForestDomain.MEDICATION, rxLeafIndex);
    if (storedLeaf.toString() !== prescriptionData.commitment().toString()) {
      return { isValid: false, reason: 'Prescription not found in MEDICATION tree' };
    }

    // 5. Forest root matches NFT
    const forestRoot = forest.getForestRoot();
    if (forestRoot.toString() !== nftData.forestRoot.toString()) {
      return { isValid: false, reason: 'Forest root does not match NFT' };
    }

    return {
      isValid: true,
      ndcHash: prescriptionData.ndcHash,
      prescriberWalletId: prescriptionData.prescriberWalletId,
      memberWalletId: prescriptionData.memberWalletId,
      quantityPrescribed: prescriptionData.quantityPrescribed,
      refillsAuthorized: prescriptionData.refillsAuthorized,
    };
  }

  /**
   * Verify a PrescriptionProgram status update or transfer proof.
   */
  async verifyStatusProof(
    proof: InstanceType<typeof PrescriptionProof>,
  ): Promise<{ isValid: boolean; statusCode?: Field; operationType?: Field }> {
    try {
      const ok = await PrescriptionProgram.verify(proof);
      if (!ok) {
        return { isValid: false };
      }
      const output = proof.publicOutput;
      return {
        isValid: true,
        statusCode: output.statusCode,
        operationType: output.operationType,
      };
    } catch {
      return { isValid: false };
    }
  }

  /**
   * Extract ordered status history from the TRANSACTION tree.
   *
   * Reads leaves 0..statusCount-1 from the TRANSACTION tree.
   * Each leaf is a PrescriptionStatusData commitment.
   *
   * Note: returns raw field values since the actual PrescriptionStatusData
   * objects must be tracked locally (can't reconstruct from commitments).
   * This method returns the raw Fields for each status entry position.
   *
   * For full status tracking, the pharmacy maintains a local list of
   * PrescriptionStatusData objects alongside the forest.
   */
  extractStatusHistory(
    forest: MerkleForest,
    statusCount: number,
    statusEntries: PrescriptionStatusData[],
  ): StatusHistoryEntry[] {
    const history: StatusHistoryEntry[] = [];

    for (let i = 0; i < statusCount && i < statusEntries.length; i++) {
      const entry = statusEntries[i]!;

      // Verify the entry matches what's in the tree
      const treeLeaf = forest.getLeaf(ForestDomain.TRANSACTION, BigInt(i));
      if (treeLeaf.toString() !== entry.commitment().toString()) {
        continue; // Skip mismatched entries
      }

      history.push({
        index: i,
        status: entry.status.toString(),
        updatedBy: entry.updatedByWalletId.toString(),
        updatedAt: entry.updatedAt.toString(),
        pharmacyWalletId: entry.pharmacyWalletId.toString(),
        fillQuantity: entry.fillQuantity.toString(),
        notesHash: entry.notesHash.toString(),
      });
    }

    return history;
  }

  /**
   * Check if a prescription was flagged as an emergency fill.
   *
   * Reads the initial status entry (leaf 0) in the TRANSACTION tree
   * and checks if its notesHash matches EMERGENCY_FILL_HASH.
   */
  isEmergencyPrescription(
    forest: MerkleForest,
    initialStatus: PrescriptionStatusData,
  ): boolean {
    // Verify the initial status is at leaf 0
    const treeLeaf = forest.getLeaf(ForestDomain.TRANSACTION, 0n);
    if (treeLeaf.toString() !== initialStatus.commitment().toString()) {
      return false;
    }

    return initialStatus.notesHash.toString() === EMERGENCY_FILL_HASH.toString();
  }

  /**
   * Full prescription verification check.
   *
   * Combines NFT holding verification + prescription data verification.
   */
  async fullPrescriptionCheck(
    holdingProof: InstanceType<typeof NftOperationProof>,
    nftData: NftData,
    prescriptionData: PrescriptionData,
    forest: MerkleForest,
    rxLeafIndex: bigint,
    currentDate: Field,
  ): Promise<FullPrescriptionCheckResult> {
    const details: string[] = [];

    // 1. Verify NFT holding
    const holdingResult = await this.verifyPharmacyHolding(holdingProof);
    details.push(
      holdingResult.isValid
        ? 'NFT holding: verified'
        : `NFT holding: FAILED (${holdingResult.reason})`,
    );

    // 2. Verify prescription data
    const dataResult = this.verifyPrescriptionData(
      nftData,
      prescriptionData,
      forest,
      rxLeafIndex,
      currentDate,
    );
    details.push(
      dataResult.isValid
        ? `Prescription data: verified (NDC: ${dataResult.ndcHash})`
        : `Prescription data: FAILED (${dataResult.reason})`,
    );

    const overallValid = holdingResult.isValid && dataResult.isValid;

    return {
      holdingValid: holdingResult.isValid,
      dataValid: dataResult.isValid,
      overallValid,
      details,
    };
  }
}
