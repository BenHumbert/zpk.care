/**
 * Where the insurer's attestation key comes from at boot — the key ceremony (owner, 2026-11-04), A9.
 *
 * With a ceremony record the sequencer pins the record and the insurer key it publishes, and the insurer node is given
 * the record's path and no seed: nothing secret passes through the launcher. Without one, the old way: a configured or
 * random seed handed to the insurer. A record without enough signatures stops the boot.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHolderKey, unlockHolderKey } from '../src/keys/holder-key.js';
import { runCeremony, signCeremonyRecord, addRecordSignature } from '../src/keys/ceremony.js';
import type { CeremonyRecord } from '../src/keys/ceremony.js';
import { planInsurerKeys } from '../src/keys/launcher-ceremony.js';
import { insurerPublicKeyFromSeed } from '../src/onboarding/employer-attestation.js';

const PASS = 'correct horse battery staple';
const holders = Array.from({ length: 3 }, (_, i) => {
  const { file, card } = createHolderKey(`holder-${i + 1}`, PASS, { scryptN: 2 ** 12 });
  return { card, unlocked: unlockHolderKey(file, PASS) };
});
const unsigned = runCeremony({ holders: holders.map((h) => h.card), threshold: 2, nodes: [{ nodeId: 'insurer', role: 'insurer' }], programSourceSha256: 'a'.repeat(64) }).record;
const sign = (r: CeremonyRecord, n: number) => holders.slice(0, n).reduce((acc, h) => addRecordSignature(acc, signCeremonyRecord(acc, h.unlocked)), r);

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-ceremony-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

test('with a ceremony record the sequencer pins its insurer key and the insurer gets no seed', () => {
  const file = path.join(dir, 'record.json');
  fs.writeFileSync(file, JSON.stringify(sign(unsigned, 2)));
  const plan = planInsurerKeys({ ZKTRIDENT_CEREMONY_RECORD: file, ZKTRIDENT_INSURER_SIGNING_SEED: 'an old seed' }, path.join(dir, 'l2-data'));
  expect(plan.insurerAttestationPublicKeyHex).toBe(unsigned.nodes[0].publicKeys.insurerSigningPublicKeyHex);
  expect(plan.insurerChildEnv).toEqual({ ZKTRIDENT_CEREMONY_RECORD: path.resolve(file), ZKTRIDENT_CEREMONY_NODE_ID: 'insurer' });
  expect(plan.ceremony?.anchored).toBe('new');
  expect(plan.notes.join(' ')).toMatch(/ignored/);
  expect(planInsurerKeys({ ZKTRIDENT_CEREMONY_RECORD: file }, path.join(dir, 'l2-data')).ceremony?.anchored).toBe('same');
});

test('a record without enough signatures stops the boot', () => {
  const file = path.join(dir, 'record.json');
  fs.writeFileSync(file, JSON.stringify(sign(unsigned, 1)));
  expect(() => planInsurerKeys({ ZKTRIDENT_CEREMONY_RECORD: file }, path.join(dir, 'l2-data'))).toThrow(/1 of the 2/);
});

test('without one, the configured seed or a random one goes to the insurer as before', () => {
  const configured = planInsurerKeys({ ZKTRIDENT_INSURER_SIGNING_SEED: 'configured-seed' }, dir);
  expect(configured.insurerChildEnv).toEqual({ ZKTRIDENT_INSURER_SIGNING_SEED: 'configured-seed' });
  expect(configured.insurerAttestationPublicKeyHex).toBe(insurerPublicKeyFromSeed('configured-seed'));
  expect(configured.ceremony).toBeNull();
  const random = planInsurerKeys({}, dir);
  expect(random.insurerChildEnv.ZKTRIDENT_INSURER_SIGNING_SEED).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(random.notes.join(' ')).toMatch(/random/);
});
