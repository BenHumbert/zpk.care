/**
 * The key ceremony — owner, 2026-11-04: "The secrets are created using multisig like how we create DNS private key
 * ceremonites to ensure nothing is leaked or hackable or infiltrated."
 *
 * Modeled on the DNS root key ceremony (KSK-2024): each key holder makes their own keys, locked under their own
 * passphrase. The ceremony program makes each node's master, splits it among the holders (any `threshold` of them
 * rebuild it, fewer learn nothing), seals each share to its holder and wipes the master; no person ever sees it. It
 * writes a record: the holders, the threshold, a check value of each master and the public keys derived from it. The
 * holders sign the record; it is valid with `threshold` of their signatures, it is the trust anchor the network pins,
 * and a later record (a rotation, a change of holders) must be signed by the holders of the one before it.
 *
 * A holder releases a share to a node being provisioned by sealing it again to that node's one-time key and signing the
 * release; the node accepts only a release signed by a holder in the record, for its own key and its own slot.
 */
import { randomBytes } from 'crypto';
import {
  createHolderKey, unlockHolderKey, holderFingerprint, isHolderCard, verifyHolderSignature,
} from '../src/keys/holder-key.js';
import type { HolderCard, HolderKeyFile, UnlockedHolder } from '../src/keys/holder-key.js';
import {
  runCeremony, signCeremonyRecord, addRecordSignature, verifyCeremonyRecord, verifyRecordSuccession, recordHashOf,
  openHolderShare, releaseShare, acceptShareRelease, canonicalJson, CeremonyRecordError,
} from '../src/keys/ceremony.js';
import type { CeremonyRecord, ShareFile } from '../src/keys/ceremony.js';
import { combineShares } from '../src/keys/shamir.js';
import { masterCheckHex, deriveSubkey, SUBKEYS } from '../src/keys/subkeys.js';
import { generateBoxKeyPair, sealTo, openSealed } from '../src/keys/seal.js';
import { insurerPublicKeyFromSeed } from '../src/onboarding/employer-attestation.js';

const FAST = { scryptN: 2 ** 12 };
const PASS = 'correct horse battery staple';
const PROGRAM = 'a'.repeat(64);

interface Holder { file: HolderKeyFile; card: HolderCard; unlocked: UnlockedHolder }

function makeHolders(n: number, groups?: string[], prefix = 'holder'): Holder[] {
  return Array.from({ length: n }, (_, i) => {
    const { file, card } = createHolderKey(`${prefix}-${i + 1}`, PASS, { ...FAST, group: groups?.[i] });
    return { file, card, unlocked: unlockHolderKey(file, PASS) };
  });
}

function ceremony(holders: Holder[], threshold = 3) {
  return runCeremony({
    holders: holders.map((h) => h.card),
    threshold,
    nodes: [{ nodeId: 'insurer', role: 'insurer' }],
    programSourceSha256: PROGRAM,
    now: new Date('2026-11-05T18:00:00Z'),
  });
}

function signedBy(record: CeremonyRecord, holders: Holder[]): CeremonyRecord {
  let out = record;
  for (const h of holders) out = addRecordSignature(out, signCeremonyRecord(out, h.unlocked));
  return out;
}

function sharesFor(shares: ShareFile[], holders: Holder[]) {
  return holders.map((h) => openHolderShare(shares.find((s) => s.holder === h.card.signPublicKeyHex)!, h.unlocked));
}

describe('holder keys', () => {
  test('a holder key opens only with its passphrase, and its private halves match its card', () => {
    const { file, card } = createHolderKey('holder-1', PASS, FAST);
    expect(isHolderCard(card)).toBe(true);
    const unlocked = unlockHolderKey(file, PASS);
    expect(unlocked.card).toEqual(card);
    expect(() => unlockHolderKey(file, 'wrong passphrase, long enough')).toThrow(/passphrase/);
    const message = Buffer.from('zpk.care test message');
    expect(verifyHolderSignature(card.signPublicKeyHex, message, unlocked.sign(message))).toBe(true);
    const envelope = sealTo(card.boxPublicKeyHex, Buffer.from('x'), 'zpk.care/test');
    expect(openSealed(unlocked.boxPrivateKey, envelope, 'zpk.care/test').toString()).toBe('x');
    // the file keeps the private halves only inside its one ciphertext
    expect(Object.keys(file).sort()).toEqual(
      ['boxPublicKeyHex', 'ciphertext', 'createdAt', 'iv', 'kdf', 'kind', 'label', 'signPublicKeyHex', 'tag', 'v'],
    );
    expect(file.kdf.N).toBe(2 ** 12);
  });

  test('a real holder key uses a slow passphrase hash', () => {
    const { file } = createHolderKey('holder-1', PASS);
    expect(file.kdf.N).toBe(2 ** 17);
  });

  test('a changed key file is refused', () => {
    const { file } = createHolderKey('holder-1', PASS, FAST);
    expect(() => unlockHolderKey({ ...file, label: 'holder-2' }, PASS)).toThrow(/passphrase|changed/);
    expect(() => unlockHolderKey({ ...file, signPublicKeyHex: 'b'.repeat(64) }, PASS)).toThrow(/passphrase|changed/);
  });

  test('a short passphrase or an odd label is refused', () => {
    expect(() => createHolderKey('holder-1', 'short', FAST)).toThrow(/12 characters/);
    expect(() => createHolderKey('', PASS, FAST)).toThrow(/label/);
    expect(() => createHolderKey('a\nb', PASS, FAST)).toThrow(/label/);
  });

  test('a fingerprint is the same for the same card and short enough to read aloud', () => {
    const { card } = createHolderKey('holder-1', PASS, FAST);
    expect(holderFingerprint(card)).toMatch(/^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/);
    expect(holderFingerprint(card)).toBe(holderFingerprint({ ...card }));
  });
});

describe('the ceremony', () => {
  const holders = makeHolders(5);

  test('any 3 of the 5 holders rebuild the master the record checks, and the public keys come from it', () => {
    const { record, shares } = ceremony(holders);
    expect(shares).toHaveLength(5);
    const node = record.nodes[0];
    const master = combineShares(sharesFor(shares, [holders[0], holders[2], holders[4]]));
    expect(masterCheckHex(master)).toBe(node.masterCheckHex);
    const seed = deriveSubkey(master, SUBKEYS.insurerSigningSeed).toString('base64url');
    expect(node.publicKeys.insurerSigningPublicKeyHex).toBe(insurerPublicKeyFromSeed(seed));
    const other = combineShares(sharesFor(shares, [holders[1], holders[3], holders[4]]));
    expect(other.equals(master)).toBe(true);
  });

  test('two holders rebuild nothing the record accepts', () => {
    const { record, shares } = ceremony(holders);
    const two = combineShares(sharesFor(shares, [holders[0], holders[1]]));
    expect(masterCheckHex(two)).not.toBe(record.nodes[0].masterCheckHex);
  });

  test('the record and the shares carry no master and no private key', () => {
    const { record, shares } = ceremony(holders);
    const master = combineShares(sharesFor(shares, holders.slice(0, 3)));
    const text = JSON.stringify({ record, shares });
    expect(text).not.toContain(master.toString('hex'));
    expect(text).not.toContain(master.toString('base64'));
    expect(text).not.toContain(deriveSubkey(master, SUBKEYS.insurerSigningSeed).toString('base64url'));
  });

  test('a holder opens only their own share', () => {
    const { shares } = ceremony(holders);
    expect(() => openHolderShare(shares[0], holders[1].unlocked)).toThrow(/not this holder's/);
    const forged = { ...shares[0], holder: holders[1].card.signPublicKeyHex };
    expect(() => openHolderShare(forged, holders[1].unlocked)).toThrow();
  });

  test('each ceremony makes a new master', () => {
    const a = ceremony(holders);
    const b = ceremony(holders);
    expect(a.record.nodes[0].masterCheckHex).not.toBe(b.record.nodes[0].masterCheckHex);
    expect(a.record.ceremonyId).not.toBe(b.record.ceremonyId);
  });

  test('refuses a threshold or a holder set that would not protect the master', () => {
    expect(() => ceremony(holders, 1)).toThrow(/threshold/);
    expect(() => ceremony(holders, 6)).toThrow(/threshold/);
    const twice = [holders[0], holders[0], holders[1]];
    expect(() => ceremony(twice, 2)).toThrow(/twice/);
  });

  test('no one group may hold enough shares to rebuild a master alone', () => {
    const grouped = makeHolders(5, ['operations', 'operations', 'operations', 'compliance', 'leadership']);
    expect(() => ceremony(grouped, 3)).toThrow(/operations/);
    const fine = makeHolders(5, ['operations', 'operations', 'compliance', 'compliance', 'leadership']);
    expect(() => ceremony(fine, 3)).not.toThrow();
  });
});

describe('the record', () => {
  const holders = makeHolders(5);

  test('is valid with 3 holder signatures and not with 2', () => {
    const { record } = ceremony(holders);
    expect(() => verifyCeremonyRecord(record)).toThrow(/0 of the 3/);
    const two = signedBy(record, holders.slice(0, 2));
    expect(() => verifyCeremonyRecord(two)).toThrow(/2 of the 3/);
    const three = signedBy(record, holders.slice(0, 3));
    const result = verifyCeremonyRecord(three);
    expect(result.recordHash).toBe(recordHashOf(three));
    expect(result.signedBy).toHaveLength(3);
  });

  test('a signature counts once per holder, and only for a holder in the record', () => {
    const { record } = ceremony(holders);
    const sig = signCeremonyRecord(record, holders[0].unlocked);
    const repeated = { ...record, signatures: [sig, sig, sig] };
    expect(() => verifyCeremonyRecord(repeated)).toThrow(/1 of the 3/);
    const outsider = makeHolders(1)[0];
    const withOutsider = addRecordSignature(signedBy(record, holders.slice(0, 2)), signCeremonyRecord(record, outsider.unlocked));
    expect(() => verifyCeremonyRecord(withOutsider)).toThrow(/2 of the 3/);
  });

  test('any change to a signed record breaks it', () => {
    const signed = signedBy(ceremony(holders).record, holders.slice(0, 3));
    const changedKey = { ...signed, nodes: [{ ...signed.nodes[0], publicKeys: { insurerSigningPublicKeyHex: 'c'.repeat(64) } }] };
    expect(() => verifyCeremonyRecord(changedKey)).toThrow(CeremonyRecordError);
    const changedThreshold = { ...signed, threshold: 2 };
    expect(() => verifyCeremonyRecord(changedThreshold)).toThrow(CeremonyRecordError);
    const droppedHolder = { ...signed, holders: signed.holders.slice(0, 4) };
    expect(() => verifyCeremonyRecord(droppedHolder)).toThrow(CeremonyRecordError);
  });

  test('canonical JSON does not depend on key order', () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] })).toBe('{"a":[2,{"c":4,"d":3}],"b":1}');
  });

  test('a later record must be signed by the holders of the one before it', () => {
    const first = signedBy(ceremony(holders).record, holders.slice(0, 3));
    const newHolders = [...holders.slice(0, 3), ...makeHolders(2, undefined, 'new')];
    const next = runCeremony({
      holders: newHolders.map((h) => h.card),
      threshold: 3,
      nodes: [{ nodeId: 'insurer', role: 'insurer' }],
      programSourceSha256: PROGRAM,
      previous: first,
    }).record;
    expect(next.previous).toEqual({ ceremonyId: first.ceremonyId, recordHash: recordHashOf(first) });
    // signed by three of the new set, two of whom held keys before: not enough of the old set
    const newOnly = signedBy(next, [newHolders[2], newHolders[3], newHolders[4]]);
    expect(() => verifyRecordSuccession(first, newOnly)).toThrow(/previous holders/);
    const both = signedBy(next, [newHolders[0], newHolders[1], newHolders[2]]);
    expect(verifyRecordSuccession(first, both).recordHash).toBe(recordHashOf(both));
    // a record naming another predecessor does not follow this one
    const stranger = signedBy(ceremony(holders).record, holders.slice(0, 3));
    expect(() => verifyRecordSuccession(stranger, both)).toThrow(/does not follow/);
  });
});

describe('releasing a share to a node being provisioned', () => {
  const holders = makeHolders(5);
  const { record: unsigned, shares } = ceremony(holders);
  const record = signedBy(unsigned, holders.slice(0, 3));

  test('the node rebuilds its master from 3 releases sealed to its one-time key', () => {
    const boot = generateBoxKeyPair();
    const target = { ceremonyId: record.ceremonyId, nodeId: 'insurer', bootPublicKeyHex: boot.publicKeyHex };
    const accepted = [holders[1], holders[3], holders[4]].map((h) => {
      const share = shares.find((s) => s.holder === h.card.signPublicKeyHex)!;
      return acceptShareRelease(releaseShare(share, h.unlocked, target), record, boot, 'insurer');
    });
    expect(masterCheckHex(combineShares(accepted))).toBe(record.nodes[0].masterCheckHex);
  });

  test('a release is refused for another node key, another node or a forged signature', () => {
    const boot = generateBoxKeyPair();
    const other = generateBoxKeyPair();
    const share = shares[0];
    const release = releaseShare(share, holders[0].unlocked, { ceremonyId: record.ceremonyId, nodeId: 'insurer', bootPublicKeyHex: other.publicKeyHex });
    expect(() => acceptShareRelease(release, record, boot, 'insurer')).toThrow(/another start/);
    const good = releaseShare(share, holders[0].unlocked, { ceremonyId: record.ceremonyId, nodeId: 'insurer', bootPublicKeyHex: boot.publicKeyHex });
    expect(() => acceptShareRelease(good, record, boot, 'sequencer-1')).toThrow(/another node/);
    const forged = { ...good, signatureHex: signCeremonyRecord(record, holders[0].unlocked).signatureHex };
    expect(() => acceptShareRelease(forged, record, boot, 'insurer')).toThrow(/signature/);
    const wrongSlot = { ...good, index: 2 };
    expect(() => acceptShareRelease(wrongSlot, record, boot, 'insurer')).toThrow(/signature|slot/);
  });

  test('a holder not in the record cannot release a share', () => {
    const boot = generateBoxKeyPair();
    const outsider = makeHolders(1)[0];
    const share = { ...shares[0], holder: outsider.card.signPublicKeyHex };
    expect(() => releaseShare(share, outsider.unlocked, { ceremonyId: record.ceremonyId, nodeId: 'insurer', bootPublicKeyHex: boot.publicKeyHex })).toThrow();
  });

  test('the release carries no share in the clear', () => {
    const boot = generateBoxKeyPair();
    const share = openHolderShare(shares[0], holders[0].unlocked);
    const release = releaseShare(shares[0], holders[0].unlocked, { ceremonyId: record.ceremonyId, nodeId: 'insurer', bootPublicKeyHex: boot.publicKeyHex });
    expect(JSON.stringify(release)).not.toContain(share.value.toString('hex'));
    expect(JSON.stringify(release)).not.toContain(randomBytes(0).toString('hex') + share.value.toString('base64'));
  });
});
