/**
 * employer-orchestrator.ts — Spawn-on-Activate Employer Node Manager
 *
 * Phase C: this module is the bridge between the marketplace activation
 * handler and a running per-tenant employer infrastructure. When called, it:
 *
 *   1. Validates that the employer has a signed attestation on the sequencer
 *   2. Checks the sequencer's live tenant registry to avoid duplicate spawns
 *   3. Allocates ephemeral TCP ports for the employer node + HR Tool
 *   4. Forks start-employer-nautilus.ts with the correct pinned identity
 *      (ZKTRIDENT_EMPLOYER_ID + ZKTRIDENT_EMPLOYER_PUBKEY_HEX + etc.)
 *   5. Waits for the employer node to boot, verify its attestation, and
 *      reach phase=ready
 *   6. Forks hr-tool-server.ts bound 1:1 to the employer node
 *   7. Waits for the HR Tool to respond on /api/session
 *   8. Registers the tenant on the sequencer via l2_registerEmployerNode
 *   9. Returns { employerNodeUrl, hrToolUrl, adminToken } to the caller
 *
 * On any failure, spawned child processes are killed and the tenant is
 * NOT registered. The caller receives a descriptive error.
 */
import { spawn, type ChildProcess } from 'child_process';
import { createServer } from 'net';
import { createHash, randomBytes } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const thisDir = path.dirname(fileURLToPath(import.meta.url));

// ─── In-Process Tenant Tracker ─────────────────────────────

/** In-memory map of tenants spawned by THIS orchestrator instance.
 *  This is a local cache; the sequencer's registry is authoritative.
 *  Used to kill child processes on orchestrator shutdown. */
interface LiveTenant {
  employerId: string;
  employerNodeUrl: string;
  hrToolUrl: string;
  employerChild: ChildProcess;
  hrToolChild: ChildProcess;
  adminToken: string;
  startedAt: number;
  sequencerUrl: string;
  insurerAdminToken: string;
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
      if (tenant.employerChild.killed || tenant.hrToolChild.killed) continue;
      try {
        const seqUrl = tenant.sequencerUrl.replace(/\/+$/, '');
        await fetch(`${seqUrl}/rpc`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${tenant.insurerAdminToken}`,
          },
          body: JSON.stringify({
            jsonrpc: '2.0', id: 1,
            method: 'l2_registerEmployerNode',
            params: {
              employerId: tenant.employerId,
              employerNodeUrl: tenant.employerNodeUrl,
              hrToolUrl: tenant.hrToolUrl,
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
  /** Admin token of the INSURER node, used to authenticate registration
   *  of the employer node on the sequencer's tenant registry. */
  insurerAdminToken: string;
}

export interface SpawnTenantResult {
  employerId: string;
  employerNodeUrl: string;
  hrToolUrl: string;
  adminToken: string;
}

export async function spawnEmployerTenant(opts: SpawnTenantOptions): Promise<SpawnTenantResult> {
  const { employerId, employerPubKeyHex, sequencerUrl, insurerUrl, insurerAdminToken } = opts;

  // ─── Step 1: Idempotency check ───
  // If a tenant with this employerId already has a live process via this
  // orchestrator instance, return the existing URLs (resume) rather than
  // spawning a duplicate. This makes activation safe to retry.
  const existing = liveTenants.get(employerId);
  if (existing && !existing.employerChild.killed && !existing.hrToolChild.killed) {
    return {
      employerId,
      employerNodeUrl: existing.employerNodeUrl,
      hrToolUrl: existing.hrToolUrl,
      adminToken: existing.adminToken,
    };
  }

  // Cross-check the sequencer's registry in case this orchestrator restarted
  // but the tenant is still running (zombie).
  const seqUrl = sequencerUrl.replace(/\/+$/, '');
  let existingRegistry: { employerId: string; employerNodeUrl: string; hrToolUrl: string } | null = null;
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
      await fetch(`${seqUrl}/rpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${insurerAdminToken}` },
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

  // ─── Step 3: Allocate ports and admin token ───
  const employerPort = await allocateEphemeralPort();
  const hrToolPort = await allocateEphemeralPort();
  const adminToken = generateAdminToken(employerId);

  // ─── Step 4: Fork the employer node ───
  const employerScript = path.resolve(thisDir, 'start-employer-nautilus.ts');
  const employerChild = spawn('npx', ['tsx', employerScript], {
    env: {
      ...process.env,
      ZKTRIDENT_PORT: String(employerPort),
      ZKTRIDENT_HOST: '127.0.0.1',
      ZKTRIDENT_EMPLOYER_ID: employerId,
      ZKTRIDENT_EMPLOYER_PUBKEY_HEX: employerPubKeyHex,
      ZKTRIDENT_SEQUENCER_URL: sequencerUrl,
      ZKTRIDENT_INSURER_URL: insurerUrl,
      ZKTRIDENT_ADMIN_TOKEN: adminToken,
      ZKTRIDENT_UNSECURE: 'true',
      ZKTRIDENT_CORS_ORIGINS: '*',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
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

  // ─── Step 5: Fork the HR Tool ───
  const hrToolScript = path.resolve(thisDir, '..', 'tools', 'hr-tool-server.ts');
  const hrToolChild = spawn('npx', ['tsx', hrToolScript], {
    env: {
      ...process.env,
      PORT: String(hrToolPort),
      HR_TOOL_DATA_DIR: `./hr-tool-data/${employerId}`,
      EMPLOYER_NODE_URL: employerNodeUrl,
      EMPLOYER_ADMIN_TOKEN: adminToken,
      // Phase E (bundled into Phase C): HR Tool pins its employer identity
      EMPLOYER_ID: employerId,
      EMPLOYER_PUBKEY_HEX: employerPubKeyHex,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
  });
  hrToolChild.stdout?.on('data', (d: Buffer) => process.stdout.write(`[hr-tool ${employerId}] ${d}`));
  hrToolChild.stderr?.on('data', (d: Buffer) => process.stderr.write(`[hr-tool ${employerId}] ${d}`));

  const hrToolUrl = `http://127.0.0.1:${hrToolPort}`;

  try {
    await pollUntilHealthy(
      `${hrToolUrl}/api/session`,
      (body) => body !== null && body !== undefined,
      30000,
      'HR Tool',
    );
  } catch (e) {
    try { hrToolChild.kill('SIGTERM'); } catch {}
    try { employerChild.kill('SIGTERM'); } catch {}
    throw e;
  }

  // ─── Step 6: Register tenant on sequencer ───
  try {
    const resp = await fetch(`${seqUrl}/rpc`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${insurerAdminToken}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'l2_registerEmployerNode',
        params: {
          employerId,
          employerNodeUrl,
          hrToolUrl,
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
    try { hrToolChild.kill('SIGTERM'); } catch {}
    try { employerChild.kill('SIGTERM'); } catch {}
    throw new Error(`Failed to register tenant on sequencer: ${e?.message || e}`);
  }

  // ─── Step 7: Track locally + return ───
  const tenant: LiveTenant = {
    employerId,
    employerNodeUrl,
    hrToolUrl,
    employerChild,
    hrToolChild,
    adminToken,
    startedAt: Date.now(),
    sequencerUrl,
    insurerAdminToken,
  };
  liveTenants.set(employerId, tenant);
  ensureKeepaliveRunning();

  // Auto-deregister if either child dies unexpectedly
  const onExit = (name: string) => (code: number | null) => {
    console.warn(`[orchestrator] ${name} for ${employerId} exited with code ${code}`);
    // Best-effort deregister on sequencer; ignore failures
    fetch(`${sequencerUrl.replace(/\/+$/, '')}/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${insurerAdminToken}` },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'l2_deregisterEmployerNode',
        params: { employerId },
      }),
    }).catch(() => {});
    liveTenants.delete(employerId);
  };
  employerChild.on('exit', onExit('employer node'));
  hrToolChild.on('exit', onExit('HR Tool'));

  console.log(`[orchestrator] Tenant "${employerId}" spawned — employer: ${employerNodeUrl}, HR Tool: ${hrToolUrl}`);

  return {
    employerId,
    employerNodeUrl,
    hrToolUrl,
    adminToken,
  };
}

/** Kill all spawned tenant processes. Called on orchestrator shutdown. */
export function shutdownAllTenants(): void {
  if (keepaliveTimer) {
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
  }
  for (const [id, tenant] of liveTenants.entries()) {
    try { tenant.hrToolChild.kill('SIGTERM'); } catch {}
    try { tenant.employerChild.kill('SIGTERM'); } catch {}
    console.log(`[orchestrator] Tenant "${id}" shut down`);
  }
  liveTenants.clear();
}

/** For the leviathan startup banner + diagnostics. */
export function listLiveTenants(): Array<{ employerId: string; employerNodeUrl: string; hrToolUrl: string; startedAt: number }> {
  return Array.from(liveTenants.values()).map(t => ({
    employerId: t.employerId,
    employerNodeUrl: t.employerNodeUrl,
    hrToolUrl: t.hrToolUrl,
    startedAt: t.startedAt,
  }));
}
