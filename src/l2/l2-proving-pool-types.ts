/**
 * L2 Proving Pool — IPC Message Types
 *
 * Shared types for the proving pool coordinator (main process) and
 * proving workers (child processes). Kept in a separate file so the
 * worker entry point can import without pulling in the full L2
 * dependency tree.
 *
 * All Field values are serialized as decimal strings for IPC transport.
 * Proofs are serialized via o1js `proof.toJSON()` (plain JSON objects).
 */

// ─── Proving Job ──────────────────────────────────────────

/**
 * ProvingJobRequest — sent from coordinator to worker.
 *
 * Contains everything needed to produce a BatchProof (and optionally
 * a ChainProof) without access to any sequencer state.
 */
export interface ProvingJobRequest {
  /** Serialized StateTransitionProof objects (proof.toJSON() outputs) */
  transitionProofJsons: object[];

  /**
   * Admin state fields for ChainProgram (decimal strings).
   * If present, the worker will also produce a ChainProof after the BatchProof.
   */
  adminState?: {
    adminPublicKeyHash: string;
    benefitPlanRoot: string;
    credentialRegistryRoot: string;
    eligibilityVkHash: string;
    messagingRoot: string;
  };

  /**
   * Latest ChainProof JSON for ChainProgram.advance().
   * If null/undefined and adminState is set, worker uses ChainProgram.genesis().
   */
  latestChainProofJson?: string | null;

  /** Audit chain hash (decimal string) for ChainProgram input. */
  latestChainHash: string;
}

/**
 * ProvingJobResult — sent from worker back to coordinator.
 *
 * Contains the serialized proofs and their public outputs as strings,
 * ready for the coordinator to finalize the batch in the main process.
 */
export interface ProvingJobResult {
  /** JSON.stringify(finalBatchProof.toJSON()) */
  batchProofJson: string;

  /** BatchOutput fields as decimal strings */
  batchOutput: {
    oldRegistryRoot: string;
    newRegistryRoot: string;
    oldLifecycleRoot: string;
    newLifecycleRoot: string;
    registrationCount: string;
    transitionCount: string;
  };

  /** JSON.stringify(chainProof.toJSON()) — only if adminState was provided */
  chainProofJson?: string;

  /** ChainOutput fields as decimal strings — only if chain proof was produced */
  chainOutput?: {
    globalStateRoot: string;
    blockHeight: string;
  };

  /** Wall-clock time for proving (ms) */
  proveTimeMs: number;

  /** Worker ID that produced this result (stamped by coordinator, not worker) */
  workerId: number;
}

// ─── IPC Messages: Coordinator → Worker ──────────────────

export interface CompileMessage {
  type: 'compile';
}

export interface ProveMessage {
  type: 'prove';
  jobId: string;
  request: ProvingJobRequest;
}

export interface ShutdownMessage {
  type: 'shutdown';
}

export type CoordinatorMessage = CompileMessage | ProveMessage | ShutdownMessage;

// ─── IPC Messages: Worker → Coordinator ──────────────────

export interface ReadyMessage {
  type: 'ready';
  compileTimeMs: number;
}

export interface ResultMessage {
  type: 'result';
  jobId: string;
  result: ProvingJobResult;
}

export interface ErrorMessage {
  type: 'error';
  jobId: string;
  message: string;
}

export type WorkerMessage = ReadyMessage | ResultMessage | ErrorMessage;

// ─── Pool Status ──────────────────────────────────────────

export interface ProvingPoolStatus {
  poolSize: number;
  workersAlive: number;
  workersIdle: number;
  workersBusy: number;
  queueDepth: number;
  totalJobsCompleted: number;
  totalJobsFailed: number;
  avgProveTimeMs: number;
}

// ─── Pool Options ─────────────────────────────────────────

export interface ProvingPoolOptions {
  /** Timeout for ZkProgram compilation per worker (ms). Default: 15 minutes. */
  compileTimeoutMs?: number;

  /** Timeout for a single prove job (ms). Default: 5 minutes. */
  proveTimeoutMs?: number;

  /** Maximum number of times to restart a crashed worker. Default: 3. */
  maxWorkerRestarts?: number;

  /** Grace period before SIGTERM on shutdown (ms). Default: 5000. */
  shutdownGraceMs?: number;

  /**
   * Kill and respawn a worker after this many prove jobs.
   * Reclaims o1js WASM heap that grows monotonically (~60MB per proof).
   * Default: 0 (disabled — workers are never recycled).
   */
  recycleAfterJobs?: number;
}

// ─── Pool Events ─────────────────────────────────────────

export type PoolEventType =
  | 'worker:spawned'
  | 'worker:compiling'
  | 'worker:ready'
  | 'worker:compile_timeout'
  | 'worker:compile_failed'
  | 'worker:dispatched'
  | 'worker:completed'
  | 'worker:crashed'
  | 'worker:recycled';

export interface PoolEvent {
  type: PoolEventType;
  timestamp: number;
  workerId: number;
  data: Record<string, unknown>;
}

export type PoolEventHandler = (event: PoolEvent) => void;

// ─── Worker Status (for dashboard polling) ───────────────

export type WorkerState = 'compiling' | 'idle' | 'proving' | 'dead';

export interface WorkerStatus {
  id: number;
  busy: boolean;
  currentJobId: string | null;
  status: WorkerState;
  jobsProcessed: number;
}
