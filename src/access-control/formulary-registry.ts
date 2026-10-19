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

import { Field, MerkleTree, MerkleWitness } from 'o1js';
import { FormularyEntry } from './formulary-entry.js';
import { buildTreeBottomUp } from '../zkp/merkle-build.js';

/**
 * Formulary tree height — supports up to 32,768 medications per plan.
 *
 * Decoupled from the forest TREE_HEIGHT because a real PBM formulary
 * can have 5,000–20,000+ NDCs. Height 16 → 2^15 = 32,768 leaf slots.
 * Each leaf holds a FormularyEntry commitment (Poseidon hash).
 * The root is stored in EligibilityData.formularyRoot.
 *
 * Circuit impact: witness has 15 Poseidon hash siblings (vs 7 at height 8).
 * Adds ~8 hashes per proof — negligible on MINA.
 */
export const FORMULARY_TREE_HEIGHT = 16;

/** Maximum number of formulary entries (2^(height-1) = 32,768) */
const MAX_FORMULARY_ENTRIES = 2 ** (FORMULARY_TREE_HEIGHT - 1);

/** Circuit-compatible witness for formulary tree inclusion proofs */
export class FormularyMerkleWitness extends MerkleWitness(FORMULARY_TREE_HEIGHT) {}

/**
 * FormularyRegistry — off-chain manager for a benefit plan's formulary tree.
 *
 * Each leaf holds a FormularyEntry commitment (Poseidon hash of entry fields).
 * The root is stored in EligibilityData.formularyRoot.
 *
 * Used in AccessControlProgram to verify that a medication is on the
 * formulary and retrieve its coverage rules (tier, copay, limits).
 *
 * Pattern: modeled after BenefitPlanRegistry in src/eligibility/benefit-plan-registry.ts
 */
export class FormularyRegistry {
  private tree: MerkleTree;
  private entries: Map<bigint, FormularyEntry>;
  private nextIndex: bigint;

  constructor() {
    this.tree = new MerkleTree(FORMULARY_TREE_HEIGHT);
    this.entries = new Map();
    this.nextIndex = 0n;
  }

  /**
   * A registry holding these entries at indices 0..n-1, built in one bottom-up pass: the same tree, root and witnesses as
   * addEntry one at a time, with about fifteen times fewer hashes (see buildTreeBottomUp). Plan-bound formularies are
   * built this way, by the insurer at publish and by the engine when it binds a member.
   */
  static fromEntries(entries: readonly FormularyEntry[]): FormularyRegistry {
    if (entries.length > MAX_FORMULARY_ENTRIES) {
      throw new Error(`Formulary full: cannot exceed ${MAX_FORMULARY_ENTRIES} entries`);
    }
    const registry = new FormularyRegistry();
    entries.forEach((entry, i) => registry.entries.set(BigInt(i), entry));
    registry.nextIndex = BigInt(entries.length);
    buildTreeBottomUp(registry.tree, entries.map((entry) => entry.commitment()));
    return registry;
  }

  /** Get the current formulary Merkle root */
  getRoot(): Field {
    return this.tree.getRoot();
  }

  /** Get the number of registered formulary entries */
  get count(): number {
    return this.entries.size;
  }

  /**
   * Add a medication to the formulary.
   * Inserts the FormularyEntry commitment at the next available slot.
   *
   * @returns The assigned index and the new formulary root
   */
  addEntry(entry: FormularyEntry): { index: bigint; newRoot: Field } {
    if (this.nextIndex >= BigInt(MAX_FORMULARY_ENTRIES)) {
      throw new Error(
        `Formulary full: cannot exceed ${MAX_FORMULARY_ENTRIES} entries`,
      );
    }

    const index = this.nextIndex++;
    this.entries.set(index, entry);
    this.tree.setLeaf(index, entry.commitment());

    return { index, newRoot: this.tree.getRoot() };
  }

  /**
   * Get the FormularyEntry stored at a given index.
   * Returns undefined if the slot is empty.
   */
  getEntry(index: bigint): FormularyEntry | undefined {
    return this.entries.get(index);
  }

  /**
   * Get a circuit-compatible witness for an entry's position in the formulary.
   * Used in AccessControlProgram to prove entry existence.
   */
  getEntryWitness(index: bigint): FormularyMerkleWitness {
    return new FormularyMerkleWitness(this.tree.getWitness(index));
  }
}
