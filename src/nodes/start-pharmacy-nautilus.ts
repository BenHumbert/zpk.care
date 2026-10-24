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
 * start-pharmacy-nautilus.ts — Pharmacy Nautilus App Entry Point
 *
 * Starts a local HTTPS/HTTP REST server for a pharmacy entity.
 * Designed to be sideloaded into existing POS software — DUR endpoints
 * provide cross-pharmacy drug history for interaction screening.
 *
 * Configuration via environment variables:
 *
 *   ZKTRIDENT_PORT             — Server port (default: 4003)
 *   ZKTRIDENT_HOST             — Bind address (default: 127.0.0.1). Loopback only (127.0.0.0/8, ::1 or
 *                                localhost) until provider sign-in (B4): any other address stops the node
 *   ZKTRIDENT_PUBLIC_HOSTS     — Not answered here until provider sign-in (B4); the node says so at boot
 *   ZKTRIDENT_SEQUENCER_URL    — Leviathan sequencer URL (default: http://localhost:3030)
 *   ZKTRIDENT_STATE_DIR        — Encrypted state directory (default: ./nautilus-data)
 *   ZKTRIDENT_TLS_CERT         — Path to PEM certificate file (optional)
 *   ZKTRIDENT_TLS_KEY          — Path to PEM private key file (optional)
 *   ZKTRIDENT_SSE              — Enable SSE streaming (default: true)
 *   ZKTRIDENT_MAX_SSE          — Max SSE connections (default: 50)
 *   ZKTRIDENT_CORS_ORIGINS     — Comma-separated CORS origins
 *                                (default: the local dashboard origins)
 *   ZKTRIDENT_RPC_PROXY        — 1 to re-enable POST /rpc forwarding (default: off)
 *   ZKTRIDENT_DISPLAY_NAME     — Display name for logging
 *   ZKTRIDENT_PROVER_URL       — Proof delegation URL (optional)
 *   ZKTRIDENT_PROVER_API_KEY   — Prover API key (optional)
 *   ZKTRIDENT_INSURER_URL      — Insurer Nautilus URL notified at enrollment (optional;
 *                                http on this machine's loopback, https anywhere else)
 *   ZKTRIDENT_PIN              — PIN for encrypted state (for CI/testing; stdin if not set)
 *
 * Usage:
 *   npx tsx src/nodes/start-pharmacy-nautilus.ts
 */
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { NautilusAppServer } from './nautilus-app-server.js';
import { parentPidFromEnv, watchParent } from './parent-watchdog.js';
import { nodeKeyFromEnv } from '../security/node-roles.js';
import { registerProviderEntity } from './provider-registration.js';
import type { NautilusAppConfig } from './nautilus-app-types.js';
import type { NautilusStateData } from './nautilus-local-state.js';
import { buildPharmacyRoutes } from './routes/pharmacy-routes.js';
import { PharmacyNode } from './pharmacy-node.js';
import {
  resolveBindHost, resolveAllowedOrigins, resolveRpcProxyPolicy, resolvePeerUrl, resolvePublicHosts, isLoopbackBind,
} from '../security/network-policy.js';

// ─── Environment ─────────────────────────────────────────────

const env = process.env;

/*
 * Loopback only until provider sign-in (B4). This node's routes take no credential, so whoever reaches its port reads
 * the pharmacy's book and acts as the pharmacy. GET /dispensing and the rest of its history, and GET /messaging/*, read
 * the sequencer signed as this pharmacy's wallet, and GET /prescriptions/list reads the engine signed with this node's
 * key; both admit the pharmacy, so the answers carry member wallet IDs, drugs, quantities, dates, copays and message
 * metadata, and the fill, reversal and message routes write in its name the same way (the confused-deputy sweep of the
 * review of round eight of the security fixes, 2026-10-24). Bound to loopback, only this machine can ask. Bound to any
 * other address, so can every machine that reaches it: the Host check (A-82) turns away a rebound browser page, not a
 * client that names a loopback Host. So the node refuses to start on any address but loopback, an empty ZKTRIDENT_HOST
 * included, for which Node binds every interface.
 *
 * Nor does it answer a public name. A reverse proxy on this host would bring other machines to the same routes, and the
 * node cannot tell whether the proxy asks them for anything, so the names in ZKTRIDENT_PUBLIC_HOSTS get 421 here. That
 * turns away a proxy that passes on the client's Host. One that sends a loopback Host instead, as nginx does unless
 * told otherwise, cannot be told from a browser on this machine, which is why the refusal also says not to use one.
 * The names do not stop the node: on a loopback bind a name exposes nothing by itself, and the launcher that starts the
 * whole network (start-leviathan.ts) passes its own environment to every node it starts, so a name the insurer answers
 * behind its TLS proxy reaches this node too.
 */
if (env.ZKTRIDENT_HOST !== undefined && !isLoopbackBind(env.ZKTRIDENT_HOST)) {
  console.error(
    '  [FATAL] pharmacy node: ZKTRIDENT_HOST is "%s", not a loopback address. Until provider sign-in (B4) its routes ' +
      "answer anyone who reaches its port: they return this pharmacy's book (member wallet IDs, drugs, quantities, " +
      'dates, copays, messages) and fill, reverse and send messages in its name, so it must not be reachable beyond ' +
      'this machine. Unset ZKTRIDENT_HOST or set it to 127.0.0.1, ::1 or localhost, and use the dashboard on this ' +
      'machine. Do not put a reverse proxy in front of it either: until then the node answers no public name.',
    env.ZKTRIDENT_HOST,
  );
  process.exit(1);
}
const unansweredPublicHosts = resolvePublicHosts(env);
if (unansweredPublicHosts.length > 0) {
  console.warn(
    '  [net] pharmacy node: ZKTRIDENT_PUBLIC_HOSTS lists %s, and this node answers none of them. Until provider ' +
      'sign-in (B4) its routes answer anyone who reaches its port, so no reverse proxy may bring other machines to ' +
      'it: it answers only its loopback names (localhost, 127.0.0.1, [::1]).',
    unansweredPublicHosts.join(', '),
  );
}

// A-81: the insurer this node notifies at enrollment is named here and nowhere else, never by a
// request. A URL that the peer-URL check refuses stops the node at boot.
let insurerUrl: string | undefined;
try {
  insurerUrl = resolvePeerUrl(env, 'ZKTRIDENT_INSURER_URL', 'pharmacy node');
} catch (err) {
  console.error('  [FATAL] %s', err instanceof Error ? err.message : String(err));
  process.exit(1);
}

const config: NautilusAppConfig = {
  role: 'pharmacy',
  port: parseInt(env.ZKTRIDENT_PORT ?? '4003', 10),
  host: resolveBindHost(env, 'pharmacy node'),
  // None until provider sign-in (B4), whatever ZKTRIDENT_PUBLIC_HOSTS says (above).
  publicHosts: [],
  sequencerUrl: env.ZKTRIDENT_SEQUENCER_URL ?? 'http://localhost:3030',
  stateDir: env.ZKTRIDENT_STATE_DIR ?? './nautilus-data',
  tlsCert: env.ZKTRIDENT_TLS_CERT,
  tlsKey: env.ZKTRIDENT_TLS_KEY,
  enableSSE: (env.ZKTRIDENT_SSE ?? 'true') !== 'false',
  maxSseConnections: parseInt(env.ZKTRIDENT_MAX_SSE ?? '50', 10),
  allowedOrigins: resolveAllowedOrigins(env, { role: 'pharmacy node' }),
  rpcProxy: resolveRpcProxyPolicy(env, 'pharmacy node'),
  displayName: env.ZKTRIDENT_DISPLAY_NAME,
  proverUrl: env.ZKTRIDENT_PROVER_URL,
  proverApiKey: env.ZKTRIDENT_PROVER_API_KEY,
  insurerUrl,
  adminToken: env.ZKTRIDENT_ADMIN_TOKEN,
  // A9: this node's own key, from the launcher; its public half is registered on the sequencer with this node's role.
  nodeKey: nodeKeyFromEnv(env) ?? undefined,
};

// Auto-detect dashboard directory
const thisDir = path.dirname(fileURLToPath(import.meta.url));
const dashboardDir = path.resolve(thisDir, '..', '..', 'dashboard-pharmacy');
if (fs.existsSync(path.join(dashboardDir, 'index.html'))) {
  config.dashboardDir = dashboardDir;
}

const pin = env.ZKTRIDENT_PIN;

// ─── Main ────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('');
  console.log('  ╔══════════════════════════════════════════════╗');
  console.log('  ║     🐊  PHARMACY NAUTILUS — Adjuda-GATOR     ║');
  console.log('  ╚══════════════════════════════════════════════╝');
  console.log('');

  const server = new NautilusAppServer(config);
  const localState = server.getLocalState();

  // Register pharmacy routes
  server.registerRoutes(buildPharmacyRoutes(server));

  // ── Seed Pharmacy (skip onboarding — seed identity from seed data) ──

  const seedPharmacyId = env.ZKTRIDENT_SEED_PHARMACY;
  if (seedPharmacyId) {
    const { PHARMACIES } = await import('../data/index.js');
    const { derivePharmacyWalletId } = await import('../wallets/wallet-derivation.js');

    const idx = parseInt(seedPharmacyId, 10);
    const pharmacy = !isNaN(idx) && idx >= 0 && idx < PHARMACIES.length
      ? PHARMACIES[idx]
      : PHARMACIES.find((p) =>
          p.storeName.toLowerCase().includes(seedPharmacyId.toLowerCase()) ||
          p.ncpdpProviderId === seedPharmacyId
        );

    if (!pharmacy) {
      console.error('  [FATAL] Seed pharmacy not found: %s', seedPharmacyId);
      console.error('  Available: %s', PHARMACIES.map((p, i) =>
        `${i}=${p.storeName}`).join(', '));
      process.exit(1);
    }

    const walletId = derivePharmacyWalletId(pharmacy.localData, pharmacy.enrollmentKey).toString();

    /*
     * A12, finding A-28, same as the prescriber starter: the wallet ID was derived from the seed
     * enrollment key and the key then dropped, so anything needing it later had nothing to use.
     * Held in memory only — neither this setter nor `useEnrollmentKey` touches the encrypted
     * file, so the seed path still writes nothing to disk.
     */
    server.getLocalState().setEnrollmentKey(pharmacy.enrollmentKey);

    console.log('  [seed] Pharmacy:  %s', pharmacy.storeName);
    console.log('  [seed] Type:      %s', pharmacy.pharmacyTypeDesc);
    console.log('  [seed] Wallet:    %s...', walletId.slice(0, 20));

    const node = new PharmacyNode({
      role: 'pharmacy',
      walletId,
      sequencerUrl: config.sequencerUrl,
      displayName: pharmacy.storeName,
      clientOptions: server.sequencerClientOptions(),
    });
    server.setEntityNode(node);

    // Start server BEFORE credentialing poll so dashboard is accessible during the wait
    server.setOnboardingPhase('awaiting_credentialing' as any);
    await server.start();
    console.log('  [seed] Server started — waiting for credentialing on sequencer...');

    const seqUrl = config.sequencerUrl.replace(/\/+$/, '');
    let credentialed = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        const resp = await fetch(seqUrl + '/rpc', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'l2_getProvider', params: { walletId } }),
        });
        const json = await resp.json() as { result?: { credentialState?: number } | null };
        if (json.result && json.result.credentialState === 2) { // ACTIVE
          credentialed = true;
          break;
        }
      } catch { /* sequencer not ready yet */ }
      await new Promise((r) => setTimeout(r, 1000));
    }

    // A10b / A-30: this node's entity, with its encryption and signing keys, so an eScript can be
    // encrypted to it and its calls can be signed as it. Idempotent; the insurer credentials.
    const registration = await registerProviderEntity(server, {
      walletId,
      displayName: pharmacy.storeName,
      type: 'pharmacy',
      npi: String(pharmacy.localData.serviceProviderId),
      pharmacyType: pharmacy.pharmacyTypeDesc,
      enrollmentKey: pharmacy.enrollmentKey,
    });
    console.log(registration.ok
      ? '  [seed] Entity registered on sequencer (encryption + signing keys)'
      : `  [seed] Entity registration refused: ${registration.error}`);

    if (credentialed) {
      console.log('  [seed] Credentialed on sequencer — transitioning to ready');
      server.setOnboardingPhase('ready');
    } else {
      console.log('  [seed] Credentialing timeout — starting in ready mode (insurer may not be running)');
      server.setOnboardingPhase('ready');
    }
  }

  // ── State Recovery (recovery mode) ──

  else {
  const stateExists = await localState.exists();
  if (stateExists && pin) {
    console.log('  [state] Unlocking encrypted state...');
    await localState.unlock(pin);
    const data = await localState.load();
    if (data?.walletId) {
      console.log('  [state] Restored wallet: %s...', data.walletId.slice(0, 12));
      const node = new PharmacyNode({
        role: 'pharmacy',
        walletId: data.walletId,
        sequencerUrl: config.sequencerUrl,
        displayName: config.displayName,
        clientOptions: server.sequencerClientOptions(),
      });
      server.setEntityNode(node);
      server.setOnboardingPhase(data.onboarding.phase as any ?? 'ready');
    }
  } else if (!stateExists && pin) {
    await localState.unlock(pin);
    const initialState: NautilusStateData = {
      version: 1,
      role: 'pharmacy',
      onboarding: { phase: 'awaiting_token' },
      lastSavedAt: new Date().toISOString(),
    };
    await localState.save(initialState);
    console.log('  [state] Created new encrypted state');
  } else if (!pin) {
    console.log('  [state] No PIN provided (set ZKTRIDENT_PIN for auto-unlock)');
    console.log('  [state] Starting in fresh onboarding mode');
  }
  } // end else (recovery mode)

  // ── Start Server (if not already started by seed credentialing path) ──

  if (!server.isRunning()) {
    await server.start();
  }

  const proto = server.isTls() ? 'https' : 'http';
  console.log('');
  console.log('  Pharmacy Nautilus App is running');
  console.log('  ─────────────────────────────────');
  console.log('  Role:          pharmacy');
  console.log('  API:           %s://%s:%d', proto, config.host, server.getPort());
  console.log('  Sequencer:     %s', config.sequencerUrl);
  console.log('  Insurer URL:   %s', config.insurerUrl ?? 'not configured');
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
}

main().catch((err) => {
  console.error('  [FATAL] Pharmacy Nautilus startup failed:', err);
  process.exit(1);
});
