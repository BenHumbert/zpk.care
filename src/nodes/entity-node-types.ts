/**
 * Entity Node Types — shared type definitions for all entity node classes.
 *
 * Each entity type (member, prescriber, pharmacy, insurer) has a typed
 * config that extends the base EntityNodeConfig. These types define the
 * query results, activity summaries, and proof timing data structures
 * used across all node implementations.
 */
import type { L2ClientOptions } from '../l2/l2-client.js';

// ─── Entity Roles ─────────────────────────────────────────

/** The five entity types in the zkpCare system */
export type EntityRole = 'member' | 'prescriber' | 'pharmacy' | 'insurer' | 'employer';

// ─── Node Configuration ──────────────────────────────────

/** Base configuration for all entity nodes */
export interface EntityNodeConfig {
  /** Entity type (determines capabilities and query methods) */
  role: EntityRole;
  /** Primary sequencer URL (e.g., 'http://localhost:3030') */
  sequencerUrl: string;
  /** Poseidon-hashed wallet ID (not needed for insurer) */
  walletId?: string;
  /** Human-readable display name (optional, for logging) */
  displayName?: string;
  /** Override default L2Client options */
  clientOptions?: Partial<L2ClientOptions>;
}

/** Member node config — wallet ID required */
export interface MemberNodeConfig extends EntityNodeConfig {
  role: 'member';
  walletId: string;
}

/** Prescriber node config — wallet ID required */
export interface PrescriberNodeConfig extends EntityNodeConfig {
  role: 'prescriber';
  walletId: string;
}

/** Pharmacy node config — wallet ID required */
export interface PharmacyNodeConfig extends EntityNodeConfig {
  role: 'pharmacy';
  walletId: string;
}

/** Insurer node config — no wallet ID, admin-gated */
export interface InsurerNodeConfig extends EntityNodeConfig {
  role: 'insurer';
}

/** Employer node config — no wallet ID, token authority */
export interface EmployerNodeConfig extends EntityNodeConfig {
  role: 'employer';
  /** Employer identifier used as TokenAuthority issuer */
  employerId: string;
  /** Optional insurer Nautilus URL for token submission */
  insurerUrl?: string;
}

// ─── Claim View ──────────────────────────────────────────

/**
 * EntityClaimView — enriched claim entry for entity display.
 *
 * Transforms a ClaimAccumulatorEntry into a human-readable view
 * with all available metadata from the claim accumulator.
 */
export interface EntityClaimView {
  /** Leaf index in the Claim Accumulator Tree */
  leafIndex: bigint;
  /** Date of service as CCYYMMDD string */
  dateOfService: string;
  /** Patient copay in cents (decimal string) */
  patientPayCents: string;
  /** Plan pay in cents (decimal string) */
  planPayCents: string;
  /** Whether this is a fill or reversal */
  operationType: 'fulfillment' | 'reversal';
  /** Member wallet ID (Poseidon hash as decimal string) */
  memberWalletId: string;
  /** Pharmacy wallet ID */
  pharmacyWalletId: string;
  /** Prescriber wallet ID */
  prescriberWalletId: string;
  /** NDC hash (Poseidon hash of NDC code) */
  ndcHash: string;
  /** Drug brand or generic name (from metadata) */
  brandName?: string;
  /** Plaintext 11-digit NDC code (from metadata) */
  ndc?: string;
  /** Formulary tier level (from metadata) */
  tierLevel?: number;
  /** Therapeutic classification (from metadata) */
  therapeuticClass?: string;
  /** Days supply (from metadata) */
  daysSupply?: number;
  /** Fill number: 0=original, 1+=refill (from metadata) */
  fillNumber?: number;
  /** 14-digit GPI code (from metadata) */
  gpi?: string;
  /** L2 receipt ID that submitted this claim */
  receiptId: string;
  /** Timestamp when the claim was accepted by the sequencer */
  timestamp: number;
}

// ─── Activity Summaries ──────────────────────────────────

/** Base activity summary shared by all entity types */
export interface EntityActivitySummary {
  /** Total fulfilled claims */
  totalClaims: number;
  /** Total reversals */
  totalReversals: number;
  /** Claims minus reversals */
  activeClaims: number;
  /** Sum of all patient pay amounts */
  totalPatientPayCents: bigint;
  /** Sum of all plan pay amounts */
  totalPlanPayCents: bigint;
  /** Number of distinct NDC hashes */
  uniqueMedications: number;
  /** Earliest and latest dateOfService, or null if no claims */
  dateRange: { earliest: string; latest: string } | null;
}

/** Extended summary for prescribers */
export interface PrescriberActivitySummary extends EntityActivitySummary {
  /** Number of distinct patient wallet IDs */
  uniquePatients: number;
  /** Number of distinct pharmacy wallet IDs */
  uniquePharmacies: number;
}

/** Extended summary for pharmacies */
export interface PharmacyActivitySummary extends EntityActivitySummary {
  /** Number of distinct patient wallet IDs */
  uniquePatients: number;
  /** Number of distinct prescriber wallet IDs */
  uniquePrescribers: number;
}

// ─── Breakdown Entries ───────────────────────────────────

/** Per-medication breakdown for prescribers and pharmacies */
export interface MedicationBreakdownEntry {
  ndcHash: string;
  brandName?: string;
  tierLevel?: number;
  therapeuticClass?: string;
  claimCount: number;
  totalPatientPayCents: bigint;
  totalPlanPayCents: bigint;
}

/** Per-prescriber breakdown for pharmacies */
export interface PrescriberBreakdownEntry {
  prescriberWalletId: string;
  claimCount: number;
  uniqueMedications: number;
  totalPatientPayCents: bigint;
  totalPlanPayCents: bigint;
}

// ─── Proof Timing ────────────────────────────────────────

/** Proof generation timing for delegation decisions */
export interface ProofTimingEstimate {
  /** Name of the ZkProgram */
  programName: string;
  /** Expected proof time on this device (ms) */
  estimatedMs: number;
  /** Actual last measurement (ms), if available */
  lastMeasuredMs?: number;
}
