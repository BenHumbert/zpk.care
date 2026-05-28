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

import { Field, MerkleTree, MerkleWitness, Poseidon } from 'o1js';
import { MessageData } from './message-data.js';
import { DelegationData } from './delegation-data.js';

// ─── Message Registry ───────────────────────────────────────

/** Message tree height — 2048 messages (2^10 leaves) */
export const MESSAGE_TREE_HEIGHT = 11;

/** Maximum number of messages (2^(height-1) = 1024) */
const MAX_MESSAGES = 2 ** (MESSAGE_TREE_HEIGHT - 1);

/** Circuit-compatible witness for message tree inclusion proofs */
export class MessageRegistryWitness extends MerkleWitness(MESSAGE_TREE_HEIGHT) {}

/**
 * MessageRegistry — off-chain manager for the message Merkle tree.
 *
 * Each leaf holds a MessageData commitment (Poseidon hash of message fields).
 * The root is packed into CareContract slot 7 via computeMessagingRoot().
 */
export class MessageRegistry {
  private tree: MerkleTree;
  private messages: Map<bigint, MessageData>;
  private nextIndex: bigint;

  constructor() {
    this.tree = new MerkleTree(MESSAGE_TREE_HEIGHT);
    this.messages = new Map();
    this.nextIndex = 0n;
  }

  /** Get the current message registry Merkle root */
  getRoot(): Field {
    return this.tree.getRoot();
  }

  /** Get the number of registered messages */
  get count(): number {
    return this.messages.size;
  }

  /**
   * Add a message to the registry.
   * Inserts the MessageData commitment at the next available slot.
   *
   * @returns The assigned index and the new registry root
   */
  addMessage(msg: MessageData): { index: bigint; newRoot: Field } {
    if (this.nextIndex >= BigInt(MAX_MESSAGES)) {
      throw new Error(
        `Message registry full: cannot exceed ${MAX_MESSAGES} messages`,
      );
    }

    const index = this.nextIndex++;
    this.messages.set(index, msg);
    this.tree.setLeaf(index, msg.commitment());

    return { index, newRoot: this.tree.getRoot() };
  }

  /**
   * Get the MessageData stored at a given index.
   * Returns undefined if the slot is empty.
   */
  getMessage(index: bigint): MessageData | undefined {
    return this.messages.get(index);
  }

  /**
   * Get a circuit-compatible witness for a message's position in the registry.
   */
  getWitness(index: bigint): MessageRegistryWitness {
    return new MessageRegistryWitness(this.tree.getWitness(index));
  }
}

// ─── Delegation Registry ────────────────────────────────────

/** Delegation tree height — 128 delegations (2^7 leaves) */
export const DELEGATION_TREE_HEIGHT = 8;

/** Maximum number of delegations (2^(height-1) = 128) */
const MAX_DELEGATIONS = 2 ** (DELEGATION_TREE_HEIGHT - 1);

/** Circuit-compatible witness for delegation tree inclusion proofs */
export class DelegationRegistryWitness extends MerkleWitness(DELEGATION_TREE_HEIGHT) {}

/**
 * DelegationRegistry — off-chain manager for the delegation Merkle tree.
 *
 * Each leaf holds a DelegationData commitment (Poseidon hash of delegation fields).
 * The root is packed into CareContract slot 7 via computeMessagingRoot().
 */
export class DelegationRegistry {
  private tree: MerkleTree;
  private delegations: Map<bigint, DelegationData>;
  private nextIndex: bigint;

  constructor() {
    this.tree = new MerkleTree(DELEGATION_TREE_HEIGHT);
    this.delegations = new Map();
    this.nextIndex = 0n;
  }

  /** Get the current delegation registry Merkle root */
  getRoot(): Field {
    return this.tree.getRoot();
  }

  /** Get the number of registered delegations */
  get count(): number {
    return this.delegations.size;
  }

  /**
   * Add a delegation to the registry.
   * Inserts the DelegationData commitment at the next available slot.
   *
   * @returns The assigned index and the new registry root
   */
  addDelegation(del: DelegationData): { index: bigint; newRoot: Field } {
    if (this.nextIndex >= BigInt(MAX_DELEGATIONS)) {
      throw new Error(
        `Delegation registry full: cannot exceed ${MAX_DELEGATIONS} delegations`,
      );
    }

    const index = this.nextIndex++;
    this.delegations.set(index, del);
    this.tree.setLeaf(index, del.commitment());

    return { index, newRoot: this.tree.getRoot() };
  }

  /**
   * Get the DelegationData stored at a given index.
   * Returns undefined if the slot is empty or revoked.
   */
  getDelegation(index: bigint): DelegationData | undefined {
    return this.delegations.get(index);
  }

  /**
   * Revoke a delegation by zeroing its Merkle leaf.
   *
   * Sets the leaf to Field(0) and removes the DelegationData from the map.
   * The index is NOT reclaimed — revoked slots stay empty permanently.
   * This ensures the delegation is no longer provable via inclusion.
   *
   * @returns The new delegation registry root
   * @throws If the index has no delegation (empty or already revoked)
   */
  revokeDelegation(index: bigint): { newRoot: Field } {
    if (!this.delegations.has(index)) {
      throw new Error(
        `Cannot revoke delegation at index ${index}: slot is empty or already revoked`,
      );
    }

    this.delegations.delete(index);
    this.tree.setLeaf(index, Field(0));

    return { newRoot: this.tree.getRoot() };
  }

  /**
   * Find a delegation by delegator + delegate wallet ID pair.
   *
   * Scans all active (non-revoked) delegations. Returns the index and
   * DelegationData if found, or undefined if no matching delegation exists.
   */
  findByWallets(
    delegatorWalletId: Field,
    delegateWalletId: Field,
  ): { index: bigint; delegation: DelegationData } | undefined {
    const delegatorStr = delegatorWalletId.toString();
    const delegateStr = delegateWalletId.toString();

    for (const [index, delegation] of this.delegations.entries()) {
      if (
        delegation.delegatorWalletId.toString() === delegatorStr &&
        delegation.delegateWalletId.toString() === delegateStr
      ) {
        return { index, delegation };
      }
    }
    return undefined;
  }

  /**
   * Get a circuit-compatible witness for a delegation's position in the registry.
   */
  getWitness(index: bigint): DelegationRegistryWitness {
    return new DelegationRegistryWitness(this.tree.getWitness(index));
  }
}

// ─── Key Registry ───────────────────────────────────────────

/** Key tree height — 1:1 with wallet registry (2048 keys) */
export const KEY_TREE_HEIGHT = 11;

/** Circuit-compatible witness for key tree inclusion proofs */
export class KeyRegistryWitness extends MerkleWitness(KEY_TREE_HEIGHT) {}

/**
 * KeyRegistry — off-chain manager for encryption public key Merkle tree.
 *
 * Each leaf holds Poseidon.hash([walletId, pubKeyX, pubKeyY]) at the SAME
 * index as the wallet in the wallet registry. This provides a 1:1 mapping
 * from wallet index → encryption public key.
 *
 * Key registration is proof-gated: only the wallet owner (verified via
 * ProofGateProof by the admin) can register/update their key.
 */
export class KeyRegistry {
  private tree: MerkleTree;
  private keyCommitments: Map<bigint, Field>;
  private keyCount: number;

  constructor() {
    this.tree = new MerkleTree(KEY_TREE_HEIGHT);
    this.keyCommitments = new Map();
    this.keyCount = 0;
  }

  /** Get the current key registry Merkle root */
  getRoot(): Field {
    return this.tree.getRoot();
  }

  /** Get the number of registered keys */
  get count(): number {
    return this.keyCount;
  }

  /**
   * Register (or update) an encryption public key for a wallet.
   *
   * Stores Poseidon.hash([walletId, pubKeyX, pubKeyY]) at the wallet's
   * index in the key tree. Same index as the wallet registry.
   *
   * @param walletIndex — the wallet's index (same as in wallet registry)
   * @param walletId — the wallet ID (for commitment binding)
   * @param pubKeyX — first half of X25519 public key as Field
   * @param pubKeyY — second half of X25519 public key as Field
   * @returns The new key registry root
   */
  registerKey(
    walletIndex: bigint,
    walletId: Field,
    pubKeyX: Field,
    pubKeyY: Field,
  ): { newRoot: Field } {
    const commitment = Poseidon.hash([walletId, pubKeyX, pubKeyY]);

    const isNew = !this.keyCommitments.has(walletIndex);
    this.keyCommitments.set(walletIndex, commitment);
    this.tree.setLeaf(walletIndex, commitment);

    if (isNew) {
      this.keyCount++;
    }

    return { newRoot: this.tree.getRoot() };
  }

  /**
   * Get the key commitment stored at a wallet index.
   * Returns Field(0) if no key has been registered.
   */
  getKeyCommitment(walletIndex: bigint): Field {
    return this.keyCommitments.get(walletIndex) ?? Field(0);
  }

  /**
   * Get a circuit-compatible witness for a key's position in the registry.
   */
  getWitness(walletIndex: bigint): KeyRegistryWitness {
    return new KeyRegistryWitness(this.tree.getWitness(walletIndex));
  }
}

// ─── Composite Root ─────────────────────────────────────────

/**
 * Compute the packed messaging root for CareContract slot 7.
 *
 * Packs three Merkle tree roots into a single Field:
 *   messagingRoot = Poseidon.hash([messageRegistryRoot, delegationRegistryRoot, keyRegistryRoot])
 *
 * @param messageRoot — message registry Merkle root
 * @param delegationRoot — delegation registry Merkle root
 * @param keyRoot — key registry Merkle root
 * @returns Packed Field for on-chain storage
 */
export function computeMessagingRoot(
  messageRoot: Field,
  delegationRoot: Field,
  keyRoot: Field,
): Field {
  return Poseidon.hash([messageRoot, delegationRoot, keyRoot]);
}
