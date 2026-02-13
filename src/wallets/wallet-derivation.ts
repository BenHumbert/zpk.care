import { Field, Poseidon } from 'o1js';
import { randomBytes } from 'crypto';
import { hashString, dateToField, codeToField } from '../zkp/hash-utils.js';
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
 * Wallet identity = Poseidon.hash([domainTag, ...identityFields, enrollmentKeyHash])
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
 * Derive a member's wallet identity from their local data + enrollment key.
 *
 * Preimage: [0, hash(cardholderId), dob, hash(firstName), hash(lastName), hash(enrollmentKey)]
 */
export function deriveMemberWalletId(local: MemberLocalData, enrollmentKey: string): Field {
  validateEnrollmentKey(enrollmentKey);
  return Poseidon.hash([
    DOMAIN_TAG_MEMBER,
    hashString(local.cardholderId),
    dateToField(local.dateOfBirth),
    hashString(local.firstName),
    hashString(local.lastName),
    hashString(enrollmentKey),
  ]);
}

/**
 * Compute the member wallet identity preimage Fields.
 * These are the private inputs to the proof-gate circuit.
 * Computed off-circuit from raw local data, then used inside the ZK proof.
 */
export function memberWalletPreimage(local: MemberLocalData, enrollmentKey: string): Field[] {
  return [
    hashString(local.cardholderId),
    dateToField(local.dateOfBirth),
    hashString(local.firstName),
    hashString(local.lastName),
    hashString(enrollmentKey),
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
