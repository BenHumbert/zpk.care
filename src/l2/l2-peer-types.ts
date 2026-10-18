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
import type { L2Receipt, L2Block, L2Batch, BenefitPlanConfig } from './l2-types.js';
import type { AuditEvent } from '../audit/audit-types.js';
import type { ClaimAccumulatorEntry } from './claim-accumulator-types.js';
import type { StoredMessage, MessagePayload } from './message-store-types.js';
import type { L2SequencerState } from './l2-checkpoint.js';
import type { LeaderHeartbeatPayload, LeaderPromotionPayload } from './l2-leviathan-types.js';
import type { QuorumProposal, QuorumVote, QuorumCertificate } from './l2-quorum-types.js';

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
  /** VK commitment — Poseidon.hash of all ZkProgram verification key hashes. Software identity. */
  vkCommitment?: string;
}

// ─── Gossip Message Types ────────────────────────────────

/** All gossip message types in the protocol */
export type GossipMessageType =
  | 'proof:accepted'      // New receipt + audit event + optional claim entry
  | 'batch:built'         // New block + batch metadata + receipt status updates
  | 'batch:settled'       // L1 tx hash + settlement confirmation
  | 'batch:failed'        // Batch failure + reason
  | 'state:snapshot'      // Full state for IBD (response to sync request)
  | 'state:roots'         // The leader's roots after an admin mutation, so replicas follow writes that carry no proof (A13)
  | 'peer:announce'       // Peer discovery + exchange peer lists
  | 'message:stored'      // New encrypted message stored in Message Store
  | 'plan:updated'        // Benefit plan created or updated
  | 'plan:deleted'        // Benefit plan deleted
  | 'formulary:updated'   // Formulary published or updated (gossip replication)
  | 'leader:heartbeat'    // Leviathan leader heartbeat (partition leadership)
  | 'leader:promotion'    // Leviathan leader promotion (failover)
  | 'quorum:propose'      // Leader proposes WAL entry for quorum consensus
  | 'quorum:vote'         // Peer votes (ack + Ed25519 signature)
  | 'quorum:certificate'  // Leader broadcasts completed quorum certificate
  | 'admin:eviction';     // Node evicted due to equivocation evidence

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
 * PlanUpdatedPayload — broadcast when a benefit plan is created or updated.
 * Plans are global (not partitioned) — all nodes store all plans.
 */
export interface PlanUpdatedPayload {
  plan: BenefitPlanConfig;
  /** Partition index (leviathan mode). Undefined for single-sequencer backward compat. */
  partitionIndex?: number;
}

/**
 * PlanDeletedPayload — broadcast when a benefit plan is deleted.
 */
export interface PlanDeletedPayload {
  planId: string;
  /** Partition index (leviathan mode). Undefined for single-sequencer backward compat. */
  partitionIndex?: number;
}

/**
 * FormularyUpdatedPayload — broadcast when a formulary is published or updated.
 * Formularies are global (not partitioned) — all nodes store all formularies.
 */
export interface FormularyUpdatedPayload {
  planIdHash: string;
  formularyRoot: string;
  entriesJson: string;
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

/**
 * EquivocationEvidence — cryptographic proof that a node signed two
 * conflicting messages for the same sequence/context.
 *
 * Two GossipMessages from the same senderId with the same messageId prefix
 * (type + senderId + sequence) but different payloads = equivocation.
 * Either message alone is valid; together they prove misbehavior.
 */
export interface EquivocationEvidence {
  /** The equivocating node's ID */
  nodeId: string;
  /** First conflicting message */
  messageA: { messageId: string; type: GossipMessageType; timestamp: number; payloadHash: string };
  /** Second conflicting message (different payload, same context) */
  messageB: { messageId: string; type: GossipMessageType; timestamp: number; payloadHash: string };
  /** Node that detected the equivocation */
  detectedBy: string;
  /** When the equivocation was detected */
  detectedAt: number;
}

/** Payload for admin:eviction gossip messages */
export interface EvictionPayload {
  /** The evicted node's ID */
  evictedNodeId: string;
  /** Why the node was evicted */
  reason: string;
  /** Equivocation evidence (if eviction was due to equivocation) */
  evidence?: EquivocationEvidence;
}

/** Union of all gossip payload types */
/**
 * The leader's roots after an admin mutation (A13). Receipts carry the roots a proof produced; an
 * admin write (provisioning, a lifecycle change) produces none, so the leader says where it stands.
 */
export interface StateRootsPayload {
  reason: string;
  registryRoot: string;
  lifecycleRoot: string;
  walletCount: string;
}

export type GossipPayload =
  | ProofAcceptedPayload
  | BatchBuiltPayload
  | BatchSettledPayload
  | BatchFailedPayload
  | MessageStoredPayload
  | PlanUpdatedPayload
  | PlanDeletedPayload
  | FormularyUpdatedPayload
  | PeerAnnouncePayload
  | EvictionPayload
  | L2SequencerState         // For state:snapshot (IBD)
  | StateRootsPayload        // For state:roots (A13)
  | LeaderHeartbeatPayload   // For leader:heartbeat (leviathan)
  | LeaderPromotionPayload   // For leader:promotion (leviathan)
  | QuorumProposal           // For quorum:propose
  | QuorumVote               // For quorum:vote
  | QuorumCertificate;       // For quorum:certificate

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
  /** Shared secret for HMAC-SHA256 gossip authentication (optional, unsecure mode fallback) */
  gossipSecret?: string;
  /** Bearer token for admin RPC methods on peer nodes. Passed to L2Client for authenticated calls. */
  adminToken?: string;
  /** Expected VK commitment — peers with a different commitment are rejected (software identity). */
  vkCommitment?: string;
  /** Ed25519 private key hex for signing gossip messages (secure mode). 64 hex chars = 32 bytes. */
  gossipPrivateKeyHex?: string;
  /** Ed25519 public key hex for this node's gossip identity. 64 hex chars = 32 bytes. */
  gossipPublicKeyHex?: string;
  /** Map of peerId → Ed25519 public key hex. Used to verify gossip signatures from known peers. */
  gossipPeerPublicKeys?: Map<string, string>;
  /**
   * This node's own key (A13). Every RPC call to a peer is signed with it, in the one wire format the
   * servers verify, and authorised there by the role the peer registered it with. When set, it
   * replaces `adminToken` for node-to-node calls.
   */
  nodeKey?: { nodeId: string; seedHex: string };
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
