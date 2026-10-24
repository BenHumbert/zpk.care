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
 * The review of round nine of the security fixes, 2026-10-24, found the PIN hash proved nothing about the device (A-108).
 * The employer holds the same hash for every code it issues: its HR Tool computes it and sets it on the employer node,
 * which keeps it after the code is consumed. The employer's validate oracle is also what consumes the code, so the
 * employer learns the moment its employee's device redeems it, and before the device completed, the employer could
 * complete the code for a wallet of its own: the insurer approved that wallet into the employee's plan, group and
 * family, and the device was refused. The same review found the device answering every 429 of the insurer's at
 * redemption as the limit on one network, "Try again in a minute", though the insurer also answers 429 for a code that
 * has had five wrong attempts in the hour, and that code stays refused for the hour whatever network the member tries.
 *
 * What is true now: at its first redemption of a code the device makes a secret of 32 random bytes and saves it before
 * the insurer is asked. Every redemption carries the secret's SHA-256, which the insurer keeps with the redemption and
 * never sends the employer, and the completion carries the secret itself, compared in constant time, and no PIN hash. A
 * completion without the secret or with another, and a repeat of the redemption without the PIN hash and the commitment
 * the code was redeemed with, are answered as every refusal is and count against the code, five an hour. The device's
 * own repeat, which presents the commitment it kept, is answered from the record, and so is its completion sent again
 * after an answer it never got. The device drops the secret once the insurer completes the code, and a device that kept
 * none says to ask HR for a new code. The employer, which holds the code and the PIN its HR Tool made, can still redeem
 * the code before its employee does, with a secret of its own; nothing here covers that, since who sets the PIN is the
 * owner's decision. The insurer marks its 429 for a code with an errorCode, and the device answers that one with 429,
 * the insurer's Retry-After, and a message that the code has had too many wrong attempts and to try again in an hour or
 * ask HR; the per-network 429 keeps its own message (tests/insurer-open-intake.test.ts).
 *
 * The review of round ten of the security fixes, 2026-10-24, found the insurer binding a completion's wallet only once
 * the engine had approved it, after two awaits (the plans, then the approval). Completions sent together that carried the
 * device's secret all passed the checks whatever wallet each named, and the engine approved each wallet, so whoever held
 * the secret, the member or anyone who captured it from a completion that failed after the check, could enroll two
 * wallets on one code; reproduced over real HTTP. The same review found this file's test of the device's secret reading
 * the device's state only after the insurer had answered the first redemption, so it could not tell a secret saved
 * before the device asked from one saved after, and only the first keeps a redemption the insurer recorded completable
 * by a device that stops between asking and saving.
 *
 * What is true now: a completion that passes the checks claims the code for its wallet before it awaits anything, and
 * the claim stands until the engine has answered and the code is bound. A completion for another wallet meanwhile is
 * refused with the one answer and counted as every refusal is; one for the same wallet waits for the claim's outcome and
 * is answered as the first is, so the engine is asked once. An approval the engine does not record binds nothing and
 * lifts the claim, and the code completes for its device. The stand-in insurer reads what the device saved the moment
 * the first redemption reaches it.
 *
 * The insurer's routes are called directly on a real NautilusAppServer, never started, with stand-in requests whose
 * socket address each test sets. Its employer is a stand-in that redeems each code it issued for the PIN hash it bound
 * the code to, once, and notes what the insurer relayed; its sequencer is a stand-in that lists the plan, records the
 * insurer's approvals (or refuses as many as a test asks) and the signing keys wallets register, and serves those keys
 * from its entity registry. The device tests run a real member node on loopback against a real insurer node on loopback,
 * or against a stand-in insurer that records what the device sends.
 */
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { createHash, randomBytes } from 'crypto';
import type { AddressInfo } from 'net';
import type { IncomingMessage, ServerResponse } from 'http';
import { NautilusAppServer } from '../src/nodes/nautilus-app-server.js';
import type { NautilusAppConfig, RouteRegistration } from '../src/nodes/nautilus-app-types.js';
import { buildInsurerRoutes } from '../src/nodes/routes/insurer-routes.js';
import { buildMemberRoutes } from '../src/nodes/routes/member-routes.js';
import { NautilusLocalState, type NautilusStateData } from '../src/nodes/nautilus-local-state.js';
import { generateEnrollmentCode } from '../src/onboarding/enrollment-code.js';
import { hashTokenPIN } from '../src/tools/hr-tool-core.js';
import { hashString } from '../src/zkp/hash-utils.js';
import { combineEnrollmentKey, recoveryPinVerifier, type RecoveryCardV3 } from '../src/security/recovery-card.js';

jest.setTimeout(120_000);

/** The insurer's one answer to a completion that does not come from the device that redeemed the code. */
const NOT_COMPLETED = 'Enrollment denied: this enrollment code has not been redeemed by this device, or has already been used.';
/** The insurer's answer to a repeat of a redemption without the PIN hash and the commitment the code was redeemed with. */
const USED = 'Enrollment denied: this enrollment code has already been used.';
/** The insurer's answer once a code has had five wrong attempts in the hour. */
const TOO_MANY_FOR_CODE = 'Too many attempts with this enrollment code in the last hour. Try again in an hour.';
/** The insurer's answer to a source past ten refused completions in the minute. */
const TOO_MANY_FROM_SOURCE = 'Too many refused enrollment completions from this address in the last minute. Try again in a minute.';
/** What the member's device answers when the insurer answers its completion 429. */
const WAIT_TO_COMPLETE = 'Too many attempts to complete an enrollment with this code or from this network. Try again later.';
/** What the member's device answers at redemption when the insurer's limit on wrong attempts with the code refuses it. */
const CODE_BLOCKED = 'This enrollment code has had too many wrong attempts in the last hour. Try again in an hour, or ask HR for a new code.';
/** What the member's device answered every 429 of the insurer's at redemption with, the code's limit included. */
const NETWORK_MINUTE = 'Too many enrollment attempts came from this network. Try again in a minute.';
/** What the member's device answers when it kept no completion secret for its code. */
const NO_SECRET = 'This device keeps no completion secret for its enrollment code, and the insurer completes a code only for the device that redeemed it: ask HR for a new code and start over';

const INSURER_SEED = 'insurer-seed-for-enrollment-completion-tests';
const PIN = '48213976';
const DEVICE_PIN = '135790';
const RECOVERY_PIN = '246813';
const DEVICE_WALLET = '7000000000000000000000000000000000001';
const STRANGER_WALLET = '4242424242424242424242424242424242424';
const EMPLOYER_WALLET = '5151515151515151515151515151515151515';
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

/** The commitment to a completion secret: the SHA-256 of its 32 bytes, in hex. */
const commitmentOf = (secret: string): string => createHash('sha256').update(Buffer.from(secret, 'hex')).digest('hex');
/** A completion secret as a device makes one at its first redemption of a code, and the commitment the redemption carries (A-108). */
function completionPair(): { secret: string; commitment: string } {
  const secret = randomBytes(32).toString('hex');
  return { secret, commitment: commitmentOf(secret) };
}

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

/**
 * A JSON service on loopback that answers each request as `reply` says, once its answer is ready (an answer that fails
 * is a 500 carrying the error), stopped after the file's tests.
 */
async function service(reply: (seen: Seen) => Reply | Promise<Reply>): Promise<string> {
  const s = http.createServer((req, res) => {
    let text = '';
    req.on('data', (c) => { text += c; });
    req.on('end', async () => {
      let body: any = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = null; }
      let r: Reply;
      try { r = await reply({ method: req.method ?? 'GET', path: req.url ?? '/', body }); }
      catch (err) { r = { status: 500, body: { ok: false, error: String(err) } }; }
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
 * once, for the PIN hash it bound the code to, and notes the body of every relay it receives. The sequencer lists PLAN_1,
 * records the insurer's approvals, except that it refuses the next `refusing.approvals` of them with 503 and records
 * nothing, keeps the signing key each wallet registers, and serves the keys from its entity registry.
 */
async function network() {
  const issued = new Map<string, string>();
  const relayed: any[] = [];
  const approvals: Array<Record<string, unknown>> = [];
  const refusing = { approvals: 0 };
  const keys = new Map<string, string>();
  const employerUrl = await service(({ path: p, body }) => {
    relayed.push(body);
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
    if (p === '/interactive/approve-member') {
      if (refusing.approvals > 0) { refusing.approvals--; return { status: 503, body: { error: 'The engine did not record the approval' } }; }
      approvals.push(body);
      return { status: 200, body: { approved: true } };
    }
    if (body?.method === 'l2_getPlans') return rpc(body, [PLAN_1]);
    if (body?.method === 'l2_registerEntity') {
      if (typeof body.params?.signingPublicKeyHex === 'string') keys.set(body.params.walletId, body.params.signingPublicKeyHex);
      return rpc(body, { ok: true });
    }
    return rpc(body, null);
  });
  /** A fresh code the employer issued, bound to the hash of `pin`: the hash its HR Tool computed and its node keeps. */
  const issue = (pin: string = PIN): string => {
    const code = generateEnrollmentCode('EMP-BIND');
    issued.set(code, hashTokenPIN(code, pin));
    return code;
  };
  return { approvals, refusing, keys, relayed, employerUrl, sequencerUrl, issue };
}
type Network = Awaited<ReturnType<typeof network>>;

// ── The insurer's routes, called directly ───────────────────

/** Enough of a request for a handler: a socket at `remoteAddress`. */
const from = (remoteAddress: string) => ({ url: '/', headers: {}, socket: { remoteAddress } });
type StandIn = ReturnType<typeof from>;
const device = from('203.0.113.10');
const stranger = from('198.51.100.66');
/** The employer's own host, where its HR Tool and its node run. */
const employer = from('192.0.2.80');

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

/** An insurer node as insurerOf makes one, started on loopback, as a member's device reaches it. */
async function startedInsurerOf(net: Network) {
  const ins = await insurerOf(net);
  ins.server.registerRoutes(ins.routes);
  await ins.server.start();
  stops.push(() => ins.server.stop());
  return { ...ins, url: `http://127.0.0.1:${ins.server.getPort()}` };
}

/** A POST to `url` + `p`, as anyone on the network sends one. */
async function post(url: string, p: string, body: unknown): Promise<{ status: number; json: any }> {
  const r = await fetch(url + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) as any };
}

describe('POST /enrollment/complete: only the device that redeemed a code completes it', () => {
  test('a holder of the code alone, with no secret or another, is refused, and the code still completes for the device that redeemed it', async () => {
    const net = await network();
    const ins = await insurerOf(net);
    const code = net.issue();
    const own = completionPair();
    expect((await call(ins.process, device, { tokenId: code, tokenPinHash: hashTokenPIN(code, PIN), completionCommitment: own.commitment })).status).toBe(200);
    const bare = await call(ins.complete, stranger, { tokenId: code, walletId: STRANGER_WALLET });
    const guessed = await call(ins.complete, stranger, { tokenId: code, walletId: STRANGER_WALLET, completionSecret: completionPair().secret });
    expect([bare.status, bare.error]).toEqual([403, NOT_COMPLETED]);         // before: [200, undefined], the stranger's wallet enrolled
    expect([guessed.status, guessed.error]).toEqual([403, NOT_COMPLETED]);   // before: [200, undefined], the stranger's wallet again
    expect(net.approvals).toEqual([]);                                        // before: the stranger's wallet approved twice, signed as the insurer
    const mine = await call(ins.complete, device, { tokenId: code, walletId: DEVICE_WALLET, completionSecret: own.secret });
    expect([mine.status, mine.data?.enrolled, mine.data?.walletId]).toEqual([200, true, DEVICE_WALLET]);   // before: [403, undefined, undefined], the code used by the stranger
    expect(net.approvals.map((a) => [a.walletId, a.planId, a.groupIdHash, a.familyIdHash])).toEqual([[DEVICE_WALLET, 'PLAN-1', G1, F1]]);   // before: the stranger's wallet, twice
    // The device presenting its completion again (one that died before it saved the answer) is answered again.
    const again = await call(ins.complete, device, { tokenId: code, walletId: DEVICE_WALLET, completionSecret: own.secret });
    expect(again.status).toBe(200);   // before: 403
  });

  test('the employer, holding the PIN hash its HR Tool bound the code to, cannot complete the code its employee\'s device redeemed, nor take it over by redeeming it again; the device then completes', async () => {
    const net = await network();
    const ins = await insurerOf(net);
    const code = net.issue();
    const pinHash = hashTokenPIN(code, PIN);
    const own = completionPair();
    const redeemed = await call(ins.process, device, { tokenId: code, tokenPinHash: pinHash, completionCommitment: own.commitment });
    expect(redeemed.status).toBe(200);
    // The employer's validate oracle has just consumed the code, so the employer knows the moment, and it holds the PIN hash.
    const taken = await call(ins.complete, employer, { tokenId: code, walletId: EMPLOYER_WALLET, tokenPinHash: pinHash });
    expect([taken.status, taken.error]).toEqual([403, NOT_COMPLETED]);   // before: [200, undefined], the employer's wallet enrolled in its employee's plan, group and family
    // A repeat of the redemption with the PIN hash and a commitment of the employer's own does not bind the code to it.
    const its = completionPair();
    const again = await call(ins.process, employer, { tokenId: code, tokenPinHash: pinHash, completionCommitment: its.commitment });
    expect([again.status, again.error]).toEqual([403, USED]);   // before: [200, undefined], answered from the record
    const rebound = await call(ins.complete, employer, { tokenId: code, walletId: EMPLOYER_WALLET, tokenPinHash: pinHash, completionSecret: its.secret });
    expect([rebound.status, rebound.error]).toEqual([403, NOT_COMPLETED]);   // before: [200, undefined], the employer's wallet again
    expect(net.approvals).toEqual([]);                                       // before: the employer's wallet approved twice, signed as the insurer
    const mine = await call(ins.complete, device, { tokenId: code, walletId: DEVICE_WALLET, completionSecret: own.secret });
    expect([mine.status, mine.data?.walletId]).toEqual([200, DEVICE_WALLET]);   // before: [403, undefined], the code completed for the employer's wallet, and the completion took the PIN hash
    expect(net.approvals.map((a) => a.walletId)).toEqual([DEVICE_WALLET]);    // before: [EMPLOYER_WALLET, EMPLOYER_WALLET]
    // The commitment went to no employer and came back in no answer.
    expect(JSON.stringify([net.relayed, redeemed, taken, again, rebound, mine])).not.toContain(own.commitment);
  });

  test('a code nobody redeemed, a code completed for another wallet and a code awaiting its device get one answer', async () => {
    const net = await network();
    const ins = await insurerOf(net);
    const completed = net.issue();
    const waiting = net.issue();
    const forCompleted = completionPair();
    const forWaiting = completionPair();
    expect((await call(ins.process, device, { tokenId: completed, tokenPinHash: hashTokenPIN(completed, PIN), completionCommitment: forCompleted.commitment })).status).toBe(200);
    expect((await call(ins.process, device, { tokenId: waiting, tokenPinHash: hashTokenPIN(waiting, PIN), completionCommitment: forWaiting.commitment })).status).toBe(200);
    expect((await call(ins.complete, device, { tokenId: completed, walletId: DEVICE_WALLET, completionSecret: forCompleted.secret })).status).toBe(200);
    const answers = [
      // a code no device redeemed
      await call(ins.complete, stranger, { tokenId: generateEnrollmentCode('EMP-BIND'), walletId: STRANGER_WALLET, completionSecret: completionPair().secret }),
      // a code completed for the device's wallet, presented with its own secret for another wallet
      await call(ins.complete, stranger, { tokenId: completed, walletId: STRANGER_WALLET, completionSecret: forCompleted.secret }),
      // a code awaiting its device, with another secret
      await call(ins.complete, stranger, { tokenId: waiting, walletId: STRANGER_WALLET, completionSecret: completionPair().secret }),
    ];
    expect(answers.map((r) => [r.status, r.error])).toEqual(Array(3).fill([403, NOT_COMPLETED]));   // before: [[404, 'This enrollment code has not been redeemed. Redeem it first.'], [403, 'Enrollment denied: this enrollment code has already been used.'], [200, undefined]]
    expect(net.approvals.map((a) => a.walletId)).toEqual([DEVICE_WALLET]);                         // before: the stranger's wallet approved for the waiting code too
  });

  test('two completions sent together with the device\'s secret, for two wallets: the first claims the code before anything is awaited, the second is refused with the one answer, and the engine approves one wallet', async () => {
    const net = await network();
    const ins = await insurerOf(net);
    const code = net.issue();
    const own = completionPair();
    expect((await call(ins.process, device, { tokenId: code, tokenPinHash: hashTokenPIN(code, PIN), completionCommitment: own.commitment })).status).toBe(200);
    // Whoever holds the secret: the member, or anyone who captured it from a completion that failed after the check.
    const [first, second] = await Promise.all([
      call(ins.complete, device, { tokenId: code, walletId: DEVICE_WALLET, completionSecret: own.secret }),
      call(ins.complete, stranger, { tokenId: code, walletId: STRANGER_WALLET, completionSecret: own.secret }),
    ]);
    expect([first.status, first.data?.walletId]).toEqual([200, DEVICE_WALLET]);
    expect([second.status, second.error]).toEqual([403, NOT_COMPLETED]);     // before: [200, undefined], a second wallet enrolled on the one code
    expect(net.approvals.map((a) => a.walletId)).toEqual([DEVICE_WALLET]);   // before: both wallets approved, signed as the insurer
    // Sent once the code is bound, as before.
    const later = await call(ins.complete, stranger, { tokenId: code, walletId: STRANGER_WALLET, completionSecret: own.secret });
    expect([later.status, later.error]).toEqual([403, NOT_COMPLETED]);
  });

  test('the device\'s completion sent twice together asks the engine once, and both are answered enrolled', async () => {
    const net = await network();
    const ins = await insurerOf(net);
    const code = net.issue();
    const own = completionPair();
    expect((await call(ins.process, device, { tokenId: code, tokenPinHash: hashTokenPIN(code, PIN), completionCommitment: own.commitment })).status).toBe(200);
    const completion = { tokenId: code, walletId: DEVICE_WALLET, completionSecret: own.secret };
    const answers = await Promise.all([call(ins.complete, device, completion), call(ins.complete, device, completion)]);
    expect(answers.map((r) => [r.status, r.data?.enrolled, r.data?.walletId])).toEqual(Array(2).fill([200, true, DEVICE_WALLET]));
    expect(net.approvals.map((a) => a.walletId)).toEqual([DEVICE_WALLET]);   // before: [DEVICE_WALLET, DEVICE_WALLET], each asked the engine
  });

  test('a completion whose approval the engine does not record binds nothing and lifts its claim: the same completion sent with it gets the same answer, and the device\'s completion sent again completes the code', async () => {
    const net = await network();
    const ins = await insurerOf(net);
    const code = net.issue();
    const own = completionPair();
    expect((await call(ins.process, device, { tokenId: code, tokenPinHash: hashTokenPIN(code, PIN), completionCommitment: own.commitment })).status).toBe(200);
    const completion = { tokenId: code, walletId: DEVICE_WALLET, completionSecret: own.secret };
    net.refusing.approvals = 1;
    const failed = await Promise.all([call(ins.complete, device, completion), call(ins.complete, device, completion)]);
    expect(failed.map((r) => [r.status, r.error])).toEqual(Array(2).fill([502, 'The sequencer did not record the insurer approval for this wallet']));   // before: one of the two answered 200, approved by a request of its own to the engine
    expect(net.approvals).toEqual([]);   // before: [DEVICE_WALLET]
    const again = await call(ins.complete, device, completion);
    expect([again.status, again.data?.walletId]).toEqual([200, DEVICE_WALLET]);
    expect(net.approvals.map((a) => a.walletId)).toEqual([DEVICE_WALLET]);
  });

  test('five wrong attempts in an hour, completions without the device\'s secret or repeats of the redemption without its PIN hash and commitment, and the code is answered 429 with nothing compared; another code is not', async () => {
    const net = await network();
    const ins = await insurerOf(net);
    const code = net.issue();
    const other = net.issue();
    const own = completionPair();
    const forOther = completionPair();
    expect((await call(ins.process, device, { tokenId: code, tokenPinHash: hashTokenPIN(code, PIN), completionCommitment: own.commitment })).status).toBe(200);
    expect((await call(ins.process, device, { tokenId: other, tokenPinHash: hashTokenPIN(other, PIN), completionCommitment: forOther.commitment })).status).toBe(200);
    const at = (i: number) => from(`198.51.100.${10 + i}`);
    const misses = [
      // completions: no secret, another secret, and something that is not a secret at all
      await call(ins.complete, at(0), { tokenId: code, walletId: STRANGER_WALLET }),
      await call(ins.complete, at(1), { tokenId: code, walletId: STRANGER_WALLET, completionSecret: completionPair().secret }),
      await call(ins.complete, at(2), { tokenId: code, walletId: STRANGER_WALLET, completionSecret: 'not-a-secret' }),
      // repeats of the redemption: another PIN hash with the device's commitment, and the PIN hash with another commitment
      await call(ins.process, at(3), { tokenId: code, tokenPinHash: hashTokenPIN(code, '10000003'), completionCommitment: own.commitment }),
      await call(ins.process, at(4), { tokenId: code, tokenPinHash: hashTokenPIN(code, PIN), completionCommitment: completionPair().commitment }),
    ].map((r) => [r.status, r.error]);
    expect(misses).toEqual([...Array(3).fill([403, NOT_COMPLETED]), [403, USED], [403, USED]]);   // before: the completions refused as "not been redeemed with this PIN", and the last [200, undefined], a repeat with the PIN hash answered from the record whatever else it carried
    const right = await call(ins.complete, device, { tokenId: code, walletId: DEVICE_WALLET, completionSecret: own.secret });
    expect([right.status, right.error, right.retryAfter, right.data?.errorCode]).toEqual([429, TOO_MANY_FOR_CODE, '3600', 'TOO_MANY_FOR_CODE']);   // before: [403, 'Enrollment denied: this enrollment code has not been redeemed with this PIN, or has already been used.', undefined, undefined]
    const repeat = await call(ins.process, device, { tokenId: code, tokenPinHash: hashTokenPIN(code, PIN), completionCommitment: own.commitment });
    expect([repeat.status, repeat.error, repeat.retryAfter, repeat.data?.errorCode]).toEqual([429, TOO_MANY_FOR_CODE, '3600', 'TOO_MANY_FOR_CODE']);   // before: [429, TOO_MANY_FOR_CODE, '3600', undefined], nothing that told this 429 from the network's
    expect(net.approvals).toEqual([]);
    const elsewhere = await call(ins.complete, device, { tokenId: other, walletId: DEVICE_WALLET, completionSecret: forOther.secret });
    expect(elsewhere.status).toBe(200);   // before: 403, the completion took the PIN hash
  });

  test('a code nobody redeemed is counted as a redeemed one is: five refused completions in the hour, then 429', async () => {
    const net = await network();
    const ins = await insurerOf(net);
    const unknown = generateEnrollmentCode('EMP-BIND');
    const sent: Answer[] = [];
    for (let i = 0; i < 6; i++) sent.push(await call(ins.complete, from(`203.0.113.${100 + i}`), { tokenId: unknown, walletId: STRANGER_WALLET, completionSecret: completionPair().secret }));
    expect(sent.map((r) => r.status)).toEqual([403, 403, 403, 403, 403, 429]);   // before: six 404s
    expect([sent[5].error, sent[5].retryAfter]).toEqual([TOO_MANY_FOR_CODE, '3600']);   // before: ['This enrollment code has not been redeemed. Redeem it first.', undefined]
  });

  test('one source past ten refused completions in a minute is answered 429 with Retry-After, and another source is still answered', async () => {
    const net = await network();
    const ins = await insurerOf(net);
    const source = from('192.0.2.50');
    const attempt = (req: StandIn) => call(ins.complete, req, { tokenId: generateEnrollmentCode('EMP-BIND'), walletId: STRANGER_WALLET, completionSecret: completionPair().secret });
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
type Member = Awaited<ReturnType<typeof memberAt>>;

/** Takes the member's device from a fresh state through redeeming `code` with `pin`, as the member's screen does. */
async function redeemOn(m: Member, code: string, pin: string = PIN): Promise<void> {
  expect((await m.dev('/onboarding/accept-token', { tokenId: code })).status).toBe(200);
  expect((await m.dev('/onboarding/generate-key')).status).toBe(200);
  expect((await m.dev('/onboarding/redeem', { tokenPIN: pin })).status).toBe(200);
}

/** The device's state as it holds it, with the completion secret it keeps between redeeming and completing. */
type HeldState = NautilusStateData & { completionSecret?: string };
/** The device's state, read from memory. */
const held = (m: Member): HeldState | null => m.server.getLocalState().getState() as HeldState | null;
/** What the device saved, read back from its state directory with its PIN. */
async function savedBy(m: Member): Promise<HeldState | null> {
  const saved = new NautilusLocalState(m.stateDir);
  await saved.unlock(DEVICE_PIN);
  return await saved.load() as HeldState | null;
}

describe('the member\'s device: its completion carries the secret it made when it redeemed, and its later deposit is signed as its wallet', () => {
  test('a stranger with the code is refused while the member is between redeeming and completing; the device completes, drops its secret, and files a later deposit the insurer accepts', async () => {
    const net = await network();
    const ins = await startedInsurerOf(net);
    const m = await memberAt(ins.url, net.sequencerUrl);
    const code = net.issue();
    await redeemOn(m, code);
    const secret = held(m)?.completionSecret;
    expect(secret).toMatch(/^[0-9a-f]{64}$/);   // before: undefined, the device kept no secret

    // Someone who learned the code tries to complete it for their own wallet before the device does.
    expect((await post(ins.url, '/enrollment/complete', { tokenId: code, walletId: STRANGER_WALLET })).status).toBe(403);   // before: 200, the stranger's wallet enrolled

    expect((await m.dev('/onboarding/derive-wallet', { ...FIELDS, consentRecord: CONSENT })).status).toBe(200);
    const enrolled = await m.dev('/onboarding/enroll', { recoveryPin: RECOVERY_PIN });
    expect([enrolled.status, enrolled.data?.insurerNotified]).toEqual([200, true]);   // before: [403, undefined], "Enrollment rejected by insurer", the code used by the stranger
    const walletId: string = enrolled.data.walletId;
    expect(net.approvals.map((a) => a.walletId)).toEqual([walletId]);                 // before: [STRANGER_WALLET]
    expect(held(m)?.completionSecret).toBeUndefined();
    expect(held(m)?.enrollment?.completedAt).toEqual(expect.any(Number));             // before: undefined, the device was refused
    // What the device saved, read back with its PIN, holds neither the secret nor the PIN hash.
    const saved = JSON.stringify(await savedBy(m));
    expect(saved).not.toContain(secret!);
    expect(saved).not.toContain(hashTokenPIN(code, PIN));

    // A pair of cards issued later: the deposit goes signed as the wallet, whose key the device registered at enrollment.
    expect(net.keys.has(walletId)).toBe(true);   // before: false, the device never enrolled
    const later = await m.dev('/recovery-card/issue', { recoveryPin: RECOVERY_PIN });
    expect(later.status).toBe(200);              // before: 409, the device never enrolled
    const card: RecoveryCardV3 = later.data.recoveryCards[0];
    const released = await post(ins.url, '/recovery/release', { cardId: card.id, pinVerifier: recoveryPinVerifier(RECOVERY_PIN, card.id) });
    expect(released.status).toBe(200);
    expect(combineEnrollmentKey(card, (released.json?.data ?? released.json).share2Hex)).toBe(m.server.getLocalState().useEnrollmentKey((k) => k));
  });

  test('the employer, holding the PIN hash, completes nothing for the code its employee\'s device redeemed, and the device completes with its secret', async () => {
    const net = await network();
    const ins = await startedInsurerOf(net);
    const m = await memberAt(ins.url, net.sequencerUrl);
    const code = net.issue();
    await redeemOn(m, code);
    // The employer saw the code consumed at its validate oracle, and holds the PIN hash its HR Tool bound the code to.
    const taken = await post(ins.url, '/enrollment/complete', { tokenId: code, walletId: EMPLOYER_WALLET, tokenPinHash: hashTokenPIN(code, PIN) });
    expect(taken.status).toBe(403);       // before: 200, the employer's wallet enrolled in its employee's plan, group and family
    expect(net.approvals).toEqual([]);    // before: the employer's wallet approved, signed as the insurer
    expect((await m.dev('/onboarding/derive-wallet', { ...FIELDS, consentRecord: CONSENT })).status).toBe(200);
    const enrolled = await m.dev('/onboarding/enroll', { recoveryPin: RECOVERY_PIN });
    expect([enrolled.status, enrolled.data?.insurerNotified]).toEqual([200, true]);   // before: [403, undefined], "Enrollment rejected by insurer", the code completed for the employer's wallet
    expect(net.approvals.map((a) => a.walletId)).toEqual([enrolled.data.walletId]);   // before: [EMPLOYER_WALLET]
  });

  test('a code past five wrong attempts in the hour is answered at the device\'s next redemption with 429, saying the code has had too many wrong attempts, to try again in an hour or ask HR, with the insurer\'s Retry-After', async () => {
    const net = await network();
    const ins = await startedInsurerOf(net);
    const m = await memberAt(ins.url, net.sequencerUrl);
    const code = net.issue();
    await redeemOn(m, code);
    // Five completions without the device's secret, from five places.
    for (let i = 0; i < 5; i++) expect((await post(ins.url, '/enrollment/complete', { tokenId: code, walletId: STRANGER_WALLET })).status).toBe(403);
    // The member redeems again, as the screen's Retry does.
    const r = await m.dev('/onboarding/redeem', { tokenPIN: PIN });
    expect([r.status, r.json?.error, r.retryAfter]).toEqual([429, CODE_BLOCKED, '3600']);   // before: [429, NETWORK_MINUTE, '3600'], told to try again in a minute
  });

  /** A stand-in insurer's answer to a redemption: redeemed, into G1 and P1. */
  const REDEEMED: Reply = { status: 200, body: { ok: true, data: { redeemed: true, groupIdHash: G1, planIdHash: P1, employerId: 'EMP-BIND' } } };

  /**
   * A stand-in insurer that answers the nth redemption (from 0) as `process(n)` says, once its answer is ready, every code
   * redeemed unless it says otherwise, and the nth completion as `complete(n)` says, noting what the device sent each
   * route.
   */
  async function recordingInsurer(complete: (n: number) => Reply, process: (n: number) => Reply | Promise<Reply> = () => REDEEMED) {
    const sent = { process: [] as any[], complete: [] as any[] };
    const url = await service(({ path: p, body }) => {
      if (p === '/enrollment/process') { sent.process.push(body); return process(sent.process.length - 1); }
      if (p === '/enrollment/complete') { sent.complete.push(body); return complete(sent.complete.length - 1); }
      return { status: 404, body: { ok: false, error: 'not stubbed ' + p } };
    });
    return { url, sent };
  }

  test('the device saves its secret before it first asks the insurer and keeps it until the insurer completes: every redemption carries its commitment, every completion the secret and no PIN hash, and the insurer\'s 429 at completion is answered 429 with its Retry-After', async () => {
    let m: Member | undefined;
    // What the device had saved when its first redemption reached the insurer, read there, before the insurer answered.
    let savedAtFirstAsk: HeldState | null | undefined;
    const insurer = await recordingInsurer(
      (n) => (n === 0
        ? { status: 429, headers: { 'Retry-After': '3600' }, body: { ok: false, error: TOO_MANY_FOR_CODE } }
        : { status: 200, body: { ok: true, data: { enrolled: true } } }),
      async (n) => {
        if (n > 0) return REDEEMED;
        savedAtFirstAsk = await savedBy(m!);
        return { status: 502, body: { ok: false, error: 'Cannot validate enrollment code: employer node unreachable.' } };
      },
    );
    m = await memberAt(insurer.url, 'http://127.0.0.1:1');
    const code = generateEnrollmentCode('EMP-BIND');
    expect((await m.dev('/onboarding/accept-token', { tokenId: code })).status).toBe(200);
    expect((await m.dev('/onboarding/generate-key')).status).toBe(200);
    // The insurer could not check the code the first time. Its redemption found the secret already saved, and the device
    // keeps it after the failure.
    expect((await m.dev('/onboarding/redeem', { tokenPIN: PIN })).status).toBe(502);
    const secret = savedAtFirstAsk?.completionSecret;
    expect(secret).toMatch(/^[0-9a-f]{64}$/);   // before: undefined, the device kept no secret; and read only once the insurer had answered, which a device that saved its secret after asking passed as well
    expect((await savedBy(m))?.completionSecret).toBe(secret);
    expect((await m.dev('/onboarding/redeem', { tokenPIN: PIN })).status).toBe(200);
    expect(insurer.sent.process.map((b) => b.completionCommitment)).toEqual([commitmentOf(secret!), commitmentOf(secret!)]);   // before: [undefined, undefined]
    expect(insurer.sent.process.map((b) => b.tokenPinHash)).toEqual([hashTokenPIN(code, PIN), hashTokenPIN(code, PIN)]);
    expect((await m.dev('/onboarding/derive-wallet', { ...FIELDS, consentRecord: CONSENT })).status).toBe(200);
    const limited = await m.dev('/onboarding/enroll', { recoveryPin: RECOVERY_PIN });
    expect([limited.status, limited.json?.error, limited.retryAfter]).toEqual([429, WAIT_TO_COMPLETE, '3600']);
    // The device stays where it was, so the same tap completes once the insurer answers again, with the same secret.
    expect(m.server.getOnboardingPhase()).toBe('wallet_derived');
    expect((await m.dev('/onboarding/enroll', { recoveryPin: RECOVERY_PIN })).status).toBe(200);
    expect(insurer.sent.complete.map((b) => b.completionSecret)).toEqual([secret, secret]);   // before: [undefined, undefined], the completion carried no secret
    expect(insurer.sent.complete.map((b) => b.tokenPinHash)).toEqual([undefined, undefined]);   // before: the PIN hash twice, sent again with each completion
    expect(held(m)?.completionSecret).toBeUndefined();
    expect(JSON.stringify(await savedBy(m))).not.toContain(secret!);
  });

  test('a device that kept no completion secret for its code says what to do and sends no completion', async () => {
    const insurer = await recordingInsurer(() => ({ status: 200, body: { ok: true, data: { enrolled: true } } }));
    const m = await memberAt(insurer.url, 'http://127.0.0.1:1');
    await redeemOn(m, generateEnrollmentCode('EMP-BIND'));
    // As a device that redeemed its code before it kept a secret leaves its state.
    delete held(m)?.completionSecret;
    expect((await m.dev('/onboarding/derive-wallet', { ...FIELDS, consentRecord: CONSENT })).status).toBe(200);
    const r = await m.dev('/onboarding/enroll', { recoveryPin: RECOVERY_PIN });
    expect([r.status, r.json?.error]).toEqual([409, NO_SECRET]);   // before: [200, undefined], completed with the PIN hash
    expect(insurer.sent.complete).toHaveLength(0);                  // before: 1
  });
});
