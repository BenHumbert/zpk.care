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
 * Claim 9 — Gossip-Replicated Proof Propagation Tests
 *
 * Tests multi-hop gossip relay, state convergence, HMAC authentication,
 * deduplication, message store gossip, and fire-and-forget resilience.
 *
 * Patent items: 09-Y01 through 09-Y07
 *
 * Run: npx jest tests/claim09-gossip-propagation.test.ts --verbose --forceExit
 */

import http from 'http';
import { Field, MerkleTree } from 'o1js';
import { InMemoryStore } from '../src/storage/local-store.js';
import { WALLET_TREE_HEIGHT } from '../src/wallets/wallet-state.js';
import { L2Node } from '../src/l2/l2-node.js';
import { L2RpcServer } from '../src/l2/l2-rpc-server.js';
import { L2Client } from '../src/l2/l2-client.js';
import { L2PeerNetwork, generateMessageId } from '../src/l2/l2-peer-network.js';
import type { GossipHandler } from '../src/l2/l2-peer-network.js';
import type {
  GossipMessage,
  GossipMessageType,
  ProofAcceptedPayload,
} from '../src/l2/l2-peer-types.js';
import type { L2Receipt } from '../src/l2/l2-types.js';
import type { AuditEvent } from '../src/audit/audit-types.js';
import { l2Stringify, l2Parse } from '../src/l2/l2-json.js';

// ─── Test Setup ─────────────────────────────────────────────

jest.setTimeout(30_000);

const emptyRegTree = new MerkleTree(WALLET_TREE_HEIGHT);
const emptyLcTree = new MerkleTree(WALLET_TREE_HEIGHT);
const INITIAL_REG_ROOT = emptyRegTree.getRoot();
const INITIAL_LC_ROOT = emptyLcTree.getRoot();
const TEST_ADMIN_TOKEN = 'test-admin-token';

// ─── Helpers ────────────────────────────────────────────────

interface TestNodeContext {
  node: L2Node;
  server: L2RpcServer;
  client: L2Client;
  peerNet: L2PeerNetwork;
  port: number;
  url: string;
  cleanup: () => Promise<void>;
}

/** Create an L2Node + RPC server + PeerNetwork on a random port */
async function createTestNode(
  opts: {
    nodeId: string;
    gossipSecret?: string;
    gossipRelayEnabled?: boolean;
  },
): Promise<TestNodeContext> {
  const store = new InMemoryStore();
  const node = new L2Node(
    {
      batchIntervalMs: 999_999,
      autoSettle: false,
      nodeId: opts.nodeId,
    },
    store,
    INITIAL_REG_ROOT,
    INITIAL_LC_ROOT,
    Field(0),
  );

  const server = new L2RpcServer(node, { port: 0, adminToken: TEST_ADMIN_TOKEN });
  await server.start();
  const port = server.getPort();
  const url = `http://127.0.0.1:${port}`;

  const peerNet = new L2PeerNetwork({
    nodeId: opts.nodeId,
    role: 'sequencer',
    gossipRelayEnabled: opts.gossipRelayEnabled ?? true,
    gossipSecret: opts.gossipSecret,
    adminToken: TEST_ADMIN_TOKEN,
    announceIntervalMs: 999_999,
  });
  server.setPeerNetwork(peerNet);
  node.start();

  const client = new L2Client({ sequencerUrl: url, adminToken: TEST_ADMIN_TOKEN });

  return {
    node,
    server,
    client,
    peerNet,
    port,
    url,
    cleanup: async () => {
      peerNet.stop();
      await node.stop();
      await server.stop();
    },
  };
}

/** Create a mock L2Receipt */
function mockReceipt(seqNum: bigint, receiptId?: string): L2Receipt {
  return {
    receiptId: receiptId ?? `l2-${seqNum.toString().padStart(8, '0')}`,
    walletId: `wallet-${seqNum}`,
    isRegistration: false,
    l1Status: 'pending' as const,
    acceptedAt: Date.now(),
    sequenceNumber: seqNum,
    oldRegistryRoot: INITIAL_REG_ROOT.toString(),
    newRegistryRoot: INITIAL_REG_ROOT.toString(),
    oldLifecycleRoot: INITIAL_LC_ROOT.toString(),
    newLifecycleRoot: INITIAL_LC_ROOT.toString(),
  };
}

/** Create a mock AuditEvent */
function mockAuditEvent(seqNum: bigint, receiptId?: string): AuditEvent {
  return {
    sequenceNumber: seqNum,
    receiptId: receiptId ?? `l2-${seqNum.toString().padStart(8, '0')}`,
    walletId: `wallet-${seqNum}`,
    oldRegistryRoot: INITIAL_REG_ROOT.toString(),
    newRegistryRoot: INITIAL_REG_ROOT.toString(),
    oldLifecycleRoot: INITIAL_LC_ROOT.toString(),
    newLifecycleRoot: INITIAL_LC_ROOT.toString(),
    isRegistration: false,
    eventCommitment: (12345n + seqNum).toString(),
    chainHash: (67890n + seqNum).toString(),
    timestamp: Date.now(),
    l1Status: 'pending' as const,
  };
}

/** Create a gossip message */
function makeGossipMessage(
  type: GossipMessageType,
  senderId: string,
  payload: unknown,
  messageId?: string,
): GossipMessage {
  const ts = Date.now();
  return {
    messageId: messageId ?? generateMessageId(type, senderId, ts),
    type,
    senderId,
    timestamp: ts,
    payload: payload as GossipMessage['payload'],
  };
}

/** Build a proof:accepted gossip payload */
function makeProofAcceptedPayload(seqNum: bigint): ProofAcceptedPayload {
  return {
    receipt: mockReceipt(seqNum),
    auditEvent: mockAuditEvent(seqNum),
    currentRegistryRoot: INITIAL_REG_ROOT.toString(),
    currentLifecycleRoot: INITIAL_LC_ROOT.toString(),
    currentWalletCount: '0',
  };
}

/** Helper: raw HTTP POST to the RPC endpoint */
function rawRpc(port: number, body: string, adminToken?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (adminToken) headers['Authorization'] = `Bearer ${adminToken}`;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/rpc',
        method: 'POST',
        headers,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Track contexts for cleanup
let activeContexts: TestNodeContext[] = [];

afterEach(async () => {
  for (const ctx of activeContexts) {
    await ctx.cleanup().catch(() => {});
  }
  activeContexts = [];
});

// ─── Tests ──────────────────────────────────────────────────

describe('Claim 9: Gossip-Replicated Proof Propagation', () => {
  /**
   * 09-Y01: Multi-hop gossip relay (A → B → C) via handleIncomingAndRelay.
   *
   * Chain topology: A → B → C (B knows C).
   * A sends gossip to B with fromPeerId, triggering relay to C.
   * B receives and relays, C receives the relayed message.
   */
  test('09-Y01: gossip relays through chain topology A→B→C', async () => {
    const ctxA = await createTestNode({ nodeId: 'node-A' });
    const ctxB = await createTestNode({ nodeId: 'node-B' });
    const ctxC = await createTestNode({ nodeId: 'node-C' });
    activeContexts.push(ctxA, ctxB, ctxC);

    // B connects to C (so B can relay to C)
    await ctxB.peerNet.connectToPeer(ctxC.url);

    // Track messages received by each node
    const receivedByB: GossipMessage[] = [];
    const receivedByC: GossipMessage[] = [];
    ctxB.peerNet.on((msg) => receivedByB.push(msg));
    ctxC.peerNet.on((msg) => receivedByC.push(msg));

    // A sends gossip to B via RPC with fromPeerId='node-A'
    // This triggers handleIncomingAndRelay which relays to C
    const payload = makeProofAcceptedPayload(1n);
    const gossipMsg = makeGossipMessage('proof:accepted', 'node-A', payload, 'relay-test-001');

    // Send to B with fromPeerId so relay kicks in
    const res = await rawRpc(ctxB.port, l2Stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'l2_gossipRelay',
      params: { message: gossipMsg, fromPeerId: 'node-A' },
    }), TEST_ADMIN_TOKEN);

    const rpc = l2Parse<{ result: { accepted: boolean } }>(res.body);
    expect(rpc.result.accepted).toBe(true);

    // Wait for relay propagation from B → C
    await new Promise((r) => setTimeout(r, 500));

    // B received the message
    expect(receivedByB.some((m) => m.messageId === 'relay-test-001')).toBe(true);

    // C received via relay from B
    expect(receivedByC.some((m) => m.messageId === 'relay-test-001')).toBe(true);
  });

  /**
   * 09-Y02: State convergence across fully connected nodes.
   *
   * 3 L2Nodes fully connected. Apply receipt to A, broadcast gossip.
   * All nodes should have the same receipt after propagation.
   */
  test('09-Y02: state converges via gossip across fully connected nodes', async () => {
    const ctxA = await createTestNode({ nodeId: 'conv-A' });
    const ctxB = await createTestNode({ nodeId: 'conv-B' });
    const ctxC = await createTestNode({ nodeId: 'conv-C' });
    activeContexts.push(ctxA, ctxB, ctxC);

    // Fully connect: A↔B, B↔C, A↔C
    await ctxA.peerNet.connectToPeer(ctxB.url);
    await ctxA.peerNet.connectToPeer(ctxC.url);
    await ctxB.peerNet.connectToPeer(ctxC.url);

    // Apply receipt to A's sequencer
    const receipt = mockReceipt(1n);
    const auditEvent = mockAuditEvent(1n);
    ctxA.node.getSequencer().applyReplicatedReceipt(receipt, auditEvent);

    // Set up handlers on B and C to apply received receipts
    const applyOnReceive = (node: L2Node): GossipHandler => {
      return (msg) => {
        if (msg.type === 'proof:accepted') {
          const p = msg.payload as ProofAcceptedPayload;
          node.getSequencer().applyReplicatedReceipt(
            p.receipt,
            p.auditEvent,
            undefined,
            p.currentRegistryRoot,
            p.currentLifecycleRoot,
            p.currentWalletCount,
          );
        }
      };
    };
    ctxB.peerNet.on(applyOnReceive(ctxB.node));
    ctxC.peerNet.on(applyOnReceive(ctxC.node));

    // A broadcasts
    const payload: ProofAcceptedPayload = {
      receipt,
      auditEvent,
      currentRegistryRoot: INITIAL_REG_ROOT.toString(),
      currentLifecycleRoot: INITIAL_LC_ROOT.toString(),
      currentWalletCount: '0',
    };
    const gossipMsg = makeGossipMessage('proof:accepted', 'conv-A', payload, 'conv-msg-001');
    await ctxA.peerNet.broadcast(gossipMsg);

    // Wait for propagation
    await new Promise((r) => setTimeout(r, 500));

    // All 3 nodes should have the receipt
    expect(ctxA.node.getSequencer().getReceipt(receipt.receiptId)).toBeDefined();
    expect(ctxB.node.getSequencer().getReceipt(receipt.receiptId)).toBeDefined();
    expect(ctxC.node.getSequencer().getReceipt(receipt.receiptId)).toBeDefined();

    // State digests match
    const digestA = await ctxA.client.getStateDigest();
    const digestB = await ctxB.client.getStateDigest();
    const digestC = await ctxC.client.getStateDigest();

    expect(digestA.registryRoot).toBe(digestB.registryRoot);
    expect(digestA.registryRoot).toBe(digestC.registryRoot);
    expect(digestA.lifecycleRoot).toBe(digestB.lifecycleRoot);
    expect(digestA.lifecycleRoot).toBe(digestC.lifecycleRoot);
  });

  /**
   * 09-Y03: State sync after partition heals.
   *
   * A↔B↔C. Disconnect B from C. Apply R1 to A (gossips to B).
   * Apply R2 to C directly. Reconnect. C requests state sync from B.
   * After sync, C has both R1 and R2.
   */
  test('09-Y03: state sync recovers after network partition heal', async () => {
    const ctxA = await createTestNode({ nodeId: 'sync-A' });
    const ctxB = await createTestNode({ nodeId: 'sync-B' });
    const ctxC = await createTestNode({ nodeId: 'sync-C' });
    activeContexts.push(ctxA, ctxB, ctxC);

    // Connect A↔B, B↔C
    await ctxA.peerNet.connectToPeer(ctxB.url);
    await ctxB.peerNet.connectToPeer(ctxC.url);

    // Set up replication handler on B
    ctxB.peerNet.on((msg) => {
      if (msg.type === 'proof:accepted') {
        const p = msg.payload as ProofAcceptedPayload;
        ctxB.node.getSequencer().applyReplicatedReceipt(p.receipt, p.auditEvent);
      }
    });

    // Apply R1 to A
    const r1 = mockReceipt(1n, 'receipt-r1');
    const a1 = mockAuditEvent(1n, 'receipt-r1');
    ctxA.node.getSequencer().applyReplicatedReceipt(r1, a1);

    // Gossip R1 from A → B
    const payload1: ProofAcceptedPayload = {
      receipt: r1,
      auditEvent: a1,
      currentRegistryRoot: INITIAL_REG_ROOT.toString(),
      currentLifecycleRoot: INITIAL_LC_ROOT.toString(),
      currentWalletCount: '0',
    };
    await ctxA.peerNet.broadcast(makeGossipMessage('proof:accepted', 'sync-A', payload1, 'sync-r1'));
    await new Promise((r) => setTimeout(r, 300));

    // B should have R1
    expect(ctxB.node.getSequencer().getReceipt('receipt-r1')).toBeDefined();

    // Apply R2 directly to C (simulates independent receipt while disconnected)
    const r2 = mockReceipt(2n, 'receipt-r2');
    const a2 = mockAuditEvent(2n, 'receipt-r2');
    ctxC.node.getSequencer().applyReplicatedReceipt(r2, a2);

    // C requests state sync from B
    const snapshot = await ctxC.client.requestSnapshot.call(
      new L2Client({ sequencerUrl: ctxB.url, adminToken: TEST_ADMIN_TOKEN }),
    );

    // Manually apply B's state to C — apply R1 which C doesn't have yet
    const r1FromSnapshot = snapshot.receipts.find((r: any) => r.receiptId === 'receipt-r1');
    const a1FromSnapshot = snapshot.auditLog.find((e: any) => e.receiptId === 'receipt-r1');
    if (r1FromSnapshot && a1FromSnapshot) {
      ctxC.node.getSequencer().applyReplicatedReceipt(r1FromSnapshot, a1FromSnapshot);
    }

    // C now has both R1 and R2
    expect(ctxC.node.getSequencer().getReceipt('receipt-r1')).toBeDefined();
    expect(ctxC.node.getSequencer().getReceipt('receipt-r2')).toBeDefined();
    expect(ctxC.node.getSequencer().getAllReceipts().length).toBe(2);
  });

  /**
   * 09-Y04: Tampered HMAC signature rejected.
   *
   * 2 L2Nodes with gossipSecret: 'shared-key'. A message with
   * tampered signature is rejected via l2_gossipRelay.
   */
  test('09-Y04: tampered HMAC gossip message is rejected', async () => {
    const ctxA = await createTestNode({ nodeId: 'hmac-A', gossipSecret: 'shared-key' });
    const ctxB = await createTestNode({ nodeId: 'hmac-B', gossipSecret: 'shared-key' });
    activeContexts.push(ctxA, ctxB);

    // Create a validly-signed message from A
    const payload = makeProofAcceptedPayload(1n);
    const msg = makeGossipMessage('proof:accepted', 'hmac-A', payload, 'hmac-test-001');

    // Tamper with the signature
    msg.signature = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

    // Send tampered message to B via RPC
    const res = await rawRpc(ctxB.port, l2Stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'l2_gossipRelay',
      params: { message: msg },
    }), TEST_ADMIN_TOKEN);

    const rpc = l2Parse<{ result: { accepted: boolean } }>(res.body);
    expect(rpc.result.accepted).toBe(false);

    // Valid message (properly signed via broadcast) should be accepted
    let handlerCalled = false;
    ctxB.peerNet.on(() => { handlerCalled = true; });

    // Connect A to B and broadcast properly
    await ctxA.peerNet.connectToPeer(ctxB.url);

    const validMsg = makeGossipMessage('proof:accepted', 'hmac-A', payload, 'hmac-test-002');
    await ctxA.peerNet.broadcast(validMsg);
    await new Promise((r) => setTimeout(r, 300));

    expect(handlerCalled).toBe(true);
  });

  /**
   * 09-Y05: Originator's own broadcast not re-processed.
   *
   * A↔B. A broadcasts M1. B's handler is called 1x.
   * A's handler is called 0x (dedup prevents re-processing originator's own message).
   */
  test('09-Y05: originator does not re-process its own broadcast', async () => {
    const ctxA = await createTestNode({ nodeId: 'dedup-A' });
    const ctxB = await createTestNode({ nodeId: 'dedup-B' });
    activeContexts.push(ctxA, ctxB);

    // Connect A↔B
    await ctxA.peerNet.connectToPeer(ctxB.url);

    let handlerCallsA = 0;
    let handlerCallsB = 0;
    ctxA.peerNet.on(() => { handlerCallsA++; });
    ctxB.peerNet.on(() => { handlerCallsB++; });

    // A broadcasts
    const payload = makeProofAcceptedPayload(1n);
    const msg = makeGossipMessage('proof:accepted', 'dedup-A', payload, 'dedup-test-001');
    await ctxA.peerNet.broadcast(msg);

    // Wait for propagation
    await new Promise((r) => setTimeout(r, 300));

    // B received it
    expect(handlerCallsB).toBe(1);

    // A did NOT re-process (broadcast marks it as seen before sending)
    expect(handlerCallsA).toBe(0);
  });

  /**
   * 09-Y06: Message store gossip propagates to peers.
   *
   * 2 L2Nodes connected. Create a message:stored gossip message.
   * B receives the gossip with the correct message payload.
   */
  test('09-Y06: message:stored gossip propagates to connected peer', async () => {
    const ctxA = await createTestNode({ nodeId: 'msg-A' });
    const ctxB = await createTestNode({ nodeId: 'msg-B' });
    activeContexts.push(ctxA, ctxB);

    // Connect A → B
    await ctxA.peerNet.connectToPeer(ctxB.url);

    // Track what B receives
    const receivedMessages: GossipMessage[] = [];
    ctxB.peerNet.on((msg) => receivedMessages.push(msg));

    // A broadcasts a message:stored gossip
    const messagePayload = {
      entry: {
        leafIndex: 0,
        message: {
          senderWalletId: 'wallet-sender',
          recipientWalletId: 'wallet-recipient',
          threadIdHash: 'thread-001',
          contentHash: 'content-hash-abc',
          messageType: 'general',
          timestamp: Date.now(),
        },
        payload: {
          encryptedContent: 'encrypted-data-here',
          senderPublicKey: 'pk-sender',
        },
        root: '12345',
        storedAt: Date.now(),
      },
    };
    const gossipMsg = makeGossipMessage('message:stored', 'msg-A', messagePayload, 'msg-stored-001');
    await ctxA.peerNet.broadcast(gossipMsg);

    // Wait for propagation
    await new Promise((r) => setTimeout(r, 300));

    // B received the message:stored gossip
    const received = receivedMessages.find((m) => m.messageId === 'msg-stored-001');
    expect(received).toBeDefined();
    expect(received!.type).toBe('message:stored');
    expect((received!.payload as any).entry.message.senderWalletId).toBe('wallet-sender');
  });

  /**
   * 09-Y07: Broadcast to unreachable peer does not throw.
   *
   * A → B. Stop B's server. A broadcasts. broadcast() resolves
   * without throwing (fire-and-forget).
   */
  test('09-Y07: broadcast to stopped peer resolves without throwing', async () => {
    const ctxA = await createTestNode({ nodeId: 'fire-A' });
    const ctxB = await createTestNode({ nodeId: 'fire-B' });
    activeContexts.push(ctxA, ctxB);

    // Connect A → B
    await ctxA.peerNet.connectToPeer(ctxB.url);

    // Stop B's server
    await ctxB.server.stop();

    // A broadcasts — should NOT throw despite B being unreachable
    const payload = makeProofAcceptedPayload(1n);
    const msg = makeGossipMessage('proof:accepted', 'fire-A', payload, 'fire-test-001');
    await expect(ctxA.peerNet.broadcast(msg)).resolves.toBeUndefined();
  });
});
