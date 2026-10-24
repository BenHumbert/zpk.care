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
 * The insurer's credentialing applications are its staff's to read, and an application holds only what the screens can
 * draw and the sequencer will keep (A-89); no one source can fill the insurer's open applications, and no applicant can
 * hold a provider's NPI by applying under it first, or under a look-alike of it (the reviews of A-89).
 *
 * What was wrong: GET /credentialing/applications took no credential and returned every application whole: the name,
 * NPI, DEA number, state of license and wallet ID each applicant entered. The insurer node's origin also serves the
 * public marketplace, so anyone could read every applicant prescriber's DEA number, the number a forged prescription
 * for a controlled substance needs. POST /credentialing/apply, open as it must be, kept every field unchecked and kept
 * every application in memory with no bound, and an approval sent the applicant's wallet ID on to l2_credentialProvider,
 * which did not hold it to A-74's rule either.
 *
 * The bound that fix set was one a single caller could reach: one anonymous client could file the 1,000 open
 * applications with distinct NPIs in about a second, a slot came back only when staff denied its application, and the
 * client could file again as fast. The first application for an NPI held it against every later one, so the same client
 * could apply under real providers' NPIs (an NPI is public) and lock them out, and the refusal told anyone whether an NPI
 * had an application and in what status. An optional field sent as null was refused 400, though l2_registerEntity and
 * l2_credentialProvider read null as no value.
 *
 * The limit that answered it, 10 applications an hour, counted each raw socket address as a caller of its own and
 * counted applications an hour rather than those open. One IPv6 host, which commonly holds a whole /64 and may use any
 * address in it, or about 100 IPv4 addresses filled all 1,000 slots in seconds, and one address filing its 10 an hour
 * filled them in about 100 hours and kept them full as staff denied. An NPI was any short line of plain text, compared
 * as written, so "1234567893" with a zero-width space or a trailing space was another NPI to the insurer's check, to its
 * 409 and to the sequencer's npiHash index: a squatter's application approved by mistake would credential a wallet under
 * what reads as the genuine NPI. And every test here bound a 127.1.x.y address as its source, which macOS does not give
 * its loopback interface without an alias, so nearly every test failed there.
 *
 * The key that answered the raw address made every link-local caller one source: every host on every link holds
 * addresses in fe80::/64, so all of them keyed as fe80:0:0:0::/64, and one could keep every other from applying. The key
 * that answered that made each link-local address a source of its own, and since nothing assigns those addresses, one
 * host on a link could take as many as it liked and count as that many sources. Once the key changed again, this file
 * still expected a key for each address, and its suite failed.
 *
 * How it was found: the review of the security fixes of 2026-10-24, tracing who chooses each value the insurer's screens
 * put in a button (A-88); the reachable bound, the held NPI and the refused null by the independent review of the A-89
 * fix; the raw-address key, the hourly count, the look-alike NPI and the macOS failures by the second review of it; the
 * link-local key by the review of the per-caller limits, which also found every caller behind a reverse proxy to be one
 * source (tests/node-caller-address.test.ts); the key for each link-local address by the review of the trusted-proxy
 * fix, and the stale expectation here by the review of the fix that followed it.
 *
 * What is true now: the list is adminOnly, and the dashboard sends its token for it. An application's name, specialty,
 * pharmacy type, DEA number and state of license are short lines of plain text, its NPI is ten digits with the check
 * digit CMS defines (npiError), the one form the insurer compares and the sequencer indexes, and its wallet ID, when it
 * gives one, is one as the network writes it; anything else is refused 400 and kept nowhere. An optional field sent as
 * null is one not sent, and the stored application holds no null. A source is the caller's address as addressKey writes
 * it: an IPv4 address, an IPv4-mapped IPv6 address as the IPv4 address it maps, a link-local IPv6 address as fe80::/64
 * on the interface it arrived on (one source for each of the node's links, which every host on that link shares), and
 * any other IPv6 address as its /64. One source keeps at most 10 applications open at once and has at most 20 kept an
 * hour; past either it is answered 429 with Retry-After and a message that names the limit, and other sources still
 * apply. At most 1,000 applications are open at once; past that the route answers 503 with Retry-After until some are
 * decided, and a denial frees a slot. Refusals come in this order: 400, 409, 429, 503. Only an application kept counts
 * against its source; the application keeps its source, and the staff's listing leaves it out. A reverse proxy in front
 * of the node is one source for everyone behind it unless the node lists it in ZKTRIDENT_TRUSTED_PROXIES, and then each
 * caller is the client the proxy names (tests/node-caller-address.test.ts); a client with many sources (a swarm) is the
 * general rate limit's to answer (A-80). An open application leaves its NPI open to the next applicant, and staff
 * verify the genuine one; once one is verified or approved, a new application for that NPI is refused 409 with a
 * message that says only that, and staff can neither verify nor approve another beside it. l2_credentialProvider holds
 * what it writes to the same rule (tests/registry-wallet-id-and-name.test.ts).
 *
 * Each describe has an insurer node of its own, as start-insurer-nautilus serves it, so each starts with fresh limits
 * (buildInsurerRoutes makes them) and sends from 127.0.0.1, one source, within that source's limits. The tests that need
 * sources of their own (one source past its limits beside another, the 1,000-application bound) apply from loopback
 * addresses no other request uses (127.1.x.y, bound as each request's source), which Windows and Linux answer on
 * loopback and macOS does not without an alias, so there they are skipped. No sequencer is behind the nodes but one
 * stand-in, which answers an approval's l2_credentialProvider.
 */
import fs from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import os from 'os';
import path from 'path';
import { Field, Poseidon } from 'o1js';
import { addressKey } from '../src/security/rate-limit.js';

jest.setTimeout(120_000);

const ADMIN = 'insurer-admin-token-for-credentialing';
const NOT_DECIMAL = 'walletId must be a field element written in decimal: digits only, with no leading zero';
const NOT_TEN_DIGITS = 'npi must be a National Provider Identifier: ten digits';
const WRONG_CHECK_DIGIT = 'npi has the wrong check digit for a National Provider Identifier';
const FULL = 'The insurer holds as many open credentialing applications as it keeps: apply again once some are decided';
const OPEN_FROM_SOURCE = 'Too many open credentialing applications from this address. Apply again once the insurer decides one.';
const HOURLY = 'Too many credentialing applications from this address in the last hour. Try again in an hour.';
const TAKEN = 'This NPI is already verified or credentialed with the insurer';
const DENIED = { reason: 'Not a provider the plan credentials' };
/**
 * The loopback address every system has: the staff's reads and decisions come from it, and so does every application a
 * test sends as one source.
 */
const LOOPBACK = '127.0.0.1';

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
let nextNine = 100_000_000;
/** An NPI no other application in this file has used. */
const unique = (): string => withCheckDigit(String(nextNine++));

let callers = 0;
/** A loopback address no request in this file has come from yet, which the insurer node counts as a source of its own. */
const nextCaller = (): string => { const n = callers++; return `127.1.${Math.floor(n / 250)}.${(n % 250) + 1}`; };

/**
 * The tests that need sources of their own. Windows and Linux route all of 127.0.0.0/8 to loopback; macOS gives loopback
 * only 127.0.0.1 unless more addresses are aliased, so binding 127.1.x.y fails there, and these are skipped.
 */
const describeWithManySources = process.platform === 'darwin' ? describe.skip : describe;

interface Answer { status: number; retryAfter: string | undefined; json: any }
type Application = Record<string, unknown> & { applicationId: string; status: string };

/** A request to the insurer node at `port` from the loopback address `from`, which the node reads as the caller's. */
function send(port: number, method: 'GET' | 'POST', route: string, opts: { from: string; body?: unknown; admin?: boolean }): Promise<Answer> {
  const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  const headers: Record<string, string> = {};
  if (payload !== undefined) Object.assign(headers, { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)) });
  if (opts.admin) headers.Authorization = `Bearer ${ADMIN}`;
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: route, headers, localAddress: opts.from, agent: false }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { text += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode ?? 0, retryAfter: res.headers['retry-after'], json: JSON.parse(text) }); } catch (err) { reject(err); }
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

/** An application as a prescriber's office fills it in. */
function application(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { providerType: 'prescriber', npi: '1234567893', displayName: 'Dr. Avery Quill, MD', specialty: 'Family Medicine', deaNumber: 'AQ1234563', stateOfLicense: 'TX', ...over };
}

/**
 * An insurer node for the describe that calls this, started before its tests and stopped after them, as
 * start-insurer-nautilus serves it; `sequencerUrl` names the sequencer its approvals call, read when it starts.
 */
function insurerForThisDescribe(sequencerUrl: () => string = () => 'http://127.0.0.1:1') {
  let server: any;
  let port = 0;
  let dir = '';
  beforeAll(async () => {
    const { NautilusAppServer } = await import('../src/nodes/nautilus-app-server.js');
    const { InsurerNode } = await import('../src/nodes/insurer-node.js');
    const { buildInsurerRoutes } = await import('../src/nodes/routes/insurer-routes.js');
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'insurer-credentialing-'));
    server = new NautilusAppServer({
      role: 'insurer', port: 0, host: '127.0.0.1', sequencerUrl: sequencerUrl(), stateDir: dir,
      enableSSE: false, maxSseConnections: 0, allowedOrigins: [], adminToken: ADMIN,
    } as any);
    server.registerRoutes(buildInsurerRoutes(server));
    server.setEntityNode(new InsurerNode({ role: 'insurer', sequencerUrl: sequencerUrl(), displayName: 'Insurer' } as any));
    await server.start();
    port = server.getPort();
  });
  afterAll(async () => {
    await server?.stop();
    if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
  });

  /** Every application, as the insurer's staff read them. */
  const applications = async (): Promise<Application[]> =>
    (await send(port, 'GET', '/credentialing/applications', { from: LOOPBACK, admin: true })).json.data.applications;
  return {
    /** An application sent from `from`, 127.0.0.1 unless a test needs a source of its own. */
    apply: (body: Record<string, unknown>, from: string = LOOPBACK): Promise<Answer> => send(port, 'POST', '/credentialing/apply', { from, body }),
    /** The list as anyone may ask for it, with the node's admin credential or without. */
    list: (admin: boolean): Promise<Answer> => send(port, 'GET', '/credentialing/applications', { from: LOOPBACK, admin }),
    /** A decision of the insurer's staff on an application, with the node's admin credential. */
    decide: (action: 'verify' | 'approve' | 'deny', applicationId: string, body: Record<string, unknown> = {}): Promise<Answer> =>
      send(port, 'POST', `/credentialing/${action}/${encodeURIComponent(applicationId)}`, { from: LOOPBACK, body, admin: true }),
    applications,
    /** How many applications are neither approved nor denied. */
    openApplications: async (): Promise<number> => (await applications()).filter((a) => a.status !== 'approved' && a.status !== 'denied').length,
  };
}
type Insurer = ReturnType<typeof insurerForThisDescribe>;

/**
 * A stand-in sequencer for the describe that calls this: it answers l2_credentialProvider as the sequencer does when it
 * credentials a provider, keeps the parameters of each such call, and refuses any other method.
 */
function sequencerForThisDescribe() {
  const credentialed: Array<Record<string, unknown>> = [];
  let url = '';
  const server = http.createServer((req, res) => {
    let text = '';
    req.on('data', (chunk) => { text += chunk; });
    req.on('end', () => {
      const call = JSON.parse(text) as { id: number; method: string; params: Record<string, unknown> };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (call.method !== 'l2_credentialProvider') {
        res.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, error: { code: -32601, message: `not stubbed: ${call.method}` } }));
        return;
      }
      credentialed.push(call.params);
      const { walletId, displayName, providerType } = call.params;
      res.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, result: { ok: true, leafIndex: String(credentialed.length - 1), walletId, displayName, providerType, credentialState: '2' } }));
    });
  });
  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    if (!server.listening) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { credentialed, url: () => url };
}

/** Fills the insurer's open applications up to `limit`, ten from each new source, a hundred at a time. */
async function fillTo(insurer: Insurer, limit: number): Promise<void> {
  for (let open = await insurer.openApplications(); open < limit;) {
    const round = Math.min(100, limit - open);
    const from = Array.from({ length: Math.ceil(round / 10) }, nextCaller);
    const sent = await Promise.all(Array.from({ length: round }, (_, i) => insurer.apply(application({ npi: unique() }), from[Math.floor(i / 10)])));
    expect(sent.map((r) => r.status)).toEqual(Array(round).fill(201));
    open += round;
  }
}

describe('addressKey: the source a per-caller limit counts', () => {
  test('an IPv4 address is its own key, and an IPv4-mapped IPv6 address, however written, is the IPv4 address it maps', () => {
    expect(addressKey('203.0.113.7')).toBe('203.0.113.7');
    expect(addressKey('::ffff:203.0.113.7')).toBe('203.0.113.7');          // before: the raw address, a caller apart from 203.0.113.7
    expect(addressKey('::FFFF:203.0.113.7')).toBe('203.0.113.7');
    expect(addressKey('::ffff:cb00:7107')).toBe('203.0.113.7');
  });

  test('two IPv6 addresses in one /64 share a key, and addresses in different /64s do not', () => {
    expect(addressKey('2001:db8:85a3:12::1')).toBe('2001:db8:85a3:12::/64');
    expect(addressKey('2001:db8:85a3:12:9f3c:51ff:fe0a:7d21')).toBe('2001:db8:85a3:12::/64');   // before: the raw address, so one /64 was as many callers as it has addresses
    expect(addressKey('2001:db8:85a3:13::1')).toBe('2001:db8:85a3:13::/64');
  });

  test('a compressed and an expanded form of one address agree', () => {
    expect(addressKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(addressKey('2001:0DB8:0000:0000:0000:0000:0000:0001')).toBe('2001:db8:0:0::/64');   // before: the raw text, a caller apart from its compressed form
    expect(addressKey('::1')).toBe(addressKey('0:0:0:0:0:0:0:1'));
  });

  test('a link-local IPv6 address is fe80::/64 on the interface it arrived on: one key for each of the node\'s links, which every host on that link shares', () => {
    expect(addressKey('fe80::1%eth0')).toBe('fe80::/64%eth0');                 // before: fe80::1%eth0, each address a key of its own; under the /64 rule fe80:0:0:0::/64, one key for every link
    expect(addressKey('fe80::2%eth0')).toBe('fe80::/64%eth0');                 // before: fe80::2%eth0
    expect(addressKey('FE80:0:0:0:0:0:0:1%eth0')).toBe('fe80::/64%eth0');      // before: fe80::1%eth0
    expect(addressKey('fe80::1%eth1')).toBe('fe80::/64%eth1');                 // before: fe80::1%eth1
    expect(addressKey('fe80::1%eth1')).not.toBe(addressKey('fe80::1%eth0'));   // another link is another key: the interface is this host's to name
    expect(addressKey('fe80::a:b:c:d%12')).toBe('fe80::/64%12');               // before: fe80::a:b:c:d%12; Windows numbers its interfaces
    expect(addressKey('fe80::1')).toBe('fe80::/64');                           // before: fe80::1; a proxy may name a link-local client with no interface
    expect(addressKey('febf:0:0:0:1::1')).toBe('fe80::/64');                   // before: febf::1:0:0:1; all of fe80::/10 is link-local
    expect(addressKey('fec0::1')).toBe('fec0:0:0:0::/64');                     // past it, the /64 rule
    expect(addressKey('2001:db8:85a3:12::1%eth0')).toBe('2001:db8:85a3:12::/64');
  });

  test('no address, or text that is not one, is the one key unknown', () => {
    expect(addressKey(undefined)).toBe('unknown');
    for (const text of ['', 'localhost', '256.0.0.1', '127.0.0.01', '1.2.3', '1::2::3', '1:2:3:4:5:6:7:8:9', '12345::1', '::ffff:256.0.0.1']) {
      expect([text, addressKey(text)]).toEqual([text, 'unknown']);
    }
  });
});

describe('GET /credentialing/applications', () => {
  const insurer = insurerForThisDescribe();

  test('answers the insurer\'s admin credential only, and leaves out the address each application came from', async () => {
    expect((await insurer.apply(application())).status).toBe(201);
    const anonymous = await insurer.list(false);
    expect(anonymous.status).toBe(401);                                       // before: 200, with every applicant's DEA number
    expect(JSON.stringify(anonymous.json)).not.toContain('AQ1234563');
    const staff = await insurer.list(true);
    expect(staff.status).toBe(200);
    expect(staff.json.data.applications.map((a: { deaNumber?: string }) => a.deaNumber)).toEqual(['AQ1234563']);
    expect(staff.json.data.applications.flatMap((a: Application) => Object.keys(a))).not.toContain('source');
    expect(JSON.stringify(staff.json)).not.toContain(LOOPBACK);
  });

  test('the insurer\'s dashboard sends its token for it', () => {
    const rpc = fs.readFileSync('dashboard-insurer/rpc.js', 'utf8');
    expect(rpc).toContain("return request('GET', '/credentialing/applications' + q, undefined, true);");   // before: no token
  });
});

describe('POST /credentialing/apply: what an application holds', () => {
  const insurer = insurerForThisDescribe();

  test('refuses a field the screens cannot draw or the sequencer will not keep, and keeps nothing', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ displayName: '<img src=x onerror=steal()>' }, 'displayName may not contain < or >'],
      [{ displayName: 'Dr. Quill\nMD' }, 'displayName may not contain control characters'],
      [{ deaNumber: 'AQ123\u00004563' }, 'deaNumber may not contain control characters'],
      [{ specialty: 'Family <b>Medicine</b>' }, 'specialty may not contain < or >'],
      [{ stateOfLicense: 7 }, 'stateOfLicense must be text'],
      [{ walletId: '0x1f' }, NOT_DECIMAL],
      [{ walletId: '1" onmouseover="steal()' }, NOT_DECIMAL],
    ];
    const before = await insurer.openApplications();
    for (const [over, why] of cases) {
      const r = await insurer.apply(application({ npi: unique(), ...over }));
      expect([over, r.status, r.json.error]).toEqual([over, 400, why]);        // before: 201, kept as sent
    }
    expect(await insurer.openApplications()).toBe(before);
  });

  test('refuses an NPI with a zero-width space, a trailing space, a digit short or the wrong check digit: each reads as an NPI on a screen and is another string to the insurer and the sequencer', async () => {
    const before = await insurer.openApplications();
    const cases: Array<[string, string]> = [
      ['1234567893\u200b', NOT_TEN_DIGITS],
      ['1234567893 ', NOT_TEN_DIGITS],
      ['123456789', NOT_TEN_DIGITS],
      ['1234567890', WRONG_CHECK_DIGIT],
    ];
    for (const [npi, why] of cases) {
      const r = await insurer.apply(application({ npi }));
      expect([JSON.stringify(npi), r.status, r.json.error]).toEqual([JSON.stringify(npi), 400, why]);   // before: 201, kept as an NPI of its own
    }
    expect(await insurer.openApplications()).toBe(before);                    // before: four more
    expect((await insurer.apply(application({ npi: '1245319599' }))).status).toBe(201);
  });

  test('takes what a provider sends: punctuation in a name, a pharmacy type, and a wallet ID as the network writes one', async () => {
    const walletId = Poseidon.hash([Field(43), Field(47)]).toString();
    const r = await insurer.apply({ providerType: 'pharmacy', npi: unique(), displayName: "O'Brien & Sons Pharmacy #12", pharmacyType: 'Community/Retail Pharmacy', stateOfLicense: 'TX', walletId });
    expect([r.status, r.json.error]).toEqual([201, undefined]);
  });

  test('reads null in an optional field as no value, and keeps no null', async () => {
    const r = await insurer.apply({ providerType: 'pharmacy', npi: unique(), displayName: 'Vale Street Pharmacy', specialty: null, pharmacyType: null, deaNumber: null, stateOfLicense: null, walletId: null });
    expect([r.status, r.json.error]).toEqual([201, undefined]);              // before: 400, 'specialty must be text'
    const kept = (await insurer.applications()).find((a) => a.applicationId === r.json.data.applicationId) ?? {};
    expect(Object.keys(kept).sort()).toEqual(['applicationId', 'displayName', 'npi', 'providerType', 'status', 'submittedAt']);
    expect(Object.values(kept)).not.toContain(null);
  });
});

describe('POST /credentialing/apply: who holds an NPI', () => {
  const sequencer = sequencerForThisDescribe();
  const insurer = insurerForThisDescribe(sequencer.url);

  test('an open application leaves its NPI open to the next applicant; once one is verified the NPI is taken, and the refusal says only that', async () => {
    const npi = unique();
    const first = await insurer.apply(application({ npi, displayName: 'Dr. A. Quill' }));
    const second = await insurer.apply(application({ npi }));
    expect([first.status, second.status]).toEqual([201, 201]);              // before: [201, 409], the first application held the NPI
    expect((await insurer.decide('verify', second.json.data.applicationId)).status).toBe(200);
    const third = await insurer.apply(application({ npi }));
    expect([third.status, third.json.error]).toEqual([409, TAKEN]);        // before: 409, 'NPI <npi> already has a pending application'
  });

  test('once one application for an NPI is verified, the insurer\'s staff can neither verify nor approve another for it', async () => {
    const npi = unique();
    const genuine = await insurer.apply(application({ npi }));
    const squatter = await insurer.apply(application({ npi, displayName: 'Dr. A. Quill', walletId: Poseidon.hash([Field(53), Field(59)]).toString() }));
    expect([genuine.status, squatter.status]).toEqual([201, 201]);          // before: [201, 409]
    expect((await insurer.decide('verify', genuine.json.data.applicationId)).status).toBe(200);
    const why = `Application ${genuine.json.data.applicationId} for the same NPI is already verified`;
    const verify = await insurer.decide('verify', squatter.json.data.applicationId);
    expect([verify.status, verify.json.error]).toEqual([409, why]);        // before the check: 200, two verified applications for one NPI
    const approve = await insurer.decide('approve', squatter.json.data.applicationId);
    expect([approve.status, approve.json.error]).toEqual([409, why]);      // before the check: 502, the squatter's wallet sent on to the sequencer
    expect(sequencer.credentialed).toEqual([]);
  });

  test('an approved application holds its NPI: staff can verify no other application for it, and a new one is refused 409', async () => {
    const npi = unique();
    const walletId = Poseidon.hash([Field(61), Field(67)]).toString();
    const genuine = await insurer.apply(application({ npi, walletId }));
    const other = await insurer.apply(application({ npi, displayName: 'Dr. A. Quill' }));
    expect([genuine.status, other.status]).toEqual([201, 201]);
    const approved = await insurer.decide('approve', genuine.json.data.applicationId);
    expect([approved.status, approved.json.data?.status]).toEqual([200, 'approved']);
    expect(sequencer.credentialed.map((p) => [p.npi, p.walletId])).toEqual([[npi, walletId]]);
    const verify = await insurer.decide('verify', other.json.data.applicationId);
    expect([verify.status, verify.json.error]).toEqual([409, `Application ${genuine.json.data.applicationId} for the same NPI is already approved`]);
    const again = await insurer.apply(application({ npi }));
    expect([again.status, again.json.error]).toEqual([409, TAKEN]);
  });
});

describe('POST /credentialing/apply: one source\'s open applications', () => {
  const insurer = insurerForThisDescribe();

  test('a source keeps at most 10 applications open: the next is refused 429 with Retry-After until staff deny one, and is then kept', async () => {
    const kept = await Promise.all(Array.from({ length: 10 }, () => insurer.apply(application({ npi: unique() }))));
    expect(kept.map((r) => r.status)).toEqual(Array(10).fill(201));
    const eleventh = await insurer.apply(application({ npi: unique() }));
    expect([eleventh.status, eleventh.json.error, eleventh.retryAfter]).toEqual([429, OPEN_FROM_SOURCE, '3600']);   // before: 429 for ten an hour, whether open or not
    expect((await insurer.decide('deny', kept[0].json.data.applicationId, DENIED)).status).toBe(200);
    expect((await insurer.apply(application({ npi: unique() }))).status).toBe(201);   // before: 429, the hour's ten spent though staff had denied one
    const next = await insurer.apply(application({ npi: unique() }));
    expect([next.status, next.json.error, next.retryAfter]).toEqual([429, OPEN_FROM_SOURCE, '3600']);   // before: 429 for ten an hour
    expect(await insurer.openApplications()).toBe(10);
  });
});

describe('POST /credentialing/apply: one source\'s hour', () => {
  const insurer = insurerForThisDescribe();

  test('keeps at most 20 applications an hour from one source, counting only those kept, and past that answers 429 with Retry-After though staff denied the rest', async () => {
    const taken = unique();
    const holder = await insurer.apply(application({ npi: taken }));
    expect((await insurer.decide('verify', holder.json.data.applicationId)).status).toBe(200);
    for (let i = 0; i < 3; i++) expect((await insurer.apply(application({ npi: unique(), stateOfLicense: '<TX>' }))).status).toBe(400);
    expect((await insurer.apply(application({ npi: taken }))).status).toBe(409);
    // Nine kept and denied, twice over: with the holder, nineteen kept this hour and one open.
    for (let round = 0; round < 2; round++) {
      const kept = await Promise.all(Array.from({ length: 9 }, () => insurer.apply(application({ npi: unique() }))));
      expect(kept.map((r) => r.status)).toEqual(Array(9).fill(201));      // before: the second round refused 429, ten an hour from one address
      for (const r of kept) expect((await insurer.decide('deny', r.json.data.applicationId, DENIED)).status).toBe(200);
    }
    expect((await insurer.apply(application({ npi: unique() }))).status).toBe(201);
    const past = await insurer.apply(application({ npi: unique() }));
    expect([past.status, past.json.error, past.retryAfter]).toEqual([429, HOURLY, '3600']);   // before: 429 at the eleventh, ten an hour
    expect(await insurer.openApplications()).toBe(2);
  });
});

describeWithManySources('POST /credentialing/apply from sources of their own (127.1.x.y; skipped on macOS, whose loopback is only 127.0.0.1)', () => {
  const insurer = insurerForThisDescribe();
  let atItsLimit = '';

  test('one source past its limit leaves another free to apply', async () => {
    atItsLimit = nextCaller();
    const kept = await Promise.all(Array.from({ length: 10 }, () => insurer.apply(application({ npi: unique() }), atItsLimit)));
    expect(kept.map((r) => r.status)).toEqual(Array(10).fill(201));
    expect((await insurer.apply(application({ npi: unique() }), atItsLimit)).status).toBe(429);
    expect((await insurer.apply(application({ npi: unique() }), nextCaller())).status).toBe(201);
  });

  test('keeps at most 1,000 applications open, ten from each of 100 sources, and past that answers 503 with Retry-After', async () => {
    await fillTo(insurer, 1_000);
    const past = await insurer.apply(application({ npi: unique() }), nextCaller());
    expect([past.status, past.json.error]).toEqual([503, FULL]);
    expect(past.retryAfter).toBe('3600');                                   // before: no Retry-After
    expect(await insurer.openApplications()).toBe(1_000);
  });

  test('with every slot taken, what an application says and what its source has filed are answered first: 400, then 409, then 429, then 503', async () => {
    await fillTo(insurer, 1_000);
    const [first] = await insurer.applications();
    expect((await insurer.decide('verify', first.applicationId)).status).toBe(200);
    const fresh = nextCaller();
    expect((await insurer.apply(application({ npi: unique(), stateOfLicense: '<TX>' }), fresh)).status).toBe(400);
    const held = await insurer.apply(application({ npi: first.npi }), fresh);
    expect([held.status, held.json.error]).toEqual([409, TAKEN]);         // before: 503, the store's bound was answered first
    const full = await insurer.apply(application({ npi: unique() }), atItsLimit);
    expect([full.status, full.json.error]).toEqual([429, OPEN_FROM_SOURCE]);   // before: 503
    expect((await insurer.apply(application({ npi: unique() }), fresh)).status).toBe(503);
  });

  test('a denied application frees its slot for the next applicant, and a source refused while every slot was taken has nothing counted against it', async () => {
    await fillTo(insurer, 1_000);
    const waiting = nextCaller();
    for (let i = 0; i < 21; i++) expect((await insurer.apply(application({ npi: unique() }), waiting)).status).toBe(503);
    const pending = (await insurer.applications()).filter((a) => a.status === 'pending');
    expect((await insurer.decide('deny', pending[pending.length - 1].applicationId, DENIED)).status).toBe(200);
    expect((await insurer.apply(application({ npi: unique() }), waiting)).status).toBe(201);
    expect((await insurer.apply(application({ npi: unique() }), nextCaller())).status).toBe(503);
  });
});
