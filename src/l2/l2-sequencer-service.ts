import { Field, Poseidon } from 'o1js';
import type { ILocalStore } from '../storage/local-store.js';
import {
  TransitionOutput,
  StateTransitionProof,
} from '../engine/state-transition.js';
import { BatchProgram, BatchProof, BatchOutput } from './batch-program.js';
import type {
  L2Receipt,
  L2Block,
  L2Batch,
  AdminStateDelta,
  L1Status,
} from './l2-types.js';
import { AuditService } from '../audit/audit-service.js';
import type { AuditEvent, AuditLog } from '../audit/audit-types.js';
import type { ClaimContext } from '../reporting/report-types.js';
import type { L2SequencerState } from './l2-checkpoint.js';

/** Default batch interval: 3 minutes (matches MINA L1 block time) */
export const DEFAULT_BATCH_INTERVAL_MS = 180_000;

/** Maximum transitions per batch (safety limit) */
export const MAX_TRANSITIONS_PER_BATCH = 1024;

/**
 * PendingTransition — internal record for a queued proof.
 */
interface PendingTransition {
  sequenceNumber: bigint;
  proof: StateTransitionProof;
  receipt: L2Receipt;
}

/**
 * L2SequencerService — the L2 chain sequencer for zkpCare.
 *
 * Processes StateTransitionProofs submitted by nodes:
 *   1. Verifies proof (~5ms) → issues L2Receipt (instant confirmation)
 *   2. Queues transitions in pending pool (ordered by sequence number)
 *   3. On buildBatch(): wraps each proof → tree-merges → single BatchProof
 *   4. BatchProof submitted to CareContract.settleBatch() on L1
 *
 * State tracking:
 *   - Maintains current L2 roots (ahead of L1 between settlements)
 *   - Tracks receipt/block/batch metadata for querying
 *   - Queues admin operations (slots 4-7) for separate L1 submission
 *
 * Fallback guarantee:
 *   If the sequencer goes down, nodes fall back to CareContract.settleTransition
 *   on L1 directly. The L1 state will be at the last settled batch.
 */
export class L2SequencerService {
  private store: ILocalStore;

  // Current L2 state (ahead of L1 between settlements)
  private currentRegistryRoot: Field;
  private currentLifecycleRoot: Field;
  private currentWalletCount: Field;

  // Pending pool
  private pendingPool: PendingTransition[] = [];
  private nextSequenceNumber: bigint = 0n;

  // Metadata stores
  private receipts: Map<string, L2Receipt> = new Map();
  private blocks: Map<bigint, L2Block> = new Map();
  private batches: Map<bigint, L2Batch> = new Map();

  // Counters
  private nextBlockNumber: bigint = 0n;
  private nextBatchNumber: bigint = 0n;

  // Admin queue
  private adminQueue: AdminStateDelta[] = [];

  // Audit / DA
  private auditLog: AuditEvent[] = [];
  private latestChainHash: Field;

  // In-flight batch (awaiting L1 settlement)
  private inFlightBatchNumber: bigint | null = null;

  // Config
  private batchIntervalMs: number;

  constructor(
    store: ILocalStore,
    initialRegistryRoot: Field,
    initialLifecycleRoot: Field,
    initialWalletCount: Field,
    batchIntervalMs: number = DEFAULT_BATCH_INTERVAL_MS,
  ) {
    this.store = store;
    this.currentRegistryRoot = initialRegistryRoot;
    this.currentLifecycleRoot = initialLifecycleRoot;
    this.currentWalletCount = initialWalletCount;
    this.batchIntervalMs = batchIntervalMs;
    this.latestChainHash = Field(BigInt(AuditService.GENESIS_HASH));
  }

  // ─── Core Flow ──────────────────────────────────────────

  /**
   * Submit a StateTransitionProof to the L2 sequencer.
   *
   * 1. Verifies the proof (~5ms)
   * 2. Asserts proof's old roots match current L2 state
   * 3. Applies the transition (updates L2 roots)
   * 4. Detects registration → increments walletCount
   * 5. Issues L2Receipt (instant confirmation)
   * 6. Queues in pending pool
   *
   * @returns L2Receipt — instant confirmation of acceptance
   * @throws If proof verification fails or roots don't match
   */
  async submitProof(proof: StateTransitionProof): Promise<L2Receipt> {
    // 1. Verify the proof
    proof.verify();

    const output = proof.publicOutput as unknown as TransitionOutput;

    // 2. Assert old roots match current L2 state
    const oldRegRoot = output.oldRegistryRoot;
    const oldLifeRoot = output.oldLifecycleRoot;

    if (oldRegRoot.toString() !== this.currentRegistryRoot.toString()) {
      throw new Error(
        'Registry root mismatch: proof expects ' +
          oldRegRoot.toString() +
          ' but L2 state is ' +
          this.currentRegistryRoot.toString(),
      );
    }

    if (oldLifeRoot.toString() !== this.currentLifecycleRoot.toString()) {
      throw new Error(
        'Lifecycle root mismatch: proof expects ' +
          oldLifeRoot.toString() +
          ' but L2 state is ' +
          this.currentLifecycleRoot.toString(),
      );
    }

    // 3. Apply the transition
    this.currentRegistryRoot = output.newRegistryRoot;
    this.currentLifecycleRoot = output.newLifecycleRoot;

    // 4. Detect registration (both roots changed)
    const registryChanged =
      oldRegRoot.toString() !== output.newRegistryRoot.toString();
    const lifecycleChanged =
      oldLifeRoot.toString() !== output.newLifecycleRoot.toString();
    const isRegistration = registryChanged && lifecycleChanged;

    if (isRegistration) {
      this.currentWalletCount = this.currentWalletCount.add(1);
    }

    // 5. Issue receipt
    const sequenceNumber = this.nextSequenceNumber++;
    const receiptId = `l2-${sequenceNumber.toString().padStart(8, '0')}`;

    const receipt: L2Receipt = {
      receiptId,
      walletId: output.walletId.toString(),
      sequenceNumber,
      oldRegistryRoot: oldRegRoot.toString(),
      newRegistryRoot: output.newRegistryRoot.toString(),
      oldLifecycleRoot: oldLifeRoot.toString(),
      newLifecycleRoot: output.newLifecycleRoot.toString(),
      isRegistration,
      acceptedAt: Date.now(),
      l1Status: 'pending',
    };

    // 6. Emit audit event (DA hash chain)
    const auditEvent: AuditEvent = {
      sequenceNumber,
      receiptId,
      walletId: output.walletId.toString(),
      isRegistration,
      oldRegistryRoot: oldRegRoot.toString(),
      newRegistryRoot: output.newRegistryRoot.toString(),
      oldLifecycleRoot: oldLifeRoot.toString(),
      newLifecycleRoot: output.newLifecycleRoot.toString(),
      eventCommitment: '',  // Computed below
      chainHash: '',        // Computed below
      timestamp: receipt.acceptedAt,
      l1Status: 'pending',
    };

    const eventCommitment = AuditService.computeEventCommitment(auditEvent);
    const chainHash = AuditService.computeChainHash(this.latestChainHash, eventCommitment);

    auditEvent.eventCommitment = eventCommitment.toString();
    auditEvent.chainHash = chainHash.toString();
    this.latestChainHash = chainHash;

    this.auditLog.push(auditEvent);
    receipt.auditEventHash = chainHash.toString();

    this.receipts.set(receiptId, receipt);

    // 7. Queue in pending pool
    this.pendingPool.push({ sequenceNumber, proof, receipt });

    // Persist receipt as proof metadata
    await this.store.saveProof(receiptId, JSON.stringify(receipt));

    return receipt;
  }

  /**
   * Build a batch from all pending proofs.
   *
   * 1. Drains the pending pool (ordered by sequence number)
   * 2. wrapTransition() each proof
   * 3. Tree-merge into single BatchProof (log2(N) rounds)
   * 4. Creates L2Block + L2Batch metadata
   * 5. Updates receipt statuses to 'batched'
   *
   * @returns L2Batch with the BatchProof JSON, or null if no pending proofs
   */
  async buildBatch(): Promise<L2Batch | null> {
    if (this.inFlightBatchNumber !== null) {
      throw new Error(
        `Batch ${this.inFlightBatchNumber} is still in-flight. ` +
        `Call markBatchSettled() or markBatchFailed() before building a new batch.`,
      );
    }

    if (this.pendingPool.length === 0) {
      return null;
    }

    if (this.pendingPool.length > MAX_TRANSITIONS_PER_BATCH) {
      throw new Error(
        `Too many pending transitions (${this.pendingPool.length}). Max: ${MAX_TRANSITIONS_PER_BATCH}`,
      );
    }

    // 1. Drain pending pool (already ordered by sequence number)
    const transitions = [...this.pendingPool];
    this.pendingPool = [];

    // 2. Wrap each transition into a BatchProof (base cases)
    const wrappedProofs: BatchProof[] = [];
    for (const t of transitions) {
      const wrapped = await BatchProgram.wrapTransition(t.proof);
      wrappedProofs.push(wrapped.proof as BatchProof);
    }

    // 3. Tree-merge: pair-wise merge until single proof remains
    let currentLevel = wrappedProofs;
    while (currentLevel.length > 1) {
      const nextLevel: BatchProof[] = [];
      for (let i = 0; i < currentLevel.length; i += 2) {
        if (i + 1 < currentLevel.length) {
          // Merge pair
          const merged = await BatchProgram.mergeBatches(
            currentLevel[i],
            currentLevel[i + 1],
          );
          nextLevel.push(merged.proof as BatchProof);
        } else {
          // Odd one out — carry forward
          nextLevel.push(currentLevel[i]);
        }
      }
      currentLevel = nextLevel;
    }

    const finalProof = currentLevel[0];
    const batchOutput = finalProof.publicOutput as unknown as BatchOutput;

    // 4. Create L2Block
    const blockNumber = this.nextBlockNumber++;
    const receiptIds = transitions.map((t) => t.receipt.receiptId);

    const block: L2Block = {
      blockNumber,
      receiptIds,
      startRegistryRoot: batchOutput.oldRegistryRoot.toString(),
      endRegistryRoot: batchOutput.newRegistryRoot.toString(),
      startLifecycleRoot: batchOutput.oldLifecycleRoot.toString(),
      endLifecycleRoot: batchOutput.newLifecycleRoot.toString(),
      registrationCount: Number(batchOutput.registrationCount.toBigInt()),
      transitionCount: Number(batchOutput.transitionCount.toBigInt()),
      createdAt: Date.now(),
      l1Status: 'batched',
    };

    this.blocks.set(blockNumber, block);

    // Create L2Batch
    const batchNumber = this.nextBatchNumber++;
    const batchProofJson = JSON.stringify(finalProof.toJSON());

    const batch: L2Batch = {
      batchNumber,
      blockNumbers: [blockNumber],
      registrationCount: block.registrationCount,
      transitionCount: block.transitionCount,
      oldRegistryRoot: batchOutput.oldRegistryRoot.toString(),
      newRegistryRoot: batchOutput.newRegistryRoot.toString(),
      oldLifecycleRoot: batchOutput.oldLifecycleRoot.toString(),
      newLifecycleRoot: batchOutput.newLifecycleRoot.toString(),
      batchProofJson,
      createdAt: Date.now(),
      l1Status: 'batched',
    };

    this.batches.set(batchNumber, batch);

    // 5. Update receipt statuses
    for (const t of transitions) {
      t.receipt.l1Status = 'batched';
      t.receipt.l2BlockNumber = blockNumber;
      t.receipt.l1BatchNumber = batchNumber;
      this.receipts.set(t.receipt.receiptId, t.receipt);
    }

    // 6. Sync audit events with batch metadata
    this.markAuditEventsBatched(receiptIds, batchNumber, blockNumber);

    // Persist batch metadata
    await this.store.saveProof(
      `batch-${batchNumber}`,
      JSON.stringify(batch),
    );

    // Mark as in-flight (must settle or fail before next buildBatch)
    this.inFlightBatchNumber = batchNumber;

    return batch;
  }

  /**
   * Mark a batch as settled on L1.
   *
   * Called after CareContract.settleBatch() transaction is confirmed.
   * Updates all associated receipts and blocks to 'settled' status.
   */
  markBatchSettled(batchNumber: bigint, l1TxHash: string): void {
    const batch = this.batches.get(batchNumber);
    if (!batch) {
      throw new Error(`Batch ${batchNumber} not found`);
    }

    batch.l1Status = 'settled';
    batch.l1TxHash = l1TxHash;

    // Update blocks
    for (const bn of batch.blockNumbers) {
      const block = this.blocks.get(bn);
      if (block) {
        block.l1Status = 'settled';
        block.l1TxHash = l1TxHash;
      }
    }

    // Update receipts in those blocks
    for (const bn of batch.blockNumbers) {
      const block = this.blocks.get(bn);
      if (block) {
        for (const receiptId of block.receiptIds) {
          const receipt = this.receipts.get(receiptId);
          if (receipt) {
            receipt.l1Status = 'settled';
          }
        }
      }
    }

    this.inFlightBatchNumber = null;
  }

  /**
   * Mark a batch as failed on L1.
   *
   * Called when CareContract.settleBatch() transaction fails (network error,
   * reorg, gas issue). Sets all associated receipts and blocks to 'failed'.
   * Clears the in-flight guard so a new batch can be built or this batch
   * can be retried via retryBatch().
   *
   * @param batchNumber — the batch that failed
   * @param reason — human-readable failure reason
   */
  markBatchFailed(batchNumber: bigint, reason: string): void {
    const batch = this.batches.get(batchNumber);
    if (!batch) {
      throw new Error(`Batch ${batchNumber} not found`);
    }

    batch.l1Status = 'failed';
    batch.failureReason = reason;

    // Update blocks
    for (const bn of batch.blockNumbers) {
      const block = this.blocks.get(bn);
      if (block) {
        block.l1Status = 'failed';
      }
    }

    // Update receipts in those blocks
    for (const bn of batch.blockNumbers) {
      const block = this.blocks.get(bn);
      if (block) {
        for (const receiptId of block.receiptIds) {
          const receipt = this.receipts.get(receiptId);
          if (receipt) {
            receipt.l1Status = 'failed';
          }
        }
      }
    }

    // Update audit events
    this.markAuditEventsStatus(batch, 'failed');

    this.inFlightBatchNumber = null;
  }

  /**
   * Retry a previously failed batch.
   *
   * Resets the batch/block/receipt statuses from 'failed' back to 'batched'
   * and re-marks it as in-flight. The caller should resubmit the returned
   * batch's batchProofJson to CareContract.settleBatch() on L1.
   *
   * @param batchNumber — the failed batch to retry
   * @returns L2Batch — the batch with its batchProofJson for resubmission
   */
  retryBatch(batchNumber: bigint): L2Batch {
    const batch = this.batches.get(batchNumber);
    if (!batch) {
      throw new Error(`Batch ${batchNumber} not found`);
    }
    if (batch.l1Status !== 'failed') {
      throw new Error(
        `Batch ${batchNumber} is not in failed state (current: ${batch.l1Status})`,
      );
    }

    batch.l1Status = 'batched';
    delete batch.failureReason;

    // Reset blocks
    for (const bn of batch.blockNumbers) {
      const block = this.blocks.get(bn);
      if (block) {
        block.l1Status = 'batched';
      }
    }

    // Reset receipts in those blocks
    for (const bn of batch.blockNumbers) {
      const block = this.blocks.get(bn);
      if (block) {
        for (const receiptId of block.receiptIds) {
          const receipt = this.receipts.get(receiptId);
          if (receipt) {
            receipt.l1Status = 'batched';
          }
        }
      }
    }

    // Reset audit events
    this.markAuditEventsStatus(batch, 'batched');

    this.inFlightBatchNumber = batchNumber;

    return batch;
  }

  // ─── Admin Queue ────────────────────────────────────────

  /**
   * Queue an admin operation for separate L1 submission.
   *
   * Admin operations (slots 4-7) are NOT batched — they require
   * admin signatures and go directly to L1 as individual transactions.
   */
  queueAdminOperation(delta: AdminStateDelta): void {
    this.adminQueue.push(delta);
  }

  /**
   * Drain the admin queue, returning all queued operations.
   * Clears the queue after draining.
   */
  drainAdminQueue(): AdminStateDelta[] {
    const ops = [...this.adminQueue];
    this.adminQueue = [];
    return ops;
  }

  // ─── Getters ────────────────────────────────────────────

  /** Current L2 registry root (may be ahead of L1) */
  getCurrentRegistryRoot(): Field {
    return this.currentRegistryRoot;
  }

  /** Current L2 lifecycle root (may be ahead of L1) */
  getCurrentLifecycleRoot(): Field {
    return this.currentLifecycleRoot;
  }

  /** Current L2 wallet count (may be ahead of L1) */
  getCurrentWalletCount(): Field {
    return this.currentWalletCount;
  }

  /** Batch number currently awaiting L1 settlement, or null */
  getInFlightBatchNumber(): bigint | null {
    return this.inFlightBatchNumber;
  }

  /** Number of proofs waiting in the pending pool */
  getPendingCount(): number {
    return this.pendingPool.length;
  }

  /** Batch interval in milliseconds */
  getBatchIntervalMs(): number {
    return this.batchIntervalMs;
  }

  /** Look up a receipt by ID */
  getReceipt(receiptId: string): L2Receipt | undefined {
    return this.receipts.get(receiptId);
  }

  /** Look up a block by number */
  getBlock(blockNumber: bigint): L2Block | undefined {
    return this.blocks.get(blockNumber);
  }

  /** Look up a batch by number */
  getBatch(batchNumber: bigint): L2Batch | undefined {
    return this.batches.get(batchNumber);
  }

  // ─── Audit / DA ────────────────────────────────────────────

  /**
   * Attach claim context to an existing audit event (post-facto enrichment).
   *
   * Financial context is provided by the pharmacy alongside the proof.
   * This method links it to the corresponding audit event for financial auditing.
   */
  enrichAuditEvent(receiptId: string, claimContext: ClaimContext): void {
    const event = this.auditLog.find(e => e.receiptId === receiptId);
    if (!event) {
      throw new Error(`Audit event not found for receipt: ${receiptId}`);
    }
    event.claimContext = claimContext;
  }

  /**
   * Get the full audit log with chain anchors.
   */
  getAuditLog(): AuditLog {
    return {
      events: [...this.auditLog],
      genesisHash: AuditService.GENESIS_HASH,
      latestChainHash: this.latestChainHash.toString(),
      eventCount: BigInt(this.auditLog.length),
    };
  }

  /**
   * Update audit events when their receipts are batched.
   *
   * Called during buildBatch() to sync audit events with batch metadata.
   */
  markAuditEventsBatched(
    receiptIds: string[],
    batchNumber: bigint,
    blockNumber: bigint,
  ): void {
    const receiptSet = new Set(receiptIds);
    for (const event of this.auditLog) {
      if (receiptSet.has(event.receiptId)) {
        event.l1Status = 'batched';
        event.l2BlockNumber = blockNumber;
        event.l1BatchNumber = batchNumber;
      }
    }
  }

  /**
   * Update audit event l1Status for all receipts in a batch.
   *
   * Used by markBatchFailed and retryBatch to keep audit events in sync.
   */
  private markAuditEventsStatus(batch: L2Batch, status: L1Status): void {
    const receiptIds = new Set<string>();
    for (const bn of batch.blockNumbers) {
      const block = this.blocks.get(bn);
      if (block) {
        for (const rid of block.receiptIds) {
          receiptIds.add(rid);
        }
      }
    }
    for (const event of this.auditLog) {
      if (receiptIds.has(event.receiptId)) {
        event.l1Status = status;
      }
    }
  }

  // ─── Checkpoint: Export / Restore ─────────────────────────

  /**
   * Export the full sequencer state for checkpointing.
   *
   * Captures all internal state except:
   *   - store (passed at construction, not owned)
   *   - pendingPool (proofs are transient; clients resubmit after recovery)
   *   - batchIntervalMs (config, not state)
   *
   * Field values are serialized as decimal strings.
   */
  exportState(): L2SequencerState {
    return {
      currentRegistryRoot: this.currentRegistryRoot.toString(),
      currentLifecycleRoot: this.currentLifecycleRoot.toString(),
      currentWalletCount: this.currentWalletCount.toString(),
      nextSequenceNumber: this.nextSequenceNumber,
      nextBlockNumber: this.nextBlockNumber,
      nextBatchNumber: this.nextBatchNumber,
      latestChainHash: this.latestChainHash.toString(),
      inFlightBatchNumber: this.inFlightBatchNumber,
      receipts: Array.from(this.receipts.values()),
      blocks: Array.from(this.blocks.values()),
      batches: Array.from(this.batches.values()),
      auditLog: [...this.auditLog],
      adminQueue: [...this.adminQueue],
    };
  }

  /**
   * Restore sequencer state from a checkpoint.
   *
   * Overwrites all internal state with the provided snapshot.
   * The pending pool is cleared — clients must resubmit any
   * proofs that were accepted but not yet settled.
   *
   * @param state — snapshot from a previous exportState() call
   */
  restoreState(state: L2SequencerState): void {
    this.currentRegistryRoot = Field(BigInt(state.currentRegistryRoot));
    this.currentLifecycleRoot = Field(BigInt(state.currentLifecycleRoot));
    this.currentWalletCount = Field(BigInt(state.currentWalletCount));
    this.nextSequenceNumber = state.nextSequenceNumber;
    this.nextBlockNumber = state.nextBlockNumber;
    this.nextBatchNumber = state.nextBatchNumber;
    this.latestChainHash = Field(BigInt(state.latestChainHash));
    this.inFlightBatchNumber = state.inFlightBatchNumber;

    this.receipts.clear();
    for (const r of state.receipts) {
      this.receipts.set(r.receiptId, r);
    }

    this.blocks.clear();
    for (const b of state.blocks) {
      this.blocks.set(b.blockNumber, b);
    }

    this.batches.clear();
    for (const b of state.batches) {
      this.batches.set(b.batchNumber, b);
    }

    this.auditLog = [...state.auditLog];
    this.adminQueue = [...state.adminQueue];

    // Pending pool is NOT restored — proofs are transient
    this.pendingPool = [];
  }
}
