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
 * EntityNodeBase — abstract base class for all entity nodes.
 *
 * Provides shared functionality:
 *   - L2Client connection to the sequencer
 *   - Partition discovery and routing
 *   - ClaimAccumulatorEntry → EntityClaimView transformation
 *   - Activity summary computation
 *   - Date range filtering
 *   - Event streaming
 *   - Health checks
 *
 * Subclasses (MemberNode, PrescriberNode, PharmacyNode, InsurerNode)
 * add role-specific proof generation and query methods.
 */
import { L2Client, DEFAULT_L2_CLIENT_OPTIONS } from '../l2/l2-client.js';
import type { L2ClientOptions } from '../l2/l2-client.js';
import { PartitionRouter, getPartition } from '../l2/l2-partition.js';
import type { L2ChainState, L2Receipt } from '../l2/l2-types.js';
import type { ClaimAccumulatorEntry } from '../l2/claim-accumulator-types.js';
import type { StoredMessage, MessagePayload, MessageStoreEntry } from '../l2/message-store-types.js';
import type { RequestSigner } from '../security/wallet-key.js';
import type { NfcCredentialAttestation } from '../credentials/nfc-attestation.js';
import type { L2ChainEvent, L2EventHandler, L2NodeStatus } from '../l2/l2-node.js';
import type {
  EntityNodeConfig,
  EntityRole,
  EntityClaimView,
  EntityActivitySummary,
} from './entity-node-types.js';

// ─── EntityNodeBase ─────────────────────────────────────────

export abstract class EntityNodeBase {
  protected client: L2Client;
  protected config: EntityNodeConfig;
  private partitionRouter: PartitionRouter | null = null;
  private partitionClients: Map<number, L2Client> = new Map();

  constructor(config: EntityNodeConfig) {
    if (!config.sequencerUrl) {
      throw new Error('sequencerUrl is required');
    }
    if (!config.role) {
      throw new Error('role is required');
    }
    this.config = config;
    const clientOptions: L2ClientOptions = {
      ...DEFAULT_L2_CLIENT_OPTIONS,
      sequencerUrl: config.sequencerUrl,
      ...config.clientOptions,
    };
    this.client = new L2Client(clientOptions);
  }

  // ─── Connection ─────────────────────────────────────────

  /**
   * Discover all sequencer partitions from the primary sequencer.
   * After discovery, proofs can be auto-routed to the correct partition.
   */
  async discoverPartitions(): Promise<void> {
    const info = await this.client.getPartitionInfo();
    if (!info.partitioned || !info.partitionConfig) {
      this.partitionRouter = null;
      this.partitionClients.clear();
      return;
    }

    const router = new PartitionRouter(info.partitionConfig.partitionCount);
    for (const p of info.allPartitions) {
      router.setPartition(p.partitionIndex, p.url);
    }
    this.partitionRouter = router;

    // Pre-create clients for each partition
    this.partitionClients.clear();
    for (const p of info.allPartitions) {
      const clientOpts: L2ClientOptions = {
        ...DEFAULT_L2_CLIENT_OPTIONS,
        sequencerUrl: p.url,
        ...this.config.clientOptions,
      };
      this.partitionClients.set(p.partitionIndex, new L2Client(clientOpts));
    }
  }

  /**
   * Get the L2Client for a specific member wallet's partition.
   * Falls back to the primary client if no partition routing is configured.
   */
  protected getClientForWallet(walletId: string): L2Client {
    if (!this.partitionRouter) return this.client;
    const partitionCount = this.partitionRouter.getPartitionCount();
    const idx = getPartition(walletId, partitionCount);
    return this.partitionClients.get(idx) ?? this.client;
  }

  /**
   * Execute a partition-routed operation with automatic failover.
   *
   * On connection failure (ECONNREFUSED, timeout, etc.), re-discovers
   * partition leaders from the primary sequencer and retries once.
   * This handles transparent failover when a leviathan partition leader
   * goes down and another node has promoted itself.
   */
  protected async withPartitionRetry<T>(
    walletId: string,
    fn: (client: L2Client) => Promise<T>,
  ): Promise<T> {
    const client = this.getClientForWallet(walletId);
    try {
      return await fn(client);
    } catch (err) {
      if (this.isConnectionError(err)) {
        await this.discoverPartitions();
        const retryClient = this.getClientForWallet(walletId);
        return fn(retryClient);
      }
      throw err;
    }
  }

  /**
   * Check if an error indicates a connection-level failure (not an
   * application-level rejection). These errors suggest the partition
   * leader may have changed.
   */
  private isConnectionError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    const msg = err.message.toLowerCase();
    return (
      msg.includes('econnrefused') ||
      msg.includes('econnreset') ||
      msg.includes('etimedout') ||
      msg.includes('enetunreach') ||
      msg.includes('ehostunreach') ||
      msg.includes('fetch failed') ||
      msg.includes('network error') ||
      msg.includes('socket hang up') ||
      msg.includes('aborted')
    );
  }

  // ─── Shared Query Methods ───────────────────────────────

  /** Get the sequencer's current chain state (roots, counts, batch info) */
  async getChainState(): Promise<L2ChainState> {
    return this.client.getChainState();
  }

  /** Get the sequencer's current status */
  async getStatus(): Promise<L2NodeStatus> {
    return this.client.getStatus();
  }

  /** Check if the sequencer is reachable and running */
  async isHealthy(): Promise<boolean> {
    return this.client.isHealthy();
  }

  /** Look up a receipt by ID */
  async getReceipt(receiptId: string): Promise<L2Receipt | null> {
    return this.client.getReceipt(receiptId, this.walletSigner() ?? undefined);
  }

  /**
   * Connect to the sequencer's SSE event stream.
   * Returns a disconnect function.
   */
  connectEvents(handler: L2EventHandler): () => void {
    return this.client.connectEvents(handler);
  }

  /** Get the underlying L2Client (for advanced use) */
  getClient(): L2Client {
    return this.client;
  }

  /** Get this node's entity role */
  getRole(): EntityRole {
    return this.config.role;
  }

  /** Get this node's wallet ID (undefined for insurer) */
  getWalletId(): string | undefined {
    return this.config.walletId;
  }

  /** Get the display name */
  getDisplayName(): string | undefined {
    return this.config.displayName;
  }

  /** Get the current partition router (null if no partitioning) */
  getPartitionRouter(): PartitionRouter | null {
    return this.partitionRouter;
  }

  // ─── The wallet's own signature (A10b) ──────────────────

  /** Where this node's wallet signing key comes from; the app server that holds the enrollment key sets it. */
  private walletSignerSource: (() => RequestSigner | null) | null = null;

  setWalletSignerSource(source: (() => RequestSigner | null) | null): void {
    this.walletSignerSource = source;
  }

  /** A signer for this node's own wallet, or null when the node holds no enrollment key (locked, or started without one). */
  walletSigner(): RequestSigner | null {
    try {
      return this.walletSignerSource?.() ?? null;
    } catch {
      return null;
    }
  }

  // ─── Messaging ─────────────────────────────────────────

  /** Store an encrypted message on the sequencer, signed as this node's wallet (A10b). */
  async storeMessage(message: StoredMessage, payload: MessagePayload, signer: RequestSigner | null = this.walletSigner()): Promise<MessageStoreEntry> {
    return this.client.storeMessage(message, payload, signer ?? undefined);
  }

  /** Ask for a signed NFC attestation of this node's wallet, signed as that wallet (A10b). */
  async requestAttestation(walletId: string, expirySeconds?: number): Promise<NfcCredentialAttestation> {
    return this.client.requestAttestation(walletId, expirySeconds, this.walletSigner() ?? undefined);
  }

  /** Get messages received by this wallet */
  async getInbox(): Promise<MessageStoreEntry[]> {
    const walletId = this.config.walletId;
    if (!walletId) return [];
    return this.client.getMessagesByRecipient(walletId, this.walletSigner() ?? undefined);
  }

  /** Get messages sent by this wallet */
  async getSentMessages(): Promise<MessageStoreEntry[]> {
    const walletId = this.config.walletId;
    if (!walletId) return [];
    return this.client.getMessagesBySender(walletId, this.walletSigner() ?? undefined);
  }

  /** Get all messages in a thread */
  async getMessagesByThread(threadIdHash: string): Promise<MessageStoreEntry[]> {
    return this.client.getMessagesByThread(threadIdHash, this.walletSigner() ?? undefined);
  }

  /** Get all messages involving this wallet (sent + received) */
  async getAllMessages(): Promise<MessageStoreEntry[]> {
    const walletId = this.config.walletId;
    if (!walletId) return [];
    return this.client.getMessagesByWallet(walletId, this.walletSigner() ?? undefined);
  }

  /** Get the Message Store root and count */
  async getMessageStoreStatus(): Promise<{ root: string; messageCount: string }> {
    return this.client.getMessageStoreRoot();
  }

  // ─── Shared Transformation Helpers ──────────────────────

  /**
   * Transform ClaimAccumulatorEntry[] into EntityClaimView[].
   * Merges the cryptographic leaf data with display metadata.
   */
  protected toClaimViews(entries: ClaimAccumulatorEntry[]): EntityClaimView[] {
    return entries.map((entry) => ({
      leafIndex: entry.leafIndex,
      dateOfService: entry.metadata.dateOfService ?? entry.leaf.dateOfService,
      patientPayCents: entry.leaf.patientPayCents,
      planPayCents: entry.leaf.planPayCents,
      operationType:
        entry.leaf.operationType === '2' ? 'reversal' : 'fulfillment',
      memberWalletId: entry.leaf.memberWalletId,
      pharmacyWalletId: entry.leaf.pharmacyWalletId,
      prescriberWalletId: entry.leaf.prescriberWalletId,
      ndcHash: entry.leaf.ndcHash,
      brandName: entry.metadata.brandName,
      ndc: entry.metadata.ndc,
      tierLevel: entry.metadata.tierLevel,
      therapeuticClass: entry.metadata.therapeuticClass,
      daysSupply: entry.metadata.daysSupply,
      fillNumber: entry.metadata.fillNumber,
      gpi: entry.metadata.gpi,
      receiptId: entry.metadata.receiptId,
      timestamp: entry.metadata.timestamp,
    }));
  }

  /**
   * Compute an activity summary from a list of claim views.
   */
  protected summarize(views: EntityClaimView[]): EntityActivitySummary {
    let totalClaims = 0;
    let totalReversals = 0;
    let totalPatientPayCents = 0n;
    let totalPlanPayCents = 0n;
    const ndcSet = new Set<string>();
    let earliest: string | null = null;
    let latest: string | null = null;

    for (const v of views) {
      if (v.operationType === 'reversal') {
        totalReversals++;
      } else {
        totalClaims++;
      }
      if (v.operationType === 'reversal') {
        totalPatientPayCents -= BigInt(v.patientPayCents);
        totalPlanPayCents -= BigInt(v.planPayCents);
      } else {
        totalPatientPayCents += BigInt(v.patientPayCents);
        totalPlanPayCents += BigInt(v.planPayCents);
      }
      ndcSet.add(v.ndcHash);

      if (earliest === null || v.dateOfService < earliest) {
        earliest = v.dateOfService;
      }
      if (latest === null || v.dateOfService > latest) {
        latest = v.dateOfService;
      }
    }

    return {
      totalClaims,
      totalReversals,
      activeClaims: totalClaims - totalReversals,
      totalPatientPayCents,
      totalPlanPayCents,
      uniqueMedications: ndcSet.size,
      dateRange:
        earliest && latest ? { earliest, latest } : null,
    };
  }

  /**
   * Filter claim views to a date range (inclusive, CCYYMMDD string compare).
   */
  protected filterByDateRange(
    views: EntityClaimView[],
    start: string,
    end: string,
  ): EntityClaimView[] {
    return views.filter(
      (v) => v.dateOfService >= start && v.dateOfService <= end,
    );
  }

  /**
   * Compute a medication breakdown from claim views.
   */
  protected medicationBreakdown(
    views: EntityClaimView[],
  ): import('./entity-node-types.js').MedicationBreakdownEntry[] {
    const map = new Map<
      string,
      {
        ndcHash: string;
        brandName?: string;
        tierLevel?: number;
        therapeuticClass?: string;
        claimCount: number;
        totalPatientPayCents: bigint;
        totalPlanPayCents: bigint;
      }
    >();

    for (const v of views) {
      const existing = map.get(v.ndcHash);
      if (existing) {
        existing.claimCount++;
        if (v.operationType === 'reversal') {
          existing.totalPatientPayCents -= BigInt(v.patientPayCents);
          existing.totalPlanPayCents -= BigInt(v.planPayCents);
        } else {
          existing.totalPatientPayCents += BigInt(v.patientPayCents);
          existing.totalPlanPayCents += BigInt(v.planPayCents);
        }
      } else {
        const sign = v.operationType === 'reversal' ? -1n : 1n;
        map.set(v.ndcHash, {
          ndcHash: v.ndcHash,
          brandName: v.brandName,
          tierLevel: v.tierLevel,
          therapeuticClass: v.therapeuticClass,
          claimCount: 1,
          totalPatientPayCents: BigInt(v.patientPayCents) * sign,
          totalPlanPayCents: BigInt(v.planPayCents) * sign,
        });
      }
    }

    return Array.from(map.values()).sort(
      (a, b) => b.claimCount - a.claimCount,
    );
  }
}
