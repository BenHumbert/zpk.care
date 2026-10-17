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
 * start-employer-nautilus.ts — Employer Nautilus App Entry Point
 *
 * Starts a local HTTPS/HTTP REST server for an employer entity.
 * No wallet, no enrollment key, no proof compilation. Admin-gated.
 * Manages enrollment tokens, groups, and roster.
 *
 * Configuration via environment variables:
 *
 *   ZKTRIDENT_PORT             — Server port (default: 4005)
 *   ZKTRIDENT_HOST             — Bind address (default: 127.0.0.1, loopback only)
 *   ZKTRIDENT_SEQUENCER_URL    — Leviathan sequencer URL (default: http://localhost:3030)
 *   ZKTRIDENT_STATE_DIR        — State directory (default: ./nautilus-data)
 *   ZKTRIDENT_TLS_CERT         — Path to PEM certificate file (optional)
 *   ZKTRIDENT_TLS_KEY          — Path to PEM private key file (optional)
 *   ZKTRIDENT_SSE              — Enable SSE streaming (default: true)
 *   ZKTRIDENT_MAX_SSE          — Max SSE connections (default: 50)
 *   ZKTRIDENT_CORS_ORIGINS     — Comma-separated CORS origins
 *                                (default: the local dashboard origins)
 *   ZKTRIDENT_RPC_PROXY        — 1 to re-enable POST /rpc forwarding (default: off)
 *   ZKTRIDENT_DISPLAY_NAME     — Display name for logging
 *   ZKTRIDENT_ADMIN_TOKEN      — Bearer token for admin endpoints (required)
 *   ZKTRIDENT_EMPLOYER_ID      — Employer identifier (required)
 *   ZKTRIDENT_INSURER_URL      — Insurer Nautilus URL for token submission (optional)
 *
 * Usage:
 *   ZKTRIDENT_EMPLOYER_ID=ACME-001 ZKTRIDENT_ADMIN_TOKEN=secret npx tsx src/nodes/start-employer-nautilus.ts
 */
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { NautilusAppServer } from './nautilus-app-server.js';
import type { NautilusAppConfig } from './nautilus-app-types.js';
import { buildEmployerRoutes } from './routes/employer-routes.js';
import { EmployerNode } from './employer-node.js';
import { resolveBindHost, resolveAllowedOrigins, resolveRpcProxyPolicy } from '../security/network-policy.js';

// ─── Environment ─────────────────────────────────────────────

const env = process.env;

const config: NautilusAppConfig = {
  role: 'employer',
  port: parseInt(env.ZKTRIDENT_PORT ?? '4005', 10),
  host: resolveBindHost(env, 'employer node'),
  sequencerUrl: env.ZKTRIDENT_SEQUENCER_URL ?? 'http://localhost:3030',
  stateDir: env.ZKTRIDENT_STATE_DIR ?? './nautilus-data',
  tlsCert: env.ZKTRIDENT_TLS_CERT,
  tlsKey: env.ZKTRIDENT_TLS_KEY,
  enableSSE: (env.ZKTRIDENT_SSE ?? 'true') !== 'false',
  maxSseConnections: parseInt(env.ZKTRIDENT_MAX_SSE ?? '50', 10),
  allowedOrigins: resolveAllowedOrigins(env, { role: 'employer node' }),
  rpcProxy: resolveRpcProxyPolicy(env, 'employer node'),
  displayName: env.ZKTRIDENT_DISPLAY_NAME,
  adminToken: env.ZKTRIDENT_ADMIN_TOKEN,
};

// Auto-detect dashboard directory
const thisDir = path.dirname(fileURLToPath(import.meta.url));
const dashboardDir = path.resolve(thisDir, '..', '..', 'dashboard-employer');
if (fs.existsSync(path.join(dashboardDir, 'index.html'))) {
  config.dashboardDir = dashboardDir;
}

const employerId = env.ZKTRIDENT_EMPLOYER_ID;
if (!employerId) {
  console.error('  [FATAL] ZKTRIDENT_EMPLOYER_ID is required');
  process.exit(1);
}
// Phase A: mandatory Ed25519 public key pin. The employer node MUST know what
// public key it is expected to operate under. When the attestation loads from
// the sequencer, its publicKeyHex field is compared against this environment
// variable; any mismatch is a fatal identity error and the process exits.
const employerPubKeyHex = env.ZKTRIDENT_EMPLOYER_PUBKEY_HEX;
if (!employerPubKeyHex) {
  console.error('  [FATAL] ZKTRIDENT_EMPLOYER_PUBKEY_HEX is required');
  console.error('          This must be the Ed25519 public key that signed the marketplace');
  console.error('          agreement for this employerId. The orchestrator provides this.');
  process.exit(1);
}
if (!/^[0-9a-f]{64}$/i.test(employerPubKeyHex)) {
  console.error('  [FATAL] ZKTRIDENT_EMPLOYER_PUBKEY_HEX must be 64 hex characters (32 bytes)');
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
  console.log('  ║     🐊  EMPLOYER NAUTILUS — Adjuda-GATOR     ║');
  console.log('  ╚══════════════════════════════════════════════╝');
  console.log('');

  const server = new NautilusAppServer(config);

  // Register employer routes
  server.registerRoutes(buildEmployerRoutes(server));

  // Employer has no wallet, no PIN — create node directly
  const adminToken = config.adminToken;
  const node = new EmployerNode({
    role: 'employer',
    sequencerUrl: config.sequencerUrl,
    displayName: config.displayName,
    employerId,
    insurerUrl,
    clientOptions: adminToken ? { adminToken } : undefined,
  });
  server.setEntityNode(node);

  // Phase A: Fail-closed by construction. The employer node always requires a
  // valid attestation with a matching public key before it will serve any
  // mutating operation. There is no "open mode" fallback.
  node.setRequireAttestation(true);

  console.log('  [init] EmployerNode created (no wallet, token authority)');
  console.log('  [init] Employer ID:  %s', employerId);
  console.log('  [init] Pinned PubKey: %s…', employerPubKeyHex.slice(0, 16));
  console.log('  [init] Attestation:  REQUIRED (fail-closed)');
  if (insurerUrl) {
    console.log('  [init] Insurer URL:  %s', insurerUrl);
  }

  // Load the employer attestation from the sequencer and verify its public key
  // matches the pinned key. On mismatch, the process exits with a fatal error.
  // On "not yet registered", retry with exponential backoff; this covers the
  // race where the orchestrator spawns us right after l2_registerEmployer but
  // before the sequencer's replication has fully settled.
  async function loadAndVerifyAttestation(): Promise<'loaded' | 'not-found' | 'mismatch' | 'error'> {
    try {
      const seqUrl = config.sequencerUrl.replace(/\/+$/, '');
      const attResp = await fetch(`${seqUrl}/rpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'l2_verifyEmployer', params: { employerId } }),
      });
      const attJson = await attResp.json() as any;
      if (!attJson.result?.valid || !attJson.result?.attestation) {
        return 'not-found';
      }
      const att = attJson.result.attestation;
      // CRITICAL identity pin check — the attestation on the sequencer MUST
      // have been signed by the key the orchestrator told us to expect.
      if ((att.publicKeyHex || '').toLowerCase() !== employerPubKeyHex.toLowerCase()) {
        console.error('  [FATAL] Attestation public key mismatch.');
        console.error('          Expected: %s', employerPubKeyHex);
        console.error('          Got:      %s', att.publicKeyHex);
        console.error('          This process is pinned to a different identity.');
        return 'mismatch';
      }
      node.setAttestation(att);
      const plans = att.authorizedPlanIds || [];
      console.log('  [init] Attestation loaded: %d authorized plan(s) — [%s]', plans.length, plans.join(', '));
      return 'loaded';
    } catch (e: any) {
      console.warn('  [init] Sequencer unreachable: %s', e?.message || e);
      return 'error';
    }
  }

  // Retry with exponential backoff. The first attempt fires immediately
  // (happy path: sequencer already has the attestation, 0ms added latency).
  // Subsequent attempts sleep before firing, giving the orchestrator time
  // to finish registering the attestation. Total wall budget on a cold path:
  // 0 + 500 + 1000 + 2000 + 4000 + 8000 + 16000 = 31.5s across 7 attempts.
  // Sized to cover: orchestrator spawn latency + sequencer replica gossip
  // settling + in-flight proving lock contention on a slow CI box.
  const retryDelays = [0, 500, 1000, 2000, 4000, 8000, 16000];
  let finalStatus: 'loaded' | 'not-found' | 'error' = 'error';
  for (let i = 0; i < retryDelays.length; i++) {
    if (retryDelays[i] > 0) {
      console.log('  [init] Retrying attestation load in %dms...', retryDelays[i]);
      await new Promise(r => setTimeout(r, retryDelays[i]));
    }
    const status = await loadAndVerifyAttestation();
    if (status === 'loaded') { finalStatus = 'loaded'; break; }
    if (status === 'mismatch') {
      // Key mismatch is a permanent, unrecoverable identity error
      process.exit(1);
    }
    finalStatus = status;
  }

  if (finalStatus !== 'loaded') {
    console.error('  [FATAL] Could not load a valid attestation for employerId=%s', employerId);
    console.error('          The marketplace ceremony must have registered the attestation');
    console.error('          on the sequencer BEFORE this process started. Aborting.');
    process.exit(1);
  }

  server.setOnboardingPhase('ready');

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
  console.error('  [FATAL] Employer Nautilus startup failed:', err);
  process.exit(1);
});
