/**
 * L2 Proving Pool — Shared Worker Fleet for Parallel Batch Proving.
 *
 * Manages N child processes, each with its own o1js Pickles/Kimchi
 * proving context. The pool coordinator dispatches prove jobs to
 * available workers, enabling true CPU-parallel proving across
 * multiple cores.
 *
 * Usage:
 *   const pool = new ProvingPool(3);  // 3 workers
 *   await pool.start();               // compile in all workers
 *   const result = await pool.prove(job);  // dispatched to first idle worker
 *   await pool.shutdown();
 *
 * The pool is optional — if not configured, L2Node/L2Leviathan fall
 * back to the single-process proving lock (backward compatible).
 */
import { fork } from 'child_process';
import type { ChildProcess } from 'child_process';
import type {
  ProvingJobRequest,
  ProvingJobResult,
  ProvingPoolOptions,
  ProvingPoolStatus,
  CoordinatorMessage,
  WorkerMessage,
  PoolEvent,
  PoolEventHandler,
  WorkerStatus,
  WorkerState,
} from './l2-proving-pool-types.js';

// ─── Worker Path Resolution ───────────────────────────────

/**
 * Resolve the default worker script path relative to this module.
 * Uses __filename (available via ts-jest CJS transform) or import.meta.url (ESM).
 */
function resolveDefaultWorkerPath(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pathModule = require('path') as typeof import('path');

  // In CJS context (ts-jest), __filename is available
  if (typeof __filename !== 'undefined') {
    return pathModule.join(pathModule.dirname(__filename), 'l2-proving-worker.ts');
  }

  // In ESM context (production), use a URL-based approach
  // The caller should set workerScriptPath explicitly or this throws.
  throw new Error(
    'ProvingPool: cannot resolve default worker path. ' +
    'Call setWorkerScriptPath() before start().',
  );
}

// ─── Constants ────────────────────────────────────────────

const DEFAULT_COMPILE_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes (workers compile in parallel, CPU-bound)
const DEFAULT_PROVE_TIMEOUT_MS = 5 * 60 * 1000;     // 5 minutes
const DEFAULT_MAX_WORKER_RESTARTS = 3;
const DEFAULT_SHUTDOWN_GRACE_MS = 5_000;

// ─── Internal Types ───────────────────────────────────────

interface WorkerHandle {
  process: ChildProcess;
  id: number;
  busy: boolean;
  restartCount: number;
  currentJobId: string | null;
  status: WorkerState;
}

interface PendingJob {
  jobId: string;
  request: ProvingJobRequest;
  resolve: (result: ProvingJobResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

// ─── ProvingPool ──────────────────────────────────────────

export class ProvingPool {
  private poolSize: number;
  private compileTimeoutMs: number;
  private proveTimeoutMs: number;
  private maxWorkerRestarts: number;
  private shutdownGraceMs: number;

  private workers: Map<number, WorkerHandle> = new Map();
  private nextWorkerId = 0;
  private running = false;

  // Job tracking
  private pendingJobs: Map<string, PendingJob> = new Map();
  private jobQueue: PendingJob[] = [];
  private nextJobId = 0;

  // Stats
  private totalJobsCompleted = 0;
  private totalJobsFailed = 0;
  private totalProveTimeMs = 0;

  // Worker script path (resolved lazily on first start, or set explicitly)
  private workerScriptPath: string | null = null;

  // Event handlers
  private eventHandlers: PoolEventHandler[] = [];

  // Stderr callback — consumers (e.g. orchestrator) can pipe worker stderr to console
  private stderrCallback: ((workerId: number, data: string) => void) | null = null;

  constructor(poolSize: number, options?: ProvingPoolOptions) {
    if (poolSize < 1) {
      throw new Error('ProvingPool: poolSize must be at least 1');
    }
    this.poolSize = poolSize;
    this.compileTimeoutMs = options?.compileTimeoutMs ?? DEFAULT_COMPILE_TIMEOUT_MS;
    this.proveTimeoutMs = options?.proveTimeoutMs ?? DEFAULT_PROVE_TIMEOUT_MS;
    this.maxWorkerRestarts = options?.maxWorkerRestarts ?? DEFAULT_MAX_WORKER_RESTARTS;
    this.shutdownGraceMs = options?.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
  }

  /**
   * Set a custom worker script path. Must be called before start()
   * unless the default resolution works (ESM with import.meta.url).
   */
  setWorkerScriptPath(scriptPath: string): void {
    this.workerScriptPath = scriptPath;
  }

  // ─── Event Emitter ─────────────────────────────────────

  /** Subscribe to pool lifecycle events. */
  on(handler: PoolEventHandler): void {
    this.eventHandlers.push(handler);
  }

  /** Unsubscribe from pool lifecycle events. */
  off(handler: PoolEventHandler): void {
    this.eventHandlers = this.eventHandlers.filter(h => h !== handler);
  }

  /** Subscribe to worker stderr output (piped from child processes). */
  onStderr(callback: (workerId: number, data: string) => void): void {
    this.stderrCallback = callback;
  }

  private emitPoolEvent(event: PoolEvent): void {
    for (const handler of this.eventHandlers) {
      try { handler(event); } catch { /* swallow listener errors */ }
    }
  }

  // ─── Lifecycle ──────────────────────────────────────────

  /**
   * Start the pool: fork workers and compile ZkPrograms in each.
   * Workers are compiled sequentially (one at a time) to avoid CPU
   * contention — o1js Pickles/Kimchi compilation is extremely CPU-intensive
   * and concurrent compilations thrash the CPU on most machines.
   * Resolves when all workers report 'ready' (or have failed).
   */
  async start(): Promise<void> {
    if (this.running) return;

    // Resolve worker script path if not explicitly set
    if (!this.workerScriptPath) {
      this.workerScriptPath = resolveDefaultWorkerPath();
    }

    // Spawn all workers up front (lightweight — just fork + event wiring)
    const handles: WorkerHandle[] = [];
    for (let i = 0; i < this.poolSize; i++) {
      handles.push(this.spawnWorker());
    }

    // Compile workers sequentially — each one gets full CPU.
    // Concurrent compilation thrashes CPU and causes timeouts.
    let succeeded = 0;
    let firstError: Error | null = null;

    for (const handle of handles) {
      this.sendToWorker(handle, { type: 'compile' });
      this.emitPoolEvent({
        type: 'worker:compiling',
        timestamp: Date.now(),
        workerId: handle.id,
        data: {},
      });

      try {
        await this.waitForReady(handle);
        succeeded++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`  [ProvingPool] Worker ${handle.id} failed to start: ${msg}`);
        if (!firstError) {
          firstError = err instanceof Error ? err : new Error(msg);
        }
        // Clean up dead worker handle
        if (handle.process.exitCode !== null || handle.process.signalCode !== null) {
          this.workers.delete(handle.id);
        }
      }
    }

    if (succeeded === 0) {
      // All workers failed — propagate the first error
      throw firstError!;
    }

    this.running = true;
  }

  /**
   * Shutdown the pool: gracefully stop all workers.
   */
  async shutdown(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    // Reject all pending and queued jobs
    for (const [, job] of this.pendingJobs) {
      if (job.timer) clearTimeout(job.timer);
      job.reject(new Error('ProvingPool: shutting down'));
    }
    this.pendingJobs.clear();

    for (const job of this.jobQueue) {
      if (job.timer) clearTimeout(job.timer);
      job.reject(new Error('ProvingPool: shutting down'));
    }
    this.jobQueue = [];

    // Send shutdown to all workers
    for (const [, handle] of this.workers) {
      this.sendToWorker(handle, { type: 'shutdown' });
    }

    // Wait for graceful exit, then force-kill
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        for (const [, handle] of this.workers) {
          if (handle.process.connected) {
            handle.process.kill('SIGTERM');
          }
        }
        resolve();
      }, this.shutdownGraceMs);

      // Check if all workers already exited
      const checkDone = () => {
        let allDead = true;
        for (const [, handle] of this.workers) {
          if (handle.process.exitCode === null && handle.process.signalCode === null) {
            allDead = false;
            break;
          }
        }
        if (allDead) {
          clearTimeout(timer);
          resolve();
        }
      };

      for (const [, handle] of this.workers) {
        handle.process.once('exit', checkDone);
      }
      checkDone();
    });

    this.workers.clear();
  }

  // ─── Job Dispatch ───────────────────────────────────────

  /**
   * Submit a proving job to the pool.
   * Dispatches to first available worker; queues if all busy.
   */
  prove(request: ProvingJobRequest): Promise<ProvingJobResult> {
    if (!this.running) {
      return Promise.reject(new Error('ProvingPool: not running'));
    }

    return new Promise<ProvingJobResult>((resolve, reject) => {
      const jobId = `job-${this.nextJobId++}`;
      const job: PendingJob = { jobId, request, resolve, reject, timer: null };

      // Try to dispatch immediately to an idle worker
      const worker = this.getIdleWorker();
      if (worker) {
        this.dispatchJob(worker, job);
      } else {
        // All workers busy — queue the job
        this.jobQueue.push(job);
      }
    });
  }

  /** Generate a unique job ID (exposed for external use) */
  generateJobId(): string {
    return `job-${this.nextJobId++}`;
  }

  // ─── Status ─────────────────────────────────────────────

  getStatus(): ProvingPoolStatus {
    let workersAlive = 0;
    let workersIdle = 0;
    let workersBusy = 0;

    for (const [, handle] of this.workers) {
      if (handle.process.exitCode === null && handle.process.signalCode === null) {
        workersAlive++;
        if (handle.busy) workersBusy++;
        else workersIdle++;
      }
    }

    return {
      poolSize: this.poolSize,
      workersAlive,
      workersIdle,
      workersBusy,
      queueDepth: this.jobQueue.length,
      totalJobsCompleted: this.totalJobsCompleted,
      totalJobsFailed: this.totalJobsFailed,
      avgProveTimeMs:
        this.totalJobsCompleted > 0
          ? Math.round(this.totalProveTimeMs / this.totalJobsCompleted)
          : 0,
    };
  }

  isRunning(): boolean {
    return this.running;
  }

  /** Get per-worker status for dashboard polling. */
  getWorkerStatuses(): WorkerStatus[] {
    const statuses: WorkerStatus[] = [];
    for (const [, handle] of this.workers) {
      statuses.push({
        id: handle.id,
        busy: handle.busy,
        currentJobId: handle.currentJobId,
        status: handle.status,
      });
    }
    return statuses.sort((a, b) => a.id - b.id);
  }

  /** Get the configured pool size. */
  getPoolSize(): number {
    return this.poolSize;
  }

  // ─── Worker Management ──────────────────────────────────

  private spawnWorker(): WorkerHandle {
    const id = this.nextWorkerId++;

    const child = fork(this.workerScriptPath!, [], {
      execArgv: process.execArgv,
      serialization: 'json',
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    });

    const handle: WorkerHandle = {
      process: child,
      id,
      busy: false,
      restartCount: 0,
      currentJobId: null,
      status: 'compiling',
    };

    // Handle messages from worker
    child.on('message', (msg: WorkerMessage) => {
      this.handleWorkerMessage(handle, msg);
    });

    // Handle worker crash
    child.on('exit', (code, signal) => {
      this.handleWorkerExit(handle, code, signal);
    });

    // Capture worker stderr — forward to consumers instead of suppressing
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text && this.stderrCallback) {
        this.stderrCallback(id, text);
      }
    });
    // Stdout: suppress (o1js may write noise)
    child.stdout?.on('data', () => {});

    this.workers.set(id, handle);

    // Emit spawned event — worker appears on dashboard immediately
    this.emitPoolEvent({
      type: 'worker:spawned',
      timestamp: Date.now(),
      workerId: id,
      data: {},
    });

    return handle;
  }

  private waitForReady(handle: WorkerHandle): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        handle.status = 'dead';
        this.emitPoolEvent({
          type: 'worker:compile_timeout',
          timestamp: Date.now(),
          workerId: handle.id,
          data: { timeoutMs: this.compileTimeoutMs },
        });
        reject(new Error(
          `ProvingPool: worker ${handle.id} compilation timed out after ${this.compileTimeoutMs}ms`,
        ));
      }, this.compileTimeoutMs);

      const onMessage = (msg: WorkerMessage) => {
        if (msg.type === 'ready') {
          clearTimeout(timer);
          handle.process.removeListener('message', onMessage);
          handle.status = 'idle';
          this.emitPoolEvent({
            type: 'worker:ready',
            timestamp: Date.now(),
            workerId: handle.id,
            data: { compileTimeMs: msg.compileTimeMs },
          });
          resolve();
        } else if (msg.type === 'error' && (msg as { jobId?: string }).jobId === '__compile__') {
          clearTimeout(timer);
          handle.process.removeListener('message', onMessage);
          handle.status = 'dead';
          this.emitPoolEvent({
            type: 'worker:compile_failed',
            timestamp: Date.now(),
            workerId: handle.id,
            data: { error: msg.message },
          });
          reject(new Error(`ProvingPool: worker ${handle.id} compilation failed: ${msg.message}`));
        }
      };

      handle.process.on('message', onMessage);
    });
  }

  private getIdleWorker(): WorkerHandle | null {
    for (const [, handle] of this.workers) {
      if (!handle.busy && handle.process.exitCode === null && handle.process.signalCode === null) {
        return handle;
      }
    }
    return null;
  }

  private dispatchJob(worker: WorkerHandle, job: PendingJob): void {
    worker.busy = true;
    worker.currentJobId = job.jobId;
    worker.status = 'proving';
    this.pendingJobs.set(job.jobId, job);

    this.emitPoolEvent({
      type: 'worker:dispatched',
      timestamp: Date.now(),
      workerId: worker.id,
      data: { jobId: job.jobId },
    });

    // Set prove timeout
    job.timer = setTimeout(() => {
      this.pendingJobs.delete(job.jobId);
      worker.busy = false;
      worker.currentJobId = null;
      worker.status = 'idle';
      this.totalJobsFailed++;
      job.reject(new Error(
        `ProvingPool: prove timeout after ${this.proveTimeoutMs}ms`,
      ));
      this.drainQueue();
    }, this.proveTimeoutMs);

    this.sendToWorker(worker, {
      type: 'prove',
      jobId: job.jobId,
      request: job.request,
    });
  }

  private drainQueue(): void {
    while (this.jobQueue.length > 0) {
      const worker = this.getIdleWorker();
      if (!worker) break;
      const job = this.jobQueue.shift()!;
      this.dispatchJob(worker, job);
    }
  }

  // ─── Message Handling ───────────────────────────────────

  private handleWorkerMessage(handle: WorkerHandle, msg: WorkerMessage): void {
    if (msg.type === 'result') {
      const job = this.pendingJobs.get(msg.jobId);
      if (job) {
        if (job.timer) clearTimeout(job.timer);
        this.pendingJobs.delete(msg.jobId);
        handle.busy = false;
        handle.currentJobId = null;
        handle.status = 'idle';
        this.totalJobsCompleted++;
        this.totalProveTimeMs += msg.result.proveTimeMs;

        // Stamp workerId onto the result (worker doesn't know its own pool index)
        const stampedResult: ProvingJobResult = { ...msg.result, workerId: handle.id };
        this.emitPoolEvent({
          type: 'worker:completed',
          timestamp: Date.now(),
          workerId: handle.id,
          data: { jobId: msg.jobId, proveTimeMs: msg.result.proveTimeMs },
        });
        job.resolve(stampedResult);
        this.drainQueue();
      }
    } else if (msg.type === 'error') {
      // Skip compile errors (handled in waitForReady)
      if (msg.jobId === '__compile__') return;

      const job = this.pendingJobs.get(msg.jobId);
      if (job) {
        if (job.timer) clearTimeout(job.timer);
        this.pendingJobs.delete(msg.jobId);
        handle.busy = false;
        handle.currentJobId = null;
        handle.status = 'idle';
        this.totalJobsFailed++;
        job.reject(new Error(`ProvingPool: worker ${handle.id} error: ${msg.message}`));
        this.drainQueue();
      }
    }
    // 'ready' messages are handled in waitForReady
  }

  private handleWorkerExit(handle: WorkerHandle, code: number | null, signal: string | null): void {
    handle.status = 'dead';

    // If the pool is shutting down, don't restart
    if (!this.running) return;

    this.emitPoolEvent({
      type: 'worker:crashed',
      timestamp: Date.now(),
      workerId: handle.id,
      data: { code, signal, restartCount: handle.restartCount },
    });

    // If a job was in-flight, reject it and try to requeue
    if (handle.currentJobId) {
      const job = this.pendingJobs.get(handle.currentJobId);
      if (job) {
        if (job.timer) clearTimeout(job.timer);
        this.pendingJobs.delete(handle.currentJobId);
        this.totalJobsFailed++;
        job.reject(new Error(
          `ProvingPool: worker ${handle.id} crashed (code=${code}, signal=${signal})`,
        ));
      }
    }

    // Remove dead worker
    this.workers.delete(handle.id);

    // Restart if under restart limit
    if (handle.restartCount < this.maxWorkerRestarts) {
      const newHandle = this.spawnWorker();
      newHandle.restartCount = handle.restartCount + 1;
      newHandle.status = 'compiling';

      // Re-compile in the new worker, then drain queue
      this.sendToWorker(newHandle, { type: 'compile' });
      this.emitPoolEvent({
        type: 'worker:compiling',
        timestamp: Date.now(),
        workerId: newHandle.id,
        data: { restart: true, restartCount: newHandle.restartCount },
      });
      this.waitForReady(newHandle)
        .then(() => this.drainQueue())
        .catch(() => {
          // Worker failed to compile on restart — remove it
          this.workers.delete(newHandle.id);
        });
    }
  }

  // ─── IPC ────────────────────────────────────────────────

  private sendToWorker(handle: WorkerHandle, msg: CoordinatorMessage): void {
    if (handle.process.connected) {
      handle.process.send(msg);
    }
  }
}
