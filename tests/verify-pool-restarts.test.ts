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
 * The verifier pool keeps verifying past its first few hundred proofs, a failed worker costs one replacement, a worker
 * that cannot start or raises an error is a failure like a crash, and a planned recycle never leaves the pool short.
 *
 * What was wrong, in src/l2/l2-verify-pool.ts:
 *  1. A planned recycle counted as a restart. After recycleAfterJobs verifications a worker is asked to shut down, to
 *     release its WASM heap; its exit took the crash path, which spends one of maxRestarts, and nothing gives it back.
 *     So the pool stopped for good after (size + maxRestarts) x recycleAfterJobs verifications, 300 for the sequencer's
 *     transition verifier with the defaults (one worker, recycle after 50, at most 5 restarts), and refused every
 *     submission after that until the sequencer was restarted.
 *  2. After a recycle, the next submission could be sent to the recycled worker on its way out, and was refused when
 *     that worker exited: it stayed in rotation until its exit arrived.
 *  3. A job that timed out in the queue had no worker, yet its timeout replaced "worker -1". That started a worker
 *     which replaced nothing: the pool grew past its size and a restart was spent.
 *  4. A worker killed after a timeout or a failed send was replaced twice, once where it was killed and again by its
 *     own exit, which took the kill for a crash: two restarts for one failure, and the pool past its size.
 *
 * The first and third are in the option A specification (docs/research/a22-option-a-spec.md, 2026-10-24, section
 * 3.4, a prerequisite of step 1). The fourth was found reading the code for that step, and the second while writing
 * this test: with the first alone fixed, the third verification here was still refused.
 *
 * The review of option A step 1 (2026-10-24) found three more, with those four fixed:
 *  5. A worker that answered compile-failed, or never answered compile, stayed in the pool for good: never ready,
 *     never killed, never replaced. The real worker answers compile-failed and keeps running, so no exit came either.
 *     At size 1, the launcher's default, after a recycle whose replacement failed to compile once, every later
 *     submission waited and was refused at its deadline until the sequencer was restarted, with no restart counted and
 *     no alarm. Until the third was fixed, the queued job's timeout started a worker, which happened to recover it.
 *  6. The pool listened for no 'error' event from its workers, and Node throws an 'error' event nobody listens for. A
 *     send to a worker whose channel has closed is reported only that way: on Windows a dying worker's channel closes
 *     before its exit arrives, the worker is still in rotation in between, and a submission sent to it then took the
 *     sequencer down. So did a replacement that could not be started at all, reported only by an 'error' event too.
 *  7. A planned recycle took the worker out of rotation before its replacement had compiled. At size 1 every recycle
 *     left no ready worker for a whole StateTransition compile, and a submission arriving then was refused once the
 *     compile outlasted timeoutMs (20 s at the launcher). It was so before the second was fixed, too.
 *
 * Now a worker that answers compile-failed, or is not ready within readyTimeoutMs, is killed and counts as a failure,
 * replaced while maxRestarts allows, and reaching the cap raises the alarm. During start() such a worker refuses the
 * start, as a failed compile always did, and is not replaced; one that never answers refuses it once readyTimeoutMs
 * has passed, where the start used to wait for ever. An 'error' event is a failure like a failed send: the submission
 * in flight on that worker is refused, and the worker is killed and replaced once. A recycle's replacement compiles
 * while the old worker serves on and takes its place once ready, one recycle at a time, so the pool holds at most
 * size + 1 processes and never more, nor fewer, than size ready workers. A replacement that fails spends a restart,
 * and the old worker serves on until the recycle is tried again; an old worker that fails meanwhile hands its place
 * to the replacement already compiling, so no second one starts. The recycled worker leaves rotation before it is
 * told to stop, and its replacement spends no restart. A job that times out in the queue replaces nothing. A worker
 * the pool has let go, recycled or killed, is not replaced again by its exit. maxRestarts counts only failures.
 *
 * Jest cannot load the pool, whose default worker path comes from import.meta.url, so each case runs the real
 * VerifyPool in a child process, tests/helpers/verify-pool-stub.mjs, whose workers are that same file speaking the
 * worker protocol without o1js. The fixture counts every fork the pool makes, every exit of a forked worker and every
 * process that never started, and reads them once the pool has settled: each worker forked has exited, never started,
 * or is ready. It also keeps the most processes alive at once and, from the moment start() resolved, the most and the
 * fewest ready workers. The "before" comments of the first four cases describe the pool at 5bc3290; those of the
 * later cases describe it with the first four items fixed.
 */
import path from 'path';
import { spawn } from 'child_process';

const REPO = path.resolve(__dirname, '..');
const FIXTURE = path.join(REPO, 'tests', 'helpers', 'verify-pool-stub.mjs');
const RESULT_MARKER = '@@verify-pool ';

interface PoolRun {
  /** Every worker forked had exited, never started, or was ready when the counts were read. */
  settled: boolean;
  /** Workers the pool forked, the first `size` included. */
  forks: number;
  /** Forked workers that have exited. */
  exits: number;
  /** Forked workers whose process never started, and so never exits. */
  spawnFailures: number;
  /** The most forked processes alive at once. */
  maxLive: number;
  /** The most and the fewest ready workers the pool reported, from the moment start() resolved. */
  maxAlive: number;
  minAlive: number | null;
  /** How many times the pool logged that its replacement limit was reached. */
  alarms: number;
  stats: { size: number; alive: number; verified: number; meanMs: number; restarts: number };
}

/** Runs one scenario of the fixture and returns what it reported; the fixture shuts its pool down before it exits. */
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

type Sequential = { verified: number; refused: string | null };
type AfterHang = { hung: string; afterwards: string };
type Stream = { submitted: number; verified: number; refused: number; firstRefusal: string | null };

describe('planned recycles', () => {
  test('400 verifications pass through a pool that recycles every 2 and may restart once, and no recycle spends a restart', async () => {
    const run = await runPool<Sequential>({
      scenario: 'verify-many',
      pool: { size: 4, recycleAfterJobs: 2, maxRestarts: 1, timeoutMs: 10_000 },
      verifications: 400,
    });
    expect(run.refused).toBeNull(); // before: 'Proof rejected: verifier process exited mid-verification', the third
    expect(run.verified).toBe(400); // before: 2; with only item 2 fixed, 10, (4 + 1) x 2, and then nothing
    expect(run.stats.restarts).toBe(0); // before: 1, spent by the first recycle
    // A recycle starts once a worker has served its 2 and ends when its replacement is ready, the worker serving on
    // meanwhile, so how many fit into 400 depends on how fast a replacement starts: at least one, and at most 200, as
    // each recycled worker served at least 2. Until item 7 was fixed there were 198 to 200, the worker leaving
    // rotation at once. Nothing was killed here, so each exit is a recycle: each was replaced exactly once, and the
    // pool still holds 4.
    expect(run.settled).toBe(true);
    expect(run.exits).toBeGreaterThanOrEqual(1);
    expect(run.exits).toBeLessThanOrEqual(200);
    expect(run.forks).toBe(4 + run.exits);
    expect(run.stats.alive).toBe(4);
  }, 60_000);
});

describe('a failed worker costs one replacement, and the pool keeps its size', () => {
  test('a job that times out in the queue, while the only worker is still starting, starts no worker', async () => {
    const run = await runPool<{ queued: string; afterwards: string }>({
      scenario: 'queued-timeout',
      pool: { size: 1, maxRestarts: 5, timeoutMs: 400 },
      readyDelayMs: 1_200,
    });
    expect(run.queued).toBe('Proof rejected: verification did not finish within 400 ms');
    expect(run.settled).toBe(true);
    expect(run.forks).toBe(1); // before: 2, a worker started in place of "worker -1"
    expect(run.stats.alive).toBe(1); // before: 2, in a pool of size 1
    expect(run.stats.restarts).toBe(0); // before: 1
    expect(run.afterwards).toBe('verified');
  }, 60_000);

  test('a worker whose verification times out is replaced exactly once', async () => {
    const run = await runPool<AfterHang>({
      scenario: 'hang',
      pool: { size: 1, maxRestarts: 5, timeoutMs: 800 },
    });
    expect(run.hung).toBe('Proof rejected: verification did not finish within 800 ms');
    expect(run.settled).toBe(true);
    expect(run.exits).toBe(1); // the hung worker, killed
    expect(run.forks).toBe(2); // before: 3, the killed worker's exit started a second replacement
    expect(run.stats.alive).toBe(1); // before: 2, in a pool of size 1
    expect(run.stats.restarts).toBe(1); // before: 2
    expect(run.afterwards).toBe('verified');
  }, 60_000);

  test('a worker the pool could not send to is replaced exactly once', async () => {
    const run = await runPool<{ unsent: string; afterwards: string }>({
      scenario: 'send-fails',
      pool: { size: 1, maxRestarts: 5, timeoutMs: 2_000 },
    });
    expect(run.unsent).toBe('Proof rejected: verifier process unavailable');
    expect(run.settled).toBe(true);
    expect(run.exits).toBe(1); // the worker the send failed on, killed
    expect(run.forks).toBe(2); // before: 3, the killed worker's exit started a second replacement
    expect(run.stats.alive).toBe(1); // before: 2, in a pool of size 1
    expect(run.stats.restarts).toBe(1); // before: 2
    expect(run.afterwards).toBe('verified');
  }, 60_000);
});

describe('a worker that fails before start() resolves refuses the start, and is not replaced', () => {
  test('one that answers compile-failed refuses the start and is killed', async () => {
    const run = await runPool<{ start: string }>({
      scenario: 'start',
      pool: { size: 1, maxRestarts: 5 },
      forks: ['compile-failed'],
    });
    expect(run.start).toBe('verifier worker 0 could not start: the stub was told to fail its compile');
    expect(run.settled).toBe(true); // before: false, the worker left running
    expect(run.exits).toBe(1); // before: 0
    expect(run.forks).toBe(1);
    expect(run.stats.restarts).toBe(0);
  }, 60_000);

  test('one that never answers compile refuses the start once the ready timeout passes', async () => {
    const run = await runPool<{ start: string }>({
      scenario: 'start',
      pool: { size: 1, maxRestarts: 5, readyTimeoutMs: 1_000 },
      forks: ['silent'],
    }); // before: rejected, no result: the start never settled, and the run was killed after 45 s
    expect(run.start).toBe('verifier worker 0 could not start: not ready within 1000 ms');
    expect(run.settled).toBe(true);
    expect(run.exits).toBe(1);
    expect(run.forks).toBe(1);
    expect(run.stats.restarts).toBe(0);
  }, 60_000);
});

describe('a worker that cannot start is a failure, replaced while the restarts last', () => {
  test('a recycle whose replacement answers compile-failed leaves the worker serving, and the next attempt replaces it', async () => {
    // Worker 0 is due after 2. Its first replacement fails its compile; worker 0 serves the next submission, which
    // starts a second replacement, and that one takes its place.
    const run = await runPool<Sequential>({
      scenario: 'batches',
      pool: { size: 1, recycleAfterJobs: 2, maxRestarts: 5, timeoutMs: 1_000 },
      forks: ['ready', 'compile-failed'],
      batches: [2, 1, 1],
    });
    expect(run.refused).toBeNull(); // before: 'Proof rejected: verification did not finish within 1000 ms', the first submission after the recycle
    expect(run.verified).toBe(4); // before: 2, and every later submission refused the same way
    expect(run.settled).toBe(true); // before: false, the failed replacement neither ready nor gone
    expect(run.forks).toBe(3); // before: 2, nothing replaced the failed replacement
    expect(run.exits).toBe(2); // the failed replacement, killed, and worker 0, recycled; before: 1, worker 0
    expect(run.stats.alive).toBe(1); // before: 0
    expect(run.stats.restarts).toBe(1); // before: 0
    expect(run.alarms).toBe(0);
  }, 60_000);

  test('a replacement that answers compile-failed is killed and replaced, and the pool verifies again', async () => {
    const run = await runPool<AfterHang>({
      scenario: 'hang',
      pool: { size: 1, maxRestarts: 5, timeoutMs: 800 },
      forks: ['ready', 'compile-failed'],
    });
    expect(run.hung).toBe('Proof rejected: verification did not finish within 800 ms');
    expect(run.settled).toBe(true); // before: false, the failed replacement neither ready nor gone
    expect(run.exits).toBe(2); // the hung worker and the failed replacement, both killed; before: 1, the hung worker
    expect(run.forks).toBe(3); // before: 2
    expect(run.stats.alive).toBe(1); // before: 0
    expect(run.stats.restarts).toBe(2); // before: 1
    expect(run.afterwards).toBe('verified'); // before: 'Proof rejected: verification did not finish within 800 ms'
  }, 60_000);

  test('a replacement that never answers compile is killed after the ready timeout and replaced', async () => {
    // The ready timeout covers every worker, the stub workers that answer at once included, so it is kept well above
    // what starting one takes on a busy machine.
    const run = await runPool<AfterHang>({
      scenario: 'hang',
      pool: { size: 1, maxRestarts: 5, timeoutMs: 800, readyTimeoutMs: 3_000 },
      forks: ['ready', 'silent'],
    });
    expect(run.hung).toBe('Proof rejected: verification did not finish within 800 ms');
    expect(run.settled).toBe(true); // before: false, the silent replacement neither ready nor gone
    expect(run.exits).toBe(2); // the hung worker and the silent replacement, both killed; before: 1, the hung worker
    expect(run.forks).toBe(3); // before: 2
    expect(run.stats.alive).toBe(1); // before: 0
    expect(run.stats.restarts).toBe(2); // before: 1
    expect(run.afterwards).toBe('verified'); // before: 'Proof rejected: verification did not finish within 800 ms'
  }, 60_000);

  test('replacements that keep failing spend the restarts and raise the alarm, and the worker they were for serves on', async () => {
    // One restart: the first failed replacement spends it, and the second finds it spent. Worker 0 is not recycled
    // again, so the last two submissions start nothing.
    const run = await runPool<Sequential>({
      scenario: 'batches',
      pool: { size: 1, recycleAfterJobs: 2, maxRestarts: 1, timeoutMs: 1_000 },
      forks: ['ready', 'compile-failed', 'compile-failed'],
      batches: [2, 1, 1, 1],
    });
    expect(run.refused).toBeNull(); // before: 'Proof rejected: verification did not finish within 1000 ms', the first submission after the recycle
    expect(run.verified).toBe(5); // before: 2
    expect(run.settled).toBe(true); // before: false
    expect(run.forks).toBe(3); // worker 0 and two replacements; before: 2
    expect(run.exits).toBe(2); // the two replacements, killed; before: 1, worker 0, recycled
    expect(run.stats.alive).toBe(1); // before: 0
    expect(run.stats.restarts).toBe(1); // before: 0
    expect(run.alarms).toBe(1); // before: 0
  }, 60_000);
});

describe('an error event from a worker is a failure, not a crash', () => {
  test('a submission sent to a worker whose channel has closed is refused, and the worker is replaced once', async () => {
    // The real event: the worker closes its channel and stays up, and the next submission is sent to it once this
    // side has seen the channel close. Node reports that send only by an 'error' event on the ChildProcess.
    const run = await runPool<{ first: string; unsent: string; afterwards: string }>({
      scenario: 'channel-closed',
      pool: { size: 1, maxRestarts: 5, timeoutMs: 2_000 },
    }); // before: rejected, the run ended with code 1, the pool's process killed by the unhandled 'error' event (ERR_IPC_CHANNEL_CLOSED)
    expect(run.first).toBe('verified');
    expect(run.unsent).toBe('Proof rejected: verifier process unavailable');
    expect(run.settled).toBe(true);
    expect(run.exits).toBe(1); // the worker whose channel closed, killed
    expect(run.forks).toBe(2);
    expect(run.stats.alive).toBe(1);
    expect(run.stats.restarts).toBe(1);
    expect(run.afterwards).toBe('verified');
  }, 60_000);

  test('a replacement that cannot be started at all is replaced once, and recycling goes on', async () => {
    // Worker 0 hangs and is killed. The process meant to replace it cannot be started, which Node reports only by an
    // 'error' event, with no exit after it. The next one replaces it, serves 2 and is recycled.
    const run = await runPool<AfterHang>({
      scenario: 'hang',
      pool: { size: 1, recycleAfterJobs: 2, maxRestarts: 5, timeoutMs: 800 },
      forks: ['ready', 'spawn-fails'],
      afterwards: 2,
    }); // before: rejected, the run ended with code 1, the pool's process killed by the unhandled 'error' event (spawn ENOENT)
    expect(run.hung).toBe('Proof rejected: verification did not finish within 800 ms');
    expect(run.afterwards).toBe('verified');
    expect(run.settled).toBe(true);
    expect(run.spawnFailures).toBe(1);
    // No exit comes for a process that never started, so it leaves the pool on its error. Left in, it would keep the
    // pool above its size for good, and no recycle could start: 3 forks and 1 exit.
    expect(run.forks).toBe(4);
    expect(run.exits).toBe(2); // the hung worker, killed, and the replacement that started, recycled
    expect(run.stats.alive).toBe(1);
    expect(run.stats.restarts).toBe(2); // the hang, and the process that never started
  }, 60_000);
});

describe('a planned recycle keeps the worker serving until its replacement is ready', () => {
  test('with one worker whose compile outlasts the deadline, a steady stream through three recycles is never refused', async () => {
    // A compile takes 1 s against a 600 ms deadline; a submission every 50 ms until three recycled workers have exited.
    const run = await runPool<Stream>({
      scenario: 'stream',
      pool: { size: 1, recycleAfterJobs: 3, maxRestarts: 5, timeoutMs: 600 },
      readyDelayMs: 1_000,
      intervalMs: 50,
      recycles: 3,
      verifications: 300,
    });
    expect(run.firstRefusal).toBeNull(); // before: 'Proof rejected: verification did not finish within 600 ms'
    expect(run.refused).toBe(0); // before: 32 of 41 in one run, every submission that arrived while a replacement compiled
    expect(run.verified).toBe(run.submitted); // before: 9, 3 per worker
    expect(run.minAlive).toBe(1); // before: 0, from each recycle until its replacement was ready
    expect(run.maxAlive).toBe(1);
    expect(run.maxLive).toBeLessThanOrEqual(2);
    expect(run.exits).toBeGreaterThanOrEqual(3);
    expect(run.settled).toBe(true);
    expect(run.forks).toBe(1 + run.exits);
    expect(run.stats.alive).toBe(1);
    expect(run.stats.restarts).toBe(0);
    expect(run.alarms).toBe(0);
  }, 60_000);

  test('a worker that fails while its recycle replacement compiles hands it its place, and no second replacement starts', async () => {
    // Compiles take 1.5 s. Worker 0 is due after 2 and its replacement starts compiling; worker 0 serves on, and hangs
    // on the next submission, whose 500 ms deadline passes long before that compile ends.
    const run = await runPool<AfterHang>({
      scenario: 'hang',
      pool: { size: 1, recycleAfterJobs: 2, maxRestarts: 5, timeoutMs: 500 },
      readyDelayMs: 1_500,
      beforeHang: 2,
    });
    expect(run.hung).toBe('Proof rejected: verification did not finish within 500 ms');
    expect(run.settled).toBe(true);
    expect(run.forks).toBe(2); // worker 0, and the replacement it already had
    expect(run.exits).toBe(1); // worker 0, killed
    expect(run.stats.alive).toBe(1);
    expect(run.maxAlive).toBe(1);
    expect(run.stats.restarts).toBe(1); // before: 0, the hung submission timed out in the queue, worker 0 having left rotation at the recycle
    expect(run.afterwards).toBe('verified');
  }, 60_000);

  test('with two workers due at once, recycles run one at a time: at most three processes, and two ready throughout', async () => {
    // Two submissions every 20 ms, one to each worker, so both are due for a recycle at the same moment.
    const run = await runPool<Stream>({
      scenario: 'stream',
      pool: { size: 2, recycleAfterJobs: 3, maxRestarts: 5, timeoutMs: 400 },
      readyDelayMs: 600,
      intervalMs: 20,
      perTick: 2,
      recycles: 4,
      verifications: 400,
    });
    expect(run.refused).toBe(0); // before: 48 of 60 in one run
    expect(run.verified).toBe(run.submitted); // before: 12, 3 per worker
    expect(run.maxLive).toBeLessThanOrEqual(3); // before: 4, both workers recycled at once
    expect(run.minAlive).toBe(2); // before: 0
    expect(run.maxAlive).toBe(2);
    expect(run.exits).toBeGreaterThanOrEqual(4);
    expect(run.settled).toBe(true);
    expect(run.forks).toBe(2 + run.exits);
    expect(run.stats.alive).toBe(2);
    expect(run.stats.restarts).toBe(0);
  }, 60_000);
});
