/**
 * Provisioning the plan's node over HTTP, and its restart — the key ceremony (owner, 2026-11-04) and the restart rule
 * (owner, 2026-11-05).
 *
 * The insurer node keyed at the ceremony answers GET /keys/status with what it is waiting for (no secret: the ceremony,
 * the threshold, how many shares have come, this start's one-time key and its fingerprint) and takes each holder's
 * release on POST /keys/release. Every release is checked before it is kept (a holder in the record, signed, for this
 * node, this start and the holder's slot); refusals from one address are limited. With three, the node signs employer
 * attestations as the insurer the ceremony record names: until then it has no signing seed at all, and none ever comes
 * from the operator's environment. Restarted on the same machine, it is unlocked before it answers its first request.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHolderKey, unlockHolderKey } from '../src/keys/holder-key.js';
import type { HolderCard, UnlockedHolder } from '../src/keys/holder-key.js';
import { runCeremony, signCeremonyRecord, addRecordSignature, releaseShare } from '../src/keys/ceremony.js';
import type { CeremonyRecord, ShareFile } from '../src/keys/ceremony.js';
import { NodeKeyring } from '../src/keys/node-keyring.js';
import { testOnlyMachineSeal } from '../src/keys/machine-seal.js';
import type { MachineSeal } from '../src/keys/machine-seal.js';
import { generateBoxKeyPair } from '../src/keys/seal.js';
import { NautilusAppServer } from '../src/nodes/nautilus-app-server.js';
import type { NautilusAppConfig } from '../src/nodes/nautilus-app-types.js';
import { buildKeyRoutes, attachNodeKeyring } from '../src/nodes/routes/key-routes.js';
import { insurerPublicKeyFromSeed } from '../src/onboarding/employer-attestation.js';

const PASS = 'correct horse battery staple';
interface Holder {
  card: HolderCard;
  unlocked: UnlockedHolder;
}
const holders: Holder[] = Array.from({ length: 5 }, (_, i) => {
  const { file, card } = createHolderKey(`holder-${i + 1}`, PASS, { scryptN: 2 ** 12 });
  return { card, unlocked: unlockHolderKey(file, PASS) };
});
const made = runCeremony({
  holders: holders.map((h) => h.card),
  threshold: 3,
  nodes: [{ nodeId: 'insurer', role: 'insurer' }],
  programSourceSha256: 'a'.repeat(64),
});
const record: CeremonyRecord = holders.slice(0, 3).reduce((r, h) => addRecordSignature(r, signCeremonyRecord(r, h.unlocked)), made.record);
const shareOf = (h: Holder): ShareFile => made.shares.find((s) => s.holder === h.card.signPublicKeyHex)!;

let dir: string;
const running: NautilusAppServer[] = [];
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'insurer-keys-'));
});
afterEach(async () => {
  for (const s of running.splice(0)) await s.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function insurer(seal: MachineSeal, withKeyring = true) {
  const server = new NautilusAppServer({
    role: 'insurer',
    port: 0,
    host: '127.0.0.1',
    sequencerUrl: 'http://127.0.0.1:9',
    stateDir: dir,
    enableSSE: false,
    maxSseConnections: 0,
    allowedOrigins: [],
    adminToken: 'insurer-token',
  } as unknown as NautilusAppConfig);
  server.registerRoutes(buildKeyRoutes(server));
  let keyring: NodeKeyring | null = null;
  if (withKeyring) {
    keyring = new NodeKeyring({ record, nodeId: 'insurer', stateDir: dir, seal, log: () => {} });
    attachNodeKeyring(server, keyring);
    await keyring.start();
  }
  await server.start();
  running.push(server);
  return { server, keyring, url: `http://127.0.0.1:${server.getPort()}` };
}

async function status(url: string) {
  const r = await fetch(`${url}/keys/status`);
  return { code: r.status, json: (await r.json()) as any };
}

async function post(url: string, body: unknown) {
  const r = await fetch(`${url}/keys/release`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { code: r.status, json: (await r.json()) as any };
}

async function releaseFrom(url: string, h: Holder) {
  const { json } = await status(url);
  return releaseShare(shareOf(h), h.unlocked, {
    ceremonyId: record.ceremonyId,
    nodeId: 'insurer',
    bootPublicKeyHex: json.data.bootPublicKeyHex,
  });
}

test("the plan's node waits for three holders, then signs as the insurer the record names", async () => {
  const { server, url } = await insurer(testOnlyMachineSeal());
  const before = await status(url);
  expect(before.code).toBe(200);
  expect(before.json.data).toMatchObject({
    state: 'awaiting-shares',
    ceremonyId: record.ceremonyId,
    nodeId: 'insurer',
    threshold: 3,
    received: 0,
  });
  expect(before.json.data.bootFingerprint).toMatch(/^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/);
  expect(server.getConfig().insurerSigningSeed).toBeUndefined();

  expect((await post(url, await releaseFrom(url, holders[0]))).json.data.received).toBe(1);
  expect((await post(url, await releaseFrom(url, holders[3]))).json.data.received).toBe(2);
  const third = await post(url, await releaseFrom(url, holders[4]));
  expect(third.code).toBe(200);
  expect(third.json.data.state).toBe('unlocked');
  expect(insurerPublicKeyFromSeed(server.getConfig().insurerSigningSeed!)).toBe(record.nodes[0].publicKeys.insurerSigningPublicKeyHex);

  const after = await status(url);
  expect(after.json.data.state).toBe('unlocked');
  expect(after.json.data.bootPublicKeyHex).toBeUndefined();
  const late = await post(
    url,
    releaseShare(shareOf(holders[1]), holders[1].unlocked, {
      ceremonyId: record.ceremonyId,
      nodeId: 'insurer',
      bootPublicKeyHex: before.json.data.bootPublicKeyHex,
    }),
  );
  expect(late.code).toBe(409);
  expect(late.json.error).toMatch(/already unlocked/);
});

test('a release that does not check out is refused and changes nothing', async () => {
  const { url } = await insurer(testOnlyMachineSeal());
  expect((await post(url, { v: 1, kind: 'zpk.care share release' })).code).toBe(400);
  const elsewhere = releaseShare(shareOf(holders[0]), holders[0].unlocked, {
    ceremonyId: record.ceremonyId,
    nodeId: 'insurer',
    bootPublicKeyHex: generateBoxKeyPair().publicKeyHex,
  });
  const refused = await post(url, elsewhere);
  expect(refused.code).toBe(400);
  expect(refused.json.error).toMatch(/another start/);
  expect((await status(url)).json.data.received).toBe(0);
});

test('refusals from one address are limited', async () => {
  const { url } = await insurer(testOnlyMachineSeal());
  for (let i = 0; i < 20; i++) expect((await post(url, { nonsense: i })).code).toBe(400);
  const limited = await post(url, { nonsense: 'again' });
  expect(limited.code).toBe(429);
});

test('restarted on the same machine, it is unlocked before it answers', async () => {
  const seal = testOnlyMachineSeal();
  const first = await insurer(seal);
  for (const h of holders.slice(0, 3)) await post(first.url, await releaseFrom(first.url, h));
  const seed = first.server.getConfig().insurerSigningSeed;
  await first.server.stop();
  running.splice(running.indexOf(first.server), 1);
  first.keyring!.close();

  const again = await insurer(seal);
  expect((await status(again.url)).json.data.state).toBe('unlocked');
  expect(again.server.getConfig().insurerSigningSeed).toBe(seed);
});

test('a node with no ceremony says so', async () => {
  const { url } = await insurer(testOnlyMachineSeal(), false);
  const r = await status(url);
  expect(r.code).toBe(404);
  expect(r.json.error).toMatch(/no key ceremony/);
});
