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
 * The pharmacy node notifies the insurer its configuration names, never one a request names (A-81).
 *
 * What was wrong: the pharmacy node's POST /onboarding/enroll read `insurerUrl` from the request body and posted the
 * node's wallet ID and enrollment code to `${insurerUrl}/enrollment/process`. The route takes no credential, so anything
 * that could reach the port while the node was in its enrollment phase chose where the node sent them: a host on this
 * machine or its network that the caller could not reach itself, or a hostile server for the node's HTTP client to
 * parse. The prescriber and member nodes already read their configuration; the pharmacy did not, and its dashboard
 * still offered an Insurer URL field.
 *
 * How it was found: the security posture check of 2026-10-24 (A-81, pharmacy-routes.ts lines 228 and 244).
 *
 * What is true now: the route refuses a body that names an insurer URL (400) and posts only to the insurer the server's
 * configuration names (ZKTRIDENT_INSURER_URL, read at boot by resolvePeerUrl), and only when peerUrlError accepts it:
 * absolute http or https with a host, no user name or password, no query or fragment, plain http to this machine's
 * loopback only. A redirect from the insurer is refused rather than followed. The dashboard's step sends no URL.
 */
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import { NautilusAppServer } from '../src/nodes/nautilus-app-server.js';
import { buildPharmacyRoutes } from '../src/nodes/routes/pharmacy-routes.js';
import type { NautilusAppConfig } from '../src/nodes/nautilus-app-types.js';

jest.setTimeout(60_000);

const PIN = '614208';
const WALLET = '424242424242424242';
const TOKEN = 'PHARM-ENROLL-TOKEN-1';
const NL = '\n';
const read = (file: string): string => fs.readFileSync(file, 'utf8').replace(/\r\n/g, NL);

/** A server that records what reaches it and answers each request as `answer` says. */
interface Recorder { url: string; requests: Array<{ method: string; path: string; body: unknown }>; server: http.Server }
async function recorder(answer: (res: http.ServerResponse) => void = (res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); }): Promise<Recorder> {
  const requests: Recorder['requests'] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body: unknown = raw;
      try { body = JSON.parse(raw); } catch { /* keep the text */ }
      requests.push({ method: req.method ?? '', path: req.url ?? '', body });
      answer(res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests, server };
}

let insurer: Recorder;
let elsewhere: Recorder;
const servers: NautilusAppServer[] = [];
const dirs: string[] = [];

beforeAll(async () => {
  insurer = await recorder();
  elsewhere = await recorder();
});

beforeEach(() => {
  insurer.requests.length = 0;
  elsewhere.requests.length = 0;
});

afterAll(async () => {
  for (const s of servers) { try { await s.stop(); } catch { /* never started */ } }
  for (const r of [insurer, elsewhere]) await new Promise<void>((resolve) => r.server.close(() => resolve()));
  for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
});

/** A pharmacy node that has derived its wallet and may enroll, configured with `insurerUrl`. */
async function pharmacy(insurerUrl?: string): Promise<{ server: NautilusAppServer; url: string }> {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pharmacy-enroll-'));
  dirs.push(stateDir);
  const config: NautilusAppConfig = {
    role: 'pharmacy', port: 0, host: '127.0.0.1', sequencerUrl: 'http://127.0.0.1:1', stateDir,
    enableSSE: false, maxSseConnections: 0, allowedOrigins: [], insurerUrl,
  };
  const server = new NautilusAppServer(config);
  servers.push(server);
  server.registerRoutes(buildPharmacyRoutes(server));
  await server.getLocalState().unlock(PIN);
  await server.getLocalState().save({
    version: 1, role: 'pharmacy', walletId: WALLET,
    onboarding: { phase: 'wallet_derived', tokenId: TOKEN },
    lastSavedAt: new Date().toISOString(),
  });
  server.setOnboardingPhase('wallet_derived');
  await server.start();
  return { server, url: `http://127.0.0.1:${server.getPort()}` };
}

async function enroll(url: string, body: unknown): Promise<{ status: number; json: any }> {
  const r = await fetch(`${url}/onboarding/enroll`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json() };
}

describe('POST /onboarding/enroll on the pharmacy node', () => {
  test('a body that names an insurer URL is refused, and nothing is sent anywhere', async () => {
    const { server, url } = await pharmacy(insurer.url);
    const r = await enroll(url, { insurerUrl: elsewhere.url });
    expect(r.status).toBe(400);                                                           // before: 200
    expect(r.json.error).toMatch(/insurerUrl is not accepted/);
    expect(elsewhere.requests).toEqual([]);                                               // before: the wallet ID and code, posted here
    expect(insurer.requests).toEqual([]);
    expect(server.getOnboardingPhase()).toBe('wallet_derived');                          // not enrolled by the refused request
  });

  test('the node notifies the insurer its configuration names, with the wallet ID and the code', async () => {
    const { server, url } = await pharmacy(insurer.url);
    const r = await enroll(url, {});
    expect(r.status).toBe(200);
    expect(r.json.data).toMatchObject({ phase: 'enrolled', walletId: WALLET, insurerNotified: true });   // before: false, nobody asked
    expect(insurer.requests).toEqual([{ method: 'POST', path: '/enrollment/process', body: { walletId: WALLET, tokenId: TOKEN, role: 'pharmacy' } }]);
    expect(elsewhere.requests).toEqual([]);
    expect(server.getOnboardingPhase()).toBe('enrolled');
  });

  test('a configured URL the peer check refuses is not called; the node still enrolls', async () => {
    const withPassword = elsewhere.url.replace('http://', 'http://user:secret@');
    const { url } = await pharmacy(withPassword);
    const r = await enroll(url, {});
    expect(r.status).toBe(200);
    expect(r.json.data).toMatchObject({ phase: 'enrolled', insurerNotified: false });
    expect(elsewhere.requests).toEqual([]);
  });

  test('a redirect from the configured insurer is not followed', async () => {
    const redirecting = await recorder((res) => { res.writeHead(307, { Location: `${elsewhere.url}/enrollment/process` }); res.end(); });
    try {
      const { url } = await pharmacy(redirecting.url);
      const r = await enroll(url, {});
      expect(r.status).toBe(200);
      expect(r.json.data).toMatchObject({ phase: 'enrolled', insurerNotified: false });
      expect(redirecting.requests).toHaveLength(1);
      expect(elsewhere.requests).toEqual([]);                                             // the wallet ID went nowhere else
    } finally {
      await new Promise<void>((resolve) => redirecting.server.close(() => resolve()));
    }
  });
});

describe('the peer-URL check', () => {
  test('accepts http on loopback and https anywhere, and nothing else', async () => {
    const { peerUrlError } = await import('../src/security/network-policy.js') as any;
    for (const ok of ['http://localhost:4004', 'http://127.0.0.1:4004/', 'http://127.3.2.1', 'http://[::1]:4004', 'https://insurer.example.org', 'https://10.0.0.7:8443/insurer']) {
      expect([ok, peerUrlError(ok)]).toEqual([ok, null]);
    }
    const refused: Array<[string, RegExp]> = [
      ['insurer.example.org:4004', /rather than http: or https:/],
      ['not a url', /not an absolute URL/],
      ['file:///etc/passwd', /rather than http: or https:/],
      ['ftp://localhost/', /rather than http: or https:/],
      ['javascript:alert(1)', /rather than http: or https:/],
      ['http://user:secret@localhost:4004', /user name or password/],
      ['http://localhost:4004/?next=http://elsewhere', /query or a fragment/],
      ['http://localhost:4004/#x', /query or a fragment/],
      ['http://insurer.example.org:4004', /over plain http/],
      ['http://169.254.169.254/latest/meta-data', /over plain http/],
      ['http://10.0.0.7:4004', /over plain http/],
    ];
    for (const [bad, why] of refused) {
      expect([bad, peerUrlError(bad)]).toEqual([bad, expect.stringMatching(why)]);
    }
  });

  test('resolvePeerUrl reads the environment: unset is none, a good URL loses its trailing slash, a bad one stops the node', async () => {
    const { resolvePeerUrl } = await import('../src/security/network-policy.js') as any;
    expect(resolvePeerUrl({}, 'ZKTRIDENT_INSURER_URL', 'pharmacy node')).toBeUndefined();
    expect(resolvePeerUrl({ ZKTRIDENT_INSURER_URL: '  ' }, 'ZKTRIDENT_INSURER_URL', 'pharmacy node')).toBeUndefined();
    expect(resolvePeerUrl({ ZKTRIDENT_INSURER_URL: 'http://localhost:4004/' }, 'ZKTRIDENT_INSURER_URL', 'pharmacy node')).toBe('http://localhost:4004');
    expect(() => resolvePeerUrl({ ZKTRIDENT_INSURER_URL: 'http://insurer.example.org' }, 'ZKTRIDENT_INSURER_URL', 'pharmacy node'))
      .toThrow('pharmacy node: ZKTRIDENT_INSURER_URL reaches insurer.example.org over plain http');
  });

  test('the pharmacy starter takes its insurer from ZKTRIDENT_INSURER_URL through that check', () => {
    const starter = read('src/nodes/start-pharmacy-nautilus.ts');
    expect(starter).toContain("insurerUrl = resolvePeerUrl(env, 'ZKTRIDENT_INSURER_URL', 'pharmacy node');");   // before: no insurer configured at all
    expect(starter).toMatch(/\n  insurerUrl,\n/);
  });
});

describe('the pharmacy dashboard', () => {
  test('its enrollment step offers no insurer URL and sends none', () => {
    expect(read('dashboard-pharmacy/index.html')).not.toContain('wiz-insurerUrl');       // before: an "Insurer URL (optional)" field
    const app = read('dashboard-pharmacy/app.js');
    expect(app).not.toContain('wiz-insurerUrl');
    expect(app).toContain('result = await API.onboarding.enroll();');
    expect(read('dashboard-pharmacy/rpc.js')).toContain("return post('/onboarding/enroll', {});");
  });
});
