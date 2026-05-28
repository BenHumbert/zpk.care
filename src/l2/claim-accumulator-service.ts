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
   * Key = "memberWalletId:ndcHash:pharmacyWalletId:dateOfService"
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
  private static fillDedupKey(leaf: ClaimLeaf): string | null {
    if (leaf.operationType === '2') return null; // reversals are never deduped
    return `${leaf.memberWalletId}:${leaf.ndcHash}:${leaf.pharmacyWalletId}:${leaf.dateOfService}`;
  }

  /**
   * Check whether a fill already exists for this (member, ndc, pharmacy, date) combination.
   * Returns the existing entry if found, undefined otherwise.
   * Reversals always return undefined (they are never considered duplicates).
   */
  hasActiveFill(memberWalletId: string, ndcHash: string, pharmacyWalletId: string, dateOfService: string): ClaimAccumulatorEntry | undefined {
    const key = `${memberWalletId}:${ndcHash}:${pharmacyWalletId}:${dateOfService}`;
    const existingIndex = this.fillDedup.get(key);
    if (existingIndex === undefined) return undefined;
    return this.entries.get(existingIndex);
  }

  /**
   * Append a new claim to the accumulator tree.
   * Fills (operationType != '2') are deduplicated by (member, ndc, pharmacy, date).
   * If a duplicate fill is detected, the existing entry is returned instead of
   * appending a new leaf — this makes the operation idempotent.
   *
   * @param leaf  The 8-Field claim leaf (all values as decimal strings)
   * @param metadata  Non-cryptographic display metadata
   * @returns The ClaimAccumulatorEntry (existing if duplicate, new if unique)
   */
  appendClaim(leaf: ClaimLeaf, metadata: ClaimMetadata): ClaimAccumulatorEntry {
    // Dedup check for fills (not reversals)
    const dedupKey = ClaimAccumulatorService.fillDedupKey(leaf);
    if (dedupKey) {
      const existingIndex = this.fillDedup.get(dedupKey);
      if (existingIndex !== undefined) {
        const existing = this.entries.get(existingIndex);
        if (existing) return existing; // idempotent — return existing entry
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

    // Track in dedup index
    if (dedupKey) {
      this.fillDedup.set(dedupKey, leafIndex);
    }

    this.nextLeafIndex++;
    return entry;
  }

  // ─── Read ────────────────────────────────────────────────

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
