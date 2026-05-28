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

/** L2 Leviathan — Multi-leader partitioned L2 node tests */

import http from 'http';
import { Field, MerkleTree } from 'o1js';
import { InMemoryStore } from '../src/storage/local-store.js';
import { WALLET_TREE_HEIGHT } from '../src/wallets/wallet-state.js';
import { L2Leviathan } from '../src/l2/l2-leviathan.js';
import { L2RpcServer } from '../src/l2/l2-rpc-server.js';
import { L2Client } from '../src/l2/l2-client.js';
import { getPartition } from '../src/l2/l2-partition.js';
import type { LeviathanConfig, LeviathanStatus, PartitionStats } from '../src/l2/l2-leviathan-types.js';
import type { L2Receipt, L2Block, L2Batch } from '../src/l2/l2-types.js';
import type { AuditEvent } from '../src/audit/audit-types.js';
import type { LeviathanCheckpoint } from '../src/l2/l2-checkpoint.js';
import { l2Parse, l2Stringify } from '../src/l2/l2-json.js';

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
    // Rotate nodeIds so partition i has nodeIds[i] first
    const chain = [...nodeIds.slice(i), ...nodeIds.slice(0, i)];
    failoverChain.set(i, chain);
  }
  return {
    partitionCount,
    primaryPartition,
    failoverChain,
    heartbeatIntervalMs: 5_000,
    heartbeatTimeoutMs: 15_000,
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
  // Simple: walletId = partitionIndex maps to partition partitionIndex
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

/** Create a mock L2Block */
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

/** Create a mock L2Batch */
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

/** Raw HTTP POST to an RPC endpoint */
function rawRpc(
  port: number,
  method: string,
  params: Record<string, unknown> = {},
  adminToken?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const body = l2Stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params,
    });
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
        res.on('data', (chunk: string) => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ═══════════════════════════════════════════════════════════════
// 1. CONSTRUCTION & CONFIGURATION
// ═══════════════════════════════════════════════════════════════

describe('L2Leviathan — Construction & Config', () => {
  test('creates leviathan with correct partition count', () => {
    const config = makeConfig(3, 0, ['lev-0', 'lev-1', 'lev-2']);
    const lev = createLeviathan(config, { nodeId: 'lev-0' });
    expect(lev.getConfig().partitionCount).toBe(3);
    expect(lev.getConfig().primaryPartition).toBe(0);
  });

  test('creates one sequencer per partition', () => {
    const config = makeConfig(5, 2, ['a', 'b', 'c', 'd', 'e']);
    const lev = createLeviathan(config, { nodeId: 'c' });
    const allSeqs = lev.getAllSequencers();
    expect(allSeqs.size).toBe(5);
    for (let i = 0; i < 5; i++) {
      expect(allSeqs.has(i)).toBe(true);
    }
  });

  test('validates partitionCount >= 1', () => {
    expect(() => {
      const config = makeConfig(0, 0, []);
      createLeviathan(config);
    }).toThrow('partitionCount must be >= 1');
  });

  test('validates primaryPartition in range', () => {
    expect(() => {
      const config = makeConfig(3, 5, ['a', 'b', 'c']);
      createLeviathan(config);
    }).toThrow('primaryPartition 5 out of range');
  });

  test('single-partition leviathan works', () => {
    const config = makeConfig(1, 0, ['solo']);
    const lev = createLeviathan(config, { nodeId: 'solo' });
    expect(lev.getConfig().partitionCount).toBe(1);
    expect(lev.isLeaderFor(0)).toBe(true);
  });

  test('initializes leader map from failover chain', () => {
    const config = makeConfig(3, 1, ['lev-0', 'lev-1', 'lev-2']);
    const lev = createLeviathan(config, { nodeId: 'lev-1' });
    const map = lev.getLeaderMap();
    // Partition 0: first in chain = 'lev-0'
    expect(map.get(0)?.currentLeader).toBe('lev-0');
    // Partition 1: primary partition for this node
    expect(map.get(1)?.currentLeader).toBe('lev-1');
    expect(map.get(1)?.isLocalLeader).toBe(true);
    // Partition 2: first in chain = 'lev-2'
    expect(map.get(2)?.currentLeader).toBe('lev-2');
  });

  test('sets correct initial role and node ID', () => {
    const config = makeConfig(3, 0, ['test-node', 'b', 'c']);
    const lev = createLeviathan(config, { nodeId: 'test-node' });
    expect(lev.getRole()).toBe('leviathan');
    expect(lev.getNodeId()).toBe('test-node');
    expect(lev.isL2Only()).toBe(true);
  });

  test('auto-generates node ID when not provided', () => {
    const config = makeConfig(2, 0, ['x', 'y']);
    const lev = createLeviathan(config);
    expect(lev.getNodeId()).toMatch(/^lev-/);
  });
});

// ═══════════════════════════════════════════════════════════════
// 2. LEADERSHIP & PARTITION ASSIGNMENT
// ═══════════════════════════════════════════════════════════════

describe('L2Leviathan — Leadership & Partition Assignment', () => {
  test('leads only primary partition initially', () => {
    const config = makeConfig(3, 1, ['a', 'b', 'c']);
    const lev = createLeviathan(config, { nodeId: 'b' });
    expect(lev.isLeaderFor(0)).toBe(false);
    expect(lev.isLeaderFor(1)).toBe(true);
    expect(lev.isLeaderFor(2)).toBe(false);
    expect(lev.getActiveLeaderPartitions()).toEqual([1]);
  });

  test('promoteToLeader adds partition to active list', () => {
    const config = makeConfig(3, 0, ['a', 'b', 'c']);
    const lev = createLeviathan(config, { nodeId: 'a' });
    expect(lev.getActiveLeaderPartitions()).toEqual([0]);

    lev.promoteToLeader(2, 'c');
    expect(lev.isLeaderFor(2)).toBe(true);
    expect(lev.getActiveLeaderPartitions()).toEqual([0, 2]);
  });

  test('demoteFromLeader removes partition from active list', () => {
    const config = makeConfig(3, 0, ['a', 'b', 'c']);
    const lev = createLeviathan(config, { nodeId: 'a' });
    lev.promoteToLeader(1, 'b');
    expect(lev.getActiveLeaderPartitions()).toEqual([0, 1]);

    lev.demoteFromLeader(1, 'b');
    expect(lev.isLeaderFor(1)).toBe(false);
    expect(lev.getActiveLeaderPartitions()).toEqual([0]);
  });

  test('demoteFromLeader updates leader map entry', () => {
    const config = makeConfig(3, 0, ['a', 'b', 'c']);
    const lev = createLeviathan(config, { nodeId: 'a' });
    lev.promoteToLeader(2, 'c');
    lev.demoteFromLeader(2, 'c-back');

    const entry = lev.getLeaderMap().get(2);
    expect(entry?.currentLeader).toBe('c-back');
    expect(entry?.isLocalLeader).toBe(false);
  });

  test('getPartition routes walletIds to correct partitions', () => {
    expect(getPartition('0', 3)).toBe(0);
    expect(getPartition('1', 3)).toBe(1);
    expect(getPartition('2', 3)).toBe(2);
    expect(getPartition('3', 3)).toBe(0);
    expect(getPartition('4', 3)).toBe(1);
    expect(getPartition('5', 3)).toBe(2);
  });

  test('walletForPartition helper returns correct partition', () => {
    for (let p = 0; p < 5; p++) {
      const wid = walletForPartition(p, 5);
      expect(getPartition(wid, 5)).toBe(p);
    }
  });

  test('multiple promotions can accumulate', () => {
    const config = makeConfig(5, 0, ['a', 'b', 'c', 'd', 'e']);
    const lev = createLeviathan(config, { nodeId: 'a' });
    lev.promoteToLeader(1, 'b');
    lev.promoteToLeader(2, 'c');
    lev.promoteToLeader(3, 'd');
    expect(lev.getActiveLeaderPartitions()).toEqual([0, 1, 2, 3]);
    expect(lev.isLeaderFor(4)).toBe(false);
  });

  test('getPartitionConfig returns primary partition info', () => {
    const config = makeConfig(3, 2, ['a', 'b', 'c']);
    const lev = createLeviathan(config, { nodeId: 'c' });
    const partConfig = lev.getPartitionConfig();
    expect(partConfig).toEqual({
      partitionCount: 3,
      partitionIndex: 2,
    });
  });

  test('getPartitionRouter returns null for leviathans', () => {
    const config = makeConfig(3, 0, ['a', 'b', 'c']);
    const lev = createLeviathan(config, { nodeId: 'a' });
    expect(lev.getPartitionRouter()).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
// 3. REPLICATED STATE & AGGREGATED QUERIES
// ═══════════════════════════════════════════════════════════════

describe('L2Leviathan — Replicated State & Queries', () => {
  let lev: L2Leviathan;
  const PARTITIONS = 3;

  beforeEach(() => {
    const config = makeConfig(PARTITIONS, 0, ['a', 'b', 'c']);
    lev = createLeviathan(config, { nodeId: 'a' });
  });

  test('getReceipt finds receipt across any partition', () => {
    const r0 = injectReceipts(lev, 0, PARTITIONS, 1, 1n);
    const r1 = injectReceipts(lev, 1, PARTITIONS, 1, 1n);
    const r2 = injectReceipts(lev, 2, PARTITIONS, 1, 1n);

    expect(lev.getReceipt(r0[0].receiptId)).toBeDefined();
    expect(lev.getReceipt(r1[0].receiptId)).toBeDefined();
    expect(lev.getReceipt(r2[0].receiptId)).toBeDefined();
  });

  test('getReceipt returns undefined for nonexistent receipt', () => {
    expect(lev.getReceipt('nonexistent')).toBeUndefined();
  });

  test('getReceiptsByWallet routes to correct partition', () => {
    // Inject receipts into partition 1
    const receipts = injectReceipts(lev, 1, PARTITIONS, 3, 1n);
    const walletId = walletForPartition(1, PARTITIONS);

    const found = lev.getReceiptsByWallet(walletId);
    expect(found).toHaveLength(3);
    expect(found[0].receiptId).toBe(receipts[0].receiptId);
  });

  test('getReceiptsByWallet returns empty for wallet with no receipts', () => {
    const walletId = walletForPartition(2, PARTITIONS);
    expect(lev.getReceiptsByWallet(walletId)).toHaveLength(0);
  });

  test('getAllReceipts merges across all partitions', () => {
    injectReceipts(lev, 0, PARTITIONS, 2, 1n);
    injectReceipts(lev, 1, PARTITIONS, 3, 10n);
    injectReceipts(lev, 2, PARTITIONS, 1, 20n);

    const all = lev.getAllReceipts();
    expect(all).toHaveLength(6);
    // Sorted by sequence number
    expect(all[0].sequenceNumber).toBe(1n);
    expect(all[all.length - 1].sequenceNumber).toBe(20n);
  });

  test('getAllBatches merges across all partitions', () => {
    const seq0 = lev.getSequencer(0);
    const seq1 = lev.getSequencer(1);

    // Inject batches via replication
    const batch0 = mockBatch(1n, 1n, ['r1']);
    const block0 = mockBlock(1n, ['r1']);
    seq0.applyReplicatedBatch(batch0, block0, [], []);

    const batch1 = mockBatch(2n, 2n, ['r2']);
    const block1 = mockBlock(2n, ['r2']);
    seq1.applyReplicatedBatch(batch1, block1, [], []);

    const all = lev.getAllBatches();
    expect(all).toHaveLength(2);
    expect(all[0].batchNumber).toBe(1n);
    expect(all[1].batchNumber).toBe(2n);
  });

  test('getBlock searches all partitions', () => {
    const seq2 = lev.getSequencer(2);
    const block = mockBlock(5n, ['r1', 'r2']);
    const batch = mockBatch(1n, 5n, ['r1', 'r2']);
    seq2.applyReplicatedBatch(batch, block, [], []);

    expect(lev.getBlock(5n)).toBeDefined();
    expect(lev.getBlock(5n)?.blockNumber).toBe(5n);
    expect(lev.getBlock(999n)).toBeUndefined();
  });

  test('getBatch searches all partitions', () => {
    const seq1 = lev.getSequencer(1);
    const batch = mockBatch(7n, 7n, ['r1']);
    const block = mockBlock(7n, ['r1']);
    seq1.applyReplicatedBatch(batch, block, [], []);

    expect(lev.getBatch(7n)).toBeDefined();
    expect(lev.getBatch(7n)?.batchNumber).toBe(7n);
    expect(lev.getBatch(999n)).toBeUndefined();
  });

  test('getAuditLog merges events from all partitions sorted by timestamp', () => {
    // Inject events at known timestamps
    const seq0 = lev.getSequencer(0);
    const seq1 = lev.getSequencer(1);

    const ae0 = mockAuditEvent(1n, 0, PARTITIONS);
    ae0.timestamp = 1000;
    seq0.applyReplicatedReceipt(
      mockReceipt(1n, 0, PARTITIONS), ae0, undefined,
      INITIAL_REG_ROOT.toString(), INITIAL_LC_ROOT.toString(), '0',
    );

    const ae1 = mockAuditEvent(1n, 1, PARTITIONS);
    ae1.timestamp = 500; // Earlier timestamp
    seq1.applyReplicatedReceipt(
      mockReceipt(1n, 1, PARTITIONS), ae1, undefined,
      INITIAL_REG_ROOT.toString(), INITIAL_LC_ROOT.toString(), '0',
    );

    const log = lev.getAuditLog();
    expect(log.events).toHaveLength(2);
    // Sorted by timestamp — partition 1's event should come first
    expect(log.events[0].timestamp).toBe(500);
    expect(log.events[1].timestamp).toBe(1000);
    expect(log.eventCount).toBe(2n);
  });

  test('getClaimsByMember routes to correct partition', () => {
    // Claims are per-partition. Members in partition 0 only in partition 0's accumulator.
    const walletId = walletForPartition(0, PARTITIONS);
    const claims = lev.getClaimsByMember(walletId);
    // No claims injected yet
    expect(claims).toHaveLength(0);
  });

  test('getClaimsByPharmacy searches all partitions', () => {
    // Without injected claims, returns empty
    const claims = lev.getClaimsByPharmacy('pharmacy-1');
    expect(claims).toHaveLength(0);
  });

  test('getClaimAccumulatorRoot returns primary partition root', () => {
    const root = lev.getClaimAccumulatorRoot();
    expect(typeof root).toBe('string');
    expect(root.length).toBeGreaterThan(0);
  });

  test('getClaimLeafCount sums across partitions', () => {
    // Initially all zeros
    const count = lev.getClaimLeafCount();
    expect(count).toBe(0n);
  });
});

// ═══════════════════════════════════════════════════════════════
// 4. LIFECYCLE & EVENTS
// ═══════════════════════════════════════════════════════════════

describe('L2Leviathan — Lifecycle & Events', () => {
  test('start sets running to true', () => {
    const config = makeConfig(3, 0, ['a', 'b', 'c']);
    const lev = createLeviathan(config, { nodeId: 'a' });
    expect(lev.isRunning()).toBe(false);
    lev.start();
    expect(lev.isRunning()).toBe(true);
    // Cleanup
    lev.stop();
  });

  test('start is idempotent', () => {
    const config = makeConfig(2, 0, ['a', 'b']);
    const lev = createLeviathan(config, { nodeId: 'a' });
    lev.start();
    lev.start(); // Second start should be no-op
    expect(lev.isRunning()).toBe(true);
    lev.stop();
  });

  test('stop waits for cleanup', async () => {
    const config = makeConfig(2, 0, ['a', 'b']);
    const lev = createLeviathan(config, { nodeId: 'a' });
    lev.start();
    await lev.stop();
    expect(lev.isRunning()).toBe(false);
  });

  test('stop is idempotent', async () => {
    const config = makeConfig(2, 0, ['a', 'b']);
    const lev = createLeviathan(config, { nodeId: 'a' });
    await lev.stop(); // Stop without start should be no-op
    expect(lev.isRunning()).toBe(false);
  });

  test('emits node:started event on start', () => {
    const config = makeConfig(3, 0, ['a', 'b', 'c']);
    const lev = createLeviathan(config, { nodeId: 'a' });
    const events: any[] = [];
    lev.on((event) => events.push(event));
    lev.start();

    expect(events.length).toBeGreaterThan(0);
    const startEvent = events.find((e) => e.type === 'node:started');
    expect(startEvent).toBeDefined();
    expect(startEvent.data.role).toBe('leviathan');
    expect(startEvent.data.partitionCount).toBe(3);
    lev.stop();
  });

  test('emits node:stopped event on stop', async () => {
    const config = makeConfig(2, 0, ['a', 'b']);
    const lev = createLeviathan(config, { nodeId: 'a' });
    const events: any[] = [];
    lev.on((event) => events.push(event));
    lev.start();
    await lev.stop();

    const stopEvent = events.find((e) => e.type === 'node:stopped');
    expect(stopEvent).toBeDefined();
    expect(stopEvent.data.nodeId).toBe('a');
  });

  test('on/off handlers work correctly', () => {
    const config = makeConfig(2, 0, ['a', 'b']);
    const lev = createLeviathan(config, { nodeId: 'a' });
    const events: any[] = [];
    const handler = (event: any) => events.push(event);
    lev.on(handler);
    lev.emit({ type: 'node:tick', timestamp: Date.now(), data: {} });
    expect(events).toHaveLength(1);

    lev.off(handler);
    lev.emit({ type: 'node:tick', timestamp: Date.now(), data: {} });
    expect(events).toHaveLength(1); // Still 1 — handler removed
  });

  test('handler errors do not crash the node', () => {
    const config = makeConfig(2, 0, ['a', 'b']);
    const lev = createLeviathan(config, { nodeId: 'a' });
    lev.on(() => { throw new Error('handler crash'); });
    expect(() => {
      lev.emit({ type: 'node:tick', timestamp: Date.now(), data: {} });
    }).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════
// 5. BATCH BUILDING
// ═══════════════════════════════════════════════════════════════

describe('L2Leviathan — Batch Building', () => {
  test('forceBatch returns null when no pending proofs', async () => {
    const config = makeConfig(3, 0, ['a', 'b', 'c']);
    const lev = createLeviathan(config, { nodeId: 'a' });
    const result = await lev.forceBatch();
    expect(result).toBeNull();
  });

  test('forceBatch defaults to primary partition', async () => {
    const config = makeConfig(3, 2, ['a', 'b', 'c']);
    const lev = createLeviathan(config, { nodeId: 'c' });
    const events: any[] = [];
    lev.on((event) => events.push(event));
    await lev.forceBatch();
    const emptyEvent = events.find((e) => e.type === 'batch:empty');
    expect(emptyEvent?.data.partitionIndex).toBe(2);
  });

  test('forceBatch can target specific partition', async () => {
    const config = makeConfig(3, 0, ['a', 'b', 'c']);
    const lev = createLeviathan(config, { nodeId: 'a' });
    lev.promoteToLeader(1, 'b');
    const events: any[] = [];
    lev.on((event) => events.push(event));
    await lev.forceBatch(1);
    const emptyEvent = events.find((e) => e.type === 'batch:empty');
    expect(emptyEvent?.data.partitionIndex).toBe(1);
  });

  test('emits batch:empty when no pending proofs on forceBatch', async () => {
    const config = makeConfig(2, 0, ['a', 'b']);
    const lev = createLeviathan(config, { nodeId: 'a' });
    const events: any[] = [];
    lev.on((event) => events.push(event));
    await lev.forceBatch(0);
    expect(events.some((e) => e.type === 'batch:empty')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// 6. HEARTBEAT & FAILOVER
// ═══════════════════════════════════════════════════════════════

describe('L2Leviathan — Heartbeat & Failover', () => {
  test('promoteToLeader emits event with correct data', () => {
    const config = makeConfig(3, 0, ['a', 'b', 'c']);
    const lev = createLeviathan(config, { nodeId: 'a' });
    const events: any[] = [];
    lev.on((event) => events.push(event));

    lev.promoteToLeader(1, 'b');

    const promotionEvent = events.find(
      (e) => e.type === 'node:started' && e.data.action === 'leader_promotion',
    );
    expect(promotionEvent).toBeDefined();
    expect(promotionEvent.data.partitionIndex).toBe(1);
    expect(promotionEvent.data.previousLeader).toBe('b');
    expect(promotionEvent.data.newLeader).toBe('a');
  });

  test('demoteFromLeader emits event with correct data', () => {
    const config = makeConfig(3, 0, ['a', 'b', 'c']);
    const lev = createLeviathan(config, { nodeId: 'a' });
    lev.promoteToLeader(1, 'b');
    const events: any[] = [];
    lev.on((event) => events.push(event));

    lev.demoteFromLeader(1, 'b');

    const demotionEvent = events.find(
      (e) => e.type === 'node:started' && e.data.action === 'leader_demotion',
    );
    expect(demotionEvent).toBeDefined();
    expect(demotionEvent.data.partitionIndex).toBe(1);
    expect(demotionEvent.data.newLeader).toBe('b');
  });

  test('promote then demote restores original state', () => {
    const config = makeConfig(3, 0, ['a', 'b', 'c']);
    const lev = createLeviathan(config, { nodeId: 'a' });
    expect(lev.getActiveLeaderPartitions()).toEqual([0]);

    lev.promoteToLeader(1, 'b');
    expect(lev.getActiveLeaderPartitions()).toEqual([0, 1]);

    lev.demoteFromLeader(1, 'b');
    expect(lev.getActiveLeaderPartitions()).toEqual([0]);
  });

  test('can promote to lead all partitions (full takeover)', () => {
    const config = makeConfig(4, 0, ['a', 'b', 'c', 'd']);
    const lev = createLeviathan(config, { nodeId: 'a' });
    lev.promoteToLeader(1, 'b');
    lev.promoteToLeader(2, 'c');
    lev.promoteToLeader(3, 'd');
    expect(lev.getActiveLeaderPartitions()).toEqual([0, 1, 2, 3]);
  });

  test('failover chain is stored in config', () => {
    const config = makeConfig(3, 0, ['a', 'b', 'c']);
    const lev = createLeviathan(config, { nodeId: 'a' });
    const chain = lev.getConfig().failoverChain;
    expect(chain.get(0)).toEqual(['a', 'b', 'c']);
    expect(chain.get(1)).toEqual(['b', 'c', 'a']);
    expect(chain.get(2)).toEqual(['c', 'a', 'b']);
  });

  test('leader map correctly tracks multiple leaders', () => {
    const config = makeConfig(3, 0, ['a', 'b', 'c']);
    const lev = createLeviathan(config, { nodeId: 'a' });

    // Simulate other nodes being leaders
    const map = lev.getLeaderMap();
    expect(map.get(0)?.isLocalLeader).toBe(true);
    expect(map.get(1)?.isLocalLeader).toBe(false);
    expect(map.get(2)?.isLocalLeader).toBe(false);

    // After promotion
    lev.promoteToLeader(2, 'c');
    const map2 = lev.getLeaderMap();
    expect(map2.get(2)?.isLocalLeader).toBe(true);
    expect(map2.get(2)?.currentLeader).toBe('a');
  });
});

// ═══════════════════════════════════════════════════════════════
// 7. CHECKPOINT & RECOVERY
// ═══════════════════════════════════════════════════════════════

describe('L2Leviathan — Checkpoint & Recovery', () => {
  test('exportCheckpoint captures all partition states', () => {
    const config = makeConfig(3, 0, ['a', 'b', 'c']);
    const lev = createLeviathan(config, { nodeId: 'a' });

    // Inject data into partitions
    injectReceipts(lev, 0, 3, 2, 1n);
    injectReceipts(lev, 1, 3, 1, 10n);

    const cp = lev.exportCheckpoint('manual');
    expect(cp.version).toBe(1);
    expect(cp.trigger).toBe('manual');
    expect(Object.keys(cp.partitionStates)).toHaveLength(3);
    expect(cp.leviathanConfig.partitionCount).toBe(3);
    expect(cp.leviathanConfig.primaryPartition).toBe(0);
  });

  test('exportCheckpoint captures leader map', () => {
    const config = makeConfig(3, 0, ['a', 'b', 'c']);
    const lev = createLeviathan(config, { nodeId: 'a' });
    lev.promoteToLeader(1, 'b');

    const cp = lev.exportCheckpoint('manual');
    expect(cp.leaderMap[0]).toBe('a');
    expect(cp.leaderMap[1]).toBe('a'); // Promoted
  });

  test('exportCheckpoint captures per-partition stats', () => {
    const config = makeConfig(2, 0, ['a', 'b']);
    const lev = createLeviathan(config, { nodeId: 'a' });

    const cp = lev.exportCheckpoint('manual');
    expect(cp.partitionNodeStats[0]).toBeDefined();
    expect(cp.partitionNodeStats[0].totalProofsAccepted).toBe(0);
    expect(cp.partitionNodeStats[1]).toBeDefined();
  });

  test('exportCheckpoint captures failover chain', () => {
    const config = makeConfig(3, 1, ['a', 'b', 'c']);
    const lev = createLeviathan(config, { nodeId: 'b' });

    const cp = lev.exportCheckpoint('shutdown');
    expect(cp.leviathanConfig.failoverChain[0]).toEqual(['a', 'b', 'c']);
    expect(cp.leviathanConfig.failoverChain[1]).toEqual(['b', 'c', 'a']);
    expect(cp.leviathanConfig.failoverChain[2]).toEqual(['c', 'a', 'b']);
  });

  test('restoreFromCheckpoint restores partition state', () => {
    const config = makeConfig(3, 0, ['a', 'b', 'c']);
    const lev1 = createLeviathan(config, { nodeId: 'a' });

    // Inject data
    injectReceipts(lev1, 0, 3, 3, 1n);
    injectReceipts(lev1, 1, 3, 2, 10n);

    // Export checkpoint
    const cp = lev1.exportCheckpoint('manual');

    // Create new leviathan and restore
    const lev2 = createLeviathan(config, { nodeId: 'a' });
    lev2.restoreFromCheckpoint(cp);

    // Verify state was restored
    expect(lev2.getAllReceipts()).toHaveLength(5);
    expect(lev2.getSequencer(0).getAllReceipts()).toHaveLength(3);
    expect(lev2.getSequencer(1).getAllReceipts()).toHaveLength(2);
  });

  test('restoreFromCheckpoint restores leader map', () => {
    const config = makeConfig(3, 0, ['a', 'b', 'c']);
    const lev1 = createLeviathan(config, { nodeId: 'a' });
    lev1.promoteToLeader(2, 'c');

    const cp = lev1.exportCheckpoint('manual');

    const lev2 = createLeviathan(config, { nodeId: 'a' });
    lev2.restoreFromCheckpoint(cp);

    // Leader map should show 'a' leading partitions 0 and 2
    expect(lev2.isLeaderFor(0)).toBe(true);
    expect(lev2.isLeaderFor(2)).toBe(true);
    expect(lev2.isLeaderFor(1)).toBe(false);
  });

  test('fromCheckpoint static factory creates working leviathan', () => {
    const config = makeConfig(3, 0, ['a', 'b', 'c']);
    const lev1 = createLeviathan(config, { nodeId: 'a' });
    injectReceipts(lev1, 0, 3, 2, 1n);

    const cp = lev1.exportCheckpoint('manual');

    const store = new InMemoryStore();
    const lev2 = L2Leviathan.fromCheckpoint(cp, store, {
      batchIntervalMs: 999_999,
      l2Only: true,
    });

    expect(lev2.getConfig().partitionCount).toBe(3);
    expect(lev2.getAllReceipts()).toHaveLength(2);
  });

  test('checkpoint round-trips through JSON serialization', () => {
    const config = makeConfig(3, 0, ['a', 'b', 'c']);
    const lev = createLeviathan(config, { nodeId: 'a' });
    injectReceipts(lev, 0, 3, 1, 1n);

    const cp = lev.exportCheckpoint('batch_settled');
    const json = l2Stringify(cp);
    const restored = l2Parse<LeviathanCheckpoint>(json);

    expect(restored.version).toBe(1);
    expect(restored.trigger).toBe('batch_settled');
    expect(Object.keys(restored.partitionStates)).toHaveLength(3);
    expect(restored.leviathanConfig.partitionCount).toBe(3);
  });
});

// ═══════════════════════════════════════════════════════════════
// 8. STATUS & GETTERS
// ═══════════════════════════════════════════════════════════════

describe('L2Leviathan — Status & Getters', () => {
  test('getStatus returns correct structure', () => {
    const config = makeConfig(3, 0, ['a', 'b', 'c']);
    const lev = createLeviathan(config, { nodeId: 'a' });
    lev.start();

    const status = lev.getStatus();
    expect(status.nodeId).toBe('a');
    expect(status.role).toBe('leviathan');
    expect(status.partitionCount).toBe(3);
    expect(status.primaryPartition).toBe(0);
    expect(status.activeLeaderPartitions).toEqual([0]);
    expect(status.partitionStats).toHaveLength(3);
    expect(status.running).toBe(true);
    expect(status.l2Only).toBe(true);
    expect(status.uptimeMs).toBeGreaterThanOrEqual(0);

    lev.stop();
  });

  test('getStatus aggregates global totals', () => {
    const config = makeConfig(3, 0, ['a', 'b', 'c']);
    const lev = createLeviathan(config, { nodeId: 'a' });

    const status = lev.getStatus();
    expect(status.globalTotals.totalProofsAccepted).toBe(0);
    expect(status.globalTotals.totalBatchesBuilt).toBe(0);
    expect(status.globalTotals.totalBatchesSettled).toBe(0);
    expect(status.globalTotals.totalBatchesFailed).toBe(0);
    expect(status.globalTotals.pendingProofs).toBe(0);
  });

  test('getStatus includes per-partition stats', () => {
    const config = makeConfig(3, 0, ['a', 'b', 'c']);
    const lev = createLeviathan(config, { nodeId: 'a' });
    injectReceipts(lev, 0, 3, 2, 1n);

    const status = lev.getStatus();
    const p0Stats = status.partitionStats.find((s) => s.partitionIndex === 0);
    expect(p0Stats).toBeDefined();
    expect(p0Stats!.isLeader).toBe(true);
    expect(p0Stats!.totalReceipts).toBe(2);
    expect(p0Stats!.currentLeader).toBe('a');
  });

  test('getStatus shows leader map correctly', () => {
    const config = makeConfig(3, 0, ['a', 'b', 'c']);
    const lev = createLeviathan(config, { nodeId: 'a' });

    const status = lev.getStatus();
    expect(status.leaderMap[0]).toBe('a');
    expect(status.leaderMap[1]).toBe('b');
    expect(status.leaderMap[2]).toBe('c');
  });

  test('getPartitionStatus returns stats for valid partition', () => {
    const config = makeConfig(3, 0, ['a', 'b', 'c']);
    const lev = createLeviathan(config, { nodeId: 'a' });
    injectReceipts(lev, 1, 3, 4, 1n);

    const pStatus = lev.getPartitionStatus(1);
    expect(pStatus).toBeDefined();
    expect(pStatus!.partitionIndex).toBe(1);
    expect(pStatus!.totalReceipts).toBe(4);
  });

  test('getPartitionStatus returns undefined for invalid partition', () => {
    const config = makeConfig(3, 0, ['a', 'b', 'c']);
    const lev = createLeviathan(config, { nodeId: 'a' });
    expect(lev.getPartitionStatus(99)).toBeUndefined();
  });

  test('uptime is zero when not running', () => {
    const config = makeConfig(2, 0, ['a', 'b']);
    const lev = createLeviathan(config, { nodeId: 'a' });
    expect(lev.getStatus().uptimeMs).toBe(0);
  });

  test('getSequencer returns partition sequencer', () => {
    const config = makeConfig(3, 0, ['a', 'b', 'c']);
    const lev = createLeviathan(config, { nodeId: 'a' });

    const seq0 = lev.getSequencer(0);
    const seq1 = lev.getSequencer(1);
    expect(seq0).toBeDefined();
    expect(seq1).toBeDefined();
    expect(seq0).not.toBe(seq1);
  });

  test('getSequencer defaults to primary partition', () => {
    const config = makeConfig(3, 2, ['a', 'b', 'c']);
    const lev = createLeviathan(config, { nodeId: 'c' });
    injectReceipts(lev, 2, 3, 1, 1n);

    const seq = lev.getSequencer();
    expect(seq.getAllReceipts()).toHaveLength(1);
  });

  test('getSequencer throws for invalid partition', () => {
    const config = makeConfig(3, 0, ['a', 'b', 'c']);
    const lev = createLeviathan(config, { nodeId: 'a' });
    expect(() => lev.getSequencer(99)).toThrow('Partition 99 not found');
  });

  test('getPeerNetwork returns null when no peers configured', () => {
    const config = makeConfig(2, 0, ['a', 'b']);
    const lev = createLeviathan(config, { nodeId: 'a' });
    expect(lev.getPeerNetwork()).toBeNull();
  });

  test('syncFromL1 throws in L2-only mode', () => {
    const config = makeConfig(2, 0, ['a', 'b']);
    const lev = createLeviathan(config, { nodeId: 'a', l2Only: true });
    expect(() => {
      lev.syncFromL1(Field(1), Field(2), Field(3));
    }).toThrow('L2-only mode: no L1 sync available');
  });
});

// ═══════════════════════════════════════════════════════════════
// 9. RPC INTEGRATION
// ═══════════════════════════════════════════════════════════════

describe('L2Leviathan — RPC Integration', () => {
  let lev: L2Leviathan;
  let server: L2RpcServer;
  let port: number;

  beforeEach(async () => {
    const config = makeConfig(3, 0, ['a', 'b', 'c']);
    lev = createLeviathan(config, { nodeId: 'a' });
    server = new L2RpcServer(lev, { port: 0, adminToken: TEST_ADMIN_TOKEN });
    await server.start();
    port = server.getPort();
  });

  afterEach(async () => {
    await lev.stop();
    await server.stop();
  });

  test('l2_getStatus returns leviathan status', async () => {
    const resp = await rawRpc(port, 'l2_getStatus');
    const parsed = l2Parse<any>(resp.body);
    expect(parsed.result.role).toBe('leviathan');
    expect(parsed.result.partitionCount).toBe(3);
    expect(parsed.result.nodeId).toBe('a');
  });

  test('l2_getLeviathanStatus returns full status', async () => {
    const resp = await rawRpc(port, 'l2_getLeviathanStatus');
    const parsed = l2Parse<any>(resp.body);
    expect(parsed.result.role).toBe('leviathan');
    expect(parsed.result.partitionStats).toHaveLength(3);
    expect(parsed.result.globalTotals).toBeDefined();
  });

  test('l2_getPartitionLeaders returns leader map', async () => {
    const resp = await rawRpc(port, 'l2_getPartitionLeaders');
    const parsed = l2Parse<any>(resp.body);
    expect(parsed.result.leaderMap).toBeDefined();
    expect(parsed.result.activeLeaderPartitions).toEqual([0]);
  });

  test('l2_getPartitionStatus returns partition stats', async () => {
    injectReceipts(lev, 0, 3, 5, 1n);
    const resp = await rawRpc(port, 'l2_getPartitionStatus', { partitionIndex: 0 });
    const parsed = l2Parse<any>(resp.body);
    expect(parsed.result.partitionIndex).toBe(0);
    expect(parsed.result.totalReceipts).toBe(5);
  });

  test('l2_getPartitionStatus requires partitionIndex param', async () => {
    const resp = await rawRpc(port, 'l2_getPartitionStatus', {});
    const parsed = l2Parse<any>(resp.body);
    expect(parsed.error).toBeDefined();
    expect(parsed.error.message).toContain('Missing or invalid');
  });

  test('l2_forceBatch accepts partitionIndex param', async () => {
    lev.promoteToLeader(1, 'b');
    const resp = await rawRpc(port, 'l2_forceBatch', { partitionIndex: 1 }, TEST_ADMIN_TOKEN);
    const parsed = l2Parse<any>(resp.body);
    // Should succeed (returns null since no pending proofs)
    expect(parsed.result).toBeNull();
  });

  test('l2_forceBatch without partitionIndex uses primary', async () => {
    const resp = await rawRpc(port, 'l2_forceBatch', {}, TEST_ADMIN_TOKEN);
    const parsed = l2Parse<any>(resp.body);
    expect(parsed.result).toBeNull();
  });

  test('l2_getChainState returns primary partition state', async () => {
    const resp = await rawRpc(port, 'l2_getChainState');
    const parsed = l2Parse<any>(resp.body);
    expect(parsed.result.registryRoot).toBeDefined();
    expect(parsed.result.lifecycleRoot).toBeDefined();
    expect(parsed.result.walletCount).toBeDefined();
  });

  test('l2_getAllReceipts returns merged receipts', async () => {
    injectReceipts(lev, 0, 3, 2, 1n);
    injectReceipts(lev, 1, 3, 3, 10n);

    const resp = await rawRpc(port, 'l2_getAllReceipts');
    const parsed = l2Parse<any>(resp.body);
    expect(parsed.result).toHaveLength(5);
  });

  test('l2_getReceipt finds receipt from any partition', async () => {
    const receipts = injectReceipts(lev, 2, 3, 1, 1n);
    const resp = await rawRpc(port, 'l2_getReceipt', { receiptId: receipts[0].receiptId });
    const parsed = l2Parse<any>(resp.body);
    expect(parsed.result).toBeDefined();
    expect(parsed.result.receiptId).toBe(receipts[0].receiptId);
  });

  test('l2_getPartitionInfo shows partition config', async () => {
    const resp = await rawRpc(port, 'l2_getPartitionInfo');
    const parsed = l2Parse<any>(resp.body);
    expect(parsed.result.partitioned).toBe(true);
    expect(parsed.result.partitionConfig.partitionCount).toBe(3);
    expect(parsed.result.l2Only).toBe(true);
  });

  test('health endpoint works with leviathan', async () => {
    lev.start();
    const resp = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/health`, (res) => {
        let data = '';
        res.on('data', (chunk: string) => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      }).on('error', reject);
    });
    const parsed = JSON.parse(resp.body);
    expect(parsed.ok).toBe(true);
    expect(parsed.running).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// 10. MULTI-LEVIATHAN SIMULATION (NO NETWORK)
// ═══════════════════════════════════════════════════════════════

describe('L2Leviathan — Multi-Leviathan Simulation', () => {
  test('three leviathans have independent partition sequencers', () => {
    const nodeIds = ['lev-0', 'lev-1', 'lev-2'];
    const levs = nodeIds.map((id, i) =>
      createLeviathan(makeConfig(3, i, nodeIds), { nodeId: id }),
    );

    // Each leads its own partition
    expect(levs[0].isLeaderFor(0)).toBe(true);
    expect(levs[1].isLeaderFor(1)).toBe(true);
    expect(levs[2].isLeaderFor(2)).toBe(true);

    // None leads others' partitions
    expect(levs[0].isLeaderFor(1)).toBe(false);
    expect(levs[1].isLeaderFor(0)).toBe(false);
  });

  test('simulated gossip: receipts propagate to correct partition', () => {
    const nodeIds = ['lev-0', 'lev-1', 'lev-2'];
    const levs = nodeIds.map((id, i) =>
      createLeviathan(makeConfig(3, i, nodeIds), { nodeId: id }),
    );

    // lev-0 "accepts" a receipt for partition 0
    const receipt = mockReceipt(1n, 0, 3);
    const auditEvent = mockAuditEvent(1n, 0, 3);
    const regRoot = INITIAL_REG_ROOT.toString();
    const lcRoot = INITIAL_LC_ROOT.toString();

    // Apply to lev-0's partition 0 sequencer
    levs[0].getSequencer(0).applyReplicatedReceipt(
      receipt, auditEvent, undefined, regRoot, lcRoot, '0',
    );

    // Simulate gossip to lev-1 and lev-2
    levs[1].getSequencer(0).applyReplicatedReceipt(
      receipt, auditEvent, undefined, regRoot, lcRoot, '0',
    );
    levs[2].getSequencer(0).applyReplicatedReceipt(
      receipt, auditEvent, undefined, regRoot, lcRoot, '0',
    );

    // All leviathans should have the receipt in partition 0
    for (const lev of levs) {
      expect(lev.getReceipt(receipt.receiptId)).toBeDefined();
      expect(lev.getSequencer(0).getAllReceipts()).toHaveLength(1);
    }
  });

  test('simulated gossip: batches propagate correctly', () => {
    const nodeIds = ['lev-0', 'lev-1', 'lev-2'];
    const levs = nodeIds.map((id, i) =>
      createLeviathan(makeConfig(3, i, nodeIds), { nodeId: id }),
    );

    // lev-1 builds a batch for partition 1
    const batch = mockBatch(1n, 1n, ['r1']);
    const block = mockBlock(1n, ['r1']);

    // Apply to all leviathans' partition 1 sequencer
    for (const lev of levs) {
      lev.getSequencer(1).applyReplicatedBatch(batch, block, [], []);
    }

    // All should have the batch
    for (const lev of levs) {
      expect(lev.getBatch(1n)).toBeDefined();
      expect(lev.getSequencer(1).getAllBatches()).toHaveLength(1);
    }
  });

  test('simulated failover: lev-1 dies, lev-2 takes partition 1', () => {
    const nodeIds = ['lev-0', 'lev-1', 'lev-2'];
    const levs = nodeIds.map((id, i) =>
      createLeviathan(makeConfig(3, i, nodeIds), { nodeId: id }),
    );

    // lev-2 promotes itself to lead partition 1 (failover from lev-1)
    levs[2].promoteToLeader(1, 'lev-1');

    // lev-2 now leads partitions 2 and 1
    expect(levs[2].isLeaderFor(1)).toBe(true);
    expect(levs[2].isLeaderFor(2)).toBe(true);
    expect(levs[2].getActiveLeaderPartitions()).toEqual([1, 2]);
  });

  test('simulated recovery: original leader reclaims partition', () => {
    const nodeIds = ['lev-0', 'lev-1', 'lev-2'];
    const levs = nodeIds.map((id, i) =>
      createLeviathan(makeConfig(3, i, nodeIds), { nodeId: id }),
    );

    // lev-2 takes over partition 1
    levs[2].promoteToLeader(1, 'lev-1');
    expect(levs[2].isLeaderFor(1)).toBe(true);

    // lev-2 demotes itself (original leader lev-1 recovers)
    levs[2].demoteFromLeader(1, 'lev-1');
    expect(levs[2].isLeaderFor(1)).toBe(false);
    expect(levs[2].getActiveLeaderPartitions()).toEqual([2]);
  });

  test('data isolation: partition 0 data not in partition 1', () => {
    const config = makeConfig(3, 0, ['a', 'b', 'c']);
    const lev = createLeviathan(config, { nodeId: 'a' });

    // Inject into partition 0 only
    injectReceipts(lev, 0, 3, 5, 1n);

    // Partition 0 has receipts
    expect(lev.getSequencer(0).getAllReceipts()).toHaveLength(5);
    // Partition 1 and 2 have none
    expect(lev.getSequencer(1).getAllReceipts()).toHaveLength(0);
    expect(lev.getSequencer(2).getAllReceipts()).toHaveLength(0);
  });

  test('idempotent replication: duplicate receipts are skipped', () => {
    const config = makeConfig(3, 0, ['a', 'b', 'c']);
    const lev = createLeviathan(config, { nodeId: 'a' });
    const seq = lev.getSequencer(0);

    const receipt = mockReceipt(1n, 0, 3);
    const auditEvent = mockAuditEvent(1n, 0, 3);
    const root = INITIAL_REG_ROOT.toString();

    // Apply twice
    seq.applyReplicatedReceipt(receipt, auditEvent, undefined, root, root, '0');
    seq.applyReplicatedReceipt(receipt, auditEvent, undefined, root, root, '0');

    expect(seq.getAllReceipts()).toHaveLength(1);
  });

  test('cross-partition read queries aggregate correctly', () => {
    const config = makeConfig(3, 0, ['a', 'b', 'c']);
    const lev = createLeviathan(config, { nodeId: 'a' });

    // 3 receipts per partition = 9 total
    injectReceipts(lev, 0, 3, 3, 1n);
    injectReceipts(lev, 1, 3, 3, 100n);
    injectReceipts(lev, 2, 3, 3, 200n);

    expect(lev.getAllReceipts()).toHaveLength(9);

    // Each partition's walletId routes correctly
    const w0 = walletForPartition(0, 3);
    const w1 = walletForPartition(1, 3);
    const w2 = walletForPartition(2, 3);
    expect(lev.getReceiptsByWallet(w0)).toHaveLength(3);
    expect(lev.getReceiptsByWallet(w1)).toHaveLength(3);
    expect(lev.getReceiptsByWallet(w2)).toHaveLength(3);
  });
});
