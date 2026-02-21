import { Field, Struct, Poseidon } from 'o1js';
import { hashString, dateToField } from '../zkp/hash-utils.js';

/**
 * RepEnrollmentToken — lightweight enrollment token for representatives.
 *
 * Unlike GroupEnrollmentToken (employer → member), this token is issued
 * by the insurer directly to a representative after a member initiates
 * an AOR. No employer involvement.
 *
 * Key differences from GroupEnrollmentToken:
 *   - No groupId or planId (reps don't have benefit plans)
 *   - Contains memberWalletId (who authorized this rep)
 *   - Contains scopeFlags (what the rep will be authorized for)
 *   - Short-lived: 24h expiry (vs 30-day for group tokens)
 *
 * Flow:
 *   1. Member sends AOR_INITIATE message
 *   2. Insurer generates RepEnrollmentToken
 *   3. Token sent to rep out-of-band (email/SMS)
 *   4. Rep creates enrollment key, derives wallet, submits token
 *   5. Insurer validates token, registers rep wallet (no credential, no lifecycle)
 */
export class RepEnrollmentToken extends Struct({
  /** Poseidon hash of unique token ID */
  tokenIdHash: Field,
  /** The member's wallet ID (who initiated the AOR) */
  memberWalletId: Field,
  /** Authorized scope flags (bitfield: 1=read, 2=write, 4=pickup) */
  scopeFlags: Field,
  /** Expiration date as numeric CCYYMMDD (24h from issuance) */
  validUntil: Field,
  /** Poseidon hash of insurer identity (token issuer) */
  issuerHash: Field,
  /** Unique nonce for replay prevention */
  nonce: Field,
}) {
  /**
   * Produces a single commitment representing this token.
   */
  commitment(): Field {
    return Poseidon.hash([
      this.tokenIdHash,
      this.memberWalletId,
      this.scopeFlags,
      this.validUntil,
      this.issuerHash,
      this.nonce,
    ]);
  }
}

/**
 * Raw rep enrollment token data before on-chain encoding.
 */
export interface RepEnrollmentTokenLocalData {
  /** Unique token ID (UUID) */
  tokenId: string;
  /** Member wallet ID as bigint string */
  memberWalletId: string;
  /** Scope flags (bitfield: 1=read, 2=write, 4=pickup) */
  scopeFlags: number;
  /** Expiration as CCYYMMDD string */
  validUntil: string;
  /** Insurer identity */
  issuer: string;
  /** Unique nonce */
  nonce: number;
}

/**
 * Build a RepEnrollmentToken from raw local data.
 */
export function buildRepEnrollmentToken(
  local: RepEnrollmentTokenLocalData,
): RepEnrollmentToken {
  return new RepEnrollmentToken({
    tokenIdHash: hashString(local.tokenId),
    memberWalletId: Field(BigInt(local.memberWalletId)),
    scopeFlags: Field(BigInt(local.scopeFlags)),
    validUntil: dateToField(local.validUntil),
    issuerHash: hashString(local.issuer),
    nonce: Field(BigInt(local.nonce)),
  });
}
