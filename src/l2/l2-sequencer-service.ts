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

import { Field, Poseidon, MerkleTree } from 'o1js';
import type { ILocalStore } from '../storage/local-store.js';
import {
  TransitionOutput,
  StateTransitionProof,
} from '../engine/state-transition.js';
import { BatchProgram, BatchProof, BatchOutput } from './batch-program.js';
import { ChainProgram, ChainProof } from './chain-program.js';
import { computeGlobalStateRoot, ChainOutput } from './global-state.js';
import type {
  L2Receipt,
  L2Block,
  L2Batch,
  AdminStateDelta,
  L1Status,
  BenefitPlanConfig,
} from './l2-types.js';
import { AuditService } from '../audit/audit-service.js';
import { AuditMerkleIndex } from '../audit/audit-merkle-index.js';
import { l2Stringify } from './l2-json.js';
import type { AuditEvent, AuditLog } from '../audit/audit-types.js';
import type { ClaimContext } from '../reporting/report-types.js';
import type { L2SequencerState } from './l2-checkpoint.js';
import type { ClaimSubmissionMetadata } from './l2-types.js';
import { ClaimAccumulatorService } from './claim-accumulator-service.js';
import type { ClaimAccumulatorEntry, ClaimLeaf, ClaimMetadata } from './claim-accumulator-types.js';
import { MessageStoreService } from './message-store-service.js';
import type { StoredMessage, MessagePayload, MessageStoreEntry } from './message-store-types.js';
import { ProviderRegistryService } from './provider-registry-service.js';
import type { ProviderRegistryEntry, ProviderLeaf, ProviderMetadata, ProviderRegistryState } from './provider-registry-types.js';
import { ProviderLifecycle } from './provider-registry-types.js';
import type { PartitionConfig } from './l2-partition.js';
import { isMyPartition, getPartition } from './l2-partition.js';
import { WalletRegistry, WalletState, WALLET_TREE_HEIGHT } from '../wallets/wallet-state.js';
import { lifecycleLeafCommitment, LIFECYCLE_REGISTERED, LifecycleWitness } from '../engine/lifecycle.js';
import type { IWalProvider, WalEntry } from './l2-wal.js';
import type { TransitionProofVerifier } from './l2-proof-verifier.js';
import type { ProvingJobRequest, ProvingJobResult } from './l2-proving-pool-types.js';
import { FormularyService } from './formulary-service.js';
import type { FormularyServiceState } from './formulary-service.js';

/** Default batch interval: 3 minutes (matches MINA L1 block time) */
export const DEFAULT_BATCH_INTERVAL_MS = 180_000;

/**
 * Maximum transitions per batch (must be even — wrapPair requires pairs).
 *
 * With uniform pairs: 4 transitions = 2 wrapPair calls → 1 merge = 3 proof ops.
 * This is more efficient than the old approach (4 wraps + 3 merges = 7 ops).
 * Excess proofs remain in the pending pool for the next batch.
 */
export const MAX_TRANSITIONS_PER_BATCH = 2;

/**
 * PendingTransition — internal record for a queued proof.
 */
interface PendingTransition {
  sequenceNumber: bigint;
  proof: StateTransitionProof;
  receipt: L2Receipt;
}

/**
 * AdminStateConfig — the 5 CareContract admin state fields needed
 * for GlobalState computation in ChainProgram.
 *
 * These fields change rarely (admin operations go to L1 individually),
 * so they're tracked separately from the core registry/lifecycle roots.
 *
 * When set via setAdminState(), the sequencer will produce ChainProofs
 * after each batch, creating the "picture of a picture" recursive chain.
 */
export interface AdminStateConfig {
  adminPublicKeyHash: Field;
  benefitPlanRoot: Field;
  credentialRegistryRoot: Field;
  eligibilityVkHash: Field;
  messagingRoot: Field;
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

  // Chain proof state (enabled when adminState is set)
  private adminState: AdminStateConfig | null = null;
  private latestChainProof: ChainProof | null = null;
  private latestChainProofJson: string | null = null;
  private currentBlockHeight: Field = Field(0);
  private currentGlobalStateRoot: Field = Field(0);

  // Audit Merkle index — parallel MerkleTree for selective event witness disclosure
  private auditMerkleIndex: AuditMerkleIndex = new AuditMerkleIndex();

  // Claim accumulator — global MerkleTree tracking all fulfilled claims with NDC data
  private claimAccumulator: ClaimAccumulatorService = new ClaimAccumulatorService();

  // Message store — global MerkleTree tracking encrypted messages between providers
  private messageStore: MessageStoreService = new MessageStoreService();

  // Provider registry — global MerkleTree tracking credentialed prescribers/pharmacies
  private providerRegistry: ProviderRegistryService = new ProviderRegistryService();

  // Formulary service — Option C: canonical 32K drug store with plan overlays
  private formularyService: FormularyService = new FormularyService();

  // Proof fingerprint deduplication — prevents replay of identical transitions
  private seenProofFingerprints: Set<string> = new Set();

  // Witness trees — the only copy of wallet registry and lifecycle state.
  // Every proof and every admin change is applied here, and currentRegistryRoot /
  // currentLifecycleRoot must always equal these trees' roots (assertTreesMatchRoots).
  // Other in-process services read these trees through getStateTrees() and change
  // them only through adminMutate().
  private walletRegistry: WalletRegistry = new WalletRegistry();
  private lifecycleTree: MerkleTree = new MerkleTree(WALLET_TREE_HEIGHT);
  /** Tracks current lifecycle state per wallet (walletId string → Field).
   *  The lifecycle tree stores Poseidon commitments so the raw state isn't
   *  recoverable from the leaf — we track it here for getWalletWitnesses(). */
  private walletLifecycleStates: Map<string, Field> = new Map();
  /** False after a restore or reset that set roots without rebuilding the trees.
   *  While false the tree/root invariant is reported but not enforced. */
  private treesAuthoritative = true;

  // Pre-batch snapshots for rollback on batch failure
  private preBatchAuditLogLength = 0;
  private preBatchChainHash: Field = Field(0);
  private preBatchClaimLeafCount = 0n;
  private preBatchAuditMerkleLeafCount = 0n;
  private preBatchFingerprints: Set<string> = new Set();
  private preBatchWalletSnapshot: Map<string, { walletId: string; lifecycleState: bigint; credentialInventoryRoot?: string; nonce?: string }> = new Map();

  // Formulary store — published formularies indexed by planIdHash
  private formularyStore: Map<string, {
    formularyRoot: string;
    entriesJson: string;
    publishedAt: number;
    version: number;
  }> = new Map();

  // Plan store — benefit plan configs indexed by planId
  private planStore: Map<string, BenefitPlanConfig> = new Map();

  // Employer attestation store — attested employer agreements indexed by employerId
  private employerAttestationStore: Map<string, import('./l2-types.js').EmployerAttestation> = new Map();

  // Employer node registry (Phase C) — tracks live employer-node processes
  // spawned on-demand by the marketplace orchestrator. Maps employerId to the
  // orchestrator-assigned URLs so any subsystem (member, insurer, dashboard)
  // can find the live tenant node dynamically. Entries are ephemeral and
  // cleared on sequencer restart; the orchestrator re-registers on boot.
  // `lastHeartbeatAt` is updated on re-register (keepalive). Entries older
  // than the TTL are pruned on lookup; the orchestrator is expected to
  // keepalive via `registerEmployerNode` every 60 seconds.
  private employerNodeRegistry: Map<string, {
    employerId: string;
    employerNodeUrl: string;
    hrToolUrl?: string;
    pid: number;
    startedAt: number;
    lastHeartbeatAt: number;
    adminTokenFingerprint?: string;
  }> = new Map();

  /** TTL after which a tenant registry entry is considered stale and pruned. */
  private static readonly EMPLOYER_NODE_TTL_MS = 5 * 60 * 1000;

  // Last-settled roots — safe recovery point matching L1 state.
  // Updated ONLY in markBatchSettled(). Used by restoreState() to
  // avoid root divergence when pending pool is discarded on crash recovery.
  private lastSettledRegistryRoot: Field;
  private lastSettledLifecycleRoot: Field;
  private lastSettledWalletCount: Field;

  // Config
  private batchIntervalMs: number;

  // L2-only mode: batches are finalized immediately (no L1 settlement)
  private l2Only: boolean;

  // Partition config (optional — when set, rejects proofs for wrong partition)
  private partitionConfig: PartitionConfig | null = null;

  // Write-Ahead Log (optional — when set, mutations are WAL'd before application)
  private walProvider: IWalProvider | null = null;

  // Cryptographic verification of submitted proofs. Required: submitProof refuses
  // while this is null, so there is no path that accepts an unverified transition.
  private transitionVerifier: TransitionProofVerifier | null = null;

  // Drained transitions held between prepareBatch() and finalizeBatch()
  private drainedTransitions: PendingTransition[] = [];

  constructor(
    store: ILocalStore,
    initialRegistryRoot: Field,
    initialLifecycleRoot: Field,
    initialWalletCount: Field,
    batchIntervalMs: number = DEFAULT_BATCH_INTERVAL_MS,
    l2Only: boolean = false,
  ) {
    this.store = store;
    this.currentRegistryRoot = initialRegistryRoot;
    this.currentLifecycleRoot = initialLifecycleRoot;
    this.currentWalletCount = initialWalletCount;
    this.lastSettledRegistryRoot = initialRegistryRoot;
    this.lastSettledLifecycleRoot = initialLifecycleRoot;
    this.lastSettledWalletCount = initialWalletCount;
    this.batchIntervalMs = batchIntervalMs;
    this.l2Only = l2Only;
    this.latestChainHash = Field(BigInt(AuditService.GENESIS_HASH));
    this.preBatchChainHash = this.latestChainHash;
    // A fresh network starts from empty trees, so the invariant holds and is enforced.
    // Callers that start from arbitrary roots get the legacy, unenforced behaviour until
    // the first adminMutate() rebuilds consistent state.
    this.treesAuthoritative = this.treesMatchRoots();
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
   * @param metadata — optional claim context (ndcHash, wallet IDs, etc.) for drug history tracking
   * @returns L2Receipt — instant confirmation of acceptance
   * @throws If proof verification fails or roots don't match
   */
  async submitProof(proof: StateTransitionProof, metadata?: ClaimSubmissionMetadata): Promise<L2Receipt> {
    // 1. Verify the proof cryptographically, before anything is read, recorded or mutated.
    //
    //    This is the first thing that happens, deliberately. Everything below it —
    //    the fingerprint, the partition check, the root assertions, the tree update,
    //    the WAL append, the receipt, the audit chain, the claim leaf and the gossip
    //    that follows — is state the caller must not be able to touch with a proof
    //    that does not verify.
    //
    //    The verifier is injected rather than called directly, so this method contains
    //    no path that can accept an unverified transition: with none configured the
    //    submission is refused. `proof.verify()` used to stand here and did nothing;
    //    o1js documents it as having no effect outside a circuit.
    if (!this.transitionVerifier) {
      throw new Error(
        'Proof verification is not configured: refusing to accept a state transition. ' +
          'Call setTransitionVerifier() with a verifier bound to a pinned verification key.',
      );
    }
    await this.transitionVerifier(proof);

    const output = proof.publicOutput as unknown as TransitionOutput;

    // 1a. Proof fingerprint dedup — prevent replay of identical transitions.
    //     Recorded after verification, so a proof that fails to verify never leaves a
    //     fingerprint behind. An honest proof that is recorded and then loses a root
    //     race is rebuilt against the new roots, which gives it a different
    //     fingerprint, so the entry it leaves is inert.
    const fp = `${output.walletId}:${output.oldRegistryRoot}:${output.newRegistryRoot}:${output.oldLifecycleRoot}:${output.newLifecycleRoot}`;
    if (this.seenProofFingerprints.has(fp)) {
      throw new Error('Duplicate proof: this transition has already been processed');
    }
    this.seenProofFingerprints.add(fp);

    // 1b. Partition check — reject if walletId doesn't belong to this partition
    if (this.partitionConfig) {
      const walletId = output.walletId.toString();
      if (!isMyPartition(walletId, this.partitionConfig)) {
        const { partitionCount, partitionIndex } = this.partitionConfig;
        const actualPartition = getPartition(walletId, partitionCount);
        throw new Error(
          `Wrong partition: walletId belongs to partition ${actualPartition}, ` +
          `this is partition ${partitionIndex}`,
        );
      }
    }

    // 1c. The witness trees must hash to the published roots before anything is applied.
    this.assertTreesMatchRoots('before applying a proof');

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

    // 2a. Work out how this transition changes the witness trees and refuse it, before
    //     anything is mutated, if the result would not hash to the roots the proof claims.
    const treeUpdate = this.planTreeUpdate(output, metadata);

    // 2b. WAL: write entry BEFORE applying mutations (crash-safe durability)
    const walPartitionIndex = this.partitionConfig?.partitionIndex ?? 0;
    let walEntryId: string | undefined;
    if (this.walProvider) {
      walEntryId = await this.walProvider.append({
        type: 'proof',
        partitionIndex: walPartitionIndex,
        sequenceNumber: this.nextSequenceNumber,
        walletId: output.walletId.toString(),
        proofJson: l2Stringify(proof),
        claimEntryData: metadata ? (metadata as unknown as Record<string, unknown>) : undefined,
        stateSnapshot: {
          registryRoot: this.currentRegistryRoot.toString(),
          lifecycleRoot: this.currentLifecycleRoot.toString(),
          walletCount: this.currentWalletCount.toString(),
          auditChainHash: this.latestChainHash.toString(),
        },
        timestamp: Date.now(),
      });
    }

    // 2c. The WAL append awaited; another change may have landed in the meantime.
    if (oldRegRoot.toString() !== this.currentRegistryRoot.toString() ||
        oldLifeRoot.toString() !== this.currentLifecycleRoot.toString()) {
      throw new Error('Registry root mismatch: state changed while the proof was being logged — rebuild the proof against the current roots');
    }

    // 3. Apply the transition to the witness trees, then take the roots from the trees.
    const isRegistration = treeUpdate.kind === 'registration';
    treeUpdate.apply();
    this.currentRegistryRoot = output.newRegistryRoot;
    this.currentLifecycleRoot = output.newLifecycleRoot;
    this.assertTreesMatchRoots('after applying a proof');

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
      ndcHash: metadata?.ndcHash,  // Drug identity committed in Poseidon hash chain
    };

    const eventCommitment = AuditService.computeEventCommitment(auditEvent);
    const chainHash = AuditService.computeChainHash(this.latestChainHash, eventCommitment);

    auditEvent.eventCommitment = eventCommitment.toString();
    auditEvent.chainHash = chainHash.toString();
    this.latestChainHash = chainHash;

    this.auditLog.push(auditEvent);
    this.auditMerkleIndex.appendEventFromCommitment(eventCommitment);
    receipt.auditEventHash = chainHash.toString();

    this.receipts.set(receiptId, receipt);

    // 6b. Append to Claim Accumulator Tree (if claim metadata provided). Metadata that only
    //     carries newCredentialInventoryRoot (credential mint, PCP update) is not a claim.
    if (metadata && metadata.memberWalletId && metadata.ndcHash) {
      const claimEntry = this.claimAccumulator.appendClaim(
        {
          memberWalletId: metadata.memberWalletId,
          ndcHash: metadata.ndcHash,
          pharmacyWalletId: metadata.pharmacyWalletId,
          prescriberWalletId: metadata.prescriberWalletId,
          dateOfService: metadata.dateOfService,
          patientPayCents: metadata.patientPayCents,
          planPayCents: metadata.planPayCents,
          operationType: metadata.operationType,
          deductibleCreditCents: metadata.deductibleCreditCents ?? '0',
        },
        {
          receiptId,
          timestamp: receipt.acceptedAt,
          dateOfService: metadata.dateOfService,
          ndc: metadata.ndc,
          brandName: metadata.brandName,
          tierLevel: metadata.tierLevel,
          gpi: metadata.gpi,
          therapeuticClass: metadata.therapeuticClass,
          daysSupply: metadata.daysSupply,
          fillNumber: metadata.fillNumber,
          planIdHash: metadata.planIdHash,
        },
      );
      receipt.claimLeafIndex = claimEntry.leafIndex;
    }

    // 7. Queue in pending pool
    this.pendingPool.push({ sequenceNumber, proof, receipt });

    // Persist receipt as proof metadata
    await this.store.saveProof(receiptId, l2Stringify(receipt));

    // WAL: commit entry (mutations applied successfully)
    if (this.walProvider && walEntryId) {
      await this.walProvider.commit(walEntryId);
    }

    return receipt;
  }

  /**
   * Build a batch from pending proofs.
   *
   * 1. Drains an even number of transitions (wrapPair requires pairs)
   * 2. wrapPair() each pair of consecutive transitions
   * 3. Tree-merge into single BatchProof (log2(N/2) rounds)
   * 4. Creates L2Block + L2Batch metadata
   * 5. Updates receipt statuses to 'batched'
   *
   * @returns L2Batch with the BatchProof JSON, or null if fewer than 2 pending
   */
  async buildBatch(): Promise<L2Batch | null> {
    if (this.inFlightBatchNumber !== null) {
      throw new Error(
        `Batch ${this.inFlightBatchNumber} is still in-flight. ` +
        `Call markBatchSettled() or markBatchFailed() before building a new batch.`,
      );
    }

    // L14 fix: Capture pre-batch snapshots BEFORE any draining or proving begins.
    // If the NEXT batch fails, rollback uses these snapshots (which reflect the
    // state before THIS batch mutated anything). Previously captured AFTER settlement,
    // which meant rollback would use post-settlement state (wrong).
    this.preBatchAuditLogLength = this.auditLog.length;
    this.preBatchChainHash = this.latestChainHash;
    this.preBatchClaimLeafCount = this.claimAccumulator.getLeafCount();
    this.preBatchAuditMerkleLeafCount = this.auditMerkleIndex.getEventCount();
    this.preBatchFingerprints = new Set(this.seenProofFingerprints);
    this.preBatchWalletSnapshot = this.snapshotWallets();

    if (this.pendingPool.length === 0) {
      // Create an empty batch record so the UI shows that a batch cycle ran
      // but found nothing to process. No proof, no block, no settlement.
      const emptyBatchNumber = this.nextBatchNumber++;
      const emptyBatch: L2Batch = {
        batchNumber: emptyBatchNumber,
        blockNumbers: [],
        registrationCount: 0,
        transitionCount: 0,
        oldRegistryRoot: this.currentRegistryRoot.toString(),
        newRegistryRoot: this.currentRegistryRoot.toString(),
        oldLifecycleRoot: this.currentLifecycleRoot.toString(),
        newLifecycleRoot: this.currentLifecycleRoot.toString(),
        batchProofJson: '',
        createdAt: Date.now(),
        l1Status: 'settled',   // nothing to settle
        l1TxHash: `empty-${emptyBatchNumber}`,
        claimAccumulatorRoot: this.claimAccumulator.getRoot().toString(),
        messageStoreRoot: this.messageStore.getRoot().toString(),
        providerRegistryRoot: this.providerRegistry.getRoot().toString(),
      };
      this.batches.set(emptyBatchNumber, emptyBatch);
      return emptyBatch;
    }

    // 1. Drain transitions — only take the longest chainable prefix.
    // Root discontinuities can occur when applyAdminRootUpdate() changes lifecycle/registry
    // roots between proof submissions (e.g., enrollment lifecycle advancement REGISTERED→ELIGIBLE).
    // Unchainable transitions stay in the pool for the next batch cycle.
    const available = Math.min(this.pendingPool.length, MAX_TRANSITIONS_PER_BATCH);
    let chainableCount = 1; // First transition is always chainable
    for (let i = 1; i < available; i++) {
      const prev = this.pendingPool[i - 1].proof.publicOutput;
      const curr = this.pendingPool[i].proof.publicOutput;
      if (prev.newRegistryRoot.toString() !== curr.oldRegistryRoot.toString() ||
          prev.newLifecycleRoot.toString() !== curr.oldLifecycleRoot.toString()) {
        break; // Root discontinuity — stop here
      }
      chainableCount++;
    }
    const drainCount = chainableCount >= 2
      ? chainableCount - (chainableCount % 2)  // Even count for wrapPair
      : chainableCount;                         // Single transition → wrapSingle
    const transitions = this.pendingPool.splice(0, drainCount);

    // 2. Build base-case BatchProofs
    let finalProof: BatchProof;
    try {
      if (transitions.length === 1) {
        // Single transition — use wrapSingle (same proof passed as both args for uniform arity)
        const wrapped = await BatchProgram.wrapSingle(
          transitions[0].proof,
          transitions[0].proof,
        );
        finalProof = wrapped.proof as BatchProof;
      } else {
        // Pair transitions and wrap each pair into a BatchProof
        const wrappedProofs: BatchProof[] = [];
        for (let i = 0; i < transitions.length; i += 2) {
          const wrapped = await BatchProgram.wrapPair(
            transitions[i].proof,
            transitions[i + 1].proof,
          );
          wrappedProofs.push(wrapped.proof as BatchProof);
        }

        // 3. Tree-merge: pair-wise merge until single proof remains
        let currentLevel = wrappedProofs;
        while (currentLevel.length > 1) {
          const nextLevel: BatchProof[] = [];
          for (let i = 0; i < currentLevel.length; i += 2) {
            if (i + 1 < currentLevel.length) {
              const merged = await BatchProgram.mergeBatches(
                currentLevel[i],
                currentLevel[i + 1],
              );
              nextLevel.push(merged.proof as BatchProof);
            } else {
              nextLevel.push(currentLevel[i]);
            }
          }
          currentLevel = nextLevel;
        }

        finalProof = currentLevel[0];
      }
    } catch (err) {
      // Restore transitions to the front of the pending pool so they aren't lost.
      this.pendingPool.unshift(...transitions);
      throw err;
    }
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
      claimAccumulatorRoot: this.claimAccumulator.getRoot().toString(),
      messageStoreRoot: this.messageStore.getRoot().toString(),
      providerRegistryRoot: this.providerRegistry.getRoot().toString(),
    };

    this.batches.set(batchNumber, batch);

    // 5. Produce ChainProof (if admin state is configured)
    if (this.adminState) {
      await this.produceChainProof(finalProof, batch);
    }

    // 6. Update receipt statuses
    for (const t of transitions) {
      t.receipt.l1Status = 'batched';
      t.receipt.l2BlockNumber = blockNumber;
      t.receipt.l1BatchNumber = batchNumber;
      this.receipts.set(t.receipt.receiptId, t.receipt);
    }

    // 7. Sync audit events with batch metadata
    this.markAuditEventsBatched(receiptIds, batchNumber, blockNumber);

    // Persist batch metadata
    await this.store.saveProof(
      `batch-${batchNumber}`,
      l2Stringify(batch),
    );

    if (this.l2Only) {
      // L2-only: batch is immediately final — no L1 settlement needed.
      // Update statuses to 'settled' and advance last-settled roots.
      batch.l1Status = 'settled';
      batch.l1TxHash = `l2-final-${batchNumber}`;
      block.l1Status = 'settled';
      block.l1TxHash = batch.l1TxHash;
      for (const t of transitions) {
        t.receipt.l1Status = 'settled';
        this.receipts.set(t.receipt.receiptId, t.receipt);
      }
      this.markAuditEventsStatus(batch, 'settled');
      this.lastSettledRegistryRoot = this.currentRegistryRoot;
      this.lastSettledLifecycleRoot = this.currentLifecycleRoot;
      this.lastSettledWalletCount = this.currentWalletCount;
      // No in-flight guard — next batch can build immediately
      this.evictOldEntries();
    } else {
      // Mark as in-flight (must settle or fail before next buildBatch)
      this.inFlightBatchNumber = batchNumber;
    }

    return batch;
  }

  // ─── Split Batch API (for ProvingPool) ──────────────────

  /**
   * Phase 1 of the split-batch flow: drain the pending pool, serialize
   * transitions, and package into a ProvingJobRequest.
   *
   * Returns null if there are no pending transitions or an empty batch
   * was created (no proving needed). The drained transitions are held
   * internally and must be finalized via finalizeBatch() or restored
   * via restoreDrainedTransitions() on failure.
   *
   * @returns { job, emptyBatch? } — job is null when no proving is needed
   */
  prepareBatch(): {
    job: ProvingJobRequest | null;
    emptyBatch: L2Batch | null;
  } {
    if (this.inFlightBatchNumber !== null) {
      throw new Error(
        `Batch ${this.inFlightBatchNumber} is still in-flight. ` +
        `Call markBatchSettled() or markBatchFailed() before building a new batch.`,
      );
    }

    // L14 fix: Capture pre-batch snapshots BEFORE any draining or proving begins.
    this.preBatchAuditLogLength = this.auditLog.length;
    this.preBatchChainHash = this.latestChainHash;
    this.preBatchClaimLeafCount = this.claimAccumulator.getLeafCount();
    this.preBatchAuditMerkleLeafCount = this.auditMerkleIndex.getEventCount();
    this.preBatchFingerprints = new Set(this.seenProofFingerprints);
    this.preBatchWalletSnapshot = this.snapshotWallets();

    // Empty pool — create empty batch record (no proving needed)
    if (this.pendingPool.length === 0) {
      const emptyBatchNumber = this.nextBatchNumber++;
      const emptyBatch: L2Batch = {
        batchNumber: emptyBatchNumber,
        blockNumbers: [],
        registrationCount: 0,
        transitionCount: 0,
        oldRegistryRoot: this.currentRegistryRoot.toString(),
        newRegistryRoot: this.currentRegistryRoot.toString(),
        oldLifecycleRoot: this.currentLifecycleRoot.toString(),
        newLifecycleRoot: this.currentLifecycleRoot.toString(),
        batchProofJson: '',
        createdAt: Date.now(),
        l1Status: 'settled',
        l1TxHash: `empty-${emptyBatchNumber}`,
        claimAccumulatorRoot: this.claimAccumulator.getRoot().toString(),
        messageStoreRoot: this.messageStore.getRoot().toString(),
        providerRegistryRoot: this.providerRegistry.getRoot().toString(),
      };
      this.batches.set(emptyBatchNumber, emptyBatch);
      return { job: null, emptyBatch };
    }

    // Chainability check + drain (identical to buildBatch Phase A)
    const available = Math.min(this.pendingPool.length, MAX_TRANSITIONS_PER_BATCH);
    let chainableCount = 1;
    for (let i = 1; i < available; i++) {
      const prev = this.pendingPool[i - 1].proof.publicOutput;
      const curr = this.pendingPool[i].proof.publicOutput;
      if (prev.newRegistryRoot.toString() !== curr.oldRegistryRoot.toString() ||
          prev.newLifecycleRoot.toString() !== curr.oldLifecycleRoot.toString()) {
        break;
      }
      chainableCount++;
    }
    const drainCount = chainableCount >= 2
      ? chainableCount - (chainableCount % 2)
      : chainableCount;
    this.drainedTransitions = this.pendingPool.splice(0, drainCount);

    // Serialize transitions for IPC
    const transitionProofJsons = this.drainedTransitions.map(
      (t) => t.proof.toJSON(),
    );

    // Package admin state + chain proof context
    const job: ProvingJobRequest = {
      transitionProofJsons,
      latestChainHash: this.latestChainHash.toString(),
    };

    if (this.adminState) {
      job.adminState = {
        adminPublicKeyHash: this.adminState.adminPublicKeyHash.toString(),
        benefitPlanRoot: this.adminState.benefitPlanRoot.toString(),
        credentialRegistryRoot: this.adminState.credentialRegistryRoot.toString(),
        eligibilityVkHash: this.adminState.eligibilityVkHash.toString(),
        messagingRoot: this.adminState.messagingRoot.toString(),
      };
      job.latestChainProofJson = this.latestChainProofJson;
    }

    return { job, emptyBatch: null };
  }

  /**
   * Phase 3 of the split-batch flow: finalize the batch using the
   * proving result from the worker.
   *
   * Must be called after prepareBatch() returned a non-null job and
   * the proving pool returned a ProvingJobResult.
   */
  async finalizeBatch(result: ProvingJobResult): Promise<L2Batch> {
    const transitions = this.drainedTransitions;

    if (transitions.length === 0) {
      throw new Error('finalizeBatch: no drained transitions — call prepareBatch() first');
    }

    // NOTE: drainedTransitions is NOT cleared here. It stays populated so that
    // if any operation below throws, the caller's catch block can still call
    // restoreDrainedTransitions() to recover them. Cleared only on success below.

    // Create L2Block from result output
    const blockNumber = this.nextBlockNumber++;
    const receiptIds = transitions.map((t) => t.receipt.receiptId);

    const block: L2Block = {
      blockNumber,
      receiptIds,
      startRegistryRoot: result.batchOutput.oldRegistryRoot,
      endRegistryRoot: result.batchOutput.newRegistryRoot,
      startLifecycleRoot: result.batchOutput.oldLifecycleRoot,
      endLifecycleRoot: result.batchOutput.newLifecycleRoot,
      registrationCount: Number(result.batchOutput.registrationCount),
      transitionCount: Number(result.batchOutput.transitionCount),
      createdAt: Date.now(),
      l1Status: 'batched',
    };

    this.blocks.set(blockNumber, block);

    // Create L2Batch
    const batchNumber = this.nextBatchNumber++;

    const batch: L2Batch = {
      batchNumber,
      blockNumbers: [blockNumber],
      registrationCount: block.registrationCount,
      transitionCount: block.transitionCount,
      oldRegistryRoot: result.batchOutput.oldRegistryRoot,
      newRegistryRoot: result.batchOutput.newRegistryRoot,
      oldLifecycleRoot: result.batchOutput.oldLifecycleRoot,
      newLifecycleRoot: result.batchOutput.newLifecycleRoot,
      batchProofJson: result.batchProofJson,
      createdAt: Date.now(),
      l1Status: 'batched',
      claimAccumulatorRoot: this.claimAccumulator.getRoot().toString(),
      messageStoreRoot: this.messageStore.getRoot().toString(),
      providerRegistryRoot: this.providerRegistry.getRoot().toString(),
      workerId: result.workerId,
      proveTimeMs: result.proveTimeMs,
    };

    this.batches.set(batchNumber, batch);

    // Apply chain proof result (if produced by worker)
    if (result.chainProofJson && result.chainOutput) {
      this.latestChainProofJson = result.chainProofJson;
      this.latestChainProof = null; // Lazy reconstruct on next advance
      this.currentBlockHeight = Field(BigInt(result.chainOutput.blockHeight));
      this.currentGlobalStateRoot = Field(BigInt(result.chainOutput.globalStateRoot));
      batch.chainProofJson = result.chainProofJson;
      batch.globalStateRoot = result.chainOutput.globalStateRoot;
      batch.blockHeight = BigInt(result.chainOutput.blockHeight);
    }

    // Update receipt statuses
    for (const t of transitions) {
      t.receipt.l1Status = 'batched';
      t.receipt.l2BlockNumber = blockNumber;
      t.receipt.l1BatchNumber = batchNumber;
      this.receipts.set(t.receipt.receiptId, t.receipt);
    }

    // Sync audit events with batch metadata
    this.markAuditEventsBatched(receiptIds, batchNumber, blockNumber);

    // Persist batch metadata
    await this.store.saveProof(
      `batch-${batchNumber}`,
      l2Stringify(batch),
    );

    if (this.l2Only) {
      // L2-only: batch is immediately final
      batch.l1Status = 'settled';
      batch.l1TxHash = `l2-final-${batchNumber}`;
      block.l1Status = 'settled';
      block.l1TxHash = batch.l1TxHash;
      for (const t of transitions) {
        t.receipt.l1Status = 'settled';
        this.receipts.set(t.receipt.receiptId, t.receipt);
      }
      this.markAuditEventsStatus(batch, 'settled');
      this.lastSettledRegistryRoot = this.currentRegistryRoot;
      this.lastSettledLifecycleRoot = this.currentLifecycleRoot;
      this.lastSettledWalletCount = this.currentWalletCount;
      this.evictOldEntries();
    } else {
      this.inFlightBatchNumber = batchNumber;
    }

    // Clear drained transitions only after all operations succeeded.
    // If any operation above threw, restoreDrainedTransitions() can still recover them.
    this.drainedTransitions = [];

    return batch;
  }

  /**
   * Restore drained transitions to the front of the pending pool.
   * Called when proving fails and the transitions should be retried.
   */
  restoreDrainedTransitions(): void {
    if (this.drainedTransitions.length > 0) {
      this.pendingPool.unshift(...this.drainedTransitions);
      this.drainedTransitions = [];
    }
  }

  /**
   * Evict old settled receipts and batches to bound memory growth.
   * Keeps the most recent `keepReceipts` settled entries (by timestamp).
   * Un-settled entries are never evicted (needed for retry/recovery).
   *
   * For batches: nulls out batchProofJson (large blob) on evicted entries
   * but keeps metadata. Safe because settled proofs are verified and
   * never re-submitted.
   */
  evictOldEntries(keepReceipts = 200, keepBatches = 50): {
    evictedReceipts: number;
    evictedBatches: number;
  } {
    let evictedReceipts = 0;
    let evictedBatches = 0;

    // Evict settled receipts beyond keepCount (oldest first by acceptedAt)
    const settledReceipts = Array.from(this.receipts.entries())
      .filter(([, r]) => r.l1Status === 'settled')
      .sort((a, b) => a[1].acceptedAt - b[1].acceptedAt);

    if (settledReceipts.length > keepReceipts) {
      const toEvict = settledReceipts.slice(0, settledReceipts.length - keepReceipts);
      for (const [id] of toEvict) {
        this.receipts.delete(id);
        evictedReceipts++;
      }
    }

    // Evict old settled batches — null out proof blobs but keep metadata
    const settledBatches = Array.from(this.batches.entries())
      .filter(([, b]) => b.l1Status === 'settled' && b.batchProofJson !== '')
      .sort((a, b) => a[1].createdAt - b[1].createdAt);

    if (settledBatches.length > keepBatches) {
      const toEvict = settledBatches.slice(0, settledBatches.length - keepBatches);
      for (const [, batch] of toEvict) {
        batch.batchProofJson = '';
        if (batch.chainProofJson) batch.chainProofJson = '';
        evictedBatches++;
      }
    }

    return { evictedReceipts, evictedBatches };
  }

  /**
   * Produce a ChainProof from a BatchProof.
   *
   * First batch → ChainProgram.genesis() (block 0)
   * Subsequent batches → ChainProgram.advance() (block N from block N-1)
   *
   * Updates the batch metadata with chainProofJson, globalStateRoot,
   * and blockHeight. Stores the ChainProof for the next advance() call.
   */
  private async produceChainProof(
    batchProof: BatchProof,
    batch: L2Batch,
  ): Promise<void> {
    const admin = this.adminState!;

    let chainResult: { proof: unknown; publicOutput?: unknown };

    // M8 fix: Lazy reconstruction of ChainProof from checkpoint JSON.
    // After crash recovery, latestChainProof is null but latestChainProofJson
    // is preserved. Reconstruct the proof object to continue the chain
    // (advance) instead of starting a discontinuous new segment (genesis).
    if (this.latestChainProof === null && this.latestChainProofJson !== null) {
      try {
        const proofJson = JSON.parse(this.latestChainProofJson);
        this.latestChainProof = (await ChainProof.fromJSON(proofJson)) as ChainProof;
      } catch {
        // If reconstruction fails (e.g., circuit not compiled), fall through to genesis
        this.latestChainProof = null;
        this.latestChainProofJson = null;
      }
    }

    if (this.latestChainProof === null) {
      // Genesis — first block (block 0)
      chainResult = await ChainProgram.genesis(
        batchProof,
        admin.adminPublicKeyHash,
        admin.benefitPlanRoot,
        admin.credentialRegistryRoot,
        admin.eligibilityVkHash,
        admin.messagingRoot,
        this.latestChainHash,
      );
    } else {
      // Advance — block N from block N-1
      chainResult = await ChainProgram.advance(
        this.latestChainProof,
        batchProof,
        admin.adminPublicKeyHash,
        admin.benefitPlanRoot,
        admin.credentialRegistryRoot,
        admin.eligibilityVkHash,
        admin.messagingRoot,
        this.latestChainHash,
      );
    }

    const chainProof = chainResult.proof as ChainProof;
    const chainOutput = chainProof.publicOutput as unknown as ChainOutput;

    // Store the chain proof for the next advance() call
    this.latestChainProof = chainProof;
    this.latestChainProofJson = JSON.stringify(chainProof.toJSON());
    this.currentBlockHeight = chainOutput.blockHeight;
    this.currentGlobalStateRoot = chainOutput.globalStateRoot;

    // Attach chain proof data to the batch
    batch.chainProofJson = this.latestChainProofJson;
    batch.globalStateRoot = chainOutput.globalStateRoot.toString();
    batch.blockHeight = chainOutput.blockHeight.toBigInt();
  }

  /**
   * Mark a batch as settled on L1.
   *
   * Called after CareContract.settleBatch() transaction is confirmed.
   * Updates all associated receipts and blocks to 'settled' status.
   */
  markBatchSettled(batchNumber: bigint, l1TxHash: string): void {
    if (this.l2Only) {
      throw new Error('L2-only mode: batches are finalized at build time, markBatchSettled is not available');
    }

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

    // M7 fix: Update audit events to 'settled' status
    this.markAuditEventsStatus(batch, 'settled');

    // Track last-settled state — this is the crash recovery safe point.
    // L1 is now at these roots after settleBatch() confirmed.
    this.lastSettledRegistryRoot = Field(BigInt(batch.newRegistryRoot));
    this.lastSettledLifecycleRoot = Field(BigInt(batch.newLifecycleRoot));
    this.lastSettledWalletCount = Field(
      this.lastSettledWalletCount.toBigInt() + BigInt(batch.registrationCount),
    );

    // H5 fix: Update rollback snapshots — settled state is the new safe point
    this.preBatchAuditLogLength = this.auditLog.length;
    this.preBatchChainHash = this.latestChainHash;
    this.preBatchClaimLeafCount = this.claimAccumulator.getLeafCount();
    this.preBatchAuditMerkleLeafCount = this.auditMerkleIndex.getEventCount();
    // Snapshot witness tree state for rollback
    this.preBatchWalletSnapshot = this.snapshotWallets();

    // Evict settled fingerprints — rebuild from pending pool only.
    // Settled proofs are protected by L1 root chain (replay impossible).
    this.seenProofFingerprints = this.rebuildFingerprintsFromPending();
    this.preBatchFingerprints = new Set(this.seenProofFingerprints);

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
    if (this.l2Only) {
      throw new Error('L2-only mode: batches are finalized at build time, markBatchFailed is not available');
    }

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

    // Roll back all mutable state to the pre-batch snapshot
    this.rollbackBatchState();

    this.inFlightBatchNumber = null;
  }

  /**
   * Roll back all mutable sequencer state to pre-batch snapshots.
   *
   * Restores: roots, wallet count, audit log, audit chain hash,
   * audit Merkle index, claim accumulator, fingerprints, and witness trees.
   *
   * Called from markBatchFailed() and applyReplicatedBatchFailure() to
   * ensure both the sequencer and replicas converge to the same state
   * after a batch failure.
   */
  private rollbackBatchState(): void {
    // H3 fix: Roll back current roots to last-settled state.
    // After a failed batch, L1 is still at lastSettled roots. New proofs must
    // chain from there, not from the failed batch's end-state.
    this.currentRegistryRoot = this.lastSettledRegistryRoot;
    this.currentLifecycleRoot = this.lastSettledLifecycleRoot;
    this.currentWalletCount = this.lastSettledWalletCount;

    // H5 fix: Roll back audit chain, claim accumulator, and fingerprints
    // to the pre-batch snapshot so the next batch starts from a clean state.
    this.auditLog.length = this.preBatchAuditLogLength;
    this.latestChainHash = this.preBatchChainHash;

    // Roll back audit Merkle index if new leaves were added during the failed batch
    if (this.auditMerkleIndex.getEventCount() > this.preBatchAuditMerkleLeafCount) {
      const amState = this.auditMerkleIndex.exportState();
      amState.eventCommitments = amState.eventCommitments.slice(
        0, Number(this.preBatchAuditMerkleLeafCount),
      );
      amState.nextLeafIndex = this.preBatchAuditMerkleLeafCount;
      this.auditMerkleIndex.restoreState(amState);
    }

    // Roll back claim accumulator if new leaves were added during the failed batch
    if (this.claimAccumulator.getLeafCount() > this.preBatchClaimLeafCount) {
      const accState = this.claimAccumulator.exportState();
      accState.entries = accState.entries.filter(
        e => e.leafIndex < this.preBatchClaimLeafCount,
      );
      accState.nextLeafIndex = this.preBatchClaimLeafCount;
      this.claimAccumulator.restoreState(accState);
    }

    // Roll back fingerprints — allow resubmission of proofs from the failed batch
    this.seenProofFingerprints = new Set(this.preBatchFingerprints);

    // Roll back witness trees to pre-batch snapshot.
    // Rebuild from snapshot to ensure materialized trees match scalar roots.
    this.walletRegistry = new WalletRegistry();
    this.lifecycleTree = new MerkleTree(WALLET_TREE_HEIGHT);
    this.walletLifecycleStates = new Map();
    for (const [walletIdStr, snap] of this.preBatchWalletSnapshot) {
      const walletId = Field(BigInt(walletIdStr));
      const lcState = Field(snap.lifecycleState);
      const regIndex = this.walletRegistry.register(walletId);
      this.lifecycleTree.setLeaf(
        regIndex,
        lifecycleLeafCommitment(walletId, lcState),
      );
      this.walletLifecycleStates.set(walletIdStr, lcState);
      if (snap.credentialInventoryRoot !== undefined && snap.nonce !== undefined) {
        this.walletRegistry.updateState(walletId, new WalletState({
          walletId,
          credentialInventoryRoot: Field(BigInt(snap.credentialInventoryRoot)),
          nonce: Field(BigInt(snap.nonce)),
        }));
      }
    }
  }

  /** Snapshot every registered wallet (lifecycle + state) in registration order. */
  private snapshotWallets(): Map<string, { walletId: string; lifecycleState: bigint; credentialInventoryRoot?: string; nonce?: string }> {
    const snap = new Map<string, { walletId: string; lifecycleState: bigint; credentialInventoryRoot?: string; nonce?: string }>();
    for (const [walletIdStr, lcState] of this.walletLifecycleStates) {
      const entry: { walletId: string; lifecycleState: bigint; credentialInventoryRoot?: string; nonce?: string } = { walletId: walletIdStr, lifecycleState: lcState.toBigInt() };
      const wid = Field(BigInt(walletIdStr));
      if (this.walletRegistry.isRegistered(wid)) {
        const st = this.walletRegistry.getState(wid);
        entry.credentialInventoryRoot = st.credentialInventoryRoot.toString();
        entry.nonce = st.nonce.toString();
      }
      snap.set(walletIdStr, entry);
    }
    return snap;
  }

  /** Rebuild fingerprint set from only the current pending pool entries. */
  private rebuildFingerprintsFromPending(): Set<string> {
    const fps = new Set<string>();
    for (const t of this.pendingPool) {
      const o = t.proof.publicOutput as unknown as TransitionOutput;
      fps.add(`${o.walletId}:${o.oldRegistryRoot}:${o.newRegistryRoot}:${o.oldLifecycleRoot}:${o.newLifecycleRoot}`);
    }
    return fps;
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
    if (this.l2Only) {
      throw new Error('L2-only mode: batches are finalized at build time, retryBatch is not available');
    }
    if (this.pendingPool.length > 0) {
      throw new Error('Cannot retry batch while pending pool is non-empty');
    }

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

    // H3 fix: Fast-forward current roots to batch's end-state for retry.
    // The batch proof is anchored to these roots — L1 will verify them.
    this.currentRegistryRoot = Field(BigInt(batch.newRegistryRoot));
    this.currentLifecycleRoot = Field(BigInt(batch.newLifecycleRoot));
    this.currentWalletCount = Field(
      this.lastSettledWalletCount.toBigInt() + BigInt(batch.registrationCount),
    );

    this.inFlightBatchNumber = batchNumber;

    return batch;
  }

  // ─── Admin Root Sync ───────────────────────────────────

  /**
   * Apply admin root update (lifecycle transitions, benefit plan changes).
   * Simulates sequencer observing an admin op settling on L1.
   *
   * Purges stale transitions from the pending pool when the admin update
   * creates a root gap. These transitions were already applied to state
   * via submitProof() — their effects are reflected in the roots that
   * this admin update is now superseding.
   */
  applyAdminRootUpdate(opts: {
    newLifecycleRoot?: Field;
    newRegistryRoot?: Field;
    /** Pre-provisioned wallets to sync into internal witness trees (admin-enrolled entities). */
    provisionedWallets?: Array<{ walletId: Field; lifecycleState: Field }>;
  }): void {
    // Kept for compatibility. The roots are always taken from the sequencer's own trees;
    // a caller-supplied root is only checked against them, never copied in.
    this.adminMutate('applyAdminRootUpdate', ({ provision }) => {
      for (const pw of opts.provisionedWallets ?? []) provision(pw.walletId, pw.lifecycleState);
    });
    const mismatch: string[] = [];
    if (opts.newRegistryRoot && opts.newRegistryRoot.toString() !== this.currentRegistryRoot.toString()) mismatch.push('registry');
    if (opts.newLifecycleRoot && opts.newLifecycleRoot.toString() !== this.currentLifecycleRoot.toString()) mismatch.push('lifecycle');
    if (mismatch.length) {
      throw new Error(
        `applyAdminRootUpdate: the supplied ${mismatch.join(' and ')} root does not match the sequencer's tree. ` +
        'Apply leaf changes through adminMutate() instead of passing roots.',
      );
    }
  }

  // ─── Single source of truth for wallet state ───────────

  /**
   * The sequencer's registry and lifecycle trees. In-process services (the adjudication
   * engine, EnrollmentService) read witnesses and wallet state from these objects.
   * Any change to them must happen inside adminMutate(), which re-derives the roots.
   */
  getStateTrees(): { registry: WalletRegistry; lifecycle: MerkleTree } {
    return { registry: this.walletRegistry, lifecycle: this.lifecycleTree };
  }

  /**
   * Apply an insurer-side (admin) change to the wallet trees — provisioning providers,
   * advancing lifecycle (REGISTERED → ELIGIBLE), revoking at termination — and take the
   * published roots from the trees afterwards. `fn` must be synchronous so no proof can
   * be accepted between the tree change and the root update.
   *
   * Transitions already in the pending pool are not discarded: the batch builder takes
   * the chainable prefix, so they are still batch-proven.
   */
  adminMutate<T>(
    reason: string,
    fn: (ctx: {
      registry: WalletRegistry;
      lifecycle: MerkleTree;
      /** Register (if new) and set the lifecycle state of a wallet. */
      provision: (walletId: Field, lifecycleState: Field) => bigint;
      /** Set the lifecycle state of a registered wallet. */
      setLifecycle: (walletId: Field, lifecycleState: Field) => void;
      /** Replace a registered wallet's state (credential inventory root, nonce). */
      setWalletState: (walletId: Field, state: WalletState) => void;
    }) => T,
  ): T {
    const before = { reg: this.currentRegistryRoot.toString(), lc: this.currentLifecycleRoot.toString() };
    const setLifecycle = (walletId: Field, lifecycleState: Field) => {
      const idx = this.walletRegistry.getIndex(walletId);
      this.lifecycleTree.setLeaf(idx, lifecycleLeafCommitment(walletId, lifecycleState));
      this.walletLifecycleStates.set(walletId.toString(), lifecycleState);
    };
    const provision = (walletId: Field, lifecycleState: Field): bigint => {
      if (!this.walletRegistry.isRegistered(walletId)) this.walletRegistry.register(walletId);
      setLifecycle(walletId, lifecycleState);
      return this.walletRegistry.getIndex(walletId);
    };
    const setWalletState = (walletId: Field, state: WalletState) => this.walletRegistry.updateState(walletId, state);

    const result = fn({ registry: this.walletRegistry, lifecycle: this.lifecycleTree, provision, setLifecycle, setWalletState });
    if (result && typeof (result as any).then === 'function') {
      throw new Error(`adminMutate(${reason}): fn must be synchronous`);
    }

    this.currentRegistryRoot = this.walletRegistry.getRoot();
    this.currentLifecycleRoot = this.lifecycleTree.getRoot();
    this.currentWalletCount = Field(this.walletRegistry.count);
    this.treesAuthoritative = true;
    if (before.reg !== this.currentRegistryRoot.toString() || before.lc !== this.currentLifecycleRoot.toString()) {
      this.adminChangeLog.push({ reason, at: Date.now(), ...before, newReg: this.currentRegistryRoot.toString(), newLc: this.currentLifecycleRoot.toString() });
      if (this.adminChangeLog.length > 1000) this.adminChangeLog.splice(0, this.adminChangeLog.length - 1000);
    }
    return result;
  }

  /** Admin changes applied through adminMutate (most recent 1,000). */
  private adminChangeLog: Array<{ reason: string; at: number; reg: string; lc: string; newReg: string; newLc: string }> = [];
  getAdminChangeLog() { return [...this.adminChangeLog]; }

  /** True when the witness trees hash to the published roots. */
  treesMatchRoots(): boolean {
    return this.walletRegistry.getRoot().toString() === this.currentRegistryRoot.toString() &&
      this.lifecycleTree.getRoot().toString() === this.currentLifecycleRoot.toString();
  }

  /** Throw if the witness trees and the published roots have diverged. */
  private assertTreesMatchRoots(context: string): void {
    if (this.treesMatchRoots()) return;
    const msg = `Wallet state divergence ${context}: registry tree ${this.walletRegistry.getRoot()} vs root ${this.currentRegistryRoot}, ` +
      `lifecycle tree ${this.lifecycleTree.getRoot()} vs root ${this.currentLifecycleRoot}`;
    if (!this.treesAuthoritative) {
      console.warn(`[sequencer] ${msg} (trees not rebuilt after restore — not enforced)`);
      return;
    }
    throw new Error(msg);
  }

  /**
   * Decide how a transition changes the witness trees and check, without mutating
   * anything, that the result hashes to the roots the proof claims.
   */
  private planTreeUpdate(
    output: TransitionOutput,
    metadata?: ClaimSubmissionMetadata,
  ): { kind: 'registration' | 'update' | 'none'; apply: () => void } {
    const wid = output.walletId;
    const registryChanged = output.oldRegistryRoot.toString() !== output.newRegistryRoot.toString();
    const lifecycleChanged = output.oldLifecycleRoot.toString() !== output.newLifecycleRoot.toString();
    const enforce = this.treesAuthoritative;

    if (registryChanged && lifecycleChanged) {
      if (this.walletRegistry.isRegistered(wid)) {
        throw new Error(`Wallet already registered: ${wid.toString()}`);
      }
      const index = BigInt(this.walletRegistry.count);
      const expectedReg = this.walletRegistry.getNextSlotWitness().calculateRoot(WalletState.init(wid).commitment());
      const lcLeaf = lifecycleLeafCommitment(wid, LIFECYCLE_REGISTERED);
      const expectedLc = new LifecycleWitness(this.lifecycleTree.getWitness(index)).calculateRoot(lcLeaf);
      if (enforce && (expectedReg.toString() !== output.newRegistryRoot.toString() ||
          expectedLc.toString() !== output.newLifecycleRoot.toString())) {
        throw new Error('Registration does not match the sequencer tree: the proof was built against a different slot or root');
      }
      return {
        kind: 'registration',
        apply: () => {
          this.walletRegistry.register(wid);
          this.lifecycleTree.setLeaf(index, lcLeaf);
          this.walletLifecycleStates.set(wid.toString(), LIFECYCLE_REGISTERED);
          this.currentWalletCount = this.currentWalletCount.add(1);
        },
      };
    }

    if (registryChanged) {
      const newCred = (metadata as any)?.newCredentialInventoryRoot;
      if (!this.walletRegistry.isRegistered(wid) || !newCred) {
        if (!enforce) return { kind: 'update', apply: () => {} };   // legacy, unenforced state
        if (!this.walletRegistry.isRegistered(wid)) {
          throw new Error(`Wallet update for an unregistered wallet: ${wid.toString()}`);
        }
        throw new Error('Wallet update rejected: submit newCredentialInventoryRoot with the proof so the sequencer can update its tree');
      }
      const oldState = this.walletRegistry.getState(wid);
      const newState = new WalletState({ walletId: wid, credentialInventoryRoot: Field(BigInt(newCred)), nonce: oldState.nonce.add(1) });
      const expected = this.walletRegistry.getWitness(wid).calculateRoot(newState.commitment());
      if (enforce && expected.toString() !== output.newRegistryRoot.toString()) {
        throw new Error('Wallet update does not match the sequencer tree: newCredentialInventoryRoot or nonce disagrees with the proof');
      }
      return { kind: 'update', apply: () => this.walletRegistry.updateState(wid, newState) };
    }

    if (lifecycleChanged) {
      if (!enforce) return { kind: 'none', apply: () => {} };   // legacy, unenforced state
      throw new Error('Lifecycle-only transitions are not accepted from proofs; lifecycle changes are admin operations');
    }
    return { kind: 'none', apply: () => {} };
  }

  /**
   * Reset sequencer to fresh state for replay.
   * Clears all accumulated receipts, batches, audit log, claim accumulator, and message store.
   * Caller must also call applyAdminRootUpdate() after rebuilding infrastructure trees
   * to sync the sequencer roots with the new service state.
   */
  resetForDemo(initialRegistryRoot: Field, initialLifecycleRoot: Field): void {
    this.currentRegistryRoot = initialRegistryRoot;
    this.currentLifecycleRoot = initialLifecycleRoot;
    this.currentWalletCount = Field(0);
    this.pendingPool = [];
    this.nextSequenceNumber = 0n;
    this.receipts.clear();
    this.blocks.clear();
    this.batches.clear();
    this.nextBlockNumber = 0n;
    this.nextBatchNumber = 0n;
    this.adminQueue = [];
    this.auditLog = [];
    this.latestChainHash = Field(0);
    this.inFlightBatchNumber = null;
    this.latestChainProof = null;
    this.latestChainProofJson = null;
    this.currentBlockHeight = Field(0);
    this.currentGlobalStateRoot = Field(0);
    this.auditMerkleIndex = new AuditMerkleIndex();
    this.claimAccumulator = new ClaimAccumulatorService();
    this.messageStore = new MessageStoreService();
    this.seenProofFingerprints.clear();
    this.walletRegistry = new WalletRegistry();
    this.lifecycleTree = new MerkleTree(WALLET_TREE_HEIGHT);
    this.walletLifecycleStates = new Map();
    // Roots always come from the (now empty) trees. Callers re-fetch getStateTrees().
    this.currentRegistryRoot = this.walletRegistry.getRoot();
    this.currentLifecycleRoot = this.lifecycleTree.getRoot();
    this.treesAuthoritative = true;
    this.preBatchAuditLogLength = 0;
    this.preBatchChainHash = Field(0);
    this.preBatchClaimLeafCount = 0n;
    this.preBatchAuditMerkleLeafCount = 0n;
    this.preBatchFingerprints.clear();
    this.preBatchWalletSnapshot = new Map();
    this.formularyStore.clear();
    this.planStore.clear();
    this.formularyService = new FormularyService();
    this.providerRegistry = new ProviderRegistryService();
    this.lastSettledRegistryRoot = initialRegistryRoot;
    this.lastSettledLifecycleRoot = initialLifecycleRoot;
    this.lastSettledWalletCount = Field(0);
  }

  /**
   * H4 fix: Sync L2 sequencer state from L1 after a direct L1 settlement
   * (e.g. settleTransition fallback or admin op that changed on-chain roots).
   *
   * Updates both current and last-settled roots, clears any in-flight batch,
   * and drains the pending pool (existing proofs chain from stale roots).
   *
   * @param newRegistryRoot — the registry root observed on L1
   * @param newLifecycleRoot — the lifecycle root observed on L1
   * @param newWalletCount — the wallet count observed on L1
   */
  syncFromL1(newRegistryRoot: Field, newLifecycleRoot: Field, newWalletCount: Field): void {
    if (this.l2Only) {
      throw new Error('L2-only mode: no L1 sync available');
    }

    // Update both current and last-settled to match L1
    this.currentRegistryRoot = newRegistryRoot;
    this.currentLifecycleRoot = newLifecycleRoot;
    this.currentWalletCount = newWalletCount;
    this.lastSettledRegistryRoot = newRegistryRoot;
    this.lastSettledLifecycleRoot = newLifecycleRoot;
    this.lastSettledWalletCount = newWalletCount;

    // Clear in-flight batch (if any) — it's no longer valid
    if (this.inFlightBatchNumber !== null) {
      const batch = this.batches.get(this.inFlightBatchNumber);
      if (batch) {
        batch.l1Status = 'failed';
        batch.failureReason = 'Invalidated by L1 sync';
        this.markAuditEventsStatus(batch, 'failed');
      }
      this.inFlightBatchNumber = null;
    }

    // Drain pending pool — proofs chain from stale roots
    this.pendingPool = [];
  }

  // ─── Chain Proof Configuration ──────────────────────────

  /**
   * Enable ChainProgram integration by setting the admin state fields.
   *
   * Once set, buildBatch() will produce a ChainProof after each BatchProof,
   * creating the recursive "picture of a picture" chain. Each ChainProof
   * commits a GlobalState root covering all 10 state fields.
   *
   * Call this before the first buildBatch() to enable chain proofs from
   * genesis, or at any time to start chaining from the next batch.
   */
  setAdminState(config: AdminStateConfig): void {
    if (this.inFlightBatchNumber !== null) {
      throw new Error('Cannot update admin state while a batch is in flight');
    }
    this.adminState = { ...config };
  }

  /** Get the current admin state config, or null if not set */
  getAdminState(): AdminStateConfig | null {
    return this.adminState ? { ...this.adminState } : null;
  }

  /**
   * Update a single admin state field.
   *
   * Used when an admin operation settles on L1 and the sequencer
   * needs to reflect the new value in subsequent GlobalState roots.
   */
  updateAdminField(field: keyof AdminStateConfig, value: Field): void {
    if (!this.adminState) {
      throw new Error('Admin state not configured — call setAdminState() first');
    }
    if (this.inFlightBatchNumber !== null) {
      throw new Error('Cannot update admin state while a batch is in flight');
    }
    this.adminState[field] = value;
  }

  /** Whether ChainProgram integration is enabled */
  isChainProofEnabled(): boolean {
    return this.adminState !== null;
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

  // ─── Formulary State ──────────────────────────────────

  /**
   * Store a published formulary for a plan.
   *
   * Called when the insurer publishes a formulary update.
   * Clients can retrieve this via l2_getFormulary RPC.
   */
  storeFormulary(
    planIdHash: string,
    formularyRoot: string,
    entriesJson: string,
  ): void {
    const existing = this.formularyStore.get(planIdHash);
    const version = existing ? existing.version + 1 : 1;
    this.formularyStore.set(planIdHash, {
      formularyRoot,
      entriesJson,
      publishedAt: Date.now(),
      version,
    });
  }

  /**
   * Retrieve a published formulary by plan ID hash.
   *
   * Returns null if no formulary has been published for this plan.
   */
  getFormulary(planIdHash: string): {
    formularyRoot: string;
    entriesJson: string;
    publishedAt: number;
    version: number;
  } | null {
    return this.formularyStore.get(planIdHash) ?? null;
  }

  /**
   * Get all published formularies (for checkpoint export).
   */
  getAllFormularies(): Map<string, {
    formularyRoot: string;
    entriesJson: string;
    publishedAt: number;
    version: number;
  }> {
    return new Map(this.formularyStore);
  }

  // ─── Formulary Service (Option C) ─────────────────────────

  /** Get the FormularyService instance (for RPC handlers) */
  getFormularyService(): FormularyService {
    return this.formularyService;
  }

  // ─── Plan Store ──────────────────────────────────────────

  /** Store a benefit plan config (sync — used by replication) */
  storePlan(plan: BenefitPlanConfig): void {
    this.planStore.set(plan.planId, plan);
  }

  /** Get a plan by ID */
  getPlan(planId: string): BenefitPlanConfig | null {
    return this.planStore.get(planId) ?? null;
  }

  /** Get all plans */
  getPlans(): BenefitPlanConfig[] {
    return Array.from(this.planStore.values());
  }

  /** Delete a plan (sync — used by replication) */
  deletePlan(planId: string): boolean {
    return this.planStore.delete(planId);
  }

  /** Apply a replicated plan from a peer (gossip: plan:updated). Idempotent. */
  applyReplicatedPlan(plan: BenefitPlanConfig): void {
    this.planStore.set(plan.planId, plan);
  }

  /** Apply a replicated plan deletion from a peer (gossip: plan:deleted). Idempotent. */
  applyReplicatedPlanDeletion(planId: string): void {
    this.planStore.delete(planId);
  }

  /**
   * Store a plan with WAL durability (async — used by the leader path).
   * WAL entry is written BEFORE the in-memory mutation, committed AFTER.
   */
  async storePlanWithWal(plan: BenefitPlanConfig): Promise<void> {
    const pi = this.partitionConfig?.partitionIndex ?? 0;
    let walEntryId: string | undefined;
    if (this.walProvider) {
      walEntryId = await this.walProvider.append({
        type: 'plan_store',
        partitionIndex: pi,
        sequenceNumber: this.walProvider.getLatestSequenceNumber(pi) + 1n,
        planData: plan as unknown as Record<string, unknown>,
        timestamp: Date.now(),
      });
    }
    this.planStore.set(plan.planId, plan);
    if (walEntryId) await this.walProvider!.commit(walEntryId);
  }

  /**
   * Delete a plan with WAL durability (async — used by the leader path).
   */
  async deletePlanWithWal(planId: string): Promise<boolean> {
    const pi = this.partitionConfig?.partitionIndex ?? 0;
    let walEntryId: string | undefined;
    if (this.walProvider) {
      walEntryId = await this.walProvider.append({
        type: 'plan_delete',
        partitionIndex: pi,
        sequenceNumber: this.walProvider.getLatestSequenceNumber(pi) + 1n,
        planData: { planId } as unknown as Record<string, unknown>,
        timestamp: Date.now(),
      });
    }
    const deleted = this.planStore.delete(planId);
    if (walEntryId) await this.walProvider!.commit(walEntryId);
    return deleted;
  }

  // ─── Employer Attestation Store ────────────────────────

  /** Store an employer attestation (sync — used by replication) */
  storeEmployerAttestation(att: import('./l2-types.js').EmployerAttestation): void {
    this.employerAttestationStore.set(att.employerId, att);
  }

  /** Get an employer attestation by employer ID */
  getEmployerAttestation(employerId: string): import('./l2-types.js').EmployerAttestation | null {
    return this.employerAttestationStore.get(employerId) ?? null;
  }

  /** Get all employer attestations */
  getEmployerAttestations(): import('./l2-types.js').EmployerAttestation[] {
    return Array.from(this.employerAttestationStore.values());
  }

  // ─── Employer Node Registry (Phase C) ──────────────────

  /** Prune entries whose lastHeartbeatAt is older than the TTL. Called on
   *  every lookup to passively clean up after orchestrator crashes. */
  private pruneStaleEmployerNodes(): void {
    const now = Date.now();
    for (const [id, entry] of this.employerNodeRegistry.entries()) {
      if (now - entry.lastHeartbeatAt > L2SequencerService.EMPLOYER_NODE_TTL_MS) {
        this.employerNodeRegistry.delete(id);
      }
    }
  }

  /** Register a live employer-node tenant process. Also acts as a keepalive
   *  when called repeatedly with the same employerId — updates lastHeartbeatAt
   *  without resetting startedAt. The orchestrator should call this every 60s
   *  to prevent TTL expiry. */
  registerEmployerNode(entry: {
    employerId: string;
    employerNodeUrl: string;
    hrToolUrl?: string;
    pid: number;
    adminTokenFingerprint?: string;
  }): void {
    const now = Date.now();
    const existing = this.employerNodeRegistry.get(entry.employerId);
    this.employerNodeRegistry.set(entry.employerId, {
      ...entry,
      startedAt: existing?.startedAt ?? now,
      lastHeartbeatAt: now,
    });
  }

  /** Look up the live URLs for a given employerId, or null if not running. */
  getEmployerNode(employerId: string): {
    employerId: string;
    employerNodeUrl: string;
    hrToolUrl?: string;
    pid: number;
    startedAt: number;
    lastHeartbeatAt: number;
    adminTokenFingerprint?: string;
  } | null {
    this.pruneStaleEmployerNodes();
    return this.employerNodeRegistry.get(employerId) ?? null;
  }

  /** List all currently-registered tenant employer-node processes. */
  listEmployerNodes(): Array<{
    employerId: string;
    employerNodeUrl: string;
    hrToolUrl?: string;
    pid: number;
    startedAt: number;
    lastHeartbeatAt: number;
  }> {
    this.pruneStaleEmployerNodes();
    return Array.from(this.employerNodeRegistry.values()).map(e => ({
      employerId: e.employerId,
      employerNodeUrl: e.employerNodeUrl,
      hrToolUrl: e.hrToolUrl,
      pid: e.pid,
      startedAt: e.startedAt,
      lastHeartbeatAt: e.lastHeartbeatAt,
    }));
  }

  /** Remove a tenant from the registry (called on clean shutdown). */
  deregisterEmployerNode(employerId: string): boolean {
    return this.employerNodeRegistry.delete(employerId);
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

  /**
   * Get Merkle witnesses for the next registration slot.
   *
   * Returns both witnesses and current roots atomically so entity nodes
   * can build valid registration proofs. The witnesses are for the NEXT
   * empty slot in the wallet registry and lifecycle trees.
   *
   * NOTE: These witnesses become stale if another registration proof
   * is submitted between the fetch and the proof generation. In production,
   * retry with fresh witnesses if the sequencer rejects the proof.
   */
  getRegistrationWitnesses(): {
    registryWitnessJson: string;
    lifecycleWitnessJson: string;
    currentRegistryRoot: string;
    currentLifecycleRoot: string;
    nextSlotIndex: string;
  } {
    const nextIndex = BigInt(this.walletRegistry.count);
    const regWitness = this.walletRegistry.getNextSlotWitness();
    const lcWitness = new LifecycleWitness(this.lifecycleTree.getWitness(nextIndex));

    return {
      registryWitnessJson: JSON.stringify(regWitness.toJSON()),
      lifecycleWitnessJson: JSON.stringify(lcWitness.toJSON()),
      currentRegistryRoot: this.currentRegistryRoot.toString(),
      currentLifecycleRoot: this.currentLifecycleRoot.toString(),
      nextSlotIndex: nextIndex.toString(),
    };
  }

  /**
   * Get Merkle witnesses for an EXISTING registered wallet.
   * Used by entity nodes to generate wallet UPDATE proofs (credential mutations).
   */
  getWalletWitnesses(walletId: string): {
    registryWitnessJson: string;
    lifecycleWitnessJson: string;
    currentRegistryRoot: string;
    currentLifecycleRoot: string;
    slotIndex: string;
    currentLifecycleState: string;
  } {
    const wid = Field(BigInt(walletId));
    const index = this.walletRegistry.getIndex(wid);
    const regWitness = this.walletRegistry.getWitnessByIndex(index);
    const lcWitness = new LifecycleWitness(this.lifecycleTree.getWitness(index));

    return {
      registryWitnessJson: JSON.stringify(regWitness.toJSON()),
      lifecycleWitnessJson: JSON.stringify(lcWitness.toJSON()),
      currentRegistryRoot: this.currentRegistryRoot.toString(),
      currentLifecycleRoot: this.currentLifecycleRoot.toString(),
      slotIndex: index.toString(),
      currentLifecycleState: (this.walletLifecycleStates.get(walletId) ?? LIFECYCLE_REGISTERED).toString(),
    };
  }

  /**
   * Get the current wallet state (nonce + credentialInventoryRoot) for RPC.
   * Used by entity nodes to compute wallet update proof inputs.
   */
  getWalletStateForRpc(walletId: string): {
    walletId: string;
    credentialInventoryRoot: string;
    nonce: string;
  } {
    const wid = Field(BigInt(walletId));
    const state = this.walletRegistry.getState(wid);
    return {
      walletId,
      credentialInventoryRoot: state.credentialInventoryRoot.toString(),
      nonce: state.nonce.toString(),
    };
  }

  /**
   * Sync a wallet's state in the witness tree after an externally-submitted proof.
   * Called by the RPC layer when a Nautilus node submits a wallet update proof directly
   * (e.g., PCP assignment) and the sequencer's witness tree needs to match the new root.
   */
  syncWalletState(walletId: Field, newState: WalletState): void {
    // submitProof() now updates the tree itself, so this is normally a no-op confirmation.
    // A state is only applied if it reproduces the published root; anything else is refused
    // so an outside caller cannot rewrite the sequencer's tree.
    if (!this.walletRegistry.isRegistered(walletId)) throw new Error('Wallet not registered');
    const current = this.walletRegistry.getState(walletId);
    if (current.commitment().toString() === newState.commitment().toString()) return;
    const resulting = this.walletRegistry.getWitness(walletId).calculateRoot(newState.commitment());
    if (resulting.toString() !== this.currentRegistryRoot.toString()) {
      throw new Error('syncWalletState refused: this state does not reproduce the published registry root');
    }
    this.walletRegistry.updateState(walletId, newState);
  }

  /** Last-settled registry root (matches L1 state) */
  getLastSettledRegistryRoot(): Field {
    return this.lastSettledRegistryRoot;
  }

  /** Last-settled lifecycle root (matches L1 state) */
  getLastSettledLifecycleRoot(): Field {
    return this.lastSettledLifecycleRoot;
  }

  /** Last-settled wallet count (matches L1 state) */
  getLastSettledWalletCount(): Field {
    return this.lastSettledWalletCount;
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

  /** Whether the sequencer is in L2-only mode (no L1 settlement) */
  isL2Only(): boolean {
    return this.l2Only;
  }

  /** Set the partition config for multi-sequencer mode */
  setPartitionConfig(config: PartitionConfig): void {
    this.partitionConfig = { ...config };
  }

  /** Get the current partition config, or null if not partitioned */
  getPartitionConfig(): PartitionConfig | null {
    return this.partitionConfig ? { ...this.partitionConfig } : null;
  }

  /**
   * Install the verifier for submitted state-transition proofs. Required before this
   * sequencer will accept anything: `submitProof` refuses while it is unset, which is
   * why it is an injected dependency rather than an option that could default to off.
   *
   * Production builds it with `createTransitionProofVerifier()`, which compiles the
   * program and pins its verification key hash.
   */
  setTransitionVerifier(verifier: TransitionProofVerifier): void {
    this.transitionVerifier = verifier;
  }

  /** Whether a proof verifier is installed. False means every submission is refused. */
  hasTransitionVerifier(): boolean {
    return this.transitionVerifier !== null;
  }

  /** Set the Write-Ahead Log provider (optional — enables crash-safe durability) */
  setWal(provider: IWalProvider): void {
    this.walProvider = provider;
  }

  /** Get the WAL provider (for external WAL operations) */
  getWal(): IWalProvider | null {
    return this.walProvider;
  }

  /** Look up a receipt by ID */
  getReceipt(receiptId: string): L2Receipt | undefined {
    return this.receipts.get(receiptId);
  }

  /** Get all receipts */
  getAllReceipts(): L2Receipt[] {
    return Array.from(this.receipts.values());
  }

  /** Get all receipts for a specific wallet */
  getReceiptsByWallet(walletId: string): L2Receipt[] {
    return this.getAllReceipts().filter((r) => r.walletId === walletId);
  }

  /** Look up a block by number */
  getBlock(blockNumber: bigint): L2Block | undefined {
    return this.blocks.get(blockNumber);
  }

  /** Look up a batch by number */
  getBatch(batchNumber: bigint): L2Batch | undefined {
    return this.batches.get(batchNumber);
  }

  /** Get all batches */
  getAllBatches(): L2Batch[] {
    return Array.from(this.batches.values());
  }

  /** Current global state root (Poseidon hash of 10 fields). Zero if no chain proof produced yet. */
  getCurrentGlobalStateRoot(): Field {
    return this.currentGlobalStateRoot;
  }

  /** Current L2 block height. Zero before first chain proof. */
  getCurrentBlockHeight(): Field {
    return this.currentBlockHeight;
  }

  /** Latest ChainProof JSON for offline verification, or null if none produced yet */
  getLatestChainProofJson(): string | null {
    return this.latestChainProofJson;
  }

  /** Current audit chain hash (Poseidon hash chain head) */
  getLatestChainHash(): string {
    return this.latestChainHash.toString();
  }

  /** Latest batch number, or null if no batches built yet */
  getLatestBatchNumber(): bigint | null {
    if (this.nextBatchNumber <= 0n) return null;
    return this.nextBatchNumber - 1n;
  }

  /** Highest assigned sequence number (0-based), or -1n if no proofs yet */
  getLatestSequenceNumber(): bigint {
    if (this.nextSequenceNumber <= 0n) return -1n;
    return this.nextSequenceNumber - 1n;
  }

  // ─── Claim Accumulator Queries ────────────────────────────

  /** Current Merkle root of the Claim Accumulator Tree */
  getClaimAccumulatorRoot(): string {
    return this.claimAccumulator.getRoot().toString();
  }

  /** Number of claims in the accumulator */
  getClaimLeafCount(): bigint {
    return this.claimAccumulator.getLeafCount();
  }

  /** All claims for a member wallet ID */
  getClaimsByMember(memberWalletId: string): ClaimAccumulatorEntry[] {
    return this.claimAccumulator.getClaimsByMember(memberWalletId);
  }

  /** All claims for a pharmacy wallet ID */
  getClaimsByPharmacy(pharmacyWalletId: string): ClaimAccumulatorEntry[] {
    return this.claimAccumulator.getClaimsByPharmacy(pharmacyWalletId);
  }

  /** All claims for a prescriber wallet ID */
  getClaimsByPrescriber(prescriberWalletId: string): ClaimAccumulatorEntry[] {
    return this.claimAccumulator.getClaimsByPrescriber(prescriberWalletId);
  }

  /** All claims for an NDC hash */
  getClaimsByNdc(ndcHash: string): ClaimAccumulatorEntry[] {
    return this.claimAccumulator.getClaimsByNdc(ndcHash);
  }

  /** Get a claim with its Merkle inclusion proof */
  getClaimWithProof(leafIndex: bigint): {
    entry: ClaimAccumulatorEntry;
    witnessJson: string;
    root: string;
  } | undefined {
    return this.claimAccumulator.getClaimWithProof(leafIndex);
  }

  /**
   * Record a fill directly on the claim accumulator (admin path).
   * Used by pharmacy Nautilus nodes to record dispensing without full ZK proof.
   * In production, fills go through AccumulatorFulfillmentProgram + proof submission.
   */
  recordFill(
    leaf: ClaimLeaf,
    metadata: ClaimMetadata,
  ): ClaimAccumulatorEntry {
    return this.claimAccumulator.appendClaim(leaf, metadata);
  }

  /** Direct access to the claim accumulator (for dedup checks in RPC layer) */
  getClaimAccumulator(): ClaimAccumulatorService {
    return this.claimAccumulator;
  }

  // ─── Accumulator Reconstruction (Wallet Migration) ──────────

  /**
   * Reconstruct a member's accumulator totals from claim history.
   *
   * Sums all claims for a wallet ID from the Claim Accumulator Tree:
   *   - Fulfillments (operationType '1') add to totals
   *   - Reversals (operationType '2') subtract from totals
   *
   * Used during wallet migration to seed the new wallet's AccumulatorData
   * with the old wallet's financial history (deductible, OOP, benefit).
   *
   * @param walletId — the member wallet ID to reconstruct for
   * @returns Reconstructed accumulator totals in cents, or null if no claims found
   */
  reconstructAccumulator(walletId: string, planIdHash?: string): {
    deductiblePaidCents: bigint;
    oopPaidCents: bigint;
    benefitUsedCents: bigint;
    claimCount: number;
    totalClaimCount: number;
  } | null {
    const allClaims = this.claimAccumulator.getClaimsByMember(walletId);
    if (allClaims.length === 0) return null;

    // Filter by plan if specified.
    // NOTE: Claims recorded before planIdHash was added have metadata.planIdHash === undefined
    // and will be EXCLUDED from plan-filtered queries. This is correct — those claims have no
    // plan association. Callers who need all claims regardless of plan should omit planIdHash.
    const claims = planIdHash
      ? allClaims.filter(c => c.metadata.planIdHash === planIdHash)
      : allClaims;
    if (claims.length === 0) return null;

    // Replay claims in order with per-step clamping to match circuit semantics.
    // The circuit uses max(0, old - amount) on reversals, so raw subtraction
    // can produce negative values that diverge from the credential's state.
    let deductiblePaidCents = 0n;
    let oopPaidCents = 0n;
    let benefitUsedCents = 0n;

    for (const claim of claims) {
      const patientPay = BigInt(claim.leaf.patientPayCents);
      const planPay = BigInt(claim.leaf.planPayCents);
      const deductibleCredit = BigInt(claim.leaf.deductibleCreditCents);

      if (claim.leaf.operationType === '1') {
        // Fulfillment — add
        oopPaidCents += patientPay;
        benefitUsedCents += planPay;
        deductiblePaidCents += deductibleCredit;
      } else if (claim.leaf.operationType === '2') {
        // Reversal — subtract with clamping (matches circuit's greaterThanOrEqual: max(0, old - amount))
        oopPaidCents = oopPaidCents >= patientPay ? oopPaidCents - patientPay : 0n;
        benefitUsedCents = benefitUsedCents >= planPay ? benefitUsedCents - planPay : 0n;
        deductiblePaidCents = deductiblePaidCents >= deductibleCredit ? deductiblePaidCents - deductibleCredit : 0n;
      }
    }

    return {
      deductiblePaidCents,
      oopPaidCents,
      benefitUsedCents,
      claimCount: claims.length,
      totalClaimCount: allClaims.length,
    };
  }

  // ─── Message Store ─────────────────────────────────────────

  /**
   * Store an encrypted message in the Message Store tree.
   *
   * @param message — the 5-Field message leaf data
   * @param payload — the encrypted message payload (ciphertext + iv + tag)
   * @returns MessageStoreEntry with assigned leafIndex and leafHash
   */
  storeMessage(message: StoredMessage, payload: MessagePayload): MessageStoreEntry {
    return this.messageStore.appendMessage(message, payload);
  }

  /** Current Merkle root of the Message Store tree */
  getMessageStoreRoot(): string {
    return this.messageStore.getRoot().toString();
  }

  /** Number of messages in the store */
  getMessageCount(): bigint {
    return this.messageStore.getMessageCount();
  }

  /** All messages sent by a wallet */
  getMessagesBySender(senderWalletId: string): MessageStoreEntry[] {
    return this.messageStore.getMessagesBySender(senderWalletId);
  }

  /** All messages received by a wallet */
  getMessagesByRecipient(recipientWalletId: string): MessageStoreEntry[] {
    return this.messageStore.getMessagesByRecipient(recipientWalletId);
  }

  /** All messages involving a wallet (sent or received) */
  getMessagesByWallet(walletId: string): MessageStoreEntry[] {
    return this.messageStore.getMessagesByWallet(walletId);
  }

  /** All messages in a thread */
  getMessagesByThread(threadIdHash: string): MessageStoreEntry[] {
    return this.messageStore.getMessagesByThread(threadIdHash);
  }

  /** Get a message with its Merkle inclusion proof */
  getMessageWithProof(leafIndex: bigint): {
    entry: MessageStoreEntry;
    witnessJson: string;
    root: string;
  } | undefined {
    return this.messageStore.getMessageWithProof(leafIndex);
  }

  // ─── Provider Registry ─────────────────────────────────────

  /** Register a new provider in the credentialing registry */
  credentialProvider(leaf: ProviderLeaf, metadata: ProviderMetadata): ProviderRegistryEntry {
    return this.providerRegistry.registerProvider(leaf, metadata);
  }

  /** Update a provider's lifecycle state */
  updateProviderStatus(walletId: string, newState: ProviderLifecycle): ProviderRegistryEntry {
    return this.providerRegistry.updateProviderStatus(walletId, newState);
  }

  /** Current Merkle root of the Provider Registry tree */
  getProviderRegistryRoot(): string {
    return this.providerRegistry.getRoot().toString();
  }

  /** Number of providers in the registry */
  getProviderCount(): bigint {
    return this.providerRegistry.getProviderCount();
  }

  /** Get provider by walletId */
  getProvider(walletId: string): ProviderRegistryEntry | undefined {
    return this.providerRegistry.getProviderByWallet(walletId);
  }

  /** Get provider by NPI hash */
  getProviderByNpi(npiHash: string): ProviderRegistryEntry | undefined {
    return this.providerRegistry.getProviderByNpi(npiHash);
  }

  /** Get all providers, optionally filtered by type and/or state */
  getProviders(providerType?: 'prescriber' | 'pharmacy', stateFilter?: ProviderLifecycle): ProviderRegistryEntry[] {
    if (stateFilter !== undefined && stateFilter === ProviderLifecycle.ACTIVE) {
      return this.providerRegistry.getActiveProviders(providerType);
    }
    if (providerType) {
      const byType = this.providerRegistry.getProvidersByType(providerType);
      if (stateFilter !== undefined) {
        return byType.filter((e) => e.leaf.credentialState === String(stateFilter));
      }
      return byType;
    }
    if (stateFilter !== undefined) {
      return this.providerRegistry.getProvidersByState(stateFilter);
    }
    // All providers — collect from all entries
    const all: ProviderRegistryEntry[] = [];
    for (let i = 0n; i < this.providerRegistry.getProviderCount(); i++) {
      const entry = this.providerRegistry.getEntry(i);
      if (entry) all.push(entry);
    }
    return all;
  }

  /** Get a provider with its Merkle inclusion proof */
  getProviderWithProof(walletId: string): {
    entry: ProviderRegistryEntry;
    witnessJson: string;
    root: string;
  } | undefined {
    return this.providerRegistry.getProviderWithProof(walletId);
  }

  /** Direct access to the provider registry service (for RPC server migration) */
  getProviderRegistry(): ProviderRegistryService {
    return this.providerRegistry;
  }

  // ─── Audit / DA ────────────────────────────────────────────

  /**
   * Emit a messaging audit event into the Poseidon hash chain.
   *
   * Messaging operations (sendMessage, sendInternalMessage, eScript) change
   * the messagingRoot but do NOT produce StateTransitionProofs. This method
   * records them in the same audit chain so they are tamper-evident and
   * included in L2 checkpoints.
   *
   * Registry/lifecycle roots are unchanged (same old/new) so they pass
   * through as no-ops in computeEventCommitment.
   *
   * Identifiable by `msg-` prefix in receiptId.
   */
  emitMessagingAuditEvent(
    senderWalletId: string,
    messagingRootBefore: string,
    messagingRootAfter: string,
  ): { chainHash: string; sequenceNumber: bigint } {
    const sequenceNumber = this.nextSequenceNumber++;
    const receiptId = `msg-${sequenceNumber.toString().padStart(8, '0')}`;

    // Registry/lifecycle roots unchanged — use current values for both old/new
    const regRoot = this.currentRegistryRoot.toString();
    const lcRoot = this.currentLifecycleRoot.toString();

    const auditEvent: AuditEvent = {
      sequenceNumber,
      receiptId,
      walletId: senderWalletId,
      isRegistration: false,
      oldRegistryRoot: regRoot,
      newRegistryRoot: regRoot,
      oldLifecycleRoot: lcRoot,
      newLifecycleRoot: lcRoot,
      eventCommitment: '',
      chainHash: '',
      timestamp: Date.now(),
      l1Status: 'pending',
    };

    const eventCommitment = AuditService.computeEventCommitment(auditEvent);
    const chainHash = AuditService.computeChainHash(this.latestChainHash, eventCommitment);

    auditEvent.eventCommitment = eventCommitment.toString();
    auditEvent.chainHash = chainHash.toString();
    this.latestChainHash = chainHash;

    this.auditLog.push(auditEvent);
    this.auditMerkleIndex.appendEventFromCommitment(eventCommitment);

    return { chainHash: chainHash.toString(), sequenceNumber };
  }

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

  /** Current Merkle root of the audit event index tree */
  getAuditMerkleRoot(): Field {
    return this.auditMerkleIndex.getRoot();
  }

  /** Selective Merkle witness for a specific audit event by index */
  getAuditSelectiveWitness(eventIndex: bigint) {
    return this.auditMerkleIndex.getSelectiveWitness(eventIndex);
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

  // ─── State Replication (Peer Network) ─────────────────────

  /**
   * Apply a replicated receipt from a peer (gossip: proof:accepted).
   *
   * Skips proof.verify() — the sequencer already verified it.
   * L1 settlement provides ultimate verification.
   *
   * Updates: roots, wallet count, receipt map, audit log, claim accumulator, counters.
   *
   * Idempotent: if receipt already exists, silently skips.
   * Ordering: advances nextSequenceNumber if receipt has higher seqNum.
   */
  applyReplicatedReceipt(
    receipt: L2Receipt,
    auditEvent: AuditEvent,
    claimEntry?: ClaimAccumulatorEntry,
    newRegistryRoot?: string,
    newLifecycleRoot?: string,
    newWalletCount?: string,
  ): void {
    // Idempotent: skip if already applied
    if (this.receipts.has(receipt.receiptId)) return;

    // Apply roots if provided
    if (newRegistryRoot) {
      this.currentRegistryRoot = Field(BigInt(newRegistryRoot));
    }
    if (newLifecycleRoot) {
      this.currentLifecycleRoot = Field(BigInt(newLifecycleRoot));
    }
    if (newWalletCount) {
      this.currentWalletCount = Field(BigInt(newWalletCount));
    }

    // Store receipt
    this.receipts.set(receipt.receiptId, receipt);

    // Update witness trees for replicated registrations
    if (receipt.isRegistration) {
      const walletId = Field(BigInt(receipt.walletId));
      if (!this.walletRegistry.isRegistered(walletId)) {
        const regIndex = this.walletRegistry.register(walletId);
        this.lifecycleTree.setLeaf(
          regIndex,
          lifecycleLeafCommitment(walletId, LIFECYCLE_REGISTERED),
        );
        this.walletLifecycleStates.set(receipt.walletId, LIFECYCLE_REGISTERED);
      }
    }

    // Append audit event + update chain hash + Merkle index
    this.auditLog.push(auditEvent);
    this.latestChainHash = Field(BigInt(auditEvent.chainHash));
    this.auditMerkleIndex.appendEventFromCommitment(Field(BigInt(auditEvent.eventCommitment)));

    // Advance sequence counter past the replicated receipt
    if (receipt.sequenceNumber >= this.nextSequenceNumber) {
      this.nextSequenceNumber = receipt.sequenceNumber + 1n;
    }

    // Apply claim entry if present
    if (claimEntry) {
      this.claimAccumulator.appendClaim(claimEntry.leaf, claimEntry.metadata);
    }
  }

  /**
   * Apply a replicated batch from a peer (gossip: batch:built).
   *
   * Updates: block map, batch map, receipt statuses, audit event statuses, counters.
   *
   * Idempotent: if batch already exists, silently skips.
   */
  applyReplicatedBatch(
    batch: L2Batch,
    block: L2Block,
    updatedReceipts: L2Receipt[],
    updatedAuditEvents: AuditEvent[],
  ): void {
    // Idempotent: skip if already applied
    if (this.batches.has(batch.batchNumber)) return;

    // Store block and batch
    this.blocks.set(block.blockNumber, block);
    this.batches.set(batch.batchNumber, batch);

    // Advance counters past the replicated batch
    if (block.blockNumber >= this.nextBlockNumber) {
      this.nextBlockNumber = block.blockNumber + 1n;
    }
    if (batch.batchNumber >= this.nextBatchNumber) {
      this.nextBatchNumber = batch.batchNumber + 1n;
    }

    // Update receipt statuses (pending → batched) and sync witness trees
    for (const updated of updatedReceipts) {
      const existing = this.receipts.get(updated.receiptId);
      if (existing) {
        existing.l1Status = updated.l1Status;
        existing.l2BlockNumber = updated.l2BlockNumber;
        existing.l1BatchNumber = updated.l1BatchNumber;
      }

      // Sync witness trees for registration receipts that may have arrived
      // via batch gossip rather than individual receipt gossip.
      if (updated.isRegistration) {
        const walletId = Field(BigInt(updated.walletId));
        if (!this.walletRegistry.isRegistered(walletId)) {
          const regIndex = this.walletRegistry.register(walletId);
          this.lifecycleTree.setLeaf(
            regIndex,
            lifecycleLeafCommitment(walletId, LIFECYCLE_REGISTERED),
          );
          this.walletLifecycleStates.set(updated.walletId, LIFECYCLE_REGISTERED);
        }
      }
    }

    // Update audit event statuses
    const updatedEventMap = new Map(
      updatedAuditEvents.map(e => [e.receiptId, e]),
    );
    for (const event of this.auditLog) {
      const updated = updatedEventMap.get(event.receiptId);
      if (updated) {
        event.l1Status = updated.l1Status;
        event.l2BlockNumber = updated.l2BlockNumber;
        event.l1BatchNumber = updated.l1BatchNumber;
      }
    }

    // Snapshot witness tree state for rollback (batch is now in-flight)
    this.preBatchWalletSnapshot = this.snapshotWallets();

    // Track in-flight
    this.inFlightBatchNumber = batch.batchNumber;
  }

  /**
   * Apply a replicated settlement from a peer (gossip: batch:settled).
   *
   * Updates: batch/block/receipt/audit statuses, last-settled roots.
   *
   * Idempotent: if batch is already settled, silently skips.
   */
  applyReplicatedSettlement(
    batchNumber: bigint,
    l1TxHash: string,
    lastSettledRegistryRoot: string,
    lastSettledLifecycleRoot: string,
    lastSettledWalletCount: string,
  ): void {
    const batch = this.batches.get(batchNumber);
    if (!batch) return;

    // Idempotent: skip if already settled
    if (batch.l1Status === 'settled') return;

    // Mark batch settled
    batch.l1Status = 'settled';
    batch.l1TxHash = l1TxHash;

    // Update block statuses
    for (const bn of batch.blockNumbers) {
      const block = this.blocks.get(bn);
      if (block) {
        block.l1Status = 'settled';
        block.l1TxHash = l1TxHash;
      }
    }

    // Update receipt and audit event statuses
    this.markAuditEventsStatus(batch, 'settled');
    for (const bn of batch.blockNumbers) {
      const block = this.blocks.get(bn);
      if (block) {
        for (const rid of block.receiptIds) {
          const receipt = this.receipts.get(rid);
          if (receipt) {
            receipt.l1Status = 'settled';
          }
        }
      }
    }

    // Update last-settled roots
    this.lastSettledRegistryRoot = Field(BigInt(lastSettledRegistryRoot));
    this.lastSettledLifecycleRoot = Field(BigInt(lastSettledLifecycleRoot));
    this.lastSettledWalletCount = Field(BigInt(lastSettledWalletCount));

    // Clear in-flight if this was the in-flight batch
    if (this.inFlightBatchNumber === batchNumber) {
      this.inFlightBatchNumber = null;
    }
  }

  /**
   * Apply a replicated message from a peer (gossip: message:stored).
   *
   * Idempotent: if the leafIndex already exists, silently skips.
   */
  applyReplicatedMessage(
    leafIndex: bigint,
    message: StoredMessage,
    payload: MessagePayload,
  ): void {
    // Idempotent: skip if this message is already stored
    if (this.messageStore.getEntry(leafIndex) !== undefined) return;
    this.messageStore.appendMessage(message, payload);
  }

  /**
   * Apply a replicated batch failure from a peer (gossip: batch:failed).
   *
   * Idempotent: if batch is already failed, silently skips.
   */
  applyReplicatedBatchFailure(batchNumber: bigint, reason: string): void {
    const batch = this.batches.get(batchNumber);
    if (!batch) return;

    // Idempotent: skip if already failed
    if (batch.l1Status === 'failed') return;

    batch.l1Status = 'failed';
    batch.failureReason = reason;

    // Update block/receipt/audit statuses
    this.markAuditEventsStatus(batch, 'failed');
    for (const bn of batch.blockNumbers) {
      const block = this.blocks.get(bn);
      if (block) {
        block.l1Status = 'failed';
        for (const rid of block.receiptIds) {
          const receipt = this.receipts.get(rid);
          if (receipt) {
            receipt.l1Status = 'failed';
          }
        }
      }
    }

    // Clear in-flight if this was the in-flight batch
    if (this.inFlightBatchNumber === batchNumber) {
      this.inFlightBatchNumber = null;
    }

    // Roll back all mutable state to pre-batch snapshot (unified with markBatchFailed)
    this.rollbackBatchState();
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
    const state: L2SequencerState = {
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

    // Include chain proof state if enabled
    if (this.adminState) {
      state.adminState = {
        adminPublicKeyHash: this.adminState.adminPublicKeyHash.toString(),
        benefitPlanRoot: this.adminState.benefitPlanRoot.toString(),
        credentialRegistryRoot: this.adminState.credentialRegistryRoot.toString(),
        eligibilityVkHash: this.adminState.eligibilityVkHash.toString(),
        messagingRoot: this.adminState.messagingRoot.toString(),
      };
      state.latestChainProofJson = this.latestChainProofJson;
      state.currentBlockHeight = this.currentBlockHeight.toString();
      state.currentGlobalStateRoot = this.currentGlobalStateRoot.toString();
    }

    // Include audit Merkle index state
    if (this.auditMerkleIndex.getEventCount() > 0n) {
      state.auditMerkleIndexState = this.auditMerkleIndex.exportState();
    }

    // Include claim accumulator state
    if (this.claimAccumulator.getLeafCount() > 0n) {
      state.claimAccumulatorState = this.claimAccumulator.exportState();
    }

    // Include message store state
    if (this.messageStore.getMessageCount() > 0n) {
      state.messageStoreState = this.messageStore.exportState();
    }

    // Include provider registry state
    if (this.providerRegistry.getProviderCount() > 0n) {
      state.providerRegistryState = this.providerRegistry.exportState();
    }

    // Include formulary state (legacy)
    if (this.formularyStore.size > 0) {
      state.formularyStore = Object.fromEntries(this.formularyStore);
    }

    // Include formulary service overlay state (Option C)
    if (this.formularyService.overlayCount > 0) {
      state.formularyServiceState = this.formularyService.exportState();
    }

    // Include plan store state
    if (this.planStore.size > 0) {
      state.planStore = Object.fromEntries(this.planStore);
    }

    // Include employer attestation store
    if (this.employerAttestationStore.size > 0) {
      (state as any).employerAttestations = Object.fromEntries(this.employerAttestationStore);
    }

    // Include last-settled roots for crash recovery
    state.lastSettledRegistryRoot = this.lastSettledRegistryRoot.toString();
    state.lastSettledLifecycleRoot = this.lastSettledLifecycleRoot.toString();
    state.lastSettledWalletCount = this.lastSettledWalletCount.toString();

    // Include L2-only flag
    state.l2Only = this.l2Only;

    // Include proof fingerprint dedup set
    if (this.seenProofFingerprints.size > 0) {
      state.seenProofFingerprints = Array.from(this.seenProofFingerprints);
    }

    // H5 fix: Include pre-batch rollback snapshots
    state.preBatchAuditLogLength = this.preBatchAuditLogLength;
    state.preBatchChainHash = this.preBatchChainHash.toString();
    state.preBatchClaimLeafCount = this.preBatchClaimLeafCount;
    state.preBatchAuditMerkleLeafCount = this.preBatchAuditMerkleLeafCount;
    if (this.preBatchFingerprints.size > 0) {
      state.preBatchFingerprints = Array.from(this.preBatchFingerprints);
    }

    // Include registered wallet list for witness tree reconstruction
    if (this.walletRegistry.count > 0) {
      const wallets: string[] = [];
      // Reconstruct ordered list from receipts (registration order)
      for (const r of state.receipts) {
        if (r.isRegistration) {
          wallets.push(r.walletId);
        }
      }
      state.registeredWallets = wallets;

      // Include lifecycle states for accurate witness reconstruction
      const lcStates: Record<string, string> = {};
      for (const [wid, lcState] of this.walletLifecycleStates) {
        lcStates[wid] = lcState.toString();
      }
      state.walletLifecycleStates = lcStates;
    }

    return state;
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
    // Restore last-settled roots (backward compat: fall back to current roots)
    const lastSettledRegRoot = state.lastSettledRegistryRoot
      ? Field(BigInt(state.lastSettledRegistryRoot))
      : Field(BigInt(state.currentRegistryRoot));
    const lastSettledLcRoot = state.lastSettledLifecycleRoot
      ? Field(BigInt(state.lastSettledLifecycleRoot))
      : Field(BigInt(state.currentLifecycleRoot));
    const lastSettledWC = state.lastSettledWalletCount
      ? Field(BigInt(state.lastSettledWalletCount))
      : Field(BigInt(state.currentWalletCount));

    this.lastSettledRegistryRoot = lastSettledRegRoot;
    this.lastSettledLifecycleRoot = lastSettledLcRoot;
    this.lastSettledWalletCount = lastSettledWC;

    // Crash recovery: recompute current roots from a consistent point.
    // The pending pool is NOT restored (clients resubmit), so current roots
    // must not include transitions from proofs that were accepted but never
    // batched. Two cases:
    //
    // 1. In-flight batch exists (built but not settled): set current roots
    //    to the batch's new roots. The batch proof is preserved and can be
    //    retried via retryBatch() — L1 will advance to these roots on success.
    //
    // 2. No in-flight batch: set current roots to last-settled (matches L1).
    if (state.inFlightBatchNumber !== null) {
      // Find the in-flight batch and use its end-state
      const inFlightBatch = state.batches.find(
        (b) => b.batchNumber === state.inFlightBatchNumber,
      );
      if (inFlightBatch) {
        this.currentRegistryRoot = Field(BigInt(inFlightBatch.newRegistryRoot));
        this.currentLifecycleRoot = Field(BigInt(inFlightBatch.newLifecycleRoot));
        this.currentWalletCount = Field(
          lastSettledWC.toBigInt() + BigInt(inFlightBatch.registrationCount),
        );
      } else {
        // In-flight batch not found (shouldn't happen) — fall back to last settled
        this.currentRegistryRoot = lastSettledRegRoot;
        this.currentLifecycleRoot = lastSettledLcRoot;
        this.currentWalletCount = lastSettledWC;
      }
    } else {
      this.currentRegistryRoot = lastSettledRegRoot;
      this.currentLifecycleRoot = lastSettledLcRoot;
      this.currentWalletCount = lastSettledWC;
    }

    this.inFlightBatchNumber = state.inFlightBatchNumber;
    this.nextSequenceNumber = state.nextSequenceNumber;
    this.nextBlockNumber = state.nextBlockNumber;
    this.nextBatchNumber = state.nextBatchNumber;
    this.latestChainHash = Field(BigInt(state.latestChainHash));

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

    // Restore chain proof state if present
    if (state.adminState) {
      this.adminState = {
        adminPublicKeyHash: Field(BigInt(state.adminState.adminPublicKeyHash)),
        benefitPlanRoot: Field(BigInt(state.adminState.benefitPlanRoot)),
        credentialRegistryRoot: Field(BigInt(state.adminState.credentialRegistryRoot)),
        eligibilityVkHash: Field(BigInt(state.adminState.eligibilityVkHash)),
        messagingRoot: Field(BigInt(state.adminState.messagingRoot)),
      };
      this.latestChainProofJson = state.latestChainProofJson ?? null;
      this.currentBlockHeight = Field(BigInt(state.currentBlockHeight ?? '0'));
      this.currentGlobalStateRoot = Field(BigInt(state.currentGlobalStateRoot ?? '0'));
      // Note: latestChainProof (the proof object) is NOT restored from checkpoint.
      // After crash recovery, the next buildBatch() will call genesis() if
      // latestChainProof is null, effectively starting a new chain segment.
      // The previous chain's validity is preserved in the settled batches.
      this.latestChainProof = null;
    }

    // Restore audit Merkle index state
    if (state.auditMerkleIndexState) {
      this.auditMerkleIndex.restoreState(state.auditMerkleIndexState);
    } else {
      this.auditMerkleIndex = new AuditMerkleIndex();
    }

    // Restore claim accumulator state
    if (state.claimAccumulatorState) {
      this.claimAccumulator.restoreState(state.claimAccumulatorState);
    } else {
      this.claimAccumulator = new ClaimAccumulatorService();
    }

    // Restore message store state
    if (state.messageStoreState) {
      this.messageStore.restoreState(state.messageStoreState);
    } else {
      this.messageStore = new MessageStoreService();
    }

    // Restore provider registry state
    if (state.providerRegistryState) {
      this.providerRegistry.restoreState(state.providerRegistryState);
    } else {
      this.providerRegistry = new ProviderRegistryService();
    }

    // Restore formulary state
    this.formularyStore.clear();
    if (state.formularyStore) {
      for (const [key, value] of Object.entries(state.formularyStore)) {
        this.formularyStore.set(key, value);
      }
    }

    // Restore formulary service overlay state (Option C)
    if (state.formularyServiceState) {
      this.formularyService.restoreState(state.formularyServiceState);
    }

    // Restore plan store state
    this.planStore.clear();
    if (state.planStore) {
      for (const [key, value] of Object.entries(state.planStore)) {
        this.planStore.set(key, value as BenefitPlanConfig);
      }
    }

    // Restore employer attestation store
    this.employerAttestationStore.clear();
    if ((state as any).employerAttestations) {
      for (const [key, value] of Object.entries((state as any).employerAttestations)) {
        this.employerAttestationStore.set(key, value as import('./l2-types.js').EmployerAttestation);
      }
    }

    // Restore L2-only flag (backward compat: defaults to current value)
    if (state.l2Only !== undefined) {
      this.l2Only = state.l2Only;
    }

    // Restore proof fingerprint dedup set
    if (state.seenProofFingerprints) {
      this.seenProofFingerprints = new Set(state.seenProofFingerprints);
    } else {
      this.seenProofFingerprints = new Set();
    }

    // H5 fix: Restore pre-batch rollback snapshots (backward compat defaults)
    this.preBatchAuditLogLength = state.preBatchAuditLogLength ?? this.auditLog.length;
    this.preBatchChainHash = state.preBatchChainHash
      ? Field(BigInt(state.preBatchChainHash))
      : this.latestChainHash;
    this.preBatchClaimLeafCount = state.preBatchClaimLeafCount ?? this.claimAccumulator.getLeafCount();
    this.preBatchAuditMerkleLeafCount = state.preBatchAuditMerkleLeafCount ?? this.auditMerkleIndex.getEventCount();
    this.preBatchFingerprints = state.preBatchFingerprints
      ? new Set(state.preBatchFingerprints)
      : new Set(this.seenProofFingerprints);

    // Rebuild witness trees from registered wallet list
    this.walletRegistry = new WalletRegistry();
    this.lifecycleTree = new MerkleTree(WALLET_TREE_HEIGHT);
    this.walletLifecycleStates = new Map();
    if (state.registeredWallets) {
      const lcStates: Record<string, string> = state.walletLifecycleStates ?? {};
      for (const walletIdStr of state.registeredWallets) {
        const walletId = Field(BigInt(walletIdStr));
        const lcState = lcStates[walletIdStr]
          ? Field(BigInt(lcStates[walletIdStr]))
          : LIFECYCLE_REGISTERED;
        const regIndex = this.walletRegistry.register(walletId);
        this.lifecycleTree.setLeaf(
          regIndex,
          lifecycleLeafCommitment(walletId, lcState),
        );
        this.walletLifecycleStates.set(walletIdStr, lcState);
      }
      // 1D fix: Derive walletCount from the materialized WalletRegistry
      // instead of arithmetic derivation from batch metadata. This ensures
      // scalar walletCount stays in sync with the witness tree after recovery.
      this.currentWalletCount = Field(BigInt(this.walletRegistry.count));
    }
    // Checkpoints carry registrations and lifecycle states but not wallet states, so the
    // rebuilt trees can differ from the restored roots. Enforce the invariant only if they match.
    this.treesAuthoritative = this.treesMatchRoots();
    if (!this.treesAuthoritative) {
      console.warn('[sequencer] Restored roots do not match the rebuilt witness trees; tree/root checks are relaxed until the next admin rebuild.');
    }

    // Initialize pre-batch wallet snapshot from restored witness trees
    this.preBatchWalletSnapshot = this.snapshotWallets();

    // Pending pool is NOT restored — proofs are transient
    this.pendingPool = [];
  }

  // ─── WAL Recovery ──────────────────────────────────────

  /**
   * Recover state from uncommitted WAL entries.
   *
   * Called after restoreState() to replay any proofs that were accepted
   * but not yet checkpointed. Uses applyReplicatedReceipt() for idempotent
   * replay (skips duplicates automatically).
   *
   * @returns Number of entries replayed
   */
  async recoverFromWal(): Promise<number> {
    if (!this.walProvider) return 0;

    const partitionIndex = this.partitionConfig?.partitionIndex ?? 0;
    const uncommitted = await this.walProvider.getUncommitted(partitionIndex);

    let replayed = 0;
    for (const entry of uncommitted) {
      if (entry.type === 'proof' && entry.receiptData) {
        // Replay the proof by applying it as a replicated receipt.
        // applyReplicatedReceipt is idempotent — it skips if the receipt already exists.
        const receipt = entry.receiptData as unknown as L2Receipt;
        if (!this.receipts.has(receipt.receiptId)) {
          // Apply the receipt data directly
          this.receipts.set(receipt.receiptId, receipt);

          // Apply audit event if present
          if (entry.auditEventData) {
            const auditEvent = entry.auditEventData as unknown as AuditEvent;
            this.auditLog.push(auditEvent);
            if (auditEvent.chainHash) {
              this.latestChainHash = Field(BigInt(auditEvent.chainHash));
            }
          }

          // Update roots from state snapshot
          if (entry.stateSnapshot) {
            // Only advance roots if they're newer than current state
            const entryRegRoot = entry.stateSnapshot.registryRoot;
            const entryLcRoot = entry.stateSnapshot.lifecycleRoot;
            if (entryRegRoot && entryLcRoot) {
              // The snapshot contains pre-mutation roots; receipt has post-mutation
              if (receipt.newRegistryRoot) {
                this.currentRegistryRoot = Field(BigInt(receipt.newRegistryRoot));
              }
              if (receipt.newLifecycleRoot) {
                this.currentLifecycleRoot = Field(BigInt(receipt.newLifecycleRoot));
              }
            }
          }

          // Advance sequence number
          if (receipt.sequenceNumber >= this.nextSequenceNumber) {
            this.nextSequenceNumber = receipt.sequenceNumber + 1n;
          }

          replayed++;
        }

        // Mark as committed in the WAL
        await this.walProvider.commit(entry.entryId);
      } else if (entry.type === 'proof' && !entry.receiptData && entry.claimEntryData) {
        // Proof WAL entry without receipt but with claim metadata —
        // replay claim into accumulator so it's not lost on crash recovery.
        const meta = entry.claimEntryData as unknown as ClaimSubmissionMetadata;
        if (meta.memberWalletId && meta.ndcHash) {
          this.claimAccumulator.appendClaim(
            {
              memberWalletId: meta.memberWalletId,
              ndcHash: meta.ndcHash,
              pharmacyWalletId: meta.pharmacyWalletId ?? '0',
              prescriberWalletId: meta.prescriberWalletId ?? '0',
              dateOfService: meta.dateOfService ?? '0',
              patientPayCents: meta.patientPayCents ?? '0',
              planPayCents: meta.planPayCents ?? '0',
              operationType: meta.operationType ?? '1',
              deductibleCreditCents: meta.deductibleCreditCents ?? '0',
            },
            {
              receiptId: `WAL-RECOVERY-${entry.entryId}`,
              timestamp: entry.timestamp ?? Date.now(),
              ndc: meta.ndc,
              brandName: meta.brandName,
              tierLevel: meta.tierLevel,
              planIdHash: meta.planIdHash,
            },
          );
          replayed++;
        }
        await this.walProvider.commit(entry.entryId);
      }
      // Plan WAL recovery
      if (entry.type === 'plan_store' && entry.planData) {
        const plan = entry.planData as unknown as BenefitPlanConfig;
        if (plan.planId) {
          this.planStore.set(plan.planId, plan);
        }
        await this.walProvider.commit(entry.entryId);
        replayed++;
      }
      if (entry.type === 'plan_delete' && entry.planData) {
        const planId = (entry.planData as Record<string, unknown>).planId as string;
        if (planId) this.planStore.delete(planId);
        await this.walProvider.commit(entry.entryId);
        replayed++;
      }

      // batch_begin without batch_commit → discard
      // The pending pool is empty after recovery; clients resubmit
    }

    return replayed;
  }
}
