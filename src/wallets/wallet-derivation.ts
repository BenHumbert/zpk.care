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
import { randomBytes } from 'crypto';
import { hashString, dateToField, hashDate, codeToField } from '../zkp/hash-utils.js';
import type { MemberLocalData } from '../models/member.js';
import type { PrescriberLocalData } from '../models/prescriber.js';
import type { PharmacyLocalData } from '../models/pharmacy.js';

/**
 * Wallet Identity Derivation
 *
 * Each actor type (member, prescriber, pharmacy) gets a deterministic
 * wallet identity derived from their identifying data PLUS a
 * user-generated enrollment key (2FA salt).
 *
 * Wallet identity = Poseidon.hash([domainTag, ...identityFields, enrollmentKeyHash, groupIdHash])
 *
 * For members, groupIdHash binds the wallet to an employer group.
 * Changing jobs = changing group = new wallet = new enrollment.
 * Non-member entities (prescriber, pharmacy, representative) pass Field(0) for groupIdHash.
 *
 * The enrollment key is a user-generated secret created on the user's
 * device during enrollment. It NEVER leaves the device and is NEVER
 * transmitted to the insurer. It prevents wallet impersonation even
 * if PHI is breached.
 *
 * The wallet identity IS the wallet "address" in our system.
 * There is no private key. Access is proven via the ProofGate circuit.
 */

// ─── Enrollment Key Generation & Validation ─────────────

/** Minimum enrollment key length in characters */
export const MIN_ENROLLMENT_KEY_LENGTH = 16;

/** Enrollment key byte length for generation (32 bytes = 256 bits) */
const ENROLLMENT_KEY_BYTES = 32;

/**
 * Generate a cryptographically secure enrollment key.
 *
 * Uses the OS entropy pool (crypto.randomBytes) to produce a 256-bit
 * key encoded as base64url. This key is generated on the user's device
 * and NEVER leaves it.
 *
 * @returns A 43-character base64url string (256 bits of entropy)
 */
export function generateEnrollmentKey(): string {
  return randomBytes(ENROLLMENT_KEY_BYTES).toString('base64url');
}

/**
 * Validate that an enrollment key meets minimum security requirements.
 *
 * Requirements:
 *   - At least MIN_ENROLLMENT_KEY_LENGTH characters (16)
 *   - Contains at least 3 of 4 character classes:
 *     uppercase, lowercase, digits, symbols
 *
 * @throws Error if the key is too weak
 */
export function validateEnrollmentKey(key: string): void {
  if (!key || key.length < MIN_ENROLLMENT_KEY_LENGTH) {
    throw new Error(
      `Enrollment key must be at least ${MIN_ENROLLMENT_KEY_LENGTH} characters (got ${key?.length ?? 0})`,
    );
  }

  let classes = 0;
  if (/[a-z]/.test(key)) classes++;
  if (/[A-Z]/.test(key)) classes++;
  if (/[0-9]/.test(key)) classes++;
  if (/[^a-zA-Z0-9]/.test(key)) classes++;

  if (classes < 3) {
    throw new Error(
      'Enrollment key must contain at least 3 of 4 character classes: ' +
      'uppercase, lowercase, digits, symbols',
    );
  }
}

// ─── Domain Tags & Derivation ───────────────────────────

/** Domain tags — prevent identity collisions across entity types */
export const DOMAIN_TAG_MEMBER         = Field(0);
export const DOMAIN_TAG_PRESCRIBER     = Field(1);
export const DOMAIN_TAG_PHARMACY       = Field(2);
export const DOMAIN_TAG_REPRESENTATIVE = Field(3);

/**
 * Derive a member's wallet identity from their local data + enrollment key + groupIdHash.
 *
 * Preimage: [0, hash(cardholderId), hashDate(dob), hash(firstName), hash(lastName), hash(enrollmentKey), groupIdHash]
 *
 * groupIdHash cryptographically binds the wallet to the employer group.
 * Changing jobs = changing groupIdHash = different wallet ID = new enrollment ceremony.
 *
 * H4 fix: DOB is now hashed through Poseidon (hashDate) instead of stored as a
 * plain integer. This prevents brute-force recovery of the date of birth from
 * the on-chain wallet ID (~36,500 possible DOB values).
 */
export function deriveMemberWalletId(local: MemberLocalData, enrollmentKey: string, groupIdHash: Field): Field {
  validateEnrollmentKey(enrollmentKey);
  return Poseidon.hash([
    DOMAIN_TAG_MEMBER,
    hashString(local.cardholderId),
    hashDate(local.dateOfBirth),
    hashString(local.firstName),
    hashString(local.lastName),
    hashString(enrollmentKey),
    groupIdHash,
  ]);
}

/**
 * Compute the member wallet identity preimage Fields.
 * These are the private inputs to the proof-gate circuit.
 * Computed off-circuit from raw local data, then used inside the ZK proof.
 * Returns 6 Fields: [cardholderIdHash, dobHash, firstNameHash, lastNameHash, enrollmentKeyHash, groupIdHash]
 */
export function memberWalletPreimage(local: MemberLocalData, enrollmentKey: string, groupIdHash: Field): Field[] {
  return [
    hashString(local.cardholderId),
    hashDate(local.dateOfBirth),
    hashString(local.firstName),
    hashString(local.lastName),
    hashString(enrollmentKey),
    groupIdHash,
  ];
}

/**
 * Derive a prescriber's wallet identity from their local data + enrollment key.
 *
 * Preimage: [1, codeToField(qualifier), hash(prescriberId), hash(enrollmentKey)]
 */
export function derivePrescriberWalletId(local: PrescriberLocalData, enrollmentKey: string): Field {
  validateEnrollmentKey(enrollmentKey);
  return Poseidon.hash([
    DOMAIN_TAG_PRESCRIBER,
    codeToField(local.prescriberIdQualifier),
    hashString(local.prescriberId),
    hashString(enrollmentKey),
  ]);
}

/**
 * Compute the prescriber wallet identity preimage Fields.
 */
export function prescriberWalletPreimage(local: PrescriberLocalData, enrollmentKey: string): Field[] {
  return [
    codeToField(local.prescriberIdQualifier),
    hashString(local.prescriberId),
    hashString(enrollmentKey),
  ];
}

/**
 * Derive a pharmacy's wallet identity from their local data + enrollment key.
 *
 * Preimage: [2, codeToField(qualifier), hash(serviceProviderId), hash(enrollmentKey)]
 */
export function derivePharmacyWalletId(local: PharmacyLocalData, enrollmentKey: string): Field {
  validateEnrollmentKey(enrollmentKey);
  return Poseidon.hash([
    DOMAIN_TAG_PHARMACY,
    codeToField(local.serviceProviderIdQualifier),
    hashString(local.serviceProviderId),
    hashString(enrollmentKey),
  ]);
}

/**
 * Compute the pharmacy wallet identity preimage Fields.
 */
export function pharmacyWalletPreimage(local: PharmacyLocalData, enrollmentKey: string): Field[] {
  return [
    codeToField(local.serviceProviderIdQualifier),
    hashString(local.serviceProviderId),
    hashString(enrollmentKey),
  ];
}

// ─── Representative (AOR) ───────────────────────────────

/**
 * Local data identifying a representative (Appointment of Representative).
 *
 * The representative's identifier is intentionally generic —
 * could be a driver license, state ID, bar number, or org ID.
 * The qualifier disambiguates the ID type.
 */
export interface RepresentativeLocalData {
  /** Qualifier code for representative ID type (1=DL, 2=StateID, 3=BarNumber, 4=OrgID) */
  representativeIdQualifier: number;
  /** The representative's identifier value */
  representativeId: string;
}

/**
 * Derive a representative's wallet identity from their local data + enrollment key.
 *
 * Preimage: [3, codeToField(qualifier), hash(representativeId), hash(enrollmentKey)]
 */
export function deriveRepresentativeWalletId(
  local: RepresentativeLocalData,
  enrollmentKey: string,
): Field {
  validateEnrollmentKey(enrollmentKey);
  return Poseidon.hash([
    DOMAIN_TAG_REPRESENTATIVE,
    codeToField(local.representativeIdQualifier),
    hashString(local.representativeId),
    hashString(enrollmentKey),
  ]);
}

/**
 * Compute the representative wallet identity preimage Fields.
 */
export function representativeWalletPreimage(
  local: RepresentativeLocalData,
  enrollmentKey: string,
): Field[] {
  return [
    codeToField(local.representativeIdQualifier),
    hashString(local.representativeId),
    hashString(enrollmentKey),
  ];
}

// ─── Padded Preimage Helpers (for StateTransitionProgram) ─────

/**
 * Pad an entity's preimage to 6 Fields for use with StateTransitionProgram.
 *
 * StateTransitionProgram accepts a uniform 7-Field input:
 *   [domainTag, f0, f1, f2, f3, f4, f5]
 * where non-member entities have unused trailing fields set to Field(0).
 *
 * Member: 6 preimage fields (incl groupIdHash) → no padding needed
 * Prescriber: 3 preimage fields → 3 trailing zeros
 * Pharmacy: 3 preimage fields → 3 trailing zeros
 */
export function paddedPreimage(domainTag: Field, preimage: Field[]): Field[] {
  const padded = [...preimage];
  while (padded.length < 6) padded.push(Field(0));
  return [domainTag, ...padded];
}

/** Build padded StateTransitionProgram input for a member */
export function memberTransitionPreimage(local: MemberLocalData, enrollmentKey: string, groupIdHash: Field): Field[] {
  return paddedPreimage(DOMAIN_TAG_MEMBER, memberWalletPreimage(local, enrollmentKey, groupIdHash));
}

/** Build padded StateTransitionProgram input for a prescriber */
export function prescriberTransitionPreimage(local: PrescriberLocalData, enrollmentKey: string): Field[] {
  return paddedPreimage(DOMAIN_TAG_PRESCRIBER, prescriberWalletPreimage(local, enrollmentKey));
}

/** Build padded StateTransitionProgram input for a pharmacy */
export function pharmacyTransitionPreimage(local: PharmacyLocalData, enrollmentKey: string): Field[] {
  return paddedPreimage(DOMAIN_TAG_PHARMACY, pharmacyWalletPreimage(local, enrollmentKey));
}
