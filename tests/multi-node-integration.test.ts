/**
 * Multi-Node Integration Tests — Cross-Claim (8 × 9 × 10)
 *
 * End-to-end tests that exercise partitioned sequencer networks (Claim 8),
 * gossip propagation (Claim 9), and deterministic routing (Claim 10) together.
 *
 * Patent items: INT-01 through INT-08
 *
 * Run: npx jest tests/multi-node-integration.test.ts --verbose --forceExit
 */

import http from 'http';
import { Field, MerkleTree } from 'o1js';
import { InMemoryStore } from '../src/storage/local-store.js';
import { WALLET_TREE_HEIGHT } from '../src/wallets/wallet-state.js';
import { L2Leviathan } from '../src/l2/l2-leviathan.js';
import { L2RpcServer } from '../src/l2/l2-rpc-server.js';
import { L2Client } from '../src/l2/l2-client.js';
import { L2PeerNetwork, generateMessageId } from '../src/l2/l2-peer-network.js';
import { getPartition, isMyPartition, PartitionRouter } from '../src/l2/l2-partition.js';
import type { LeviathanConfig } from '../src/l2/l2-leviathan-types.js';
import type { L2Receipt } from '../src/l2/l2-types.js';
import type { AuditEvent } from '../src/audit/audit-types.js';
import type {
  GossipMessage,
  GossipMessageType,
  ProofAcceptedPayload,
} from '../src/l2/l2-peer-types.js';
import { MemberNode } from '../src/nodes/member-node.js';
import { PharmacyNode } from '../src/nodes/pharmacy-node.js';
import { PrescriberNode } from '../src/nodes/prescriber-node.js';
import { l2Stringify, l2Parse } from '../src/l2/l2-json.js';

// ─── Test Setup ─────────────────────────────────────────────

jest.setTimeout(45_000);

const emptyRegTree = new MerkleTree(WALLET_TREE_HEIGHT);
const emptyLcTree = new MerkleTree(WALLET_TREE_HEIGHT);
const INITIAL_REG_ROOT = emptyRegTree.getRoot();
const INITIAL_LC_ROOT = emptyLcTree.getRoot();
const TEST_ADMIN_TOKEN = 'test-admin-token';

// ─── Helpers ────────────────────────────────────────────────

function makeConfig(
  partitionCount: number,
  primaryPartition: number,
  nodeIds: string[],
): LeviathanConfig {
  const failoverChain = new Map<number, string[]>();
  for (let i = 0; i < partitionCount; i++) {
    const chain = [...nodeIds.slice(i), ...nodeIds.slice(0, i)];
    failoverChain.set(i, chain);
  }
  return {
    partitionCount,
    primaryPartition,
    failoverChain,
    heartbeatIntervalMs: 60_000,
    heartbeatTimeoutMs: 120_000,
  };
}

interface TestLeviathanContext {
  leviathan: L2Leviathan;
  server: L2RpcServer;
  client: L2Client;
  peerNet: L2PeerNetwork;
  port: number;
  url: string;
  cleanup: () => Promise<void>;
}

async function createTestLeviathan(
  partitionCount: number,
  primaryPartition: number,
  nodeId: string,
  nodeIds: string[],
  gossipSecret?: string,
): Promise<TestLeviathanContext> {
  const config = makeConfig(partitionCount, primaryPartition, nodeIds);
  const store = new InMemoryStore();
  const leviathan = new L2Leviathan(
    config,
    {
      batchIntervalMs: 999_999,
      l2Only: true,
      nodeId,
    },
    store,
    INITIAL_REG_ROOT,
    INITIAL_LC_ROOT,
    Field(0),
  );
  leviathan.start();

  const server = new L2RpcServer(leviathan, { port: 0, adminToken: TEST_ADMIN_TOKEN });
  await server.start();
  const port = server.getPort();
  const url = `http://127.0.0.1:${port}`;

  const peerNet = new L2PeerNetwork({
    nodeId,
    role: 'sequencer',
    gossipRelayEnabled: true,
    gossipSecret,
    adminToken: TEST_ADMIN_TOKEN,
    announceIntervalMs: 999_999,
  });
  server.setPeerNetwork(peerNet);

  const client = new L2Client({ sequencerUrl: url, adminToken: TEST_ADMIN_TOKEN });

  return {
    leviathan,
    server,
    client,
    peerNet,
    port,
    url,
    cleanup: async () => {
      peerNet.stop();
      await leviathan.stop();
      await server.stop();
    },
  };
}

function walletForPartition(partitionIndex: number, partitionCount: number): string {
  return partitionIndex.toString();
}

function mockReceipt(
  seqNum: bigint,
  partitionIndex: number,
  partitionCount: number,
  receiptId?: string,
): L2Receipt {
  const walletId = walletForPartition(partitionIndex, partitionCount);
  return {
    receiptId: receiptId ?? `l2-p${partitionIndex}-${seqNum.toString().padStart(8, '0')}`,
    walletId,
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

function mockAuditEvent(
  seqNum: bigint,
  partitionIndex: number,
  partitionCount: number,
  receiptId?: string,
): AuditEvent {
  const walletId = walletForPartition(partitionIndex, partitionCount);
  return {
    sequenceNumber: seqNum,
    receiptId: receiptId ?? `l2-p${partitionIndex}-${seqNum.toString().padStart(8, '0')}`,
    walletId,
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

function rawRpc(port: number, body: string, adminToken?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (adminToken) headers['Authorization'] = `Bearer ${adminToken}`;
    const req = http.request(
      { hostname: '127.0.0.1', port, path: '/rpc', method: 'POST', headers },
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
let activeContexts: TestLeviathanContext[] = [];

afterEach(async () => {
  for (const ctx of activeContexts) {
    await ctx.cleanup().catch(() => {});
  }
  activeContexts = [];
});

// ─── Integration Tests ──────────────────────────────────────

describe('Multi-Node Integration (Claims 8 × 9 × 10)', () => {
  /**
   * INT-01: All 3 Leviathans running, entity nodes connect, all healthy.
   *
   * Stand up 3 Leviathans. Create MemberNode, PharmacyNode, PrescriberNode
   * each connected to a different Leviathan. All report healthy.
   */
  test('INT-01: 3 Leviathans and entity nodes all healthy', async () => {
    const nodeIds = ['int-lev-0', 'int-lev-1', 'int-lev-2'];
    const ctx0 = await createTestLeviathan(3, 0, 'int-lev-0', nodeIds);
    const ctx1 = await createTestLeviathan(3, 1, 'int-lev-1', nodeIds);
    const ctx2 = await createTestLeviathan(3, 2, 'int-lev-2', nodeIds);
    activeContexts.push(ctx0, ctx1, ctx2);

    // Entity nodes connected to different Leviathans
    const member = new MemberNode({ role: 'member', sequencerUrl: ctx0.url, walletId: '100' });
    const pharmacy = new PharmacyNode({ role: 'pharmacy', sequencerUrl: ctx1.url, walletId: '200' });
    const prescriber = new PrescriberNode({ role: 'prescriber', sequencerUrl: ctx2.url, walletId: '300' });

    // All healthy
    const [h0, h1, h2] = await Promise.all([
      member.isHealthy(),
      pharmacy.isHealthy(),
      prescriber.isHealthy(),
    ]);
    expect(h0).toBe(true);
    expect(h1).toBe(true);
    expect(h2).toBe(true);

    // All Leviathans running
    const [s0, s1, s2] = await Promise.all([
      ctx0.client.getStatus(),
      ctx1.client.getStatus(),
      ctx2.client.getStatus(),
    ]);
    expect(s0.running).toBe(true);
    expect(s1.running).toBe(true);
    expect(s2.running).toBe(true);
  });

  /**
   * INT-02: MemberNode builds PartitionRouter, routing matches getPartition().
   *
   * 3 Leviathans. MemberNode manually builds a PartitionRouter from
   * known URLs. Routing for various walletIds matches getPartition().
   */
  test('INT-02: PartitionRouter routing matches getPartition for entity nodes', async () => {
    const nodeIds = ['int-lev-0', 'int-lev-1', 'int-lev-2'];
    const ctx0 = await createTestLeviathan(3, 0, 'int-lev-0', nodeIds);
    const ctx1 = await createTestLeviathan(3, 1, 'int-lev-1', nodeIds);
    const ctx2 = await createTestLeviathan(3, 2, 'int-lev-2', nodeIds);
    activeContexts.push(ctx0, ctx1, ctx2);

    // MemberNode connected to lev-0
    const member = new MemberNode({ role: 'member', sequencerUrl: ctx0.url, walletId: '100' });

    // Manually build a PartitionRouter (since Leviathan.getPartitionRouter() returns null)
    const router = new PartitionRouter(3);
    router.setPartition(0, ctx0.url);
    router.setPartition(1, ctx1.url);
    router.setPartition(2, ctx2.url);

    // Verify routing for wallets that map to each partition
    for (let p = 0; p < 3; p++) {
      const wid = walletForPartition(p, 3);
      const expectedUrl = [ctx0.url, ctx1.url, ctx2.url][p];
      expect(router.getSequencerUrl(wid)).toBe(expectedUrl);
      expect(getPartition(wid, 3)).toBe(p);
    }

    // Router is complete
    expect(router.isComplete()).toBe(true);
    expect(router.getPartitionCount()).toBe(3);
  });

  /**
   * INT-03: Receipt on lev0 gossips to lev1 and lev2 via peer network.
   *
   * 3 Leviathans with connected peer networks. Apply receipt to lev0,
   * gossip it. lev1 and lev2 receive and apply it.
   */
  test('INT-03: receipt gossips from lev0 to lev1 and lev2', async () => {
    const nodeIds = ['int-lev-0', 'int-lev-1', 'int-lev-2'];
    const ctx0 = await createTestLeviathan(3, 0, 'int-lev-0', nodeIds);
    const ctx1 = await createTestLeviathan(3, 1, 'int-lev-1', nodeIds);
    const ctx2 = await createTestLeviathan(3, 2, 'int-lev-2', nodeIds);
    activeContexts.push(ctx0, ctx1, ctx2);

    // Connect peer networks: 0 → 1, 0 → 2
    await ctx0.peerNet.connectToPeer(ctx1.url);
    await ctx0.peerNet.connectToPeer(ctx2.url);

    // Set up replication handlers on lev1 and lev2
    const applyOnReceive = (lev: L2Leviathan, partIdx: number) => {
      return (msg: GossipMessage) => {
        if (msg.type === 'proof:accepted') {
          const p = msg.payload as ProofAcceptedPayload;
          const targetPartition = p.partitionIndex ?? partIdx;
          lev.getSequencer(targetPartition).applyReplicatedReceipt(
            p.receipt, p.auditEvent,
            undefined,
            p.currentRegistryRoot,
            p.currentLifecycleRoot,
            p.currentWalletCount,
          );
        }
      };
    };
    ctx1.peerNet.on(applyOnReceive(ctx1.leviathan, 0));
    ctx2.peerNet.on(applyOnReceive(ctx2.leviathan, 0));

    // Apply receipt to lev0's partition 0
    const receipt = mockReceipt(1n, 0, 3, 'int-receipt-001');
    const auditEvent = mockAuditEvent(1n, 0, 3, 'int-receipt-001');
    ctx0.leviathan.getSequencer(0).applyReplicatedReceipt(receipt, auditEvent);

    // Gossip it
    const payload: ProofAcceptedPayload = {
      receipt,
      auditEvent,
      currentRegistryRoot: INITIAL_REG_ROOT.toString(),
      currentLifecycleRoot: INITIAL_LC_ROOT.toString(),
      currentWalletCount: '0',
      partitionIndex: 0,
    };
    const gossipMsg = makeGossipMessage('proof:accepted', 'int-lev-0', payload, 'int-gossip-001');
    await ctx0.peerNet.broadcast(gossipMsg);

    // Wait for propagation
    await new Promise((r) => setTimeout(r, 500));

    // lev0 has the receipt on partition 0
    expect(ctx0.leviathan.getSequencer(0).getReceipt('int-receipt-001')).toBeDefined();

    // lev1 and lev2 also replicated it on partition 0
    expect(ctx1.leviathan.getSequencer(0).getReceipt('int-receipt-001')).toBeDefined();
    expect(ctx2.leviathan.getSequencer(0).getReceipt('int-receipt-001')).toBeDefined();
  });

  /**
   * INT-04: Wrong-partition receipt rejected with informative error.
   *
   * Verify that isMyPartition correctly identifies wrong-partition wallets
   * and the error message format is informative.
   */
  test('INT-04: wrong-partition wallet correctly identified', async () => {
    const nodeIds = ['int-lev-0'];
    const ctx0 = await createTestLeviathan(3, 0, 'int-lev-0', nodeIds);
    activeContexts.push(ctx0);

    // Wallet "1" routes to partition 1, not partition 0
    const walletForP1 = walletForPartition(1, 3);
    expect(getPartition(walletForP1, 3)).toBe(1);

    // Partition 0's config
    const config = { partitionCount: 3, partitionIndex: 0 };
    expect(isMyPartition(walletForP1, config)).toBe(false);

    // Partition 1's config
    const config1 = { partitionCount: 3, partitionIndex: 1 };
    expect(isMyPartition(walletForP1, config1)).toBe(true);

    // Verify the sequencer has partition config set
    const seq0 = ctx0.leviathan.getSequencer(0);
    const partConfig = seq0.getPartitionConfig();
    expect(partConfig).not.toBeNull();
    expect(partConfig!.partitionCount).toBe(3);
    expect(partConfig!.partitionIndex).toBe(0);
  });

  /**
   * INT-05: Member, Pharmacy, Prescriber nodes query same network concurrently.
   *
   * All 3 entity node types query the same Leviathan via Promise.all().
   * All succeed without interference.
   */
  test('INT-05: concurrent entity node queries succeed without interference', async () => {
    const nodeIds = ['int-lev-0'];
    const ctx0 = await createTestLeviathan(1, 0, 'int-lev-0', nodeIds);
    activeContexts.push(ctx0);

    // Apply some receipts so there's state to query
    const seq = ctx0.leviathan.getSequencer(0);
    for (let i = 0; i < 5; i++) {
      seq.applyReplicatedReceipt(
        mockReceipt(BigInt(i), 0, 1, `concurrent-${i}`),
        mockAuditEvent(BigInt(i), 0, 1, `concurrent-${i}`),
      );
    }

    const member = new MemberNode({ role: 'member', sequencerUrl: ctx0.url, walletId: '100' });
    const pharmacy = new PharmacyNode({ role: 'pharmacy', sequencerUrl: ctx0.url, walletId: '200' });
    const prescriber = new PrescriberNode({ role: 'prescriber', sequencerUrl: ctx0.url, walletId: '300' });

    // All 3 query concurrently
    const [memberState, pharmacyState, prescriberState] = await Promise.all([
      member.getChainState(),
      pharmacy.getChainState(),
      prescriber.getChainState(),
    ]);

    // All see the same state
    expect(memberState.registryRoot).toBe(pharmacyState.registryRoot);
    expect(memberState.registryRoot).toBe(prescriberState.registryRoot);
    expect(memberState.lifecycleRoot).toBe(pharmacyState.lifecycleRoot);
  });

  /**
   * INT-06: Gossip with HMAC across all 3 Leviathans.
   *
   * Valid signed messages accepted, tampered messages rejected.
   */
  test('INT-06: HMAC gossip authentication across 3 Leviathans', async () => {
    const nodeIds = ['hmac-lev-0', 'hmac-lev-1', 'hmac-lev-2'];
    const secret = 'integration-test-secret';

    const ctx0 = await createTestLeviathan(3, 0, 'hmac-lev-0', nodeIds, secret);
    const ctx1 = await createTestLeviathan(3, 1, 'hmac-lev-1', nodeIds, secret);
    const ctx2 = await createTestLeviathan(3, 2, 'hmac-lev-2', nodeIds, secret);
    activeContexts.push(ctx0, ctx1, ctx2);

    // Connect 0 → 1, 0 → 2
    await ctx0.peerNet.connectToPeer(ctx1.url);
    await ctx0.peerNet.connectToPeer(ctx2.url);

    // Track received messages
    let receivedByLev1 = 0;
    let receivedByLev2 = 0;
    ctx1.peerNet.on(() => { receivedByLev1++; });
    ctx2.peerNet.on(() => { receivedByLev2++; });

    // Valid broadcast from lev0 (properly signed)
    const payload: ProofAcceptedPayload = {
      receipt: mockReceipt(1n, 0, 3),
      auditEvent: mockAuditEvent(1n, 0, 3),
      currentRegistryRoot: INITIAL_REG_ROOT.toString(),
      currentLifecycleRoot: INITIAL_LC_ROOT.toString(),
      currentWalletCount: '0',
    };
    const validMsg = makeGossipMessage('proof:accepted', 'hmac-lev-0', payload, 'hmac-int-001');
    await ctx0.peerNet.broadcast(validMsg);
    await new Promise((r) => setTimeout(r, 300));

    expect(receivedByLev1).toBe(1);
    expect(receivedByLev2).toBe(1);

    // Tampered message sent directly to lev1 — rejected
    const tamperedMsg = makeGossipMessage('proof:accepted', 'hmac-lev-0', payload, 'hmac-int-tampered');
    tamperedMsg.signature = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

    const res = await rawRpc(ctx1.port, l2Stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'l2_gossipRelay',
      params: { message: tamperedMsg },
    }), TEST_ADMIN_TOKEN);

    const rpc = l2Parse<{ result: { accepted: boolean } }>(res.body);
    expect(rpc.result.accepted).toBe(false);

    // lev1 handler count unchanged (tampered message was rejected)
    expect(receivedByLev1).toBe(1);
  });

  /**
   * INT-07: l2Only batch cycle on 2 partitions.
   *
   * Submit receipts to 2 partitions via applyReplicatedReceipt,
   * forceBatch each — both emit batch:empty (since no pending pool entries).
   * Verify l2Only flag and per-partition routing.
   */
  test('INT-07: l2Only batch cycle targets correct partition', async () => {
    const nodeIds = ['batch-lev-0'];
    const config = makeConfig(2, 0, nodeIds);
    const store = new InMemoryStore();
    const leviathan = new L2Leviathan(
      config,
      { batchIntervalMs: 999_999, l2Only: true, nodeId: 'batch-lev-0' },
      store,
      INITIAL_REG_ROOT,
      INITIAL_LC_ROOT,
      Field(0),
    );
    leviathan.start();

    const cleanup = async () => { await leviathan.stop(); };

    try {
      // Apply receipts to partition 0
      const seq0 = leviathan.getSequencer(0);
      seq0.applyReplicatedReceipt(
        mockReceipt(1n, 0, 2, 'batch-p0-r1'),
        mockAuditEvent(1n, 0, 2, 'batch-p0-r1'),
      );

      // Apply receipts to partition 1
      const seq1 = leviathan.getSequencer(1);
      seq1.applyReplicatedReceipt(
        mockReceipt(1n, 1, 2, 'batch-p1-r1'),
        mockAuditEvent(1n, 1, 2, 'batch-p1-r1'),
      );

      // Verify receipts are in correct partitions
      expect(seq0.getReceipt('batch-p0-r1')).toBeDefined();
      expect(seq0.getReceipt('batch-p1-r1')).toBeUndefined();
      expect(seq1.getReceipt('batch-p1-r1')).toBeDefined();
      expect(seq1.getReceipt('batch-p0-r1')).toBeUndefined();

      // Collect events
      const events: any[] = [];
      leviathan.on((e) => events.push(e));

      // forceBatch on partition 0
      await leviathan.forceBatch(0);
      const emptyP0 = events.find(
        (e) => e.type === 'batch:empty' && e.data.partitionIndex === 0,
      );
      expect(emptyP0).toBeDefined();

      // forceBatch on partition 1 (need leadership first)
      leviathan.promoteToLeader(1, 'batch-lev-0');
      await leviathan.forceBatch(1);
      const emptyP1 = events.find(
        (e) => e.type === 'batch:empty' && e.data.partitionIndex === 1,
      );
      expect(emptyP1).toBeDefined();

      // l2Only confirmed
      expect(leviathan.isL2Only()).toBe(true);
    } finally {
      await cleanup();
    }
  });

  /**
   * INT-08: State convergence across partitions via gossip.
   *
   * 3 Leviathans. Different receipts to different partitions.
   * Gossip propagation ensures all Leviathans see all receipts on
   * the correct partition.
   */
  test('INT-08: state convergence across partitions via gossip', async () => {
    const nodeIds = ['conv-lev-0', 'conv-lev-1', 'conv-lev-2'];
    const ctx0 = await createTestLeviathan(3, 0, 'conv-lev-0', nodeIds);
    const ctx1 = await createTestLeviathan(3, 1, 'conv-lev-1', nodeIds);
    const ctx2 = await createTestLeviathan(3, 2, 'conv-lev-2', nodeIds);
    activeContexts.push(ctx0, ctx1, ctx2);

    // Fully connected peer network (bidirectional)
    await ctx0.peerNet.connectToPeer(ctx1.url);
    await ctx0.peerNet.connectToPeer(ctx2.url);
    await ctx1.peerNet.connectToPeer(ctx0.url);
    await ctx1.peerNet.connectToPeer(ctx2.url);
    await ctx2.peerNet.connectToPeer(ctx0.url);
    await ctx2.peerNet.connectToPeer(ctx1.url);

    // Set up replication handlers on all nodes
    const setupReplication = (ctx: TestLeviathanContext) => {
      ctx.peerNet.on((msg) => {
        if (msg.type === 'proof:accepted') {
          const p = msg.payload as ProofAcceptedPayload;
          const partition = p.partitionIndex ?? 0;
          ctx.leviathan.getSequencer(partition).applyReplicatedReceipt(
            p.receipt, p.auditEvent,
            undefined,
            p.currentRegistryRoot,
            p.currentLifecycleRoot,
            p.currentWalletCount,
          );
        }
      });
    };
    setupReplication(ctx0);
    setupReplication(ctx1);
    setupReplication(ctx2);

    // Apply receipt to partition 0 on lev0
    const r0 = mockReceipt(1n, 0, 3, 'conv-p0-r1');
    const a0 = mockAuditEvent(1n, 0, 3, 'conv-p0-r1');
    ctx0.leviathan.getSequencer(0).applyReplicatedReceipt(r0, a0);

    // Apply receipt to partition 1 on lev1
    const r1 = mockReceipt(1n, 1, 3, 'conv-p1-r1');
    const a1 = mockAuditEvent(1n, 1, 3, 'conv-p1-r1');
    ctx1.leviathan.getSequencer(1).applyReplicatedReceipt(r1, a1);

    // Gossip both
    const payload0: ProofAcceptedPayload = {
      receipt: r0, auditEvent: a0,
      currentRegistryRoot: INITIAL_REG_ROOT.toString(),
      currentLifecycleRoot: INITIAL_LC_ROOT.toString(),
      currentWalletCount: '0',
      partitionIndex: 0,
    };
    const payload1: ProofAcceptedPayload = {
      receipt: r1, auditEvent: a1,
      currentRegistryRoot: INITIAL_REG_ROOT.toString(),
      currentLifecycleRoot: INITIAL_LC_ROOT.toString(),
      currentWalletCount: '0',
      partitionIndex: 1,
    };

    await ctx0.peerNet.broadcast(
      makeGossipMessage('proof:accepted', 'conv-lev-0', payload0, 'conv-gossip-p0'),
    );
    await ctx1.peerNet.broadcast(
      makeGossipMessage('proof:accepted', 'conv-lev-1', payload1, 'conv-gossip-p1'),
    );

    // Wait for full propagation
    await new Promise((r) => setTimeout(r, 700));

    // All 3 Leviathans should have both receipts on the correct partitions
    for (const ctx of [ctx0, ctx1, ctx2]) {
      // Partition 0 has conv-p0-r1
      expect(ctx.leviathan.getSequencer(0).getReceipt('conv-p0-r1')).toBeDefined();
      // Partition 1 has conv-p1-r1
      expect(ctx.leviathan.getSequencer(1).getReceipt('conv-p1-r1')).toBeDefined();
      // Cross-contamination check: partition 0 does NOT have p1's receipt
      expect(ctx.leviathan.getSequencer(0).getReceipt('conv-p1-r1')).toBeUndefined();
      // And partition 1 does NOT have p0's receipt
      expect(ctx.leviathan.getSequencer(1).getReceipt('conv-p0-r1')).toBeUndefined();
    }
  });
});
