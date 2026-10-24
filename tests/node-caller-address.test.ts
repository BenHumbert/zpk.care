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
 * Each per-caller limit on the insurer and employer nodes counts the client a request speaks for, read as the request
 * arrives: behind a reverse proxy the node trusts, the client the proxy names; otherwise the socket's address, an IPv6
 * caller by its /64.
 *
 * What was wrong: the insurer node counted each caller's credentialing applications (10 open and 20 an hour), card
 * recovery requests (30 a minute) and reads of an employer's plans to add (30 a minute) by addressKey of the socket's
 * address, and the employer node counted the callers of its validate oracle (60 a minute) by the raw socket address.
 * Behind a reverse proxy or a TLS terminator, a deployment RUNNING.md supports through ZKTRIDENT_PUBLIC_HOSTS, every
 * request's socket is the proxy's, so every caller was one source: the cap of 10 open applications per source became a
 * cap of 10 for the whole network, and one client trickling 30 bad /recovery/release requests a minute had every
 * member's card recovery refused 429. Nothing read X-Forwarded-For or trusted a proxy. The employer's raw key also made
 * an IPv4 caller and its IPv4-mapped form two callers, and one IPv6 host as many callers as its /64 has addresses. And
 * no route-level test could tell addressKey keying from raw-address keying: every request in the tests came from a
 * dotted IPv4 address.
 *
 * The fix left two faults of its own. The boot warning, for a node bound to loopback that answers a public name, told
 * every such node to trust 127.0.0.1, even one bound to ::1 or to localhost (which Node may bind as ::1), and any entry
 * in the list silenced it: a node bound to ::1 that followed the advice fell silent while its proxy, connecting from
 * ::1, stayed untrusted and every client was one source again. And addressKey keyed each link-local address as a source
 * of its own, so one host on a link could take as many fe80:: addresses as it liked and count as that many sources.
 *
 * One route also read its caller too late. Node reads a socket's address from the open connection, and
 * POST /marketplace/api/apply read callerKey only after asking the sequencer whether the employerId was taken, so an
 * application from a client that half-closed its connection right after sending it was kept under 'unknown', the one
 * key every closed socket shares, and not under its source: one client could hold its own three open applications and
 * three more under 'unknown', and those three refused every other client that closed the same way.
 *
 * How it was found: the review of the per-caller limits (the review of A-89's fixes), which asked what a socket's
 * address is behind the proxy RUNNING.md describes; the warning's advice and the link-local key by the review of the
 * trusted-proxy fix; the half-close by the review of the open-intake limits.
 *
 * What is true now: ZKTRIDENT_TRUSTED_PROXIES lists the proxies in front of a node by exact IP address, normalized
 * (resolveTrustedProxies), and an entry that is not one IP address stops the node at boot. From a listed proxy, a node
 * walks X-Forwarded-For from the right past every listed proxy, and the first other address is the client
 * (clientAddress); an entry that is not an IP address stops the walk at the last trusted hop. From any other address
 * the header is ignored, so a client cannot choose its own source. NautilusAppServer.callerKey is addressKey of that
 * client, and every per-caller limit on the insurer node, and the employer's validate limit, counts it. A node bound to
 * loopback that answers a public name warns at boot, naming the address to add, unless it trusts the loopback address
 * of its bind's family that a proxy on its host connects from: one in 127.0.0.0/8 for an IPv4 bind, ::1 for ::1, and
 * both for localhost, which Node binds to whichever of the two it resolves first. A link-local caller is keyed as
 * fe80::/64 on the interface it arrived on: one source for each of the node's links. A node reads each request's key as
 * the request arrives, before routing, and callerKey answers that key for as long as the request lasts, whatever becomes
 * of its socket; the marketplace's apply route reads its caller before it awaits anything as well.
 *
 * The route tests call the handlers buildInsurerRoutes and buildEmployerRoutes make on a real NautilusAppServer, which is
 * never started, with stand-in requests whose socket address and headers each test sets, so they need no IPv6 socket and
 * no proxy. The two that share an insurer source between addresses alone (one /64, an IPv4-mapped address) passed on
 * the route as it was; they hold the route to addressKey, which no test could see before. The half-close test starts a
 * node with a route of its own that reads callerKey only once the request's socket has closed, and sends from a raw
 * socket that ends its side of the connection with the request. The apply route's test calls buildMarketplaceRoutes'
 * handler the same way as the others, and its stand-in sequencer clears the request's socket address before it answers,
 * as a socket's closing does.
 */
import fs from 'fs';
import http from 'http';
import net from 'net';
import os from 'os';
import path from 'path';
import util from 'util';
import type { AddressInfo } from 'net';
import type { IncomingMessage, ServerResponse } from 'http';
import { NautilusAppServer } from '../src/nodes/nautilus-app-server.js';
import { buildInsurerRoutes } from '../src/nodes/routes/insurer-routes.js';
import { buildEmployerRoutes } from '../src/nodes/routes/employer-routes.js';
import { buildMarketplaceRoutes, getApplicationStore } from '../src/nodes/routes/marketplace-routes.js';
import type { NautilusAppConfig, RouteRegistration } from '../src/nodes/nautilus-app-types.js';
import type { EntityNodeBase } from '../src/nodes/entity-node-base.js';
import type { EmployerApplication } from '../src/l2/l2-types.js';
import { clientAddress, isLoopbackBind, resolveTrustedProxies } from '../src/security/network-policy.js';
import { addressKey, normalizeAddress } from '../src/security/rate-limit.js';

jest.setTimeout(60_000);

const OPEN_FROM_SOURCE = 'Too many open credentialing applications from this address. Apply again once the insurer decides one.';
const EMPLOYER_OPEN_FROM_SOURCE = 'Too many open employer applications from this address. Apply again once the insurer decides one.';
/** The one reverse proxy most tests trust: one on the node's own host. */
const PROXY = ['127.0.0.1'];

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
});

/**
 * A node for `role`. Every test but the half-close test leaves it unstarted and calls its routes directly. It answers no
 * public name and trusts no proxy unless `over` says so, whatever this process's environment holds.
 */
function nodeFor(role: 'insurer' | 'employer', over: Partial<NautilusAppConfig> = {}): NautilusAppServer {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caller-address-'));
  dirs.push(dir);
  return new NautilusAppServer({
    role, port: 0, host: '127.0.0.1', sequencerUrl: 'http://127.0.0.1:1', stateDir: dir,
    enableSSE: false, maxSseConnections: 0, allowedOrigins: [], adminToken: 'admin-token-for-caller-tests',
    publicHosts: [], trustedProxies: [], ...over,
  } as NautilusAppConfig);
}

/** Enough of a request for a handler: a socket at `remoteAddress`, and X-Forwarded-For when `forwardedFor` is given. */
function from(remoteAddress: string | undefined, forwardedFor?: string) {
  return { url: '/', headers: forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor }, socket: { remoteAddress } };
}
type StandIn = ReturnType<typeof from>;

interface Answer { status: number; retryAfter: string | undefined; error: string | undefined }

/** Calls `route`'s handler as the server does once it has parsed the body, with a stand-in response; returns the answer. */
async function call(route: RouteRegistration, req: StandIn, body?: unknown, params: Record<string, string> = {}): Promise<Answer> {
  let status = 0;
  let text = '';
  const headers: Record<string, string> = {};
  const res = {
    get writableEnded() { return status !== 0; },
    setHeader(name: string, value: string) { headers[name.toLowerCase()] = value; return this; },
    writeHead(code: number) { status = code; return this; },
    end(chunk?: string) { text = chunk ?? ''; return this; },
  };
  await route.handler(req as unknown as IncomingMessage, res as unknown as ServerResponse, params, new URLSearchParams(), body);
  return { status, retryAfter: headers['retry-after'], error: text ? (JSON.parse(text) as { error?: string }).error : undefined };
}

function routeOf(routes: RouteRegistration[], method: string, p: string): RouteRegistration {
  const r = routes.find((x) => x.method === method && x.path === p);
  if (!r) throw new Error(`route not registered: ${method} ${p}`);
  return r;
}

/** The statuses of `n` requests sent one after another. */
async function statuses(n: number, send: (i: number) => Promise<Answer>): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push((await send(i)).status);
  return out;
}

/** The NPI whose first nine digits are `nine`: the tenth is the Luhn digit over 80840 and the nine, by the CMS rule. */
function withCheckDigit(nine: string): string {
  const digits = '80840' + nine;
  let sum = 0;
  // The check digit will stand to the right of these, so the rightmost of them is the first doubled.
  for (let i = digits.length - 1, doubled = true; i >= 0; i--, doubled = !doubled) {
    let d = Number(digits[i]);
    if (doubled) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return nine + String((10 - (sum % 10)) % 10);
}
let nextNine = 300_000_000;
/** An application as a prescriber's office fills it in, under an NPI no other application in this file has used. */
const application = (): Record<string, unknown> =>
  ({ providerType: 'prescriber', npi: withCheckDigit(String(nextNine++)), displayName: 'Dr. Avery Quill, MD' });

let employers = 0;
/** An application as an employer fills it in on the marketplace, under an employerId no other application here has used. */
const employerApplication = (): Record<string, unknown> => ({
  companyName: 'Fernhill Test Works LLC', employerId: `CALLER-${++employers}`, contactName: 'Jordan Testcase',
  contactEmail: 'hr@fernhill.example.test', state: 'WI', selectedPlanIds: ['PLAN-TEST-1'], effectiveDate: '2027-01-01',
  enrollmentCap: 10, publicKeyHex: 'a'.repeat(64),
});

// ── The functions ──────────────────────────────────────────

describe('resolveTrustedProxies: the reverse proxies whose X-Forwarded-For a node reads', () => {
  test('none unless set, and each listed address written one way, once', () => {
    expect(resolveTrustedProxies({})).toEqual([]);
    expect(resolveTrustedProxies({ ZKTRIDENT_TRUSTED_PROXIES: ' , ' })).toEqual([]);
    expect(resolveTrustedProxies({ ZKTRIDENT_TRUSTED_PROXIES: ' 127.0.0.1, 10.0.0.2,127.0.0.1 ' })).toEqual(['127.0.0.1', '10.0.0.2']);
    expect(resolveTrustedProxies({ ZKTRIDENT_TRUSTED_PROXIES: '::ffff:10.0.0.2' })).toEqual(['10.0.0.2']);
  });

  test('an IPv6 address, however it is written, in the form RFC 5952 gives it', () => {
    expect(resolveTrustedProxies({ ZKTRIDENT_TRUSTED_PROXIES: '::1, 2001:0DB8:0000:0000:0000:0000:0000:0010, FE80::1%eth0' }))
      .toEqual(['::1', '2001:db8::10', 'fe80::1%eth0']);
  });

  test('an entry that is not one IP address is refused, naming the variable and the entry', () => {
    for (const entry of ['proxy.internal', 'localhost', '10.0.0.0/8', '127.0.0.1:8080', '[::1]', '127.0.0.01', '2001:db8::1::2']) {
      expect(() => resolveTrustedProxies({ ZKTRIDENT_TRUSTED_PROXIES: `127.0.0.1, ${entry}` }))
        .toThrow(`ZKTRIDENT_TRUSTED_PROXIES: "${entry}" is not an IP address`);
    }
  });

  test('a node refuses to start with such an entry, from its environment or from its config', () => {
    const saved = process.env.ZKTRIDENT_TRUSTED_PROXIES;
    process.env.ZKTRIDENT_TRUSTED_PROXIES = '127.0.0.1, proxy.internal';
    try {
      expect(() => nodeFor('insurer', { trustedProxies: undefined }))
        .toThrow('ZKTRIDENT_TRUSTED_PROXIES: "proxy.internal" is not an IP address');   // before: the node started, and read no proxy's header
    } finally {
      if (saved === undefined) delete process.env.ZKTRIDENT_TRUSTED_PROXIES;
      else process.env.ZKTRIDENT_TRUSTED_PROXIES = saved;
    }
    expect(() => nodeFor('insurer', { trustedProxies: ['10.0.0.0/8'] })).toThrow('trustedProxies: "10.0.0.0/8" is not an IP address');
  });
});

describe('normalizeAddress: one text for each address', () => {
  test('IPv6 as RFC 5952 writes it, an IPv4-mapped address as its IPv4 address, and an interface on a link-local address only', () => {
    expect(normalizeAddress('2001:0DB8:0:0:1:0:0:1')).toBe('2001:db8::1:0:0:1');
    expect(normalizeAddress('2001:db8:0:1:1:1:1:1')).toBe('2001:db8:0:1:1:1:1:1');
    expect(normalizeAddress('0:0:0:0:0:0:0:0')).toBe('::');
    expect(normalizeAddress('::ffff:c000:280')).toBe('192.0.2.128');
    expect(normalizeAddress('FE80::1%eth0')).toBe('fe80::1%eth0');
    expect(normalizeAddress('2001:db8::1%eth0')).toBe('2001:db8::1');
    for (const text of [undefined, '', ' 192.0.2.1', 'fe80::1%', 'fe80::1%eth 0', '192.0.2.1:80', '[::1]', 'unknown']) {
      expect([text, normalizeAddress(text)]).toEqual([text, null]);
    }
  });
});

describe('clientAddress: the client a request speaks for', () => {
  test('from a socket that is not a trusted proxy, the socket\'s address as given, whatever X-Forwarded-For says', () => {
    expect(clientAddress('192.0.2.50', '198.51.100.7', PROXY)).toBe('192.0.2.50');
    expect(clientAddress('127.0.0.1', '198.51.100.7', [])).toBe('127.0.0.1');
    expect(clientAddress('::ffff:192.0.2.50', '198.51.100.7', PROXY)).toBe('::ffff:192.0.2.50');
    expect(clientAddress(undefined, '198.51.100.7', PROXY)).toBeUndefined();
  });

  test('from a trusted proxy, the address it appended: the only entry, or the rightmost of several', () => {
    expect(clientAddress('127.0.0.1', '198.51.100.7', PROXY)).toBe('198.51.100.7');                  // before: 127.0.0.1, nothing read the header
    expect(clientAddress('127.0.0.1', '203.0.113.9, 198.51.100.7', PROXY)).toBe('198.51.100.7');     // before: 127.0.0.1
    expect(clientAddress('127.0.0.1', ' 203.0.113.9 ,198.51.100.7 ', PROXY)).toBe('198.51.100.7');   // before: 127.0.0.1
    expect(clientAddress('127.0.0.1', undefined, PROXY)).toBe('127.0.0.1');
    expect(clientAddress('127.0.0.1', '', PROXY)).toBe('127.0.0.1');
  });

  test('a chain of trusted proxies is walked to the first address that is not one of them', () => {
    const chain = ['127.0.0.1', '10.0.0.2', '10.0.0.3'];
    expect(clientAddress('127.0.0.1', '203.0.113.9, 198.51.100.7, 10.0.0.3, 10.0.0.2', chain)).toBe('198.51.100.7');   // before: 127.0.0.1
    // A proxy no one listed is a client like any other, and a request whose every entry is a listed proxy is the leftmost's.
    expect(clientAddress('127.0.0.1', '198.51.100.7, 10.0.0.2', PROXY)).toBe('10.0.0.2');            // before: 127.0.0.1
    expect(clientAddress('127.0.0.1', '10.0.0.3, 10.0.0.2', chain)).toBe('10.0.0.3');                // before: 127.0.0.1
  });

  test('an entry that is not an IP address stops the walk, and the request is the last trusted hop\'s', () => {
    for (const header of ['unknown', '198.51.100.7, unknown', '198.51.100.7:51234', '[2001:db8::7]', '198.51.100.7, ', 'client.example']) {
      expect([header, clientAddress('127.0.0.1', header, PROXY)]).toEqual([header, '127.0.0.1']);
    }
    const chain = ['127.0.0.1', '10.0.0.2'];
    expect(clientAddress('127.0.0.1', '198.51.100.7, client.example, 10.0.0.2', chain)).toBe('10.0.0.2');   // before: 127.0.0.1
  });

  test('IPv6 in any text form, a proxy listed by IPv6 or reported as an IPv4-mapped address, and a header sent twice', () => {
    expect(clientAddress('127.0.0.1', '2001:0DB8:85A3:0:0:0:0:7', PROXY)).toBe('2001:db8:85a3::7');  // before: 127.0.0.1
    expect(clientAddress('127.0.0.1', '::ffff:198.51.100.7', PROXY)).toBe('198.51.100.7');           // before: 127.0.0.1
    expect(clientAddress('127.0.0.1', 'fe80::7%eth0', PROXY)).toBe('fe80::7%eth0');                  // before: 127.0.0.1
    // A listener bound to both families reports an IPv4 proxy as ::ffff:127.0.0.1.
    expect(clientAddress('::ffff:127.0.0.1', '198.51.100.7', PROXY)).toBe('198.51.100.7');           // before: ::ffff:127.0.0.1
    expect(clientAddress('::1', '2001:db8::7', ['::1'])).toBe('2001:db8::7');                        // before: ::1
    expect(clientAddress('0:0:0:0:0:0:0:1', '2001:db8::7', ['0::1'])).toBe('2001:db8::7');           // before: 0:0:0:0:0:0:0:1
    expect(clientAddress('127.0.0.1', ['203.0.113.9', '198.51.100.7'], PROXY)).toBe('198.51.100.7'); // before: 127.0.0.1
  });
});

describe('NautilusAppServer.callerKey: what each per-caller limit counts', () => {
  test('addressKey of the client the request speaks for', () => {
    const server = nodeFor('insurer', { trustedProxies: PROXY });
    const key = (req: StandIn): string => server.callerKey(req as unknown as IncomingMessage);
    expect(key(from('127.0.0.1', '2001:db8:85a3:12::1'))).toBe('2001:db8:85a3:12::/64');   // before: 127.0.0.1, the proxy, for every client
    expect(key(from('::ffff:127.0.0.1', '198.51.100.7'))).toBe('198.51.100.7');            // before: 127.0.0.1
    expect(key(from('127.0.0.1', 'fe80::7%eth0'))).toBe('fe80::/64%eth0');                 // before: fe80::7%eth0, each link-local address a source
    expect(key(from('192.0.2.50', '198.51.100.7'))).toBe('192.0.2.50');
    expect(key(from('127.0.0.1'))).toBe('127.0.0.1');
    expect(key(from(undefined))).toBe('unknown');
  });
});

describe('addressKey: a link-local caller is the link it arrived on', () => {
  test('every link-local address on one interface is one key, fe80::/64 on that interface, all of fe80::/10 alike', () => {
    expect(addressKey('fe80::1%eth0')).toBe('fe80::/64%eth0');                     // before: fe80::1%eth0, each address a key of its own
    expect(addressKey('fe80::9f3c:51ff:fe0a:7d21%eth0')).toBe('fe80::/64%eth0');   // before: fe80::9f3c:51ff:fe0a:7d21%eth0
    expect(addressKey('FE80:0:0:0:0:0:0:2%eth0')).toBe('fe80::/64%eth0');          // before: fe80::2%eth0
    expect(addressKey('febf:0:0:0:1::1%eth0')).toBe('fe80::/64%eth0');             // before: febf::1:0:0:1%eth0
    expect(addressKey('fe80::a:b:c:d%12')).toBe('fe80::/64%12');                   // before: fe80::a:b:c:d%12; Windows numbers its interfaces
    // A proxy may write a link-local client with no interface.
    expect(addressKey('fe80::1')).toBe('fe80::/64');                               // before: fe80::1
    expect(addressKey('fec0::1')).toBe('fec0:0:0:0::/64');                         // past fe80::/10, the /64 rule
  });

  test('the same link-local address on two interfaces is two keys: the interface is this host\'s to name', () => {
    expect(addressKey('fe80::1%eth1')).toBe('fe80::/64%eth1');                     // before: fe80::1%eth1
    expect(addressKey('fe80::1%eth1')).not.toBe(addressKey('fe80::1%eth0'));
  });
});

// ── The routes ─────────────────────────────────────────────

describe('POST /credentialing/apply counts the source callerKey names', () => {
  /** Sends an application to a fresh insurer node, whose source counts start empty. */
  function insurer(over: Partial<NautilusAppConfig> = {}): (req: StandIn) => Promise<Answer> {
    const apply = routeOf(buildInsurerRoutes(nodeFor('insurer', over)), 'POST', '/credentialing/apply');
    return (req) => call(apply, req, application());
  }

  test('two addresses in one IPv6 /64 share a source\'s ten open applications, and an address in another /64 does not', async () => {
    const apply = insurer();
    const kept = await statuses(10, (i) => apply(from(i % 2 ? '2001:db8:85a3:12::1' : '2001:db8:85a3:12:9f3c:51ff:fe0a:7d21')));
    expect(kept).toEqual(Array(10).fill(201));
    const eleventh = await apply(from('2001:db8:85a3:12::2'));
    expect([eleventh.status, eleventh.error]).toEqual([429, OPEN_FROM_SOURCE]);   // keyed by the raw socket address, 201: a source of its own
    expect((await apply(from('2001:db8:85a3:13::1'))).status).toBe(201);
  });

  test('an IPv4-mapped address is the IPv4 address it maps', async () => {
    const apply = insurer();
    expect(await statuses(10, () => apply(from('203.0.113.7')))).toEqual(Array(10).fill(201));
    const mapped = await apply(from('::ffff:203.0.113.7'));
    expect([mapped.status, mapped.error]).toEqual([429, OPEN_FROM_SOURCE]);       // keyed by the raw socket address, 201: a source of its own
  });

  test('link-local addresses on one interface share a source\'s ten open applications, and the same address on another interface does not', async () => {
    const apply = insurer();
    expect(await statuses(10, (i) => apply(from(`fe80::${(i + 1).toString(16)}%eth0`)))).toEqual(Array(10).fill(201));
    const eleventh = await apply(from('fe80::9f3c:51ff:fe0a:7d21%eth0'));
    expect([eleventh.status, eleventh.error]).toEqual([429, OPEN_FROM_SOURCE]);   // before: 201, each link-local address a source of its own
    expect((await apply(from('fe80::1%eth1'))).status).toBe(201);
  });

  test('behind a trusted proxy each client it names is a source of its own; behind one the node does not trust, every client is the proxy', async () => {
    const trusting = insurer({ trustedProxies: PROXY });
    expect(await statuses(10, () => trusting(from('127.0.0.1', '198.51.100.1')))).toEqual(Array(10).fill(201));
    const past = await trusting(from('127.0.0.1', '198.51.100.1'));
    expect([past.status, past.error, past.retryAfter]).toEqual([429, OPEN_FROM_SOURCE, '3600']);
    expect((await trusting(from('127.0.0.1', '198.51.100.2'))).status).toBe(201);          // before: 429, every caller was the proxy
    expect((await trusting(from('127.0.0.1', '2001:db8:85a3:12::1'))).status).toBe(201);   // before: 429

    const untrusting = insurer();
    expect(await statuses(10, (i) => untrusting(from('127.0.0.1', `198.51.100.${i + 1}`)))).toEqual(Array(10).fill(201));
    expect((await untrusting(from('127.0.0.1', '198.51.100.99'))).status).toBe(429);
  });

  test('X-Forwarded-For from an address that is not a trusted proxy makes no new source, nor does an entry a client writes ahead of the proxy\'s', async () => {
    const apply = insurer({ trustedProxies: PROXY });
    expect(await statuses(10, (i) => apply(from('192.0.2.50', `198.51.100.${i + 1}`)))).toEqual(Array(10).fill(201));
    expect((await apply(from('192.0.2.50', '198.51.100.99'))).status).toBe(429);
    // The proxy appended 192.0.2.60, the address it took each request from; what the client wrote before it is not read.
    expect(await statuses(10, (i) => apply(from('127.0.0.1', `203.0.113.${i + 1}, 192.0.2.60`)))).toEqual(Array(10).fill(201));
    expect((await apply(from('127.0.0.1', '203.0.113.99, 192.0.2.60'))).status).toBe(429);
  });
});

describe('the insurer\'s card recovery and plans-to-add limits count each client behind a trusted proxy', () => {
  test('one client\'s thirty recovery requests a minute leave every other member\'s card recovery open', async () => {
    const routes = buildInsurerRoutes(nodeFor('insurer', { trustedProxies: PROXY }));
    const release = routeOf(routes, 'POST', '/recovery/release');
    const revoke = routeOf(routes, 'POST', '/recovery/revoke');
    // Malformed, so each is refused 400 once the limit has counted it; release and revoke share the limit.
    const bad = { cardId: 'not-a-card', pinVerifier: 'x' };
    expect(await statuses(30, (i) => call(i % 2 ? revoke : release, from('127.0.0.1', '198.51.100.7'), bad))).toEqual(Array(30).fill(400));
    const spent = await call(release, from('127.0.0.1', '198.51.100.7'), bad);
    expect([spent.status, spent.retryAfter]).toEqual([429, '60']);
    expect((await call(release, from('127.0.0.1', '198.51.100.8'), bad)).status).toBe(400);       // before: 429, one client spent the proxy's thirty
    expect((await call(revoke, from('127.0.0.1', '2001:db8:aa:1::5'), bad)).status).toBe(400);    // before: 429
  });

  test('one client\'s thirty plans-to-add reads a minute leave another\'s open', async () => {
    const routes = buildInsurerRoutes(nodeFor('insurer', { trustedProxies: PROXY }));
    const plans = routeOf(routes, 'GET', '/employer-agreements/:applicationId/plans-to-add');
    const ask = (client: string): Promise<Answer> => call(plans, from('127.0.0.1', client), undefined, { applicationId: 'EMPAPP-NONE' });
    // No insurer node is behind these routes, so each read the limit lets through is answered 503.
    expect(await statuses(30, () => ask('198.51.100.7'))).toEqual(Array(30).fill(503));
    expect((await ask('198.51.100.7')).status).toBe(429);
    expect((await ask('198.51.100.8')).status).toBe(503);                                          // before: 429, every caller was the proxy
  });
});

describe('the employer\'s validate oracle counts each caller as callerKey names it', () => {
  /** Asks the validate oracle of a fresh employer node, whose limits start empty, unsigned: refused 401 once counted. */
  function employer(over: Partial<NautilusAppConfig> = {}): (req: StandIn) => Promise<Answer> {
    const server = nodeFor('employer', over);
    // With no employer node the oracle answers 503 before its limits; anything stands in, since an unsigned request
    // goes no further than the limits and the 401 after them.
    server.setEntityNode({ setWalletSignerSource: () => undefined } as unknown as EntityNodeBase);
    const validate = routeOf(buildEmployerRoutes(server), 'POST', '/tokens/:tokenId/validate');
    return (req) => call(validate, req, { tokenPinHash: 'x' }, { tokenId: 'ABCD-0000-0000-0000-0000' });
  }

  test('an IPv4-mapped caller is the IPv4 address it maps, and two addresses in one IPv6 /64 are one caller', async () => {
    const validate = employer();
    expect(await statuses(60, () => validate(from('203.0.113.7')))).toEqual(Array(60).fill(401));
    expect((await validate(from('::ffff:203.0.113.7'))).status).toBe(429);            // before: 401, the raw address was a caller of its own
    expect(await statuses(60, () => validate(from('2001:db8:1:2::1')))).toEqual(Array(60).fill(401));
    expect((await validate(from('2001:db8:1:2:abcd::99'))).status).toBe(429);         // before: 401, each address of a /64 a caller of its own
    expect((await validate(from('198.51.100.20'))).status).toBe(401);
  });

  test('behind a trusted proxy each client is a caller of its own', async () => {
    const validate = employer({ trustedProxies: ['::1'] });
    expect(await statuses(60, () => validate(from('::1', '198.51.100.7')))).toEqual(Array(60).fill(401));
    expect((await validate(from('::1', '198.51.100.7'))).status).toBe(429);
    expect((await validate(from('::1', '198.51.100.8'))).status).toBe(401);           // before: 429, every caller was the proxy
  });
});

// ── A caller whose socket closes ───────────────────────────

describe('a request keeps the source it arrived from, though its socket closes before a route reads it', () => {
  test('a client that half-closes right after its request is its own source to a route that reads callerKey once the socket has closed', async () => {
    // A response whose socket has closed never finishes, so the node's request budget for it runs to its end; a short
    // budget ends with the test.
    const server = nodeFor('insurer', { requestTimeoutMs: 100 });
    const keyed = new Promise<string>((resolve) => {
      server.registerRoutes([{
        method: 'POST',
        path: '/caller',
        // A route that awaits anything may find the socket closed by the time it reads its caller; this one waits for that.
        handler: async (req, res) => {
          if (!req.socket.destroyed) await new Promise((closed) => req.socket.once('close', closed));
          resolve(server.callerKey(req));
          res.end();
        },
      }]);
    });
    await server.start();
    try {
      const port = server.getPort();
      const client = net.connect(port, '127.0.0.1', () => {
        // The whole request, and the client's end of the connection with it.
        client.end(`POST /caller HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}`);
      });
      client.resume();
      const failed = new Promise<never>((_, reject) => client.on('error', reject));
      expect(await Promise.race([keyed, failed])).toBe('127.0.0.1');   // before: unknown, the closed socket had no address to give
    } finally {
      await server.stop();
    }
  });
});

describe('POST /marketplace/api/apply counts the source an application came from, read before the route asks the sequencer', () => {
  /** What the stand-in sequencer does before it answers: nothing, unless a test has it clear the waiting request's address. */
  let beforeAnswering: () => void = () => undefined;
  let sequencerUrl = '';
  // It knows no employer, so every employerId is free; without a sequencer the route refuses every application.
  const sequencer = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      beforeAnswering();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: null }));
    });
  });
  beforeAll(async () => {
    await new Promise<void>((resolve) => sequencer.listen(0, '127.0.0.1', resolve));
    sequencerUrl = `http://127.0.0.1:${(sequencer.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    sequencer.closeAllConnections();
    await new Promise<void>((resolve) => sequencer.close(() => resolve()));
  });

  test('applications whose socket closes while the sequencer is asked count against the client that sent them, not the key unknown every closed socket shares', async () => {
    getApplicationStore().clear();
    const apply = routeOf(buildMarketplaceRoutes(nodeFor('insurer', { sequencerUrl })), 'POST', '/marketplace/api/apply');
    /** An application from `address` whose socket closes, as a client's that half-closes, while the sequencer is asked. */
    const leaving = async (address: string): Promise<Answer> => {
      const req = from(address);
      beforeAnswering = () => { req.socket.remoteAddress = undefined; };
      try {
        return await call(apply, req, employerApplication());
      } finally {
        beforeAnswering = () => undefined;
      }
    };
    expect(await statuses(3, () => leaving('198.51.100.7'))).toEqual([201, 201, 201]);
    const sources = [...getApplicationStore().values()].map((a) => (a as EmployerApplication & { source?: string }).source);
    expect(sources).toEqual(Array(3).fill('198.51.100.7'));                             // before: unknown three times
    // The same client with its socket open holds three open applications already, as many as one source keeps.
    const fourth = await call(apply, from('198.51.100.7'), employerApplication());
    expect([fourth.status, fourth.error]).toEqual([429, EMPLOYER_OPEN_FROM_SOURCE]);   // before: [201, undefined], a fourth open from one client
    // Another client whose socket closes the same way is a source of its own, not refused for the first one's three.
    expect((await leaving('203.0.113.9')).status).toBe(201);                             // before: 429, unknown held three
  });
});

// ── At boot ────────────────────────────────────────────────

describe('a node bound to loopback that answers a public name warns at boot unless it trusts the proxy its bind is reached from', () => {
  test('isLoopbackBind: localhost, 127.0.0.0/8 and ::1, however written', () => {
    for (const host of ['127.0.0.1', '127.1.2.3', 'localhost', 'LocalHost', '::1', '[::1]', '0:0:0:0:0:0:0:1']) {
      expect([host, isLoopbackBind(host)]).toEqual([host, true]);
    }
    for (const host of ['0.0.0.0', '::', '192.0.2.10', '2001:db8::1', 'node.example', '', undefined]) {
      expect([host, isLoopbackBind(host)]).toEqual([host, false]);
    }
  });

  /** The proxy warnings an insurer node bound to `host`, answering `publicHosts` and trusting `trusted`, gives at boot. */
  function warnings(host: string, trusted: string[], publicHosts: string[] = ['insurer.example']): string[] {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      nodeFor('insurer', { displayName: 'Insurer', host, trustedProxies: trusted, publicHosts });
      return warn.mock.calls.map((args) => util.format(...args)).filter((line) => line.includes('ZKTRIDENT_TRUSTED_PROXIES'));
    } finally {
      warn.mockRestore();
    }
  }

  test('an IPv4 loopback bind asks for 127.0.0.1, and any trusted address in 127.0.0.0/8 is the proxy it is reached from', () => {
    const found = warnings('127.0.0.1', []);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('Insurer is bound to 127.0.0.1 and answers insurer.example');   // before: "bound to loopback", whatever the bind
    expect(found[0]).toContain('every caller counts as the proxy');
    expect(found[0]).toContain('Add 127.0.0.1 to ZKTRIDENT_TRUSTED_PROXIES so the node reads X-Forwarded-For');   // before: "Set ZKTRIDENT_TRUSTED_PROXIES to the proxy's address (127.0.0.1 for a proxy on this host)"
    // A proxy on this host reaches 127.0.0.2 from 127.0.0.1, as it reaches 127.0.0.1.
    expect(warnings('127.0.0.2', [])).toEqual([expect.stringContaining('Add 127.0.0.1 to ZKTRIDENT_TRUSTED_PROXIES so')]);   // before: "Set ZKTRIDENT_TRUSTED_PROXIES to the proxy's address"
    expect(warnings('127.0.0.1', ['127.0.0.1'])).toEqual([]);
    expect(warnings('127.0.0.2', ['127.0.0.1'])).toEqual([]);
    expect(warnings('127.0.0.1', ['127.0.0.2'])).toEqual([]);
    expect(warnings('127.0.0.1', ['::ffff:127.0.0.1'])).toEqual([]);
  });

  test('::1 asks for ::1, and a trusted proxy of the other family, or on another host, silences neither bind', () => {
    for (const host of ['::1', '[::1]', '0:0:0:0:0:0:0:1']) {
      expect([host, warnings(host, ['127.0.0.1'])]).toEqual([host, [expect.stringContaining('Add ::1 to ZKTRIDENT_TRUSTED_PROXIES so')]]);   // before: no warning, any entry silenced it
    }
    expect(warnings('::1', ['127.0.0.1'])).toEqual([expect.stringContaining('Insurer is bound to ::1 and answers insurer.example')]);   // before: no warning
    expect(warnings('::1', ['::1'])).toEqual([]);
    expect(warnings('::1', ['0:0:0:0:0:0:0:1'])).toEqual([]);
    expect(warnings('127.0.0.1', ['::1'])).toEqual([expect.stringContaining('Add 127.0.0.1 to ZKTRIDENT_TRUSTED_PROXIES so')]);   // before: no warning
    expect(warnings('127.0.0.1', ['10.0.0.2'])).toEqual([expect.stringContaining('Add 127.0.0.1 to ZKTRIDENT_TRUSTED_PROXIES so')]);   // before: no warning
  });

  test('localhost, bound to whichever of 127.0.0.1 and ::1 Node resolves first, asks for each of them until both are trusted', () => {
    // Many systems resolve localhost to ::1 first (Node 22 on Windows does), and a proxy then reaches a localhost bind
    // from ::1: had trusting 127.0.0.1 alone silenced the warning, every caller would still be one source.
    const why = '(Node binds localhost to whichever of 127.0.0.1 and ::1 it resolves first)';
    expect(warnings('localhost', [])).toEqual([expect.stringContaining(`Add 127.0.0.1 and ::1 to ZKTRIDENT_TRUSTED_PROXIES ${why}`)]);   // before: it asked for 127.0.0.1 alone
    expect(warnings('LocalHost', ['127.0.0.1'])).toEqual([expect.stringContaining(`Add ::1 to ZKTRIDENT_TRUSTED_PROXIES ${why}`)]);   // before: no warning
    expect(warnings('localhost', ['::1'])).toEqual([expect.stringContaining(`Add 127.0.0.1 to ZKTRIDENT_TRUSTED_PROXIES ${why}`)]);   // before: no warning
    expect(warnings('localhost', ['127.0.0.1', '::1'])).toEqual([]);
  });

  test('a node that answers no public name, or is not bound to loopback, does not warn', () => {
    for (const host of ['127.0.0.1', '::1', 'localhost']) {
      expect([host, warnings(host, [], [])]).toEqual([host, []]);
    }
    for (const host of ['0.0.0.0', '::', '192.0.2.10']) {
      expect([host, warnings(host, [])]).toEqual([host, []]);
    }
  });
});
