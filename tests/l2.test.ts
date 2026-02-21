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
import type { AdminStateConfig } from '../src/l2/l2-sequencer-service.js';
import { InMemoryStore } from '../src/storage/local-store.js';
import { WALLET_TREE_HEIGHT } from '../src/wallets/wallet-state.js';
import { computeGlobalStateRoot } from '../src/l2/global-state.js';
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
      operationType: 'registerGlobalCredential',
      params: { commitment: '222' },
      queuedAt: Date.now(),
      status: 'queued',
    };

    service.queueAdminOperation(delta1);
    service.queueAdminOperation(delta2);

    const ops = service.drainAdminQueue();
    expect(ops).toHaveLength(2);
    expect(ops[0].operationType).toBe('updateBenefitPlan');
    expect(ops[1].operationType).toBe('registerGlobalCredential');

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

// ─── H3 Fix: Settlement Failure Rollback & Retry Root Management ──

describe('H3 — Settlement Failure Rollback', () => {
  let store: InMemoryStore;
  let service: L2SequencerService;

  // Helper to inject a fake batch into the service's private state
  function injectBatch(svc: L2SequencerService, batch: L2Batch): void {
    const s = svc as any;
    s.batches.set(batch.batchNumber, batch);
    s.inFlightBatchNumber = batch.batchNumber;
    // Advance current roots to batch end-state (simulates submitProof having run)
    s.currentRegistryRoot = Field(BigInt(batch.newRegistryRoot));
    s.currentLifecycleRoot = Field(BigInt(batch.newLifecycleRoot));
    s.currentWalletCount = Field(
      s.lastSettledWalletCount.toBigInt() + BigInt(batch.registrationCount),
    );
  }

  function makeBatch(overrides?: Partial<L2Batch>): L2Batch {
    return {
      batchNumber: 0n,
      blockNumbers: [0n],
      registrationCount: 2,
      transitionCount: 5,
      oldRegistryRoot: INITIAL_REG_ROOT.toString(),
      newRegistryRoot: rootA_reg.toString(),
      oldLifecycleRoot: INITIAL_LC_ROOT.toString(),
      newLifecycleRoot: rootA_lc.toString(),
      batchProofJson: '{"proof":"fake"}',
      createdAt: Date.now(),
      l1Status: 'batched' as const,
      ...overrides,
    };
  }

  beforeEach(() => {
    store = new InMemoryStore();
    service = new L2SequencerService(
      store,
      INITIAL_REG_ROOT,
      INITIAL_LC_ROOT,
      Field(0),
    );
  });

  test('markBatchFailed rolls back current roots to last-settled state', () => {
    const batch = makeBatch();
    injectBatch(service, batch);

    // Current roots should be at batch end-state
    expect(service.getCurrentRegistryRoot().toString()).toBe(rootA_reg.toString());
    expect(service.getCurrentLifecycleRoot().toString()).toBe(rootA_lc.toString());
    expect(service.getCurrentWalletCount().toString()).toBe('2');

    // Fail the batch
    service.markBatchFailed(0n, 'L1 timeout');

    // After failure, roots must revert to initial (last-settled) state
    expect(service.getCurrentRegistryRoot().toString()).toBe(INITIAL_REG_ROOT.toString());
    expect(service.getCurrentLifecycleRoot().toString()).toBe(INITIAL_LC_ROOT.toString());
    expect(service.getCurrentWalletCount().toString()).toBe('0');
  });

  test('markBatchFailed clears in-flight batch number', () => {
    const batch = makeBatch();
    injectBatch(service, batch);

    expect(service.getInFlightBatchNumber()).toBe(0n);
    service.markBatchFailed(0n, 'nonce error');
    expect(service.getInFlightBatchNumber()).toBeNull();
  });

  test('retryBatch fast-forwards current roots to batch end-state', () => {
    const batch = makeBatch();
    injectBatch(service, batch);

    // Fail first
    service.markBatchFailed(0n, 'L1 timeout');

    // Roots are now at initial (rolled back)
    expect(service.getCurrentRegistryRoot().toString()).toBe(INITIAL_REG_ROOT.toString());

    // Retry should fast-forward roots back to batch end-state
    const retried = service.retryBatch(0n);

    expect(service.getCurrentRegistryRoot().toString()).toBe(rootA_reg.toString());
    expect(service.getCurrentLifecycleRoot().toString()).toBe(rootA_lc.toString());
    expect(service.getCurrentWalletCount().toString()).toBe('2');
    expect(service.getInFlightBatchNumber()).toBe(0n);
    expect(retried.l1Status).toBe('batched');
  });

  test('retryBatch throws for non-failed batch', () => {
    const batch = makeBatch({ l1Status: 'batched' });
    injectBatch(service, batch);

    expect(() => service.retryBatch(0n)).toThrow('not in failed state');
  });

  test('markBatchFailed preserves last-settled roots across multiple fail/retry cycles', () => {
    const batch = makeBatch();
    injectBatch(service, batch);

    // Fail → retry → fail → verify roots still correct
    service.markBatchFailed(0n, 'attempt 1');
    expect(service.getCurrentRegistryRoot().toString()).toBe(INITIAL_REG_ROOT.toString());

    service.retryBatch(0n);
    expect(service.getCurrentRegistryRoot().toString()).toBe(rootA_reg.toString());

    service.markBatchFailed(0n, 'attempt 2');
    expect(service.getCurrentRegistryRoot().toString()).toBe(INITIAL_REG_ROOT.toString());
    expect(service.getCurrentLifecycleRoot().toString()).toBe(INITIAL_LC_ROOT.toString());
    expect(service.getCurrentWalletCount().toString()).toBe('0');
  });

  test('markBatchFailed after settle uses updated last-settled roots', () => {
    // Simulate first batch settled successfully
    const batch1 = makeBatch({
      batchNumber: 0n,
      newRegistryRoot: rootA_reg.toString(),
      newLifecycleRoot: rootA_lc.toString(),
      registrationCount: 1,
    });
    injectBatch(service, batch1);
    service.markBatchSettled(0n, '0xabc');

    // Now last-settled roots are at rootA
    expect(service.getCurrentRegistryRoot().toString()).toBe(rootA_reg.toString());

    // Second batch moves to rootB
    const batch2 = makeBatch({
      batchNumber: 1n,
      oldRegistryRoot: rootA_reg.toString(),
      newRegistryRoot: rootB_reg.toString(),
      oldLifecycleRoot: rootA_lc.toString(),
      newLifecycleRoot: rootB_lc.toString(),
      registrationCount: 3,
    });
    const s = service as any;
    s.batches.set(1n, batch2);
    s.inFlightBatchNumber = 1n;
    s.currentRegistryRoot = rootB_reg;
    s.currentLifecycleRoot = rootB_lc;
    s.currentWalletCount = Field(1n + 3n); // lastSettled(1) + batch2(3)

    // Fail batch 2 → should roll back to rootA (last settled), not initial
    service.markBatchFailed(1n, 'L1 reorg');

    expect(service.getCurrentRegistryRoot().toString()).toBe(rootA_reg.toString());
    expect(service.getCurrentLifecycleRoot().toString()).toBe(rootA_lc.toString());
    // walletCount should be back to 1 (from batch1 settlement)
    expect(service.getCurrentWalletCount().toString()).toBe('1');
  });
});

// ─── H4 Fix: L1 Sync After Direct Settlement ──────────────

describe('H4 — syncFromL1', () => {
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

  test('syncFromL1 updates both current and last-settled roots', () => {
    service.syncFromL1(rootA_reg, rootA_lc, Field(10));

    expect(service.getCurrentRegistryRoot().toString()).toBe(rootA_reg.toString());
    expect(service.getCurrentLifecycleRoot().toString()).toBe(rootA_lc.toString());
    expect(service.getCurrentWalletCount().toString()).toBe('10');
  });

  test('syncFromL1 clears in-flight batch', () => {
    // Inject a fake in-flight batch
    const batch: L2Batch = {
      batchNumber: 0n,
      blockNumbers: [0n],
      registrationCount: 1,
      transitionCount: 1,
      oldRegistryRoot: INITIAL_REG_ROOT.toString(),
      newRegistryRoot: rootA_reg.toString(),
      oldLifecycleRoot: INITIAL_LC_ROOT.toString(),
      newLifecycleRoot: rootA_lc.toString(),
      batchProofJson: '{"proof":"fake"}',
      createdAt: Date.now(),
      l1Status: 'batched',
    };
    const s = service as any;
    s.batches.set(0n, batch);
    s.inFlightBatchNumber = 0n;

    expect(service.getInFlightBatchNumber()).toBe(0n);

    // Sync from L1 — in-flight batch should be invalidated
    service.syncFromL1(rootB_reg, rootB_lc, Field(5));

    expect(service.getInFlightBatchNumber()).toBeNull();
    expect(batch.l1Status).toBe('failed');
    expect(batch.failureReason).toBe('Invalidated by L1 sync');
  });

  test('syncFromL1 drains pending pool', () => {
    // Inject fake pending items
    const s = service as any;
    s.pendingPool = [{ seq: 0 }, { seq: 1 }];
    expect(s.pendingPool).toHaveLength(2);

    service.syncFromL1(rootA_reg, rootA_lc, Field(3));

    expect(s.pendingPool).toHaveLength(0);
  });

  test('after syncFromL1, markBatchFailed rolls back to synced roots', () => {
    // First sync to rootA
    service.syncFromL1(rootA_reg, rootA_lc, Field(5));

    // Now inject a batch that advances to rootB
    const batch: L2Batch = {
      batchNumber: 1n,
      blockNumbers: [1n],
      registrationCount: 2,
      transitionCount: 3,
      oldRegistryRoot: rootA_reg.toString(),
      newRegistryRoot: rootB_reg.toString(),
      oldLifecycleRoot: rootA_lc.toString(),
      newLifecycleRoot: rootB_lc.toString(),
      batchProofJson: '{"proof":"fake"}',
      createdAt: Date.now(),
      l1Status: 'batched',
    };
    const s = service as any;
    s.batches.set(1n, batch);
    s.inFlightBatchNumber = 1n;
    s.currentRegistryRoot = rootB_reg;
    s.currentLifecycleRoot = rootB_lc;
    s.currentWalletCount = Field(7n);

    // Fail the batch — should roll back to rootA (the synced state)
    service.markBatchFailed(1n, 'L1 reorg');

    expect(service.getCurrentRegistryRoot().toString()).toBe(rootA_reg.toString());
    expect(service.getCurrentLifecycleRoot().toString()).toBe(rootA_lc.toString());
    expect(service.getCurrentWalletCount().toString()).toBe('5');
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

// ─── AdminStateConfig & Chain Proof Integration ──────────────

describe('L2SequencerService — AdminState & ChainProof', () => {
  let store: InMemoryStore;
  let service: L2SequencerService;

  const adminConfig: AdminStateConfig = {
    adminPublicKeyHash: Field(1000),
    benefitPlanRoot: Field(2000),
    credentialRegistryRoot: Field(3000),
    eligibilityVkHash: Field(4000),
    messagingRoot: Field(5000),
  };

  beforeEach(() => {
    store = new InMemoryStore();
    service = new L2SequencerService(
      store,
      INITIAL_REG_ROOT,
      INITIAL_LC_ROOT,
      Field(0),
    );
  });

  test('isChainProofEnabled returns false by default', () => {
    expect(service.isChainProofEnabled()).toBe(false);
  });

  test('getAdminState returns null by default', () => {
    expect(service.getAdminState()).toBeNull();
  });

  test('setAdminState enables chain proofs', () => {
    service.setAdminState(adminConfig);
    expect(service.isChainProofEnabled()).toBe(true);
  });

  test('getAdminState returns a copy of the config', () => {
    service.setAdminState(adminConfig);
    const config = service.getAdminState();
    expect(config).not.toBeNull();
    expect(config!.adminPublicKeyHash.toString()).toBe('1000');
    expect(config!.benefitPlanRoot.toString()).toBe('2000');
    expect(config!.credentialRegistryRoot.toString()).toBe('3000');
    expect(config!.eligibilityVkHash.toString()).toBe('4000');
    expect(config!.messagingRoot.toString()).toBe('5000');
  });

  test('updateAdminField updates a single field', () => {
    service.setAdminState(adminConfig);
    service.updateAdminField('benefitPlanRoot', Field(9999));
    const config = service.getAdminState();
    expect(config!.benefitPlanRoot.toString()).toBe('9999');
    // Other fields unchanged
    expect(config!.adminPublicKeyHash.toString()).toBe('1000');
  });

  test('updateAdminField throws when admin state not configured', () => {
    expect(() => service.updateAdminField('benefitPlanRoot', Field(9999)))
      .toThrow('Admin state not configured');
  });

  test('chain state getters return defaults before chain proofs', () => {
    expect(service.getCurrentGlobalStateRoot().toString()).toBe('0');
    expect(service.getCurrentBlockHeight().toString()).toBe('0');
    expect(service.getLatestChainProofJson()).toBeNull();
  });

  test('buildBatch returns null when no pending (chain proofs enabled)', async () => {
    service.setAdminState(adminConfig);
    const result = await service.buildBatch();
    expect(result).toBeNull();
  });
});

// ─── Checkpoint with Chain State ────────────────────────────

describe('L2SequencerService — Checkpoint with Chain State', () => {
  let store: InMemoryStore;

  const adminConfig: AdminStateConfig = {
    adminPublicKeyHash: Field(1000),
    benefitPlanRoot: Field(2000),
    credentialRegistryRoot: Field(3000),
    eligibilityVkHash: Field(4000),
    messagingRoot: Field(5000),
  };

  test('exportState includes adminState when set', () => {
    store = new InMemoryStore();
    const service = new L2SequencerService(store, INITIAL_REG_ROOT, INITIAL_LC_ROOT, Field(0));
    service.setAdminState(adminConfig);

    const state = service.exportState();
    expect(state.adminState).toBeDefined();
    expect(state.adminState!.adminPublicKeyHash).toBe('1000');
    expect(state.adminState!.benefitPlanRoot).toBe('2000');
    expect(state.adminState!.credentialRegistryRoot).toBe('3000');
    expect(state.adminState!.eligibilityVkHash).toBe('4000');
    expect(state.adminState!.messagingRoot).toBe('5000');
    expect(state.latestChainProofJson).toBeNull();
    expect(state.currentBlockHeight).toBe('0');
    expect(state.currentGlobalStateRoot).toBe('0');
  });

  test('exportState omits adminState when not set', () => {
    store = new InMemoryStore();
    const service = new L2SequencerService(store, INITIAL_REG_ROOT, INITIAL_LC_ROOT, Field(0));

    const state = service.exportState();
    expect(state.adminState).toBeUndefined();
    expect(state.latestChainProofJson).toBeUndefined();
    expect(state.currentBlockHeight).toBeUndefined();
  });

  test('restoreState rebuilds admin state from checkpoint', () => {
    store = new InMemoryStore();
    const service1 = new L2SequencerService(store, INITIAL_REG_ROOT, INITIAL_LC_ROOT, Field(0));
    service1.setAdminState(adminConfig);
    const exported = service1.exportState();

    // Restore into a fresh service
    const service2 = new L2SequencerService(store, Field(0), Field(0), Field(0));
    service2.restoreState(exported);

    expect(service2.isChainProofEnabled()).toBe(true);
    const config = service2.getAdminState();
    expect(config!.adminPublicKeyHash.toString()).toBe('1000');
    expect(config!.benefitPlanRoot.toString()).toBe('2000');
    expect(service2.getCurrentBlockHeight().toString()).toBe('0');
    expect(service2.getCurrentGlobalStateRoot().toString()).toBe('0');
    // latestChainProof object is null after restore (proof objects aren't serializable)
    expect(service2.getLatestChainProofJson()).toBeNull();
  });

  test('restoreState without admin state does not enable chain proofs', () => {
    store = new InMemoryStore();
    const service1 = new L2SequencerService(store, INITIAL_REG_ROOT, INITIAL_LC_ROOT, Field(0));
    const exported = service1.exportState();

    const service2 = new L2SequencerService(store, Field(0), Field(0), Field(0));
    service2.restoreState(exported);

    expect(service2.isChainProofEnabled()).toBe(false);
    expect(service2.getAdminState()).toBeNull();
  });
});

// ─── L2Batch Chain Fields ───────────────────────────────────

describe('L2Batch — Chain Proof Fields', () => {
  test('L2Batch accepts optional chain proof fields', () => {
    const batch: L2Batch = {
      batchNumber: 0n,
      blockNumbers: [0n],
      registrationCount: 1,
      transitionCount: 1,
      oldRegistryRoot: rootA_reg.toString(),
      newRegistryRoot: rootB_reg.toString(),
      oldLifecycleRoot: rootA_lc.toString(),
      newLifecycleRoot: rootB_lc.toString(),
      batchProofJson: '{"proof":"..."}',
      chainProofJson: '{"chain":"..."}',
      globalStateRoot: Poseidon.hash([Field(42)]).toString(),
      blockHeight: 0n,
      createdAt: Date.now(),
      l1Status: 'batched',
    };

    expect(batch.chainProofJson).toBe('{"chain":"..."}');
    expect(batch.globalStateRoot).toBeDefined();
    expect(batch.blockHeight).toBe(0n);
  });

  test('L2Batch works without chain proof fields (backward compatible)', () => {
    const batch: L2Batch = {
      batchNumber: 0n,
      blockNumbers: [0n],
      registrationCount: 1,
      transitionCount: 1,
      oldRegistryRoot: rootA_reg.toString(),
      newRegistryRoot: rootB_reg.toString(),
      oldLifecycleRoot: rootA_lc.toString(),
      newLifecycleRoot: rootB_lc.toString(),
      batchProofJson: '{"proof":"..."}',
      createdAt: Date.now(),
      l1Status: 'batched',
    };

    expect(batch.chainProofJson).toBeUndefined();
    expect(batch.globalStateRoot).toBeUndefined();
    expect(batch.blockHeight).toBeUndefined();
  });
});

// ─── Constants & Exports ────────────────────────────────────

describe('L2 Constants', () => {
  test('DEFAULT_BATCH_INTERVAL_MS is 3 minutes', () => {
    expect(DEFAULT_BATCH_INTERVAL_MS).toBe(180_000);
  });

  test('MAX_TRANSITIONS_PER_BATCH is 4', () => {
    expect(MAX_TRANSITIONS_PER_BATCH).toBe(4);
  });
});

// ─── L2-Only Mode ───────────────────────────────────────────

describe('L2SequencerService — L2-Only Mode', () => {
  let store: InMemoryStore;
  let service: L2SequencerService;

  beforeEach(() => {
    store = new InMemoryStore();
    service = new L2SequencerService(
      store,
      INITIAL_REG_ROOT,
      INITIAL_LC_ROOT,
      Field(0),
      DEFAULT_BATCH_INTERVAL_MS,
      true, // l2Only
    );
  });

  test('isL2Only returns true when constructed with l2Only=true', () => {
    expect(service.isL2Only()).toBe(true);
  });

  test('isL2Only returns false by default', () => {
    const defaultService = new L2SequencerService(
      store, INITIAL_REG_ROOT, INITIAL_LC_ROOT, Field(0),
    );
    expect(defaultService.isL2Only()).toBe(false);
  });

  test('syncFromL1 throws in L2-only mode', () => {
    expect(() => service.syncFromL1(rootA_reg, rootA_lc, Field(10)))
      .toThrow('L2-only mode: no L1 sync available');
  });

  test('markBatchSettled throws in L2-only mode', () => {
    expect(() => service.markBatchSettled(0n, '0xabc'))
      .toThrow('L2-only mode');
  });

  test('markBatchFailed throws in L2-only mode', () => {
    expect(() => service.markBatchFailed(0n, 'timeout'))
      .toThrow('L2-only mode');
  });

  test('retryBatch throws in L2-only mode', () => {
    expect(() => service.retryBatch(0n))
      .toThrow('L2-only mode');
  });

  test('exportState includes l2Only flag', () => {
    const state = service.exportState();
    expect(state.l2Only).toBe(true);
  });

  test('restoreState preserves l2Only flag', () => {
    const state = service.exportState();

    const restored = new L2SequencerService(
      store, INITIAL_REG_ROOT, INITIAL_LC_ROOT, Field(0),
    );
    expect(restored.isL2Only()).toBe(false);

    restored.restoreState(state);
    expect(restored.isL2Only()).toBe(true);
  });

  test('restoreState backward-compatible when l2Only is absent', () => {
    // Simulate an old checkpoint without l2Only field
    const defaultService = new L2SequencerService(
      store, INITIAL_REG_ROOT, INITIAL_LC_ROOT, Field(0),
    );
    const state = defaultService.exportState();
    delete (state as any).l2Only;

    const restored = new L2SequencerService(
      store, INITIAL_REG_ROOT, INITIAL_LC_ROOT, Field(0),
      DEFAULT_BATCH_INTERVAL_MS,
      true, // constructed as L2-only
    );
    restored.restoreState(state);
    // Should preserve the construction-time value when checkpoint has no l2Only
    expect(restored.isL2Only()).toBe(true);
  });
});
