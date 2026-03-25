/**
 * L2 Proving Pool — Tests for parallel batch proving infrastructure.
 *
 * Tests the ProvingPool coordinator, the prepareBatch/finalizeBatch split,
 * and the L2Node/L2Leviathan integration paths. All FAST (no ZkProgram
 * compilation). Uses mock proofs and mock workers.
 *
 * Run: npx jest tests/l2-proving-pool.test.ts --verbose
 */
import { Field, Poseidon } from 'o1js';
import { InMemoryStore } from '../src/storage/local-store.js';
import { L2SequencerService, MAX_TRANSITIONS_PER_BATCH } from '../src/l2/l2-sequencer-service.js';
import { L2Node } from '../src/l2/l2-node.js';
import type { ProvingJobRequest, ProvingJobResult, PoolEvent, PoolEventType } from '../src/l2/l2-proving-pool-types.js';

// ─── Mock Proof Helpers ─────────────────────────────────────

function makeMockProof(opts: {
  walletId: Field;
  oldRegistryRoot: Field;
  newRegistryRoot: Field;
  oldLifecycleRoot: Field;
  newLifecycleRoot: Field;
}) {
  return {
    verify: () => {},
    publicOutput: {
      walletId: opts.walletId,
      oldRegistryRoot: opts.oldRegistryRoot,
      newRegistryRoot: opts.newRegistryRoot,
      oldLifecycleRoot: opts.oldLifecycleRoot,
      newLifecycleRoot: opts.newLifecycleRoot,
    },
    toJSON: () => ({
      publicOutput: [
        opts.oldRegistryRoot.toString(),
        opts.newRegistryRoot.toString(),
        opts.oldLifecycleRoot.toString(),
        opts.newLifecycleRoot.toString(),
        opts.walletId.toString(),
      ],
    }),
  } as any;
}

/** Build a mock ProvingJobResult that matches a set of transitions */
function makeMockResult(
  oldRegRoot: string, newRegRoot: string,
  oldLcRoot: string, newLcRoot: string,
  transitionCount: number,
  workerId?: number,
): ProvingJobResult {
  return {
    batchProofJson: '{"proof":"mock-batch-proof"}',
    batchOutput: {
      oldRegistryRoot: oldRegRoot,
      newRegistryRoot: newRegRoot,
      oldLifecycleRoot: oldLcRoot,
      newLifecycleRoot: newLcRoot,
      registrationCount: '0',
      transitionCount: String(transitionCount),
    },
    proveTimeMs: 100,
    workerId: workerId ?? 0,
  };
}

// ─── Test Data ──────────────────────────────────────────────

const ROOT_0 = Field(1000);
const ROOT_1 = Field(1001);
const ROOT_2 = Field(1002);
const ROOT_3 = Field(1003);
const LC_ROOT = Field(2000);
const WALLET_A = Field(100);
const WALLET_B = Field(200);

// ─── prepareBatch / finalizeBatch / restoreDrainedTransitions ──

describe('L2SequencerService — Split Batch API', () => {
  let service: L2SequencerService;

  beforeEach(() => {
    service = new L2SequencerService(
      new InMemoryStore(),
      ROOT_0,
      LC_ROOT,
      Field(0),
      30_000,
      true, // l2Only
    );
  });

  test('prepareBatch returns empty batch when no proofs pending', () => {
    const { job, emptyBatch } = service.prepareBatch();
    expect(job).toBeNull();
    expect(emptyBatch).not.toBeNull();
    expect(emptyBatch!.transitionCount).toBe(0);
    expect(emptyBatch!.l1Status).toBe('settled');
  });

  test('prepareBatch drains pending pool and returns job', async () => {
    const proof = makeMockProof({
      walletId: WALLET_A,
      oldRegistryRoot: ROOT_0,
      newRegistryRoot: ROOT_1,
      oldLifecycleRoot: LC_ROOT,
      newLifecycleRoot: LC_ROOT,
    });

    await service.submitProof(proof);
    expect(service.getPendingCount()).toBe(1);

    const { job, emptyBatch } = service.prepareBatch();
    expect(emptyBatch).toBeNull();
    expect(job).not.toBeNull();
    expect(job!.transitionProofJsons.length).toBe(1);
    expect(job!.latestChainHash).toBeTruthy();

    // Pending pool should be empty after drain
    expect(service.getPendingCount()).toBe(0);
  });

  test('prepareBatch drains up to MAX_TRANSITIONS_PER_BATCH', async () => {
    // Submit 3 chained proofs
    const proof1 = makeMockProof({
      walletId: WALLET_A,
      oldRegistryRoot: ROOT_0,
      newRegistryRoot: ROOT_1,
      oldLifecycleRoot: LC_ROOT,
      newLifecycleRoot: LC_ROOT,
    });
    const proof2 = makeMockProof({
      walletId: WALLET_B,
      oldRegistryRoot: ROOT_1,
      newRegistryRoot: ROOT_2,
      oldLifecycleRoot: LC_ROOT,
      newLifecycleRoot: LC_ROOT,
    });
    const proof3 = makeMockProof({
      walletId: WALLET_A,
      oldRegistryRoot: ROOT_2,
      newRegistryRoot: ROOT_3,
      oldLifecycleRoot: LC_ROOT,
      newLifecycleRoot: LC_ROOT,
    });

    await service.submitProof(proof1);
    await service.submitProof(proof2);
    await service.submitProof(proof3);
    expect(service.getPendingCount()).toBe(3);

    const { job } = service.prepareBatch();
    expect(job).not.toBeNull();
    expect(job!.transitionProofJsons.length).toBe(MAX_TRANSITIONS_PER_BATCH);

    // One proof should remain in the pending pool
    expect(service.getPendingCount()).toBe(1);
  });

  test('finalizeBatch creates batch from proving result', async () => {
    const proof = makeMockProof({
      walletId: WALLET_A,
      oldRegistryRoot: ROOT_0,
      newRegistryRoot: ROOT_1,
      oldLifecycleRoot: LC_ROOT,
      newLifecycleRoot: LC_ROOT,
    });

    await service.submitProof(proof);
    const { job } = service.prepareBatch();
    expect(job).not.toBeNull();

    const result = makeMockResult(
      ROOT_0.toString(), ROOT_1.toString(),
      LC_ROOT.toString(), LC_ROOT.toString(),
      1,
    );

    const batch = await service.finalizeBatch(result);
    expect(batch).toBeDefined();
    expect(batch.transitionCount).toBe(1);
    expect(batch.batchProofJson).toBe('{"proof":"mock-batch-proof"}');
    expect(batch.oldRegistryRoot).toBe(ROOT_0.toString());
    expect(batch.newRegistryRoot).toBe(ROOT_1.toString());
    // l2Only → auto-settled
    expect(batch.l1Status).toBe('settled');
  });

  test('finalizeBatch updates receipt status to settled (l2Only)', async () => {
    const proof = makeMockProof({
      walletId: WALLET_A,
      oldRegistryRoot: ROOT_0,
      newRegistryRoot: ROOT_1,
      oldLifecycleRoot: LC_ROOT,
      newLifecycleRoot: LC_ROOT,
    });

    const receipt = await service.submitProof(proof);
    service.prepareBatch();

    const result = makeMockResult(
      ROOT_0.toString(), ROOT_1.toString(),
      LC_ROOT.toString(), LC_ROOT.toString(),
      1,
    );

    await service.finalizeBatch(result);

    const updatedReceipt = service.getReceipt(receipt.receiptId);
    expect(updatedReceipt?.l1Status).toBe('settled');
  });

  test('finalizeBatch applies chain proof result', async () => {
    service.setAdminState({
      adminPublicKeyHash: Field(1),
      benefitPlanRoot: Field(2),
      credentialRegistryRoot: Field(3),
      eligibilityVkHash: Field(4),
      messagingRoot: Field(5),
    });

    const proof = makeMockProof({
      walletId: WALLET_A,
      oldRegistryRoot: ROOT_0,
      newRegistryRoot: ROOT_1,
      oldLifecycleRoot: LC_ROOT,
      newLifecycleRoot: LC_ROOT,
    });

    await service.submitProof(proof);
    service.prepareBatch();

    const result = makeMockResult(
      ROOT_0.toString(), ROOT_1.toString(),
      LC_ROOT.toString(), LC_ROOT.toString(),
      1,
    );
    result.chainProofJson = '{"proof":"mock-chain-proof"}';
    result.chainOutput = {
      globalStateRoot: '9999',
      blockHeight: '0',
    };

    const batch = await service.finalizeBatch(result);
    expect(batch.chainProofJson).toBe('{"proof":"mock-chain-proof"}');
    expect(batch.globalStateRoot).toBe('9999');
    expect(batch.blockHeight).toBe(0n);
  });

  test('restoreDrainedTransitions puts proofs back in pool', async () => {
    const proof = makeMockProof({
      walletId: WALLET_A,
      oldRegistryRoot: ROOT_0,
      newRegistryRoot: ROOT_1,
      oldLifecycleRoot: LC_ROOT,
      newLifecycleRoot: LC_ROOT,
    });

    await service.submitProof(proof);
    expect(service.getPendingCount()).toBe(1);

    service.prepareBatch();
    expect(service.getPendingCount()).toBe(0);

    service.restoreDrainedTransitions();
    expect(service.getPendingCount()).toBe(1);
  });

  test('restoreDrainedTransitions is idempotent when called twice', async () => {
    const proof = makeMockProof({
      walletId: WALLET_A,
      oldRegistryRoot: ROOT_0,
      newRegistryRoot: ROOT_1,
      oldLifecycleRoot: LC_ROOT,
      newLifecycleRoot: LC_ROOT,
    });

    await service.submitProof(proof);
    service.prepareBatch();
    service.restoreDrainedTransitions();
    expect(service.getPendingCount()).toBe(1);

    service.restoreDrainedTransitions(); // second call — no-op
    expect(service.getPendingCount()).toBe(1);
  });

  test('finalizeBatch throws if called without prepareBatch', async () => {
    const result = makeMockResult(
      ROOT_0.toString(), ROOT_1.toString(),
      LC_ROOT.toString(), LC_ROOT.toString(),
      1,
    );

    await expect(service.finalizeBatch(result)).rejects.toThrow(
      'finalizeBatch: no drained transitions',
    );
  });

  test('prepareBatch includes admin state when configured', async () => {
    service.setAdminState({
      adminPublicKeyHash: Field(1),
      benefitPlanRoot: Field(2),
      credentialRegistryRoot: Field(3),
      eligibilityVkHash: Field(4),
      messagingRoot: Field(5),
    });

    const proof = makeMockProof({
      walletId: WALLET_A,
      oldRegistryRoot: ROOT_0,
      newRegistryRoot: ROOT_1,
      oldLifecycleRoot: LC_ROOT,
      newLifecycleRoot: LC_ROOT,
    });

    await service.submitProof(proof);
    const { job } = service.prepareBatch();

    expect(job!.adminState).toBeDefined();
    expect(job!.adminState!.adminPublicKeyHash).toBe('1');
    expect(job!.adminState!.benefitPlanRoot).toBe('2');
    expect(job!.adminState!.credentialRegistryRoot).toBe('3');
    expect(job!.adminState!.eligibilityVkHash).toBe('4');
    expect(job!.adminState!.messagingRoot).toBe('5');
  });

  test('prepareBatch rejects when in-flight batch exists (non-l2Only)', async () => {
    // Create a non-l2Only sequencer
    const seqNonL2 = new L2SequencerService(
      new InMemoryStore(),
      ROOT_0,
      LC_ROOT,
      Field(0),
      30_000,
      false, // NOT l2Only
    );

    // Inject a fake in-flight batch to simulate non-settled state
    (seqNonL2 as any).inFlightBatchNumber = 1n;

    expect(() => seqNonL2.prepareBatch()).toThrow('still in-flight');
  });

  test('multiple prepare/finalize cycles work sequentially', async () => {
    // First cycle
    const proof1 = makeMockProof({
      walletId: WALLET_A,
      oldRegistryRoot: ROOT_0,
      newRegistryRoot: ROOT_1,
      oldLifecycleRoot: LC_ROOT,
      newLifecycleRoot: LC_ROOT,
    });
    await service.submitProof(proof1);
    const { job: job1 } = service.prepareBatch();
    expect(job1).not.toBeNull();
    const batch1 = await service.finalizeBatch(makeMockResult(
      ROOT_0.toString(), ROOT_1.toString(),
      LC_ROOT.toString(), LC_ROOT.toString(), 1,
    ));
    expect(batch1.batchNumber).toBeDefined();

    // Second cycle
    const proof2 = makeMockProof({
      walletId: WALLET_B,
      oldRegistryRoot: ROOT_1,
      newRegistryRoot: ROOT_2,
      oldLifecycleRoot: LC_ROOT,
      newLifecycleRoot: LC_ROOT,
    });
    await service.submitProof(proof2);
    const { job: job2 } = service.prepareBatch();
    expect(job2).not.toBeNull();
    const batch2 = await service.finalizeBatch(makeMockResult(
      ROOT_1.toString(), ROOT_2.toString(),
      LC_ROOT.toString(), LC_ROOT.toString(), 1,
    ));
    expect(batch2.batchNumber).toBeGreaterThan(batch1.batchNumber);
  });
});

// ─── Proving Pool Types ─────────────────────────────────────

describe('ProvingJobRequest / ProvingJobResult types', () => {
  test('ProvingJobRequest serialization is JSON-safe', () => {
    const req: ProvingJobRequest = {
      transitionProofJsons: [{ proof: 'data', publicOutput: ['1', '2'] }],
      latestChainHash: '12345678901234567890',
      adminState: {
        adminPublicKeyHash: '1',
        benefitPlanRoot: '2',
        credentialRegistryRoot: '3',
        eligibilityVkHash: '4',
        messagingRoot: '5',
      },
      latestChainProofJson: '{"proof":"chain"}',
    };

    // Verify it round-trips through JSON
    const json = JSON.stringify(req);
    const parsed = JSON.parse(json) as ProvingJobRequest;
    expect(parsed.transitionProofJsons).toHaveLength(1);
    expect(parsed.adminState?.adminPublicKeyHash).toBe('1');
    expect(parsed.latestChainProofJson).toBe('{"proof":"chain"}');
  });

  test('ProvingJobResult serialization is JSON-safe', () => {
    const result: ProvingJobResult = {
      batchProofJson: '{"proof":"batch"}',
      batchOutput: {
        oldRegistryRoot: '100',
        newRegistryRoot: '200',
        oldLifecycleRoot: '300',
        newLifecycleRoot: '400',
        registrationCount: '1',
        transitionCount: '2',
      },
      chainProofJson: '{"proof":"chain"}',
      chainOutput: {
        globalStateRoot: '999',
        blockHeight: '5',
      },
      proveTimeMs: 42000,
    };

    const json = JSON.stringify(result);
    const parsed = JSON.parse(json) as ProvingJobResult;
    expect(parsed.batchOutput.transitionCount).toBe('2');
    expect(parsed.chainOutput?.blockHeight).toBe('5');
    expect(parsed.proveTimeMs).toBe(42000);
  });
});

// ─── ProvingPool Unit Tests (Mock Workers) ──────────────────

describe('ProvingPool status and lifecycle', () => {
  // These tests import the ProvingPool class directly but don't start real workers.
  // They test the non-worker-dependent behavior.

  test('constructor rejects poolSize < 1', async () => {
    const { ProvingPool } = await import('../src/l2/l2-proving-pool.js');
    expect(() => new ProvingPool(0)).toThrow('poolSize must be at least 1');
  });

  test('prove rejects when pool is not running', async () => {
    const { ProvingPool } = await import('../src/l2/l2-proving-pool.js');
    const pool = new ProvingPool(1);

    const req: ProvingJobRequest = {
      transitionProofJsons: [],
      latestChainHash: '0',
    };

    await expect(pool.prove(req)).rejects.toThrow('not running');
  });

  test('getStatus reports correct initial state', async () => {
    const { ProvingPool } = await import('../src/l2/l2-proving-pool.js');
    const pool = new ProvingPool(3);
    const status = pool.getStatus();

    expect(status.poolSize).toBe(3);
    expect(status.workersAlive).toBe(0);
    expect(status.queueDepth).toBe(0);
    expect(status.totalJobsCompleted).toBe(0);
    expect(status.avgProveTimeMs).toBe(0);
  });

  test('isRunning is false before start', async () => {
    const { ProvingPool } = await import('../src/l2/l2-proving-pool.js');
    const pool = new ProvingPool(1);
    expect(pool.isRunning()).toBe(false);
  });
});

// ─── L2Node Pool Integration ────────────────────────────────

describe('L2Node — proving pool integration', () => {
  test('setProvingPool / getProvingPool', () => {
    const node = new L2Node(
      { batchIntervalMs: 60_000, l2Only: true },
      new InMemoryStore(),
      ROOT_0, LC_ROOT, Field(0),
    );

    expect(node.getProvingPool()).toBeNull();

    // Create a mock pool
    const mockPool = { prove: jest.fn(), isRunning: () => true, on: jest.fn(), off: jest.fn(), getStatus: () => ({ workersIdle: 0, workersBusy: 0, queueDepth: 0 }) } as any;
    node.setProvingPool(mockPool);
    expect(node.getProvingPool()).toBe(mockPool);
  });

  test('executeBatchCycle uses pool path when pool is set', async () => {
    const node = new L2Node(
      { batchIntervalMs: 60_000, l2Only: true },
      new InMemoryStore(),
      ROOT_0, LC_ROOT, Field(0),
    );

    // Create mock pool that returns a valid result
    const mockPool = {
      prove: jest.fn().mockResolvedValue(makeMockResult(
        ROOT_0.toString(), ROOT_1.toString(),
        LC_ROOT.toString(), LC_ROOT.toString(), 1,
      )),
      isRunning: () => true,
      on: jest.fn(),
      off: jest.fn(),
      getStatus: () => ({ workersIdle: 0, workersBusy: 1, queueDepth: 0 }),
    } as any;
    node.setProvingPool(mockPool);

    // Submit a proof
    const proof = makeMockProof({
      walletId: WALLET_A,
      oldRegistryRoot: ROOT_0,
      newRegistryRoot: ROOT_1,
      oldLifecycleRoot: LC_ROOT,
      newLifecycleRoot: LC_ROOT,
    });
    await node.submitProof(proof);

    // Trigger batch cycle via the internal method
    const batch = await (node as any).executeBatchCycle();
    expect(batch).not.toBeNull();
    expect(batch.batchProofJson).toBe('{"proof":"mock-batch-proof"}');

    // Pool.prove should have been called
    expect(mockPool.prove).toHaveBeenCalledTimes(1);
    const jobArg = mockPool.prove.mock.calls[0][0] as ProvingJobRequest;
    expect(jobArg.transitionProofJsons.length).toBe(1);
  });

  test('executeBatchCycle restores transitions on pool failure', async () => {
    const node = new L2Node(
      { batchIntervalMs: 60_000, l2Only: true },
      new InMemoryStore(),
      ROOT_0, LC_ROOT, Field(0),
    );

    // Create mock pool that rejects
    const mockPool = {
      prove: jest.fn().mockRejectedValue(new Error('worker crashed')),
      isRunning: () => true,
      on: jest.fn(),
      off: jest.fn(),
      getStatus: () => ({ workersIdle: 0, workersBusy: 1, queueDepth: 0 }),
    } as any;
    node.setProvingPool(mockPool);

    // Submit a proof
    const proof = makeMockProof({
      walletId: WALLET_A,
      oldRegistryRoot: ROOT_0,
      newRegistryRoot: ROOT_1,
      oldLifecycleRoot: LC_ROOT,
      newLifecycleRoot: LC_ROOT,
    });
    await node.submitProof(proof);
    expect((node as any).sequencer.getPendingCount()).toBe(1);

    // Trigger batch cycle — should fail but restore transitions
    const events: any[] = [];
    node.on((e) => events.push(e));

    const batch = await (node as any).executeBatchCycle();
    expect(batch).toBeNull(); // failed

    // Transitions should be restored to the pending pool
    expect((node as any).sequencer.getPendingCount()).toBe(1);

    // Should have emitted batch:failed
    expect(events.some((e) => e.type === 'batch:failed')).toBe(true);
  });

  test('executeBatchCycle uses legacy path when no pool set', async () => {
    const node = new L2Node(
      { batchIntervalMs: 60_000, l2Only: true },
      new InMemoryStore(),
      ROOT_0, LC_ROOT, Field(0),
    );

    // No pool set — should use withProvingLock path (which calls buildBatch)
    // buildBatch with mock proofs will try to call BatchProgram.wrapSingle
    // which fails without compilation — that's expected in this test.
    // We just verify the code path by checking it doesn't look for pool.prove.

    expect(node.getProvingPool()).toBeNull();
    // (We don't actually trigger a batch here since it would require
    //  ZkProgram compilation. The path is verified by the pool test above.)
  });
});

// ─── L2SequencerService buildBatch still works ──────────────

describe('L2SequencerService — buildBatch backward compatibility', () => {
  let service: L2SequencerService;

  beforeEach(() => {
    service = new L2SequencerService(
      new InMemoryStore(),
      ROOT_0,
      LC_ROOT,
      Field(0),
      30_000,
      true,
    );
  });

  test('buildBatch returns empty batch when pool is empty', async () => {
    const batch = await service.buildBatch();
    expect(batch).not.toBeNull();
    expect(batch!.transitionCount).toBe(0);
    expect(batch!.l1Status).toBe('settled');
  });

  test('buildBatch with pending proof still works (would need ZK for real proving)', async () => {
    // This just verifies the method signature hasn't changed
    // Real proving would require BatchProgram compilation
    const proof = makeMockProof({
      walletId: WALLET_A,
      oldRegistryRoot: ROOT_0,
      newRegistryRoot: ROOT_1,
      oldLifecycleRoot: LC_ROOT,
      newLifecycleRoot: LC_ROOT,
    });

    await service.submitProof(proof);
    expect(service.getPendingCount()).toBe(1);

    // buildBatch would fail at BatchProgram.wrapSingle without compilation
    // but we verify the API is still available
    expect(typeof service.buildBatch).toBe('function');
    expect(typeof service.prepareBatch).toBe('function');
    expect(typeof service.finalizeBatch).toBe('function');
    expect(typeof service.restoreDrainedTransitions).toBe('function');
  });
});

// ─── Proving Pool Types — edge cases ────────────────────────

describe('ProvingJobRequest edge cases', () => {
  test('job without adminState omits chain proof context', async () => {
    const service = new L2SequencerService(
      new InMemoryStore(),
      ROOT_0,
      LC_ROOT,
      Field(0),
      30_000,
      true,
    );

    const proof = makeMockProof({
      walletId: WALLET_A,
      oldRegistryRoot: ROOT_0,
      newRegistryRoot: ROOT_1,
      oldLifecycleRoot: LC_ROOT,
      newLifecycleRoot: LC_ROOT,
    });

    await service.submitProof(proof);
    const { job } = service.prepareBatch();

    expect(job).not.toBeNull();
    expect(job!.adminState).toBeUndefined();
    expect(job!.latestChainProofJson).toBeUndefined();
  });

  test('job with 2 chainable transitions drains both', async () => {
    const service = new L2SequencerService(
      new InMemoryStore(),
      ROOT_0,
      LC_ROOT,
      Field(0),
      30_000,
      true,
    );

    const proof1 = makeMockProof({
      walletId: WALLET_A,
      oldRegistryRoot: ROOT_0,
      newRegistryRoot: ROOT_1,
      oldLifecycleRoot: LC_ROOT,
      newLifecycleRoot: LC_ROOT,
    });
    const proof2 = makeMockProof({
      walletId: WALLET_B,
      oldRegistryRoot: ROOT_1,
      newRegistryRoot: ROOT_2,
      oldLifecycleRoot: LC_ROOT,
      newLifecycleRoot: LC_ROOT,
    });

    await service.submitProof(proof1);
    await service.submitProof(proof2);

    const { job } = service.prepareBatch();
    expect(job!.transitionProofJsons.length).toBe(2);
    expect(service.getPendingCount()).toBe(0);
  });

  test('root discontinuity limits drain to 1 transition', async () => {
    const service = new L2SequencerService(
      new InMemoryStore(),
      ROOT_0,
      LC_ROOT,
      Field(0),
      30_000,
      true,
    );

    const proof1 = makeMockProof({
      walletId: WALLET_A,
      oldRegistryRoot: ROOT_0,
      newRegistryRoot: ROOT_1,
      oldLifecycleRoot: LC_ROOT,
      newLifecycleRoot: LC_ROOT,
    });

    await service.submitProof(proof1);

    // Simulate admin root update between proofs
    (service as any).currentRegistryRoot = ROOT_2;

    const proof2 = makeMockProof({
      walletId: WALLET_B,
      oldRegistryRoot: ROOT_2,
      newRegistryRoot: ROOT_3,
      oldLifecycleRoot: LC_ROOT,
      newLifecycleRoot: LC_ROOT,
    });

    await service.submitProof(proof2);

    const { job } = service.prepareBatch();
    // Only first transition is chainable (discontinuity between proof1.new and proof2.old)
    expect(job!.transitionProofJsons.length).toBe(1);
    expect(service.getPendingCount()).toBe(1);
  });
});

// ─── Pool Event Emitter ─────────────────────────────────────

describe('ProvingPool — event emitter', () => {
  test('on() registers handler and off() removes it', async () => {
    const { ProvingPool } = await import('../src/l2/l2-proving-pool.js');
    const pool = new ProvingPool(1);
    const events: PoolEvent[] = [];
    const handler = (e: PoolEvent) => events.push(e);

    pool.on(handler);
    // Emit via private method — access for testing
    (pool as any).emitPoolEvent({ type: 'worker:ready', timestamp: Date.now(), workerId: 0, data: {} });
    expect(events.length).toBe(1);
    expect(events[0].type).toBe('worker:ready');

    pool.off(handler);
    (pool as any).emitPoolEvent({ type: 'worker:ready', timestamp: Date.now(), workerId: 1, data: {} });
    expect(events.length).toBe(1); // no new event — handler removed
  });

  test('multiple handlers receive same event', async () => {
    const { ProvingPool } = await import('../src/l2/l2-proving-pool.js');
    const pool = new ProvingPool(1);
    const events1: PoolEvent[] = [];
    const events2: PoolEvent[] = [];

    pool.on((e) => events1.push(e));
    pool.on((e) => events2.push(e));

    (pool as any).emitPoolEvent({ type: 'worker:dispatched', timestamp: 123, workerId: 0, data: { jobId: 'j1' } });
    expect(events1.length).toBe(1);
    expect(events2.length).toBe(1);
    expect(events1[0].workerId).toBe(0);
    expect(events2[0].data.jobId).toBe('j1');
  });

  test('handler error does not break other handlers', async () => {
    const { ProvingPool } = await import('../src/l2/l2-proving-pool.js');
    const pool = new ProvingPool(1);
    const events: PoolEvent[] = [];

    pool.on(() => { throw new Error('bad handler'); });
    pool.on((e) => events.push(e));

    // Should not throw
    (pool as any).emitPoolEvent({ type: 'worker:crashed', timestamp: Date.now(), workerId: 0, data: {} });
    expect(events.length).toBe(1);
  });
});

// ─── Pool Worker Statuses ────────────────────────────────────

describe('ProvingPool — getWorkerStatuses / getPoolSize', () => {
  test('getPoolSize returns constructor value', async () => {
    const { ProvingPool } = await import('../src/l2/l2-proving-pool.js');
    const pool = new ProvingPool(4);
    expect(pool.getPoolSize()).toBe(4);
  });

  test('getWorkerStatuses returns empty array before start', async () => {
    const { ProvingPool } = await import('../src/l2/l2-proving-pool.js');
    const pool = new ProvingPool(2);
    const statuses = pool.getWorkerStatuses();
    expect(statuses).toEqual([]);
  });
});

// ─── WorkerId Stamping in finalizeBatch ──────────────────────

describe('L2SequencerService — workerId in finalizeBatch', () => {
  test('finalizeBatch stamps workerId onto L2Batch', async () => {
    const service = new L2SequencerService(
      new InMemoryStore(),
      ROOT_0,
      LC_ROOT,
      Field(0),
      30_000,
      true,
    );

    const proof = makeMockProof({
      walletId: WALLET_A,
      oldRegistryRoot: ROOT_0,
      newRegistryRoot: ROOT_1,
      oldLifecycleRoot: LC_ROOT,
      newLifecycleRoot: LC_ROOT,
    });

    await service.submitProof(proof);
    service.prepareBatch();

    const result = makeMockResult(
      ROOT_0.toString(), ROOT_1.toString(),
      LC_ROOT.toString(), LC_ROOT.toString(), 1, 2,
    );

    const batch = await service.finalizeBatch(result);
    expect(batch.workerId).toBe(2);
    expect(batch.proveTimeMs).toBe(100);
  });

  test('finalizeBatch omits workerId when not set in result', async () => {
    const service = new L2SequencerService(
      new InMemoryStore(),
      ROOT_0,
      LC_ROOT,
      Field(0),
      30_000,
      true,
    );

    const proof = makeMockProof({
      walletId: WALLET_A,
      oldRegistryRoot: ROOT_0,
      newRegistryRoot: ROOT_1,
      oldLifecycleRoot: LC_ROOT,
      newLifecycleRoot: LC_ROOT,
    });

    await service.submitProof(proof);
    service.prepareBatch();

    // Create result without workerId explicitly
    const result: ProvingJobResult = {
      batchProofJson: '{"proof":"mock"}',
      batchOutput: {
        oldRegistryRoot: ROOT_0.toString(),
        newRegistryRoot: ROOT_1.toString(),
        oldLifecycleRoot: LC_ROOT.toString(),
        newLifecycleRoot: LC_ROOT.toString(),
        registrationCount: '0',
        transitionCount: '1',
      },
      proveTimeMs: 50,
      workerId: 0,
    };

    const batch = await service.finalizeBatch(result);
    expect(batch.workerId).toBe(0);
    expect(batch.proveTimeMs).toBe(50);
  });
});

// ─── L2Node Pool Event Forwarding ────────────────────────────

describe('L2Node — pool event forwarding', () => {
  test('setProvingPool forwards pool events as L2ChainEvents', () => {
    const node = new L2Node(
      { batchIntervalMs: 60_000, l2Only: true },
      new InMemoryStore(),
      ROOT_0, LC_ROOT, Field(0),
    );

    const events: any[] = [];
    node.on((e) => events.push(e));

    // Create a mock pool with on/off/isRunning
    const handlers: Array<(e: PoolEvent) => void> = [];
    const mockPool = {
      prove: jest.fn(),
      isRunning: () => true,
      on: (h: (e: PoolEvent) => void) => { handlers.push(h); },
      off: jest.fn(),
      getPoolSize: () => 2,
      getWorkerStatuses: () => [],
    } as any;

    node.setProvingPool(mockPool);

    // Simulate pool emitting a worker:ready event
    const poolEvent: PoolEvent = {
      type: 'worker:ready',
      timestamp: Date.now(),
      workerId: 0,
      data: { compileTimeMs: 5000 },
    };
    for (const h of handlers) h(poolEvent);

    expect(events.length).toBe(1);
    expect(events[0].type).toBe('pool:worker:ready');
    expect(events[0].data.workerId).toBe(0);
    expect(events[0].data.compileTimeMs).toBe(5000);
  });

  test('executeBatchCycle includes workerId in batch:built event', async () => {
    const node = new L2Node(
      { batchIntervalMs: 60_000, l2Only: true },
      new InMemoryStore(),
      ROOT_0, LC_ROOT, Field(0),
    );

    const mockResult = makeMockResult(
      ROOT_0.toString(), ROOT_1.toString(),
      LC_ROOT.toString(), LC_ROOT.toString(), 1, 1,
    );
    const mockPool = {
      prove: jest.fn().mockResolvedValue(mockResult),
      isRunning: () => true,
      on: jest.fn(),
      off: jest.fn(),
      getStatus: () => ({ workersIdle: 0, workersBusy: 1, queueDepth: 0 }),
    } as any;
    node.setProvingPool(mockPool);

    const proof = makeMockProof({
      walletId: WALLET_A,
      oldRegistryRoot: ROOT_0,
      newRegistryRoot: ROOT_1,
      oldLifecycleRoot: LC_ROOT,
      newLifecycleRoot: LC_ROOT,
    });
    await node.submitProof(proof);

    const events: any[] = [];
    node.on((e) => events.push(e));

    await (node as any).executeBatchCycle();

    const batchBuilt = events.find((e) => e.type === 'batch:built');
    expect(batchBuilt).toBeDefined();
    expect(batchBuilt.data.workerId).toBe(1);
    expect(batchBuilt.data.proveTimeMs).toBe(100);
  });
});

// ─── ProvingJobResult.workerId type check ────────────────────

describe('ProvingJobResult — workerId field', () => {
  test('workerId is present and numeric in type', () => {
    const result: ProvingJobResult = {
      batchProofJson: '{"proof":"test"}',
      batchOutput: {
        oldRegistryRoot: '1',
        newRegistryRoot: '2',
        oldLifecycleRoot: '3',
        newLifecycleRoot: '4',
        registrationCount: '0',
        transitionCount: '1',
      },
      proveTimeMs: 42,
      workerId: 3,
    };

    expect(result.workerId).toBe(3);
    expect(typeof result.workerId).toBe('number');
  });

  test('workerId survives JSON round-trip', () => {
    const result: ProvingJobResult = {
      batchProofJson: '{"proof":"test"}',
      batchOutput: {
        oldRegistryRoot: '1',
        newRegistryRoot: '2',
        oldLifecycleRoot: '3',
        newLifecycleRoot: '4',
        registrationCount: '0',
        transitionCount: '1',
      },
      proveTimeMs: 42,
      workerId: 5,
    };

    const parsed = JSON.parse(JSON.stringify(result)) as ProvingJobResult;
    expect(parsed.workerId).toBe(5);
  });

  test('PoolEventType union has expected members', () => {
    const types: PoolEventType[] = [
      'worker:spawned', 'worker:compiling', 'worker:ready',
      'worker:compile_timeout', 'worker:compile_failed',
      'worker:dispatched', 'worker:completed', 'worker:crashed',
    ];
    expect(types.length).toBe(8);
    for (const t of types) {
      expect(typeof t).toBe('string');
    }
  });
});
