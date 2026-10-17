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
 * Message Submission Tests — write path from device → sequencer → gossip → entity nodes.
 *
 * Tests the full message submission pipeline:
 *   1. L2Node.storeMessage() — store + gossip broadcast
 *   2. l2_storeMessage RPC — validation + acceptance
 *   3. L2Client.storeMessage() — round-trip store + query
 *   4. Gossip replication — broadcast, apply, idempotent skip, root convergence
 *   5. L2Leviathan.storeMessage() — partitioned store + gossip
 *   6. Entity node methods — member/prescriber/pharmacy store + query, insurer read-only
 *
 * Run: npx jest tests/message-submission.test.ts --verbose
 */

import { Field, Poseidon, MerkleTree } from 'o1js';
import {
  computeMessageLeafHash,
  type StoredMessage,
  type MessagePayload,
  type MessageStoreEntry,
} from '../src/l2/message-store-types.js';
import { L2SequencerService } from '../src/l2/l2-sequencer-service.js';
import { L2Node } from '../src/l2/l2-node.js';
import type { GossipMessage, MessageStoredPayload } from '../src/l2/l2-peer-types.js';
import { generateMessageId } from '../src/l2/l2-peer-network.js';
import { InMemoryStore } from '../src/storage/local-store.js';
import { WALLET_TREE_HEIGHT } from '../src/wallets/wallet-state.js';
import { createAcceptAllVerifierForTests } from '../src/l2/l2-proof-verifier.js';

jest.setTimeout(60000);

// ─── Test Data ──────────────────────────────────────────────

const walletA = Poseidon.hash([Field(1)]).toString();
const walletB = Poseidon.hash([Field(2)]).toString();
const walletC = Poseidon.hash([Field(3)]).toString();

const threadAlpha = Poseidon.hash([Field(100)]).toString();
const threadBeta = Poseidon.hash([Field(200)]).toString();

const emptyTree = new MerkleTree(WALLET_TREE_HEIGHT);
const EMPTY_ROOT = emptyTree.getRoot();

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

/** Create a fresh L2Node for testing */
function createNode(opts: Partial<Parameters<typeof L2Node.prototype.start>[0]> = {}): L2Node {
  const node = new L2Node(
    {
      batchIntervalMs: 999_999, // no auto-batch
      autoSettle: false,
      settlementDelayMs: 0,
      maxBatchRetries: 0,
      l2Only: true,
      ...opts,
    },
    new InMemoryStore(),
    EMPTY_ROOT,
    EMPTY_ROOT,
    Field(0),
  );
  node.getSequencer().setTransitionVerifier(createAcceptAllVerifierForTests('tests/message-submission.test.ts'));
  return node;
}

// ═══════════════════════════════════════════════════════════
//  L2Node.storeMessage()
// ═══════════════════════════════════════════════════════════

describe('L2Node.storeMessage', () => {
  test('stores a message and returns entry with leafIndex 0', () => {
    const node = createNode();
    const msg = makeMessage(walletA, walletB, threadAlpha);
    const pl = makePayload('hello');
    const entry = node.storeMessage(msg, pl);

    expect(entry.leafIndex).toBe(0n);
    expect(entry.message).toEqual(msg);
    expect(entry.payload).toEqual(pl);
    expect(entry.leafHash).toBe(computeMessageLeafHash(msg).toString());
  });

  test('assigns sequential leaf indexes', () => {
    const node = createNode();
    const e1 = node.storeMessage(makeMessage(walletA, walletB, threadAlpha), makePayload('1'));
    const e2 = node.storeMessage(makeMessage(walletB, walletA, threadAlpha), makePayload('2'));
    const e3 = node.storeMessage(makeMessage(walletA, walletC, threadBeta), makePayload('3'));

    expect(e1.leafIndex).toBe(0n);
    expect(e2.leafIndex).toBe(1n);
    expect(e3.leafIndex).toBe(2n);
  });

  test('changes the message store root', () => {
    const node = createNode();
    const rootBefore = node.getSequencer().getMessageStoreRoot();
    node.storeMessage(makeMessage(walletA, walletB, threadAlpha), makePayload());
    const rootAfter = node.getSequencer().getMessageStoreRoot();

    expect(rootAfter).not.toBe(rootBefore);
  });

  test('increments message count', () => {
    const node = createNode();
    expect(node.getSequencer().getMessageCount()).toBe(0n);

    node.storeMessage(makeMessage(walletA, walletB, threadAlpha), makePayload());
    expect(node.getSequencer().getMessageCount()).toBe(1n);

    node.storeMessage(makeMessage(walletB, walletA, threadAlpha), makePayload());
    expect(node.getSequencer().getMessageCount()).toBe(2n);
  });

  test('preserves encrypted payload', () => {
    const node = createNode();
    const pl = makePayload('secret medical data');
    const entry = node.storeMessage(makeMessage(walletA, walletB, threadAlpha), pl);

    expect(entry.payload.ciphertext).toBe(pl.ciphertext);
    expect(entry.payload.iv).toBe(pl.iv);
    expect(entry.payload.tag).toBe(pl.tag);
    expect(entry.payload.timestamp).toBe(pl.timestamp);
  });
});

// ═══════════════════════════════════════════════════════════
//  Sequencer applyReplicatedMessage (gossip replication)
// ═══════════════════════════════════════════════════════════

describe('Gossip replication — applyReplicatedMessage', () => {
  test('replicates a message to a second sequencer', () => {
    const seq1 = new L2SequencerService(new InMemoryStore(), EMPTY_ROOT, EMPTY_ROOT, Field(0), 999_999, true);
    seq1.setTransitionVerifier(createAcceptAllVerifierForTests('tests/message-submission.test.ts'));
    const seq2 = new L2SequencerService(new InMemoryStore(), EMPTY_ROOT, EMPTY_ROOT, Field(0), 999_999, true);
    seq2.setTransitionVerifier(createAcceptAllVerifierForTests('tests/message-submission.test.ts'));

    const msg = makeMessage(walletA, walletB, threadAlpha);
    const pl = makePayload('replicated');
    const entry = seq1.storeMessage(msg, pl);

    // Replicate to seq2
    seq2.applyReplicatedMessage(entry.leafIndex, msg, pl);

    expect(seq2.getMessageCount()).toBe(1n);
    expect(seq2.getMessageStoreRoot()).toBe(seq1.getMessageStoreRoot());
  });

  test('idempotent — skips duplicate leafIndex', () => {
    const seq = new L2SequencerService(new InMemoryStore(), EMPTY_ROOT, EMPTY_ROOT, Field(0), 999_999, true);
    seq.setTransitionVerifier(createAcceptAllVerifierForTests('tests/message-submission.test.ts'));
    const msg = makeMessage(walletA, walletB, threadAlpha);
    const pl = makePayload('first');
    seq.storeMessage(msg, pl);

    const rootBefore = seq.getMessageStoreRoot();
    const countBefore = seq.getMessageCount();

    // Try to replicate same index — should be skipped
    seq.applyReplicatedMessage(0n, msg, pl);

    expect(seq.getMessageStoreRoot()).toBe(rootBefore);
    expect(seq.getMessageCount()).toBe(countBefore);
  });

  test('roots converge after replicating all messages', () => {
    const seq1 = new L2SequencerService(new InMemoryStore(), EMPTY_ROOT, EMPTY_ROOT, Field(0), 999_999, true);
    seq1.setTransitionVerifier(createAcceptAllVerifierForTests('tests/message-submission.test.ts'));
    const seq2 = new L2SequencerService(new InMemoryStore(), EMPTY_ROOT, EMPTY_ROOT, Field(0), 999_999, true);
    seq2.setTransitionVerifier(createAcceptAllVerifierForTests('tests/message-submission.test.ts'));

    const messages = [
      { msg: makeMessage(walletA, walletB, threadAlpha), pl: makePayload('msg1') },
      { msg: makeMessage(walletB, walletC, threadBeta), pl: makePayload('msg2') },
      { msg: makeMessage(walletC, walletA, threadAlpha), pl: makePayload('msg3') },
    ];

    // Store all on seq1
    const entries: MessageStoreEntry[] = [];
    for (const { msg, pl } of messages) {
      entries.push(seq1.storeMessage(msg, pl));
    }

    // Replicate all to seq2
    for (const entry of entries) {
      seq2.applyReplicatedMessage(entry.leafIndex, entry.message, entry.payload);
    }

    expect(seq2.getMessageStoreRoot()).toBe(seq1.getMessageStoreRoot());
    expect(seq2.getMessageCount()).toBe(seq1.getMessageCount());
  });

  test('replicated messages are queryable by sender', () => {
    const seq1 = new L2SequencerService(new InMemoryStore(), EMPTY_ROOT, EMPTY_ROOT, Field(0), 999_999, true);
    seq1.setTransitionVerifier(createAcceptAllVerifierForTests('tests/message-submission.test.ts'));
    const seq2 = new L2SequencerService(new InMemoryStore(), EMPTY_ROOT, EMPTY_ROOT, Field(0), 999_999, true);
    seq2.setTransitionVerifier(createAcceptAllVerifierForTests('tests/message-submission.test.ts'));

    const msg = makeMessage(walletA, walletB, threadAlpha);
    const pl = makePayload('queryable');
    const entry = seq1.storeMessage(msg, pl);

    seq2.applyReplicatedMessage(entry.leafIndex, msg, pl);

    const senderMsgs = seq2.getMessagesBySender(walletA);
    expect(senderMsgs).toHaveLength(1);
    expect(senderMsgs[0].message.senderWalletId).toBe(walletA);
  });

  test('replicated messages are queryable by recipient', () => {
    const seq1 = new L2SequencerService(new InMemoryStore(), EMPTY_ROOT, EMPTY_ROOT, Field(0), 999_999, true);
    seq1.setTransitionVerifier(createAcceptAllVerifierForTests('tests/message-submission.test.ts'));
    const seq2 = new L2SequencerService(new InMemoryStore(), EMPTY_ROOT, EMPTY_ROOT, Field(0), 999_999, true);
    seq2.setTransitionVerifier(createAcceptAllVerifierForTests('tests/message-submission.test.ts'));

    const msg = makeMessage(walletA, walletB, threadAlpha);
    const pl = makePayload();
    const entry = seq1.storeMessage(msg, pl);

    seq2.applyReplicatedMessage(entry.leafIndex, msg, pl);

    const recipientMsgs = seq2.getMessagesByRecipient(walletB);
    expect(recipientMsgs).toHaveLength(1);
    expect(recipientMsgs[0].message.recipientWalletId).toBe(walletB);
  });

  test('replicated messages are queryable by thread', () => {
    const seq1 = new L2SequencerService(new InMemoryStore(), EMPTY_ROOT, EMPTY_ROOT, Field(0), 999_999, true);
    seq1.setTransitionVerifier(createAcceptAllVerifierForTests('tests/message-submission.test.ts'));
    const seq2 = new L2SequencerService(new InMemoryStore(), EMPTY_ROOT, EMPTY_ROOT, Field(0), 999_999, true);
    seq2.setTransitionVerifier(createAcceptAllVerifierForTests('tests/message-submission.test.ts'));

    const msg = makeMessage(walletA, walletB, threadAlpha);
    const pl = makePayload();
    const entry = seq1.storeMessage(msg, pl);

    seq2.applyReplicatedMessage(entry.leafIndex, msg, pl);

    const threadMsgs = seq2.getMessagesByThread(msg.threadIdHash);
    expect(threadMsgs).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════
//  L2Node gossip handling for message:stored
// ═══════════════════════════════════════════════════════════

describe('L2Node gossip — message:stored', () => {
  test('replica applies message:stored gossip', async () => {
    const sequencer = createNode({ role: 'sequencer', nodeId: 'seq-1' });
    const replica = createNode({ role: 'replica', nodeId: 'rep-1' });

    // Store a message on the sequencer
    const msg = makeMessage(walletA, walletB, threadAlpha);
    const pl = makePayload('gossip-test');
    const entry = sequencer.storeMessage(msg, pl);

    // Simulate gossip delivery to the replica
    const gossipPayload: MessageStoredPayload = {
      leafIndex: entry.leafIndex,
      message: msg,
      payload: pl,
      leafHash: entry.leafHash,
    };

    const gossipMsg: GossipMessage = {
      messageId: generateMessageId('message:stored', 'seq-1', Date.now(), '0'),
      type: 'message:stored',
      senderId: 'seq-1',
      timestamp: Date.now(),
      payload: gossipPayload,
    };

    // Access private handleGossip via casting
    await (replica as any).handleGossip(gossipMsg);

    // Verify the replica has the message
    expect(replica.getSequencer().getMessageCount()).toBe(1n);
    expect(replica.getSequencer().getMessageStoreRoot()).toBe(
      sequencer.getSequencer().getMessageStoreRoot(),
    );
  });

  test('sequencer ignores message:stored gossip from self', async () => {
    const node = createNode({ role: 'sequencer', nodeId: 'seq-1' });
    node.storeMessage(makeMessage(walletA, walletB, threadAlpha), makePayload());

    const countBefore = node.getSequencer().getMessageCount();

    // Gossip from self should be ignored
    const gossipMsg: GossipMessage = {
      messageId: generateMessageId('message:stored', 'seq-1', Date.now(), '99'),
      type: 'message:stored',
      senderId: 'seq-1',
      timestamp: Date.now(),
      payload: {
        leafIndex: 99n,
        message: makeMessage(walletC, walletA, threadBeta),
        payload: makePayload(),
        leafHash: '0',
      } as MessageStoredPayload,
    };

    await (node as any).handleGossip(gossipMsg);

    // Should not have been applied
    expect(node.getSequencer().getMessageCount()).toBe(countBefore);
  });

  test('sequencer ignores message:stored from other sequencer (not replica)', async () => {
    const node = createNode({ role: 'sequencer', nodeId: 'seq-1' });

    const gossipMsg: GossipMessage = {
      messageId: generateMessageId('message:stored', 'seq-2', Date.now(), '0'),
      type: 'message:stored',
      senderId: 'seq-2',
      timestamp: Date.now(),
      payload: {
        leafIndex: 0n,
        message: makeMessage(walletA, walletB, threadAlpha),
        payload: makePayload(),
        leafHash: '0',
      } as MessageStoredPayload,
    };

    await (node as any).handleGossip(gossipMsg);

    // Sequencers ignore message:stored gossip (only replicas apply)
    expect(node.getSequencer().getMessageCount()).toBe(0n);
  });
});

// ═══════════════════════════════════════════════════════════
//  Message Store query integration via sequencer
// ═══════════════════════════════════════════════════════════

describe('Sequencer message query methods', () => {
  test('getMessagesBySender returns correct messages', () => {
    const node = createNode();
    node.storeMessage(makeMessage(walletA, walletB, threadAlpha), makePayload('1'));
    node.storeMessage(makeMessage(walletB, walletA, threadAlpha), makePayload('2'));
    node.storeMessage(makeMessage(walletA, walletC, threadBeta), makePayload('3'));

    const senderA = node.getSequencer().getMessagesBySender(walletA);
    expect(senderA).toHaveLength(2);

    const senderB = node.getSequencer().getMessagesBySender(walletB);
    expect(senderB).toHaveLength(1);
  });

  test('getMessagesByRecipient returns correct messages', () => {
    const node = createNode();
    node.storeMessage(makeMessage(walletA, walletB, threadAlpha), makePayload('1'));
    node.storeMessage(makeMessage(walletC, walletB, threadBeta), makePayload('2'));

    const recipientB = node.getSequencer().getMessagesByRecipient(walletB);
    expect(recipientB).toHaveLength(2);
  });

  test('getMessagesByWallet returns union of sent + received', () => {
    const node = createNode();
    node.storeMessage(makeMessage(walletA, walletB, threadAlpha), makePayload('1'));
    node.storeMessage(makeMessage(walletB, walletA, threadAlpha), makePayload('2'));
    node.storeMessage(makeMessage(walletC, walletB, threadBeta), makePayload('3'));

    // walletA: sent 1, received 1 = 2
    const walletAMsgs = node.getSequencer().getMessagesByWallet(walletA);
    expect(walletAMsgs).toHaveLength(2);

    // walletB: received 1, sent 1, received 1 = 3
    const walletBMsgs = node.getSequencer().getMessagesByWallet(walletB);
    expect(walletBMsgs).toHaveLength(3);
  });

  test('getMessagesByThread returns correct messages', () => {
    const node = createNode();
    const m1 = makeMessage(walletA, walletB, threadAlpha);
    const m2 = makeMessage(walletB, walletA, threadAlpha);
    const m3 = makeMessage(walletA, walletC, threadBeta);

    node.storeMessage(m1, makePayload('1'));
    node.storeMessage(m2, makePayload('2'));
    node.storeMessage(m3, makePayload('3'));

    const alphaThread = node.getSequencer().getMessagesByThread(m1.threadIdHash);
    expect(alphaThread).toHaveLength(2);

    const betaThread = node.getSequencer().getMessagesByThread(m3.threadIdHash);
    expect(betaThread).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════
//  Checkpoint round-trip with messages
// ═══════════════════════════════════════════════════════════

describe('Checkpoint round-trip preserves messages', () => {
  test('export + restore preserves message store state', () => {
    const seq1 = new L2SequencerService(new InMemoryStore(), EMPTY_ROOT, EMPTY_ROOT, Field(0), 999_999, true);
    seq1.setTransitionVerifier(createAcceptAllVerifierForTests('tests/message-submission.test.ts'));

    seq1.storeMessage(makeMessage(walletA, walletB, threadAlpha), makePayload('msg1'));
    seq1.storeMessage(makeMessage(walletB, walletC, threadBeta), makePayload('msg2'));

    const state = seq1.exportState();

    const seq2 = new L2SequencerService(new InMemoryStore(), EMPTY_ROOT, EMPTY_ROOT, Field(0), 999_999, true);
    seq2.setTransitionVerifier(createAcceptAllVerifierForTests('tests/message-submission.test.ts'));
    seq2.restoreState(state);

    expect(seq2.getMessageCount()).toBe(seq1.getMessageCount());
    expect(seq2.getMessageStoreRoot()).toBe(seq1.getMessageStoreRoot());
    expect(seq2.getMessagesBySender(walletA)).toHaveLength(1);
    expect(seq2.getMessagesByRecipient(walletC)).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════
//  MessageStoredPayload type structure
// ═══════════════════════════════════════════════════════════

describe('MessageStoredPayload type structure', () => {
  test('has all required fields', () => {
    const msg = makeMessage(walletA, walletB, threadAlpha);
    const pl = makePayload();
    const leafHash = computeMessageLeafHash(msg).toString();

    const payload: MessageStoredPayload = {
      leafIndex: 0n,
      message: msg,
      payload: pl,
      leafHash,
    };

    expect(payload.leafIndex).toBe(0n);
    expect(payload.message.senderWalletId).toBe(walletA);
    expect(payload.message.recipientWalletId).toBe(walletB);
    expect(payload.payload.ciphertext).toBeTruthy();
    expect(payload.leafHash).toBe(leafHash);
    expect(payload.partitionIndex).toBeUndefined();
  });

  test('supports optional partitionIndex for leviathan mode', () => {
    const payload: MessageStoredPayload = {
      leafIndex: 5n,
      message: makeMessage(walletA, walletB, threadAlpha),
      payload: makePayload(),
      leafHash: '123',
      partitionIndex: 2,
    };

    expect(payload.partitionIndex).toBe(2);
  });
});
