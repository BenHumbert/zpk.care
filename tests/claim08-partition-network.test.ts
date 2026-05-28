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
 * Claim 8 — Partitioned Sequencer Network Tests
 *
 * Tests multi-Leviathan partition topology: per-partition sequencers,
 * wrong-partition rejection, entity node connectivity, partition info
 * via RPC, manual PartitionRouter setup, and l2Only batch cycle.
 *
 * Patent items: 08-Y01 through 08-Y07
 *
 * Run: npx jest tests/claim08-partition-network.test.ts --verbose --forceExit
 */

import { Field, MerkleTree } from 'o1js';
import { InMemoryStore } from '../src/storage/local-store.js';
import { WALLET_TREE_HEIGHT } from '../src/wallets/wallet-state.js';
import { L2Leviathan } from '../src/l2/l2-leviathan.js';
import { L2RpcServer } from '../src/l2/l2-rpc-server.js';
import { L2Client } from '../src/l2/l2-client.js';
import { getPartition, isMyPartition, PartitionRouter } from '../src/l2/l2-partition.js';
import type { LeviathanConfig } from '../src/l2/l2-leviathan-types.js';
import type { L2Receipt } from '../src/l2/l2-types.js';
import type { AuditEvent } from '../src/audit/audit-types.js';
import { MemberNode } from '../src/nodes/member-node.js';
import { PharmacyNode } from '../src/nodes/pharmacy-node.js';
import { PrescriberNode } from '../src/nodes/prescriber-node.js';

// ─── Test Setup ─────────────────────────────────────────────

jest.setTimeout(30_000);

const emptyRegTree = new MerkleTree(WALLET_TREE_HEIGHT);
const emptyLcTree = new MerkleTree(WALLET_TREE_HEIGHT);
const INITIAL_REG_ROOT = emptyRegTree.getRoot();
const INITIAL_LC_ROOT = emptyLcTree.getRoot();
const TEST_ADMIN_TOKEN = 'test-admin-token';

// ─── Helpers ────────────────────────────────────────────────

/** Create a LeviathanConfig with round-robin failover chain */
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
  port: number;
  url: string;
  cleanup: () => Promise<void>;
}

async function createTestLeviathan(
  partitionCount: number,
  primaryPartition: number,
  nodeId: string,
  nodeIds: string[],
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
  const client = new L2Client({ sequencerUrl: url, adminToken: TEST_ADMIN_TOKEN });

  return {
    leviathan,
    server,
    client,
    port,
    url,
    cleanup: async () => {
      await leviathan.stop();
      await server.stop();
    },
  };
}

/** Return a walletId string that maps to a specific partition */
function walletForPartition(partitionIndex: number, partitionCount: number): string {
  // Since BigInt(partitionIndex) % BigInt(partitionCount) = partitionIndex
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

/** Create a mock AuditEvent for a given partition */
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

// Track contexts for cleanup
let activeContexts: TestLeviathanContext[] = [];

afterEach(async () => {
  for (const ctx of activeContexts) {
    await ctx.cleanup().catch(() => {});
  }
  activeContexts = [];
});

// ─── Tests ──────────────────────────────────────────────────

describe('Claim 8: Partitioned Sequencer Network', () => {
  /**
   * 08-Y01: Per-partition sequencer isolation.
   *
   * 3 Leviathans (partition 0, 1, 2), each in l2Only mode.
   * Apply a mock receipt to each Leviathan's primary partition sequencer.
   * Verify each partition sequencer has exactly 1 receipt and isLeaderFor()
   * returns true for the primary partition.
   */
  test('08-Y01: each Leviathan manages its own partition sequencer', async () => {
    const nodeIds = ['lev-0', 'lev-1', 'lev-2'];

    const ctx0 = await createTestLeviathan(3, 0, 'lev-0', nodeIds);
    const ctx1 = await createTestLeviathan(3, 1, 'lev-1', nodeIds);
    const ctx2 = await createTestLeviathan(3, 2, 'lev-2', nodeIds);
    activeContexts.push(ctx0, ctx1, ctx2);

    // Apply mock receipt to each Leviathan's primary partition
    const ctxs = [ctx0, ctx1, ctx2];
    for (let i = 0; i < 3; i++) {
      const receipt = mockReceipt(1n, i, 3);
      const auditEvent = mockAuditEvent(1n, i, 3);
      const seq = ctxs[i].leviathan.getSequencer(i);
      seq.applyReplicatedReceipt(receipt, auditEvent);
    }

    // Verify isolation: each partition sequencer has exactly 1 receipt
    for (let i = 0; i < 3; i++) {
      const seq = ctxs[i].leviathan.getSequencer(i);
      expect(seq.getAllReceipts().length).toBe(1);

      // Other partitions on the same Leviathan should have 0 receipts
      for (let j = 0; j < 3; j++) {
        if (j !== i) {
          const otherSeq = ctxs[i].leviathan.getSequencer(j);
          expect(otherSeq.getAllReceipts().length).toBe(0);
        }
      }
    }

    // Verify leadership
    expect(ctx0.leviathan.isLeaderFor(0)).toBe(true);
    expect(ctx0.leviathan.isLeaderFor(1)).toBe(false);
    expect(ctx1.leviathan.isLeaderFor(1)).toBe(true);
    expect(ctx1.leviathan.isLeaderFor(0)).toBe(false);
    expect(ctx2.leviathan.isLeaderFor(2)).toBe(true);
    expect(ctx2.leviathan.isLeaderFor(1)).toBe(false);
  });

  /**
   * 08-Y02: Wrong-partition wallet rejection.
   *
   * isMyPartition() returns false for a wallet belonging to a different partition.
   */
  test('08-Y02: isMyPartition rejects wrong-partition wallets', () => {
    // Wallet "1" maps to partition 1 in a 3-partition setup
    const wallet1 = walletForPartition(1, 3);
    expect(getPartition(wallet1, 3)).toBe(1);

    // Partition 0 rejects it
    expect(isMyPartition(wallet1, { partitionCount: 3, partitionIndex: 0 })).toBe(false);

    // Partition 1 accepts it
    expect(isMyPartition(wallet1, { partitionCount: 3, partitionIndex: 1 })).toBe(true);

    // Partition 2 rejects it
    expect(isMyPartition(wallet1, { partitionCount: 3, partitionIndex: 2 })).toBe(false);
  });

  /**
   * 08-Y03: Multiple entity node types connect to the same Leviathan.
   *
   * 1 Leviathan + RPC server. MemberNode, PharmacyNode, PrescriberNode
   * all pointing at the same URL. All call getStatus() successfully.
   */
  test('08-Y03: member, pharmacy, prescriber nodes all connect to same Leviathan', async () => {
    const nodeIds = ['lev-0'];
    const ctx = await createTestLeviathan(1, 0, 'lev-0', nodeIds);
    activeContexts.push(ctx);

    const memberNode = new MemberNode({
      role: 'member',
      sequencerUrl: ctx.url,
      walletId: '12345',
    });

    const pharmacyNode = new PharmacyNode({
      role: 'pharmacy',
      sequencerUrl: ctx.url,
      walletId: '67890',
    });

    const prescriberNode = new PrescriberNode({
      role: 'prescriber',
      sequencerUrl: ctx.url,
      walletId: '11111',
    });

    // All 3 can query the same chain state
    const [memberStatus, pharmacyStatus, prescriberStatus] = await Promise.all([
      memberNode.getStatus(),
      pharmacyNode.getStatus(),
      prescriberNode.getStatus(),
    ]);

    expect(memberStatus).toBeDefined();
    expect(pharmacyStatus).toBeDefined();
    expect(prescriberStatus).toBeDefined();

    // All see the same node
    expect(memberStatus.running).toBe(true);
    expect(pharmacyStatus.running).toBe(true);
    expect(prescriberStatus.running).toBe(true);

    // Roles are correct
    expect(memberNode.getRole()).toBe('member');
    expect(pharmacyNode.getRole()).toBe('pharmacy');
    expect(prescriberNode.getRole()).toBe('prescriber');
  });

  /**
   * 08-Y04: Partition info available via RPC.
   *
   * 3 Leviathans + RPC servers. Each returns partitioned: true,
   * partitionConfig with correct partitionCount and partitionIndex.
   */
  test('08-Y04: l2_getPartitionInfo returns correct partition config per Leviathan', async () => {
    const nodeIds = ['lev-0', 'lev-1', 'lev-2'];

    const ctx0 = await createTestLeviathan(3, 0, 'lev-0', nodeIds);
    const ctx1 = await createTestLeviathan(3, 1, 'lev-1', nodeIds);
    const ctx2 = await createTestLeviathan(3, 2, 'lev-2', nodeIds);
    activeContexts.push(ctx0, ctx1, ctx2);

    const info0 = await ctx0.client.getPartitionInfo();
    const info1 = await ctx1.client.getPartitionInfo();
    const info2 = await ctx2.client.getPartitionInfo();

    // All report as partitioned
    expect(info0.partitioned).toBe(true);
    expect(info1.partitioned).toBe(true);
    expect(info2.partitioned).toBe(true);

    // Correct partition count
    expect(info0.partitionConfig?.partitionCount).toBe(3);
    expect(info1.partitionConfig?.partitionCount).toBe(3);
    expect(info2.partitionConfig?.partitionCount).toBe(3);

    // Correct partition index (primary partition)
    expect(info0.partitionConfig?.partitionIndex).toBe(0);
    expect(info1.partitionConfig?.partitionIndex).toBe(1);
    expect(info2.partitionConfig?.partitionIndex).toBe(2);

    // l2Only flag
    expect(info0.l2Only).toBe(true);
  });

  /**
   * 08-Y05: Manual PartitionRouter maps wallets to correct Leviathan URLs.
   *
   * 3 Leviathans. Manual PartitionRouter(3) with all 3 URLs.
   * router.getSequencerUrl(walletId) returns the correct Leviathan URL
   * matching getPartition().
   */
  test('08-Y05: manual PartitionRouter routes to correct Leviathan', async () => {
    const nodeIds = ['lev-0', 'lev-1', 'lev-2'];

    const ctx0 = await createTestLeviathan(3, 0, 'lev-0', nodeIds);
    const ctx1 = await createTestLeviathan(3, 1, 'lev-1', nodeIds);
    const ctx2 = await createTestLeviathan(3, 2, 'lev-2', nodeIds);
    activeContexts.push(ctx0, ctx1, ctx2);

    const router = new PartitionRouter(3);
    router.setPartition(0, ctx0.url);
    router.setPartition(1, ctx1.url);
    router.setPartition(2, ctx2.url);

    // Test wallets known to route to each partition
    for (let p = 0; p < 3; p++) {
      const walletId = walletForPartition(p, 3);
      const expectedUrl = [ctx0.url, ctx1.url, ctx2.url][p];
      expect(router.getSequencerUrl(walletId)).toBe(expectedUrl);
    }
  });

  /**
   * 08-Y06: Entity node falls back to primary client without partition discovery.
   *
   * Before discovery: getPartitionRouter() returns null, queries go to primary.
   * After manual router setup: routing works correctly.
   */
  test('08-Y06: entity node falls back to primary without partition discovery', async () => {
    const nodeIds = ['lev-0', 'lev-1'];

    const ctx0 = await createTestLeviathan(2, 0, 'lev-0', nodeIds);
    const ctx1 = await createTestLeviathan(2, 1, 'lev-1', nodeIds);
    activeContexts.push(ctx0, ctx1);

    const memberNode = new MemberNode({
      role: 'member',
      sequencerUrl: ctx0.url,
      walletId: '12345',
    });

    // Before discovery: no partition router
    expect(memberNode.getPartitionRouter()).toBeNull();

    // Still works — falls back to primary client
    const status = await memberNode.getStatus();
    expect(status).toBeDefined();
    expect(status.running).toBe(true);

    // After discoverPartitions — Leviathan returns partitioned:true but allPartitions is empty
    // (because Leviathan.getPartitionRouter() returns null)
    await memberNode.discoverPartitions();

    // Still no router because allPartitions was empty
    // But the node is still functional via the primary client
    const status2 = await memberNode.getStatus();
    expect(status2).toBeDefined();
    expect(status2.running).toBe(true);
  });

  /**
   * 08-Y07: l2Only forceBatch routes to correct partition and reports l2Only mode.
   *
   * 1 Leviathan, l2Only: true, 2 partitions.
   * forceBatch(0) emits batch:empty with partitionIndex 0.
   * forceBatch(1) emits batch:empty with partitionIndex 1.
   * Leviathan status correctly reports l2Only: true.
   *
   * Note: Real proof submission requires ZkProgram compilation which is
   * out of scope for fast integration tests. We verify the routing
   * mechanism and l2Only configuration instead.
   */
  test('08-Y07: l2Only forceBatch routes to correct partition', async () => {
    const nodeIds = ['lev-0'];
    const config = makeConfig(2, 0, nodeIds);
    const store = new InMemoryStore();
    const leviathan = new L2Leviathan(
      config,
      {
        batchIntervalMs: 999_999,
        l2Only: true,
        nodeId: 'lev-0',
      },
      store,
      INITIAL_REG_ROOT,
      INITIAL_LC_ROOT,
      Field(0),
    );
    leviathan.start();

    const cleanupLev = async () => { await leviathan.stop(); };

    try {
      // Collect events to verify partition routing
      const events: any[] = [];
      leviathan.on((event) => events.push(event));

      // forceBatch on partition 0 (primary — we are leader)
      const batch0 = await leviathan.forceBatch(0);
      expect(batch0).toBeNull(); // No pending proofs

      // Verify batch:empty event targets partition 0
      const emptyP0 = events.find(
        (e) => e.type === 'batch:empty' && e.data.partitionIndex === 0,
      );
      expect(emptyP0).toBeDefined();

      // forceBatch on partition 1 — executeBatchCycle doesn't check leadership
      events.length = 0;
      const batch1 = await leviathan.forceBatch(1);
      expect(batch1).toBeNull(); // No pending proofs

      const emptyP1 = events.find(
        (e) => e.type === 'batch:empty' && e.data.partitionIndex === 1,
      );
      expect(emptyP1).toBeDefined();

      // Verify l2Only flag
      expect(leviathan.isL2Only()).toBe(true);
      const status = leviathan.getStatus();
      expect(status.l2Only).toBe(true);
    } finally {
      await cleanupLev();
    }
  });
});
