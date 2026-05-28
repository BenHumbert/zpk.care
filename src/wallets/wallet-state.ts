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

import { Field, Struct, Poseidon, MerkleTree, MerkleWitness } from 'o1js';

/**
 * Wallet State
 *
 * Represents what a proof-gated wallet "contains" in the zkApp.
 * The zkApp maintains a Merkle tree of all wallet states.
 * Each leaf is a WalletState commitment.
 *
 * A wallet holds:
 *   - Its identity (the wallet "address")
 *   - A credential inventory root (Merkle root of credentials owned by this wallet)
 *   - A nonce (prevents replay attacks on wallet operations)
 */

/** Height of the wallet registry tree (supports 1024 wallets) */
export const WALLET_TREE_HEIGHT = 11;

/** Circuit-compatible witness for the wallet registry tree */
export class WalletRegistryWitness extends MerkleWitness(WALLET_TREE_HEIGHT) {}

/** Height of per-wallet credential inventory tree (supports 64 credentials per wallet) */
export const CREDENTIAL_INVENTORY_HEIGHT = 7;

/** Circuit-compatible witness for a wallet's credential inventory */
export class CredentialInventoryWitness extends MerkleWitness(CREDENTIAL_INVENTORY_HEIGHT) {}

/**
 * WalletState — on-chain representation of a single wallet.
 *
 * This is the leaf value in the wallet registry Merkle tree.
 */
export class WalletState extends Struct({
  /** The wallet identity (derived from entity data + domain tag) */
  walletId: Field,
  /** Merkle root of credentials held by this wallet */
  credentialInventoryRoot: Field,
  /** Monotonically increasing nonce — prevents replay of wallet operations */
  nonce: Field,
}) {
  /** Compute the commitment stored as a Merkle leaf */
  commitment(): Field {
    return Poseidon.hash([
      this.walletId,
      this.credentialInventoryRoot,
      this.nonce,
    ]);
  }

  /** Create a new wallet with an empty credential inventory for a given identity */
  static init(walletId: Field): WalletState {
    // Empty credential inventory tree root (all leaves are Field(0))
    const emptyTree = new MerkleTree(CREDENTIAL_INVENTORY_HEIGHT);
    return new WalletState({
      walletId,
      credentialInventoryRoot: emptyTree.getRoot(),
      nonce: Field(0),
    });
  }
}

/**
 * WalletRegistry — manages all wallet states in a single Merkle tree.
 *
 * The zkApp stores only the registry root on-chain.
 * Individual wallet lookups happen off-chain with Merkle witnesses.
 */
export class WalletRegistry {
  private tree: MerkleTree;
  private walletIndices: Map<string, bigint>;
  private walletStates: Map<string, WalletState>;
  private nextIndex: bigint;

  constructor() {
    this.tree = new MerkleTree(WALLET_TREE_HEIGHT);
    this.walletIndices = new Map();
    this.walletStates = new Map();
    this.nextIndex = 0n;
  }

  /** Register a new wallet. Returns the assigned index. */
  register(walletId: Field): bigint {
    const key = walletId.toString();
    if (this.walletIndices.has(key)) {
      throw new Error(`Wallet already registered: ${key}`);
    }

    const index = this.nextIndex++;
    const state = WalletState.init(walletId);

    this.walletIndices.set(key, index);
    this.walletStates.set(key, state);
    this.tree.setLeaf(index, state.commitment());

    return index;
  }

  /** Check if a wallet is registered */
  isRegistered(walletId: Field): boolean {
    return this.walletIndices.has(walletId.toString());
  }

  /** Get the current state of a wallet */
  getState(walletId: Field): WalletState {
    const state = this.walletStates.get(walletId.toString());
    if (!state) throw new Error('Wallet not registered');
    return state;
  }

  /** Update wallet state (e.g., after receiving a credential) */
  updateState(walletId: Field, newState: WalletState): void {
    const key = walletId.toString();
    const index = this.walletIndices.get(key);
    if (index === undefined) throw new Error('Wallet not registered');

    this.walletStates.set(key, newState);
    this.tree.setLeaf(index, newState.commitment());
  }

  /** Get the index of a wallet in the registry tree */
  getIndex(walletId: Field): bigint {
    const index = this.walletIndices.get(walletId.toString());
    if (index === undefined) throw new Error('Wallet not registered');
    return index;
  }

  /** Get a circuit-compatible witness for a wallet's position in the registry */
  getWitness(walletId: Field): WalletRegistryWitness {
    const index = this.getIndex(walletId);
    return new WalletRegistryWitness(this.tree.getWitness(index));
  }

  /** Get the registry Merkle root (this is what goes on-chain) */
  getRoot(): Field {
    return this.tree.getRoot();
  }

  /** Get witness for the next available (empty) slot — for proveRegistration */
  getNextSlotWitness(): WalletRegistryWitness {
    return new WalletRegistryWitness(this.tree.getWitness(this.nextIndex));
  }

  /** Get witness by raw index — for proveWalletUpdate */
  getWitnessByIndex(index: bigint): WalletRegistryWitness {
    return new WalletRegistryWitness(this.tree.getWitness(index));
  }

  /** Get total number of registered wallets */
  get count(): number {
    return this.walletIndices.size;
  }
}
