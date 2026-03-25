#!/usr/bin/env node
/**
 * start-insurer-nautilus.ts — Insurer Nautilus App Entry Point
 *
 * Starts a local HTTPS/HTTP REST server for an insurer (PBM) entity.
 * No wallet, no enrollment key, no proof compilation. Admin-gated.
 *
 * Configuration via environment variables:
 *
 *   ZKTRIDENT_PORT             — Server port (default: 4004)
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
 *
 * Usage:
 *   ZKTRIDENT_ADMIN_TOKEN=secret npx tsx src/nodes/start-insurer-nautilus.ts
 */
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { NautilusAppServer } from './nautilus-app-server.js';
import type { NautilusAppConfig } from './nautilus-app-types.js';
import { buildInsurerRoutes } from './routes/insurer-routes.js';
import { InsurerNode } from './insurer-node.js';

// ─── Environment ─────────────────────────────────────────────

const env = process.env;

const config: NautilusAppConfig = {
  role: 'insurer',
  port: parseInt(env.ZKTRIDENT_PORT ?? '4004', 10),
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

// Auto-detect dashboard directory
const thisDir = path.dirname(fileURLToPath(import.meta.url));
const dashboardDir = path.resolve(thisDir, '..', '..', 'dashboard-insurer');
if (fs.existsSync(path.join(dashboardDir, 'index.html'))) {
  config.dashboardDir = dashboardDir;
}

// ─── Main ────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('');
  console.log('  ╔══════════════════════════════════════════════╗');
  console.log('  ║     🐊  INSURER NAUTILUS — Adjuda-GATOR      ║');
  console.log('  ╚══════════════════════════════════════════════╝');
  console.log('');

  const server = new NautilusAppServer(config);

  // Register insurer routes
  server.registerRoutes(buildInsurerRoutes(server));

  // Insurer has no wallet, no PIN — create node directly
  const node = new InsurerNode({
    role: 'insurer',
    sequencerUrl: config.sequencerUrl,
    displayName: config.displayName,
  });
  server.setEntityNode(node);
  server.setOnboardingPhase('credentialing' as any);

  console.log('  [init] InsurerNode created (no wallet, admin-gated)');

  // ── Start Server ──

  await server.start();

  // ══════════════════════════════════════════════════════════
  //  PROVIDER CREDENTIALING — Register providers on the sequencer
  //
  //  In production: insurer verifies NPI/NCPDP credentials via NPPES/PECOS,
  //  then registers them in the sequencer's entity registry.
  //  Here: loads seed prescribers + pharmacies and registers via RPC.
  // ══════════════════════════════════════════════════════════

  const seqUrl = config.sequencerUrl.replace(/\/+$/, '');
  const adminToken = config.adminToken;

  async function rpcCall(method: string, params: Record<string, unknown>): Promise<unknown> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (adminToken) headers['Authorization'] = 'Bearer ' + adminToken;
    const res = await fetch(seqUrl + '/rpc', {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const json = await res.json() as any;
    if (json.error) throw new Error(json.error.message ?? JSON.stringify(json.error));
    return json.result;
  }

  // Wait for sequencer to be reachable (it may still be starting)
  let seqReady = false;
  for (let i = 0; i < 30; i++) {
    try {
      await fetch(seqUrl + '/health');
      seqReady = true;
      break;
    } catch { await new Promise((r) => setTimeout(r, 1000)); }
  }

  if (seqReady) {
    // ── Credential Prescribers (via provider registry) ──
    const { PRESCRIBERS } = await import('../data/index.js');
    const { derivePrescriberWalletId } = await import('../wallets/wallet-derivation.js');

    let prescriberCount = 0;
    for (const p of PRESCRIBERS) {
      const walletId = derivePrescriberWalletId(p.localData, p.enrollmentKey).toString();
      try {
        await rpcCall('l2_credentialProvider', {
          walletId,
          displayName: `Dr. ${p.firstName} ${p.lastName}, ${p.credential}`,
          providerType: 'prescriber',
          npi: p.localData.prescriberId,
          specialty: p.specialty,
          stateOfLicense: p.state,
          deaNumber: p.deaNumber,
          verificationMethod: 'nppes',
        });
        prescriberCount++;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('already registered')) {
          prescriberCount++; // Already present from checkpoint — count as success
        } else {
          console.error('  [credential] Failed to credential prescriber %s: %s', p.lastName, msg);
        }
      }
    }
    console.log('  [credential] Credentialed %d prescribers in provider registry', prescriberCount);

    // ── Credential Pharmacies (via provider registry) ──
    const { PHARMACIES } = await import('../data/index.js');
    const { derivePharmacyWalletId } = await import('../wallets/wallet-derivation.js');

    let pharmacyCount = 0;
    for (const p of PHARMACIES) {
      const walletId = derivePharmacyWalletId(p.localData, p.enrollmentKey).toString();
      try {
        await rpcCall('l2_credentialProvider', {
          walletId,
          displayName: p.storeName,
          providerType: 'pharmacy',
          npi: p.localData.serviceProviderId,
          pharmacyType: p.pharmacyTypeDesc,
          stateOfLicense: p.state,
          verificationMethod: 'nppes',
        });
        pharmacyCount++;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('already registered')) {
          pharmacyCount++; // Already present from checkpoint — count as success
        } else {
          console.error('  [credential] Failed to credential pharmacy %s: %s', p.storeName, msg);
        }
      }
    }
    console.log('  [credential] Credentialed %d pharmacies in provider registry', pharmacyCount);

    // ── Publish Plan Overlay (Option C) ──
    // Canonical 32K drugs already loaded into FormularyService on leviathan.
    // Just publish a default plan overlay with standard tier copays.
    try {
      const defaults = { tier1Copay: 1000, tier2Copay: 3500, tier3Copay: 7500, tier4Copay: 15000 };
      await rpcCall('l2_publishPlanOverlay', { planIdHash: 'default', planName: 'Standard Plan', overrides: [], defaults });

      // Also verify the formulary loaded
      const countRes = await rpcCall('l2_getFormularyDrugCount', {});
      console.log('  [formulary] Published default plan overlay (sequencer has %d drugs)', (countRes as any)?.count ?? '?');
    } catch (err) {
      console.error('  [formulary] Failed to publish plan overlay: %s', err);
    }
  } else {
    console.error('  [credential] Sequencer not reachable after 30s — skipping provider registration');
  }

  // Credentialing complete — signal ready so the leviathan health gate passes
  server.setOnboardingPhase('ready');
  console.log('  [init] Credentialing complete — phase → ready');

  const proto = server.isTls() ? 'https' : 'http';
  console.log('');
  console.log('  Insurer Nautilus App is running');
  console.log('  ─────────────────────────────────');
  console.log('  Role:          insurer');
  console.log('  API:           %s://%s:%d', proto, config.host, server.getPort());
  console.log('  Sequencer:     %s', config.sequencerUrl);
  console.log('  TLS:           %s', server.isTls() ? 'enabled' : 'disabled');
  console.log('  SSE:           %s', config.enableSSE ? 'enabled' : 'disabled');
  console.log('  Admin token:   %s', config.adminToken ? 'configured' : 'NONE (admin endpoints disabled)');
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
    await server.stop();
    console.log('  [shutdown] Server stopped');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('  [FATAL] Insurer Nautilus startup failed:', err);
  process.exit(1);
});
