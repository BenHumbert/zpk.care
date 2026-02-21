#!/usr/bin/env node
/**
 * start-prover.ts — Proof Delegate Server Entry Point
 *
 * Starts a dedicated proof generation server for the zkTrident Network.
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
  console.log('  ║     ⚡  PROOF DELEGATE — zkTrident          ║');
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
  console.log('  Prove:         http://0.0.0.0:%d/prove', proverPort);
  console.log('  Status:        http://0.0.0.0:%d/status', proverPort);
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
