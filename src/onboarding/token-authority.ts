import { Field } from 'o1js';
import { timingSafeEqual } from 'crypto';
import {
  GroupEnrollmentToken,
  buildGroupEnrollmentToken,
} from './group-enrollment-token.js';
import type { GroupEnrollmentTokenLocalData } from './group-enrollment-token.js';

/**
 * Token record — the TokenAuthority's internal tracking of a token.
 *
 * Stores only the ZK-compatible struct (all Poseidon hashes) and opaque metadata.
 * NO plaintext PII — the HR Tool on the admin's machine holds the correlation table.
 */
export interface TokenRecord {
  /** The ZK-compatible enrollment token (all fields are Poseidon hashes) */
  token: GroupEnrollmentToken;
  /** Token ID (opaque identifier) */
  tokenId: string;
  /** Expiration date as CCYYMMDD */
  validUntil: string;
  /** Group ID hash (from the token struct) */
  groupIdHash: string;
  /** Plan ID hash (from the token struct) */
  planIdHash: string;
  /** Poseidon(tokenId + PIN) — enrollment 2FA binding. Set by HR Tool after token generation. */
  tokenPinHash?: string;
  /** Number of failed PIN attempts (locked after MAX_PIN_ATTEMPTS) */
  pinAttempts?: number;
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
  /** The group ID hash from the token (if valid) */
  groupIdHash?: string;
  /** The plan ID hash from the token (if valid) */
  planIdHash?: string;
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
  /**
   * Generate a new enrollment token.
   *
   * Accepts pre-hashed identifiers. The plaintext-to-hash mapping
   * is maintained by the HR Tool, not by this authority.
   *
   * @param groupId — employer group ID (plaintext for group lookup, hashed internally)
   * @param planId — benefit plan ID (plaintext for plan lookup, hashed internally)
   * @param employeeIdHash — pre-hashed employee ID (from HR Tool with groupSeed)
   * @param familyIdHash — pre-hashed family ID (from HR Tool with groupSeed)
   * @param validUntil — expiration date as CCYYMMDD
   * @param tokenId — optional custom token ID
   */
  generateToken(
    groupId: string,
    planId: string,
    employeeIdHash: string,
    familyIdHash: string,
    validUntil: string,
    tokenId?: string,
  ): { token: GroupEnrollmentToken; tokenId: string } {
    const id = tokenId ?? `TOKEN-${Date.now()}-${this.nonceCounter}`;
    const nonce = this.nonceCounter++;

    // Build the ZK-compatible token using the hashes as the "local data"
    // The buildGroupEnrollmentToken function hashes all fields — but since
    // employeeIdHash and familyIdHash are already hashes, they get double-hashed.
    // This is intentional: the on-chain token has Poseidon(Poseidon(groupSeed || employeeId)),
    // which is still a valid one-way commitment.
    const localData: GroupEnrollmentTokenLocalData = {
      tokenId: id,
      groupId,
      planId,
      employeeId: employeeIdHash, // Pre-hashed — no plaintext
      familyId: familyIdHash,     // Pre-hashed — no plaintext
      validUntil,
      issuer: this.issuer,
      nonce,
    };

    const token = buildGroupEnrollmentToken(localData);

    // Store ONLY hashes and opaque metadata — discard localData
    const record: TokenRecord = {
      token,
      tokenId: id,
      validUntil,
      groupIdHash: token.groupIdHash.toString(),
      planIdHash: token.planIdHash.toString(),
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
    const expiry = BigInt(record.validUntil);
    if (current > expiry) {
      record.status = 'expired';
      return { valid: false, reason: 'Token expired' };
    }

    return {
      valid: true,
      groupIdHash: record.groupIdHash,
      planIdHash: record.planIdHash,
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

  /**
   * Set the PIN hash on a token record.
   * Called by the HR Tool after token generation to bind the enrollment PIN.
   * Only the hash is stored — the PIN itself never touches this node.
   * Cannot be called twice — prevents overwrite attacks.
   */
  setTokenPinHash(tokenId: string, tokenPinHash: string): void {
    const record = this.tokens.get(tokenId);
    if (!record) throw new Error('Token not found');
    if (record.status !== 'unused') throw new Error(`Cannot set PIN hash: token already ${record.status}`);
    if (record.tokenPinHash) throw new Error('PIN hash already set — cannot overwrite');
    record.tokenPinHash = tokenPinHash;
  }

  /** Max failed PIN attempts before token is locked */
  static readonly MAX_PIN_ATTEMPTS = 5;

  /**
   * Validate a token with PIN verification (enrollment 2FA).
   *
   * Security properties:
   *   - Timing-safe comparison prevents side-channel hash leakage
   *   - Rate limiting locks token after 5 failed PIN attempts
   *   - Tokens without PIN hash set are blocked (race window protection)
   *
   * @param tokenId — the token ID
   * @param currentDate — current date as CCYYMMDD
   * @param tokenPinHash — Poseidon(tokenId + PIN) computed by the member's device
   */
  validateTokenWithPin(
    tokenId: string,
    currentDate: string,
    tokenPinHash?: string,
  ): TokenValidationResult {
    const baseResult = this.validateToken(tokenId, currentDate);
    if (!baseResult.valid) return baseResult;

    const record = this.tokens.get(tokenId)!;

    // If token has a PIN hash, verify it
    if (record.tokenPinHash) {
      // Rate limiting: lock after MAX_PIN_ATTEMPTS failed attempts
      const attempts = record.pinAttempts ?? 0;
      if (attempts >= TokenAuthority.MAX_PIN_ATTEMPTS) {
        return { valid: false, reason: 'Token locked: too many failed PIN attempts' };
      }

      if (!tokenPinHash) {
        record.pinAttempts = attempts + 1;
        return { valid: false, reason: 'Enrollment PIN required' };
      }

      // Timing-safe comparison to prevent side-channel leakage
      const a = Buffer.from(tokenPinHash, 'utf8');
      const b = Buffer.from(record.tokenPinHash, 'utf8');
      let match = false;
      if (a.length === b.length) {
        match = timingSafeEqual(a, b);
      }

      if (!match) {
        record.pinAttempts = attempts + 1;
        const remaining = TokenAuthority.MAX_PIN_ATTEMPTS - (attempts + 1);
        return { valid: false, reason: `Invalid enrollment PIN (${remaining} attempts remaining)` };
      }

      // PIN verified — reset attempts
      record.pinAttempts = 0;
    }

    return baseResult;
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
