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
 * employer-orchestrator.ts — Spawn-on-Activate Employer Node Manager
 *
 * Phase C: this module is the bridge between the marketplace activation
 * handler and a running per-tenant employer infrastructure. When called, it:
 *
 *   1. Validates that the employer has a signed attestation on the sequencer
 *   2. Checks the sequencer's live tenant registry to avoid duplicate spawns
 *   3. Allocates an ephemeral TCP port and a per-tenant admin token
 *   4. Spawns start-employer-nautilus.ts with the correct pinned identity
 *      (ZKTRIDENT_EMPLOYER_ID + ZKTRIDENT_EMPLOYER_PUBKEY_HEX + etc.), told this
 *      process's PID so it exits on its own if this process dies (A7)
 *   5. Waits for the employer node to boot, verify its attestation, and
 *      reach phase=ready
 *   6. Registers the tenant on the sequencer via l2_registerEmployerNode
 *   7. Returns { employerNodeUrl, adminToken, hrToolSetup } to the caller
 *
 * A7: the HR Tool is NOT spawned here any more. It holds the employer's plaintext
 * correlation table (names, birth dates, enrollment PINs) and runs on the
 * employer's own machine; activation hands the employer what it needs to set it up.
 *
 * On any failure, spawned child processes are killed and the tenant is
 * NOT registered. The caller receives a descriptive error.
 */
import { spawn, type ChildProcess } from 'child_process';
import { createServer } from 'net';
import { createHash, randomBytes } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { signedFetch, type SequencerSigner } from './sequencer-fetch.js';

const thisDir = path.dirname(fileURLToPath(import.meta.url));

// ─── In-Process Tenant Tracker ─────────────────────────────

/** In-memory map of tenants spawned by THIS orchestrator instance.
 *  This is a local cache; the sequencer's registry is authoritative.
 *  Used to kill child processes on orchestrator shutdown. */
interface LiveTenant {
  employerId: string;
  employerNodeUrl: string;
  employerChild: ChildProcess;
  adminToken: string;
  startedAt: number;
  sequencerUrl: string;
  /** Signs the insurer node's requests to the sequencer with its own key (A9). */
  signSequencerRequest: SequencerSigner;
}
const liveTenants: Map<string, LiveTenant> = new Map();

// Keepalive timer: every 60 seconds, re-register all live tenants on the
// sequencer. This refreshes their lastHeartbeatAt and prevents TTL expiry.
// If the orchestrator process dies, keepalives stop and the sequencer
// automatically prunes stale entries after 5 minutes.
let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
const KEEPALIVE_INTERVAL_MS = 60_000;

function ensureKeepaliveRunning(): void {
  if (keepaliveTimer) return;
  keepaliveTimer = setInterval(async () => {
    for (const [id, tenant] of liveTenants.entries()) {
      // Skip dead children
      if (tenant.employerChild.killed) continue;
      try {
        const seqUrl = tenant.sequencerUrl.replace(/\/+$/, '');
        await signedFetch(tenant.signSequencerRequest, `${seqUrl}/rpc`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0', id: 1,
            method: 'l2_registerEmployerNode',
            params: {
              employerId: tenant.employerId,
              employerNodeUrl: tenant.employerNodeUrl,
              pid: tenant.employerChild.pid || 0,
              adminTokenFingerprint: fingerprint(tenant.adminToken),
            },
          }),
        });
      } catch (e) {
        console.warn('[orchestrator] Keepalive failed for %s:', id, e);
      }
    }
  }, KEEPALIVE_INTERVAL_MS);
  // Don't block process exit
  if (keepaliveTimer && typeof keepaliveTimer.unref === 'function') {
    keepaliveTimer.unref();
  }
}

// ─── Port Allocation ───────────────────────────────────────

/** Ask the OS for a free ephemeral port by binding to port 0 and reading
 *  back the assigned port. Used to avoid collisions in the 5xxxx range. */
async function allocateEphemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') {
        srv.close();
        return reject(new Error('Failed to allocate ephemeral port'));
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}

// ─── Health Polling ────────────────────────────────────────

async function pollUntilHealthy(
  url: string,
  matcher: (body: any) => boolean,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const start = Date.now();
  let lastError: string | null = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (resp.ok) {
        const body = await resp.json();
        if (matcher(body)) return;
      }
      lastError = `HTTP ${resp.status}`;
    } catch (e: any) {
      lastError = e?.message || String(e);
    }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`${label} did not become healthy within ${timeoutMs}ms (last error: ${lastError})`);
}

// ─── Admin Token Generation ────────────────────────────────

/** Generate a per-tenant admin token. Shown once to the employer on the
 *  marketplace activate screen; not recoverable from the orchestrator. */
function generateAdminToken(employerId: string): string {
  // prefix + 128-bit random, base36-encoded for readability
  const rand = randomBytes(16).toString('hex');
  return `${employerId.toLowerCase()}-admin-${rand.slice(0, 16)}`;
}

function fingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 16);
}

// ─── Main Entry Point ──────────────────────────────────────

export interface SpawnTenantOptions {
  employerId: string;
  employerPubKeyHex: string;
  sequencerUrl: string;
  insurerUrl: string;
  /**
   * Signs the insurer node's requests to the sequencer with the insurer's own key (A9); the
   * sequencer authorises tenant registration by the insurer role, so no bearer token travels.
   */
  signSequencerRequest: SequencerSigner;
}

/** What the employer's HR administrator needs to run the HR Tool on their own machine (A7). */
export interface HrToolSetup {
  command: string;
  employerNodeUrl: string;
  steps: string[];
}

export interface SpawnTenantResult {
  employerId: string;
  employerNodeUrl: string;
  adminToken: string;
  hrToolSetup: HrToolSetup;
}

export async function spawnEmployerTenant(opts: SpawnTenantOptions): Promise<SpawnTenantResult> {
  const { employerId, employerPubKeyHex, sequencerUrl, insurerUrl, signSequencerRequest } = opts;

  // ─── Step 1: Idempotency check ───
  // If a tenant with this employerId already has a live process via this
  // orchestrator instance, return the existing URLs (resume) rather than
  // spawning a duplicate. This makes activation safe to retry.
  const existing = liveTenants.get(employerId);
  if (existing && !existing.employerChild.killed) {
    return {
      employerId,
      employerNodeUrl: existing.employerNodeUrl,
      adminToken: existing.adminToken,
      hrToolSetup: hrToolSetupFor(existing.employerNodeUrl),
    };
  }

  // Cross-check the sequencer's registry in case this orchestrator restarted
  // but the tenant is still running (zombie).
  const seqUrl = sequencerUrl.replace(/\/+$/, '');
  let existingRegistry: { employerId: string; employerNodeUrl: string; hrToolUrl?: string } | null = null;
  try {
    const resp = await fetch(`${seqUrl}/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'l2_getEmployerNode',
        params: { employerId },
      }),
    });
    const json = await resp.json() as any;
    if (json.result && json.result.employerId === employerId) {
      existingRegistry = json.result;
    }
  } catch (e: any) {
    throw new Error(`Cannot reach sequencer to check tenant registry: ${e?.message || e}`);
  }

  if (existingRegistry) {
    // Probe the registered URL. If alive, REFUSE to spawn — the operator
    // must force a reset to get a new admin token. If dead, deregister
    // and fall through to spawn fresh.
    let alive = false;
    try {
      const hResp = await fetch(`${existingRegistry.employerNodeUrl}/health`, { signal: AbortSignal.timeout(1500) });
      alive = hResp.ok;
    } catch { /* unreachable → treat as dead */ }

    if (alive) {
      throw new Error(
        `Tenant "${employerId}" is already running at ${existingRegistry.employerNodeUrl}. ` +
        `The admin token was shown once at the initial activation and is not recoverable. ` +
        `To issue a new admin token, an insurer admin must first call l2_deregisterEmployerNode and terminate the existing process.`,
      );
    }

    // Dead tenant — clean up the stale registry entry and spawn fresh
    try {
      await signedFetch(signSequencerRequest, `${seqUrl}/rpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 2,
          method: 'l2_deregisterEmployerNode',
          params: { employerId },
        }),
      });
    } catch {
      throw new Error(`Found a stale tenant registry entry for "${employerId}" but could not deregister it`);
    }
  }

  // ─── Step 2: Verify attestation exists on sequencer ───
  try {
    const resp = await fetch(`${seqUrl}/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'l2_getEmployerAttestation',
        params: { employerId },
      }),
    });
    const json = await resp.json() as any;
    if (!json.result || json.result.employerId !== employerId) {
      throw new Error(`No attestation on sequencer for employerId=${employerId}. Sign the agreement first.`);
    }
    if ((json.result.publicKeyHex || '').toLowerCase() !== employerPubKeyHex.toLowerCase()) {
      throw new Error(`Attestation public key mismatch for employerId=${employerId}. The activation pubkey does not match the signed attestation.`);
    }
  } catch (e: any) {
    throw new Error(`Cannot verify attestation: ${e?.message || e}`);
  }

  // ─── Step 3: Allocate a port and the tenant's admin token ───
  const employerPort = await allocateEphemeralPort();
  const adminToken = generateAdminToken(employerId);

  // ─── Step 4: Fork the employer node ───
  // A7: spawned from this node binary with tsx's loader rather than through `npx` and a shell, so
  // a tenant is one process instead of three, and told this process's PID so it can exit on its
  // own if this process dies without running its shutdown handlers (eight orphans from four runs
  // were found alive on one machine). ZKTRIDENT_UNSECURE is not passed: the employer launcher never
  // read it, and it is stripped from the inherited environment so a dev boot's flag stops here.
  const { ZKTRIDENT_UNSECURE: _dropUnsecure, ...inheritedEnv } = process.env;
  void _dropUnsecure;
  const employerScript = path.resolve(thisDir, 'start-employer-nautilus.ts');
  const employerChild = spawn(process.execPath, ['--import', 'tsx', employerScript], {
    cwd: process.cwd(),
    env: {
      ...inheritedEnv,
      ZKTRIDENT_PORT: String(employerPort),
      ZKTRIDENT_HOST: '127.0.0.1',
      ZKTRIDENT_EMPLOYER_ID: employerId,
      ZKTRIDENT_EMPLOYER_PUBKEY_HEX: employerPubKeyHex,
      ZKTRIDENT_SEQUENCER_URL: sequencerUrl,
      ZKTRIDENT_INSURER_URL: insurerUrl,
      ZKTRIDENT_ADMIN_TOKEN: adminToken,
      ZKTRIDENT_PARENT_PID: String(process.pid),
      // No ZKTRIDENT_CORS_ORIGINS: the spawned node resolves the local dashboard
      // origins itself. Passing '*' here opened every employer node to any origin.
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  employerChild.stdout?.on('data', (d: Buffer) => process.stdout.write(`[tenant ${employerId}] ${d}`));
  employerChild.stderr?.on('data', (d: Buffer) => process.stderr.write(`[tenant ${employerId}] ${d}`));
  const employerNodeUrl = `http://127.0.0.1:${employerPort}`;

  // Wait for the employer node to boot and load its attestation
  try {
    await pollUntilHealthy(
      `${employerNodeUrl}/health`,
      (body) => body?.ok && body?.data?.phase === 'ready',
      60000,
      'employer node',
    );
  } catch (e) {
    try { employerChild.kill('SIGTERM'); } catch {}
    throw e;
  }

  // ─── Step 5: Register the tenant on the sequencer ───
  try {
    const resp = await signedFetch(signSequencerRequest, `${seqUrl}/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'l2_registerEmployerNode',
        params: {
          employerId,
          employerNodeUrl,
          pid: employerChild.pid || 0,
          adminTokenFingerprint: fingerprint(adminToken),
        },
      }),
    });
    const json = await resp.json() as any;
    if (json.error) {
      throw new Error(json.error.message || String(json.error));
    }
  } catch (e: any) {
    try { employerChild.kill('SIGTERM'); } catch {}
    throw new Error(`Failed to register tenant on sequencer: ${e?.message || e}`);
  }

  // ─── Step 6: Track locally + return ───
  const tenant: LiveTenant = {
    employerId,
    employerNodeUrl,
    employerChild,
    adminToken,
    startedAt: Date.now(),
    sequencerUrl,
    signSequencerRequest,
  };
  liveTenants.set(employerId, tenant);
  ensureKeepaliveRunning();

  // Auto-deregister if the child dies unexpectedly
  employerChild.on('exit', (code: number | null) => {
    console.warn(`[orchestrator] employer node for ${employerId} exited with code ${code}`);
    // Best-effort deregister on sequencer; ignore failures
    signedFetch(signSequencerRequest, `${sequencerUrl.replace(/\/+$/, '')}/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'l2_deregisterEmployerNode',
        params: { employerId },
      }),
    }).catch(() => {});
    liveTenants.delete(employerId);
  });

  console.log(`[orchestrator] Tenant "${employerId}" spawned — employer node: ${employerNodeUrl}. The HR Tool runs on the employer's machine.`);

  return {
    employerId,
    employerNodeUrl,
    adminToken,
    hrToolSetup: hrToolSetupFor(employerNodeUrl),
  };
}

/**
 * What the employer's HR administrator needs in order to run the HR Tool on their own machine
 * (A7). The tool is never started on the insurer's host: the correlation table it keeps, with
 * employee names, birth dates and the enrollment PINs, belongs to the employer (rule I5).
 */
export function hrToolSetupFor(employerNodeUrl: string): HrToolSetup {
  return {
    command: 'npm run start:hr-tool',
    employerNodeUrl,
    steps: [
      'On the HR administrator\'s own machine, in a checkout of this repository, run: npm run start:hr-tool',
      'Open http://localhost:5050 and choose "Set up a workspace"',
      'Enter this employer node URL, the admin token shown once with it, and a passphrase of at least 12 characters',
      'The token and every employee record stay encrypted on that machine; only hashes reach the employer node',
    ],
  };
}

/** Kill all spawned tenant processes. Called on orchestrator shutdown. */
export function shutdownAllTenants(): void {
  if (keepaliveTimer) {
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
  }
  for (const [id, tenant] of liveTenants.entries()) {
    try { tenant.employerChild.kill('SIGTERM'); } catch {}
    console.log(`[orchestrator] Tenant "${id}" shut down`);
  }
  liveTenants.clear();
}

/** For the leviathan startup banner + diagnostics. */
export function listLiveTenants(): Array<{ employerId: string; employerNodeUrl: string; startedAt: number }> {
  return Array.from(liveTenants.values()).map(t => ({
    employerId: t.employerId,
    employerNodeUrl: t.employerNodeUrl,
    startedAt: t.startedAt,
  }));
}
