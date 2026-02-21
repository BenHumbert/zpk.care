import { Field, Struct, Poseidon } from 'o1js';
import { hashString, dateToField } from '../zkp/hash-utils.js';

// ─── Consent Scope Constants (bitfield) ────────────────────

/** Access to prescription history */
export const PCP_SCOPE_RX_HISTORY = Field(1);
/** Access to eligibility/benefit plan data */
export const PCP_SCOPE_ELIGIBILITY = Field(2);
/** Access to accumulator state (deductible, OOPM, annual max) */
export const PCP_SCOPE_ACCUMULATORS = Field(4);
/** Full access — RX_HISTORY + ELIGIBILITY + ACCUMULATORS (1 | 2 | 4 = 7) */
export const PCP_SCOPE_ALL = Field(7);

/** Leaf index in the MEMBER domain tree for the PCP assignment */
export const PCP_ASSIGNMENT_LEAF_INDEX = 0n;

// ─── PcpAssignmentData ─────────────────────────────────────

/**
 * PcpAssignmentData — a provable Struct for PCP (Primary Care Physician) assignment.
 *
 * Stored as a leaf in the eligibility credential's MEMBER domain tree (ForestDomain.MEMBER).
 * This is the first data written to the MEMBER tree — all other domain trees
 * (PRESCRIBER, PHARMACY) remain empty.
 *
 * The commitment serves dual purpose:
 *   1. Proves the member selected this specific prescriber as their PCP
 *   2. Records consent — the ZK proof of PCP assignment IS the consent verification
 *
 * When a prescriber needs to view member history, they prove via PcpVerificationProgram
 * that their walletId matches the pcpWalletId in this data, and the consentScopeFlags
 * determine what data they can access.
 *
 * No PHI/PII — only wallet IDs (already hashes), dates, and flags.
 */
export class PcpAssignmentData extends Struct({
  /** Wallet ID of the member (the patient) */
  memberWalletId: Field,
  /** Wallet ID of the assigned PCP prescriber */
  pcpWalletId: Field,
  /** Assignment effective date as numeric CCYYMMDD */
  effectiveDate: Field,
  /** Assignment termination date as numeric CCYYMMDD (Field(0) = open-ended) */
  terminationDate: Field,
  /** Poseidon hash of the PCP's specialty (e.g., hashString("Internal Medicine")) */
  specialtyHash: Field,
  /** Consent timestamp as numeric CCYYMMDD (when member approved) */
  consentTimestamp: Field,
  /** Consent scope bitfield: 1=rxHistory, 2=eligibility, 4=accumulators */
  consentScopeFlags: Field,
}) {
  /**
   * Produces a single commitment representing this PCP assignment.
   * Stored as a Merkle leaf in the MEMBER domain tree at PCP_ASSIGNMENT_LEAF_INDEX.
   */
  commitment(): Field {
    return Poseidon.hash([
      this.memberWalletId,
      this.pcpWalletId,
      this.effectiveDate,
      this.terminationDate,
      this.specialtyHash,
      this.consentTimestamp,
      this.consentScopeFlags,
    ]);
  }
}

// ─── Local Interface + Builder ──────────────────────────────

/**
 * Raw PCP assignment data before on-chain encoding.
 */
export interface PcpAssignmentLocalData {
  /** Member wallet ID as bigint string */
  memberWalletId: string;
  /** PCP prescriber wallet ID as bigint string */
  pcpWalletId: string;
  /** Effective date as CCYYMMDD string */
  effectiveDate: string;
  /** Termination date as CCYYMMDD string (empty = open-ended) */
  terminationDate: string;
  /** PCP specialty string (e.g., "Internal Medicine") */
  specialty: string;
  /** Consent date as CCYYMMDD string */
  consentTimestamp: string;
  /** Consent scope flags (bitfield: 1=rxHistory, 2=eligibility, 4=accumulators) */
  consentScopeFlags: number;
}

/**
 * Build a PcpAssignmentData from raw local data.
 */
export function buildPcpAssignmentData(local: PcpAssignmentLocalData): PcpAssignmentData {
  return new PcpAssignmentData({
    memberWalletId: Field(BigInt(local.memberWalletId)),
    pcpWalletId: Field(BigInt(local.pcpWalletId)),
    effectiveDate: dateToField(local.effectiveDate),
    terminationDate: local.terminationDate
      ? dateToField(local.terminationDate)
      : Field(0),
    specialtyHash: hashString(local.specialty),
    consentTimestamp: dateToField(local.consentTimestamp),
    consentScopeFlags: Field(BigInt(local.consentScopeFlags)),
  });
}
