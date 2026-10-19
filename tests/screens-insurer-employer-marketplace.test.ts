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
 * The insurer, employer and marketplace screens (screen audit, screens items 1 to 10, and the insurer roster).
 *
 * What was wrong, by item:
 *  1. The insurer admin token input was type="text", so the token showed on camera.
 *  2. The insurer's "Review PDF" was a plain link to an admin-only route, which a link cannot authenticate: 401.
 *  3. The insurer's "Force Batch" can never succeed (the A9 role table gives the insurer no l2_forceBatch), and
 *     the sequencer's refusal came back as a 500. The button is gone and the route answers a plain 403.
 *  4. The employer dashboard read its admin-only roster and groups without its token: 401 everywhere.
 *  5. The employer roster still had a Wallet ID column (rows carry no wallet since B6) and read r.groupId, which
 *     rows do not carry; it shows the group hash.
 *  6. The marketplace's "Generate New Key" posted no activation secret, which the rekey route requires: 401.
 *  7. The marketplace showed "Under Review" with no way to upload the IRS letter the insurer needs to approve.
 *     The status route now says whether a letter is on file, and the screen asks for one until it is.
 *  8. The activation code was shown in alert(), which a recording cannot show; it is a card on the page now.
 *  9. The marketplace claimed to provision an HR Tool, which activation has not done since A7.
 * 10. SECURITY: the insurer node answered /roster, /receipts/all, /audit/log and /claims/member/:walletId to
 *     anyone, reading with the insurer's role key; they are admin-only, and the dashboard sends its token.
 * Roster: /roster read the sequencer's /viz/entities with a plain fetch, which D1 refuses, so every name and
 *     role came back empty; it reads with the node's signature now.
 *
 * The dashboards are plain browser scripts: their rpc.js clients run in a vm with a fake fetch, single functions
 * are lifted out of app.js and run with stubs, and the rest is read from source. The node routes run on real
 * NautilusAppServers on port 0 against stand-in sequencers, so nothing here reaches a live network.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import vm from 'vm';
import type { AddressInfo } from 'net';
import { NautilusAppServer } from '../src/nodes/nautilus-app-server.js';
import type { NautilusAppConfig, RouteRegistration } from '../src/nodes/nautilus-app-types.js';
import { buildInsurerRoutes } from '../src/nodes/routes/insurer-routes.js';
import { buildMarketplaceRoutes } from '../src/nodes/routes/marketplace-routes.js';
import { InsurerNode } from '../src/nodes/insurer-node.js';
import { generateNodeKey } from '../src/security/node-roles.js';
import { verifySignedRequest } from '../src/security/signed-request.js';

jest.setTimeout(60_000);

const NL = '\n';
const read = (file: string): string => fs.readFileSync(file, 'utf8').replace(/\r\n/g, NL);
const MARKETPLACE = read('dashboard-marketplace/app.js');
const TOKEN = 'insurer-token';
const upstreams: http.Server[] = [];
const dirs: string[] = [];

afterAll(async () => {
  for (const u of upstreams) await new Promise<void>((resolve) => u.close(() => resolve()));
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

type Call = { url: string; init?: { headers?: Record<string, string> } };

/** Load a dashboard rpc.js with a stored admin token and a fake fetch; return its API and the calls it made. */
function loadRpc(file: string, token: string): { API: any; calls: Call[] } {
  const calls: Call[] = [];
  const ctx: Record<string, unknown> = {
    location: { origin: 'http://node.test' },
    localStorage: { getItem: () => token, setItem() {}, removeItem() {} },
    fetch: async (url: string, init?: Call['init']) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true, data: [] }),
        json: async () => ({ ok: true, data: [] }),
        arrayBuffer: async () => new TextEncoder().encode('%PDF-1.4\n%%EOF\n').buffer,
      };
    },
    Blob,
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(file, 'utf8') + '\n;globalThis.__API = API;', ctx);
  return { API: ctx.__API, calls };
}
const bearer = (c: Call) => c.init?.headers?.Authorization;

/** A top-level function of an IIFE dashboard: from its declaration to the first line that is exactly "  }". */
function lift(src: string, name: string): string {
  let at = src.indexOf(NL + '  function ' + name + '(');
  if (at < 0) at = src.indexOf(NL + '  async function ' + name + '(');
  if (at < 0) throw new Error('no function ' + name);
  const end = src.indexOf(NL + '  }' + NL, at);
  return src.slice(at + 1, end + 4);
}

/** The lines from the one containing `marker` through the first later line that is exactly `endLine`. */
function cut(src: string, marker: string, endLine: string): string {
  const lines = src.split(NL);
  const from = lines.findIndex((l) => l.includes(marker));
  if (from < 0) throw new Error('not found: ' + marker);
  const to = lines.findIndex((l, i) => i > from && l === endLine);
  if (to < 0) throw new Error('no end after: ' + marker);
  return lines.slice(from, to + 1).join(NL);
}

/** Runs pieces of page code in strict mode with `scope` as their free variables and returns the value of `ret`. */
function run(pieces: string[], scope: Record<string, unknown>, ret: string): any {
  const names = Object.keys(scope);
  return new Function(...names, `'use strict';\n${pieces.join(NL)}\nreturn ${ret};`)(...names.map((n) => scope[n]));
}

type Seen = { method: string; path: string; headers: http.IncomingHttpHeaders; body: string };

/** A stand-in HTTP service that records each request and answers it with `answer(request)`. */
async function service(answer: (req: Seen) => { status: number; body: unknown }): Promise<{ url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const r: Seen = { method: req.method ?? '', path: new URL(req.url ?? '/', 'http://x').pathname, headers: req.headers, body };
      seen.push(r);
      const a = answer(r);
      res.writeHead(a.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(a.body));
    });
  });
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()));
  upstreams.push(srv);
  return { url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, seen };
}

/** An insurer-side node on a random port with the given routes; by default its sequencer is a dead port. */
async function appServer(
  build: (s: NautilusAppServer) => RouteRegistration[],
  opts: { sequencerUrl?: string; nodeKey?: { nodeId: string; seedHex: string }; node?: unknown } = {},
): Promise<{ url: string; stop: () => Promise<void> }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'screens-ins-'));
  dirs.push(dir);
  const server = new NautilusAppServer({
    role: 'insurer', port: 0, host: '127.0.0.1', sequencerUrl: opts.sequencerUrl ?? 'http://127.0.0.1:1', stateDir: dir,
    enableSSE: false, maxSseConnections: 0, allowedOrigins: [], adminToken: TOKEN,
    ...(opts.nodeKey ? { nodeKey: opts.nodeKey } : {}),
  } as NautilusAppConfig);
  server.registerRoutes(build(server));
  if (opts.node) server.setEntityNode(opts.node as never);
  await server.start();
  return { url: `http://127.0.0.1:${server.getPort()}`, stop: () => server.stop() };
}

test('1. the insurer admin token input is a password field', () => {
  const html = read('dashboard-insurer/index.html');
  const tag = html.match(/<input[^>]*id="admin-token-input"[^>]*>/)?.[0] ?? '';
  expect(tag).not.toBe('');
  expect(tag).toMatch(/type="password"/);
});

test('2. Review PDF fetches the document with the token and opens it as a PDF blob', async () => {
  const { API, calls } = loadRpc('dashboard-insurer/rpc.js', TOKEN);
  const blob = await API.getEmployerDocument('EMPAPP-1');
  expect(calls[0].url).toBe('http://node.test/marketplace/api/document/EMPAPP-1');
  expect(bearer(calls[0])).toBe(`Bearer ${TOKEN}`);
  expect(blob.type).toBe('application/pdf');
  expect(Buffer.from(await blob.arrayBuffer()).toString('latin1').startsWith('%PDF')).toBe(true);
  const app = read('dashboard-insurer/app.js');
  expect(app).not.toContain('href="/marketplace/api/document/');
  expect(app).toContain('App.reviewDoc(');
  expect(app).toContain('reviewDoc: reviewDoc');
});

test('3. Force Batch is off the insurer screen, and a role the sequencer refuses gets a 403, not a 500', async () => {
  expect(read('dashboard-insurer/index.html')).not.toContain('id="admin-force-batch"');
  // The sequencer answers a refusal as a JSON-RPC error with HTTP 200, and L2Client turns it into "RPC error <code>: ...".
  let code = -32004;
  const seq = await service(() => ({ status: 200, body: { jsonrpc: '2.0', id: 1, error: { code, message: 'Forbidden: role insurer may not call l2_forceBatch' } } }));
  const ins = await appServer(buildInsurerRoutes, { node: new InsurerNode({ role: 'insurer', sequencerUrl: seq.url }) });
  try {
    const refused = await fetch(ins.url + '/admin/batch/force', { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: string }).error).toMatch(/only the network operator/);
    expect(JSON.parse(seq.seen[0].body).method).toBe('l2_forceBatch');
    code = -32603; // any other failure is still an error of this node's
    expect((await fetch(ins.url + '/admin/batch/force', { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` } })).status).toBe(500);
  } finally {
    await ins.stop();
  }
});

test('4. the employer dashboard sends its token on the admin-only roster and group reads', async () => {
  const { API, calls } = loadRpc('dashboard-employer/rpc.js', 'tenant-token');
  await API.listRoster();
  await API.getRosterEntry('e1');
  await API.listGroups();
  await API.getGroup('G1');
  expect(calls.map((c) => c.url)).toEqual(['/roster', '/roster/e1', '/groups', '/groups/G1'].map((p) => 'http://node.test' + p));
  expect(calls.map(bearer)).toEqual(Array(4).fill('Bearer tenant-token'));
});

test('5. the employer roster has no wallet column (B6) and shows the group hash the rows carry', () => {
  const src = read('dashboard-employer/app.js');
  const start = src.indexOf('async function loadRosterTable()');
  const fn = src.slice(start, src.indexOf('async function doTerminateRoster(', start));
  expect(fn.length).toBeGreaterThan(100);
  expect(fn).not.toMatch(/wallet/i);
  expect(fn).toContain('r.groupIdHash');
  expect(fn).not.toMatch(/r\.groupId\b(?!Hash)/);
});

describe('6. Generate New Key sends the activation secret to the rekey route', () => {
  /** The real Generate New Key handler, lifted out of the Agreement screen, with the page around it stubbed. */
  async function regenerate(opts: { claimSecret: string; typed?: string | null; refuse?: boolean }) {
    const posted: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
    const toasts: Array<[string, string]> = [];
    let persisted = 0;
    const page = run([cut(MARKETPLACE, 'if (regenBtn) regenBtn.onclick = async function()', '    };')], {
      regenBtn: {}, applicationId: 'EMPAPP-1', claimSecret: opts.claimSecret, keypair: null,
      prompt: () => opts.typed ?? null,
      regenerateKeypair: async () => ({ publicKeyHex: 'b'.repeat(64) }),
      api: async (method: string, p: string, body: Record<string, unknown>) => {
        posted.push({ method, path: p, body });
        if (opts.refuse) throw new Error('Invalid activation code');
        return {};
      },
      persistState: () => { persisted++; },
      toast: (m: string, t: string) => { toasts.push([m, t]); },
      renderSign: () => undefined,
    }, '{ click: regenBtn.onclick, state: function () { return { claimSecret: claimSecret, keypair: keypair }; } }');
    await page.click();
    return { posted, toasts, persisted, state: page.state() };
  }

  test('the secret this tab holds goes with the new public key', async () => {
    const r = await regenerate({ claimSecret: 'secret-in-this-tab' });
    expect(r.posted).toEqual([{ method: 'POST', path: '/employer-applications/EMPAPP-1/rekey', body: { publicKeyHex: 'b'.repeat(64), claimSecret: 'secret-in-this-tab' } }]);
    expect(r.toasts).toEqual([[expect.stringMatching(/registered/), 'success']]);
  });

  test('a closed tab asks for the code, sends the part after the dot, and keeps it once it worked', async () => {
    const r = await regenerate({ claimSecret: '', typed: '  EMPAPP-1.secret-typed-in  ' });
    expect(r.posted[0]?.body).toEqual({ publicKeyHex: 'b'.repeat(64), claimSecret: 'secret-typed-in' });
    expect(r.state.claimSecret).toBe('secret-typed-in');
    expect(r.persisted).toBe(1);
  });

  test('no code, or a code the server refuses, registers nothing and leaves no unaccepted key to sign with', async () => {
    const none = await regenerate({ claimSecret: '', typed: null });
    expect(none.posted).toEqual([]);
    expect(none.toasts).toEqual([[expect.stringMatching(/activation code is required/), 'error']]);
    const refused = await regenerate({ claimSecret: 'stale-secret', refuse: true });
    expect(refused.posted).toHaveLength(1);
    expect(refused.state.keypair).toBeNull();
    expect(refused.toasts).toEqual([[expect.stringMatching(/not registered.*Invalid activation code/), 'error']]);
  });
});

describe('7. the employer is asked for the IRS letter from submission until one is on file', () => {
  /** The real Agreement screen (renderSign) for an application the status route describes as `status`. */
  async function agreementScreen(status: Record<string, unknown>): Promise<string> {
    const els: Record<string, any> = {};
    const document = { getElementById: (id: string) => (els[id] = els[id] ?? { id, innerHTML: '', textContent: '', value: '' }) };
    const renderSign = run([lift(MARKETPLACE, 'renderSign')], {
      document, app: { innerHTML: '' }, applicationId: 'EMPAPP-1', applicationStatus: '',
      stepBar: () => '', loading: () => '', activationCodeCard: () => '', wireActivationCodeCard: () => undefined,
      api: async () => status, persistState: () => undefined, esc: String, toast: () => undefined, errMsg: String,
    }, 'renderSign');
    await renderSign();
    return String(els['sign-content']?.innerHTML ?? '');
  }
  const UPLOAD = 'Please Upload Your IRS CP 575 Letter';
  const REVIEW = 'Application Under Review';

  test('the screen offers the upload at submitted and under review until a letter is on file, then says under review', async () => {
    expect(await agreementScreen({ status: 'submitted', companyName: 'Fernhill', documentUploaded: false })).toContain(UPLOAD);
    expect(await agreementScreen({ status: 'under_review', companyName: 'Fernhill', documentUploaded: false })).toContain(UPLOAD);
    expect(await agreementScreen({ status: 'needs_documents', companyName: 'Fernhill', documentUploaded: true })).toContain(UPLOAD);
    const review = await agreementScreen({ status: 'submitted', companyName: 'Fernhill', documentUploaded: true });
    expect(review).toContain(REVIEW);
    expect(review).not.toContain(UPLOAD);
  });

  test('the status route says whether the letter is on file: false after applying, true after an upload at submitted', async () => {
    // The apply route checks the employer ID against the sequencer and fails closed without one: this one knows no employer.
    const seq = await service(() => ({ status: 200, body: { jsonrpc: '2.0', id: 1, result: null } }));
    const mkt = await appServer(buildMarketplaceRoutes, { sequencerUrl: seq.url });
    try {
      const applied = await fetch(mkt.url + '/marketplace/api/apply', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          companyName: 'Fernhill Test Works LLC', employerId: `FERNHILL-DOC-${Date.now()}`, contactName: 'Jordan Testcase',
          contactEmail: 'hr@fernhill.example.test', ein: '00-0000003', state: 'WI', selectedPlanIds: ['PLAN-TEST-1'],
          effectiveDate: '2027-01-01', enrollmentCap: 10, publicKeyHex: 'a'.repeat(64),
        }),
      });
      expect(applied.status).toBe(201);
      const id = ((await applied.json()) as { data: { applicationId: string } }).data.applicationId;
      const status = async () => ((await (await fetch(`${mkt.url}/marketplace/api/status/${id}`)).json()) as { data: Record<string, unknown> }).data;
      expect(await status()).toMatchObject({ status: 'submitted', documentUploaded: false });
      const upload = await fetch(`${mkt.url}/marketplace/api/upload-document/${id}`, {
        method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: '%PDF-1.4\n%%EOF\n',
      });
      expect(upload.status).toBe(200);
      expect(await status()).toMatchObject({ status: 'submitted', documentUploaded: true });
    } finally {
      await mkt.stop();
    }
  });
});

test('8. the activation code is shown on the page, not in alert(), and is not stored', () => {
  const esc = (s: unknown) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const card = (code: string): string => run([lift(MARKETPLACE, 'activationCodeCard')], { pendingActivationCode: code, esc }, 'activationCodeCard()');
  const html = card('EMPAPP-1.s3cret-half');
  expect(html).toMatch(/<code id="activation-code"[^>]*>EMPAPP-1\.s3cret-half<\/code>/);
  expect(html).toContain('id="btn-code-saved"');
  expect(card('')).toBe('');
  // No alert() call is left. (The comment that says the code used to be shown in one does not count.)
  const code = MARKETPLACE.replace(/\/\*[\s\S]*?\*\//g, '').split(NL).filter((l) => !l.trim().startsWith('//')).join(NL);
  expect(code).not.toMatch(/\balert\(/);
  expect(MARKETPLACE).toContain('pendingActivationCode = code;');
  expect(MARKETPLACE).not.toMatch(/Storage\.setItem\([^)]*pendingActivationCode/);
});

test('9. the marketplace does not claim to provision an HR Tool (A7)', () => {
  expect(MARKETPLACE).not.toContain('employer node and HR Tool');
  expect(MARKETPLACE).not.toContain('Click <strong>Open HR Tool</strong>');
});

describe('10. the insurer node answers member data only to its own admin', () => {
  let ins: { url: string; stop: () => Promise<void> };
  beforeAll(async () => { ins = await appServer(buildInsurerRoutes); });
  afterAll(async () => { await ins.stop(); });

  test.each(['/claims/member/123456789', '/receipts/all', '/audit/log', '/roster'])('%s refuses a bare caller and admits the token', async (p) => {
    expect((await fetch(ins.url + p)).status).toBe(401);
    expect((await fetch(ins.url + p, { headers: { Authorization: 'Bearer not-the-token' } })).status).toBe(401);
    // No entity node here, so a request past the gate gets 503 and nothing reaches a sequencer.
    expect((await fetch(ins.url + p, { headers: { Authorization: `Bearer ${TOKEN}` } })).status).toBe(503);
  });

  test('the insurer dashboard sends its token on those four reads', async () => {
    const { API, calls } = loadRpc('dashboard-insurer/rpc.js', TOKEN);
    await API.getReceipts();
    await API.getAuditLog();
    await API.getMemberClaims('123');
    await API.getRoster();
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(['/receipts/all', '/audit/log', '/claims/member/123', '/roster']);
    expect(calls.map(bearer)).toEqual(Array(4).fill(`Bearer ${TOKEN}`));
  });
});

test('the insurer roster reads names and roles from /viz/entities with the node\'s signature, which D1 requires', async () => {
  const key = generateNodeKey('insurer-node');
  const reads: string[] = [];
  const seq = await service((req) => {
    if (req.path !== '/viz/entities') return { status: 404, body: {} };
    const verdict = verifySignedRequest({ method: 'GET', path: '/viz/entities', headers: req.headers, expectedSignerId: key.nodeId, publicKeyHex: key.publicKeyHex });
    reads.push(verdict.ok ? 'signed by the insurer node' : verdict.reason);
    return verdict.ok
      ? { status: 200, body: [{ walletId: '1001', type: 'member', displayName: 'Avery Q.' }] }
      : { status: 401, body: { error: 'Unauthorized' } };
  });
  // Only what /roster touches: the registration receipts. The route reads entities from the configured sequencer.
  const node = {
    setWalletSignerSource() {},
    getAllReceipts: async () => [{ isRegistration: true, walletId: '1001', acceptedAt: 1, receiptId: 'r-1' }],
  };
  const ins = await appServer(buildInsurerRoutes, { sequencerUrl: seq.url, nodeKey: { nodeId: key.nodeId, seedHex: key.seedHex }, node });
  try {
    const r = await fetch(ins.url + '/roster', { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(r.status).toBe(200);
    expect(reads).toEqual(['signed by the insurer node']); // before: 'the request is not signed', and every name was blank
    expect(((await r.json()) as { data: { entries: unknown[] } }).data.entries).toEqual([
      expect.objectContaining({ walletId: '1001', role: 'member', displayName: 'Avery Q.' }),
    ]);
  } finally {
    await ins.stop();
  }
});
