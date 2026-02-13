/**
 * L2 — Batch Settlement Fast Tests (zkpCare Chain)
 *
 * Tests BatchOutput, L2 types, L2SequencerService unit logic,
 * and root chaining validation. All FAST (no ZkProgram compilation).
 *
 * Run: npx jest tests/l2.test.ts --verbose
 */
import { Field, Poseidon, MerkleTree } from 'o1js';
import { BatchOutput } from '../src/l2/batch-program.js';
import { L2SequencerService, DEFAULT_BATCH_INTERVAL_MS, MAX_TRANSITIONS_PER_BATCH } from '../src/l2/l2-sequencer-service.js';
import { InMemoryStore } from '../src/storage/local-store.js';
import { WALLET_TREE_HEIGHT } from '../src/wallets/wallet-state.js';
import type {
  L2Receipt,
  L2Block,
  L2Batch,
  L2NodeConfig,
  AdminStateDelta,
} from '../src/l2/l2-types.js';

// ─── Test Data ──────────────────────────────────────────────

const emptyRegTree = new MerkleTree(WALLET_TREE_HEIGHT);
const emptyLcTree = new MerkleTree(WALLET_TREE_HEIGHT);
const INITIAL_REG_ROOT = emptyRegTree.getRoot();
const INITIAL_LC_ROOT = emptyLcTree.getRoot();

const rootA_reg = Field(111);
const rootB_reg = Field(222);
const rootC_reg = Field(333);
const rootA_lc = Field(444);
const rootB_lc = Field(555);
const rootC_lc = Field(666);

// ─── BatchOutput Struct ─────────────────────────────────────

describe('BatchOutput Struct', () => {
  test('creates BatchOutput with all 6 fields', () => {
    const output = new BatchOutput({
      oldRegistryRoot: rootA_reg,
      newRegistryRoot: rootB_reg,
      oldLifecycleRoot: rootA_lc,
      newLifecycleRoot: rootB_lc,
      registrationCount: Field(3),
      transitionCount: Field(10),
    });

    expect(output.oldRegistryRoot.toString()).toBe(rootA_reg.toString());
    expect(output.newRegistryRoot.toString()).toBe(rootB_reg.toString());
    expect(output.oldLifecycleRoot.toString()).toBe(rootA_lc.toString());
    expect(output.newLifecycleRoot.toString()).toBe(rootB_lc.toString());
    expect(output.registrationCount.toString()).toBe('3');
    expect(output.transitionCount.toString()).toBe('10');
  });

  test('BatchOutput with zero registrations', () => {
    const output = new BatchOutput({
      oldRegistryRoot: rootA_reg,
      newRegistryRoot: rootB_reg,
      oldLifecycleRoot: rootA_lc,
      newLifecycleRoot: rootA_lc, // lifecycle unchanged = no registration
      registrationCount: Field(0),
      transitionCount: Field(5),
    });

    expect(output.registrationCount.toString()).toBe('0');
    expect(output.transitionCount.toString()).toBe('5');
  });

  test('BatchOutput with multiple registrations', () => {
    const output = new BatchOutput({
      oldRegistryRoot: rootA_reg,
      newRegistryRoot: rootC_reg,
      oldLifecycleRoot: rootA_lc,
      newLifecycleRoot: rootC_lc,
      registrationCount: Field(42),
      transitionCount: Field(100),
    });

    expect(output.registrationCount.toString()).toBe('42');
    expect(output.transitionCount.toString()).toBe('100');
  });
});

// ─── L2 Types ───────────────────────────────────────────────

describe('L2 Types', () => {
  test('L2Receipt fields correctly typed', () => {
    const receipt: L2Receipt = {
      receiptId: 'l2-00000001',
      walletId: '12345678901234567890',
      sequenceNumber: 1n,
      oldRegistryRoot: rootA_reg.toString(),
      newRegistryRoot: rootB_reg.toString(),
      oldLifecycleRoot: rootA_lc.toString(),
      newLifecycleRoot: rootB_lc.toString(),
      isRegistration: true,
      acceptedAt: Date.now(),
      l1Status: 'pending',
    };

    expect(receipt.receiptId).toBe('l2-00000001');
    expect(receipt.isRegistration).toBe(true);
    expect(receipt.l1Status).toBe('pending');
    expect(receipt.l2BlockNumber).toBeUndefined();
    expect(receipt.l1BatchNumber).toBeUndefined();
  });

  test('L2Block tracks start/end roots', () => {
    const block: L2Block = {
      blockNumber: 0n,
      receiptIds: ['l2-00000001', 'l2-00000002'],
      startRegistryRoot: rootA_reg.toString(),
      endRegistryRoot: rootC_reg.toString(),
      startLifecycleRoot: rootA_lc.toString(),
      endLifecycleRoot: rootC_lc.toString(),
      registrationCount: 2,
      transitionCount: 2,
      createdAt: Date.now(),
      l1Status: 'batched',
    };

    expect(block.blockNumber).toBe(0n);
    expect(block.receiptIds).toHaveLength(2);
    expect(block.registrationCount).toBe(2);
    expect(block.l1TxHash).toBeUndefined();
  });

  test('L2Batch contains proof JSON placeholder', () => {
    const batch: L2Batch = {
      batchNumber: 0n,
      blockNumbers: [0n],
      registrationCount: 2,
      transitionCount: 5,
      oldRegistryRoot: rootA_reg.toString(),
      newRegistryRoot: rootC_reg.toString(),
      oldLifecycleRoot: rootA_lc.toString(),
      newLifecycleRoot: rootC_lc.toString(),
      batchProofJson: '{"proof":"..."}',
      createdAt: Date.now(),
      l1Status: 'batched',
    };

    expect(batch.batchNumber).toBe(0n);
    expect(batch.batchProofJson).toContain('proof');
    expect(batch.l1Status).toBe('batched');
  });

  test('AdminStateDelta queues operations', () => {
    const delta: AdminStateDelta = {
      operationType: 'updateBenefitPlan',
      params: { newRoot: '12345' },
      queuedAt: Date.now(),
      status: 'queued',
    };

    expect(delta.operationType).toBe('updateBenefitPlan');
    expect(delta.status).toBe('queued');
    expect(delta.params.newRoot).toBe('12345');
  });

  test('L2NodeConfig defines node capabilities', () => {
    const config: L2NodeConfig = {
      walletId: '999888777666555444',
      entityType: 'pharmacy',
      sequencerUrl: 'https://l2.zkpcare.io',
      batchIntervalMs: 180_000,
      l1RpcUrl: 'https://mina.example.com',
      l1FallbackMode: true,
      maxL2Retries: 3,
    };

    expect(config.entityType).toBe('pharmacy');
    expect(config.l1FallbackMode).toBe(true);
    expect(config.batchIntervalMs).toBe(180_000);
  });
});

// ─── L2SequencerService Unit Tests ──────────────────────────

describe('L2SequencerService', () => {
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

  test('constructor initializes with correct initial state', () => {
    expect(service.getCurrentRegistryRoot().toString()).toBe(
      INITIAL_REG_ROOT.toString(),
    );
    expect(service.getCurrentLifecycleRoot().toString()).toBe(
      INITIAL_LC_ROOT.toString(),
    );
    expect(service.getCurrentWalletCount().toString()).toBe('0');
    expect(service.getPendingCount()).toBe(0);
    expect(service.getBatchIntervalMs()).toBe(DEFAULT_BATCH_INTERVAL_MS);
  });

  test('constructor accepts custom batch interval', () => {
    const custom = new L2SequencerService(
      store,
      INITIAL_REG_ROOT,
      INITIAL_LC_ROOT,
      Field(0),
      60_000,
    );
    expect(custom.getBatchIntervalMs()).toBe(60_000);
  });

  test('buildBatch returns null when no pending proofs', async () => {
    const result = await service.buildBatch();
    expect(result).toBeNull();
  });

  test('drainAdminQueue returns operations and clears queue', () => {
    const delta1: AdminStateDelta = {
      operationType: 'updateBenefitPlan',
      params: { newRoot: '111' },
      queuedAt: Date.now(),
      status: 'queued',
    };
    const delta2: AdminStateDelta = {
      operationType: 'registerGlobalNft',
      params: { commitment: '222' },
      queuedAt: Date.now(),
      status: 'queued',
    };

    service.queueAdminOperation(delta1);
    service.queueAdminOperation(delta2);

    const ops = service.drainAdminQueue();
    expect(ops).toHaveLength(2);
    expect(ops[0].operationType).toBe('updateBenefitPlan');
    expect(ops[1].operationType).toBe('registerGlobalNft');

    // Queue should be empty now
    const ops2 = service.drainAdminQueue();
    expect(ops2).toHaveLength(0);
  });

  test('getReceipt returns undefined for unknown receipt', () => {
    expect(service.getReceipt('nonexistent')).toBeUndefined();
  });

  test('getBlock returns undefined for unknown block', () => {
    expect(service.getBlock(999n)).toBeUndefined();
  });

  test('getBatch returns undefined for unknown batch', () => {
    expect(service.getBatch(999n)).toBeUndefined();
  });
});

// ─── Batch Failure & Retry ─────────────────────────────────

describe('L2SequencerService — Batch Failure & Retry', () => {
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

  test('getInFlightBatchNumber starts as null', () => {
    expect(service.getInFlightBatchNumber()).toBeNull();
  });

  test('markBatchFailed throws for unknown batch', () => {
    expect(() => service.markBatchFailed(999n, 'L1 timeout'))
      .toThrow('Batch 999 not found');
  });

  test('retryBatch throws for unknown batch', () => {
    expect(() => service.retryBatch(999n))
      .toThrow('Batch 999 not found');
  });

  test('buildBatch returns null with no pending and no in-flight', async () => {
    // Verify in-flight guard doesn't interfere with the empty-pool case
    expect(service.getInFlightBatchNumber()).toBeNull();
    const result = await service.buildBatch();
    expect(result).toBeNull();
    expect(service.getInFlightBatchNumber()).toBeNull();
  });
});

// ─── Root Chaining Logic (Off-Circuit) ──────────────────────

describe('Root Chaining Logic', () => {
  test('merge A→B + B→C = A→C (off-circuit validation)', () => {
    // Simulate two sequential BatchOutputs
    const left = new BatchOutput({
      oldRegistryRoot: rootA_reg,
      newRegistryRoot: rootB_reg,
      oldLifecycleRoot: rootA_lc,
      newLifecycleRoot: rootB_lc,
      registrationCount: Field(1),
      transitionCount: Field(3),
    });

    const right = new BatchOutput({
      oldRegistryRoot: rootB_reg, // Must match left.new
      newRegistryRoot: rootC_reg,
      oldLifecycleRoot: rootB_lc, // Must match left.new
      newLifecycleRoot: rootC_lc,
      registrationCount: Field(2),
      transitionCount: Field(4),
    });

    // Verify chain: left.new == right.old
    expect(left.newRegistryRoot.toString()).toBe(
      right.oldRegistryRoot.toString(),
    );
    expect(left.newLifecycleRoot.toString()).toBe(
      right.oldLifecycleRoot.toString(),
    );

    // Merged result: A→C
    expect(left.oldRegistryRoot.toString()).toBe(rootA_reg.toString());
    expect(right.newRegistryRoot.toString()).toBe(rootC_reg.toString());
    expect(left.oldLifecycleRoot.toString()).toBe(rootA_lc.toString());
    expect(right.newLifecycleRoot.toString()).toBe(rootC_lc.toString());
  });

  test('registration count sums correctly across merges', () => {
    const left = new BatchOutput({
      oldRegistryRoot: rootA_reg,
      newRegistryRoot: rootB_reg,
      oldLifecycleRoot: rootA_lc,
      newLifecycleRoot: rootB_lc,
      registrationCount: Field(5),
      transitionCount: Field(10),
    });

    const right = new BatchOutput({
      oldRegistryRoot: rootB_reg,
      newRegistryRoot: rootC_reg,
      oldLifecycleRoot: rootB_lc,
      newLifecycleRoot: rootC_lc,
      registrationCount: Field(3),
      transitionCount: Field(7),
    });

    const mergedRegCount = left.registrationCount.add(
      right.registrationCount,
    );
    expect(mergedRegCount.toString()).toBe('8');
  });

  test('transition count sums correctly across merges', () => {
    const left = new BatchOutput({
      oldRegistryRoot: rootA_reg,
      newRegistryRoot: rootB_reg,
      oldLifecycleRoot: rootA_lc,
      newLifecycleRoot: rootB_lc,
      registrationCount: Field(0),
      transitionCount: Field(15),
    });

    const right = new BatchOutput({
      oldRegistryRoot: rootB_reg,
      newRegistryRoot: rootC_reg,
      oldLifecycleRoot: rootB_lc,
      newLifecycleRoot: rootC_lc,
      registrationCount: Field(0),
      transitionCount: Field(25),
    });

    const mergedTxCount = left.transitionCount.add(right.transitionCount);
    expect(mergedTxCount.toString()).toBe('40');
  });
});

// ─── Constants & Exports ────────────────────────────────────

describe('L2 Constants', () => {
  test('DEFAULT_BATCH_INTERVAL_MS is 3 minutes', () => {
    expect(DEFAULT_BATCH_INTERVAL_MS).toBe(180_000);
  });

  test('MAX_TRANSITIONS_PER_BATCH is 1024', () => {
    expect(MAX_TRANSITIONS_PER_BATCH).toBe(1024);
  });
});
