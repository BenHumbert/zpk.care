/**
 * L2 Leviathan Types — Multi-leader partitioned node architecture.
 *
 * Pure type definitions for the leviathan system where N nodes each lead
 * one partition of the wallet space while replicating all other partitions
 * via gossip. Automatic failover when a partition leader goes down.
 *
 * Zero external dependencies — pure TypeScript interfaces and constants.
 */

// ─── Constants ──────────────────────────────────────────

/** Default heartbeat broadcast interval (5 seconds) */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;

/** Default heartbeat timeout before failover (15 seconds = 3 missed heartbeats) */
export const DEFAULT_HEARTBEAT_TIMEOUT_MS = 15_000;

// ─── Leviathan Configuration ────────────────────────────

/**
 * LeviathanConfig — configuration for a multi-leader leviathan node.
 *
 * Each leviathan leads one primary partition and replicates all others.
 * The failover chain determines promotion priority when a leader goes down.
 */
export interface LeviathanConfig {
  /** Total number of partitions (e.g., 5 leviathans = 5 partitions) */
  partitionCount: number;

  /** This leviathan's primary partition index (0-based) */
  primaryPartition: number;

  /**
   * Failover priority chain per partition.
   *
   * failoverChain[partitionIndex] = ['nodeId-primary', 'nodeId-backup1', ...]
   * The first nodeId is the primary leader; subsequent are failover candidates
   * in priority order. When the leader's heartbeat times out, the highest-priority
   * live node in the chain promotes itself.
   *
   * Example for 3 partitions:
   *   0 → ['lev-0', 'lev-1', 'lev-2']
   *   1 → ['lev-1', 'lev-2', 'lev-0']
   *   2 → ['lev-2', 'lev-0', 'lev-1']
   */
  failoverChain: Map<number, string[]>;

  /** Heartbeat broadcast interval in ms. Default 5000. */
  heartbeatIntervalMs: number;

  /** Heartbeat timeout: promote after this many ms without heartbeat. Default 15000. */
  heartbeatTimeoutMs: number;
}

// ─── Leadership Tracking ────────────────────────────────

/**
 * PartitionLeaderEntry — tracks the current leader for one partition.
 *
 * Each leviathan maintains a leaderMap with one entry per partition.
 */
export interface PartitionLeaderEntry {
  /** Partition index */
  partitionIndex: number;

  /** Node ID of the current leader */
  currentLeader: string;

  /** Timestamp of last heartbeat received from the leader */
  lastHeartbeatAt: number;

  /** Whether THIS node is actively leading this partition */
  isLocalLeader: boolean;
}

// ─── Gossip Payloads ────────────────────────────────────

/**
 * LeaderHeartbeatPayload — broadcast periodically by each leviathan.
 *
 * Contains the node's identity, which partitions it leads, and
 * per-partition sequence numbers for sync verification.
 */
export interface LeaderHeartbeatPayload {
  /** Node ID of the heartbeating leader */
  nodeId: string;

  /** Partition indices this node is currently leading */
  partitions: number[];

  /** Per-partition latest sequence numbers (partition index → sequence number as string) */
  partitionSequences: Record<number, string>;

  /** Timestamp when heartbeat was generated */
  timestamp: number;

  /** Ed25519 public key hex for quorum signing (64 hex chars, optional for backward compat) */
  publicKeyHex?: string;
}

/**
 * LeaderPromotionPayload — broadcast when a node promotes itself to leader.
 *
 * All nodes update their leaderMap on receipt. If a lower-priority node
 * also promoted, it demotes upon seeing a higher-priority promotion.
 */
export interface LeaderPromotionPayload {
  /** Node ID of the new leader */
  newLeaderId: string;

  /** Partition being taken over */
  partitionIndex: number;

  /** Node ID of the previous leader (or 'unknown' if not determinable) */
  previousLeaderId: string;

  /** Reason for the promotion */
  reason: 'heartbeat_timeout' | 'manual' | 'rejoin';

  /** Timestamp when promotion occurred */
  timestamp: number;
}

// ─── Status Types ───────────────────────────────────────

/**
 * PartitionStats — status snapshot for one partition on this node.
 */
export interface PartitionStats {
  /** Partition index */
  partitionIndex: number;

  /** Whether this node is the leader for this partition */
  isLeader: boolean;

  /** Node ID of the current leader */
  currentLeader: string;

  /** Number of proofs waiting in the pending pool (leader only) */
  pendingProofs: number;

  /** Total receipts stored for this partition */
  totalReceipts: number;

  /** Total batches built for this partition */
  totalBatches: number;

  /** Highest sequence number assigned in this partition */
  latestSequenceNumber: string;

  /** Current registry root for this partition */
  registryRoot: string;

  /** Current lifecycle root for this partition */
  lifecycleRoot: string;

  /** Current wallet count for this partition */
  walletCount: string;

  /** Current audit chain hash for this partition */
  auditChainHash: string;
}

/**
 * LeviathanStatus — full status snapshot for a leviathan node.
 *
 * Aggregates per-partition stats with global totals.
 */
export interface LeviathanStatus {
  /** This node's unique identifier */
  nodeId: string;

  /** Always 'leviathan' for multi-leader nodes */
  role: 'leviathan';

  /** Total number of partitions in the network */
  partitionCount: number;

  /** This node's primary (home) partition */
  primaryPartition: number;

  /** Partitions this node is currently leading (includes primary + any failover) */
  activeLeaderPartitions: number[];

  /** Leader map: partition index → leader nodeId */
  leaderMap: Record<number, string>;

  /** Per-partition statistics */
  partitionStats: PartitionStats[];

  /** Global totals across all partitions */
  globalTotals: {
    totalProofsAccepted: number;
    totalBatchesBuilt: number;
    totalBatchesSettled: number;
    totalBatchesFailed: number;
    pendingProofs: number;
  };

  /** Whether the node is running */
  running: boolean;

  /** Uptime in milliseconds */
  uptimeMs: number;

  /** Whether the node operates in L2-only mode */
  l2Only: boolean;
}
