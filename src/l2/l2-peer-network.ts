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
import { createHmac, createHash, timingSafeEqual } from 'crypto';
import { L2Client } from './l2-client.js';
import type { L2SequencerState } from './l2-checkpoint.js';
import type {
  PeerInfo,
  PeerNetworkConfig,
  GossipMessage,
  GossipMessageType,
  PeerAnnouncePayload,
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

  constructor(config: Partial<PeerNetworkConfig> & { nodeId: string }) {
    this.config = { ...DEFAULT_PEER_NETWORK_CONFIG, ...config };
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

    // If we have a disconnected peer for this URL, reuse its entry
    if (existing) {
      existing.status = 'connected';
      existing.lastSeen = Date.now();
      // Replace the stale client with a fresh one
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
  handleIncoming(message: GossipMessage): boolean {
    // HMAC verification — reject unauthenticated gossip when secret is configured
    if (!this.verifyGossip(message)) {
      return false;
    }

    // Deduplication check
    if (this.seenMessageSet.has(message.messageId)) {
      return false;
    }

    // Mark as seen
    this.markSeen(message.messageId);

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
  private signGossip(message: GossipMessage): string {
    const secret = this.config.gossipSecret;
    if (!secret) return '';
    const payload = `${message.messageId}:${message.type}:${message.senderId}:${message.timestamp}`;
    return createHmac('sha256', secret).update(payload).digest('hex');
  }

  /** Verify a gossip message's HMAC signature (constant-time comparison) */
  private verifyGossip(message: GossipMessage): boolean {
    const secret = this.config.gossipSecret;
    if (!secret) return true; // No secret configured — skip auth (backward compat)
    if (!message.signature) return false; // Secret required but no signature present
    const expected = this.signGossip(message);
    const a = Buffer.from(message.signature, 'hex');
    const b = Buffer.from(expected, 'hex');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
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
