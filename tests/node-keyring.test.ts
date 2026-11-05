/**
 * A node's keys at start — the key ceremony (owner, 2026-11-04) and the restart rule (owner, 2026-11-05: "if it shuts
 * down and restarts we dont need keys to have it come back online").
 *
 * A node keyed at the ceremony starts with no master. It makes a one-time key for this start and waits; `threshold` key
 * holders release their shares to that key, the node rebuilds the master, checks it against the ceremony record, seals
 * it to its machine and is unlocked. From then on every start opens the sealed master by itself, with no holder and no
 * network. On another machine the sealed master opens nothing, and the holders provision that machine as they did the
 * first. A wrong share cannot unlock it, and one more good share is enough to find the ones that agree. A node holding
 * a master from one ceremony refuses another rather than lose the stores the first one's keys opened.
 *
 * The sequencer pins the first record it is given (the trust anchor) and after that accepts only that record or one
 * that follows it, signed by its holders.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash, randomBytes } from 'crypto';
import { createHolderKey, unlockHolderKey } from '../src/keys/holder-key.js';
import type { UnlockedHolder, HolderCard } from '../src/keys/holder-key.js';
import {
  runCeremony, signCeremonyRecord, addRecordSignature, releaseShare, canonicalJson, bootFingerprint,
} from '../src/keys/ceremony.js';
import type { CeremonyRecord, ShareFile, ShareRelease } from '../src/keys/ceremony.js';
import { NodeKeyring } from '../src/keys/node-keyring.js';
import { pinCeremonyRecord } from '../src/keys/ceremony-anchor.js';
import { testOnlyMachineSeal } from '../src/keys/machine-seal.js';
import { sealTo } from '../src/keys/seal.js';
import { SUBKEYS } from '../src/keys/subkeys.js';
import { insurerPublicKeyFromSeed } from '../src/onboarding/employer-attestation.js';

const PASS = 'correct horse battery staple';
interface Holder { card: HolderCard; unlocked: UnlockedHolder }

function makeHolders(n: number, prefix = 'holder'): Holder[] {
  return Array.from({ length: n }, (_, i) => {
    const { file, card } = createHolderKey(`${prefix}-${i + 1}`, PASS, { scryptN: 2 ** 12 });
    return { card, unlocked: unlockHolderKey(file, PASS) };
  });
}

function signed(record: CeremonyRecord, by: Holder[]): CeremonyRecord {
  return by.reduce((r, h) => addRecordSignature(r, signCeremonyRecord(r, h.unlocked)), record);
}

const holders = makeHolders(5);
const made = runCeremony({ holders: holders.map((h) => h.card), threshold: 3, nodes: [{ nodeId: 'insurer', role: 'insurer' }], programSourceSha256: 'a'.repeat(64) });
const record = signed(made.record, holders.slice(0, 3));
const shareOf = (h: Holder): ShareFile => made.shares.find((s) => s.holder === h.card.signPublicKeyHex)!;

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keyring-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function releaseTo(keyring: NodeKeyring, h: Holder): ShareRelease {
  const boot = keyring.status().bootPublicKeyHex!;
  return releaseShare(shareOf(h), h.unlocked, { ceremonyId: record.ceremonyId, nodeId: 'insurer', bootPublicKeyHex: boot });
}

/** What a holder who lies would send: a well-signed release of a share that is not theirs. */
function lyingRelease(keyring: NodeKeyring, h: Holder, slot: number): ShareRelease {
  const boot = keyring.status().bootPublicKeyHex!;
  const body = {
    v: 1 as const, kind: 'zpk.care share release' as const, ceremonyId: record.ceremonyId, nodeId: 'insurer',
    holder: h.card.signPublicKeyHex, index: slot, bootPublicKeyHex: boot,
    envelope: sealTo(boot, randomBytes(32), `zpk.care/ceremony/v1/release/${record.ceremonyId}/insurer/${boot}/${slot}`),
  };
  const digest = createHash('sha256').update(canonicalJson(body), 'utf8').digest('hex');
  return { ...body, signatureHex: h.unlocked.sign(Buffer.from(`zpk.care/share-release/v1\n${digest}`, 'utf8')) };
}

describe('NodeKeyring', () => {
  test('a node with no master waits for 3 holders, then unlocks and seals its master to its machine', async () => {
    const seal = testOnlyMachineSeal();
    const keyring = new NodeKeyring({ record, nodeId: 'insurer', stateDir: dir, seal });
    const status = await keyring.start();
    expect(status.state).toBe('awaiting-shares');
    expect(status.threshold).toBe(3);
    expect(status.bootFingerprint).toBe(bootFingerprint(status.bootPublicKeyHex!));
    expect(keyring.isUnlocked()).toBe(false);
    expect(() => keyring.subkey(SUBKEYS.planPinPepper)).toThrow(/locked/);

    expect((await keyring.acceptRelease(releaseTo(keyring, holders[0]))).status.received).toBe(1);
    expect((await keyring.acceptRelease(releaseTo(keyring, holders[2]))).status.state).toBe('awaiting-shares');
    const third = await keyring.acceptRelease(releaseTo(keyring, holders[4]));
    expect(third.accepted).toBe(true);
    expect(third.status.state).toBe('unlocked');
    expect(insurerPublicKeyFromSeed(keyring.insurerSigningSeed())).toBe(record.nodes[0].publicKeys.insurerSigningPublicKeyHex);

    const sealed = fs.readdirSync(path.join(dir, 'node-keys'));
    expect(sealed).toEqual([`${record.ceremonyId}.insurer.sealed.json`]);
    expect(fs.readFileSync(path.join(dir, 'node-keys', sealed[0]), 'utf8')).not.toContain(keyring.subkey(SUBKEYS.planPinPepper).toString('hex'));
    keyring.close();
  });

  test('after a restart on the same machine it unlocks by itself, with no holder', async () => {
    const seal = testOnlyMachineSeal();
    const first = new NodeKeyring({ record, nodeId: 'insurer', stateDir: dir, seal });
    await first.start();
    for (const h of holders.slice(0, 3)) await first.acceptRelease(releaseTo(first, h));
    const seed = first.insurerSigningSeed();
    first.close();

    const restarted = new NodeKeyring({ record, nodeId: 'insurer', stateDir: dir, seal });
    let told = 0;
    restarted.onUnlocked(() => { told++; });
    const status = await restarted.start();
    expect(status.state).toBe('unlocked');
    expect(status.bootPublicKeyHex).toBeUndefined();
    expect(told).toBe(1);
    expect(restarted.insurerSigningSeed()).toBe(seed);
    restarted.close();
  });

  test('on another machine the sealed master opens nothing, and the holders provision it again', async () => {
    const first = new NodeKeyring({ record, nodeId: 'insurer', stateDir: dir, seal: testOnlyMachineSeal() });
    await first.start();
    for (const h of holders.slice(0, 3)) await first.acceptRelease(releaseTo(first, h));
    first.close();

    const elsewhere = new NodeKeyring({ record, nodeId: 'insurer', stateDir: dir, seal: testOnlyMachineSeal() });
    const status = await elsewhere.start();
    expect(status.state).toBe('awaiting-shares');
    expect(status.reason).toMatch(/could not be opened on this machine/);
    for (const h of holders.slice(2, 5)) await elsewhere.acceptRelease(releaseTo(elsewhere, h));
    expect(elsewhere.isUnlocked()).toBe(true);
    elsewhere.close();
  });

  test('a release made for an earlier start is refused', async () => {
    const earlier = new NodeKeyring({ record, nodeId: 'insurer', stateDir: dir, seal: testOnlyMachineSeal() });
    await earlier.start();
    const stale = releaseTo(earlier, holders[0]);
    const later = new NodeKeyring({ record, nodeId: 'insurer', stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'keyring-b-')), seal: testOnlyMachineSeal() });
    await later.start();
    const result = await later.acceptRelease(stale);
    expect(result.accepted).toBe(false);
    expect(result.reason).toMatch(/another start/);
    expect(later.status().received).toBe(0);
  });

  test('a lying holder cannot unlock it, and one more good share finds the three that agree', async () => {
    const logged: string[] = [];
    const keyring = new NodeKeyring({ record, nodeId: 'insurer', stateDir: dir, seal: testOnlyMachineSeal(), log: (m) => logged.push(m) });
    await keyring.start();
    await keyring.acceptRelease(releaseTo(keyring, holders[0]));
    await keyring.acceptRelease(lyingRelease(keyring, holders[1], 2));
    const third = await keyring.acceptRelease(releaseTo(keyring, holders[2]));
    expect(third.status.state).toBe('awaiting-shares');
    expect(third.status.reason).toMatch(/do not rebuild/);
    const fourth = await keyring.acceptRelease(releaseTo(keyring, holders[3]));
    expect(fourth.status.state).toBe('unlocked');
    expect(logged.join(' ')).toContain('the share from holder-2 did not agree with the others');
    keyring.close();
  });

  test('once unlocked it takes no more releases', async () => {
    const keyring = new NodeKeyring({ record, nodeId: 'insurer', stateDir: dir, seal: testOnlyMachineSeal() });
    await keyring.start();
    const releases = holders.slice(0, 4).map((h) => releaseTo(keyring, h));
    for (const r of releases.slice(0, 3)) await keyring.acceptRelease(r);
    const extra = await keyring.acceptRelease(releases[3]);
    expect(extra.accepted).toBe(false);
    expect(extra.reason).toMatch(/already unlocked/);
    keyring.close();
  });

  test('a node holding a master from another ceremony refuses this one rather than lose its stores', async () => {
    const first = new NodeKeyring({ record, nodeId: 'insurer', stateDir: dir, seal: testOnlyMachineSeal() });
    await first.start();
    for (const h of holders.slice(0, 3)) await first.acceptRelease(releaseTo(first, h));
    first.close();
    const other = signed(runCeremony({ holders: holders.map((h) => h.card), threshold: 3, nodes: [{ nodeId: 'insurer', role: 'insurer' }], programSourceSha256: 'a'.repeat(64) }).record, holders.slice(0, 3));
    const keyring = new NodeKeyring({ record: other, nodeId: 'insurer', stateDir: dir, seal: testOnlyMachineSeal() });
    const status = await keyring.start();
    expect(status.state).toBe('refused');
    expect(status.reason).toMatch(new RegExp(`${record.ceremonyId}.*not built`));
  });

  test('closing wipes the master', async () => {
    const keyring = new NodeKeyring({ record, nodeId: 'insurer', stateDir: dir, seal: testOnlyMachineSeal() });
    await keyring.start();
    for (const h of holders.slice(0, 3)) await keyring.acceptRelease(releaseTo(keyring, h));
    keyring.close();
    expect(keyring.isUnlocked()).toBe(false);
    expect(() => keyring.insurerSigningSeed()).toThrow(/locked/);
  });

  test('a node the record does not key is refused at construction', () => {
    expect(() => new NodeKeyring({ record, nodeId: 'sequencer-1', stateDir: dir, seal: testOnlyMachineSeal() })).toThrow(/does not key/);
  });
});

describe('pinCeremonyRecord (the sequencer\'s trust anchor)', () => {
  function write(name: string, value: unknown): string {
    const file = path.join(dir, name);
    fs.writeFileSync(file, JSON.stringify(value));
    return file;
  }

  test('pins the first valid record, then accepts it again', () => {
    const file = write('record.json', record);
    const anchorDir = path.join(dir, 'l2-data');
    expect(pinCeremonyRecord(file, anchorDir).anchored).toBe('new');
    expect(fs.existsSync(path.join(anchorDir, 'ceremony-anchor.json'))).toBe(true);
    expect(pinCeremonyRecord(file, anchorDir).anchored).toBe('same');
  });

  test('refuses a record without enough signatures', () => {
    const file = write('record.json', signed(made.record, holders.slice(0, 2)));
    expect(() => pinCeremonyRecord(file, path.join(dir, 'l2-data'))).toThrow(/2 of the 3/);
  });

  test('accepts a record that follows the pinned one, and refuses one that does not', () => {
    const anchorDir = path.join(dir, 'l2-data');
    pinCeremonyRecord(write('first.json', record), anchorDir);
    const next = signed(runCeremony({
      holders: holders.map((h) => h.card), threshold: 3, nodes: [{ nodeId: 'insurer', role: 'insurer' }],
      programSourceSha256: 'a'.repeat(64), previous: record,
    }).record, holders.slice(0, 3));
    expect(pinCeremonyRecord(write('next.json', next), anchorDir).anchored).toBe('succeeded');
    const unrelated = signed(runCeremony({ holders: holders.map((h) => h.card), threshold: 3, nodes: [{ nodeId: 'insurer', role: 'insurer' }], programSourceSha256: 'a'.repeat(64) }).record, holders.slice(0, 3));
    expect(() => pinCeremonyRecord(write('unrelated.json', unrelated), anchorDir)).toThrow(/neither is nor follows/);
  });
});
