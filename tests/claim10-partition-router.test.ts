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
 * Claim 10 — Deterministic Partition Router Tests
 *
 * Tests the PartitionRouter's deterministic wallet→sequencer routing
 * with live RPC servers, reference equality of cached clients, and
 * consistency across multiple router instances.
 *
 * Patent items: 10-Y01 through 10-Y04
 *
 * Run: npx jest tests/claim10-partition-router.test.ts --verbose --forceExit
 */

import { Field, MerkleTree, Poseidon } from 'o1js';
import { InMemoryStore } from '../src/storage/local-store.js';
import { WALLET_TREE_HEIGHT } from '../src/wallets/wallet-state.js';
import { L2Leviathan } from '../src/l2/l2-leviathan.js';
import { L2RpcServer } from '../src/l2/l2-rpc-server.js';
import { L2Client } from '../src/l2/l2-client.js';
import { getPartition, PartitionRouter } from '../src/l2/l2-partition.js';
import type { LeviathanConfig } from '../src/l2/l2-leviathan-types.js';
import { EntityNodeBase } from '../src/nodes/entity-node-base.js';

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

/** Create a Leviathan + RPC server on a random port. Returns cleanup function. */
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

/** Generate N Poseidon-hashed walletIds for uniform distribution */
function generateWalletIds(count: number): string[] {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    ids.push(Poseidon.hash([Field(i + 1000)]).toString());
  }
  return ids;
}

/**
 * TestEntityNode — exposes the protected getClientForWallet for testing.
 */
class TestEntityNode extends EntityNodeBase {
  constructor(sequencerUrl: string) {
    super({ role: 'member', sequencerUrl, walletId: '12345' });
  }

  /** Public wrapper for the protected getClientForWallet */
  public getClientForWalletPublic(walletId: string): L2Client {
    return this.getClientForWallet(walletId);
  }

  /** Manually set the partition router for testing */
  public async setupRouter(router: PartitionRouter, urls: Map<number, string>): Promise<void> {
    // Use the internal partition discovery by setting up a mock
    // We access the private fields directly since this is a test-only subclass
    (this as any).partitionRouter = router;
    const clientMap = new Map<number, L2Client>();
    for (const [idx, url] of urls) {
      clientMap.set(idx, new L2Client({ sequencerUrl: url }));
    }
    (this as any).partitionClients = clientMap;
  }
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

describe('Claim 10: Deterministic Partition Router', () => {
  /**
   * 10-Y01: Live RPC routing via PartitionRouter.
   *
   * Stand up 3 Leviathans with RPC servers. Build a PartitionRouter(3)
   * with all 3 URLs. For 10 Poseidon-hashed walletIds, verify:
   *   (a) router.getSequencerUrl() returns the correct URL per getPartition()
   *   (b) l2_getStatus at that URL succeeds (RPC is reachable)
   */
  test('10-Y01: routes walletIds to correct Leviathan RPC endpoint', async () => {
    const nodeIds = ['lev-0', 'lev-1', 'lev-2'];

    // Stand up 3 Leviathans
    const ctx0 = await createTestLeviathan(3, 0, 'lev-0', nodeIds);
    const ctx1 = await createTestLeviathan(3, 1, 'lev-1', nodeIds);
    const ctx2 = await createTestLeviathan(3, 2, 'lev-2', nodeIds);
    activeContexts.push(ctx0, ctx1, ctx2);

    // Build router with all 3 URLs
    const router = new PartitionRouter(3);
    router.setPartition(0, ctx0.url);
    router.setPartition(1, ctx1.url);
    router.setPartition(2, ctx2.url);

    expect(router.isComplete()).toBe(true);

    // Generate 10 walletIds and verify routing
    const walletIds = generateWalletIds(10);
    const urlMap = new Map<string, string>([
      [ctx0.url, 'lev-0'],
      [ctx1.url, 'lev-1'],
      [ctx2.url, 'lev-2'],
    ]);

    for (const walletId of walletIds) {
      const expectedPartition = getPartition(walletId, 3);
      const url = router.getSequencerUrl(walletId);
      expect(url).toBeDefined();

      // Verify correct URL per getPartition()
      const expectedUrl = [ctx0.url, ctx1.url, ctx2.url][expectedPartition];
      expect(url).toBe(expectedUrl);

      // Verify RPC is reachable at that URL
      const client = new L2Client({ sequencerUrl: url!, adminToken: TEST_ADMIN_TOKEN });
      const status = await client.getStatus();
      expect(status).toBeDefined();
      expect(status.running).toBe(true);
    }
  });

  /**
   * 10-Y02: Incomplete router handles missing partitions gracefully.
   *
   * PartitionRouter(3) with only partitions 0 and 1 registered.
   * Wallet routing to partition 2 returns undefined.
   * isComplete() returns false.
   */
  test('10-Y02: incomplete router returns undefined for missing partitions', () => {
    const router = new PartitionRouter(3);
    router.setPartition(0, 'http://lev-0:3030');
    router.setPartition(1, 'http://lev-1:3030');

    expect(router.isComplete()).toBe(false);

    // Find a walletId that routes to partition 2
    let walletForP2: string | undefined;
    for (let i = 0; i < 1000; i++) {
      const wid = i.toString();
      if (getPartition(wid, 3) === 2) {
        walletForP2 = wid;
        break;
      }
    }
    expect(walletForP2).toBeDefined();

    const url = router.getSequencerUrl(walletForP2!);
    expect(url).toBeUndefined();

    // Partitions 0 and 1 still work
    let walletForP0: string | undefined;
    let walletForP1: string | undefined;
    for (let i = 0; i < 1000; i++) {
      const wid = i.toString();
      const p = getPartition(wid, 3);
      if (p === 0 && !walletForP0) walletForP0 = wid;
      if (p === 1 && !walletForP1) walletForP1 = wid;
      if (walletForP0 && walletForP1) break;
    }
    expect(router.getSequencerUrl(walletForP0!)).toBe('http://lev-0:3030');
    expect(router.getSequencerUrl(walletForP1!)).toBe('http://lev-1:3030');
  });

  /**
   * 10-Y03: Multiple independent routers produce identical routing.
   *
   * 3 separate PartitionRouter(5) instances with the same URLs.
   * 50 Poseidon-hashed walletIds through each — all return the same URL.
   * Proves determinism is a property of the algorithm, not router instance state.
   */
  test('10-Y03: independent router instances produce identical routing for same walletIds', () => {
    const urls = [
      'http://lev-0:3030',
      'http://lev-1:3030',
      'http://lev-2:3030',
      'http://lev-3:3030',
      'http://lev-4:3030',
    ];

    // Create 3 independent routers with same config
    const routers = [
      new PartitionRouter(5),
      new PartitionRouter(5),
      new PartitionRouter(5),
    ];
    for (const router of routers) {
      for (let i = 0; i < 5; i++) {
        router.setPartition(i, urls[i]);
      }
    }

    // 50 Poseidon-hashed walletIds
    const walletIds = generateWalletIds(50);

    for (const walletId of walletIds) {
      const url0 = routers[0].getSequencerUrl(walletId);
      const url1 = routers[1].getSequencerUrl(walletId);
      const url2 = routers[2].getSequencerUrl(walletId);

      // All 3 routers return the exact same URL
      expect(url0).toBeDefined();
      expect(url0).toBe(url1);
      expect(url0).toBe(url2);

      // And it matches direct getPartition() computation
      const expectedPartition = getPartition(walletId, 5);
      expect(url0).toBe(urls[expectedPartition]);
    }
  });

  /**
   * 10-Y04: Entity node's getClientForWallet returns cached client per partition.
   *
   * Two walletIds routing to the same partition get the same L2Client
   * instance (reference equality). Different partitions get different instances.
   */
  test('10-Y04: entity node returns same L2Client instance for same-partition wallets', async () => {
    const node = new TestEntityNode('http://fallback:3030');

    // Set up router with 3 partitions
    const router = new PartitionRouter(3);
    const urls = new Map<number, string>([
      [0, 'http://lev-0:3030'],
      [1, 'http://lev-1:3030'],
      [2, 'http://lev-2:3030'],
    ]);
    for (const [idx, url] of urls) {
      router.setPartition(idx, url);
    }
    await node.setupRouter(router, urls);

    // Find two walletIds that route to the same partition
    const walletsByPartition = new Map<number, string[]>();
    for (let i = 0; i < 100; i++) {
      const wid = i.toString();
      const p = getPartition(wid, 3);
      const existing = walletsByPartition.get(p) ?? [];
      existing.push(wid);
      walletsByPartition.set(p, existing);
    }

    // Pick a partition with at least 2 wallets (guaranteed with 100 wallets across 3 partitions)
    let targetPartition = -1;
    for (const [p, wids] of walletsByPartition) {
      if (wids.length >= 2) {
        targetPartition = p;
        break;
      }
    }
    expect(targetPartition).toBeGreaterThanOrEqual(0);

    const walletsInSamePartition = walletsByPartition.get(targetPartition)!;
    const client1 = node.getClientForWalletPublic(walletsInSamePartition[0]);
    const client2 = node.getClientForWalletPublic(walletsInSamePartition[1]);

    // Same partition → same L2Client instance (reference equality)
    expect(client1).toBe(client2);

    // Different partition → different L2Client instance
    const otherPartition = (targetPartition + 1) % 3;
    const walletsInOtherPartition = walletsByPartition.get(otherPartition)!;
    const client3 = node.getClientForWalletPublic(walletsInOtherPartition[0]);
    expect(client3).not.toBe(client1);

    // Without router, falls back to primary client
    const plainNode = new TestEntityNode('http://primary:3030');
    const fallbackClient = plainNode.getClientForWalletPublic('any-wallet');
    expect(fallbackClient).toBe(plainNode.getClient());
  });
});
