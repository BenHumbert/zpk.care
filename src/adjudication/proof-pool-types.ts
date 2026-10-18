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
 * Proof Pool — IPC Message Types for Interactive Service ZK Proving
 *
 * Generic proving pool that offloads ALL ZkProgram proofs to child processes,
 * keeping the main event loop free for heartbeats, RPC, and gossip.
 *
 * Unlike the L2 ProvingPool (batch-specific), this pool handles all 10
 * ZkPrograms used by the AdjudicationService. Jobs are dispatched by
 * program name + method name, with arguments serialized as JSON-safe values.
 *
 * Serialization convention:
 *   - Field values → decimal strings (field.toString())
 *   - Structs → Provable.toJSON(StructType, value)  (handled by caller)
 *   - MerkleWitness → witness.toJSON()
 *   - Proofs → proof.toJSON()
 *   - All other values → passed as-is (strings, numbers, booleans)
 */

// ─── Proving Job ──────────────────────────────────────────

/**
 * Generic proof job request — program + method + serialized arguments.
 *
 * The worker deserializes args back into typed o1js objects using the
 * program/method registry, then calls the prove method.
 */
export interface ProofJobRequest {
  /** ZkProgram name (e.g., 'ProofGate', 'Eligibility', 'AccessControl') */
  program: string;

  /** Method name on the program (e.g., 'verifyMember', 'proveEligibility') */
  method: string;

  /**
   * Serialized arguments array. Each element is JSON-safe:
   *   - Field → string (decimal)
   *   - Struct → object (via Provable.toJSON)
   *   - MerkleWitness → object (via witness.toJSON())
   *   - Proof → object (via proof.toJSON())
   *   - Primitive → as-is
   */
  args: unknown[];
}

/**
 * Generic proof job result — serialized proof + optional public output.
 */
export interface ProofJobResult {
  /** JSON.stringify(proof.toJSON()) — or null if proof not needed */
  proofJson: string | null;

  /**
   * Public output fields as decimal strings (if the method has publicOutput).
   * Keys match the Struct field names.
   */
  publicOutput: Record<string, string> | null;

  /** Wall-clock proving time (ms) */
  proveTimeMs: number;

  /** Worker ID that produced this result (stamped by coordinator) */
  workerId: number;
}

// ─── IPC Messages: Coordinator → Worker ──────────────────

export interface ProofCompileMessage {
  type: 'compile';
}

export interface ProofProveMessage {
  type: 'prove';
  jobId: string;
  request: ProofJobRequest;
}

export interface ProofShutdownMessage {
  type: 'shutdown';
}

export type ProofCoordinatorMessage =
  | ProofCompileMessage
  | ProofProveMessage
  | ProofShutdownMessage;

// ─── IPC Messages: Worker → Coordinator ──────────────────

export interface ProofReadyMessage {
  type: 'ready';
  compileTimeMs: number;
  programs: string[];
}

export interface ProofResultMessage {
  type: 'result';
  jobId: string;
  result: ProofJobResult;
}

export interface ProofErrorMessage {
  type: 'error';
  jobId: string;
  message: string;
}

export type ProofWorkerMessage =
  | ProofReadyMessage
  | ProofResultMessage
  | ProofErrorMessage;

// ─── Pool Options ─────────────────────────────────────────

export interface ProofPoolOptions {
  /** Timeout for ZkProgram compilation per worker (ms). Default: 20 minutes. */
  compileTimeoutMs?: number;

  /** Timeout for a single prove job (ms). Default: 3 minutes. */
  proveTimeoutMs?: number;

  /** Maximum number of times to restart a crashed worker. Default: 3. */
  maxWorkerRestarts?: number;

  /** Grace period before SIGTERM on shutdown (ms). Default: 5000. */
  shutdownGraceMs?: number;

  /**
   * Kill and respawn a worker after this many prove jobs.
   * Reclaims o1js WASM heap (~60MB per proof monotonic growth).
   * Default: 0 (disabled).
   */
  recycleAfterJobs?: number;
}

// ─── Pool Status ──────────────────────────────────────────

export interface ProofPoolStatus {
  poolSize: number;
  workersAlive: number;
  workersIdle: number;
  workersBusy: number;
  queueDepth: number;
  totalJobsCompleted: number;
  totalJobsFailed: number;
  avgProveTimeMs: number;
}
