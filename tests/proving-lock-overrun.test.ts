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
 * An operation that holds the proving lock past five minutes keeps it until it settles, and its caller hears what it did.
 *
 * What was wrong: L2Node.withProvingLock raced the operation against a five-minute timer and let go of the lock when the
 * timer fired, while the operation, which nothing can cancel, ran on. Its caller was told it had timed out, and the next
 * locked operation ran beside it. The fill route runs dispensePrescription under the lock as a background job, so a fill
 * whose proof outlasted five minutes was reported failed to the pharmacy while a termination sent meanwhile ran in the
 * middle of it: the fill then built its credential with revoked = 1, committed its claim, and set the cancelled
 * prescription back to DISPENSED. L2Leviathan's own lock, which its in-process batch cycle takes, let go the same way, so a
 * second batch could start proving beside the first.
 *
 * How it was found: the review of option A step 1 (docs/research/a22-option-a-spec.md), 2026-10-24, which reproduced it
 * with the real engine.
 *
 * What is true now: the lock is held until the operation settles, and the caller is answered from the operation's own
 * result or error, so a background job records what really happened. A watchdog logs once the operation has held the lock
 * for five minutes, and again when it lets go, with how long it held it. Operations that finish sooner run one at a time in
 * arrival order, as before, and log nothing.
 *
 * Fake timers stand in for the minutes; nothing is proved.
 *
 * Run: npx jest tests/proving-lock-overrun.test.ts
 */
import { Field, MerkleTree } from 'o1js';
import { InMemoryStore } from '../src/storage/local-store.js';
import { WALLET_TREE_HEIGHT } from '../src/wallets/wallet-state.js';
import { L2Node } from '../src/l2/l2-node.js';
import { L2Leviathan } from '../src/l2/l2-leviathan.js';
import type { LeviathanConfig } from '../src/l2/l2-leviathan-types.js';
import type { L2Batch } from '../src/l2/l2-types.js';

const EMPTY = new MerkleTree(WALLET_TREE_HEIGHT).getRoot();
const MINUTE = 60_000;

let warn: jest.SpyInstance;
beforeEach(() => {
  jest.useFakeTimers();
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
  jest.useRealTimers();
});

/** What the watchdog has logged so far. */
const lockWarnings = (): string[] => warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('proving lock'));

/** Let the promises that are ready run, and the clock move on by `ms`. */
const elapse = (ms = 0) => jest.advanceTimersByTimeAsync(ms);

function newNode(): L2Node {
  return new L2Node({ batchIntervalMs: 999_999, autoSettle: false, nodeId: 'lock-node' }, new InMemoryStore(), EMPTY, EMPTY, Field(0));
}

/** An operation that runs until the test ends it, as a proof runs until it is done; what it does goes into `events`. */
function operation<T>(name: string, events: string[]) {
  let finish!: (value: T) => void;
  let fail!: (err: Error) => void;
  const run = (): Promise<T> => {
    events.push(`${name} starts`);
    return new Promise<T>((resolve, reject) => {
      finish = (value) => { events.push(`${name} ends`); resolve(value); };
      fail = (err) => { events.push(`${name} fails`); reject(err); };
    });
  };
  return { run, finish: (value: T) => finish(value), fail: (err: Error) => fail(err) };
}

/** What a promise has settled to so far, read without waiting for it. */
function track<T>(promise: Promise<T>) {
  const seen: { status: 'pending' | 'resolved' | 'rejected'; value?: T; error?: string } = { status: 'pending' };
  promise.then(
    (value) => { seen.status = 'resolved'; seen.value = value; },
    (err) => { seen.status = 'rejected'; seen.error = err instanceof Error ? err.message : String(err); },
  );
  return seen;
}

describe('L2Node: an operation that holds the proving lock past five minutes', () => {
  test("a fill that proves past five minutes keeps the lock: a termination sent meanwhile runs after it, and the fill's job records the fill's own result", async () => {
    const node = newNode();
    const events: string[] = [];
    const fill = operation<{ prescriptionId: string; status: string }>('fill', events);
    // as the fill route does: dispense runs under the lock as a background job, and the job records what came back
    const job: { status: string; result?: unknown; error?: string } = { status: 'pending' };
    node.withProvingLock(fill.run)
      .then((result) => { job.status = 'complete'; job.result = result; })
      .catch((err: Error) => { job.status = 'error'; job.error = err.message; });
    await elapse();
    expect(events).toEqual(['fill starts']);

    const termination = track(node.withProvingLock(async () => { events.push('terminate'); return { lifecycle: 'REVOKED' }; }));
    await elapse(6 * MINUTE);
    expect(events).toEqual(['fill starts']);     // before: ['fill starts', 'terminate']: the lock was let go at five minutes and the termination ran in the middle of the fill
    expect(job.status).toBe('pending');          // before: 'error', the pharmacy told the fill had failed while it was still running
    expect(termination.status).toBe('pending');  // before: 'resolved'

    fill.finish({ prescriptionId: 'RX-OVERRUN', status: 'DISPENSED' });
    await elapse();
    expect(job).toEqual({ status: 'complete', result: { prescriptionId: 'RX-OVERRUN', status: 'DISPENSED' } }); // before: { status: 'error', error: 'Proving lock timeout: operation exceeded 5 minutes' }
    expect(termination).toEqual({ status: 'resolved', value: { lifecycle: 'REVOKED' } });
    expect(events).toEqual(['fill starts', 'fill ends', 'terminate']); // before: ['fill starts', 'terminate', 'fill ends']
  });

  test('an operation that fails after five minutes hands its caller its own error, not a lock timeout, and the next one waits for the failure', async () => {
    const node = newNode();
    const events: string[] = [];
    const proof = operation<string>('proof', events);
    const first = track(node.withProvingLock(proof.run));
    const second = track(node.withProvingLock(async () => { events.push('next'); return 'next done'; }));
    await elapse(7 * MINUTE);
    expect(first.status).toBe('pending');        // before: 'rejected' with 'Proving lock timeout: operation exceeded 5 minutes'
    expect(events).toEqual(['proof starts']);    // before: ['proof starts', 'next']

    proof.fail(new Error('Prove timeout after 180000ms for AccumulatorFulfillment.fulfill'));
    await elapse();
    expect(first).toEqual({ status: 'rejected', error: 'Prove timeout after 180000ms for AccumulatorFulfillment.fulfill' }); // before: the lock's own timeout message
    expect(second).toEqual({ status: 'resolved', value: 'next done' });
    expect(events).toEqual(['proof starts', 'proof fails', 'next']); // before: ['proof starts', 'next', 'proof fails']
  });

  test('the watchdog logs once the operation has held the lock for five minutes, and again when it lets go, with how long it held it', async () => {
    const node = newNode();
    const batch = operation<string>('batch', []);
    const result = track(node.withProvingLock(batch.run));
    await elapse(5 * MINUTE - 1);
    expect(lockWarnings()).toEqual([]);
    await elapse(1);
    expect(lockWarnings()).toHaveLength(1);       // before: nothing was logged; the caller was refused instead
    expect(lockWarnings()[0]).toMatch(/lock-node: an operation has held the proving lock for 300 s and is still running/);

    await elapse(2 * MINUTE);
    expect(lockWarnings()).toHaveLength(1);
    batch.finish('built');
    await elapse();
    expect(lockWarnings()).toHaveLength(2);       // before: nothing was logged
    expect(lockWarnings()[1]).toMatch(/lock-node: the operation that held the proving lock past 300 s let go of it after 420 s/);
    expect(result).toEqual({ status: 'resolved', value: 'built' }); // before: rejected with the lock's timeout at five minutes
    expect(jest.getTimerCount()).toBe(0);
  });

  test('operations that finish within five minutes run one at a time in arrival order, as before, and nothing is logged', async () => {
    const node = newNode();
    const events: string[] = [];
    const first = operation<string>('first', events);
    const results = [
      track(node.withProvingLock(first.run)),
      track(node.withProvingLock(async () => { events.push('second'); return 'second done'; })),
      track(node.withProvingLock(async () => { events.push('third'); throw new Error('third refused'); })),
    ];
    await elapse(4 * MINUTE);
    expect(events).toEqual(['first starts']);
    first.finish('first done');
    await elapse();
    expect(events).toEqual(['first starts', 'first ends', 'second', 'third']);
    expect(results).toEqual([
      { status: 'resolved', value: 'first done' },
      { status: 'resolved', value: 'second done' },
      { status: 'rejected', error: 'third refused' },
    ]);
    expect(lockWarnings()).toEqual([]);
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe("L2Leviathan: its batch cycle's in-process proving lock", () => {
  function newLeviathan(): L2Leviathan {
    const config: LeviathanConfig = {
      partitionCount: 2,
      primaryPartition: 0,
      failoverChain: new Map([[0, ['lock-lev']], [1, ['lock-lev']]]),
      heartbeatIntervalMs: 999_999,
      heartbeatTimeoutMs: 999_999,
    };
    return new L2Leviathan(config, { batchIntervalMs: 999_999, l2Only: true, nodeId: 'lock-lev' }, new InMemoryStore(), EMPTY, EMPTY, Field(0));
  }

  /** A partition with a proof pending whose in-process batch build runs until the test ends it. */
  function provingPartition(lev: L2Leviathan, partition: number, events: string[]) {
    const build = operation<L2Batch>(`batch ${partition}`, events);
    const seq = lev.getSequencer(partition);
    jest.spyOn(seq, 'getPendingCount').mockReturnValue(1);
    jest.spyOn(seq, 'buildBatch').mockImplementation(build.run);
    const batch = { batchNumber: BigInt(partition), blockNumbers: [], registrationCount: 0, transitionCount: 1 } as unknown as L2Batch;
    return { finish: () => build.finish(batch), batch };
  }

  test("a batch that proves past five minutes keeps the lock: the other partition's batch starts only after it, and the first comes back built", async () => {
    const lev = newLeviathan();
    const events: string[] = [];
    const failures: unknown[] = [];
    lev.on((e) => { if (e.type === 'batch:failed') failures.push(e.data.reason); });
    const p0 = provingPartition(lev, 0, events);
    const p1 = provingPartition(lev, 1, events);

    const first = track(lev.forceBatch(0));
    await elapse();
    const second = track(lev.forceBatch(1));
    await elapse(6 * MINUTE);
    expect(events).toEqual(['batch 0 starts']);   // before: ['batch 0 starts', 'batch 1 starts']: two batches proving at once in one o1js context
    expect(first.status).toBe('pending');         // before: resolved null, the batch reported failed while it was still proving
    expect(failures).toEqual([]);                 // before: ['Proving lock timeout: operation exceeded 5 minutes']
    expect(lockWarnings()).toHaveLength(1);       // before: nothing was logged
    expect(lockWarnings()[0]).toMatch(/lock-lev: an operation has held the proving lock for 300 s/);

    p0.finish();
    await elapse();
    expect(first).toEqual({ status: 'resolved', value: p0.batch }); // before: { status: 'resolved', value: null }
    expect(events).toEqual(['batch 0 starts', 'batch 0 ends', 'batch 1 starts']);
    p1.finish();
    await elapse();
    expect(second).toEqual({ status: 'resolved', value: p1.batch });
    expect(lockWarnings()).toHaveLength(2);       // before: nothing was logged
  });
});
