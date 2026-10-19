/**
 * A proof made while the proof pool is still starting waits for the pool; it does not prove inline on the event loop
 * the sequencer shares. In the four-member run of 2026-10-19 the engine proved a prescription's first proofs inline
 * because the pool's workers were still compiling, the sequencer stopped answering for 6.4 s, and an employer lookup
 * timed out, so a member's enrollment code was refused.
 *
 * A real L2Node sequencer and a real AdjudicationService; programs not compiled, nothing proved (the pool is a stand-in).
 */
import { describe, test, expect, beforeAll, jest } from '@jest/globals';
import { Field, MerkleTree } from 'o1js';

let svc: any;
let AdjudicationService: any;
let node: any;

function standInPool() {
  let running = false;
  const pool = {
    isRunning: () => running,
    prove: jest.fn(async () => ({ proofJson: '{"pool":true}', publicOutput: null, proveTimeMs: 1 })),
    start: () => { running = true; },
  };
  return pool;
}

beforeAll(async () => {
  process.env.ZKTRIDENT_FORMULARY_LIMIT = '100';
  const { InMemoryStore } = await import('../src/storage/local-store.js');
  const { WALLET_TREE_HEIGHT } = await import('../src/wallets/wallet-state.js');
  const { L2Node } = await import('../src/l2/l2-node.js');
  ({ AdjudicationService } = await import('../src/adjudication/interactive-service.js'));
  const emptyRoot = new MerkleTree(WALLET_TREE_HEIGHT).getRoot();
  node = new L2Node({ batchIntervalMs: 999_999, autoSettle: false, nodeId: 'seq-pool-wait' }, new InMemoryStore(), emptyRoot, emptyRoot, Field(0));
});

function freshService() {
  return new AdjudicationService(() => {}, () => {}, node);
}

describe('proofs made while the proof pool starts', () => {
  test('wait for the pool and go to it; nothing is proved inline', async () => {
    const s = freshService();
    const pool = standInPool();
    let finishStart!: () => void;
    const starting = new Promise<void>((resolve) => { finishStart = () => { pool.start(); s.setProofPool(pool); resolve(); }; });
    s.setProofPool(pool); // the pool object exists but is not running yet
    s.setProofPoolStarting(starting);
    const inline = jest.fn(async () => { throw new Error('proved inline'); });
    const proof = s.dispatchProof('ProofGate', 'verifyPrescriber', [], [], inline);
    // the event loop stays free while the proof waits: a timer fires before the proof settles
    const ticked = await new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 20));
    expect(ticked).toBe(true);
    expect(pool.prove).not.toHaveBeenCalled();
    finishStart();
    await expect(proof).resolves.toMatchObject({ proofJson: '{"pool":true}' });
    expect(pool.prove).toHaveBeenCalledTimes(1);
    expect(inline).not.toHaveBeenCalled();
  });

  test('a pool that fails to start leaves proofs to prove inline, as before', async () => {
    const s = freshService();
    s.setProofPoolStarting(Promise.reject(new Error('All proof pool workers failed to compile')));
    const inline = jest.fn(async () => ({ proof: null }));
    await expect(s.dispatchProof('Eligibility', 'proveEligibility', [], [], inline)).resolves.toMatchObject({ proofJson: null });
    expect(inline).toHaveBeenCalledTimes(1);
  });

  test('with no pool configured, proofs prove inline without waiting', async () => {
    const s = freshService();
    const inline = jest.fn(async () => ({ proof: null }));
    await s.dispatchProof('Messaging', 'proveSendMessage', [], [], inline);
    expect(inline).toHaveBeenCalledTimes(1);
  });

  test('once the pool runs, proofs go straight to it', async () => {
    const s = freshService();
    const pool = standInPool();
    pool.start();
    s.setProofPool(pool);
    s.setProofPoolStarting(Promise.resolve());
    const inline = jest.fn(async () => { throw new Error('proved inline'); });
    await s.dispatchProof('AccessControl', 'proveFormularyAccess', [], [], inline);
    expect(pool.prove).toHaveBeenCalledTimes(1);
    expect(inline).not.toHaveBeenCalled();
  });

  test('the boot script hands the engine the starting pool before any request can arrive', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync('src/nodes/start-leviathan.ts', 'utf8');
    const started = src.indexOf('const proofPoolStarted = proofPool.start()');
    const handed = src.indexOf('interactiveService.setProofPoolStarting(proofPoolStarted)');
    expect(started).toBeGreaterThan(0);
    expect(handed).toBeGreaterThan(started);
  });
});
