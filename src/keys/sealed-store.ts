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
 * A sealed record store — A-136, A-142, A-143.
 *
 * The employer node kept its groups, roster and invites only in memory (A-136), and the plan its redeemed codes,
 * reports, recovery deposits and enrollment registry (A-142), so a restart forgot them. They are kept here instead:
 * records under string keys, in an encrypted snapshot and an append-only encrypted journal, under a key derived from
 * the node's ceremony-made master for this one store (subkeys.ts), which is never written to the node's disk.
 *
 * Each journal entry is AES-256-GCM with the store's name, the journal's generation and the entry's sequence number in
 * its authenticated data, so the files open only with this store's key, only as this store, and only in the order they
 * were written: a changed, dropped, reordered or swapped entry is refused. A write is on disk (fsync) before put()
 * returns. A crash mid-write leaves at most a torn last line, which is dropped on open; a bad line anywhere else is
 * tampering and the store refuses to open. Once the journal is long its records are folded into a new snapshot (a new
 * generation): the snapshot is renamed into place before the journal is restarted, so a crash between the two leaves
 * an older journal whose entries the snapshot already holds, which is set aside.
 *
 * What it cannot tell: a whole older copy of the files put back. The sequence number only grows, and `position()`
 * gives it, for the network to record later (phase E).
 */
import fs from 'fs';
import path from 'path';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const LABEL = 'zpk.care/sealed-store/v1';
const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const DEFAULT_COMPACT_AFTER = 1000;

export class SealedStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SealedStoreError';
  }
}

export interface SealedStoreOptions {
  dir: string;
  /** Names the files, and is bound into every entry. */
  name: string;
  /** This store's 32-byte key (deriveSubkey). */
  key: Uint8Array;
  /** Fold the journal into a new snapshot after this many entries. */
  compactAfter?: number;
  /** Told of a torn last entry dropped on open. */
  onWarning?: (message: string) => void;
}

interface Sealed {
  iv: string;
  ciphertext: string;
  tag: string;
}
interface SnapshotFile extends Sealed {
  v: 1;
  store: string;
  generation: number;
  seq: number;
}
interface JournalHeader {
  v: 1;
  store: string;
  generation: number;
  baseSeq: number;
}
interface JournalEntry extends Sealed {
  seq: number;
}
type Op<V> = { op: 'put'; k: string; v: V } | { op: 'del'; k: string } | { op: 'putMany'; e: Array<[string, V]> };

function isCount(n: unknown): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
}

export class SealedRecordStore<V = unknown> implements Iterable<[string, V]> {
  private readonly records = new Map<string, V>();
  private readonly key: Buffer;
  private readonly name: string;
  private readonly dir: string;
  private readonly snapshotFile: string;
  private readonly journalFile: string;
  private readonly compactAfter: number;
  private readonly onWarning: (message: string) => void;
  private generation = 0;
  private seq = 0;
  private journalEntries = 0;
  private fd: number | null = null;
  private closed = false;
  /** Set when a compaction renamed its snapshot in but could not restart the journal: the store must be opened again. */
  private broken = false;

  private constructor(opts: SealedStoreOptions) {
    if (typeof opts.name !== 'string' || !NAME.test(opts.name)) {
      throw new SealedStoreError('SealedRecordStore: a store name is 1 to 64 lower-case letters, digits, dots, dashes or underscores');
    }
    if (!(opts.key instanceof Uint8Array) || opts.key.length !== 32)
      throw new SealedStoreError(`${opts.name}: the store key must be 32 bytes`);
    this.name = opts.name;
    this.key = Buffer.from(opts.key);
    this.dir = opts.dir;
    this.snapshotFile = path.join(opts.dir, `${opts.name}.snapshot`);
    this.journalFile = path.join(opts.dir, `${opts.name}.journal`);
    this.compactAfter = Math.max(1, opts.compactAfter ?? DEFAULT_COMPACT_AFTER);
    this.onWarning = opts.onWarning ?? ((m) => console.warn(`[sealed-store] ${m}`));
  }

  /** Open (or create) a store, replaying its journal. Throws SealedStoreError for a wrong key or tampered files. */
  static open<V = unknown>(opts: SealedStoreOptions): SealedRecordStore<V> {
    const store = new SealedRecordStore<V>(opts);
    store.load();
    return store;
  }

  get size(): number {
    return this.records.size;
  }
  get(key: string): V | undefined {
    return this.records.get(key);
  }
  has(key: string): boolean {
    return this.records.has(key);
  }
  keys(): IterableIterator<string> {
    return this.records.keys();
  }
  values(): IterableIterator<V> {
    return this.records.values();
  }
  entries(): IterableIterator<[string, V]> {
    return this.records.entries();
  }
  [Symbol.iterator](): IterableIterator<[string, V]> {
    return this.records.entries();
  }

  /** Where the store is: the sequence number grows by one with every write and never goes back. */
  position(): { generation: number; seq: number } {
    return { generation: this.generation, seq: this.seq };
  }

  /**
   * Keep a record. It is on disk before this returns. The store keeps the object it is given, as a Map would, so a
   * caller that changes a record it read must put it back for the change to reach the disk.
   */
  put(key: string, value: V): void {
    checkKey(key);
    this.append({ op: 'put', k: key, v: value });
    this.records.set(key, value);
    this.afterWrite();
  }

  /** put, as a Map's set, so a store can stand where a Map of records stood (the plan's records, A-142). */
  set(key: string, value: V): this {
    this.put(key, value);
    return this;
  }

  /** Keep several records in one journal entry. */
  putMany(entries: Array<[string, V]>): void {
    if (!Array.isArray(entries) || entries.length === 0) return;
    for (const [k] of entries) checkKey(k);
    this.append({ op: 'putMany', e: entries });
    for (const [k, v] of entries) this.records.set(k, v);
    this.afterWrite();
  }

  delete(key: string): boolean {
    checkKey(key);
    if (!this.records.has(key)) return false;
    this.append({ op: 'del', k: key });
    this.records.delete(key);
    this.afterWrite();
    return true;
  }

  /** Fold every record into a new snapshot and start an empty journal. */
  compact(): void {
    this.ensureOpen();
    const generation = this.generation + 1;
    const plain = Buffer.from(JSON.stringify([...this.records]), 'utf8');
    const sealed = this.encrypt('snapshot', generation, this.seq, plain);
    plain.fill(0);
    const snapshot: SnapshotFile = { v: 1, store: this.name, generation, seq: this.seq, ...sealed };
    this.closeJournal();
    try {
      this.writeAtomic(this.snapshotFile, JSON.stringify(snapshot));
    } catch (err) {
      this.openJournal();
      throw err;
    }
    this.generation = generation;
    try {
      this.startJournal();
    } catch (err) {
      // the new snapshot holds every record; until the journal is restarted no entry can be written under it
      this.broken = true;
      throw err;
    }
  }

  close(): void {
    this.closeJournal();
    this.closed = true;
    this.key.fill(0);
    this.records.clear();
  }

  // ─── Inside ──────────────────────────────────────────────────────────────

  private load(): void {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    if (fs.existsSync(this.snapshotFile)) this.loadSnapshot();
    if (!fs.existsSync(this.journalFile)) {
      this.startJournal();
      return;
    }
    const raw = fs.readFileSync(this.journalFile, 'utf8');
    const parts = raw.split('\n');
    const complete = parts.slice(0, -1);
    const torn = raw.endsWith('\n') ? '' : parts[parts.length - 1];
    if (complete.length === 0) throw new SealedStoreError(`${this.name}: the journal has no header`);
    let header: JournalHeader;
    try {
      header = JSON.parse(complete[0]) as JournalHeader;
    } catch {
      throw new SealedStoreError(`${this.name}: the journal header is not readable`);
    }
    if (header?.v !== 1 || header.store !== this.name || !isCount(header.generation) || !isCount(header.baseSeq)) {
      throw new SealedStoreError(`${this.name}: the journal is not this store's`);
    }
    if (header.generation < this.generation) {
      // the snapshot was written and the journal not yet restarted: every entry of this one is in the snapshot
      this.startJournal();
      return;
    }
    if (header.generation > this.generation) throw new SealedStoreError(`${this.name}: the journal is newer than the snapshot`);
    if (header.baseSeq !== this.seq) throw new SealedStoreError(`${this.name}: the journal does not follow the snapshot`);
    for (let i = 1; i < complete.length; i++) {
      let entry: JournalEntry;
      try {
        entry = JSON.parse(complete[i]) as JournalEntry;
      } catch {
        throw new SealedStoreError(`${this.name}: journal entry ${i} is not readable`);
      }
      if (entry?.seq !== this.seq + 1) throw new SealedStoreError(`${this.name}: journal entry ${i} is out of order`);
      const plain = this.decrypt('journal', this.generation, entry.seq, entry, `journal entry ${i}`);
      let op: Op<V>;
      try {
        op = JSON.parse(plain.toString('utf8')) as Op<V>;
      } catch {
        throw new SealedStoreError(`${this.name}: journal entry ${i} is not readable`);
      } finally {
        plain.fill(0);
      }
      this.apply(op, i);
      this.seq = entry.seq;
      this.journalEntries++;
    }
    if (torn.length > 0) {
      fs.truncateSync(this.journalFile, Buffer.byteLength(raw, 'utf8') - Buffer.byteLength(torn, 'utf8'));
      this.onWarning(`${this.name}: dropped a torn last journal entry (a write cut short by a crash)`);
    }
    this.openJournal();
    if (this.journalEntries >= this.compactAfter) this.compact();
  }

  private loadSnapshot(): void {
    let snapshot: SnapshotFile;
    try {
      snapshot = JSON.parse(fs.readFileSync(this.snapshotFile, 'utf8')) as SnapshotFile;
    } catch {
      throw new SealedStoreError(`${this.name}: the snapshot is not readable`);
    }
    if (
      snapshot?.v !== 1 ||
      snapshot.store !== this.name ||
      !isCount(snapshot.generation) ||
      snapshot.generation < 1 ||
      !isCount(snapshot.seq)
    ) {
      throw new SealedStoreError(`${this.name}: the snapshot is not this store's`);
    }
    const plain = this.decrypt('snapshot', snapshot.generation, snapshot.seq, snapshot, 'the snapshot');
    let entries: Array<[string, V]>;
    try {
      entries = JSON.parse(plain.toString('utf8')) as Array<[string, V]>;
    } catch {
      throw new SealedStoreError(`${this.name}: the snapshot is not readable`);
    } finally {
      plain.fill(0);
    }
    if (!Array.isArray(entries)) throw new SealedStoreError(`${this.name}: the snapshot is not readable`);
    for (const [k, v] of entries) this.records.set(k, v);
    this.generation = snapshot.generation;
    this.seq = snapshot.seq;
  }

  private apply(op: Op<V>, line: number): void {
    if (op?.op === 'put' && typeof op.k === 'string') this.records.set(op.k, op.v);
    else if (op?.op === 'del' && typeof op.k === 'string') this.records.delete(op.k);
    else if (op?.op === 'putMany' && Array.isArray(op.e)) for (const [k, v] of op.e) this.records.set(k, v);
    else throw new SealedStoreError(`${this.name}: journal entry ${line} is not an operation`);
  }

  /** Write one journal entry, durably. */
  private append(op: Op<V>): void {
    this.ensureOpen();
    const seq = this.seq + 1;
    const json = JSON.stringify(op);
    const plain = Buffer.from(json, 'utf8');
    const sealed = this.encrypt('journal', this.generation, seq, plain);
    plain.fill(0);
    const line = JSON.stringify({ seq, ...sealed } satisfies JournalEntry) + '\n';
    fs.writeSync(this.fd!, line);
    fs.fsyncSync(this.fd!);
    this.seq = seq;
    this.journalEntries++;
  }

  /** The write that triggered a compaction is on disk already: a compaction that fails is reported, not thrown. */
  private afterWrite(): void {
    if (this.journalEntries < this.compactAfter) return;
    try {
      this.compact();
    } catch (err) {
      this.onWarning(`${this.name}: could not fold the journal into a new snapshot: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private aad(kind: 'snapshot' | 'journal', generation: number, seq: number): Buffer {
    return Buffer.from(`${LABEL}\n${this.name}\n${kind}\n${generation}\n${seq}`, 'utf8');
  }

  private encrypt(kind: 'snapshot' | 'journal', generation: number, seq: number, plain: Buffer): Sealed {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(this.aad(kind, generation, seq));
    const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
    return { iv: iv.toString('hex'), ciphertext: ciphertext.toString('base64'), tag: cipher.getAuthTag().toString('hex') };
  }

  private decrypt(kind: 'snapshot' | 'journal', generation: number, seq: number, sealed: Sealed, what: string): Buffer {
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(String(sealed.iv), 'hex'));
      decipher.setAAD(this.aad(kind, generation, seq));
      decipher.setAuthTag(Buffer.from(String(sealed.tag), 'hex'));
      return Buffer.concat([decipher.update(Buffer.from(String(sealed.ciphertext), 'base64')), decipher.final()]);
    } catch {
      throw new SealedStoreError(`${this.name}: ${what} could not be opened (another key, or changed)`);
    }
  }

  private startJournal(): void {
    this.closeJournal();
    const header: JournalHeader = { v: 1, store: this.name, generation: this.generation, baseSeq: this.seq };
    this.writeAtomic(this.journalFile, JSON.stringify(header) + '\n');
    this.journalEntries = 0;
    this.openJournal();
  }

  private openJournal(): void {
    if (this.fd === null) this.fd = fs.openSync(this.journalFile, 'a', 0o600);
  }

  private closeJournal(): void {
    if (this.fd !== null) {
      fs.closeSync(this.fd);
      this.fd = null;
    }
  }

  private ensureOpen(): void {
    if (this.closed) throw new SealedStoreError(`${this.name}: the store is closed`);
    if (this.broken)
      throw new SealedStoreError(`${this.name}: the journal could not be restarted after a compaction; open the store again`);
  }

  private writeAtomic(file: string, content: string): void {
    const tmp = `${file}.tmp-${process.pid}`;
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeSync(fd, content);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.renameSync(tmp, file);
    } catch (err) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* left for the next write to replace */
      }
      throw err;
    }
    if (process.platform !== 'win32') {
      // the rename is durable once the directory is
      try {
        const dirFd = fs.openSync(this.dir, 'r');
        try {
          fs.fsyncSync(dirFd);
        } finally {
          fs.closeSync(dirFd);
        }
      } catch {
        /* a filesystem that cannot sync a directory */
      }
    }
  }
}

function checkKey(key: string): void {
  if (typeof key !== 'string' || key.length === 0 || key.length > 512)
    throw new SealedStoreError('SealedRecordStore: a record key is 1 to 512 characters');
}
