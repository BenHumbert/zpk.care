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
 * The HR Tool on the employer's machine — the acceptance test for phase A item A7, findings A-21,
 * PHI-4, CONT-3 and the other half of AUTH-13.
 *
 * What was wrong. The insurer's orchestrator spawned the HR Tool on the insurer's own host, with the
 * employer node URL and the tenant admin token in its environment, so the plaintext correlation
 * table (names, birth dates, employee IDs, enrollment PINs) lived with the insurer (I5). A workspace
 * was created by the first unlock with any 8-character passphrase and no confirmation; there was no
 * attempt limit; the PIN was listed by `/api/employees` and exported by `/api/export/tokens`, so an
 * HR insider held both factors indefinitely; and the plaintext audit log recorded employee IDs and
 * search terms.
 *
 * This drives the real server binary, started the way an employer would start it, against a stub
 * employer node that records what it is sent.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import net from 'net';
import { spawn, type ChildProcess } from 'child_process';
import { verifySignedRequest } from '../src/security/signed-request.js';

const REPO = path.resolve(__dirname, '..');
const PASS = 'correct-horse-battery-staple-12';
const TOKEN = 'tenant-admin-token-0123456789abcdef';

interface Seen { method: string; path: string; auth: string | undefined; sig: string | undefined; body: string }
const seen: Seen[] = [];
/** Client keys the stub employer node has registered (A9), as the real one keeps them: in memory. */
const registeredKeys = new Map<string, string>();
let employerStub: http.Server;
let employerUrl: string;
let hrTool: ChildProcess | null = null;
let hrUrl: string;
let dataDir: string;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const a = s.address(); const p = typeof a === 'object' && a ? a.port : 0; s.close(() => resolve(p)); });
  });
}
function send(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}
async function api(method: string, p: string, body?: unknown): Promise<{ status: number; json: any; headers: Headers }> {
  const r = await fetch(hrUrl + p, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  let json: any = null;
  try { json = await r.json(); } catch { json = null; }
  return { status: r.status, json, headers: r.headers };
}
const data = (r: { json: any }) => (r.json && 'data' in r.json ? r.json.data : r.json);

beforeAll(async () => {
  // A stub employer node: enough of the real routes for a group select and an import, recording
  // every request so the test can see which credential the HR Tool presented.
  employerStub = http.createServer((req, res) => {
    let text = '';
    req.on('data', (c) => { text += c; });
    req.on('end', () => {
      const url = req.url ?? '/';
      const sig = req.headers['x-admin-signature'] as string | undefined;
      seen.push({ method: req.method ?? '', path: url, auth: req.headers.authorization, sig, body: text });
      const bearerOk = req.headers.authorization === `Bearer ${TOKEN}`;
      // A9: like the real employer node, the stub takes the bearer or a signature from a key it registered.
      if (req.method === 'POST' && url === '/admin/client-keys') {
        if (!bearerOk) return send(res, 401, { ok: false, error: 'Unauthorized' });
        const b = JSON.parse(text || '{}');
        registeredKeys.set(b.clientId, b.publicKeyHex);
        return send(res, 201, { ok: true, data: { clientId: b.clientId, registered: true } });
      }
      const signerId = sig?.split(':')[0];
      const signedOk = !!signerId && registeredKeys.has(signerId)
        && verifySignedRequest({ method: req.method ?? 'GET', path: url.split('?')[0], headers: req.headers, expectedSignerId: signerId, publicKeyHex: registeredKeys.get(signerId)!, body: text }).ok;
      if (!bearerOk && !signedOk) return send(res, 401, { ok: false, error: 'Unauthorized' });
      if (req.method === 'GET' && url === '/groups/G1') return send(res, 200, { ok: true, data: { groupId: 'G1', planId: 'PLAN-1', status: 'active', enrollmentCap: 0 } });
      if (req.method === 'GET' && url === '/groups/G1/stats') return send(res, 200, { ok: true, data: { isUnlimited: true, remainingSlots: 999, enrollmentCap: 0, enrolledCount: 0, pendingTokens: 0 } });
      if (req.method === 'POST' && url === '/tokens/generate') {
        const n = seen.filter((s) => s.path === '/tokens/generate').length;
        return send(res, 201, { ok: true, data: { tokenId: `ABCD-0000-0000-0000-000${n}`, tokenIdHash: String(1000 + n) } });
      }
      if (req.method === 'POST' && /^\/tokens\/[^/]+\/set-pin-hash$/.test(url)) return send(res, 200, { ok: true, data: { pinHashSet: true } });
      if (req.method === 'GET' && url === '/health') return send(res, 200, { ok: true, data: { phase: 'ready' } });
      return send(res, 404, { ok: false, error: 'not stubbed: ' + url });
    });
  });
  await new Promise<void>((resolve) => employerStub.listen(0, '127.0.0.1', () => resolve()));
  const addr = employerStub.address();
  employerUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hr-lockdown-'));
  const port = await freePort();
  hrUrl = `http://127.0.0.1:${port}`;
  hrTool = spawn(process.execPath, ['--import', 'tsx', path.join(REPO, 'src', 'tools', 'hr-tool-server.ts')], {
    cwd: REPO,
    env: { ...process.env, PORT: String(port), HR_TOOL_DATA_DIR: dataDir, EMPLOYER_NODE_URL: 'http://127.0.0.1:1', EMPLOYER_ADMIN_TOKEN: 'must-be-ignored' },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  hrTool.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
  const deadline = Date.now() + 60_000;
  for (;;) {
    try { const r = await fetch(hrUrl + '/api/session'); if (r.ok) break; } catch { /* not yet */ }
    if (Date.now() > deadline) throw new Error('HR Tool did not start: ' + stderr);
    await new Promise((r) => setTimeout(r, 300));
  }
}, 90_000);

afterAll(async () => {
  if (hrTool && !hrTool.killed) { try { hrTool.kill(); } catch { /* best effort */ } }
  await new Promise<void>((resolve) => employerStub.close(() => resolve()));
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('a workspace is set up once, on this machine, from the activation handover', () => {
  test('before setup, unlock says so and reveals nothing', async () => {
    const r = await api('POST', '/api/unlock', { passphrase: PASS });
    expect(r.status).toBe(409);
    expect(r.json.error).toMatch(/Set one up first/);
    const w = data(await api('GET', '/api/workspaces'));
    expect(w.needsSetup).toBe(true);
    expect(w.defaultEmployerNodeUrl).toBe('http://127.0.0.1:1');
  });

  test('the passphrase policy: length and confirmation', async () => {
    const short = await api('POST', '/api/setup', { employerNodeUrl: employerUrl, adminToken: TOKEN, passphrase: 'tooshort', passphraseConfirm: 'tooshort' });
    expect(short.status).toBe(400);
    expect(short.json.error).toMatch(/at least 12/);
    const mismatch = await api('POST', '/api/setup', { employerNodeUrl: employerUrl, adminToken: TOKEN, passphrase: PASS, passphraseConfirm: PASS + 'x' });
    expect(mismatch.status).toBe(400);
    expect(mismatch.json.error).toMatch(/confirmation/);
    const noToken = await api('POST', '/api/setup', { employerNodeUrl: employerUrl, adminToken: '', passphrase: PASS, passphraseConfirm: PASS });
    expect(noToken.status).toBe(400);
    const badUrl = await api('POST', '/api/setup', { employerNodeUrl: 'ftp://x', adminToken: TOKEN, passphrase: PASS, passphraseConfirm: PASS });
    expect(badUrl.status).toBe(400);
    expect(fs.readdirSync(dataDir).filter((n) => n.startsWith('workspace-'))).toHaveLength(0);
  });

  test('setup creates the workspace, stores the token encrypted, and the environment token is ignored', async () => {
    const r = await api('POST', '/api/setup', { employerNodeUrl: employerUrl, adminToken: TOKEN, passphrase: PASS, passphraseConfirm: PASS });
    expect(r.status).toBe(200);
    expect(data(r).workspace.firstRun).toBe(true);
    // A9: setup registered the workspace's client key with the token presented once; requests are signed from here on
    expect(data(r).authMode).toBe('ed25519');
    expect(seen.some((s) => s.path === '/admin/client-keys' && s.auth === `Bearer ${TOKEN}`)).toBe(true);
    expect(registeredKeys.size).toBe(1);
    const ws = fs.readdirSync(dataDir).filter((n) => n.startsWith('workspace-'));
    expect(ws).toHaveLength(1);
    const tokenFile = path.join(dataDir, ws[0], 'admin.token.enc');
    expect(fs.existsSync(tokenFile)).toBe(true);
    expect(fs.readFileSync(tokenFile).toString('utf8')).not.toContain(TOKEN);    // encrypted, not stored in clear
    const again = await api('POST', '/api/setup', { employerNodeUrl: employerUrl, adminToken: TOKEN, passphrase: PASS, passphraseConfirm: PASS });
    expect(again.status).toBe(409);
  });

  test('the workspace key registered with the stored token, not the environment token, is what reaches the employer node', async () => {
    seen.length = 0;
    const r = await api('POST', '/api/group/select', { groupId: 'G1' });
    expect(r.status).toBe(200);
    expect(seen.length).toBeGreaterThan(0);
    for (const s of seen) {
      expect(s.auth).toBeUndefined();
      expect(s.sig?.startsWith('hr-tool-')).toBe(true);
    }
  });
});

describe('unlocking is attempt-limited and never a wipe', () => {
  test('three wrong passphrases are refused plainly; the fourth is throttled with Retry-After', async () => {
    await api('POST', '/api/lock');
    for (let i = 0; i < 3; i++) {
      const r = await api('POST', '/api/unlock', { passphrase: 'wrong-passphrase-' + i });
      expect(r.status).toBe(403);
    }
    const fourth = await api('POST', '/api/unlock', { passphrase: 'wrong-passphrase-4' });
    expect(fourth.status).toBe(403);                       // counted; the delay starts now
    const fifth = await api('POST', '/api/unlock', { passphrase: PASS });
    expect(fifth.status).toBe(429);                        // even the right one must wait
    expect(fifth.headers.get('retry-after')).toMatch(/^\d+$/);
    expect(fs.existsSync(path.join(dataDir, 'attempts.json'))).toBe(true);
    expect(fs.readFileSync(path.join(dataDir, 'attempts.json'), 'utf8')).not.toContain(PASS);
    // The workspace is intact.
    expect(fs.readdirSync(dataDir).filter((n) => n.startsWith('workspace-'))).toHaveLength(1);
  }, 30_000);

  test('after the delay the right passphrase opens it, with the token on file', async () => {
    await new Promise((r) => setTimeout(r, 2_200));
    const r = await api('POST', '/api/unlock', { passphrase: PASS });
    expect(r.status).toBe(200);
    expect(data(r).adminTokenOnFile).toBe(true);
    expect(data(r).authMode).toBe('ed25519');
    expect(data(r).workspace.employerNodeUrl).toBe(employerUrl);
  }, 15_000);
});

describe('the second factor is shown once and never listed', () => {
  let pins: Record<string, string> = {};
  let hashes: Record<string, string> = {};

  test('import returns each PIN once, in the import result', async () => {
    await api('POST', '/api/group/select', { groupId: 'G1' });
    const csv = ['employee_id,family_id,first_name,last_name,dob,email', 'E-1,F-1,Avery,Lindqvist,19900101,a@example.test', 'E-2,F-2,Rowan,Ashgrove,19921103,'].join('\n');
    const r = await api('POST', '/api/import', { csvContent: csv, validUntil: '2027-12-31', dryRun: false });
    expect(r.status).toBe(200);
    const d = data(r);
    expect(d.success).toBe(2);
    expect(d.pinNotice).toMatch(/once/);
    for (const row of d.results as Array<{ employeeId: string; status: string; tokenId: string; tokenPIN: string }>) {
      expect(row.status).toBe('ok');
      expect(row.tokenPIN).toMatch(/^\d{8}$/);
      pins[row.employeeId] = row.tokenPIN;
    }
    expect(Object.keys(pins)).toHaveLength(2);
  });

  test('the employee list and lookup carry no PIN and no PIN hash', async () => {
    const list = data(await api('GET', '/api/employees'));
    expect(list.total).toBe(2);
    for (const e of list.entries) {
      expect(e.tokenPIN).toBeUndefined();
      expect(e.tokenPinHash).toBeUndefined();
      expect(e.tokenId).toBeDefined();
      hashes[e.employeeId] = e.employeeIdHash;
    }
    const one = data(await api('GET', '/api/employees/E-1'));
    expect(one.employeeId).toBe('E-1');
    expect(one.tokenPIN).toBeUndefined();
  });

  test('the export carries codes and no PINs', async () => {
    const exp = data(await api('GET', '/api/export/tokens'));
    expect(exp.tokens).toHaveLength(2);
    for (const t of exp.tokens) {
      expect(t.tokenId).toMatch(/^ABCD-/);
      expect(t.tokenPIN).toBeUndefined();
    }
  });

  test('a reveal needs the passphrase again, is counted, and returns the same PIN', async () => {
    const wrong = await api('POST', `/api/employees/${encodeURIComponent(hashes['E-1'])}/pin`, { passphrase: 'not-it-at-all' });
    expect(wrong.status).toBe(403);
    const none = await api('POST', `/api/employees/${encodeURIComponent(hashes['E-1'])}/pin`, {});
    expect(none.status).toBe(403);
    const right = await api('POST', `/api/employees/${encodeURIComponent(hashes['E-1'])}/pin`, { passphrase: PASS });
    expect(right.status).toBe(200);
    expect(data(right).tokenPIN).toBe(pins['E-1']);
    const unknown = await api('POST', '/api/employees/nope/pin', { passphrase: PASS });
    expect(unknown.status).toBe(404);
  });

  test('the audit log names hashes and events, never people or what was searched for', async () => {
    await api('GET', '/api/employees?search=Lindqvist');
    await api('GET', '/api/employees/E-2');
    const groupAudit = path.join(dataDir, fs.readdirSync(dataDir).find((n) => n.startsWith('workspace-'))!, 'groups', 'G1', 'audit.log');
    const log = fs.readFileSync(groupAudit, 'utf8');
    expect(log).toContain('pin:reveal');
    expect(log).toContain(`employeeIdHash=${hashes['E-1'].slice(0, 12)}`);
    expect(log).toContain('search=yes');
    expect(log).not.toContain('Lindqvist');
    expect(log).not.toContain('employeeId=E-');
    expect(log).not.toContain('E-2');
    expect(log).not.toMatch(/\b\d{8}\b/);                 // no PIN ever
  });
});

describe('what moved out of the insurer host, by construction', () => {
  test('the orchestrator no longer spawns the HR Tool, and ties the employer node to its own life', () => {
    const src = fs.readFileSync(path.join(REPO, 'src/nodes/employer-orchestrator.ts'), 'utf8');
    expect(src).not.toContain('hr-tool-server');
    expect(src).not.toContain('hrToolChild');
    expect(src).toContain('ZKTRIDENT_PARENT_PID');
    expect(src).toContain("spawn(process.execPath, ['--import', 'tsx', employerScript]");
    expect(src).not.toMatch(/ZKTRIDENT_UNSECURE: 'true'/);
    expect(src).toContain('hrToolSetupFor(');
  });

  test('the employer launcher watches its parent', () => {
    const src = fs.readFileSync(path.join(REPO, 'src/nodes/start-employer-nautilus.ts'), 'utf8');
    expect(src).toContain('watchParent(');
    expect(src).toContain('parentPidFromEnv(');
  });

  test('the employer node no longer answers group reads to anyone (AUTH-13, other half)', () => {
    const src = fs.readFileSync(path.join(REPO, 'src/nodes/routes/employer-routes.ts'), 'utf8');
    for (const p of ["'/groups'", "'/groups/:groupId'", "'/groups/:groupId/stats'"]) {
      // Comment lines may sit between the path and the flag.
      const re = new RegExp(`method: 'GET',\\s*\\n\\s*path: ${p},(?:\\s*\\n\\s*//[^\\n]*)*\\s*\\n\\s*adminOnly: true`);
      expect(src).toMatch(re);
    }
  });

  test('the HR Tool server reads no admin token from its environment', () => {
    const src = fs.readFileSync(path.join(REPO, 'src/tools/hr-tool-server.ts'), 'utf8');
    expect(src).not.toMatch(/process\.env\.EMPLOYER_ADMIN_TOKEN/);
  });
});
