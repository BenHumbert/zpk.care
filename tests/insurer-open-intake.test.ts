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
 * Two of the insurer node's open routes answer each source on its own, so one caller cannot spend for everyone what
 * every caller shares: the enrollment-code redemption, which relays each code to the issuing employer signed as the
 * insurer, and the marketplace's employer application, which keeps what it is sent.
 *
 * What was wrong: POST /enrollment/process had no per-caller limit. It sends every code that passes its own checks to
 * the issuing employer's validate oracle, signed as the insurer, and the employer counts the insurer as one caller,
 * allowed 60 calls a minute. One outside client sending a junk code a second spent that allowance, and every member's
 * enrollment with that employer was answered 502 (the employer returned 429) for as long as the client kept going;
 * nothing was kept, so it cost the client nothing. POST /marketplace/api/apply had one limit for the whole route, ten
 * applications kept a minute whoever sent them, and no bound on the applications kept. One client sending ten
 * well-formed applications a minute (a fresh employerId, any 64-hex key) had every real employer refused 429, and each
 * of its own was kept: written to marketplace-applications.json, the whole file rewritten each time, and listed for the
 * insurer's staff to review, up to 14,400 a day.
 *
 * How it was found: the review of the insurer node's open routes of 2026-10-24, which confirmed both; each is older
 * than the hardening program.
 *
 * What is true now: a source is the caller as NautilusAppServer.callerKey writes it (tests/node-caller-address.test.ts).
 * The redemption route sends employers at most 10 codes a minute from one source; past that it answers 429 with
 * Retry-After and relays nothing, while other sources' codes still reach the employer. A request refused for what it
 * says, and a repeat of a redeemed code with its PIN hash (answered from the record), count against nothing. The apply
 * route keeps at most 3 open applications from one source and at most 6 from it in an hour; past either it answers 429
 * with Retry-After and a message that names the limit, and other sources still apply. An application is open while it
 * waits on the insurer (submitted, under_review, needs_documents), so one approved, signed, activated or denied frees
 * its source's slot. At most 1,000 applications are open at once, whoever filed them; past that the route answers 503
 * with Retry-After until one is decided. Refusals come in this order: 400, 409, 429, 503, and a refused application
 * counts against nothing. Applications sent together are counted one after another, never all against one count. An
 * application keeps its source, in the file as well, so the limits hold across a restart, and neither the staff's
 * listing nor the employer's status shows it. The route-wide limit is gone.
 *
 * The tests call the handlers buildInsurerRoutes, buildMarketplaceRoutes and buildEmployerAdminRoutes make on a real
 * NautilusAppServer, never started, with stand-in requests whose socket address each test sets, as
 * tests/node-caller-address.test.ts does; the staff's decisions are called the same way, past the admin gate the server
 * applies in front of them. The redemption's employer is a stand-in validate endpoint that answers every code "Token
 * not found", as an employer answers a junk code, unless a test has it issue one; the marketplace's sequencer is a
 * stand-in that knows no employer, so every employerId is free. The marketplace keeps its applications in one store for
 * the module, which each test empties first; the 1,000 open applications are put in the store directly, as a restart
 * loads them from the file, and the route is then asked for more.
 *
 * The review of those fixes, the same day, found two more things wrong with the redemption. The insurer signs each
 * relay with Ed25519 over the method, the path, the time in milliseconds and the body's hash, and Ed25519 is
 * deterministic, so one code and PIN hash relayed twice in a millisecond went to the employer as two byte-identical
 * requests. The employer answered the first, refused the second 401 as a replay ("this signature has already been
 * presented") and charged it to the insurer's caller key there (127.0.0.1, for a tenant the insurer reaches on
 * loopback), and once 60 such were charged in a minute it refused the insurer's genuine relays before checking their
 * signatures. So many sources sending one junk code at once, each inside its ten a minute, failed every member's
 * enrollment with that employer for the minute. And the member's device answered the insurer's 429 as it answers a
 * refusal, "The insurer did not accept this enrollment code and PIN.", with no Retry-After: a member who was only
 * limited was told the code and PIN were refused, and might try other PINs until the employer locked the code, which it
 * does after five wrong ones.
 *
 * What is true now: every relay carries a fresh random nonce, which the employer's validate route does not read, so no
 * two relays share a signature. A real employer node answers each copy on its merits and charges none of them to the
 * insurer, and the insurer's next relay is answered. The device answers the insurer's 429 with 429, a message that says
 * too many enrollment attempts came from this network and to try again in a minute, and the insurer's Retry-After;
 * every other refusal keeps the message it had.
 *
 * In those tests the route that sends is called directly, as above, and the node it reaches is real and listening on
 * loopback. The employer is a real employer node, its routes as buildEmployerRoutes makes them, with an attestation
 * that names the insurer's key and one code issued; its validate route notes the signature each request carried and
 * the status it answered, and its check is untouched. The clock is held at one millisecond while the copies are
 * relayed. The member's device is a member node with a code accepted and its key generated, whose redeem route calls a
 * real insurer node, which relays to a stand-in employer that issued nothing.
 *
 * The review of that fix (A-93) found the device still answered the insurer's 5xx as a refusal. The insurer answers 502
 * when the employer refused it, could not be reached or was busy, or the sequencer could not be reached, and 503 when no
 * employer is registered yet; none of them is a verdict on the code and PIN, and the device answered each 403, "The
 * insurer did not accept this enrollment code and PIN.", so a member whose code was fine was told it was refused and
 * might try other PINs until the employer locked the code. What is true now: the device answers the insurer's 5xx with
 * 502, a message that says the insurer could not check the code now and to try again later, and the insurer's
 * Retry-After when it sends one in seconds. The device stays where it was, so the same PIN is redeemed once the insurer
 * can check it. A 4xx refusal keeps the refused message. In those tests the insurer is a real insurer node relaying to an
 * employer that is not listening, to a stand-in employer that answers 429 or 503, or, with no employer configured, to
 * the employers a stand-in sequencer lists, which are none; one stand-in insurer answers 503 with a Retry-After.
 */
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import type { IncomingMessage, ServerResponse } from 'http';
import { NautilusAppServer } from '../src/nodes/nautilus-app-server.js';
import { buildInsurerRoutes } from '../src/nodes/routes/insurer-routes.js';
import { buildEmployerRoutes } from '../src/nodes/routes/employer-routes.js';
import { buildMemberRoutes } from '../src/nodes/routes/member-routes.js';
import { buildEmployerAdminRoutes, buildMarketplaceRoutes, getApplicationStore } from '../src/nodes/routes/marketplace-routes.js';
import type { NautilusAppConfig, RouteRegistration } from '../src/nodes/nautilus-app-types.js';
import type { EntityNodeBase } from '../src/nodes/entity-node-base.js';
import type { EmployerNode } from '../src/nodes/employer-node.js';
import type { EmployerApplication, EmployerApplicationStatus, EmployerAttestation } from '../src/l2/l2-types.js';
import { generateEnrollmentCode } from '../src/onboarding/enrollment-code.js';
import { insurerPublicKeyFromSeed } from '../src/onboarding/employer-attestation.js';

jest.setTimeout(60_000);

const NOT_RECOGNIZED = 'Enrollment denied: this enrollment code is not recognized by its employer.';
const TOO_MANY_CODES = 'Too many enrollment codes from this address in the last minute. Try again in a minute.';
/** What a member's device answers when the insurer refuses its code and PIN. */
const REFUSED = 'The insurer did not accept this enrollment code and PIN.';
/** What a member's device answers when the insurer's per-source limit refuses it. */
const TOO_MANY_ATTEMPTS = 'Too many enrollment attempts came from this network. Try again in a minute.';
/** What a member's device answers when the insurer answers 5xx: an employer or the sequencer did not answer it, or no employer is registered. */
const COULD_NOT_CHECK = 'The insurer could not check this enrollment code now. Try again later.';
/** The insurer's request-signing seed. The real employer node's attestation names the key it derives. */
const INSURER_SEED = 'insurer-signing-seed-for-open-intake';
const OPEN_FROM_SOURCE = 'Too many open employer applications from this address. Apply again once the insurer decides one.';
const HOURLY = 'Too many employer applications from this address in the last hour. Try again in an hour.';
const FULL = 'The insurer holds as many open employer applications as it keeps: apply again once some are decided';
/** What the apply route answered every caller once any ten applications had been kept in a minute. */
const ROUTE_WIDE = 'Too many applications. Try again in a minute.';
/** The address the insurer's staff decide from. No application in this file comes from it. */
const STAFF = '127.0.0.1';

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
});

/**
 * A node of `role` that is not started unless a test starts it: otherwise its routes are called directly. It trusts no
 * proxy, whatever this process's environment holds.
 */
function appNode(role: NautilusAppConfig['role'], over: Partial<NautilusAppConfig> = {}): NautilusAppServer {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-intake-'));
  dirs.push(dir);
  return new NautilusAppServer({
    role, port: 0, host: '127.0.0.1', sequencerUrl: 'http://127.0.0.1:1', stateDir: dir,
    enableSSE: false, maxSseConnections: 0, allowedOrigins: [], adminToken: 'admin-token-for-open-intake',
    publicHosts: [], trustedProxies: [], ...over,
  } as NautilusAppConfig);
}
const insurerNode = (over: Partial<NautilusAppConfig> = {}): NautilusAppServer => appNode('insurer', over);

/** Enough of a request for a handler: a socket at `remoteAddress`. */
const from = (remoteAddress: string) => ({ url: '/', headers: {}, socket: { remoteAddress } });
type StandIn = ReturnType<typeof from>;

interface Answer { status: number; retryAfter: string | undefined; error: string | undefined; data: any }

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
  const json = (text ? JSON.parse(text) : {}) as { error?: string; data?: unknown };
  return { status, retryAfter: headers['retry-after'], error: json.error, data: json.data };
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

/** How a stand-in answers one request: a status, any headers beside the JSON content type, and a JSON body. */
interface Reply { status: number; headers?: Record<string, string>; body: unknown }

/**
 * A JSON service on loopback, started before the tests of the block that calls this (a describe, or the whole file) and
 * stopped after them, that answers each request as `reply` says for its path.
 */
function replying(reply: (path: string) => Reply) {
  let url = '';
  const service = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const r = reply(req.url ?? '/');
      res.writeHead(r.status, { 'Content-Type': 'application/json', ...r.headers });
      res.end(JSON.stringify(r.body));
    });
  });
  beforeAll(async () => {
    await new Promise<void>((resolve) => service.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(service.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    service.closeAllConnections();
    await new Promise<void>((resolve) => service.close(() => resolve()));
  });
  return { url: () => url };
}

/** A stand-in, as replying makes one, that answers every request 200 with what `answer` returns for its path. */
function standIn(answer: (path: string) => unknown) {
  return replying((p) => ({ status: 200, body: answer(p) }));
}

/**
 * A fresh insurer node, whose limits start empty, that relays the codes it is sent to the employer at `employerUrl`, or
 * with none, to the employer the sequencer it is configured with lists for the code.
 */
function relayingInsurer(employerUrl: string | undefined, over: Partial<NautilusAppConfig> = {}): NautilusAppServer {
  const server = insurerNode({ ...(employerUrl ? { employerUrl } : {}), insurerSigningSeed: INSURER_SEED, ...over });
  // The route refuses until an insurer node is configured and reads nothing from it, so anything stands in.
  server.setEntityNode({ setWalletSignerSource: () => undefined } as unknown as EntityNodeBase);
  return server;
}

/** The redemption route of a fresh relaying insurer, called directly. */
function redemptionAt(employerUrl: string): (req: StandIn, body: unknown) => Promise<Answer> {
  const route = routeOf(buildInsurerRoutes(relayingInsurer(employerUrl)), 'POST', '/enrollment/process');
  return (req, body) => call(route, req, body);
}

// ── The enrollment-code redemption ──────────────────────────

describe('POST /enrollment/process: the codes one source may have the insurer ask an employer about', () => {
  /** Each code the stand-in employer was asked about, in order. */
  const asked: string[] = [];
  /** The codes the stand-in employer issued. */
  const issued = new Set<string>();
  const employer = standIn((p) => {
    const code = decodeURIComponent(/^\/tokens\/([^/]+)\/validate$/.exec(p)?.[1] ?? '');
    asked.push(code);
    return { ok: true, data: issued.has(code) ? { valid: true, groupIdHash: '11', planIdHash: '22', consumed: true } : { valid: false, reason: 'Token not found' } };
  });

  /** The redemption route of a fresh insurer node, whose limits start empty, with the stand-in configured as its employer. */
  const redemption = () => redemptionAt(employer.url());
  /** A code no employer issued, as a client trying codes sends one. */
  const junk = () => ({ tokenId: generateEnrollmentCode('EMP-NOBODY'), tokenPinHash: '4242' });

  test('a source past ten codes a minute is answered 429 with Retry-After and relays nothing, and another source\'s code still reaches the employer', async () => {
    const redeem = redemption();
    const before = asked.length;
    expect(await statuses(10, () => redeem(from('198.51.100.7'), junk()))).toEqual(Array(10).fill(403));
    expect(asked.length - before).toBe(10);
    const past = await redeem(from('198.51.100.7'), junk());
    expect([past.status, past.error, past.retryAfter]).toEqual([429, TOO_MANY_CODES, '60']);   // before: [403, NOT_RECOGNIZED, undefined], the code relayed
    expect(asked.length - before).toBe(10);                                                     // before: 11
    const other = await redeem(from('198.51.100.8'), junk());
    expect([other.status, other.error]).toEqual([403, NOT_RECOGNIZED]);
    expect(asked.length - before).toBe(11);                                                     // before: 12
  });

  test('two addresses in one IPv6 /64 are one source, and an address in another /64 is another', async () => {
    const redeem = redemption();
    const sent = await statuses(10, (i) => redeem(from(i % 2 ? '2001:db8:85a3:12::1' : '2001:db8:85a3:12:9f3c:51ff:fe0a:7d21'), junk()));
    expect(sent).toEqual(Array(10).fill(403));
    expect((await redeem(from('2001:db8:85a3:12::2'), junk())).status).toBe(429);   // before: 403, relayed
    expect((await redeem(from('2001:db8:85a3:13::1'), junk())).status).toBe(403);
  });

  test('a request refused for what it says, and a repeat of a redeemed code with its PIN hash, which is answered from the record, count against nothing', async () => {
    const redeem = redemption();
    const source = from('203.0.113.20');
    // What the pharmacy and prescriber nodes send when they enroll (a wallet and a code, no PIN hash), and no code at all.
    for (let i = 0; i < 6; i++) {
      expect((await redeem(source, { walletId: '42', tokenId: generateEnrollmentCode('EMP-NOBODY'), role: 'pharmacy' })).status).toBe(400);
      expect((await redeem(source, { tokenPinHash: '4242' })).status).toBe(400);
    }
    const code = generateEnrollmentCode('EMP-ISSUER');
    issued.add(code);
    const before = asked.length;
    const first = await redeem(source, { tokenId: code, tokenPinHash: '4242' });
    expect([first.status, first.data?.redeemed]).toEqual([200, true]);
    for (let i = 0; i < 12; i++) {
      const again = await redeem(source, { tokenId: code, tokenPinHash: '4242' });
      expect([again.status, again.data?.repeated]).toEqual([200, true]);
    }
    expect(asked.length - before).toBe(1);
    // One redemption counted, so nine more codes go to the employer and the next is refused.
    expect(await statuses(9, () => redeem(source, junk()))).toEqual(Array(9).fill(403));
    expect(asked.length - before).toBe(10);
    const past = await redeem(source, junk());
    expect([past.status, past.retryAfter]).toEqual([429, '60']);   // before: [403, undefined], relayed
    expect(asked.length - before).toBe(10);                        // before: 11
  });
});

// ── Relays of one code signed in one millisecond ────────────

/** An attestation as the employer node loads it from the sequencer; the validate route reads the insurer's key from it. */
function attestationFor(employerId: string, insurerPublicKeyHex: string): EmployerAttestation {
  return {
    v: 2, employerId, publicKeyHex: 'b'.repeat(64), authorizedPlanIds: ['PLAN-1'], enrollmentCap: 0,
    agreementCommitment: '1', documentHash: '2', effectiveDate: '20260101',
    employerSignature: 'c'.repeat(128), insurerSignature: 'd'.repeat(128), insurerPublicKeyHex,
    ts: 1792200000, applicationId: 'EMPAPP-relay', attestationSeq: 1, signerName: 'Test', signerTitle: 'Test',
  };
}

/** A request the employer node's validate route received: the signature it carried and the status the route answered. */
interface Received { signature: string; status: number }

/**
 * An employer node started on loopback, as the insurer reaches a tenant it spawned: its routes as buildEmployerRoutes
 * makes them, an attestation that names the insurer's key, and one code issued, bound to `pinHash`. Its validate route
 * notes what each request carried and how the route answered it; the route's own check is untouched.
 */
async function startedEmployer(pinHash: string): Promise<{ url: string; code: string; received: Received[]; stop: () => Promise<void> }> {
  const server = appNode('employer');
  const routes = buildEmployerRoutes(server);
  // The employer's HR Tool, on the employer's own host.
  const hr = from('127.0.0.1');
  expect((await call(routeOf(routes, 'POST', '/onboarding/configure'), hr, { employerId: 'EMP-RELAY' })).status).toBe(200);
  (server.getEntityNode() as EmployerNode).setAttestation(attestationFor('EMP-RELAY', insurerPublicKeyFromSeed(INSURER_SEED)));
  expect((await call(routeOf(routes, 'POST', '/groups'), hr, { groupId: 'G1', planId: 'PLAN-1', effectiveDate: '20260101' })).status).toBe(201);
  const issued = await call(routeOf(routes, 'POST', '/tokens/generate'), hr, { groupId: 'G1', employeeIdHash: 'employee-hash-1', validUntil: '20991231' });
  expect(issued.status).toBe(201);
  const code = issued.data.tokenId as string;
  expect((await call(routeOf(routes, 'POST', '/tokens/:tokenId/set-pin-hash'), hr, { tokenPinHash: pinHash }, { tokenId: code })).status).toBe(200);
  const received: Received[] = [];
  const validate = routeOf(routes, 'POST', '/tokens/:tokenId/validate');
  server.registerRoutes(routes.map((r): RouteRegistration => r !== validate ? r : {
    ...r,
    handler: async (req, res, params, query, body) => {
      await validate.handler(req, res, params, query, body);
      received.push({ signature: String(req.headers['x-admin-signature']), status: res.statusCode });
    },
  }));
  await server.start();
  return { url: `http://127.0.0.1:${server.getPort()}`, code, received, stop: () => server.stop() };
}

/** Holds the clock at `at` until what `send` sends is answered, so every relay it makes is signed in that millisecond. */
async function inOneMillisecond<T>(at: number, send: () => Promise<T>): Promise<T> {
  const clock = jest.spyOn(Date, 'now').mockReturnValue(at);
  try {
    return await send();
  } finally {
    clock.mockRestore();
  }
}

describe('POST /enrollment/process: relays of one code and PIN hash signed in one millisecond, as a real employer node answers them', () => {
  /** The PIN hash the employer node's one code is bound to, which the member it was issued to sends. */
  const MEMBER_PIN_HASH = 'pin-hash-of-the-member-the-code-was-issued-to';
  /** A code no employer issued, and a PIN hash, as many sources send them at once. */
  const copy = () => ({ tokenId: generateEnrollmentCode('EMP-NOBODY'), tokenPinHash: '4242' });

  test('two sources sending one code and PIN hash at once have the insurer sign two different relays, and the employer answers each on its merits', async () => {
    const employer = await startedEmployer(MEMBER_PIN_HASH);
    try {
      const redeem = redemptionAt(employer.url);
      const body = copy();
      const at = Date.now();
      const answers = await inOneMillisecond(at, () => Promise.all([redeem(from('198.51.100.21'), body), redeem(from('198.51.100.22'), body)]));
      expect(employer.received).toHaveLength(2);
      const [first, second] = employer.received;
      expect([first.signature, second.signature].map((s) => s.split(':').slice(0, 2).join(':'))).toEqual([`insurer:${at}`, `insurer:${at}`]);
      expect(first.signature).not.toBe(second.signature);   // before: the same signature twice
      expect([first.status, second.status]).toEqual([200, 200]);   // before: [200, 401], the second refused as a replay and charged to the insurer's caller key
      expect(answers.map((r) => [r.status, r.error])).toEqual([[403, NOT_RECOGNIZED], [403, NOT_RECOGNIZED]]);   // before: one was [502, 'Cannot validate enrollment code: employer (static) returned 401: This oracle answers only the insurer: this signature has already been presented.']
    } finally {
      await employer.stop();
    }
  });

  test('a junk code sixty-one sources send at once is answered on its merits each time, none of it charged to the insurer, and a member\'s code relayed next is redeemed', async () => {
    const employer = await startedEmployer(MEMBER_PIN_HASH);
    try {
      const redeem = redemptionAt(employer.url);
      const body = copy();
      const answers = await inOneMillisecond(Date.now(), () => Promise.all(Array.from({ length: 61 }, (_, i) => redeem(from(`198.51.100.${100 + i}`), body))));
      expect(answers.filter((r) => r.status === 403 && r.error === NOT_RECOGNIZED)).toHaveLength(61);   // before: 1, the other 60 answered 502
      expect(employer.received.filter((r) => r.status === 401)).toHaveLength(0);   // before: 60, each a copy refused as a replay and charged to the insurer's caller key
      const member = await redeem(from('203.0.113.60'), { tokenId: employer.code, tokenPinHash: MEMBER_PIN_HASH });
      expect([member.status, member.data?.redeemed]).toEqual([200, true]);   // before: [502, undefined], the employer having refused the insurer 429 before checking its signature
    } finally {
      await employer.stop();
    }
  });
});

// ── What a member's device says ─────────────────────────────

/** An insurer node started on loopback, as a member's device reaches it, relaying codes as relayingInsurer says. */
async function startedInsurer(employerUrl: string | undefined, over: Partial<NautilusAppConfig> = {}): Promise<{ url: string; stop: () => Promise<void> }> {
  const server = relayingInsurer(employerUrl, over);
  server.registerRoutes(buildInsurerRoutes(server));
  await server.start();
  return { url: `http://127.0.0.1:${server.getPort()}`, stop: () => server.stop() };
}

/**
 * A member's device, never started, with an enrollment code accepted and its key generated, as the member's screen leaves
 * it before redeeming: its redeem route, which sends the code and a hash of the PIN to the insurer at `insurerUrl`, and
 * the phase the device is in.
 */
async function memberDevice(insurerUrl: string): Promise<((tokenPIN: string) => Promise<Answer>) & { phase: () => string }> {
  const server = appNode('member', { insurerUrl });
  const routes = buildMemberRoutes(server);
  const device = from('127.0.0.1');
  expect((await call(routeOf(routes, 'POST', '/onboarding/unlock'), device, { pin: '135790' })).status).toBe(200);
  expect((await call(routeOf(routes, 'POST', '/onboarding/accept-token'), device, { tokenId: generateEnrollmentCode('EMP-NOBODY') })).status).toBe(200);
  expect((await call(routeOf(routes, 'POST', '/onboarding/generate-key'), device, {})).status).toBe(200);
  const redeem = routeOf(routes, 'POST', '/onboarding/redeem');
  return Object.assign((tokenPIN: string) => call(redeem, device, { tokenPIN }), { phase: () => server.getOnboardingPhase() as string });
}

describe('POST /onboarding/redeem: what a member\'s device says when the insurer does not redeem its code', () => {
  /** The employer the insurer relays to: a stand-in that issued nothing, so every code is "Token not found". */
  const nobody = standIn(() => ({ ok: true, data: { valid: false, reason: 'Token not found' } }));

  test('the insurer\'s 429 is answered 429, saying too many attempts came from this network, with the insurer\'s Retry-After; its 403 keeps the refusal', async () => {
    const insurer = await startedInsurer(nobody.url());
    try {
      const redeem = await memberDevice(insurer.url);
      // The device reaches the insurer from loopback, one source: its first ten attempts are relayed, and refused.
      const refused: Answer[] = [];
      for (let i = 0; i < 10; i++) refused.push(await redeem(String(48213970 + i)));
      expect(refused.map((r) => [r.status, r.error, r.retryAfter])).toEqual(Array(10).fill([403, REFUSED, undefined]));
      const limited = await redeem('48213980');
      expect([limited.status, limited.error, limited.retryAfter]).toEqual([429, TOO_MANY_ATTEMPTS, '60']);   // before: [429, REFUSED, undefined]
    } finally {
      await insurer.stop();
    }
  });

  /** An employer too busy to answer the insurer: it answers every relay 429, as its overall limit does. */
  const busy = replying(() => ({ status: 429, body: { ok: false, error: 'Too many validation requests. Try again in a minute.' } }));
  /** A sequencer that lists no employer node, as before any employer has finished activation. */
  const noEmployers = standIn(() => ({ jsonrpc: '2.0', id: 1, result: [] }));
  /** An insurer that answers every request 503 with a Retry-After of two minutes. */
  const unavailable = replying(() => ({ status: 503, headers: { 'Retry-After': '120' }, body: { ok: false, error: 'Service unavailable' } }));
  /** An employer that answers the insurer 503, as one with no attestation loaded does, until a test brings it back; then it redeems every code. */
  let employerDown = true;
  const recovering = replying(() => (employerDown
    ? { status: 503, body: { ok: false, error: 'This employer node has no attestation loaded, so it cannot tell who the insurer is. Refresh the attestation first.' } }
    : { status: 200, body: { ok: true, data: { valid: true, groupIdHash: '11', planIdHash: '22', consumed: true } } }));

  test('an employer the insurer cannot reach, or one too busy to answer it, has the insurer answer 502, and the device answers 502, saying the insurer could not check the code now; a code the employer refuses is still refused', async () => {
    const insurers = await Promise.all([startedInsurer('http://127.0.0.1:1'), startedInsurer(busy.url()), startedInsurer(nobody.url())]);
    try {
      const [unreachable, tooBusy, refusing] = await Promise.all(insurers.map((i) => memberDevice(i.url)));
      const notListening = await unreachable('48213970');
      expect([notListening.status, notListening.error, notListening.retryAfter]).toEqual([502, COULD_NOT_CHECK, undefined]);   // before: [403, REFUSED, undefined]
      const limited = await tooBusy('48213970');
      expect([limited.status, limited.error]).toEqual([502, COULD_NOT_CHECK]);                                               // before: [403, REFUSED]
      const refused = await refusing('48213970');
      expect([refused.status, refused.error]).toEqual([403, REFUSED]);
    } finally {
      await Promise.all(insurers.map((i) => i.stop()));
    }
  });

  test('an insurer with no employer registered answers 503, and the device answers 502 the same way, with the insurer\'s Retry-After when it sends one', async () => {
    const insurer = await startedInsurer(undefined, { sequencerUrl: noEmployers.url() });
    try {
      const none = await (await memberDevice(insurer.url))('48213970');
      expect([none.status, none.error, none.retryAfter]).toEqual([502, COULD_NOT_CHECK, undefined]);           // before: [403, REFUSED, undefined]
    } finally {
      await insurer.stop();
    }
    const waiting = await (await memberDevice(unavailable.url()))('48213970');
    expect([waiting.status, waiting.error, waiting.retryAfter]).toEqual([502, COULD_NOT_CHECK, '120']);        // before: [403, REFUSED, undefined]
  });

  test('the code was fine all along: the device stays where it was, and once the employer answers the insurer again the same PIN redeems it', async () => {
    const insurer = await startedInsurer(recovering.url());
    try {
      const redeem = await memberDevice(insurer.url);
      const down = await redeem('48213970');
      expect([down.status, down.error]).toEqual([502, COULD_NOT_CHECK]);   // before: [403, REFUSED]
      expect(redeem.phase()).toBe('key_generated');
      employerDown = false;
      const back = await redeem('48213970');
      expect([back.status, back.data?.phase]).toEqual([200, 'code_redeemed']);
    } finally {
      await insurer.stop();
    }
  });
});

// ── The marketplace's employer applications ─────────────────

/** The stand-in sequencer: it knows no employer, so every employerId is free (the apply route fails closed without one). */
const sequencer = standIn(() => ({ jsonrpc: '2.0', id: 1, result: null }));

let employers = 0;
/** An application as an employer fills it in, under an employerId no other application in this file has used. */
const application = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  companyName: 'Fernhill Test Works LLC', employerId: `FERNHILL-${++employers}`, contactName: 'Jordan Testcase',
  contactEmail: 'hr@fernhill.example.test', state: 'WI', selectedPlanIds: ['PLAN-TEST-1'], effectiveDate: '2027-01-01',
  enrollmentCap: 10, publicKeyHex: 'a'.repeat(64), ...over,
});

/**
 * The marketplace of a fresh insurer node, whose per-source hour starts empty: its apply route, the staff's decisions
 * and listing, and the employer's status. The store is the module's: emptied here, then read back from the node's file
 * when its state directory holds one.
 */
function marketplace(over: Partial<NautilusAppConfig> = {}) {
  const server = insurerNode({ sequencerUrl: sequencer.url(), ...over });
  getApplicationStore().clear();
  const routes = buildMarketplaceRoutes(server);
  const admin = buildEmployerAdminRoutes(server);
  const apply = routeOf(routes, 'POST', '/marketplace/api/apply');
  return {
    stateDir: server.getConfig().stateDir,
    /** An application from `remoteAddress`, as an employer fills it in unless `over` says otherwise. */
    apply: (remoteAddress: string, over: Record<string, unknown> = {}): Promise<Answer> => call(apply, from(remoteAddress), application(over)),
    /** The staff deny an application. */
    deny: (applicationId: string): Promise<Answer> =>
      call(routeOf(admin, 'POST', '/employer-applications/:applicationId/deny'), from(STAFF), { reason: 'Not an employer the insurer serves' }, { applicationId }),
    /** Every application, as the staff's screen reads them. */
    listing: (): Promise<Answer> => call(routeOf(admin, 'GET', '/employer-applications'), from(STAFF)),
    /** One application, as the employer's screen reads it. */
    status: (applicationId: string): Promise<Answer> => call(routeOf(routes, 'GET', '/marketplace/api/status/:applicationId'), from(STAFF), undefined, { applicationId }),
  };
}

/** How many applications in the store wait on the insurer. */
const openApplications = (): number =>
  [...getApplicationStore().values()].filter((a) => ['submitted', 'under_review', 'needs_documents'].includes(a.status)).length;

/** Puts `n` open applications in the store, as a restart loads them from the file; `source` is whose they are, if anyone's. */
function fill(n: number, source?: string): void {
  const store = getApplicationStore();
  for (let i = 0; i < n; i++) {
    const app: EmployerApplication & { source?: string } = {
      applicationId: `EMPAPP-FILL-${store.size}`, employerId: `FILL-${++employers}`, companyName: 'Filler Works LLC',
      contactName: 'Pat Filler', contactEmail: 'hr@filler.example.test', state: 'WI', selectedPlanIds: ['PLAN-TEST-1'],
      effectiveDate: '20270101', enrollmentCap: 10, publicKeyHex: 'a'.repeat(64), submittedAt: Date.now(), status: 'submitted',
      ...(source === undefined ? {} : { source }),
    };
    store.set(app.applicationId, app);
  }
}

describe('POST /marketplace/api/apply: what one source may file', () => {
  test('one source sending ten well-formed applications in a minute has three kept and the rest refused 429 with Retry-After, and another source still applies', async () => {
    const mkt = marketplace();
    const sent: Answer[] = [];
    for (let i = 0; i < 10; i++) sent.push(await mkt.apply('198.51.100.7'));
    expect(sent.map((r) => r.status)).toEqual([201, 201, 201, ...Array(7).fill(429)]);       // before: ten 201s, every one kept
    expect(sent.slice(3).map((r) => [r.error, r.retryAfter])).toEqual(Array(7).fill([OPEN_FROM_SOURCE, '3600']));   // before: no error and no Retry-After
    const other = await mkt.apply('198.51.100.8');
    expect([other.status, other.error]).toEqual([201, undefined]);                           // before: [429, ROUTE_WIDE], one source's ten spent the route's minute
    expect(openApplications()).toBe(4);                                                       // before: 10
  });

  test('applications one source sends together are counted one after another: three are kept', async () => {
    const mkt = marketplace();
    const sent = await Promise.all(Array.from({ length: 10 }, () => mkt.apply('198.51.100.9')));
    expect(sent.map((r) => r.status).sort((a, b) => a - b)).toEqual([201, 201, 201, ...Array(7).fill(429)]);   // before: ten 201s, each passed the route's count before any was kept
    expect(openApplications()).toBe(3);                                                       // before: 10
  });

  test('a source has at most six applications kept in an hour, counting only those kept, and past that is refused 429 with Retry-After though staff denied the rest', async () => {
    const mkt = marketplace();
    const source = '203.0.113.30';
    const held = await mkt.apply('203.0.113.31');
    expect(held.status).toBe(201);
    const heldEmployerId = getApplicationStore().get(held.data.applicationId)!.employerId;
    // Refused for what they say, so counted against nothing: a key that is not one, and an employerId already applied under.
    for (let i = 0; i < 4; i++) {
      expect((await mkt.apply(source, { publicKeyHex: 'not-a-key' })).status).toBe(400);
      expect((await mkt.apply(source, { employerId: heldEmployerId })).status).toBe(409);
    }
    // Three kept and denied, twice over: six kept this hour, none of them open.
    for (let round = 0; round < 2; round++) {
      const kept: number[] = [];
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        const r = await mkt.apply(source);
        kept.push(r.status);
        ids.push(r.data?.applicationId);
      }
      expect(kept).toEqual([201, 201, 201]);
      for (const id of ids) expect((await mkt.deny(id)).status).toBe(200);
    }
    const past = await mkt.apply(source);
    expect([past.status, past.error, past.retryAfter]).toEqual([429, HOURLY, '3600']);        // before: [201, undefined, undefined], nothing counted a source's hour
    expect((await mkt.apply('203.0.113.32')).status).toBe(201);
  });

  test('a source at three open applications is refused until the insurer decides one: a denial frees its slot, and so does an activation', async () => {
    const mkt = marketplace();
    const source = '192.0.2.40';
    const kept: Answer[] = [];
    for (let i = 0; i < 3; i++) kept.push(await mkt.apply(source));
    expect(kept.map((r) => r.status)).toEqual([201, 201, 201]);
    const fourth = await mkt.apply(source);
    expect([fourth.status, fourth.error, fourth.retryAfter]).toEqual([429, OPEN_FROM_SOURCE, '3600']);   // before: [201, undefined, undefined]
    expect((await mkt.deny(kept[0].data.applicationId)).status).toBe(200);
    expect((await mkt.apply(source)).status).toBe(201);
    expect((await mkt.apply(source)).status).toBe(429);                                      // before: 201
    // Activation starts the employer's node and, once it is up, marks the application active.
    getApplicationStore().get(kept[1].data.applicationId)!.status = 'active';
    expect((await mkt.apply(source)).status).toBe(201);
    expect((await mkt.apply(source)).status).toBe(429);                                      // before: 201
  });

  test('an application holds its source\'s slot while it waits on the insurer, and frees it once approved, signed, activated or denied', async () => {
    const source = '192.0.2.41';
    const after: Array<[EmployerApplicationStatus, number]> = [];
    for (const status of ['submitted', 'under_review', 'needs_documents', 'approved', 'signed', 'active', 'denied'] as const) {
      const mkt = marketplace();
      const kept: Answer[] = [];
      for (let i = 0; i < 3; i++) kept.push(await mkt.apply(source));
      expect([status, kept.map((r) => r.status)]).toEqual([status, [201, 201, 201]]);
      getApplicationStore().get(kept[0].data.applicationId)!.status = status;
      after.push([status, (await mkt.apply(source)).status]);
    }
    expect(after).toEqual([
      ['submitted', 429], ['under_review', 429], ['needs_documents', 429],                    // before: 201 for each, no source held a slot
      ['approved', 201], ['signed', 201], ['active', 201], ['denied', 201],
    ]);
  });
});

describe('POST /marketplace/api/apply: the open applications the insurer keeps', () => {
  test('at most 1,000 are open at once, whoever filed them; past that the route answers 503 with Retry-After, and a source refused meanwhile has nothing counted against it', async () => {
    const mkt = marketplace();
    fill(999);
    expect((await mkt.apply('198.51.100.50')).status).toBe(201);
    expect(openApplications()).toBe(1_000);
    // Seven refusals from one source, more than a source's hour holds.
    const waiting = '198.51.100.51';
    for (let i = 0; i < 7; i++) {
      const full = await mkt.apply(waiting);
      expect([full.status, full.error, full.retryAfter]).toEqual([503, FULL, '3600']);       // before: [201, undefined, undefined], no bound on what was kept
    }
    expect((await mkt.deny('EMPAPP-FILL-0')).status).toBe(200);
    expect((await mkt.apply(waiting)).status).toBe(201);
    const next = await mkt.apply('198.51.100.52');
    expect([next.status, next.retryAfter]).toEqual([503, '3600']);                            // before: [201, undefined]
    expect(openApplications()).toBe(1_000);                                                   // before: 1,008
  });

  test('with every slot taken, what an application says and what its source has filed are answered first: 400, then 409, then 429, then 503', async () => {
    const mkt = marketplace();
    const atItsLimit = '198.51.100.60';
    fill(3, atItsLimit);
    fill(997);
    const taken = getApplicationStore().get('EMPAPP-FILL-999')!.employerId;
    const fresh = '198.51.100.61';
    const bad = await mkt.apply(fresh, { publicKeyHex: 'not-a-key' });
    expect([bad.status, bad.error]).toEqual([400, 'Invalid public key format (expected 64 hex characters)']);
    const held = await mkt.apply(atItsLimit, { employerId: taken });
    expect([held.status, held.error]).toEqual([409, `An application for "${taken}" is already submitted`]);
    const limited = await mkt.apply(atItsLimit);
    expect([limited.status, limited.error]).toEqual([429, OPEN_FROM_SOURCE]);                // before: [201, undefined], kept past every bound
    const full = await mkt.apply(fresh);
    expect([full.status, full.error]).toEqual([503, FULL]);                                  // before: [201, undefined]
  });
});

describe('the source an application keeps', () => {
  test('is filed with the application, so a source with three open is still refused after a restart, and neither the staff\'s listing nor the employer\'s status shows it', async () => {
    const mkt = marketplace();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await mkt.apply('203.0.113.77')).data.applicationId);
    expect((getApplicationStore().get(ids[0]) as EmployerApplication & { source?: string }).source).toBe('203.0.113.77');   // before: undefined
    const listing = await mkt.listing();
    expect([listing.status, listing.data.length]).toEqual([200, 3]);
    expect(JSON.stringify(listing.data)).not.toContain('203.0.113.77');
    const status = await mkt.status(ids[0]);
    expect(status.status).toBe(200);
    expect(JSON.stringify(status.data)).not.toContain('203.0.113.77');

    // A restart: a node over the same state directory reads the store back from its file.
    const restarted = marketplace({ stateDir: mkt.stateDir });
    expect(getApplicationStore().size).toBe(3);
    const again = await restarted.apply('203.0.113.77');
    expect([again.status, again.error]).toEqual([429, OPEN_FROM_SOURCE]);                    // before: [201, undefined]
    expect((await restarted.apply('203.0.113.78')).status).toBe(201);
  });
});
