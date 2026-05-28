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
 * L2Leviathan — Multi-leader partitioned L2 node for zkpCare.
 *
 * Each leviathan manages N partition sequencers. It leads one primary
 * partition (accepts proofs, builds batches) and replicates all other
 * partitions via gossip. If a partition leader goes down, the next
 * in the failover chain automatically promotes.
 *
 * Architecture:
 *   - N L2SequencerService instances (one per partition), each with own root chain
 *   - Shared L2PeerNetwork for gossip across all partitions
 *   - Per-partition batch timers (only for led partitions)
 *   - Heartbeat protocol for leader detection and failover
 *   - Aggregated read queries across all partitions
 *
 * Usage:
 *   const lev = new L2Leviathan(config, options, store, regRoot, lcRoot, walletCount);
 *   lev.start();
 *   await lev.submitProof(proof);  // routes to correct partition
 *   await lev.stop();
 */
import { Field } from 'o1js';
import type { ILocalStore } from '../storage/local-store.js';
import type { StateTransitionProof, TransitionOutput } from '../engine/state-transition.js';
import { L2SequencerService } from './l2-sequencer-service.js';
import type { AdminStateConfig } from './l2-sequencer-service.js';
import type { L2Receipt, L2Batch, L2Block, ClaimSubmissionMetadata } from './l2-types.js';
import type { AuditEvent, AuditLog } from '../audit/audit-types.js';
import type { ClaimAccumulatorEntry } from './claim-accumulator-types.js';
import { L2PeerNetwork, generateMessageId } from './l2-peer-network.js';
import type { GossipMessage, L2NodeRole } from './l2-peer-types.js';
import type {
  ProofAcceptedPayload,
  BatchBuiltPayload,
  BatchSettledPayload,
  BatchFailedPayload,
  MessageStoredPayload,
  PlanUpdatedPayload,
  PlanDeletedPayload,
  FormularyUpdatedPayload,
} from './l2-peer-types.js';
import type { StoredMessage, MessagePayload, MessageStoreEntry } from './message-store-types.js';
import type { BenefitPlanConfig } from './l2-types.js';
import { getPartition, PartitionRouter } from './l2-partition.js';
import type { PartitionConfig } from './l2-partition.js';
import type { L2ChainEvent, L2EventHandler, L2NodeOptions } from './l2-node.js';
import { DEFAULT_L2_NODE_OPTIONS } from './l2-node.js';
import type { L2CheckpointTrigger, L2SequencerState } from './l2-checkpoint.js';
import type { LeviathanCheckpoint } from './l2-checkpoint.js';
import {
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_HEARTBEAT_TIMEOUT_MS,
} from './l2-leviathan-types.js';
import type {
  LeviathanConfig,
  PartitionLeaderEntry,
  LeviathanStatus,
  PartitionStats,
  LeaderHeartbeatPayload,
  LeaderPromotionPayload,
} from './l2-leviathan-types.js';
import type { IWalProvider } from './l2-wal.js';
import { L2QuorumService, QuorumKeyAuthority, computeStateDigestHash } from './l2-quorum-service.js';
import type { QuorumConfig, QuorumProposal, QuorumVote, QuorumCertificate, StateCertificate } from './l2-quorum-types.js';
import type { StateDigest } from './l2-peer-types.js';
import type { ProvingPool } from './l2-proving-pool.js';

// ─── L2Leviathan ──────────────────────────────────────────

export class L2Leviathan {
  private config: LeviathanConfig;
  private nodeId: string;
  private options: L2NodeOptions;
  private store: ILocalStore;

  // Per-partition sequencer instances
  private partitionSequencers: Map<number, L2SequencerService> = new Map();

  // Per-partition batch timers (only for led partitions)
  private batchTimers: Map<number, ReturnType<typeof setTimeout>> = new Map();
  private batchInProgress: Map<number, boolean> = new Map();

  // Leadership tracking
  private leaderMap: Map<number, PartitionLeaderEntry> = new Map();
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatMonitorTimer: ReturnType<typeof setTimeout> | null = null;

  // Peer network (shared across all partitions)
  private peerNetwork: L2PeerNetwork | null = null;

  // Per-partition stats
  private partitionProofs: Map<number, number> = new Map();
  private partitionBatches: Map<number, number> = new Map();
  private partitionSettled: Map<number, number> = new Map();
  private partitionFailed: Map<number, number> = new Map();

  // Event system
  private handlers: L2EventHandler[] = [];

  // Lifecycle
  private running = false;
  private startedAt = 0;

  // Proving mutex — o1js requires serial ZkProgram proving
  private _provingLockQueue: Promise<void> = Promise.resolve();

  // Proving pool — optional worker fleet for parallel batch proving
  private provingPool: ProvingPool | null = null;

  // Write-Ahead Log (optional — enables crash-safe durability)
  private walProvider: IWalProvider | null = null;

  // Quorum service (optional — enables N/2+1 consensus on proof acceptance)
  private quorumService: L2QuorumService | null = null;
  private quorumKeyAuthority: QuorumKeyAuthority | null = null;

  // Peer public keys collected from heartbeats
  private peerPublicKeys: Map<string, string> = new Map();

  constructor(
    config: LeviathanConfig,
    options: Partial<L2NodeOptions>,
    store: ILocalStore,
    initialRegistryRoot: Field,
    initialLifecycleRoot: Field,
    initialWalletCount: Field,
  ) {
    if (config.partitionCount < 1) {
      throw new Error('partitionCount must be >= 1');
    }
    if (config.primaryPartition < 0 || config.primaryPartition >= config.partitionCount) {
      throw new Error(`primaryPartition ${config.primaryPartition} out of range [0, ${config.partitionCount})`);
    }

    this.config = {
      ...config,
      heartbeatIntervalMs: config.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
      heartbeatTimeoutMs: config.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS,
    };
    this.options = { ...DEFAULT_L2_NODE_OPTIONS, ...options };
    this.nodeId = options.nodeId ?? `lev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    this.store = store;

    // Create one L2SequencerService per partition
    for (let i = 0; i < config.partitionCount; i++) {
      const seq = new L2SequencerService(
        store,
        initialRegistryRoot,
        initialLifecycleRoot,
        initialWalletCount,
        this.options.batchIntervalMs,
        this.options.l2Only ?? false,
      );
      seq.setPartitionConfig({ partitionCount: config.partitionCount, partitionIndex: i });
      this.partitionSequencers.set(i, seq);
      this.partitionProofs.set(i, 0);
      this.partitionBatches.set(i, 0);
      this.partitionSettled.set(i, 0);
      this.partitionFailed.set(i, 0);
      this.batchInProgress.set(i, false);
    }

    // 3f fix: Validate failover chain completeness
    // Every partition must have a failover chain entry, otherwise
    // checkHeartbeats() will silently skip the partition forever.
    for (let i = 0; i < config.partitionCount; i++) {
      if (!config.failoverChain.has(i)) {
        // Auto-generate a minimal chain: primary leader = first known node
        // This ensures heartbeat monitoring works for all partitions
        const defaultChain = [this.nodeId];
        config.failoverChain.set(i, defaultChain);
      }
    }

    // Initialize leader map — this node leads its primary partition
    for (let i = 0; i < config.partitionCount; i++) {
      const chain = config.failoverChain.get(i);
      const primaryLeader = chain?.[0] ?? this.nodeId;
      this.leaderMap.set(i, {
        partitionIndex: i,
        currentLeader: primaryLeader,
        lastHeartbeatAt: Date.now(),
        isLocalLeader: i === config.primaryPartition,
      });
    }
  }

  // ─── WAL + Quorum Configuration ─────────────────────────

  /**
   * Set the Write-Ahead Log provider for crash-safe durability.
   * Also sets the WAL on each partition sequencer.
   */
  setWal(provider: IWalProvider): void {
    this.walProvider = provider;
    for (const seq of this.partitionSequencers.values()) {
      seq.setWal(provider);
    }
  }

  /** Get the WAL provider */
  getWal(): IWalProvider | null {
    return this.walProvider;
  }

  /**
   * Attach a proving pool for parallel batch proving.
   * When set, executeBatchCycle() dispatches proving to the pool
   * instead of using the single-process proving lock.
   */
  setProvingPool(pool: ProvingPool): void {
    this.provingPool = pool;

    // Forward pool lifecycle events to the leviathan event stream
    pool.on((event) => {
      this.emit({
        type: `pool:${event.type}` as import('./l2-node.js').L2EventType,
        timestamp: event.timestamp,
        data: { workerId: event.workerId, ...event.data },
      });
    });
  }

  /** Get the attached proving pool (if any). */
  getProvingPool(): ProvingPool | null {
    return this.provingPool;
  }

  /**
   * Enable quorum writes with Ed25519-based consensus.
   *
   * @param seed — optional seed for deterministic keypair (e.g., Buffer.from(nodeId))
   */
  enableQuorum(config?: {
    quorumThreshold?: number;
    quorumTimeoutMs?: number;
    seed?: Buffer;
  }): void {
    const seed = config?.seed ?? Buffer.from(this.nodeId);
    this.quorumKeyAuthority = new QuorumKeyAuthority(seed);

    // Register self in peer public keys
    this.peerPublicKeys.set(this.nodeId, this.quorumKeyAuthority.publicKeyHex);

    const quorumThreshold = config?.quorumThreshold ??
      Math.floor(this.config.partitionCount / 2) + 1;

    const quorumConfig: QuorumConfig = {
      quorumThreshold,
      quorumTimeoutMs: config?.quorumTimeoutMs ?? 5_000,
      privateKey: this.quorumKeyAuthority.getPrivateKey(),
      publicKeyHex: this.quorumKeyAuthority.publicKeyHex,
      peerPublicKeys: this.peerPublicKeys,
      nodeId: this.nodeId,
    };

    this.quorumService = new L2QuorumService(quorumConfig);
  }

  /** Get the quorum service (for external access) */
  getQuorumService(): L2QuorumService | null {
    return this.quorumService;
  }

  /** Get this node's quorum public key hex */
  getQuorumPublicKeyHex(): string | undefined {
    return this.quorumKeyAuthority?.publicKeyHex;
  }

  // ─── Lifecycle ──────────────────────────────────────────

  start(): void {
    if (this.running) return;
    this.running = true;
    this.startedAt = Date.now();

    this.emit({
      type: 'node:started',
      timestamp: Date.now(),
      data: {
        role: 'leviathan',
        nodeId: this.nodeId,
        partitionCount: this.config.partitionCount,
        primaryPartition: this.config.primaryPartition,
        batchIntervalMs: this.options.batchIntervalMs,
      },
    });

    // Start batch timer for primary partition
    this.scheduleBatchTick(this.config.primaryPartition);

    // Start heartbeat broadcast and monitor
    this.scheduleHeartbeat();
    this.scheduleHeartbeatMonitor();

    // Connect to seed peers
    if (this.options.seedPeers && this.options.seedPeers.length > 0) {
      this.initPeerNetwork().catch(() => {});
    }
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    // Stop all batch timers
    for (const [, timer] of this.batchTimers) {
      clearTimeout(timer);
    }
    this.batchTimers.clear();

    // Stop heartbeat timers
    if (this.heartbeatTimer !== null) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.heartbeatMonitorTimer !== null) {
      clearTimeout(this.heartbeatMonitorTimer);
      this.heartbeatMonitorTimer = null;
    }

    // Wait for any in-progress batches
    const waitPromises: Promise<void>[] = [];
    for (const [partIdx, inProgress] of this.batchInProgress) {
      if (inProgress) {
        waitPromises.push(new Promise<void>((resolve) => {
          const check = () => {
            if (!this.batchInProgress.get(partIdx)) resolve();
            else setTimeout(check, 50);
          };
          check();
        }));
      }
    }
    if (waitPromises.length > 0) {
      await Promise.all(waitPromises);
    }

    // Disconnect peer network
    if (this.peerNetwork) {
      this.peerNetwork.stop();
      this.peerNetwork = null;
    }

    this.emit({
      type: 'node:stopped',
      timestamp: Date.now(),
      data: {
        uptimeMs: Date.now() - this.startedAt,
        nodeId: this.nodeId,
      },
    });
  }

  isRunning(): boolean {
    return this.running;
  }

  // ─── Core API ───────────────────────────────────────────

  /**
   * Submit a StateTransitionProof to the leviathan.
   *
   * Routes to the correct partition sequencer based on walletId.
   * Rejects if this node is not the leader for that partition.
   */
  async submitProof(proof: StateTransitionProof, metadata?: ClaimSubmissionMetadata): Promise<L2Receipt> {
    const output = proof.publicOutput as unknown as TransitionOutput;
    const walletId = output.walletId.toString();
    const partition = getPartition(walletId, this.config.partitionCount);

    // Check leadership
    const leader = this.leaderMap.get(partition);
    if (!leader || !leader.isLocalLeader) {
      const currentLeader = leader?.currentLeader ?? 'unknown';
      throw new Error(
        `Not leader for partition ${partition} (walletId routes here). ` +
        `Current leader: ${currentLeader}`,
      );
    }

    const seq = this.partitionSequencers.get(partition)!;

    try {
      const receipt = await seq.submitProof(proof, metadata);
      this.partitionProofs.set(partition, (this.partitionProofs.get(partition) ?? 0) + 1);

      this.emit({
        type: 'proof:accepted',
        timestamp: Date.now(),
        data: {
          receiptId: receipt.receiptId,
          walletId: receipt.walletId,
          isRegistration: receipt.isRegistration,
          sequenceNumber: receipt.sequenceNumber.toString(),
          partitionIndex: partition,
          pendingCount: seq.getPendingCount(),
        },
      });

      // Build gossip payload for proof:accepted
      const auditLog = seq.getAuditLog();
      const latestAuditEvent = auditLog.events[auditLog.events.length - 1];
      const claimEntry = metadata
        ? seq.getClaimsByMember(receipt.walletId).slice(-1)[0]
        : undefined;

      const payload: ProofAcceptedPayload = {
        receipt,
        auditEvent: latestAuditEvent,
        claimEntry,
        currentRegistryRoot: seq.getCurrentRegistryRoot().toString(),
        currentLifecycleRoot: seq.getCurrentLifecycleRoot().toString(),
        currentWalletCount: seq.getCurrentWalletCount().toString(),
        partitionIndex: partition,
      };

      // Quorum write: propose and wait for N/2+1 votes before returning
      if (this.quorumService && this.peerNetwork) {
        const walEntryHash = generateMessageId(
          'quorum:propose', this.nodeId, Date.now(), receipt.receiptId,
        );

        const stateDigest: StateDigest = {
          latestSequenceNumber: receipt.sequenceNumber,
          latestBatchNumber: seq.getLatestBatchNumber(),
          auditChainHash: seq.getLatestChainHash(),
          claimAccumulatorRoot: seq.getClaimAccumulatorRoot(),
          registryRoot: seq.getCurrentRegistryRoot().toString(),
          lifecycleRoot: seq.getCurrentLifecycleRoot().toString(),
          walletCount: seq.getCurrentWalletCount().toString(),
        };

        const proposal: QuorumProposal = {
          proposalId: receipt.receiptId,
          partitionIndex: partition,
          sequenceNumber: receipt.sequenceNumber.toString(),
          walEntryHash,
          stateDigestHash: computeStateDigestHash(stateDigest),
          leaderId: this.nodeId,
          timestamp: Date.now(),
        };

        // Broadcast proposal to peers
        const proposalGossip: GossipMessage = {
          messageId: generateMessageId(
            'quorum:propose', this.nodeId, Date.now(), receipt.receiptId,
          ),
          type: 'quorum:propose',
          senderId: this.nodeId,
          timestamp: Date.now(),
          payload: proposal,
        };
        this.peerNetwork.broadcast(proposalGossip).catch(() => {});

        try {
          // Wait for quorum (includes self-vote)
          const certificate = await this.quorumService.proposeAndWait(proposal);
          receipt.quorumCertificate = certificate;

          this.emit({
            type: 'quorum:achieved',
            timestamp: Date.now(),
            data: {
              proposalId: proposal.proposalId,
              partitionIndex: partition,
              voteCount: certificate.votes.length,
              quorumThreshold: this.quorumService.getQuorumThreshold(),
            },
          });
        } catch {
          // Quorum timeout — still return receipt but without certificate
          this.emit({
            type: 'quorum:timeout',
            timestamp: Date.now(),
            data: {
              proposalId: proposal.proposalId,
              partitionIndex: partition,
            },
          });
        }

        // Also broadcast proof:accepted for non-leviathan replicas (backward compat)
        const gossipMsg: GossipMessage = {
          messageId: generateMessageId(
            'proof:accepted', this.nodeId, Date.now(), receipt.receiptId,
          ),
          type: 'proof:accepted',
          senderId: this.nodeId,
          timestamp: Date.now(),
          payload,
        };
        this.peerNetwork.broadcast(gossipMsg).catch(() => {});
      } else if (this.peerNetwork) {
        // No quorum — fire-and-forget gossip (backward compatible)
        const gossipMsg: GossipMessage = {
          messageId: generateMessageId(
            'proof:accepted', this.nodeId, Date.now(), receipt.receiptId,
          ),
          type: 'proof:accepted',
          senderId: this.nodeId,
          timestamp: Date.now(),
          payload,
        };
        this.peerNetwork.broadcast(gossipMsg).catch(() => {});
      }

      return receipt;
    } catch (err) {
      this.emit({
        type: 'proof:rejected',
        timestamp: Date.now(),
        data: {
          reason: err instanceof Error ? err.message : String(err),
          partitionIndex: partition,
        },
      });
      throw err;
    }
  }

  /**
   * Manually trigger a batch build for a specific partition.
   * Defaults to the primary partition.
   */
  async forceBatch(partitionIndex?: number): Promise<L2Batch | null> {
    const idx = partitionIndex ?? this.config.primaryPartition;
    return this.executeBatchCycle(idx);
  }

  // ─── Events ─────────────────────────────────────────────

  on(handler: L2EventHandler): void {
    this.handlers.push(handler);
  }

  off(handler: L2EventHandler): void {
    this.handlers = this.handlers.filter((h) => h !== handler);
  }

  emit(event: L2ChainEvent): void {
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch {
        // Don't let handler errors crash the node
      }
    }
  }

  // ─── Getters ────────────────────────────────────────────

  getNodeId(): string {
    return this.nodeId;
  }

  getRole(): L2NodeRole {
    return 'leviathan';
  }

  getPeerNetwork(): L2PeerNetwork | null {
    return this.peerNetwork;
  }

  isL2Only(): boolean {
    return this.options.l2Only ?? false;
  }

  getConfig(): LeviathanConfig {
    return { ...this.config };
  }

  /** Get the sequencer for a specific partition (default: primary) */
  getSequencer(partitionIndex?: number): L2SequencerService {
    const idx = partitionIndex ?? this.config.primaryPartition;
    const seq = this.partitionSequencers.get(idx);
    if (!seq) throw new Error(`Partition ${idx} not found`);
    return seq;
  }

  /** Get all partition sequencers */
  getAllSequencers(): Map<number, L2SequencerService> {
    return new Map(this.partitionSequencers);
  }

  /** Check if this node is the leader for a partition */
  isLeaderFor(partitionIndex: number): boolean {
    return this.leaderMap.get(partitionIndex)?.isLocalLeader ?? false;
  }

  /** Get all partitions this node currently leads */
  getActiveLeaderPartitions(): number[] {
    const result: number[] = [];
    for (const [idx, entry] of this.leaderMap) {
      if (entry.isLocalLeader) result.push(idx);
    }
    return result.sort((a, b) => a - b);
  }

  /** Get the full leader map */
  getLeaderMap(): Map<number, PartitionLeaderEntry> {
    return new Map(this.leaderMap);
  }

  // ─── Read Queries (Aggregated) ──────────────────────────

  /** Look up a receipt by ID — searches all partition sequencers */
  getReceipt(receiptId: string): L2Receipt | undefined {
    for (const [, seq] of this.partitionSequencers) {
      const receipt = seq.getReceipt(receiptId);
      if (receipt) return receipt;
    }
    return undefined;
  }

  /** Get all receipts for a wallet — routes to correct partition */
  getReceiptsByWallet(walletId: string): L2Receipt[] {
    const partition = getPartition(walletId, this.config.partitionCount);
    const seq = this.partitionSequencers.get(partition);
    return seq ? seq.getReceiptsByWallet(walletId) : [];
  }

  /** Get all receipts across all partitions */
  getAllReceipts(): L2Receipt[] {
    const all: L2Receipt[] = [];
    for (const [, seq] of this.partitionSequencers) {
      all.push(...seq.getAllReceipts());
    }
    return all.sort((a, b) => Number(a.sequenceNumber - b.sequenceNumber));
  }

  /** Get all batches across all partitions */
  getAllBatches(): L2Batch[] {
    const all: L2Batch[] = [];
    for (const [, seq] of this.partitionSequencers) {
      all.push(...seq.getAllBatches());
    }
    return all.sort((a, b) => Number(a.batchNumber - b.batchNumber));
  }

  /** Get a block by number — searches all partitions */
  getBlock(blockNumber: bigint): L2Block | undefined {
    for (const [, seq] of this.partitionSequencers) {
      const block = seq.getBlock(blockNumber);
      if (block) return block;
    }
    return undefined;
  }

  /** Get a batch by number — searches all partitions */
  getBatch(batchNumber: bigint): L2Batch | undefined {
    for (const [, seq] of this.partitionSequencers) {
      const batch = seq.getBatch(batchNumber);
      if (batch) return batch;
    }
    return undefined;
  }

  /** Get merged audit log across all partitions, sorted by timestamp */
  getAuditLog(): AuditLog {
    const allEvents: AuditEvent[] = [];
    for (const [, seq] of this.partitionSequencers) {
      const log = seq.getAuditLog();
      allEvents.push(...log.events);
    }
    allEvents.sort((a, b) => a.timestamp - b.timestamp);
    return {
      events: allEvents,
      genesisHash: this.getSequencer(0).getAuditLog().genesisHash,
      latestChainHash: allEvents.length > 0
        ? allEvents[allEvents.length - 1].chainHash
        : this.getSequencer(0).getAuditLog().genesisHash,
      eventCount: BigInt(allEvents.length),
    };
  }

  /** Get claims for a member — routes to correct partition */
  getClaimsByMember(memberWalletId: string): ClaimAccumulatorEntry[] {
    const partition = getPartition(memberWalletId, this.config.partitionCount);
    const seq = this.partitionSequencers.get(partition);
    return seq ? seq.getClaimsByMember(memberWalletId) : [];
  }

  /** Get claims for a pharmacy — searches all partitions */
  getClaimsByPharmacy(pharmacyWalletId: string): ClaimAccumulatorEntry[] {
    const all: ClaimAccumulatorEntry[] = [];
    for (const [, seq] of this.partitionSequencers) {
      all.push(...seq.getClaimsByPharmacy(pharmacyWalletId));
    }
    return all;
  }

  /** Get claims for a prescriber — searches all partitions */
  getClaimsByPrescriber(prescriberWalletId: string): ClaimAccumulatorEntry[] {
    const all: ClaimAccumulatorEntry[] = [];
    for (const [, seq] of this.partitionSequencers) {
      all.push(...seq.getClaimsByPrescriber(prescriberWalletId));
    }
    return all;
  }

  /** Get claims for an NDC hash — searches all partitions */
  getClaimsByNdc(ndcHash: string): ClaimAccumulatorEntry[] {
    const all: ClaimAccumulatorEntry[] = [];
    for (const [, seq] of this.partitionSequencers) {
      all.push(...seq.getClaimsByNdc(ndcHash));
    }
    return all;
  }

  /** Get a claim with its Merkle inclusion proof — searches all partitions */
  getClaimWithProof(leafIndex: bigint): {
    entry: ClaimAccumulatorEntry;
    witnessJson: string;
    root: string;
  } | undefined {
    for (const [, seq] of this.partitionSequencers) {
      const result = seq.getClaimWithProof(leafIndex);
      if (result) return result;
    }
    return undefined;
  }

  /** Current Merkle root of the primary partition's claim accumulator */
  getClaimAccumulatorRoot(): string {
    return this.getSequencer().getClaimAccumulatorRoot();
  }

  /** Total claim leaf count across all partitions */
  getClaimLeafCount(): bigint {
    let total = 0n;
    for (const [, seq] of this.partitionSequencers) {
      total += seq.getClaimLeafCount();
    }
    return total;
  }

  /** Sync from L1 — throws in L2-only mode */
  syncFromL1(newRegistryRoot: Field, newLifecycleRoot: Field, newWalletCount: Field): void {
    if (this.isL2Only()) {
      throw new Error('L2-only mode: no L1 sync available');
    }
    for (const [, seq] of this.partitionSequencers) {
      seq.syncFromL1(newRegistryRoot, newLifecycleRoot, newWalletCount);
    }
  }

  // ─── Message Store ──────────────────────────────────────

  /**
   * Store an encrypted message on the primary partition's sequencer.
   * Messages are global (not partitioned) — all leviathans store all messages.
   * Broadcasts message:stored gossip so all replicas replicate the entry.
   */
  storeMessage(message: StoredMessage, payload: MessagePayload): MessageStoreEntry {
    const seq = this.getSequencer(); // primary partition
    const entry = seq.storeMessage(message, payload);

    // Broadcast message:stored gossip
    if (this.peerNetwork) {
      const gossipPayload: MessageStoredPayload = {
        leafIndex: entry.leafIndex,
        message,
        payload,
        leafHash: entry.leafHash,
        partitionIndex: this.config.primaryPartition,
      };

      const gossipMsg: GossipMessage = {
        messageId: generateMessageId(
          'message:stored', this.nodeId, Date.now(),
          entry.leafIndex.toString(),
        ),
        type: 'message:stored',
        senderId: this.nodeId,
        timestamp: Date.now(),
        payload: gossipPayload,
      };
      this.peerNetwork.broadcast(gossipMsg).catch(() => {});
    }

    return entry;
  }

  /**
   * Store a benefit plan on the primary partition's sequencer.
   * Plans are global (not partitioned) — all leviathans store all plans.
   * Broadcasts plan:updated gossip so all replicas replicate the entry.
   */
  async storePlan(plan: BenefitPlanConfig): Promise<void> {
    const seq = this.getSequencer();
    await seq.storePlanWithWal(plan);

    if (this.peerNetwork) {
      const gossipMsg: GossipMessage = {
        messageId: generateMessageId('plan:updated', this.nodeId, Date.now(), plan.planId),
        type: 'plan:updated',
        senderId: this.nodeId,
        timestamp: Date.now(),
        payload: { plan, partitionIndex: this.config.primaryPartition } as PlanUpdatedPayload,
      };
      this.peerNetwork.broadcast(gossipMsg).catch(() => {});
    }
  }

  /**
   * Delete a benefit plan from the primary partition's sequencer.
   * Broadcasts plan:deleted gossip so all replicas remove the entry.
   */
  async deletePlan(planId: string): Promise<boolean> {
    const seq = this.getSequencer();
    const deleted = await seq.deletePlanWithWal(planId);
    if (!deleted) return false;

    if (this.peerNetwork) {
      const gossipMsg: GossipMessage = {
        messageId: generateMessageId('plan:deleted', this.nodeId, Date.now(), planId),
        type: 'plan:deleted',
        senderId: this.nodeId,
        timestamp: Date.now(),
        payload: { planId, partitionIndex: this.config.primaryPartition } as PlanDeletedPayload,
      };
      this.peerNetwork.broadcast(gossipMsg).catch(() => {});
    }
    return true;
  }

  /**
   * Store a formulary with gossip replication.
   * Wraps sequencer.storeFormulary() with gossip broadcast.
   */
  storeFormularyWithGossip(planIdHash: string, formularyRoot: string, entriesJson: string): void {
    const seq = this.getSequencer();
    seq.storeFormulary(planIdHash, formularyRoot, entriesJson);

    if (this.peerNetwork) {
      const gossipMsg: GossipMessage = {
        messageId: generateMessageId('formulary:updated', this.nodeId, Date.now(), planIdHash),
        type: 'formulary:updated',
        senderId: this.nodeId,
        timestamp: Date.now(),
        payload: { planIdHash, formularyRoot, entriesJson, partitionIndex: this.config.primaryPartition } as FormularyUpdatedPayload,
      };
      this.peerNetwork.broadcast(gossipMsg).catch(() => {});
    }
  }

  /** Get partition config for the primary partition */
  getPartitionConfig(): PartitionConfig | null {
    return {
      partitionCount: this.config.partitionCount,
      partitionIndex: this.config.primaryPartition,
    };
  }

  /** Get partition router — leviathans handle routing internally */
  getPartitionRouter(): PartitionRouter | null {
    return null;
  }

  // ─── Status ─────────────────────────────────────────────

  getStatus(): LeviathanStatus {
    const now = Date.now();
    const partitionStats: PartitionStats[] = [];
    let totalProofs = 0;
    let totalBatches = 0;
    let totalSettled = 0;
    let totalFailed = 0;
    let totalPending = 0;

    for (let i = 0; i < this.config.partitionCount; i++) {
      const seq = this.partitionSequencers.get(i)!;
      const leader = this.leaderMap.get(i)!;
      const proofs = this.partitionProofs.get(i) ?? 0;
      const batches = this.partitionBatches.get(i) ?? 0;
      const settled = this.partitionSettled.get(i) ?? 0;

      partitionStats.push({
        partitionIndex: i,
        isLeader: leader.isLocalLeader,
        currentLeader: leader.currentLeader,
        pendingProofs: seq.getPendingCount(),
        totalReceipts: seq.getAllReceipts().length,
        totalBatches: seq.getAllBatches().length,
        latestSequenceNumber: seq.getLatestSequenceNumber().toString(),
        registryRoot: seq.getCurrentRegistryRoot().toString(),
        lifecycleRoot: seq.getCurrentLifecycleRoot().toString(),
        walletCount: seq.getCurrentWalletCount().toString(),
        auditChainHash: seq.getLatestChainHash(),
      });

      totalProofs += proofs;
      totalBatches += batches;
      totalSettled += settled;
      totalFailed += (this.partitionFailed.get(i) ?? 0);
      totalPending += seq.getPendingCount();
    }

    const leaderMapObj: Record<number, string> = {};
    for (const [idx, entry] of this.leaderMap) {
      leaderMapObj[idx] = entry.currentLeader;
    }

    return {
      nodeId: this.nodeId,
      role: 'leviathan',
      partitionCount: this.config.partitionCount,
      primaryPartition: this.config.primaryPartition,
      activeLeaderPartitions: this.getActiveLeaderPartitions(),
      leaderMap: leaderMapObj,
      partitionStats,
      globalTotals: {
        totalProofsAccepted: totalProofs,
        totalBatchesBuilt: totalBatches,
        totalBatchesSettled: totalSettled,
        totalBatchesFailed: totalFailed,
        pendingProofs: totalPending,
      },
      running: this.running,
      uptimeMs: this.running ? now - this.startedAt : 0,
      l2Only: this.options.l2Only ?? false,
    };
  }

  getPartitionStatus(partitionIndex: number): PartitionStats | undefined {
    const status = this.getStatus();
    return status.partitionStats.find((s) => s.partitionIndex === partitionIndex);
  }

  // ─── Batch Building ─────────────────────────────────────

  private scheduleBatchTick(partitionIndex: number): void {
    if (!this.running) return;

    const timer = setTimeout(async () => {
      this.emit({
        type: 'node:tick',
        timestamp: Date.now(),
        data: {
          partitionIndex,
          pendingCount: this.partitionSequencers.get(partitionIndex)?.getPendingCount() ?? 0,
        },
      });
      await this.executeBatchCycle(partitionIndex);
      this.scheduleBatchTick(partitionIndex);
    }, this.options.batchIntervalMs);

    this.batchTimers.set(partitionIndex, timer);
  }

  private async executeBatchCycle(partitionIndex: number): Promise<L2Batch | null> {
    if (this.batchInProgress.get(partitionIndex)) return null;

    const seq = this.partitionSequencers.get(partitionIndex);
    if (!seq) return null;

    if (seq.getPendingCount() === 0) {
      this.emit({
        type: 'batch:empty',
        timestamp: Date.now(),
        data: { partitionIndex },
      });
      return null;
    }

    this.batchInProgress.set(partitionIndex, true);

    try {
      this.emit({
        type: 'batch:building',
        timestamp: Date.now(),
        data: { partitionIndex, pendingCount: seq.getPendingCount() },
      });

      let batch: L2Batch | null;

      if (this.provingPool) {
        // Pool path: prepareBatch → pool.prove → finalizeBatch
        if (!this.provingPool.isRunning()) {
          // Pool is configured but still compiling — skip this cycle
          this.batchInProgress.set(partitionIndex, false);
          return null;
        }
        const { job, emptyBatch } = seq.prepareBatch();
        if (!job) {
          batch = emptyBatch;
        } else {
          try {
            const proofCount = job.transitionProofJsons.length;
            const desc = `P${partitionIndex} Batch — ${proofCount} proof${proofCount !== 1 ? 's' : ''}${job.adminState ? ' + chain' : ''}`;
            const result = await this.provingPool.prove(job, desc);
            batch = await seq.finalizeBatch(result);
          } catch (err) {
            seq.restoreDrainedTransitions();
            throw err;
          }
        }
      } else {
        // Legacy path: single-process proving with proving lock
        batch = await this.withProvingLock(() => seq.buildBatch());
      }

      if (!batch) {
        this.batchInProgress.set(partitionIndex, false);
        return null;
      }

      this.partitionBatches.set(partitionIndex, (this.partitionBatches.get(partitionIndex) ?? 0) + 1);

      this.emit({
        type: 'batch:built',
        timestamp: Date.now(),
        data: {
          batchNumber: batch.batchNumber.toString(),
          partitionIndex,
          registrationCount: batch.registrationCount,
          transitionCount: batch.transitionCount,
        },
      });

      // Broadcast batch:built gossip
      if (this.peerNetwork) {
        const blockNumber = batch.blockNumbers?.[0] ?? batch.batchNumber;
        const block = seq.getBlock(blockNumber);
        if (block) {
          const updatedReceipts = seq.getAllReceipts().filter(
            (r) => r.l1BatchNumber === batch.batchNumber,
          );
          const auditLog = seq.getAuditLog();
          const updatedAuditEvents = auditLog.events.filter(
            (e) => e.l1BatchNumber === batch.batchNumber,
          );

          const payload: BatchBuiltPayload = {
            batch,
            block,
            updatedReceipts,
            updatedAuditEvents,
            partitionIndex,
          };

          const gossipMsg: GossipMessage = {
            messageId: generateMessageId(
              'batch:built', this.nodeId, Date.now(),
              batch.batchNumber.toString(),
            ),
            type: 'batch:built',
            senderId: this.nodeId,
            timestamp: Date.now(),
            payload,
          };
          this.peerNetwork.broadcast(gossipMsg).catch(() => {});
        }
      }

      // L2-only mode: batch is already finalized
      if (this.options.l2Only) {
        this.partitionSettled.set(partitionIndex, (this.partitionSettled.get(partitionIndex) ?? 0) + 1);

        this.emit({
          type: 'batch:settled',
          timestamp: Date.now(),
          data: {
            batchNumber: batch.batchNumber.toString(),
            partitionIndex,
            l1TxHash: batch.l1TxHash ?? `l2-final-${batch.batchNumber}`,
            l2Only: true,
          },
        });

        // Broadcast batch:settled gossip
        if (this.peerNetwork) {
          const settledPayload: BatchSettledPayload = {
            batchNumber: batch.batchNumber,
            l1TxHash: batch.l1TxHash ?? `l2-final-${batch.batchNumber}`,
            lastSettledRegistryRoot: seq.getLastSettledRegistryRoot().toString(),
            lastSettledLifecycleRoot: seq.getLastSettledLifecycleRoot().toString(),
            lastSettledWalletCount: seq.getLastSettledWalletCount().toString(),
            partitionIndex,
          };
          const settledMsg: GossipMessage = {
            messageId: generateMessageId(
              'batch:settled', this.nodeId, Date.now(),
              batch.batchNumber.toString(),
            ),
            type: 'batch:settled',
            senderId: this.nodeId,
            timestamp: Date.now(),
            payload: settledPayload,
          };
          this.peerNetwork.broadcast(settledMsg).catch(() => {});
        }
      }

      return batch;
    } catch (err) {
      this.emit({
        type: 'batch:failed',
        timestamp: Date.now(),
        data: {
          reason: err instanceof Error ? err.message : String(err),
          partitionIndex,
        },
      });
      this.partitionFailed.set(partitionIndex, (this.partitionFailed.get(partitionIndex) ?? 0) + 1);
      return null;
    } finally {
      this.batchInProgress.set(partitionIndex, false);
    }
  }

  // ─── Proving Lock ───────────────────────────────────────

  private acquireProvingLock(): Promise<() => void> {
    let releaseFn!: () => void;
    const previous = this._provingLockQueue;
    this._provingLockQueue = new Promise<void>((resolve) => {
      releaseFn = resolve;
    });
    return previous.then(() => releaseFn);
  }

  private async withProvingLock<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquireProvingLock();
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        fn(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error('Proving lock timeout: operation exceeded 5 minutes'));
          }, 5 * 60 * 1000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      release();
    }
  }

  // ─── Peer Network ──────────────────────────────────────

  private async initPeerNetwork(): Promise<void> {
    const peerConfig = {
      nodeId: this.nodeId,
      role: 'leviathan' as L2NodeRole,
      seedPeers: this.options.seedPeers ?? [],
      maxPeers: this.options.maxPeers ?? 12,
      gossipRelayEnabled: true,
      announceIntervalMs: 60_000,
      syncOnConnect: false, // Leviathans manage their own sync
      ...(this.options.gossipSecret ? { gossipSecret: this.options.gossipSecret } : {}),
      ...(this.options.adminToken ? { adminToken: this.options.adminToken } : {}),
    };

    this.peerNetwork = new L2PeerNetwork(peerConfig);

    // Subscribe to gossip
    this.peerNetwork.on((msg: GossipMessage) => {
      this.handleGossip(msg).catch(() => {});
    });

    this.peerNetwork.start();

    // Connect to seed peers
    for (const url of peerConfig.seedPeers) {
      try {
        await this.peerNetwork.connectToPeer(url);
      } catch {
        // Seed unreachable — will retry on next announce cycle
      }
    }
  }

  // ─── Gossip Handling ────────────────────────────────────

  /**
   * Handle an incoming gossip message.
   *
   * Routes to the correct partition sequencer based on partitionIndex.
   * Skips messages from self. Applies replicated state for partitions
   * we don't lead. Handles heartbeat and promotion messages.
   */
  private async handleGossip(msg: GossipMessage): Promise<void> {
    // Don't process our own messages
    if (msg.senderId === this.nodeId) return;

    switch (msg.type) {
      case 'proof:accepted': {
        const payload = msg.payload as ProofAcceptedPayload;
        if (payload.partitionIndex === undefined || payload.partitionIndex === null) {
          console.warn(`[Leviathan] Gossip ${msg.type} from ${msg.senderId} missing partitionIndex, dropping`);
          return;
        }
        const partition = payload.partitionIndex;
        const seq = this.partitionSequencers.get(partition);
        if (!seq) return;

        // Skip if we are the leader for this partition (we originated it)
        if (this.isLeaderFor(partition)) return;

        seq.applyReplicatedReceipt(
          payload.receipt,
          payload.auditEvent,
          payload.claimEntry,
          payload.currentRegistryRoot,
          payload.currentLifecycleRoot,
          payload.currentWalletCount,
        );

        this.emit({
          type: 'proof:accepted',
          timestamp: Date.now(),
          data: {
            receiptId: payload.receipt.receiptId,
            walletId: payload.receipt.walletId,
            partitionIndex: partition,
            source: 'gossip',
          },
        });
        break;
      }

      case 'batch:built': {
        const payload = msg.payload as BatchBuiltPayload;
        if (payload.partitionIndex === undefined || payload.partitionIndex === null) {
          console.warn(`[Leviathan] Gossip ${msg.type} from ${msg.senderId} missing partitionIndex, dropping`);
          return;
        }
        const partition = payload.partitionIndex;
        const seq = this.partitionSequencers.get(partition);
        if (!seq) return;
        if (this.isLeaderFor(partition)) return;

        seq.applyReplicatedBatch(
          payload.batch,
          payload.block,
          payload.updatedReceipts,
          payload.updatedAuditEvents,
        );
        break;
      }

      case 'batch:settled': {
        const payload = msg.payload as BatchSettledPayload;
        if (payload.partitionIndex === undefined || payload.partitionIndex === null) {
          console.warn(`[Leviathan] Gossip ${msg.type} from ${msg.senderId} missing partitionIndex, dropping`);
          return;
        }
        const partition = payload.partitionIndex;
        const seq = this.partitionSequencers.get(partition);
        if (!seq) return;
        if (this.isLeaderFor(partition)) return;

        seq.applyReplicatedSettlement(
          payload.batchNumber,
          payload.l1TxHash,
          payload.lastSettledRegistryRoot,
          payload.lastSettledLifecycleRoot,
          payload.lastSettledWalletCount,
        );
        break;
      }

      case 'batch:failed': {
        const payload = msg.payload as BatchFailedPayload;
        if (payload.partitionIndex === undefined || payload.partitionIndex === null) {
          console.warn(`[Leviathan] Gossip ${msg.type} from ${msg.senderId} missing partitionIndex, dropping`);
          return;
        }
        const partition = payload.partitionIndex;
        const seq = this.partitionSequencers.get(partition);
        if (!seq) return;
        if (this.isLeaderFor(partition)) return;

        seq.applyReplicatedBatchFailure(
          payload.batchNumber,
          payload.reason,
        );
        break;
      }

      case 'message:stored': {
        // Messages are global — apply to primary partition sequencer (idempotent)
        const payload = msg.payload as MessageStoredPayload;
        const seq = this.getSequencer(); // primary partition
        seq.applyReplicatedMessage(payload.leafIndex, payload.message, payload.payload);
        break;
      }

      case 'plan:updated': {
        const planPayload = msg.payload as PlanUpdatedPayload;
        // WAL-durable path: survives partition crash without requiring checkpoint
        await this.getSequencer().storePlanWithWal(planPayload.plan);
        break;
      }

      case 'plan:deleted': {
        const delPayload = msg.payload as PlanDeletedPayload;
        // WAL-durable path: survives partition crash without requiring checkpoint
        await this.getSequencer().deletePlanWithWal(delPayload.planId);
        break;
      }

      case 'formulary:updated': {
        const formPayload = msg.payload as FormularyUpdatedPayload;
        this.getSequencer().storeFormulary(formPayload.planIdHash, formPayload.formularyRoot, formPayload.entriesJson);
        break;
      }

      case 'leader:heartbeat': {
        const payload = msg.payload as LeaderHeartbeatPayload;
        this.handleHeartbeat(payload);
        break;
      }

      case 'leader:promotion': {
        const payload = msg.payload as LeaderPromotionPayload;
        this.handlePromotion(payload);
        break;
      }

      // ─── Quorum Protocol ────────────────────────────────

      case 'quorum:propose': {
        // Peer received a proposal — write to WAL and send signed vote back
        if (!this.quorumService || !this.peerNetwork) break;
        const proposal = msg.payload as QuorumProposal;
        const propSeq = this.partitionSequencers.get(proposal.partitionIndex);
        if (!propSeq) break;

        // Write to local WAL if available
        if (this.walProvider) {
          await this.walProvider.append({
            type: 'proof',
            partitionIndex: proposal.partitionIndex,
            sequenceNumber: BigInt(proposal.sequenceNumber),
            walletId: undefined, // Replicated entry — walletId from receipt
            stateSnapshot: undefined,
            timestamp: Date.now(),
            originNodeId: proposal.leaderId,
          });
        }

        // Create and send signed vote back to the proposer
        const vote = this.quorumService.createVote(proposal, proposal.walEntryHash);
        const voteGossip: GossipMessage = {
          messageId: generateMessageId(
            'quorum:vote', this.nodeId, Date.now(), proposal.proposalId,
          ),
          type: 'quorum:vote',
          senderId: this.nodeId,
          timestamp: Date.now(),
          payload: vote,
        };
        this.peerNetwork.sendTo(msg.senderId, voteGossip).catch(() => {});
        break;
      }

      case 'quorum:vote': {
        // Leader received a vote — add to collection
        if (!this.quorumService) break;
        this.quorumService.handleVote(msg.payload as QuorumVote);
        break;
      }

      case 'quorum:certificate': {
        // Peer received a completed certificate — informational only
        // The actual receipt replication happens via proof:accepted gossip
        break;
      }

      // peer:announce and state:snapshot handled by L2PeerNetwork directly
      default:
        break;
    }
  }

  // ─── Heartbeat Protocol ─────────────────────────────────

  private scheduleHeartbeat(): void {
    if (!this.running) return;

    this.heartbeatTimer = setTimeout(() => {
      this.broadcastHeartbeat();
      this.scheduleHeartbeat();
    }, this.config.heartbeatIntervalMs);
  }

  private broadcastHeartbeat(): void {
    if (!this.peerNetwork) return;

    const ledPartitions = this.getActiveLeaderPartitions();
    const partitionSequences: Record<number, string> = {};
    for (const idx of ledPartitions) {
      const seq = this.partitionSequencers.get(idx);
      if (seq) {
        partitionSequences[idx] = seq.getLatestSequenceNumber().toString();
      }
    }

    const payload: LeaderHeartbeatPayload = {
      nodeId: this.nodeId,
      partitions: ledPartitions,
      partitionSequences,
      timestamp: Date.now(),
      publicKeyHex: this.quorumKeyAuthority?.publicKeyHex,
    };

    const msg: GossipMessage = {
      messageId: generateMessageId(
        'leader:heartbeat', this.nodeId, Date.now(), 'hb',
      ),
      type: 'leader:heartbeat',
      senderId: this.nodeId,
      timestamp: Date.now(),
      payload,
    };

    this.peerNetwork.broadcast(msg).catch(() => {});
  }

  private handleHeartbeat(payload: LeaderHeartbeatPayload): void {
    // Collect peer public key for quorum certificate verification
    if (payload.publicKeyHex && payload.nodeId !== this.nodeId) {
      this.peerPublicKeys.set(payload.nodeId, payload.publicKeyHex);
      this.quorumService?.updatePeerPublicKey(payload.nodeId, payload.publicKeyHex);
    }

    for (const partIdx of payload.partitions) {
      const entry = this.leaderMap.get(partIdx);
      if (!entry) continue;

      // Update leader info if this heartbeat is from the current leader
      // or if we don't know the leader yet
      if (entry.currentLeader === payload.nodeId || entry.currentLeader === 'unknown') {
        entry.currentLeader = payload.nodeId;
        entry.lastHeartbeatAt = Date.now();
        entry.isLocalLeader = (payload.nodeId === this.nodeId);
      }
    }
  }

  private scheduleHeartbeatMonitor(): void {
    if (!this.running) return;

    this.heartbeatMonitorTimer = setTimeout(() => {
      this.checkHeartbeats();
      this.scheduleHeartbeatMonitor();
    }, this.config.heartbeatIntervalMs);
  }

  private checkHeartbeats(): void {
    const now = Date.now();

    for (const [partIdx, entry] of this.leaderMap) {
      // Skip partitions we already lead
      if (entry.isLocalLeader) continue;

      // Skip if leader is alive
      if (now - entry.lastHeartbeatAt <= this.config.heartbeatTimeoutMs) continue;

      // Leader timed out — check if we should promote
      const chain = this.config.failoverChain.get(partIdx);
      if (!chain) continue;

      // Find the highest-priority live node (skip the dead leader)
      for (const candidateId of chain) {
        if (candidateId === entry.currentLeader) continue; // Skip dead leader
        if (candidateId === this.nodeId) {
          // We are the highest-priority live candidate — promote
          this.promoteToLeader(partIdx, entry.currentLeader);
          break;
        }
        // Check if this candidate has a recent heartbeat
        // (i.e., they're handling some other partition and are alive)
        let candidateAlive = false;
        for (const [, otherEntry] of this.leaderMap) {
          if (otherEntry.currentLeader === candidateId &&
              now - otherEntry.lastHeartbeatAt <= this.config.heartbeatTimeoutMs) {
            candidateAlive = true;
            break;
          }
        }
        if (candidateAlive) {
          // A higher-priority candidate is alive — they should promote, not us
          break;
        }
        // Candidate is also dead — continue to next in chain
      }
    }
  }

  /** Promote this node to leader for a partition */
  promoteToLeader(partitionIndex: number, previousLeaderId?: string, reason: 'heartbeat_timeout' | 'manual' | 'rejoin' = 'heartbeat_timeout'): void {
    const entry = this.leaderMap.get(partitionIndex);
    if (!entry) return;

    const prevLeader = previousLeaderId ?? entry.currentLeader;

    entry.currentLeader = this.nodeId;
    entry.isLocalLeader = true;
    entry.lastHeartbeatAt = Date.now();

    // Clear any existing batch timer before scheduling a new one
    const existingTimer = this.batchTimers.get(partitionIndex);
    if (existingTimer) clearTimeout(existingTimer);
    this.scheduleBatchTick(partitionIndex);

    this.emit({
      type: 'leader:promoted',
      timestamp: Date.now(),
      data: {
        action: 'leader_promotion',
        partitionIndex,
        previousLeader: prevLeader,
        newLeader: this.nodeId,
        reason,
      },
    });

    // Broadcast promotion gossip
    if (this.peerNetwork) {
      const payload: LeaderPromotionPayload = {
        newLeaderId: this.nodeId,
        partitionIndex,
        previousLeaderId: prevLeader,
        reason,
        timestamp: Date.now(),
      };

      const msg: GossipMessage = {
        messageId: generateMessageId(
          'leader:promotion', this.nodeId, Date.now(),
          `p${partitionIndex}`,
        ),
        type: 'leader:promotion',
        senderId: this.nodeId,
        timestamp: Date.now(),
        payload,
      };
      this.peerNetwork.broadcast(msg).catch(() => {});
    }
  }

  /** Demote this node from leading a partition */
  demoteFromLeader(partitionIndex: number, newLeaderId: string): void {
    const entry = this.leaderMap.get(partitionIndex);
    if (!entry) return;

    // Stop batch timer for this partition
    const timer = this.batchTimers.get(partitionIndex);
    if (timer) {
      clearTimeout(timer);
      this.batchTimers.delete(partitionIndex);
    }

    entry.currentLeader = newLeaderId;
    entry.isLocalLeader = false;
    entry.lastHeartbeatAt = Date.now();

    this.emit({
      type: 'leader:demoted',
      timestamp: Date.now(),
      data: {
        action: 'leader_demotion',
        partitionIndex,
        newLeader: newLeaderId,
      },
    });
  }

  private handlePromotion(payload: LeaderPromotionPayload): void {
    const entry = this.leaderMap.get(payload.partitionIndex);
    if (!entry) return;

    // If I also just promoted for this partition, check priority
    if (entry.isLocalLeader && entry.currentLeader === this.nodeId) {
      const chain = this.config.failoverChain.get(payload.partitionIndex);
      if (chain) {
        const myPriority = chain.indexOf(this.nodeId);
        const theirPriority = chain.indexOf(payload.newLeaderId);
        if (theirPriority >= 0 && (myPriority < 0 || theirPriority < myPriority)) {
          // They have higher priority — demote self
          this.demoteFromLeader(payload.partitionIndex, payload.newLeaderId);
          return;
        }
        // I have higher priority — ignore their promotion, my heartbeat will win
        return;
      }
    }

    // Accept the promotion
    entry.currentLeader = payload.newLeaderId;
    entry.lastHeartbeatAt = Date.now();
    entry.isLocalLeader = (payload.newLeaderId === this.nodeId);
  }

  // ─── Checkpoint ─────────────────────────────────────────

  exportCheckpoint(trigger: L2CheckpointTrigger): LeviathanCheckpoint {
    const partitionStates: Record<number, L2SequencerState> = {};
    const partitionNodeStats: Record<number, { totalProofsAccepted: number; totalBatchesBuilt: number; totalBatchesSettled: number; totalBatchesFailed: number; nextSettlementId: number }> = {};

    for (const [idx, seq] of this.partitionSequencers) {
      partitionStates[idx] = seq.exportState();
      partitionNodeStats[idx] = {
        totalProofsAccepted: this.partitionProofs.get(idx) ?? 0,
        totalBatchesBuilt: this.partitionBatches.get(idx) ?? 0,
        totalBatchesSettled: this.partitionSettled.get(idx) ?? 0,
        totalBatchesFailed: this.partitionFailed.get(idx) ?? 0,
        nextSettlementId: 1,
      };
    }

    const leaderMapObj: Record<number, string> = {};
    for (const [idx, entry] of this.leaderMap) {
      leaderMapObj[idx] = entry.currentLeader;
    }

    const failoverChainObj: Record<number, string[]> = {};
    for (const [idx, chain] of this.config.failoverChain) {
      failoverChainObj[idx] = [...chain];
    }

    return {
      version: 1,
      createdAt: Date.now(),
      trigger,
      partitionStates,
      leaderMap: leaderMapObj,
      partitionNodeStats,
      leviathanConfig: {
        partitionCount: this.config.partitionCount,
        primaryPartition: this.config.primaryPartition,
        failoverChain: failoverChainObj,
      },
    };
  }

  restoreFromCheckpoint(checkpoint: LeviathanCheckpoint): void {
    for (const [idxStr, state] of Object.entries(checkpoint.partitionStates)) {
      const idx = Number(idxStr);
      const seq = this.partitionSequencers.get(idx);
      if (seq) {
        seq.restoreState(state);
      }
    }

    for (const [idxStr, stats] of Object.entries(checkpoint.partitionNodeStats)) {
      const idx = Number(idxStr);
      this.partitionProofs.set(idx, stats.totalProofsAccepted);
      this.partitionBatches.set(idx, stats.totalBatchesBuilt);
      this.partitionSettled.set(idx, stats.totalBatchesSettled);
      this.partitionFailed.set(idx, stats.totalBatchesFailed);
    }

    for (const [idxStr, leaderId] of Object.entries(checkpoint.leaderMap)) {
      const idx = Number(idxStr);
      const entry = this.leaderMap.get(idx);
      if (entry) {
        entry.currentLeader = leaderId;
        entry.isLocalLeader = (leaderId === this.nodeId);
        entry.lastHeartbeatAt = Date.now();
      }
    }
  }

  static fromCheckpoint(
    checkpoint: LeviathanCheckpoint,
    store: ILocalStore,
    options?: Partial<L2NodeOptions>,
  ): L2Leviathan {
    const cfg = checkpoint.leviathanConfig;
    const failoverChain = new Map<number, string[]>();
    for (const [idxStr, chain] of Object.entries(cfg.failoverChain)) {
      failoverChain.set(Number(idxStr), chain);
    }

    // Get initial roots from partition 0 state (arbitrary — will be overwritten by restoreState)
    const p0State = checkpoint.partitionStates[0] ?? checkpoint.partitionStates[cfg.primaryPartition];
    const regRoot = Field(BigInt(p0State?.currentRegistryRoot ?? '0'));
    const lcRoot = Field(BigInt(p0State?.currentLifecycleRoot ?? '0'));
    const wc = Field(BigInt(p0State?.currentWalletCount ?? '0'));

    const config: LeviathanConfig = {
      partitionCount: cfg.partitionCount,
      primaryPartition: cfg.primaryPartition,
      failoverChain,
      heartbeatIntervalMs: DEFAULT_HEARTBEAT_INTERVAL_MS,
      heartbeatTimeoutMs: DEFAULT_HEARTBEAT_TIMEOUT_MS,
    };

    const lev = new L2Leviathan(config, options ?? {}, store, regRoot, lcRoot, wc);
    lev.restoreFromCheckpoint(checkpoint);
    return lev;
  }

  // ─── WAL Recovery ──────────────────────────────────────

  /**
   * Recover all partitions from uncommitted WAL entries.
   * Called after restoreFromCheckpoint() to replay any accepted
   * proofs that weren't checkpointed.
   *
   * @returns Total number of entries replayed across all partitions
   */
  async recoverFromWal(): Promise<number> {
    let totalReplayed = 0;
    for (const seq of this.partitionSequencers.values()) {
      totalReplayed += await seq.recoverFromWal();
    }
    return totalReplayed;
  }

  // ─── Quorum Status ────────────────────────────────────

  /** Get quorum protocol status */
  getQuorumStatus(): {
    enabled: boolean;
    publicKeyHex?: string;
    quorumThreshold?: number;
    pendingProposals?: number;
    knownPeerKeys: number;
    stateCertificates?: number;
    quorumTimeoutMs?: number;
  } {
    if (!this.quorumService) {
      return { enabled: false, knownPeerKeys: this.peerPublicKeys.size };
    }
    const status = this.quorumService.getStatus();
    return {
      enabled: true,
      publicKeyHex: this.quorumKeyAuthority?.publicKeyHex,
      quorumThreshold: status.quorumThreshold,
      pendingProposals: status.pendingProposals,
      knownPeerKeys: status.knownPeers,
      stateCertificates: status.stateCertificateCount,
      quorumTimeoutMs: status.quorumTimeoutMs,
    };
  }

  /** Get the latest state certificate for a partition */
  getLatestStateCertificate(partitionIndex: number): StateCertificate | undefined {
    return this.quorumService?.getLatestStateCertificate(partitionIndex);
  }
}
