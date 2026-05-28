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

/**
 * Network tree height — supports up to 2,048 providers per plan network.
 *
 * Height 12 → 2^11 = 2,048 leaf slots.
 * Each leaf holds a provider walletId directly (already a Poseidon hash, no double-hashing).
 * The root is stored in EligibilityData.networkRoot.
 */
export const NETWORK_TREE_HEIGHT = 12;

/** Maximum number of providers per network (2^(height-1) = 2,048) */
const MAX_NETWORK_PROVIDERS = 2 ** (NETWORK_TREE_HEIGHT - 1);

/** Circuit-compatible witness for network tree inclusion proofs */
export class NetworkMerkleWitness extends MerkleWitness(NETWORK_TREE_HEIGHT) {}

/**
 * ProviderNetworkRegistry — off-chain manager for a benefit plan's provider network tree.
 *
 * Each leaf holds a provider walletId (already a Poseidon hash from wallet derivation).
 * The root is stored in EligibilityData.networkRoot.
 *
 * Used in InNetworkProgram to verify that a provider (prescriber/pharmacy) is
 * in the plan's network, not just lifecycle-active.
 *
 * Pattern: modeled after FormularyRegistry in src/access-control/formulary-registry.ts
 */
export class ProviderNetworkRegistry {
  private tree: MerkleTree;
  private providers: Map<bigint, Field>;
  private walletIndex: Map<string, bigint>;
  private nextIndex: bigint;

  constructor() {
    this.tree = new MerkleTree(NETWORK_TREE_HEIGHT);
    this.providers = new Map();
    this.walletIndex = new Map();
    this.nextIndex = 0n;
  }

  /** Get the current network Merkle root */
  getRoot(): Field {
    return this.tree.getRoot();
  }

  /** Get the number of registered providers */
  get count(): number {
    return this.providers.size;
  }

  /**
   * Add a provider to the network.
   * Inserts the provider walletId at the next available slot.
   *
   * @returns The assigned index and the new network root
   */
  addProvider(walletId: Field): { index: bigint; newRoot: Field } {
    if (this.nextIndex >= BigInt(MAX_NETWORK_PROVIDERS)) {
      throw new Error(
        `Network full: cannot exceed ${MAX_NETWORK_PROVIDERS} providers`,
      );
    }

    const walletStr = walletId.toString();
    if (this.walletIndex.has(walletStr)) {
      throw new Error('Provider already in network');
    }

    const index = this.nextIndex++;
    this.providers.set(index, walletId);
    this.walletIndex.set(walletStr, index);
    this.tree.setLeaf(index, walletId);

    return { index, newRoot: this.tree.getRoot() };
  }

  /**
   * Check if a provider is in the network.
   */
  isInNetwork(walletId: Field): boolean {
    return this.walletIndex.has(walletId.toString());
  }

  /**
   * Get the index of a provider in the network.
   * Returns undefined if not found.
   */
  getIndex(walletId: Field): bigint | undefined {
    return this.walletIndex.get(walletId.toString());
  }

  /**
   * Get a circuit-compatible witness for a provider's position in the network.
   * Used in InNetworkProgram to prove network membership.
   */
  getWitness(walletId: Field): NetworkMerkleWitness {
    const index = this.walletIndex.get(walletId.toString());
    if (index === undefined) {
      throw new Error('Provider not in network');
    }
    return new NetworkMerkleWitness(this.tree.getWitness(index));
  }
}
