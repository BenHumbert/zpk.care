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
 * L2PeerNetwork — Gossip-based peer-to-peer network for zkpCare L2 nodes.
 *
 * Manages connections to peer L2 nodes and handles gossip message
 * broadcasting, deduplication, and relay. Bitcoin-style epidemic spread:
 *
 *   1. Sequencer accepts proof → broadcasts ProofAccepted to all peers
 *   2. Each peer validates the messageId (dedup), processes payload
 *   3. If message is new, peer relays to ITS peers (except sender)
 *   4. Eventually all nodes in the network have the state
 *
 * Deduplication:
 *   - seenMessages Set tracks messageIds (bounded, max 10K entries)
 *   - When full, oldest half is evicted
 *   - Duplicate messages are silently dropped
 *
 * Zero external dependencies — uses L2Client (HTTP) for all communication.
 */
import { createHmac, createHash, timingSafeEqual, sign as ed25519Sign, verify as ed25519Verify, createPrivateKey, createPublicKey } from 'crypto';
import { L2Client } from './l2-client.js';
import type { L2SequencerState } from './l2-checkpoint.js';
import type {
  PeerInfo,
  PeerNetworkConfig,
  GossipMessage,
  GossipMessageType,
  PeerAnnouncePayload,
  EvictionPayload,
  EquivocationEvidence,
  StateDigest,
} from './l2-peer-types.js';
import {
  DEFAULT_PEER_NETWORK_CONFIG,
  MAX_SEEN_MESSAGES,
} from './l2-peer-types.js';

// ─── Types ──────────────────────────────────────────────

/** Handler for incoming gossip messages */
export type GossipHandler = (message: GossipMessage) => void;

// ─── Utility ────────────────────────────────────────────

/** Generate a unique message ID from content fields using SHA-256 */
export function generateMessageId(
  type: GossipMessageType,
  senderId: string,
  timestamp: number,
  ...extraFields: string[]
): string {
  const content = [type, senderId, String(timestamp), ...extraFields].join(':');
  return createHash('sha256').update(content).digest('hex').slice(0, 32);
}

// ─── L2PeerNetwork ──────────────────────────────────────

export class L2PeerNetwork {
  private config: PeerNetworkConfig;
  private peers: Map<string, PeerInfo> = new Map();
  private clients: Map<string, L2Client> = new Map();
  private seenMessages: string[] = [];
  private seenMessageSet: Set<string> = new Set();
  private handlers: GossipHandler[] = [];
  private announceTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  /**
   * Equivocation detection: tracks payload hashes per sender+type+context.
   * Key: `${senderId}:${type}:${contextKey}` → { payloadHash, messageId }.
   * If a second DIFFERENT hash arrives for the same key, it's equivocation.
   * Bounded at 10K entries (same eviction as seenMessages).
   */
  private payloadFingerprints: Map<string, { payloadHash: string; messageId: string }> = new Map();
  private static readonly MAX_FINGERPRINTS = 10_000;

  /** Banned peer IDs — gossip from these senders is silently dropped */
  private bannedPeers: Set<string> = new Set();

  /** Eviction handler — called when equivocation is detected. Set by L2Node. */
  private evictionHandler: ((evidence: import('./l2-peer-types.js').EquivocationEvidence) => void) | null = null;

  constructor(config: Partial<PeerNetworkConfig> & { nodeId: string }) {
    this.config = { ...DEFAULT_PEER_NETWORK_CONFIG, ...config };

    // Warn about asymmetric gossip security configurations
    if (this.config.gossipPeerPublicKeys !== undefined && !this.config.gossipPrivateKeyHex) {
      console.warn('[peer] WARNING: gossipPeerPublicKeys set without gossipPrivateKeyHex — this node will verify peers but cannot sign its own messages. Other Ed25519-mode peers will reject gossip from this node.');
    }
    if (this.config.gossipPrivateKeyHex && this.config.gossipPeerPublicKeys === undefined) {
      console.warn('[peer] WARNING: gossipPrivateKeyHex set without gossipPeerPublicKeys — this node signs gossip but does not verify peers. Set gossipPeerPublicKeys for bidirectional security.');
    }
  }

  /** Register a handler called when equivocation is detected */
  onEviction(handler: (evidence: import('./l2-peer-types.js').EquivocationEvidence) => void): void {
    this.evictionHandler = handler;
  }

  /** Ban a peer — disconnect immediately and reject all future gossip from this senderId */
  banPeer(peerId: string): void {
    this.bannedPeers.add(peerId);
    this.disconnectPeer(peerId);
    console.warn(`  [peer] BANNED ${peerId} — all future messages will be dropped`);
  }

  /** Check if a peer is banned */
  isPeerBanned(peerId: string): boolean {
    return this.bannedPeers.has(peerId);
  }

  // ─── Connection Management ────────────────────────────

  /**
   * Connect to a peer by URL.
   *
   * Creates an L2Client, fetches the peer's identity via l2_getPeerInfo,
   * and registers the connection.
   *
   * @returns PeerInfo of the connected peer
   * @throws If connection fails or peer is unreachable
   */
  async connectToPeer(url: string): Promise<PeerInfo> {
    // Check if we already know this peer (connected or disconnected)
    const existing = this.findPeerByUrl(url);
    if (existing && existing.status === 'connected') {
      return existing;
    }

    // Check max peers (only count currently connected peers)
    if (!existing && this.getConnectedPeers().length >= this.config.maxPeers) {
      throw new Error(`Max peers reached (${this.config.maxPeers})`);
    }

    const client = new L2Client({
      sequencerUrl: url,
      timeoutMs: 10_000,
      ...(this.config.adminToken ? { adminToken: this.config.adminToken } : {}),
    });

    // If we have a disconnected peer for this URL, re-verify VK before reconnecting
    if (existing) {
      // Re-fetch peer info to verify VK commitment on reconnection
      if (this.config.vkCommitment) {
        try {
          const freshInfo = await client.getPeerInfo();
          if (freshInfo.vkCommitment && freshInfo.vkCommitment !== this.config.vkCommitment) {
            console.warn(`[peer] Rejected reconnection of ${existing.peerId} — VK commitment mismatch`);
            throw new Error(`VK commitment mismatch on reconnection — peer ${existing.peerId}`);
          }
        } catch (err: any) {
          if (err.message?.includes('VK commitment mismatch')) throw err;
          // getPeerInfo failed — allow reconnection (backward compat with old peers)
        }
      }
      existing.status = 'connected';
      existing.lastSeen = Date.now();
      this.clients.set(existing.peerId, client);
      return existing;
    }

    // Try to get peer identity
    let peerInfo: PeerInfo;
    try {
      peerInfo = await client.getPeerInfo();
      peerInfo.status = 'connected';
      peerInfo.lastSeen = Date.now();
    } catch {
      // Peer doesn't support getPeerInfo yet — create a basic entry
      peerInfo = {
        peerId: `peer-${url}`,
        url,
        role: 'replica',
        status: 'connected',
        lastSeen: Date.now(),
        latestSequenceNumber: 0n,
        latestBatchNumber: null,
      };
    }

    // Verify VK commitment — reject peers running different software
    if (this.config.vkCommitment) {
      if (!peerInfo.vkCommitment) {
        console.warn(`[peer] Rejected ${peerInfo.peerId} — no VK commitment provided (this node requires software identity verification)`);
        throw new Error(`VK commitment missing — peer ${peerInfo.peerId} did not provide software identity`);
      }
      if (peerInfo.vkCommitment !== this.config.vkCommitment) {
        console.warn(`[peer] Rejected ${peerInfo.peerId} — VK commitment mismatch (expected ${this.config.vkCommitment.slice(0, 16)}…, got ${peerInfo.vkCommitment.slice(0, 16)}…)`);
        throw new Error(`VK commitment mismatch — peer ${peerInfo.peerId} is running different software`);
      }
    }

    this.peers.set(peerInfo.peerId, peerInfo);
    this.clients.set(peerInfo.peerId, client);

    return peerInfo;
  }

  /**
   * Disconnect from a specific peer.
   */
  disconnectPeer(peerId: string): void {
    const peer = this.peers.get(peerId);
    if (peer) {
      peer.status = 'disconnected';
    }
    this.clients.delete(peerId);
  }

  /**
   * Disconnect from all peers and clean up.
   */
  disconnectAll(): void {
    for (const [peerId] of this.clients) {
      this.disconnectPeer(peerId);
    }
    this.peers.clear();
    this.clients.clear();
  }

  /** Get all known peers (including disconnected) */
  getPeers(): PeerInfo[] {
    return Array.from(this.peers.values());
  }

  /** Get only connected peers */
  getConnectedPeers(): PeerInfo[] {
    return Array.from(this.peers.values()).filter(
      (p) => p.status === 'connected',
    );
  }

  /** Get all known peer URLs */
  getPeerUrls(): string[] {
    return Array.from(this.peers.values()).map((p) => p.url);
  }

  /** Get this node's config */
  getConfig(): PeerNetworkConfig {
    return { ...this.config };
  }

  /** Set VK commitment after ZkProgram compilation. Updates future peer announcements and verification. */
  setVkCommitment(commitment: string): void {
    this.config.vkCommitment = commitment;
  }

  /** Register a peer's gossip public key (called when a new peer is admitted). */
  registerGossipPeerKey(peerId: string, publicKeyHex: string): void {
    if (!this.config.gossipPeerPublicKeys) {
      this.config.gossipPeerPublicKeys = new Map();
    }
    this.config.gossipPeerPublicKeys.set(peerId, publicKeyHex);
  }

  /** Broadcast an eviction event to all peers */
  private async broadcastEviction(nodeId: string, reason: string, evidence?: EquivocationEvidence): Promise<void> {
    const payload: EvictionPayload = { evictedNodeId: nodeId, reason, evidence };
    const message: GossipMessage = {
      messageId: generateMessageId('admin:eviction', this.config.nodeId, Date.now(), nodeId),
      type: 'admin:eviction',
      senderId: this.config.nodeId,
      timestamp: Date.now(),
      payload,
    };
    await this.broadcast(message);
  }

  // ─── Gossip Broadcast ─────────────────────────────────

  /**
   * Broadcast a gossip message to all connected peers.
   *
   * Fire-and-forget: errors on individual peers are silently ignored.
   * The message is marked as "seen" before broadcasting to prevent
   * receiving our own broadcast back.
   */
  async broadcast(message: GossipMessage): Promise<void> {
    // Sign outgoing message if gossipSecret is configured
    message.signature = this.signGossip(message);

    // Mark as seen so we don't re-process our own broadcast
    this.markSeen(message.messageId);

    const promises: Promise<void>[] = [];
    for (const [peerId, client] of this.clients) {
      const peer = this.peers.get(peerId);
      if (!peer || peer.status !== 'connected') continue;

      promises.push(
        client.gossipRelay(message).then(
          () => {
            peer.lastSeen = Date.now();
          },
          () => {
            // Peer unreachable — mark disconnected
            peer.status = 'disconnected';
          },
        ),
      );
    }

    await Promise.allSettled(promises);
  }

  /**
   * Broadcast to all connected peers EXCEPT the specified sender.
   *
   * Used for gossip relay: when we receive a message from peer A,
   * we relay to everyone except peer A.
   */
  async broadcastExcept(
    message: GossipMessage,
    exceptPeerId: string,
  ): Promise<void> {
    // Sign outgoing message if gossipSecret is configured
    message.signature = this.signGossip(message);

    // Mark as seen
    this.markSeen(message.messageId);

    const promises: Promise<void>[] = [];
    for (const [peerId, client] of this.clients) {
      if (peerId === exceptPeerId) continue;
      const peer = this.peers.get(peerId);
      if (!peer || peer.status !== 'connected') continue;

      promises.push(
        client.gossipRelay(message).then(
          () => {
            peer.lastSeen = Date.now();
          },
          () => {
            peer.status = 'disconnected';
          },
        ),
      );
    }

    await Promise.allSettled(promises);
  }

  /**
   * Send a gossip message to a specific peer (directed messaging).
   *
   * Used for quorum vote responses where the vote goes back to
   * the original proposer, not broadcast to everyone.
   *
   * @returns true if the message was sent, false if peer not found/connected.
   */
  async sendTo(peerId: string, message: GossipMessage): Promise<boolean> {
    const client = this.clients.get(peerId);
    const peer = this.peers.get(peerId);
    if (!client || !peer || peer.status !== 'connected') return false;

    message.signature = this.signGossip(message);
    this.markSeen(message.messageId);

    try {
      await client.gossipRelay(message);
      peer.lastSeen = Date.now();
      return true;
    } catch {
      peer.status = 'disconnected';
      return false;
    }
  }

  // ─── Gossip Reception ─────────────────────────────────

  /**
   * Handle an incoming gossip message from a peer.
   *
   * @returns true if the message was new (should be processed),
   *          false if it was a duplicate (already seen).
   */
  /** Max age for gossip messages — reject anything older than 5 minutes (replay protection) */
  private static readonly MAX_GOSSIP_AGE_MS = 5 * 60 * 1000;

  handleIncoming(message: GossipMessage): boolean {
    // Timestamp window — reject stale messages (replay protection after dedup eviction)
    // Only enforced when gossip authentication is active (Ed25519 or HMAC)
    if (this.config.gossipPeerPublicKeys !== undefined || this.config.gossipSecret) {
      if (Math.abs(Date.now() - message.timestamp) > L2PeerNetwork.MAX_GOSSIP_AGE_MS) {
        return false;
      }
    }

    // Signature verification — reject unauthenticated gossip when keys are configured
    if (!this.verifyGossip(message)) {
      return false;
    }

    // Deduplication check
    if (this.seenMessageSet.has(message.messageId)) {
      return false;
    }

    // Mark as seen
    this.markSeen(message.messageId);

    // Drop messages from banned peers (evicted via equivocation)
    if (this.bannedPeers.has(message.senderId)) {
      return false;
    }

    // Equivocation detection — check for conflicting payloads from the same sender
    // Skip for peer:announce (expected to change), admin:eviction (eviction broadcast), state:snapshot (large, variable)
    if (message.type !== 'peer:announce' && message.type !== 'admin:eviction' && message.type !== 'state:snapshot') {
      const contextKey = `${message.senderId}:${message.type}:${message.timestamp}`;
      const payloadHash = createHash('sha256')
        .update(JSON.stringify(message.payload, (_, v) => typeof v === 'bigint' ? v.toString() : v))
        .digest('hex')
        .slice(0, 32);

      const existing = this.payloadFingerprints.get(contextKey);
      if (existing && existing.payloadHash !== payloadHash) {
        // EQUIVOCATION DETECTED — same sender, same context, different payload
        const evidence: EquivocationEvidence = {
          nodeId: message.senderId,
          messageA: { messageId: existing.messageId, type: message.type, timestamp: message.timestamp, payloadHash: existing.payloadHash },
          messageB: { messageId: message.messageId, type: message.type, timestamp: message.timestamp, payloadHash },
          detectedBy: this.config.nodeId,
          detectedAt: Date.now(),
        };
        console.error(`  [EQUIVOCATION] Node ${message.senderId} produced conflicting ${message.type} at ts=${message.timestamp}`);

        // Ban the equivocating peer immediately
        this.banPeer(message.senderId);

        // Notify application layer (wrapped to prevent handler crash from blocking eviction)
        try { this.evictionHandler?.(evidence); } catch { /* handler crash must not block eviction */ }

        // Broadcast eviction to all peers (fire-and-forget with error suppression)
        this.broadcastEviction(message.senderId, 'Equivocation detected — conflicting payloads', evidence)
          .catch(() => { /* broadcast failure must not crash the process */ });

        return false; // Reject the conflicting message
      }

      this.payloadFingerprints.set(contextKey, { payloadHash, messageId: message.messageId });
      // Bounded size — evict oldest half when full
      if (this.payloadFingerprints.size > L2PeerNetwork.MAX_FINGERPRINTS) {
        const entries = [...this.payloadFingerprints.keys()];
        for (let i = 0; i < entries.length / 2; i++) {
          this.payloadFingerprints.delete(entries[i]);
        }
      }
    }

    // Notify handlers
    for (const handler of this.handlers) {
      try {
        handler(message);
      } catch {
        // Don't let handler errors crash the network
      }
    }

    return true;
  }

  /**
   * Handle incoming message AND relay to other peers if enabled.
   *
   * This is the main entry point for gossip reception.
   * Returns true if the message was new.
   */
  async handleIncomingAndRelay(
    message: GossipMessage,
    fromPeerId?: string,
  ): Promise<boolean> {
    const isNew = this.handleIncoming(message);

    if (isNew && this.config.gossipRelayEnabled) {
      // Relay to all peers except the sender
      if (fromPeerId) {
        await this.broadcastExcept(message, fromPeerId);
      }
    }

    return isNew;
  }

  // ─── State Sync (IBD) ─────────────────────────────────

  /**
   * Request a full state snapshot from a peer for Initial Block Download.
   *
   * @throws If the peer is not connected or the request fails
   */
  async requestStateSync(peerId: string): Promise<L2SequencerState> {
    const client = this.clients.get(peerId);
    if (!client) {
      throw new Error(`Peer not connected: ${peerId}`);
    }

    const peer = this.peers.get(peerId);
    if (peer) {
      peer.status = 'syncing';
    }

    try {
      const state = await client.requestSnapshot();
      if (peer) {
        peer.status = 'connected';
        peer.lastSeen = Date.now();
      }
      return state;
    } catch (err) {
      if (peer) {
        peer.status = 'disconnected';
      }
      throw err;
    }
  }

  /**
   * Get a compact state digest from a peer for quick sync check.
   */
  async getRemoteDigest(peerId: string): Promise<StateDigest> {
    const client = this.clients.get(peerId);
    if (!client) {
      throw new Error(`Peer not connected: ${peerId}`);
    }
    return client.getStateDigest();
  }

  // ─── Peer Discovery ───────────────────────────────────

  /**
   * Exchange peer lists with a connected peer.
   *
   * Sends our peer list and receives theirs.
   * New peers from the remote list can be connected to.
   *
   * @returns URLs of peers the remote knows about
   */
  async exchangePeerList(peerId: string): Promise<string[]> {
    const client = this.clients.get(peerId);
    if (!client) {
      throw new Error(`Peer not connected: ${peerId}`);
    }

    try {
      const remotePeers = await client.getPeerList();
      const peer = this.peers.get(peerId);
      if (peer) {
        peer.lastSeen = Date.now();
      }
      return remotePeers;
    } catch {
      return [];
    }
  }

  // ─── Event Handling ───────────────────────────────────

  /** Subscribe to incoming gossip messages */
  on(handler: GossipHandler): void {
    this.handlers.push(handler);
  }

  /** Unsubscribe from gossip messages */
  off(handler: GossipHandler): void {
    this.handlers = this.handlers.filter((h) => h !== handler);
  }

  // ─── Lifecycle ────────────────────────────────────────

  /** Start the peer network (peer announcements, etc.) */
  start(): void {
    if (this.running) return;
    this.running = true;

    // Start periodic peer announcements
    if (this.config.announceIntervalMs > 0) {
      this.scheduleAnnounce();
    }
  }

  /** Stop the peer network */
  stop(): void {
    if (!this.running) return;
    this.running = false;

    if (this.announceTimer !== null) {
      clearTimeout(this.announceTimer);
      this.announceTimer = null;
    }

    this.disconnectAll();
  }

  /** Whether the network is running */
  isRunning(): boolean {
    return this.running;
  }

  // ─── Gossip Authentication ──────────────────────────────

  /** Sign a gossip message using HMAC-SHA256 with the shared secret */
  /**
   * Sign a gossip message.
   *
   * Secure mode (gossipPrivateKeyHex set): Ed25519 signature over canonical payload.
   * Each message is attributable to a specific node. Non-repudiable.
   *
   * Unsecure/legacy mode (gossipSecret set): HMAC-SHA256 with shared secret.
   * Proves membership in the group but not which specific node sent it.
   *
   * No keys configured: empty string (no signature).
   */
  private signGossip(message: GossipMessage): string {
    // Ed25519 signing (secure mode)
    if (this.config.gossipPrivateKeyHex) {
      const payload = `${message.messageId}:${message.type}:${message.senderId}:${message.timestamp}`;
      const pkDer = Buffer.from(
        '302e020100300506032b657004220420' + this.config.gossipPrivateKeyHex,
        'hex',
      );
      const privateKey = createPrivateKey({ key: pkDer, format: 'der', type: 'pkcs8' });
      return ed25519Sign(null, Buffer.from(payload), privateKey).toString('hex');
    }
    // HMAC signing (legacy/unsecure mode)
    const secret = this.config.gossipSecret;
    if (!secret) return '';
    const payload = `${message.messageId}:${message.type}:${message.senderId}:${message.timestamp}`;
    return createHmac('sha256', secret).update(payload).digest('hex');
  }

  /**
   * Verify a gossip message's signature.
   *
   * Secure mode: verify Ed25519 signature against the sender's known public key.
   * Unsecure mode: verify HMAC-SHA256 against shared secret.
   * No auth configured: accept all (backward compat).
   */
  private verifyGossip(message: GossipMessage): boolean {
    // Ed25519 verification (secure mode — active when gossipPeerPublicKeys Map exists, even if empty)
    if (this.config.gossipPeerPublicKeys !== undefined) {
      if (!message.signature) return false; // Signature required in secure mode
      const senderPubKeyHex = this.config.gossipPeerPublicKeys.get(message.senderId)
        ?? this.config.gossipPublicKeyHex; // Accept own messages (sender is self)
      if (!senderPubKeyHex) {
        // Unknown sender — check if this is our own node ID (self-originated messages after relay)
        if (message.senderId === this.config.nodeId && this.config.gossipPublicKeyHex) {
          return this.verifyEd25519Gossip(message, this.config.gossipPublicKeyHex);
        }
        return false; // Unknown sender with no key — reject
      }
      return this.verifyEd25519Gossip(message, senderPubKeyHex);
    }
    // HMAC verification (legacy/unsecure mode)
    const secret = this.config.gossipSecret;
    if (!secret) return true; // No secret configured — skip auth (backward compat)
    if (!message.signature) return false; // Secret required but no signature present
    const payload = `${message.messageId}:${message.type}:${message.senderId}:${message.timestamp}`;
    const expected = createHmac('sha256', secret).update(payload).digest('hex');
    const a = Buffer.from(message.signature, 'hex');
    const b = Buffer.from(expected, 'hex');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  /** Verify an Ed25519 signature on a gossip message against a known public key */
  private verifyEd25519Gossip(message: GossipMessage, pubKeyHex: string): boolean {
    const payload = `${message.messageId}:${message.type}:${message.senderId}:${message.timestamp}`;
    try {
      const pubKeyDer = Buffer.from('302a300506032b6570032100' + pubKeyHex, 'hex');
      const pubKey = createPublicKey({ key: pubKeyDer, format: 'der', type: 'spki' });
      return ed25519Verify(null, Buffer.from(payload), pubKey, Buffer.from(message.signature!, 'hex'));
    } catch {
      return false; // Malformed key or signature
    }
  }

  // ─── Internal ─────────────────────────────────────────

  /** Check if a peer URL is already connected */
  private isPeerAlreadyConnected(url: string): boolean {
    return this.findPeerByUrl(url) !== undefined;
  }

  /** Find a peer by URL (regardless of connection status) */
  private findPeerByUrl(url: string): PeerInfo | undefined {
    for (const peer of this.peers.values()) {
      if (peer.url === url) {
        return peer;
      }
    }
    return undefined;
  }

  /**
   * Mark a message ID as seen (deduplication).
   *
   * Maintains a bounded list. When MAX_SEEN_MESSAGES is reached,
   * the oldest half is evicted to free memory.
   */
  private markSeen(messageId: string): void {
    if (this.seenMessageSet.has(messageId)) return;

    // Evict oldest half if at capacity
    if (this.seenMessages.length >= MAX_SEEN_MESSAGES) {
      const evictCount = Math.floor(MAX_SEEN_MESSAGES / 2);
      const evicted = this.seenMessages.splice(0, evictCount);
      for (const id of evicted) {
        this.seenMessageSet.delete(id);
      }
    }

    this.seenMessages.push(messageId);
    this.seenMessageSet.add(messageId);
  }

  /** Schedule the next peer announcement */
  private scheduleAnnounce(): void {
    if (!this.running) return;
    this.announceTimer = setTimeout(() => {
      this.announceToAllPeers().catch(() => {});
      this.scheduleAnnounce();
    }, this.config.announceIntervalMs);
  }

  /** Announce this node to all connected peers */
  private async announceToAllPeers(): Promise<void> {
    const announcePayload: PeerAnnouncePayload = {
      peer: {
        peerId: this.config.nodeId,
        url: '', // Filled by the receiver
        role: this.config.role,
        status: 'connected',
        lastSeen: Date.now(),
        latestSequenceNumber: 0n,
        latestBatchNumber: null,
        ...(this.config.vkCommitment ? { vkCommitment: this.config.vkCommitment } : {}),
      },
      knownPeers: this.getPeerUrls(),
    };

    const message: GossipMessage = {
      messageId: generateMessageId(
        'peer:announce',
        this.config.nodeId,
        Date.now(),
      ),
      type: 'peer:announce',
      senderId: this.config.nodeId,
      timestamp: Date.now(),
      payload: announcePayload,
    };

    await this.broadcast(message);
  }
}
