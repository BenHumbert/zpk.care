/**
 * Redeem before derive, the real group in the wallet, two cards at the tap, the same wallet back
 * from a card — plan item C2 (A-9), C1 (A-1) and A12b (PRD-1) on the member node.
 *
 * A real member NautilusAppServer with its routes, driven over HTTP with a device session, against
 * a stub insurer (process / complete / release) and a stub sequencer (l2_registerEntity,
 * l2_getEntity). The device state is opened afterwards with the PIN, as the harness does.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { Field, Poseidon } from 'o1js';
import { NautilusAppServer } from '../src/nodes/nautilus-app-server.js';
import type { NautilusAppConfig } from '../src/nodes/nautilus-app-types.js';
import { buildMemberRoutes } from '../src/nodes/routes/member-routes.js';
import { NautilusLocalState } from '../src/nodes/nautilus-local-state.js';
import { deriveMemberWalletId } from '../src/wallets/wallet-derivation.js';
import { hashIdentityField, isIdentitySalt } from '../src/zkp/hash-utils.js';
import { combineEnrollmentKey, recoveryPinVerifier, type RecoveryCardV3, type RecoveryDeposit } from '../src/security/recovery-card.js';

jest.setTimeout(120_000);

const PIN = '135790';
const ENROLL_PIN = '12345678';
const RECOVERY_PIN = '246813';
const GROUP = '7777777';
const PLAN = '8888888';
const FIELDS = { cardholderId: 'CH-ORDER-1', dateOfBirth: '19880214', genderCode: 1, firstName: 'Order', lastName: 'Member' };
const CONSENT = { phiDescription: 'claims', disclosingParty: 'Member', receivingParty: 'zpk.care', purpose: 'test', expiration: '2027-01-01', signatureDate: '2026-10-18' };

const dirs: string[] = [];
const tmp = (p: string) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };

// stub insurer state
const insurer = { processCalls: [] as any[], completeCalls: [] as any[], releaseCalls: [] as any[], deposits: new Map<string, RecoveryDeposit & { walletId: string }>(), boundWallet: null as string | null };
let insurerUrl = '';
let sequencerUrl = '';
const servers: http.Server[] = [];

function jsonServer(handle: (req: http.IncomingMessage, body: any) => { status: number; body: unknown }): Promise<string> {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let text = '';
      req.on('data', (c) => { text += c; });
      req.on('end', () => {
        let parsed: any = null;
        try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
        const out = handle(req, parsed);
        res.writeHead(out.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out.body));
      });
    });
    servers.push(s);
    s.listen(0, '127.0.0.1', () => { const a = s.address(); resolve(`http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`); });
  });
}

async function memberServer(stateDir: string): Promise<{ server: NautilusAppServer; url: string; session: string }> {
  const server = new NautilusAppServer({
    role: 'member', port: 0, host: '127.0.0.1', sequencerUrl, insurerUrl, stateDir,
    enableSSE: false, maxSseConnections: 0, allowedOrigins: [],
  } as unknown as NautilusAppConfig);
  server.registerRoutes(buildMemberRoutes(server));
  await server.start();
  const url = `http://127.0.0.1:${server.getPort()}`;
  const unlock = await fetch(url + '/onboarding/unlock', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: PIN }) });
  const j: any = await unlock.json();
  return { server, url, session: j.data?.deviceSession ?? j.deviceSession };
}
async function dev(url: string, session: string, p: string, body: unknown) {
  const r = await fetch(url + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Device-Session': session }, body: JSON.stringify(body) });
  let json: any = null;
  try { json = await r.json(); } catch { json = null; }
  return { status: r.status, json, data: json && 'data' in json ? json.data : json };
}

beforeAll(async () => {
  insurerUrl = await jsonServer((req, body) => {
    const url = req.url ?? '';
    if (url === '/enrollment/process') {
      insurer.processCalls.push(body);
      if (!body?.tokenId || !body?.tokenPinHash) return { status: 400, body: { ok: false, error: 'code and pin hash required' } };
      if (body.walletId) return { status: 400, body: { ok: false, error: 'process takes no wallet' } };
      return { status: 200, body: { ok: true, data: { redeemed: true, groupIdHash: GROUP, planIdHash: PLAN, employerId: 'EMP-ORDER' } } };
    }
    if (url === '/enrollment/complete') {
      insurer.completeCalls.push(body);
      if (insurer.boundWallet && insurer.boundWallet !== body.walletId) return { status: 403, body: { ok: false, error: 'used' } };
      insurer.boundWallet = body.walletId;
      for (const d of body.recoveryDeposits ?? []) insurer.deposits.set(d.cardId, { ...d, walletId: body.walletId });
      return { status: 200, body: { ok: true, data: { enrolled: true, walletId: body.walletId } } };
    }
    if (url === '/recovery/release') {
      insurer.releaseCalls.push(body);
      const d = insurer.deposits.get(body?.cardId);
      if (!d || d.pinVerifier !== body.pinVerifier) return { status: 403, body: { ok: false, error: 'no' } };
      return { status: 200, body: { ok: true, data: { share2Hex: d.share2Hex, identitySalt: d.identitySalt, groupIdHash: d.groupIdHash, planIdHash: d.planIdHash, domainTag: d.domainTag } } };
    }
    return { status: 404, body: { ok: false, error: 'not stubbed ' + url } };
  });
  sequencerUrl = await jsonServer((_req, body) => {
    if (body?.method === 'l2_registerEntity') return { status: 200, body: { jsonrpc: '2.0', id: body.id, result: { registered: true } } };
    if (body?.method === 'l2_getEntity') return { status: 200, body: { jsonrpc: '2.0', id: body.id, result: insurer.boundWallet === body.params?.walletId ? { walletId: body.params.walletId } : null } };
    return { status: 200, body: { jsonrpc: '2.0', id: body?.id ?? 1, error: { code: -32601, message: 'not stubbed' } } };
  });
});

afterAll(async () => {
  for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
  for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
});

describe('enrollment on the device', () => {
  let m: Awaited<ReturnType<typeof memberServer>>;
  let stateDir: string;
  let walletId = '';
  let cards: RecoveryCardV3[] = [];

  beforeAll(async () => { stateDir = tmp('step2-mem-'); m = await memberServer(stateDir); });
  afterAll(async () => { await m.server.stop(); });

  test('the wallet cannot be derived before the code is redeemed', async () => {
    expect((await dev(m.url, m.session, '/onboarding/accept-token', { tokenId: '7Q4K-9XMD-2PWT-R8HN-5VZC' })).status).toBe(200);
    expect((await dev(m.url, m.session, '/onboarding/generate-key', {})).status).toBe(200);
    const early = await dev(m.url, m.session, '/onboarding/derive-wallet', { ...FIELDS, consentRecord: CONSENT });
    expect(early.status).toBe(409);
    expect(early.json.error).toMatch(/Redeem the enrollment code first/);
  });

  test('redeem asks the insurer with the code and PIN hash only, and stores the group and plan it answers', async () => {
    const noPin = await dev(m.url, m.session, '/onboarding/redeem', {});
    expect(noPin.status).toBe(400);
    const r = await dev(m.url, m.session, '/onboarding/redeem', { tokenPIN: ENROLL_PIN });
    expect(r.status).toBe(200);
    expect(r.data.groupIdHash).toBe(GROUP);
    expect(r.data.phase).toBe('code_redeemed');
    const call = insurer.processCalls[insurer.processCalls.length - 1];
    expect(call.walletId).toBeUndefined();
    expect(call.tokenId).toBe('7Q4K-9XMD-2PWT-R8HN-5VZC');
    expect(call.tokenPinHash).toMatch(/^\d+$/);
  });

  test('the wallet is derived bound to the real group, with a fresh identity salt that stays on the device', async () => {
    const r = await dev(m.url, m.session, '/onboarding/derive-wallet', { ...FIELDS, consentRecord: CONSENT });
    expect(r.status).toBe(200);
    expect(r.data.boundToGroup).toBe(true);
    walletId = r.data.walletId;
    expect(JSON.stringify(r.json)).not.toMatch(/identitySalt/);
    const ls = new NautilusLocalState(stateDir);
    await ls.unlock(PIN);
    const d = await ls.load();
    expect(isIdentitySalt(d?.identitySalt)).toBe(true);
    expect(d?.preimageFields?.[5]).toBe(GROUP);
    expect(d?.preimageFields?.[0]).toBe(hashIdentityField(FIELDS.cardholderId, d!.identitySalt!).toString());
    const key = ls.useEnrollmentKey((k) => k);
    expect(deriveMemberWalletId(FIELDS, key, Field(BigInt(GROUP)), d!.identitySalt!).toString()).toBe(walletId);
    expect(Poseidon.hash([Field(0), ...d!.preimageFields!.map((f) => Field(BigInt(f)))]).toString()).toBe(walletId);
  });

  test('enroll needs a recovery PIN, completes the redemption with the wallet, and issues two opaque cards once', async () => {
    const noPin = await dev(m.url, m.session, '/onboarding/enroll', {});
    expect(noPin.status).toBe(400);
    expect(noPin.json.error).toMatch(/recovery PIN/);
    const r = await dev(m.url, m.session, '/onboarding/enroll', { recoveryPin: RECOVERY_PIN });
    expect(r.status).toBe(200);
    expect(r.data.insurerNotified).toBe(true);
    cards = r.data.recoveryCards;
    expect(cards).toHaveLength(2);
    for (const c of cards) {
      expect(Object.keys(c).sort()).toEqual(['id', 's', 'v']);
      expect(JSON.stringify(c)).not.toContain(walletId);
    }
    expect(r.data.recoveryCardBytes.every((n: number) => n < 160)).toBe(true);
    const complete = insurer.completeCalls[0];
    expect(complete.walletId).toBe(walletId);
    expect(complete.tokenId).toBe('7Q4K-9XMD-2PWT-R8HN-5VZC');
    expect(complete.recoveryDeposits).toHaveLength(2);
    expect(complete.recoveryDeposits.map((d: RecoveryDeposit) => d.cardId).sort()).toEqual(cards.map((c) => c.id).sort());
    expect(complete.recoveryDeposits.every((d: RecoveryDeposit) => d.groupIdHash === GROUP && d.planIdHash === PLAN && d.domainTag === 0)).toBe(true);
    // the device keeps the ids and nothing of the shares
    const ls = new NautilusLocalState(stateDir);
    await ls.unlock(PIN);
    const d = await ls.load();
    expect(d?.recoveryCards?.map((c) => c.cardId).sort()).toEqual(cards.map((c) => c.id).sort());
    const raw = JSON.stringify(d);
    for (const c of cards) expect(raw).not.toContain(c.s);
    expect(complete.recoveryDeposits.every((dep: RecoveryDeposit) => dep.identitySalt === d?.identitySalt)).toBe(true);
    // the shares recombine into the device's key
    const key = ls.useEnrollmentKey((k) => k);
    for (const c of cards) expect(combineEnrollmentKey(c, insurer.deposits.get(c.id)!.share2Hex)).toBe(key);
  });

  test('a second device recovers the same wallet from a card and the PIN, and a wrong PIN or wrong name does not', async () => {
    const other = await memberServer(tmp('step2-mem2-'));
    try {
      const wrongPin = await dev(other.url, other.session, '/onboarding/recover', { card: cards[0], recoveryPin: '000000', ...FIELDS });
      expect(wrongPin.status).toBe(403);
      const wrongName = await dev(other.url, other.session, '/onboarding/recover', { card: cards[0], recoveryPin: RECOVERY_PIN, ...FIELDS, lastName: 'Nobody' });
      expect(wrongName.status).toBe(404);
      const r = await dev(other.url, other.session, '/onboarding/recover', { card: cards[1], recoveryPin: RECOVERY_PIN, ...FIELDS });
      expect(r.status).toBe(200);
      expect(r.data.walletId).toBe(walletId);
      expect(r.data.recoveredFromCard).toBe(cards[1].id);
      expect(insurer.releaseCalls[insurer.releaseCalls.length - 1].pinVerifier).toBe(recoveryPinVerifier(RECOVERY_PIN, cards[1].id));
      const status = await fetch(other.url + '/onboarding/status', { headers: { 'X-Device-Session': other.session } }).then((x) => x.json()) as any;
      expect((status.data ?? status).phase).toBe('enrolled');
    } finally {
      await other.server.stop();
    }
  });
});
