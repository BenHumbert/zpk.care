/** L2 Peer Network — gossip, replication, multi-node tests */

import http from 'http';
import { Field, MerkleTree } from 'o1js';
import { InMemoryStore } from '../src/storage/local-store.js';
import { WALLET_TREE_HEIGHT } from '../src/wallets/wallet-state.js';
import { L2Node } from '../src/l2/l2-node.js';
import type { L2NodeStatus } from '../src/l2/l2-node.js';
import { L2RpcServer } from '../src/l2/l2-rpc-server.js';
import { L2Client } from '../src/l2/l2-client.js';
import { L2PeerNetwork, generateMessageId } from '../src/l2/l2-peer-network.js';
import type { GossipHandler } from '../src/l2/l2-peer-network.js';
import {
  DEFAULT_PEER_NETWORK_CONFIG,
  MAX_SEEN_MESSAGES,
  DEFAULT_MAX_PEERS,
} from '../src/l2/l2-peer-types.js';
import type {
  PeerInfo,
  GossipMessage,
  GossipMessageType,
  PeerNetworkConfig,
  StateDigest,
  ProofAcceptedPayload,
  BatchBuiltPayload,
  BatchSettledPayload,
  BatchFailedPayload,
  PeerAnnouncePayload,
  L2NodeRole,
} from '../src/l2/l2-peer-types.js';
import type { L2Receipt, L2Block, L2Batch } from '../src/l2/l2-types.js';
import type { AuditEvent } from '../src/audit/audit-types.js';
import type { L2SequencerState } from '../src/l2/l2-checkpoint.js';
import { l2Stringify, l2Parse } from '../src/l2/l2-json.js';

// ─── Test Setup ─────────────────────────────────────────────

jest.setTimeout(30_000);

const emptyRegTree = new MerkleTree(WALLET_TREE_HEIGHT);
const emptyLcTree = new MerkleTree(WALLET_TREE_HEIGHT);
const INITIAL_REG_ROOT = emptyRegTree.getRoot();
const INITIAL_LC_ROOT = emptyLcTree.getRoot();
const TEST_ADMIN_TOKEN = 'test-admin-token';

/** Helper: create an L2Node + L2RpcServer on a random port. Returns cleanup function. */
interface TestNodeContext {
  node: L2Node;
  server: L2RpcServer;
  client: L2Client;
  port: number;
  url: string;
  cleanup: () => Promise<void>;
}

async function createTestNode(
  opts?: Partial<{
    role: L2NodeRole;
    nodeId: string;
    seedPeers: string[];
    maxPeers: number;
    batchIntervalMs: number;
    autoSettle: boolean;
    settlementDelayMs: number;
  }>,
): Promise<TestNodeContext> {
  const store = new InMemoryStore();
  const node = new L2Node(
    {
      batchIntervalMs: opts?.batchIntervalMs ?? 999_999,
      autoSettle: opts?.autoSettle ?? false,
      settlementDelayMs: opts?.settlementDelayMs ?? 0,
      role: opts?.role,
      nodeId: opts?.nodeId,
      seedPeers: opts?.seedPeers,
      maxPeers: opts?.maxPeers,
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
  const client = new L2Client({ sequencerUrl: url, adminToken: TEST_ADMIN_TOKEN });

  return {
    node,
    server,
    client,
    port,
    url,
    cleanup: async () => {
      await node.stop();
      await server.stop();
    },
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

/** Helper: create a mock L2Receipt */
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

/** Helper: create a mock AuditEvent */
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
    eventCommitment: '12345',
    chainHash: (67890n + seqNum).toString(),
    timestamp: Date.now(),
    l1Status: 'pending' as const,
  };
}

/** Helper: create a mock L2Block */
function mockBlock(blockNum: bigint, receiptIds: string[]): L2Block {
  return {
    blockNumber: blockNum,
    receiptIds,
    startRegistryRoot: INITIAL_REG_ROOT.toString(),
    endRegistryRoot: INITIAL_REG_ROOT.toString(),
    startLifecycleRoot: INITIAL_LC_ROOT.toString(),
    endLifecycleRoot: INITIAL_LC_ROOT.toString(),
    registrationCount: 0,
    transitionCount: receiptIds.length,
    createdAt: Date.now(),
    l1Status: 'batched' as const,
  };
}

/** Helper: create a mock L2Batch */
function mockBatch(batchNum: bigint, blockNum: bigint, receiptIds: string[]): L2Batch {
  return {
    batchNumber: batchNum,
    blockNumbers: [blockNum],
    registrationCount: 0,
    transitionCount: receiptIds.length,
    oldRegistryRoot: INITIAL_REG_ROOT.toString(),
    newRegistryRoot: INITIAL_REG_ROOT.toString(),
    oldLifecycleRoot: INITIAL_LC_ROOT.toString(),
    newLifecycleRoot: INITIAL_LC_ROOT.toString(),
    batchProofJson: '{}',
    createdAt: Date.now(),
    l1Status: 'batched' as const,
  };
}

/** Helper: create a gossip message */
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

// Track servers for cleanup
let activeContexts: TestNodeContext[] = [];

afterEach(async () => {
  for (const ctx of activeContexts) {
    await ctx.cleanup().catch(() => {});
  }
  activeContexts = [];
});

// ═══════════════════════════════════════════════════════════════
// 1. Type Construction
// ═══════════════════════════════════════════════════════════════

describe('Type Construction', () => {
  test('PeerInfo can be constructed with all fields', () => {
    const info: PeerInfo = {
      peerId: 'node-alpha',
      url: 'http://localhost:3030',
      role: 'sequencer',
      status: 'connected',
      lastSeen: Date.now(),
      latestSequenceNumber: 5n,
      latestBatchNumber: 1n,
    };
    expect(info.peerId).toBe('node-alpha');
    expect(info.role).toBe('sequencer');
    expect(info.latestSequenceNumber).toBe(5n);
    expect(info.latestBatchNumber).toBe(1n);
  });

  test('GossipMessage can be constructed with typed payload', () => {
    const payload: PeerAnnouncePayload = {
      peer: {
        peerId: 'node-beta',
        url: 'http://localhost:3031',
        role: 'replica',
        status: 'connected',
        lastSeen: Date.now(),
        latestSequenceNumber: 0n,
        latestBatchNumber: null,
      },
      knownPeers: ['http://localhost:3030'],
    };
    const msg: GossipMessage = {
      messageId: 'msg-001',
      type: 'peer:announce',
      senderId: 'node-beta',
      timestamp: Date.now(),
      payload,
    };
    expect(msg.type).toBe('peer:announce');
    expect((msg.payload as PeerAnnouncePayload).peer.peerId).toBe('node-beta');
  });

  test('PeerNetworkConfig defaults are reasonable', () => {
    expect(DEFAULT_PEER_NETWORK_CONFIG.role).toBe('replica');
    expect(DEFAULT_PEER_NETWORK_CONFIG.maxPeers).toBe(DEFAULT_MAX_PEERS);
    expect(DEFAULT_PEER_NETWORK_CONFIG.gossipRelayEnabled).toBe(true);
    expect(DEFAULT_PEER_NETWORK_CONFIG.syncOnConnect).toBe(true);
    expect(DEFAULT_PEER_NETWORK_CONFIG.seedPeers).toEqual([]);
  });

  test('generateMessageId produces deterministic IDs', () => {
    const id1 = generateMessageId('proof:accepted', 'node-a', 1000, 'receipt-1');
    const id2 = generateMessageId('proof:accepted', 'node-a', 1000, 'receipt-1');
    expect(id1).toBe(id2);
    expect(typeof id1).toBe('string');
    expect(id1.length).toBe(32);
  });

  test('generateMessageId produces different IDs for different inputs', () => {
    const id1 = generateMessageId('proof:accepted', 'node-a', 1000, 'receipt-1');
    const id2 = generateMessageId('proof:accepted', 'node-a', 1001, 'receipt-1');
    const id3 = generateMessageId('batch:built', 'node-a', 1000, 'receipt-1');
    const id4 = generateMessageId('proof:accepted', 'node-b', 1000, 'receipt-1');
    expect(id1).not.toBe(id2);
    expect(id1).not.toBe(id3);
    expect(id1).not.toBe(id4);
  });
});

// ═══════════════════════════════════════════════════════════════
// 2. L2PeerNetwork — Unit Tests
// ═══════════════════════════════════════════════════════════════

describe('L2PeerNetwork — Unit', () => {
  test('create network with custom config', () => {
    const net = new L2PeerNetwork({
      nodeId: 'test-node',
      role: 'sequencer',
      maxPeers: 5,
    });
    const config = net.getConfig();
    expect(config.nodeId).toBe('test-node');
    expect(config.role).toBe('sequencer');
    expect(config.maxPeers).toBe(5);
    expect(config.gossipRelayEnabled).toBe(true);
  });

  test('getConfig returns a copy', () => {
    const net = new L2PeerNetwork({ nodeId: 'test-node' });
    const c1 = net.getConfig();
    const c2 = net.getConfig();
    expect(c1).toEqual(c2);
    expect(c1).not.toBe(c2);
  });

  test('getPeers is empty initially', () => {
    const net = new L2PeerNetwork({ nodeId: 'test-node' });
    expect(net.getPeers()).toEqual([]);
  });

  test('getConnectedPeers is empty initially', () => {
    const net = new L2PeerNetwork({ nodeId: 'test-node' });
    expect(net.getConnectedPeers()).toEqual([]);
  });

  test('getPeerUrls is empty initially', () => {
    const net = new L2PeerNetwork({ nodeId: 'test-node' });
    expect(net.getPeerUrls()).toEqual([]);
  });

  test('handleIncoming returns true for new message', () => {
    const net = new L2PeerNetwork({ nodeId: 'test-node' });
    const msg = makeGossipMessage('peer:announce', 'sender-1', {
      peer: { peerId: 'sender-1', url: '', role: 'replica' as const, status: 'connected' as const, lastSeen: 0, latestSequenceNumber: 0n, latestBatchNumber: null },
      knownPeers: [],
    });
    const result = net.handleIncoming(msg);
    expect(result).toBe(true);
  });

  test('handleIncoming returns false for duplicate message', () => {
    const net = new L2PeerNetwork({ nodeId: 'test-node' });
    const msg = makeGossipMessage('peer:announce', 'sender-1', {
      peer: { peerId: 'sender-1', url: '', role: 'replica' as const, status: 'connected' as const, lastSeen: 0, latestSequenceNumber: 0n, latestBatchNumber: null },
      knownPeers: [],
    });
    expect(net.handleIncoming(msg)).toBe(true);
    expect(net.handleIncoming(msg)).toBe(false);
  });

  test('deduplication: same messageId rejected on second call', () => {
    const net = new L2PeerNetwork({ nodeId: 'test-node' });
    const payload = {
      peer: { peerId: 'x', url: '', role: 'replica' as const, status: 'connected' as const, lastSeen: 0, latestSequenceNumber: 0n, latestBatchNumber: null },
      knownPeers: [],
    };
    const msg1: GossipMessage = { messageId: 'unique-id-001', type: 'peer:announce', senderId: 'x', timestamp: 1, payload };
    const msg2: GossipMessage = { messageId: 'unique-id-001', type: 'peer:announce', senderId: 'x', timestamp: 2, payload };
    expect(net.handleIncoming(msg1)).toBe(true);
    expect(net.handleIncoming(msg2)).toBe(false);
  });

  test('seenMessages eviction when MAX_SEEN_MESSAGES reached', () => {
    const net = new L2PeerNetwork({ nodeId: 'test-node' });
    const payload = {
      peer: { peerId: 'x', url: '', role: 'replica' as const, status: 'connected' as const, lastSeen: 0, latestSequenceNumber: 0n, latestBatchNumber: null },
      knownPeers: [],
    };

    // Insert MAX_SEEN_MESSAGES + 1 unique messages
    for (let i = 0; i <= MAX_SEEN_MESSAGES; i++) {
      const msg: GossipMessage = {
        messageId: `msg-${i}`,
        type: 'peer:announce',
        senderId: 'x',
        timestamp: i,
        payload,
      };
      expect(net.handleIncoming(msg)).toBe(true);
    }

    // After eviction, the first messages should have been cleared.
    // Oldest half is evicted when capacity reached, so msg-0 should be evicted.
    const oldMsg: GossipMessage = {
      messageId: 'msg-0',
      type: 'peer:announce',
      senderId: 'x',
      timestamp: 0,
      payload,
    };
    // After eviction, msg-0 should be accepted again (it was evicted)
    expect(net.handleIncoming(oldMsg)).toBe(true);
  });

  test('on/off handler subscription', () => {
    const net = new L2PeerNetwork({ nodeId: 'test-node' });
    const calls: string[] = [];
    const handler: GossipHandler = (msg) => { calls.push(msg.messageId); };

    net.on(handler);

    const msg1 = makeGossipMessage('peer:announce', 'x', {
      peer: { peerId: 'x', url: '', role: 'replica' as const, status: 'connected' as const, lastSeen: 0, latestSequenceNumber: 0n, latestBatchNumber: null },
      knownPeers: [],
    }, 'test-msg-1');
    net.handleIncoming(msg1);
    expect(calls).toEqual(['test-msg-1']);

    net.off(handler);

    const msg2 = makeGossipMessage('peer:announce', 'x', {
      peer: { peerId: 'x', url: '', role: 'replica' as const, status: 'connected' as const, lastSeen: 0, latestSequenceNumber: 0n, latestBatchNumber: null },
      knownPeers: [],
    }, 'test-msg-2');
    net.handleIncoming(msg2);
    // Handler was removed, so calls should still have only 1 entry
    expect(calls).toEqual(['test-msg-1']);
  });

  test('handler called on new message', () => {
    const net = new L2PeerNetwork({ nodeId: 'test-node' });
    let received: GossipMessage | null = null;
    net.on((msg) => { received = msg; });

    const msg = makeGossipMessage('proof:accepted', 'sender-1', {
      receipt: mockReceipt(0n),
      auditEvent: mockAuditEvent(0n),
      currentRegistryRoot: INITIAL_REG_ROOT.toString(),
      currentLifecycleRoot: INITIAL_LC_ROOT.toString(),
      currentWalletCount: '0',
    }, 'proof-msg-1');
    net.handleIncoming(msg);
    expect(received).not.toBeNull();
    expect(received!.messageId).toBe('proof-msg-1');
  });

  test('handler NOT called on duplicate', () => {
    const net = new L2PeerNetwork({ nodeId: 'test-node' });
    let callCount = 0;
    net.on(() => { callCount++; });

    const msg = makeGossipMessage('peer:announce', 'x', {
      peer: { peerId: 'x', url: '', role: 'replica' as const, status: 'connected' as const, lastSeen: 0, latestSequenceNumber: 0n, latestBatchNumber: null },
      knownPeers: [],
    }, 'dup-test');

    net.handleIncoming(msg);
    net.handleIncoming(msg);
    expect(callCount).toBe(1);
  });

  test('start/stop lifecycle', () => {
    const net = new L2PeerNetwork({
      nodeId: 'test-node',
      announceIntervalMs: 999_999, // Prevent actual announcements
    });
    expect(net.isRunning()).toBe(false);
    net.start();
    expect(net.isRunning()).toBe(true);
    net.stop();
    expect(net.isRunning()).toBe(false);
  });

  test('isRunning returns false initially', () => {
    const net = new L2PeerNetwork({ nodeId: 'test-node' });
    expect(net.isRunning()).toBe(false);
  });

  test('start is idempotent', () => {
    const net = new L2PeerNetwork({
      nodeId: 'test-node',
      announceIntervalMs: 999_999,
    });
    net.start();
    net.start(); // should not throw
    expect(net.isRunning()).toBe(true);
    net.stop();
  });

  test('stop clears peers', () => {
    const net = new L2PeerNetwork({
      nodeId: 'test-node',
      announceIntervalMs: 999_999,
    });
    net.start();
    // Manually calling stop should clear everything
    net.stop();
    expect(net.getPeers()).toEqual([]);
    expect(net.getConnectedPeers()).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════
// 3. Sequencer Replication Methods
// ═══════════════════════════════════════════════════════════════

describe('Sequencer Replication Methods', () => {
  let sequencer: ReturnType<L2Node['getSequencer']>;

  beforeEach(() => {
    const store = new InMemoryStore();
    const node = new L2Node(
      { batchIntervalMs: 999_999, autoSettle: false },
      store,
      INITIAL_REG_ROOT,
      INITIAL_LC_ROOT,
      Field(0),
    );
    sequencer = node.getSequencer();
  });

  test('getLatestSequenceNumber returns -1n initially', () => {
    expect(sequencer.getLatestSequenceNumber()).toBe(-1n);
  });

  test('applyReplicatedReceipt stores receipt and audit event', () => {
    const receipt = mockReceipt(0n);
    const audit = mockAuditEvent(0n);

    sequencer.applyReplicatedReceipt(receipt, audit);

    expect(sequencer.getReceipt(receipt.receiptId)).toBeDefined();
    expect(sequencer.getReceipt(receipt.receiptId)!.walletId).toBe('wallet-0');
    expect(sequencer.getAuditLog().events.length).toBe(1);
  });

  test('applyReplicatedReceipt is idempotent (skip duplicate receiptId)', () => {
    const receipt = mockReceipt(0n);
    const audit = mockAuditEvent(0n);

    sequencer.applyReplicatedReceipt(receipt, audit);
    sequencer.applyReplicatedReceipt(receipt, audit);

    // Should only have one receipt and one audit event
    expect(sequencer.getAllReceipts().length).toBe(1);
    expect(sequencer.getAuditLog().events.length).toBe(1);
  });

  test('applyReplicatedReceipt advances sequence number', () => {
    const receipt = mockReceipt(5n);
    const audit = mockAuditEvent(5n);

    sequencer.applyReplicatedReceipt(receipt, audit);
    expect(sequencer.getLatestSequenceNumber()).toBe(5n);
  });

  test('applyReplicatedReceipt advances sequence number past highest', () => {
    sequencer.applyReplicatedReceipt(mockReceipt(3n), mockAuditEvent(3n));
    sequencer.applyReplicatedReceipt(mockReceipt(7n), mockAuditEvent(7n));
    expect(sequencer.getLatestSequenceNumber()).toBe(7n);
  });

  test('applyReplicatedReceipt updates roots when provided', () => {
    const receipt = mockReceipt(0n);
    const audit = mockAuditEvent(0n);
    const newRegRoot = '999';
    const newLcRoot = '888';
    const newWalletCount = '42';

    sequencer.applyReplicatedReceipt(receipt, audit, undefined, newRegRoot, newLcRoot, newWalletCount);

    expect(sequencer.getCurrentRegistryRoot().toString()).toBe(newRegRoot);
    expect(sequencer.getCurrentLifecycleRoot().toString()).toBe(newLcRoot);
    expect(sequencer.getCurrentWalletCount().toString()).toBe(newWalletCount);
  });

  test('applyReplicatedReceipt does not change roots when not provided', () => {
    const origReg = sequencer.getCurrentRegistryRoot().toString();
    const origLc = sequencer.getCurrentLifecycleRoot().toString();

    const receipt = mockReceipt(0n);
    const audit = mockAuditEvent(0n);

    sequencer.applyReplicatedReceipt(receipt, audit);

    expect(sequencer.getCurrentRegistryRoot().toString()).toBe(origReg);
    expect(sequencer.getCurrentLifecycleRoot().toString()).toBe(origLc);
  });

  test('applyReplicatedReceipt updates audit chain hash', () => {
    const receipt = mockReceipt(0n);
    const audit = mockAuditEvent(0n);
    audit.chainHash = '99999';

    sequencer.applyReplicatedReceipt(receipt, audit);

    expect(sequencer.getLatestChainHash()).toBe('99999');
  });

  test('applyReplicatedBatch stores block and batch', () => {
    // First add receipts
    const r0 = mockReceipt(0n, 'l2-00000000');
    const a0 = mockAuditEvent(0n, 'l2-00000000');
    sequencer.applyReplicatedReceipt(r0, a0);

    const block = mockBlock(0n, ['l2-00000000']);
    const batch = mockBatch(0n, 0n, ['l2-00000000']);

    sequencer.applyReplicatedBatch(batch, block, [{ ...r0, l1Status: 'batched', l2BlockNumber: 0n, l1BatchNumber: 0n }], [{ ...a0, l1Status: 'batched', l2BlockNumber: 0n, l1BatchNumber: 0n }]);

    expect(sequencer.getBlock(0n)).toBeDefined();
    expect(sequencer.getBatch(0n)).toBeDefined();
    expect(sequencer.getLatestBatchNumber()).toBe(0n);
  });

  test('applyReplicatedBatch is idempotent (skip duplicate batchNumber)', () => {
    const r0 = mockReceipt(0n, 'l2-00000000');
    const a0 = mockAuditEvent(0n, 'l2-00000000');
    sequencer.applyReplicatedReceipt(r0, a0);

    const block = mockBlock(0n, ['l2-00000000']);
    const batch = mockBatch(0n, 0n, ['l2-00000000']);
    const updatedReceipts = [{ ...r0, l1Status: 'batched' as const, l2BlockNumber: 0n, l1BatchNumber: 0n }];
    const updatedAudit = [{ ...a0, l1Status: 'batched' as const, l2BlockNumber: 0n, l1BatchNumber: 0n }];

    sequencer.applyReplicatedBatch(batch, block, updatedReceipts, updatedAudit);
    sequencer.applyReplicatedBatch(batch, block, updatedReceipts, updatedAudit);

    expect(sequencer.getAllBatches().length).toBe(1);
  });

  test('applyReplicatedBatch updates receipt statuses', () => {
    const r0 = mockReceipt(0n, 'l2-00000000');
    const a0 = mockAuditEvent(0n, 'l2-00000000');
    sequencer.applyReplicatedReceipt(r0, a0);

    expect(sequencer.getReceipt('l2-00000000')!.l1Status).toBe('pending');

    const block = mockBlock(0n, ['l2-00000000']);
    const batch = mockBatch(0n, 0n, ['l2-00000000']);
    sequencer.applyReplicatedBatch(
      batch, block,
      [{ ...r0, l1Status: 'batched', l2BlockNumber: 0n, l1BatchNumber: 0n }],
      [{ ...a0, l1Status: 'batched', l2BlockNumber: 0n, l1BatchNumber: 0n }],
    );

    expect(sequencer.getReceipt('l2-00000000')!.l1Status).toBe('batched');
    expect(sequencer.getReceipt('l2-00000000')!.l2BlockNumber).toBe(0n);
    expect(sequencer.getReceipt('l2-00000000')!.l1BatchNumber).toBe(0n);
  });

  test('applyReplicatedSettlement marks batch/block/receipt/audit as settled', () => {
    // Build the full chain: receipt -> batch -> settlement
    const r0 = mockReceipt(0n, 'l2-00000000');
    const a0 = mockAuditEvent(0n, 'l2-00000000');
    sequencer.applyReplicatedReceipt(r0, a0);

    const block = mockBlock(0n, ['l2-00000000']);
    const batch = mockBatch(0n, 0n, ['l2-00000000']);
    sequencer.applyReplicatedBatch(
      batch, block,
      [{ ...r0, l1Status: 'batched', l2BlockNumber: 0n, l1BatchNumber: 0n }],
      [{ ...a0, l1Status: 'batched', l2BlockNumber: 0n, l1BatchNumber: 0n }],
    );

    sequencer.applyReplicatedSettlement(0n, 'tx-hash-abc', INITIAL_REG_ROOT.toString(), INITIAL_LC_ROOT.toString(), '0');

    expect(sequencer.getBatch(0n)!.l1Status).toBe('settled');
    expect(sequencer.getBatch(0n)!.l1TxHash).toBe('tx-hash-abc');
    expect(sequencer.getBlock(0n)!.l1Status).toBe('settled');
    expect(sequencer.getReceipt('l2-00000000')!.l1Status).toBe('settled');
    expect(sequencer.getLastSettledRegistryRoot().toString()).toBe(INITIAL_REG_ROOT.toString());
  });

  test('applyReplicatedSettlement is idempotent', () => {
    const r0 = mockReceipt(0n, 'l2-00000000');
    const a0 = mockAuditEvent(0n, 'l2-00000000');
    sequencer.applyReplicatedReceipt(r0, a0);

    const block = mockBlock(0n, ['l2-00000000']);
    const batch = mockBatch(0n, 0n, ['l2-00000000']);
    sequencer.applyReplicatedBatch(
      batch, block,
      [{ ...r0, l1Status: 'batched', l2BlockNumber: 0n, l1BatchNumber: 0n }],
      [{ ...a0, l1Status: 'batched', l2BlockNumber: 0n, l1BatchNumber: 0n }],
    );

    sequencer.applyReplicatedSettlement(0n, 'tx-1', INITIAL_REG_ROOT.toString(), INITIAL_LC_ROOT.toString(), '0');
    sequencer.applyReplicatedSettlement(0n, 'tx-2', INITIAL_REG_ROOT.toString(), INITIAL_LC_ROOT.toString(), '0');

    // First call wins — tx hash should be 'tx-1'
    expect(sequencer.getBatch(0n)!.l1TxHash).toBe('tx-1');
  });

  test('applyReplicatedSettlement clears in-flight batch', () => {
    const r0 = mockReceipt(0n, 'l2-00000000');
    const a0 = mockAuditEvent(0n, 'l2-00000000');
    sequencer.applyReplicatedReceipt(r0, a0);

    const block = mockBlock(0n, ['l2-00000000']);
    const batch = mockBatch(0n, 0n, ['l2-00000000']);
    sequencer.applyReplicatedBatch(batch, block, [{ ...r0, l1Status: 'batched', l2BlockNumber: 0n, l1BatchNumber: 0n }], [{ ...a0, l1Status: 'batched', l2BlockNumber: 0n, l1BatchNumber: 0n }]);

    // After applyReplicatedBatch, in-flight should be set
    expect(sequencer.getInFlightBatchNumber()).toBe(0n);

    sequencer.applyReplicatedSettlement(0n, 'tx-x', INITIAL_REG_ROOT.toString(), INITIAL_LC_ROOT.toString(), '0');
    expect(sequencer.getInFlightBatchNumber()).toBeNull();
  });

  test('applyReplicatedBatchFailure marks as failed', () => {
    const r0 = mockReceipt(0n, 'l2-00000000');
    const a0 = mockAuditEvent(0n, 'l2-00000000');
    sequencer.applyReplicatedReceipt(r0, a0);

    const block = mockBlock(0n, ['l2-00000000']);
    const batch = mockBatch(0n, 0n, ['l2-00000000']);
    sequencer.applyReplicatedBatch(batch, block, [{ ...r0, l1Status: 'batched', l2BlockNumber: 0n, l1BatchNumber: 0n }], [{ ...a0, l1Status: 'batched', l2BlockNumber: 0n, l1BatchNumber: 0n }]);

    sequencer.applyReplicatedBatchFailure(0n, 'L1 tx reverted');

    expect(sequencer.getBatch(0n)!.l1Status).toBe('failed');
    expect(sequencer.getBatch(0n)!.failureReason).toBe('L1 tx reverted');
    expect(sequencer.getInFlightBatchNumber()).toBeNull();
  });

  test('applyReplicatedBatchFailure is idempotent', () => {
    const r0 = mockReceipt(0n, 'l2-00000000');
    const a0 = mockAuditEvent(0n, 'l2-00000000');
    sequencer.applyReplicatedReceipt(r0, a0);

    const block = mockBlock(0n, ['l2-00000000']);
    const batch = mockBatch(0n, 0n, ['l2-00000000']);
    sequencer.applyReplicatedBatch(batch, block, [{ ...r0, l1Status: 'batched', l2BlockNumber: 0n, l1BatchNumber: 0n }], [{ ...a0, l1Status: 'batched', l2BlockNumber: 0n, l1BatchNumber: 0n }]);

    sequencer.applyReplicatedBatchFailure(0n, 'reason-1');
    sequencer.applyReplicatedBatchFailure(0n, 'reason-2');

    // First call wins
    expect(sequencer.getBatch(0n)!.failureReason).toBe('reason-1');
  });

  test('applyReplicatedSettlement for unknown batch is a no-op', () => {
    // Should not throw — silently skips
    sequencer.applyReplicatedSettlement(99n, 'tx-hash', '1', '1', '0');
    expect(sequencer.getBatch(99n)).toBeUndefined();
  });

  test('applyReplicatedBatchFailure for unknown batch is a no-op', () => {
    sequencer.applyReplicatedBatchFailure(99n, 'reason');
    expect(sequencer.getBatch(99n)).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════
// 4. RPC Peer Methods
// ═══════════════════════════════════════════════════════════════

describe('RPC Peer Methods', () => {
  test('l2_getPeerInfo returns valid PeerInfo', async () => {
    const ctx = await createTestNode({ nodeId: 'rpc-node-1', role: 'sequencer' });
    activeContexts.push(ctx);

    const peerNet = new L2PeerNetwork({ nodeId: 'rpc-node-1', role: 'sequencer' });
    ctx.server.setPeerNetwork(peerNet);
    ctx.node.start();

    const res = await rawRpc(ctx.port, l2Stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'l2_getPeerInfo',
    }));

    const rpc = l2Parse<{ jsonrpc: string; id: number; result: PeerInfo }>(res.body);
    expect(rpc.result.peerId).toBe('rpc-node-1');
    expect(rpc.result.status).toBe('connected');
    expect(rpc.result.latestSequenceNumber).toBe(-1n);
    expect(rpc.result.latestBatchNumber).toBeNull();
  });

  test('l2_getPeerList returns empty when no peers', async () => {
    const ctx = await createTestNode({ nodeId: 'rpc-node-2' });
    activeContexts.push(ctx);
    ctx.node.start();

    const res = await rawRpc(ctx.port, l2Stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'l2_getPeerList',
    }));

    const rpc = l2Parse<{ jsonrpc: string; id: number; result: string[] }>(res.body);
    expect(rpc.result).toEqual([]);
  });

  test('l2_getStateDigest returns valid digest', async () => {
    const ctx = await createTestNode({ nodeId: 'rpc-node-3' });
    activeContexts.push(ctx);
    ctx.node.start();

    const res = await rawRpc(ctx.port, l2Stringify({
      jsonrpc: '2.0',
      id: 3,
      method: 'l2_getStateDigest',
    }));

    const rpc = l2Parse<{ jsonrpc: string; id: number; result: StateDigest }>(res.body);
    expect(rpc.result.latestSequenceNumber).toBe(-1n);
    expect(rpc.result.latestBatchNumber).toBeNull();
    expect(rpc.result.registryRoot).toBe(INITIAL_REG_ROOT.toString());
    expect(rpc.result.lifecycleRoot).toBe(INITIAL_LC_ROOT.toString());
    expect(rpc.result.walletCount).toBe('0');
    expect(typeof rpc.result.auditChainHash).toBe('string');
    expect(typeof rpc.result.claimAccumulatorRoot).toBe('string');
  });

  test('l2_requestSnapshot returns full state', async () => {
    const ctx = await createTestNode({ nodeId: 'rpc-node-4' });
    activeContexts.push(ctx);
    ctx.node.start();

    const res = await rawRpc(ctx.port, l2Stringify({
      jsonrpc: '2.0',
      id: 4,
      method: 'l2_requestSnapshot',
    }), TEST_ADMIN_TOKEN);

    const rpc = l2Parse<{ jsonrpc: string; id: number; result: L2SequencerState }>(res.body);
    expect(rpc.result.currentRegistryRoot).toBe(INITIAL_REG_ROOT.toString());
    expect(rpc.result.currentLifecycleRoot).toBe(INITIAL_LC_ROOT.toString());
    expect(rpc.result.currentWalletCount).toBe('0');
    expect(Array.isArray(rpc.result.receipts)).toBe(true);
    expect(Array.isArray(rpc.result.blocks)).toBe(true);
    expect(Array.isArray(rpc.result.batches)).toBe(true);
    expect(Array.isArray(rpc.result.auditLog)).toBe(true);
  });

  test('l2_gossipRelay accepts message when peer network set', async () => {
    const ctx = await createTestNode({ nodeId: 'rpc-node-5' });
    activeContexts.push(ctx);

    const peerNet = new L2PeerNetwork({ nodeId: 'rpc-node-5', role: 'sequencer' });
    ctx.server.setPeerNetwork(peerNet);
    ctx.node.start();

    const gossipMsg = makeGossipMessage('peer:announce', 'sender-x', {
      peer: { peerId: 'sender-x', url: '', role: 'replica' as const, status: 'connected' as const, lastSeen: 0, latestSequenceNumber: 0n, latestBatchNumber: null },
      knownPeers: [],
    });

    const res = await rawRpc(ctx.port, l2Stringify({
      jsonrpc: '2.0',
      id: 5,
      method: 'l2_gossipRelay',
      params: { message: gossipMsg },
    }), TEST_ADMIN_TOKEN);

    const rpc = l2Parse<{ jsonrpc: string; id: number; result: { accepted: boolean } }>(res.body);
    expect(rpc.result.accepted).toBe(true);
  });

  test('l2_gossipRelay rejects without peer network', async () => {
    const ctx = await createTestNode({ nodeId: 'rpc-node-6' });
    activeContexts.push(ctx);
    ctx.node.start();

    const gossipMsg = makeGossipMessage('peer:announce', 'sender-x', {
      peer: { peerId: 'sender-x', url: '', role: 'replica' as const, status: 'connected' as const, lastSeen: 0, latestSequenceNumber: 0n, latestBatchNumber: null },
      knownPeers: [],
    });

    const res = await rawRpc(ctx.port, l2Stringify({
      jsonrpc: '2.0',
      id: 6,
      method: 'l2_gossipRelay',
      params: { message: gossipMsg },
    }), TEST_ADMIN_TOKEN);

    const rpc = l2Parse<{ jsonrpc: string; id: number; error?: { code: number; message: string } }>(res.body);
    expect(rpc.error).toBeDefined();
    expect(rpc.error!.message).toContain('Peer network not configured');
  });

  test('l2_gossipRelay deduplicates same message', async () => {
    const ctx = await createTestNode({ nodeId: 'rpc-node-7' });
    activeContexts.push(ctx);

    const peerNet = new L2PeerNetwork({ nodeId: 'rpc-node-7', role: 'sequencer' });
    ctx.server.setPeerNetwork(peerNet);
    ctx.node.start();

    const gossipMsg = makeGossipMessage('peer:announce', 'sender-x', {
      peer: { peerId: 'sender-x', url: '', role: 'replica' as const, status: 'connected' as const, lastSeen: 0, latestSequenceNumber: 0n, latestBatchNumber: null },
      knownPeers: [],
    }, 'dedup-test-id');

    // First call: accepted
    const res1 = await rawRpc(ctx.port, l2Stringify({
      jsonrpc: '2.0', id: 7, method: 'l2_gossipRelay', params: { message: gossipMsg },
    }), TEST_ADMIN_TOKEN);
    const rpc1 = l2Parse<{ result: { accepted: boolean } }>(res1.body);
    expect(rpc1.result.accepted).toBe(true);

    // Second call: rejected (duplicate)
    const res2 = await rawRpc(ctx.port, l2Stringify({
      jsonrpc: '2.0', id: 8, method: 'l2_gossipRelay', params: { message: gossipMsg },
    }), TEST_ADMIN_TOKEN);
    const rpc2 = l2Parse<{ result: { accepted: boolean } }>(res2.body);
    expect(rpc2.result.accepted).toBe(false);
  });

  test('l2_getPeerInfo without peer network uses defaults', async () => {
    const ctx = await createTestNode({ nodeId: 'rpc-node-8' });
    activeContexts.push(ctx);
    ctx.node.start();

    const res = await rawRpc(ctx.port, l2Stringify({
      jsonrpc: '2.0', id: 9, method: 'l2_getPeerInfo',
    }));

    const rpc = l2Parse<{ result: PeerInfo }>(res.body);
    // Without setPeerNetwork, peerId falls back to 'unknown'
    expect(rpc.result.peerId).toBe('unknown');
    expect(rpc.result.role).toBe('sequencer');
  });

  test('l2_gossipRelay rejects invalid message', async () => {
    const ctx = await createTestNode({ nodeId: 'rpc-node-9' });
    activeContexts.push(ctx);

    const peerNet = new L2PeerNetwork({ nodeId: 'rpc-node-9' });
    ctx.server.setPeerNetwork(peerNet);
    ctx.node.start();

    const res = await rawRpc(ctx.port, l2Stringify({
      jsonrpc: '2.0', id: 10, method: 'l2_gossipRelay',
      params: { message: { noMessageId: true } },
    }), TEST_ADMIN_TOKEN);

    const rpc = l2Parse<{ error?: { message: string } }>(res.body);
    expect(rpc.error).toBeDefined();
    expect(rpc.error!.message).toContain('invalid message');
  });
});

// ═══════════════════════════════════════════════════════════════
// 5. Client Peer Methods
// ═══════════════════════════════════════════════════════════════

describe('Client Peer Methods', () => {
  test('client.getPeerInfo() returns PeerInfo', async () => {
    const ctx = await createTestNode({ nodeId: 'client-node-1', role: 'sequencer' });
    activeContexts.push(ctx);
    ctx.node.start();

    // Set up peer network so peerId is correct
    const peerNet = new L2PeerNetwork({ nodeId: 'client-node-1', role: 'sequencer' });
    ctx.server.setPeerNetwork(peerNet);

    const info = await ctx.client.getPeerInfo();
    expect(info.peerId).toBe('client-node-1');
    expect(info.role).toBe('sequencer');
    expect(info.status).toBe('connected');
    expect(typeof info.lastSeen).toBe('number');
  });

  test('client.getStateDigest() returns StateDigest', async () => {
    const ctx = await createTestNode({ nodeId: 'client-node-2' });
    activeContexts.push(ctx);
    ctx.node.start();

    const digest = await ctx.client.getStateDigest();
    expect(digest.latestSequenceNumber).toBe(-1n);
    expect(digest.latestBatchNumber).toBeNull();
    expect(digest.registryRoot).toBe(INITIAL_REG_ROOT.toString());
    expect(digest.lifecycleRoot).toBe(INITIAL_LC_ROOT.toString());
    expect(digest.walletCount).toBe('0');
  });

  test('client.requestSnapshot() returns full sequencer state', async () => {
    const ctx = await createTestNode({ nodeId: 'client-node-3' });
    activeContexts.push(ctx);
    ctx.node.start();

    const state = await ctx.client.requestSnapshot();
    expect(state.currentRegistryRoot).toBe(INITIAL_REG_ROOT.toString());
    expect(state.currentWalletCount).toBe('0');
    expect(state.nextSequenceNumber).toBe(0n);
    expect(Array.isArray(state.receipts)).toBe(true);
  });

  test('client.getPeerList() returns URLs', async () => {
    const ctx = await createTestNode({ nodeId: 'client-node-4' });
    activeContexts.push(ctx);
    ctx.node.start();

    const peers = await ctx.client.getPeerList();
    expect(Array.isArray(peers)).toBe(true);
    expect(peers.length).toBe(0);
  });

  test('client.gossipRelay() sends and receives response', async () => {
    const ctx = await createTestNode({ nodeId: 'client-node-5' });
    activeContexts.push(ctx);

    const peerNet = new L2PeerNetwork({ nodeId: 'client-node-5' });
    ctx.server.setPeerNetwork(peerNet);
    ctx.node.start();

    const msg = makeGossipMessage('peer:announce', 'remote-x', {
      peer: { peerId: 'remote-x', url: '', role: 'replica' as const, status: 'connected' as const, lastSeen: 0, latestSequenceNumber: 0n, latestBatchNumber: null },
      knownPeers: [],
    });

    const result = await ctx.client.gossipRelay(msg);
    expect(result.accepted).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// 6. L2Node Peer Integration
// ═══════════════════════════════════════════════════════════════

describe('L2Node Peer Integration', () => {
  test('node with role=sequencer (default)', () => {
    const store = new InMemoryStore();
    const node = new L2Node(
      { batchIntervalMs: 999_999 },
      store,
      INITIAL_REG_ROOT,
      INITIAL_LC_ROOT,
      Field(0),
    );
    expect(node.getRole()).toBe('sequencer');
  });

  test('node with role=replica', () => {
    const store = new InMemoryStore();
    const node = new L2Node(
      { batchIntervalMs: 999_999, role: 'replica' },
      store,
      INITIAL_REG_ROOT,
      INITIAL_LC_ROOT,
      Field(0),
    );
    expect(node.getRole()).toBe('replica');
  });

  test('getNodeId returns configured ID', () => {
    const store = new InMemoryStore();
    const node = new L2Node(
      { batchIntervalMs: 999_999, nodeId: 'my-custom-node' },
      store,
      INITIAL_REG_ROOT,
      INITIAL_LC_ROOT,
      Field(0),
    );
    expect(node.getNodeId()).toBe('my-custom-node');
  });

  test('getNodeId returns auto-generated ID when not configured', () => {
    const store = new InMemoryStore();
    const node = new L2Node(
      { batchIntervalMs: 999_999 },
      store,
      INITIAL_REG_ROOT,
      INITIAL_LC_ROOT,
      Field(0),
    );
    const id = node.getNodeId();
    expect(typeof id).toBe('string');
    expect(id.startsWith('node-')).toBe(true);
  });

  test('getPeerNetwork is null when no seedPeers', () => {
    const store = new InMemoryStore();
    const node = new L2Node(
      { batchIntervalMs: 999_999 },
      store,
      INITIAL_REG_ROOT,
      INITIAL_LC_ROOT,
      Field(0),
    );
    node.start();
    expect(node.getPeerNetwork()).toBeNull();
    node.stop();
  });

  test('node start() with seedPeers creates peer network', async () => {
    // Create a sequencer node that the replica can connect to
    const seqCtx = await createTestNode({ nodeId: 'seq-for-peer', role: 'sequencer' });
    activeContexts.push(seqCtx);

    const peerNet = new L2PeerNetwork({ nodeId: 'seq-for-peer', role: 'sequencer' });
    seqCtx.server.setPeerNetwork(peerNet);
    seqCtx.node.start();

    // Create a replica node with seedPeers
    const repCtx = await createTestNode({
      nodeId: 'rep-peer-test',
      role: 'replica',
      seedPeers: [seqCtx.url],
    });
    activeContexts.push(repCtx);
    repCtx.node.start();

    // Wait a bit for async peer connection
    await new Promise((r) => setTimeout(r, 500));

    expect(repCtx.node.getPeerNetwork()).not.toBeNull();
  });

  test('node status includes role info', async () => {
    const ctx = await createTestNode({ nodeId: 'status-node', role: 'replica' });
    activeContexts.push(ctx);
    ctx.node.start();

    const status = ctx.node.getStatus();
    expect(status.running).toBe(true);
    expect(status.pendingProofs).toBe(0);
  });

  test('sequencer node has auto-generated nodeId', () => {
    const store = new InMemoryStore();
    const n1 = new L2Node({ batchIntervalMs: 999_999 }, store, INITIAL_REG_ROOT, INITIAL_LC_ROOT, Field(0));
    const n2 = new L2Node({ batchIntervalMs: 999_999 }, store, INITIAL_REG_ROOT, INITIAL_LC_ROOT, Field(0));
    expect(n1.getNodeId()).not.toBe(n2.getNodeId());
  });

  test('replica does not start batch timer', async () => {
    const ctx = await createTestNode({
      nodeId: 'replica-no-timer',
      role: 'replica',
      batchIntervalMs: 100,
    });
    activeContexts.push(ctx);
    ctx.node.start();

    // Wait longer than batch interval
    await new Promise((r) => setTimeout(r, 300));

    // Replica should not attempt to build batches
    const status = ctx.node.getStatus();
    expect(status.totalBatchesBuilt).toBe(0);
  });

  test('node stop disconnects peer network', async () => {
    const seqCtx = await createTestNode({ nodeId: 'seq-stop-test', role: 'sequencer' });
    activeContexts.push(seqCtx);
    const peerNet = new L2PeerNetwork({ nodeId: 'seq-stop-test', role: 'sequencer' });
    seqCtx.server.setPeerNetwork(peerNet);
    seqCtx.node.start();

    const repCtx = await createTestNode({
      nodeId: 'rep-stop-test',
      role: 'replica',
      seedPeers: [seqCtx.url],
    });
    activeContexts.push(repCtx);
    repCtx.node.start();

    await new Promise((r) => setTimeout(r, 500));

    expect(repCtx.node.getPeerNetwork()).not.toBeNull();

    await repCtx.node.stop();
    expect(repCtx.node.getPeerNetwork()).toBeNull();
  });

  test('node getRole returns replica when configured', async () => {
    const ctx = await createTestNode({ nodeId: 'role-test', role: 'replica' });
    activeContexts.push(ctx);
    expect(ctx.node.getRole()).toBe('replica');
  });

  test('fromPeerSync creates replica from sequencer state', async () => {
    // Create a sequencer with some state
    const seqCtx = await createTestNode({ nodeId: 'seq-ibd', role: 'sequencer' });
    activeContexts.push(seqCtx);
    seqCtx.node.start();

    // Apply some state to the sequencer
    const seq = seqCtx.node.getSequencer();
    const r0 = mockReceipt(0n, 'l2-00000000');
    const a0 = mockAuditEvent(0n, 'l2-00000000');
    seq.applyReplicatedReceipt(r0, a0);

    // Create a replica via fromPeerSync
    const replicaStore = new InMemoryStore();
    const replica = await L2Node.fromPeerSync(seqCtx.url, replicaStore, {
      role: 'replica',
      nodeId: 'replica-ibd',
      batchIntervalMs: 999_999,
      adminToken: TEST_ADMIN_TOKEN,
    });

    expect(replica.getRole()).toBe('replica');
    expect(replica.getNodeId()).toBe('replica-ibd');

    // Verify the state was synced
    const repSeq = replica.getSequencer();
    expect(repSeq.getReceipt('l2-00000000')).toBeDefined();
    expect(repSeq.getLatestSequenceNumber()).toBe(0n);
    expect(repSeq.getAuditLog().events.length).toBe(1);

    await replica.stop();
  });

  test('fromPeerSync adds peer URL to seedPeers', async () => {
    const seqCtx = await createTestNode({ nodeId: 'seq-ibd-seed', role: 'sequencer' });
    activeContexts.push(seqCtx);
    seqCtx.node.start();

    const replicaStore = new InMemoryStore();
    const replica = await L2Node.fromPeerSync(seqCtx.url, replicaStore, {
      role: 'replica',
      batchIntervalMs: 999_999,
      adminToken: TEST_ADMIN_TOKEN,
    });

    // Start the replica — it should try to connect to the sequencer
    replica.start();
    await new Promise((r) => setTimeout(r, 500));

    // The peer network should exist because seedPeers was set
    expect(replica.getPeerNetwork()).not.toBeNull();

    await replica.stop();
  });
});

// ═══════════════════════════════════════════════════════════════
// 7. Multi-Node Gossip
// ═══════════════════════════════════════════════════════════════

describe('Multi-Node Gossip', () => {
  test('sequencer works without peers (standalone)', async () => {
    const ctx = await createTestNode({
      nodeId: 'standalone-seq',
      role: 'sequencer',
    });
    activeContexts.push(ctx);
    ctx.node.start();

    // Should be able to apply receipts directly
    const seq = ctx.node.getSequencer();
    const r = mockReceipt(0n);
    const a = mockAuditEvent(0n);
    seq.applyReplicatedReceipt(r, a);

    expect(seq.getLatestSequenceNumber()).toBe(0n);
    expect(seq.getAllReceipts().length).toBe(1);
  });

  test('replica receives state via client.requestSnapshot', async () => {
    const seqCtx = await createTestNode({ nodeId: 'seq-gossip-1', role: 'sequencer' });
    activeContexts.push(seqCtx);
    seqCtx.node.start();

    // Add state to sequencer
    const seqService = seqCtx.node.getSequencer();
    seqService.applyReplicatedReceipt(
      mockReceipt(0n, 'l2-00000000'),
      mockAuditEvent(0n, 'l2-00000000'),
      undefined,
      '100',
      '200',
      '1',
    );

    // Fetch snapshot via client
    const state = await seqCtx.client.requestSnapshot();
    expect(state.receipts.length).toBe(1);
    expect(state.receipts[0].receiptId).toBe('l2-00000000');
  });

  test('gossip relay round-trip: client sends, server receives', async () => {
    const ctx = await createTestNode({ nodeId: 'gossip-rt-1' });
    activeContexts.push(ctx);

    const receivedMessages: GossipMessage[] = [];
    const peerNet = new L2PeerNetwork({ nodeId: 'gossip-rt-1' });
    peerNet.on((msg) => { receivedMessages.push(msg); });
    ctx.server.setPeerNetwork(peerNet);
    ctx.node.start();

    const msg = makeGossipMessage('proof:accepted', 'remote-sender', {
      receipt: mockReceipt(0n),
      auditEvent: mockAuditEvent(0n),
      currentRegistryRoot: INITIAL_REG_ROOT.toString(),
      currentLifecycleRoot: INITIAL_LC_ROOT.toString(),
      currentWalletCount: '0',
    });

    const result = await ctx.client.gossipRelay(msg);
    expect(result.accepted).toBe(true);
    expect(receivedMessages.length).toBe(1);
    expect(receivedMessages[0].messageId).toBe(msg.messageId);
  });

  test('gossip deduplication across client calls', async () => {
    const ctx = await createTestNode({ nodeId: 'gossip-dedup' });
    activeContexts.push(ctx);

    let handlerCallCount = 0;
    const peerNet = new L2PeerNetwork({ nodeId: 'gossip-dedup' });
    peerNet.on(() => { handlerCallCount++; });
    ctx.server.setPeerNetwork(peerNet);
    ctx.node.start();

    const msg = makeGossipMessage('peer:announce', 'remote', {
      peer: { peerId: 'remote', url: '', role: 'replica' as const, status: 'connected' as const, lastSeen: 0, latestSequenceNumber: 0n, latestBatchNumber: null },
      knownPeers: [],
    }, 'fixed-dedup-id');

    await ctx.client.gossipRelay(msg);
    await ctx.client.gossipRelay(msg);

    expect(handlerCallCount).toBe(1);
  });

  test('apply replicated receipt on replica via direct method', () => {
    const store = new InMemoryStore();
    const replica = new L2Node(
      { batchIntervalMs: 999_999, role: 'replica', nodeId: 'direct-replica' },
      store,
      INITIAL_REG_ROOT,
      INITIAL_LC_ROOT,
      Field(0),
    );

    const seq = replica.getSequencer();
    const receipt = mockReceipt(0n, 'l2-00000000');
    const audit = mockAuditEvent(0n, 'l2-00000000');

    seq.applyReplicatedReceipt(receipt, audit, undefined,
      INITIAL_REG_ROOT.toString(),
      INITIAL_LC_ROOT.toString(),
      '0');

    expect(seq.getReceipt('l2-00000000')).toBeDefined();
    expect(seq.getLatestSequenceNumber()).toBe(0n);
  });

  test('apply replicated batch on replica via direct method', () => {
    const store = new InMemoryStore();
    const replica = new L2Node(
      { batchIntervalMs: 999_999, role: 'replica', nodeId: 'batch-replica' },
      store,
      INITIAL_REG_ROOT,
      INITIAL_LC_ROOT,
      Field(0),
    );

    const seq = replica.getSequencer();

    // First receipt
    const r0 = mockReceipt(0n, 'l2-00000000');
    const a0 = mockAuditEvent(0n, 'l2-00000000');
    seq.applyReplicatedReceipt(r0, a0);

    // Then batch
    const block = mockBlock(0n, ['l2-00000000']);
    const batch = mockBatch(0n, 0n, ['l2-00000000']);
    seq.applyReplicatedBatch(
      batch, block,
      [{ ...r0, l1Status: 'batched', l2BlockNumber: 0n, l1BatchNumber: 0n }],
      [{ ...a0, l1Status: 'batched', l2BlockNumber: 0n, l1BatchNumber: 0n }],
    );

    expect(seq.getBlock(0n)).toBeDefined();
    expect(seq.getBatch(0n)).toBeDefined();
    expect(seq.getReceipt('l2-00000000')!.l1Status).toBe('batched');
  });

  test('full replication chain: receipt -> batch -> settlement', () => {
    const store = new InMemoryStore();
    const replica = new L2Node(
      { batchIntervalMs: 999_999, role: 'replica', nodeId: 'full-chain-replica' },
      store,
      INITIAL_REG_ROOT,
      INITIAL_LC_ROOT,
      Field(0),
    );
    const seq = replica.getSequencer();

    // 1. Receipt
    const r0 = mockReceipt(0n, 'l2-00000000');
    const a0 = mockAuditEvent(0n, 'l2-00000000');
    seq.applyReplicatedReceipt(r0, a0, undefined,
      INITIAL_REG_ROOT.toString(), INITIAL_LC_ROOT.toString(), '0');

    // 2. Batch
    const block = mockBlock(0n, ['l2-00000000']);
    const batch = mockBatch(0n, 0n, ['l2-00000000']);
    seq.applyReplicatedBatch(
      batch, block,
      [{ ...r0, l1Status: 'batched', l2BlockNumber: 0n, l1BatchNumber: 0n }],
      [{ ...a0, l1Status: 'batched', l2BlockNumber: 0n, l1BatchNumber: 0n }],
    );

    // 3. Settlement
    seq.applyReplicatedSettlement(0n, 'sim-l1-tx-001', INITIAL_REG_ROOT.toString(), INITIAL_LC_ROOT.toString(), '0');

    expect(seq.getBatch(0n)!.l1Status).toBe('settled');
    expect(seq.getBlock(0n)!.l1Status).toBe('settled');
    expect(seq.getReceipt('l2-00000000')!.l1Status).toBe('settled');
    expect(seq.getInFlightBatchNumber()).toBeNull();
  });

  test('multiple receipts replicated in order', () => {
    const store = new InMemoryStore();
    const replica = new L2Node(
      { batchIntervalMs: 999_999, role: 'replica' },
      store,
      INITIAL_REG_ROOT,
      INITIAL_LC_ROOT,
      Field(0),
    );
    const seq = replica.getSequencer();

    for (let i = 0; i < 5; i++) {
      seq.applyReplicatedReceipt(
        mockReceipt(BigInt(i)),
        mockAuditEvent(BigInt(i)),
      );
    }

    expect(seq.getAllReceipts().length).toBe(5);
    expect(seq.getLatestSequenceNumber()).toBe(4n);
    expect(seq.getAuditLog().events.length).toBe(5);
  });

  test('state digest comparison between sequencer and replica', async () => {
    // Create sequencer with state
    const seqCtx = await createTestNode({ nodeId: 'seq-digest', role: 'sequencer' });
    activeContexts.push(seqCtx);
    seqCtx.node.start();

    const seqService = seqCtx.node.getSequencer();
    seqService.applyReplicatedReceipt(
      mockReceipt(0n, 'l2-00000000'),
      mockAuditEvent(0n, 'l2-00000000'),
    );

    // Get digest from sequencer
    const digest = await seqCtx.client.getStateDigest();
    expect(digest.latestSequenceNumber).toBe(0n);

    // Create replica and apply the same state
    const store = new InMemoryStore();
    const replica = new L2Node(
      { batchIntervalMs: 999_999, role: 'replica' },
      store,
      INITIAL_REG_ROOT,
      INITIAL_LC_ROOT,
      Field(0),
    );
    const repSeq = replica.getSequencer();
    repSeq.applyReplicatedReceipt(
      mockReceipt(0n, 'l2-00000000'),
      mockAuditEvent(0n, 'l2-00000000'),
    );

    // Compare
    expect(repSeq.getLatestSequenceNumber()).toBe(digest.latestSequenceNumber);
  });

  test('batch failure gossip replicated correctly', () => {
    const store = new InMemoryStore();
    const replica = new L2Node(
      { batchIntervalMs: 999_999, role: 'replica' },
      store,
      INITIAL_REG_ROOT,
      INITIAL_LC_ROOT,
      Field(0),
    );
    const seq = replica.getSequencer();

    // Set up receipt and batch
    const r0 = mockReceipt(0n, 'l2-00000000');
    const a0 = mockAuditEvent(0n, 'l2-00000000');
    seq.applyReplicatedReceipt(r0, a0);

    const block = mockBlock(0n, ['l2-00000000']);
    const batch = mockBatch(0n, 0n, ['l2-00000000']);
    seq.applyReplicatedBatch(
      batch, block,
      [{ ...r0, l1Status: 'batched', l2BlockNumber: 0n, l1BatchNumber: 0n }],
      [{ ...a0, l1Status: 'batched', l2BlockNumber: 0n, l1BatchNumber: 0n }],
    );

    // Simulate batch failure
    seq.applyReplicatedBatchFailure(0n, 'Gas too low');

    expect(seq.getBatch(0n)!.l1Status).toBe('failed');
    expect(seq.getBatch(0n)!.failureReason).toBe('Gas too low');
    expect(seq.getBlock(0n)!.l1Status).toBe('failed');
    expect(seq.getReceipt('l2-00000000')!.l1Status).toBe('failed');
  });

  test('peer network connectToPeer works between two nodes', async () => {
    const seqCtx = await createTestNode({ nodeId: 'seq-connect', role: 'sequencer' });
    activeContexts.push(seqCtx);
    const seqPeerNet = new L2PeerNetwork({ nodeId: 'seq-connect', role: 'sequencer' });
    seqCtx.server.setPeerNetwork(seqPeerNet);
    seqCtx.node.start();

    // Create a second peer network and connect to seq
    const repPeerNet = new L2PeerNetwork({ nodeId: 'rep-connect', role: 'replica' });
    const peerInfo = await repPeerNet.connectToPeer(seqCtx.url);

    expect(peerInfo).toBeDefined();
    expect(peerInfo.status).toBe('connected');
    expect(repPeerNet.getConnectedPeers().length).toBe(1);

    repPeerNet.stop();
  });

  test('peer network exchangePeerList between two nodes', async () => {
    const seqCtx = await createTestNode({ nodeId: 'seq-exchange', role: 'sequencer' });
    activeContexts.push(seqCtx);
    const seqPeerNet = new L2PeerNetwork({ nodeId: 'seq-exchange', role: 'sequencer' });
    seqCtx.server.setPeerNetwork(seqPeerNet);
    seqCtx.node.start();

    const repPeerNet = new L2PeerNetwork({ nodeId: 'rep-exchange', role: 'replica' });
    const peerInfo = await repPeerNet.connectToPeer(seqCtx.url);
    const remotePeers = await repPeerNet.exchangePeerList(peerInfo.peerId);

    expect(Array.isArray(remotePeers)).toBe(true);
    // Sequencer has no peers itself, so list should be empty
    expect(remotePeers.length).toBe(0);

    repPeerNet.stop();
  });

  test('requestStateSync fetches full state from peer', async () => {
    const seqCtx = await createTestNode({ nodeId: 'seq-sync', role: 'sequencer' });
    activeContexts.push(seqCtx);
    seqCtx.node.start();

    // Add some state
    const seqService = seqCtx.node.getSequencer();
    seqService.applyReplicatedReceipt(
      mockReceipt(0n, 'l2-00000000'),
      mockAuditEvent(0n, 'l2-00000000'),
    );
    seqService.applyReplicatedReceipt(
      mockReceipt(1n, 'l2-00000001'),
      mockAuditEvent(1n, 'l2-00000001'),
    );

    const repPeerNet = new L2PeerNetwork({ nodeId: 'rep-sync', role: 'replica', adminToken: TEST_ADMIN_TOKEN });
    const peerInfo = await repPeerNet.connectToPeer(seqCtx.url);
    const state = await repPeerNet.requestStateSync(peerInfo.peerId);

    expect(state.receipts.length).toBe(2);
    expect(state.auditLog.length).toBe(2);
    expect(state.nextSequenceNumber).toBe(2n);

    repPeerNet.stop();
  });

  test('getRemoteDigest fetches digest from peer', async () => {
    const seqCtx = await createTestNode({ nodeId: 'seq-digest-2', role: 'sequencer' });
    activeContexts.push(seqCtx);
    seqCtx.node.start();

    const repPeerNet = new L2PeerNetwork({ nodeId: 'rep-digest-2', role: 'replica' });
    const peerInfo = await repPeerNet.connectToPeer(seqCtx.url);
    const digest = await repPeerNet.getRemoteDigest(peerInfo.peerId);

    expect(digest.latestSequenceNumber).toBe(-1n);
    expect(digest.registryRoot).toBe(INITIAL_REG_ROOT.toString());

    repPeerNet.stop();
  });

  test('requestStateSync throws for unknown peer', async () => {
    const net = new L2PeerNetwork({ nodeId: 'test' });
    await expect(net.requestStateSync('nonexistent-peer')).rejects.toThrow('Peer not connected');
  });

  test('getRemoteDigest throws for unknown peer', async () => {
    const net = new L2PeerNetwork({ nodeId: 'test' });
    await expect(net.getRemoteDigest('nonexistent-peer')).rejects.toThrow('Peer not connected');
  });

  test('exchangePeerList throws for unknown peer', async () => {
    const net = new L2PeerNetwork({ nodeId: 'test' });
    await expect(net.exchangePeerList('nonexistent-peer')).rejects.toThrow('Peer not connected');
  });
});

// ═══════════════════════════════════════════════════════════════
// 8. Edge Cases & Network Resilience
// ═══════════════════════════════════════════════════════════════

describe('Edge Cases & Network Resilience', () => {
  test('handleIncomingAndRelay returns true for new, false for dup', async () => {
    const net = new L2PeerNetwork({ nodeId: 'relay-test', gossipRelayEnabled: true });
    const msg = makeGossipMessage('peer:announce', 'sender', {
      peer: { peerId: 'sender', url: '', role: 'replica' as const, status: 'connected' as const, lastSeen: 0, latestSequenceNumber: 0n, latestBatchNumber: null },
      knownPeers: [],
    });

    const first = await net.handleIncomingAndRelay(msg, 'sender');
    expect(first).toBe(true);

    const second = await net.handleIncomingAndRelay(msg, 'sender');
    expect(second).toBe(false);
  });

  test('disconnectPeer marks peer as disconnected', async () => {
    const seqCtx = await createTestNode({ nodeId: 'seq-disconnect' });
    activeContexts.push(seqCtx);
    const seqPeerNet = new L2PeerNetwork({ nodeId: 'seq-disconnect' });
    seqCtx.server.setPeerNetwork(seqPeerNet);
    seqCtx.node.start();

    const net = new L2PeerNetwork({ nodeId: 'client-disconnect' });
    const peerInfo = await net.connectToPeer(seqCtx.url);

    expect(net.getConnectedPeers().length).toBe(1);

    net.disconnectPeer(peerInfo.peerId);
    expect(net.getConnectedPeers().length).toBe(0);
    // Peer still in getPeers() but disconnected
    const allPeers = net.getPeers();
    expect(allPeers.length).toBe(1);
    expect(allPeers[0].status).toBe('disconnected');

    net.stop();
  });

  test('disconnectAll clears all peers', async () => {
    const seqCtx = await createTestNode({ nodeId: 'seq-discall' });
    activeContexts.push(seqCtx);
    const seqPeerNet = new L2PeerNetwork({ nodeId: 'seq-discall' });
    seqCtx.server.setPeerNetwork(seqPeerNet);
    seqCtx.node.start();

    const net = new L2PeerNetwork({ nodeId: 'client-discall' });
    await net.connectToPeer(seqCtx.url);
    expect(net.getPeers().length).toBe(1);

    net.disconnectAll();
    expect(net.getPeers().length).toBe(0);
    expect(net.getConnectedPeers().length).toBe(0);

    net.stop();
  });

  test('connectToPeer returns existing peer if already connected', async () => {
    const seqCtx = await createTestNode({ nodeId: 'seq-reconn' });
    activeContexts.push(seqCtx);
    const seqPeerNet = new L2PeerNetwork({ nodeId: 'seq-reconn' });
    seqCtx.server.setPeerNetwork(seqPeerNet);
    seqCtx.node.start();

    const net = new L2PeerNetwork({ nodeId: 'client-reconn' });
    const p1 = await net.connectToPeer(seqCtx.url);
    const p2 = await net.connectToPeer(seqCtx.url);

    expect(p1.peerId).toBe(p2.peerId);
    expect(net.getConnectedPeers().length).toBe(1);

    net.stop();
  });

  test('multiple handlers receive same message', () => {
    const net = new L2PeerNetwork({ nodeId: 'multi-handler' });
    const calls1: string[] = [];
    const calls2: string[] = [];

    net.on((msg) => calls1.push(msg.messageId));
    net.on((msg) => calls2.push(msg.messageId));

    const msg = makeGossipMessage('peer:announce', 'x', {
      peer: { peerId: 'x', url: '', role: 'replica' as const, status: 'connected' as const, lastSeen: 0, latestSequenceNumber: 0n, latestBatchNumber: null },
      knownPeers: [],
    }, 'multi-msg');

    net.handleIncoming(msg);
    expect(calls1).toEqual(['multi-msg']);
    expect(calls2).toEqual(['multi-msg']);
  });

  test('handler error does not crash network', () => {
    const net = new L2PeerNetwork({ nodeId: 'error-handler' });
    let secondHandlerCalled = false;

    net.on(() => { throw new Error('handler crash'); });
    net.on(() => { secondHandlerCalled = true; });

    const msg = makeGossipMessage('peer:announce', 'x', {
      peer: { peerId: 'x', url: '', role: 'replica' as const, status: 'connected' as const, lastSeen: 0, latestSequenceNumber: 0n, latestBatchNumber: null },
      knownPeers: [],
    }, 'crash-msg');

    expect(() => net.handleIncoming(msg)).not.toThrow();
    expect(secondHandlerCalled).toBe(true);
  });

  test('state snapshot round-trip preserves bigint fields', async () => {
    const seqCtx = await createTestNode({ nodeId: 'seq-bigint' });
    activeContexts.push(seqCtx);
    seqCtx.node.start();

    // Apply a receipt with a specific sequence number
    seqCtx.node.getSequencer().applyReplicatedReceipt(
      mockReceipt(42n, 'l2-00000042'),
      mockAuditEvent(42n, 'l2-00000042'),
    );

    const state = await seqCtx.client.requestSnapshot();
    expect(state.nextSequenceNumber).toBe(43n);
    expect(typeof state.nextSequenceNumber).toBe('bigint');
    expect(state.receipts[0].sequenceNumber).toBe(42n);
  });

  test('export and restore state preserves replication data', () => {
    const store1 = new InMemoryStore();
    const node1 = new L2Node(
      { batchIntervalMs: 999_999, role: 'replica', nodeId: 'export-test' },
      store1,
      INITIAL_REG_ROOT,
      INITIAL_LC_ROOT,
      Field(0),
    );
    const seq1 = node1.getSequencer();

    // Add receipts
    seq1.applyReplicatedReceipt(mockReceipt(0n, 'l2-00000000'), mockAuditEvent(0n, 'l2-00000000'));
    seq1.applyReplicatedReceipt(mockReceipt(1n, 'l2-00000001'), mockAuditEvent(1n, 'l2-00000001'));

    // Add batch
    const block = mockBlock(0n, ['l2-00000000', 'l2-00000001']);
    const batch = mockBatch(0n, 0n, ['l2-00000000', 'l2-00000001']);
    seq1.applyReplicatedBatch(batch, block,
      [
        { ...mockReceipt(0n, 'l2-00000000'), l1Status: 'batched', l2BlockNumber: 0n, l1BatchNumber: 0n },
        { ...mockReceipt(1n, 'l2-00000001'), l1Status: 'batched', l2BlockNumber: 0n, l1BatchNumber: 0n },
      ],
      [
        { ...mockAuditEvent(0n, 'l2-00000000'), l1Status: 'batched', l2BlockNumber: 0n, l1BatchNumber: 0n },
        { ...mockAuditEvent(1n, 'l2-00000001'), l1Status: 'batched', l2BlockNumber: 0n, l1BatchNumber: 0n },
      ],
    );

    // Export
    const exported = seq1.exportState();

    // Restore into a new node
    const store2 = new InMemoryStore();
    const node2 = new L2Node(
      { batchIntervalMs: 999_999, role: 'replica' },
      store2,
      INITIAL_REG_ROOT,
      INITIAL_LC_ROOT,
      Field(0),
    );
    const seq2 = node2.getSequencer();
    seq2.restoreState(exported);

    expect(seq2.getAllReceipts().length).toBe(2);
    expect(seq2.getAllBatches().length).toBe(1);
    expect(seq2.getBlock(0n)).toBeDefined();
    expect(seq2.getLatestSequenceNumber()).toBe(1n);
    expect(seq2.getAuditLog().events.length).toBe(2);
  });
});
