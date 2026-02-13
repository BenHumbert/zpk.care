import { Field, Struct, Poseidon, Bool } from 'o1js';
import { hashString, dateToField, quantityToField } from '../zkp/hash-utils.js';

// ─── Status Constants ───────────────────────────────────────────

/** Newly written, awaiting fill */
export const RX_STATUS_ACTIVE = Field(1);
/** Partial dispense completed */
export const RX_STATUS_PARTIALLY_FILLED = Field(2);
/** Fully dispensed */
export const RX_STATUS_FILLED = Field(3);
/** Cancelled by prescriber */
export const RX_STATUS_CANCELLED = Field(4);
/** Rejected by pharmacy */
export const RX_STATUS_REJECTED = Field(5);
/** Reversed (undo a fill) */
export const RX_STATUS_REVERSED = Field(6);
/** Transferred to another pharmacy */
export const RX_STATUS_TRANSFERRED = Field(7);

// ─── PrescriptionData ───────────────────────────────────────────

/**
 * PrescriptionData — the written prescription (eScript).
 *
 * Stored as a leaf in the MerkleForest MEDICATION tree.
 * Immutable once created — status changes go to the TRANSACTION tree.
 *
 * NCPDP D.0 fields:
 *   407-D7  Product/Service ID (NDC) → ndcHash
 *   460-ET  Quantity Prescribed → quantityPrescribed
 *   415-DF  Number of Refills Authorized → refillsAuthorized
 */
export class PrescriptionData extends Struct({
  /** Poseidon hash of NDC code (NCPDP 407-D7) */
  ndcHash: Field,
  /** Who wrote the prescription (prescriber wallet ID) */
  prescriberWalletId: Field,
  /** Patient the prescription is for (member wallet ID) */
  memberWalletId: Field,
  /** Date written (CCYYMMDD as number) */
  writtenDate: Field,
  /** Expiration date (CCYYMMDD as number) */
  expirationDate: Field,
  /** Quantity prescribed (x1000 scaled integer, NCPDP 460-ET) */
  quantityPrescribed: Field,
  /** Number of refills authorized (0-99, NCPDP 415-DF) */
  refillsAuthorized: Field,
}) {
  commitment(): Field {
    return Poseidon.hash([
      this.ndcHash,
      this.prescriberWalletId,
      this.memberWalletId,
      this.writtenDate,
      this.expirationDate,
      this.quantityPrescribed,
      this.refillsAuthorized,
    ]);
  }
}

/**
 * Raw prescription data — lives locally, never on-chain.
 */
export interface PrescriptionLocalData {
  /** NDC code (11-digit string) */
  ndcCode: string;
  /** Prescriber wallet ID as bigint string */
  prescriberWalletId: string;
  /** Member wallet ID as bigint string */
  memberWalletId: string;
  /** Written date as CCYYMMDD string */
  writtenDate: string;
  /** Expiration date as CCYYMMDD string */
  expirationDate: string;
  /** Quantity prescribed (decimal) */
  quantityPrescribed: number;
  /** Refills authorized (integer 0-99) */
  refillsAuthorized: number;
}

/**
 * Build a PrescriptionData from raw local data.
 */
export function buildPrescriptionData(local: PrescriptionLocalData): PrescriptionData {
  return new PrescriptionData({
    ndcHash: hashString(local.ndcCode),
    prescriberWalletId: Field(BigInt(local.prescriberWalletId)),
    memberWalletId: Field(BigInt(local.memberWalletId)),
    writtenDate: dateToField(local.writtenDate),
    expirationDate: dateToField(local.expirationDate),
    quantityPrescribed: quantityToField(local.quantityPrescribed),
    refillsAuthorized: Field(BigInt(local.refillsAuthorized)),
  });
}

// ─── PrescriptionStatusData ─────────────────────────────────────

/**
 * PrescriptionStatusData — a single status entry in the prescription lifecycle.
 *
 * Stored as a leaf in the MerkleForest TRANSACTION tree.
 * Append-only: each status change adds a new leaf at the next index.
 * Leaf 0 is always the initial ACTIVE status created at prescription time.
 *
 * Emergency flag: initial ACTIVE entry's notesHash = hashString("EMERGENCY_FILL")
 * for emergency prescriptions, Field(0) for standard.
 */
export class PrescriptionStatusData extends Struct({
  /** Links to PrescriptionData.commitment() */
  prescriptionHash: Field,
  /** Status code (1-7, see RX_STATUS_* constants) */
  status: Field,
  /** Who made this update (pharmacy/prescriber/admin wallet ID) */
  updatedByWalletId: Field,
  /** Timestamp CCYYMMDDHHMMSS as number */
  updatedAt: Field,
  /** Which pharmacy holds the prescription after this update */
  pharmacyWalletId: Field,
  /** Amount dispensed this action (x1000 scaled, 0 for non-fill updates) */
  fillQuantity: Field,
  /** Poseidon hash of notes/reason text (Field(0) if none) */
  notesHash: Field,
}) {
  commitment(): Field {
    return Poseidon.hash([
      this.prescriptionHash,
      this.status,
      this.updatedByWalletId,
      this.updatedAt,
      this.pharmacyWalletId,
      this.fillQuantity,
      this.notesHash,
    ]);
  }
}

/**
 * Raw prescription status data — lives locally, never on-chain.
 */
export interface PrescriptionStatusLocalData {
  /** Prescription commitment as bigint string */
  prescriptionHash: string;
  /** Status code (1-7) */
  status: number;
  /** Who updated (wallet ID as bigint string) */
  updatedByWalletId: string;
  /** Timestamp as CCYYMMDDHHMMSS string */
  updatedAt: string;
  /** Current pharmacy wallet ID as bigint string */
  pharmacyWalletId: string;
  /** Fill quantity (decimal, 0 for non-fill) */
  fillQuantity: number;
  /** Notes text (empty string if none) */
  notes: string;
}

/**
 * Build a PrescriptionStatusData from raw local data.
 */
export function buildPrescriptionStatusData(
  local: PrescriptionStatusLocalData,
): PrescriptionStatusData {
  return new PrescriptionStatusData({
    prescriptionHash: Field(BigInt(local.prescriptionHash)),
    status: Field(BigInt(local.status)),
    updatedByWalletId: Field(BigInt(local.updatedByWalletId)),
    updatedAt: Field(BigInt(local.updatedAt)),
    pharmacyWalletId: Field(BigInt(local.pharmacyWalletId)),
    fillQuantity: quantityToField(local.fillQuantity),
    notesHash: local.notes ? hashString(local.notes) : Field(0),
  });
}

// ─── Status Transition Validation ───────────────────────────────

/**
 * Valid prescription status transitions (off-chain lookup).
 *
 * ACTIVE → PARTIALLY_FILLED, FILLED, CANCELLED, REJECTED, TRANSFERRED
 * PARTIALLY_FILLED → PARTIALLY_FILLED, FILLED, CANCELLED, REVERSED, TRANSFERRED
 * FILLED → REVERSED
 * REVERSED → ACTIVE
 * CANCELLED, REJECTED, TRANSFERRED → terminal (no further transitions)
 */
const VALID_TRANSITIONS: [bigint, bigint][] = [
  // From ACTIVE
  [1n, 2n], // ACTIVE → PARTIALLY_FILLED
  [1n, 3n], // ACTIVE → FILLED
  [1n, 4n], // ACTIVE → CANCELLED
  [1n, 5n], // ACTIVE → REJECTED
  [1n, 7n], // ACTIVE → TRANSFERRED
  // From PARTIALLY_FILLED
  [2n, 2n], // PARTIALLY_FILLED → PARTIALLY_FILLED
  [2n, 3n], // PARTIALLY_FILLED → FILLED
  [2n, 4n], // PARTIALLY_FILLED → CANCELLED
  [2n, 6n], // PARTIALLY_FILLED → REVERSED
  [2n, 7n], // PARTIALLY_FILLED → TRANSFERRED
  // From FILLED
  [3n, 6n], // FILLED → REVERSED
  // From REVERSED
  [6n, 1n], // REVERSED → ACTIVE (can restart)
];

/**
 * Off-chain helper: check if a status transition is valid.
 */
export function isValidStatusTransition(from: bigint, to: bigint): boolean {
  return VALID_TRANSITIONS.some(([f, t]) => f === from && t === to);
}

/**
 * Assert a status transition is valid inside a ZK circuit.
 *
 * Uses only circuit-compatible operations (.equals, .and, .or, .assertTrue).
 */
export function assertValidStatusTransition(from: Field, to: Field): void {
  // ACTIVE(1) → PARTIALLY_FILLED(2), FILLED(3), CANCELLED(4), REJECTED(5), TRANSFERRED(7)
  const t1 = from.equals(RX_STATUS_ACTIVE).and(to.equals(RX_STATUS_PARTIALLY_FILLED));
  const t2 = from.equals(RX_STATUS_ACTIVE).and(to.equals(RX_STATUS_FILLED));
  const t3 = from.equals(RX_STATUS_ACTIVE).and(to.equals(RX_STATUS_CANCELLED));
  const t4 = from.equals(RX_STATUS_ACTIVE).and(to.equals(RX_STATUS_REJECTED));
  const t5 = from.equals(RX_STATUS_ACTIVE).and(to.equals(RX_STATUS_TRANSFERRED));

  // PARTIALLY_FILLED(2) → PARTIALLY_FILLED(2), FILLED(3), CANCELLED(4), REVERSED(6), TRANSFERRED(7)
  const t6 = from.equals(RX_STATUS_PARTIALLY_FILLED).and(to.equals(RX_STATUS_PARTIALLY_FILLED));
  const t7 = from.equals(RX_STATUS_PARTIALLY_FILLED).and(to.equals(RX_STATUS_FILLED));
  const t8 = from.equals(RX_STATUS_PARTIALLY_FILLED).and(to.equals(RX_STATUS_CANCELLED));
  const t9 = from.equals(RX_STATUS_PARTIALLY_FILLED).and(to.equals(RX_STATUS_REVERSED));
  const t10 = from.equals(RX_STATUS_PARTIALLY_FILLED).and(to.equals(RX_STATUS_TRANSFERRED));

  // FILLED(3) → REVERSED(6)
  const t11 = from.equals(RX_STATUS_FILLED).and(to.equals(RX_STATUS_REVERSED));

  // REVERSED(6) → ACTIVE(1)
  const t12 = from.equals(RX_STATUS_REVERSED).and(to.equals(RX_STATUS_ACTIVE));

  const isValid = t1.or(t2).or(t3).or(t4).or(t5)
    .or(t6).or(t7).or(t8).or(t9).or(t10)
    .or(t11).or(t12);
  isValid.assertTrue('Invalid prescription status transition');
}

/** Sentinel for the emergency fill flag in the initial status notesHash */
export const EMERGENCY_FILL_HASH = hashString('EMERGENCY_FILL');
