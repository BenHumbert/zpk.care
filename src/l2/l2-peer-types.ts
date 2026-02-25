/**
 * L2 Peer Types — Type definitions for the distributed L2 node network.
 *
 * Defines the gossip protocol, peer identity, and message formats
 * for Bitcoin-style full node replication across the zkpCare L2 chain.
 *
 * Architecture:
 *   - Single sequencer orders proofs, builds batches, settles on MINA L1
 *   - N full replicas receive gossip, store everything, serve queries
 *   - Any node can accept proofs; replicas forward to the sequencer
 *   - Gossip messages relay through connected peers (epidemic spread)
 *   - Deduplication via message IDs prevents infinite loops
 *   - MINA L1 roots provide trustless verification anchor
 *
 * Zero external dependencies — uses Node.js built-in http + o1js Poseidon.
 */
import type { L2Receipt, L2Block, L2Batch } from './l2-types.js';
import type { AuditEvent } from '../audit/audit-types.js';
import type { ClaimAccumulatorEntry } from './claim-accumulator-types.js';
import type { StoredMessage, MessagePayload } from './message-store-types.js';
import type { L2SequencerState } from './l2-checkpoint.js';
import type { LeaderHeartbeatPayload, LeaderPromotionPayload } from './l2-leviathan-types.js';

// ─── Node Role ──────────────────────────────────────────

/** Role of an L2 node in the network */
export type L2NodeRole = 'sequencer' | 'replica' | 'leviathan';

// ─── Peer Identity ──────────────────────────────────────

/** Status of a peer connection */
export type PeerStatus = 'connected' | 'disconnected' | 'syncing';

/**
 * PeerInfo — identity and status of a peer node.
 *
 * Exchanged during peer discovery and tracked locally
 * by each node's L2PeerNetwork instance.
 */
export interface PeerInfo {
  /** Unique node identifier (UUID or user-assigned) */
  peerId: string;
  /** HTTP RPC endpoint URL (e.g., 'http://node-b:3030') */
  url: string;
  /** Node role: sequencer or replica */
  role: L2NodeRole;
  /** Current connection status */
  status: PeerStatus;
  /** Timestamp of last successful communication */
  lastSeen: number;
  /** Highest sequence number this peer has acknowledged */
  latestSequenceNumber: bigint;
  /** Highest settled batch number, or null if none */
  latestBatchNumber: bigint | null;
}

// ─── Gossip Message Types ────────────────────────────────

/** All gossip message types in the protocol */
export type GossipMessageType =
  | 'proof:accepted'      // New receipt + audit event + optional claim entry
  | 'batch:built'         // New block + batch metadata + receipt status updates
  | 'batch:settled'       // L1 tx hash + settlement confirmation
  | 'batch:failed'        // Batch failure + reason
  | 'state:snapshot'      // Full state for IBD (response to sync request)
  | 'peer:announce'       // Peer discovery + exchange peer lists
  | 'message:stored'      // New encrypted message stored in Message Store
  | 'leader:heartbeat'    // Leviathan leader heartbeat (partition leadership)
  | 'leader:promotion';   // Leviathan leader promotion (failover)

// ─── Gossip Payloads ─────────────────────────────────────

/**
 * ProofAcceptedPayload — broadcast when the sequencer accepts a proof.
 *
 * Contains the receipt, audit event, and optional claim entry.
 * Replicas apply this to their local state without re-verifying the proof.
 */
export interface ProofAcceptedPayload {
  receipt: L2Receipt;
  auditEvent: AuditEvent;
  /** Present when ClaimSubmissionMetadata was provided with the proof */
  claimEntry?: ClaimAccumulatorEntry;
  /** Current registry root after this proof */
  currentRegistryRoot: string;
  /** Current lifecycle root after this proof */
  currentLifecycleRoot: string;
  /** Current wallet count after this proof */
  currentWalletCount: string;
  /** Partition index (leviathan mode). Undefined for single-sequencer backward compat. */
  partitionIndex?: number;
}

/**
 * BatchBuiltPayload — broadcast when the sequencer builds a batch.
 *
 * Contains the full batch (with batchProofJson), the block,
 * and updated receipts/audit events with l1Status='batched'.
 */
export interface BatchBuiltPayload {
  batch: L2Batch;
  block: L2Block;
  /** Receipts with updated l1Status, l2BlockNumber, l1BatchNumber */
  updatedReceipts: L2Receipt[];
  /** Audit events with updated l1Status, l2BlockNumber, l1BatchNumber */
  updatedAuditEvents: AuditEvent[];
  /** Partition index (leviathan mode). Undefined for single-sequencer backward compat. */
  partitionIndex?: number;
}

/**
 * BatchSettledPayload — broadcast after L1 settlement confirmation.
 */
export interface BatchSettledPayload {
  batchNumber: bigint;
  l1TxHash: string;
  lastSettledRegistryRoot: string;
  lastSettledLifecycleRoot: string;
  lastSettledWalletCount: string;
  /** Partition index (leviathan mode). Undefined for single-sequencer backward compat. */
  partitionIndex?: number;
}

/**
 * BatchFailedPayload — broadcast when a batch settlement fails.
 */
export interface BatchFailedPayload {
  batchNumber: bigint;
  reason: string;
  /** Partition index (leviathan mode). Undefined for single-sequencer backward compat. */
  partitionIndex?: number;
}

/**
 * MessageStoredPayload — broadcast when a new encrypted message is stored.
 *
 * Replicas apply this to their local message store for HA.
 * Messages are global (not partitioned) — all nodes store all messages.
 */
export interface MessageStoredPayload {
  leafIndex: bigint;
  message: StoredMessage;
  payload: MessagePayload;
  leafHash: string;
  /** Partition index (leviathan mode). Undefined for single-sequencer backward compat. */
  partitionIndex?: number;
}

/**
 * PeerAnnouncePayload — broadcast for peer discovery.
 *
 * Contains this node's identity and a list of known peer URLs
 * for new nodes to connect to.
 */
export interface PeerAnnouncePayload {
  peer: PeerInfo;
  /** URLs of peers this node knows about */
  knownPeers: string[];
}

/** Union of all gossip payload types */
export type GossipPayload =
  | ProofAcceptedPayload
  | BatchBuiltPayload
  | BatchSettledPayload
  | BatchFailedPayload
  | MessageStoredPayload
  | PeerAnnouncePayload
  | L2SequencerState         // For state:snapshot (IBD)
  | LeaderHeartbeatPayload   // For leader:heartbeat (leviathan)
  | LeaderPromotionPayload;  // For leader:promotion (leviathan)

// ─── Gossip Message ──────────────────────────────────────

/**
 * GossipMessage — the unit of peer-to-peer communication.
 *
 * Every gossip message has a unique messageId for deduplication.
 * When a node receives a message it hasn't seen before, it:
 *   1. Processes the payload (applies state, discovers peers, etc.)
 *   2. Relays to all connected peers EXCEPT the sender
 *
 * This creates epidemic spread through the network.
 */
export interface GossipMessage {
  /** Unique message ID for deduplication */
  messageId: string;
  /** Message type determines payload interpretation */
  type: GossipMessageType;
  /** Node ID of the original sender (not the relayer) */
  senderId: string;
  /** Timestamp when the message was created */
  timestamp: number;
  /** Typed payload */
  payload: GossipPayload;
  /** HMAC-SHA256 signature for message authentication (hex string) */
  signature?: string;
}

// ─── State Digest ────────────────────────────────────────

/**
 * StateDigest — compact summary of a node's current state.
 *
 * Used by peers to quickly check if they're in sync without
 * transferring the full state. If digests don't match,
 * a full state sync (IBD) is needed.
 */
export interface StateDigest {
  /** Highest sequence number assigned */
  latestSequenceNumber: bigint;
  /** Highest batch number (null if no batches) */
  latestBatchNumber: bigint | null;
  /** Current Poseidon audit chain hash */
  auditChainHash: string;
  /** Current claim accumulator root */
  claimAccumulatorRoot: string;
  /** Current registry root */
  registryRoot: string;
  /** Current lifecycle root */
  lifecycleRoot: string;
  /** Current wallet count */
  walletCount: string;
}

// ─── Network Configuration ───────────────────────────────

/** Default max peers for connection management */
export const DEFAULT_MAX_PEERS = 12;

/** Default peer announcement interval (60 seconds) */
export const DEFAULT_ANNOUNCE_INTERVAL_MS = 60_000;

/** Max seen messages before eviction (deduplication) */
export const MAX_SEEN_MESSAGES = 10_000;

/**
 * PeerNetworkConfig — configuration for the L2 peer network.
 */
export interface PeerNetworkConfig {
  /** Unique node identifier */
  nodeId: string;
  /** This node's role */
  role: L2NodeRole;
  /** Initial peer URLs to connect to on startup */
  seedPeers: string[];
  /** Maximum concurrent peer connections */
  maxPeers: number;
  /** Whether to relay gossip messages to other peers */
  gossipRelayEnabled: boolean;
  /** Interval between peer announcement broadcasts (ms) */
  announceIntervalMs: number;
  /** Whether to request full state sync on first peer connection */
  syncOnConnect: boolean;
  /** Shared secret for HMAC-SHA256 gossip authentication (optional) */
  gossipSecret?: string;
  /** Bearer token for admin RPC methods on peer nodes. Passed to L2Client for authenticated calls. */
  adminToken?: string;
}

/** Default peer network configuration */
export const DEFAULT_PEER_NETWORK_CONFIG: PeerNetworkConfig = {
  nodeId: '',          // Must be set by caller
  role: 'replica',
  seedPeers: [],
  maxPeers: DEFAULT_MAX_PEERS,
  gossipRelayEnabled: true,
  announceIntervalMs: DEFAULT_ANNOUNCE_INTERVAL_MS,
  syncOnConnect: true,
};
