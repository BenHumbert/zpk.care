/**
 * L2Checkpoint — Persistence & Crash Recovery for the zkpCare L2 chain.
 *
 * Captures the full L2 chain state at a point in time (typically after
 * each settled batch). On restart, the node rebuilds from the latest
 * checkpoint and resumes accepting proofs.
 *
 * What IS checkpointed:
 *   - Current Merkle roots (registry, lifecycle)
 *   - Wallet count
 *   - All receipts, blocks, batches, audit events
 *   - Counters (sequence#, block#, batch#)
 *   - Audit chain hash
 *   - Node stats (proofs accepted, batches built/settled/failed)
 *
 * What is NOT checkpointed:
 *   - Pending proof pool — proofs are transient. Clients resubmit after
 *     recovery. This is by design: the safe recovery point is the last
 *     settled batch, and any proofs accepted since then were not yet
 *     settled on L1 anyway.
 *
 * File format: JSON with BigInt support via l2Stringify/l2Parse.
 * File naming: l2-checkpoint-{timestamp}.json (sorts chronologically).
 *
 * Zero external dependencies — uses Node.js built-in fs module.
 */
import fs from 'fs/promises';
import path from 'path';
import { l2Stringify, l2Parse } from './l2-json.js';
import type { L2Receipt, L2Block, L2Batch, AdminStateDelta } from './l2-types.js';
import type { AuditEvent } from '../audit/audit-types.js';

// ─── Types ──────────────────────────────────────────────────

/**
 * Serializable snapshot of L2SequencerService state.
 *
 * All Field values stored as decimal strings.
 * All bigint values preserved via l2Stringify.
 */
export interface L2SequencerState {
  /** Current registry root (decimal string) */
  currentRegistryRoot: string;
  /** Current lifecycle root (decimal string) */
  currentLifecycleRoot: string;
  /** Current wallet count (decimal string) */
  currentWalletCount: string;
  /** Next sequence number to assign */
  nextSequenceNumber: bigint;
  /** Next block number to assign */
  nextBlockNumber: bigint;
  /** Next batch number to assign */
  nextBatchNumber: bigint;
  /** Latest audit chain hash (decimal string) */
  latestChainHash: string;
  /** Batch awaiting L1 settlement, or null */
  inFlightBatchNumber: bigint | null;
  /** All receipts */
  receipts: L2Receipt[];
  /** All blocks */
  blocks: L2Block[];
  /** All batches */
  batches: L2Batch[];
  /** Full audit event log */
  auditLog: AuditEvent[];
  /** Queued admin operations */
  adminQueue: AdminStateDelta[];

  // ── Chain proof state (optional — present when ChainProgram is enabled) ──

  /** Admin state config for GlobalState computation (decimal strings) */
  adminState?: {
    adminPublicKeyHash: string;
    benefitPlanRoot: string;
    credentialRegistryRoot: string;
    eligibilityVkHash: string;
    messagingRoot: string;
  };
  /** Latest ChainProof JSON for advance() input (null before first batch) */
  latestChainProofJson?: string | null;
  /** Current block height (decimal string) */
  currentBlockHeight?: string;
  /** Current global state root (decimal string) */
  currentGlobalStateRoot?: string;

  // ── Formulary state (optional — present when formularies are published) ──

  /** Published formularies indexed by planIdHash */
  formularyStore?: Record<string, {
    formularyRoot: string;
    entriesJson: string;
    publishedAt: number;
    version: number;
  }>;

  // ── Audit Merkle Index state (optional — present when audit events have been indexed) ──

  /** Serialized audit Merkle index state for crash recovery */
  auditMerkleIndexState?: import('../audit/audit-merkle-index.js').AuditMerkleState;

  // ── Claim Accumulator state (optional — present when claims have been submitted) ──

  /** Serialized claim accumulator state for crash recovery */
  claimAccumulatorState?: import('./claim-accumulator-types.js').ClaimAccumulatorState;

  // ── Message Store state (optional — present when messages have been stored) ──

  /** Serialized message store state for crash recovery */
  messageStoreState?: import('./message-store-types.js').MessageStoreState;

  // ── Provider Registry state (optional — present when providers have been credentialed) ──

  /** Serialized provider registry state for crash recovery */
  providerRegistryState?: import('./provider-registry-types.js').ProviderRegistryState;

  // ── Last-settled roots (crash recovery safe point) ──

  /** Registry root at last settled batch (decimal string). Optional for backward compat. */
  lastSettledRegistryRoot?: string;
  /** Lifecycle root at last settled batch (decimal string). Optional for backward compat. */
  lastSettledLifecycleRoot?: string;
  /** Wallet count at last settled batch (decimal string). Optional for backward compat. */
  lastSettledWalletCount?: string;

  // ── L2-only mode flag ──

  /** Whether the sequencer was in L2-only mode (no L1 settlement). Optional for backward compat. */
  l2Only?: boolean;

  // ── Proof fingerprint deduplication ──

  /** Seen proof fingerprints for replay prevention. Optional for backward compat. */
  seenProofFingerprints?: string[];

  // ── Pre-batch rollback snapshots (H5 fix) ──

  /** Audit log length at last settlement — truncation point for batch failure rollback */
  preBatchAuditLogLength?: number;
  /** Chain hash at last settlement — restore point for batch failure rollback (decimal string) */
  preBatchChainHash?: string;
  /** Claim accumulator leaf count at last settlement — rollback point for batch failure */
  preBatchClaimLeafCount?: bigint;
  /** Audit Merkle index leaf count at last settlement — rollback point for batch failure */
  preBatchAuditMerkleLeafCount?: bigint;
  /** Proof fingerprints at last settlement — rollback set for batch failure */
  preBatchFingerprints?: string[];

  // ── Witness tree reconstruction ──

  /** Ordered list of registered walletId strings for rebuilding WalletRegistry + lifecycle tree */
  registeredWallets?: string[];
}

/**
 * L2Node statistics — counters for operational monitoring.
 */
export interface L2NodeStats {
  totalProofsAccepted: number;
  totalBatchesBuilt: number;
  totalBatchesSettled: number;
  totalBatchesFailed: number;
  nextSettlementId: number;
}

/** What triggered this checkpoint */
export type L2CheckpointTrigger = 'batch_settled' | 'manual' | 'shutdown';

/**
 * L2Checkpoint — full chain state snapshot for crash recovery.
 *
 * Saved to disk after each batch settlement, on manual request,
 * or during graceful shutdown.
 */
export interface L2Checkpoint {
  /** Schema version for forward compatibility */
  version: number;
  /** Timestamp when checkpoint was created */
  createdAt: number;
  /** What triggered this checkpoint */
  trigger: L2CheckpointTrigger;
  /** Last settled batch number, or null if none settled yet */
  lastSettledBatchNumber: bigint | null;
  /** Full sequencer state */
  sequencerState: L2SequencerState;
  /** Node-level statistics */
  nodeStats: L2NodeStats;
}

/**
 * LeviathanCheckpoint — multi-partition checkpoint for leviathan nodes.
 *
 * Captures per-partition sequencer states, the leader map, and
 * leviathan configuration for crash recovery of partitioned nodes.
 */
export interface LeviathanCheckpoint {
  /** Schema version for forward compatibility */
  version: number;
  /** Timestamp when checkpoint was created */
  createdAt: number;
  /** What triggered this checkpoint */
  trigger: L2CheckpointTrigger;
  /** Per-partition sequencer states (partitionIndex → L2SequencerState) */
  partitionStates: Record<number, L2SequencerState>;
  /** Leader map at checkpoint time (partitionIndex → leader nodeId) */
  leaderMap: Record<number, string>;
  /** Per-partition node stats (partitionIndex → L2NodeStats) */
  partitionNodeStats: Record<number, L2NodeStats>;
  /** Leviathan configuration for recovery */
  leviathanConfig: {
    partitionCount: number;
    primaryPartition: number;
    failoverChain: Record<number, string[]>;
  };
  /** Per-partition last WAL sequence number at checkpoint time (for WAL recovery resume point) */
  walSequenceNumbers?: Record<number, string>;
}

// ─── Constants ──────────────────────────────────────────────

/** Current checkpoint schema version */
export const CHECKPOINT_VERSION = 1;

/** Filename prefix for checkpoint files */
const CHECKPOINT_PREFIX = 'l2-checkpoint-';

/** Filename suffix for checkpoint files */
const CHECKPOINT_SUFFIX = '.json';

// ─── L2CheckpointStore ──────────────────────────────────────

/**
 * File-based checkpoint persistence.
 *
 * Manages checkpoint files in a dedicated directory.
 * Files are named with timestamps for chronological ordering.
 * Supports pruning to limit disk usage.
 */
export class L2CheckpointStore {
  private dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  /**
   * Save a checkpoint to disk.
   *
   * Creates the data directory if it doesn't exist.
   * Uses atomic-ish write: stringify first, then write in one call.
   *
   * @returns The filename of the saved checkpoint
   */
  async save(checkpoint: L2Checkpoint): Promise<string> {
    await fs.mkdir(this.dataDir, { recursive: true });

    const timestamp = checkpoint.createdAt.toString().padStart(16, '0');
    const filename = `${CHECKPOINT_PREFIX}${timestamp}${CHECKPOINT_SUFFIX}`;
    const filepath = path.join(this.dataDir, filename);

    const content = l2Stringify(checkpoint);

    // Atomic write: write to temp file + fsync + rename
    const tmpPath = filepath + '.tmp';
    const fh = await fs.open(tmpPath, 'w');
    try {
      await fh.writeFile(content, 'utf-8');
      await fh.sync(); // fsync guarantees data is on disk
    } finally {
      await fh.close();
    }
    await fs.rename(tmpPath, filepath); // atomic on same filesystem

    return filename;
  }

  /**
   * Load the most recent checkpoint.
   *
   * @returns The latest checkpoint, or null if no checkpoints exist
   */
  async loadLatest(): Promise<L2Checkpoint | null> {
    const files = await this.list();
    if (files.length === 0) return null;

    // Files are sorted ascending by timestamp; latest is last
    return this.load(files[files.length - 1]);
  }

  /**
   * Load a specific checkpoint by filename.
   *
   * @throws If the file doesn't exist or is corrupted
   */
  async load(filename: string): Promise<L2Checkpoint> {
    const filepath = path.join(this.dataDir, filename);
    const content = await fs.readFile(filepath, 'utf-8');
    return l2Parse<L2Checkpoint>(content);
  }

  /**
   * List all checkpoint files in chronological order.
   *
   * @returns Sorted array of checkpoint filenames (oldest first)
   */
  async list(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.dataDir);
      return entries
        .filter(
          (f) =>
            f.startsWith(CHECKPOINT_PREFIX) && f.endsWith(CHECKPOINT_SUFFIX),
        )
        .sort(); // Timestamp-based names sort correctly as strings
    } catch {
      return []; // Directory doesn't exist yet
    }
  }

  /**
   * Prune old checkpoint files, keeping the most recent ones.
   *
   * @param keepCount — number of recent checkpoints to keep
   * @returns Number of files deleted
   */
  async prune(keepCount: number): Promise<number> {
    const files = await this.list();
    if (files.length <= keepCount) return 0;

    const toDelete = files.slice(0, files.length - keepCount);
    for (const filename of toDelete) {
      await fs.unlink(path.join(this.dataDir, filename));
    }

    return toDelete.length;
  }

  /** Get the data directory path */
  getDataDir(): string {
    return this.dataDir;
  }
}
