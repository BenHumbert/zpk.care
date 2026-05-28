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
 * Message Store Service — MerkleTree-backed encrypted message index.
 *
 * Maintains a global MerkleTree(20) on the L2 sequencer that stores
 * encrypted messages between providers. Provides:
 *   - O(1) append of new messages
 *   - O(1) index lookups by sender, recipient, wallet (union), or thread
 *   - Merkle inclusion proofs for any message (verifiable off-chain)
 *   - Full export/restore for checkpoint persistence
 *
 * The tree root is stored on each L2Batch, and encrypted payloads
 * are replicated via gossip to all leviathans.
 *
 * PRIVACY: Only encrypted payloads are stored. The sequencer cannot
 * read message content.
 */

import { MerkleTree } from 'o1js';
import {
  MESSAGE_STORE_HEIGHT,
  MessageStoreWitness,
  computeMessageLeafHash,
  type StoredMessage,
  type MessagePayload,
  type MessageStoreEntry,
  type MessageStoreState,
} from './message-store-types.js';

export class MessageStoreService {
  /** The backing Merkle tree */
  private tree: MerkleTree;

  /** Next available leaf index */
  private nextLeafIndex: bigint = 0n;

  /** Full entries by leaf index */
  private entries: Map<bigint, MessageStoreEntry> = new Map();

  // ─── Indexes (walletId/threadIdHash → leaf indices) ────

  private senderIndex: Map<string, bigint[]> = new Map();
  private recipientIndex: Map<string, bigint[]> = new Map();
  private threadIndex: Map<string, bigint[]> = new Map();
  private walletIndex: Map<string, bigint[]> = new Map(); // sender OR recipient union

  constructor() {
    this.tree = new MerkleTree(MESSAGE_STORE_HEIGHT);
  }

  // ─── Write ───────────────────────────────────────────────

  /**
   * Append a new message to the message store tree.
   *
   * @param message  The 5-Field stored message (all values as decimal strings)
   * @param payload  The encrypted message payload (ciphertext + iv + tag)
   * @returns The MessageStoreEntry with assigned leafIndex and leafHash
   */
  appendMessage(message: StoredMessage, payload: MessagePayload): MessageStoreEntry {
    const leafIndex = this.nextLeafIndex;
    const leafHash = computeMessageLeafHash(message);

    // Store in Merkle tree
    this.tree.setLeaf(leafIndex, leafHash);

    // Build entry
    const entry: MessageStoreEntry = {
      leafIndex,
      message,
      leafHash: leafHash.toString(),
      payload,
    };

    // Store entry
    this.entries.set(leafIndex, entry);

    // Update indexes
    this.addToIndex(this.senderIndex, message.senderWalletId, leafIndex);
    this.addToIndex(this.recipientIndex, message.recipientWalletId, leafIndex);
    this.addToIndex(this.threadIndex, message.threadIdHash, leafIndex);
    // Wallet index = union of sender + recipient
    this.addToIndex(this.walletIndex, message.senderWalletId, leafIndex);
    if (message.senderWalletId !== message.recipientWalletId) {
      this.addToIndex(this.walletIndex, message.recipientWalletId, leafIndex);
    }

    this.nextLeafIndex++;
    return entry;
  }

  // ─── Read ────────────────────────────────────────────────

  /** Current Merkle root of the message store tree */
  getRoot(): bigint {
    return this.tree.getRoot().toBigInt();
  }

  /** Merkle witness for a specific leaf index */
  getWitness(leafIndex: bigint): MessageStoreWitness {
    return new MessageStoreWitness(this.tree.getWitness(leafIndex));
  }

  /** Number of messages stored */
  getMessageCount(): bigint {
    return this.nextLeafIndex;
  }

  /** Get a single entry by leaf index (or undefined) */
  getEntry(leafIndex: bigint): MessageStoreEntry | undefined {
    return this.entries.get(leafIndex);
  }

  // ─── Index Queries ───────────────────────────────────────

  /** All messages sent by a wallet ID */
  getMessagesBySender(senderWalletId: string): MessageStoreEntry[] {
    return this.getEntriesByIndex(this.senderIndex, senderWalletId);
  }

  /** All messages received by a wallet ID */
  getMessagesByRecipient(recipientWalletId: string): MessageStoreEntry[] {
    return this.getEntriesByIndex(this.recipientIndex, recipientWalletId);
  }

  /** All messages where the wallet is sender OR recipient */
  getMessagesByWallet(walletId: string): MessageStoreEntry[] {
    return this.getEntriesByIndex(this.walletIndex, walletId);
  }

  /** All messages in a thread (by thread ID hash) */
  getMessagesByThread(threadIdHash: string): MessageStoreEntry[] {
    return this.getEntriesByIndex(this.threadIndex, threadIdHash);
  }

  /**
   * Get a message with its Merkle inclusion proof.
   * Returns the entry, witness JSON, and current root for off-chain verification.
   */
  getMessageWithProof(leafIndex: bigint): {
    entry: MessageStoreEntry;
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
   * Export full message store state for checkpoint persistence.
   */
  exportState(): MessageStoreState {
    const entries: MessageStoreEntry[] = [];
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
   * Restore message store state from a checkpoint.
   * Rebuilds the Merkle tree and all indexes from the entry list.
   */
  restoreState(state: MessageStoreState): void {
    // Reset everything
    this.tree = new MerkleTree(MESSAGE_STORE_HEIGHT);
    this.nextLeafIndex = 0n;
    this.entries.clear();
    this.senderIndex.clear();
    this.recipientIndex.clear();
    this.threadIndex.clear();
    this.walletIndex.clear();

    // Re-append each entry (rebuilds tree + indexes)
    for (const entry of state.entries) {
      this.appendMessage(entry.message, entry.payload);
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

  private getEntriesByIndex(index: Map<string, bigint[]>, key: string): MessageStoreEntry[] {
    const indices = index.get(key) ?? [];
    return indices
      .map((i) => this.entries.get(i))
      .filter((e): e is MessageStoreEntry => e !== undefined);
  }
}
