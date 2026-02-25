import { Field } from 'o1js';
import {
  GroupEnrollmentToken,
  buildGroupEnrollmentToken,
} from './group-enrollment-token.js';
import type { GroupEnrollmentTokenLocalData } from './group-enrollment-token.js';

/**
 * Token record — the TokenAuthority's internal tracking of a token.
 * Stores both the ZK-compatible struct and the raw local data.
 */
export interface TokenRecord {
  /** The ZK-compatible enrollment token */
  token: GroupEnrollmentToken;
  /** Raw local data (cleartext identifiers for lookups) */
  localData: GroupEnrollmentTokenLocalData;
  /** Token lifecycle status */
  status: 'unused' | 'consumed' | 'expired' | 'revoked';
  /** WalletId that consumed this token (if consumed) */
  consumedByWalletId?: string;
  /** ISO timestamp when consumed (if consumed) */
  consumedAt?: string;
}

/**
 * Token validation result.
 */
export interface TokenValidationResult {
  /** Whether the token is valid for enrollment */
  valid: boolean;
  /** Reason for invalidity (if valid=false) */
  reason?: string;
  /** The group ID from the token (if valid) */
  groupId?: string;
  /** The plan ID from the token (if valid) */
  planId?: string;
  /** The family ID from the token (if valid) */
  familyId?: string;
}

/**
 * TokenAuthority — employer-side token generation and management.
 *
 * The employer's HR system uses this to generate enrollment tokens
 * that authorize members to enroll without the insurer seeing PHI.
 *
 * Token lifecycle:
 *   1. generateToken() — employer creates token for an eligible employee
 *   2. Token distributed to employee (QR, email, portal)
 *   3. Token also sent to insurer (no PHI — just tokenId, groupId, planId)
 *   4. validateToken() — insurer checks token before enrollment
 *   5. consumeToken() — insurer marks token used after successful enrollment
 *   6. revokeToken() — employer can revoke unused tokens
 *
 * Security:
 *   - Tokens are one-time use (consumed after enrollment)
 *   - Tokens have expiration dates
 *   - Tokens contain NO PHI — only opaque hashed identifiers
 *   - The insurer sees (tokenId, groupId, planId, hashedEmployeeId)
 */
export class TokenAuthority {
  private tokens: Map<string, TokenRecord>;
  private nonceCounter: number;
  private issuer: string;

  constructor(issuer: string) {
    this.tokens = new Map();
    this.nonceCounter = 0;
    this.issuer = issuer;
  }

  /**
   * Generate a new enrollment token for an eligible employee.
   *
   * @param groupId — employer group ID
   * @param planId — benefit plan ID
   * @param employeeId — employee's internal ID (opaque to insurer)
   * @param familyId — family identifier (groups subscriber + dependents)
   * @param validUntil — expiration date as CCYYMMDD
   * @param tokenId — optional custom token ID (auto-generated if omitted)
   */
  generateToken(
    groupId: string,
    planId: string,
    employeeId: string,
    familyId: string,
    validUntil: string,
    tokenId?: string,
  ): { token: GroupEnrollmentToken; tokenId: string } {
    const id = tokenId ?? `TOKEN-${Date.now()}-${this.nonceCounter}`;
    const nonce = this.nonceCounter++;

    const localData: GroupEnrollmentTokenLocalData = {
      tokenId: id,
      groupId,
      planId,
      employeeId,
      familyId,
      validUntil,
      issuer: this.issuer,
      nonce,
    };

    const token = buildGroupEnrollmentToken(localData);
    const record: TokenRecord = {
      token,
      localData,
      status: 'unused',
    };

    this.tokens.set(id, record);

    return { token, tokenId: id };
  }

  /**
   * Validate a token for enrollment eligibility.
   *
   * Checks:
   *   1. Token exists
   *   2. Token has not been consumed, expired, or revoked
   *   3. Current date is before expiration
   *
   * @param tokenId — the token ID to validate
   * @param currentDate — current date as CCYYMMDD string
   */
  validateToken(
    tokenId: string,
    currentDate: string,
  ): TokenValidationResult {
    const record = this.tokens.get(tokenId);
    if (!record) {
      return { valid: false, reason: 'Token not found' };
    }

    if (record.status !== 'unused') {
      return { valid: false, reason: `Token already ${record.status}` };
    }

    // Check expiration
    const current = BigInt(currentDate);
    const expiry = BigInt(record.localData.validUntil);
    if (current > expiry) {
      record.status = 'expired';
      return { valid: false, reason: 'Token expired' };
    }

    return {
      valid: true,
      groupId: record.localData.groupId,
      planId: record.localData.planId,
      familyId: record.localData.familyId,
    };
  }

  /**
   * Mark a token as consumed after successful enrollment.
   *
   * @param tokenId — the token ID
   * @param walletId — the wallet ID that enrolled with this token
   */
  consumeToken(tokenId: string, walletId: Field): void {
    const record = this.tokens.get(tokenId);
    if (!record) throw new Error('Token not found');
    if (record.status !== 'unused') {
      throw new Error(`Cannot consume token: already ${record.status}`);
    }

    record.status = 'consumed';
    record.consumedByWalletId = walletId.toString();
    record.consumedAt = new Date().toISOString();
  }

  /**
   * Revoke an unused token (employer or insurer action).
   * Cannot revoke already-consumed tokens.
   */
  revokeToken(tokenId: string): void {
    const record = this.tokens.get(tokenId);
    if (!record) throw new Error('Token not found');
    if (record.status === 'consumed') {
      throw new Error('Cannot revoke consumed token');
    }

    record.status = 'revoked';
  }

  /** Get the internal token record (for inspection/debugging) */
  getTokenRecord(tokenId: string): TokenRecord | undefined {
    return this.tokens.get(tokenId);
  }

  /**
   * Look up a consumed token by its token ID hash.
   *
   * Used during wallet migration: the recovery card stores tokenIdHash
   * (Poseidon hash of tokenId). The insurer scans consumed tokens to find
   * the matching record, confirming the member's identity.
   *
   * @param tokenIdHash — Poseidon hash of the token ID (from recovery card)
   * @returns The matching token record, or undefined if not found
   */
  getTokenByHash(tokenIdHash: string): TokenRecord | undefined {
    for (const record of this.tokens.values()) {
      if (record.token.tokenIdHash.toString() === tokenIdHash) {
        return record;
      }
    }
    return undefined;
  }

  /** Get total number of tokens managed */
  get count(): number {
    return this.tokens.size;
  }

  /** Get the issuer identity */
  get issuerName(): string {
    return this.issuer;
  }
}
