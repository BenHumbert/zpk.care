/**
 * L2 Partition — Wallet-based partitioning for multi-sequencer topology.
 *
 * In a multi-sequencer deployment, each sequencer owns a partition of the
 * wallet space. Writes are routed to the owning sequencer; reads are
 * replicated via gossip to all sequencers.
 *
 * Partition assignment is deterministic: the walletId (a Poseidon hash
 * as a decimal string / bigint) is modded by the partition count.
 *
 * Zero external dependencies.
 */

// ─── Partition Config ─────────────────────────────────────────

/**
 * PartitionConfig — identifies which slice of the wallet space
 * this sequencer owns.
 */
export interface PartitionConfig {
  /** Total number of sequencer partitions */
  partitionCount: number;
  /** This sequencer's partition index (0-based) */
  partitionIndex: number;
}

// ─── Partition Assignment ─────────────────────────────────────

/**
 * Compute which partition a walletId belongs to.
 *
 * Uses the walletId's bigint value mod partitionCount for uniform
 * distribution (Poseidon hashes are pseudorandom over the field).
 *
 * @param walletId — decimal string of the Poseidon hash
 * @param partitionCount — total number of partitions
 * @returns partition index (0-based)
 */
export function getPartition(walletId: string, partitionCount: number): number {
  if (partitionCount <= 0) {
    throw new Error('partitionCount must be positive');
  }
  if (partitionCount === 1) return 0;
  const n = BigInt(walletId);
  // Use absolute value to handle any edge cases
  const absN = n < 0n ? -n : n;
  return Number(absN % BigInt(partitionCount));
}

/**
 * Check if a walletId belongs to this sequencer's partition.
 */
export function isMyPartition(walletId: string, config: PartitionConfig): boolean {
  return getPartition(walletId, config.partitionCount) === config.partitionIndex;
}

// ─── Partition Router ─────────────────────────────────────────

/**
 * PartitionRouter — maps partition indices to sequencer peer URLs.
 *
 * Entity nodes use this to discover which sequencer to submit a proof to
 * based on the target member wallet's partition assignment.
 */
export class PartitionRouter {
  private partitionMap: Map<number, string> = new Map();
  private partitionCount: number;

  constructor(partitionCount: number) {
    if (partitionCount <= 0) {
      throw new Error('partitionCount must be positive');
    }
    this.partitionCount = partitionCount;
  }

  /** Register a sequencer URL for a partition index */
  setPartition(partitionIndex: number, url: string): void {
    if (partitionIndex < 0 || partitionIndex >= this.partitionCount) {
      throw new Error(
        `partitionIndex ${partitionIndex} out of range [0, ${this.partitionCount})`,
      );
    }
    this.partitionMap.set(partitionIndex, url);
  }

  /** Get the sequencer URL that owns a given walletId */
  getSequencerUrl(walletId: string): string | undefined {
    const idx = getPartition(walletId, this.partitionCount);
    return this.partitionMap.get(idx);
  }

  /** Get the sequencer URL for a specific partition index */
  getUrlForPartition(partitionIndex: number): string | undefined {
    return this.partitionMap.get(partitionIndex);
  }

  /** Get all registered partitions */
  getAllPartitions(): { partitionIndex: number; url: string }[] {
    return Array.from(this.partitionMap.entries())
      .map(([partitionIndex, url]) => ({ partitionIndex, url }))
      .sort((a, b) => a.partitionIndex - b.partitionIndex);
  }

  /** Get the total partition count */
  getPartitionCount(): number {
    return this.partitionCount;
  }

  /** Check if all partitions have registered URLs */
  isComplete(): boolean {
    return this.partitionMap.size === this.partitionCount;
  }
}
