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
import type { L2Receipt, L2Batch } from './l2-types.js';
import {
  L2CheckpointStore,
  CHECKPOINT_VERSION,
} from './l2-checkpoint.js';
import type {
  L2Checkpoint,
  L2CheckpointTrigger,
} from './l2-checkpoint.js';

// ─── Options ─────────────────────────────────────────────

/** Configuration for the L2 node */
export interface L2NodeOptions {
  /** Batch interval in ms. Default 30_000 (30s) for demo, 180_000 (3 min) for production */
  batchIntervalMs: number;
  /** If true, automatically simulates L1 settlement after each batch */
  autoSettle: boolean;
  /** Delay in ms before marking batch as settled (simulates L1 confirmation time) */
  settlementDelayMs: number;
  /** Maximum retries for failed batch settlements */
  maxBatchRetries: number;
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
  | 'audit:event';

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

  constructor(
    options: Partial<L2NodeOptions>,
    store: ILocalStore,
    initialRegistryRoot: Field,
    initialLifecycleRoot: Field,
    initialWalletCount: Field,
  ) {
    this.options = { ...DEFAULT_L2_NODE_OPTIONS, ...options };
    this.sequencer = new L2SequencerService(
      store,
      initialRegistryRoot,
      initialLifecycleRoot,
      initialWalletCount,
      this.options.batchIntervalMs,
    );
  }

  // ─── Lifecycle ──────────────────────────────────────────

  /** Start the L2 node — begins the batch timer */
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
      },
    });

    this.scheduleBatchTick();
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
   */
  async submitProof(proof: StateTransitionProof): Promise<L2Receipt> {
    try {
      const receipt = await this.sequencer.submitProof(proof);
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

  // ─── Events ─────────────────────────────────────────────

  /** Subscribe to all chain events */
  on(handler: L2EventHandler): void {
    this.handlers.push(handler);
  }

  /** Unsubscribe from chain events */
  off(handler: L2EventHandler): void {
    this.handlers = this.handlers.filter((h) => h !== handler);
  }

  private emit(event: L2ChainEvent): void {
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
    };
  }

  /** Direct access to the underlying sequencer for advanced queries */
  getSequencer(): L2SequencerService {
    return this.sequencer;
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
      const batch = await this.sequencer.buildBatch();

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
        },
      });

      // Settle
      if (this.options.autoSettle) {
        await this.settleBatch(batch);
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

    // Simulate L1 confirmation delay
    if (this.options.settlementDelayMs > 0) {
      await new Promise((r) => setTimeout(r, this.options.settlementDelayMs));
    }

    // ──────────────────────────────────────────────────────
    // SETTLEMENT HOOK — Replace this block for real MINA L1
    // ──────────────────────────────────────────────────────
    const l1TxHash = `sim-l1-tx-${String(this.nextSettlementId++).padStart(4, '0')}`;
    this.sequencer.markBatchSettled(batch.batchNumber, l1TxHash);
    // ──────────────────────────────────────────────────────

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

    // Auto-checkpoint after each settlement
    if (this.checkpointStore && this.autoCheckpoint) {
      await this.saveCheckpoint('batch_settled');
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

    return {
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
  }

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
    const node = new L2Node(
      options ?? {},
      store,
      Field(BigInt(state.currentRegistryRoot)),
      Field(BigInt(state.currentLifecycleRoot)),
      Field(BigInt(state.currentWalletCount)),
    );
    node.restoreFromCheckpoint(checkpoint);
    return node;
  }
}
