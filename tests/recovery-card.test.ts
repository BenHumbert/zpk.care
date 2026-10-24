/**
 * Recovery cards — plan item A12b, risk PRD-1.
 *
 * Nothing on a card depends on the PIN: it carries one share of the enrollment key and a random id.
 * The other share, the identity salt, the group and plan hashes and a device-computed PIN verifier
 * are deposited with the insurer, which releases them only against the verifier, attempt-limited per
 * card. Two cards, independent shares, independent revocation.
 *
 * The confused-deputy sweep of round eight's security fixes (2026-10-24) found the insurer's deposit
 * route open. POST /recovery/deposit filed deposits for whatever wallet the body named, answering 201
 * for a wallet the insurer had enrolled and 404 for any other: anyone could tell which wallet IDs the
 * insurer had enrolled, file deposits of their own against an enrolled wallet without limit, and,
 * given a card's ID (it is on the card), replace that card's deposit, after which the member's card
 * released nothing and a card the member had revoked released what the caller had filed. No deposit a
 * stranger filed recovers the member's wallet: a release hands back only what was filed, and a card's
 * share recombines only with its own.
 *
 * What is true now: a deposit is filed only for a request the wallet itself signed, with the key the
 * device derives from the enrollment key, verified over the body received against the key the
 * sequencer registered for that wallet, inside the window and once. Anything else, and a signed
 * request for a wallet the insurer did not enroll, is answered the same 403 and files nothing; a
 * sequencer the insurer cannot read is a 502 for every wallet alike. In these tests the insurer is a
 * real node on loopback, and the sequencer a stand-in whose entity registry, which the plan reads,
 * holds the enrolled wallet's key and the key of one wallet the insurer did not enroll. The member's
 * device signing its own deposit is in tests/enrollment-complete-binding.test.ts.
 */
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import {
  splitEnrollmentKey, combineEnrollmentKey, issueRecoveryCards, recoveryPinVerifier, isRecoveryCardV3, recoveryCardBytes,
  validateRecoveryPin, NFC_CAPACITY_BYTES,
} from '../src/security/recovery-card.js';
import { generateEnrollmentKey, generateIdentitySalt } from '../src/wallets/wallet-derivation.js';
import { NautilusAppServer } from '../src/nodes/nautilus-app-server.js';
import type { NautilusAppConfig } from '../src/nodes/nautilus-app-types.js';
import { buildInsurerRoutes } from '../src/nodes/routes/insurer-routes.js';
import { signRequest } from '../src/security/signed-request.js';
import { deriveWalletSigningKey } from '../src/security/wallet-key.js';

jest.setTimeout(60_000);

const KEY = generateEnrollmentKey();
const SALT = generateIdentitySalt();
const GROUP = '123456789';
const PLAN = '987654321';
/** The member's wallet, which the insurer enrolled; its signing key derives from KEY. */
const WALLET = '123456789123456789';
/** A wallet registered on the network and enrolled by no insurer here, with a key of its own. */
const OTHER_WALLET = '555555555555555555';
const OTHER_KEY = generateEnrollmentKey();
/** The insurer's one answer to a deposit the wallet did not sign, or one for a wallet it did not enroll. */
const DEPOSIT_REFUSED = 'Recovery deposits are filed only by an enrolled wallet, signed with its own key.';

/** Headers that sign `text` as `walletId` with the wallet key derived from `enrollmentKey`, as a member's device signs its deposit. */
function signedAs(walletId: string, enrollmentKey: string, text: string): Record<string, string> {
  return signRequest({ signerId: walletId, privateKey: deriveWalletSigningKey(enrollmentKey).privateKey, method: 'POST', path: '/recovery/deposit', body: text });
}

/**
 * A stand-in sequencer on loopback whose entity registry (GET /viz/entities) holds the signing key of each wallet `keys`
 * names, derived from the enrollment key beside it; `reads` counts the registry's reads.
 */
async function sequencerWith(keys: Record<string, string>): Promise<{ url: string; reads: () => number; stop: () => Promise<void> }> {
  let reads = 0;
  const service = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.method === 'GET' && req.url === '/viz/entities') {
        reads++;
        const entities = Object.entries(keys).map(([walletId, enrollmentKey]) => ({
          walletId, displayName: 'Member', type: 'member', signingPublicKeyHex: deriveWalletSigningKey(enrollmentKey).publicKeyHex,
        }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(entities));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => service.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(service.address() as AddressInfo).port}`,
    reads: () => reads,
    stop: () => new Promise<void>((resolve) => { service.closeAllConnections(); service.close(() => resolve()); }),
  };
}

/** An insurer node on loopback that reads the sequencer at `sequencerUrl`, with `walletId` seeded as enrolled. */
async function insurerAt(sequencerUrl: string, walletId: string): Promise<{ server: NautilusAppServer; url: string; dir: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a12b-ins-'));
  const server = new NautilusAppServer({
    role: 'insurer', port: 0, host: '127.0.0.1', sequencerUrl, stateDir: dir,
    enableSSE: false, maxSseConnections: 0, allowedOrigins: [], adminToken: 'insurer-token',
  } as unknown as NautilusAppConfig);
  server.registerRoutes(buildInsurerRoutes(server));
  await server.start();
  // The deposits at enrollment arrive with its completion; here the wallet is seeded as enrolled, as completion leaves it.
  (server as unknown as { __enrollmentRegistry?: Map<string, unknown> }).__enrollmentRegistry = new Map([[walletId, { walletId, tokenId: 'CODE' }]]);
  return { server, url: `http://127.0.0.1:${server.getPort()}`, dir };
}

/** POSTs `body` as JSON to `url + p` with any `headers` beside the content type; the status, the JSON and Retry-After. */
async function postTo(url: string, p: string, body: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(url + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  let json: any = null;
  try { json = await r.json(); } catch { json = null; }
  return { status: r.status, json, retryAfter: r.headers.get('retry-after') };
}
const data = (r: { json: any }) => (r.json && 'data' in r.json ? r.json.data : r.json);

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
  let sequencer: Awaited<ReturnType<typeof sequencerWith>>;

  const post = (p: string, body: unknown, headers: Record<string, string> = {}) => postTo(url, p, body, headers);

  beforeAll(async () => {
    sequencer = await sequencerWith({ [WALLET]: KEY });
    ({ server, url, dir } = await insurerAt(sequencer.url, WALLET));
    // The deposits filed through the deposit route, signed by the wallet as the member's device signs them.
    const body = { walletId: WALLET, deposits: issued.deposits };
    const dep = await post('/recovery/deposit', body, signedAs(WALLET, KEY, JSON.stringify(body)));
    expect(dep.status).toBe(201);
  });

  afterAll(async () => {
    await server.stop();
    await sequencer.stop();
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
    expect(JSON.stringify(d)).not.toContain(WALLET);
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
});

describe('POST /recovery/deposit: a deposit comes from the wallet itself', () => {
  let server: NautilusAppServer;
  let url: string;
  let dir: string;
  let sequencer: Awaited<ReturnType<typeof sequencerWith>>;

  const post = (p: string, body: unknown, headers: Record<string, string> = {}) => postTo(url, p, body, headers);
  /** A deposit for `walletId`, unsigned, or signed as `signer` with the wallet key of `signer.key`. */
  const deposit = (walletId: string, deposits: unknown, signer?: { walletId: string; key: string }) => {
    const body = { walletId, deposits };
    return post('/recovery/deposit', body, signer ? signedAs(signer.walletId, signer.key, JSON.stringify(body)) : {});
  };
  const cardsFor = (enrollmentKey: string, recoveryPin: string) =>
    issueRecoveryCards({ enrollmentKey, recoveryPin, identitySalt: SALT, groupIdHash: GROUP, planIdHash: PLAN, domainTag: 0 });

  beforeAll(async () => {
    sequencer = await sequencerWith({ [WALLET]: KEY, [OTHER_WALLET]: OTHER_KEY });
    ({ server, url, dir } = await insurerAt(sequencer.url, WALLET));
  });

  afterAll(async () => {
    await server.stop();
    await sequencer.stop();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  test('a request the wallet did not sign, or one for a wallet the insurer did not enroll, is refused with one answer and files nothing', async () => {
    const stray = cardsFor(generateEnrollmentKey(), '111111');
    const answers = [
      await deposit(WALLET, stray.deposits),                                                    // an enrolled wallet, unsigned
      await deposit('42', stray.deposits),                                                      // a wallet nobody enrolled, unsigned
      await deposit(WALLET, stray.deposits, { walletId: WALLET, key: OTHER_KEY }),              // signed in the wallet's name with another key
      await deposit(WALLET, stray.deposits, { walletId: OTHER_WALLET, key: OTHER_KEY }),        // signed by another wallet
      await deposit(OTHER_WALLET, stray.deposits, { walletId: OTHER_WALLET, key: OTHER_KEY }),  // signed by a wallet this insurer did not enroll
    ];
    expect(answers.map((r) => [r.status, r.json?.error])).toEqual(Array(5).fill([403, DEPOSIT_REFUSED]));   // before: [[201, undefined], [404, 'No enrollment for this wallet'], [201, undefined], [201, undefined], [404, 'No enrollment for this wallet']]
    for (const c of stray.cards) {
      expect((await post('/recovery/release', { cardId: c.id, pinVerifier: recoveryPinVerifier('111111', c.id) })).status).toBe(403);   // before: 200, the stranger's deposit filed under the member's wallet
    }
  });

  test('with a card\'s ID, a stranger neither replaces the member\'s deposit nor revives a card the member revoked', async () => {
    const issued = cardsFor(KEY, '246813');
    expect((await deposit(WALLET, issued.deposits, { walletId: WALLET, key: KEY })).status).toBe(201);
    const [live, revoked] = issued.cards;
    expect((await post('/recovery/revoke', { cardId: revoked.id, pinVerifier: recoveryPinVerifier('246813', revoked.id) })).status).toBe(200);
    // The stranger's own shares and PIN, filed under the member's two card IDs.
    const theirs = cardsFor(generateEnrollmentKey(), '111111').deposits;
    const forged = [live, revoked].map((c, i) => ({ ...theirs[i], cardId: c.id, pinVerifier: recoveryPinVerifier('111111', c.id) }));
    expect((await deposit(WALLET, forged)).status).toBe(403);   // before: 201, both deposits replaced
    expect((await post('/recovery/release', { cardId: revoked.id, pinVerifier: recoveryPinVerifier('111111', revoked.id) })).status).toBe(403);   // before: 200, the revoked card released the stranger's share
    const own = await post('/recovery/release', { cardId: live.id, pinVerifier: recoveryPinVerifier('246813', live.id) });
    expect(own.status).toBe(200);   // before: 403, the member's deposit was the stranger's
    expect(combineEnrollmentKey(live, data(own).share2Hex)).toBe(KEY);
  });

  test('the wallet\'s own signed deposit is filed and releases, and the same signed request presented again is refused', async () => {
    const issued = cardsFor(KEY, '246813');
    const body = { walletId: WALLET, deposits: issued.deposits };
    const headers = signedAs(WALLET, KEY, JSON.stringify(body));
    const first = await post('/recovery/deposit', body, headers);
    expect([first.status, data(first).recoveryCards]).toEqual([201, issued.cards.map((c) => ({ cardId: c.id, filed: true }))]);
    const again = await post('/recovery/deposit', body, headers);
    expect([again.status, again.json?.error]).toEqual([403, DEPOSIT_REFUSED]);   // before: [201, undefined], filed again
    const r = await post('/recovery/release', { cardId: issued.cards[0].id, pinVerifier: recoveryPinVerifier('246813', issued.cards[0].id) });
    expect(r.status).toBe(200);
    expect(combineEnrollmentKey(issued.cards[0], data(r).share2Hex)).toBe(KEY);
  });

  test('deposits signed together read the sequencer\'s registry once at most', async () => {
    const before = sequencer.reads();
    const sent = await Promise.all([0, 1, 2].map(() => deposit(WALLET, cardsFor(KEY, '246813').deposits, { walletId: WALLET, key: KEY })));
    expect(sent.map((r) => r.status)).toEqual([201, 201, 201]);
    expect(sequencer.reads() - before).toBeLessThanOrEqual(1);
  });

  test('a sequencer the insurer cannot read is answered 502 for a signed request, enrolled wallet or not, and an unsigned one is still refused', async () => {
    const unreachable = await insurerAt('http://127.0.0.1:1', WALLET);
    try {
      const at = (walletId: string, signer?: { walletId: string; key: string }) => {
        const body = { walletId, deposits: cardsFor(KEY, '246813').deposits };
        return postTo(unreachable.url, '/recovery/deposit', body, signer ? signedAs(signer.walletId, signer.key, JSON.stringify(body)) : {});
      };
      const enrolled = await at(WALLET, { walletId: WALLET, key: KEY });
      const other = await at(OTHER_WALLET, { walletId: OTHER_WALLET, key: OTHER_KEY });
      expect([enrolled.status, other.status]).toEqual([502, 502]);   // before: [201, 404]
      expect(enrolled.json?.error).toBe(other.json?.error);           // before: undefined and 'No enrollment for this wallet'
      expect((await at(WALLET)).status).toBe(403);                    // before: 201
    } finally {
      await unreachable.server.stop();
      try { fs.rmSync(unreachable.dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });
});
