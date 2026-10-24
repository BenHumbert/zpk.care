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
 * start-prescriber-nautilus.ts — Prescriber Nautilus App Entry Point
 *
 * Starts a local HTTPS/HTTP REST server for a prescriber (doctor) entity.
 * Handles onboarding, prescribing history, provider network lookups,
 * formulary queries, and PCP assignment.
 *
 * Configuration via environment variables:
 *
 *   ZKTRIDENT_PORT             — Server port (default: 4002)
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
 *   ZKTRIDENT_PIN              — PIN for encrypted state (for CI/testing; stdin if not set)
 *
 * Usage:
 *   npx tsx src/nodes/start-prescriber-nautilus.ts
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
import { buildPrescriberRoutes } from './routes/prescriber-routes.js';
import { PrescriberNode } from './prescriber-node.js';
import {
  resolveBindHost, resolveAllowedOrigins, resolveRpcProxyPolicy, resolvePublicHosts, isLoopbackBind,
} from '../security/network-policy.js';

// ─── Environment ─────────────────────────────────────────────

const env = process.env;

/*
 * Loopback only until provider sign-in (B4). This node's routes take no credential, so whoever reaches its port reads
 * the prescriber's book and acts as the prescriber. GET /prescriptions and the rest of its history, GET /pcp/patients
 * and GET /messaging/* read the sequencer signed as this prescriber's wallet, which admits it, so the answers carry
 * member wallet IDs, drugs, quantities, dates, copays, its primary-care patients and message metadata; the prescribing
 * and message routes write in its name, signed with its wallet or this node's key (the confused-deputy sweep of the
 * review of round eight of the security fixes, 2026-10-24). Bound to loopback, only this machine can ask. Bound to any
 * other address, so can every machine that reaches it: the Host check (A-82) turns away a rebound browser page, not a
 * client that names a loopback Host. So the node refuses to start on any address but loopback, an empty ZKTRIDENT_HOST
 * included, for which Node binds every interface.
 *
 * Nor does it answer a public name, for the reasons the pharmacy starter gives: a reverse proxy on this host would
 * bring other machines to the same routes, so the names in ZKTRIDENT_PUBLIC_HOSTS get 421 here, and the refusal says
 * not to use one, since a proxy that sends a loopback Host cannot be told from a browser on this machine. The names do
 * not stop the node: a name on a loopback bind exposes nothing by itself, and the whole-network launcher
 * (start-leviathan.ts) passes its own environment to every node it starts, the insurer's public name included.
 */
if (env.ZKTRIDENT_HOST !== undefined && !isLoopbackBind(env.ZKTRIDENT_HOST)) {
  console.error(
    '  [FATAL] prescriber node: ZKTRIDENT_HOST is "%s", not a loopback address. Until provider sign-in (B4) its ' +
      "routes answer anyone who reaches its port: they return this prescriber's book (member wallet IDs, drugs, " +
      'quantities, dates, copays, primary-care patients, messages) and prescribe and send messages in its name, so ' +
      'it must not be reachable beyond this machine. Unset ZKTRIDENT_HOST or set it to 127.0.0.1, ::1 or localhost, ' +
      'and use the dashboard on this machine. Do not put a reverse proxy in front of it either: until then the node ' +
      'answers no public name.',
    env.ZKTRIDENT_HOST,
  );
  process.exit(1);
}
const unansweredPublicHosts = resolvePublicHosts(env);
if (unansweredPublicHosts.length > 0) {
  console.warn(
    '  [net] prescriber node: ZKTRIDENT_PUBLIC_HOSTS lists %s, and this node answers none of them. Until provider ' +
      'sign-in (B4) its routes answer anyone who reaches its port, so no reverse proxy may bring other machines to ' +
      'it: it answers only its loopback names (localhost, 127.0.0.1, [::1]).',
    unansweredPublicHosts.join(', '),
  );
}

const config: NautilusAppConfig = {
  role: 'prescriber',
  port: parseInt(env.ZKTRIDENT_PORT ?? '4002', 10),
  host: resolveBindHost(env, 'prescriber node'),
  // None until provider sign-in (B4), whatever ZKTRIDENT_PUBLIC_HOSTS says (above).
  publicHosts: [],
  sequencerUrl: env.ZKTRIDENT_SEQUENCER_URL ?? 'http://localhost:3030',
  stateDir: env.ZKTRIDENT_STATE_DIR ?? './nautilus-data',
  tlsCert: env.ZKTRIDENT_TLS_CERT,
  tlsKey: env.ZKTRIDENT_TLS_KEY,
  enableSSE: (env.ZKTRIDENT_SSE ?? 'true') !== 'false',
  maxSseConnections: parseInt(env.ZKTRIDENT_MAX_SSE ?? '50', 10),
  allowedOrigins: resolveAllowedOrigins(env, { role: 'prescriber node' }),
  rpcProxy: resolveRpcProxyPolicy(env, 'prescriber node'),
  displayName: env.ZKTRIDENT_DISPLAY_NAME,
  proverUrl: env.ZKTRIDENT_PROVER_URL,
  proverApiKey: env.ZKTRIDENT_PROVER_API_KEY,
  adminToken: env.ZKTRIDENT_ADMIN_TOKEN,
  // A9: this node's own key, from the launcher; its public half is registered on the sequencer with this node's role.
  nodeKey: nodeKeyFromEnv(env) ?? undefined,
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
  console.log('  ║     🐊  PRESCRIBER NAUTILUS — Adjuda-GATOR   ║');
  console.log('  ╚══════════════════════════════════════════════╝');
  console.log('');

  const server = new NautilusAppServer(config);
  const localState = server.getLocalState();

  // Register prescriber routes (no network registry at startup — can be loaded later)
  server.registerRoutes(buildPrescriberRoutes(server));

  // ── Seed Prescriber (skip onboarding — seed identity from seed data) ──

  const seedPrescriberId = env.ZKTRIDENT_SEED_PRESCRIBER;
  if (seedPrescriberId) {
    const { PRESCRIBERS, prescriberDisplayName } = await import('../data/index.js');
    const { derivePrescriberWalletId } = await import('../wallets/wallet-derivation.js');

    const idx = parseInt(seedPrescriberId, 10);
    const prescriber = !isNaN(idx) && idx >= 0 && idx < PRESCRIBERS.length
      ? PRESCRIBERS[idx]
      : PRESCRIBERS.find((p) =>
          p.lastName.toLowerCase() === seedPrescriberId.toLowerCase() ||
          `${p.firstName} ${p.lastName}`.toLowerCase() === seedPrescriberId.toLowerCase()
        );

    if (!prescriber) {
      console.error('  [FATAL] Seed prescriber not found: %s', seedPrescriberId);
      console.error('  Available: %s', PRESCRIBERS.map((p, i) =>
        `${i}=${p.firstName} ${p.lastName}`).join(', '));
      process.exit(1);
    }

    const walletId = derivePrescriberWalletId(prescriber.localData, prescriber.enrollmentKey).toString();

    /*
     * A12, finding A-28. The wallet ID was derived from the seed enrollment key and the key was
     * then dropped, so this node could register but could not **encrypt an eScript**:
     * `encryptEScript` reads the key from local state and threw "Cannot send eScript: enrollment
     * key not available", and the prescriber path returned 500 on a clean boot.
     *
     * Held in memory only, via the obfuscated-key wrapper. Neither this setter nor
     * `useEnrollmentKey` touches the encrypted file, so the seed path keeps the property the
     * codemap recorded for it — nothing written to disk — while the feature that needs the key
     * works. A really enrolled node is in the same position after unlocking.
     */
    server.getLocalState().setEnrollmentKey(prescriber.enrollmentKey);
    const displayName = `${prescriberDisplayName(prescriber)}, ${prescriber.credential}`;

    console.log('  [seed] Prescriber: %s', displayName);
    console.log('  [seed] Specialty:  %s', prescriber.specialty);
    console.log('  [seed] Wallet:     %s...', walletId.slice(0, 20));

    const node = new PrescriberNode({
      role: 'prescriber',
      walletId,
      sequencerUrl: config.sequencerUrl,
      displayName,
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
      displayName,
      type: 'prescriber',
      npi: String(prescriber.localData.prescriberId),
      specialty: prescriber.specialty,
      enrollmentKey: prescriber.enrollmentKey,
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
        const node = new PrescriberNode({
          role: 'prescriber',
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

  // ── Start Server (if not already started by seed credentialing path) ──

  if (!server.isRunning()) {
    await server.start();
  }

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
  console.error('  [FATAL] Prescriber Nautilus startup failed:', err);
  process.exit(1);
});
