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
 * Claim Accumulator Service — MerkleTree-backed drug history index.
 *
 * Maintains a global MerkleTree(24) on the L2 sequencer that tracks
 * every fulfilled claim with drug identity (ndcHash). Provides:
 *   - O(1) append of new claims
 *   - O(1) index lookups by member, pharmacy, prescriber, or NDC
 *   - Merkle inclusion proofs for any claim (verifiable off-chain)
 *   - Full export/restore for checkpoint persistence
 *
 * The tree root is stored on each L2Batch, and the ndcHash is committed
 * in the audit Poseidon hash chain (GlobalState → ChainProof → on-chain).
 */

import { MerkleTree } from 'o1js';
import {
  CLAIM_TREE_HEIGHT,
  ClaimAccumulatorWitness,
  computeClaimLeafHash,
  type ClaimLeaf,
  type ClaimMetadata,
  type ClaimAccumulatorEntry,
  type ClaimAccumulatorState,
} from './claim-accumulator-types.js';

/**
 * A fill whose key — member, drug, pharmacy, day and fill number — is already on the ledger (D4, A-10). Thrown
 * before any leaf is written, so the caller learns at once instead of billing a claim the ledger never recorded.
 */
export class DuplicateFillError extends Error {
  constructor(
    readonly existingLeafIndex: bigint,
    readonly key: { memberWalletId: string; ndcHash: string; pharmacyWalletId: string; dateOfService: string },
    readonly fillNumber: number,
  ) {
    super(`Duplicate fill: a claim for this member, drug and pharmacy on ${key.dateOfService} (fill ${fillNumber}) is already on the ledger at leaf ${existingLeafIndex}`);
    this.name = 'DuplicateFillError';
  }
}

export class ClaimAccumulatorService {
  /** The backing Merkle tree */
  private tree: MerkleTree;

  /** Next available leaf index */
  private nextLeafIndex: bigint = 0n;

  /** Full entries by leaf index */
  private entries: Map<bigint, ClaimAccumulatorEntry> = new Map();

  // ─── Indexes (walletId/ndcHash → leaf indices) ──────────

  private memberIndex: Map<string, bigint[]> = new Map();
  private pharmacyIndex: Map<string, bigint[]> = new Map();
  private prescriberIndex: Map<string, bigint[]> = new Map();
  private ndcIndex: Map<string, bigint[]> = new Map();

  /**
   * Deduplication index: tracks active fills to prevent duplicate dispensing.
   * Key = "memberWalletId:ndcHash:pharmacyWalletId:dateOfService:fillNumber" — the fill number keeps the
   * remainder of a partial fill apart from a duplicate (D4)
   * Value = leafIndex of the existing fill
   */
  private fillDedup: Map<string, bigint> = new Map();

  constructor() {
    this.tree = new MerkleTree(CLAIM_TREE_HEIGHT);
  }

  // ─── Write ───────────────────────────────────────────────

  /**
   * Build a dedup key for fill uniqueness checks.
   * Reversals (operationType '2') are excluded from dedup — multiple reversals are allowed.
   */
  private static fillKey(leaf: Pick<ClaimLeaf, 'memberWalletId' | 'ndcHash' | 'pharmacyWalletId' | 'dateOfService'>, fillNumber: number | undefined): string {
    return `${leaf.memberWalletId}:${leaf.ndcHash}:${leaf.pharmacyWalletId}:${leaf.dateOfService}:${fillNumber ?? 0}`;
  }
  private static fillDedupKey(leaf: ClaimLeaf, fillNumber: number | undefined): string | null {
    if (leaf.operationType === '2') return null; // a reversal is never a duplicate; it frees its fill's key instead
    return ClaimAccumulatorService.fillKey(leaf, fillNumber);
  }

  /**
   * Check whether an unreversed fill already exists for this (member, ndc, pharmacy, date, fill number) key.
   * Returns the existing entry if found, undefined otherwise.
   * Reversals always return undefined (they are never considered duplicates).
   */
  hasActiveFill(memberWalletId: string, ndcHash: string, pharmacyWalletId: string, dateOfService: string, fillNumber = 0): ClaimAccumulatorEntry | undefined {
    const key = ClaimAccumulatorService.fillKey({ memberWalletId, ndcHash, pharmacyWalletId, dateOfService }, fillNumber);
    const existingIndex = this.fillDedup.get(key);
    if (existingIndex === undefined) return undefined;
    return this.entries.get(existingIndex);
  }

  /**
   * Append a new claim to the accumulator tree.
   * A fill (operationType != '2') whose key (member, ndc, pharmacy, date, fill number) is already on the ledger
   * is refused with DuplicateFillError before anything is written (D4, A-10); a reversal frees its fill's key.
   *
   * @param leaf  The 8-Field claim leaf (all values as decimal strings)
   * @param metadata  Non-cryptographic display metadata
   * @returns The ClaimAccumulatorEntry (existing if duplicate, new if unique)
   */
  appendClaim(leaf: ClaimLeaf, metadata: ClaimMetadata): ClaimAccumulatorEntry {
    // D4 (A-10): a second fill with the same key is refused, never silently folded into the first. Until D4 the
    // existing entry was returned, and the caller had already billed the member for a claim the ledger never recorded.
    const dedupKey = ClaimAccumulatorService.fillDedupKey(leaf, metadata.fillNumber);
    if (dedupKey) {
      const existingIndex = this.fillDedup.get(dedupKey);
      if (existingIndex !== undefined && this.entries.has(existingIndex)) {
        throw new DuplicateFillError(existingIndex, leaf, metadata.fillNumber ?? 0);
      }
    }

    const leafIndex = this.nextLeafIndex;
    const leafHash = computeClaimLeafHash(leaf);

    // Store in Merkle tree
    this.tree.setLeaf(leafIndex, leafHash);

    // Build entry
    const entry: ClaimAccumulatorEntry = {
      leafIndex,
      leaf,
      leafHash: leafHash.toString(),
      metadata,
    };

    // Store entry
    this.entries.set(leafIndex, entry);

    // Update indexes
    this.addToIndex(this.memberIndex, leaf.memberWalletId, leafIndex);
    this.addToIndex(this.pharmacyIndex, leaf.pharmacyWalletId, leafIndex);
    this.addToIndex(this.prescriberIndex, leaf.prescriberWalletId, leafIndex);
    this.addToIndex(this.ndcIndex, leaf.ndcHash, leafIndex);

    // Track in dedup index; a reversal frees its fill's key, so the prescription can be filled again after it
    if (dedupKey) {
      this.fillDedup.set(dedupKey, leafIndex);
    } else if (leaf.operationType === '2') {
      this.fillDedup.delete(ClaimAccumulatorService.fillKey(leaf, metadata.fillNumber));
    }

    this.nextLeafIndex++;
    return entry;
  }

  // ─── Read ────────────────────────────────────────────────

  /** The ledger's money, net of reversals — what the audit chain must agree with (D5). */
  getTotals(): { claimCount: number; reversalCount: number; patientPayCents: bigint; planPayCents: bigint } {
    const t = { claimCount: 0, reversalCount: 0, patientPayCents: 0n, planPayCents: 0n };
    for (const entry of this.entries.values()) {
      const reversal = entry.leaf.operationType === '2';
      const sign = reversal ? -1n : 1n;
      if (reversal) t.reversalCount++; else t.claimCount++;
      t.patientPayCents += sign * BigInt(entry.leaf.patientPayCents);
      t.planPayCents += sign * BigInt(entry.leaf.planPayCents);
    }
    return t;
  }

  /** Current Merkle root of the claim accumulator tree */
  getRoot(): bigint {
    return this.tree.getRoot().toBigInt();
  }

  /** Merkle witness for a specific leaf index */
  getWitness(leafIndex: bigint): ClaimAccumulatorWitness {
    return new ClaimAccumulatorWitness(this.tree.getWitness(leafIndex));
  }

  /** Number of claims stored */
  getLeafCount(): bigint {
    return this.nextLeafIndex;
  }

  /** Get a single entry by leaf index (or undefined) */
  getEntry(leafIndex: bigint): ClaimAccumulatorEntry | undefined {
    return this.entries.get(leafIndex);
  }

  // ─── Index Queries ───────────────────────────────────────

  /** All claims for a member wallet ID */
  getClaimsByMember(memberWalletId: string): ClaimAccumulatorEntry[] {
    return this.getEntriesByIndex(this.memberIndex, memberWalletId);
  }

  /** All claims for a pharmacy wallet ID */
  getClaimsByPharmacy(pharmacyWalletId: string): ClaimAccumulatorEntry[] {
    return this.getEntriesByIndex(this.pharmacyIndex, pharmacyWalletId);
  }

  /** All claims for a prescriber wallet ID */
  getClaimsByPrescriber(prescriberWalletId: string): ClaimAccumulatorEntry[] {
    return this.getEntriesByIndex(this.prescriberIndex, prescriberWalletId);
  }

  /** All claims for an NDC hash */
  getClaimsByNdc(ndcHash: string): ClaimAccumulatorEntry[] {
    return this.getEntriesByIndex(this.ndcIndex, ndcHash);
  }

  /**
   * Get a claim with its Merkle inclusion proof.
   * Returns the entry, witness JSON, and current root for off-chain verification.
   */
  getClaimWithProof(leafIndex: bigint): {
    entry: ClaimAccumulatorEntry;
    witnessJson: string;
    root: string;
  } | undefined {
    const entry = this.entries.get(leafIndex);
    if (!entry) return undefined;

    const witness = this.getWitness(leafIndex);
    return {
      entry,
      witnessJson: JSON.stringify(witness.toJSON()),
      root: this.getRoot().toString(),
    };
  }

  // ─── Checkpoint Export / Restore ─────────────────────────

  /**
   * Export full accumulator state for checkpoint persistence.
   */
  exportState(): ClaimAccumulatorState {
    const entries: ClaimAccumulatorEntry[] = [];
    for (let i = 0n; i < this.nextLeafIndex; i++) {
      const entry = this.entries.get(i);
      if (entry) entries.push(entry);
    }

    return {
      nextLeafIndex: this.nextLeafIndex,
      entries,
      currentRoot: this.getRoot().toString(),
    };
  }

  /**
   * Restore accumulator state from a checkpoint.
   * Rebuilds the Merkle tree and all indexes from the entry list.
   */
  restoreState(state: ClaimAccumulatorState): void {
    // Reset everything
    this.tree = new MerkleTree(CLAIM_TREE_HEIGHT);
    this.nextLeafIndex = 0n;
    this.entries.clear();
    this.memberIndex.clear();
    this.pharmacyIndex.clear();
    this.prescriberIndex.clear();
    this.ndcIndex.clear();
    this.fillDedup.clear();

    // Re-append each entry (rebuilds tree + indexes)
    for (const entry of state.entries) {
      this.appendClaim(entry.leaf, entry.metadata);
    }
  }

  // ─── Private Helpers ─────────────────────────────────────

  private addToIndex(index: Map<string, bigint[]>, key: string, leafIndex: bigint): void {
    const existing = index.get(key);
    if (existing) {
      existing.push(leafIndex);
    } else {
      index.set(key, [leafIndex]);
    }
  }

  private getEntriesByIndex(index: Map<string, bigint[]>, key: string): ClaimAccumulatorEntry[] {
    const indices = index.get(key) ?? [];
    return indices
      .map((i) => this.entries.get(i))
      .filter((e): e is ClaimAccumulatorEntry => e !== undefined);
  }
}
