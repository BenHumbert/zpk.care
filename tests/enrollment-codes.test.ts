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
 * Enrollment codes — the acceptance test for phase A item A6: findings AUTH-13, C-2 (FIG. 4 `456`)
 * and A-31.
 *
 * Three defects, in the first secret the system ever handles.
 *
 *   - **The code was a serial number.** `TOKEN-<ms clock>-<counter>`: anyone who saw one could
 *     name its neighbours.
 *   - **Nothing ever consumed one.** The employer's `confirmEnrollment` was only reachable through
 *     an admin-only route the member node called without credentials, so every code stayed valid
 *     until it expired, and the one path that would have consumed it would also have handed the
 *     employer the member's wallet ID (rule I6).
 *   - **The oracle was open and fanned out.** `/tokens/:id/validate` answered anyone, with reason
 *     text and attempts remaining, and the insurer sent each member's code and PIN hash to EVERY
 *     tenant's oracle until one recognised it. A malicious tenant could brute-force an 8-digit PIN
 *     offline from that hash and enroll first. That is A-31.
 *
 * What this pins: codes are random, carry a routing prefix and have one canonical spelling; the
 * right PIN consumes a code and nothing else does; the oracle answers only a request the insurer
 * signed, over the body it actually received, once; the insurer asks exactly the employer the
 * prefix names, records a redemption against the wallet before anything else, and never fans out.
 *
 * Later, a review of the oracle's two rate limits found them in the wrong order. Every request
 * was recorded against the overall limit of 600 a minute before its caller's limit of 60 was
 * checked, so a caller its own limit had already refused kept spending the budget the insurer
 * needs: one client sending 600 unsigned requests a minute (60 answered 401, 540 refused 429, all
 * 600 counted) had the insurer's next signed request refused 429, and every enrollment with that
 * employer failed for the minute. And the insurer, the one caller the oracle answers, had the
 * same 60 a minute as any other, so its relays of every member's enrollment shared one small
 * budget. Now a caller over its limit is refused by a count that records nothing, before any
 * signature is checked; a request that does not prove it is the insurer's is charged to its
 * caller alone; and one the insurer signed spends only the overall budget. The test that a
 * caller is still refused after 60 such requests a minute passed on the route as it was; it holds
 * the new order to that limit.
 *
 * The review of round nine of the security fixes, 2026-10-24, found that the PIN hash, which the
 * completion had to present, is one the employer holds for every code it issues, so the employer
 * could complete its employee's just-redeemed code for a wallet of its own (A-108). Now every
 * redemption here carries the SHA-256 of a secret the device keeps, and every completion the
 * secret. What is true now, and pinned here: the insurer keeps the commitment with the redemption
 * and persists it, a restart included, so the device's completion is still answered after one;
 * the probe to the employer carries the PIN hash and its nonce and nothing of the commitment; and
 * a repeat of the redemption with another commitment is refused as the code used. What the binding
 * is for is tested in tests/enrollment-complete-binding.test.ts.
 */
import fs from 'fs';
import { createHash, randomBytes } from 'crypto';
import { hashString } from '../src/zkp/hash-utils.js';
import os from 'os';
import path from 'path';
import http from 'http';
import { Field } from 'o1js';
import {
  ENROLLMENT_CODE_ALPHABET,
  canonicalizeEnrollmentCode,
  enrollmentCodeRoutingPrefix,
  generateEnrollmentCode,
  isEnrollmentCode,
  normalizeTokenId,
  routingPrefixOf,
} from '../src/onboarding/enrollment-code.js';
import {
  ReplayCache,
  contentHashOf,
  signRequest,
  verifySignedRequest,
} from '../src/security/signed-request.js';
import { SlidingWindowLimiter } from '../src/security/rate-limit.js';
import { TokenAuthority } from '../src/onboarding/token-authority.js';
import { deriveInsurerKeypair, insurerPublicKeyFromSeed } from '../src/onboarding/employer-attestation.js';
import { hashTokenPIN } from '../src/tools/hr-tool-core.js';
import { NautilusAppServer } from '../src/nodes/nautilus-app-server.js';
import { buildEmployerRoutes } from '../src/nodes/routes/employer-routes.js';
import { buildInsurerRoutes } from '../src/nodes/routes/insurer-routes.js';
import { buildMemberRoutes } from '../src/nodes/routes/member-routes.js';
import { EmployerNode } from '../src/nodes/employer-node.js';
import type { NautilusAppConfig, RouteRegistration } from '../src/nodes/nautilus-app-types.js';
import type { EmployerAttestation } from '../src/l2/l2-types.js';
import type { NautilusStateData } from '../src/nodes/nautilus-local-state.js';

const CODE_RE = /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){4}$/;
const INSURER_SEED = 'insurer-seed-for-enrollment-code-tests';
const ATTACKER_SEED = 'a-seed-the-insurer-never-had';
const PIN = '48213976';
const DATE = '20260601';

// ─── Harness ────────────────────────────────────────────────────────────────────

const tempDirs: string[] = [];
function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

interface Captured { status: number; payload: any }
/** What a handler wrote, captured without a socket. */
function fakeRes(): { res: unknown; captured: () => Captured } {
  let status = 0;
  let payload: any = {};
  const res = {
    writeHead(code: number) { status = code; return this; },
    setHeader() { return this; },
    end(body?: string) {
      if (body) { try { payload = JSON.parse(body); } catch { payload = { raw: body }; } }
      return this;
    },
    get writableEnded() { return status !== 0; },
  };
  return { res, captured: () => ({ status, payload }) };
}
/** Enough of an IncomingMessage for a handler: the URL, lower-cased headers and a peer address (127.0.0.1 unless given). */
function fakeReq(opts: { url?: string; headers?: Record<string, string>; remoteAddress?: string } = {}) {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.headers ?? {})) headers[k.toLowerCase()] = v;
  return { url: opts.url ?? '/', headers, socket: { remoteAddress: opts.remoteAddress ?? '127.0.0.1' } };
}
function find(routes: RouteRegistration[], method: string, p: string): RouteRegistration {
  const r = routes.find((x) => x.method === method && x.path === p);
  if (!r) throw new Error(`route not registered: ${method} ${p}`);
  return r;
}
async function call(
  route: RouteRegistration,
  args: { req?: ReturnType<typeof fakeReq>; params?: Record<string, string>; body?: unknown } = {},
): Promise<Captured> {
  const { res, captured } = fakeRes();
  await route.handler((args.req ?? fakeReq()) as any, res as any, args.params ?? {}, new URLSearchParams(), args.body);
  return captured();
}
/** The statuses of `n` calls made one after another. */
async function statuses(n: number, send: (i: number) => Promise<Captured>): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push((await send(i)).status);
  return out;
}
function baseConfig(role: NautilusAppConfig['role'], stateDir: string, extra: Partial<NautilusAppConfig> = {}): NautilusAppConfig {
  return {
    role, port: 0, host: '127.0.0.1',
    sequencerUrl: 'http://127.0.0.1:1',
    stateDir, enableSSE: false, maxSseConnections: 0, allowedOrigins: [],
    adminToken: 'admin-token-for-tests',
    ...extra,
  } as NautilusAppConfig;
}
/** An attestation as the employer node would have loaded it from the sequencer after A9. */
function attestationFor(employerId: string, insurerPublicKeyHex: string): EmployerAttestation {
  return {
    v: 2, employerId, publicKeyHex: 'b'.repeat(64), authorizedPlanIds: ['PLAN-1'], enrollmentCap: 0,
    agreementCommitment: '1', documentHash: '2', effectiveDate: '20260101',
    employerSignature: 'c'.repeat(128), insurerSignature: 'd'.repeat(128), insurerPublicKeyHex,
    ts: 1792200000, applicationId: 'EMPAPP-test', attestationSeq: 1, signerName: 'Test', signerTitle: 'Test',
  };
}
/** A tiny JSON HTTP server standing in for a peer node. */
async function jsonServer(
  handle: (req: http.IncomingMessage, bodyText: string) => { status: number; body: unknown },
): Promise<{ server: http.Server; url: string }> {
  const server = http.createServer((req, res) => {
    let text = '';
    req.on('data', (c) => { text += c; });
    req.on('end', () => {
      const out = handle(req, text);
      res.writeHead(out.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { server, url: `http://127.0.0.1:${port}` };
}

// ─── 1. The code itself ─────────────────────────────────────────────────────────

describe('an enrollment code is random, self-routing and has one spelling', () => {
  test('a generated code is canonical and carries its employer’s routing prefix', () => {
    const code = generateEnrollmentCode('FERNHILL-TEST');
    expect(code).toMatch(CODE_RE);
    expect(routingPrefixOf(code)).toBe(enrollmentCodeRoutingPrefix('FERNHILL-TEST'));
    expect(isEnrollmentCode(code)).toBe(true);
  });

  test('codes do not repeat and are not derived from a clock', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(generateEnrollmentCode('FERNHILL-TEST'));
    expect(seen.size).toBe(200);
    for (const c of seen) expect(c).not.toMatch(/TOKEN-|\d{13}/);
  });

  test('every character comes from the Crockford alphabet, so none of I, L, O or U appears', () => {
    for (let i = 0; i < 50; i++) {
      const flat = generateEnrollmentCode('ACME').replace(/-/g, '');
      for (const ch of flat) expect(ENROLLMENT_CODE_ALPHABET).toContain(ch);
      expect(flat).not.toMatch(/[ILOU]/);
    }
  });

  test('the base32 bit reader is exact: all-zero and all-one bytes map to the alphabet’s ends', () => {
    const zeros = generateEnrollmentCode('ACME', () => Buffer.alloc(10, 0x00));
    const ones = generateEnrollmentCode('ACME', () => Buffer.alloc(10, 0xff));
    const prefix = enrollmentCodeRoutingPrefix('ACME');
    expect(zeros).toBe(`${prefix}-0000-0000-0000-0000`);
    expect(ones).toBe(`${prefix}-ZZZZ-ZZZZ-ZZZZ-ZZZZ`);
  });

  test('the routing prefix is deterministic per employer and differs between employers', () => {
    expect(enrollmentCodeRoutingPrefix('EMP-A')).toBe(enrollmentCodeRoutingPrefix('EMP-A'));
    const prefixes = new Set(['EMP-A', 'EMP-B', 'EMP-C', 'FERNHILL-TEST'].map(enrollmentCodeRoutingPrefix));
    expect(prefixes.size).toBeGreaterThanOrEqual(3);
    expect(() => enrollmentCodeRoutingPrefix('')).toThrow(/employerId/);
  });

  test('what a person types is repaired into the canonical form', () => {
    expect(canonicalizeEnrollmentCode(' 7q4k-9xmd 2pwt-r8hn-5vzc ')).toBe('7Q4K-9XMD-2PWT-R8HN-5VZC');
    // O reads as 0, I and L as 1 — the confusions a phone keyboard produces.
    expect(canonicalizeEnrollmentCode('7Q4K9XMD2PWTR8HN5VZC'.replace('0', 'O').replace('1', 'I')))
      .toBe('7Q4K-9XMD-2PWT-R8HN-5VZC');
    expect(canonicalizeEnrollmentCode('OIL0-9XMD-2PWT-R8HN-5VZC')).toBe('0110-9XMD-2PWT-R8HN-5VZC');
    // Canonical input is a fixed point.
    expect(canonicalizeEnrollmentCode('7Q4K-9XMD-2PWT-R8HN-5VZC')).toBe('7Q4K-9XMD-2PWT-R8HN-5VZC');
  });

  test('things that cannot be a code are not forced into one', () => {
    expect(canonicalizeEnrollmentCode('7Q4K-9XMD-2PWT-R8HN')).toBeNull();        // too short
    expect(canonicalizeEnrollmentCode('7Q4K-9XMD-2PWT-R8HN-5VZU')).toBeNull();   // U is not repaired
    expect(canonicalizeEnrollmentCode('TOKEN-001')).toBeNull();
    expect(canonicalizeEnrollmentCode('')).toBeNull();
    expect(routingPrefixOf('TOKEN-001')).toBeNull();
    // Identifiers that are not codes pass through untouched, so in-process callers keep working.
    expect(normalizeTokenId('TOKEN-001')).toBe('TOKEN-001');
    expect(normalizeTokenId('  CUSTOM-1 ')).toBe('CUSTOM-1');
    expect(normalizeTokenId('7q4k 9xmd 2pwt r8hn 5vzc')).toBe('7Q4K-9XMD-2PWT-R8HN-5VZC');
  });
});

// ─── 2. The authority ───────────────────────────────────────────────────────────

describe('TokenAuthority issues codes and consumes them at redemption', () => {
  function issued(authority: TokenAuthority, pin: string | null = PIN, validUntil = '20271231') {
    const { tokenId } = authority.generateToken('G1', 'PLAN-1', 'emp-hash', 'fam-hash', validUntil);
    if (pin !== null) authority.setTokenPinHash(tokenId, hashTokenPIN(tokenId, pin));
    return tokenId;
  }

  test('generated IDs are codes carrying the issuer’s prefix, not serial numbers', () => {
    const authority = new TokenAuthority('ACME');
    const a = issued(authority);
    const b = issued(authority);
    expect(a).toMatch(CODE_RE);
    expect(b).toMatch(CODE_RE);
    expect(a).not.toBe(b);
    expect(routingPrefixOf(a)).toBe(enrollmentCodeRoutingPrefix('ACME'));
    expect(a).not.toContain('TOKEN-');
  });

  test('a named ID is still honoured, which the in-process service and other tests rely on', () => {
    const authority = new TokenAuthority('ACME');
    const { tokenId } = authority.generateToken('G1', 'PLAN-1', 'e', 'f', '20271231', 'CUSTOM-1');
    expect(tokenId).toBe('CUSTOM-1');
  });

  test('the right PIN redeems and consumes; the code cannot be redeemed twice', () => {
    const authority = new TokenAuthority('ACME');
    const code = issued(authority);
    const first = authority.redeemTokenWithPin(code, DATE, hashTokenPIN(code, PIN));
    expect(first.valid).toBe(true);
    expect(first.consumed).toBe(true);
    expect(first.groupIdHash).toBeDefined();
    const record = authority.getTokenRecord(code)!;
    expect(record.status).toBe('consumed');
    expect(record.consumedAt).toBeDefined();
    expect(record.consumedByWalletId).toBeUndefined();   // the employer learns no wallet (I6)

    const second = authority.redeemTokenWithPin(code, DATE, hashTokenPIN(code, PIN));
    expect(second.valid).toBe(false);
    expect(second.reason).toMatch(/already consumed/i);
  });

  test('a wrong PIN neither redeems nor consumes, and five of them lock the code', () => {
    const authority = new TokenAuthority('ACME');
    const code = issued(authority);
    for (let i = 0; i < 5; i++) {
      const r = authority.redeemTokenWithPin(code, DATE, hashTokenPIN(code, '00000000'));
      expect(r.valid).toBe(false);
      expect(authority.getTokenRecord(code)!.status).toBe('unused');
    }
    const locked = authority.redeemTokenWithPin(code, DATE, hashTokenPIN(code, PIN));
    expect(locked.valid).toBe(false);
    expect(locked.reason).toMatch(/locked/i);
  });

  test('a code with no PIN bound cannot be redeemed at all, and is not consumed by trying', () => {
    const authority = new TokenAuthority('ACME');
    const code = issued(authority, null);
    const r = authority.redeemTokenWithPin(code, DATE, undefined);
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/PIN not set/i);
    expect(authority.getTokenRecord(code)!.status).toBe('unused');
  });

  test('an expired code is refused', () => {
    const authority = new TokenAuthority('ACME');
    const code = issued(authority, PIN, '20200101');
    const r = authority.redeemTokenWithPin(code, DATE, hashTokenPIN(code, PIN));
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/expired/i);
  });

  test('consumeToken with a wallet ID still works for the in-process service', () => {
    const authority = new TokenAuthority('ACME');
    const code = issued(authority);
    authority.consumeToken(code, Field(7));
    expect(authority.getTokenRecord(code)!.status).toBe('consumed');
  });
});

// ─── 3. Signed requests ─────────────────────────────────────────────────────────

describe('a signed request binds the signer, the path, the time and the body', () => {
  const insurer = deriveInsurerKeypair(INSURER_SEED);
  const attacker = deriveInsurerKeypair(ATTACKER_SEED);
  const PATH = '/tokens/ABCD-0000-0000-0000-0000/validate';
  const BODY = JSON.stringify({ tokenPinHash: '123' });
  const NOW = 1_792_300_000_000;

  function verify(headers: Record<string, string>, over: Partial<Parameters<typeof verifySignedRequest>[0]> = {}) {
    return verifySignedRequest({
      method: 'POST', path: PATH, headers, expectedSignerId: 'insurer',
      publicKeyHex: insurer.publicKeyHex, body: BODY, now: NOW, ...over,
    });
  }

  test('the insurer’s own signature verifies, and carries the body hash', () => {
    const headers = signRequest({ signerId: 'insurer', privateKey: insurer.privateKey, method: 'POST', path: PATH, body: BODY, now: NOW });
    expect(headers['X-Content-Hash']).toBe(contentHashOf(BODY));
    const r = verify(headers);
    expect(r.ok).toBe(true);
  });

  test('another key fails, even when it claims to be the insurer', () => {
    const headers = signRequest({ signerId: 'insurer', privateKey: attacker.privateKey, method: 'POST', path: PATH, body: BODY, now: NOW });
    const r = verify(headers);
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.reason).toMatch(/does not verify/);
  });

  test('a signer the route does not expect is refused before the signature is checked', () => {
    const headers = signRequest({ signerId: 'hr-tool', privateKey: insurer.privateKey, method: 'POST', path: PATH, body: BODY, now: NOW });
    const r = verify(headers);
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.reason).toMatch(/does not accept/);
  });

  test('a signature over a different path or method does not transfer', () => {
    const headers = signRequest({ signerId: 'insurer', privateKey: insurer.privateKey, method: 'POST', path: '/tokens/OTHER/validate', body: BODY, now: NOW });
    expect(verify(headers).ok).toBe(false);
    const h2 = signRequest({ signerId: 'insurer', privateKey: insurer.privateKey, method: 'GET', path: PATH, body: BODY, now: NOW });
    expect(verify(h2).ok).toBe(false);
  });

  test('the body actually received must hash to what was signed — AUTH-14’s defect does not recur', () => {
    const headers = signRequest({ signerId: 'insurer', privateKey: insurer.privateKey, method: 'POST', path: PATH, body: BODY, now: NOW });
    const r = verify(headers, { body: JSON.stringify({ tokenPinHash: '999' }) });
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.reason).toMatch(/content hash/);
    // And a body smuggled in under a signature made with no body is refused too.
    const noBody = signRequest({ signerId: 'insurer', privateKey: insurer.privateKey, method: 'POST', path: PATH, now: NOW });
    expect(noBody['X-Content-Hash']).toBeUndefined();
    expect(verify(noBody, { body: '' }).ok).toBe(true);
    expect(verify(noBody, { body: BODY }).ok).toBe(false);
  });

  test('a stale or future-dated signature is refused', () => {
    const headers = signRequest({ signerId: 'insurer', privateKey: insurer.privateKey, method: 'POST', path: PATH, body: BODY, now: NOW });
    expect(verify(headers, { now: NOW + 31_000 }).ok).toBe(false);
    expect(verify(headers, { now: NOW - 31_000 }).ok).toBe(false);
    expect(verify(headers, { now: NOW + 29_000 }).ok).toBe(true);
  });

  test('the same signature is accepted once', () => {
    const cache = new ReplayCache();
    const headers = signRequest({ signerId: 'insurer', privateKey: insurer.privateKey, method: 'POST', path: PATH, body: BODY, now: NOW });
    expect(verify(headers, { replayCache: cache }).ok).toBe(true);
    const again = verify(headers, { replayCache: cache });
    expect(again.ok).toBe(false);
    expect(again.ok ? '' : again.reason).toMatch(/already been presented/);
    // A failed attempt is not remembered, so it cannot be used to block a later honest one.
    const fresh = new ReplayCache();
    verify(headers, { replayCache: fresh, publicKeyHex: attacker.publicKeyHex });
    expect(fresh.size).toBe(0);
  });

  test('no signature, a malformed one, or no trusted key all refuse', () => {
    expect(verify({}).ok).toBe(false);
    expect(verify({ 'x-admin-signature': 'insurer:oops' }).ok).toBe(false);
    const headers = signRequest({ signerId: 'insurer', privateKey: insurer.privateKey, method: 'POST', path: PATH, body: BODY, now: NOW });
    const r = verify(headers, { publicKeyHex: '' });
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.reason).toMatch(/no trusted key/);
  });
});

// ─── 4. The limiter ─────────────────────────────────────────────────────────────

describe('the sliding-window limiter', () => {
  test('allows up to the limit inside the window, then refuses, then recovers', () => {
    const lim = new SlidingWindowLimiter(3, 1000);
    expect(lim.allow('a', 0)).toBe(true);
    expect(lim.allow('a', 100)).toBe(true);
    expect(lim.allow('a', 200)).toBe(true);
    expect(lim.allow('a', 300)).toBe(false);
    expect(lim.allow('b', 300)).toBe(true);        // keys are independent
    expect(lim.allow('a', 1001)).toBe(true);       // the first event has slid out
    expect(lim.count('a', 1001)).toBe(3);
  });
});

// ─── 5. The employer’s oracle ───────────────────────────────────────────────────

describe('the validate oracle answers only the insurer, and consumes what it validates', () => {
  async function employerWithCode(opts: { attest?: boolean; pin?: string | null } = {}) {
    const attest = opts.attest ?? true;
    const server = new NautilusAppServer(baseConfig('employer', makeTempDir('a6-emp-')));
    const routes = buildEmployerRoutes(server);
    const conf = await call(find(routes, 'POST', '/onboarding/configure'), { body: { employerId: 'FERNHILL-TEST' } });
    expect(conf.status).toBe(200);
    const node = server.getEntityNode() as EmployerNode;
    if (attest) node.setAttestation(attestationFor('FERNHILL-TEST', insurerPublicKeyFromSeed(INSURER_SEED)));
    const grp = await call(find(routes, 'POST', '/groups'), { body: { groupId: 'G1', planId: 'PLAN-1', effectiveDate: '20260101' } });
    expect(grp.status).toBe(201);
    const gen = await call(find(routes, 'POST', '/tokens/generate'), { body: { groupId: 'G1', employeeIdHash: 'emp-hash-1', validUntil: '20271231' } });
    expect(gen.status).toBe(201);
    const code = gen.payload.data.tokenId as string;
    expect(code).toMatch(CODE_RE);
    if (opts.pin !== null) {
      const set = await call(find(routes, 'POST', '/tokens/:tokenId/set-pin-hash'), {
        params: { tokenId: code }, body: { tokenPinHash: hashTokenPIN(code, opts.pin ?? PIN) },
      });
      expect(set.status).toBe(200);
    }
    return { server, routes, node, code, validate: find(routes, 'POST', '/tokens/:tokenId/validate') };
  }
  /** A validate call signed by `seed`, over `body`, optionally delivering a different body. */
  function signed(code: string, body: unknown, seed = INSURER_SEED, over: { signerId?: string; deliver?: unknown } = {}) {
    const p = `/tokens/${encodeURIComponent(code)}/validate`;
    const headers = signRequest({
      signerId: over.signerId ?? 'insurer', privateKey: deriveInsurerKeypair(seed).privateKey,
      method: 'POST', path: p, body: JSON.stringify(body),
    });
    return { req: fakeReq({ url: p, headers }), params: { tokenId: code }, body: over.deliver === undefined ? body : over.deliver };
  }
  /** An unsigned validate call, from `remoteAddress`. */
  function unsigned(code: string, remoteAddress = '127.0.0.1') {
    return { req: fakeReq({ url: `/tokens/${code}/validate`, remoteAddress }), params: { tokenId: code }, body: { tokenPinHash: 'x' } };
  }

  test('unsigned, it refuses before looking at the code', async () => {
    const e = await employerWithCode();
    const r = await call(e.validate, { req: fakeReq({ url: `/tokens/${e.code}/validate` }), params: { tokenId: e.code }, body: { tokenPinHash: hashTokenPIN(e.code, PIN) } });
    expect(r.status).toBe(401);
    expect(r.payload.error).toMatch(/not signed/);
    expect(e.node.getTokenRecord(e.code)!.status).toBe('unused');
  });

  test('unsigned with no attestation loaded is still "not signed": an outsider learns nothing about the node', async () => {
    const e = await employerWithCode({ attest: false });
    const r = await call(e.validate, { req: fakeReq({ url: `/tokens/${e.code}/validate` }), params: { tokenId: e.code }, body: { tokenPinHash: 'x' } });
    expect(r.status).toBe(401);
    expect(r.payload.error).toMatch(/not signed/);
  });

  test('a signature from any key but the insurer’s is refused', async () => {
    const e = await employerWithCode();
    const r = await call(e.validate, signed(e.code, { tokenPinHash: hashTokenPIN(e.code, PIN) }, ATTACKER_SEED));
    expect(r.status).toBe(401);
    expect(r.payload.error).toMatch(/does not verify/);
  });

  test('a signed envelope with a swapped body is refused', async () => {
    const e = await employerWithCode();
    const r = await call(e.validate, signed(e.code, { tokenPinHash: 'what-was-signed' }, INSURER_SEED, { deliver: { tokenPinHash: hashTokenPIN(e.code, PIN) } }));
    expect(r.status).toBe(401);
    expect(r.payload.error).toMatch(/content hash/);
    expect(e.node.getTokenRecord(e.code)!.status).toBe('unused');
  });

  test('the insurer with a wrong PIN hash gets a verdict and the code stays unused', async () => {
    const e = await employerWithCode();
    const r = await call(e.validate, signed(e.code, { tokenPinHash: hashTokenPIN(e.code, '11111111') }));
    expect(r.status).toBe(200);
    expect(r.payload.data.valid).toBe(false);
    expect(r.payload.data.reason).toMatch(/Invalid enrollment PIN/);
    expect(e.node.getTokenRecord(e.code)!.status).toBe('unused');
  });

  test('the insurer with the right PIN hash redeems it: consumed, roster enrolled, cap counted, once', async () => {
    const e = await employerWithCode();
    const good = { tokenPinHash: hashTokenPIN(e.code, PIN) };
    const first = signed(e.code, good);
    const r1 = await call(e.validate, first);
    expect(r1.status).toBe(200);
    expect(r1.payload.data.valid).toBe(true);
    expect(r1.payload.data.consumed).toBe(true);
    expect(e.node.getTokenRecord(e.code)!.status).toBe('consumed');
    const entry = e.node.listRoster().find((x) => x.tokenId === e.code)!;
    expect(entry.status).toBe('enrolled');
    expect('walletId' in entry).toBe(false);          // I6: the roster has no wallet column at all (B6)
    expect(e.node.getGroup('G1')!.enrolledCount).toBe(1);

    // The identical signed request again is a replay.
    const replay = await call(e.validate, first);
    expect(replay.status).toBe(401);
    expect(replay.payload.error).toMatch(/already been presented/);

    // A fresh signature over the same code gets the verdict: already consumed.
    const r2 = await call(e.validate, signed(e.code, good));
    expect(r2.status).toBe(200);
    expect(r2.payload.data.valid).toBe(false);
    expect(r2.payload.data.reason).toMatch(/already consumed/);
    expect(e.node.getGroup('G1')!.enrolledCount).toBe(1);
  });

  test('with no attestation loaded it refuses: it cannot know who the insurer is', async () => {
    const e = await employerWithCode({ attest: false });
    const r = await call(e.validate, signed(e.code, { tokenPinHash: hashTokenPIN(e.code, PIN) }));
    expect(r.status).toBe(503);
    expect(r.payload.error).toMatch(/no attestation/);
  });

  test('an orphan with no PIN bound is reported as such, not redeemed', async () => {
    const e = await employerWithCode({ pin: null });
    const r = await call(e.validate, signed(e.code, { tokenPinHash: hashTokenPIN(e.code, PIN) }));
    expect(r.status).toBe(409);
    expect(r.payload.error).toMatch(/PIN hash not yet set/);
    expect(e.node.getTokenRecord(e.code)!.status).toBe('unused');
  });

  test('a code it never issued is "not found", which is how the insurer knows to stop', async () => {
    const e = await employerWithCode();
    const other = generateEnrollmentCode('SOMEONE-ELSE');
    const r = await call(e.validate, signed(other, { tokenPinHash: 'x' }));
    expect(r.status).toBe(200);
    expect(r.payload.data.valid).toBe(false);
    expect(r.payload.data.reason).toMatch(/not found/i);
  });

  test('a caller-chosen code is refused at generation', async () => {
    const e = await employerWithCode();
    const r = await call(find(e.routes, 'POST', '/tokens/generate'), { body: { groupId: 'G1', employeeIdHash: 'emp-hash-2', validUntil: '20271231', tokenId: 'TKN-CHOSEN' } });
    expect(r.status).toBe(400);
    expect(r.payload.error).toMatch(/caller-chosen/);
  });

  test('one client’s 600 unsigned requests in a minute leave the insurer’s next signed request answered', async () => {
    const e = await employerWithCode();
    const junk = await statuses(600, () => call(e.validate, unsigned(e.code, '203.0.113.7')));
    expect(junk).toEqual([...Array(60).fill(401), ...Array(540).fill(429)]);
    const r = await call(e.validate, signed(e.code, { tokenPinHash: hashTokenPIN(e.code, PIN) }));
    expect([r.status, r.payload.data?.valid]).toEqual([200, true]);   // before: [429, undefined], the junk had spent the overall 600
    expect(e.node.getTokenRecord(e.code)!.status).toBe('consumed');   // before: 'unused'
  });

  test('the insurer’s signed requests are not held to one caller’s 60 a minute', async () => {
    const e = await employerWithCode();
    const other = generateEnrollmentCode('SOMEONE-ELSE');
    // Each over a body of its own, so each signature is new and none is refused as a replay.
    const answered = await statuses(61, (i) => call(e.validate, signed(other, { tokenPinHash: `pin-hash-${i}` })));
    expect(answered).toEqual(Array(61).fill(200));                     // before: the 61st was 429
    const r = await call(e.validate, signed(e.code, { tokenPinHash: hashTokenPIN(e.code, PIN) }));
    expect([r.status, r.payload.data?.valid]).toEqual([200, true]);   // before: [429, undefined]
  });

  test('the insurer’s signed requests spend the overall budget: 600 a minute are answered and the next waits', async () => {
    const e = await employerWithCode();
    const other = generateEnrollmentCode('SOMEONE-ELSE');
    const answered = await statuses(600, (i) => call(e.validate, signed(other, { tokenPinHash: `pin-hash-${i}` })));
    expect(answered).toEqual(Array(600).fill(200));                    // before: 429 from the 61st on
    const over = await call(e.validate, signed(e.code, { tokenPinHash: hashTokenPIN(e.code, PIN) }));
    expect([over.status, over.payload.error]).toEqual([429, 'Too many validation requests. Try again in a minute.']);
    expect(e.node.getTokenRecord(e.code)!.status).toBe('unused');
  });

  test('a caller’s requests that do not prove they are the insurer’s are still refused 429 after 60 a minute', async () => {
    const e = await employerWithCode();
    expect(await statuses(30, () => call(e.validate, unsigned(e.code)))).toEqual(Array(30).fill(401));
    // Signed with a key that is not the insurer's: charged as an unsigned request is.
    const forged = await statuses(30, (i) => call(e.validate, signed(e.code, { tokenPinHash: `guess-${i}` }, ATTACKER_SEED)));
    expect(forged).toEqual(Array(30).fill(401));
    const over = await call(e.validate, unsigned(e.code));
    expect([over.status, over.payload.error]).toEqual([429, 'Too many validation requests. Try again in a minute.']);
    // The refusal comes before any signature is checked, so a flood costs no verification: while
    // its caller is over the limit, a request the insurer signed waits too.
    expect((await call(e.validate, signed(e.code, { tokenPinHash: hashTokenPIN(e.code, PIN) }))).status).toBe(429);
    expect(e.node.getTokenRecord(e.code)!.status).toBe('unused');

    // A node with no attestation cannot verify anyone, so what it is sent is charged to its caller too.
    const bare = await employerWithCode({ attest: false });
    const unverifiable = await statuses(60, (i) => call(bare.validate, signed(bare.code, { tokenPinHash: `pin-hash-${i}` })));
    expect(unverifiable).toEqual(Array(60).fill(503));
    expect((await call(bare.validate, signed(bare.code, { tokenPinHash: 'pin-hash-60' }))).status).toBe(429);
  });

  test('the routes and methods that carried a wallet ID to the employer are gone', async () => {
    const server = new NautilusAppServer(baseConfig('employer', makeTempDir('a6-emp-')));
    const paths = buildEmployerRoutes(server).map((r) => `${r.method} ${r.path}`);
    expect(paths).not.toContain('POST /enrollment/confirm');
    expect(paths).not.toContain('POST /tokens/:tokenId/submit');
    expect((EmployerNode.prototype as unknown as Record<string, unknown>).confirmEnrollment).toBeUndefined();
    expect((EmployerNode.prototype as unknown as Record<string, unknown>).submitTokenToInsurer).toBeUndefined();
    // And the oracle that replaced them is limited per caller: a caller over its limit is refused by
    // a count, before any signature is checked, and a request that does not prove it is the
    // insurer's is charged to its caller.
    const src = fs.readFileSync('src/nodes/routes/employer-routes.ts', 'utf-8');
    expect(src).toContain('validatePerCaller.count(caller) >= VALIDATE_PER_CALLER_PER_MINUTE');   // before: validateOverall.allow('*') || !validatePerCaller.allow(caller)
    expect(src).toContain('validatePerCaller.allow(caller)');
  });
});

// ─── 6. The insurer ─────────────────────────────────────────────────────────────

describe('the insurer redeems a code with the employer that issued it, and nobody else', () => {
  interface Probe { path: string; body: string; verified: boolean }
  const probesA: Probe[] = [];
  const probesB: Probe[] = [];
  let answerA: () => { status: number; body: unknown };
  let answerB: () => { status: number; body: unknown };
  // Real hashes, because completion resolves the plan from its hash and approves the wallet with the engine (Step 2 commit two).
  const G1 = hashString('GRP-1').toString();
  const P1 = hashString('PLAN-1').toString();
  const F1 = hashString('FAM-1').toString(); // A-34: the code's opaque family hash
  const PLAN_1 = {
    planId: 'PLAN-1', name: 'Plan 1', coverageType: 1, copayAmountCents: 1000, deductibleAmountCents: 50000, oopMaxCents: 800000, annualBenefitMaxCents: 0, familyDeductibleAmountCents: 0, familyOopMaxCents: 0, familyAnnualBenefitMaxCents: 0, formularyNdcs: [], networkProviderWalletIds: [], published: true, createdAt: 0, updatedAt: 0,
    // Plan-bound formularies: a published plan carries the terms its members are bound to
    publishedTerms: { copayAmountCents: 1000, coverageType: 1, deductibleAmountCents: 50000, oopMaxCents: 800000, annualBenefitMaxCents: 0, familyDeductibleAmountCents: 0, familyOopMaxCents: 0, familyAnnualBenefitMaxCents: 0, formularyNdcs: [], networkProviderWalletIds: [], formularyRoot: '12345', networkRoot: '0', publishedAt: 0 },
  };
  let plansAnswer = (): unknown[] => [PLAN_1];
  const approvals: unknown[] = [];
  /** A secret as a device makes one for a code, and the SHA-256 of it every redemption carries (A-108). */
  const completionPair = (): { secret: string; commitment: string } => {
    const secret = randomBytes(32).toString('hex');
    return { secret, commitment: createHash('sha256').update(Buffer.from(secret, 'hex')).digest('hex') };
  };
  /** The device's secret for codeA, and a commitment for redemptions whose completion no test asks for. */
  const DEVICE_A = completionPair();
  const ANY_COMMITMENT = completionPair().commitment;
  const VALID = () => ({ status: 200, body: { ok: true, data: { valid: true, groupIdHash: G1, planIdHash: P1, familyIdHash: F1, consumed: true } } });
  const NOT_FOUND = () => ({ status: 200, body: { ok: true, data: { valid: false, reason: 'Token not found' } } });
  const servers: http.Server[] = [];
  let seqUrl: string;
  let stateDir: string;
  let main: { server: NautilusAppServer; routes: RouteRegistration[]; process: RouteRegistration; complete: RouteRegistration };

  function stubEmployer(probes: Probe[], answer: () => { status: number; body: unknown }) {
    return jsonServer((req, bodyText) => {
      const v = verifySignedRequest({
        method: 'POST', path: req.url ?? '/', headers: req.headers as Record<string, string | string[] | undefined>,
        expectedSignerId: 'insurer', publicKeyHex: insurerPublicKeyFromSeed(INSURER_SEED), body: bodyText,
      });
      probes.push({ path: req.url ?? '/', body: bodyText, verified: v.ok });
      return answer();
    });
  }
  async function insurer(dir: string, seed: string | undefined) {
    const server = new NautilusAppServer(baseConfig('insurer', dir, { sequencerUrl: seqUrl, insurerSigningSeed: seed }));
    // Unlocked, so persistence is real in this test; in a deployment this is the node's own PIN.
    const ls = server.getLocalState();
    await ls.unlock('123456');
    if (!(await ls.load())) {
      await ls.save({ version: 1, role: 'insurer', onboarding: { phase: 'awaiting_token' }, lastSavedAt: '' } as NautilusStateData);
      await ls.load();
    }
    const routes = buildInsurerRoutes(server);
    const conf = await call(find(routes, 'POST', '/onboarding/configure'), { body: {} });
    expect(conf.status).toBe(200);
    return { server, routes, process: find(routes, 'POST', '/enrollment/process'), complete: find(routes, 'POST', '/enrollment/complete') };
  }

  beforeAll(async () => {
    answerA = VALID;
    answerB = NOT_FOUND;
    const a = await stubEmployer(probesA, () => answerA());
    const b = await stubEmployer(probesB, () => answerB());
    servers.push(a.server, b.server);
    const seq = await jsonServer((req, bodyText) => {
      if ((req.url ?? '') === '/interactive/approve-member') { approvals.push(JSON.parse(bodyText || '{}')); return { status: 200, body: { approved: true } }; }
      const rpc = JSON.parse(bodyText || '{}') as { method?: string };
      if (rpc.method === 'l2_getPlans') return { status: 200, body: { jsonrpc: '2.0', id: 1, result: plansAnswer() } };
      if (rpc.method === 'l2_listEmployerNodes') {
        return { status: 200, body: { jsonrpc: '2.0', id: 1, result: [
          { employerId: 'EMP-A', employerNodeUrl: a.url },
          { employerId: 'EMP-B', employerNodeUrl: b.url },
        ] } };
      }
      return { status: 200, body: { jsonrpc: '2.0', id: 1, result: null } };
    });
    servers.push(seq.server);
    seqUrl = seq.url;
    stateDir = makeTempDir('a6-ins-');
    main = await insurer(stateDir, INSURER_SEED);
  });
  afterAll(async () => {
    for (const s of servers) await new Promise<void>((resolve) => s.close(() => resolve()));
  });

  const codeA = generateEnrollmentCode('EMP-A');

  test('a code is required', async () => {
    const r = await call(main.process, { body: { walletId: 'W0' } });
    expect(r.status).toBe(400);
    expect(r.payload.error).toMatch(/enrollment code is required/i);
    expect(probesA.length + probesB.length).toBe(0);
  });

  test('the prefix routes the probe to the issuing employer only, signed as the insurer', async () => {
    // C2: the code is redeemed before the member has a wallet; the insurer answers the group and plan.
    const r = await call(main.process, { body: { tokenId: codeA.toLowerCase(), tokenPinHash: 'pinhash-1', completionCommitment: DEVICE_A.commitment } });
    expect(r.status).toBe(200);
    expect(r.payload.data.redeemed).toBe(true);
    expect(r.payload.data.employerId).toBe('EMP-A');
    expect(r.payload.data.groupIdHash).toBe(G1);
    expect(r.payload.data.planIdHash).toBe(P1);
    expect(probesA).toHaveLength(1);
    expect(probesB).toHaveLength(0);                            // never fanned out
    expect(probesA[0].verified).toBe(true);                     // a real insurer signature over the body
    expect(probesA[0].path).toBe(`/tokens/${codeA}/validate`);
    // the relay names the PIN hash and a fresh nonce, so no two relays share a signature (A-93), and nothing of the
    // device's commitment, which the employer must never hold (A-108)
    expect(JSON.parse(probesA[0].body)).toEqual({ tokenPinHash: 'pinhash-1', nonce: expect.stringMatching(/^[0-9a-f]{32}$/) });
  });

  test('the redemption is persisted immediately, with no wallet yet', async () => {
    const data = main.server.getLocalState().getState() as unknown as { redeemedEnrollmentCodes?: Record<string, { walletId: string | null; pinHash: string | null; completionCommitment?: string }> };
    expect(data.redeemedEnrollmentCodes?.[codeA]?.walletId).toBeNull();
    expect(data.redeemedEnrollmentCodes?.[codeA]?.pinHash).toBe('pinhash-1');
    expect(data.redeemedEnrollmentCodes?.[codeA]?.completionCommitment).toBe(DEVICE_A.commitment);   // before: undefined, nothing bound the completion to the device
  });
  test('complete binds the wallet to the redemption and records the enrollment with the canonical code', async () => {
    const r = await call(main.complete, { body: { walletId: '11', tokenId: codeA.toLowerCase(), completionSecret: DEVICE_A.secret } });
    expect(r.status).toBe(200);
    expect(r.payload.data.enrolled).toBe(true);
    expect(r.payload.data.tokenId).toBe(codeA);                 // stored canonical, not as typed
    expect(r.payload.data.groupIdHash).toBe(G1);
    // completion approved the wallet with the engine, naming the plan it resolved from the hash
    expect(approvals.length).toBe(1);
    expect(approvals[0]).toMatchObject({ walletId: '11', groupIdHash: G1, planIdHash: P1, planId: 'PLAN-1', employerId: 'EMP-A', familyIdHash: F1 });
    const data = main.server.getLocalState().getState() as unknown as { redeemedEnrollmentCodes?: Record<string, { walletId: string | null }> };
    expect(data.redeemedEnrollmentCodes?.[codeA]?.walletId).toBe('11');
    expect(probesA).toHaveLength(1);                            // completion asks the employer nothing
  });

  test('the same device retrying is idempotent and does not ask the employer again', async () => {
    // A device that died between redemption and derivation presents the same code, PIN hash and commitment.
    const again = await call(main.process, { body: { tokenId: codeA, tokenPinHash: 'pinhash-1', completionCommitment: DEVICE_A.commitment } });
    expect(again.status).toBe(200);
    expect(again.payload.data.repeated).toBe(true);
    expect(again.payload.data.groupIdHash).toBe(G1);
    // Simulate a crash between the completion and the registry write: the same wallet completes again.
    ((main.server as unknown as { __enrollmentRegistry: Map<string, unknown> }).__enrollmentRegistry).delete('11');
    const r = await call(main.complete, { body: { walletId: '11', tokenId: codeA, completionSecret: DEVICE_A.secret } });
    expect(r.status).toBe(200);
    expect(probesA).toHaveLength(1);
  });

  test('any other wallet, any other PIN hash or any other commitment presenting the used code is refused, without asking the employer', async () => {
    const otherWallet = await call(main.complete, { body: { walletId: '22', tokenId: codeA } });
    expect(otherWallet.status).toBe(403);
    expect(otherWallet.payload.error).toMatch(/already been used/);
    const otherPin = await call(main.process, { body: { tokenId: codeA, tokenPinHash: 'pinhash-other', completionCommitment: DEVICE_A.commitment } });
    expect(otherPin.status).toBe(403);
    expect(otherPin.payload.error).toMatch(/already been used/);
    // The PIN hash the code was redeemed with, which its employer holds, with a commitment of someone else's.
    const otherCommitment = await call(main.process, { body: { tokenId: codeA, tokenPinHash: 'pinhash-1', completionCommitment: ANY_COMMITMENT } });
    expect([otherCommitment.status, otherCommitment.payload.error]).toEqual([403, 'Enrollment denied: this enrollment code has already been used.']);   // before: [200, undefined], answered from the record
    expect(probesA).toHaveLength(1);
  });

  test('a code whose prefix matches no registered employer is refused without asking anyone', async () => {
    const r = await call(main.process, { body: { walletId: 'W3', tokenId: generateEnrollmentCode('NOBODY'), tokenPinHash: 'x', completionCommitment: ANY_COMMITMENT } });
    expect(r.status).toBe(403);
    expect(r.payload.error).toMatch(/not recognized by any registered employer/);
    expect(probesA.length + probesB.length).toBe(1);
  });

  test('a wrong PIN is the employer’s verdict and is not recorded as a redemption', async () => {
    answerA = () => ({ status: 200, body: { ok: true, data: { valid: false, reason: 'Invalid enrollment PIN (4 attempts remaining)' } } });
    const code = generateEnrollmentCode('EMP-A');
    const r = await call(main.process, { body: { walletId: 'W4', tokenId: code, tokenPinHash: 'wrong', completionCommitment: ANY_COMMITMENT } });
    expect(r.status).toBe(403);
    expect(r.payload.error).toMatch(/Invalid enrollment PIN/);
    expect(probesA).toHaveLength(2);
    // Not redeemed, so the next attempt asks the employer again rather than refusing as "used".
    answerA = VALID;
    const again = await call(main.process, { body: { walletId: 'W4', tokenId: code, tokenPinHash: 'right', completionCommitment: ANY_COMMITMENT } });
    expect(again.status).toBe(200);
    expect(probesA).toHaveLength(3);
  });

  test('an employer that will not answer the insurer is a 502, never read as a verdict', async () => {
    answerB = () => ({ status: 401, body: { ok: false, error: 'This oracle answers only the insurer: the signature does not verify.' } });
    const r = await call(main.process, { body: { walletId: 'W5', tokenId: generateEnrollmentCode('EMP-B'), tokenPinHash: 'x', completionCommitment: ANY_COMMITMENT } });
    expect(r.status).toBe(502);
    expect(r.payload.error).toMatch(/returned 401/);
    answerB = NOT_FOUND;
  });

  test('an identifier that is not a code is never fanned out: only a named employer is asked', async () => {
    const before = probesA.length + probesB.length;
    const bBefore = probesB.length;
    const r1 = await call(main.process, { body: { walletId: 'W6', tokenId: 'TOKEN-001', tokenPinHash: 'x', completionCommitment: ANY_COMMITMENT } });
    expect(r1.status).toBe(403);
    expect(probesA.length + probesB.length).toBe(before);
    const r2 = await call(main.process, { body: { walletId: 'W6', tokenId: 'TOKEN-001', tokenPinHash: 'x', completionCommitment: ANY_COMMITMENT, employerId: 'EMP-B' } });
    expect(r2.status).toBe(403);
    expect(r2.payload.error).toMatch(/not recognized by its employer/);
    expect(probesB).toHaveLength(bBefore + 1);
    expect(probesA.length + probesB.length).toBe(before + 1);
  });

  test('without a signing seed the insurer refuses rather than probing unsigned', async () => {
    const other = await insurer(makeTempDir('a6-ins-noseed-'), undefined);
    const before = probesA.length;
    const r = await call(other.process, { body: { walletId: 'W7', tokenId: generateEnrollmentCode('EMP-A'), tokenPinHash: 'x', completionCommitment: ANY_COMMITMENT } });
    expect(r.status).toBe(500);
    expect(r.payload.error).toMatch(/signing seed/);
    expect(probesA).toHaveLength(before);
  });

  test('redeemed codes survive a restart, with the commitment that completes them', async () => {
    const restarted = await insurer(stateDir, INSURER_SEED);
    const before = probesA.length;
    const otherPin = await call(restarted.process, { body: { tokenId: codeA, tokenPinHash: 'pinhash-9', completionCommitment: DEVICE_A.commitment } });
    expect(otherPin.status).toBe(403);
    expect(otherPin.payload.error).toMatch(/already been used/);
    const otherWallet = await call(restarted.complete, { body: { walletId: '99', tokenId: codeA } });
    expect(otherWallet.status).toBe(403);
    // The device that redeemed it, completing again after the restart, is still answered.
    const own = await call(restarted.complete, { body: { walletId: '11', tokenId: codeA, completionSecret: DEVICE_A.secret } });
    expect(own.status).toBe(200);   // before: 403, the completion took the PIN hash
    expect(probesA).toHaveLength(before);
  });

  test('the fan-out is gone from the source, and the probe is signed', () => {
    const src = fs.readFileSync('src/nodes/routes/insurer-routes.ts', 'utf-8');
    expect(src).not.toContain('__already_validated__');
    expect(src).toContain("signRequest({ signerId: 'insurer'");
    expect(src).toContain('enrollmentCodeRoutingPrefix(n.employerId) === prefix');
  });

  test('a family the employer names in anything but a hash is no family: the plain ID never reaches the engine (A-34)', async () => {
    answerA = () => ({ status: 200, body: { ok: true, data: { valid: true, groupIdHash: G1, planIdHash: P1, familyIdHash: 'FAM-PLAINTEXT-1', consumed: true } } });
    const code = generateEnrollmentCode('EMP-A');
    const family = completionPair();
    expect((await call(main.process, { body: { tokenId: code, tokenPinHash: 'pin-fam', completionCommitment: family.commitment } })).status).toBe(200);
    expect((await call(main.complete, { body: { walletId: '33', tokenId: code, completionSecret: family.secret } })).status).toBe(200);
    const last = approvals[approvals.length - 1] as Record<string, unknown>;
    expect(last.walletId).toBe('33');
    expect(last.familyIdHash).toBeNull();
    expect(JSON.stringify(approvals)).not.toContain('FAM-PLAINTEXT');
    answerA = VALID;
  });

  test('a plan without published terms enrols no one, and the engine is not asked to approve the wallet (plan-bound formularies)', async () => {
    // a plan published before the terms were kept (its formularyRoot is the overlay version), or a draft never published
    for (const unpublished of [{ ...PLAN_1, formularyRoot: '1', publishedTerms: undefined }, { ...PLAN_1, published: false, publishedTerms: undefined }]) {
      plansAnswer = () => [unpublished];
      const code = generateEnrollmentCode('EMP-A');
      const own = completionPair();
      expect((await call(main.process, { body: { tokenId: code, tokenPinHash: `pin-${unpublished.published}`, completionCommitment: own.commitment } })).status).toBe(200);
      const before = approvals.length;
      const r = await call(main.complete, { body: { walletId: unpublished.published ? '44' : '45', tokenId: code, completionSecret: own.secret } });
      expect(r.status).toBe(409);
      expect(r.payload.error).toMatch(/not published/);
      expect(approvals.length).toBe(before);
    }
    plansAnswer = () => [PLAN_1];
  });
});

// ─── 7. The member node ─────────────────────────────────────────────────────────

describe('the member node stores the canonical code and tells the employer nothing', () => {
  test('accept-token repairs what was typed and stores one spelling', async () => {
    const server = new NautilusAppServer(baseConfig('member', makeTempDir('a6-mem-')));
    const routes = buildMemberRoutes(server);
    const unlocked = await call(find(routes, 'POST', '/onboarding/unlock'), { body: { pin: '123456' } });
    expect(unlocked.status).toBe(200);
    const accepted = await call(find(routes, 'POST', '/onboarding/accept-token'), { body: { tokenId: ' 7q4k-9xmd 2pwt-r8hn-5vzc ' } });
    expect(accepted.status).toBe(200);
    expect(accepted.payload.data.tokenId).toBe('7Q4K-9XMD-2PWT-R8HN-5VZC');
    expect(server.getLocalState().getState()!.onboarding.tokenId).toBe('7Q4K-9XMD-2PWT-R8HN-5VZC');
  });

  test('the wallet ID no longer travels to the employer', () => {
    const src = fs.readFileSync('src/nodes/routes/member-routes.ts', 'utf-8');
    // The comment that explains the removal names the route; the fetch that used it must be gone.
    expect(src).not.toMatch(/\/enrollment\/confirm`/);
    expect(src).not.toContain('employerNotified');
    expect(src).toContain('canonicalizeEnrollmentCode(b.tokenId)');
  });
});
