/**
 * Recovery cards — plan item A12b, risk PRD-1.
 *
 * Nothing on a card depends on the PIN: it carries one share of the enrollment key and a random id.
 * The other share, the identity salt, the group and plan hashes and a device-computed PIN verifier
 * are deposited with the insurer, which releases them only against the verifier, attempt-limited per
 * card. Two cards, independent shares, independent revocation.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  splitEnrollmentKey, combineEnrollmentKey, issueRecoveryCards, recoveryPinVerifier, isRecoveryCardV3, recoveryCardBytes,
  validateRecoveryPin, NFC_CAPACITY_BYTES,
} from '../src/security/recovery-card.js';
import { generateEnrollmentKey, generateIdentitySalt } from '../src/wallets/wallet-derivation.js';
import { NautilusAppServer } from '../src/nodes/nautilus-app-server.js';
import type { NautilusAppConfig } from '../src/nodes/nautilus-app-types.js';
import { buildInsurerRoutes } from '../src/nodes/routes/insurer-routes.js';

jest.setTimeout(60_000);

const KEY = generateEnrollmentKey();
const SALT = generateIdentitySalt();
const GROUP = '123456789';
const PLAN = '987654321';

describe('the split', () => {
  test('a card holds one share and an id, about ninety bytes, and nothing else', () => {
    const { card, share2Hex } = splitEnrollmentKey(KEY);
    expect(isRecoveryCardV3(card)).toBe(true);
    expect(Object.keys(card).sort()).toEqual(['id', 's', 'v']);
    expect(recoveryCardBytes(card)).toBeLessThan(160);
    expect(recoveryCardBytes(card)).toBeLessThanOrEqual(NFC_CAPACITY_BYTES);
    expect(combineEnrollmentKey(card, share2Hex)).toBe(KEY);
    expect(JSON.stringify(card)).not.toContain(KEY);
  });

  test('two splits of the same key share nothing', () => {
    const a = splitEnrollmentKey(KEY);
    const b = splitEnrollmentKey(KEY);
    expect(a.card.id).not.toBe(b.card.id);
    expect(a.card.s).not.toBe(b.card.s);
    expect(a.share2Hex).not.toBe(b.share2Hex);
    expect(() => combineEnrollmentKey(a.card, b.share2Hex)).not.toThrow(); // same length, wrong key
    expect(combineEnrollmentKey(a.card, b.share2Hex)).not.toBe(KEY);
  });

  test('a share alone is uniformly random: the card reveals nothing about the key', () => {
    // With a fixed rng the share is exactly the rng output, independent of the key.
    const rng = (n: number) => Buffer.alloc(n, 0x5a);
    const one = splitEnrollmentKey(KEY, rng);
    const two = splitEnrollmentKey(generateEnrollmentKey(), rng);
    expect(one.card.s).toBe(two.card.s);
    expect(one.share2Hex).not.toBe(two.share2Hex);
  });

  test('the PIN verifier is slow-hashed under the card id and never equals the PIN', () => {
    const v = recoveryPinVerifier('246813', 'abcdefabcdefabcd');
    expect(v).toMatch(/^[0-9a-f]{64}$/);
    expect(v).toBe(recoveryPinVerifier('246813', 'abcdefabcdefabcd'));
    expect(v).not.toBe(recoveryPinVerifier('246813', 'ffffffffffffffff'));
    expect(v).not.toBe(recoveryPinVerifier('246814', 'abcdefabcdefabcd'));
    expect(() => validateRecoveryPin('12345')).toThrow(/6 to 32/);
    expect(() => validateRecoveryPin(123456 as unknown as string)).toThrow();
  });

  test('issuing makes two cards and two deposits that match by id and carry the salt, group and plan', () => {
    const issued = issueRecoveryCards({ enrollmentKey: KEY, recoveryPin: '246813', identitySalt: SALT, groupIdHash: GROUP, planIdHash: PLAN, domainTag: 0 });
    expect(issued.cards).toHaveLength(2);
    expect(issued.deposits).toHaveLength(2);
    for (let i = 0; i < 2; i++) {
      expect(issued.deposits[i].cardId).toBe(issued.cards[i].id);
      expect(combineEnrollmentKey(issued.cards[i], issued.deposits[i].share2Hex)).toBe(KEY);
      expect(issued.deposits[i].identitySalt).toBe(SALT);
      expect(issued.deposits[i].pinVerifier).toBe(recoveryPinVerifier('246813', issued.cards[i].id));
    }
    expect(issued.cards[0].id).not.toBe(issued.cards[1].id);
  });
});

describe('the insurer releases a deposit against the verifier, attempt-limited per card', () => {
  let server: NautilusAppServer;
  let url: string;
  let dir: string;
  const issued = issueRecoveryCards({ enrollmentKey: KEY, recoveryPin: '246813', identitySalt: SALT, groupIdHash: GROUP, planIdHash: PLAN, domainTag: 0 });
  const [cardA, cardB] = issued.cards;

  async function post(p: string, body: unknown) {
    const r = await fetch(url + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    let json: any = null;
    try { json = await r.json(); } catch { json = null; }
    return { status: r.status, json, retryAfter: r.headers.get('retry-after') };
  }
  const data = (r: { json: any }) => (r.json && 'data' in r.json ? r.json.data : r.json);

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a12b-ins-'));
    server = new NautilusAppServer({
      role: 'insurer', port: 0, host: '127.0.0.1', sequencerUrl: 'http://127.0.0.1:1', stateDir: dir,
      enableSSE: false, maxSseConnections: 0, allowedOrigins: [], adminToken: 'insurer-token',
    } as unknown as NautilusAppConfig);
    server.registerRoutes(buildInsurerRoutes(server));
    await server.start();
    url = `http://127.0.0.1:${server.getPort()}`;
    // The deposits arrive at enrollment completion; here the wallet is seeded as enrolled and the deposits filed through the deposit route.
    (server as unknown as { __enrollmentRegistry?: Map<string, unknown> }).__enrollmentRegistry = new Map([['123456789123456789', { walletId: '123456789123456789', tokenId: 'CODE' }]]);
    const dep = await post('/recovery/deposit', { walletId: '123456789123456789', deposits: issued.deposits });
    expect(dep.status).toBe(201);
  });

  afterAll(async () => {
    await server.stop();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  test('a wrong verifier is refused, then throttled with Retry-After, and the card is not released', async () => {
    const wrong = recoveryPinVerifier('000000', cardA.id);
    for (let i = 0; i < 3; i++) expect((await post('/recovery/release', { cardId: cardA.id, pinVerifier: wrong })).status).toBe(403);
    const fourth = await post('/recovery/release', { cardId: cardA.id, pinVerifier: wrong });
    expect(fourth.status).toBe(403);
    const fifth = await post('/recovery/release', { cardId: cardA.id, pinVerifier: recoveryPinVerifier('246813', cardA.id) });
    expect(fifth.status).toBe(429);
    expect(fifth.retryAfter).toMatch(/^\d+$/);
  }, 30_000);

  test('the other card is independent: the right verifier releases its deposit, and the key recombines', async () => {
    const r = await post('/recovery/release', { cardId: cardB.id, pinVerifier: recoveryPinVerifier('246813', cardB.id) });
    expect(r.status).toBe(200);
    const d = data(r);
    expect(d.identitySalt).toBe(SALT);
    expect(d.groupIdHash).toBe(GROUP);
    expect(d.planIdHash).toBe(PLAN);
    expect(d.domainTag).toBe(0);
    expect(combineEnrollmentKey(cardB, d.share2Hex)).toBe(KEY);
    expect(JSON.stringify(d)).not.toContain('123456789123456789');
  });

  test('an unknown card id, a malformed verifier and a missing body are refused without a hint', async () => {
    expect((await post('/recovery/release', { cardId: 'ffffffffffffffff', pinVerifier: recoveryPinVerifier('246813', 'ffffffffffffffff') })).status).toBe(403);
    expect((await post('/recovery/release', { cardId: cardB.id, pinVerifier: 'nothex' })).status).toBe(400);
    expect((await post('/recovery/release', {})).status).toBe(400);
  });

  test('revocation closes a card for good', async () => {
    const v = recoveryPinVerifier('246813', cardB.id);
    expect((await post('/recovery/revoke', { cardId: cardB.id, pinVerifier: v })).status).toBe(200);
    expect((await post('/recovery/release', { cardId: cardB.id, pinVerifier: v })).status).toBe(403);
  });

  test('a deposit for a wallet the insurer has not enrolled is refused', async () => {
    const other = issueRecoveryCards({ enrollmentKey: KEY, recoveryPin: '246813', identitySalt: SALT, groupIdHash: GROUP, planIdHash: PLAN, domainTag: 0 });
    expect((await post('/recovery/deposit', { walletId: '42', deposits: other.deposits })).status).toBe(404);
  });
});
