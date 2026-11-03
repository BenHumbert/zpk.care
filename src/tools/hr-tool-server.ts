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
 *   - A request must name this tool in its Host, and a write must declare JSON (A-82)
 *
 * Usage: npm run start:hr-tool   (on the HR admin's own machine — phase A item A7)
 *   PORT=5050 (default)
 *   HR_TOOL_DATA_DIR=./hr-tool-data (default)
 *   EMPLOYER_NODE_URL=http://localhost:4005 (default offered on the setup screen only)
 *   ZKTRIDENT_PUBLIC_HOSTS= (Host names answered beyond loopback; none by default)
 *
 * The employer node URL and the admin token are entered once at POST /api/setup and stored
 * encrypted under the workspace passphrase. Neither is read from the environment any more.
 */
import { createServer } from 'http';
import { readFileSync, existsSync, readdirSync, mkdirSync, appendFileSync, writeFileSync } from 'fs';
import { timingSafeEqual } from 'crypto';
import { PersistedAttemptLimiter } from '../security/attempt-limiter.js';
import {
  resolvePublicHosts, requestHostAllowed, bodyTypeAccepted, MISDIRECTED_REQUEST, UNSUPPORTED_BODY_TYPE, type HostPolicy,
} from '../security/network-policy.js';
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
import { textServiceFromEnv, normalizeMobile, maskMobile, TEXTS } from './text-service.js';
import type { TextService } from './text-service.js';
import { INVITE_MAX_DAYS, inviteExpiryProblem, compactInviteDate } from '../onboarding/token-authority.js';

const PORT = parseInt(process.env.PORT || '5050', 10);
/** A-82: the names this tool answers to in a request's Host, beside loopback with its port. */
const HOST_POLICY: HostPolicy = { bindHost: '127.0.0.1', publicHosts: resolvePublicHosts(process.env) };
const DATA_DIR = process.env.HR_TOOL_DATA_DIR || './hr-tool-data';
/**
 * A-109: the service that texts each PIN straight to its employee, so no one at HR sees one; null when none is set, and
 * then no invite is issued. HR_TOOL_TEXT_SERVICE (text-service.ts); an unknown one stops the start.
 */
let TEXT_SERVICE: TextService | null = null;
try {
  TEXT_SERVICE = textServiceFromEnv(process.env, DATA_DIR);
} catch (err) {
  console.error(`[FATAL] hr-tool: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
const NO_TEXT_SERVICE =
  'No text service is set up, so no PIN can be texted to an employee, and the HR Tool issues no invite without one. ' +
  'Set HR_TOOL_TEXT_SERVICE (outbox, for a demonstration) and restart the HR Tool.';
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

/** An entry as a table saved before A-109 may still hold it: with the PIN and its hash. */
type LegacyEntry = CorrelationEntry & { tokenPIN?: string; tokenPinHash?: string };

/**
 * What a list or lookup may return: everything the HR admin manages, minus the second factor, and a mobile number as
 * its last four digits (A-109).
 */
function publicEntry(e: CorrelationEntry): CorrelationEntry {
  const { tokenPIN: _pin, tokenPinHash: _hash, ...rest } = e as LegacyEntry;
  return rest.mobile ? { ...rest, mobile: maskMobile(rest.mobile) } : rest;
}

/** Delete the PINs and PIN hashes a table saved before A-109 kept (A-109: the HR Tool keeps none); how many entries had one. */
function scrubLegacyPins(table: CorrelationTable): number {
  let scrubbed = 0;
  for (const e of table.entries as LegacyEntry[]) {
    if (e.tokenPIN !== undefined || e.tokenPinHash !== undefined) {
      delete e.tokenPIN;
      delete e.tokenPinHash;
      scrubbed++;
    }
  }
  return scrubbed;
}

const isoDate = (ccyymmdd: string): string => `${ccyymmdd.slice(0, 4)}-${ccyymmdd.slice(4, 6)}-${ccyymmdd.slice(6, 8)}`;
/** The latest expiry an invite may have (A-138), CCYYMMDD: the default for a new invite. */
const latestInviteExpiry = (): string => compactInviteDate(new Date(Date.now() + INVITE_MAX_DAYS * 86_400_000).toISOString().slice(0, 10))!;

type IssueOutcome = { ok: true; tokenId: string; tokenIdHash: string; pinSentTo: string } | { ok: false; status: number; error: string };

/**
 * Issue an employee an invite (A-109): the employer node's code, a fresh PIN whose hash the node binds to it, and the PIN
 * texted straight to the employee's mobile. The PIN is kept nowhere. Every answer of the employer node is read (A-137:
 * one that refused used to count as success), and an invite that does not work is withdrawn, so a code goes out only
 * with its PIN bound and texted. The node withdraws the employee's earlier invite itself (A-135). On success the entry
 * carries the new code; the caller saves the table.
 */
async function issueInvite(entry: CorrelationEntry, validUntil: string, wording: 'pin' | 'replacedPin'): Promise<IssueOutcome> {
  const mobile = entry.mobile ? normalizeMobile(entry.mobile) : null;
  if (!mobile) return { ok: false, status: 400, error: 'No mobile number to text the PIN to: add one in the mobile column, or with Change mobile' };
  if (!TEXT_SERVICE) return { ok: false, status: 503, error: NO_TEXT_SERVICE };
  let gen: { status: number; data: any };
  try {
    gen = await proxyToEmployer('POST', '/tokens/generate', {
      groupId: activeGroupId, employeeIdHash: entry.employeeIdHash, familyIdHash: entry.familyIdHash, validUntil,
    });
  } catch (e: any) {
    return { ok: false, status: 502, error: e?.name === 'AbortError' ? 'Employer node timeout' : 'Connection failed' };
  }
  const tokenId = gen.status === 201 && typeof gen.data?.tokenId === 'string' ? (gen.data.tokenId as string) : null;
  if (!tokenId) {
    return { ok: false, status: gen.status >= 400 && gen.status < 500 ? gen.status : 502, error: gen.data?.error || `The employer node issued no code (${gen.status})` };
  }
  const withdraw = async (): Promise<void> => {
    try { await proxyToEmployer('POST', '/tokens/' + encodeURIComponent(tokenId) + '/revoke', {}); } catch { /* the code has no working PIN either way */ }
  };
  const pin = generateTokenPIN();
  let bound: { status: number; data: any };
  try {
    bound = await proxyToEmployer('POST', '/tokens/' + encodeURIComponent(tokenId) + '/set-pin-hash', { tokenPinHash: hashTokenPIN(tokenId, pin) });
  } catch (e: any) {
    await withdraw();
    return { ok: false, status: 502, error: e?.name === 'AbortError' ? 'PIN hash set timeout; no invite was issued' : 'PIN hash set failed; no invite was issued' };
  }
  if (bound.status !== 200) {
    await withdraw();
    return { ok: false, status: 502, error: `The employer node refused the PIN hash (${bound.status}${bound.data?.error ? ': ' + bound.data.error : ''}); no invite was issued` };
  }
  try {
    await TEXT_SERVICE.send({ to: mobile, body: TEXTS[wording](pin) });
  } catch (e: any) {
    await withdraw();
    return { ok: false, status: 502, error: `The PIN could not be texted (${e?.message || 'the text service failed'}); no invite was issued` };
  }
  const tokenIdHash: string = typeof gen.data?.tokenIdHash === 'string' ? gen.data.tokenIdHash : '';
  entry.mobile = mobile;
  entry.tokenId = tokenId;
  entry.tokenIdHash = tokenIdHash;
  entry.validUntil = isoDate(validUntil);
  entry.status = 'token_generated';
  return { ok: true, tokenId, tokenIdHash, pinSentTo: maskMobile(mobile) };
}

/** How often the HR Tool checks what became of its invites while it is unlocked (A-109 notices); 0 turns the timer off. */
const NOTICE_INTERVAL_MS = Number(process.env.HR_TOOL_NOTICE_INTERVAL_MS ?? 60_000);

/**
 * The notices (A-109): each employee is texted once when the current invite is used, and once when five wrong PINs
 * lock it, so an invite someone else used does not go unnoticed. The employer node's roster says what became of each
 * invite and holds no number; the numbers are here, so this runs only while the HR Tool is unlocked, every
 * NOTICE_INTERVAL_MS, and catches up when a group is selected. An invite is matched by its fingerprint, so a new one is
 * noticed afresh; a text that fails is tried again the next time. Returns the number of texts sent.
 */
async function sendDueNotices(): Promise<number> {
  if (!activeTable || !activeGroupId || !TEXT_SERVICE) return 0;
  const table = activeTable;
  const resp = await proxyToEmployer('GET', '/roster');
  if (resp.status !== 200) throw new Error(`the employer node answered ${resp.status} for its roster`);
  type OnNode = { employeeIdHash: string; tokenIdHash?: string | null; inviteStatus?: string | null };
  const byEmployee = new Map<string, OnNode>(((resp.data?.entries ?? []) as OnNode[]).map((e) => [e.employeeIdHash, e]));
  let sent = 0;
  for (const entry of table.entries) {
    const onNode = byEmployee.get(entry.employeeIdHash);
    const mobile = entry.mobile ? normalizeMobile(entry.mobile) : null;
    if (!onNode || !mobile || !entry.tokenIdHash || onNode.tokenIdHash !== entry.tokenIdHash) continue;   // the current invite only
    const due = onNode.inviteStatus === 'consumed' && entry.noticedUse !== entry.tokenIdHash ? 'used'
      : onNode.inviteStatus === 'locked' && entry.noticedLock !== entry.tokenIdHash ? 'locked'
        : null;
    if (!due) continue;
    try {
      await TEXT_SERVICE.send({ to: mobile, body: due === 'used' ? TEXTS.inviteUsed() : TEXTS.inviteLocked() });
    } catch {
      continue;   // tried again the next time
    }
    if (due === 'used') {
      entry.noticedUse = entry.tokenIdHash;
      entry.status = 'enrolled';
    } else {
      entry.noticedLock = entry.tokenIdHash;
    }
    sent++;
    auditLog(due === 'used' ? 'notice:used' : 'notice:locked', `employeeIdHash=${entry.employeeIdHash.slice(0, 12)}`);
  }
  if (sent > 0 && activeTable === table) saveTable();
  return sent;
}

let noticesInFlight: Promise<number> | null = null;
/** One run of the notices at a time, whoever asks: the timer, a group select, or HR. */
function runNotices(): Promise<number> {
  if (!noticesInFlight) noticesInFlight = sendDueNotices().finally(() => { noticesInFlight = null; });
  return noticesInFlight;
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
                // A-109: a table saved before it loses its PINs the first time it is opened
                if (scrubLegacyPins(tbl) > 0) saveCorrelationTable(gp.tableFile, tbl, activePassphrase);
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
    let pinsDeleted = 0;
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
          // A-109: a table saved before it loses its PINs the first time it is opened
          pinsDeleted = scrubLegacyPins(table);
          if (pinsDeleted > 0) saveCorrelationTable(gp.tableFile, table, activePassphrase!);
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
    if (pinsDeleted > 0) auditLog('pins:deleted', `count=${pinsDeleted}`);
    // A-109: the notices that came due while the HR Tool was locked go out now
    runNotices().catch(() => { /* the employer node is unreachable; the timer tries again */ });

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
    const { csvContent, validUntil: askedExpiry, dryRun } = body;
    if (!csvContent || !askedExpiry) return errRes(res, 400, 'Missing CSV content or expiration date');
    // A-138: the employer node refuses an invite past 14 days; said here before anything is issued
    const expiryProblem = inviteExpiryProblem(askedExpiry);
    if (expiryProblem) return errRes(res, 400, expiryProblem);
    const validUntil = compactInviteDate(askedExpiry)!;

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
          preview: toProcess.slice(0, 20).map(e => {
            const mobile = e.mobile ? normalizeMobile(e.mobile) : null;
            return {
              employeeId: e.employeeId,
              familyId: e.familyId,
              name: e.firstName + ' ' + e.lastName,
              employeeIdHash: e.employeeIdHash.slice(0, 16) + '...',
              // A-109: where the PIN will be texted; an employee with none is issued no invite
              mobile: mobile ? maskMobile(mobile) : null,
            };
          }),
          textService: TEXT_SERVICE ? TEXT_SERVICE.description : null,
        });
      }

      // A-109: each PIN is texted straight to its employee; with no text service no invite is issued, since its PIN
      // would reach nobody, or HR
      if (!TEXT_SERVICE) return errRes(res, 503, NO_TEXT_SERVICE);

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

      // Issue the invites — only working ones join the table. A-109: each PIN is texted straight to its employee and
      // kept nowhere, so the answer names where it went and never what it is.
      const results: Array<{ employeeId: string; status: string; tokenId?: string; pinSentTo?: string; error?: string }> = [];
      const successEntries: CorrelationEntry[] = [];
      const failedEntries: CorrelationEntry[] = [];

      for (const entry of toProcess) {
        const issued = await issueInvite(entry, validUntil, 'pin');
        if (issued.ok) {
          results.push({ employeeId: entry.employeeId, status: 'ok', tokenId: issued.tokenId, pinSentTo: issued.pinSentTo });
          successEntries.push(entry);
        } else {
          results.push({ employeeId: entry.employeeId, status: 'error', error: issued.error });
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
        pinNotice: 'Each PIN was texted straight to its employee: no one at HR sees it, and it is kept nowhere. Send each employee the invite code (export the codes, or print them).',
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

  // ── Send an employee a new invite (A-109)
  // This replaces the reveal of a PIN (A7), which let anyone who could unlock the HR Tool read any unused invite's PIN.
  // A lost text now means a new invite: a fresh code and PIN, the PIN texted to the employee, and the old invite
  // withdrawn by the employer node (A-135). A deliberate act: passphrase again, counted on the unlock limiter, and an
  // audit line that names the hash and never the person.
  if (path.startsWith('/api/employees/') && path.endsWith('/reissue') && method === 'POST') {
    if (!requireGroup(res)) return;
    const hash = decodeURIComponent(path.slice('/api/employees/'.length, -'/reissue'.length));
    if (!hash || hash.includes('/')) return errRes(res, 400, 'Invalid employee identifier');
    const body = await readBody(req);
    if (!reauth(res, body?.passphrase)) return;
    const entry = activeTable!.entries.find(e => e.employeeIdHash === hash);
    if (!entry) return errRes(res, 404, 'Employee not found');
    // A-109: an employee this tool saw enrolled may be pending again on the employer node, once the plan cancelled an
    // enrollment someone else made with the invite; the node's roster decides.
    let cancelledOnNode = false;
    if (entry.status === 'enrolled') {
      try {
        const onNode = await proxyToEmployer('GET', '/roster/' + encodeURIComponent(entry.employeeIdHash));
        cancelledOnNode = onNode.status === 200 && onNode.data?.status === 'pending';
      } catch { cancelledOnNode = false; }
    }
    if ((entry.status === 'enrolled' && !cancelledOnNode) || entry.status === 'terminated') {
      return errRes(res, 409, `This employee is ${entry.status}; a new invite is for an employee who has not enrolled`);
    }
    const asked = body?.validUntil;
    const askedProblem = asked === undefined || asked === null || asked === '' ? null : inviteExpiryProblem(asked);
    if (askedProblem) return errRes(res, 400, askedProblem);
    const issued = await issueInvite(entry, askedProblem === null && asked ? compactInviteDate(asked)! : latestInviteExpiry(), 'replacedPin');
    if (!issued.ok) return errRes(res, issued.status, issued.error);
    saveTable();
    auditLog('invite:reissue', `employeeIdHash=${hash.slice(0, 12)}`);
    return ok(res, { tokenId: issued.tokenId, tokenIdHash: issued.tokenIdHash, pinSentTo: issued.pinSentTo, validUntil: entry.validUntil });
  }

  // ── Change an employee's mobile number (A-109)
  // The old number is told first, naming only the new number's last four digits, so a number changed behind the
  // employee's back does not go unnoticed; an invite not yet used goes again to the new number, since its PIN went to
  // the old one. Passphrase again; the audit line names the hash. (The HR Tool sends no email: codes go out by HR's
  // export or print, so an email address is not a channel to alert.)
  if (path.startsWith('/api/employees/') && path.endsWith('/contact') && method === 'POST') {
    if (!requireGroup(res)) return;
    const hash = decodeURIComponent(path.slice('/api/employees/'.length, -'/contact'.length));
    if (!hash || hash.includes('/')) return errRes(res, 400, 'Invalid employee identifier');
    const body = await readBody(req);
    if (!reauth(res, body?.passphrase)) return;
    const entry = activeTable!.entries.find(e => e.employeeIdHash === hash);
    if (!entry) return errRes(res, 404, 'Employee not found');
    const mobile = normalizeMobile(body?.mobile);
    if (!mobile) return errRes(res, 400, 'A mobile number is 8 to 15 digits, with an optional leading +');
    if (!TEXT_SERVICE) return errRes(res, 503, NO_TEXT_SERVICE);
    const old = entry.mobile ? normalizeMobile(entry.mobile) : null;
    if (old === mobile) return ok(res, { mobile: maskMobile(mobile), reissued: false });
    if (old) {
      try {
        await TEXT_SERVICE.send({ to: old, body: TEXTS.mobileChanged(maskMobile(mobile)) });
      } catch (e: any) {
        return errRes(res, 502, `The old number could not be told of the change (${e?.message || 'the text service failed'}); nothing was changed`);
      }
    }
    entry.mobile = mobile;
    saveTable();
    auditLog('contact:change', `employeeIdHash=${hash.slice(0, 12)}`);
    if (entry.status !== 'token_generated') return ok(res, { mobile: maskMobile(mobile), reissued: false });
    const issued = await issueInvite(entry, latestInviteExpiry(), 'pin');
    if (!issued.ok) return ok(res, { mobile: maskMobile(mobile), reissued: false, reissueError: issued.error });
    saveTable();
    auditLog('invite:reissue', `employeeIdHash=${hash.slice(0, 12)}`);
    return ok(res, { mobile: maskMobile(mobile), reissued: true, tokenId: issued.tokenId, pinSentTo: issued.pinSentTo });
  }

  // ── The notices, now (A-109): what the timer does every NOTICE_INTERVAL_MS while the HR Tool is unlocked
  if (path === '/api/notices' && method === 'POST') {
    if (!requireGroup(res)) return;
    if (!TEXT_SERVICE) return errRes(res, 503, NO_TEXT_SERVICE);
    try {
      return ok(res, { sent: await runNotices() });
    } catch (e: any) {
      return errRes(res, 502, `Could not read the employer node's roster: ${e?.message || 'unreachable'}`);
    }
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
        validUntil: e.validUntil || '',
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
  // A-82: the request must name this tool in its Host, or a page rebound to loopback could drive the open workspace.
  if (!requestHostAllowed(req, HOST_POLICY)) return errRes(res, 421, MISDIRECTED_REQUEST);

  const method = req.method || 'GET';
  const rawUrl = req.url || '/';
  const urlPath = rawUrl.split('?')[0];

  // No CORS headers — same-origin only (dashboard served from same port)
  // Security headers
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' https://fonts.googleapis.com 'unsafe-inline'; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; script-src 'self'");

  if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // A-82: every write declares JSON, which this tool's page always sends. A form or text/plain post, or a bodyless
  // one with no type, is what another site's page can send without asking first, to an unlocked workspace.
  if (!bodyTypeAccepted(req)) return errRes(res, 415, UNSUPPORTED_BODY_TYPE);

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
// A-109: the notices, while unlocked; locked, there is no number to text
if (NOTICE_INTERVAL_MS > 0) setInterval(() => { runNotices().catch(() => { /* tried again next time */ }); }, NOTICE_INTERVAL_MS);

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
  // A-109: where each enrollment PIN goes; with no service the HR Tool issues no invite
  console.log(TEXT_SERVICE
    ? `  Text service: ${TEXT_SERVICE.description}`
    : '  Text service: none. No invite can be issued until HR_TOOL_TEXT_SERVICE is set, since each PIN is texted to its employee.');
  console.log('');
});
