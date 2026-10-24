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
 * What every listener checks before it routes: the Host header, a write's body type, and framing — finding A-82.
 *
 * What was wrong: no listener looked at the Host header, so a page whose name was rebound to 127.0.0.1 (DNS rebinding)
 * counted as the same origin as a loopback node and could read every answer. Every server read a POST body as JSON
 * whatever type it declared, so a page on any site could send text/plain, a form encoding or a bodyless POST, none of
 * which a browser asks about first (no CORS preflight), to an open route of a node, the sequencer, the explorer or an
 * unlocked HR Tool. And the pages a node or the explorer serves sent no anti-framing header. Found by the security
 * posture check of 2026-10-24.
 *
 * Now one Host allowlist in network-policy.ts (localhost, 127.0.0.1 and [::1] with the listener's own port, its bind
 * address, and the names in ZKTRIDENT_PUBLIC_HOSTS) runs in front of routing on the sequencer, the Nautilus app server,
 * the HR Tool and the explorer, and anything else gets 421. A POST, PUT or DELETE must declare application/json, with
 * or without a body, or the one other type its route reads (the CP 575 upload's application/pdf), else 415. The
 * Nautilus app server and the explorer send X-Frame-Options: DENY and a frame-ancestors 'none' policy, as the
 * sequencer does.
 *
 * The sequencer and the app server run in this process; the explorer and the HR Tool are started as their own scripts,
 * the way they run, against a stand-in sequencer.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import net from 'net';
import { spawn, type ChildProcess } from 'child_process';
import type { IncomingMessage } from 'http';
import { Field, MerkleTree } from 'o1js';
import { InMemoryStore } from '../src/storage/local-store.js';
import { WALLET_TREE_HEIGHT } from '../src/wallets/wallet-state.js';
import { L2Node } from '../src/l2/l2-node.js';
import { L2RpcServer } from '../src/l2/l2-rpc-server.js';
import { NautilusAppServer } from '../src/nodes/nautilus-app-server.js';
import type { NautilusAppConfig } from '../src/nodes/nautilus-app-types.js';
import { hostAllowed, bodyTypeAccepted, requestMediaType, resolvePublicHosts } from '../src/security/network-policy.js';

jest.setTimeout(120_000);

const REPO = path.resolve(__dirname, '..');
const OPERATOR = 'operator-bearer-for-guard-tests';
const TOKEN = 'node-admin-token-for-guard-tests';
const JSON_TYPE = { 'Content-Type': 'application/json' };

interface Answer { status: number; headers: http.IncomingHttpHeaders; body: string }

/** A request with the Host header the test names (http.request sends it as given). */
function raw(port: number, opts: { method?: string; path?: string; host?: string; headers?: Record<string, string>; body?: string | Buffer } = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Host: opts.host ?? `127.0.0.1:${port}`, ...(opts.headers ?? {}) };
    if (opts.body !== undefined) headers['Content-Length'] = String(Buffer.byteLength(opts.body));
    const req = http.request({ hostname: '127.0.0.1', port, path: opts.path ?? '/', method: opts.method ?? 'GET', headers, agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const a = s.address(); const p = typeof a === 'object' && a ? a.port : 0; s.close(() => resolve(p)); });
  });
}

/** Start one of the repository's scripts as its own process and wait until `ready` answers 200. */
async function startScript(script: string, env: Record<string, string>, port: number, ready: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['--import', 'tsx', path.join(REPO, script)], {
    cwd: REPO, env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
  });
  let stderr = '';
  child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
  const deadline = Date.now() + 90_000;
  for (;;) {
    try { if ((await raw(port, { path: ready })).status === 200) return child; } catch { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error(`${script} did not start: ${stderr}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

const frameDenied = (a: Answer): void => {
  expect(a.headers['x-frame-options']).toBe('DENY');
  expect(String(a.headers['content-security-policy'])).toMatch(/frame-ancestors 'none'/);
  expect(a.headers['x-content-type-options']).toBe('nosniff');
};

describe('the policy itself', () => {
  test('a Host names the listener: a loopback name with its own port, the bind address, or a configured name', () => {
    for (const host of ['localhost:3030', '127.0.0.1:3030', '[::1]:3030', 'LocalHost:3030', ' 127.0.0.1:3030 ']) {
      expect([host, hostAllowed(host, 3030)]).toEqual([host, true]);
    }
    for (const host of ['attacker.example:3030', 'attacker.example', '127.0.0.1:3031', '127.0.0.1', 'localhost.:3030', '127.0.0.2:3030', '0.0.0.0:3030', '']) {
      expect([host, hostAllowed(host, 3030)]).toEqual([host, false]);
    }
    expect(hostAllowed(undefined, 3030)).toBe(false);                                // every browser sends one
    expect(hostAllowed('localhost', 80)).toBe(true);                                  // the scheme's default port goes unwritten
    expect(hostAllowed('localhost', 443, { tls: true })).toBe(true);
    expect(hostAllowed('localhost', 443)).toBe(false);
    expect(hostAllowed('10.0.0.5:3030', 3030, { bindHost: '10.0.0.5' })).toBe(true);  // a specific bind address is a name
    expect(hostAllowed('10.0.0.5:3030', 3030, { bindHost: '0.0.0.0' })).toBe(false); // a wildcard names nobody
    expect(hostAllowed('[::1]:3030', 3030, { bindHost: '::1' })).toBe(true);
    const publicHosts = resolvePublicHosts({ ZKTRIDENT_PUBLIC_HOSTS: ' Node.Example , proxy.example:8443,' });
    expect(publicHosts).toEqual(['node.example', 'proxy.example:8443']);
    expect(hostAllowed('node.example', 4004, { publicHosts })).toBe(true);
    expect(hostAllowed('node.example:4004', 4004, { publicHosts })).toBe(true);
    expect(hostAllowed('node.example:9999', 4004, { publicHosts })).toBe(false);
    expect(hostAllowed('proxy.example:8443', 4004, { publicHosts })).toBe(true);
    expect(hostAllowed('proxy.example', 4004, { publicHosts })).toBe(false);
    expect(resolvePublicHosts({})).toEqual([]);
  });

  test('a write declares a type its route reads, with or without a body; a read needs none', () => {
    const req = (method: string, type?: string) => ({ method, headers: type === undefined ? {} : { 'content-type': type } }) as unknown as IncomingMessage;
    expect(requestMediaType(req('POST', 'Application/JSON; charset=utf-8'))).toBe('application/json');
    expect(bodyTypeAccepted(req('POST', 'application/json'))).toBe(true);
    expect(bodyTypeAccepted(req('PUT', 'application/json;charset=UTF-8'))).toBe(true);
    for (const type of ['text/plain', 'text/plain;charset=UTF-8', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'application/pdf', undefined]) {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) expect([method, type, bodyTypeAccepted(req(method, type))]).toEqual([method, type, false]);
    }
    expect(bodyTypeAccepted(req('GET'))).toBe(true);
    expect(bodyTypeAccepted(req('OPTIONS', 'text/plain'))).toBe(true);
    expect(bodyTypeAccepted(req('POST', 'application/pdf'), ['application/pdf'])).toBe(true);
    expect(bodyTypeAccepted(req('POST', 'application/json'), ['application/pdf'])).toBe(false);
  });
});

describe('the sequencer', () => {
  let server: L2RpcServer;
  let port: number;
  let proxied: L2RpcServer;
  let proxiedPort: number;

  beforeAll(async () => {
    const emptyRoot = new MerkleTree(WALLET_TREE_HEIGHT).getRoot();
    const node = new L2Node({ batchIntervalMs: 999_999, autoSettle: false, nodeId: 'seq-guards' }, new InMemoryStore(), emptyRoot, emptyRoot, Field(0));
    server = new L2RpcServer(node, { port: 0, host: '127.0.0.1', adminToken: OPERATOR, enableSSE: false });
    proxied = new L2RpcServer(node, { port: 0, host: '127.0.0.1', adminToken: OPERATOR, enableSSE: false, publicHosts: ['seq.example'] });
    await server.start();
    await proxied.start();
    port = server.getPort();
    proxiedPort = proxied.getPort();
  });
  afterAll(async () => {
    await server.stop();
    await proxied.stop();
  });

  test('a Host that does not name it is 421, the rebinding case among them; its own names are answered', async () => {
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]) {
      expect([host, (await raw(port, { path: '/health', host })).status]).toEqual([host, 200]);
    }
    for (const host of [`attacker.example:${port}`, `127.0.0.1:${port + 1}`, '127.0.0.1', 'seq.example']) {
      const a = await raw(port, { path: '/health', host });
      expect([host, a.status]).toEqual([host, 421]);                                 // before: 200
      expect(JSON.parse(a.body).error).toMatch(/does not answer for that Host/);
    }
    const rpc = await raw(port, { method: 'POST', path: '/rpc', host: `attacker.example:${port}`, headers: JSON_TYPE, body: '{"jsonrpc":"2.0","id":1,"method":"l2_getStatus"}' });
    expect(rpc.status).toBe(421);
    expect((await raw(proxiedPort, { path: '/health', host: 'seq.example' })).status).toBe(200);   // a configured public name
  });

  test('a write that does not declare JSON is 415 before any route sees it; JSON is answered', async () => {
    const body = '{"jsonrpc":"2.0","id":1,"method":"l2_getStatus","params":{}}';
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
      const a = await raw(port, { method: 'POST', path: '/rpc', headers: { 'Content-Type': type }, body });
      expect([type, a.status]).toEqual([type, 415]);                                 // before: 200 and the chain's status
    }
    expect((await raw(port, { method: 'POST', path: '/rpc', body })).status).toBe(415);
    const ok = await raw(port, { method: 'POST', path: '/rpc', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body });
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body).result).toBeTruthy();

    // A bodyless write with no type: what another site's page can send without asking, refused even with a credential.
    const bare = { Authorization: `Bearer ${OPERATOR}` };
    expect((await raw(port, { method: 'POST', path: '/viz/clear', headers: bare })).status).toBe(415);   // before: 200
    expect((await raw(port, { method: 'POST', path: '/viz/clear', headers: { ...bare, ...JSON_TYPE } })).status).toBe(200);
    expect((await raw(port, { method: 'OPTIONS', path: '/rpc' })).status).toBe(204);
  });
});

describe('the Nautilus app server', () => {
  let server: NautilusAppServer;
  let port: number;
  let dir: string;
  const seen: Array<{ route: string; body: unknown }> = [];

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-guards-'));
    const dashboard = path.join(dir, 'dashboard');
    fs.mkdirSync(dashboard);
    fs.writeFileSync(path.join(dashboard, 'index.html'), '<!doctype html><title>node</title>');
    server = new NautilusAppServer({
      role: 'insurer', port: 0, host: '127.0.0.1', sequencerUrl: 'http://127.0.0.1:1', stateDir: dir,
      enableSSE: false, maxSseConnections: 0, allowedOrigins: [], adminToken: TOKEN, dashboardDir: dashboard,
      publicHosts: ['node.example'],
    } as unknown as NautilusAppConfig);
    server.registerRoutes([
      { method: 'POST', path: '/open/echo', handler: async (_req, res, _p, _q, body) => { seen.push({ route: 'echo', body }); server.sendResponse(res, 200, true, { body }); } },
      {
        method: 'POST', path: '/open/upload/:id', bodyTypes: ['application/pdf'],
        handler: async (req, res) => {
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c as Buffer);
          seen.push({ route: 'upload', body: Buffer.concat(chunks).toString('latin1') });
          server.sendResponse(res, 200, true, { bytes: Buffer.concat(chunks).length });
        },
      },
    ]);
    await server.start();
    port = server.getPort();
  });
  afterAll(async () => {
    await server.stop();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  test('a Host that does not name it is 421 and reaches no route; its own names and a configured one are answered', async () => {
    seen.length = 0;
    const evil = await raw(port, { method: 'POST', path: '/open/echo', host: `attacker.example:${port}`, headers: JSON_TYPE, body: '{"a":1}' });
    expect(evil.status).toBe(421);                                                    // before: 200, and the handler ran
    expect(seen).toEqual([]);
    expect((await raw(port, { path: '/health', host: `attacker.example:${port}` })).status).toBe(421);
    expect((await raw(port, { path: '/health', host: `localhost:${port}` })).status).toBe(200);
    expect((await raw(port, { path: '/health', host: 'node.example' })).status).toBe(200);
  });

  test('a write that does not declare JSON is 415 and reaches no route; JSON is parsed for the handler', async () => {
    seen.length = 0;
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'application/octet-stream']) {
      const a = await raw(port, { method: 'POST', path: '/open/echo', headers: { 'Content-Type': type }, body: '{"a":1}' });
      expect([type, a.status]).toEqual([type, 415]);                                 // before: 200 (multipart reached it unparsed)
    }
    expect((await raw(port, { method: 'POST', path: '/open/echo' })).status).toBe(415);
    expect(seen).toEqual([]);
    const ok = await raw(port, { method: 'POST', path: '/open/echo', headers: JSON_TYPE, body: '{"a":1}' });
    expect(ok.status).toBe(200);
    expect(seen).toEqual([{ route: 'echo', body: { a: 1 } }]);
    expect((await raw(port, { method: 'POST', path: '/rpc', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status).toBe(415);
  });

  test('a route that reads a document takes its own type, and only that', async () => {
    seen.length = 0;
    const pdf = '%PDF-1.4\n%%EOF\n';
    const ok = await raw(port, { method: 'POST', path: '/open/upload/A1', headers: { 'Content-Type': 'application/pdf' }, body: pdf });
    expect(ok.status).toBe(200);
    expect(seen).toEqual([{ route: 'upload', body: pdf }]);
    expect((await raw(port, { method: 'POST', path: '/open/upload/A1', headers: JSON_TYPE, body: '{}' })).status).toBe(415);
    expect((await raw(port, { method: 'POST', path: '/open/upload/A1', headers: { 'Content-Type': 'text/plain' }, body: pdf })).status).toBe(415);
    expect(seen).toHaveLength(1);
  });

  test('its pages and its answers may not be framed by another site', async () => {
    const page = await raw(port, { path: '/' });
    expect(page.status).toBe(200);
    expect(page.body).toContain('<title>node</title>');
    frameDenied(page);                                                                // before: no such header
    frameDenied(await raw(port, { path: '/health' }));
  });
});

describe('the explorer, started as it runs', () => {
  let explorer: ChildProcess | null = null;
  let port: number;
  let seq: http.Server;
  const forwarded: string[] = [];

  beforeAll(async () => {
    // A stand-in sequencer that answers the one method this test forwards.
    seq = http.createServer((req, res) => {
      let text = '';
      req.on('data', (c) => { text += c; });
      req.on('end', () => {
        forwarded.push(`${req.method} ${req.url} ${text}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(req.url === '/rpc' ? JSON.stringify({ jsonrpc: '2.0', id: 1, result: { running: true } }) : '{"ok":true}');
      });
    });
    await new Promise<void>((resolve) => seq.listen(0, '127.0.0.1', () => resolve()));
    const seqAddr = seq.address();
    port = await freePort();
    explorer = await startScript('src/nodes/start-explorer.ts', {
      ZKTRIDENT_EXPLORER_PORT: String(port),
      ZKTRIDENT_SEQUENCER_URL: `http://127.0.0.1:${typeof seqAddr === 'object' && seqAddr ? seqAddr.port : 0}`,
      ZKTRIDENT_PUBLIC_HOSTS: 'explorer.example',
      ZKTRIDENT_HOST: '127.0.0.1',
    }, port, '/index.html');
  }, 120_000);
  afterAll(async () => {
    if (explorer && !explorer.killed) { try { explorer.kill(); } catch { /* best effort */ } }
    await new Promise<void>((resolve) => seq.close(() => resolve()));
  });

  test('a Host that does not name it is 421, and nothing is forwarded to the sequencer', async () => {
    forwarded.length = 0;
    expect((await raw(port, { path: '/', host: `attacker.example:${port}` })).status).toBe(421);   // before: 200
    const rpc = await raw(port, { method: 'POST', path: '/rpc', host: `attacker.example:${port}`, headers: JSON_TYPE, body: '{"jsonrpc":"2.0","id":1,"method":"l2_getStatus"}' });
    expect(rpc.status).toBe(421);
    expect(forwarded).toEqual([]);
    expect((await raw(port, { path: '/', host: `localhost:${port}` })).status).toBe(200);
    expect((await raw(port, { path: '/', host: 'explorer.example' })).status).toBe(200);
    // A Host that is not even a URL authority is refused here too, before the handler builds a URL from it.
    expect((await raw(port, { path: '/', host: 'bad[host' })).status).toBe(421);
    expect((await raw(port, { path: '/' })).status).toBe(200);                         // and the explorer is still up
  });

  test('a write that does not declare JSON is 415 and is not forwarded; JSON is', async () => {
    forwarded.length = 0;
    const body = '{"jsonrpc":"2.0","id":1,"method":"l2_getStatus","params":{}}';
    expect((await raw(port, { method: 'POST', path: '/rpc', headers: { 'Content-Type': 'text/plain' }, body })).status).toBe(415);   // before: forwarded
    expect((await raw(port, { method: 'POST', path: '/rpc', body })).status).toBe(415);
    expect(forwarded).toEqual([]);
    const ok = await raw(port, { method: 'POST', path: '/rpc', headers: JSON_TYPE, body });
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body).result).toEqual({ running: true });
    expect(forwarded).toHaveLength(1);
  });

  test('its pages may not be framed by another site', async () => {
    const page = await raw(port, { path: '/' });
    expect(page.status).toBe(200);
    frameDenied(page);                                                                // before: no such header
  });
});

describe('the HR Tool, started as it runs', () => {
  let tool: ChildProcess | null = null;
  let port: number;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hr-guards-'));
    port = await freePort();
    tool = await startScript('src/tools/hr-tool-server.ts', { PORT: String(port), HR_TOOL_DATA_DIR: dataDir, EMPLOYER_NODE_URL: 'http://127.0.0.1:1' }, port, '/api/session');
  }, 120_000);
  afterAll(async () => {
    if (tool && !tool.killed) { try { tool.kill(); } catch { /* best effort */ } }
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  test('a Host that does not name it is 421: a page rebound to loopback cannot drive the tool', async () => {
    expect((await raw(port, { path: '/api/session', host: `attacker.example:${port}` })).status).toBe(421);   // before: 200
    expect((await raw(port, { path: '/', host: `attacker.example:${port}` })).status).toBe(421);
    expect((await raw(port, { path: '/api/session', host: `localhost:${port}` })).status).toBe(200);
    expect((await raw(port, { path: '/api/session', host: `[::1]:${port}` })).status).toBe(200);
  });

  test('a write that does not declare JSON is 415: the posts another site\'s page can send without asking', async () => {
    const unlock = '{"passphrase":"correct-horse-battery-staple-12"}';
    const plain = await raw(port, { method: 'POST', path: '/api/unlock', headers: { 'Content-Type': 'text/plain' }, body: unlock });
    expect(plain.status).toBe(415);                                                   // before: 409, the body read as JSON
    expect(JSON.parse(plain.body)).toMatchObject({ ok: false });
    expect((await raw(port, { method: 'POST', path: '/api/lock' })).status).toBe(415);   // before: 200, the workspace locked
    expect((await raw(port, { method: 'POST', path: '/api/lock', headers: JSON_TYPE })).status).toBe(200);
    expect((await raw(port, { method: 'POST', path: '/api/unlock', headers: JSON_TYPE, body: unlock })).status).toBe(409);   // no workspace yet
  });
});
