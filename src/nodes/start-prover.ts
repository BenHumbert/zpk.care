#!/usr/bin/env node
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
 * start-prover.ts — Proof Delegate Server Entry Point
 *
 * Starts a dedicated proof generation server for the Adjuda-GATOR Network.
 * Compiles ZkPrograms at startup, then accepts proof requests from
 * Nautilus entity nodes (Member, Prescriber, Pharmacy) over HTTP.
 *
 * The prover receives only hashed Field values (Poseidon outputs) —
 * no PHI/PII crosses the wire. Entity nodes verify returned proofs
 * locally (~5ms) before submitting to a Leviathan sequencer.
 *
 * Configuration via environment variables:
 *
 *   ZKTRIDENT_PROVER_PORT      — HTTP port (default: 4040)
 *   ZKTRIDENT_PROVER_API_KEY   — API key for /prove endpoint (default: none)
 *
 * Usage:
 *   npx tsx src/nodes/start-prover.ts
 *   ZKTRIDENT_PROVER_PORT=4040 ZKTRIDENT_PROVER_API_KEY=secret npx tsx src/nodes/start-prover.ts
 *
 * Requirements:
 *   - High RAM (~8-12 GB for ZkProgram compilation)
 *   - $env:NODE_OPTIONS="--max-old-space-size=12288" recommended
 */
import { ProofDelegateServer } from './proof-delegate.js';

// ─── Environment Parsing ──────────────────────────────────────

const env = process.env;

const proverPort = parseInt(env.ZKTRIDENT_PROVER_PORT ?? '4040', 10);
const proverApiKey = env.ZKTRIDENT_PROVER_API_KEY;

// ─── Main ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('');
  console.log('  ╔══════════════════════════════════════════════╗');
  console.log('  ║     🐊  PROOF DELEGATE — Adjuda-GATOR       ║');
  console.log('  ╚══════════════════════════════════════════════╝');
  console.log('');

  const server = new ProofDelegateServer({
    port: proverPort,
    apiKey: proverApiKey,
  });

  // ── Compile ZkPrograms ──

  console.log('  [compile] Compiling StateTransitionProgram...');
  const compileStart = Date.now();
  await server.compile();
  const compileMs = Date.now() - compileStart;
  console.log('  [compile] Compilation complete (%ds)', Math.round(compileMs / 1000));

  // ── Start Server ──

  await server.start();

  // ── Startup Banner ──

  console.log('');
  console.log('  Proof Delegate Server is running');
  console.log('  ─────────────────────────────────');
  console.log('  Prove:         http://localhost:%d/prove', proverPort);
  console.log('  Status:        http://localhost:%d/status', proverPort);
  console.log('  API key:       %s', proverApiKey ? 'configured' : 'NONE (unauthenticated)');
  console.log('');

  // ── Graceful Shutdown ──

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log('');
    console.log('  [%s] Shutting down...', signal);
    await server.stop();
    console.log('  [shutdown] Proof delegate server stopped');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('  [FATAL] Prover startup failed:', err);
  process.exit(1);
});
