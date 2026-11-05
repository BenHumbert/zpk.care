/**
 * The sealed record store — A-136, A-142, A-143 (owner, 2026-11-04: save the invites and the plan's enrollment records
 * without letting them leak; the key is made at the key ceremony and never written to the node's disk).
 *
 * A store is an encrypted snapshot and an append-only encrypted journal. Every entry is AES-256-GCM under a key derived
 * for that one store, with the store's name, the journal's generation and the entry's sequence number in its
 * authenticated data, so the files open only with the key, only as the store they were written for and only in the order
 * they were written: a changed, dropped, reordered or swapped entry is refused. A write is on disk before put() returns.
 * A crash can leave a torn last line, which is dropped on open; one in the middle is tampering. The files carry no
 * record in the clear.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomBytes } from 'crypto';
import { SealedRecordStore, SealedStoreError } from '../src/keys/sealed-store.js';
import { deriveSubkey, masterCheckHex, SUBKEYS } from '../src/keys/subkeys.js';

let dir: string;
const key = randomBytes(32);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sealed-store-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function journalPath(name = 'invites'): string { return path.join(dir, `${name}.journal`); }
function snapshotPath(name = 'invites'): string { return path.join(dir, `${name}.snapshot`); }
function lines(file: string): string[] { return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.length > 0); }

describe('subkeys', () => {
  const master = randomBytes(32);

  test('the same master and label give the same key, and different labels different keys', () => {
    expect(deriveSubkey(master, SUBKEYS.planStore('redeemed-codes')).equals(deriveSubkey(master, SUBKEYS.planStore('redeemed-codes')))).toBe(true);
    const labels = [
      SUBKEYS.check, SUBKEYS.insurerSigningSeed, SUBKEYS.planPinPepper, SUBKEYS.planStore('a'), SUBKEYS.planStore('b'),
      SUBKEYS.tenantStore('ACME-001'), SUBKEYS.tenantPinPepper('ACME-001'), SUBKEYS.tenantStore('ACME-002'),
    ];
    const keys = new Set(labels.map((l) => deriveSubkey(master, l).toString('hex')));
    expect(keys.size).toBe(labels.length);
  });

  test('an employer ID cannot be chosen to reach another label', () => {
    expect(SUBKEYS.tenantStore('a/pin-pepper')).not.toBe(SUBKEYS.tenantPinPepper('a'));
    expect(SUBKEYS.tenantStore('x/store')).not.toContain('x/store/');
  });

  test('the check value is not a key and does not reveal the master', () => {
    expect(masterCheckHex(master)).toMatch(/^[0-9a-f]{64}$/);
    expect(masterCheckHex(master)).not.toBe(master.toString('hex'));
    expect(masterCheckHex(master)).not.toBe(deriveSubkey(master, SUBKEYS.planPinPepper).toString('hex'));
  });

  test('refuses a master that is not 32 bytes', () => {
    expect(() => deriveSubkey(randomBytes(16), SUBKEYS.check)).toThrow(/32 bytes/);
  });
});

describe('SealedRecordStore', () => {
  test('records written are there after the store is opened again', () => {
    const store = SealedRecordStore.open<{ status: string }>({ dir, name: 'invites', key });
    store.put('fp-1', { status: 'unused' });
    store.put('fp-2', { status: 'unused' });
    store.put('fp-1', { status: 'consumed' });
    expect(store.delete('fp-2')).toBe(true);
    expect(store.delete('fp-404')).toBe(false);
    store.close();

    const again = SealedRecordStore.open<{ status: string }>({ dir, name: 'invites', key });
    expect(again.get('fp-1')).toEqual({ status: 'consumed' });
    expect(again.has('fp-2')).toBe(false);
    expect(again.size).toBe(1);
    expect([...again.keys()]).toEqual(['fp-1']);
    expect(again.position().seq).toBe(4);
    again.close();
  });

  test('putMany writes one entry for many records', () => {
    const store = SealedRecordStore.open<number>({ dir, name: 'invites', key });
    store.putMany([['a', 1], ['b', 2], ['c', 3]]);
    store.close();
    expect(lines(journalPath())).toHaveLength(2); // the header and one entry
    const again = SealedRecordStore.open<number>({ dir, name: 'invites', key });
    expect([...again.entries()]).toEqual([['a', 1], ['b', 2], ['c', 3]]);
    again.close();
  });

  test('the files carry no record in the clear', () => {
    const store = SealedRecordStore.open<{ marker: string }>({ dir, name: 'invites', key, compactAfter: 2 });
    store.put('MARKER-KEY-0001', { marker: 'MARKER-VALUE-0001' });
    store.put('MARKER-KEY-0002', { marker: 'MARKER-VALUE-0002' });
    store.put('MARKER-KEY-0003', { marker: 'MARKER-VALUE-0003' });
    store.close();
    for (const file of fs.readdirSync(dir)) {
      const raw = fs.readFileSync(path.join(dir, file), 'latin1');
      expect(raw).not.toContain('MARKER');
    }
  });

  test('another key opens nothing', () => {
    const store = SealedRecordStore.open<number>({ dir, name: 'invites', key });
    store.put('a', 1);
    store.close();
    expect(() => SealedRecordStore.open({ dir, name: 'invites', key: randomBytes(32) })).toThrow(SealedStoreError);
  });

  test('one store\'s files cannot be passed off as another\'s, even under the same key', () => {
    const store = SealedRecordStore.open<number>({ dir, name: 'invites', key, compactAfter: 1 });
    store.put('a', 1);
    store.put('b', 2);
    store.close();
    fs.copyFileSync(snapshotPath('invites'), snapshotPath('roster'));
    fs.copyFileSync(journalPath('invites'), journalPath('roster'));
    expect(() => SealedRecordStore.open({ dir, name: 'roster', key })).toThrow(SealedStoreError);
  });

  test('a changed entry is refused', () => {
    const store = SealedRecordStore.open<number>({ dir, name: 'invites', key });
    store.put('a', 1);
    store.put('b', 2);
    store.close();
    const all = lines(journalPath());
    const entry = JSON.parse(all[1]);
    entry.ciphertext = (entry.ciphertext[0] === '0' ? '1' : '0') + entry.ciphertext.slice(1);
    all[1] = JSON.stringify(entry);
    fs.writeFileSync(journalPath(), all.join('\n') + '\n');
    expect(() => SealedRecordStore.open({ dir, name: 'invites', key })).toThrow(/entry 1/);
  });

  test('a dropped or reordered entry is refused', () => {
    const store = SealedRecordStore.open<number>({ dir, name: 'invites', key });
    store.put('a', 1);
    store.put('b', 2);
    store.put('c', 3);
    store.close();
    const all = lines(journalPath());
    fs.writeFileSync(journalPath(), [all[0], all[1], all[3]].join('\n') + '\n');
    expect(() => SealedRecordStore.open({ dir, name: 'invites', key })).toThrow(SealedStoreError);
    fs.writeFileSync(journalPath(), [all[0], all[2], all[1], all[3]].join('\n') + '\n');
    expect(() => SealedRecordStore.open({ dir, name: 'invites', key })).toThrow(SealedStoreError);
  });

  test('a torn last line from a crash is dropped and the store goes on', () => {
    const warnings: string[] = [];
    const store = SealedRecordStore.open<number>({ dir, name: 'invites', key });
    store.put('a', 1);
    store.put('b', 2);
    store.close();
    const raw = fs.readFileSync(journalPath(), 'utf8');
    const lastStart = raw.lastIndexOf('\n', raw.length - 2) + 1;
    fs.writeFileSync(journalPath(), raw.slice(0, lastStart + Math.floor((raw.length - lastStart) / 2)));
    const again = SealedRecordStore.open<number>({ dir, name: 'invites', key, onWarning: (m) => warnings.push(m) });
    expect(again.get('a')).toBe(1);
    expect(again.has('b')).toBe(false);
    expect(warnings.join(' ')).toMatch(/torn/);
    again.put('c', 3);
    again.close();
    const third = SealedRecordStore.open<number>({ dir, name: 'invites', key });
    expect([...third.keys()]).toEqual(['a', 'c']);
    third.close();
  });

  test('compaction folds the journal into a new snapshot, and the records survive it', () => {
    const store = SealedRecordStore.open<number>({ dir, name: 'invites', key, compactAfter: 3 });
    for (let i = 0; i < 7; i++) store.put(`k${i}`, i);
    const pos = store.position();
    expect(pos.generation).toBe(2);
    expect(pos.seq).toBe(7);
    store.close();
    expect(lines(journalPath())).toHaveLength(2); // the header and k6
    const again = SealedRecordStore.open<number>({ dir, name: 'invites', key, compactAfter: 3 });
    expect(again.size).toBe(7);
    expect(again.get('k6')).toBe(6);
    again.close();
  });

  test('a crash between writing the snapshot and starting the new journal loses nothing', () => {
    const store = SealedRecordStore.open<number>({ dir, name: 'invites', key, compactAfter: 100 });
    store.put('a', 1);
    store.put('b', 2);
    store.close();
    const oldJournal = fs.readFileSync(journalPath());
    const compacting = SealedRecordStore.open<number>({ dir, name: 'invites', key, compactAfter: 100 });
    compacting.compact();
    compacting.close();
    // as if the process died after the snapshot's rename and before the journal's
    fs.writeFileSync(journalPath(), oldJournal);
    const again = SealedRecordStore.open<number>({ dir, name: 'invites', key });
    expect([...again.entries()]).toEqual([['a', 1], ['b', 2]]);
    again.put('c', 3);
    again.close();
    const third = SealedRecordStore.open<number>({ dir, name: 'invites', key });
    expect(third.size).toBe(3);
    third.close();
  });

  test('a compaction that fails does not fail the write that triggered it', () => {
    const warnings: string[] = [];
    const store = SealedRecordStore.open<number>({ dir, name: 'invites', key, compactAfter: 2, onWarning: (m) => warnings.push(m) });
    store.put('a', 1);
    fs.mkdirSync(snapshotPath()); // the snapshot cannot be renamed onto a directory
    expect(() => store.put('b', 2)).not.toThrow();
    expect(warnings.join(' ')).toMatch(/could not fold/);
    expect(store.get('b')).toBe(2);
    expect(fs.readdirSync(dir).filter((f) => f.includes('.tmp-'))).toEqual([]);
    store.close();
    fs.rmSync(snapshotPath(), { recursive: true });
    const again = SealedRecordStore.open<number>({ dir, name: 'invites', key });
    expect([...again.entries()]).toEqual([['a', 1], ['b', 2]]);
    again.close();
  });

  test('a journal newer than its snapshot is refused', () => {
    const store = SealedRecordStore.open<number>({ dir, name: 'invites', key, compactAfter: 1 });
    store.put('a', 1);
    store.put('b', 2);
    store.close();
    fs.rmSync(snapshotPath());
    expect(() => SealedRecordStore.open({ dir, name: 'invites', key })).toThrow(/newer than/);
  });

  test('a failed write changes nothing in memory', () => {
    const store = SealedRecordStore.open<unknown>({ dir, name: 'invites', key });
    store.put('a', 1);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => store.put('b', circular)).toThrow();
    expect(store.has('b')).toBe(false);
    expect(store.position().seq).toBe(1);
    store.close();
  });

  test('refuses a key that is not 32 bytes and a name that could escape its directory', () => {
    expect(() => SealedRecordStore.open({ dir, name: 'invites', key: randomBytes(16) })).toThrow(/32 bytes/);
    expect(() => SealedRecordStore.open({ dir, name: '../x', key })).toThrow(/name/);
    expect(() => SealedRecordStore.open({ dir, name: '', key })).toThrow(/name/);
  });

  test('a closed store refuses writes', () => {
    const store = SealedRecordStore.open<number>({ dir, name: 'invites', key });
    store.close();
    expect(() => store.put('a', 1)).toThrow(/closed/);
  });
});
