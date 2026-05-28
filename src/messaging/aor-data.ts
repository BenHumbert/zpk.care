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

import { Field, Poseidon } from 'o1js';
import { hashString, dateToField } from '../zkp/hash-utils.js';

// ─── AOR Message Type Constants ──────────────────────────────

/** Member initiates AOR (member → insurer) */
export const MSG_TYPE_AOR_INITIATE = Field(10);
/** Representative completes AOR sections 2-4 (rep → insurer) */
export const MSG_TYPE_AOR_COMPLETE = Field(11);
/** Insurer asks member to confirm specific rep (insurer → member) */
export const MSG_TYPE_AOR_CONFIRM = Field(12);
/** Member confirms the specific representative (member → insurer) */
export const MSG_TYPE_AOR_CONFIRMED = Field(13);
/** Insurer approves the AOR (insurer → member + rep) */
export const MSG_TYPE_AOR_APPROVED = Field(14);
/** Insurer denies the AOR (insurer → member + rep) */
export const MSG_TYPE_AOR_DENIED = Field(15);
/** Member or insurer revokes an active AOR (member|insurer → both) */
export const MSG_TYPE_AOR_REVOKE = Field(16);
/** Member shares data with rep (member → rep) */
export const MSG_TYPE_AOR_DATA_SHARE = Field(17);

// ─── AOR Timing Constants ────────────────────────────────────

/** Cool-down period before PICKUP scope activates (48 hours in ms) */
export const PICKUP_COOLDOWN_MS = 48 * 60 * 60 * 1000;

/** Default AOR validity period (365 days, per CMS-1696) */
export const AOR_DEFAULT_VALIDITY_DAYS = 365;

/** Rate limit: minimum interval between AOR initiations per member (24 hours in ms) */
export const AOR_RATE_LIMIT_MS = 24 * 60 * 60 * 1000;

/** Rep enrollment token expiry (24 hours in ms) */
export const REP_TOKEN_EXPIRY_MS = 24 * 60 * 60 * 1000;

/**
 * TTL for offline credential verification by scope (in ms).
 * Pharmacies with stale chain state beyond TTL must sync before honoring.
 */
export const OFFLINE_TTL_MS = {
  READ: 72 * 60 * 60 * 1000,   // 72 hours
  WRITE: 24 * 60 * 60 * 1000,  // 24 hours
  PICKUP: 4 * 60 * 60 * 1000,  //  4 hours
} as const;

// ─── AOR Local Data (CMS-1696 Complete) ──────────────────────

/**
 * AorLocalData — full CMS-1696 Appointment of Representative form.
 *
 * All fields are stored ENCRYPTED via L7 messaging. Only the
 * Poseidon commitment (delegationHash) goes on-chain.
 *
 * Sections match the official CMS-1696 form:
 *   Section 1: Party (beneficiary) information
 *   Section 2: Representative information
 *   Section 3: Fee waiver
 *   Section 4: Liability waiver
 */
export interface AorLocalData {
  // Section 1 — Party (Beneficiary)
  /** Full legal name of the party appointing the representative */
  partyFullName: string;
  /** Identifier (cardholder ID, Medicare #, or NPI) */
  partyIdentifier: string;
  /** Full street address including city, state, ZIP */
  partyAddress: string;
  /** Phone number */
  partyPhone: string;
  /** Email (optional per CMS-1696) */
  partyEmail?: string;
  /** Party's signature as base64-encoded data */
  partySignature: string;
  /** Date the party signed (CCYYMMDD) */
  partySignedDate: string;

  // Section 2 — Representative
  /** Full name of the appointed representative */
  repFullName: string;
  /** Professional status or relationship to party */
  repProfessionalStatus: string;
  /** Phone number */
  repPhone: string;
  /** Full address */
  repAddress: string;
  /** Email (optional) */
  repEmail?: string;
  /** Representative's signature as base64-encoded data */
  repSignature: string;
  /** Date the representative signed (CCYYMMDD) */
  repSignedDate: string;

  // Section 3 — Fee Waiver
  /** Whether the representative waives fees */
  feeWaived: boolean;
  /** Fee amount in cents (if not waived) */
  feeAmountCents?: number;
  /** Fee waiver signature as base64 (required if feeWaived=true) */
  feeWaiverSignature?: string;
  /** Date of fee waiver signature (CCYYMMDD) */
  feeWaiverDate?: string;

  // Section 4 — Liability Waiver
  /** Whether the liability waiver applies (rep is provider of services at issue) */
  liabilityWaiverApplicable: boolean;
  /** Liability waiver signature as base64 (required if applicable) */
  liabilityWaiverSignature?: string;
  /** Date of liability waiver (CCYYMMDD) */
  liabilityWaiverDate?: string;

  // Scope Limitations
  /** Free-text description of specific claims/issues the rep is authorized for */
  scopeLimitations?: string;
}

// ─── AOR Validation ──────────────────────────────────────────

/**
 * Result of validating an AOR document's completeness.
 */
export interface AorValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validate that an AOR document has all required fields for CMS-1696 compliance.
 */
export function validateAorDocument(aor: AorLocalData): AorValidationResult {
  const errors: string[] = [];

  // Section 1 — required fields
  if (!aor.partyFullName) errors.push('Section 1: Party full name is required');
  if (!aor.partyIdentifier) errors.push('Section 1: Party identifier is required');
  if (!aor.partyAddress) errors.push('Section 1: Party address is required');
  if (!aor.partyPhone) errors.push('Section 1: Party phone is required');
  if (!aor.partySignature) errors.push('Section 1: Party signature is required');
  if (!aor.partySignedDate) errors.push('Section 1: Party signed date is required');

  // Section 2 — required fields
  if (!aor.repFullName) errors.push('Section 2: Representative name is required');
  if (!aor.repProfessionalStatus) errors.push('Section 2: Professional status is required');
  if (!aor.repPhone) errors.push('Section 2: Representative phone is required');
  if (!aor.repAddress) errors.push('Section 2: Representative address is required');
  if (!aor.repSignature) errors.push('Section 2: Representative signature is required');
  if (!aor.repSignedDate) errors.push('Section 2: Representative signed date is required');

  // Section 3 — fee waiver signature required when waived
  if (aor.feeWaived && !aor.feeWaiverSignature) {
    errors.push('Section 3: Fee waiver signature is required when fees are waived');
  }

  // Section 4 — liability waiver signature required when applicable
  if (aor.liabilityWaiverApplicable && !aor.liabilityWaiverSignature) {
    errors.push('Section 4: Liability waiver signature is required when applicable');
  }

  return { valid: errors.length === 0, errors };
}

// ─── AOR Commitment ──────────────────────────────────────────

/**
 * Build a Poseidon commitment of the AOR document.
 *
 * This hash becomes the `delegationHash` in DelegationData,
 * cryptographically binding the on-chain delegation to the
 * full CMS-1696 document stored off-chain (encrypted).
 *
 * Hashes the 6 most critical binding fields:
 *   partyFullName, partyIdentifier, repFullName,
 *   repProfessionalStatus, partySignedDate, repSignedDate
 */
export function buildAorCommitment(aor: AorLocalData): Field {
  return Poseidon.hash([
    hashString(aor.partyFullName),
    hashString(aor.partyIdentifier),
    hashString(aor.repFullName),
    hashString(aor.repProfessionalStatus),
    dateToField(aor.partySignedDate),
    dateToField(aor.repSignedDate),
  ]);
}

/**
 * Build the AOR confirmation commitment — binds member to specific rep.
 *
 * Used in the AOR_CONFIRMED message contentHash to cryptographically
 * prove the member authorized THIS specific representative wallet.
 *
 * @param memberWalletId — the member's proof-gated wallet ID
 * @param repWalletId — the representative's proof-gated wallet ID
 * @param aorCommitment — the AOR document commitment (from buildAorCommitment)
 * @param scopeFlags — the authorized scope (bitfield)
 */
export function buildAorConfirmationHash(
  memberWalletId: Field,
  repWalletId: Field,
  aorCommitment: Field,
  scopeFlags: Field,
): Field {
  return Poseidon.hash([memberWalletId, repWalletId, aorCommitment, scopeFlags]);
}
