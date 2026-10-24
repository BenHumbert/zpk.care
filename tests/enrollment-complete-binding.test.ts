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
 * Who completes an enrollment at the insurer, and who files a recovery deposit there: the member's own device, never a
 * caller who knows only the enrollment code or the wallet ID.
 *
 * What was wrong: the insurer's POST /enrollment/complete took the code and a wallet ID and nothing else. A code is
 * redeemed first, with its PIN, before the device derives its wallet (C2), and in the window between that redemption and
 * the device's completion anyone who knew the code alone could complete it for a wallet of their own choosing. The
 * insurer then approved that wallet with the engine (POST /interactive/approve-member, signed with the insurer's node
 * key) into the member's plan, group and family, and the engine registers any approved wallet whose owner proves it, so
 * the stranger's wallet would be covered by the member's plan while the member's device was refused the code as used.
 * The route's answers told codes apart as well: 404 for a code never redeemed, 403 for one completed for another wallet,
 * 200 for one awaiting its device. The member's device sent nothing with its completion that the code alone did not
 * give. The same sweep found POST /recovery/deposit filing deposits for any wallet the body named
 * (tests/recovery-card.test.ts).
 *
 * How it was found: the confused-deputy sweep of round eight of the security fixes, 2026-10-24, confirmed by a
 * reproduction against the real routes.
 *
 * What is true now: the device keeps the PIN hash it redeemed the code with, sends it with the completion, and drops it
 * once enrolled. The insurer completes a code only for the PIN hash it kept with the redemption, and only for the wallet
 * the code first enrolled; a completion without the hash or with another, for a code nobody redeemed, or for another
 * wallet, is answered one 403, and the code waits for its device. An enrollment PIN is eight digits, so a code may be
 * presented with a wrong PIN hash five times an hour, at completion or at a repeat of the redemption, after which it is
 * answered 429 with nothing compared, the right hash included; completion counts a code nobody redeemed the same way, and
 * one source has at most ten refused completions a minute. The device answers the insurer's 429 at completion with 429
 * and its Retry-After rather than as a refusal of the code, and a device that kept no PIN hash says what to do and sends
 * nothing. A deposit the device files after enrollment is signed by its wallet, and the insurer files it once the
 * signature holds against the key the sequencer registered for the wallet.
 *
 * The insurer's routes are called directly on a real NautilusAppServer, never started, with stand-in requests whose
 * socket address each test sets. Its employer is a stand-in that redeems each code it issued for the PIN hash it bound
 * the code to, once; its sequencer is a stand-in that lists the plan, records the insurer's approvals and the signing
 * keys wallets register, and serves those keys from its entity registry. The device tests run a real member node on
 * loopback against a real insurer node on loopback, or against a stand-in insurer that records what the device sends.
 */
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import type { IncomingMessage, ServerResponse } from 'http';
import { NautilusAppServer } from '../src/nodes/nautilus-app-server.js';
import type { NautilusAppConfig, RouteRegistration } from '../src/nodes/nautilus-app-types.js';
import { buildInsurerRoutes } from '../src/nodes/routes/insurer-routes.js';
import { buildMemberRoutes } from '../src/nodes/routes/member-routes.js';
import { NautilusLocalState } from '../src/nodes/nautilus-local-state.js';
import { generateEnrollmentCode } from '../src/onboarding/enrollment-code.js';
import { hashTokenPIN } from '../src/tools/hr-tool-core.js';
import { hashString } from '../src/zkp/hash-utils.js';
import { combineEnrollmentKey, recoveryPinVerifier, type RecoveryCardV3 } from '../src/security/recovery-card.js';

jest.setTimeout(120_000);

/** The insurer's one answer to a completion that does not come from the device that redeemed the code. */
const NOT_COMPLETED = 'Enrollment denied: this enrollment code has not been redeemed with this PIN, or has already been used.';
/** The insurer's answer once a code has been presented with five wrong PIN hashes in the hour. */
const TOO_MANY_FOR_CODE = 'Too many attempts with this enrollment code in the last hour. Try again in an hour.';
/** The insurer's answer to a source past ten refused completions in the minute. */
const TOO_MANY_FROM_SOURCE = 'Too many refused enrollment completions from this address in the last minute. Try again in a minute.';
/** What the member's device answers when the insurer answers its completion 429. */
const WAIT_TO_COMPLETE = 'Too many attempts to complete an enrollment with this code or from this network. Try again later.';
/** What the member's device answers when it kept no PIN hash for its code. */
const NO_PIN_HASH = 'This device keeps no PIN hash for its enrollment code, which the insurer needs to complete it: start over and redeem the same code and PIN again';

const INSURER_SEED = 'insurer-seed-for-enrollment-completion-tests';
const PIN = '48213976';
const DEVICE_PIN = '135790';
const RECOVERY_PIN = '246813';
const DEVICE_WALLET = '7000000000000000000000000000000000001';
const STRANGER_WALLET = '4242424242424242424242424242424242424';
const G1 = hashString('GRP-1').toString();
const P1 = hashString('PLAN-1').toString();
const F1 = hashString('FAM-1').toString();
const PLAN_1 = {
  planId: 'PLAN-1', name: 'Plan 1', coverageType: 1, copayAmountCents: 1000, deductibleAmountCents: 50000, oopMaxCents: 800000, annualBenefitMaxCents: 0,
  familyDeductibleAmountCents: 0, familyOopMaxCents: 0, familyAnnualBenefitMaxCents: 0, formularyNdcs: [], networkProviderWalletIds: [], published: true,
  createdAt: 0, updatedAt: 0,
  publishedTerms: {
    copayAmountCents: 1000, coverageType: 1, deductibleAmountCents: 50000, oopMaxCents: 800000, annualBenefitMaxCents: 0, familyDeductibleAmountCents: 0,
    familyOopMaxCents: 0, familyAnnualBenefitMaxCents: 0, formularyNdcs: [], networkProviderWalletIds: [], formularyRoot: '12345', networkRoot: '0', publishedAt: 0,
  },
};
const FIELDS = { cardholderId: 'CH-BIND-1', dateOfBirth: '19880214', genderCode: 1, firstName: 'Bound', lastName: 'Member' };
const CONSENT = { phiDescription: 'claims', disclosingParty: 'Member', receivingParty: 'zpk.care', purpose: 'test', expiration: '2027-01-01', signatureDate: '2026-10-24' };

const dirs: string[] = [];
const stops: Array<() => Promise<void>> = [];
const tmp = (prefix: string): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); dirs.push(d); return d; };
afterAll(async () => {
  for (const stop of stops.reverse()) await stop();
  for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
});

// ── Stand-ins ───────────────────────────────────────────────

/** A request a stand-in received. */
interface Seen { method: string; path: string; body: any }
/** How a stand-in answers one request. */
interface Reply { status: number; headers?: Record<string, string>; body: unknown }

/** A JSON service on loopback that answers each request as `reply` says, stopped after the file's tests. */
async function service(reply: (seen: Seen) => Reply): Promise<string> {
  const s = http.createServer((req, res) => {
    let text = '';
    req.on('data', (c) => { text += c; });
    req.on('end', () => {
      let body: any = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = null; }
      const r = reply({ method: req.method ?? 'GET', path: req.url ?? '/', body });
      res.writeHead(r.status, { 'Content-Type': 'application/json', ...r.headers });
      res.end(JSON.stringify(r.body));
    });
  });
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  stops.push(() => new Promise<void>((resolve) => { s.closeAllConnections(); s.close(() => resolve()); }));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

const rpc = (body: any, result: unknown): Reply => ({ status: 200, body: { jsonrpc: '2.0', id: body?.id ?? 1, result } });

/**
 * The employer and the sequencer an insurer works with, as stand-ins. The employer redeems each code `issue` gave it,
 * once, for the PIN hash it bound the code to. The sequencer lists PLAN_1, records the insurer's approvals, keeps the
 * signing key each wallet registers, and serves the keys from its entity registry.
 */
async function network() {
  const issued = new Map<string, string>();
  const approvals: Array<Record<string, unknown>> = [];
  const keys = new Map<string, string>();
  const employerUrl = await service(({ path: p, body }) => {
    const code = decodeURIComponent(/^\/tokens\/([^/]+)\/validate$/.exec(p)?.[1] ?? '');
    const bound = issued.get(code);
    if (bound === undefined) return { status: 200, body: { ok: true, data: { valid: false, reason: 'Token not found' } } };
    if (body?.tokenPinHash !== bound) return { status: 200, body: { ok: true, data: { valid: false, reason: 'Invalid enrollment PIN' } } };
    issued.delete(code);
    return { status: 200, body: { ok: true, data: { valid: true, groupIdHash: G1, planIdHash: P1, familyIdHash: F1, consumed: true } } };
  });
  const sequencerUrl = await service(({ method, path: p, body }) => {
    if (method === 'GET' && p === '/viz/entities') {
      return { status: 200, body: [...keys].map(([walletId, signingPublicKeyHex]) => ({ walletId, displayName: 'Member', type: 'member', signingPublicKeyHex })) };
    }
    if (p === '/interactive/approve-member') { approvals.push(body); return { status: 200, body: { approved: true } }; }
    if (body?.method === 'l2_getPlans') return rpc(body, [PLAN_1]);
    if (body?.method === 'l2_registerEntity') {
      if (typeof body.params?.signingPublicKeyHex === 'string') keys.set(body.params.walletId, body.params.signingPublicKeyHex);
      return rpc(body, { ok: true });
    }
    return rpc(body, null);
  });
  /** A fresh code the employer issued, bound to the hash of `pin`. */
  const issue = (pin: string = PIN): string => {
    const code = generateEnrollmentCode('EMP-BIND');
    issued.set(code, hashTokenPIN(code, pin));
    return code;
  };
  return { approvals, keys, employerUrl, sequencerUrl, issue };
}
type Network = Awaited<ReturnType<typeof network>>;

// ── The insurer's routes, called directly ───────────────────

/** Enough of a request for a handler: a socket at `remoteAddress`. */
const from = (remoteAddress: string) => ({ url: '/', headers: {}, socket: { remoteAddress } });
type StandIn = ReturnType<typeof from>;
const device = from('203.0.113.10');
const stranger = from('198.51.100.66');

interface Answer { status: number; retryAfter: string | undefined; error: string | undefined; data: any }

/** Calls `route`'s handler as the server does once it has parsed the body, with a stand-in response; returns the answer. */
async function call(route: RouteRegistration, req: StandIn, body?: unknown): Promise<Answer> {
  let status = 0;
  let text = '';
  const headers: Record<string, string> = {};
  const res = {
    get writableEnded() { return status !== 0; },
    setHeader(name: string, value: string) { headers[name.toLowerCase()] = value; return this; },
    writeHead(code: number) { status = code; return this; },
    end(chunk?: string) { text = chunk ?? ''; return this; },
  };
  await route.handler(req as unknown as IncomingMessage, res as unknown as ServerResponse, {}, new URLSearchParams(), body);
  const json = (text ? JSON.parse(text) : {}) as { error?: string; data?: unknown };
  return { status, retryAfter: headers['retry-after'], error: json.error, data: json.data };
}

function routeOf(routes: RouteRegistration[], method: string, p: string): RouteRegistration {
  const r = routes.find((x) => x.method === method && x.path === p);
  if (!r) throw new Error(`route not registered: ${method} ${p}`);
  return r;
}

/** An insurer node, configured, that redeems codes with `net`'s employer and approves wallets with its sequencer. */
async function insurerOf(net: Network) {
  const server = new NautilusAppServer({
    role: 'insurer', port: 0, host: '127.0.0.1', sequencerUrl: net.sequencerUrl, employerUrl: net.employerUrl, insurerSigningSeed: INSURER_SEED,
    stateDir: tmp('bind-ins-'), enableSSE: false, maxSseConnections: 0, allowedOrigins: [], adminToken: 'admin-token-for-binding',
    publicHosts: [], trustedProxies: [],
  } as unknown as NautilusAppConfig);
  const routes = buildInsurerRoutes(server);
  expect((await call(routeOf(routes, 'POST', '/onboarding/configure'), from('127.0.0.1'), {})).status).toBe(200);
  return { server, routes, process: routeOf(routes, 'POST', '/enrollment/process'), complete: routeOf(routes, 'POST', '/enrollment/complete') };
}

describe('POST /enrollment/complete: only the device that redeemed a code completes it', () => {
  test('a holder of the code alone, with no PIN hash or another, is refused, and the code still completes for the device that redeemed it', async () => {
    const net = await network();
    const ins = await insurerOf(net);
    const code = net.issue();
    expect((await call(ins.process, device, { tokenId: code, tokenPinHash: hashTokenPIN(code, PIN) })).status).toBe(200);
    const bare = await call(ins.complete, stranger, { tokenId: code, walletId: STRANGER_WALLET });
    const guessed = await call(ins.complete, stranger, { tokenId: code, walletId: STRANGER_WALLET, tokenPinHash: hashTokenPIN(code, '00000000') });
    expect([bare.status, bare.error]).toEqual([403, NOT_COMPLETED]);         // before: [200, undefined], the stranger's wallet enrolled
    expect([guessed.status, guessed.error]).toEqual([403, NOT_COMPLETED]);   // before: [200, undefined], the stranger's wallet again
    expect(net.approvals).toEqual([]);                                        // before: the stranger's wallet approved twice, signed as the insurer
    const own = await call(ins.complete, device, { tokenId: code, walletId: DEVICE_WALLET, tokenPinHash: hashTokenPIN(code, PIN) });
    expect([own.status, own.data?.enrolled, own.data?.walletId]).toEqual([200, true, DEVICE_WALLET]);   // before: [403, undefined, undefined], the code used by the stranger
    expect(net.approvals.map((a) => [a.walletId, a.planId, a.groupIdHash, a.familyIdHash])).toEqual([[DEVICE_WALLET, 'PLAN-1', G1, F1]]);   // before: the stranger's wallet, twice
    // The device presenting its completion again (one that died before it saved the answer) is answered again.
    const again = await call(ins.complete, device, { tokenId: code, walletId: DEVICE_WALLET, tokenPinHash: hashTokenPIN(code, PIN) });
    expect(again.status).toBe(200);   // before: 403
  });

  test('a code nobody redeemed, a code completed for another wallet and a code awaiting its device get one answer', async () => {
    const net = await network();
    const ins = await insurerOf(net);
    const completed = net.issue();
    const waiting = net.issue();
    for (const code of [completed, waiting]) expect((await call(ins.process, device, { tokenId: code, tokenPinHash: hashTokenPIN(code, PIN) })).status).toBe(200);
    expect((await call(ins.complete, device, { tokenId: completed, walletId: DEVICE_WALLET, tokenPinHash: hashTokenPIN(completed, PIN) })).status).toBe(200);
    const answers = [
      // a code no device redeemed
      await call(ins.complete, stranger, { tokenId: generateEnrollmentCode('EMP-BIND'), walletId: STRANGER_WALLET, tokenPinHash: '1' }),
      // a code completed for the device's wallet, presented with its own PIN hash for another wallet
      await call(ins.complete, stranger, { tokenId: completed, walletId: STRANGER_WALLET, tokenPinHash: hashTokenPIN(completed, PIN) }),
      // a code awaiting its device, with another PIN hash
      await call(ins.complete, stranger, { tokenId: waiting, walletId: STRANGER_WALLET, tokenPinHash: hashTokenPIN(waiting, '00000000') }),
    ];
    expect(answers.map((r) => [r.status, r.error])).toEqual(Array(3).fill([403, NOT_COMPLETED]));   // before: [[404, 'This enrollment code has not been redeemed. Redeem it first.'], [403, 'Enrollment denied: this enrollment code has already been used.'], [200, undefined]]
    expect(net.approvals.map((a) => a.walletId)).toEqual([DEVICE_WALLET]);                         // before: the stranger's wallet approved for the waiting code too
  });

  test('five wrong PIN hashes in an hour, at completion or at a repeat of the redemption, and the code is answered 429 with nothing compared; another code is not', async () => {
    const net = await network();
    const ins = await insurerOf(net);
    const code = net.issue();
    const other = net.issue();
    for (const c of [code, other]) expect((await call(ins.process, device, { tokenId: c, tokenPinHash: hashTokenPIN(c, PIN) })).status).toBe(200);
    const wrong = (i: number) => hashTokenPIN(code, String(10_000_000 + i));
    const misses: number[] = [];
    for (let i = 0; i < 3; i++) misses.push((await call(ins.complete, from(`198.51.100.${10 + i}`), { tokenId: code, walletId: STRANGER_WALLET, tokenPinHash: wrong(i) })).status);
    for (let i = 3; i < 5; i++) misses.push((await call(ins.process, from(`198.51.100.${10 + i}`), { tokenId: code, tokenPinHash: wrong(i) })).status);
    expect(misses).toEqual([403, 403, 403, 403, 403]);   // before: [200, 200, 200, 403, 403], the code completed for the stranger's wallet
    const right = await call(ins.complete, device, { tokenId: code, walletId: DEVICE_WALLET, tokenPinHash: hashTokenPIN(code, PIN) });
    expect([right.status, right.error, right.retryAfter]).toEqual([429, TOO_MANY_FOR_CODE, '3600']);   // before: [403, 'Enrollment denied: this enrollment code has already been used.', undefined]
    const repeat = await call(ins.process, device, { tokenId: code, tokenPinHash: hashTokenPIN(code, PIN) });
    expect([repeat.status, repeat.error, repeat.retryAfter]).toEqual([429, TOO_MANY_FOR_CODE, '3600']);   // before: [200, undefined, undefined], answered from the record
    expect(net.approvals).toEqual([]);                                                                    // before: the stranger's wallet approved three times
    const elsewhere = await call(ins.complete, device, { tokenId: other, walletId: DEVICE_WALLET, tokenPinHash: hashTokenPIN(other, PIN) });
    expect(elsewhere.status).toBe(200);
  });

  test('a code nobody redeemed is counted as a redeemed one is: five refused completions in the hour, then 429', async () => {
    const net = await network();
    const ins = await insurerOf(net);
    const unknown = generateEnrollmentCode('EMP-BIND');
    const sent: Answer[] = [];
    for (let i = 0; i < 6; i++) sent.push(await call(ins.complete, from(`203.0.113.${100 + i}`), { tokenId: unknown, walletId: STRANGER_WALLET, tokenPinHash: String(i) }));
    expect(sent.map((r) => r.status)).toEqual([403, 403, 403, 403, 403, 429]);   // before: six 404s
    expect([sent[5].error, sent[5].retryAfter]).toEqual([TOO_MANY_FOR_CODE, '3600']);   // before: ['This enrollment code has not been redeemed. Redeem it first.', undefined]
  });

  test('one source past ten refused completions in a minute is answered 429 with Retry-After, and another source is still answered', async () => {
    const net = await network();
    const ins = await insurerOf(net);
    const source = from('192.0.2.50');
    const attempt = (req: StandIn) => call(ins.complete, req, { tokenId: generateEnrollmentCode('EMP-BIND'), walletId: STRANGER_WALLET, tokenPinHash: '1' });
    const sent: number[] = [];
    for (let i = 0; i < 10; i++) sent.push((await attempt(source)).status);
    expect(sent).toEqual(Array(10).fill(403));   // before: ten 404s
    const past = await attempt(source);
    expect([past.status, past.error, past.retryAfter]).toEqual([429, TOO_MANY_FROM_SOURCE, '60']);   // before: [404, 'This enrollment code has not been redeemed. Redeem it first.', undefined]
    expect((await attempt(from('192.0.2.51'))).status).toBe(403);                                     // before: 404
  });
});

// ── The member's device ─────────────────────────────────────

interface DeviceAnswer { status: number; json: any; data: any; retryAfter: string | null }

/** A member node on loopback that redeems and completes with the insurer at `insurerUrl`, unlocked, with its device session. */
async function memberAt(insurerUrl: string, sequencerUrl: string) {
  const stateDir = tmp('bind-mem-');
  const server = new NautilusAppServer({
    role: 'member', port: 0, host: '127.0.0.1', sequencerUrl, insurerUrl, stateDir,
    enableSSE: false, maxSseConnections: 0, allowedOrigins: [],
  } as unknown as NautilusAppConfig);
  server.registerRoutes(buildMemberRoutes(server));
  await server.start();
  stops.push(() => server.stop());
  const url = `http://127.0.0.1:${server.getPort()}`;
  const unlock = await fetch(url + '/onboarding/unlock', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: DEVICE_PIN }) });
  const j: any = await unlock.json();
  const session: string = j.data?.deviceSession ?? j.deviceSession;
  /** A request from the member's screen, with the device session. */
  const dev = async (p: string, body: unknown = {}): Promise<DeviceAnswer> => {
    const r = await fetch(url + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Device-Session': session }, body: JSON.stringify(body) });
    let json: any = null;
    try { json = await r.json(); } catch { json = null; }
    return { status: r.status, json, data: json && 'data' in json ? json.data : json, retryAfter: r.headers.get('retry-after') };
  };
  return { server, url, stateDir, dev };
}

/** Takes the member's device from a fresh state through redeeming `code` with `pin`, as the member's screen does. */
async function redeemOn(m: Awaited<ReturnType<typeof memberAt>>, code: string, pin: string = PIN): Promise<void> {
  expect((await m.dev('/onboarding/accept-token', { tokenId: code })).status).toBe(200);
  expect((await m.dev('/onboarding/generate-key')).status).toBe(200);
  expect((await m.dev('/onboarding/redeem', { tokenPIN: pin })).status).toBe(200);
}

/** What the device keeps of its redemption, read from its state. */
const keptRedemption = (m: Awaited<ReturnType<typeof memberAt>>) =>
  m.server.getLocalState().getState()?.enrollment as (Record<string, unknown> & { tokenPinHash?: string }) | undefined;

describe('the member\'s device: its completion carries the PIN hash it redeemed with, and its later deposit is signed as its wallet', () => {
  test('a stranger with the code is refused while the member is between redeeming and completing; the device completes, drops the PIN hash, and files a later deposit the insurer accepts', async () => {
    const net = await network();
    const ins = await insurerOf(net);
    ins.server.registerRoutes(ins.routes);
    await ins.server.start();
    stops.push(() => ins.server.stop());
    const insurerUrl = `http://127.0.0.1:${ins.server.getPort()}`;
    const m = await memberAt(insurerUrl, net.sequencerUrl);
    const code = net.issue();
    await redeemOn(m, code);
    expect(keptRedemption(m)?.tokenPinHash).toBe(hashTokenPIN(code, PIN));   // before: undefined, the device kept no PIN hash

    // Someone who learned the code tries to complete it for their own wallet before the device does.
    const post = async (p: string, body: unknown) => {
      const r = await fetch(insurerUrl + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return { status: r.status, json: await r.json().catch(() => null) as any };
    };
    expect((await post('/enrollment/complete', { tokenId: code, walletId: STRANGER_WALLET })).status).toBe(403);   // before: 200, the stranger's wallet enrolled

    expect((await m.dev('/onboarding/derive-wallet', { ...FIELDS, consentRecord: CONSENT })).status).toBe(200);
    const enrolled = await m.dev('/onboarding/enroll', { recoveryPin: RECOVERY_PIN });
    expect([enrolled.status, enrolled.data?.insurerNotified]).toEqual([200, true]);   // before: [403, undefined], "Enrollment rejected by insurer", the code used by the stranger
    const walletId: string = enrolled.data.walletId;
    expect(net.approvals.map((a) => a.walletId)).toEqual([walletId]);                 // before: [STRANGER_WALLET]
    expect(keptRedemption(m)?.tokenPinHash).toBeUndefined();
    expect(keptRedemption(m)?.completedAt).toEqual(expect.any(Number));               // before: undefined, the device was refused
    // What the device saved, read back with its PIN, holds no PIN hash either.
    const saved = new NautilusLocalState(m.stateDir);
    await saved.unlock(DEVICE_PIN);
    expect(JSON.stringify((await saved.load())?.enrollment)).not.toContain(hashTokenPIN(code, PIN));

    // A pair of cards issued later: the deposit goes signed as the wallet, whose key the device registered at enrollment.
    expect(net.keys.has(walletId)).toBe(true);   // before: false, the device never enrolled
    const later = await m.dev('/recovery-card/issue', { recoveryPin: RECOVERY_PIN });
    expect(later.status).toBe(200);              // before: 409, the device never enrolled
    const card: RecoveryCardV3 = later.data.recoveryCards[0];
    const released = await post('/recovery/release', { cardId: card.id, pinVerifier: recoveryPinVerifier(RECOVERY_PIN, card.id) });
    expect(released.status).toBe(200);
    expect(combineEnrollmentKey(card, (released.json?.data ?? released.json).share2Hex)).toBe(m.server.getLocalState().useEnrollmentKey((k) => k));
  });

  /** A stand-in insurer that redeems every code and answers completion as `complete` says, noting what the device sent each route. */
  async function recordingInsurer(complete: Reply) {
    const sent = { process: [] as any[], complete: [] as any[] };
    const url = await service(({ path: p, body }) => {
      if (p === '/enrollment/process') {
        sent.process.push(body);
        return { status: 200, body: { ok: true, data: { redeemed: true, groupIdHash: G1, planIdHash: P1, employerId: 'EMP-BIND' } } };
      }
      if (p === '/enrollment/complete') { sent.complete.push(body); return complete; }
      return { status: 404, body: { ok: false, error: 'not stubbed ' + p } };
    });
    return { url, sent };
  }

  test('the insurer\'s 429 at completion is answered 429 with its Retry-After, and the completion carried the PIN hash the code was redeemed with', async () => {
    const insurer = await recordingInsurer({ status: 429, headers: { 'Retry-After': '3600' }, body: { ok: false, error: TOO_MANY_FOR_CODE } });
    const m = await memberAt(insurer.url, 'http://127.0.0.1:1');
    await redeemOn(m, generateEnrollmentCode('EMP-BIND'));
    expect((await m.dev('/onboarding/derive-wallet', { ...FIELDS, consentRecord: CONSENT })).status).toBe(200);
    const r = await m.dev('/onboarding/enroll', { recoveryPin: RECOVERY_PIN });
    expect([r.status, r.json?.error, r.retryAfter]).toEqual([429, WAIT_TO_COMPLETE, '3600']);   // before: [403, 'Enrollment rejected by insurer. Check your enrollment code and PIN.', null]
    expect(insurer.sent.complete).toHaveLength(1);
    expect(insurer.sent.process[0].tokenPinHash).toMatch(/^\d+$/);
    expect(insurer.sent.complete[0].tokenPinHash).toBe(insurer.sent.process[0].tokenPinHash);   // before: undefined, the completion carried no PIN hash
    // The device stays where it was, so the same tap completes once the insurer answers again.
    expect(m.server.getOnboardingPhase()).toBe('wallet_derived');
  });

  test('a device that kept no PIN hash for its code says what to do and sends no completion', async () => {
    const insurer = await recordingInsurer({ status: 200, body: { ok: true, data: { enrolled: true } } });
    const m = await memberAt(insurer.url, 'http://127.0.0.1:1');
    await redeemOn(m, generateEnrollmentCode('EMP-BIND'));
    // As a device that redeemed its code before it kept the PIN hash leaves its state.
    delete keptRedemption(m)?.tokenPinHash;
    expect((await m.dev('/onboarding/derive-wallet', { ...FIELDS, consentRecord: CONSENT })).status).toBe(200);
    const r = await m.dev('/onboarding/enroll', { recoveryPin: RECOVERY_PIN });
    expect([r.status, r.json?.error]).toEqual([409, NO_PIN_HASH]);   // before: [200, undefined], completed with no PIN hash
    expect(insurer.sent.complete).toHaveLength(0);                    // before: 1
  });
});
