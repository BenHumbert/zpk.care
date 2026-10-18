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
 * HR Tool Server — Local HTTP server for the HR Tool web UI.
 *
 * Runs on the employer's admin workstation. Serves:
 *   1. Static dashboard files (index.html, style.css, app.js, logo.png)
 *   2. REST API for Poseidon hashing, encrypted storage, and employer node proxy
 *
 * The hashing MUST happen server-side because o1js (Poseidon) runs in Node.js, not browser.
 * All PII stays on this machine — the employer node only receives hashes.
 *
 * Security fixes (council review):
 *   - CORS restricted to same-origin (no wildcard)
 *   - Passphrase discarded after key derivation; only derived key held in memory
 *   - Request body size capped at 10MB
 *   - Path traversal hardened with resolve() + normalized startsWith
 *   - Audit log for all PII access
 *   - Session timeout (15 min inactivity)
 *   - Fetch timeout on employer node proxy (10s)
 *   - CSV preview requires active session
 *   - groupId validated against regex before filesystem use
 *   - Failed imports only add entries after successful token generation
 *   - Error messages sanitized (no internal paths leaked)
 *   - Atomic file writes via core module
 *
 * Usage: npm run start:hr-tool   (on the HR admin's own machine — phase A item A7)
 *   PORT=5050 (default)
 *   HR_TOOL_DATA_DIR=./hr-tool-data (default)
 *   EMPLOYER_NODE_URL=http://localhost:4005 (default offered on the setup screen only)
 *
 * The employer node URL and the admin token are entered once at POST /api/setup and stored
 * encrypted under the workspace passphrase. Neither is read from the environment any more.
 */
import { createServer } from 'http';
import { readFileSync, existsSync, readdirSync, mkdirSync, appendFileSync, writeFileSync } from 'fs';
import { timingSafeEqual } from 'crypto';
import { PersistedAttemptLimiter } from '../security/attempt-limiter.js';
import { encryptWithPassphrase, decryptWithPassphrase, workspaceDirName } from './hr-tool-core.js';
import { join, resolve, extname, sep } from 'path';
import { fileURLToPath } from 'url';
import {
  generateGroupSeed,
  saveGroupSeed,
  loadGroupSeed,
  parseCsv,
  hashEmployeeRecords,
  saveCorrelationTable,
  loadCorrelationTable,
  reconcile,
  ensureDataDir,
  hashWithSeed,
  validateGroupId,
  generateClientKey,
  saveClientKey,
  loadClientKey,
  signEmployerRequest,
  generateTokenPIN,
  hashTokenPIN,
  workspacePaths,
  workspaceGroupPaths,
  saveWorkspaceMeta,
  loadWorkspaceMeta,
} from './hr-tool-core.js';
import type { CorrelationTable, CorrelationEntry, TokenDistributionRecord, HrToolClientKey, WorkspaceMeta } from './hr-tool-core.js';

const PORT = parseInt(process.env.PORT || '5050', 10);
const DATA_DIR = process.env.HR_TOOL_DATA_DIR || './hr-tool-data';
/** Wrong-passphrase counter: plaintext, no secrets, beside the encrypted workspaces (A7). */
const attempts = new PersistedAttemptLimiter(join(DATA_DIR, 'attempts.json'));
/** Offered as the default on the setup screen; the workspace records the real one. */
const DEFAULT_EMPLOYER_NODE_URL = process.env.EMPLOYER_NODE_URL || 'http://localhost:4005';
/** A7: the admin token is entered once at setup and kept encrypted beside the client key. */
const ADMIN_TOKEN_FILE = 'admin.token.enc';
const PASSPHRASE_MIN_LENGTH = 12;

const thisDir = fileURLToPath(new URL('.', import.meta.url));
const DASHBOARD_DIR = resolve(thisDir, '..', '..', 'dashboard-hr-tool');

const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10 MB
const SESSION_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
const FETCH_TIMEOUT_MS = 10_000; // 10 seconds

// ─── MIME Types ─────────────────────────────────────────────

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// ─── Helpers ────────────────────────────────────────────────

function jsonRes(res: any, status: number, data: any): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function ok(res: any, data: any): void { jsonRes(res, 200, { ok: true, data }); }
function errRes(res: any, status: number, msg: string): void { jsonRes(res, status, { ok: false, error: msg }); }

/** Read request body with size limit */
async function readBody(req: any): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', (chunk: Buffer | string) => {
      size += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
      if (size > MAX_BODY_SIZE) {
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      body += chunk;
    });
    req.on('error', (e: Error) => reject(e));
    req.on('end', () => {
      try { resolve(JSON.parse(body)); } catch { resolve(body); }
    });
  });
}

/**
 * Proxy a request to the employer node with timeout.
 *
 * Authentication (A7):
 *   1. Bearer token from the open workspace, decrypted at unlock and held only in memory.
 *   2. Ed25519 signature with the workspace's client key when no token is on file: a node whose
 *      key registry was populated out of band. Moving every HR Tool onto this path, with the
 *      employer node registering the key, is item A9's remainder.
 * The target URL is the open workspace's employer node, never a process-wide setting.
 */
async function proxyToEmployer(method: string, path: string, body?: any): Promise<any> {
  if (!activeWorkspaceUrl) throw new Error('No active workspace');
  const bodyStr = body ? JSON.stringify(body) : undefined;
  const signed = (): Record<string, string> => {
    const sig = signEmployerRequest(method, path, bodyStr, activeClientKey!);
    const h: Record<string, string> = { 'X-Admin-Signature': sig.signature };
    if (sig.contentHash) h['X-Content-Hash'] = sig.contentHash;
    return h;
  };
  // A9: the workspace's client key signs every request once the employer node knows it. The admin
  // token collected at setup registers the key, and registers it again after the employer node has
  // restarted (its key registry lives in memory): a 401 to a signed request is the one signal of
  // that. A workspace with a token and no key, or a key the node will not take, falls back to the
  // token, which is what A7 shipped.
  if (activeClientKey) {
    if (!clientKeyRegistered && activeAdminToken) clientKeyRegistered = await registerClientKeyWithEmployer();
    if (clientKeyRegistered) {
      const first = await fetchEmployer(activeWorkspaceUrl + path, method, bodyStr, signed());
      if (first.status !== 401 || !activeAdminToken) return first;
      clientKeyRegistered = await registerClientKeyWithEmployer();
      if (clientKeyRegistered) return fetchEmployer(activeWorkspaceUrl + path, method, bodyStr, signed());
    }
  }
  if (activeAdminToken) return fetchEmployer(activeWorkspaceUrl + path, method, bodyStr, { Authorization: 'Bearer ' + activeAdminToken });
  if (activeClientKey) return fetchEmployer(activeWorkspaceUrl + path, method, bodyStr, signed());
  return fetchEmployer(activeWorkspaceUrl + path, method, bodyStr, {});
}

/** Register the open workspace's client key on its employer node, with the admin token. */
async function registerClientKeyWithEmployer(): Promise<boolean> {
  if (!activeWorkspaceUrl || !activeClientKey || !activeAdminToken) return false;
  try {
    const r = await fetchEmployer(activeWorkspaceUrl + '/admin/client-keys', 'POST',
      JSON.stringify({ clientId: activeClientKey.clientId, publicKeyHex: activeClientKey.publicKeyHex }),
      { Authorization: 'Bearer ' + activeAdminToken });
    if (r.status < 300) { auditLog('client-key:registered', `clientId=${activeClientKey.clientId}`); return true; }
    console.warn('[hr-tool-server] The employer node did not register this workspace\'s client key (HTTP %d)', r.status);
    return false;
  } catch (err) {
    console.warn('[hr-tool-server] Could not reach the employer node to register the client key:', err instanceof Error ? err.message : err);
    return false;
  }
}

async function fetchEmployer(url: string, method: string, bodyStr: string | undefined, auth: Record<string, string>): Promise<any> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...auth };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { method, headers, body: bodyStr, signal: controller.signal });
    const text = await resp.text();
    try {
      const json = JSON.parse(text);
      return { status: resp.status, data: json.data ?? json };
    } catch {
      return { status: resp.status, data: text };
    }
  } finally {
    clearTimeout(timeout);
  }
}

// ─── Audit Log ──────────────────────────────────────────────

function auditLog(action: string, detail: string = ''): void {
  // Phase F3: audit logs are workspace-scoped when a workspace is active.
  // If a group is also selected, entries go to that group's audit file;
  // otherwise they go to a workspace-level audit file.
  if (!activeWorkspaceUrl) return;
  try {
    const ts = new Date().toISOString();
    const grp = activeGroupId ? ` group=${activeGroupId}` : '';
    const line = `${ts}\t${action}${grp}\t${detail}\n`;
    if (activeGroupId) {
      const paths = workspaceGroupPaths(DATA_DIR, activeWorkspaceUrl, activeGroupId);
      appendFileSync(paths.auditFile, line);
    } else {
      const ws = workspacePaths(DATA_DIR, activeWorkspaceUrl);
      appendFileSync(join(ws.wsDir, 'audit.log'), line);
    }
  } catch { /* best effort */ }
}

// ─── In-Memory Session State (Phase F3: workspace-scoped) ───
//
// A "workspace" is the HR admin's passphrase-unlocked container for one
// employer node. Inside a workspace the admin can switch between multiple
// groups. Each group has its own seed + correlation table, generated lazily
// the first time the group is selected.

/** Employer node URL this session is bound to. Identifies the workspace. */
let activeWorkspaceUrl: string | null = null;
/** Workspace metadata loaded from disk. */
let activeWorkspaceMeta: WorkspaceMeta | null = null;
/** Passphrase kept in memory for re-encryption on save. Cleared on lock. */
let activePassphrase: string | null = null;
/** Ed25519 client key for signing employer node requests. Workspace-scoped. */
let activeClientKey: HrToolClientKey | null = null;
/** Whether the open workspace's client key is known to its employer node (A9); re-learned on a 401. */
let clientKeyRegistered = false;
/** Employer node admin token, decrypted from the workspace at unlock. Workspace-scoped (A7). */
let activeAdminToken: string | null = null;

/** Currently-selected group within the active workspace. */
let activeGroupId: string | null = null;
/** Loaded seed for the active group. Generated lazily on first select. */
let activeSeed: Buffer | null = null;
/** Correlation table for the active group. */
let activeTable: CorrelationTable | null = null;

let lastActivityTime: number = 0;
let sessionTimeoutTimer: ReturnType<typeof setInterval> | null = null;

function touchSession(): void {
  lastActivityTime = Date.now();
}

function checkSessionTimeout(): void {
  if (activeWorkspaceUrl && Date.now() - lastActivityTime > SESSION_TIMEOUT_MS) {
    console.log('[hr-tool-server] Session timed out after 15 minutes of inactivity');
    auditLog('session:timeout');
    lockSession();
  }
}

function lockSession(): void {
  activeWorkspaceUrl = null;
  activeWorkspaceMeta = null;
  activePassphrase = null;
  activeClientKey = null;
  activeAdminToken = null;
  activeGroupId = null;
  activeSeed = null;
  activeTable = null;
}

/** Require an unlocked workspace. Used by endpoints that read workspace-level
 *  state (list groups, session info). Does NOT require a group to be selected. */
function requireWorkspace(res: any): boolean {
  if (!activeWorkspaceUrl || !activePassphrase) {
    errRes(res, 401, 'No active workspace. Unlock the HR Tool first.');
    return false;
  }
  touchSession();
  return true;
}

/** Require an unlocked workspace AND a selected group. Used by endpoints that
 *  operate on correlation-table data (import, list employees, reconcile). */
function requireGroup(res: any): boolean {
  if (!requireWorkspace(res)) return false;
  if (!activeGroupId || !activeTable || !activeSeed) {
    errRes(res, 409, 'No group selected. Choose a group first (POST /api/group/select).');
    return false;
  }
  return true;
}

function saveTable(): void {
  if (!activeWorkspaceUrl || !activeGroupId || !activePassphrase || !activeTable) return;
  const paths = workspaceGroupPaths(DATA_DIR, activeWorkspaceUrl, activeGroupId);
  saveCorrelationTable(paths.tableFile, activeTable, activePassphrase);
}

// ─── A7: workspace setup, passphrase policy, re-authentication ───────────────
//
// The HR Tool runs on the employer's own machine. Nothing it needs arrives in the environment
// any more: the employer node URL and the admin token are entered once at setup and kept encrypted
// under the passphrase, beside the client key. A workspace directory is named by a hash of the
// employer node URL, so an unlock can find it without knowing the URL first.

/** The paths of a workspace known only by its directory name (before its metadata is decrypted). */
function pathsForWorkspaceDir(dirName: string) {
  const wsDir = join(DATA_DIR, dirName);
  return {
    wsDir,
    metaFile: join(wsDir, 'workspace.meta.enc'),
    keyFile: join(wsDir, 'client.key.enc'),
    groupsDir: join(wsDir, 'groups'),
    tokenFile: join(wsDir, ADMIN_TOKEN_FILE),
  };
}

function listWorkspaceDirs(): string[] {
  ensureDataDir(DATA_DIR);
  try {
    return readdirSync(DATA_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory() && d.name.startsWith('workspace-'))
      .map(d => d.name);
  } catch {
    return [];
  }
}

/** Length over complexity, with a confirmation so a typo does not lock the admin out of a new workspace. */
function passphrasePolicyError(passphrase: unknown, confirm: unknown): string | null {
  if (typeof passphrase !== 'string' || passphrase.length === 0) return 'Passphrase is required';
  if (passphrase.length < PASSPHRASE_MIN_LENGTH) return `Passphrase must be at least ${PASSPHRASE_MIN_LENGTH} characters`;
  if (passphrase !== confirm) return 'Passphrase confirmation does not match';
  return null;
}

function openWorkspace(url: string, meta: WorkspaceMeta, passphrase: string, clientKey: HrToolClientKey | null, adminToken: string | null): void {
  activeWorkspaceUrl = url;
  activeWorkspaceMeta = meta;
  activePassphrase = passphrase;
  activeClientKey = clientKey;
  activeAdminToken = adminToken;
  clientKeyRegistered = false;
  activeGroupId = null;
  activeSeed = null;
  activeTable = null;
  touchSession();
}

function sendRetryAfter(res: any, status: number, retryAfterMs: number, what: string): void {
  const secs = Math.max(1, Math.ceil(retryAfterMs / 1000));
  try { res.setHeader('Retry-After', String(secs)); } catch { /* fake responses in tests */ }
  errRes(res, status, `Too many wrong ${what}. Try again in ${secs} s.`);
}

/**
 * Ask for the passphrase again before something sensitive (revealing a PIN, changing the stored
 * admin token). Compared in constant time against the passphrase that opened this workspace, and
 * counted on the same limiter as unlocking, so it cannot be used to grind the passphrase either.
 */
function reauth(res: any, passphrase: unknown): boolean {
  if (!activeWorkspaceUrl || !activePassphrase) { errRes(res, 401, 'No active workspace. Unlock the HR Tool first.'); return false; }
  const key = 'reauth:' + workspaceDirName(activeWorkspaceUrl);
  const verdict = attempts.check(key);
  if (!verdict.allowed) { sendRetryAfter(res, 429, verdict.retryAfterMs, 'passphrases'); return false; }
  const a = Buffer.from(typeof passphrase === 'string' ? passphrase : '', 'utf8');
  const b = Buffer.from(activePassphrase, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    const delay = attempts.recordFailure(key);
    auditLog('reauth:failed');
    if (delay > 0) { try { res.setHeader('Retry-After', String(Math.ceil(delay / 1000))); } catch { /* fake responses */ } }
    errRes(res, 403, 'Passphrase does not match');
    return false;
  }
  attempts.reset(key);
  return true;
}

/** What a list or lookup may return: everything the HR admin manages, minus the second factor. */
function publicEntry(e: CorrelationEntry): Omit<CorrelationEntry, 'tokenPIN' | 'tokenPinHash'> {
  const { tokenPIN: _pin, tokenPinHash: _hash, ...rest } = e;
  return rest;
}

// ─── API Routes ─────────────────────────────────────────────

async function handleApi(req: any, res: any, path: string, method: string): Promise<void> {
  // ── List workspaces that have been created locally
  // Phase F3: a workspace is the HR admin's passphrase-gated container for
  // one employer node. It exists if the admin has unlocked the tool at least
  // once against that employer URL.
  if (path === '/api/workspaces' && method === 'GET') {
    ensureDataDir(DATA_DIR);
    try {
      const dirs = readdirSync(DATA_DIR, { withFileTypes: true })
        .filter(d => d.isDirectory() && d.name.startsWith('workspace-'))
        .map(d => d.name);
      return ok(res, {
        // Only directory names are exposed — actual metadata requires passphrase.
        count: dirs.length,
        needsSetup: dirs.length === 0,
        defaultEmployerNodeUrl: DEFAULT_EMPLOYER_NODE_URL,
      });
    } catch {
      return ok(res, { count: 0, needsSetup: true, defaultEmployerNodeUrl: DEFAULT_EMPLOYER_NODE_URL });
    }
  }

  // ── Set up a workspace (A7: first run on the employer's machine)
  // Replaces the old create-on-first-unlock, which took the employer URL and the admin token from
  // the environment the orchestrator set, on the insurer's host. Both are entered here once and
  // stored encrypted under the passphrase; the token never appears in a process environment again.
  if (path === '/api/setup' && method === 'POST') {
    const body = await readBody(req);
    const { employerNodeUrl, adminToken, passphrase, passphraseConfirm } = body ?? {};
    let url: string;
    try {
      const u = new URL(String(employerNodeUrl ?? ''));
      if (!/^https?:$/.test(u.protocol)) throw new Error('scheme');
      url = u.origin;
    } catch {
      return errRes(res, 400, 'employerNodeUrl must be an http or https URL');
    }
    if (typeof adminToken !== 'string' || adminToken.trim().length < 16) {
      return errRes(res, 400, 'adminToken is required: the token collected once when the employer was activated');
    }
    const policy = passphrasePolicyError(passphrase, passphraseConfirm);
    if (policy) return errRes(res, 400, policy);

    ensureDataDir(DATA_DIR);
    const ws = workspacePaths(DATA_DIR, url);
    if (existsSync(ws.metaFile)) {
      return errRes(res, 409, 'A workspace for this employer node already exists on this machine. Unlock it instead.');
    }
    mkdirSync(ws.wsDir, { recursive: true });
    mkdirSync(ws.groupsDir, { recursive: true });
    const meta: WorkspaceMeta = { version: 1, employerNodeUrl: url, createdAt: new Date().toISOString(), label: url };
    saveWorkspaceMeta(ws.metaFile, meta, passphrase);
    const clientId = `hr-tool-${ws.wsDir.split(sep).pop()}`;
    const clientKey = generateClientKey(clientId);
    saveClientKey(ws.keyFile, clientKey, passphrase);
    writeFileSync(join(ws.wsDir, ADMIN_TOKEN_FILE), encryptWithPassphrase(adminToken.trim(), passphrase), { mode: 0o600 });

    openWorkspace(url, meta, passphrase, clientKey, adminToken.trim());
    // A9: register the key now, with the token presented once; from here on requests are signed.
    clientKeyRegistered = await registerClientKeyWithEmployer();
    auditLog('workspace:created', `employer=${url} auth=${clientKeyRegistered ? 'ed25519' : 'bearer'}`);
    return ok(res, {
      workspace: { employerNodeUrl: url, createdAt: meta.createdAt, firstRun: true },
      authMode: clientKeyRegistered ? 'ed25519' : 'bearer',
      clientId: clientKey.clientId,
      publicKeyHex: clientKey.publicKeyHex,
    });
  }

  // ── Unlock an existing workspace
  // Attempt-limited: three free, then a doubling delay to fifteen minutes, counted in a plaintext
  // sidecar because the counter cannot live inside a file encrypted under the passphrase being
  // guessed. Never a wipe.
  if (path === '/api/unlock' && method === 'POST') {
    const body = await readBody(req);
    const { passphrase, employerNodeUrl } = body ?? {};
    if (typeof passphrase !== 'string' || passphrase.length === 0) return errRes(res, 400, 'Passphrase is required');

    const dirs = listWorkspaceDirs();
    let dirName: string;
    if (typeof employerNodeUrl === 'string' && employerNodeUrl.length > 0) {
      dirName = workspaceDirName(employerNodeUrl);
      if (!dirs.includes(dirName)) return errRes(res, 404, 'No workspace for that employer node on this machine. Set one up first.');
    } else if (dirs.length === 1) {
      dirName = dirs[0];
    } else if (dirs.length === 0) {
      return errRes(res, 409, 'No workspace on this machine yet. Set one up first.');
    } else {
      return errRes(res, 409, 'Several workspaces exist on this machine; say which employer node to unlock.');
    }

    const limiterKey = 'unlock:' + dirName;
    const verdict = attempts.check(limiterKey);
    if (!verdict.allowed) return sendRetryAfter(res, 429, verdict.retryAfterMs, 'passphrases');

    const ws = pathsForWorkspaceDir(dirName);
    try {
      const meta = loadWorkspaceMeta(ws.metaFile, passphrase);
      let clientKey: HrToolClientKey | null = null;
      if (existsSync(ws.keyFile)) {
        try { clientKey = loadClientKey(ws.keyFile, passphrase); }
        catch { console.warn('[hr-tool-server] Could not load client key for this workspace'); }
      }
      let token: string | null = null;
      if (existsSync(ws.tokenFile)) token = decryptWithPassphrase(readFileSync(ws.tokenFile), passphrase);

      attempts.reset(limiterKey);
      openWorkspace(meta.employerNodeUrl, meta, passphrase, clientKey, token);
      const authMode = clientKey ? 'ed25519' : (token ? 'bearer' : 'none');
      auditLog('workspace:unlock', `employer=${meta.employerNodeUrl} auth=${authMode}`);
      return ok(res, {
        workspace: { employerNodeUrl: meta.employerNodeUrl, createdAt: meta.createdAt, firstRun: false },
        authMode,
        adminTokenOnFile: Boolean(token),
        clientId: clientKey?.clientId ?? null,
        publicKeyHex: clientKey?.publicKeyHex ?? null,
      });
    } catch {
      lockSession();
      const delay = attempts.recordFailure(limiterKey);
      if (delay > 0) { try { res.setHeader('Retry-After', String(Math.ceil(delay / 1000))); } catch { /* fake responses */ } }
      return errRes(res, 403, 'Wrong passphrase or corrupted workspace');
    }
  }

  // ── Store or rotate the employer node admin token for the open workspace
  // For a workspace created before A7 (which has no token on file) and for token rotation. Asks
  // for the passphrase again.
  if (path === '/api/workspace/admin-token' && method === 'POST') {
    if (!requireWorkspace(res)) return;
    const body = await readBody(req);
    if (!reauth(res, body?.passphrase)) return;
    const { adminToken } = body ?? {};
    if (typeof adminToken !== 'string' || adminToken.trim().length < 16) {
      return errRes(res, 400, 'adminToken is required');
    }
    const ws = workspacePaths(DATA_DIR, activeWorkspaceUrl!);
    writeFileSync(join(ws.wsDir, ADMIN_TOKEN_FILE), encryptWithPassphrase(adminToken.trim(), activePassphrase!), { mode: 0o600 });
    activeAdminToken = adminToken.trim();
    auditLog('workspace:admin-token-set');
    return ok(res, { stored: true, authMode: 'bearer' });
  }

  // ── List groups from employer node (after unlock)
  // Phase F3: groups live on the employer node, not locally. The HR Tool
  // pulls the group list from there so users can't invent fake groups.
  if (path === '/api/groups' && method === 'GET') {
    if (!requireWorkspace(res)) return;
    try {
      const resp = await proxyToEmployer('GET', '/groups');
      if (resp.status !== 200) return errRes(res, 502, 'Employer node returned ' + resp.status);
      const remoteGroups = Array.isArray(resp.data) ? resp.data : [];

      // Annotate each group with whether we have a local seed/table for it.
      const ws = workspacePaths(DATA_DIR, activeWorkspaceUrl!);
      const enriched = remoteGroups.map((g: any) => {
        const gid = g.groupId;
        let hasLocalState = false;
        let localEntryCount = 0;
        try {
          const gp = workspaceGroupPaths(DATA_DIR, activeWorkspaceUrl!, gid);
          if (existsSync(gp.seedFile)) {
            hasLocalState = true;
            if (existsSync(gp.tableFile) && activePassphrase) {
              try {
                const tbl = loadCorrelationTable(gp.tableFile, activePassphrase);
                localEntryCount = tbl.entries.length;
              } catch { /* ignore — may be re-encrypted with different passphrase */ }
            }
          }
        } catch { /* invalid groupId or IO error — fall through */ }
        return { ...g, hasLocalState, localEntryCount };
      });
      return ok(res, { groups: enriched });
    } catch (e: any) {
      return errRes(res, 502, 'Cannot reach employer node: ' + (e?.message || 'unknown'));
    }
  }

  // ── Select a group as the active context for imports
  // Phase F3 + F7: lazy seed generation. On first select, generate a 32-byte
  // seed for {workspace, groupId} and persist it encrypted. Subsequent selects
  // load the existing seed. The seed is the binding between plaintext PII and
  // its Poseidon hash — losing it means losing the ability to cross-reference
  // existing tokens to plaintext employees.
  if (path === '/api/group/select' && method === 'POST') {
    if (!requireWorkspace(res)) return;
    const body = await readBody(req);
    const { groupId } = body;
    if (!groupId) return errRes(res, 400, 'groupId is required');
    if (!validateGroupId(groupId)) return errRes(res, 400, 'Invalid groupId format');

    // Verify the group actually exists on the employer node before accepting.
    let remoteGroup: any = null;
    try {
      const resp = await proxyToEmployer('GET', '/groups/' + encodeURIComponent(groupId));
      if (resp.status === 404) return errRes(res, 404, `Group "${groupId}" does not exist on the employer node. Create it in the Employer Dashboard first.`);
      if (resp.status !== 200) return errRes(res, 502, 'Employer node returned ' + resp.status);
      remoteGroup = resp.data;
    } catch (e: any) {
      return errRes(res, 502, 'Cannot reach employer node to verify group');
    }

    // Load or lazily generate the group seed
    const gp = workspaceGroupPaths(DATA_DIR, activeWorkspaceUrl!, groupId);
    let seed: Buffer;
    let table: CorrelationTable;
    let firstSelect = false;

    if (existsSync(gp.seedFile)) {
      try {
        seed = loadGroupSeed(gp.seedFile, activePassphrase!);
      } catch {
        return errRes(res, 403, 'Could not decrypt group seed — passphrase mismatch');
      }
      // Distinguish missing table (ENOENT — safe to reinitialize) from
      // decryption failure (data corruption or passphrase drift — NEVER
      // silently overwrite; the admin must restore from backup).
      if (existsSync(gp.tableFile)) {
        try {
          table = loadCorrelationTable(gp.tableFile, activePassphrase!);
        } catch (e: any) {
          console.error('[hr-tool-server] Corrupt correlation table for group %s:', groupId, e?.message || e);
          return errRes(res, 500,
            `Corrupt correlation table for group "${groupId}". ` +
            `The seed decrypted successfully but the table failed to decrypt — ` +
            `this indicates either file corruption or passphrase drift. ` +
            `Restore the table file from backup, or delete ${gp.tableFile} to start fresh ` +
            `(WARNING: this loses all plaintext correlation data for the group).`);
        }
      } else {
        // Seed exists but table was never created (partial write or disk loss)
        table = {
          groupId,
          planId: remoteGroup.planId || '',
          createdAt: new Date().toISOString(),
          entries: [],
        };
        saveCorrelationTable(gp.tableFile, table, activePassphrase!);
      }
      // D2: reconcile stale planId if the employer has moved the group to
      // a different plan since the last select.
      if (remoteGroup.planId && table.planId !== remoteGroup.planId) {
        console.log('[hr-tool-server] Group %s planId changed: %s → %s (reconciling local table)', groupId, table.planId, remoteGroup.planId);
        table.planId = remoteGroup.planId;
        saveCorrelationTable(gp.tableFile, table, activePassphrase!);
      }
    } else {
      // First select — generate fresh seed and correlation table
      firstSelect = true;
      mkdirSync(gp.groupDir, { recursive: true });
      seed = generateGroupSeed();
      saveGroupSeed(gp.seedFile, seed, activePassphrase!);
      table = {
        groupId,
        planId: remoteGroup.planId || '',
        createdAt: new Date().toISOString(),
        entries: [],
      };
      saveCorrelationTable(gp.tableFile, table, activePassphrase!);
    }

    activeGroupId = groupId;
    activeSeed = seed;
    activeTable = table;
    touchSession();
    auditLog('group:select', `groupId=${groupId} firstSelect=${firstSelect} entries=${table.entries.length}`);

    return ok(res, {
      groupId,
      planId: remoteGroup.planId,
      effectiveDate: remoteGroup.effectiveDate,
      enrollmentCap: remoteGroup.enrollmentCap,
      isUnlimited: remoteGroup.isUnlimited === true || remoteGroup.enrollmentCap === 0,
      enrolledCount: remoteGroup.enrolledCount || 0,
      pendingTokens: remoteGroup.pendingTokens || 0,
      remainingSlots: remoteGroup.remainingSlots || 0,
      entryCount: table.entries.length,
      firstSelect,
    });
  }

  // ── Deselect the active group (return to workspace-level state)
  if (path === '/api/group/deselect' && method === 'POST') {
    if (!requireWorkspace(res)) return;
    auditLog('group:deselect');
    activeGroupId = null;
    activeSeed = null;
    activeTable = null;
    return ok(res, { deselected: true });
  }

  // ── Lock (end session)
  if (path === '/api/lock' && method === 'POST') {
    auditLog('session:lock');
    lockSession();
    return ok(res, { locked: true });
  }

  // ── Session status
  if (path === '/api/session' && method === 'GET') {
    return ok(res, {
      workspaceActive: !!activeWorkspaceUrl,
      employerNodeUrl: activeWorkspaceUrl,
      groupSelected: !!activeGroupId,
      groupId: activeGroupId,
      planId: activeTable?.planId ?? null,
      entryCount: activeTable?.entries.length ?? 0,
      authMode: activeClientKey ? 'ed25519' : (activeWorkspaceUrl ? 'bearer' : null),
    });
  }

  // ── Dashboard stats
  if (path === '/api/stats' && method === 'GET') {
    if (!requireGroup(res)) return;
    const entries = activeTable!.entries;
    const pending = entries.filter(e => e.status === 'pending').length;
    const issued = entries.filter(e => e.status === 'token_generated').length;
    const enrolled = entries.filter(e => e.status === 'enrolled').length;
    const terminated = entries.filter(e => e.status === 'terminated').length;

    let employerNodeOnline = false;
    try {
      const resp = await proxyToEmployer('GET', '/health');
      employerNodeOnline = resp.status === 200;
    } catch { /* offline */ }

    return ok(res, { total: entries.length, pending, issued, enrolled, terminated, employerNodeOnline });
  }

  // ── Parse CSV (preview only — requires session since PII is returned)
  if (path === '/api/csv/preview' && method === 'POST') {
    if (!requireGroup(res)) return;
    const body = await readBody(req);
    const { csvContent } = body;
    if (!csvContent) return errRes(res, 400, 'Missing CSV content');
    try {
      const records = parseCsv(csvContent);
      auditLog('csv:preview', `rows=${records.length}`);
      return ok(res, { count: records.length, preview: records.slice(0, 10) });
    } catch (e: any) {
      return errRes(res, 400, 'CSV parse error: check column headers and row format');
    }
  }

  // ── Import CSV (hash + generate tokens)
  if (path === '/api/import' && method === 'POST') {
    if (!requireGroup(res)) return;
    const body = await readBody(req);
    const { csvContent, validUntil, dryRun } = body;
    if (!csvContent || !validUntil) return errRes(res, 400, 'Missing CSV content or expiration date');

    try {
      const records = parseCsv(csvContent);
      const { entries: newEntries } = hashEmployeeRecords(records, activeSeed!, activeGroupId!, activeTable!.planId);

      const existingHashes = new Set(activeTable!.entries.map(e => e.employeeIdHash));
      const toProcess: CorrelationEntry[] = [];
      let skipped = 0;

      for (const entry of newEntries) {
        if (existingHashes.has(entry.employeeIdHash)) {
          skipped++;
        } else {
          toProcess.push(entry);
        }
      }

      if (dryRun) {
        return ok(res, {
          dryRun: true,
          total: records.length,
          newEntries: toProcess.length,
          skipped,
          preview: toProcess.slice(0, 20).map(e => ({
            employeeId: e.employeeId,
            familyId: e.familyId,
            name: e.firstName + ' ' + e.lastName,
            employeeIdHash: e.employeeIdHash.slice(0, 16) + '...',
          })),
        });
      }

      // Phase F1 + F5: capacity pre-check. Fetch fresh stats from the employer
      // node and abort the entire import if the new entries would exceed the
      // group's enrollment cap. This prevents partial imports where some
      // tokens are issued and others are blocked mid-loop with a confusing
      // "cap reached" error on the Nth employee.
      //
      // If stats are unavailable (employer node offline or stats endpoint
      // errored), we REFUSE to proceed rather than risk a partial import.
      // Fail-closed is the same principle Phase A applied to attestation.
      let statsResp;
      try {
        statsResp = await proxyToEmployer('GET', '/groups/' + encodeURIComponent(activeGroupId!) + '/stats');
      } catch (e: any) {
        return errRes(res, 503,
          'Cannot verify group capacity — employer node unreachable. ' +
          'Aborting import to prevent partial token generation. Retry once the employer node is back online.');
      }
      if (statsResp.status !== 200 || !statsResp.data) {
        return errRes(res, 503,
          `Cannot verify group capacity — stats endpoint returned ${statsResp.status}. Aborting import to prevent partial token generation.`);
      }
      const stats = statsResp.data;
      if (!stats.isUnlimited && toProcess.length > stats.remainingSlots) {
        return errRes(res, 409,
          `Cannot import ${toProcess.length} new employees — only ${stats.remainingSlots} slots remaining in group "${activeGroupId}" (cap: ${stats.enrollmentCap}, ` +
          `currently used: ${stats.enrolledCount + stats.pendingTokens}). Reduce the CSV size or terminate existing roster entries to make room.`);
      }

      // Generate tokens + PINs — only add entries to table AFTER successful generation
      // A7: the PIN rides in this response once, for the SMS step, and is not listed or exported again.
      const results: Array<{ employeeId: string; status: string; tokenId?: string; tokenPIN?: string; error?: string }> = [];
      const successEntries: CorrelationEntry[] = [];
      const failedEntries: CorrelationEntry[] = [];

      for (const entry of toProcess) {
        try {
          // Generate 8-digit PIN
          const pin = generateTokenPIN();

          // Step 1: Generate token on employer node
          // On retry, token may already exist (409) — retrieve tokenId and continue to PIN hash step
          let tokenId: string | undefined;
          let tokenIdHash: string | undefined;
          const resp = await proxyToEmployer('POST', '/tokens/generate', {
            groupId: activeGroupId,
            employeeIdHash: entry.employeeIdHash,
            familyIdHash: entry.familyIdHash,
            validUntil,
          });

          if (resp.status === 201 || (resp.data && resp.data.tokenId)) {
            tokenId = resp.data.tokenId;
            tokenIdHash = resp.data.tokenIdHash;
          } else if (resp.status === 409) {
            // Token already exists for this employee — likely a retry after PIN hash failure
            // Look up existing token by querying the roster
            try {
              const rosterResp = await proxyToEmployer('GET', '/roster/' + encodeURIComponent(entry.employeeIdHash));
              if (rosterResp.data?.tokenId) {
                tokenId = rosterResp.data.tokenId;
                tokenIdHash = rosterResp.data.tokenIdHash || '';
              }
            } catch { /* roster lookup failed — fall through to error */ }
          }

          if (!tokenId) {
            results.push({ employeeId: entry.employeeId, status: 'error', error: resp.data?.error || 'Token generation failed' });
            failedEntries.push(entry);
            continue;
          }

          // Step 2: Compute PIN hash and set on employer node
          const pinHash = hashTokenPIN(tokenId, pin);
          try {
            await proxyToEmployer('POST', '/tokens/' + encodeURIComponent(tokenId) + '/set-pin-hash', {
              tokenPinHash: pinHash,
            });
          } catch (pinErr: any) {
            // PIN hash set failed — revoke the orphaned token so it can't be used without 2FA
            try { await proxyToEmployer('POST', '/tokens/' + encodeURIComponent(tokenId) + '/revoke', {}); } catch { /* best effort */ }
            const msg = pinErr.name === 'AbortError' ? 'PIN hash set timeout' : 'PIN hash set failed';
            results.push({ employeeId: entry.employeeId, status: 'error', error: msg });
            failedEntries.push(entry);
            continue;
          }

          entry.tokenId = tokenId;
          entry.tokenIdHash = tokenIdHash || '';
          entry.tokenPIN = pin;
          entry.tokenPinHash = pinHash;
          entry.status = 'token_generated';
          results.push({ employeeId: entry.employeeId, status: 'ok', tokenId, tokenPIN: pin });
          successEntries.push(entry);
        } catch (e: any) {
          const msg = e.name === 'AbortError' ? 'Employer node timeout' : 'Connection failed';
          results.push({ employeeId: entry.employeeId, status: 'error', error: msg });
          failedEntries.push(entry);
        }
      }

      // Only add successful entries to the table; failed entries can be retried
      for (const entry of successEntries) {
        activeTable!.entries.push(entry);
      }

      saveTable();

      const success = successEntries.length;
      const failed = failedEntries.length;

      auditLog('import', `total=${records.length} success=${success} failed=${failed} skipped=${skipped}`);

      return ok(res, {
        total: records.length, processed: toProcess.length, skipped, success, failed, results,
        csvWarning: 'Remember to securely delete the source CSV file after import.',
        pinNotice: 'PINs are shown here once. Send each by SMS now; they are not listed or exported afterwards.',
      });
    } catch (e: any) {
      return errRes(res, 400, 'Import failed: check CSV format');
    }
  }

  // ── List employees (correlation table)
  if (path === '/api/employees' && method === 'GET') {
    if (!requireGroup(res)) return;
    const url = new URL(req.url, 'http://localhost');
    const status = url.searchParams.get('status') || '';
    const search = (url.searchParams.get('search') || '').toLowerCase();

    let entries = activeTable!.entries;
    if (status) entries = entries.filter(e => e.status === status);
    if (search) {
      entries = entries.filter(e =>
        e.employeeId.toLowerCase().includes(search) ||
        e.firstName.toLowerCase().includes(search) ||
        e.lastName.toLowerCase().includes(search) ||
        e.familyId.toLowerCase().includes(search) ||
        (e.email && e.email.toLowerCase().includes(search))
      );
    }

    // A7: the audit log records that a search happened, never what was searched for.
    auditLog('employees:list', `filter=${status || 'all'} search=${search ? 'yes' : 'no'} results=${entries.length}`);
    return ok(res, { total: entries.length, entries: entries.map(publicEntry) });
  }

  // ── Lookup single employee
  if (path.startsWith('/api/employees/') && method === 'GET') {
    if (!requireGroup(res)) return;
    const id = decodeURIComponent(path.slice('/api/employees/'.length));
    if (!id || id.includes('/')) return errRes(res, 400, 'Invalid employee identifier');

    // Try by employeeId first, then by hash
    let entry = activeTable!.entries.find(e => e.employeeId === id);
    if (!entry) {
      const hash = hashWithSeed(id, activeSeed!);
      entry = activeTable!.entries.find(e => e.employeeIdHash === hash);
    }
    if (!entry) entry = activeTable!.entries.find(e => e.employeeIdHash === id);
    if (!entry) return errRes(res, 404, 'Employee not found');

    auditLog('employees:lookup', `employeeIdHash=${entry.employeeIdHash.slice(0, 12)}`);
    return ok(res, publicEntry(entry));
  }

  // ── Reveal one employee's PIN again (A7)
  // PINs are shown once, at import, for the SMS step. They stay encrypted in the table so that a
  // lost text can be re-sent, but reading one back is a deliberate act: passphrase again, counted
  // on the unlock limiter, and an audit line that names the hash and never the person.
  if (path.startsWith('/api/employees/') && path.endsWith('/pin') && method === 'POST') {
    if (!requireGroup(res)) return;
    const hash = decodeURIComponent(path.slice('/api/employees/'.length, -'/pin'.length));
    if (!hash || hash.includes('/')) return errRes(res, 400, 'Invalid employee identifier');
    const body = await readBody(req);
    if (!reauth(res, body?.passphrase)) return;
    const entry = activeTable!.entries.find(e => e.employeeIdHash === hash);
    if (!entry) return errRes(res, 404, 'Employee not found');
    if (!entry.tokenPIN || !entry.tokenId) return errRes(res, 404, 'No PIN on file for this employee');
    auditLog('pin:reveal', `employeeIdHash=${hash.slice(0, 12)}`);
    return ok(res, { tokenId: entry.tokenId, tokenPIN: entry.tokenPIN });
  }

  // ── Reconcile with employer node
  if (path === '/api/reconcile' && method === 'POST') {
    if (!requireGroup(res)) return;
    try {
      const resp = await proxyToEmployer('GET', '/roster');
      if (resp.status !== 200) return errRes(res, 502, 'Could not reach the employer node');

      const nodeEntries = resp.data?.entries || [];
      const result = reconcile(activeTable!.entries, nodeEntries);

      // Sync enrollment statuses
      let synced = 0;
      for (const nodeEntry of nodeEntries) {
        const local = activeTable!.entries.find(e => e.employeeIdHash === nodeEntry.employeeIdHash);
        if (local && nodeEntry.status === 'enrolled' && local.status !== 'enrolled') {
          local.status = 'enrolled';
          synced++;
        }
      }
      if (synced > 0) saveTable();

      // Enrich results with employee names for HR readability
      const enriched = {
        ...result,
        synced,
        missingFromNodeDetail: result.missingFromNode.map(h => {
          const e = activeTable!.entries.find(e => e.employeeIdHash === h);
          return { hash: h, name: e ? e.firstName + ' ' + e.lastName : 'Unknown', employeeId: e?.employeeId || '' };
        }),
        unknownOnNodeDetail: result.unknownOnNode.map(h => ({ hash: h })),
        statusMismatchDetail: result.statusMismatches.map(m => {
          const e = activeTable!.entries.find(e => e.employeeIdHash === m.employeeIdHash);
          return { ...m, name: e ? e.firstName + ' ' + e.lastName : 'Unknown', employeeId: e?.employeeId || '' };
        }),
      };

      auditLog('reconcile', `matched=${result.matched} missing=${result.missingFromNode.length} unknown=${result.unknownOnNode.length} synced=${synced}`);
      return ok(res, enriched);
    } catch (e: any) {
      return errRes(res, 502, 'Cannot reach employer node');
    }
  }

  // ── Export token list
  if (path === '/api/export/tokens' && method === 'GET') {
    if (!requireGroup(res)) return;
    const tokens: TokenDistributionRecord[] = activeTable!.entries
      .filter(e => e.tokenId && e.status === 'token_generated')
      .map(e => ({
        employeeIdHash: e.employeeIdHash,
        tokenId: e.tokenId!,
        tokenIdHash: e.tokenIdHash || '',
        validUntil: '',
        displayName: e.firstName + ' ' + e.lastName.charAt(0) + '.',
      }));
    auditLog('export:tokens', `count=${tokens.length}`);
    return ok(res, { tokens });
  }

  // ── Employer node health check
  if (path === '/api/employer/health' && method === 'GET') {
    try {
      const resp = await proxyToEmployer('GET', '/health');
      return ok(res, { online: resp.status === 200, data: resp.data });
    } catch (e: any) {
      return ok(res, { online: false, error: 'Employer node unreachable' });
    }
  }

  // ── Available plans from employer node
  if (path === '/api/employer/plans' && method === 'GET') {
    try {
      const resp = await proxyToEmployer('GET', '/plans/available');
      return ok(res, resp.data);
    } catch (e: any) {
      return errRes(res, 502, 'Cannot fetch plans from employer node');
    }
  }

  // ── Get client identity info (workspace-scoped, Phase F3)
  if (path === '/api/identity' && method === 'GET') {
    if (!requireWorkspace(res)) return;
    return ok(res, {
      authMode: activeClientKey ? 'ed25519' : 'bearer',
      clientId: activeClientKey?.clientId ?? null,
      publicKeyHex: activeClientKey?.publicKeyHex ?? null,
      createdAt: activeClientKey?.createdAt ?? null,
    });
  }

  // ── Generate client key (workspace-scoped, Phase F3)
  if (path === '/api/identity/generate' && method === 'POST') {
    if (!requireWorkspace(res)) return;
    if (activeClientKey) return errRes(res, 409, 'Client key already exists for this workspace');
    const ws = workspacePaths(DATA_DIR, activeWorkspaceUrl!);
    const clientId = `hr-tool-${ws.wsDir.split(sep).pop()}`;
    const clientKey = generateClientKey(clientId);
    saveClientKey(ws.keyFile, clientKey, activePassphrase!);
    activeClientKey = clientKey;
    auditLog('identity:generate', `clientId=${clientId}`);
    return ok(res, {
      clientId: clientKey.clientId,
      publicKeyHex: clientKey.publicKeyHex,
      message: 'Register this public key with the employer node to enable secure authentication',
    });
  }

  return errRes(res, 404, 'Unknown endpoint');
}

// ─── Server ─────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  const method = req.method || 'GET';
  const rawUrl = req.url || '/';
  const urlPath = rawUrl.split('?')[0];

  // No CORS headers — same-origin only (dashboard served from same port)
  // Security headers
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' https://fonts.googleapis.com 'unsafe-inline'; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; script-src 'self' 'unsafe-inline'");

  if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // API routes
  if (urlPath.startsWith('/api/')) {
    try {
      await handleApi(req, res, urlPath, method);
    } catch (e: any) {
      console.error('[hr-tool-server] API error:', e.message);
      errRes(res, 500, 'Internal server error');
    }
    return;
  }

  // Static files — hardened path traversal prevention
  let filePath = urlPath === '/' ? '/index.html' : urlPath;
  const fullPath = resolve(join(DASHBOARD_DIR, filePath));
  const normalizedDashDir = resolve(DASHBOARD_DIR);

  // Prevent path traversal: resolved path must start with dashboard dir
  if (!fullPath.startsWith(normalizedDashDir + (normalizedDashDir.endsWith('/') || normalizedDashDir.endsWith('\\') ? '' : sep))) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  if (!existsSync(fullPath)) {
    // SPA fallback
    const indexPath = join(DASHBOARD_DIR, 'index.html');
    if (existsSync(indexPath)) {
      const content = readFileSync(indexPath);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(content);
      return;
    }
    res.writeHead(404); res.end('Not found'); return;
  }

  const ext = extname(fullPath);
  const contentType = MIME[ext] || 'application/octet-stream';
  const content = readFileSync(fullPath);
  res.writeHead(200, { 'Content-Type': contentType });
  res.end(content);
});

ensureDataDir(DATA_DIR);

// Session timeout checker — runs every 60 seconds
sessionTimeoutTimer = setInterval(checkSessionTimeout, 60_000);

server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════════════╗');
  console.log('  ║        zkpCare HR Tool — Local Server        ║');
  console.log('  ╠══════════════════════════════════════════════╣');
  console.log(`  ║  UI:            http://localhost:${PORT}          ║`);
  console.log(`  ║  Data dir:      ${DATA_DIR.padEnd(27)}║`);
  console.log(`  ║  Default node:  ${DEFAULT_EMPLOYER_NODE_URL.padEnd(27)}║`);
  console.log('  ║  Session timeout: 15 minutes                ║');
  console.log('  ║                                              ║');
  console.log('  ║  All PII stays on this machine.              ║');
  console.log('  ║  Only Poseidon hashes are transmitted.       ║');
  console.log('  ╚══════════════════════════════════════════════╝');
  console.log('');
});
