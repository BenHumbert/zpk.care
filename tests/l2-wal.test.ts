/**
 * L2 WAL Tests — Write-Ahead Log unit tests.
 *
 * Tests the InMemoryWalProvider and FileWalProvider implementations
 * for append, commit, recovery, truncation, and integrity.
 */

import { InMemoryWalProvider, FileWalProvider, computeWalIntegrityHash } from '../src/l2/l2-wal.js';
import type { WalEntry, IWalProvider, WalConfig } from '../src/l2/l2-wal.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ─── Test Helpers ──────────────────────────────────────────

function makeProofEntry(partitionIndex: number, seqNum: bigint, walletId?: string): Omit<WalEntry, 'entryId' | 'committed' | 'integrityHash' | 'prevIntegrityHash'> {
  return {
    type: 'proof',
    partitionIndex,
    sequenceNumber: seqNum,
    walletId: walletId ?? `wallet-${seqNum}`,
    stateSnapshot: {
      registryRoot: '12345',
      lifecycleRoot: '67890',
      walletCount: '1',
      auditChainHash: 'abc',
    },
    timestamp: Date.now(),
  };
}

function makeBatchEntry(partitionIndex: number, seqNum: bigint, type: 'batch_begin' | 'batch_commit' | 'batch_abort'): Omit<WalEntry, 'entryId' | 'committed' | 'integrityHash' | 'prevIntegrityHash'> {
  return {
    type,
    partitionIndex,
    sequenceNumber: seqNum,
    timestamp: Date.now(),
  };
}

// ─── InMemoryWalProvider Tests ─────────────────────────────

describe('InMemoryWalProvider', () => {
  let wal: InMemoryWalProvider;

  beforeEach(() => {
    wal = new InMemoryWalProvider();
  });

  afterEach(async () => {
    await wal.close();
  });

  test('append returns an entryId', async () => {
    const entryId = await wal.append(makeProofEntry(0, 1n));
    expect(entryId).toBeTruthy();
    expect(typeof entryId).toBe('string');
    expect(entryId.length).toBe(32);
  });

  test('append stores entry retrievable via getAllEntries', async () => {
    await wal.append(makeProofEntry(0, 1n));
    const entries = wal.getAllEntries(0);
    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe('proof');
    expect(entries[0].sequenceNumber).toBe(1n);
    expect(entries[0].committed).toBe(false);
  });

  test('commit marks entry as committed', async () => {
    const entryId = await wal.append(makeProofEntry(0, 1n));
    await wal.commit(entryId);
    const entries = wal.getAllEntries(0);
    expect(entries[0].committed).toBe(true);
  });

  test('getUncommitted returns only uncommitted entries', async () => {
    const id1 = await wal.append(makeProofEntry(0, 1n));
    await wal.append(makeProofEntry(0, 2n));
    const id3 = await wal.append(makeProofEntry(0, 3n));

    await wal.commit(id1);
    await wal.commit(id3);

    const uncommitted = await wal.getUncommitted(0);
    expect(uncommitted).toHaveLength(1);
    expect(uncommitted[0].sequenceNumber).toBe(2n);
  });

  test('getUncommitted returns entries sorted by sequence number', async () => {
    await wal.append(makeProofEntry(0, 3n));
    await wal.append(makeProofEntry(0, 1n));
    await wal.append(makeProofEntry(0, 2n));

    const uncommitted = await wal.getUncommitted(0);
    expect(uncommitted).toHaveLength(3);
    expect(uncommitted[0].sequenceNumber).toBe(1n);
    expect(uncommitted[1].sequenceNumber).toBe(2n);
    expect(uncommitted[2].sequenceNumber).toBe(3n);
  });

  test('getUncommitted returns empty for committed entries', async () => {
    const id1 = await wal.append(makeProofEntry(0, 1n));
    await wal.commit(id1);

    const uncommitted = await wal.getUncommitted(0);
    expect(uncommitted).toHaveLength(0);
  });

  test('readAfter returns entries after given sequence number', async () => {
    await wal.append(makeProofEntry(0, 1n));
    await wal.append(makeProofEntry(0, 2n));
    await wal.append(makeProofEntry(0, 3n));
    await wal.append(makeProofEntry(0, 4n));

    const after2 = await wal.readAfter(0, 2n);
    expect(after2).toHaveLength(2);
    expect(after2[0].sequenceNumber).toBe(3n);
    expect(after2[1].sequenceNumber).toBe(4n);
  });

  test('getLatestSequenceNumber returns -1n for empty partition', () => {
    expect(wal.getLatestSequenceNumber(0)).toBe(-1n);
  });

  test('getLatestSequenceNumber tracks highest sequence', async () => {
    await wal.append(makeProofEntry(0, 5n));
    await wal.append(makeProofEntry(0, 3n));
    expect(wal.getLatestSequenceNumber(0)).toBe(5n);
  });

  test('truncateBefore removes old entries', async () => {
    await wal.append(makeProofEntry(0, 1n));
    await wal.append(makeProofEntry(0, 2n));
    await wal.append(makeProofEntry(0, 3n));
    await wal.append(makeProofEntry(0, 4n));

    await wal.truncateBefore(0, 2n);

    const entries = wal.getAllEntries(0);
    expect(entries).toHaveLength(2);
    expect(entries[0].sequenceNumber).toBe(3n);
    expect(entries[1].sequenceNumber).toBe(4n);
  });

  test('multiple partitions are independent', async () => {
    await wal.append(makeProofEntry(0, 1n, 'wallet-p0'));
    await wal.append(makeProofEntry(1, 1n, 'wallet-p1'));
    await wal.append(makeProofEntry(0, 2n, 'wallet-p0-2'));

    expect(wal.getAllEntries(0)).toHaveLength(2);
    expect(wal.getAllEntries(1)).toHaveLength(1);
    expect(wal.getLatestSequenceNumber(0)).toBe(2n);
    expect(wal.getLatestSequenceNumber(1)).toBe(1n);
  });

  test('getTotalEntryCount counts across all partitions', async () => {
    await wal.append(makeProofEntry(0, 1n));
    await wal.append(makeProofEntry(1, 1n));
    await wal.append(makeProofEntry(2, 1n));

    expect(wal.getTotalEntryCount()).toBe(3);
  });

  test('clear removes all entries', async () => {
    await wal.append(makeProofEntry(0, 1n));
    await wal.append(makeProofEntry(1, 1n));

    wal.clear();

    expect(wal.getTotalEntryCount()).toBe(0);
    expect(wal.getLatestSequenceNumber(0)).toBe(-1n);
  });

  test('integrity hash is deterministic', () => {
    const entry = makeProofEntry(0, 1n, 'test-wallet');
    const hash1 = computeWalIntegrityHash(entry);
    const hash2 = computeWalIntegrityHash(entry);
    expect(hash1).toBe(hash2);
  });

  test('integrity hash differs for different entries', () => {
    const entry1 = makeProofEntry(0, 1n, 'wallet-a');
    const entry2 = makeProofEntry(0, 2n, 'wallet-b');
    const hash1 = computeWalIntegrityHash(entry1);
    const hash2 = computeWalIntegrityHash(entry2);
    expect(hash1).not.toBe(hash2);
  });

  test('batch entries work correctly', async () => {
    const id1 = await wal.append(makeBatchEntry(0, 10n, 'batch_begin'));
    const id2 = await wal.append(makeBatchEntry(0, 10n, 'batch_commit'));

    const entries = wal.getAllEntries(0);
    expect(entries).toHaveLength(2);
    expect(entries[0].type).toBe('batch_begin');
    expect(entries[1].type).toBe('batch_commit');

    await wal.commit(id1);
    await wal.commit(id2);

    expect((await wal.getUncommitted(0))).toHaveLength(0);
  });

  test('commit with unknown entryId is a no-op', async () => {
    await wal.commit('nonexistent-id');
    // Should not throw
  });

  test('entries have integrityHash set', async () => {
    await wal.append(makeProofEntry(0, 1n));
    const entries = wal.getAllEntries(0);
    expect(entries[0].integrityHash).toBeTruthy();
    expect(typeof entries[0].integrityHash).toBe('string');
    expect(entries[0].integrityHash.length).toBe(32);
  });

  test('entries are hash-chained via prevIntegrityHash', async () => {
    await wal.append(makeProofEntry(0, 1n));
    await wal.append(makeProofEntry(0, 2n));
    await wal.append(makeProofEntry(0, 3n));
    const entries = wal.getAllEntries(0);

    expect(entries[0].prevIntegrityHash).toBe('0'); // genesis
    expect(entries[1].prevIntegrityHash).toBe(entries[0].integrityHash);
    expect(entries[2].prevIntegrityHash).toBe(entries[1].integrityHash);
  });

  test('chain resets after truncation', async () => {
    await wal.append(makeProofEntry(0, 1n));
    await wal.append(makeProofEntry(0, 2n));
    await wal.truncateBefore(0, 1n);
    await wal.append(makeProofEntry(0, 3n));
    const entries = wal.getAllEntries(0);

    // After truncation, the chain continues from the last kept entry
    expect(entries).toHaveLength(2); // seq 2 + seq 3
    expect(entries[1].prevIntegrityHash).toBe(entries[0].integrityHash);
  });
});

// ─── FileWalProvider Tests ─────────────────────────────────

describe('FileWalProvider', () => {
  let tmpDir: string;
  let wal: FileWalProvider;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'l2-wal-test-'));
    wal = new FileWalProvider({
      dataDir: tmpDir,
      fsyncOnWrite: false, // Faster for tests
    });
  });

  afterEach(async () => {
    await wal.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('append creates WAL file and stores entry', async () => {
    await wal.append(makeProofEntry(0, 1n));

    const walFile = path.join(tmpDir, 'wal', 'partition-0.wal');
    expect(fs.existsSync(walFile)).toBe(true);

    const content = fs.readFileSync(walFile, 'utf-8');
    expect(content).toContain('"type":"proof"');
  });

  test('append + commit writes commit marker', async () => {
    const entryId = await wal.append(makeProofEntry(0, 1n));
    await wal.commit(entryId);

    const walFile = path.join(tmpDir, 'wal', 'partition-0.wal');
    const content = fs.readFileSync(walFile, 'utf-8');
    expect(content).toContain(`"commit":"${entryId}"`);
  });

  test('committed entries are not returned by getUncommitted', async () => {
    const id1 = await wal.append(makeProofEntry(0, 1n));
    await wal.append(makeProofEntry(0, 2n));
    await wal.commit(id1);

    const uncommitted = await wal.getUncommitted(0);
    expect(uncommitted).toHaveLength(1);
    expect(uncommitted[0].sequenceNumber).toBe(2n);
  });

  test('recovery from file: reload after close', async () => {
    const id1 = await wal.append(makeProofEntry(0, 1n));
    await wal.commit(id1);
    await wal.append(makeProofEntry(0, 2n));
    await wal.close();

    // Create new WAL provider pointing to same directory
    const wal2 = new FileWalProvider({
      dataDir: tmpDir,
      fsyncOnWrite: false,
    });

    const uncommitted = await wal2.getUncommitted(0);
    expect(uncommitted).toHaveLength(1);
    expect(uncommitted[0].sequenceNumber).toBe(2n);

    expect(wal2.getLatestSequenceNumber(0)).toBe(2n);

    await wal2.close();
  });

  test('truncateBefore compacts the WAL file', async () => {
    const id1 = await wal.append(makeProofEntry(0, 1n));
    const id2 = await wal.append(makeProofEntry(0, 2n));
    const id3 = await wal.append(makeProofEntry(0, 3n));
    await wal.commit(id1);
    await wal.commit(id2);
    await wal.commit(id3);

    await wal.truncateBefore(0, 2n);

    const after = await wal.readAfter(0, 0n);
    expect(after).toHaveLength(1);
    expect(after[0].sequenceNumber).toBe(3n);
  });

  test('multiple partitions use separate files', async () => {
    await wal.append(makeProofEntry(0, 1n));
    await wal.append(makeProofEntry(1, 1n));

    const walDir = path.join(tmpDir, 'wal');
    expect(fs.existsSync(path.join(walDir, 'partition-0.wal'))).toBe(true);
    expect(fs.existsSync(path.join(walDir, 'partition-1.wal'))).toBe(true);
  });

  test('corrupt lines in WAL are skipped during recovery', async () => {
    await wal.append(makeProofEntry(0, 1n));
    await wal.close();

    // Inject a corrupt line
    const walFile = path.join(tmpDir, 'wal', 'partition-0.wal');
    fs.appendFileSync(walFile, 'THIS IS CORRUPT JSON\n');

    const wal2 = new FileWalProvider({
      dataDir: tmpDir,
      fsyncOnWrite: false,
    });

    const entries = await wal2.readAfter(0, 0n);
    expect(entries).toHaveLength(1);
    expect(entries[0].sequenceNumber).toBe(1n);

    await wal2.close();
  });

  test('empty partition returns -1n for latest sequence number', () => {
    expect(wal.getLatestSequenceNumber(99)).toBe(-1n);
  });

  test('readAfter returns entries sorted by sequence number', async () => {
    await wal.append(makeProofEntry(0, 3n));
    await wal.append(makeProofEntry(0, 1n));
    await wal.append(makeProofEntry(0, 2n));

    const entries = await wal.readAfter(0, 0n);
    expect(entries).toHaveLength(3);
    expect(entries[0].sequenceNumber).toBe(1n);
    expect(entries[1].sequenceNumber).toBe(2n);
    expect(entries[2].sequenceNumber).toBe(3n);
  });

  test('HMAC secret file is created', async () => {
    await wal.append(makeProofEntry(0, 1n));
    const secretFile = path.join(tmpDir, 'wal', 'wal.secret');
    expect(fs.existsSync(secretFile)).toBe(true);
    expect(fs.readFileSync(secretFile).length).toBe(32);
  });

  test('entries are hash-chained on disk', async () => {
    await wal.append(makeProofEntry(0, 1n));
    await wal.append(makeProofEntry(0, 2n));
    await wal.close();

    const wal2 = new FileWalProvider({ dataDir: tmpDir, fsyncOnWrite: false });
    const entries = await wal2.readAfter(0, 0n);
    expect(entries).toHaveLength(2);
    expect(entries[0].prevIntegrityHash).toBe('0');
    expect(entries[1].prevIntegrityHash).toBe(entries[0].integrityHash);
    await wal2.close();
  });

  test('injected entries are rejected on recovery (HMAC mismatch)', async () => {
    await wal.append(makeProofEntry(0, 1n));
    await wal.append(makeProofEntry(0, 2n));
    await wal.close();

    // Attacker appends a forged entry — they don't have the HMAC secret
    const walFile = path.join(tmpDir, 'wal', 'partition-0.wal');
    const forgedEntry = JSON.stringify({
      entryId: 'forged-entry-id',
      sequenceNumber: '3',
      type: 'proof',
      partitionIndex: 0,
      walletId: 'attacker-wallet',
      stateSnapshot: { registryRoot: 'fake', lifecycleRoot: 'fake', walletCount: '999', auditChainHash: 'fake' },
      integrityHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      prevIntegrityHash: '0',
      timestamp: Date.now(),
      committed: false,
    });
    fs.appendFileSync(walFile, forgedEntry + '\n');

    const wal2 = new FileWalProvider({ dataDir: tmpDir, fsyncOnWrite: false });
    const entries = await wal2.readAfter(0, 0n);

    // Only the 2 legitimate entries survive — the forged entry is rejected
    expect(entries).toHaveLength(2);
    expect(entries.find(e => e.walletId === 'attacker-wallet')).toBeUndefined();
    await wal2.close();
  });

  test('chain break rejects all subsequent injected entries', async () => {
    await wal.append(makeProofEntry(0, 1n));
    await wal.close();

    // Attacker injects TWO entries
    const walFile = path.join(tmpDir, 'wal', 'partition-0.wal');
    for (let i = 2; i <= 3; i++) {
      const forged = JSON.stringify({
        entryId: `forged-${i}`,
        sequenceNumber: String(i),
        type: 'proof',
        partitionIndex: 0,
        walletId: `attacker-${i}`,
        integrityHash: `${'b'.repeat(32)}`,
        prevIntegrityHash: i === 2 ? `${'b'.repeat(32)}` : `${'c'.repeat(32)}`,
        timestamp: Date.now(),
        committed: false,
      });
      fs.appendFileSync(walFile, forged + '\n');
    }

    const wal2 = new FileWalProvider({ dataDir: tmpDir, fsyncOnWrite: false });
    const entries = await wal2.readAfter(0, 0n);

    // Only the 1 legitimate entry survives
    expect(entries).toHaveLength(1);
    expect(entries[0].sequenceNumber).toBe(1n);
    await wal2.close();
  });
});
