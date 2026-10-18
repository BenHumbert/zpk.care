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
 * Three properties this has to keep, in priority order:
 *
 *   1. **Nothing is accepted without a verdict.** Every failure path — a dead worker, a
 *      timeout, a mismatched key, a queue that never drains — throws. There is no branch
 *      that returns normally without a worker having said `valid: true`.
 *   2. **A stuck worker cannot hold a submission open.** Each request has a deadline; past
 *      it the submission is refused and the worker is replaced, because a verification that
 *      hangs once will hang again.
 *   3. **A crash must not become a silent outage.** Workers restart, with a cap, and the
 *      cap being reached is loud.
 */
import { fork, type ChildProcess } from 'child_process';
import { childEnvironment } from '../security/node-roles.js';
import path from 'path';
import { fileURLToPath } from 'url';
import { ProofRejected, VERIFY_TIMEOUT_MS } from './l2-proof-verifier.js';
import type { TransitionProofVerifier } from './l2-proof-verifier.js';
import type { StateTransitionProof } from '../engine/state-transition.js';
import type { VerifyRequest, VerifyResponse } from './l2-verify-worker.js';

export interface VerifyPoolOptions {
  /** How many verifier processes. One is enough for ~1 s verifications at low rates. */
  size?: number;
  /** Verification key hash this deployment expects; a worker reporting another refuses to start. */
  expectedVkHash?: string;
  /** Replace a worker after this many verifications, to release WASM heap. 0 disables. */
  recycleAfterJobs?: number;
  /** Give up on a single verification after this long and refuse the submission. */
  timeoutMs?: number;
  /** How many times a worker may be replaced before the pool gives up. */
  maxRestarts?: number;
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
  ready: boolean;
  jobs: number;
  busy: boolean;
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
  private readonly workerScriptPath: string;

  private workers: Worker[] = [];
  private pending = new Map<string, Pending>();
  private queue: Array<{ proofJson: unknown; id: string }> = [];
  private nextWorkerId = 0;
  private nextJobId = 0;
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
    this.workerScriptPath = options.workerScriptPath ?? defaultWorkerPath();
  }

  /** Fork the workers and wait until each has compiled and reported a matching key. */
  async start(): Promise<{ vkHash: string; compileMs: number }> {
    const results = await Promise.all(
      Array.from({ length: this.size }, () => this.spawn()),
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
        if (entry) {
          // A verification that overran will overrun again: replace the worker rather than
          // leave a wedged one in rotation.
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

  private spawn(): Promise<{ vkHash: string; compileMs: number }> {
    const id = this.nextWorkerId++;
    const child = fork(this.workerScriptPath, [], {
      execArgv: process.execArgv,
      serialization: 'json',
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      env: childEnvironment(process.env, {}), // A9: a verifier holds no credential
    });
    const worker: Worker = { id, child, ready: false, jobs: 0, busy: false };
    this.workers.push(worker);

    child.stderr?.on('data', (d: Buffer) => {
      const line = d.toString().trim();
      if (line) console.error('  [verify:w%d] %s', id, line.slice(0, 400));
    });

    return new Promise((resolve, reject) => {
      const onMessage = (msg: VerifyResponse): void => {
        switch (msg.type) {
          case 'ready':
            worker.ready = true;
            resolve({ vkHash: msg.vkHash, compileMs: msg.compileMs });
            this.drain();
            break;
          case 'compile-failed':
            reject(new Error(`verifier worker ${id} could not start: ${msg.message}`));
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
            this.maybeRecycle(worker);
            this.drain();
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
            this.maybeRecycle(worker);
            this.drain();
            break;
          }
        }
      };
      child.on('message', onMessage);

      child.on('exit', (code) => {
        worker.ready = false;
        const wasBusy = worker.busy;
        this.workers = this.workers.filter((w) => w.id !== worker.id);
        // Anything that was in flight on this worker has no verdict, so it is refused.
        for (const [jobId, entry] of [...this.pending]) {
          if (entry.workerId === worker.id) {
            this.fail(jobId, new ProofRejected('timeout', 'Proof rejected: verifier process exited mid-verification'));
          }
        }
        if (!this.shuttingDown) {
          console.error('  [verify] worker %d exited (code %s)%s', worker.id, code, wasBusy ? ' while verifying' : '');
          this.replaceWorker(worker.id, `exited with code ${code}`);
        }
        reject(new Error(`verifier worker ${id} exited before becoming ready (code ${code})`));
      });

      child.send({ type: 'compile', expectedVkHash: this.expectedVkHash } satisfies VerifyRequest);
    });
  }

  private maybeRecycle(worker: Worker): void {
    if (this.recycleAfterJobs > 0 && worker.jobs >= this.recycleAfterJobs && !worker.busy) {
      console.log('  [verify] recycling worker %d after %d verifications', worker.id, worker.jobs);
      try {
        worker.child.send({ type: 'shutdown' } satisfies VerifyRequest);
      } catch { /* exit handler replaces it */ }
    }
  }

  private replaceWorker(workerId: number, reason: string): void {
    if (this.shuttingDown) return;
    const existing = this.workers.find((w) => w.id === workerId);
    if (existing) {
      existing.ready = false;
      try { existing.child.kill(); } catch { /* already gone */ }
      this.workers = this.workers.filter((w) => w.id !== workerId);
    }
    if (this.restarts >= this.maxRestarts) {
      console.error(
        '  [verify] worker replacement limit reached (%d). Submissions will be refused until ' +
          'the sequencer is restarted. Last reason: %s',
        this.maxRestarts, reason,
      );
      return;
    }
    this.restarts++;
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
