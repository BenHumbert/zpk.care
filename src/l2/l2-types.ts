/**
 * L2 Types — Type interfaces for the zkpCare L2 chain.
 *
 * Pure type definitions — no runtime code.
 * These types define the data structures for L2 receipts, blocks,
 * batches, node configuration, and admin state deltas.
 */

// ─── L2 Receipt ─────────────────────────────────────────────

/** Status of an L2 receipt relative to L1 settlement */
export type L1Status = 'pending' | 'batched' | 'settled' | 'failed';

/**
 * L2Receipt — instant confirmation issued by the sequencer.
 *
 * When a node submits a StateTransitionProof, the sequencer verifies it
 * (~5ms) and issues an L2Receipt as instant confirmation. The receipt
 * tracks L1 settlement status as it progresses through batching.
 */
export interface L2Receipt {
  /** Unique receipt identifier */
  receiptId: string;
  /** Wallet involved in this transition */
  walletId: string;
  /** Monotonic sequence number within the L2 chain */
  sequenceNumber: bigint;
  /** Registry root before this transition */
  oldRegistryRoot: string;
  /** Registry root after this transition */
  newRegistryRoot: string;
  /** Lifecycle root before this transition */
  oldLifecycleRoot: string;
  /** Lifecycle root after this transition */
  newLifecycleRoot: string;
  /** Whether this transition was a new wallet registration */
  isRegistration: boolean;
  /** L2 block this receipt belongs to (set after batching) */
  l2BlockNumber?: bigint;
  /** Timestamp when the sequencer accepted the proof */
  acceptedAt: number;
  /** Current L1 settlement status */
  l1Status: L1Status;
  /** L1 batch number (set after batching) */
  l1BatchNumber?: bigint;
  /** Links receipt to AuditEvent chain hash (set by DA emission) */
  auditEventHash?: string;
}

// ─── L2 Block ───────────────────────────────────────────────

/**
 * L2Block — logical grouping of receipts within a batch window.
 *
 * Created when buildBatch() is called. One block per batch interval.
 */
export interface L2Block {
  /** Block number (monotonic) */
  blockNumber: bigint;
  /** Receipt IDs included in this block */
  receiptIds: string[];
  /** Registry root at start of block */
  startRegistryRoot: string;
  /** Registry root at end of block */
  endRegistryRoot: string;
  /** Lifecycle root at start of block */
  startLifecycleRoot: string;
  /** Lifecycle root at end of block */
  endLifecycleRoot: string;
  /** Number of new wallet registrations in this block */
  registrationCount: number;
  /** Total transitions in this block */
  transitionCount: number;
  /** Timestamp when block was created */
  createdAt: number;
  /** Current L1 settlement status */
  l1Status: L1Status;
  /** L1 transaction hash (set after settlement) */
  l1TxHash?: string;
}

// ─── L2 Batch ───────────────────────────────────────────────

/**
 * L2Batch — settlement metadata for an L1 transaction.
 *
 * Contains the BatchProof JSON needed for CareContract.settleBatch().
 * One batch = one L1 transaction = one 3-minute MINA block.
 */
export interface L2Batch {
  /** Batch number (monotonic) */
  batchNumber: bigint;
  /** Block numbers included in this batch */
  blockNumbers: bigint[];
  /** Total new wallet registrations across all blocks */
  registrationCount: number;
  /** Total transitions across all blocks */
  transitionCount: number;
  /** Registry root at start of batch */
  oldRegistryRoot: string;
  /** Registry root at end of batch */
  newRegistryRoot: string;
  /** Lifecycle root at start of batch */
  oldLifecycleRoot: string;
  /** Lifecycle root at end of batch */
  newLifecycleRoot: string;
  /** Serialized BatchProof JSON for L1 submission */
  batchProofJson: string;
  /** Timestamp when batch was created */
  createdAt: number;
  /** Current L1 settlement status */
  l1Status: L1Status;
  /** L1 transaction hash (set after settlement) */
  l1TxHash?: string;
  /** Reason for failure (set by markBatchFailed) */
  failureReason?: string;
}

// ─── L2 Node Config ─────────────────────────────────────────

/** Entity type for node classification */
export type L2EntityType = 'member' | 'prescriber' | 'pharmacy' | 'sequencer' | 'validator';

/**
 * L2NodeConfig — configuration for an L2 node.
 *
 * Distributed with node software. Each node type has different
 * capabilities (pharmacies generate proofs, sequencer batches).
 */
export interface L2NodeConfig {
  /** Wallet ID of the node operator */
  walletId: string;
  /** Entity type determines capabilities */
  entityType: L2EntityType;
  /** URL of the L2 sequencer to submit proofs to */
  sequencerUrl: string;
  /** Batch interval in milliseconds (default 180,000 = 3 min) */
  batchIntervalMs: number;
  /** MINA L1 RPC URL for settlement and fallback */
  l1RpcUrl: string;
  /** Whether to fall back to L1 if L2 sequencer is unreachable */
  l1FallbackMode: boolean;
  /** Maximum retries before falling back to L1 */
  maxL2Retries: number;
}

// ─── Admin State Delta ──────────────────────────────────────

/** Type of admin operation */
export type AdminOperationType =
  | 'updateBenefitPlan'
  | 'registerGlobalNft'
  | 'initEligibilityState'
  | 'initMessaging'
  | 'submitMessage'
  | 'registerDelegation'
  | 'registerEncryptionKey';

/** Status of a queued admin operation */
export type AdminOpStatus = 'queued' | 'submitted' | 'confirmed' | 'failed';

/**
 * AdminStateDelta — queued admin operation.
 *
 * Admin operations (slots 4-7) are NOT batched — they require
 * admin signatures and go directly to L1. The sequencer queues
 * them and submits individually between batches.
 */
export interface AdminStateDelta {
  /** Type of admin operation */
  operationType: AdminOperationType;
  /** Operation-specific parameters (serialized) */
  params: Record<string, string>;
  /** Timestamp when operation was queued */
  queuedAt: number;
  /** Current status */
  status: AdminOpStatus;
}
