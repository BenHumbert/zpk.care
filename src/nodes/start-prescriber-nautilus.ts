#!/usr/bin/env node
/**
 * start-prescriber-nautilus.ts — Prescriber Nautilus App Entry Point
 *
 * Starts a local HTTPS/HTTP REST server for a prescriber (doctor) entity.
 * Handles onboarding, prescribing history, provider network lookups,
 * formulary queries, and PCP assignment.
 *
 * Configuration via environment variables:
 *
 *   ZKTRIDENT_PORT             — Server port (default: 4002)
 *   ZKTRIDENT_HOST             — Bind address (default: 0.0.0.0)
 *   ZKTRIDENT_SEQUENCER_URL    — Leviathan sequencer URL (default: http://localhost:3030)
 *   ZKTRIDENT_STATE_DIR        — Encrypted state directory (default: ./nautilus-data)
 *   ZKTRIDENT_TLS_CERT         — Path to PEM certificate file (optional)
 *   ZKTRIDENT_TLS_KEY          — Path to PEM private key file (optional)
 *   ZKTRIDENT_SSE              — Enable SSE streaming (default: true)
 *   ZKTRIDENT_MAX_SSE          — Max SSE connections (default: 50)
 *   ZKTRIDENT_CORS_ORIGINS     — Comma-separated CORS origins (default: *)
 *   ZKTRIDENT_DISPLAY_NAME     — Display name for logging
 *   ZKTRIDENT_PROVER_URL       — Proof delegation URL (optional)
 *   ZKTRIDENT_PROVER_API_KEY   — Prover API key (optional)
 *   ZKTRIDENT_PIN              — PIN for encrypted state (for CI/testing; stdin if not set)
 *
 * Usage:
 *   npx tsx src/nodes/start-prescriber-nautilus.ts
 */
import { NautilusAppServer } from './nautilus-app-server.js';
import type { NautilusAppConfig } from './nautilus-app-types.js';
import type { NautilusStateData } from './nautilus-local-state.js';
import { buildPrescriberRoutes } from './routes/prescriber-routes.js';
import { PrescriberNode } from './prescriber-node.js';

// ─── Environment ─────────────────────────────────────────────

const env = process.env;

const config: NautilusAppConfig = {
  role: 'prescriber',
  port: parseInt(env.ZKTRIDENT_PORT ?? '4002', 10),
  host: env.ZKTRIDENT_HOST ?? '0.0.0.0',
  sequencerUrl: env.ZKTRIDENT_SEQUENCER_URL ?? 'http://localhost:3030',
  stateDir: env.ZKTRIDENT_STATE_DIR ?? './nautilus-data',
  tlsCert: env.ZKTRIDENT_TLS_CERT,
  tlsKey: env.ZKTRIDENT_TLS_KEY,
  enableSSE: (env.ZKTRIDENT_SSE ?? 'true') !== 'false',
  maxSseConnections: parseInt(env.ZKTRIDENT_MAX_SSE ?? '50', 10),
  allowedOrigins: env.ZKTRIDENT_CORS_ORIGINS
    ? env.ZKTRIDENT_CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
    : ['*'],
  displayName: env.ZKTRIDENT_DISPLAY_NAME,
  proverUrl: env.ZKTRIDENT_PROVER_URL,
  proverApiKey: env.ZKTRIDENT_PROVER_API_KEY,
};

const pin = env.ZKTRIDENT_PIN;

// ─── Main ────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('');
  console.log('  ╔══════════════════════════════════════════════╗');
  console.log('  ║     🐚  PRESCRIBER NAUTILUS — zkTrident      ║');
  console.log('  ╚══════════════════════════════════════════════╝');
  console.log('');

  const server = new NautilusAppServer(config);
  const localState = server.getLocalState();

  // Register prescriber routes (no network registry at startup — can be loaded later)
  server.registerRoutes(buildPrescriberRoutes(server));

  // ── State Recovery ──

  const stateExists = await localState.exists();
  if (stateExists && pin) {
    console.log('  [state] Unlocking encrypted state...');
    await localState.unlock(pin);
    const data = await localState.load();
    if (data?.walletId) {
      console.log('  [state] Restored wallet: %s...', data.walletId.slice(0, 12));
      const node = new PrescriberNode({
        role: 'prescriber',
        walletId: data.walletId,
        sequencerUrl: config.sequencerUrl,
        displayName: config.displayName,
      });
      server.setEntityNode(node);
      server.setOnboardingPhase(data.onboarding.phase as any ?? 'ready');
    }
  } else if (!stateExists && pin) {
    await localState.unlock(pin);
    const initialState: NautilusStateData = {
      version: 1,
      role: 'prescriber',
      onboarding: { phase: 'awaiting_token' },
      lastSavedAt: new Date().toISOString(),
    };
    await localState.save(initialState);
    console.log('  [state] Created new encrypted state');
  } else if (!pin) {
    console.log('  [state] No PIN provided (set ZKTRIDENT_PIN for auto-unlock)');
    console.log('  [state] Starting in fresh onboarding mode');
  }

  // ── Start Server ──

  await server.start();

  const proto = server.isTls() ? 'https' : 'http';
  console.log('');
  console.log('  Prescriber Nautilus App is running');
  console.log('  ─────────────────────────────────');
  console.log('  Role:          prescriber');
  console.log('  API:           %s://%s:%d', proto, config.host, server.getPort());
  console.log('  Sequencer:     %s', config.sequencerUrl);
  console.log('  TLS:           %s', server.isTls() ? 'enabled' : 'disabled');
  console.log('  SSE:           %s', config.enableSSE ? 'enabled' : 'disabled');
  console.log('  Phase:         %s', server.getOnboardingPhase());
  console.log('  State dir:     %s', config.stateDir);
  console.log('');

  // ── Graceful Shutdown ──

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log('');
    console.log('  [%s] Shutting down gracefully...', signal);
    localState.lock();
    console.log('  [shutdown] Encryption key zeroed');
    await server.stop();
    console.log('  [shutdown] Server stopped');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('  [FATAL] Prescriber Nautilus startup failed:', err);
  process.exit(1);
});
