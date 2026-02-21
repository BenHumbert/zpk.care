/**
 * L2 Checkpoint — Persistence & Crash Recovery Tests
 *
 * All FAST tests (no ZkProgram compilation). Uses temp directories
 * for file-based checkpoint storage.
 *
 * Run: npx jest tests/l2-checkpoint.test.ts --verbose
 */
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { Field, MerkleTree } from 'o1js';
import { L2SequencerService } from '../src/l2/l2-sequencer-service.js';
import { L2Node } from '../src/l2/l2-node.js';
import {
  L2CheckpointStore,
  CHECKPOINT_VERSION,
} from '../src/l2/l2-checkpoint.js';
import type {
  L2Checkpoint,
  L2SequencerState,
  L2NodeStats,
} from '../src/l2/l2-checkpoint.js';
import { l2Stringify, l2Parse } from '../src/l2/l2-json.js';
import { InMemoryStore } from '../src/storage/local-store.js';
import { WALLET_TREE_HEIGHT } from '../src/wallets/wallet-state.js';
import { AuditService } from '../src/audit/audit-service.js';
import type { L2Receipt, L2Block, L2Batch, AdminStateDelta } from '../src/l2/l2-types.js';

// ─── Test Setup ─────────────────────────────────────────────

const emptyRegTree = new MerkleTree(WALLET_TREE_HEIGHT);
const emptyLcTree = new MerkleTree(WALLET_TREE_HEIGHT);
const INITIAL_REG_ROOT = emptyRegTree.getRoot();
const INITIAL_LC_ROOT = emptyLcTree.getRoot();

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'l2-checkpoint-test-'));
});

afterEach(async () => {
  try {
    await fs.rm(tmpDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
});

// ─── Helper: build a mock receipt ────────────────────────────

function mockReceipt(seq: bigint, isRegistration = false): L2Receipt {
  return {
    receiptId: `l2-${seq.toString().padStart(8, '0')}`,
    walletId: `wallet-${seq}`,
    sequenceNumber: seq,
    oldRegistryRoot: Field(100 + Number(seq)).toString(),
    newRegistryRoot: Field(200 + Number(seq)).toString(),
    oldLifecycleRoot: Field(300 + Number(seq)).toString(),
    newLifecycleRoot: Field(400 + Number(seq)).toString(),
    isRegistration,
    acceptedAt: Date.now(),
    l1Status: 'settled',
  };
}

function mockBlock(blockNum: bigint, receiptIds: string[]): L2Block {
  return {
    blockNumber: blockNum,
    receiptIds,
    startRegistryRoot: Field(100).toString(),
    endRegistryRoot: Field(200).toString(),
    startLifecycleRoot: Field(300).toString(),
    endLifecycleRoot: Field(400).toString(),
    registrationCount: 1,
    transitionCount: receiptIds.length,
    createdAt: Date.now(),
    l1Status: 'settled',
    l1TxHash: `sim-l1-tx-${blockNum}`,
  };
}

function mockBatch(batchNum: bigint, blockNums: bigint[]): L2Batch {
  return {
    batchNumber: batchNum,
    blockNumbers: blockNums,
    registrationCount: 1,
    transitionCount: 2,
    oldRegistryRoot: Field(100).toString(),
    newRegistryRoot: Field(200).toString(),
    oldLifecycleRoot: Field(300).toString(),
    newLifecycleRoot: Field(400).toString(),
    batchProofJson: '{"proof":"mock"}',
    createdAt: Date.now(),
    l1Status: 'settled',
    l1TxHash: `sim-l1-tx-batch-${batchNum}`,
  };
}

function makeCheckpoint(overrides?: Partial<L2Checkpoint>): L2Checkpoint {
  return {
    version: CHECKPOINT_VERSION,
    createdAt: Date.now(),
    trigger: 'batch_settled',
    lastSettledBatchNumber: 0n,
    sequencerState: {
      currentRegistryRoot: Field(200).toString(),
      currentLifecycleRoot: Field(400).toString(),
      currentWalletCount: Field(2).toString(),
      lastSettledRegistryRoot: Field(200).toString(),
      lastSettledLifecycleRoot: Field(400).toString(),
      lastSettledWalletCount: Field(2).toString(),
      nextSequenceNumber: 3n,
      nextBlockNumber: 1n,
      nextBatchNumber: 1n,
      latestChainHash: Field(999).toString(),
      inFlightBatchNumber: null,
      receipts: [mockReceipt(0n, true), mockReceipt(1n), mockReceipt(2n)],
      blocks: [mockBlock(0n, ['l2-00000000', 'l2-00000001', 'l2-00000002'])],
      batches: [mockBatch(0n, [0n])],
      auditLog: [],
      adminQueue: [],
    },
    nodeStats: {
      totalProofsAccepted: 3,
      totalBatchesBuilt: 1,
      totalBatchesSettled: 1,
      totalBatchesFailed: 0,
      nextSettlementId: 2,
    },
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════
// L2CheckpointStore — File-Based Persistence
// ═══════════════════════════════════════════════════════════

describe('L2CheckpointStore', () => {
  test('save creates checkpoint file in data directory', async () => {
    const store = new L2CheckpointStore(tmpDir);
    const checkpoint = makeCheckpoint();
    const filename = await store.save(checkpoint);

    expect(filename).toMatch(/^l2-checkpoint-\d+\.json$/);

    const files = await fs.readdir(tmpDir);
    expect(files).toContain(filename);
  });

  test('save creates data directory if it does not exist', async () => {
    const nestedDir = path.join(tmpDir, 'nested', 'deep', 'dir');
    const store = new L2CheckpointStore(nestedDir);
    const checkpoint = makeCheckpoint();

    await store.save(checkpoint);

    const files = await fs.readdir(nestedDir);
    expect(files).toHaveLength(1);
  });

  test('load reads checkpoint back from file', async () => {
    const store = new L2CheckpointStore(tmpDir);
    const original = makeCheckpoint();
    const filename = await store.save(original);

    const loaded = await store.load(filename);

    expect(loaded.version).toBe(CHECKPOINT_VERSION);
    expect(loaded.trigger).toBe('batch_settled');
    expect(loaded.sequencerState.currentRegistryRoot).toBe(
      original.sequencerState.currentRegistryRoot,
    );
    expect(loaded.nodeStats.totalProofsAccepted).toBe(3);
  });

  test('loadLatest returns null for empty directory', async () => {
    const store = new L2CheckpointStore(tmpDir);
    const result = await store.loadLatest();
    expect(result).toBeNull();
  });

  test('loadLatest returns null for non-existent directory', async () => {
    const store = new L2CheckpointStore(path.join(tmpDir, 'does-not-exist'));
    const result = await store.loadLatest();
    expect(result).toBeNull();
  });

  test('loadLatest returns the most recent checkpoint', async () => {
    const store = new L2CheckpointStore(tmpDir);

    // Save 3 checkpoints with increasing timestamps
    const cp1 = makeCheckpoint({ createdAt: 1000000000001 });
    const cp2 = makeCheckpoint({ createdAt: 1000000000002 });
    const cp3 = makeCheckpoint({ createdAt: 1000000000003 });
    cp3.nodeStats.totalProofsAccepted = 99;

    await store.save(cp1);
    await store.save(cp2);
    await store.save(cp3);

    const latest = await store.loadLatest();
    expect(latest).not.toBeNull();
    expect(latest!.nodeStats.totalProofsAccepted).toBe(99);
  });

  test('list returns sorted checkpoint filenames', async () => {
    const store = new L2CheckpointStore(tmpDir);

    await store.save(makeCheckpoint({ createdAt: 1000000000003 }));
    await store.save(makeCheckpoint({ createdAt: 1000000000001 }));
    await store.save(makeCheckpoint({ createdAt: 1000000000002 }));

    const files = await store.list();
    expect(files).toHaveLength(3);
    // Should be sorted ascending by timestamp
    expect(files[0]).toContain('1000000000001');
    expect(files[1]).toContain('1000000000002');
    expect(files[2]).toContain('1000000000003');
  });

  test('list returns empty array for non-existent directory', async () => {
    const store = new L2CheckpointStore(path.join(tmpDir, 'no-dir'));
    const files = await store.list();
    expect(files).toEqual([]);
  });

  test('list ignores non-checkpoint files', async () => {
    const store = new L2CheckpointStore(tmpDir);
    await store.save(makeCheckpoint());

    // Write some unrelated files
    await fs.writeFile(path.join(tmpDir, 'random.txt'), 'hello');
    await fs.writeFile(path.join(tmpDir, 'data.json'), '{}');

    const files = await store.list();
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^l2-checkpoint-/);
  });

  test('prune keeps the specified number of recent checkpoints', async () => {
    const store = new L2CheckpointStore(tmpDir);

    // Save 5 checkpoints
    for (let i = 1; i <= 5; i++) {
      await store.save(makeCheckpoint({ createdAt: 1000000000000 + i }));
    }

    const deleted = await store.prune(2);
    expect(deleted).toBe(3);

    const remaining = await store.list();
    expect(remaining).toHaveLength(2);
    // Should keep the 2 most recent
    expect(remaining[0]).toContain('1000000000004');
    expect(remaining[1]).toContain('1000000000005');
  });

  test('prune does nothing when fewer files than keepCount', async () => {
    const store = new L2CheckpointStore(tmpDir);
    await store.save(makeCheckpoint());

    const deleted = await store.prune(5);
    expect(deleted).toBe(0);
  });

  test('getDataDir returns configured path', () => {
    const store = new L2CheckpointStore('/some/path');
    expect(store.getDataDir()).toBe('/some/path');
  });
});

// ═══════════════════════════════════════════════════════════
// L2Checkpoint BigInt Round-Trip Serialization
// ═══════════════════════════════════════════════════════════

describe('L2Checkpoint Serialization', () => {
  test('BigInt fields survive l2Stringify/l2Parse round-trip', () => {
    const checkpoint = makeCheckpoint();
    const json = l2Stringify(checkpoint);
    const parsed = l2Parse<L2Checkpoint>(json);

    expect(parsed.lastSettledBatchNumber).toBe(0n);
    expect(parsed.sequencerState.nextSequenceNumber).toBe(3n);
    expect(parsed.sequencerState.nextBlockNumber).toBe(1n);
    expect(parsed.sequencerState.nextBatchNumber).toBe(1n);
  });

  test('receipt sequenceNumber survives round-trip', () => {
    const checkpoint = makeCheckpoint();
    const json = l2Stringify(checkpoint);
    const parsed = l2Parse<L2Checkpoint>(json);

    const receipt = parsed.sequencerState.receipts[0];
    expect(receipt.sequenceNumber).toBe(0n);
  });

  test('batch/block bigint fields survive round-trip', () => {
    const checkpoint = makeCheckpoint();
    const json = l2Stringify(checkpoint);
    const parsed = l2Parse<L2Checkpoint>(json);

    const batch = parsed.sequencerState.batches[0];
    expect(batch.batchNumber).toBe(0n);
    expect(batch.blockNumbers[0]).toBe(0n);

    const block = parsed.sequencerState.blocks[0];
    expect(block.blockNumber).toBe(0n);
  });

  test('null inFlightBatchNumber survives round-trip', () => {
    const checkpoint = makeCheckpoint();
    checkpoint.sequencerState.inFlightBatchNumber = null;

    const json = l2Stringify(checkpoint);
    const parsed = l2Parse<L2Checkpoint>(json);

    expect(parsed.sequencerState.inFlightBatchNumber).toBeNull();
  });

  test('non-null inFlightBatchNumber survives round-trip', () => {
    const checkpoint = makeCheckpoint();
    checkpoint.sequencerState.inFlightBatchNumber = 42n;

    const json = l2Stringify(checkpoint);
    const parsed = l2Parse<L2Checkpoint>(json);

    expect(parsed.sequencerState.inFlightBatchNumber).toBe(42n);
  });

  test('version field is correct', () => {
    expect(CHECKPOINT_VERSION).toBe(1);
    const checkpoint = makeCheckpoint();
    expect(checkpoint.version).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════
// L2SequencerService — Export / Restore State
// ═══════════════════════════════════════════════════════════

describe('L2SequencerService — Export / Restore', () => {
  let store: InMemoryStore;
  let service: L2SequencerService;

  beforeEach(() => {
    store = new InMemoryStore();
    service = new L2SequencerService(
      store,
      INITIAL_REG_ROOT,
      INITIAL_LC_ROOT,
      Field(0),
    );
  });

  test('exportState captures all initial state', () => {
    const state = service.exportState();

    expect(state.currentRegistryRoot).toBe(INITIAL_REG_ROOT.toString());
    expect(state.currentLifecycleRoot).toBe(INITIAL_LC_ROOT.toString());
    expect(state.currentWalletCount).toBe('0');
    expect(state.lastSettledRegistryRoot).toBe(INITIAL_REG_ROOT.toString());
    expect(state.lastSettledLifecycleRoot).toBe(INITIAL_LC_ROOT.toString());
    expect(state.lastSettledWalletCount).toBe('0');
    expect(state.nextSequenceNumber).toBe(0n);
    expect(state.nextBlockNumber).toBe(0n);
    expect(state.nextBatchNumber).toBe(0n);
    expect(state.inFlightBatchNumber).toBeNull();
    expect(state.receipts).toHaveLength(0);
    expect(state.blocks).toHaveLength(0);
    expect(state.batches).toHaveLength(0);
    expect(state.auditLog).toHaveLength(0);
    expect(state.adminQueue).toHaveLength(0);
  });

  test('exportState captures latestChainHash as genesis', () => {
    const state = service.exportState();
    expect(state.latestChainHash).toBe(
      Field(BigInt(AuditService.GENESIS_HASH)).toString(),
    );
  });

  test('restoreState uses lastSettled roots when no in-flight batch', () => {
    const settledRegRoot = Field(12345);
    const settledLcRoot = Field(67890);

    service.restoreState({
      currentRegistryRoot: Field(99999).toString(), // Advanced (stale)
      currentLifecycleRoot: Field(88888).toString(), // Advanced (stale)
      currentWalletCount: '50', // Advanced (stale)
      nextSequenceNumber: 10n,
      nextBlockNumber: 5n,
      nextBatchNumber: 3n,
      latestChainHash: Field(99999).toString(),
      inFlightBatchNumber: null,
      receipts: [],
      blocks: [],
      batches: [],
      auditLog: [],
      adminQueue: [],
      lastSettledRegistryRoot: settledRegRoot.toString(),
      lastSettledLifecycleRoot: settledLcRoot.toString(),
      lastSettledWalletCount: '42',
    });

    // Current roots should match lastSettled, NOT the stale advanced values
    expect(service.getCurrentRegistryRoot().toString()).toBe(settledRegRoot.toString());
    expect(service.getCurrentLifecycleRoot().toString()).toBe(settledLcRoot.toString());
    expect(service.getCurrentWalletCount().toString()).toBe('42');
    expect(service.getInFlightBatchNumber()).toBeNull();
    expect(service.getPendingCount()).toBe(0);
  });

  test('restoreState populates receipts map', () => {
    const receipts = [mockReceipt(0n), mockReceipt(1n)];

    service.restoreState({
      currentRegistryRoot: INITIAL_REG_ROOT.toString(),
      currentLifecycleRoot: INITIAL_LC_ROOT.toString(),
      currentWalletCount: '0',
      lastSettledRegistryRoot: INITIAL_REG_ROOT.toString(),
      lastSettledLifecycleRoot: INITIAL_LC_ROOT.toString(),
      lastSettledWalletCount: '0',
      nextSequenceNumber: 2n,
      nextBlockNumber: 0n,
      nextBatchNumber: 0n,
      latestChainHash: Field(BigInt(AuditService.GENESIS_HASH)).toString(),
      inFlightBatchNumber: null,
      receipts,
      blocks: [],
      batches: [],
      auditLog: [],
      adminQueue: [],
    });

    expect(service.getReceipt('l2-00000000')).toBeDefined();
    expect(service.getReceipt('l2-00000001')).toBeDefined();
    expect(service.getReceipt('l2-00000099')).toBeUndefined();
  });

  test('restoreState populates blocks and batches maps', () => {
    const block = mockBlock(0n, ['l2-00000000']);
    const batch = mockBatch(0n, [0n]);

    service.restoreState({
      currentRegistryRoot: INITIAL_REG_ROOT.toString(),
      currentLifecycleRoot: INITIAL_LC_ROOT.toString(),
      currentWalletCount: '0',
      lastSettledRegistryRoot: INITIAL_REG_ROOT.toString(),
      lastSettledLifecycleRoot: INITIAL_LC_ROOT.toString(),
      lastSettledWalletCount: '0',
      nextSequenceNumber: 1n,
      nextBlockNumber: 1n,
      nextBatchNumber: 1n,
      latestChainHash: Field(BigInt(AuditService.GENESIS_HASH)).toString(),
      inFlightBatchNumber: null,
      receipts: [mockReceipt(0n)],
      blocks: [block],
      batches: [batch],
      auditLog: [],
      adminQueue: [],
    });

    expect(service.getBlock(0n)).toBeDefined();
    expect(service.getBlock(99n)).toBeUndefined();
    expect(service.getBatch(0n)).toBeDefined();
    expect(service.getBatch(99n)).toBeUndefined();
  });

  test('restoreState clears pending pool', () => {
    // Even if there were pending proofs, restore clears them
    service.restoreState({
      currentRegistryRoot: INITIAL_REG_ROOT.toString(),
      currentLifecycleRoot: INITIAL_LC_ROOT.toString(),
      currentWalletCount: '0',
      lastSettledRegistryRoot: INITIAL_REG_ROOT.toString(),
      lastSettledLifecycleRoot: INITIAL_LC_ROOT.toString(),
      lastSettledWalletCount: '0',
      nextSequenceNumber: 0n,
      nextBlockNumber: 0n,
      nextBatchNumber: 0n,
      latestChainHash: Field(BigInt(AuditService.GENESIS_HASH)).toString(),
      inFlightBatchNumber: null,
      receipts: [],
      blocks: [],
      batches: [],
      auditLog: [],
      adminQueue: [],
    });

    expect(service.getPendingCount()).toBe(0);
  });

  test('export → restore → export round-trip preserves state', () => {
    // Set up non-default state with lastSettled roots matching current
    // (simulates checkpoint taken right after settlement — no pending proofs)
    service.restoreState({
      currentRegistryRoot: Field(111).toString(),
      currentLifecycleRoot: Field(222).toString(),
      currentWalletCount: '5',
      lastSettledRegistryRoot: Field(111).toString(),
      lastSettledLifecycleRoot: Field(222).toString(),
      lastSettledWalletCount: '5',
      nextSequenceNumber: 10n,
      nextBlockNumber: 3n,
      nextBatchNumber: 2n,
      latestChainHash: Field(333).toString(),
      inFlightBatchNumber: null,
      receipts: [mockReceipt(0n), mockReceipt(1n)],
      blocks: [mockBlock(0n, ['l2-00000000', 'l2-00000001'])],
      batches: [mockBatch(0n, [0n])],
      auditLog: [],
      adminQueue: [{ operationType: 'updateBenefitPlan', params: { root: '999' }, queuedAt: Date.now(), status: 'queued' }],
    });

    // Export → restore into a new service → export again
    const state1 = service.exportState();

    const service2 = new L2SequencerService(
      new InMemoryStore(),
      INITIAL_REG_ROOT,
      INITIAL_LC_ROOT,
      Field(0),
    );
    service2.restoreState(state1);
    const state2 = service2.exportState();

    // Compare key fields
    expect(state2.currentRegistryRoot).toBe(state1.currentRegistryRoot);
    expect(state2.currentLifecycleRoot).toBe(state1.currentLifecycleRoot);
    expect(state2.currentWalletCount).toBe(state1.currentWalletCount);
    expect(state2.lastSettledRegistryRoot).toBe(state1.lastSettledRegistryRoot);
    expect(state2.lastSettledLifecycleRoot).toBe(state1.lastSettledLifecycleRoot);
    expect(state2.lastSettledWalletCount).toBe(state1.lastSettledWalletCount);
    expect(state2.nextSequenceNumber).toBe(state1.nextSequenceNumber);
    expect(state2.nextBlockNumber).toBe(state1.nextBlockNumber);
    expect(state2.nextBatchNumber).toBe(state1.nextBatchNumber);
    expect(state2.latestChainHash).toBe(state1.latestChainHash);
    expect(state2.receipts).toHaveLength(state1.receipts.length);
    expect(state2.blocks).toHaveLength(state1.blocks.length);
    expect(state2.batches).toHaveLength(state1.batches.length);
    expect(state2.adminQueue).toHaveLength(state1.adminQueue.length);
  });

  test('restoreState with admin queue', () => {
    const adminOp: AdminStateDelta = {
      operationType: 'updateBenefitPlan',
      params: { newRoot: '12345' },
      queuedAt: Date.now(),
      status: 'queued',
    };

    service.restoreState({
      currentRegistryRoot: INITIAL_REG_ROOT.toString(),
      currentLifecycleRoot: INITIAL_LC_ROOT.toString(),
      currentWalletCount: '0',
      lastSettledRegistryRoot: INITIAL_REG_ROOT.toString(),
      lastSettledLifecycleRoot: INITIAL_LC_ROOT.toString(),
      lastSettledWalletCount: '0',
      nextSequenceNumber: 0n,
      nextBlockNumber: 0n,
      nextBatchNumber: 0n,
      latestChainHash: Field(BigInt(AuditService.GENESIS_HASH)).toString(),
      inFlightBatchNumber: null,
      receipts: [],
      blocks: [],
      batches: [],
      auditLog: [],
      adminQueue: [adminOp],
    });

    const ops = service.drainAdminQueue();
    expect(ops).toHaveLength(1);
    expect(ops[0].operationType).toBe('updateBenefitPlan');
  });
});

// ═══════════════════════════════════════════════════════════
// L2Node — Checkpoint Integration
// ═══════════════════════════════════════════════════════════

describe('L2Node — Checkpoint Integration', () => {
  test('exportCheckpoint produces valid checkpoint structure', () => {
    const store = new InMemoryStore();
    const node = new L2Node(
      { batchIntervalMs: 60_000, autoSettle: false, settlementDelayMs: 0 },
      store,
      INITIAL_REG_ROOT,
      INITIAL_LC_ROOT,
      Field(0),
    );

    const checkpoint = node.exportCheckpoint('manual');

    expect(checkpoint.version).toBe(CHECKPOINT_VERSION);
    expect(checkpoint.trigger).toBe('manual');
    expect(checkpoint.lastSettledBatchNumber).toBeNull();
    expect(checkpoint.sequencerState).toBeDefined();
    expect(checkpoint.sequencerState.currentRegistryRoot).toBe(
      INITIAL_REG_ROOT.toString(),
    );
    expect(checkpoint.nodeStats).toBeDefined();
    expect(checkpoint.nodeStats.totalProofsAccepted).toBe(0);
    expect(checkpoint.nodeStats.totalBatchesBuilt).toBe(0);
  });

  test('restoreFromCheckpoint restores node stats', () => {
    const store = new InMemoryStore();
    const node = new L2Node(
      { batchIntervalMs: 60_000, autoSettle: false, settlementDelayMs: 0 },
      store,
      INITIAL_REG_ROOT,
      INITIAL_LC_ROOT,
      Field(0),
    );

    const checkpoint = makeCheckpoint();
    node.restoreFromCheckpoint(checkpoint);

    const status = node.getStatus();
    expect(status.totalProofsAccepted).toBe(3);
    expect(status.totalBatchesBuilt).toBe(1);
    expect(status.totalBatchesSettled).toBe(1);
    expect(status.totalBatchesFailed).toBe(0);
  });

  test('restoreFromCheckpoint restores sequencer state', () => {
    const store = new InMemoryStore();
    const node = new L2Node(
      { batchIntervalMs: 60_000, autoSettle: false, settlementDelayMs: 0 },
      store,
      INITIAL_REG_ROOT,
      INITIAL_LC_ROOT,
      Field(0),
    );

    const checkpoint = makeCheckpoint();
    node.restoreFromCheckpoint(checkpoint);

    const seq = node.getSequencer();
    expect(seq.getCurrentRegistryRoot().toString()).toBe(
      checkpoint.sequencerState.currentRegistryRoot,
    );
    expect(seq.getCurrentLifecycleRoot().toString()).toBe(
      checkpoint.sequencerState.currentLifecycleRoot,
    );
    expect(seq.getCurrentWalletCount().toString()).toBe('2');
    expect(seq.getReceipt('l2-00000000')).toBeDefined();
    expect(seq.getBlock(0n)).toBeDefined();
    expect(seq.getBatch(0n)).toBeDefined();
  });

  test('fromCheckpoint creates a working node from checkpoint', () => {
    const store = new InMemoryStore();
    const checkpoint = makeCheckpoint();

    const node = L2Node.fromCheckpoint(checkpoint, store);

    expect(node.isRunning()).toBe(false);

    const status = node.getStatus();
    expect(status.totalProofsAccepted).toBe(3);
    expect(status.totalBatchesBuilt).toBe(1);
    expect(status.totalBatchesSettled).toBe(1);
    expect(status.currentRegistryRoot).toBe(
      checkpoint.sequencerState.currentRegistryRoot,
    );
  });

  test('fromCheckpoint accepts custom options', () => {
    const store = new InMemoryStore();
    const checkpoint = makeCheckpoint();

    const node = L2Node.fromCheckpoint(checkpoint, store, {
      batchIntervalMs: 5_000,
      autoSettle: false,
    });

    const status = node.getStatus();
    expect(status.batchIntervalMs).toBe(5_000);
  });

  test('setCheckpointStore enables auto-checkpointing', () => {
    const store = new InMemoryStore();
    const node = new L2Node(
      { batchIntervalMs: 60_000, autoSettle: false, settlementDelayMs: 0 },
      store,
      INITIAL_REG_ROOT,
      INITIAL_LC_ROOT,
      Field(0),
    );

    const cpStore = new L2CheckpointStore(tmpDir);
    node.setCheckpointStore(cpStore);

    // Should not throw — store is configured
    const checkpoint = node.exportCheckpoint('manual');
    expect(checkpoint).toBeDefined();
  });

  test('saveCheckpoint returns null when no store configured', async () => {
    const store = new InMemoryStore();
    const node = new L2Node(
      { batchIntervalMs: 60_000, autoSettle: false, settlementDelayMs: 0 },
      store,
      INITIAL_REG_ROOT,
      INITIAL_LC_ROOT,
      Field(0),
    );

    const result = await node.saveCheckpoint('manual');
    expect(result).toBeNull();
  });

  test('saveCheckpoint writes file when store configured', async () => {
    const store = new InMemoryStore();
    const node = new L2Node(
      { batchIntervalMs: 60_000, autoSettle: false, settlementDelayMs: 0 },
      store,
      INITIAL_REG_ROOT,
      INITIAL_LC_ROOT,
      Field(0),
    );

    const cpStore = new L2CheckpointStore(tmpDir);
    node.setCheckpointStore(cpStore);

    const filename = await node.saveCheckpoint('manual');
    expect(filename).not.toBeNull();

    const files = await cpStore.list();
    expect(files).toHaveLength(1);
  });

  test('saveCheckpoint prunes old files', async () => {
    const store = new InMemoryStore();
    const node = new L2Node(
      { batchIntervalMs: 60_000, autoSettle: false, settlementDelayMs: 0 },
      store,
      INITIAL_REG_ROOT,
      INITIAL_LC_ROOT,
      Field(0),
    );

    const cpStore = new L2CheckpointStore(tmpDir);
    node.setCheckpointStore(cpStore, { maxCheckpoints: 2 });

    // Save 5 checkpoints
    for (let i = 0; i < 5; i++) {
      await node.saveCheckpoint('manual');
      // Small delay to ensure different timestamps
      await new Promise((r) => setTimeout(r, 10));
    }

    const files = await cpStore.list();
    expect(files).toHaveLength(2);
  });
});

// ═══════════════════════════════════════════════════════════
// Full Crash Recovery Scenario
// ═══════════════════════════════════════════════════════════

describe('Full Crash Recovery', () => {
  test('save checkpoint → load → rebuild node → state matches', async () => {
    const store = new InMemoryStore();
    const cpStore = new L2CheckpointStore(tmpDir);

    // Phase 1: Create original node with state
    const node1 = new L2Node(
      { batchIntervalMs: 60_000, autoSettle: false, settlementDelayMs: 0 },
      store,
      INITIAL_REG_ROOT,
      INITIAL_LC_ROOT,
      Field(0),
    );
    node1.setCheckpointStore(cpStore);

    // Manually set some state via restoreFromCheckpoint
    const originalCheckpoint = makeCheckpoint();
    node1.restoreFromCheckpoint(originalCheckpoint);

    // Save checkpoint
    const filename = await node1.saveCheckpoint('batch_settled');
    expect(filename).not.toBeNull();

    // Phase 2: "Crash" — discard node1, start fresh from checkpoint
    const loaded = await cpStore.loadLatest();
    expect(loaded).not.toBeNull();

    const node2 = L2Node.fromCheckpoint(loaded!, new InMemoryStore());

    // Phase 3: Verify state matches
    const status1 = node1.getStatus();
    const status2 = node2.getStatus();

    expect(status2.totalProofsAccepted).toBe(status1.totalProofsAccepted);
    expect(status2.totalBatchesBuilt).toBe(status1.totalBatchesBuilt);
    expect(status2.totalBatchesSettled).toBe(status1.totalBatchesSettled);
    expect(status2.totalBatchesFailed).toBe(status1.totalBatchesFailed);
    expect(status2.currentRegistryRoot).toBe(status1.currentRegistryRoot);
    expect(status2.currentLifecycleRoot).toBe(status1.currentLifecycleRoot);
    expect(status2.currentWalletCount).toBe(status1.currentWalletCount);
  });

  test('recovered node can start and accept operations', async () => {
    const cpStore = new L2CheckpointStore(tmpDir);
    const checkpoint = makeCheckpoint();

    // Save checkpoint
    await cpStore.save(checkpoint);

    // Recover
    const loaded = await cpStore.loadLatest();
    const node = L2Node.fromCheckpoint(loaded!, new InMemoryStore(), {
      batchIntervalMs: 60_000,
      autoSettle: false,
      settlementDelayMs: 0,
    });

    // Node should start without errors
    node.start();
    expect(node.isRunning()).toBe(true);

    // Node should have recovered stats
    const status = node.getStatus();
    expect(status.totalProofsAccepted).toBe(3);
    expect(status.totalBatchesSettled).toBe(1);

    // Sequencer should have recovered metadata
    const seq = node.getSequencer();
    expect(seq.getReceipt('l2-00000000')).toBeDefined();
    expect(seq.getBatch(0n)).toBeDefined();

    await node.stop();
  });

  test('checkpoint file round-trip preserves audit log', async () => {
    const cpStore = new L2CheckpointStore(tmpDir);

    // Create checkpoint with audit events
    const checkpoint = makeCheckpoint();
    checkpoint.sequencerState.auditLog = [
      {
        sequenceNumber: 0n,
        receiptId: 'l2-00000000',
        walletId: 'wallet-0',
        isRegistration: true,
        oldRegistryRoot: Field(100).toString(),
        newRegistryRoot: Field(200).toString(),
        oldLifecycleRoot: Field(300).toString(),
        newLifecycleRoot: Field(400).toString(),
        eventCommitment: Field(500).toString(),
        chainHash: Field(600).toString(),
        timestamp: Date.now(),
        l1Status: 'settled',
      },
    ];

    await cpStore.save(checkpoint);
    const loaded = await cpStore.loadLatest();

    expect(loaded!.sequencerState.auditLog).toHaveLength(1);
    const event = loaded!.sequencerState.auditLog[0];
    expect(event.sequenceNumber).toBe(0n);
    expect(event.receiptId).toBe('l2-00000000');
    expect(event.isRegistration).toBe(true);
    expect(event.chainHash).toBe(Field(600).toString());
  });

  test('shutdown checkpoint is saved on graceful stop', async () => {
    const store = new InMemoryStore();
    const cpStore = new L2CheckpointStore(tmpDir);

    const node = new L2Node(
      { batchIntervalMs: 60_000, autoSettle: false, settlementDelayMs: 0 },
      store,
      INITIAL_REG_ROOT,
      INITIAL_LC_ROOT,
      Field(0),
    );
    node.setCheckpointStore(cpStore);
    node.start();

    // Stop should trigger shutdown checkpoint
    await node.stop();

    const files = await cpStore.list();
    expect(files.length).toBeGreaterThanOrEqual(1);

    const loaded = await cpStore.loadLatest();
    expect(loaded).not.toBeNull();
    expect(loaded!.trigger).toBe('shutdown');
  });

  test('lastSettledBatchNumber is correctly computed', async () => {
    const store = new InMemoryStore();
    const node = new L2Node(
      { batchIntervalMs: 60_000, autoSettle: false, settlementDelayMs: 0 },
      store,
      INITIAL_REG_ROOT,
      INITIAL_LC_ROOT,
      Field(0),
    );

    // No batches → lastSettledBatchNumber = null
    const cp1 = node.exportCheckpoint('manual');
    expect(cp1.lastSettledBatchNumber).toBeNull();

    // Restore with a settled batch
    const checkpoint = makeCheckpoint();
    node.restoreFromCheckpoint(checkpoint);

    const cp2 = node.exportCheckpoint('manual');
    expect(cp2.lastSettledBatchNumber).toBe(0n);
  });

  test('multiple recovery cycles preserve state', async () => {
    const cpStore = new L2CheckpointStore(tmpDir);

    // Round 1: Initial node
    const checkpoint1 = makeCheckpoint({
      nodeStats: {
        totalProofsAccepted: 10,
        totalBatchesBuilt: 3,
        totalBatchesSettled: 3,
        totalBatchesFailed: 0,
        nextSettlementId: 4,
      },
    });
    await cpStore.save(checkpoint1);

    // Round 2: Recover and add more state
    const loaded1 = await cpStore.loadLatest();
    const node2 = L2Node.fromCheckpoint(loaded1!, new InMemoryStore());
    node2.setCheckpointStore(cpStore);

    // Simulate more work by updating checkpoint
    const checkpoint2 = node2.exportCheckpoint('batch_settled');
    expect(checkpoint2.nodeStats.totalProofsAccepted).toBe(10);
    await cpStore.save(checkpoint2);

    // Round 3: Recover again
    const loaded2 = await cpStore.loadLatest();
    const node3 = L2Node.fromCheckpoint(loaded2!, new InMemoryStore());

    const status = node3.getStatus();
    expect(status.totalProofsAccepted).toBe(10);
    expect(status.totalBatchesBuilt).toBe(3);
    expect(status.totalBatchesSettled).toBe(3);
  });
});

// ═══════════════════════════════════════════════════════════
// C6 Fix: Crash Recovery Root Consistency
// ═══════════════════════════════════════════════════════════

describe('C6 Fix: Crash Recovery Root Consistency', () => {
  test('recovery resets current roots to lastSettled when no in-flight batch', () => {
    const store = new InMemoryStore();
    const service = new L2SequencerService(
      store,
      INITIAL_REG_ROOT,
      INITIAL_LC_ROOT,
      Field(0),
    );

    // Simulate: checkpoint was taken during graceful shutdown with
    // proofs accepted (current roots advanced) but not yet batched.
    // lastSettled roots are behind current roots.
    service.restoreState({
      currentRegistryRoot: Field(9999).toString(), // Advanced past L1
      currentLifecycleRoot: Field(8888).toString(), // Advanced past L1
      currentWalletCount: '10',                     // Advanced past L1
      lastSettledRegistryRoot: Field(1111).toString(), // Matches L1
      lastSettledLifecycleRoot: Field(2222).toString(), // Matches L1
      lastSettledWalletCount: '5',                     // Matches L1
      nextSequenceNumber: 5n,
      nextBlockNumber: 1n,
      nextBatchNumber: 1n,
      latestChainHash: Field(BigInt(AuditService.GENESIS_HASH)).toString(),
      inFlightBatchNumber: null,
      receipts: [],
      blocks: [],
      batches: [],
      auditLog: [],
      adminQueue: [],
    });

    // After recovery, current roots should be at lastSettled (matching L1)
    expect(service.getCurrentRegistryRoot().toString()).toBe(Field(1111).toString());
    expect(service.getCurrentLifecycleRoot().toString()).toBe(Field(2222).toString());
    expect(service.getCurrentWalletCount().toString()).toBe('5');
    // Pending pool is empty — clients will resubmit proofs against these roots
    expect(service.getPendingCount()).toBe(0);
  });

  test('recovery uses in-flight batch new roots when batch exists', () => {
    const store = new InMemoryStore();
    const service = new L2SequencerService(
      store,
      INITIAL_REG_ROOT,
      INITIAL_LC_ROOT,
      Field(0),
    );

    // In-flight batch transitions from lastSettled to batch.newRoots
    const inFlightBatch = mockBatch(1n, [0n]);
    inFlightBatch.l1Status = 'batched';
    inFlightBatch.newRegistryRoot = Field(5555).toString();
    inFlightBatch.newLifecycleRoot = Field(6666).toString();
    inFlightBatch.registrationCount = 2;
    delete inFlightBatch.l1TxHash;

    service.restoreState({
      currentRegistryRoot: Field(9999).toString(), // Stale advanced
      currentLifecycleRoot: Field(8888).toString(), // Stale advanced
      currentWalletCount: '20',                     // Stale advanced
      lastSettledRegistryRoot: Field(1111).toString(),
      lastSettledLifecycleRoot: Field(2222).toString(),
      lastSettledWalletCount: '3',
      nextSequenceNumber: 5n,
      nextBlockNumber: 2n,
      nextBatchNumber: 2n,
      latestChainHash: Field(BigInt(AuditService.GENESIS_HASH)).toString(),
      inFlightBatchNumber: 1n,
      receipts: [],
      blocks: [mockBlock(0n, [])],
      batches: [mockBatch(0n, [0n]), inFlightBatch],
      auditLog: [],
      adminQueue: [],
    });

    // Current roots should be at in-flight batch's new roots
    expect(service.getCurrentRegistryRoot().toString()).toBe(Field(5555).toString());
    expect(service.getCurrentLifecycleRoot().toString()).toBe(Field(6666).toString());
    // Wallet count = lastSettled + in-flight registrations
    expect(service.getCurrentWalletCount().toString()).toBe('5'); // 3 + 2
    // In-flight batch preserved for retry
    expect(service.getInFlightBatchNumber()).toBe(1n);
  });

  test('backward compat: restoreState without lastSettled fields uses current roots', () => {
    const store = new InMemoryStore();
    const service = new L2SequencerService(
      store,
      INITIAL_REG_ROOT,
      INITIAL_LC_ROOT,
      Field(0),
    );

    // Old checkpoint format — no lastSettled fields
    service.restoreState({
      currentRegistryRoot: Field(7777).toString(),
      currentLifecycleRoot: Field(8888).toString(),
      currentWalletCount: '15',
      nextSequenceNumber: 0n,
      nextBlockNumber: 0n,
      nextBatchNumber: 0n,
      latestChainHash: Field(BigInt(AuditService.GENESIS_HASH)).toString(),
      inFlightBatchNumber: null,
      receipts: [],
      blocks: [],
      batches: [],
      auditLog: [],
      adminQueue: [],
      // No lastSettled* fields — simulates old checkpoint format
    });

    // Should fall back to current roots (backward compatible)
    expect(service.getCurrentRegistryRoot().toString()).toBe(Field(7777).toString());
    expect(service.getCurrentLifecycleRoot().toString()).toBe(Field(8888).toString());
    expect(service.getCurrentWalletCount().toString()).toBe('15');
  });

  test('exportState includes lastSettled fields', () => {
    const store = new InMemoryStore();
    const service = new L2SequencerService(
      store,
      Field(1000),
      Field(2000),
      Field(5),
    );

    const state = service.exportState();

    // Initially lastSettled matches constructor values
    expect(state.lastSettledRegistryRoot).toBe(Field(1000).toString());
    expect(state.lastSettledLifecycleRoot).toBe(Field(2000).toString());
    expect(state.lastSettledWalletCount).toBe('5');
  });

  test('markBatchSettled updates lastSettled roots', () => {
    const store = new InMemoryStore();
    const service = new L2SequencerService(
      store,
      INITIAL_REG_ROOT,
      INITIAL_LC_ROOT,
      Field(0),
    );

    // Restore with a batched (in-flight) batch
    const batch = mockBatch(0n, [0n]);
    batch.l1Status = 'batched';
    batch.newRegistryRoot = Field(4444).toString();
    batch.newLifecycleRoot = Field(5555).toString();
    batch.registrationCount = 3;
    delete batch.l1TxHash;

    service.restoreState({
      currentRegistryRoot: Field(4444).toString(),
      currentLifecycleRoot: Field(5555).toString(),
      currentWalletCount: '3',
      lastSettledRegistryRoot: INITIAL_REG_ROOT.toString(),
      lastSettledLifecycleRoot: INITIAL_LC_ROOT.toString(),
      lastSettledWalletCount: '0',
      nextSequenceNumber: 3n,
      nextBlockNumber: 1n,
      nextBatchNumber: 1n,
      latestChainHash: Field(BigInt(AuditService.GENESIS_HASH)).toString(),
      inFlightBatchNumber: 0n,
      receipts: [mockReceipt(0n)],
      blocks: [mockBlock(0n, ['l2-00000000'])],
      batches: [batch],
      auditLog: [],
      adminQueue: [],
    });

    // Settle the batch
    service.markBatchSettled(0n, 'sim-l1-tx-0001');

    // lastSettled should now reflect the settled batch's new roots
    expect(service.getLastSettledRegistryRoot().toString()).toBe(Field(4444).toString());
    expect(service.getLastSettledLifecycleRoot().toString()).toBe(Field(5555).toString());
    expect(service.getLastSettledWalletCount().toString()).toBe('3');
  });
});

// ═══════════════════════════════════════════════════════════
// Edge Cases
// ═══════════════════════════════════════════════════════════

describe('Checkpoint Edge Cases', () => {
  test('checkpoint with in-flight batch preserves batch data', async () => {
    const cpStore = new L2CheckpointStore(tmpDir);

    const checkpoint = makeCheckpoint();
    // Simulate an in-flight batch (not yet settled)
    checkpoint.sequencerState.inFlightBatchNumber = 1n;
    const inFlightBatch = mockBatch(1n, [1n]);
    inFlightBatch.l1Status = 'batched'; // Not settled
    delete inFlightBatch.l1TxHash;
    checkpoint.sequencerState.batches.push(inFlightBatch);

    await cpStore.save(checkpoint);
    const loaded = await cpStore.loadLatest();

    expect(loaded!.sequencerState.inFlightBatchNumber).toBe(1n);
    expect(loaded!.sequencerState.batches).toHaveLength(2);
    const recoveredInFlight = loaded!.sequencerState.batches.find(
      (b) => b.batchNumber === 1n,
    );
    expect(recoveredInFlight).toBeDefined();
    expect(recoveredInFlight!.l1Status).toBe('batched');
    expect(recoveredInFlight!.batchProofJson).toBe('{"proof":"mock"}');
  });

  test('checkpoint with empty state is valid', async () => {
    const cpStore = new L2CheckpointStore(tmpDir);

    const checkpoint: L2Checkpoint = {
      version: CHECKPOINT_VERSION,
      createdAt: Date.now(),
      trigger: 'manual',
      lastSettledBatchNumber: null,
      sequencerState: {
        currentRegistryRoot: INITIAL_REG_ROOT.toString(),
        currentLifecycleRoot: INITIAL_LC_ROOT.toString(),
        currentWalletCount: '0',
        lastSettledRegistryRoot: INITIAL_REG_ROOT.toString(),
        lastSettledLifecycleRoot: INITIAL_LC_ROOT.toString(),
        lastSettledWalletCount: '0',
        nextSequenceNumber: 0n,
        nextBlockNumber: 0n,
        nextBatchNumber: 0n,
        latestChainHash: Field(BigInt(AuditService.GENESIS_HASH)).toString(),
        inFlightBatchNumber: null,
        receipts: [],
        blocks: [],
        batches: [],
        auditLog: [],
        adminQueue: [],
      },
      nodeStats: {
        totalProofsAccepted: 0,
        totalBatchesBuilt: 0,
        totalBatchesSettled: 0,
        totalBatchesFailed: 0,
        nextSettlementId: 1,
      },
    };

    await cpStore.save(checkpoint);
    const loaded = await cpStore.loadLatest();

    const node = L2Node.fromCheckpoint(loaded!, new InMemoryStore());
    const status = node.getStatus();
    expect(status.totalProofsAccepted).toBe(0);
    expect(status.currentRegistryRoot).toBe(INITIAL_REG_ROOT.toString());
  });

  test('large checkpoint with many receipts serializes correctly', async () => {
    const cpStore = new L2CheckpointStore(tmpDir);

    const receipts: L2Receipt[] = [];
    for (let i = 0; i < 100; i++) {
      receipts.push(mockReceipt(BigInt(i), i % 3 === 0));
    }

    const checkpoint = makeCheckpoint();
    checkpoint.sequencerState.receipts = receipts;
    checkpoint.sequencerState.nextSequenceNumber = 100n;

    await cpStore.save(checkpoint);
    const loaded = await cpStore.loadLatest();

    expect(loaded!.sequencerState.receipts).toHaveLength(100);
    expect(loaded!.sequencerState.nextSequenceNumber).toBe(100n);

    // Verify specific receipt
    const r50 = loaded!.sequencerState.receipts.find(
      (r) => r.receiptId === 'l2-00000050',
    );
    expect(r50).toBeDefined();
    expect(r50!.sequenceNumber).toBe(50n);
  });

  test('autoCheckpoint can be disabled', async () => {
    const store = new InMemoryStore();
    const cpStore = new L2CheckpointStore(tmpDir);
    const node = new L2Node(
      { batchIntervalMs: 60_000, autoSettle: false, settlementDelayMs: 0 },
      store,
      INITIAL_REG_ROOT,
      INITIAL_LC_ROOT,
      Field(0),
    );

    node.setCheckpointStore(cpStore, { autoCheckpoint: false });

    // Manual save should still work
    const filename = await node.saveCheckpoint('manual');
    expect(filename).not.toBeNull();
  });
});
