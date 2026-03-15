/**
 * L2 Quorum Service — Ed25519-based vote collection and certificate creation.
 *
 * Coordinates the quorum write protocol:
 *   1. Leader proposes a WAL entry → broadcasts QuorumProposal
 *   2. Peers write to WAL + sign vote → send QuorumVote back
 *   3. Leader collects N/2+1 votes → assembles QuorumCertificate
 *
 * Also handles state certificate creation at batch boundaries
 * via Ed25519 cross-signing of state digests.
 *
 * Ed25519 key handling follows the same DER encoding pattern as
 * SequencerAttestationAuthority in src/credentials/nfc-attestation.ts.
 *
 * Zero external dependencies — Node.js crypto only.
 */

import {
  sign,
  verify,
  generateKeyPairSync,
  createPrivateKey,
  createPublicKey,
  createHash,
  type KeyObject,
} from 'crypto';

import type { StateDigest } from './l2-peer-types.js';
import type {
  QuorumConfig,
  QuorumProposal,
  QuorumVote,
  QuorumCertificate,
  StateCertificate,
  StateCertSignature,
  PartitionDigest,
} from './l2-quorum-types.js';
import {
  buildQuorumVoteMessage,
  buildStateCertMessage,
  DEFAULT_QUORUM_TIMEOUT_MS,
} from './l2-quorum-types.js';

// ─── Ed25519 DER Helpers ────────────────────────────────
// Same pattern as src/credentials/nfc-attestation.ts lines 108-144

/** PKCS8 DER prefix for Ed25519 private key (32-byte seed follows) */
const ED25519_PKCS8_PREFIX = Buffer.from([
  0x30, 0x2e,       // SEQUENCE (46 bytes)
  0x02, 0x01, 0x00, // INTEGER 0 (version)
  0x30, 0x05,       // SEQUENCE (5 bytes)
  0x06, 0x03, 0x2b, 0x65, 0x70, // OID 1.3.101.112 (Ed25519)
  0x04, 0x22,       // OCTET STRING (34 bytes)
  0x04, 0x20,       // OCTET STRING (32 bytes) — the raw seed
]);

/** Build an Ed25519 KeyObject from a 32-byte seed */
export function ed25519PrivateKeyFromSeed(seed: Buffer): KeyObject {
  const pkcs8Der = Buffer.concat([ED25519_PKCS8_PREFIX, seed]);
  return createPrivateKey({ key: pkcs8Der, format: 'der', type: 'pkcs8' });
}

/** Extract raw 32-byte public key from an Ed25519 KeyObject */
export function extractRawPublicKey(publicKey: KeyObject): Buffer {
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' });
  return Buffer.from(spkiDer.subarray(12)); // skip 12-byte SPKI header
}

/** Build an Ed25519 public KeyObject from raw 32 bytes */
export function ed25519PublicKeyFromRaw(raw: Buffer): KeyObject {
  const spkiPrefix = Buffer.from([
    0x30, 0x2a,       // SEQUENCE (42 bytes)
    0x30, 0x05,       // SEQUENCE (5 bytes)
    0x06, 0x03, 0x2b, 0x65, 0x70, // OID 1.3.101.112 (Ed25519)
    0x03, 0x21, 0x00, // BIT STRING (33 bytes, 0 unused bits)
  ]);
  return createPublicKey({
    key: Buffer.concat([spkiPrefix, raw]),
    format: 'der',
    type: 'spki',
  });
}

// ─── Quorum Key Authority ────────────────────────────────

/**
 * QuorumKeyAuthority — Ed25519 keypair for a leviathan node.
 *
 * Generates a deterministic keypair from a seed (nodeId-derived)
 * or a random keypair for testing.
 */
export class QuorumKeyAuthority {
  private _privateKey: KeyObject;
  readonly publicKey: KeyObject;
  readonly publicKeyHex: string;

  constructor(seed?: Buffer) {
    if (seed) {
      const derivedSeed = createHash('sha256').update(seed).digest();
      this._privateKey = ed25519PrivateKeyFromSeed(derivedSeed);
      this.publicKey = createPublicKey(this._privateKey);
      derivedSeed.fill(0); // scrub
    } else {
      const { publicKey, privateKey } = generateKeyPairSync('ed25519');
      this._privateKey = privateKey;
      this.publicKey = publicKey;
    }
    this.publicKeyHex = extractRawPublicKey(this.publicKey).toString('hex');
  }

  /** Sign a message with this node's private key */
  sign(message: Buffer): Buffer {
    return sign(null, message, this._privateKey);
  }

  /** Get the private key (for QuorumConfig) */
  getPrivateKey(): KeyObject {
    return this._privateKey;
  }
}

// ─── Pending Proposal Tracker ────────────────────────────

interface PendingProposal {
  proposal: QuorumProposal;
  votes: Map<string, QuorumVote>; // voterId → vote
  resolve: (cert: QuorumCertificate) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  quorumThreshold: number;
}

// ─── Quorum Service ──────────────────────────────────────

export class L2QuorumService {
  private config: QuorumConfig;
  private pending: Map<string, PendingProposal> = new Map();
  /** Latest state certificates per partition */
  private stateCertificates: Map<number, StateCertificate> = new Map();

  constructor(config: QuorumConfig) {
    this.config = config;
  }

  // ─── Proposal / Vote Collection ───────────────────────

  /**
   * Propose a WAL entry for quorum. Returns a promise that resolves
   * when N/2+1 votes are collected, or rejects on timeout.
   *
   * Self-vote is counted automatically.
   */
  proposeAndWait(proposal: QuorumProposal): Promise<QuorumCertificate> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(proposal.proposalId);
        if (pending) {
          this.pending.delete(proposal.proposalId);
          const voteCount = pending.votes.size;
          reject(new Error(
            `Quorum timeout: ${voteCount}/${pending.quorumThreshold} votes collected ` +
            `for proposal ${proposal.proposalId} after ${this.config.quorumTimeoutMs}ms`,
          ));
        }
      }, this.config.quorumTimeoutMs);

      const pendingProposal: PendingProposal = {
        proposal,
        votes: new Map(),
        resolve,
        reject,
        timer,
        quorumThreshold: this.config.quorumThreshold,
      };

      this.pending.set(proposal.proposalId, pendingProposal);

      // Self-vote: leader automatically votes for its own proposal
      const selfVote = this.createVote(proposal, proposal.walEntryHash);
      this.handleVote(selfVote);
    });
  }

  /**
   * Handle an incoming vote from a peer (or self-vote).
   * If quorum is reached, resolves the pending promise.
   */
  handleVote(vote: QuorumVote): void {
    const pending = this.pending.get(vote.proposalId);
    if (!pending) return; // Unknown proposal or already resolved

    // Verify vote signature
    if (!this.verifyVote(vote)) return;

    // Check walEntryHash matches
    if (vote.walEntryHash !== pending.proposal.walEntryHash) return;

    // Deduplicate: one vote per voter
    if (pending.votes.has(vote.voterId)) return;

    pending.votes.set(vote.voterId, vote);

    // Check if quorum is reached
    if (pending.votes.size >= pending.quorumThreshold) {
      clearTimeout(pending.timer);
      this.pending.delete(vote.proposalId);

      const certificate: QuorumCertificate = {
        proposalId: pending.proposal.proposalId,
        partitionIndex: pending.proposal.partitionIndex,
        sequenceNumber: pending.proposal.sequenceNumber,
        walEntryHash: pending.proposal.walEntryHash,
        stateDigestHash: pending.proposal.stateDigestHash,
        votes: Array.from(pending.votes.values()),
        leaderId: pending.proposal.leaderId,
        createdAt: Date.now(),
      };

      pending.resolve(certificate);
    }
  }

  // ─── Vote Creation & Verification ─────────────────────

  /**
   * Create a signed vote for a received proposal.
   * Called by peers after they durably WAL the entry.
   */
  createVote(proposal: QuorumProposal, walEntryHash: string): QuorumVote {
    const timestamp = Date.now();
    const nodeId = this.getNodeId();

    const canonicalMessage = buildQuorumVoteMessage({
      proposalId: proposal.proposalId,
      walEntryHash,
      voterId: nodeId,
      timestamp,
    });

    const signature = sign(null, Buffer.from(canonicalMessage, 'utf8'), this.config.privateKey);

    return {
      proposalId: proposal.proposalId,
      voterId: nodeId,
      walEntryHash,
      signature: signature.toString('hex'),
      timestamp,
    };
  }

  /**
   * Verify a vote's Ed25519 signature.
   * Looks up the voter's public key from the peer registry.
   */
  verifyVote(vote: QuorumVote): boolean {
    // Get the voter's public key
    let publicKeyHex: string | undefined;
    if (vote.voterId === this.getNodeId()) {
      publicKeyHex = this.config.publicKeyHex;
    } else {
      publicKeyHex = this.config.peerPublicKeys.get(vote.voterId);
    }

    if (!publicKeyHex) return false; // Unknown voter

    try {
      const publicKeyRaw = Buffer.from(publicKeyHex, 'hex');
      if (publicKeyRaw.length !== 32) return false;

      const publicKey = ed25519PublicKeyFromRaw(publicKeyRaw);
      const canonicalMessage = buildQuorumVoteMessage({
        proposalId: vote.proposalId,
        walEntryHash: vote.walEntryHash,
        voterId: vote.voterId,
        timestamp: vote.timestamp,
      });

      const signatureBytes = Buffer.from(vote.signature, 'hex');
      if (signatureBytes.length !== 64) return false;

      return verify(null, Buffer.from(canonicalMessage, 'utf8'), publicKey, signatureBytes);
    } catch {
      return false;
    }
  }

  // ─── State Certificates ───────────────────────────────

  /**
   * Create a state certificate at batch boundary.
   *
   * Signs the state digest with this node's Ed25519 key.
   * Returns a partial certificate — other leviathans add their signatures.
   */
  createStateCertificate(
    batchNumber: bigint,
    partitionIndex: number,
    digest: StateDigest,
  ): StateCertificate {
    const stateDigestHash = computeStateDigestHash(digest);
    const timestamp = Date.now();

    const canonicalMessage = buildStateCertMessage({
      batchNumber: batchNumber.toString(),
      partitionIndex,
      stateDigestHash,
      nodeId: this.getNodeId(),
      timestamp,
    });

    const signature = sign(null, Buffer.from(canonicalMessage, 'utf8'), this.config.privateKey);

    const cert: StateCertificate = {
      version: 1,
      batchNumber: batchNumber.toString(),
      partitionIndex,
      stateDigest: digest,
      stateDigestHash,
      signatures: [{
        nodeId: this.getNodeId(),
        signature: signature.toString('hex'),
        publicKeyHex: this.config.publicKeyHex,
      }],
      createdAt: timestamp,
    };

    return cert;
  }

  /**
   * Sign an existing state certificate (as a peer).
   * Returns the signature entry to add to the certificate.
   */
  signStateCertificate(cert: StateCertificate): StateCertSignature {
    const timestamp = cert.createdAt; // Use the certificate's timestamp for determinism

    const canonicalMessage = buildStateCertMessage({
      batchNumber: cert.batchNumber,
      partitionIndex: cert.partitionIndex,
      stateDigestHash: cert.stateDigestHash,
      nodeId: this.getNodeId(),
      timestamp,
    });

    const signature = sign(null, Buffer.from(canonicalMessage, 'utf8'), this.config.privateKey);

    return {
      nodeId: this.getNodeId(),
      signature: signature.toString('hex'),
      publicKeyHex: this.config.publicKeyHex,
    };
  }

  /**
   * Verify a state certificate has valid majority signatures.
   */
  verifyStateCertificate(cert: StateCertificate): boolean {
    if (cert.signatures.length < this.config.quorumThreshold) return false;

    // Verify the digest hash matches
    const expectedHash = computeStateDigestHash(cert.stateDigest);
    if (cert.stateDigestHash !== expectedHash) return false;

    let validCount = 0;
    for (const sig of cert.signatures) {
      try {
        const publicKeyRaw = Buffer.from(sig.publicKeyHex, 'hex');
        if (publicKeyRaw.length !== 32) continue;

        const publicKey = ed25519PublicKeyFromRaw(publicKeyRaw);
        const canonicalMessage = buildStateCertMessage({
          batchNumber: cert.batchNumber,
          partitionIndex: cert.partitionIndex,
          stateDigestHash: cert.stateDigestHash,
          nodeId: sig.nodeId,
          timestamp: cert.createdAt,
        });

        const signatureBytes = Buffer.from(sig.signature, 'hex');
        if (signatureBytes.length !== 64) continue;

        if (verify(null, Buffer.from(canonicalMessage, 'utf8'), publicKey, signatureBytes)) {
          validCount++;
        }
      } catch {
        // Skip invalid signatures
      }
    }

    return validCount >= this.config.quorumThreshold;
  }

  // ─── State Certificate Storage ────────────────────────

  /** Store the latest state certificate for a partition */
  storeStateCertificate(cert: StateCertificate): void {
    this.stateCertificates.set(cert.partitionIndex, cert);
  }

  /** Get the latest state certificate for a partition */
  getLatestStateCertificate(partitionIndex: number): StateCertificate | undefined {
    return this.stateCertificates.get(partitionIndex);
  }

  /** Get all stored state certificates */
  getAllStateCertificates(): StateCertificate[] {
    return Array.from(this.stateCertificates.values());
  }

  // ─── Accessors ────────────────────────────────────────

  /** Get the node ID (derived from the public key hex — first 16 chars) */
  private getNodeId(): string {
    // Find our node ID by checking which peer key matches our public key
    for (const [nodeId, pubKey] of this.config.peerPublicKeys) {
      if (pubKey === this.config.publicKeyHex) return nodeId;
    }
    // Fallback: we might not be in the peer map yet
    return `node-${this.config.publicKeyHex.slice(0, 8)}`;
  }

  /** Get this node's public key hex */
  getNodePublicKeyHex(): string {
    return this.config.publicKeyHex;
  }

  /** Get the quorum threshold */
  getQuorumThreshold(): number {
    return this.config.quorumThreshold;
  }

  /** Update peer public keys (called when heartbeats arrive with publicKeyHex) */
  updatePeerPublicKey(nodeId: string, publicKeyHex: string): void {
    this.config.peerPublicKeys.set(nodeId, publicKeyHex);
  }

  /** Get quorum status */
  getStatus(): {
    quorumThreshold: number;
    pendingProposals: number;
    knownPeers: number;
    stateCertificateCount: number;
    quorumTimeoutMs: number;
  } {
    return {
      quorumThreshold: this.config.quorumThreshold,
      pendingProposals: this.pending.size,
      knownPeers: this.config.peerPublicKeys.size,
      stateCertificateCount: this.stateCertificates.size,
      quorumTimeoutMs: this.config.quorumTimeoutMs,
    };
  }

  /** Clean up pending proposals (for shutdown) */
  destroy(): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Quorum service destroyed'));
    }
    this.pending.clear();
  }
}

// ─── Utility Functions ──────────────────────────────────

/**
 * Compute a single hash of all StateDigest fields for quick comparison.
 * SHA-256 of pipe-delimited field values.
 */
export function computeStateDigestHash(digest: StateDigest): string {
  const content = [
    digest.latestSequenceNumber.toString(),
    digest.latestBatchNumber?.toString() ?? 'null',
    digest.auditChainHash,
    digest.claimAccumulatorRoot,
    digest.registryRoot,
    digest.lifecycleRoot,
    digest.walletCount,
  ].join('|');
  return createHash('sha256').update(content).digest('hex').slice(0, 32);
}

/**
 * Compute a PartitionDigest hash for quick comparison.
 */
export function computePartitionDigestHash(digest: Omit<PartitionDigest, 'digestHash'>): string {
  const content = [
    String(digest.partitionIndex),
    digest.walSequenceNumber.toString(),
    digest.latestSequenceNumber.toString(),
    digest.latestBatchNumber?.toString() ?? 'null',
    digest.auditChainHash,
    digest.claimAccumulatorRoot,
    digest.registryRoot,
    digest.lifecycleRoot,
    digest.walletCount,
  ].join('|');
  return createHash('sha256').update(content).digest('hex').slice(0, 32);
}

/**
 * Compute the default quorum threshold for a given leviathan count.
 * N/2+1 (strict majority).
 */
export function computeQuorumThreshold(leviathanCount: number): number {
  return Math.floor(leviathanCount / 2) + 1;
}
