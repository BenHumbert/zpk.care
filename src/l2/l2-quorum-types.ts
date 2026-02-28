/**
 * L2 Quorum Types — Protocol types for quorum writes and state certificates.
 *
 * Defines the types for:
 *   1. Quorum Write proposals and votes (per-proof consensus)
 *   2. Quorum Certificates (proof that N/2+1 leviathans agreed)
 *   3. State Certificates (batch-level consensus with Ed25519 cross-signing)
 *   4. Reconciliation protocol (periodic state digest comparison)
 *
 * Pure type definitions — no runtime code.
 * Zero external dependencies.
 */

import type { KeyObject } from 'crypto';
import type { StateDigest } from './l2-peer-types.js';

// ─── Quorum Configuration ────────────────────────────────

/**
 * QuorumConfig — configuration for the quorum write protocol.
 */
export interface QuorumConfig {
  /** Minimum votes needed for quorum (default: Math.floor(partitionCount / 2) + 1) */
  quorumThreshold: number;
  /** Max time to wait for quorum votes (ms). Default 5000. */
  quorumTimeoutMs: number;
  /** This node's Ed25519 private key for signing */
  privateKey: KeyObject;
  /** This node's Ed25519 public key hex (64 chars = 32 bytes) */
  publicKeyHex: string;
  /** Map of nodeId → Ed25519 public key hex for all known peers */
  peerPublicKeys: Map<string, string>;
}

export const DEFAULT_QUORUM_TIMEOUT_MS = 5_000;

// ─── Quorum Proposal ────────────────────────────────────

/**
 * QuorumProposal — leader proposes a WAL entry for quorum consensus.
 *
 * Sent to all peers after the leader durably writes to its own WAL.
 * Each peer writes to its WAL and sends back a signed vote.
 */
export interface QuorumProposal {
  /** Unique proposal ID (= WAL entryId) */
  proposalId: string;
  /** Partition this proof belongs to */
  partitionIndex: number;
  /** Sequence number assigned to the proof */
  sequenceNumber: string;
  /** SHA-256 hash of the WAL entry content */
  walEntryHash: string;
  /** Hash of the post-mutation state (for verification) */
  stateDigestHash: string;
  /** Node ID of the leader making the proposal */
  leaderId: string;
  /** Timestamp when proposal was created */
  timestamp: number;
}

// ─── Quorum Vote ─────────────────────────────────────────

/**
 * QuorumVote — peer's signed acknowledgment of durable write.
 *
 * After receiving a proposal, the peer:
 *   1. Durably writes the proof data to its WAL
 *   2. Signs the proposal with its Ed25519 key
 *   3. Sends this vote back to the leader
 */
export interface QuorumVote {
  /** Proposal this vote is for (must match proposal.proposalId) */
  proposalId: string;
  /** Node ID of the voter */
  voterId: string;
  /** SHA-256 of the WAL entry (must match proposal.walEntryHash) */
  walEntryHash: string;
  /** Ed25519 signature over canonical vote message (128 hex chars) */
  signature: string;
  /** Timestamp when vote was created */
  timestamp: number;
}

// ─── Quorum Certificate ─────────────────────────────────

/**
 * QuorumCertificate — proof that N/2+1 leviathans durably wrote a proof.
 *
 * Assembled by the leader after collecting sufficient votes.
 * Attached to the L2Receipt as proof of consensus.
 * Any party can verify by checking Ed25519 signatures.
 */
export interface QuorumCertificate {
  /** Proposal that achieved quorum */
  proposalId: string;
  /** Partition index */
  partitionIndex: number;
  /** Sequence number */
  sequenceNumber: string;
  /** Hash of the WAL entry */
  walEntryHash: string;
  /** Hash of the post-mutation state */
  stateDigestHash: string;
  /** The N/2+1 votes that form the certificate */
  votes: QuorumVote[];
  /** Leader that assembled the certificate */
  leaderId: string;
  /** Timestamp when certificate was assembled */
  createdAt: number;
}

// ─── State Certificate ──────────────────────────────────

/**
 * StateCertificate — batch-level consensus proof.
 *
 * At batch boundaries, leviathans cross-sign the state digest.
 * When N/2+1 agree, a StateCertificate is produced.
 * This replaces L1 anchoring as the trust proof.
 */
export interface StateCertificate {
  /** Format version */
  version: 1;
  /** Batch number at which this certificate was produced */
  batchNumber: string;
  /** Partition index */
  partitionIndex: number;
  /** The agreed-upon state digest */
  stateDigest: StateDigest;
  /** Single hash of all digest fields for quick comparison */
  stateDigestHash: string;
  /** Ed25519 signatures from consenting leviathans */
  signatures: StateCertSignature[];
  /** Timestamp when certificate was assembled */
  createdAt: number;
}

/** One signer's contribution to a StateCertificate */
export interface StateCertSignature {
  /** Node ID of the signer */
  nodeId: string;
  /** Ed25519 signature (128 hex chars) */
  signature: string;
  /** Signer's public key (64 hex chars) */
  publicKeyHex: string;
}

// ─── Reconciliation Types ────────────────────────────────

/**
 * ReconciliationConfig — periodic state digest comparison settings.
 */
export interface ReconciliationConfig {
  /** Run reconciliation every N batches. Default 10. */
  batchInterval: number;
  /** Run reconciliation every M milliseconds. Default 300_000 (5 min). */
  timeIntervalMs: number;
  /** Whether reconciliation is enabled. Default true. */
  enabled: boolean;
}

export const DEFAULT_RECONCILIATION_CONFIG: ReconciliationConfig = {
  batchInterval: 10,
  timeIntervalMs: 300_000,
  enabled: true,
};

/**
 * PartitionDigest — extends StateDigest with partition context and WAL info.
 */
export interface PartitionDigest {
  /** Partition index */
  partitionIndex: number;
  /** Latest WAL sequence number */
  walSequenceNumber: bigint;
  /** Same fields as StateDigest */
  latestSequenceNumber: bigint;
  latestBatchNumber: bigint | null;
  auditChainHash: string;
  claimAccumulatorRoot: string;
  registryRoot: string;
  lifecycleRoot: string;
  walletCount: string;
  /** SHA-256 of the digest fields for quick comparison */
  digestHash: string;
}

/** Result of a reconciliation round for one partition */
export interface ReconciliationResult {
  /** Partition index */
  partitionIndex: number;
  /** Whether consensus was reached (N/2+1 agree) */
  consensusReached: boolean;
  /** State certificate if consensus reached */
  certificate?: StateCertificate;
  /** Node IDs that agreed */
  agreeingNodes: string[];
  /** Node IDs that diverged */
  divergentNodes: string[];
  /** Whether this node was divergent and needs resync */
  selfDivergent: boolean;
}

// ─── Canonical Sign Messages ─────────────────────────────

/**
 * Build the canonical message for a quorum vote signature.
 * Pipe-delimited, deterministic, no JSON ambiguity.
 */
export function buildQuorumVoteMessage(vote: {
  proposalId: string;
  walEntryHash: string;
  voterId: string;
  timestamp: number;
}): string {
  return `zkpcare-quorum-vote-v1|${vote.proposalId}|${vote.walEntryHash}|${vote.voterId}|${vote.timestamp}`;
}

/**
 * Build the canonical message for a state certificate signature.
 * Pipe-delimited, deterministic, no JSON ambiguity.
 */
export function buildStateCertMessage(params: {
  batchNumber: string;
  partitionIndex: number;
  stateDigestHash: string;
  nodeId: string;
  timestamp: number;
}): string {
  return `zkpcare-state-cert-v1|${params.batchNumber}|${params.partitionIndex}|${params.stateDigestHash}|${params.nodeId}|${params.timestamp}`;
}
