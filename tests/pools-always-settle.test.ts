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
 * Both proving pools settle every job: it is proved or refused within a bounded time, and a prove that times out costs
 * its worker, not the job after it.
 *
 * What was wrong, in src/adjudication/proof-pool.ts (the engine's pool) and src/l2/l2-proving-pool.ts (the L2 batch
 * pool):
 *  1. A job submitted while no worker was idle was queued with no timer, and the queue drained only when a worker
 *     answered, timed out, or a replacement became ready. Once a pool had no worker left (its last worker crashed past
 *     the restart limit, or the replacement for a crashed or recycled worker failed its compile), the queued job and
 *     every job after it waited for good, while isRunning() still said the pool ran and the engine kept sending it work.
 *     Under the proving lock, which round two holds until the operation settles, the operation waiting on such a job
 *     held the lock for good, and every locked engine route waited behind it. A replacement that failed its compile was
 *     also left running, holding its memory.
 *  2. The engine's pool, on a prove timeout, refused the job but put the worker back in rotation without stopping it,
 *     so the next job could be sent to a worker still proving the abandoned one, and waited behind it until it timed
 *     out in turn. The L2 batch pool already killed a worker on a prove timeout and replaced it as a crash.
 *
 * How it was found: the review of option A step 1 (docs/research/a22-option-a-spec.md), round two, 2026-10-24, which
 * reproduced both with stub workers under the real proving lock.
 *
 * What is true now: once no worker is ready, proving or compiling, each pool refuses the jobs it had queued at once,
 * with an error that says no worker is left, and refuses every new job in prove(), while canTakeWork() reads false.
 * isRunning() is unchanged, because the engine proves inline in its own process when its pool does not run. A
 * replacement that fails its compile is killed. In the engine's pool a prove timeout kills the worker, which is replaced
 * as a crash, against the restart limit, so the next job goes to a worker that is free. Honest jobs through a healthy
 * pool, recycles included, are proved as before.
 *
 * Jest cannot load the engine's pool, whose worker path comes from import.meta.url, so each case runs the real pool in
 * a child process, tests/helpers/prover-pool-stub.mjs, whose workers are that same file speaking the workers' protocol
 * without o1js. A job the fixture saw unsettled after 10 s is reported 'pending'. The "before" comments describe the
 * pools at 5bc3290.
 *
 * Run: npx jest tests/pools-always-settle.test.ts
 */
import path from 'path';
import { spawn } from 'child_process';

const REPO = path.resolve(__dirname, '..');
const FIXTURE = path.join(REPO, 'tests', 'helpers', 'prover-pool-stub.mjs');
const RESULT_MARKER = '@@prover-pool ';

type PoolKind = 'proof' | 'proving';

/** What became of one job, and how many milliseconds after its submission. */
interface Outcome {
  result: 'proved' | 'refused' | 'pending';
  /** The process that answered a proved job. */
  pid?: number;
  /** Why a refused job was refused. */
  message?: string;
  ms?: number;
}

interface PoolRun {
  /** Workers the pool forked, and the pids of those forked and of those that exited, in order. */
  forks: number;
  exits: number;
  pids: number[];
  exitedPids: number[];
  status: { workersAlive: number; queueDepth: number; totalJobsCompleted: number; totalJobsFailed: number };
  /** The engine's pool reports each slot's restartCount; the L2 pool does not. */
  workers: Array<{ status: string; restartCount?: number }>;
  isRunning: boolean;
  /** null where the pool has no canTakeWork(). */
  canTakeWork: boolean | null;
}

type LastWorkerLost = { crashing: Outcome; queued: Outcome; later: Outcome; allExited: boolean };
type Recycle = { first: Outcome; queued: Outcome; later: Outcome; allExited: boolean };
type Timeout = { hung: Outcome; next: Outcome; afterwards: Outcome; hungExited: boolean };
type Honest = { proved: number; refused: number; pending: number; settled: boolean };

/** Runs one case of the fixture and returns what it reported; the fixture shuts its pool down before it exits. */
function runPool<Seen>(scenario: Record<string, unknown>): Promise<PoolRun & Seen> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [FIXTURE, JSON.stringify(scenario)], {
      cwd: REPO,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    const guard = setTimeout(() => child.kill(), 45_000);
    child.on('close', (code) => {
      clearTimeout(guard);
      const line = stdout.split(/\r?\n/).find((l) => l.startsWith(RESULT_MARKER));
      if (code !== 0 || !line) {
        reject(new Error(`the ${String(scenario.scenario)} run ended with code ${code} and no result\n${stderr.slice(-2_000)}`));
        return;
      }
      resolve(JSON.parse(line.slice(RESULT_MARKER.length)) as PoolRun & Seen);
    });
  });
}

const POOLS: Array<{ kind: PoolKind; name: string }> = [
  { kind: 'proof', name: "the engine's proof pool" },
  { kind: 'proving', name: 'the L2 batch proving pool' },
];

const NO_WORKER_LEFT = /no worker is left to prove/;

for (const { kind, name } of POOLS) {
  describe(`${name}, once no worker is left`, () => {
    test('refuses the job queued behind a last worker that crashed past its restart limit, and each job after it, at once', async () => {
      const run = await runPool<LastWorkerLost>({
        pool: kind, size: 1, options: { maxWorkerRestarts: 0 }, scenario: 'last-worker-lost',
      });
      expect(run.crashing.result).toBe('refused');
      expect(run.queued.result).toBe('refused'); // before: 'pending', queued for good with no worker to take it
      expect(run.queued.message).toMatch(NO_WORKER_LEFT); // before: no message, it never settled
      expect(run.queued.ms).toBeLessThan(2_000); // before: no time, it never settled
      expect(run.later.result).toBe('refused'); // before: 'pending', queued behind it
      expect(run.later.message).toMatch(NO_WORKER_LEFT); // before: no message
      expect(run.later.ms).toBeLessThan(500); // before: no time, it never settled
      expect(run.status.queueDepth).toBe(0); // before: 2
      expect(run.canTakeWork).toBe(false); // before: null, the pool had no canTakeWork()
      // The engine proves inline in its own process when its pool does not run, so isRunning() keeps its meaning.
      expect(run.isRunning).toBe(true);
    }, 60_000);

    test('refuses them as well when the replacement for a crashed worker fails its compile, and kills that replacement', async () => {
      const run = await runPool<LastWorkerLost>({
        pool: kind, size: 1, options: { maxWorkerRestarts: 3 }, forks: ['ready', 'compile-failed'], scenario: 'last-worker-lost',
      });
      expect(run.crashing.result).toBe('refused');
      expect(run.forks).toBe(2);
      expect(run.queued.result).toBe('refused'); // before: 'pending', queued for good
      expect(run.queued.message).toMatch(NO_WORKER_LEFT); // before: no message
      expect(run.later.result).toBe('refused'); // before: 'pending'
      expect(run.later.ms).toBeLessThan(500); // before: no time, it never settled
      expect(run.allExited).toBe(true); // before: false, the replacement that failed its compile kept running
      expect(run.canTakeWork).toBe(false); // before: null, the pool had no canTakeWork()
    }, 60_000);

    test("refuses them as well when a planned recycle's replacement fails its compile, and kills that replacement", async () => {
      const run = await runPool<Recycle>({
        pool: kind, size: 1, options: { recycleAfterJobs: 1 }, forks: ['ready', 'compile-failed'], scenario: 'recycle',
      });
      expect(run.first.result).toBe('proved');
      expect(run.queued.result).toBe('refused'); // before: 'pending', queued for the replacement for good
      expect(run.queued.message).toMatch(NO_WORKER_LEFT); // before: no message
      expect(run.later.result).toBe('refused'); // before: 'pending'
      expect(run.later.ms).toBeLessThan(500); // before: no time, it never settled
      expect(run.allExited).toBe(true); // before: false, the replacement that failed its compile kept running
      expect(run.canTakeWork).toBe(false); // before: null, the pool had no canTakeWork()
    }, 60_000);
  });
}

describe('a prove that times out costs its worker, not the next job', () => {
  test("the engine's proof pool kills the worker, and the next job goes to the other worker and is answered at once", async () => {
    const run = await runPool<Timeout>({ pool: 'proof', size: 2, options: { proveTimeoutMs: 1_000 }, scenario: 'timeout' });
    expect(run.hung.result).toBe('refused');
    expect(run.hung.message).toMatch(/Prove timeout after 1000ms/);
    expect(run.next.result).toBe('proved'); // before: 'refused' at its own timeout, sent to the worker still proving the abandoned job
    expect(run.next.pid).toBe(run.pids[1]); // before: no pid, it was never answered
    expect(run.next.ms).toBeLessThan(1_000); // before: about 1000, its whole timeout
    expect(run.afterwards.result).toBe('proved'); // before: 'refused', sent to that worker again
    expect(run.hungExited).toBe(true); // before: false, the worker was left running
    expect(run.forks).toBe(3); // before: 2, nothing replaced the worker
    expect(run.workers[0].restartCount).toBe(1); // before: 0; the timeout now counts against the restart limit
    expect(run.canTakeWork).toBe(true); // before: null, the pool had no canTakeWork()
  }, 60_000);

  test("with one worker, the engine's proof pool answers the next job from the worker that replaced the killed one", async () => {
    const run = await runPool<Timeout>({ pool: 'proof', size: 1, options: { proveTimeoutMs: 1_000 }, scenario: 'timeout' });
    expect(run.hung.result).toBe('refused');
    expect(run.next.result).toBe('proved'); // before: 'refused' at its own timeout, behind the abandoned job
    expect(run.next.pid).toBe(run.pids[1]); // before: no pid, and no second worker was ever forked
    expect(run.afterwards.result).toBe('proved'); // before: 'refused'
    expect(run.hungExited).toBe(true); // before: false, the worker was left running
    expect(run.workers[0].restartCount).toBe(1); // before: 0
  }, 60_000);

  for (const size of [2, 1]) {
    test(`the L2 batch proving pool already killed and replaced the worker, with ${size} worker(s)`, async () => {
      const run = await runPool<Timeout>({ pool: 'proving', size, options: { proveTimeoutMs: 1_000 }, scenario: 'timeout' });
      expect(run.hung.result).toBe('refused');
      expect(run.hung.message).toMatch(/prove timeout after 1000ms/);
      // With two workers the other one answers; with one, the worker forked to replace the killed one.
      expect(run.next.result).toBe('proved');
      expect(run.next.pid).toBe(run.pids[1]);
      expect(run.afterwards.result).toBe('proved');
      expect(run.hungExited).toBe(true);
      expect(run.forks).toBe(size + 1);
    }, 60_000);
  }
});

describe('a healthy pool', () => {
  for (const { kind, name } of POOLS) {
    test(`${name} proves every job of three waves as before, recycling its workers, with none refused and no worker lost`, async () => {
      const run = await runPool<Honest>({ pool: kind, size: 2, options: { recycleAfterJobs: 3 }, scenario: 'honest' });
      expect(run.proved).toBe(12);
      expect(run.refused).toBe(0);
      expect(run.pending).toBe(0);
      expect(run.status.totalJobsCompleted).toBe(12);
      expect(run.status.totalJobsFailed).toBe(0);
      // Every exit is a recycle's, and each recycled worker was replaced once: the pool holds two ready workers.
      expect(run.settled).toBe(true);
      expect(run.exits).toBeGreaterThanOrEqual(1);
      expect(run.forks - run.exits).toBe(2);
      expect(run.workers.every((w) => w.status === 'idle')).toBe(true);
    }, 60_000);
  }
});
