#!/usr/bin/env node
/**
 * start-employer-nautilus.ts — Employer Nautilus App Entry Point
 *
 * Starts a local HTTPS/HTTP REST server for an employer entity.
 * No wallet, no enrollment key, no proof compilation. Admin-gated.
 * Manages enrollment tokens, groups, and roster.
 *
 * Configuration via environment variables:
 *
 *   ZKTRIDENT_PORT             — Server port (default: 4005)
 *   ZKTRIDENT_HOST             — Bind address (default: 0.0.0.0)
 *   ZKTRIDENT_SEQUENCER_URL    — Leviathan sequencer URL (default: http://localhost:3030)
 *   ZKTRIDENT_STATE_DIR        — State directory (default: ./nautilus-data)
 *   ZKTRIDENT_TLS_CERT         — Path to PEM certificate file (optional)
 *   ZKTRIDENT_TLS_KEY          — Path to PEM private key file (optional)
 *   ZKTRIDENT_SSE              — Enable SSE streaming (default: true)
 *   ZKTRIDENT_MAX_SSE          — Max SSE connections (default: 50)
 *   ZKTRIDENT_CORS_ORIGINS     — Comma-separated CORS origins (default: *)
 *   ZKTRIDENT_DISPLAY_NAME     — Display name for logging
 *   ZKTRIDENT_ADMIN_TOKEN      — Bearer token for admin endpoints (required)
 *   ZKTRIDENT_EMPLOYER_ID      — Employer identifier (required)
 *   ZKTRIDENT_INSURER_URL      — Insurer Nautilus URL for token submission (optional)
 *
 * Usage:
 *   ZKTRIDENT_EMPLOYER_ID=ACME-001 ZKTRIDENT_ADMIN_TOKEN=secret npx tsx src/nodes/start-employer-nautilus.ts
 */
import { NautilusAppServer } from './nautilus-app-server.js';
import type { NautilusAppConfig } from './nautilus-app-types.js';
import { buildEmployerRoutes } from './routes/employer-routes.js';
import { EmployerNode } from './employer-node.js';

// ─── Environment ─────────────────────────────────────────────

const env = process.env;

const config: NautilusAppConfig = {
  role: 'employer',
  port: parseInt(env.ZKTRIDENT_PORT ?? '4005', 10),
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
  adminToken: env.ZKTRIDENT_ADMIN_TOKEN,
};

const employerId = env.ZKTRIDENT_EMPLOYER_ID;
if (!employerId) {
  console.error('  [FATAL] ZKTRIDENT_EMPLOYER_ID is required');
  process.exit(1);
}
const insurerUrl = env.ZKTRIDENT_INSURER_URL;
if (insurerUrl && !/^https?:\/\//.test(insurerUrl)) {
  console.error('  [FATAL] ZKTRIDENT_INSURER_URL must start with http:// or https://');
  process.exit(1);
}

// ─── Main ────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('');
  console.log('  ╔══════════════════════════════════════════════╗');
  console.log('  ║     🏢  EMPLOYER NAUTILUS — zkTrident        ║');
  console.log('  ╚══════════════════════════════════════════════╝');
  console.log('');

  const server = new NautilusAppServer(config);

  // Register employer routes
  server.registerRoutes(buildEmployerRoutes(server));

  // Employer has no wallet, no PIN — create node directly
  const node = new EmployerNode({
    role: 'employer',
    sequencerUrl: config.sequencerUrl,
    displayName: config.displayName,
    employerId,
    insurerUrl,
  });
  server.setEntityNode(node);
  server.setOnboardingPhase('ready');

  console.log('  [init] EmployerNode created (no wallet, token authority)');
  console.log('  [init] Employer ID: %s', employerId);
  if (insurerUrl) {
    console.log('  [init] Insurer URL: %s', insurerUrl);
  }

  // ── Start Server ──

  await server.start();

  const proto = server.isTls() ? 'https' : 'http';
  console.log('');
  console.log('  Employer Nautilus App is running');
  console.log('  ─────────────────────────────────');
  console.log('  Role:          employer');
  console.log('  Employer ID:   %s', employerId);
  console.log('  API:           %s://%s:%d', proto, config.host, server.getPort());
  console.log('  Sequencer:     %s', config.sequencerUrl);
  console.log('  Insurer URL:   %s', insurerUrl ?? 'not configured');
  console.log('  TLS:           %s', server.isTls() ? 'enabled' : 'disabled');
  console.log('  SSE:           %s', config.enableSSE ? 'enabled' : 'disabled');
  console.log('  Admin token:   %s', config.adminToken ? 'configured' : 'NONE (admin endpoints disabled)');
  console.log('');

  // ── Graceful Shutdown ──

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log('');
    console.log('  [%s] Shutting down gracefully...', signal);
    await server.stop();
    console.log('  [shutdown] Server stopped');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('  [FATAL] Employer Nautilus startup failed:', err);
  process.exit(1);
});
