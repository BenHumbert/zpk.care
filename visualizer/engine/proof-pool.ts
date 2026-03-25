/**
 * ProofPool — Child process pool for offloading ZK proof generation.
 *
 * Modeled after L2 ProvingPool (src/l2/l2-proving-pool.ts) but handles
 * all 10 interactive-service ZkPrograms instead of just Batch+Chain.
 *
 * Each worker forks a child process that compiles all programs once,
 * then accepts generic prove requests by program+method name.
 *
 * Benefits:
 *   - Main event loop stays free for heartbeats, RPC, gossip
 *   - Multiple proofs can execute in parallel (e.g., 4 prescription proofs)
 *   - Crash recovery with automatic worker restart
 *   - Memory recycling after N proofs
 */

import { fork, type ChildProcess } from 'child_process';
import * as path from 'path';
import type {
  ProofJobRequest,
  ProofJobResult,
  ProofPoolOptions,
  ProofPoolStatus,
  ProofCoordinatorMessage,
  ProofWorkerMessage,
} from './proof-pool-types.js';

// ─── Internal Types ──────────────────────────────────────

interface WorkerHandle {
  id: number;
  process: ChildProcess;
  busy: boolean;
  status: 'compiling' | 'idle' | 'proving' | 'dead';
  currentJobId: string | null;
  jobsProcessed: number;
  restartCount: number;
  /** Marked for recycling — will recycle when idle AND no queued jobs */
  pendingRecycle: boolean;
  /** Last completed job info for dashboard display */
  lastJobDescription: string | null;
  lastJobTimeMs: number;
  lastJobCompletedAt: number;
}

interface PendingJob {
  jobId: string;
  request: ProofJobRequest;
  description: string;
  resolve: (result: ProofJobResult) => void;
  reject: (err: Error) => void;
  timeout: ReturnType<typeof setTimeout> | null;
}

// ─── ProofPool ───────────────────────────────────────────

export class ProofPool {
  private workers: WorkerHandle[] = [];
  private pendingJobs: Map<string, PendingJob> = new Map();
  private jobQueue: PendingJob[] = [];
  private nextJobId = 1;
  private running = false;

  private readonly poolSize: number;
  private readonly compileTimeoutMs: number;
  private readonly proveTimeoutMs: number;
  private readonly maxWorkerRestarts: number;
  private readonly shutdownGraceMs: number;
  private readonly recycleAfterJobs: number;

  private workerScriptPath: string;
  private totalCompleted = 0;
  private totalFailed = 0;
  private totalProveTimeMs = 0;

  private eventHandlers: Array<(event: { type: string; workerId: number; data?: Record<string, unknown> }) => void> = [];

  constructor(poolSize: number, options?: ProofPoolOptions) {
    if (poolSize < 1) throw new Error('ProofPool requires at least 1 worker');
    this.poolSize = poolSize;
    this.compileTimeoutMs = options?.compileTimeoutMs ?? 20 * 60_000; // 20 min
    this.proveTimeoutMs = options?.proveTimeoutMs ?? 3 * 60_000;     // 3 min
    this.maxWorkerRestarts = options?.maxWorkerRestarts ?? 3;
    this.shutdownGraceMs = options?.shutdownGraceMs ?? 5000;
    this.recycleAfterJobs = options?.recycleAfterJobs ?? 0;

    // Resolve worker script path relative to this file
    const thisDir = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Z]:)/i, '$1');
    this.workerScriptPath = path.resolve(thisDir, 'proof-pool-worker.ts');
  }

  setWorkerScriptPath(scriptPath: string): void {
    this.workerScriptPath = scriptPath;
  }

  on(handler: (event: { type: string; workerId: number; data?: Record<string, unknown> }) => void): void {
    this.eventHandlers.push(handler);
  }

  private emit(type: string, workerId: number, data?: Record<string, unknown>): void {
    for (const h of this.eventHandlers) {
      try { h({ type, workerId, data }); } catch { /* ignore */ }
    }
  }

  // ─── Lifecycle ──────────────────────────────────────────

  async start(): Promise<void> {
    const handles: WorkerHandle[] = [];

    for (let i = 0; i < this.poolSize; i++) {
      handles.push(this.spawnWorker(i));
    }

    this.workers = handles;

    // Compile all workers (sequentially to avoid CPU contention during compile)
    for (const handle of handles) {
      try {
        this.sendToWorker(handle, { type: 'compile' });
        handle.status = 'compiling';
        this.emit('worker:compiling', handle.id);
        await this.waitForReady(handle);
        this.emit('worker:ready', handle.id);
      } catch (err: any) {
        console.error(`[proof-pool] Worker ${handle.id} failed to compile:`, err.message);
        handle.status = 'dead';
      }
    }

    const alive = this.workers.filter(w => w.status === 'idle').length;
    if (alive === 0) throw new Error('All proof pool workers failed to compile');
    this.running = true;
    console.log(`[proof-pool] ${alive}/${this.poolSize} workers ready`);
  }

  async shutdown(): Promise<void> {
    this.running = false;

    // Reject all pending and queued jobs
    for (const [, job] of this.pendingJobs) {
      if (job.timeout) clearTimeout(job.timeout);
      job.reject(new Error('ProofPool shutting down'));
    }
    this.pendingJobs.clear();

    for (const job of this.jobQueue) {
      job.reject(new Error('ProofPool shutting down'));
    }
    this.jobQueue = [];

    // Send shutdown to all workers
    for (const w of this.workers) {
      if (w.status !== 'dead') {
        this.sendToWorker(w, { type: 'shutdown' });
      }
    }

    // Wait for graceful exit, then force kill
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        for (const w of this.workers) {
          try { w.process.kill('SIGTERM'); } catch { /* ignore */ }
        }
        resolve();
      }, this.shutdownGraceMs);

      const check = () => {
        if (this.workers.every(w => w.status === 'dead')) {
          clearTimeout(timer);
          resolve();
        }
      };

      for (const w of this.workers) {
        w.process.once('exit', check);
      }
    });
  }

  // ─── Job Dispatch ─────────────────────────────────────

  /**
   * Submit a proof job and return a promise for the result.
   * If a worker is idle, dispatch immediately. Otherwise queue.
   */
  prove(request: ProofJobRequest, description?: string): Promise<ProofJobResult> {
    const jobId = `pj-${this.nextJobId++}`;

    return new Promise<ProofJobResult>((resolve, reject) => {
      const job: PendingJob = {
        jobId,
        request,
        description: description ?? `${request.program}.${request.method}`,
        resolve,
        reject,
        timeout: null,
      };

      const idle = this.getIdleWorker();
      if (idle) {
        this.dispatchJob(idle, job);
      } else {
        this.jobQueue.push(job);
      }
    });
  }

  isRunning(): boolean { return this.running; }

  getStatus(): ProofPoolStatus {
    const alive = this.workers.filter(w => w.status !== 'dead').length;
    const idle = this.workers.filter(w => w.status === 'idle').length;
    const busy = this.workers.filter(w => w.status === 'proving').length;
    return {
      poolSize: this.poolSize,
      workersAlive: alive,
      workersIdle: idle,
      workersBusy: busy,
      queueDepth: this.jobQueue.length,
      totalJobsCompleted: this.totalCompleted,
      totalJobsFailed: this.totalFailed,
      avgProveTimeMs: this.totalCompleted > 0 ? Math.round(this.totalProveTimeMs / this.totalCompleted) : 0,
    };
  }

  getWorkerStatuses(): Record<string, unknown>[] {
    return this.workers.map(w => ({
      id: w.id,
      busy: w.busy,
      status: w.status,
      currentJobId: w.currentJobId,
      jobsProcessed: w.jobsProcessed,
      restartCount: w.restartCount,
      pendingRecycle: w.pendingRecycle,
      lastJobDescription: w.lastJobDescription,
      lastJobTimeMs: w.lastJobTimeMs,
      lastJobCompletedAt: w.lastJobCompletedAt,
    }));
  }

  // ─── Internal: Worker Management ──────────────────────

  private spawnWorker(id: number, restartCount = 0): WorkerHandle {
    const child = fork(this.workerScriptPath, [], {
      serialization: 'json',
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      execArgv: ['--import', 'tsx'],
    });

    const handle: WorkerHandle = {
      id,
      process: child,
      busy: false,
      status: 'compiling',
      currentJobId: null,
      jobsProcessed: 0,
      restartCount,
      pendingRecycle: false,
      lastJobDescription: null,
      lastJobTimeMs: 0,
      lastJobCompletedAt: 0,
    };

    child.on('message', (msg: ProofWorkerMessage) => this.handleWorkerMessage(handle, msg));
    child.on('exit', (code, signal) => this.handleWorkerExit(handle, code, signal));

    // Pipe worker stderr to main process stderr
    child.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write(`[proof-worker-${id}] ${chunk.toString()}`);
    });

    this.emit('worker:spawned', id);
    return handle;
  }

  private waitForReady(handle: WorkerHandle): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Worker ${handle.id} compile timed out after ${this.compileTimeoutMs}ms`));
      }, this.compileTimeoutMs);

      const onMessage = (msg: ProofWorkerMessage) => {
        if (msg.type === 'ready') {
          clearTimeout(timer);
          handle.process.removeListener('message', onMessage);
          handle.status = 'idle';
          resolve();
        } else if (msg.type === 'error' && msg.jobId === '__compile__') {
          clearTimeout(timer);
          handle.process.removeListener('message', onMessage);
          reject(new Error(`Worker ${handle.id} compile failed: ${msg.message}`));
        }
      };

      handle.process.on('message', onMessage);
    });
  }

  private getIdleWorker(): WorkerHandle | null {
    // Prefer workers NOT pending recycle, fall back to pending-recycle if no clean workers available
    return this.workers.find(w => !w.busy && w.status === 'idle' && w.process.connected && !w.pendingRecycle)
      ?? this.workers.find(w => !w.busy && w.status === 'idle' && w.process.connected)
      ?? null;
  }

  /** Returns true if any worker has an in-flight proving job */
  private hasActiveJobs(): boolean {
    return this.workers.some(w => w.busy && w.status === 'proving');
  }

  private dispatchJob(worker: WorkerHandle, job: PendingJob): void {
    worker.busy = true;
    worker.status = 'proving';
    worker.currentJobId = job.jobId;

    this.pendingJobs.set(job.jobId, job);

    job.timeout = setTimeout(() => {
      console.error(`[proof-pool] TIMEOUT: Worker ${worker.id} — ${job.description} (${job.jobId}) exceeded ${this.proveTimeoutMs}ms`);
      this.pendingJobs.delete(job.jobId);
      worker.busy = false;
      worker.status = 'idle';
      worker.currentJobId = null;
      this.totalFailed++;
      job.reject(new Error(`Prove timeout after ${this.proveTimeoutMs}ms for ${job.description}`));
      this.drainQueue();
    }, this.proveTimeoutMs);

    this.sendToWorker(worker, {
      type: 'prove',
      jobId: job.jobId,
      request: job.request,
    });

    this.emit('worker:dispatched', worker.id, { jobId: job.jobId, description: job.description });
  }

  private drainQueue(): void {
    while (this.jobQueue.length > 0) {
      const idle = this.getIdleWorker();
      if (!idle) break;
      this.dispatchJob(idle, this.jobQueue.shift()!);
    }
  }

  // ─── Internal: Message Handling ─────────────────────

  private handleWorkerMessage(handle: WorkerHandle, msg: ProofWorkerMessage): void {
    if (msg.type === 'result') {
      const job = this.pendingJobs.get(msg.jobId);
      if (!job) return;

      if (job.timeout) clearTimeout(job.timeout);
      this.pendingJobs.delete(msg.jobId);

      handle.busy = false;
      handle.status = 'idle';
      handle.lastJobDescription = job.description;
      handle.lastJobTimeMs = msg.result.proveTimeMs;
      handle.lastJobCompletedAt = Date.now();
      handle.currentJobId = null;
      handle.jobsProcessed++;

      this.totalCompleted++;
      this.totalProveTimeMs += msg.result.proveTimeMs;

      // Stamp worker ID
      msg.result.workerId = handle.id;

      this.emit('worker:completed', handle.id, {
        jobId: msg.jobId,
        proveTimeMs: msg.result.proveTimeMs,
      });

      // Check if this worker should be recycled
      if (this.recycleAfterJobs > 0 && handle.jobsProcessed >= this.recycleAfterJobs) {
        handle.pendingRecycle = true;
      }

      job.resolve(msg.result);
      this.drainQueue();

      // Deferred recycle: only recycle when queue is empty and no jobs in flight
      // This prevents mid-workflow recycling that drops pool capacity at the worst time
      if (handle.pendingRecycle && this.jobQueue.length === 0 && !this.hasActiveJobs()) {
        this.recycleWorker(handle);
      }

    } else if (msg.type === 'error' && msg.jobId !== '__compile__') {
      const job = this.pendingJobs.get(msg.jobId);
      if (!job) return;

      if (job.timeout) clearTimeout(job.timeout);
      this.pendingJobs.delete(msg.jobId);

      handle.busy = false;
      handle.status = 'idle';
      handle.currentJobId = null;
      this.totalFailed++;

      job.reject(new Error(`Proof worker error: ${msg.message}`));
      this.drainQueue();
    }
  }

  private handleWorkerExit(handle: WorkerHandle, code: number | null, _signal: string | null): void {
    const wasDead = handle.status === 'dead';
    handle.status = 'dead';
    handle.busy = false;

    if (!this.running || wasDead) return;

    const jobDesc = handle.currentJobId
      ? this.pendingJobs.get(handle.currentJobId)?.description ?? handle.currentJobId
      : 'idle';
    console.error(`[proof-pool] Worker ${handle.id} CRASHED — code: ${code}, signal: ${_signal}, job: ${jobDesc}, restarts: ${handle.restartCount}/${this.maxWorkerRestarts}`);
    this.emit('worker:crashed', handle.id, { code, signal: _signal, job: jobDesc });

    // Reject in-flight job
    if (handle.currentJobId) {
      const job = this.pendingJobs.get(handle.currentJobId);
      if (job) {
        if (job.timeout) clearTimeout(job.timeout);
        this.pendingJobs.delete(handle.currentJobId);
        this.totalFailed++;
        console.error(`[proof-pool] Rejecting in-flight job: ${job.description} (${job.jobId})`);
        job.reject(new Error(`Worker ${handle.id} crashed during ${job.description} (code ${code}, signal ${_signal})`));
      }
    }

    // Restart if under limit
    if (handle.restartCount < this.maxWorkerRestarts) {
      const idx = this.workers.indexOf(handle);
      if (idx >= 0) {
        const newHandle = this.spawnWorker(handle.id, handle.restartCount + 1);
        this.workers[idx] = newHandle;
        this.sendToWorker(newHandle, { type: 'compile' });
        newHandle.status = 'compiling';
        this.waitForReady(newHandle)
          .then(() => {
            this.emit('worker:ready', newHandle.id);
            this.drainQueue();
          })
          .catch((err) => {
            console.error(`[proof-pool] Worker ${newHandle.id} restart compile failed:`, err.message);
            newHandle.status = 'dead';
          });
      }
    }
  }

  private recycleWorker(handle: WorkerHandle): void {
    this.emit('worker:recycled', handle.id, { jobsProcessed: handle.jobsProcessed });

    const idx = this.workers.indexOf(handle);
    if (idx < 0) return;

    // Gracefully shutdown old worker
    this.sendToWorker(handle, { type: 'shutdown' });
    setTimeout(() => {
      try { handle.process.kill('SIGTERM'); } catch { /* ignore */ }
    }, this.shutdownGraceMs);
    handle.status = 'dead';

    // Spawn replacement (same restart count — recycle ≠ crash)
    const newHandle = this.spawnWorker(handle.id, handle.restartCount);
    this.workers[idx] = newHandle;
    this.sendToWorker(newHandle, { type: 'compile' });
    newHandle.status = 'compiling';
    this.waitForReady(newHandle)
      .then(() => {
        this.emit('worker:ready', newHandle.id);
        this.drainQueue();
      })
      .catch((err) => {
        console.error(`[proof-pool] Worker ${newHandle.id} recycle compile failed:`, err.message);
        newHandle.status = 'dead';
      });
  }

  private sendToWorker(handle: WorkerHandle, msg: ProofCoordinatorMessage): boolean {
    if (!handle.process.connected) return false;
    try {
      handle.process.send(msg);
      return true;
    } catch {
      return false;
    }
  }
}
