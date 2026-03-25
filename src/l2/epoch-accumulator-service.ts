/**
 * EpochAccumulatorService — Monthly epoch-based claim accumulator.
 *
 * Wraps multiple ClaimAccumulatorService instances (one per month) to handle
 * production-scale drug history: 250M claims/year over 25 years (~4 TB).
 *
 * Each epoch is a MerkleTree(25) with 33.5M leaf capacity (~16 months at
 * 250M/year). Monthly rotation ensures each tree stays manageable in memory.
 *
 * Queries search across all epochs (newest first). Merkle proofs are scoped
 * to the epoch that contains the claim.
 *
 * The active epoch's root is committed in each L2Batch (claimAccumulatorRoot).
 * Archived epochs are immutable — their roots are fixed.
 */

import { ClaimAccumulatorService } from './claim-accumulator-service.js';
import type {
  ClaimLeaf,
  ClaimMetadata,
  ClaimAccumulatorEntry,
  ClaimAccumulatorState,
} from './claim-accumulator-types.js';

// ─── Epoch Types ────────────────────────────────────────────

/** Information about a single epoch */
export interface EpochInfo {
  /** Epoch identifier (YYYY-MM format) */
  epochId: string;
  /** Timestamp when the epoch started */
  startTimestamp: number;
  /** Timestamp when the epoch ended (null = still active) */
  endTimestamp: number | null;
  /** Number of claims in this epoch */
  leafCount: bigint;
  /** Merkle root for this epoch's tree */
  accumulatorRoot: string;
  /** Whether this epoch has been closed and archived */
  archived: boolean;
}

/** Serializable state for checkpoint persistence */
export interface EpochAccumulatorServiceState {
  /** Active epoch ID */
  activeEpochId: string;
  /** Active epoch's full state */
  activeEpochState: ClaimAccumulatorState;
  /** Timestamp when the active epoch started (preserved across restores) */
  activeStartTimestamp?: number;
  /** Archived epochs with full state */
  archivedEpochs: {
    epochId: string;
    info: EpochInfo;
    state: ClaimAccumulatorState;
  }[];
}

// ─── Service ────────────────────────────────────────────────

export class EpochAccumulatorService {
  /** Currently active epoch (receives writes) */
  private activeEpoch: ClaimAccumulatorService;
  /** Active epoch identifier */
  private activeEpochId: string;
  /** Epoch metadata registry */
  private epochs: Map<string, EpochInfo> = new Map();
  /** Archived epoch data (full ClaimAccumulatorService per epoch) */
  private archivedAccumulators: Map<string, ClaimAccumulatorService> = new Map();
  /** Start timestamp of the active epoch */
  private activeStartTimestamp: number;

  constructor(initialEpochId?: string) {
    this.activeEpochId = initialEpochId ?? EpochAccumulatorService.currentEpochId();
    this.activeEpoch = new ClaimAccumulatorService();
    this.activeStartTimestamp = Date.now();

    this.epochs.set(this.activeEpochId, {
      epochId: this.activeEpochId,
      startTimestamp: this.activeStartTimestamp,
      endTimestamp: null,
      leafCount: 0n,
      accumulatorRoot: this.activeEpoch.getRoot().toString(),
      archived: false,
    });
  }

  // ─── Write ─────────────────────────────────────────────────

  /**
   * Append a claim to the active epoch.
   * Delegates to the active ClaimAccumulatorService.
   */
  appendClaim(
    leaf: ClaimLeaf,
    metadata: ClaimMetadata,
    _timestamp?: number,
  ): ClaimAccumulatorEntry {
    const entry = this.activeEpoch.appendClaim(leaf, metadata);

    // Update epoch info
    const info = this.epochs.get(this.activeEpochId)!;
    info.leafCount = this.activeEpoch.getLeafCount();
    info.accumulatorRoot = this.activeEpoch.getRoot().toString();

    return entry;
  }

  // ─── Read (cross-epoch, newest first) ──────────────────────

  /** All claims for a member wallet ID (across all epochs, newest first) */
  getClaimsByMember(walletId: string): ClaimAccumulatorEntry[] {
    return this.queryCrossEpoch((acc) => acc.getClaimsByMember(walletId));
  }

  /** All claims for a pharmacy wallet ID */
  getClaimsByPharmacy(walletId: string): ClaimAccumulatorEntry[] {
    return this.queryCrossEpoch((acc) => acc.getClaimsByPharmacy(walletId));
  }

  /** All claims for a prescriber wallet ID */
  getClaimsByPrescriber(walletId: string): ClaimAccumulatorEntry[] {
    return this.queryCrossEpoch((acc) => acc.getClaimsByPrescriber(walletId));
  }

  /** All claims for an NDC hash */
  getClaimsByNdc(ndcHash: string): ClaimAccumulatorEntry[] {
    return this.queryCrossEpoch((acc) => acc.getClaimsByNdc(ndcHash));
  }

  // ─── Single-Epoch Queries ──────────────────────────────────

  /** Claims for a member in a specific epoch */
  getClaimsByMemberInEpoch(walletId: string, epochId: string): ClaimAccumulatorEntry[] {
    const acc = this.getAccumulator(epochId);
    return acc ? acc.getClaimsByMember(walletId) : [];
  }

  // ─── Merkle Proofs ─────────────────────────────────────────

  /**
   * Get a claim with its Merkle inclusion proof.
   * Must specify the epoch since leaf indices are per-epoch.
   */
  getClaimWithProof(
    epochId: string,
    leafIndex: bigint,
  ): { entry: ClaimAccumulatorEntry; witnessJson: string; root: string } | undefined {
    const acc = this.getAccumulator(epochId);
    if (!acc) return undefined;
    return acc.getClaimWithProof(leafIndex);
  }

  /** Merkle root of the active epoch */
  getActiveRoot(): string {
    return this.activeEpoch.getRoot().toString();
  }

  /** Merkle root of a specific epoch (or undefined if not found) */
  getRootForEpoch(epochId: string): string | undefined {
    return this.epochs.get(epochId)?.accumulatorRoot;
  }

  /** Total leaf count across all epochs */
  getTotalLeafCount(): bigint {
    let total = 0n;
    for (const info of this.epochs.values()) {
      total += info.leafCount;
    }
    return total;
  }

  // ─── Epoch Lifecycle ───────────────────────────────────────

  /**
   * Rotate to a new epoch.
   *
   * Closes the active epoch (archives it) and starts a new one.
   * Returns the info of the just-closed epoch.
   */
  rotateEpoch(newEpochId?: string): EpochInfo {
    const closedEpochId = this.activeEpochId;
    const closedInfo = this.epochs.get(closedEpochId)!;

    // Close the active epoch
    closedInfo.endTimestamp = Date.now();
    closedInfo.archived = true;
    closedInfo.leafCount = this.activeEpoch.getLeafCount();
    closedInfo.accumulatorRoot = this.activeEpoch.getRoot().toString();

    // Archive the accumulator
    this.archivedAccumulators.set(closedEpochId, this.activeEpoch);

    // Create new epoch
    const nextEpochId = newEpochId ?? EpochAccumulatorService.currentEpochId();
    this.activeEpochId = nextEpochId;
    this.activeEpoch = new ClaimAccumulatorService();
    this.activeStartTimestamp = Date.now();

    this.epochs.set(nextEpochId, {
      epochId: nextEpochId,
      startTimestamp: this.activeStartTimestamp,
      endTimestamp: null,
      leafCount: 0n,
      accumulatorRoot: this.activeEpoch.getRoot().toString(),
      archived: false,
    });

    return closedInfo;
  }

  /** The active epoch's identifier */
  getActiveEpochId(): string {
    return this.activeEpochId;
  }

  /** List all epochs (active + archived) sorted newest first */
  listEpochs(): EpochInfo[] {
    return Array.from(this.epochs.values()).sort(
      (a, b) => b.startTimestamp - a.startTimestamp,
    );
  }

  /** Get info for a specific epoch */
  getEpochInfo(epochId: string): EpochInfo | undefined {
    return this.epochs.get(epochId);
  }

  // ─── Checkpoint Export / Restore ───────────────────────────

  /** Export the full state of all epochs for checkpoint persistence */
  exportState(): EpochAccumulatorServiceState {
    const archivedEpochs: EpochAccumulatorServiceState['archivedEpochs'] = [];
    for (const [epochId, acc] of this.archivedAccumulators) {
      const info = this.epochs.get(epochId)!;
      archivedEpochs.push({
        epochId,
        info,
        state: acc.exportState(),
      });
    }

    return {
      activeEpochId: this.activeEpochId,
      activeEpochState: this.activeEpoch.exportState(),
      activeStartTimestamp: this.activeStartTimestamp,
      archivedEpochs,
    };
  }

  /** Restore full state from a checkpoint */
  restoreState(state: EpochAccumulatorServiceState): void {
    // Clear everything
    this.epochs.clear();
    this.archivedAccumulators.clear();

    // Restore archived epochs
    for (const archived of state.archivedEpochs) {
      const acc = new ClaimAccumulatorService();
      acc.restoreState(archived.state);
      this.archivedAccumulators.set(archived.epochId, acc);
      this.epochs.set(archived.epochId, archived.info);
    }

    // Restore active epoch
    this.activeEpochId = state.activeEpochId;
    this.activeEpoch = new ClaimAccumulatorService();
    this.activeEpoch.restoreState(state.activeEpochState);
    this.activeStartTimestamp = state.activeStartTimestamp ?? Date.now();

    this.epochs.set(this.activeEpochId, {
      epochId: this.activeEpochId,
      startTimestamp: this.activeStartTimestamp,
      endTimestamp: null,
      leafCount: this.activeEpoch.getLeafCount(),
      accumulatorRoot: this.activeEpoch.getRoot().toString(),
      archived: false,
    });
  }

  // ─── Internal ──────────────────────────────────────────────

  /** Get the accumulator for an epoch (active or archived) */
  private getAccumulator(epochId: string): ClaimAccumulatorService | undefined {
    if (epochId === this.activeEpochId) return this.activeEpoch;
    return this.archivedAccumulators.get(epochId);
  }

  /**
   * Query across all epochs (newest first).
   * Results from newer epochs come first.
   */
  private queryCrossEpoch(
    queryFn: (acc: ClaimAccumulatorService) => ClaimAccumulatorEntry[],
  ): ClaimAccumulatorEntry[] {
    const results: ClaimAccumulatorEntry[] = [];

    // Active epoch first (newest)
    results.push(...queryFn(this.activeEpoch));

    // Then archived epochs (newest first by start timestamp)
    const sortedArchived = Array.from(this.archivedAccumulators.entries())
      .sort((a, b) => {
        const infoA = this.epochs.get(a[0])!;
        const infoB = this.epochs.get(b[0])!;
        return infoB.startTimestamp - infoA.startTimestamp;
      });

    for (const [, acc] of sortedArchived) {
      results.push(...queryFn(acc));
    }

    return results;
  }

  /** Generate the current epoch ID (YYYY-MM format) */
  static currentEpochId(): string {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    return `${year}-${month}`;
  }
}
