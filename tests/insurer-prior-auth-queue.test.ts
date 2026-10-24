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
 * The insurer's prior-authorization queue (owner decision 2026-10-19).
 *
 * What was missing: a prescriber could start a prior-authorization request at the engine, and only the operator's
 * console could approve or deny it. The insurer node had no route to the engine's requests and its dashboard no screen
 * for them, so the plan could not decide on its own members' requests.
 *
 * Now the insurer node reads the engine's requests (GET /interactive/prior-auths) and sends its decisions to the
 * engine's approve-prior-auth and deny-prior-auth, signed with its own node key (the insurer role). Its routes are
 * GET /prior-auth/pending, GET /prior-auth/decisions, POST /prior-auth/:id/approve and POST /prior-auth/:id/deny, all
 * behind the node's admin credential; what reaches the screen is the request ID, the member by a cut of the wallet ID,
 * the drug and NDC, the quantity and its unit, the prescriber's display name, the dates and the reasons. The dashboard
 * has a Prior Auth tab with Approve, and Deny with a reason, that reads both lists again after each decision.
 *
 * The node runs on a real NautilusAppServer against a stand-in engine that verifies the node's signature on every call,
 * and, for the gate itself, against a real sequencer RPC server whose engine routes are stand-ins.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import vm from 'vm';
import type { AddressInfo } from 'net';
import { NautilusAppServer } from '../src/nodes/nautilus-app-server.js';
import type { NautilusAppConfig } from '../src/nodes/nautilus-app-types.js';
import { PROVING_BUDGET_MS } from '../src/nodes/nautilus-app-types.js';
import { buildInsurerRoutes } from '../src/nodes/routes/insurer-routes.js';
import { InsurerNode } from '../src/nodes/insurer-node.js';
import { generateNodeKey, roleMayCall } from '../src/security/node-roles.js';
import { verifySignedRequest } from '../src/security/signed-request.js';

jest.setTimeout(120_000);

const NL = '\n';
const read = (file: string): string => fs.readFileSync(file, 'utf8').replace(/\r\n/g, NL);
const TOKEN = 'insurer-admin-token-for-prior-auth';
const WALLET_A = '7900000000000000000000000000000000000000000000000000000000000000000000000001';
const WALLET_B = '7900000000000000000000000000000000000000000000000000000000000000000000000002';
const insurerKey = generateNodeKey('insurer-node');
const servers: Array<{ close: () => Promise<void> }> = [];
const dirs: string[] = [];

afterAll(async () => {
  for (const s of servers) await s.close();
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

/** The engine's requests as the engine answers its list: the PA state, with fields the insurer must not pass on. */
function engineRequests() {
  return [
    {
      id: 'PA-0002', status: 'PENDING', memberWalletId: WALLET_B, memberName: 'Riley Fixture', ndcHash: '222', ndc: '00093-7146-56',
      drugName: 'ADALIMUMAB-ADAZ', quantity: 0.4, pricingUnit: 'ML', prescriberName: 'Avery Quill, MD', requestedAt: 2_000, reason: 'Failed methotrexate', resolvedAt: null, decisionReason: null,
    },
    {
      id: 'PA-0001', status: 'PENDING', memberWalletId: WALLET_A, memberName: 'Jordan Fixture', ndcHash: '111', ndc: '00378-4105-91',
      drugName: 'ABACAVIR', quantity: 30, pricingUnit: 'EA', prescriberName: 'Avery Quill, MD', requestedAt: 1_000, reason: null, resolvedAt: null, decisionReason: null,
    },
    {
      id: 'PA-0000', status: 'DENIED', memberWalletId: WALLET_A, memberName: 'Jordan Fixture', ndcHash: '333', ndc: '59148-0008-13',
      drugName: 'ARIPIPRAZOLE', quantity: 30, pricingUnit: 'EA', prescriberName: 'Avery Quill, MD', requestedAt: 500, reason: null, resolvedAt: 900, decisionReason: 'Step therapy not documented',
    },
  ];
}

type Seen = { method: string; path: string; query: string; body: string; signed: boolean; signerOk: string };

/**
 * A stand-in engine: the three engine routes the insurer node calls, each answered only when the request carries the
 * insurer node's valid signature over the exact method, path and body (as the sequencer's gate verifies it).
 */
async function standInEngine(opts: { refuse?: number; noListRoute?: boolean; approveDelayMs?: number; approveAnswer?: { status: number; error: string } } = {}) {
  const seen: Seen[] = [];
  let requests = engineRequests();
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      const url = new URL(req.url ?? '/', 'http://engine.test');
      const verdict = verifySignedRequest({
        method: req.method ?? 'GET', path: url.pathname, headers: req.headers, expectedSignerId: insurerKey.nodeId,
        publicKeyHex: insurerKey.publicKeyHex, body,
      });
      seen.push({ method: req.method ?? '', path: url.pathname, query: url.search, body, signed: verdict.ok, signerOk: verdict.ok ? 'ok' : verdict.reason });
      const send = (status: number, payload: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)); };
      if (!verdict.ok) return send(401, { error: `Unauthorized — ${verdict.reason}` });
      if (opts.refuse) return send(opts.refuse, { error: 'Forbidden — role insurer may not call GET /interactive/prior-auths' });
      if (req.method === 'GET' && url.pathname === '/interactive/prior-auths' && !opts.noListRoute) {
        const status = url.searchParams.get('status');
        const list = requests.filter((p) => status === 'PENDING' ? p.status === 'PENDING' : status === 'RESOLVED' ? p.status !== 'PENDING' : true);
        return send(200, { priorAuths: list });
      }
      if (opts.approveAnswer && url.pathname === '/interactive/approve-prior-auth') return send(opts.approveAnswer.status, { error: opts.approveAnswer.error });
      if (req.method === 'POST' && (url.pathname === '/interactive/approve-prior-auth' || url.pathname === '/interactive/deny-prior-auth')) {
        const params = JSON.parse(body || '{}') as { priorAuthId?: string; reason?: string };
        const pa = requests.find((p) => p.id === params.priorAuthId);
        if (!pa) return send(500, { error: `Prior auth not found: ${params.priorAuthId}` });
        if (pa.status !== 'PENDING') return send(500, { error: `Prior auth is already ${pa.status}: ${pa.id}` });
        if (opts.approveDelayMs) await new Promise((r) => setTimeout(r, opts.approveDelayMs));
        const approve = url.pathname.endsWith('approve-prior-auth');
        requests = requests.map((p) => p.id === pa.id
          ? { ...p, status: approve ? 'APPROVED' : 'DENIED', resolvedAt: 5_000 + seen.length, decisionReason: approve ? null : (params.reason ?? null) }
          : p);
        // the engine's own answer names the member; the insurer node must not pass that on
        return send(200, approve
          ? { paId: pa.id, status: 'APPROVED', medication: { brandName: pa.drugName, ndc: pa.ndc }, member: { name: pa.memberName, walletId: pa.memberWalletId }, l2Receipt: { walletUpdate: { status: 'pending', updateId: 'u1' }, type: 'wallet-update' } }
          : { paId: pa.id, status: 'DENIED', medication: { brandName: pa.drugName }, member: { name: pa.memberName } });
      }
      return send(404, { error: 'Not found' });
    });
  });
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()));
  servers.push({ close: () => new Promise<void>((resolve) => srv.close(() => resolve())) });
  return { url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, seen };
}

/** The insurer node on a random port, keyed as start-leviathan keys it, talking to `sequencerUrl`. */
async function insurerNode(sequencerUrl: string): Promise<{ url: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-queue-'));
  dirs.push(dir);
  const server = new NautilusAppServer({
    role: 'insurer', port: 0, host: '127.0.0.1', sequencerUrl, stateDir: dir, enableSSE: false, maxSseConnections: 0,
    allowedOrigins: [], adminToken: TOKEN, nodeKey: { nodeId: insurerKey.nodeId, seedHex: insurerKey.seedHex },
  } as NautilusAppConfig);
  server.registerRoutes(buildInsurerRoutes(server));
  server.setEntityNode(new InsurerNode({ role: 'insurer', sequencerUrl, clientOptions: server.sequencerClientOptions() } as never));
  await server.start();
  servers.push({ close: () => server.stop() });
  return { url: `http://127.0.0.1:${server.getPort()}` };
}

const admin = { Authorization: `Bearer ${TOKEN}` };
async function call(base: string, method: string, p: string, body?: unknown, headers: Record<string, string> = admin) {
  const r = await fetch(base + p, {
    method, headers: { 'Content-Type': 'application/json', ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: r.status, json, text };
}

describe('the insurer node reads the engine\'s prior-authorization requests', () => {
  test('without the node\'s admin credential nothing is answered and the engine is not asked', async () => {
    const engine = await standInEngine();
    const ins = await insurerNode(engine.url);
    for (const [method, p, body] of [['GET', '/prior-auth/pending'], ['GET', '/prior-auth/decisions'], ['POST', '/prior-auth/PA-0001/approve', {}], ['POST', '/prior-auth/PA-0001/deny', { reason: 'x' }]] as const) {
      expect([p, (await call(ins.url, method, p, body, {})).status]).toEqual([p, 401]);   // before: 404, no such route
    }
    expect(engine.seen).toEqual([]);
  });

  test('the pending requests, oldest first, as the screen shows them: no member name and no full wallet ID', async () => {
    const engine = await standInEngine();
    const ins = await insurerNode(engine.url);
    const r = await call(ins.url, 'GET', '/prior-auth/pending');
    expect(r.status).toBe(200);
    expect(r.json.data.requests).toEqual([
      { id: 'PA-0001', status: 'PENDING', member: '79000000…0001', drugName: 'ABACAVIR', ndc: '00378-4105-91', quantity: 30, pricingUnit: 'EA', prescriberName: 'Avery Quill, MD', requestedAt: 1_000, reason: null, resolvedAt: null, decisionReason: null },
      { id: 'PA-0002', status: 'PENDING', member: '79000000…0002', drugName: 'ADALIMUMAB-ADAZ', ndc: '00093-7146-56', quantity: 0.4, pricingUnit: 'ML', prescriberName: 'Avery Quill, MD', requestedAt: 2_000, reason: 'Failed methotrexate', resolvedAt: null, decisionReason: null },
    ]);
    expect(r.text).not.toContain(WALLET_A);
    expect(r.text).not.toContain(WALLET_B);
    expect(r.text).not.toContain('Fixture');
    // one engine read, signed by the insurer node over the exact request
    expect(engine.seen).toEqual([expect.objectContaining({ method: 'GET', path: '/interactive/prior-auths', query: '?status=PENDING', signed: true })]);
  });

  test('the decisions, newest first, with the insurer\'s reason', async () => {
    const engine = await standInEngine();
    const ins = await insurerNode(engine.url);
    const r = await call(ins.url, 'GET', '/prior-auth/decisions');
    expect(r.status).toBe(200);
    expect(r.json.data.decisions).toEqual([expect.objectContaining({ id: 'PA-0000', status: 'DENIED', member: '79000000…0001', decisionReason: 'Step therapy not documented', resolvedAt: 900 })]);
    expect(engine.seen[0]).toMatchObject({ path: '/interactive/prior-auths', query: '?status=RESOLVED', signed: true });
  });

  test('an engine that refuses the node, or has no such read, is the node\'s 502 with the engine\'s words', async () => {
    const refusing = await insurerNode((await standInEngine({ refuse: 403 })).url);
    const refused = await call(refusing.url, 'GET', '/prior-auth/pending');
    expect(refused.status).toBe(502);
    expect(refused.json.error).toMatch(/refused this insurer node's credential.*role insurer may not call GET \/interactive\/prior-auths/);
    const without = await insurerNode((await standInEngine({ noListRoute: true })).url);
    const missing = await call(without.url, 'GET', '/prior-auth/pending');
    expect(missing.status).toBe(502);
    expect(missing.json.error).toMatch(/The engine has no route to read its prior-authorization requests/);
    const unreachable = await insurerNode('http://127.0.0.1:1');
    expect((await call(unreachable.url, 'GET', '/prior-auth/pending')).status).toBe(502);
  });
});

describe('the insurer decides, as itself', () => {
  test('approve: the engine\'s approve-prior-auth, signed by the node; the answer names the drug and the wallet update, not the member', async () => {
    const engine = await standInEngine();
    const ins = await insurerNode(engine.url);
    const r = await call(ins.url, 'POST', '/prior-auth/PA-0001/approve', {});
    expect(r.status).toBe(200);
    expect(r.json.data).toEqual({ id: 'PA-0001', status: 'APPROVED', drugName: 'ABACAVIR', walletUpdate: 'pending' });
    expect(r.text).not.toContain(WALLET_A);
    expect(r.text).not.toContain('Fixture');
    expect(engine.seen).toEqual([expect.objectContaining({ method: 'POST', path: '/interactive/approve-prior-auth', signed: true })]);
    expect(JSON.parse(engine.seen[0].body)).toEqual({ priorAuthId: 'PA-0001' });
    // it leaves the queue and is among the decisions
    expect((await call(ins.url, 'GET', '/prior-auth/pending')).json.data.requests.map((p: any) => p.id)).toEqual(['PA-0002']);
    expect((await call(ins.url, 'GET', '/prior-auth/decisions')).json.data.decisions.map((p: any) => [p.id, p.status])).toEqual([['PA-0001', 'APPROVED'], ['PA-0000', 'DENIED']]);
    // a second decision on it is the engine's conflict; an unknown request is a 404
    const again = await call(ins.url, 'POST', '/prior-auth/PA-0001/approve', {});
    expect([again.status, again.json.error]).toEqual([409, 'Prior auth is already APPROVED: PA-0001']);
    const unknown = await call(ins.url, 'POST', '/prior-auth/PA-0099/approve', {});
    expect([unknown.status, unknown.json.error]).toEqual([404, 'Prior auth not found: PA-0099']);
  });

  test('deny: the reason is required and goes to the engine with the request ID; the decision shows it', async () => {
    const engine = await standInEngine();
    const ins = await insurerNode(engine.url);
    for (const body of [{}, { reason: '   ' }, { reason: 7 }, { reason: 'x'.repeat(501) }]) {
      expect((await call(ins.url, 'POST', '/prior-auth/PA-0002/deny', body)).status).toBe(400);
    }
    expect(engine.seen).toEqual([]);
    const r = await call(ins.url, 'POST', '/prior-auth/PA-0002/deny', { reason: '  Formulary alternative available  ' });
    expect(r.status).toBe(200);
    expect(r.json.data).toEqual({ id: 'PA-0002', status: 'DENIED', drugName: 'ADALIMUMAB-ADAZ', reason: 'Formulary alternative available' });
    expect(engine.seen).toEqual([expect.objectContaining({ method: 'POST', path: '/interactive/deny-prior-auth', signed: true })]);
    expect(JSON.parse(engine.seen[0].body)).toEqual({ priorAuthId: 'PA-0002', reason: 'Formulary alternative available' });
    const decisions = (await call(ins.url, 'GET', '/prior-auth/decisions')).json.data.decisions;
    expect(decisions[0]).toMatchObject({ id: 'PA-0002', status: 'DENIED', decisionReason: 'Formulary alternative available' });
  });

  test('the engine\'s own refusals keep their status and words; the gate\'s refusal, a missing route and a failure are the node\'s 502', async () => {
    const cases: Array<[number, string, number]> = [
      [409, 'This request was decided already', 409],
      [404, 'No prior-authorization request PA-0001', 404],
      [403, 'The member is revoked: nothing can be authorized for them', 403],
      [400, 'priorAuthId must be a string', 400],
      [403, 'Forbidden — role insurer may not call POST /interactive/approve-prior-auth', 502],
      [401, 'Unauthorized — unknown signer', 502],
      [404, 'Not found', 502],
      [500, 'Programs not compiled yet', 502],
    ];
    for (const [status, error, want] of cases) {
      const ins = await insurerNode((await standInEngine({ approveAnswer: { status, error } })).url);
      const r = await call(ins.url, 'POST', '/prior-auth/PA-0001/approve', {});
      expect([status, error, r.status]).toEqual([status, error, want]);
      expect(r.json.error).toContain(error === 'Not found' ? 'The engine has no route to approve prior authorization PA-0001' : error);
    }
  });

  test('a request ID other than letters, digits, "-" and "_" is refused before the engine is asked', async () => {
    const engine = await standInEngine();
    const ins = await insurerNode(engine.url);
    for (const id of ['PA%200001', 'PA-0001%22', 'x'.repeat(65)]) {
      expect([id, (await call(ins.url, 'POST', `/prior-auth/${id}/approve`, {})).status]).toEqual([id, 400]);
    }
    expect(engine.seen).toEqual([]);
  });

  test('a second click while the first decision is being sent is refused, so the engine is asked once', async () => {
    const engine = await standInEngine({ approveDelayMs: 300 });
    const ins = await insurerNode(engine.url);
    const [a, b] = await Promise.all([
      call(ins.url, 'POST', '/prior-auth/PA-0001/approve', {}),
      new Promise((r) => setTimeout(r, 50)).then(() => call(ins.url, 'POST', '/prior-auth/PA-0001/approve', {})),
    ]);
    expect([a.status, b.status]).toEqual([200, 409]);
    expect(b.json.error).toMatch(/already being sent/);
    expect(engine.seen.filter((s) => s.path === '/interactive/approve-prior-auth')).toHaveLength(1);
  });

  test('approving proves at the engine, so its route carries the proving budget', () => {
    const fake = { getConfig: () => ({ sequencerUrl: 'http://127.0.0.1:1', stateDir: os.tmpdir() }) } as unknown as NautilusAppServer;
    const routes = buildInsurerRoutes(fake);
    const approve = routes.find((r) => r.method === 'POST' && r.path === '/prior-auth/:id/approve');
    expect(approve?.timeoutMs).toBe(PROVING_BUDGET_MS);
    expect(approve?.adminOnly).toBe(true);
  });
});

describe('through a real sequencer gate', () => {
  let rpcServer: any;
  let seqUrl: string;
  const engineCalls: string[] = [];

  beforeAll(async () => {
    const { Field, MerkleTree } = await import('o1js');
    const { InMemoryStore } = await import('../src/storage/local-store.js');
    const { WALLET_TREE_HEIGHT } = await import('../src/wallets/wallet-state.js');
    const { L2Node } = await import('../src/l2/l2-node.js');
    const { L2RpcServer } = await import('../src/l2/l2-rpc-server.js');
    const emptyRoot = new MerkleTree(WALLET_TREE_HEIGHT).getRoot();
    const node = new L2Node({ batchIntervalMs: 999_999, autoSettle: false, nodeId: 'seq-prior-auth' }, new InMemoryStore(), emptyRoot, emptyRoot, Field(0));
    rpcServer = new L2RpcServer(node, { port: 0, host: '127.0.0.1', adminToken: 'operator-token-prior-auth', enableSSE: false });
    rpcServer.registerNodeKey(insurerKey.nodeId, insurerKey.publicKeyHex, 'insurer');
    // the engine's routes, registered as registerInteractiveRoutes registers them: behind the admin gate
    const answer = (payload: unknown) => async (_req: http.IncomingMessage, res: http.ServerResponse) => {
      engineCalls.push(String(_req.url));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    rpcServer.registerRoute('GET', '/interactive/prior-auths', answer({ priorAuths: engineRequests() }), { adminOnly: true });
    rpcServer.registerRoute('POST', '/interactive/approve-prior-auth', answer({ paId: 'PA-0001', status: 'APPROVED', medication: { brandName: 'ABACAVIR' }, l2Receipt: { walletUpdate: { status: 'applied' } } }), { adminOnly: true });
    rpcServer.registerRoute('POST', '/interactive/deny-prior-auth', answer({ paId: 'PA-0002', status: 'DENIED', medication: { brandName: 'ADALIMUMAB-ADAZ' } }), { adminOnly: true });
    await rpcServer.start();
    seqUrl = `http://127.0.0.1:${rpcServer.getPort()}`;
  });
  afterAll(async () => { await rpcServer?.stop(); });

  test('the insurer role decides: approve and deny pass the gate signed by the insurer node', async () => {
    const ins = await insurerNode(seqUrl);
    const approved = await call(ins.url, 'POST', '/prior-auth/PA-0001/approve', {});
    expect([approved.status, approved.json.data]).toEqual([200, { id: 'PA-0001', status: 'APPROVED', drugName: 'ABACAVIR', walletUpdate: 'applied' }]);
    const denied = await call(ins.url, 'POST', '/prior-auth/PA-0002/deny', { reason: 'Formulary alternative available' });
    expect(denied.status).toBe(200);
    expect(engineCalls).toEqual(['/interactive/approve-prior-auth', '/interactive/deny-prior-auth']);
  });

  test('the queue read passes the gate once the insurer role may call GET /interactive/prior-auths (node-roles.ts), and is a 502 naming the gate until then', async () => {
    const ins = await insurerNode(seqUrl);
    const r = await call(ins.url, 'GET', '/prior-auth/pending');
    if (roleMayCall('insurer', { kind: 'route', method: 'GET', path: '/interactive/prior-auths' })) {
      expect(r.status).toBe(200);
      expect(r.json.data.requests.map((p: any) => p.id)).toEqual(['PA-0001', 'PA-0002']);
    } else {
      expect(r.status).toBe(502);
      expect(r.json.error).toMatch(/role insurer may not call GET \/interactive\/prior-auths/);
    }
  });
});

// ─── The dashboard ────────────────────────────────────────────────────────────────────────

const APP = read('dashboard-insurer/app.js');
const HTML = read('dashboard-insurer/index.html');

/** A top-level function of the dashboard's IIFE: from its declaration to the first line that is exactly "  }". */
function lift(src: string, name: string): string {
  let at = src.indexOf(NL + '  function ' + name + '(');
  if (at < 0) at = src.indexOf(NL + '  async function ' + name + '(');
  if (at < 0) throw new Error('no function ' + name);
  const end = src.indexOf(NL + '  }' + NL, at);
  return src.slice(at + 1, end + 4);
}
function run(pieces: string[], scope: Record<string, unknown>, ret: string): any {
  const names = Object.keys(scope);
  return new Function(...names, `'use strict';\n${pieces.join(NL)}\nreturn ${ret};`)(...names.map((n) => scope[n]));
}
const escHtml = (s: unknown): string => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const PAGE_FUNCTIONS = ['paIdOk', 'paQuantity', 'paLoadError', 'renderPendingPriorAuths', 'renderPriorAuthDecisions',
  'loadPendingPriorAuths', 'loadPriorAuthDecisions', 'loadPriorAuthPage', 'paRowBusy', 'approvePriorAuth', 'denyPriorAuth'];

/** The Prior Auth page's functions, run over element stubs and an API stand-in that answers from `lists`. */
function priorAuthPage(lists: { requests: unknown[]; decisions: unknown[] }, fail: Record<string, Error> = {}) {
  const els: Record<string, any> = {};
  const $ = (id: string) => (els[id] = els[id] ?? { id, value: '', innerHTML: '', textContent: '', disabled: false, focus() { this.focused = true; } });
  const asked: Array<[string, ...unknown[]]> = [];
  const toasts: Array<[string, string]> = [];
  const API = {
    getPendingPriorAuths: async () => { asked.push(['pending']); return { requests: lists.requests }; },
    getPriorAuthDecisions: async (limit: number) => { asked.push(['decisions', limit]); return { decisions: lists.decisions }; },
    approvePriorAuth: async (id: string) => { asked.push(['approve', id]); if (fail.approve) throw fail.approve; return { id, status: 'APPROVED', drugName: 'ABACAVIR', walletUpdate: 'pending' }; },
    denyPriorAuth: async (id: string, reason: string) => { asked.push(['deny', id, reason]); if (fail.deny) throw fail.deny; return { id, status: 'DENIED', reason }; },
  };
  const page = run(PAGE_FUNCTIONS.map((n) => lift(APP, n)), {
    $, esc: escHtml, fmtDate: (v: unknown) => (v ? `when:${v}` : '--'),
    toast: (m: string, t: string) => { toasts.push([m, t]); },
    showResult: (id: string, msg: string, ok: boolean) => { $(id).innerHTML = `${ok ? 'ok' : 'error'}:${msg}`; },
    API,
  }, '{ renderPendingPriorAuths, renderPriorAuthDecisions, loadPriorAuthPage, approvePriorAuth, denyPriorAuth, paLoadError }');
  return { page, $, asked, toasts };
}

const PENDING_VIEW = [
  { id: 'PA-0001', status: 'PENDING', member: '79000000…0001', drugName: 'ABACAVIR', ndc: '00378-4105-91', quantity: 30, pricingUnit: 'EA', prescriberName: 'Avery Quill, MD', requestedAt: 1000, reason: null },
  { id: 'PA-0002', status: 'PENDING', member: '79000000…0002', drugName: 'ADALIMUMAB-ADAZ', ndc: '00093-7146-56', quantity: 0.4, pricingUnit: 'ML', prescriberName: 'Avery Quill, MD', requestedAt: 2000, reason: 'Failed <b>methotrexate</b>' },
];

describe('the dashboard\'s Prior Auth tab', () => {
  test('the page has a Prior Auth tab, its lists, and the router opens it', () => {
    expect(HTML).toContain('<button class="nav-tab" data-tab="priorauth" role="tab">Prior Auth</button>');
    expect(HTML).toContain('<section class="page" id="page-priorauth">');
    for (const id of ['pa-pending-container', 'pa-decisions-container', 'pa-refresh-btn', 'pa-action-result']) expect([id, HTML.includes(`id="${id}"`)]).toEqual([id, true]);
    expect(APP).toContain("case 'priorauth': loadPriorAuthPage(); break;");
    expect(APP).toMatch(/approvePriorAuth: approvePriorAuth,\s*\n\s*denyPriorAuth: denyPriorAuth,/);
  });

  test('each pending request shows the cut wallet ID, the drug, the quantity with its unit, the prescriber, a reason box, Approve and Deny', async () => {
    const { page, $ } = priorAuthPage({ requests: PENDING_VIEW, decisions: [] });
    await page.loadPriorAuthPage();
    const html = String($('pa-pending-container').innerHTML);
    expect(html).toContain('79000000…0001');
    expect(html).toContain('ABACAVIR');
    expect(html).toContain('30 EA');
    expect(html).toContain('0.4 ML');
    expect(html).toContain('Avery Quill, MD');
    expect(html).toContain('id="pa-reason-PA-0002"');
    expect(html).toContain('data-act="approvePriorAuth" data-arg="PA-0001"');
    expect(html).toContain('data-act="denyPriorAuth" data-arg="PA-0002"');
    expect(html).not.toContain('onclick');                                // A-88: no ID rides inside an inline handler
    expect(html).toContain('Failed &lt;b&gt;methotrexate&lt;/b&gt;');     // the prescriber's words are text, not markup
    expect(String($('pa-decisions-container').innerHTML)).toContain('No decisions yet');
    // a request whose ID could break out of an attribute is not drawn
    expect(page.renderPendingPriorAuths([{ ...PENDING_VIEW[0], id: "x');alert(1);//" }])).not.toContain('alert');
  });

  test('Approve sends the decision, says what happens next, and reads both lists again', async () => {
    const { page, $, asked, toasts } = priorAuthPage({ requests: PENDING_VIEW, decisions: [] });
    await page.approvePriorAuth('PA-0001');
    expect(asked).toEqual([['approve', 'PA-0001'], ['pending'], ['decisions', 20]]);
    expect(toasts[0]).toEqual(['Approved PA-0001. The member\'s device applies it when it next syncs.', 'success']);
    expect(String($('pa-action-result').innerHTML)).toContain('ok:Approved PA-0001 (ABACAVIR).');
  });

  test('Deny needs the reason typed on its row: without one nothing is sent; with one it is sent and both lists are read again', async () => {
    const { page, $, asked, toasts } = priorAuthPage({ requests: PENDING_VIEW, decisions: [] });
    await page.denyPriorAuth('PA-0002');
    expect(asked).toEqual([]);
    expect(toasts[0]).toEqual(['Enter the reason for the denial: the prescriber is told it', 'error']);
    expect($('pa-reason-PA-0002').focused).toBe(true);
    $('pa-reason-PA-0002').value = '  Formulary alternative available ';
    await page.denyPriorAuth('PA-0002');
    expect(asked).toEqual([['deny', 'PA-0002', 'Formulary alternative available'], ['pending'], ['decisions', 20]]);
    expect(toasts[1]).toEqual(['Denied PA-0002', 'info']);
  });

  test('a refused decision is shown, and the lists are read again', async () => {
    const { page, $, asked, toasts } = priorAuthPage({ requests: PENDING_VIEW, decisions: [] }, { approve: new Error('Prior auth is already APPROVED: PA-0001') });
    await page.approvePriorAuth('PA-0001');
    expect(toasts[0]).toEqual(['Approve failed: Prior auth is already APPROVED: PA-0001', 'error']);
    expect(String($('pa-action-result').innerHTML)).toContain('error:Approve failed for PA-0001');
    expect(asked.slice(1)).toEqual([['pending'], ['decisions', 20]]);
  });

  test('recent decisions show the decision and the insurer\'s reason; without the admin token the page says to set it', async () => {
    const { page } = priorAuthPage({ requests: [], decisions: [] });
    const html = page.renderPriorAuthDecisions([{ id: 'PA-0000', status: 'DENIED', member: '79000000…0001', drugName: 'ARIPIPRAZOLE', quantity: 30, pricingUnit: 'EA', prescriberName: 'Avery Quill, MD', resolvedAt: 900, decisionReason: 'Step therapy not documented' }]);
    expect(html).toContain('Denied');
    expect(html).toContain('Step therapy not documented');
    expect(html).toContain('when:900');
    expect(page.paLoadError(Object.assign(new Error('Unauthorized'), { status: 401 }))).toMatch(/Set the insurer admin token in the Admin tab/);
  });
});

describe('the dashboard\'s client sends the node\'s admin token on every prior-authorization call', () => {
  test('pending, decisions, approve and deny', async () => {
    const calls: Array<{ url: string; init: any }> = [];
    const ctx: Record<string, unknown> = {
      location: { origin: 'http://insurer.test' },
      localStorage: { getItem: () => TOKEN, setItem() {} },
      fetch: async (url: string, init: any) => {
        calls.push({ url, init });
        return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, data: { requests: [] } }) };
      },
    };
    vm.createContext(ctx);
    vm.runInContext(read('dashboard-insurer/rpc.js') + '\n;globalThis.__API = API;', ctx);
    const API = ctx.__API as any;
    await API.getPendingPriorAuths();
    await API.getPriorAuthDecisions(20);
    await API.approvePriorAuth('PA-0001');
    await API.denyPriorAuth('PA-0002', 'Formulary alternative available');
    expect(calls.map((c) => [c.init.method, c.url])).toEqual([
      ['GET', 'http://insurer.test/prior-auth/pending'],
      ['GET', 'http://insurer.test/prior-auth/decisions?limit=20'],
      ['POST', 'http://insurer.test/prior-auth/PA-0001/approve'],
      ['POST', 'http://insurer.test/prior-auth/PA-0002/deny'],
    ]);
    expect(calls.map((c) => c.init.headers.Authorization)).toEqual(Array(4).fill(`Bearer ${TOKEN}`));
    expect(JSON.parse(calls[3].init.body)).toEqual({ reason: 'Formulary alternative available' });
  });
});
