/**
 * Leviathan Failover Tests — Claim 12 Patent Coverage
 *
 * Tests the multi-leader heartbeat failover mechanism:
 *   - Heartbeat broadcasting and receipt tracking (12-R02, R03, R12)
 *   - Automatic failover on leader timeout (12-R04, R05)
 *   - Promotion/demotion lifecycle (12-R06, R07, R10)
 *   - Conflict resolution between competing promotions (12-R08, R09)
 *   - Pre-failover replication preservation (12-R11)
 *   - Independent failover chain configuration (12-R01)
 */

import { Field, MerkleTree } from 'o1js';
import { InMemoryStore } from '../src/storage/local-store.js';
import { WALLET_TREE_HEIGHT } from '../src/wallets/wallet-state.js';
import { L2Leviathan } from '../src/l2/l2-leviathan.js';
import { generateMessageId } from '../src/l2/l2-peer-network.js';
import type { LeviathanConfig } from '../src/l2/l2-leviathan-types.js';
import type { LeaderHeartbeatPayload, LeaderPromotionPayload } from '../src/l2/l2-leviathan-types.js';
import type { GossipMessage } from '../src/l2/l2-peer-types.js';
import type { L2Receipt } from '../src/l2/l2-types.js';
import type { AuditEvent } from '../src/audit/audit-types.js';

// ─── Test Setup ─────────────────────────────────────────────

jest.setTimeout(30_000);

const emptyRegTree = new MerkleTree(WALLET_TREE_HEIGHT);
const emptyLcTree = new MerkleTree(WALLET_TREE_HEIGHT);
const INITIAL_REG_ROOT = emptyRegTree.getRoot();
const INITIAL_LC_ROOT = emptyLcTree.getRoot();

// ─── Helpers ────────────────────────────────────────────────

/** Create a LeviathanConfig with round-robin failover chain and configurable heartbeat */
function makeConfig(
  partitionCount: number,
  primaryPartition: number,
  nodeIds: string[],
  heartbeatIntervalMs = 5_000,
  heartbeatTimeoutMs = 15_000,
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
    heartbeatIntervalMs,
    heartbeatTimeoutMs,
  };
}

/** Create a leviathan with sensible test defaults */
function createLeviathan(
  config: LeviathanConfig,
  opts?: Partial<{
    nodeId: string;
    batchIntervalMs: number;
    l2Only: boolean;
  }>,
): L2Leviathan {
  const store = new InMemoryStore();
  return new L2Leviathan(
    config,
    {
      batchIntervalMs: opts?.batchIntervalMs ?? 999_999,
      l2Only: opts?.l2Only ?? true,
      nodeId: opts?.nodeId,
    },
    store,
    INITIAL_REG_ROOT,
    INITIAL_LC_ROOT,
    Field(0),
  );
}

/** Return a walletId string that maps to a specific partition */
function walletForPartition(partitionIndex: number, partitionCount: number): string {
  return partitionIndex.toString();
}

/** Create a mock L2Receipt for a given partition */
function mockReceipt(
  seqNum: bigint,
  partitionIndex: number,
  partitionCount: number,
): L2Receipt {
  const walletId = walletForPartition(partitionIndex, partitionCount);
  return {
    receiptId: `l2-p${partitionIndex}-${seqNum.toString().padStart(8, '0')}`,
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

/** Create a mock AuditEvent */
function mockAuditEvent(
  seqNum: bigint,
  partitionIndex: number,
  partitionCount: number,
): AuditEvent {
  const walletId = walletForPartition(partitionIndex, partitionCount);
  return {
    sequenceNumber: seqNum,
    receiptId: `l2-p${partitionIndex}-${seqNum.toString().padStart(8, '0')}`,
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

/** Inject receipts into a partition sequencer via replication */
function injectReceipts(
  lev: L2Leviathan,
  partitionIndex: number,
  partitionCount: number,
  count: number,
  startSeq: bigint = 1n,
): L2Receipt[] {
  const seq = lev.getSequencer(partitionIndex);
  const receipts: L2Receipt[] = [];
  for (let i = 0; i < count; i++) {
    const seqNum = startSeq + BigInt(i);
    const receipt = mockReceipt(seqNum, partitionIndex, partitionCount);
    const auditEvent = mockAuditEvent(seqNum, partitionIndex, partitionCount);
    seq.applyReplicatedReceipt(
      receipt,
      auditEvent,
      undefined,
      INITIAL_REG_ROOT.toString(),
      INITIAL_LC_ROOT.toString(),
      '0',
    );
    receipts.push(receipt);
  }
  return receipts;
}

// ─── Mock Peer Network ──────────────────────────────────────

/**
 * Lightweight mock for L2PeerNetwork — captures broadcasts and allows
 * delivering messages as if received from the network.
 */
class MockPeerNetwork {
  broadcasts: GossipMessage[] = [];
  private handlers: Array<(msg: GossipMessage) => void> = [];

  async broadcast(msg: GossipMessage): Promise<void> {
    this.broadcasts.push(msg);
  }

  on(_event: string, handler: (msg: GossipMessage) => void): void {
    this.handlers.push(handler);
  }

  off(_event: string, handler: (msg: GossipMessage) => void): void {
    this.handlers = this.handlers.filter((h) => h !== handler);
  }

  start(): void {}
  stop(): void {}

  /** Simulate receiving a gossip message from the network */
  deliver(msg: GossipMessage): void {
    for (const handler of this.handlers) {
      handler(msg);
    }
  }

  /** Get count of broadcasts of a specific type */
  broadcastsOfType(type: string): GossipMessage[] {
    return this.broadcasts.filter((b) => b.type === type);
  }
}

/**
 * GossipRouter — coordinates gossip delivery between multiple leviathan nodes.
 *
 * When a node broadcasts, the router delivers to all OTHER alive nodes.
 * kill(nodeId) stops that node's broadcasts from being delivered.
 */
class GossipRouter {
  private nodes = new Map<string, { lev: L2Leviathan; mock: MockPeerNetwork }>();
  private alive = new Set<string>();

  register(nodeId: string, lev: L2Leviathan, mock: MockPeerNetwork): void {
    this.nodes.set(nodeId, { lev, mock });
    this.alive.add(nodeId);
  }

  /** Forward all pending broadcasts to other alive nodes */
  tick(): void {
    for (const [senderId, { mock }] of this.nodes) {
      if (!this.alive.has(senderId)) continue;
      const pending = [...mock.broadcasts];
      mock.broadcasts.length = 0;
      for (const msg of pending) {
        for (const [receiverId, receiver] of this.nodes) {
          if (receiverId === senderId) continue;
          if (!this.alive.has(receiverId)) continue;
          // Deliver via handleGossip (private — call through the receiver's mock won't work
          // since handleGossip is registered on the real peerNetwork, not our mock)
          // Instead, call handleGossip directly on the leviathan
          (receiver.lev as any).handleGossip(msg);
        }
      }
    }
  }

  /** Stop delivering this node's heartbeats (simulates node death) */
  kill(nodeId: string): void {
    this.alive.delete(nodeId);
  }

  /** Resume delivering this node's heartbeats */
  revive(nodeId: string): void {
    this.alive.add(nodeId);
  }

  /** Run heartbeat for all alive nodes and deliver */
  broadcastAllHeartbeats(): void {
    for (const [nodeId, { lev }] of this.nodes) {
      if (!this.alive.has(nodeId)) continue;
      (lev as any).broadcastHeartbeat();
    }
    this.tick();
  }
}

/** Build a valid leader:heartbeat GossipMessage */
function buildHeartbeatMsg(
  nodeId: string,
  partitions: number[],
  partitionSequences: Record<number, string> = {},
): GossipMessage {
  const now = Date.now();
  const payload: LeaderHeartbeatPayload = {
    nodeId,
    partitions,
    partitionSequences,
    timestamp: now,
  };
  return {
    messageId: generateMessageId('leader:heartbeat', nodeId, now, 'hb'),
    type: 'leader:heartbeat',
    senderId: nodeId,
    timestamp: now,
    payload,
  };
}

/** Build a valid leader:promotion GossipMessage */
function buildPromotionMsg(
  newLeaderId: string,
  partitionIndex: number,
  previousLeaderId: string,
  reason: 'heartbeat_timeout' | 'manual' | 'rejoin' = 'heartbeat_timeout',
): GossipMessage {
  const now = Date.now();
  const payload: LeaderPromotionPayload = {
    newLeaderId,
    partitionIndex,
    previousLeaderId,
    reason,
    timestamp: now,
  };
  return {
    messageId: generateMessageId('leader:promotion', newLeaderId, now, `p${partitionIndex}`),
    type: 'leader:promotion',
    senderId: newLeaderId,
    timestamp: now,
    payload,
  };
}

/** Small delay helper */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Unit Tests ─────────────────────────────────────────────

describe('Leviathan Failover — Unit Tests', () => {
  // 12-R01: Independent failover chains
  test('12-R01: spins up 3 leviathans with independent failover chains', () => {
    const nodeIds = ['lev-0', 'lev-1', 'lev-2'];

    const lev0 = createLeviathan(
      makeConfig(3, 0, nodeIds),
      { nodeId: 'lev-0' },
    );
    const lev1 = createLeviathan(
      makeConfig(3, 1, nodeIds),
      { nodeId: 'lev-1' },
    );
    const lev2 = createLeviathan(
      makeConfig(3, 2, nodeIds),
      { nodeId: 'lev-2' },
    );

    // Each leviathan leads ONLY its primary partition
    expect(lev0.isLeaderFor(0)).toBe(true);
    expect(lev0.isLeaderFor(1)).toBe(false);
    expect(lev0.isLeaderFor(2)).toBe(false);

    expect(lev1.isLeaderFor(0)).toBe(false);
    expect(lev1.isLeaderFor(1)).toBe(true);
    expect(lev1.isLeaderFor(2)).toBe(false);

    expect(lev2.isLeaderFor(0)).toBe(false);
    expect(lev2.isLeaderFor(1)).toBe(false);
    expect(lev2.isLeaderFor(2)).toBe(true);

    // Verify failover chains rotate correctly
    const config0 = lev0.getConfig();
    expect(config0.failoverChain.get(0)).toEqual(['lev-0', 'lev-1', 'lev-2']);
    expect(config0.failoverChain.get(1)).toEqual(['lev-1', 'lev-2', 'lev-0']);
    expect(config0.failoverChain.get(2)).toEqual(['lev-2', 'lev-0', 'lev-1']);

    // Verify active leader partitions
    expect(lev0.getActiveLeaderPartitions()).toEqual([0]);
    expect(lev1.getActiveLeaderPartitions()).toEqual([1]);
    expect(lev2.getActiveLeaderPartitions()).toEqual([2]);
  });

  // 12-R03: Heartbeat payload structure
  test('12-R03: heartbeat payload contains nodeId, partitions, partitionSequences, timestamp', () => {
    const lev = createLeviathan(
      makeConfig(3, 0, ['lev-test', 'lev-1', 'lev-2']),
      { nodeId: 'lev-test' },
    );

    // Inject mock peer network so broadcastHeartbeat doesn't early-return
    const mock = new MockPeerNetwork();
    (lev as any).peerNetwork = mock;

    // Trigger heartbeat
    (lev as any).broadcastHeartbeat();

    expect(mock.broadcasts.length).toBe(1);
    const msg = mock.broadcasts[0];

    expect(msg.type).toBe('leader:heartbeat');
    expect(msg.senderId).toBe('lev-test');

    const payload = msg.payload as LeaderHeartbeatPayload;
    expect(payload.nodeId).toBe('lev-test');
    expect(payload.partitions).toEqual([0]); // only leads partition 0
    expect(payload.partitionSequences).toHaveProperty('0');
    expect(typeof payload.timestamp).toBe('number');
    expect(payload.timestamp).toBeGreaterThan(Date.now() - 5000);
    expect(payload.timestamp).toBeLessThanOrEqual(Date.now());
  });

  // 12-R06: Promotion broadcasts gossip with correct metadata
  test('12-R06: promotion broadcasts leader:promotion gossip with correct metadata', () => {
    const lev = createLeviathan(
      makeConfig(3, 1, ['lev-0', 'lev-1', 'lev-2']),
      { nodeId: 'lev-1' },
    );

    const mock = new MockPeerNetwork();
    (lev as any).peerNetwork = mock;

    // Promote lev-1 for partition 0 (taking over from lev-0)
    lev.promoteToLeader(0, 'lev-0');

    const promotions = mock.broadcastsOfType('leader:promotion');
    expect(promotions.length).toBe(1);

    const msg = promotions[0];
    expect(msg.type).toBe('leader:promotion');
    expect(msg.senderId).toBe('lev-1');

    const payload = msg.payload as LeaderPromotionPayload;
    expect(payload.newLeaderId).toBe('lev-1');
    expect(payload.previousLeaderId).toBe('lev-0');
    expect(payload.partitionIndex).toBe(0);
    expect(payload.reason).toBe('heartbeat_timeout');
    expect(typeof payload.timestamp).toBe('number');
  });

  // 12-R07: Promoted node accepts proofs and batches for orphaned partition
  test('12-R07: promoted node accepts proofs and batches for orphaned partition', async () => {
    const lev = createLeviathan(
      makeConfig(3, 1, ['lev-0', 'lev-1', 'lev-2']),
      { nodeId: 'lev-1' },
    );
    lev.start();

    try {
      // Initially NOT leader for partition 0
      expect(lev.isLeaderFor(0)).toBe(false);

      // Promote for partition 0
      lev.promoteToLeader(0, 'lev-0');
      expect(lev.isLeaderFor(0)).toBe(true);

      // forceBatch on empty partition should emit batch:empty, not throw
      const events: any[] = [];
      lev.on((e) => events.push(e));
      const emptyResult = await lev.forceBatch(0);
      expect(emptyResult).toBeNull();
      expect(events.some((e) => e.type === 'batch:empty' && e.data?.partitionIndex === 0)).toBe(true);

      // After promotion, the sequencer for partition 0 is accessible and can
      // receive replicated state (simulating proof acceptance on the new leader)
      injectReceipts(lev, 0, 3, 3, 1n);
      const seq0 = lev.getSequencer(0);
      expect(seq0.getLatestSequenceNumber()).toBe(3n);
      expect(seq0.getReceipt('l2-p0-00000001')).toBeDefined();
      expect(seq0.getReceipt('l2-p0-00000002')).toBeDefined();
      expect(seq0.getReceipt('l2-p0-00000003')).toBeDefined();

      // Active leader partitions now includes both primary and promoted
      expect(lev.getActiveLeaderPartitions()).toEqual([0, 1]);

      // Status should show leadership over both partitions
      const status = lev.getStatus();
      expect(status.activeLeaderPartitions).toContain(0);
      expect(status.activeLeaderPartitions).toContain(1);
    } finally {
      await lev.stop();
    }
  });

  // 12-R08: Conflict resolution — higher-priority node in chain wins
  test('12-R08: conflict resolution — higher-priority node in chain wins', () => {
    const nodeIds = ['lev-0', 'lev-1', 'lev-2'];

    // Failover chain for partition 1: ['lev-1', 'lev-2', 'lev-0']
    // lev-2 is index 1 (higher priority), lev-0 is index 2 (lower priority)
    const lev0 = createLeviathan(
      makeConfig(3, 0, nodeIds),
      { nodeId: 'lev-0' },
    );
    const lev2 = createLeviathan(
      makeConfig(3, 2, nodeIds),
      { nodeId: 'lev-2' },
    );

    // Both promote for partition 1 (lev-1 died)
    lev0.promoteToLeader(1, 'lev-1');
    lev2.promoteToLeader(1, 'lev-1');

    expect(lev0.isLeaderFor(1)).toBe(true);
    expect(lev2.isLeaderFor(1)).toBe(true);

    // lev-0 receives lev-2's promotion gossip
    const promotionFromLev2 = buildPromotionMsg('lev-2', 1, 'lev-1');
    (lev0 as any).handleGossip(promotionFromLev2);

    // lev-0 should demote — lev-2 is index 1, lev-0 is index 2 in partition 1's chain
    expect(lev0.isLeaderFor(1)).toBe(false);

    // lev-2 receives lev-0's promotion gossip
    const promotionFromLev0 = buildPromotionMsg('lev-0', 1, 'lev-1');
    (lev2 as any).handleGossip(promotionFromLev0);

    // lev-2 should NOT demote — it has higher priority
    expect(lev2.isLeaderFor(1)).toBe(true);
  });

  // 12-R09: Self-demotion when higher-priority node reclaims partition
  test('12-R09: self-demotion when higher-priority node reclaims partition', () => {
    const nodeIds = ['lev-0', 'lev-1', 'lev-2'];

    // lev-2 promotes for partition 0 (lev-0 died)
    // Failover chain for partition 0: ['lev-0', 'lev-1', 'lev-2']
    const lev2 = createLeviathan(
      makeConfig(3, 2, nodeIds),
      { nodeId: 'lev-2' },
    );

    lev2.promoteToLeader(0, 'lev-0');
    expect(lev2.isLeaderFor(0)).toBe(true);

    // Track demotion events
    const events: any[] = [];
    lev2.on((e) => events.push(e));

    // lev-0 comes back and reclaims partition 0
    const promotionFromLev0 = buildPromotionMsg('lev-0', 0, 'lev-2');
    (lev2 as any).handleGossip(promotionFromLev0);

    // lev-2 should demote — lev-0 is index 0 (highest priority)
    expect(lev2.isLeaderFor(0)).toBe(false);

    // Verify leaderMap updated
    const leaderMap = lev2.getLeaderMap();
    expect(leaderMap.get(0)?.currentLeader).toBe('lev-0');

    // Verify demotion event emitted
    const demotionEvent = events.find(
      (e) => e.data?.action === 'leader_demotion' && e.data?.partitionIndex === 0,
    );
    expect(demotionEvent).toBeDefined();
    expect(demotionEvent.data.newLeader).toBe('lev-0');
  });

  // 12-R10: Batch timer starts on promotion, stops on demotion
  test('12-R10: batch timer starts on promotion, stops on demotion', async () => {
    const lev = createLeviathan(
      makeConfig(3, 0, ['lev-0', 'lev-1', 'lev-2']),
      { nodeId: 'lev-0' },
    );
    lev.start();

    try {
      const batchTimers = (lev as any).batchTimers as Map<number, any>;

      // Primary partition 0 should have a batch timer
      expect(batchTimers.has(0)).toBe(true);
      expect(batchTimers.has(1)).toBe(false);
      expect(batchTimers.has(2)).toBe(false);

      // Promote for partition 1 → batch timer should start
      lev.promoteToLeader(1, 'lev-1');
      expect(batchTimers.has(1)).toBe(true);

      // Demote from partition 1 → batch timer should stop
      lev.demoteFromLeader(1, 'lev-1');
      expect(batchTimers.has(1)).toBe(false);

      // Primary partition 0 timer should be unaffected
      expect(batchTimers.has(0)).toBe(true);
    } finally {
      await lev.stop();
    }
  });

  // 12-R12: lastHeartbeatAt updates on each heartbeat receipt
  test('12-R12: lastHeartbeatAt updates on each heartbeat receipt', async () => {
    const lev = createLeviathan(
      makeConfig(3, 1, ['lev-0', 'lev-1', 'lev-2']),
      { nodeId: 'lev-1' },
    );

    const leaderMap = (lev as any).leaderMap as Map<number, any>;

    // Record initial lastHeartbeatAt for partitions 0 and 2
    const initialHb0 = leaderMap.get(0)!.lastHeartbeatAt;
    const initialHb2 = leaderMap.get(2)!.lastHeartbeatAt;

    // Wait a bit so timestamps differ
    await sleep(15);

    // Deliver heartbeat from lev-0 for partition 0
    const hbMsg = buildHeartbeatMsg('lev-0', [0], { 0: '5' });
    (lev as any).handleGossip(hbMsg);

    // Partition 0 heartbeat should have updated
    const newHb0 = leaderMap.get(0)!.lastHeartbeatAt;
    expect(newHb0).toBeGreaterThan(initialHb0);
    expect(newHb0).toBeGreaterThanOrEqual(Date.now() - 100);
    expect(newHb0).toBeLessThanOrEqual(Date.now());

    // Partition 2 heartbeat should NOT have updated
    const newHb2 = leaderMap.get(2)!.lastHeartbeatAt;
    expect(newHb2).toBe(initialHb2);
  });
});

// ─── Integration Tests ──────────────────────────────────────

describe('Leviathan Failover — Integration Tests', () => {
  // 12-R02: Heartbeat broadcast at configured intervals
  test('12-R02: broadcasts leader:heartbeat at configured intervals', async () => {
    const lev = createLeviathan(
      makeConfig(3, 0, ['lev-0', 'lev-1', 'lev-2'], 100, 300),
      { nodeId: 'lev-0' },
    );

    const mock = new MockPeerNetwork();
    (lev as any).peerNetwork = mock;
    lev.start();

    try {
      // Wait for ~3.5 intervals (350ms at 100ms intervals)
      await sleep(350);

      // Should have broadcast at least 2 heartbeats (conservative)
      const heartbeats = mock.broadcastsOfType('leader:heartbeat');
      expect(heartbeats.length).toBeGreaterThanOrEqual(2);

      // All should be leader:heartbeat type
      for (const hb of heartbeats) {
        expect(hb.type).toBe('leader:heartbeat');
        expect(hb.senderId).toBe('lev-0');
        const payload = hb.payload as LeaderHeartbeatPayload;
        expect(payload.nodeId).toBe('lev-0');
        expect(payload.partitions).toContain(0);
      }
    } finally {
      await lev.stop();
    }
  });

  // 12-R04: Detects leader timeout and promotes backup
  test('12-R04: detects leader timeout and promotes backup after heartbeatTimeoutMs', async () => {
    const nodeIds = ['lev-0', 'lev-1', 'lev-2'];
    const HB_INTERVAL = 100;
    const HB_TIMEOUT = 300;

    const lev0 = createLeviathan(
      makeConfig(3, 0, nodeIds, HB_INTERVAL, HB_TIMEOUT),
      { nodeId: 'lev-0' },
    );
    const lev1 = createLeviathan(
      makeConfig(3, 1, nodeIds, HB_INTERVAL, HB_TIMEOUT),
      { nodeId: 'lev-1' },
    );
    const lev2 = createLeviathan(
      makeConfig(3, 2, nodeIds, HB_INTERVAL, HB_TIMEOUT),
      { nodeId: 'lev-2' },
    );

    const router = new GossipRouter();
    const mock0 = new MockPeerNetwork();
    const mock1 = new MockPeerNetwork();
    const mock2 = new MockPeerNetwork();
    (lev0 as any).peerNetwork = mock0;
    (lev1 as any).peerNetwork = mock1;
    (lev2 as any).peerNetwork = mock2;
    router.register('lev-0', lev0, mock0);
    router.register('lev-1', lev1, mock1);
    router.register('lev-2', lev2, mock2);

    // Start all nodes
    lev0.start();
    lev1.start();
    lev2.start();

    try {
      // Let heartbeats establish tracking (200ms = ~2 heartbeat cycles)
      for (let i = 0; i < 4; i++) {
        await sleep(50);
        router.broadcastAllHeartbeats();
      }

      // Verify all nodes see correct leaders initially
      expect(lev0.isLeaderFor(0)).toBe(true);
      expect(lev1.isLeaderFor(1)).toBe(true);
      expect(lev2.isLeaderFor(2)).toBe(true);

      // Kill lev-1 (stop delivering its heartbeats)
      router.kill('lev-1');

      // Wait for timeout to expire (> 300ms) while continuing heartbeats from live nodes
      // and running heartbeat monitors
      for (let i = 0; i < 5; i++) {
        await sleep(80);
        router.broadcastAllHeartbeats();
        // Manually trigger heartbeat check on alive nodes
        (lev0 as any).checkHeartbeats();
        (lev2 as any).checkHeartbeats();
      }

      // lev-2 should promote for partition 1 (lev-2 is index 1 in partition 1's chain)
      // Chain for partition 1: ['lev-1', 'lev-2', 'lev-0']
      expect(lev2.isLeaderFor(1)).toBe(true);
    } finally {
      await lev0.stop();
      await lev1.stop();
      await lev2.stop();
    }
  });

  // 12-R05: Follows failover chain priority — skips dead higher-priority candidates
  test('12-R05: follows failover chain priority — skips dead higher-priority candidates', () => {
    const nodeIds = ['lev-0', 'lev-1', 'lev-2'];

    // Create lev-2 (primary=2), test failover for partition 0
    // Chain for partition 0: ['lev-0', 'lev-1', 'lev-2']
    const lev2 = createLeviathan(
      makeConfig(3, 2, nodeIds, 100, 300),
      { nodeId: 'lev-2' },
    );

    const leaderMap = (lev2 as any).leaderMap as Map<number, any>;
    const now = Date.now();

    // Simulate: lev-0 (leader of partition 0) is dead — heartbeat timed out
    leaderMap.get(0)!.lastHeartbeatAt = now - 500;

    // Simulate: lev-1 is ALSO dead — no recent heartbeat on any partition
    // lev-1 leads partition 1, so make that heartbeat old too
    leaderMap.get(1)!.lastHeartbeatAt = now - 500;

    // Now check heartbeats — lev-2 should promote for partition 0
    // because both higher-priority candidates (lev-0, lev-1) are dead
    (lev2 as any).checkHeartbeats();

    expect(lev2.isLeaderFor(0)).toBe(true);

    // ── Second scenario: if lev-1 IS alive, lev-2 should NOT promote ──

    const lev2b = createLeviathan(
      makeConfig(3, 2, nodeIds, 100, 300),
      { nodeId: 'lev-2' },
    );

    const leaderMap2 = (lev2b as any).leaderMap as Map<number, any>;
    const now2 = Date.now();

    // lev-0 (leader of partition 0) is dead
    leaderMap2.get(0)!.lastHeartbeatAt = now2 - 500;

    // But lev-1 is ALIVE (leading partition 1 with recent heartbeat)
    leaderMap2.get(1)!.lastHeartbeatAt = now2;

    (lev2b as any).checkHeartbeats();

    // lev-2 should NOT promote — lev-1 is alive and has higher priority
    expect(lev2b.isLeaderFor(0)).toBe(false);
  });

  // 12-R11: Proofs replicated before failover are preserved on new leader
  test('12-R11: proofs replicated before failover are preserved on new leader', async () => {
    const nodeIds = ['lev-0', 'lev-1', 'lev-2'];
    const HB_INTERVAL = 100;
    const HB_TIMEOUT = 300;

    const lev1 = createLeviathan(
      makeConfig(3, 1, nodeIds, HB_INTERVAL, HB_TIMEOUT),
      { nodeId: 'lev-1' },
    );
    const lev2 = createLeviathan(
      makeConfig(3, 2, nodeIds, HB_INTERVAL, HB_TIMEOUT),
      { nodeId: 'lev-2' },
    );

    // Inject 3 receipts into lev-1's partition 1 sequencer
    const originalReceipts = injectReceipts(lev1, 1, 3, 3, 1n);
    expect(originalReceipts.length).toBe(3);

    // Replicate those same 3 receipts to lev-2's partition 1 sequencer
    // (simulating gossip replication that happened before failure)
    const seq2 = lev2.getSequencer(1);
    for (let i = 0; i < 3; i++) {
      const seqNum = 1n + BigInt(i);
      const receipt = mockReceipt(seqNum, 1, 3);
      const auditEvent = mockAuditEvent(seqNum, 1, 3);
      seq2.applyReplicatedReceipt(
        receipt,
        auditEvent,
        undefined,
        INITIAL_REG_ROOT.toString(),
        INITIAL_LC_ROOT.toString(),
        '0',
      );
    }

    // Verify lev-2 has 3 receipts on partition 1
    expect(seq2.getLatestSequenceNumber()).toBe(3n);

    // lev-1 dies, lev-2 promotes for partition 1
    lev2.promoteToLeader(1, 'lev-1');
    expect(lev2.isLeaderFor(1)).toBe(true);

    // Inject 2 MORE receipts into lev-2's partition 1 (now that it's leading)
    injectReceipts(lev2, 1, 3, 2, 4n);

    // lev-2 should have all 5 receipts (3 old + 2 new)
    expect(seq2.getLatestSequenceNumber()).toBe(5n);

    // Verify all 5 receipts are individually accessible
    expect(seq2.getReceipt('l2-p1-00000001')).toBeDefined();
    expect(seq2.getReceipt('l2-p1-00000002')).toBeDefined();
    expect(seq2.getReceipt('l2-p1-00000003')).toBeDefined();
    expect(seq2.getReceipt('l2-p1-00000004')).toBeDefined();
    expect(seq2.getReceipt('l2-p1-00000005')).toBeDefined();

    // Audit log should contain all 5 events
    const auditLog = seq2.getAuditLog();
    expect(auditLog.events.length).toBe(5);

    // The new leader has full state continuity — no data lost in failover
  });
});
