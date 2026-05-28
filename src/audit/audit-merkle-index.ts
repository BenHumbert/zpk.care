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
 * AuditMerkleIndex — Selective Merkle Witness for Audit Events.
 *
 * Maintains a MerkleTree(20) parallel to the sequential Poseidon hash chain
 * in AuditService. Each audit event's `eventCommitment` is stored as a leaf,
 * enabling O(log N) selective disclosure: prove a single event exists in the
 * audit log without revealing any other events.
 *
 * Follows the ClaimAccumulatorService pattern:
 *   - Append-only leaf insertion
 *   - Merkle witnesses for any leaf by index
 *   - Export/restore for checkpoint persistence
 *
 * The hash chain (AuditService) provides tamper-evident DA (linear walk).
 * The Merkle tree (this class) adds selective witness disclosure (O(log N)).
 * Both use the same eventCommitment — no extra hashing.
 */

import { Field, MerkleTree, MerkleWitness } from 'o1js';
import { AuditService } from './audit-service.js';
import type { AuditEvent } from './audit-types.js';

/** Tree height — supports ~1M audit events (2^20 = 1,048,576) */
export const AUDIT_TREE_HEIGHT = 20;

/** MerkleWitness class for audit event inclusion proofs */
export class AuditEventWitness extends MerkleWitness(AUDIT_TREE_HEIGHT) {}

/**
 * Serializable snapshot for checkpoint persistence.
 * Stores ordered commitments as decimal strings for tree rebuild.
 */
export interface AuditMerkleState {
  nextLeafIndex: bigint;
  /** Ordered event commitments (decimal strings) — rebuilds tree on restore */
  eventCommitments: string[];
  /** Current Merkle root (decimal string) — for validation after restore */
  currentRoot: string;
}

/**
 * Result of a selective witness query.
 * Contains everything needed for off-chain verification.
 */
export interface SelectiveWitnessResult {
  /** Merkle witness (sibling path from leaf to root) */
  witness: AuditEventWitness;
  /** The event's Poseidon commitment (leaf value) */
  eventCommitment: Field;
  /** Current Merkle root at time of query */
  root: Field;
  /** Leaf index in the tree */
  eventIndex: bigint;
}

export class AuditMerkleIndex {
  /** The backing Merkle tree */
  private tree: MerkleTree;

  /** Next available leaf index */
  private nextLeafIndex: bigint = 0n;

  /** Event commitments by leaf index (for witness queries) */
  private eventCommitments: Map<bigint, Field> = new Map();

  constructor() {
    this.tree = new MerkleTree(AUDIT_TREE_HEIGHT);
  }

  // ─── Write ───────────────────────────────────────────────

  /**
   * Append an audit event to the Merkle tree.
   *
   * Computes the event commitment via AuditService.computeEventCommitment()
   * and stores it as a leaf.
   *
   * @returns The leaf index assigned to this event
   */
  appendEvent(event: AuditEvent): bigint {
    const commitment = AuditService.computeEventCommitment(event);
    return this.appendEventFromCommitment(commitment);
  }

  /**
   * Append a pre-computed event commitment to the Merkle tree.
   *
   * Used by L2SequencerService when the commitment is already computed
   * for the hash chain (avoids double-hashing).
   *
   * @returns The leaf index assigned to this commitment
   */
  appendEventFromCommitment(commitment: Field): bigint {
    const leafIndex = this.nextLeafIndex;

    this.tree.setLeaf(leafIndex, commitment);
    this.eventCommitments.set(leafIndex, commitment);

    this.nextLeafIndex++;
    return leafIndex;
  }

  // ─── Read ────────────────────────────────────────────────

  /** Current Merkle root of the audit event tree */
  getRoot(): Field {
    return this.tree.getRoot();
  }

  /** Number of events stored in the tree */
  getEventCount(): bigint {
    return this.nextLeafIndex;
  }

  /**
   * Get a selective Merkle witness for a specific event.
   *
   * Returns everything needed for off-chain verification:
   * the witness path, the event commitment (leaf), the current root,
   * and the event index.
   *
   * @throws If eventIndex >= nextLeafIndex (no event at that index)
   */
  getSelectiveWitness(eventIndex: bigint): SelectiveWitnessResult {
    if (eventIndex >= this.nextLeafIndex) {
      throw new Error(
        `Event index ${eventIndex} out of range (${this.nextLeafIndex} events stored)`,
      );
    }

    const commitment = this.eventCommitments.get(eventIndex);
    if (!commitment) {
      throw new Error(`Event commitment not found for index ${eventIndex}`);
    }

    const witness = new AuditEventWitness(this.tree.getWitness(eventIndex));

    return {
      witness,
      eventCommitment: commitment,
      root: this.getRoot(),
      eventIndex,
    };
  }

  // ─── Verify (static) ────────────────────────────────────

  /**
   * Verify a selective Merkle witness against an expected root.
   *
   * This is the core selective disclosure primitive: given a witness
   * and a commitment, verify that the commitment is included in the
   * tree with the expected root — without knowing any other leaves.
   */
  static verifySelectiveWitness(
    witness: AuditEventWitness,
    eventCommitment: Field,
    expectedRoot: Field,
  ): boolean {
    const computedRoot = witness.calculateRoot(eventCommitment);
    return computedRoot.equals(expectedRoot).toBoolean();
  }

  // ─── Checkpoint Export / Restore ─────────────────────────

  /**
   * Export full index state for checkpoint persistence.
   *
   * Stores ordered commitments as decimal strings. On restore,
   * the tree is rebuilt by re-inserting each commitment.
   */
  exportState(): AuditMerkleState {
    const commitments: string[] = [];
    for (let i = 0n; i < this.nextLeafIndex; i++) {
      const c = this.eventCommitments.get(i);
      if (c) commitments.push(c.toString());
    }

    return {
      nextLeafIndex: this.nextLeafIndex,
      eventCommitments: commitments,
      currentRoot: this.getRoot().toString(),
    };
  }

  /**
   * Restore index state from a checkpoint.
   *
   * Rebuilds the Merkle tree from the stored commitment list.
   */
  restoreState(state: AuditMerkleState): void {
    this.tree = new MerkleTree(AUDIT_TREE_HEIGHT);
    this.nextLeafIndex = 0n;
    this.eventCommitments.clear();

    for (const commitmentStr of state.eventCommitments) {
      const commitment = Field(BigInt(commitmentStr));
      this.appendEventFromCommitment(commitment);
    }
  }
}
