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
 * The engine says when it is ready to prove.
 *
 * What was wrong: the engine had no readiness signal. Its proof pool starts at boot and the pool's workers compile for
 * minutes; a proof that arrived meanwhile waited for the pool inside the request (A-58), so in the single-member run of
 * 2026-10-19 the first prescription's first proof waited 148.87 s and the prescriber node's request timed out. Now
 * isProvingReady() is true once the programs are compiled and a proof made now would not wait: no pool configured, the
 * pool running, or its start settled as failed (inline proving, the fallback). provingReadiness() is the open summary
 * { ready, compiled, prover }, which names nothing about members.
 *
 * A real L2Node sequencer and a real AdjudicationService; programs not compiled, nothing proved (the pool is a stand-in).
 */
import { describe, test, expect, beforeAll, jest } from '@jest/globals';
import { Field, MerkleTree } from 'o1js';

let AdjudicationService: any;
let svc: any;

function standInPool() {
  let running = false;
  return {
    isRunning: () => running,
    prove: jest.fn(async () => ({ proofJson: '{"pool":true}', publicOutput: null, proveTimeMs: 1 })),
    start: () => { running = true; },
    stop: () => { running = false; },
  };
}

/** The real engine code over a bare object: what a freshly built engine holds for the proof pool, which is nothing. */
function bareEngine(compiled: boolean): any {
  const e = Object.create(AdjudicationService.prototype);
  e.compiled = compiled;
  e.emit = () => {};
  return e;
}

/** Let a settled start's callbacks run. */
const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

beforeAll(async () => {
  process.env.ZKTRIDENT_FORMULARY_LIMIT = '100';
  const { InMemoryStore } = await import('../src/storage/local-store.js');
  const { WALLET_TREE_HEIGHT } = await import('../src/wallets/wallet-state.js');
  const { L2Node } = await import('../src/l2/l2-node.js');
  ({ AdjudicationService } = await import('../src/adjudication/interactive-service.js'));
  const emptyRoot = new MerkleTree(WALLET_TREE_HEIGHT).getRoot();
  const node = new L2Node({ batchIntervalMs: 999_999, autoSettle: false, nodeId: 'seq-proving-ready' }, new InMemoryStore(), emptyRoot, emptyRoot, Field(0));
  svc = new AdjudicationService(() => {}, () => {}, node);
});

describe('an engine that has just booted', () => {
  test('is not ready to prove until its programs are compiled, and with no pool it proves inline', () => {
    expect(svc.isProvingReady()).toBe(false);
    expect(svc.provingReadiness()).toEqual({ ready: false, compiled: false, prover: 'inline' });
  });

  test('is not ready while its proof pool starts, even once compiled, and is the moment the pool runs', async () => {
    const pool = standInPool();
    let finishStart!: () => void;
    const starting = new Promise<void>((resolve) => { finishStart = () => { pool.start(); svc.setProofPool(pool); resolve(); }; });
    svc.setProofPoolStarting(starting);
    expect(svc.provingReadiness()).toEqual({ ready: false, compiled: false, prover: 'starting' });
    svc.compiled = true;
    expect(svc.isProvingReady()).toBe(false);
    expect(svc.provingReadiness()).toEqual({ ready: false, compiled: true, prover: 'starting' });
    finishStart();
    await settle();
    expect(svc.isProvingReady()).toBe(true);
    expect(svc.provingReadiness()).toEqual({ ready: true, compiled: true, prover: 'pool' });
  });

  test('the summary carries only whether it is ready, whether it is compiled and where proofs go', () => {
    expect(Object.keys(svc.provingReadiness()).sort()).toEqual(['compiled', 'prover', 'ready']);
  });
});

describe("the proof pool's start, tracked until it settles", () => {
  test('a start that fails leaves the engine ready to prove inline (the documented fallback)', async () => {
    const e = bareEngine(true);
    let fail!: (err: Error) => void;
    e.setProofPoolStarting(new Promise<void>((_resolve, reject) => { fail = reject; }));
    expect(e.provingReadiness()).toEqual({ ready: false, compiled: true, prover: 'starting' });
    fail(new Error('All proof pool workers failed to compile'));
    await settle();
    expect(e.isProvingReady()).toBe(true);
    expect(e.provingReadiness()).toEqual({ ready: true, compiled: true, prover: 'inline' });
  });

  test('an engine with no pool configured is ready once compiled, and not before', () => {
    expect(bareEngine(false).isProvingReady()).toBe(false);
    expect(bareEngine(true).isProvingReady()).toBe(true);
    expect(bareEngine(true).provingReadiness()).toEqual({ ready: true, compiled: true, prover: 'inline' });
  });

  test('a running pool does not make an uncompiled engine ready', () => {
    const e = bareEngine(false);
    const pool = standInPool();
    pool.start();
    e.setProofPool(pool);
    expect(e.provingReadiness()).toEqual({ ready: false, compiled: false, prover: 'pool' });
  });

  test('a pool that stops after it started leaves proofs to prove inline, and the engine says so', async () => {
    const e = bareEngine(true);
    const pool = standInPool();
    e.setProofPoolStarting(Promise.resolve().then(() => { pool.start(); e.setProofPool(pool); }));
    await settle();
    expect(e.provingReadiness().prover).toBe('pool');
    pool.stop();
    expect(e.provingReadiness()).toEqual({ ready: true, compiled: true, prover: 'inline' });
  });

  test('a second start supersedes the first: the first one settling later changes nothing', async () => {
    const e = bareEngine(true);
    let failFirst!: (err: Error) => void;
    e.setProofPoolStarting(new Promise<void>((_resolve, reject) => { failFirst = reject; }));
    e.setProofPoolStarting(new Promise<void>(() => {})); // still starting
    failFirst(new Error('the first start failed'));
    await settle();
    expect(e.provingReadiness().prover).toBe('starting');
  });
});

describe('readiness agrees with what a proof would do', () => {
  test('not ready: a proof waits for the starting pool; ready: it goes straight to the pool', async () => {
    const e = bareEngine(true);
    const pool = standInPool();
    let finishStart!: () => void;
    e.setProofPool(pool); // the pool object exists but is not running yet
    e.setProofPoolStarting(new Promise<void>((resolve) => { finishStart = () => { pool.start(); resolve(); }; }));
    expect(e.isProvingReady()).toBe(false);
    const inline = jest.fn(async () => { throw new Error('proved inline'); });
    const proof = e.dispatchProof('ProofGate', 'verifyPrescriber', [], [], inline);
    await new Promise((r) => setTimeout(r, 20));
    expect(pool.prove).not.toHaveBeenCalled(); // waiting, as the engine said
    finishStart();
    await expect(proof).resolves.toMatchObject({ proofJson: '{"pool":true}' });
    expect(e.isProvingReady()).toBe(true);
    await e.dispatchProof('ProofGate', 'verifyPrescriber', [], [], inline);
    expect(pool.prove).toHaveBeenCalledTimes(2);
    expect(inline).not.toHaveBeenCalled();
  });
});
