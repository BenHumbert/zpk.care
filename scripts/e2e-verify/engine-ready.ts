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
 * The live harnesses' wait for the claims engine to be ready to prove.
 *
 * The engine runs in the sequencer's process. Its proof pool starts at boot and its workers compile for minutes, and
 * until the pool runs the engine answers every request that makes proofs with 503 and Retry-After. So a harness waits,
 * before its first proving step, for GET /interactive/ready (an open read that names nothing about members) to answer
 * 200 { ready: true }. In the single-member run of 2026-10-19 the first prescription was sent about 150 s before the
 * pool was ready, and the prescriber node's request timed out.
 */
import { poll, type makeHttp } from './trace.js';

/** How long a harness waits for the engine to be ready to prove: 15 minutes. */
export const ENGINE_READY_TIMEOUT_MS = 15 * 60_000;

/** What GET /interactive/ready answers: whether the engine is ready, whether its programs are compiled, where proofs go. */
export interface EngineReadiness {
  ready: boolean;
  compiled: boolean;
  prover: 'pool' | 'starting' | 'inline';
}

export interface EngineReadyWait {
  /** The engine answered ready within the timeout. */
  ready: boolean;
  /** The engine's last answer, or null when it gave none. */
  readiness: EngineReadiness | null;
  /** How long the wait took, the sequencer's /health included. */
  ms: number;
}

/**
 * Reads the sequencer's /health until it answers, then polls GET /interactive/ready until the engine is ready to prove
 * or `timeoutMs` (15 minutes) has passed.
 */
export async function waitForEngineReady(
  http: ReturnType<typeof makeHttp>,
  seqUrl: string,
  opts: { timeoutMs?: number; everyMs?: number; healthTimeoutMs?: number } = {},
): Promise<EngineReadyWait> {
  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? ENGINE_READY_TIMEOUT_MS;
  await poll(http, `${seqUrl}/health`, (j) => j?.ok === true, opts.healthTimeoutMs ?? Math.min(timeoutMs, 120_000), Math.min(opts.everyMs ?? 2_000, 2_000));
  const left = Math.max(0, timeoutMs - (Date.now() - started));
  const answer = await poll(http, `${seqUrl}/interactive/ready`, (j) => j?.ready === true, left, opts.everyMs ?? 5_000);
  const j = answer.json;
  const readiness: EngineReadiness | null = j && typeof j === 'object' && typeof j.ready === 'boolean'
    ? { ready: j.ready, compiled: j.compiled === true, prover: j.prover }
    : null;
  return { ready: readiness?.ready === true, readiness, ms: Date.now() - started };
}
