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
 * L2Node — Fully functional L2 chain node for zkpCare.
 *
 * Wraps L2SequencerService with:
 *   - Lifecycle management (start/stop)
 *   - Automatic batch timer (setTimeout-based, no overlap)
 *   - Settlement simulation (production: CareContract.settleBatch on MINA L1)
 *   - Event system for chain observability
 *   - Chain status queries
 *
 * Future L1 integration:
 *   Replace settleBatch() internals with real MINA L1 transaction submission.
 *   The hook is clearly marked — everything else stays the same.
 *
 * Run:
 *   const node = new L2Node(options, store, regRoot, lcRoot, walletCount);
 *   node.start();
 *   await node.submitProof(stateTransitionProof);
 *   // ... batch timer fires automatically, builds batch, settles ...
 *   await node.stop();
 */
import { Field } from 'o1js';
import type { ILocalStore } from '../storage/local-store.js';
import type { StateTransitionProof } from '../engine/state-transition.js';
import { L2SequencerService } from './l2-sequencer-service.js';
import { RequestRefused } from './request-refused.js';
import type { AdminStateConfig } from './l2-sequencer-service.js';
import type { L2Receipt, L2Batch, L1Status, ClaimSubmissionMetadata } from './l2-types.js';
import type { ClaimAccumulatorEntry } from './claim-accumulator-types.js';
import {
  L2CheckpointStore,
  CHECKPOINT_VERSION,
} from './l2-checkpoint.js';
import type {
  L2Checkpoint,
  L2CheckpointTrigger,
  L2SequencerState,
} from './l2-checkpoint.js';
import { L2PeerNetwork, generateMessageId } from './l2-peer-network.js';
import type { PartitionConfig } from './l2-partition.js';
import { PartitionRouter } from './l2-partition.js';
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
import type { ProvingPool } from './l2-proving-pool.js';

// ─── Settlement Strategy ─────────────────────────────────

/**
 * SettlementStrategy — pluggable L1 settlement hook.
 *
 * Called by L2Node after a batch is built. Must submit the batch
 * to L1 and return the L1 transaction hash.
 *
 * Built-in strategies:
 *   - undefined (default): simulated settlement (fake tx hash)
 *   - localBlockchainSettlement(): real CareContract.settleBatch on LocalBlockchain
 *
 * Custom strategies can target testnet, mainnet, or any other L1.
 */
export type SettlementStrategy = (batch: L2Batch) => Promise<string>;

// ─── Options ─────────────────────────────────────────────

/** Configuration for the L2 node */
export interface L2NodeOptions {
  /** Batch interval in ms. Default 30_000 (30s) for local testing, 180_000 (3 min) for production */
  batchIntervalMs: number;
  /** If true, automatically simulates L1 settlement after each batch */
  autoSettle: boolean;
  /** Delay in ms before marking batch as settled (simulates L1 confirmation time) */
  settlementDelayMs: number;
  /** Maximum retries for failed batch settlements */
  maxBatchRetries: number;
  /** Optional settlement strategy. When set, replaces the default simulation. */
  settlementStrategy?: SettlementStrategy;
  /** Node role: 'sequencer' (default) or 'replica'. Replicas forward proofs and apply gossip. */
  role?: L2NodeRole;
  /** Unique node identifier. Default: auto-generated. */
  nodeId?: string;
  /** Initial peer URLs to connect to on startup. Default: [] (standalone). */
  seedPeers?: string[];
  /** Maximum concurrent peer connections. Default: 12. */
  maxPeers?: number;
  /**
   * L2-only mode: no MINA L1 settlement.
   *
   * When true, batches are finalized immediately after building (no L1 tx).
   * Settlement strategy is ignored. autoSettle means "auto-finalize after build".
   * syncFromL1() throws. All audit/batch/proof logic still applies.
   */
  l2Only?: boolean;
  /** Partition config for multi-sequencer deployment. When set, rejects proofs for wrong partition. */
  partitionConfig?: PartitionConfig;
  /** Partition router for forwarding proofs to the correct sequencer. */
  partitionRouter?: PartitionRouter;
  /** Bearer token for admin RPC methods. Passed to peer L2Client instances for authenticated calls. */
  adminToken?: string;
  /** Shared secret for HMAC-SHA256 gossip authentication between peers. */
  gossipSecret?: string;
  /** When true, replicas verify BatchProof from gossip before applying state.
   *  Requires BatchProgram compilation at startup (~3-5 min, ~800MB).
   *  Batches received before compilation completes are applied unverified. Default: false. */
  verifyGossipBatches?: boolean;
}

/** Default options */
export const DEFAULT_L2_NODE_OPTIONS: L2NodeOptions = {
  batchIntervalMs: 30_000,
  autoSettle: true,
  settlementDelayMs: 1_000,
  maxBatchRetries: 3,
};

// ─── Events ──────────────────────────────────────────────

/** All event types emitted by the L2 node */
export type L2EventType =
  | 'node:started'
  | 'node:stopped'
  | 'node:tick'
  | 'proof:accepted'
  | 'proof:rejected'
  | 'batch:building'
  | 'batch:built'
  | 'batch:empty'
  | 'batch:settling'
  | 'batch:settled'
  | 'batch:failed'
  | 'audit:event'
  | 'formulary:updated'
  | 'plan:updated'
  | 'plan:deleted'
  | 'network:updated'
  | 'pool:worker:spawned'
  | 'pool:worker:compiling'
  | 'pool:worker:ready'
  | 'pool:worker:compile_timeout'
  | 'pool:worker:compile_failed'
  | 'pool:worker:dispatched'
  | 'pool:worker:completed'
  | 'pool:worker:crashed'
  | 'leader:promoted'
  | 'leader:demoted'
  | 'employer:registered'
  | 'employer:revoked'
  | 'employer:node-registered'
  | 'employer:node-deregistered'
  | 'batch:rejected'
  | 'node:error';

/** Chain event with typed data payload */
export interface L2ChainEvent {
  type: L2EventType;
  timestamp: number;
  data: Record<string, unknown>;
}

/** Handler function for chain events */
export type L2EventHandler = (event: L2ChainEvent) => void;

// ─── Status ──────────────────────────────────────────────

/** Snapshot of the L2 node's current state */
export interface L2NodeStatus {
  running: boolean;
  uptimeMs: number;
  pendingProofs: number;
  totalProofsAccepted: number;
  totalBatchesBuilt: number;
  totalBatchesSettled: number;
  totalBatchesFailed: number;
  currentRegistryRoot: string;
  currentLifecycleRoot: string;
  currentWalletCount: string;
  inFlightBatch: bigint | null;
  nextBatchInMs: number;
  batchIntervalMs: number;
  chainProofEnabled: boolean;
  globalStateRoot: string;
  blockHeight: string;
  /** Whether this node operates in L2-only mode (no L1 settlement) */
  l2Only: boolean;
}

// ─── L2Node ──────────────────────────────────────────────

export class L2Node {
  private sequencer: L2SequencerService;
  private options: L2NodeOptions;

  // Lifecycle
  private running = false;
  private startedAt = 0;
  private batchTimer: ReturnType<typeof setTimeout> | null = null;
  private batchInProgress = false;
  private lastBatchTickAt = 0;
  private stopResolve: (() => void) | null = null;

  // Stats
  private totalProofsAccepted = 0;
  private totalBatchesBuilt = 0;
  private totalBatchesSettled = 0;
  private totalBatchesFailed = 0;
  private nextSettlementId = 1;

  // Event handlers
  private handlers: L2EventHandler[] = [];

  // Checkpoint
  private checkpointStore: L2CheckpointStore | null = null;
  private autoCheckpoint = true;
  private maxCheckpoints = 5;

  // Proving mutex — o1js requires serial ZkProgram proving (single global context)
  private _provingLockQueue: Promise<void> = Promise.resolve();

  // Proving pool — optional worker fleet for parallel batch proving
  private provingPool: ProvingPool | null = null;

  // NFC credential attestation authority (Ed25519 signing)
  private attestationAuthority: import('../credentials/nfc-attestation.js').SequencerAttestationAuthority | null = null;
  private attestationCache = new Map<string, import('../credentials/nfc-attestation.js').NfcCredentialAttestation>();

  /** Known wallets registered via entity registry (fed by RPC server) */
  knownWallets: Set<string> | null = null;

  /** Admin registry state provider for checkpoint persistence */
  private adminRegistryProvider: (() => { keys: Array<{ nodeId: string; publicKeyHex: string; admittedBy: string; reason: string; timestamp: number }>; blacklist: string[] }) | null = null;

  /** Set the admin registry state provider (called by start-leviathan.ts to wire RPC server registry into checkpoints) */
  setAdminRegistryProvider(fn: () => { keys: Array<{ nodeId: string; publicKeyHex: string; admittedBy: string; reason: string; timestamp: number }>; blacklist: string[] }): void {
    this.adminRegistryProvider = fn;
  }

  /** Register a wallet as known to the network (called by RPC server on l2_registerEntity) */
  registerKnownWallet(walletId: string): void {
    if (!this.knownWallets) this.knownWallets = new Set();
    this.knownWallets.add(walletId);
  }

  // Gossip batch verification (opt-in for replicas)
  private batchVerificationKey: string | null = null;
  private batchVerificationEnabled = false;

  // Peer network
  private peerNetwork: L2PeerNetwork | null = null;
  private nodeId: string;
  private role: L2NodeRole;

  constructor(
    options: Partial<L2NodeOptions>,
    store: ILocalStore,
    initialRegistryRoot: Field,
    initialLifecycleRoot: Field,
    initialWalletCount: Field,
  ) {
    this.options = { ...DEFAULT_L2_NODE_OPTIONS, ...options };
    this.nodeId = options.nodeId ?? `node-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    this.role = options.role ?? 'sequencer';
    this.sequencer = new L2SequencerService(
      store,
      initialRegistryRoot,
      initialLifecycleRoot,
      initialWalletCount,
      this.options.batchIntervalMs,
      this.options.l2Only ?? false,
    );

    // Configure partition if provided
    if (this.options.partitionConfig) {
      this.sequencer.setPartitionConfig(this.options.partitionConfig);
    }
  }

  // ─── Gossip Batch Verification ───────────────────────────

  /**
   * Compile BatchProgram for gossip verification (replicas only).
   * After calling this, the replica will verify BatchProof from gossip
   * before applying state changes. Takes ~3-5 min for compilation.
   */
  async enableBatchVerification(): Promise<void> {
    const { BatchProgram } = await import('./batch-program.js');
    const result = await BatchProgram.compile();
    this.batchVerificationKey = result.verificationKey.data;
    this.batchVerificationEnabled = true;
  }

  /** Whether gossip batch verification is active */
  isBatchVerificationEnabled(): boolean {
    return this.batchVerificationEnabled;
  }

  // ─── Proving Pool ──────────────────────────────────────

  /**
   * Attach a proving pool for parallel batch proving.
   * When set, executeBatchCycle() dispatches proving to the pool
   * instead of using the single-process proving lock.
   */
  setProvingPool(pool: ProvingPool): void {
    this.provingPool = pool;

    // Forward pool lifecycle events as L2ChainEvents
    pool.on((event) => {
      this.emit({
        type: `pool:${event.type}` as L2EventType,
        timestamp: event.timestamp,
        data: { workerId: event.workerId, ...event.data },
      });
    });
  }

  /** Get the attached proving pool (if any). */
  getProvingPool(): ProvingPool | null {
    return this.provingPool;
  }

  // ─── NFC Attestation ─────────────────────────────────────

  /** Enable NFC credential attestation signing. Called once at startup. */
  async enableAttestations(seed?: string): Promise<void> {
    const { SequencerAttestationAuthority } = await import('../credentials/nfc-attestation.js');
    this.attestationAuthority = seed
      ? new SequencerAttestationAuthority(Buffer.from(seed, 'hex'))
      : new SequencerAttestationAuthority();
  }

  /** Request a signed NFC attestation for a registered wallet. */
  requestAttestation(walletId: string, expirySeconds?: number): import('../credentials/nfc-attestation.js').NfcCredentialAttestation | null {
    if (!this.attestationAuthority) return null;

    // Get current chain state for the attestation fields
    const registryRoot = this.sequencer.getCurrentRegistryRoot().toString();
    const globalStateRoot = this.sequencer.getCurrentGlobalStateRoot().toString();
    // A10b: the ledger decides. The wallet must hold a registration here, put there by its own
    // proof, and the attestation states the lifecycle its leaf holds; a revoked wallet is refused
    // and an unregistered one gets nothing. The RPC gate has already checked that the caller
    // signed as this wallet.
    const lifecycle = this.sequencer.lifecycleStateOf(walletId);
    if (!lifecycle) return null;
    if (lifecycle.name === 'revoked') throw new RequestRefused('Attestation refused — the ledger shows this wallet revoked');

    const att = this.attestationAuthority.createAttestation({
      walletId,
      credentialCommitment: registryRoot, // Best available commitment
      lifecycleState: lifecycle.state,
      forestRoot: globalStateRoot || registryRoot,
      expirySeconds,
    });

    this.attestationCache.set(walletId, att);
    return att;
  }

  /** Get cached attestation for a wallet (if one exists). */
  getAttestation(walletId: string): import('../credentials/nfc-attestation.js').NfcCredentialAttestation | null {
    return this.attestationCache.get(walletId) ?? null;
  }

  /** Get the sequencer's Ed25519 public key hex string. */
  getAttestationPublicKey(): string | null {
    return this.attestationAuthority?.publicKeyHex ?? null;
  }

  // ─── Lifecycle ──────────────────────────────────────────

  /** Start the L2 node — begins the batch timer and connects to peers */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.startedAt = Date.now();
    this.lastBatchTickAt = Date.now();

    this.emit({
      type: 'node:started',
      timestamp: Date.now(),
      data: {
        batchIntervalMs: this.options.batchIntervalMs,
        autoSettle: this.options.autoSettle,
        role: this.role,
        nodeId: this.nodeId,
      },
    });

    // Only sequencers run the batch timer — replicas receive batches via gossip
    if (this.role === 'sequencer') {
      this.scheduleBatchTick();
    }

    // Connect to seed peers (fire-and-forget)
    if (this.options.seedPeers && this.options.seedPeers.length > 0) {
      this.initPeerNetwork().catch(() => {});
    }

    // Compile BatchProgram for gossip verification (replicas only, background)
    if (this.role === 'replica' && this.options.verifyGossipBatches) {
      this.enableBatchVerification().catch((err) => {
        this.emit({
          type: 'node:error',
          timestamp: Date.now(),
          data: { error: `BatchProgram compilation failed: ${err instanceof Error ? err.message : String(err)}` },
        });
      });
    }
  }

  /**
   * Stop the L2 node gracefully.
   * Waits for any in-progress batch to complete before resolving.
   */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    if (this.batchTimer !== null) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }

    // If a batch is in progress, wait for it to complete
    if (this.batchInProgress) {
      await new Promise<void>((resolve) => {
        this.stopResolve = resolve;
      });
    }

    // Disconnect peer network
    if (this.peerNetwork) {
      this.peerNetwork.stop();
      this.peerNetwork = null;
    }

    // Shutdown proving pool workers
    if (this.provingPool) {
      await this.provingPool.shutdown();
    }

    // Save shutdown checkpoint
    if (this.checkpointStore) {
      await this.saveCheckpoint('shutdown');
    }

    this.emit({
      type: 'node:stopped',
      timestamp: Date.now(),
      data: {
        uptimeMs: Date.now() - this.startedAt,
        totalProofs: this.totalProofsAccepted,
        totalBatches: this.totalBatchesBuilt,
      },
    });
  }

  /** Whether the node is currently running */
  isRunning(): boolean {
    return this.running;
  }

  // ─── Core API ───────────────────────────────────────────

  /**
   * Submit a StateTransitionProof to the L2 chain.
   * Returns an L2Receipt (instant confirmation) if the proof is valid.
   *
   * @param metadata — optional claim context for drug history tracking
   */
  async submitProof(proof: StateTransitionProof, metadata?: ClaimSubmissionMetadata): Promise<L2Receipt> {
    try {
      const receipt = await this.sequencer.submitProof(proof, metadata);
      this.totalProofsAccepted++;

      this.emit({
        type: 'proof:accepted',
        timestamp: Date.now(),
        data: {
          receiptId: receipt.receiptId,
          walletId: receipt.walletId,
          isRegistration: receipt.isRegistration,
          sequenceNumber: receipt.sequenceNumber.toString(),
          pendingCount: this.sequencer.getPendingCount(),
        },
      });

      // Eager batch: if proving pool has idle workers and no batch in progress,
      // trigger an immediate batch cycle instead of waiting for the timer.
      if (this.provingPool && this.provingPool.isRunning() && !this.batchInProgress) {
        const poolStatus = this.provingPool.getStatus();
        if (poolStatus.workersIdle > 0) {
          // Fire-and-forget — don't block submitProof on batch building
          this.executeBatchCycle().catch(() => {});
        }
      }

      // Sequencer: broadcast proof:accepted gossip to peers
      if (this.role === 'sequencer' && this.peerNetwork) {
        const auditLog = this.sequencer.getAuditLog();
        const latestAuditEvent = auditLog.events[auditLog.events.length - 1];
        const claimEntry = metadata
          ? this.sequencer.getClaimsByMember(receipt.walletId).slice(-1)[0]
          : undefined;

        const payload: ProofAcceptedPayload = {
          receipt,
          auditEvent: latestAuditEvent,
          claimEntry,
          currentRegistryRoot: this.sequencer.getCurrentRegistryRoot().toString(),
          currentLifecycleRoot: this.sequencer.getCurrentLifecycleRoot().toString(),
          currentWalletCount: this.sequencer.getCurrentWalletCount().toString(),
        };

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
        },
      });
      throw err;
    }
  }

  /**
   * Manually trigger a batch build (bypasses the timer).
   * Useful for testing or when you want immediate batching.
   */
  async forceBatch(): Promise<L2Batch | null> {
    return this.executeBatchCycle();
  }

  /**
   * Build a batch using the proving pool if available, falling back to
   * single-process proving. Unlike forceBatch(), this does NOT check
   * batchInProgress — the caller must hold the proving lock or otherwise
   * guarantee serial access.
   *
   * Designed for enrollment flows that call buildBatch() mid-ceremony
   * while holding the proving lock.
   */
  async buildBatchDirect(): Promise<L2Batch | null> {
    if (this.provingPool) {
      return this.executeBatchWithPool();
    }
    return this.sequencer.buildBatch();
  }

  /** Number of pending (unbatched) transitions in the sequencer queue. */
  getPendingCount(): number {
    return this.sequencer.getPendingCount();
  }

  /**
   * Pause the automatic batch timer.
   * Use when an external controller (e.g. auto-mode) manages batch timing.
   */
  pauseBatchTimer(): void {
    if (this.batchTimer !== null) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
  }

  /**
   * Resume the automatic batch timer after a pause.
   */
  resumeBatchTimer(): void {
    if (this.running && this.batchTimer === null) {
      this.scheduleBatchTick();
    }
  }

  /**
   * Emit a messaging audit event into the L2 Poseidon hash chain.
   *
   * Delegates to the sequencer's emitMessagingAuditEvent, then emits
   * an 'audit:event' chain event with type: 'messaging' for observers.
   */
  emitMessagingAuditEvent(
    senderWalletId: string,
    messagingRootBefore: string,
    messagingRootAfter: string,
  ): { chainHash: string; sequenceNumber: bigint } {
    const result = this.sequencer.emitMessagingAuditEvent(
      senderWalletId,
      messagingRootBefore,
      messagingRootAfter,
    );

    this.emit({
      type: 'audit:event',
      timestamp: Date.now(),
      data: {
        type: 'messaging',
        senderWalletId,
        messagingRootBefore,
        messagingRootAfter,
        chainHash: result.chainHash,
        sequenceNumber: result.sequenceNumber.toString(),
      },
    });

    return result;
  }

  // ─── Message Store ─────────────────────────────────────────

  /**
   * Store an encrypted message and broadcast via gossip.
   *
   * Delegates to the sequencer's storeMessage(), then broadcasts
   * a `message:stored` gossip message so replicas replicate the entry.
   */
  storeMessage(message: StoredMessage, payload: MessagePayload): MessageStoreEntry {
    const entry = this.sequencer.storeMessage(message, payload);

    // Broadcast message:stored gossip to peers
    if (this.role === 'sequencer' && this.peerNetwork) {
      const gossipPayload: MessageStoredPayload = {
        leafIndex: entry.leafIndex,
        message,
        payload,
        leafHash: entry.leafHash,
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
   * Store a benefit plan and broadcast via gossip.
   * Delegates to the sequencer's storePlanWithWal(), then broadcasts
   * a `plan:updated` gossip message so replicas replicate the entry.
   */
  async storePlan(plan: BenefitPlanConfig): Promise<void> {
    await this.sequencer.storePlanWithWal(plan);

    if (this.role === 'sequencer' && this.peerNetwork) {
      const gossipMsg: GossipMessage = {
        messageId: generateMessageId('plan:updated', this.nodeId, Date.now(), plan.planId),
        type: 'plan:updated',
        senderId: this.nodeId,
        timestamp: Date.now(),
        payload: { plan } as PlanUpdatedPayload,
      };
      this.peerNetwork.broadcast(gossipMsg).catch(() => {});
    }
  }

  /**
   * Delete a benefit plan and broadcast via gossip.
   */
  async deletePlan(planId: string): Promise<boolean> {
    const deleted = await this.sequencer.deletePlanWithWal(planId);
    if (!deleted) return false;

    if (this.role === 'sequencer' && this.peerNetwork) {
      const gossipMsg: GossipMessage = {
        messageId: generateMessageId('plan:deleted', this.nodeId, Date.now(), planId),
        type: 'plan:deleted',
        senderId: this.nodeId,
        timestamp: Date.now(),
        payload: { planId } as PlanDeletedPayload,
      };
      this.peerNetwork.broadcast(gossipMsg).catch(() => {});
    }
    return true;
  }

  /**
   * Store a formulary and broadcast via gossip.
   * Wraps sequencer.storeFormulary() with gossip replication.
   */
  storeFormularyWithGossip(planIdHash: string, formularyRoot: string, entriesJson: string): void {
    this.sequencer.storeFormulary(planIdHash, formularyRoot, entriesJson);

    if (this.role === 'sequencer' && this.peerNetwork) {
      const gossipMsg: GossipMessage = {
        messageId: generateMessageId('formulary:updated', this.nodeId, Date.now(), planIdHash),
        type: 'formulary:updated',
        senderId: this.nodeId,
        timestamp: Date.now(),
        payload: { planIdHash, formularyRoot, entriesJson } as FormularyUpdatedPayload,
      };
      this.peerNetwork.broadcast(gossipMsg).catch(() => {});
    }
  }

  // ─── Events ─────────────────────────────────────────────

  /** Subscribe to all chain events */
  on(handler: L2EventHandler): void {
    this.handlers.push(handler);
  }

  /** Unsubscribe from chain events */
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

  // ─── Status ─────────────────────────────────────────────

  /** Get a snapshot of the node's current state */
  getStatus(): L2NodeStatus {
    const now = Date.now();
    const elapsed = now - this.lastBatchTickAt;
    const nextBatchIn = Math.max(0, this.options.batchIntervalMs - elapsed);

    return {
      running: this.running,
      uptimeMs: this.running ? now - this.startedAt : 0,
      pendingProofs: this.sequencer.getPendingCount(),
      totalProofsAccepted: this.totalProofsAccepted,
      totalBatchesBuilt: this.totalBatchesBuilt,
      totalBatchesSettled: this.totalBatchesSettled,
      totalBatchesFailed: this.totalBatchesFailed,
      currentRegistryRoot: this.sequencer.getCurrentRegistryRoot().toString(),
      currentLifecycleRoot: this.sequencer.getCurrentLifecycleRoot().toString(),
      currentWalletCount: this.sequencer.getCurrentWalletCount().toString(),
      inFlightBatch: this.sequencer.getInFlightBatchNumber(),
      nextBatchInMs: nextBatchIn,
      batchIntervalMs: this.options.batchIntervalMs,
      chainProofEnabled: this.sequencer.isChainProofEnabled(),
      globalStateRoot: this.sequencer.getCurrentGlobalStateRoot().toString(),
      blockHeight: this.sequencer.getCurrentBlockHeight().toString(),
      l2Only: this.options.l2Only ?? false,
    };
  }

  /**
   * Enable ChainProgram integration by setting admin state.
   * Delegates to L2SequencerService.setAdminState().
   */
  setAdminState(config: AdminStateConfig): void {
    this.sequencer.setAdminState(config);
  }

  /** Whether the node is in L2-only mode (no L1 settlement) */
  isL2Only(): boolean {
    return this.options.l2Only ?? false;
  }

  /** Get the partition config for this node, or null if not partitioned */
  getPartitionConfig(): PartitionConfig | null {
    return this.sequencer.getPartitionConfig();
  }

  /** Get the partition router for forwarding proofs, or null if not configured */
  getPartitionRouter(): PartitionRouter | null {
    return this.options.partitionRouter ?? null;
  }

  /** Direct access to the underlying sequencer for advanced queries */
  getSequencer(): L2SequencerService {
    return this.sequencer;
  }

  // ─── Claim Accumulator Queries ────────────────────────────

  /** Current Merkle root of the Claim Accumulator Tree */
  getClaimAccumulatorRoot(): string {
    return this.sequencer.getClaimAccumulatorRoot();
  }

  /** Number of claims in the accumulator */
  getClaimLeafCount(): bigint {
    return this.sequencer.getClaimLeafCount();
  }

  /** All claims for a member wallet ID */
  getClaimsByMember(memberWalletId: string): ClaimAccumulatorEntry[] {
    return this.sequencer.getClaimsByMember(memberWalletId);
  }

  /** All claims for a pharmacy wallet ID */
  getClaimsByPharmacy(pharmacyWalletId: string): ClaimAccumulatorEntry[] {
    return this.sequencer.getClaimsByPharmacy(pharmacyWalletId);
  }

  /** All claims for a prescriber wallet ID */
  getClaimsByPrescriber(prescriberWalletId: string): ClaimAccumulatorEntry[] {
    return this.sequencer.getClaimsByPrescriber(prescriberWalletId);
  }

  /** All claims for an NDC hash */
  getClaimsByNdc(ndcHash: string): ClaimAccumulatorEntry[] {
    return this.sequencer.getClaimsByNdc(ndcHash);
  }

  /** Get a claim with its Merkle inclusion proof */
  getClaimWithProof(leafIndex: bigint): {
    entry: ClaimAccumulatorEntry;
    witnessJson: string;
    root: string;
  } | undefined {
    return this.sequencer.getClaimWithProof(leafIndex);
  }

  /** Record a fill directly on the claim accumulator (admin path) */
  recordFill(
    leaf: import('./claim-accumulator-types.js').ClaimLeaf,
    metadata: import('./claim-accumulator-types.js').ClaimMetadata,
  ): ClaimAccumulatorEntry {
    return this.sequencer.recordFill(leaf, metadata);
  }

  /**
   * H4 fix: Sync L2 state from L1 after a direct L1 settlement
   * (settleTransition fallback or admin op that changed on-chain roots).
   *
   * Delegates to sequencer.syncFromL1() and emits an event.
   */
  syncFromL1(newRegistryRoot: Field, newLifecycleRoot: Field, newWalletCount: Field): void {
    if (this.options.l2Only) {
      throw new Error('L2-only mode: no L1 sync available');
    }
    this.sequencer.syncFromL1(newRegistryRoot, newLifecycleRoot, newWalletCount);
    this.emit({
      type: 'node:started', // Reuse existing event type for L1 sync notification
      timestamp: Date.now(),
      data: {
        action: 'l1_sync',
        registryRoot: newRegistryRoot.toString(),
        lifecycleRoot: newLifecycleRoot.toString(),
        walletCount: newWalletCount.toString(),
      },
    });
  }

  // ─── Peer Network ──────────────────────────────────────

  /** Get this node's unique identifier */
  getNodeId(): string {
    return this.nodeId;
  }

  /** Get this node's role */
  getRole(): L2NodeRole {
    return this.role;
  }

  /** Get the peer network instance (null if no peers configured) */
  getPeerNetwork(): L2PeerNetwork | null {
    return this.peerNetwork;
  }

  /**
   * Initialize the peer network: create it, connect to seeds, subscribe to gossip.
   * Called during start() when seedPeers are configured.
   */
  private async initPeerNetwork(): Promise<void> {
    const config = {
      nodeId: this.nodeId,
      role: this.role,
      seedPeers: this.options.seedPeers ?? [],
      maxPeers: this.options.maxPeers ?? 12,
      gossipRelayEnabled: true,
      announceIntervalMs: 60_000,
      syncOnConnect: true,
      ...(this.options.gossipSecret ? { gossipSecret: this.options.gossipSecret } : {}),
      ...(this.options.adminToken ? { adminToken: this.options.adminToken } : {}),
    };

    this.peerNetwork = new L2PeerNetwork(config);

    // Subscribe to gossip messages (replicas apply state, sequencers ignore their own)
    this.peerNetwork.on((msg: GossipMessage) => {
      this.handleGossip(msg).catch(() => {});
    });

    this.peerNetwork.start();

    // Connect to seed peers
    for (const url of config.seedPeers) {
      try {
        await this.peerNetwork.connectToPeer(url);
      } catch {
        // Seed unreachable — will retry on next announce cycle
      }
    }
  }

  /**
   * Handle an incoming gossip message.
   *
   * Replicas apply state changes from the sequencer.
   * Sequencers ignore their own broadcasts (already applied locally).
   */
  private async handleGossip(msg: GossipMessage): Promise<void> {
    // Don't process our own messages
    if (msg.senderId === this.nodeId) return;

    switch (msg.type) {
      case 'proof:accepted': {
        if (this.role !== 'replica') return;
        const payload = msg.payload as ProofAcceptedPayload;
        this.sequencer.applyReplicatedReceipt(
          payload.receipt,
          payload.auditEvent,
          payload.claimEntry,
          payload.currentRegistryRoot,
          payload.currentLifecycleRoot,
          payload.currentWalletCount,
        );
        this.totalProofsAccepted++;
        this.emit({
          type: 'proof:accepted',
          timestamp: Date.now(),
          data: {
            receiptId: payload.receipt.receiptId,
            walletId: payload.receipt.walletId,
            isRegistration: payload.receipt.isRegistration,
            sequenceNumber: payload.receipt.sequenceNumber.toString(),
            source: 'gossip',
          },
        });
        break;
      }

      case 'batch:built': {
        if (this.role !== 'replica') return;
        const payload = msg.payload as BatchBuiltPayload;

        if (this.batchVerificationEnabled && payload.batch.batchProofJson) {
          try {
            const { BatchProof } = await import('./batch-program.js');
            const batchProof = await BatchProof.fromJSON(JSON.parse(payload.batch.batchProofJson));
            await batchProof.verify();
          } catch (err) {
            this.emit({
              type: 'batch:rejected',
              timestamp: Date.now(),
              data: {
                batchNumber: payload.batch.batchNumber.toString(),
                reason: `BatchProof verification failed: ${err instanceof Error ? err.message : String(err)}`,
                source: 'gossip',
              },
            });
            return;
          }
        }

        this.sequencer.applyReplicatedBatch(
          payload.batch,
          payload.block,
          payload.updatedReceipts,
          payload.updatedAuditEvents,
        );
        this.totalBatchesBuilt++;
        this.emit({
          type: 'batch:built',
          timestamp: Date.now(),
          data: {
            batchNumber: payload.batch.batchNumber.toString(),
            registrationCount: payload.batch.registrationCount,
            transitionCount: payload.batch.transitionCount,
            source: 'gossip',
          },
        });
        break;
      }

      case 'batch:settled': {
        if (this.role !== 'replica') return;
        const payload = msg.payload as BatchSettledPayload;
        this.sequencer.applyReplicatedSettlement(
          payload.batchNumber,
          payload.l1TxHash,
          payload.lastSettledRegistryRoot,
          payload.lastSettledLifecycleRoot,
          payload.lastSettledWalletCount,
        );
        this.totalBatchesSettled++;
        this.emit({
          type: 'batch:settled',
          timestamp: Date.now(),
          data: {
            batchNumber: payload.batchNumber.toString(),
            l1TxHash: payload.l1TxHash,
            source: 'gossip',
          },
        });
        break;
      }

      case 'batch:failed': {
        if (this.role !== 'replica') return;
        const payload = msg.payload as BatchFailedPayload;
        this.sequencer.applyReplicatedBatchFailure(
          payload.batchNumber,
          payload.reason,
        );
        this.totalBatchesFailed++;
        this.emit({
          type: 'batch:failed',
          timestamp: Date.now(),
          data: {
            batchNumber: payload.batchNumber.toString(),
            reason: payload.reason,
            source: 'gossip',
          },
        });
        break;
      }

      case 'message:stored': {
        if (this.role !== 'replica') return;
        const payload = msg.payload as MessageStoredPayload;
        this.sequencer.applyReplicatedMessage(
          payload.leafIndex,
          payload.message,
          payload.payload,
        );
        break;
      }

      case 'plan:updated': {
        if (this.role !== 'replica') return;
        const planPayload = msg.payload as PlanUpdatedPayload;
        // WAL-durable path: survives replica crash without requiring checkpoint
        await this.sequencer.storePlanWithWal(planPayload.plan);
        break;
      }

      case 'plan:deleted': {
        if (this.role !== 'replica') return;
        const delPayload = msg.payload as PlanDeletedPayload;
        // WAL-durable path: survives replica crash without requiring checkpoint
        await this.sequencer.deletePlanWithWal(delPayload.planId);
        break;
      }

      case 'formulary:updated': {
        if (this.role !== 'replica') return;
        const formPayload = msg.payload as FormularyUpdatedPayload;
        this.sequencer.storeFormulary(formPayload.planIdHash, formPayload.formularyRoot, formPayload.entriesJson);
        break;
      }

      case 'admin:eviction': {
        const evictionPayload = msg.payload as import('./l2-peer-types.js').EvictionPayload;
        const evictedId = evictionPayload.evictedNodeId;
        if (this.peerNetwork && !this.peerNetwork.isPeerBanned(evictedId)) {
          this.peerNetwork.banPeer(evictedId);
          console.warn(`  [eviction] Peer ${evictedId} banned via gossip: ${evictionPayload.reason}`);
        }
        break;
      }

      // peer:announce and state:snapshot handled by L2PeerNetwork directly
      default:
        break;
    }
  }

  /**
   * Create a new L2Node by syncing state from a peer (Initial Block Download).
   *
   * Connects to the peer, downloads the full state snapshot, and creates
   * a node with that state. The node is NOT started — call node.start().
   *
   * Usage:
   *   const node = await L2Node.fromPeerSync('http://sequencer:3030', store);
   *   node.start(); // Begins receiving gossip
   */
  static async fromPeerSync(
    peerUrl: string,
    store: ILocalStore,
    options?: Partial<L2NodeOptions>,
  ): Promise<L2Node> {
    // Temporarily create a network to fetch state
    // Pass adminToken so the IBD snapshot request is authenticated
    const tempNetwork = new L2PeerNetwork({
      nodeId: 'ibd-temp',
      role: (options?.role ?? 'replica'),
      ...(options?.adminToken ? { adminToken: options.adminToken } : {}),
      ...(options?.gossipSecret ? { gossipSecret: options.gossipSecret } : {}),
    });
    const peerInfo = await tempNetwork.connectToPeer(peerUrl);
    const state = await tempNetwork.requestStateSync(peerInfo.peerId);
    tempNetwork.stop();

    // Create node from the downloaded state
    // Propagate l2Only from peer state if not explicitly set in options
    const mergedOptions: Partial<L2NodeOptions> = { ...(options ?? {}) };
    if (mergedOptions.l2Only === undefined && state.l2Only !== undefined) {
      mergedOptions.l2Only = state.l2Only;
    }
    const node = new L2Node(
      mergedOptions,
      store,
      Field(BigInt(state.currentRegistryRoot)),
      Field(BigInt(state.currentLifecycleRoot)),
      Field(BigInt(state.currentWalletCount)),
    );
    node.sequencer.restoreState(state);

    // Add the peer as a seed so start() will connect
    if (!node.options.seedPeers) {
      node.options.seedPeers = [];
    }
    if (!node.options.seedPeers.includes(peerUrl)) {
      node.options.seedPeers.push(peerUrl);
    }

    return node;
  }

  // ─── Internal: Batch Timer ──────────────────────────────

  /**
   * Schedule the next batch tick using setTimeout.
   * setTimeout (not setInterval) prevents overlap — the next tick
   * is only scheduled AFTER the previous batch completes.
   */
  private scheduleBatchTick(): void {
    if (!this.running) return;

    this.batchTimer = setTimeout(async () => {
      await this.onBatchTick();
      this.scheduleBatchTick(); // Re-arm after completion
    }, this.options.batchIntervalMs);
  }

  /** Called when the batch timer fires */
  private async onBatchTick(): Promise<void> {
    this.lastBatchTickAt = Date.now();

    this.emit({
      type: 'node:tick',
      timestamp: Date.now(),
      data: { pendingCount: this.sequencer.getPendingCount() },
    });

    await this.executeBatchCycle();
  }

  /**
   * Execute one batch cycle: build → settle.
   * Guards against concurrent execution with batchInProgress flag.
   */
  private async executeBatchCycle(): Promise<L2Batch | null> {
    if (this.batchInProgress) return null;

    const pendingCount = this.sequencer.getPendingCount();
    if (pendingCount === 0) {
      this.emit({
        type: 'batch:empty',
        timestamp: Date.now(),
        data: {},
      });
      return null;
    }

    this.batchInProgress = true;

    try {
      // Build batch
      this.emit({
        type: 'batch:building',
        timestamp: Date.now(),
        data: { pendingCount },
      });

      const buildStart = Date.now();
      let batch: L2Batch | null;

      if (this.provingPool) {
        // Pool path: prepareBatch → pool.prove → finalizeBatch
        if (!this.provingPool.isRunning()) {
          // Pool is configured but still compiling — skip this cycle
          this.batchInProgress = false;
          return null;
        }
        batch = await this.executeBatchWithPool();
      } else {
        // Legacy path: single-process proving with proving lock
        batch = await this.withProvingLock(() => this.sequencer.buildBatch());
      }

      if (!batch) {
        this.batchInProgress = false;
        return null;
      }

      this.totalBatchesBuilt++;

      this.emit({
        type: 'batch:built',
        timestamp: Date.now(),
        data: {
          batchNumber: batch.batchNumber.toString(),
          registrationCount: batch.registrationCount,
          transitionCount: batch.transitionCount,
          buildTimeMs: Date.now() - buildStart,
          oldRegistryRoot: batch.oldRegistryRoot,
          newRegistryRoot: batch.newRegistryRoot,
          ...(batch.workerId != null ? { workerId: batch.workerId } : {}),
          ...(batch.proveTimeMs != null ? { proveTimeMs: batch.proveTimeMs } : {}),
        },
      });

      // Memory watermark check — warn when RSS approaches GC storm threshold
      const rss = process.memoryUsage().rss;
      const rssGB = rss / (1024 * 1024 * 1024);
      if (rssGB > 4.0) {
        console.warn(`[L2Node] MEMORY WARNING: RSS=${rssGB.toFixed(2)}GB — approaching GC storm threshold`);
      }

      // Broadcast batch:built gossip to peers
      if (this.peerNetwork) {
        const blockNumber = batch.blockNumbers?.[0] ?? batch.batchNumber;
        const block = this.sequencer.getBlock(blockNumber);
        if (block) {
          const updatedReceipts = this.sequencer.getAllReceipts().filter(
            (r) => r.l1BatchNumber === batch.batchNumber,
          );
          const auditLog = this.sequencer.getAuditLog();
          const updatedAuditEvents = auditLog.events.filter(
            (e) => e.l1BatchNumber === batch.batchNumber,
          );

          const payload: BatchBuiltPayload = {
            batch,
            block,
            updatedReceipts,
            updatedAuditEvents,
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

      // Settle — in L2-only mode, batch is already finalized by the sequencer
      if (this.options.autoSettle && !this.options.l2Only) {
        await this.settleBatch(batch);
      } else if (this.options.l2Only) {
        // Emit settled event (batch was finalized during buildBatch)
        this.totalBatchesSettled++;
        this.emit({
          type: 'batch:settled',
          timestamp: Date.now(),
          data: {
            batchNumber: batch.batchNumber.toString(),
            l1TxHash: batch.l1TxHash ?? `l2-final-${batch.batchNumber}`,
            registrationCount: batch.registrationCount,
            transitionCount: batch.transitionCount,
            l2Only: true,
          },
        });

        // Broadcast batch:settled gossip so replicas clear inFlightBatchNumber
        if (this.peerNetwork) {
          const settledPayload: BatchSettledPayload = {
            batchNumber: batch.batchNumber,
            l1TxHash: batch.l1TxHash ?? `l2-final-${batch.batchNumber}`,
            lastSettledRegistryRoot: this.sequencer.getLastSettledRegistryRoot().toString(),
            lastSettledLifecycleRoot: this.sequencer.getLastSettledLifecycleRoot().toString(),
            lastSettledWalletCount: this.sequencer.getLastSettledWalletCount().toString(),
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

        // Auto-checkpoint after each L2-only settlement
        if (this.checkpointStore && this.autoCheckpoint) {
          await this.saveCheckpoint('batch_settled');
        }
      }

      return batch;
    } catch (err) {
      this.emit({
        type: 'batch:failed',
        timestamp: Date.now(),
        data: {
          reason: err instanceof Error ? err.message : String(err),
        },
      });
      this.totalBatchesFailed++;
      return null;
    } finally {
      this.batchInProgress = false;

      // If stop() is waiting for us, resolve it
      if (this.stopResolve) {
        this.stopResolve();
        this.stopResolve = null;
      }
    }
  }

  // ─── Internal: Settlement ───────────────────────────────

  /**
   * Settle a batch — marks it as settled on L1.
   *
   * SIMULATION MODE (current):
   *   Generates a simulated L1 tx hash and marks the batch settled.
   *
   * PRODUCTION MODE (future MINA L1 integration):
   *   Replace this method's body with:
   *     const batchProof = BatchProof.fromJSON(batch.batchProofJson);
   *     const tx = await Mina.transaction(feePayer, async () => {
   *       await careContract.settleBatch(batchProof);
   *     });
   *     await tx.prove();
   *     await tx.sign([feePayerKey]).send();
   *     this.sequencer.markBatchSettled(batch.batchNumber, tx.hash);
   */
  private async settleBatch(batch: L2Batch): Promise<void> {
    this.emit({
      type: 'batch:settling',
      timestamp: Date.now(),
      data: { batchNumber: batch.batchNumber.toString() },
    });

    let l1TxHash: string;

    if (this.options.settlementStrategy) {
      // Real L1 settlement via pluggable strategy
      try {
        l1TxHash = await this.options.settlementStrategy(batch);
      } catch (err) {
        // Mark batch as failed and re-throw
        const reason = err instanceof Error ? err.message : String(err);
        this.sequencer.markBatchFailed(batch.batchNumber, reason);

        // Broadcast batch:failed gossip
        if (this.peerNetwork) {
          const failPayload: BatchFailedPayload = {
            batchNumber: batch.batchNumber,
            reason,
          };
          const failMsg: GossipMessage = {
            messageId: generateMessageId(
              'batch:failed', this.nodeId, Date.now(),
              batch.batchNumber.toString(),
            ),
            type: 'batch:failed',
            senderId: this.nodeId,
            timestamp: Date.now(),
            payload: failPayload,
          };
          this.peerNetwork.broadcast(failMsg).catch(() => {});
        }

        throw err;
      }
    } else {
      // Simulate L1 confirmation delay
      if (this.options.settlementDelayMs > 0) {
        await new Promise((r) => setTimeout(r, this.options.settlementDelayMs));
      }
      l1TxHash = `sim-l1-tx-${String(this.nextSettlementId++).padStart(4, '0')}`;
    }

    this.sequencer.markBatchSettled(batch.batchNumber, l1TxHash);

    this.totalBatchesSettled++;

    this.emit({
      type: 'batch:settled',
      timestamp: Date.now(),
      data: {
        batchNumber: batch.batchNumber.toString(),
        l1TxHash,
        registrationCount: batch.registrationCount,
        transitionCount: batch.transitionCount,
      },
    });

    // Broadcast batch:settled gossip
    if (this.peerNetwork) {
      const settledPayload: BatchSettledPayload = {
        batchNumber: batch.batchNumber,
        l1TxHash,
        lastSettledRegistryRoot: this.sequencer.getLastSettledRegistryRoot().toString(),
        lastSettledLifecycleRoot: this.sequencer.getLastSettledLifecycleRoot().toString(),
        lastSettledWalletCount: this.sequencer.getLastSettledWalletCount().toString(),
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

    // Auto-checkpoint after each settlement
    if (this.checkpointStore && this.autoCheckpoint) {
      await this.saveCheckpoint('batch_settled');
    }
  }

  // ─── Pool-Based Batch Building ──────────────────────────

  /**
   * Execute a batch build cycle using the proving pool.
   * Splits the batch into prepare → prove (in worker) → finalize.
   */
  private async executeBatchWithPool(): Promise<L2Batch | null> {
    const { job, emptyBatch } = this.sequencer.prepareBatch();

    // Empty batch — no proving needed
    if (!job) return emptyBatch;

    try {
      const proofCount = job.transitionProofJsons.length;
      const desc = `Batch — ${proofCount} proof${proofCount !== 1 ? 's' : ''}${job.adminState ? ' + chain' : ''}`;
      const result = await this.provingPool!.prove(job, desc);
      return await this.sequencer.finalizeBatch(result);
    } catch (err) {
      // Proving failed — restore drained transitions to the pool
      this.sequencer.restoreDrainedTransitions();
      throw err;
    }
  }

  // ─── Proving Lock ────────────────────────────────────────

  /**
   * Acquire the proving lock. o1js uses a single global context that
   * does not support concurrent ZkProgram proving. All code paths that
   * call ZkProgram methods (prove, compile) must serialize through this lock.
   *
   * Returns a release function — call it when proving is complete.
   */
  acquireProvingLock(): Promise<() => void> {
    let releaseFn!: () => void;
    const previous = this._provingLockQueue;
    this._provingLockQueue = new Promise<void>((resolve) => {
      releaseFn = resolve;
    });
    return previous.then(() => releaseFn);
  }

  /**
   * Execute an async function while holding the proving lock.
   * Convenience wrapper around acquireProvingLock().
   *
   * Includes a 5-minute safety timeout: if `fn` hasn't resolved by then,
   * the lock is released and the promise rejects. This prevents a hung
   * o1js proof from permanently blocking the entire proof pipeline.
   */
  async withProvingLock<T>(fn: () => Promise<T>): Promise<T> {
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

  // ─── Checkpoint ──────────────────────────────────────────

  /**
   * Configure a checkpoint store for crash recovery.
   *
   * When enabled, the node automatically saves a checkpoint after:
   *   - Each batch settlement (if autoCheckpoint is true)
   *   - Graceful shutdown via stop()
   *
   * Old checkpoints are pruned to maxCheckpoints.
   */
  setCheckpointStore(
    store: L2CheckpointStore,
    options?: { autoCheckpoint?: boolean; maxCheckpoints?: number },
  ): void {
    this.checkpointStore = store;
    if (options?.autoCheckpoint !== undefined) {
      this.autoCheckpoint = options.autoCheckpoint;
    }
    if (options?.maxCheckpoints !== undefined) {
      this.maxCheckpoints = options.maxCheckpoints;
    }
  }

  /**
   * Save a checkpoint to disk.
   *
   * @param trigger — what triggered this checkpoint
   * @returns The filename of the saved checkpoint, or null if no store configured
   */
  async saveCheckpoint(trigger: L2CheckpointTrigger): Promise<string | null> {
    if (!this.checkpointStore) return null;

    const checkpoint = this.exportCheckpoint(trigger);
    const filename = await this.checkpointStore.save(checkpoint);

    // Prune old checkpoints
    if (this.maxCheckpoints > 0) {
      await this.checkpointStore.prune(this.maxCheckpoints);
    }

    return filename;
  }

  /**
   * Export the current node state as a checkpoint object.
   *
   * Useful for manual checkpointing or inspection without
   * requiring a configured checkpoint store.
   */
  exportCheckpoint(trigger: L2CheckpointTrigger): L2Checkpoint {
    const seqState = this.sequencer.exportState();

    // Find latest settled batch number
    let lastSettled: bigint | null = null;
    for (const b of seqState.batches) {
      if (b.l1Status === 'settled') {
        if (lastSettled === null || b.batchNumber > lastSettled) {
          lastSettled = b.batchNumber;
        }
      }
    }

    const checkpoint: L2Checkpoint = {
      version: CHECKPOINT_VERSION,
      createdAt: Date.now(),
      trigger,
      lastSettledBatchNumber: lastSettled,
      sequencerState: seqState,
      nodeStats: {
        totalProofsAccepted: this.totalProofsAccepted,
        totalBatchesBuilt: this.totalBatchesBuilt,
        totalBatchesSettled: this.totalBatchesSettled,
        totalBatchesFailed: this.totalBatchesFailed,
        nextSettlementId: this.nextSettlementId,
      },
    };

    // Persist known wallets for attestation eligibility after restart
    if (this.knownWallets && this.knownWallets.size > 0) {
      checkpoint.sequencerState.knownWallets = Array.from(this.knownWallets);
    }

    // Include admin registry state if provider is set
    if (this.adminRegistryProvider) {
      checkpoint.sequencerState.adminRegistryState = this.adminRegistryProvider();
    }

    return checkpoint;
  }

  /**
   * Restore node state from a checkpoint.
   *
   * Overwrites sequencer state and node stats. The pending pool
   * is cleared — clients must resubmit proofs after recovery.
   */
  restoreFromCheckpoint(checkpoint: L2Checkpoint): void {
    this.sequencer.restoreState(checkpoint.sequencerState);
    this.totalProofsAccepted = checkpoint.nodeStats.totalProofsAccepted;
    this.totalBatchesBuilt = checkpoint.nodeStats.totalBatchesBuilt;
    this.totalBatchesSettled = checkpoint.nodeStats.totalBatchesSettled;
    this.totalBatchesFailed = checkpoint.nodeStats.totalBatchesFailed;
    this.nextSettlementId = checkpoint.nodeStats.nextSettlementId;

    // Restore known wallets for attestation eligibility
    if (checkpoint.sequencerState.knownWallets) {
      if (!this.knownWallets) this.knownWallets = new Set();
      for (const wid of checkpoint.sequencerState.knownWallets) {
        this.knownWallets.add(wid);
      }
    }

    // Admin registry state is restored by the RPC server via restoreAdminRegistryState()
    // (the node stores the state in checkpoint but the RPC server owns the registry)
    this._checkpointAdminRegistryState = checkpoint.sequencerState.adminRegistryState ?? null;
  }

  /** Checkpoint admin registry state — held temporarily until RPC server restores it */
  _checkpointAdminRegistryState: { keys: Array<{ nodeId: string; publicKeyHex: string; admittedBy: string; reason: string; timestamp: number }>; blacklist: string[] } | null = null;

  /**
   * Create a new L2Node from a checkpoint (crash recovery).
   *
   * Constructs a fresh node and restores all state from the checkpoint.
   * The node is NOT started — call node.start() after recovery.
   *
   * Usage:
   *   const checkpointStore = new L2CheckpointStore('./l2-data');
   *   const checkpoint = await checkpointStore.loadLatest();
   *   const node = L2Node.fromCheckpoint(checkpoint, store);
   *   node.setCheckpointStore(checkpointStore);
   *   node.start();
   */
  static fromCheckpoint(
    checkpoint: L2Checkpoint,
    store: ILocalStore,
    options?: Partial<L2NodeOptions>,
  ): L2Node {
    const state = checkpoint.sequencerState;
    // Propagate l2Only from checkpoint state if not explicitly set in options
    const mergedOptions: Partial<L2NodeOptions> = { ...options };
    if (mergedOptions.l2Only === undefined && state.l2Only !== undefined) {
      mergedOptions.l2Only = state.l2Only;
    }
    const node = new L2Node(
      mergedOptions,
      store,
      Field(BigInt(state.currentRegistryRoot)),
      Field(BigInt(state.currentLifecycleRoot)),
      Field(BigInt(state.currentWalletCount)),
    );
    node.restoreFromCheckpoint(checkpoint);
    return node;
  }
}
