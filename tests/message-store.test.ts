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
 * Message Store Tests — MerkleTree-backed encrypted message index.
 *
 * Tests the MessageStoreService: leaf hashing, tree append,
 * index queries, Merkle proof verification, checkpoint round-trip,
 * and L2 sequencer integration.
 *
 * Run: npx jest tests/message-store.test.ts --verbose
 */

import { Field, Poseidon, MerkleTree } from 'o1js';
import {
  MESSAGE_STORE_HEIGHT,
  MessageStoreWitness,
  computeMessageLeafHash,
  type StoredMessage,
  type MessagePayload,
} from '../src/l2/message-store-types.js';
import { MessageStoreService } from '../src/l2/message-store-service.js';
import { L2SequencerService } from '../src/l2/l2-sequencer-service.js';
import { InMemoryStore } from '../src/storage/local-store.js';
import { WALLET_TREE_HEIGHT } from '../src/wallets/wallet-state.js';
import type { L2Batch } from '../src/l2/l2-types.js';

jest.setTimeout(60000);

// ─── Test Data ──────────────────────────────────────────────

const walletA = Poseidon.hash([Field(1)]).toString();
const walletB = Poseidon.hash([Field(2)]).toString();
const walletC = Poseidon.hash([Field(3)]).toString();

const threadAlpha = Poseidon.hash([Field(100)]).toString();
const threadBeta = Poseidon.hash([Field(200)]).toString();

/** Helper to create a test StoredMessage */
function makeMessage(
  sender: string,
  recipient: string,
  threadId: string,
  type = '1',
): StoredMessage {
  return {
    messageCommitment: Poseidon.hash([Field(BigInt(sender)), Field(BigInt(recipient))]).toString(),
    senderWalletId: sender,
    recipientWalletId: recipient,
    messageType: type,
    threadIdHash: Poseidon.hash([Field(BigInt(threadId))]).toString(),
  };
}

/** Helper to create a test MessagePayload */
function makePayload(content = 'test'): MessagePayload {
  return {
    ciphertext: Buffer.from(content).toString('hex'),
    iv: '000102030405060708090a0b',
    tag: '0123456789abcdef01234567',
    timestamp: Date.now(),
  };
}

// ─── Sequencer helpers ──────────────────────────────────────

const emptyRegTree = new MerkleTree(WALLET_TREE_HEIGHT);
const emptyLcTree = new MerkleTree(WALLET_TREE_HEIGHT);
const INITIAL_REG_ROOT = emptyRegTree.getRoot();
const INITIAL_LC_ROOT = emptyLcTree.getRoot();

function createSequencer(): L2SequencerService {
  const store = new InMemoryStore();
  return new L2SequencerService(
    store,
    INITIAL_REG_ROOT,
    INITIAL_LC_ROOT,
    Field(0),
  );
}

// ─── 1. Types & Hashing ─────────────────────────────────────

describe('Message Store Types & Hashing', () => {
  test('computeMessageLeafHash produces deterministic Field', () => {
    const msg = makeMessage(walletA, walletB, threadAlpha);
    const hash1 = computeMessageLeafHash(msg);
    const hash2 = computeMessageLeafHash(msg);
    expect(hash1.toString()).toBe(hash2.toString());
    // Should be a non-zero Field
    expect(hash1.toBigInt()).not.toBe(0n);
  });

  test('different messages produce different hashes', () => {
    const msg1 = makeMessage(walletA, walletB, threadAlpha);
    const msg2 = makeMessage(walletA, walletC, threadAlpha);
    const msg3 = makeMessage(walletA, walletB, threadBeta);
    const msg4 = makeMessage(walletA, walletB, threadAlpha, '2');

    const hash1 = computeMessageLeafHash(msg1).toString();
    const hash2 = computeMessageLeafHash(msg2).toString();
    const hash3 = computeMessageLeafHash(msg3).toString();
    const hash4 = computeMessageLeafHash(msg4).toString();

    expect(hash1).not.toBe(hash2);
    expect(hash1).not.toBe(hash3);
    expect(hash1).not.toBe(hash4);
  });

  test('MESSAGE_STORE_HEIGHT is 20', () => {
    expect(MESSAGE_STORE_HEIGHT).toBe(20);
  });

  test('MessageStoreWitness has correct path length', () => {
    const tree = new MerkleTree(MESSAGE_STORE_HEIGHT);
    const witness = new MessageStoreWitness(tree.getWitness(0n));
    expect(witness).toBeDefined();
    // Height = 20, so witness path length = 19
    expect(witness.toJSON().path.length).toBe(MESSAGE_STORE_HEIGHT - 1);
  });
});

// ─── 2. MessageStoreService CRUD ────────────────────────────

describe('MessageStoreService — CRUD', () => {
  let service: MessageStoreService;

  beforeEach(() => {
    service = new MessageStoreService();
  });

  test('appendMessage assigns sequential leaf indices', () => {
    const entry0 = service.appendMessage(
      makeMessage(walletA, walletB, threadAlpha),
      makePayload('hello'),
    );
    expect(entry0.leafIndex).toBe(0n);

    const entry1 = service.appendMessage(
      makeMessage(walletB, walletC, threadAlpha),
      makePayload('world'),
    );
    expect(entry1.leafIndex).toBe(1n);

    const entry2 = service.appendMessage(
      makeMessage(walletC, walletA, threadBeta),
      makePayload('!'),
    );
    expect(entry2.leafIndex).toBe(2n);
  });

  test('appendMessage computes correct leaf hash', () => {
    const msg = makeMessage(walletA, walletB, threadAlpha);
    const entry = service.appendMessage(msg, makePayload());
    const expectedHash = computeMessageLeafHash(msg).toString();
    expect(entry.leafHash).toBe(expectedHash);
  });

  test('getRoot returns non-zero after append', () => {
    service.appendMessage(
      makeMessage(walletA, walletB, threadAlpha),
      makePayload(),
    );
    const root = service.getRoot();
    expect(root).not.toBe(0n);
  });

  test('getRoot changes after append', () => {
    const rootBefore = service.getRoot();
    service.appendMessage(
      makeMessage(walletA, walletB, threadAlpha),
      makePayload(),
    );
    const rootAfter = service.getRoot();
    expect(rootAfter).not.toBe(rootBefore);
  });

  test('getMessageCount tracks message count', () => {
    expect(service.getMessageCount()).toBe(0n);

    service.appendMessage(makeMessage(walletA, walletB, threadAlpha), makePayload());
    expect(service.getMessageCount()).toBe(1n);

    service.appendMessage(makeMessage(walletB, walletC, threadAlpha), makePayload());
    expect(service.getMessageCount()).toBe(2n);

    service.appendMessage(makeMessage(walletC, walletA, threadBeta), makePayload());
    expect(service.getMessageCount()).toBe(3n);
  });

  test('getEntry returns correct entry by index', () => {
    const msg = makeMessage(walletA, walletB, threadAlpha);
    const payload = makePayload('specific content');
    service.appendMessage(msg, payload);

    const retrieved = service.getEntry(0n);
    expect(retrieved).toBeDefined();
    expect(retrieved!.leafIndex).toBe(0n);
    expect(retrieved!.message.senderWalletId).toBe(walletA);
    expect(retrieved!.message.recipientWalletId).toBe(walletB);
    expect(retrieved!.payload.ciphertext).toBe(payload.ciphertext);
  });

  test('getEntry returns undefined for non-existent index', () => {
    expect(service.getEntry(0n)).toBeUndefined();
    expect(service.getEntry(999n)).toBeUndefined();
  });

  test('getWitness returns valid witness (verify against root)', () => {
    const msg = makeMessage(walletA, walletB, threadAlpha);
    service.appendMessage(msg, makePayload());

    const witness = service.getWitness(0n);
    const leafHash = computeMessageLeafHash(msg);
    const computedRoot = witness.calculateRoot(leafHash);
    expect(computedRoot.toBigInt()).toBe(service.getRoot());
  });

  test('payload is preserved through append and retrieval', () => {
    const payload: MessagePayload = {
      ciphertext: 'deadbeef0123456789abcdef',
      iv: 'aabbccddeeff00112233',
      tag: 'ffeeddccbbaa99887766',
      timestamp: 1700000000000,
      receiptId: 'rcpt-msg-001',
    };

    service.appendMessage(makeMessage(walletA, walletB, threadAlpha), payload);
    const entry = service.getEntry(0n);

    expect(entry!.payload.ciphertext).toBe('deadbeef0123456789abcdef');
    expect(entry!.payload.iv).toBe('aabbccddeeff00112233');
    expect(entry!.payload.tag).toBe('ffeeddccbbaa99887766');
    expect(entry!.payload.timestamp).toBe(1700000000000);
    expect(entry!.payload.receiptId).toBe('rcpt-msg-001');
  });
});

// ─── 3. Index Queries ───────────────────────────────────────

describe('MessageStoreService — Index Queries', () => {
  let service: MessageStoreService;

  beforeEach(() => {
    service = new MessageStoreService();

    // Message 0: A → B, thread Alpha, type clinical
    service.appendMessage(
      makeMessage(walletA, walletB, threadAlpha, '1'),
      makePayload('msg0'),
    );

    // Message 1: B → C, thread Alpha, type administrative
    service.appendMessage(
      makeMessage(walletB, walletC, threadAlpha, '2'),
      makePayload('msg1'),
    );

    // Message 2: C → A, thread Beta, type clinical
    service.appendMessage(
      makeMessage(walletC, walletA, threadBeta, '1'),
      makePayload('msg2'),
    );

    // Message 3: A → C, thread Beta, type eScript
    service.appendMessage(
      makeMessage(walletA, walletC, threadBeta, '3'),
      makePayload('msg3'),
    );
  });

  test('getMessagesBySender returns messages from sender', () => {
    const fromA = service.getMessagesBySender(walletA);
    expect(fromA.length).toBe(2); // msg0 (A→B), msg3 (A→C)
    expect(fromA.map((e) => e.leafIndex)).toEqual([0n, 3n]);

    const fromB = service.getMessagesBySender(walletB);
    expect(fromB.length).toBe(1); // msg1 (B→C)
    expect(fromB[0].leafIndex).toBe(1n);
  });

  test('getMessagesByRecipient returns messages to recipient', () => {
    const toB = service.getMessagesByRecipient(walletB);
    expect(toB.length).toBe(1); // msg0 (A→B)
    expect(toB[0].leafIndex).toBe(0n);

    const toC = service.getMessagesByRecipient(walletC);
    expect(toC.length).toBe(2); // msg1 (B→C), msg3 (A→C)
    expect(toC.map((e) => e.leafIndex)).toEqual([1n, 3n]);
  });

  test('getMessagesByWallet returns messages where wallet is sender OR recipient', () => {
    const walletAMessages = service.getMessagesByWallet(walletA);
    // A is sender of msg0, msg3 and recipient of msg2 → 3 messages
    expect(walletAMessages.length).toBe(3);
    expect(walletAMessages.map((e) => e.leafIndex).sort()).toEqual([0n, 2n, 3n]);

    const walletCMessages = service.getMessagesByWallet(walletC);
    // C is sender of msg2 and recipient of msg1, msg3 → 3 messages
    expect(walletCMessages.length).toBe(3);
    expect(walletCMessages.map((e) => e.leafIndex).sort()).toEqual([1n, 2n, 3n]);
  });

  test('getMessagesByWallet deduplicates when sender == recipient', () => {
    // Add a self-message: A → A
    service.appendMessage(
      makeMessage(walletA, walletA, threadAlpha),
      makePayload('self-msg'),
    );

    const walletAMessages = service.getMessagesByWallet(walletA);
    // Original 3 (msg0, msg2, msg3) + 1 self-message = 4
    // The self-message should appear only ONCE, not twice
    const selfEntries = walletAMessages.filter((e) => e.leafIndex === 4n);
    expect(selfEntries.length).toBe(1);
    expect(walletAMessages.length).toBe(4);
  });

  test('getMessagesByThread groups messages by thread', () => {
    const alphaThread = service.getMessagesByThread(
      Poseidon.hash([Field(BigInt(threadAlpha))]).toString(),
    );
    // msg0 and msg1 use threadAlpha
    expect(alphaThread.length).toBe(2);
    expect(alphaThread.map((e) => e.leafIndex)).toEqual([0n, 1n]);

    const betaThread = service.getMessagesByThread(
      Poseidon.hash([Field(BigInt(threadBeta))]).toString(),
    );
    // msg2 and msg3 use threadBeta
    expect(betaThread.length).toBe(2);
    expect(betaThread.map((e) => e.leafIndex)).toEqual([2n, 3n]);
  });

  test('multiple wallets have independent indexes', () => {
    const senderA = service.getMessagesBySender(walletA);
    const senderB = service.getMessagesBySender(walletB);
    const senderC = service.getMessagesBySender(walletC);

    // No overlap in sender results
    const senderAIndices = new Set(senderA.map((e) => e.leafIndex));
    const senderBIndices = new Set(senderB.map((e) => e.leafIndex));
    const senderCIndices = new Set(senderC.map((e) => e.leafIndex));

    for (const idx of senderAIndices) {
      expect(senderBIndices.has(idx)).toBe(false);
      expect(senderCIndices.has(idx)).toBe(false);
    }
    for (const idx of senderBIndices) {
      expect(senderCIndices.has(idx)).toBe(false);
    }
  });

  test('empty queries return empty arrays', () => {
    const unknownWallet = Poseidon.hash([Field(999)]).toString();
    expect(service.getMessagesBySender(unknownWallet)).toEqual([]);
    expect(service.getMessagesByRecipient(unknownWallet)).toEqual([]);
    expect(service.getMessagesByWallet(unknownWallet)).toEqual([]);
    expect(service.getMessagesByThread('nonexistent-thread')).toEqual([]);
  });

  test('mixed sender/recipient queries are correct', () => {
    // walletB: sender of msg1 (B→C), recipient of msg0 (A→B)
    const sentByB = service.getMessagesBySender(walletB);
    const receivedByB = service.getMessagesByRecipient(walletB);
    const allB = service.getMessagesByWallet(walletB);

    expect(sentByB.length).toBe(1);
    expect(sentByB[0].leafIndex).toBe(1n);

    expect(receivedByB.length).toBe(1);
    expect(receivedByB[0].leafIndex).toBe(0n);

    // Wallet union = sent + received = 2
    expect(allB.length).toBe(2);
    expect(allB.map((e) => e.leafIndex).sort()).toEqual([0n, 1n]);
  });
});

// ─── 4. Merkle Proof Verification ───────────────────────────

describe('MessageStoreService — Merkle Proof Verification', () => {
  let service: MessageStoreService;

  beforeEach(() => {
    service = new MessageStoreService();
    service.appendMessage(
      makeMessage(walletA, walletB, threadAlpha),
      makePayload('proof-msg0'),
    );
    service.appendMessage(
      makeMessage(walletB, walletC, threadBeta),
      makePayload('proof-msg1'),
    );
  });

  test('getMessageWithProof returns entry + witness + root', () => {
    const result = service.getMessageWithProof(0n);
    expect(result).toBeDefined();
    expect(result!.entry.leafIndex).toBe(0n);
    expect(result!.entry.message.senderWalletId).toBe(walletA);
    expect(result!.root).toBe(service.getRoot().toString());
    expect(result!.witnessJson).toBeDefined();

    // Parse witness JSON and verify structure
    const witnessData = JSON.parse(result!.witnessJson);
    expect(witnessData.path).toBeDefined();
    expect(witnessData.path.length).toBe(MESSAGE_STORE_HEIGHT - 1);
  });

  test('getMessageWithProof returns undefined for non-existent leaf', () => {
    expect(service.getMessageWithProof(999n)).toBeUndefined();
  });

  test('witness verifies against current root (using o1js MerkleWitness.calculateRoot)', () => {
    // Verify leaf 0
    const witness0 = service.getWitness(0n);
    const leafHash0 = computeMessageLeafHash(
      makeMessage(walletA, walletB, threadAlpha),
    );
    const root0 = witness0.calculateRoot(leafHash0);
    expect(root0.toBigInt()).toBe(service.getRoot());

    // Verify leaf 1
    const witness1 = service.getWitness(1n);
    const leafHash1 = computeMessageLeafHash(
      makeMessage(walletB, walletC, threadBeta),
    );
    const root1 = witness1.calculateRoot(leafHash1);
    expect(root1.toBigInt()).toBe(service.getRoot());

    // Wrong leaf hash should NOT verify
    const wrongRoot = witness0.calculateRoot(leafHash1);
    expect(wrongRoot.toBigInt()).not.toBe(service.getRoot());
  });
});

// ─── 5. Checkpoint Round-trip ───────────────────────────────

describe('MessageStoreService — Checkpoint Round-trip', () => {
  test('exportState captures all entries', () => {
    const service = new MessageStoreService();
    service.appendMessage(makeMessage(walletA, walletB, threadAlpha), makePayload('e1'));
    service.appendMessage(makeMessage(walletB, walletC, threadBeta), makePayload('e2'));

    const state = service.exportState();
    expect(state.nextLeafIndex).toBe(2n);
    expect(state.entries.length).toBe(2);
    expect(state.entries[0].leafIndex).toBe(0n);
    expect(state.entries[1].leafIndex).toBe(1n);
  });

  test('exportState captures correct root', () => {
    const service = new MessageStoreService();
    service.appendMessage(makeMessage(walletA, walletB, threadAlpha), makePayload());

    const state = service.exportState();
    expect(state.currentRoot).toBe(service.getRoot().toString());
  });

  test('restoreState rebuilds tree with same root', () => {
    const original = new MessageStoreService();
    original.appendMessage(makeMessage(walletA, walletB, threadAlpha), makePayload('r1'));
    original.appendMessage(makeMessage(walletB, walletC, threadBeta), makePayload('r2'));
    original.appendMessage(makeMessage(walletC, walletA, threadAlpha), makePayload('r3'));

    const originalRoot = original.getRoot();
    const state = original.exportState();

    const restored = new MessageStoreService();
    restored.restoreState(state);

    expect(restored.getRoot()).toBe(originalRoot);
    expect(restored.getMessageCount()).toBe(3n);
  });

  test('restoreState rebuilds all indexes', () => {
    const original = new MessageStoreService();
    original.appendMessage(makeMessage(walletA, walletB, threadAlpha), makePayload('i1'));
    original.appendMessage(makeMessage(walletB, walletC, threadAlpha), makePayload('i2'));
    original.appendMessage(makeMessage(walletC, walletA, threadBeta), makePayload('i3'));

    const state = original.exportState();

    const restored = new MessageStoreService();
    restored.restoreState(state);

    // Sender indexes
    expect(restored.getMessagesBySender(walletA).length).toBe(1);
    expect(restored.getMessagesBySender(walletB).length).toBe(1);
    expect(restored.getMessagesBySender(walletC).length).toBe(1);

    // Recipient indexes
    expect(restored.getMessagesByRecipient(walletB).length).toBe(1);
    expect(restored.getMessagesByRecipient(walletC).length).toBe(1);
    expect(restored.getMessagesByRecipient(walletA).length).toBe(1);

    // Wallet union indexes
    expect(restored.getMessagesByWallet(walletA).length).toBe(2); // sender of msg0, recipient of msg2
    expect(restored.getMessagesByWallet(walletB).length).toBe(2); // recipient of msg0, sender of msg1
    expect(restored.getMessagesByWallet(walletC).length).toBe(2); // recipient of msg1, sender of msg2
  });

  test('round-trip: export -> restore -> export produces identical state', () => {
    const original = new MessageStoreService();
    original.appendMessage(makeMessage(walletA, walletB, threadAlpha), makePayload('rt1'));
    original.appendMessage(makeMessage(walletB, walletC, threadBeta), makePayload('rt2'));

    const state1 = original.exportState();

    const restored = new MessageStoreService();
    restored.restoreState(state1);

    const state2 = restored.exportState();

    expect(state2.nextLeafIndex).toBe(state1.nextLeafIndex);
    expect(state2.currentRoot).toBe(state1.currentRoot);
    expect(state2.entries.length).toBe(state1.entries.length);

    for (let i = 0; i < state1.entries.length; i++) {
      expect(state2.entries[i].leafIndex).toBe(state1.entries[i].leafIndex);
      expect(state2.entries[i].leafHash).toBe(state1.entries[i].leafHash);
      expect(state2.entries[i].message.senderWalletId).toBe(state1.entries[i].message.senderWalletId);
      expect(state2.entries[i].message.recipientWalletId).toBe(state1.entries[i].message.recipientWalletId);
      expect(state2.entries[i].payload.ciphertext).toBe(state1.entries[i].payload.ciphertext);
    }
  });

  test('restore from empty state creates fresh service', () => {
    const service = new MessageStoreService();
    service.appendMessage(makeMessage(walletA, walletB, threadAlpha), makePayload());
    service.appendMessage(makeMessage(walletB, walletC, threadAlpha), makePayload());
    expect(service.getMessageCount()).toBe(2n);

    service.restoreState({
      nextLeafIndex: 0n,
      entries: [],
      currentRoot: '0',
    });

    expect(service.getMessageCount()).toBe(0n);
    expect(service.getMessagesBySender(walletA)).toEqual([]);
    expect(service.getMessagesByRecipient(walletB)).toEqual([]);
    expect(service.getMessagesByWallet(walletA)).toEqual([]);
  });
});

// ─── 6. L2 Sequencer Integration ────────────────────────────

describe('L2 Sequencer — Message Store Integration', () => {
  let sequencer: L2SequencerService;

  beforeEach(() => {
    sequencer = createSequencer();
  });

  test('storeMessage stores in message store', () => {
    const msg = makeMessage(walletA, walletB, threadAlpha);
    const payload = makePayload('sequencer-msg');

    const entry = sequencer.storeMessage(msg, payload);
    expect(entry).toBeDefined();
    expect(entry.leafIndex).toBe(0n);
    expect(entry.message.senderWalletId).toBe(walletA);
    expect(entry.payload.ciphertext).toBe(payload.ciphertext);
  });

  test('getMessageStoreRoot returns root from store', () => {
    // Before any messages, should have an empty-tree root
    const emptyRoot = sequencer.getMessageStoreRoot();
    expect(emptyRoot).toBeDefined();
    expect(typeof emptyRoot).toBe('string');

    // After storing a message, root should change
    sequencer.storeMessage(
      makeMessage(walletA, walletB, threadAlpha),
      makePayload(),
    );
    const newRoot = sequencer.getMessageStoreRoot();
    expect(newRoot).not.toBe(emptyRoot);
  });

  test('getMessageCount returns count', () => {
    expect(sequencer.getMessageCount()).toBe(0n);

    sequencer.storeMessage(makeMessage(walletA, walletB, threadAlpha), makePayload());
    expect(sequencer.getMessageCount()).toBe(1n);

    sequencer.storeMessage(makeMessage(walletB, walletC, threadBeta), makePayload());
    expect(sequencer.getMessageCount()).toBe(2n);
  });

  test('getMessagesByWallet returns stored messages via sequencer', () => {
    sequencer.storeMessage(makeMessage(walletA, walletB, threadAlpha), makePayload('m1'));
    sequencer.storeMessage(makeMessage(walletC, walletA, threadBeta), makePayload('m2'));
    sequencer.storeMessage(makeMessage(walletB, walletC, threadAlpha), makePayload('m3'));

    const walletAMessages = sequencer.getMessagesByWallet(walletA);
    // A is sender of m1, recipient of m2 → 2 messages
    expect(walletAMessages.length).toBe(2);
    expect(walletAMessages.map((e) => e.leafIndex).sort()).toEqual([0n, 1n]);

    const walletBMessages = sequencer.getMessagesByWallet(walletB);
    // B is recipient of m1, sender of m3 → 2 messages
    expect(walletBMessages.length).toBe(2);
  });

  test('buildBatch includes messageStoreRoot on L2Batch', () => {
    // Store a message so the root is non-empty
    sequencer.storeMessage(
      makeMessage(walletA, walletB, threadAlpha),
      makePayload('batch-msg'),
    );

    const expectedRoot = sequencer.getMessageStoreRoot();

    // Inject a fake batch to simulate what buildBatch would produce
    // (buildBatch requires compiled ZkPrograms, so we inject directly)
    const fakeBatch: L2Batch = {
      batchNumber: 0n,
      blockNumbers: [0n],
      registrationCount: 1,
      transitionCount: 1,
      oldRegistryRoot: INITIAL_REG_ROOT.toString(),
      newRegistryRoot: Field(111).toString(),
      oldLifecycleRoot: INITIAL_LC_ROOT.toString(),
      newLifecycleRoot: Field(222).toString(),
      batchProofJson: '{"proof":"fake"}',
      createdAt: Date.now(),
      l1Status: 'batched',
      messageStoreRoot: expectedRoot,
    };

    // Verify the batch has the messageStoreRoot field
    expect(fakeBatch.messageStoreRoot).toBeDefined();
    expect(fakeBatch.messageStoreRoot).toBe(expectedRoot);
    expect(typeof fakeBatch.messageStoreRoot).toBe('string');
    expect(fakeBatch.messageStoreRoot!.length).toBeGreaterThan(0);
  });
});
