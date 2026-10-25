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
 * Parent side of out-of-process proof verification.
 *
 * Holds one or more `l2-verify-worker` children, each with its own o1js context, and
 * exposes a `TransitionProofVerifier` so the sequencer is unchanged: it still awaits a
 * verdict before touching any state, and still refuses outright when no verifier is set.
 *
 * Four properties this has to keep, in priority order:
 *
 *   1. **Nothing is accepted without a verdict.** Every failure path — a dead worker, a
 *      timeout, a mismatched key, a queue that never drains — throws. There is no branch
 *      that returns normally without a worker having said `valid: true`.
 *   2. **A stuck worker cannot hold a submission open.** Each request has a deadline; past
 *      it the submission is refused and the worker is replaced, because a verification that
 *      hangs once will hang again.
 *   3. **A crash must not become a silent outage.** Workers restart, with a cap, and the
 *      cap being reached is loud. Only failures spend the cap, and a failed worker is
 *      replaced once. A failure is a crash, a timeout, a failed send, an error event from
 *      the process, or a worker that cannot compile or is not ready in time, and none of
 *      them may escape as an exception that takes the sequencer down.
 *   4. **A planned recycle costs no capacity.** The replacement compiles while the worker
 *      it replaces keeps serving, and takes over only once it is ready.
 */
import { fork, type ChildProcess } from 'child_process';
import { childEnvironment } from '../security/node-roles.js';
import path from 'path';
import { fileURLToPath } from 'url';
import { ProofRejected, VERIFY_TIMEOUT_MS } from './l2-proof-verifier.js';
import type { TransitionProofVerifier } from './l2-proof-verifier.js';
import type { StateTransitionProof } from '../engine/state-transition.js';
import type { VerifyRequest, VerifyResponse } from './l2-verify-worker.js';

/**
 * How long a worker may take to compile and report ready before it counts as failed.
 * StateTransitionProgram compiles in the worker in about 5 s: 4.6 s measured at boot, and
 * 7.2 s in the sequencer's own process on a genesis boot (scripts/e2e-verify/
 * PLAN-security-hardening.md). Five minutes is some forty times the slower figure, room for
 * a cold key cache and a machine busy proving batches, and still a bound on how long a
 * worker that will never be ready holds its place.
 */
const DEFAULT_READY_TIMEOUT_MS = 5 * 60_000;

export interface VerifyPoolOptions {
  /** How many verifier processes. One is enough for ~1 s verifications at low rates. */
  size?: number;
  /** Verification key hash this deployment expects; a worker reporting another refuses to start. */
  expectedVkHash?: string;
  /**
   * Replace a worker after this many verifications, to release WASM heap. 0 disables. The
   * replacement compiles while the worker keeps serving, and takes its place once ready. One
   * recycle runs at a time, so the pool holds at most size + 1 processes and never more than
   * `size` ready workers. A recycle is planned, so it does not count against `maxRestarts`; a
   * replacement that fails does, and the worker it was to replace serves on until the recycle
   * is tried again, after that worker's next verification.
   */
  recycleAfterJobs?: number;
  /** Give up on a single verification after this long and refuse the submission. */
  timeoutMs?: number;
  /**
   * How many failed workers may be replaced before the pool gives up, which it says loudly: a
   * crash, a timeout, a failed send, an error event, a failed compile, a worker not ready within
   * `readyTimeoutMs`, and a recycle's replacement that fails all count.
   */
  maxRestarts?: number;
  /**
   * How long a worker may take to compile and report ready. Past it the worker is killed and
   * counts as a failure; during start() the boot is refused instead. Defaults to five minutes.
   */
  readyTimeoutMs?: number;
  /** Absolute path to the worker script. Defaults to the sibling `l2-verify-worker.ts`. */
  workerScriptPath?: string;
}

interface Pending {
  resolve: (valid: boolean) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  workerId: number;
}

interface Worker {
  id: number;
  child: ChildProcess;
  /** Compiled and in rotation. */
  ready: boolean;
  jobs: number;
  busy: boolean;
  /**
   * Out of rotation for good: recycled, or failed and killed. Whatever its place needed was
   * done when it was retired, so neither its exit nor a later error starts anything. It stays
   * in `workers` until it exits, so a recycled worker can finish the verification it holds.
   */
  retired: boolean;
  /** Started by start(): if it fails before it is ready, start() refuses rather than replacing it. */
  initial: boolean;
  /** Runs from the fork until the worker is ready, and fails a worker that never gets there. */
  readyTimer: ReturnType<typeof setTimeout> | null;
  /** In a planned recycle, the worker this one takes over from once it is ready. */
  replaces: Worker | null;
  /** A replacement for it failed after the restarts were spent, so it serves on without recycling. */
  recycleAbandoned: boolean;
}

function defaultWorkerPath(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'l2-verify-worker.ts');
}

export class VerifyPool {
  private readonly size: number;
  private readonly expectedVkHash?: string;
  private readonly recycleAfterJobs: number;
  private readonly timeoutMs: number;
  private readonly maxRestarts: number;
  private readonly readyTimeoutMs: number;
  private readonly workerScriptPath: string;

  /** Every worker forked and not yet exited: starting, in rotation, or retired and on its way out. */
  private workers: Worker[] = [];
  private pending = new Map<string, Pending>();
  private queue: Array<{ proofJson: unknown; id: string }> = [];
  private nextWorkerId = 0;
  private nextJobId = 0;
  /** Failures that spent one of `maxRestarts`; planned recycles are not counted. */
  private restarts = 0;
  private shuttingDown = false;
  private vkHash: string | null = null;

  private verified = 0;
  private totalMs = 0;

  constructor(options: VerifyPoolOptions = {}) {
    this.size = Math.max(1, options.size ?? 1);
    this.expectedVkHash = options.expectedVkHash;
    this.recycleAfterJobs = options.recycleAfterJobs ?? 50;
    this.timeoutMs = options.timeoutMs ?? VERIFY_TIMEOUT_MS;
    this.maxRestarts = options.maxRestarts ?? 5;
    this.readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    this.workerScriptPath = options.workerScriptPath ?? defaultWorkerPath();
  }

  /**
   * Fork the workers and wait until each has compiled and reported a matching key. A worker
   * that fails before it is ready refuses the start and is not replaced: the boot stops instead.
   */
  async start(): Promise<{ vkHash: string; compileMs: number }> {
    const results = await Promise.all(
      Array.from({ length: this.size }, () => this.spawn({ initial: true })),
    );
    this.vkHash = results[0].vkHash;
    return { vkHash: results[0].vkHash, compileMs: Math.max(...results.map((r) => r.compileMs)) };
  }

  /** The verification key every worker in this pool is checking against. */
  getVkHash(): string | null {
    return this.vkHash;
  }

  stats(): { size: number; alive: number; verified: number; meanMs: number; restarts: number } {
    return {
      size: this.size,
      alive: this.workers.filter((w) => w.ready).length,
      verified: this.verified,
      meanMs: this.verified ? Math.round(this.totalMs / this.verified) : 0,
      restarts: this.restarts,
    };
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    for (const w of this.workers) {
      if (w.readyTimer) clearTimeout(w.readyTimer);
      try {
        w.child.send({ type: 'shutdown' } satisfies VerifyRequest);
      } catch { /* already gone */ }
    }
    this.workers = [];
  }

  /**
   * The verifier handed to the sequencer. Resolves only when a worker has returned
   * `valid: true`; every other outcome throws.
   */
  asVerifier(): TransitionProofVerifier {
    return async (proof: StateTransitionProof): Promise<void> => {
      const valid = await this.verifyProof(proof.toJSON());
      if (!valid) {
        throw new ProofRejected(
          'invalid',
          "Proof rejected: not valid against this deployment's verification key",
        );
      }
    };
  }

  private verifyProof(proofJson: unknown): Promise<boolean> {
    if (this.shuttingDown) {
      return Promise.reject(new ProofRejected('timeout', 'Proof rejected: verifier is shutting down'));
    }
    const id = `v${this.nextJobId++}`;
    const promise = new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(() => {
        const entry = this.pending.get(id);
        this.pending.delete(id);
        if (entry && entry.workerId >= 0) {
          // A verification that overran will overrun again: replace the worker rather than
          // leave a wedged one in rotation. A job that timed out in the queue never had a
          // worker, so there is none to replace; replacing anyway grew the pool past its size.
          this.replaceWorker(entry.workerId, 'verification timed out');
        }
        reject(new ProofRejected('timeout', `Proof rejected: verification did not finish within ${this.timeoutMs} ms`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer, workerId: -1 });
    });
    this.dispatch({ proofJson, id });
    return promise;
  }

  private dispatch(job: { proofJson: unknown; id: string }): void {
    const worker = this.workers.find((w) => w.ready && !w.busy);
    if (!worker) {
      this.queue.push(job);
      return;
    }
    const entry = this.pending.get(job.id);
    if (!entry) return; // already timed out
    entry.workerId = worker.id;
    worker.busy = true;
    try {
      worker.child.send({ type: 'verify', id: job.id, proofJson: job.proofJson } satisfies VerifyRequest);
    } catch (err) {
      worker.busy = false;
      this.fail(job.id, new ProofRejected('timeout', 'Proof rejected: verifier process unavailable'));
      this.replaceWorker(worker.id, 'send failed');
    }
  }

  private fail(id: string, err: Error): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(id);
    entry.reject(err);
  }

  private spawn(role: { initial?: boolean; replaces?: Worker } = {}): Promise<{ vkHash: string; compileMs: number }> {
    const id = this.nextWorkerId++;
    const child = fork(this.workerScriptPath, [], {
      execArgv: process.execArgv,
      serialization: 'json',
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      env: childEnvironment(process.env, {}), // A9: a verifier holds no credential
    });
    const worker: Worker = {
      id, child, ready: false, jobs: 0, busy: false, retired: false,
      initial: role.initial ?? false, readyTimer: null, replaces: role.replaces ?? null, recycleAbandoned: false,
    };
    this.workers.push(worker);

    child.stderr?.on('data', (d: Buffer) => {
      const line = d.toString().trim();
      if (line) console.error('  [verify:w%d] %s', id, line.slice(0, 400));
    });

    return new Promise((resolve, reject) => {
      // A worker that never gets to ready has failed as surely as one that crashes. One that
      // answered compile-failed, or nothing, used to stay in the pool for good, neither ready
      // nor replaced, and at size 1 every submission after it was refused.
      const notReady = (why: string): void => {
        reject(new Error(`verifier worker ${id} could not start: ${why}`));
        this.failed(worker, why);
      };
      worker.readyTimer = setTimeout(() => notReady(`not ready within ${this.readyTimeoutMs} ms`), this.readyTimeoutMs);

      const onMessage = (msg: VerifyResponse): void => {
        switch (msg.type) {
          case 'ready':
            // Given up on, or the pool shut down, before this arrived.
            if (worker.retired || this.shuttingDown) break;
            this.admit(worker);
            resolve({ vkHash: msg.vkHash, compileMs: msg.compileMs });
            this.drain();
            break;
          case 'compile-failed':
            if (!worker.retired) notReady(msg.message);
            break;
          case 'result': {
            worker.busy = false;
            worker.jobs++;
            const entry = this.pending.get(msg.id);
            if (entry) {
              clearTimeout(entry.timer);
              this.pending.delete(msg.id);
              this.verified++;
              this.totalMs += msg.verifyMs;
              if (this.verified === 1 || this.verified % 50 === 0) {
                console.log(
                  '  [verify] %d verified, %d ms last, %d ms mean',
                  this.verified, msg.verifyMs, Math.round(this.totalMs / this.verified),
                );
              }
              entry.resolve(msg.valid);
            }
            this.afterJob(worker);
            break;
          }
          case 'error': {
            worker.busy = false;
            worker.jobs++;
            this.fail(
              msg.id,
              new ProofRejected(
                msg.undecodable ? 'undecodable' : 'invalid',
                `Proof rejected: ${msg.message}`,
              ),
            );
            this.afterJob(worker);
            break;
          }
        }
      };
      child.on('message', onMessage);

      // Node reports some failures of a child process only as an 'error' event, and throws an
      // 'error' event nobody listens for, which took the sequencer down. The usual one is a send
      // to a worker whose channel has closed while its exit has not arrived: on Windows the
      // channel closes first, and the worker is still in rotation in between. A process that
      // could not be started at all is reported the same way and sends no exit, so it leaves
      // the pool here.
      child.on('error', (err) => {
        if (child.pid === undefined) this.workers = this.workers.filter((w) => w !== worker);
        if (this.shuttingDown || worker.retired) return;
        console.error('  [verify] worker %d: %s', id, err.message);
        reject(new Error(`verifier worker ${id} could not start: ${err.message}`));
        this.failed(worker, err.message);
      });

      child.on('exit', (code) => {
        const wasBusy = worker.busy;
        this.workers = this.workers.filter((w) => w !== worker);
        // Anything that was in flight on this worker has no verdict, so it is refused.
        for (const [jobId, entry] of [...this.pending]) {
          if (entry.workerId === worker.id) {
            this.fail(jobId, new ProofRejected('timeout', 'Proof rejected: verifier process exited mid-verification'));
          }
        }
        reject(new Error(`verifier worker ${id} exited before becoming ready (code ${code})`));
        // A retired worker's place was dealt with when it was retired. Only an exit nobody
        // asked for is a crash.
        if (!this.shuttingDown && !worker.retired) {
          console.error('  [verify] worker %d exited (code %s)%s', worker.id, code, wasBusy ? ' while verifying' : '');
          this.failed(worker, `exited with code ${code}`);
        }
      });

      child.send({ type: 'compile', expectedVkHash: this.expectedVkHash } satisfies VerifyRequest);
    });
  }

  /**
   * Puts a worker that has compiled into rotation. A recycle's replacement takes over from the
   * worker it replaces in the same step, so a recycle never leaves the pool with fewer ready
   * workers, nor with more than `size`. The old worker finishes a verification it holds, then
   * is told to stop.
   */
  private admit(worker: Worker): void {
    if (worker.readyTimer) clearTimeout(worker.readyTimer);
    worker.readyTimer = null;
    worker.ready = true;
    const predecessor = worker.replaces;
    worker.replaces = null;
    if (predecessor) {
      console.log('  [verify] worker %d takes the place of recycled worker %d', worker.id, predecessor.id);
      this.retire(predecessor);
      if (!predecessor.busy) this.stop(predecessor);
    }
  }

  /**
   * After a worker answers a verification. A retired worker has given its last answer: one
   * recycled while it was verifying, or one killed just after it finished. Either is told to
   * stop, and only a worker still in rotation can be due for a recycle.
   */
  private afterJob(worker: Worker): void {
    if (worker.retired) this.stop(worker);
    else this.maybeRecycle(worker);
    this.drain();
  }

  /**
   * Starts the planned recycle of a worker that has done its share: its replacement compiles
   * while it keeps serving, and takes over once ready (see admit). The worker used to leave
   * rotation first, so at size 1 every recycle left no ready worker for a whole compile, and a
   * submission arriving then was refused once the compile outlasted `timeoutMs`. One recycle
   * runs at a time: a recycle starts only while the pool holds no more processes than its size,
   * and a worker kept waiting asks again after its next verification.
   */
  private maybeRecycle(worker: Worker): void {
    if (this.shuttingDown || worker.recycleAbandoned) return;
    if (this.recycleAfterJobs <= 0 || worker.jobs < this.recycleAfterJobs) return;
    if (this.workers.length > this.size) return;
    console.log('  [verify] recycling worker %d after %d verifications', worker.id, worker.jobs);
    this.spawn({ replaces: worker }).catch(() => { /* failed() has dealt with it, and said so */ });
  }

  /**
   * Gives up on a worker that overran a verification or could not be sent to. A retired worker
   * was recycled while it held that verification and its replacement already has its place, so
   * it is only killed.
   */
  private replaceWorker(workerId: number, reason: string): void {
    if (this.shuttingDown) return;
    const worker = this.workers.find((w) => w.id === workerId);
    if (!worker) return; // its exit came first, and dealt with it
    if (worker.retired) {
      try { worker.child.kill(); } catch { /* already gone */ }
      return;
    }
    this.failed(worker, reason);
  }

  /**
   * A worker has failed: it crashed, overran a verification, could not be sent to, raised an
   * error event, could not compile, or was not ready in time. It is retired and killed, and a
   * verification it held is refused. Then its place is filled once, because a retired worker is
   * never handled again; a killed worker's own exit used to replace it a second time, which grew
   * the pool past its size and spent two restarts on one failure.
   *  - A worker that start() is still waiting for is not replaced: start() refuses the boot.
   *  - A recycle's replacement that fails leaves the worker it was to replace serving. The
   *    failure spends a restart and the recycle is tried again after that worker's next
   *    verification; once the restarts are spent, that worker serves on without recycling.
   *  - A worker whose recycle replacement is already compiling hands it its place. The failure
   *    counts, but nothing more is started: a second replacement would leave the pool, once
   *    both were ready, with more than `size` ready workers.
   *  - Any other worker is replaced, while the restarts last.
   */
  private failed(worker: Worker, reason: string): void {
    if (this.shuttingDown || worker.retired) return;
    const neverReady = worker.readyTimer !== null;
    this.retire(worker);
    try { worker.child.kill(); } catch { /* already gone */ }
    for (const [jobId, entry] of [...this.pending]) {
      if (entry.workerId === worker.id) {
        this.fail(jobId, new ProofRejected('timeout', 'Proof rejected: verifier process unavailable'));
      }
    }
    if (worker.initial && neverReady) return;

    const predecessor = worker.replaces;
    if (predecessor) {
      worker.replaces = null;
      console.error(
        '  [verify] the replacement for worker %d failed (%s); worker %d serves on',
        predecessor.id, reason, predecessor.id,
      );
      if (!this.spendRestart(reason, `Worker ${predecessor.id} serves on and is no longer recycled.`)) {
        predecessor.recycleAbandoned = true;
      }
      return;
    }
    const successor = this.workers.find((w) => w.replaces === worker);
    if (successor) {
      successor.replaces = null;
      this.spendRestart(reason, `Worker ${successor.id}, already starting, takes its place.`);
      return;
    }
    if (this.spendRestart(reason, 'Submissions will be refused until the sequencer is restarted.')) {
      this.startReplacement(reason);
    }
  }

  /** Takes a worker out of rotation for good: no job is sent to it, and nothing more is done for its place. */
  private retire(worker: Worker): void {
    worker.retired = true;
    worker.ready = false;
    if (worker.readyTimer) clearTimeout(worker.readyTimer);
    worker.readyTimer = null;
  }

  private stop(worker: Worker): void {
    try {
      worker.child.send({ type: 'shutdown' } satisfies VerifyRequest);
    } catch { /* already gone */ }
  }

  /**
   * Spends one of `maxRestarts` on a failure or, once they are all spent, says so loudly and
   * returns false. Planned recycles spend nothing: when they counted too, the pool stopped for
   * good after (size + maxRestarts) x recycleAfterJobs verifications, 300 with the defaults,
   * and refused every submission after that until the sequencer was restarted (option A, step 1).
   */
  private spendRestart(reason: string, consequence: string): boolean {
    if (this.restarts >= this.maxRestarts) {
      console.error(
        '  [verify] worker replacement limit reached (%d). %s Last reason: %s',
        this.maxRestarts, consequence, reason,
      );
      return false;
    }
    this.restarts++;
    return true;
  }

  /** Starts the worker that takes a failed worker's place; the failure has already spent its restart. */
  private startReplacement(reason: string): void {
    this.spawn().then(
      () => console.log('  [verify] replacement worker ready (%s)', reason),
      (err) => console.error('  [verify] replacement worker failed: %s', err instanceof Error ? err.message : err),
    );
  }

  private drain(): void {
    while (this.queue.length > 0 && this.workers.some((w) => w.ready && !w.busy)) {
      const job = this.queue.shift()!;
      if (this.pending.has(job.id)) this.dispatch(job);
    }
  }
}
