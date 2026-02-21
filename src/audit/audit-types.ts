/**
 * Audit Types — Data Availability & Audit Trail for zkpCare L2 chain.
 *
 * Pure type definitions — no runtime code.
 * AuditEvents form a Poseidon hash chain for tamper-evident DA.
 * Verification results follow the isValid/reason pattern from L5-L9.
 */

import type { L1Status } from '../l2/l2-types.js';
import type { ClaimContext } from '../reporting/report-types.js';

// ─── AuditEvent ─────────────────────────────────────────────

/**
 * AuditEvent — DA record emitted per L2 state transition.
 *
 * Each event carries a Poseidon hash chain: chainHash = Poseidon.hash([prevChainHash, eventCommitment]).
 * The eventCommitment is a Poseidon hash of the 8 core state-transition fields (including ndcHash).
 * Tampering with any event breaks the chain from that point forward.
 */
export interface AuditEvent {
  /** Monotonic sequence number (from L2Receipt) */
  sequenceNumber: bigint;
  /** Links to L2Receipt.receiptId */
  receiptId: string;
  /** Opaque wallet hash involved in this transition */
  walletId: string;
  /** Whether this transition was a new wallet registration */
  isRegistration: boolean;
  /** Registry root before this transition */
  oldRegistryRoot: string;
  /** Registry root after this transition */
  newRegistryRoot: string;
  /** Lifecycle root before this transition */
  oldLifecycleRoot: string;
  /** Lifecycle root after this transition */
  newLifecycleRoot: string;
  /** Poseidon hash of 10 core state fields (including ndcHash, patientPayCents, planPayCents) */
  eventCommitment: string;
  /** Poseidon.hash([prevChainHash, eventCommitment]) — tamper-evident chain */
  chainHash: string;
  /** Timestamp when event was created (Date.now()) */
  timestamp: number;
  /** Current L1 settlement status */
  l1Status: L1Status;
  /** L2 block number (set after batching) */
  l2BlockNumber?: bigint;
  /** L1 batch number (set after batching) */
  l1BatchNumber?: bigint;
  /** Optional financial context (pharmacy-provided, verifiable) */
  claimContext?: ClaimContext;
  /** ZK-computed patient copay in cents (from proof output) */
  patientPayCents?: number;
  /** ZK-computed plan pay in cents (from proof output) */
  planPayCents?: number;
  /** Poseidon hash of NDC code — drug identity from FulfillmentProof output (optional for non-claim events) */
  ndcHash?: string;
}

// ─── AuditLog ───────────────────────────────────────────────

/**
 * AuditLog — ordered collection of AuditEvents with chain anchors.
 *
 * The genesisHash is the initial chain seed: Poseidon.hash([Field(0)]).
 * latestChainHash is the chainHash of the most recent event.
 */
export interface AuditLog {
  /** Ordered audit events */
  events: AuditEvent[];
  /** Initial chain seed — Poseidon.hash([Field(0)]) */
  genesisHash: string;
  /** Chain hash of the most recent event */
  latestChainHash: string;
  /** Total number of events */
  eventCount: bigint;
}

// ─── OnChainState ───────────────────────────────────────────

/**
 * Snapshot of on-chain state for settlement verification.
 *
 * Read from CareContract at audit time.
 */
export interface OnChainState {
  /** Current walletRegistryRoot from CareContract */
  walletRegistryRoot: string;
  /** Current lifecycleRoot from CareContract */
  lifecycleRoot: string;
  /** Current walletCount from CareContract */
  walletCount: bigint;
}

// ─── Verification Results ───────────────────────────────────

/** Chain integrity — verifies Poseidon hash chain is unbroken. */
export interface ChainIntegrityResult {
  isValid: boolean;
  totalEvents: number;
  /** Sequence numbers where the chain hash doesn't match recomputed value */
  brokenLinks: number[];
  reason?: string;
}

/** Financial balance — verifies patientPay + planPay == ingredientCost + dispensingFee. */
export interface FinancialBalanceResult {
  isValid: boolean;
  totalClaims: number;
  /** Receipt IDs where amounts don't balance */
  imbalancedClaims: string[];
  totalPatientPayCents: number;
  totalPlanPayCents: number;
  totalIngredientCostCents: number;
  totalDispensingFeeCents: number;
  reason?: string;
}

/** Duplicate detection — identifies potential duplicate claims. */
export interface DuplicateDetectionResult {
  hasDuplicates: boolean;
  /** Groups of receipts sharing the same (walletId + ndcHash + dateOfService) */
  duplicateGroups: { key: string; receiptIds: string[] }[];
  totalDuplicates: number;
}

/** Sequence gap detection — finds missing sequence numbers. */
export interface SequenceGapResult {
  hasGaps: boolean;
  /** Each gap: expected sequence number vs actual next number found */
  gaps: { expected: bigint; actual: bigint }[];
  totalGaps: number;
}

/** Orphaned receipt detection — finds receipts that were never batched. */
export interface OrphanedReceiptResult {
  hasOrphans: boolean;
  /** Receipt IDs still pending beyond the orphan threshold */
  orphanedReceiptIds: string[];
  totalOrphans: number;
}

/** L1 settlement verification — checks batch settlement status. */
export interface SettlementResult {
  isComplete: boolean;
  settledBatches: number;
  pendingBatches: number;
  failedBatches: number;
  /** Whether latest settled batch root matches current on-chain root */
  rootConsistent: boolean;
  reason?: string;
}

/** Enrollment consistency — compares L2 registrations vs roster entries. */
export interface EnrollmentConsistencyResult {
  isConsistent: boolean;
  /** Count of L2 registration events */
  registrationCount: number;
  /** Count of roster entries */
  rosterCount: number;
  /** Number of mismatches */
  mismatchCount: number;
  /** Wallet IDs in roster but with no L2 registration event */
  unregisteredWallets: string[];
  /** Wallet IDs with L2 registration but not in roster */
  unrosteredWallets: string[];
  reason?: string;
}

// ─── Full Audit Report ──────────────────────────────────────

/**
 * FullAuditReport — aggregation of all audit checks.
 *
 * overallHealthy is true when all critical checks pass:
 *   chain valid && no financial imbalance && no duplicates && no gaps && settlement roots match
 *
 * Note: orphaned receipts DON'T fail overall health
 *   (pending work is expected between batch intervals).
 */
export interface FullAuditReport {
  chainIntegrity: ChainIntegrityResult;
  financialBalance: FinancialBalanceResult;
  duplicateDetection: DuplicateDetectionResult;
  sequenceGaps: SequenceGapResult;
  orphanedReceipts: OrphanedReceiptResult;
  settlement: SettlementResult;
  enrollmentConsistency: EnrollmentConsistencyResult;
  /** Timestamp when audit was performed */
  auditedAt: number;
  /** True when all critical checks pass */
  overallHealthy: boolean;
  /** Summary messages for each check */
  details: string[];
}
