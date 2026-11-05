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
 * start-insurer-nautilus.ts — Insurer Nautilus App Entry Point
 *
 * Starts a local HTTPS/HTTP REST server for an insurer (PBM) entity.
 * No wallet, no enrollment key, no proof compilation. Admin-gated.
 *
 * Configuration via environment variables:
 *
 *   ZKTRIDENT_PORT             — Server port (default: 4004)
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
 *   ZKTRIDENT_CEREMONY_RECORD  — The signed key ceremony record. This node's keys come from the master its
 *                                key holders provision once per machine (POST /keys/release) and its
 *                                machine keeps sealed after that, so a restart needs no one
 *   ZKTRIDENT_CEREMONY_NODE_ID — This node's name in the record (default: insurer)
 *   ZKTRIDENT_KEY_SEAL         — dpapi (the Windows default) or development (unsecure boots only)
 *
 * Usage:
 *   ZKTRIDENT_ADMIN_TOKEN=secret npx tsx src/nodes/start-insurer-nautilus.ts
 */
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { NautilusAppServer } from './nautilus-app-server.js';
import { parentPidFromEnv, watchParent } from './parent-watchdog.js';
import { nodeKeyFromEnv } from '../security/node-roles.js';
import type { NautilusAppConfig } from './nautilus-app-types.js';
import { buildInsurerRoutes } from './routes/insurer-routes.js';
import { buildMarketplaceRoutes, buildEmployerAdminRoutes } from './routes/marketplace-routes.js';
import { InsurerNode } from './insurer-node.js';
import { resolveBindHost, resolveAllowedOrigins, resolveRpcProxyPolicy } from '../security/network-policy.js';
import { buildKeyRoutes, attachNodeKeyring } from './routes/key-routes.js';
import { NodeKeyring } from '../keys/node-keyring.js';
import { resolveMachineSeal } from '../keys/machine-seal.js';
import { verifyCeremonyRecord, type CeremonyRecord } from '../keys/ceremony.js';
import { SealedRecordStore } from '../keys/sealed-store.js';
import { SUBKEYS } from '../keys/subkeys.js';
import { configureTenantKeys, respawnRegisteredTenants, type TenantRegistration } from './employer-orchestrator.js';

// ─── Environment ─────────────────────────────────────────────

const env = process.env;

const config: NautilusAppConfig = {
  role: 'insurer',
  port: parseInt(env.ZKTRIDENT_PORT ?? '4004', 10),
  host: resolveBindHost(env, 'insurer node'),
  sequencerUrl: env.ZKTRIDENT_SEQUENCER_URL ?? 'http://localhost:3030',
  stateDir: env.ZKTRIDENT_STATE_DIR ?? './nautilus-data',
  tlsCert: env.ZKTRIDENT_TLS_CERT,
  tlsKey: env.ZKTRIDENT_TLS_KEY,
  enableSSE: (env.ZKTRIDENT_SSE ?? 'true') !== 'false',
  maxSseConnections: parseInt(env.ZKTRIDENT_MAX_SSE ?? '50', 10),
  allowedOrigins: resolveAllowedOrigins(env, { role: 'insurer node' }),
  rpcProxy: resolveRpcProxyPolicy(env, 'insurer node'),
  displayName: env.ZKTRIDENT_DISPLAY_NAME,
  adminToken: env.ZKTRIDENT_ADMIN_TOKEN,
  // A9: this node's own key, from the launcher; its public half is registered on the sequencer with this node's role.
  nodeKey: nodeKeyFromEnv(env) ?? undefined,
  /*
   * A9, finding A-14: a dedicated seed for counter-signing employer attestations, separate from
   * the bearer token. The seed's public half has to be pinned on the sequencer, which refuses
   * employer registration without it, so the two are generated together at boot by
   * start-leviathan. Set it explicitly in a deployment that runs the insurer on its own.
   */
  insurerSigningSeed: env.ZKTRIDENT_INSURER_SIGNING_SEED,
};

// Auto-detect dashboard directory
const thisDir = path.dirname(fileURLToPath(import.meta.url));
const dashboardDir = path.resolve(thisDir, '..', '..', 'dashboard-insurer');
if (fs.existsSync(path.join(dashboardDir, 'index.html'))) {
  config.dashboardDir = dashboardDir;
}

// Auto-detect marketplace dashboard directory
const marketplaceDir = path.resolve(thisDir, '..', '..', 'dashboard-marketplace');
if (fs.existsSync(path.join(marketplaceDir, 'index.html'))) {
  config.marketplaceDashboardDir = marketplaceDir;
}

// ─── Main ────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('');
  console.log('  ╔══════════════════════════════════════════════╗');
  console.log('  ║     🐊  INSURER NAUTILUS — Adjuda-GATOR      ║');
  console.log('  ╚══════════════════════════════════════════════╝');
  console.log('');

  const server = new NautilusAppServer(config);

  // Register insurer routes + marketplace + employer admin
  server.registerRoutes(buildInsurerRoutes(server));
  server.registerRoutes(buildMarketplaceRoutes(server));
  server.registerRoutes(buildEmployerAdminRoutes(server));
  server.registerRoutes(buildKeyRoutes(server));

  // Insurer has no wallet, no PIN — create node directly
  const node = new InsurerNode({
    role: 'insurer',
    sequencerUrl: config.sequencerUrl,
    displayName: config.displayName,
    clientOptions: server.sequencerClientOptions(),
  });
  server.setEntityNode(node);
  server.setOnboardingPhase('credentialing' as any);

  console.log('  [init] InsurerNode created (no wallet, admin-gated)');

  let tenantRegistry: SealedRecordStore<TenantRegistration> | null = null;
  let serverReady = false;
  const bringBackTenants = async () => {
    const back = await respawnRegisteredTenants({
      sequencerUrl: config.sequencerUrl,
      insurerUrl: `http://localhost:${config.port}`,
      signSequencerRequest: (m, p, b) => server.sequencerAuthHeaders(m, p, b),
    });
    for (const t of back) {
      if (t.ok) console.log('  [tenants] %s is back at %s', t.employerId, t.employerNodeUrl);
      else console.error('  [tenants] %s could not be brought back: %s', t.employerId, t.error);
    }
  };

  // ── Keys (the key ceremony, owner 2026-11-04; the restart rule, owner 2026-11-05) ──
  // With a ceremony record this node's keys come from its master: provisioned once per machine by the key holders,
  // then opened by this machine's seal at every start, with no one. Claims never wait on it: they do not pass through
  // this node. Until it is unlocked the node signs no employer attestation.
  const ceremonyRecordPath = env.ZKTRIDENT_CEREMONY_RECORD?.trim();
  if (ceremonyRecordPath) {
    let record: CeremonyRecord;
    try {
      record = JSON.parse(fs.readFileSync(ceremonyRecordPath, 'utf8')) as CeremonyRecord;
      verifyCeremonyRecord(record);
    } catch (err) {
      console.error('  [FATAL] the key ceremony record at %s is not valid: %s', ceremonyRecordPath, err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
    if (config.insurerSigningSeed) {
      console.warn('  [keys] ZKTRIDENT_INSURER_SIGNING_SEED is ignored: this node signs with the key the ceremony made');
      config.insurerSigningSeed = undefined;
    }
    const keyring = new NodeKeyring({
      record,
      nodeId: env.ZKTRIDENT_CEREMONY_NODE_ID?.trim() || 'insurer',
      stateDir: config.stateDir,
      seal: resolveMachineSeal(env),
    });
    attachNodeKeyring(server, keyring);
    // A-136: once unlocked, the plan's sealed registry of the employer tenants it activated, so they come back after
    // this node's restart with their records, on their ports, with their admin tokens
    keyring.onUnlocked((k) => {
      tenantRegistry = SealedRecordStore.open<TenantRegistration>({
        dir: path.join(config.stateDir, 'plan-records'), name: 'tenants', key: k.subkey(SUBKEYS.planStore('tenants')),
      });
      configureTenantKeys({ keys: k, registry: tenantRegistry, stateDir: config.stateDir });
      if (serverReady) void bringBackTenants();
    });
    await keyring.start();
  } else {
    console.warn('  [keys] no key ceremony record: the insurer signs with %s', config.insurerSigningSeed ? 'the seed it was given' : 'nothing (no seed was given)');
  }

  // ── Start Server ──

  await server.start();

  // ══════════════════════════════════════════════════════════
  //  PROVIDER CREDENTIALING — Register providers on the sequencer
  //
  //  In production: insurer verifies NPI/NCPDP credentials via NPPES/PECOS,
  //  then registers them in the sequencer's entity registry.
  //  Here: loads the fictional seed prescribers + pharmacies and registers
  //  them via RPC. Nothing is looked up in NPPES, so the registry records
  //  verificationMethod 'manual'.
  // ══════════════════════════════════════════════════════════

  const seqUrl = config.sequencerUrl.replace(/\/+$/, '');
  async function rpcCall(method: string, params: Record<string, unknown>): Promise<unknown> {
    // A9: signed with the insurer node's own key; the sequencer authorises by the insurer role.
    const res = await server.signedFetch(seqUrl + '/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
    const { PRESCRIBERS, prescriberDisplayName } = await import('../data/index.js');
    const { derivePrescriberWalletId } = await import('../wallets/wallet-derivation.js');

    let prescriberCount = 0;
    for (const p of PRESCRIBERS) {
      const walletId = derivePrescriberWalletId(p.localData, p.enrollmentKey).toString();
      try {
        await rpcCall('l2_credentialProvider', {
          walletId,
          displayName: `${prescriberDisplayName(p)}, ${p.credential}`,
          providerType: 'prescriber',
          npi: p.localData.prescriberId,
          specialty: p.specialty,
          stateOfLicense: p.state,
          deaNumber: p.deaNumber,
          verificationMethod: 'manual',
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
          verificationMethod: 'manual',
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

    // ── Plans to publish again (plan-bound formularies) ──
    // A plan marked published before its terms were kept has no published terms: the engine binds no member to it and
    // /enrollment/complete refuses it, so each one is named here, by plan ID and name, until the insurer publishes it.
    try {
      const stale = await node.reportPlansNeedingRepublish();
      if (stale.length === 0) console.log('  [plans] Every published plan carries its published terms');
    } catch (err) {
      console.warn('  [plans] Could not check for plans to publish again: %s', err instanceof Error ? err.message : String(err));
    }
  } else {
    console.error('  [credential] Sequencer not reachable after 30s — skipping provider registration');
  }

  // Credentialing complete — signal ready so the leviathan health gate passes
  server.setOnboardingPhase('ready');
  console.log('  [init] Credentialing complete — phase → ready');
  serverReady = true;

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
    // Phase C: kill any tenant employer nodes + HR Tools the orchestrator spawned
    try {
      const { shutdownAllTenants } = await import('./employer-orchestrator.js');
      shutdownAllTenants();
    } catch { /* orchestrator module may not be loaded — ignore */ }
    await server.stop();
    tenantRegistry?.close();
    server.getKeyring()?.close();
    console.log('  [shutdown] Server stopped');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // A9: a node must not outlive the launcher that keyed it. The launcher passes its PID; when that
  // process is gone, so is this node's registration on the sequencer.
  const parentPid = parentPidFromEnv();
  if (parentPid) {
    watchParent({
      parentPid,
      onGone: () => {
        console.log('  [parent] the process that spawned this node (%d) is gone; shutting down', parentPid);
        void shutdown('parent-gone');
      },
    });
  }

  // A-136: the tenants activated before this restart, when the keys are already open; in the background, once this
  // node can shut down and watches its parent, since each tenant takes a few seconds to start
  if (tenantRegistry) void bringBackTenants();
}

main().catch((err) => {
  console.error('  [FATAL] Insurer Nautilus startup failed:', err);
  process.exit(1);
});
