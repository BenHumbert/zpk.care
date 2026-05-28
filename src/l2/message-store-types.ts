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
 * Message Store Types — data structures for encrypted message history.
 *
 * The Message Store is a global MerkleTree on the L2 sequencer that
 * persists encrypted messages between providers. Any node can query
 * the store for messages by sender, recipient, thread, or wallet
 * and receive a Merkle inclusion proof verifiable against the root.
 *
 * The root is stored on each L2Batch, and the store is replicated
 * via gossip to all leviathans for redundancy.
 *
 * PRIVACY: Only encrypted payloads (ciphertext + iv + tag) are stored.
 * The sequencer cannot read message content. Keys are derived
 * deterministically from the enrollment key via deriveEncryptionKeyPair().
 */

import { Field, Poseidon, MerkleTree, MerkleWitness } from 'o1js';

// ─── Tree Constants ─────────────────────────────────────────

/** MerkleTree height — 2^20 = 1,048,576 message capacity */
export const MESSAGE_STORE_HEIGHT = 20;

/** Merkle witness for the message store tree */
export class MessageStoreWitness extends MerkleWitness(MESSAGE_STORE_HEIGHT) {}

// ─── Stored Message ─────────────────────────────────────────

/**
 * StoredMessage — the 5 Fields that form a single message leaf.
 *
 * The leaf hash is Poseidon.hash of these 5 fields.
 * The actual encrypted payload is stored alongside but NOT hashed
 * into the tree (too large for a Field).
 */
export interface StoredMessage {
  /** Poseidon commitment of message content (ciphertext hash) */
  messageCommitment: string;
  /** Sender wallet ID (Poseidon hash) */
  senderWalletId: string;
  /** Recipient wallet ID (Poseidon hash) */
  recipientWalletId: string;
  /** Message type: '1'=clinical, '2'=admin, '3'=eScript, '4'=text, '5'=system, '6'=pcp_assign, '7'=access_grant */
  messageType: string;
  /** Poseidon hash of thread identifier (groups related messages) */
  threadIdHash: string;
}

/**
 * Compute the Poseidon hash of a StoredMessage (5 Fields → 1 hash).
 * This hash is stored as the leaf value in the MerkleTree.
 */
export function computeMessageLeafHash(message: StoredMessage): Field {
  return Poseidon.hash([
    Field(BigInt(message.messageCommitment)),
    Field(BigInt(message.senderWalletId)),
    Field(BigInt(message.recipientWalletId)),
    Field(BigInt(message.messageType)),
    Field(BigInt(message.threadIdHash)),
  ]);
}

// ─── Message Payload ────────────────────────────────────────

/**
 * MessagePayload — the encrypted message data stored alongside the leaf.
 *
 * This data is NOT hashed into the Merkle tree — it's the actual
 * encrypted message content. Only the recipient can decrypt it
 * using their X25519 private key derived from their enrollment key.
 */
export interface MessagePayload {
  /** Encrypted message content (hex-encoded ciphertext) */
  ciphertext: string;
  /** AES-GCM initialization vector (hex) */
  iv: string;
  /** AES-GCM authentication tag (hex) */
  tag: string;
  /** Timestamp when the message was stored */
  timestamp: number;
  /** L2 receipt ID that submitted this message (optional) */
  receiptId?: string;
}

// ─── Message Store Entry ────────────────────────────────────

/**
 * MessageStoreEntry — full message record (leaf + payload + position).
 *
 * Returned by query methods. The `leafIndex` can be used to request
 * a Merkle witness for independent verification.
 */
export interface MessageStoreEntry {
  /** Position in the MerkleTree (0-indexed) */
  leafIndex: bigint;
  /** The cryptographic leaf data (5 Fields) */
  message: StoredMessage;
  /** The Poseidon hash of the message leaf (what's actually in the tree) */
  leafHash: string;
  /** The encrypted payload (ciphertext + iv + tag) */
  payload: MessagePayload;
}

// ─── Message Store State (Checkpoint) ───────────────────────

/**
 * Serializable snapshot of the message store state.
 * Used for checkpoint export/restore.
 */
export interface MessageStoreState {
  /** Next available leaf index */
  nextLeafIndex: bigint;
  /** All entries (message + payload + index) */
  entries: MessageStoreEntry[];
  /** Current tree root as decimal string */
  currentRoot: string;
}
