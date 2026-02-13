import { Field } from 'o1js';
import { dateToField } from '../zkp/hash-utils.js';
import { DelegationData, REL_APPOINTED_REPRESENTATIVE, SCOPE_PICKUP, SCOPE_WRITE } from './delegation-data.js';
import { MessageRegistry, DelegationRegistry } from './message-registry.js';
import {
  AOR_DEFAULT_VALIDITY_DAYS,
  AOR_RATE_LIMIT_MS,
  PICKUP_COOLDOWN_MS,
  OFFLINE_TTL_MS,
  MSG_TYPE_AOR_INITIATE,
  buildAorCommitment,
  buildAorConfirmationHash,
  validateAorDocument,
} from './aor-data.js';
import type { AorLocalData, AorValidationResult } from './aor-data.js';

// ─── Result Types ────────────────────────────────────────────

/**
 * Result of an AOR initiation.
 */
export interface AorInitiationResult {
  /** The AOR document commitment (Poseidon hash) */
  aorCommitment: Field;
  /** Validation result for the document */
  validation: AorValidationResult;
  /** Whether the member is rate-limited (true = blocked) */
  rateLimited: boolean;
}

/**
 * Result of building a delegation from an approved AOR.
 */
export interface AorDelegationResult {
  /** The built DelegationData (ready for registry insertion) */
  delegationData: DelegationData;
  /** The AOR commitment stored in delegationHash */
  aorCommitment: Field;
  /** Computed expiration date (CCYYMMDD) */
  expirationDate: string;
}

/**
 * Pickup eligibility check result.
 */
export interface PickupEligibilityResult {
  eligible: boolean;
  reason: string;
  /** Time remaining until pickup is eligible (ms), 0 if eligible */
  cooldownRemainingMs: number;
}

/**
 * Offline credential validity result.
 */
export interface OfflineValidityResult {
  valid: boolean;
  reason: string;
  /** TTL that applies for this scope (ms) */
  ttlMs: number;
  /** How stale the chain state is (ms) */
  stalenessMs: number;
}

/**
 * Result of an AOR revocation.
 */
export interface AorRevocationResult {
  /** Whether the revocation is valid */
  valid: boolean;
  /** Reason if invalid */
  reason: string;
  /** The delegation index that was (or would be) revoked */
  delegationIndex: bigint;
  /** New delegation registry root after revocation (only set if valid) */
  newDelegationRoot?: Field;
}

// ─── Service ─────────────────────────────────────────────────

/**
 * AorService — Appointment of Representative workflow orchestration.
 *
 * Manages the multi-step AOR lifecycle:
 *   1. Member initiates AOR (validates document + rate limit)
 *   2. Rep completes their sections
 *   3. Member confirms the specific representative
 *   4. Insurer approves → delegation created
 *   5. Cool-down period before PICKUP scope activates
 *   6. Revocation at any time
 *
 * All methods are static — no state, no side effects, fully offline.
 * The actual L7 message sending is done by MessagingService.
 * This service handles AOR-specific validation and construction.
 *
 * Security defenses built in:
 *   - Two-message confirmation (INITIATE + CONFIRMED from member wallet)
 *   - 24h rate limit per member
 *   - 48h cool-down before PICKUP activates
 *   - Scope-based offline TTL (READ:72h, WRITE:24h, PICKUP:4h)
 *   - Immutable scope (no escalation without new AOR)
 */
export class AorService {
  /**
   * Step 1: Validate and prepare an AOR initiation.
   *
   * Called by the member's device. Validates the AOR document (Section 1)
   * and checks rate limiting before allowing the initiation.
   *
   * @param aorLocal — the AOR document (at least Section 1 filled)
   * @param memberWalletId — the member's wallet ID
   * @param messageRegistry — the message registry (for rate limit check)
   * @param currentTimestamp — current time in ms (for rate limit)
   */
  static prepareInitiation(
    aorLocal: AorLocalData,
    memberWalletId: Field,
    messageRegistry: MessageRegistry,
    currentTimestamp: number,
  ): AorInitiationResult {
    // Check rate limit: scan for recent AOR_INITIATE from this member
    const rateLimited = AorService.isRateLimited(
      memberWalletId,
      messageRegistry,
      currentTimestamp,
    );

    // Validate document (at minimum, Section 1 must be complete)
    const partialAor: AorLocalData = {
      ...aorLocal,
      // Section 2 may not be filled yet during initiation
      repFullName: aorLocal.repFullName || 'PENDING',
      repProfessionalStatus: aorLocal.repProfessionalStatus || 'PENDING',
      repPhone: aorLocal.repPhone || 'PENDING',
      repAddress: aorLocal.repAddress || 'PENDING',
      repSignature: aorLocal.repSignature || 'PENDING',
      repSignedDate: aorLocal.repSignedDate || aorLocal.partySignedDate,
    };

    // Only validate Section 1 fields for initiation
    const errors: string[] = [];
    if (!aorLocal.partyFullName) errors.push('Section 1: Party full name is required');
    if (!aorLocal.partyIdentifier) errors.push('Section 1: Party identifier is required');
    if (!aorLocal.partyAddress) errors.push('Section 1: Party address is required');
    if (!aorLocal.partyPhone) errors.push('Section 1: Party phone is required');
    if (!aorLocal.partySignature) errors.push('Section 1: Party signature is required');
    if (!aorLocal.partySignedDate) errors.push('Section 1: Party signed date is required');

    const validation: AorValidationResult = { valid: errors.length === 0, errors };

    // Build commitment from whatever we have
    const aorCommitment = buildAorCommitment(partialAor);

    return { aorCommitment, validation, rateLimited };
  }

  /**
   * Step 2: Validate a completed AOR document (all sections).
   *
   * Called when the representative submits their sections (2-4).
   * Validates the full CMS-1696 document.
   */
  static validateCompletion(aorLocal: AorLocalData): AorValidationResult {
    return validateAorDocument(aorLocal);
  }

  /**
   * Step 3: Build the confirmation hash for the member to sign.
   *
   * The member sends this as contentHash in their AOR_CONFIRMED message,
   * cryptographically binding their wallet to the specific representative.
   *
   * @param memberWalletId — member's wallet ID
   * @param repWalletId — representative's wallet ID
   * @param aorCommitment — AOR document commitment
   * @param scopeFlags — authorized scope flags
   */
  static buildConfirmationHash(
    memberWalletId: Field,
    repWalletId: Field,
    aorCommitment: Field,
    scopeFlags: Field,
  ): Field {
    return buildAorConfirmationHash(memberWalletId, repWalletId, aorCommitment, scopeFlags);
  }

  /**
   * Step 4: Build delegation data for an approved AOR.
   *
   * Called by the insurer after both member messages (INITIATE + CONFIRMED)
   * are verified. Creates the DelegationData for registry insertion.
   *
   * @param memberWalletId — member (delegator) wallet ID
   * @param repWalletId — representative (delegate) wallet ID
   * @param scopeFlags — authorized scope (bitfield)
   * @param effectiveDateStr — effective date as CCYYMMDD string
   * @param aorCommitment — the AOR document commitment
   * @param validityDays — override default 365-day validity
   */
  static buildDelegation(
    memberWalletId: Field,
    repWalletId: Field,
    scopeFlags: Field,
    effectiveDateStr: string,
    aorCommitment: Field,
    validityDays: number = AOR_DEFAULT_VALIDITY_DAYS,
  ): AorDelegationResult {
    const expirationDate = AorService.computeExpirationDate(
      effectiveDateStr,
      validityDays,
    );

    const delegationData = new DelegationData({
      delegatorWalletId: memberWalletId,
      delegateWalletId: repWalletId,
      scopeFlags,
      effectiveDate: dateToField(effectiveDateStr),
      expirationDate: dateToField(expirationDate),
      relationshipCode: REL_APPOINTED_REPRESENTATIVE,
      delegationHash: aorCommitment,
    });

    return { delegationData, aorCommitment, expirationDate };
  }

  /**
   * Check if PICKUP scope is eligible (cool-down period elapsed).
   *
   * PICKUP scope has a 48-hour activation delay after the delegation's
   * effective date. This gives the member time to notice and revoke
   * a fraudulent AOR before medications can be dispensed.
   *
   * @param delegationData — the delegation to check
   * @param currentTimestamp — current time in ms
   */
  static isPickupEligible(
    delegationData: DelegationData,
    currentTimestamp: number,
  ): PickupEligibilityResult {
    // Check if delegation has PICKUP scope at all
    const scopeNum = Number(delegationData.scopeFlags.toBigInt());
    const hasPickup = (scopeNum & Number(SCOPE_PICKUP.toBigInt())) !== 0;
    if (!hasPickup) {
      return { eligible: false, reason: 'Delegation does not include PICKUP scope', cooldownRemainingMs: 0 };
    }

    // Check expiration
    const expirationNum = Number(delegationData.expirationDate.toBigInt());
    const currentDateNum = AorService.timestampToDateNum(currentTimestamp);
    if (currentDateNum > expirationNum) {
      return { eligible: false, reason: 'Delegation has expired', cooldownRemainingMs: 0 };
    }

    // Check cool-down: effectiveDate + 48h
    const effectiveNum = Number(delegationData.effectiveDate.toBigInt());
    const effectiveMs = AorService.dateNumToTimestamp(effectiveNum);
    const cooldownEnd = effectiveMs + PICKUP_COOLDOWN_MS;

    if (currentTimestamp < cooldownEnd) {
      const remaining = cooldownEnd - currentTimestamp;
      return {
        eligible: false,
        reason: `PICKUP cool-down active: ${Math.ceil(remaining / 3600000)}h remaining`,
        cooldownRemainingMs: remaining,
      };
    }

    return { eligible: true, reason: 'PICKUP scope is active', cooldownRemainingMs: 0 };
  }

  /**
   * Validate an offline delegation credential against scope-based TTL.
   *
   * Different scopes have different staleness tolerances:
   *   READ:   72h — low risk (viewing data)
   *   WRITE:  24h — medium risk (sending messages)
   *   PICKUP:  4h — high risk (medication dispensing)
   *
   * @param chainStateTimestamp — when the pharmacy last synced chain state (ms)
   * @param scopeRequired — the scope being exercised (single flag)
   * @param currentTimestamp — current time in ms
   */
  static isOfflineCredentialValid(
    chainStateTimestamp: number,
    scopeRequired: number,
    currentTimestamp: number,
  ): OfflineValidityResult {
    const stalenessMs = currentTimestamp - chainStateTimestamp;

    // Determine TTL based on highest-risk scope requested
    let ttlMs: number;
    if (scopeRequired & Number(SCOPE_PICKUP.toBigInt())) {
      ttlMs = OFFLINE_TTL_MS.PICKUP;
    } else if (scopeRequired & Number(SCOPE_WRITE.toBigInt())) {
      ttlMs = OFFLINE_TTL_MS.WRITE;
    } else {
      ttlMs = OFFLINE_TTL_MS.READ;
    }

    if (stalenessMs > ttlMs) {
      return {
        valid: false,
        reason: `Chain state is ${Math.round(stalenessMs / 3600000)}h old, TTL is ${Math.round(ttlMs / 3600000)}h`,
        ttlMs,
        stalenessMs,
      };
    }

    return { valid: true, reason: 'Credential is within TTL', ttlMs, stalenessMs };
  }

  // ─── Rate Limiting ─────────────────────────────────────────

  /**
   * Check if a member is rate-limited for AOR initiation.
   *
   * Scans the message registry for the most recent AOR_INITIATE
   * from this member. If within 24h, the member is rate-limited.
   */
  static isRateLimited(
    memberWalletId: Field,
    messageRegistry: MessageRegistry,
    currentTimestamp: number,
  ): boolean {
    const walletStr = memberWalletId.toString();
    const aorInitiateType = MSG_TYPE_AOR_INITIATE.toString();

    // Scan registry for matching messages
    for (let i = 0n; i < BigInt(messageRegistry.count); i++) {
      const msg = messageRegistry.getMessage(i);
      if (
        msg &&
        msg.senderWalletId.toString() === walletStr &&
        msg.messageType.toString() === aorInitiateType
      ) {
        // Found an AOR_INITIATE from this member
        const msgTimestamp = Number(msg.timestamp.toBigInt());
        if (currentTimestamp - msgTimestamp < AOR_RATE_LIMIT_MS) {
          return true; // Rate limited
        }
      }
    }

    return false;
  }

  // ─── Revocation ───────────────────────────────────────────

  /**
   * Validate and execute an AOR revocation.
   *
   * Either the member (delegator) or the insurer can revoke an AOR.
   * Revocation zeros the delegation leaf in the Merkle tree, making
   * it unprovable. The revoked slot is never reused.
   *
   * After calling this, the caller should send an MSG_TYPE_AOR_REVOKE
   * message via MessagingService to notify both parties.
   *
   * @param memberWalletId — the member's wallet ID (delegator)
   * @param repWalletId — the representative's wallet ID (delegate)
   * @param revokerWalletId — who is revoking (must be member or admin)
   * @param adminWalletId — the insurer admin's wallet ID
   * @param delegationRegistry — the delegation registry
   */
  static revokeAor(
    memberWalletId: Field,
    repWalletId: Field,
    revokerWalletId: Field,
    adminWalletId: Field,
    delegationRegistry: DelegationRegistry,
  ): AorRevocationResult {
    // Verify revoker is authorized (member or admin)
    const revokerStr = revokerWalletId.toString();
    const isMember = revokerStr === memberWalletId.toString();
    const isAdmin = revokerStr === adminWalletId.toString();
    if (!isMember && !isAdmin) {
      return {
        valid: false,
        reason: 'Only the member or insurer admin can revoke an AOR',
        delegationIndex: 0n,
      };
    }

    // Find the delegation
    const found = delegationRegistry.findByWallets(memberWalletId, repWalletId);
    if (!found) {
      return {
        valid: false,
        reason: 'No active delegation found for this member-representative pair',
        delegationIndex: 0n,
      };
    }

    // Verify it's an AOR delegation (not a parent/spouse/POA etc.)
    if (found.delegation.relationshipCode.toString() !== REL_APPOINTED_REPRESENTATIVE.toString()) {
      return {
        valid: false,
        reason: 'Delegation is not an AOR (wrong relationship code)',
        delegationIndex: found.index,
      };
    }

    // Execute revocation
    const { newRoot } = delegationRegistry.revokeDelegation(found.index);

    return {
      valid: true,
      reason: isMember ? 'Revoked by member' : 'Revoked by insurer admin',
      delegationIndex: found.index,
      newDelegationRoot: newRoot,
    };
  }

  /**
   * Check if a delegation is currently active (non-revoked) in the registry.
   *
   * A delegation is active if its leaf is non-zero in the Merkle tree.
   * This is a fast check that doesn't verify expiration or scope —
   * use isPickupEligible() for full eligibility checks.
   *
   * @param delegationIndex — the delegation's index in the registry
   * @param delegationRegistry — the delegation registry
   */
  static isDelegationActive(
    delegationIndex: bigint,
    delegationRegistry: DelegationRegistry,
  ): boolean {
    return delegationRegistry.getDelegation(delegationIndex) !== undefined;
  }

  // ─── Date Helpers ──────────────────────────────────────────

  /**
   * Compute expiration date from effective date + validity days.
   */
  static computeExpirationDate(
    effectiveDateStr: string,
    validityDays: number,
  ): string {
    const year = parseInt(effectiveDateStr.slice(0, 4), 10);
    const month = parseInt(effectiveDateStr.slice(4, 6), 10);
    const day = parseInt(effectiveDateStr.slice(6, 8), 10);

    const ms = Date.UTC(year, month - 1, day);
    const date = new Date(ms + validityDays * 86_400_000);

    const expYear = date.getUTCFullYear().toString().padStart(4, '0');
    const expMonth = (date.getUTCMonth() + 1).toString().padStart(2, '0');
    const expDay = date.getUTCDate().toString().padStart(2, '0');
    return `${expYear}${expMonth}${expDay}`;
  }

  /**
   * Convert a ms timestamp to CCYYMMDD numeric value.
   */
  static timestampToDateNum(timestampMs: number): number {
    const d = new Date(timestampMs);
    return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
  }

  /**
   * Convert a CCYYMMDD numeric value to ms timestamp (midnight UTC).
   */
  static dateNumToTimestamp(dateNum: number): number {
    const year = Math.floor(dateNum / 10000);
    const month = Math.floor((dateNum % 10000) / 100);
    const day = dateNum % 100;
    return Date.UTC(year, month - 1, day);
  }
}
