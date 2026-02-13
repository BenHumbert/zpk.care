import { Field, Struct, Poseidon } from 'o1js';
import { hashString, dateToField, quantityToField } from '../zkp/hash-utils.js';

/**
 * PriorAuthData — a prior authorization approval record.
 *
 * Stored as a leaf in the MerkleForest ACCESS_CONTROL tree
 * (alongside EligibilityData at different leaf indices).
 *
 * When a medication requires PA (FormularyEntry.requiresPriorAuth == 1),
 * the pharmacy must prove a valid PA exists using AccessControlProgram.
 *
 * No PHI/PII — only hashes, wallet IDs (already hashed), dates, quantities.
 */
export class PriorAuthData extends Struct({
  /** Poseidon hash of NDC code (links to FormularyEntry.ndcHash) */
  ndcHash: Field,
  /** The member this PA is for (wallet ID — already a hash) */
  memberWalletId: Field,
  /** The prescriber who requested the PA (wallet ID — already a hash) */
  prescriberWalletId: Field,
  /** Date PA was approved (CCYYMMDD as number) */
  approvalDate: Field,
  /** Date PA expires (CCYYMMDD as number) */
  expirationDate: Field,
  /** Total approved quantity (scaled x1000 via quantityToField) */
  approvedQuantity: Field,
  /** Poseidon hash of the authorization code */
  authCodeHash: Field,
}) {
  /**
   * Produces a single commitment representing this prior authorization.
   * Stored as a Merkle leaf in the ACCESS_CONTROL tree.
   */
  commitment(): Field {
    return Poseidon.hash([
      this.ndcHash,
      this.memberWalletId,
      this.prescriberWalletId,
      this.approvalDate,
      this.expirationDate,
      this.approvedQuantity,
      this.authCodeHash,
    ]);
  }
}

/**
 * Raw prior authorization data from the insurer's system.
 */
export interface PriorAuthLocalData {
  /** NDC code of the medication */
  ndc: string;
  /** Member wallet ID as bigint string */
  memberWalletId: string;
  /** Prescriber wallet ID as bigint string */
  prescriberWalletId: string;
  /** Approval date as CCYYMMDD string */
  approvalDate: string;
  /** Expiration date as CCYYMMDD string */
  expirationDate: string;
  /** Approved quantity */
  approvedQuantity: number;
  /** Authorization code string */
  authorizationCode: string;
}

/**
 * Build a PriorAuthData from raw local data.
 */
export function buildPriorAuthData(local: PriorAuthLocalData): PriorAuthData {
  return new PriorAuthData({
    ndcHash: hashString(local.ndc),
    memberWalletId: Field(BigInt(local.memberWalletId)),
    prescriberWalletId: Field(BigInt(local.prescriberWalletId)),
    approvalDate: dateToField(local.approvalDate),
    expirationDate: dateToField(local.expirationDate),
    approvedQuantity: quantityToField(local.approvedQuantity),
    authCodeHash: hashString(local.authorizationCode),
  });
}
