import { Field, Struct, Poseidon } from 'o1js';
import { hashString, dateToField } from '../zkp/hash-utils.js';

/**
 * Token Status Constants
 *
 * Lifecycle of a GroupEnrollmentToken:
 *   UNUSED    — freshly generated, awaiting member enrollment
 *   CONSUMED  — member submitted walletId with this token, enrollment complete
 *   EXPIRED   — validUntil date passed without consumption
 *   REVOKED   — employer or insurer manually invalidated the token
 */
export const TOKEN_STATUS_UNUSED = Field(0);
export const TOKEN_STATUS_CONSUMED = Field(1);
export const TOKEN_STATUS_EXPIRED = Field(2);
export const TOKEN_STATUS_REVOKED = Field(3);

/**
 * GroupEnrollmentToken — three-party enrollment ceremony token.
 *
 * Issued by the employer (TokenAuthority) to authorize a member to enroll.
 * Contains NO PHI/PII — only hashed identifiers and dates.
 *
 * Flow:
 *   1. Employer generates token for each eligible employee
 *   2. Token sent to employee (QR code, email, HR portal)
 *   3. Token also sent to insurer (no PHI — just tokenId, groupId, planId)
 *   4. Member presents token + their walletId to insurer
 *   5. Insurer validates token, registers wallet, mints eligibility credential
 *
 * The token binds an opaque employee identity to a specific group and plan
 * without the insurer ever seeing the employee's name, DOB, or other PHI.
 */
export class GroupEnrollmentToken extends Struct({
  /** Poseidon hash of unique token ID */
  tokenIdHash: Field,
  /** Poseidon hash of employer group ID */
  groupIdHash: Field,
  /** Poseidon hash of benefit plan ID */
  planIdHash: Field,
  /** Poseidon hash of employee ID (opaque to insurer) */
  employeeIdHash: Field,
  /** Poseidon hash of family ID (groups subscriber + dependents) */
  familyIdHash: Field,
  /** Expiration date as numeric CCYYMMDD */
  validUntil: Field,
  /** Poseidon hash of employer identity (token issuer) */
  issuerHash: Field,
  /** Unique nonce for replay prevention */
  nonce: Field,
}) {
  /**
   * Produces a single commitment representing this token.
   * Can be used for on-chain token registry verification in future.
   */
  commitment(): Field {
    return Poseidon.hash([
      this.tokenIdHash,
      this.groupIdHash,
      this.planIdHash,
      this.employeeIdHash,
      this.familyIdHash,
      this.validUntil,
      this.issuerHash,
      this.nonce,
    ]);
  }
}

/**
 * Raw enrollment token data from the employer's HR system.
 * Contains cleartext identifiers — never stored on-chain.
 */
export interface GroupEnrollmentTokenLocalData {
  /** Unique token ID (UUID or employer-generated) */
  tokenId: string;
  /** Employer group ID */
  groupId: string;
  /** Benefit plan ID */
  planId: string;
  /** Employee ID (opaque to insurer — employer's internal ID) */
  employeeId: string;
  /** Family ID — groups subscriber + dependents under one identifier */
  familyId: string;
  /** Expiration date as CCYYMMDD string */
  validUntil: string;
  /** Employer identity (name or ID) */
  issuer: string;
  /** Unique nonce (auto-incremented by TokenAuthority) */
  nonce: number;
}

/**
 * Build a GroupEnrollmentToken from raw local data.
 * Hashes all string fields, converts dates and nonce to Fields.
 */
export function buildGroupEnrollmentToken(
  local: GroupEnrollmentTokenLocalData,
): GroupEnrollmentToken {
  return new GroupEnrollmentToken({
    tokenIdHash: hashString(local.tokenId),
    groupIdHash: hashString(local.groupId),
    planIdHash: hashString(local.planId),
    employeeIdHash: hashString(local.employeeId),
    familyIdHash: hashString(local.familyId),
    validUntil: dateToField(local.validUntil),
    issuerHash: hashString(local.issuer),
    nonce: Field(BigInt(local.nonce)),
  });
}
