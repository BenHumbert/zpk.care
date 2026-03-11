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
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
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

// Auto-detect dashboard directory
const thisDir = path.dirname(fileURLToPath(import.meta.url));
const dashboardDir = path.resolve(thisDir, '..', '..', 'dashboard-prescriber');
if (fs.existsSync(path.join(dashboardDir, 'index.html'))) {
  config.dashboardDir = dashboardDir;
}

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

  // ── Demo Prescriber (skip onboarding — seed identity from demo data) ──

  const demoPrescriberId = env.ZKTRIDENT_DEMO_PRESCRIBER;
  if (demoPrescriberId) {
    const { DEMO_PRESCRIBERS } = await import('../demo/prescribers.js');
    const { derivePrescriberWalletId } = await import('../wallets/wallet-derivation.js');

    const idx = parseInt(demoPrescriberId, 10);
    const prescriber = !isNaN(idx) && idx >= 0 && idx < DEMO_PRESCRIBERS.length
      ? DEMO_PRESCRIBERS[idx]
      : DEMO_PRESCRIBERS.find((p) =>
          p.lastName.toLowerCase() === demoPrescriberId.toLowerCase() ||
          `${p.firstName} ${p.lastName}`.toLowerCase() === demoPrescriberId.toLowerCase()
        );

    if (!prescriber) {
      console.error('  [FATAL] Demo prescriber not found: %s', demoPrescriberId);
      console.error('  Available: %s', DEMO_PRESCRIBERS.map((p, i) =>
        `${i}=${p.firstName} ${p.lastName}`).join(', '));
      process.exit(1);
    }

    const walletId = derivePrescriberWalletId(prescriber.localData, prescriber.enrollmentKey).toString();
    const displayName = `Dr. ${prescriber.firstName} ${prescriber.lastName}, ${prescriber.credential}`;

    console.log('  [demo] Prescriber: %s', displayName);
    console.log('  [demo] Specialty:  %s', prescriber.specialty);
    console.log('  [demo] Wallet:     %s...', walletId.slice(0, 20));

    const node = new PrescriberNode({
      role: 'prescriber',
      walletId,
      sequencerUrl: config.sequencerUrl,
      displayName,
    });
    server.setEntityNode(node);
    server.setOnboardingPhase('ready');
  }

  // ── State Recovery (non-demo mode) ──

  else {
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
  if (config.dashboardDir) {
    console.log('  Dashboard:     %s://%s:%d/', proto, config.host === '0.0.0.0' ? 'localhost' : config.host, server.getPort());
  }
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
