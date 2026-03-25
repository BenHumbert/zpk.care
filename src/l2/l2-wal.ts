/**
 * L2 Write-Ahead Log (WAL) — Crash-safe proof durability.
 *
 * Per-partition append-only NDJSON log that is fsync'd before returning.
 * Every proof acceptance and batch operation writes a WAL entry BEFORE
 * applying in-memory mutations. On crash recovery, uncommitted entries
 * are replayed from the log to restore state.
 *
 * Two implementations:
 *   - FileWALProvider: Production. NDJSON append + fsync.
 *   - InMemoryWALProvider: Testing. No disk I/O.
 *
 * WAL file per partition: {dataDir}/wal/partition-{index}.wal
 * Each line is a JSON-serialized WalEntry using l2Stringify for BigInt support.
 *
 * Zero external dependencies — Node.js fs + crypto only.
 */

import { createHash } from 'crypto';
import { l2Stringify, l2Parse } from './l2-json.js';

// ─── WAL Entry Types ─────────────────────────────────────

/** Type of WAL entry */
export type WalEntryType =
  | 'proof'          // Proof accepted — all pre-computed state change data
  | 'batch_begin'    // Batch build started — pending pool drained
  | 'batch_commit'   // Batch build completed — all mutations applied
  | 'batch_abort'    // Batch build failed — pending pool restored
  | 'settle'         // Batch settlement confirmed
  | 'fail'           // Batch settlement failed
  | 'plan_store'     // Plan created or updated
  | 'plan_delete';   // Plan deleted

/**
 * WalEntry — one line in the append-only proof log.
 *
 * Serialized as NDJSON (one JSON line per entry).
 * Contains everything needed to replay a state mutation.
 */
export interface WalEntry {
  /** Unique entry identifier (SHA-256 hash) */
  entryId: string;
  /** Monotonic sequence number within this partition's WAL */
  sequenceNumber: bigint;
  /** Entry type */
  type: WalEntryType;
  /** Partition index this entry belongs to */
  partitionIndex: number;
  /** Wallet ID targeted by this proof (proof entries only) */
  walletId?: string;
  /** Serialized proof data (proof entries only) */
  proofJson?: string;
  /** Pre-computed receipt (proof entries only) */
  receiptData?: Record<string, unknown>;
  /** Pre-computed audit event (proof entries only) */
  auditEventData?: Record<string, unknown>;
  /** Optional claim leaf data (proof entries with ClaimSubmissionMetadata) */
  claimEntryData?: Record<string, unknown>;
  /** Plan config data (plan_store/plan_delete entries only) */
  planData?: Record<string, unknown>;
  /** Batch metadata (batch entries only) */
  batchData?: Record<string, unknown>;
  /** State roots at time of entry */
  stateSnapshot?: {
    registryRoot: string;
    lifecycleRoot: string;
    walletCount: string;
    auditChainHash: string;
  };
  /** SHA-256 integrity hash of critical fields */
  integrityHash: string;
  /** Unix timestamp (ms) when entry was written */
  timestamp: number;
  /** Whether mutations have been applied (commit marker) */
  committed: boolean;
  /** Node ID of the leader that created this entry */
  originNodeId?: string;
}

// ─── WAL Configuration ───────────────────────────────────

export interface WalConfig {
  /** Directory for WAL files */
  dataDir: string;
  /** Whether to fsync after each write. Default true. */
  fsyncOnWrite: boolean;
}

export const DEFAULT_WAL_CONFIG: Omit<WalConfig, 'dataDir'> = {
  fsyncOnWrite: true,
};

// ─── WAL Provider Interface ─────────────────────────────

/**
 * IWalProvider — abstraction for WAL storage.
 *
 * Allows file-based (production) and in-memory (testing) implementations.
 */
export interface IWalProvider {
  /** Append an entry. Returns the entryId. */
  append(entry: Omit<WalEntry, 'entryId' | 'committed' | 'integrityHash'>): Promise<string>;

  /** Mark an entry as committed (mutations applied). */
  commit(entryId: string): Promise<void>;

  /** Read all uncommitted entries for crash recovery, ordered by sequence number. */
  getUncommitted(partitionIndex: number): Promise<WalEntry[]>;

  /** Read all entries for a partition after a given sequence number. */
  readAfter(partitionIndex: number, afterSequenceNumber: bigint): Promise<WalEntry[]>;

  /** Get the highest sequence number written for a partition (-1n if empty). */
  getLatestSequenceNumber(partitionIndex: number): bigint;

  /** Truncate entries at or before the given sequence number (compaction after checkpoint). */
  truncateBefore(partitionIndex: number, beforeSequenceNumber: bigint): Promise<void>;

  /** Close file handles. */
  close(): Promise<void>;
}

// ─── Integrity Hash ──────────────────────────────────────

/**
 * Compute the integrity hash for a WAL entry.
 * SHA-256 of the critical fields (type, partition, sequence, walletId, state snapshot).
 */
export function computeWalIntegrityHash(entry: {
  type: WalEntryType;
  partitionIndex: number;
  sequenceNumber: bigint;
  walletId?: string;
  stateSnapshot?: { registryRoot: string; lifecycleRoot: string; walletCount: string; auditChainHash: string };
  timestamp: number;
  proofJson?: string;
  receiptData?: unknown;
  claimEntryData?: unknown;
}): string {
  const content = [
    entry.type,
    String(entry.partitionIndex),
    entry.sequenceNumber.toString(),
    entry.walletId ?? '',
    entry.stateSnapshot?.registryRoot ?? '',
    entry.stateSnapshot?.lifecycleRoot ?? '',
    entry.stateSnapshot?.walletCount ?? '',
    entry.stateSnapshot?.auditChainHash ?? '',
    String(entry.timestamp),
  ].join('|');
  const hash = createHash('sha256').update(content);
  // Include proof payload in integrity hash for tamper detection on recovery
  if (entry.proofJson) hash.update('|p:').update(entry.proofJson);
  if (entry.receiptData) hash.update('|r:').update(JSON.stringify(entry.receiptData));
  if (entry.claimEntryData) hash.update('|c:').update(JSON.stringify(entry.claimEntryData));
  return hash.digest('hex').slice(0, 32);
}

/**
 * Generate a unique entry ID.
 * SHA-256 of type + partition + sequence + timestamp.
 */
function generateEntryId(entry: {
  type: WalEntryType;
  partitionIndex: number;
  sequenceNumber: bigint;
  timestamp: number;
}): string {
  const content = `${entry.type}:${entry.partitionIndex}:${entry.sequenceNumber}:${entry.timestamp}`;
  return createHash('sha256').update(content).digest('hex').slice(0, 32);
}

// ─── In-Memory WAL Provider ─────────────────────────────

/**
 * InMemoryWalProvider — WAL backed by in-memory arrays.
 *
 * For testing only. No disk I/O, no fsync.
 */
export class InMemoryWalProvider implements IWalProvider {
  /** Map of partitionIndex → WalEntry[] */
  private entries: Map<number, WalEntry[]> = new Map();
  /** Map of entryId → WalEntry reference for fast commit lookup */
  private entryIndex: Map<string, WalEntry> = new Map();
  /** Map of partitionIndex → latest sequence number */
  private latestSeqNums: Map<number, bigint> = new Map();

  async append(
    entry: Omit<WalEntry, 'entryId' | 'committed' | 'integrityHash'>,
  ): Promise<string> {
    const entryId = generateEntryId(entry);
    const integrityHash = computeWalIntegrityHash(entry);

    const fullEntry: WalEntry = {
      ...entry,
      entryId,
      integrityHash,
      committed: false,
    };

    let partitionEntries = this.entries.get(entry.partitionIndex);
    if (!partitionEntries) {
      partitionEntries = [];
      this.entries.set(entry.partitionIndex, partitionEntries);
    }
    partitionEntries.push(fullEntry);
    this.entryIndex.set(entryId, fullEntry);

    const currentLatest = this.latestSeqNums.get(entry.partitionIndex) ?? -1n;
    if (entry.sequenceNumber > currentLatest) {
      this.latestSeqNums.set(entry.partitionIndex, entry.sequenceNumber);
    }

    return entryId;
  }

  async commit(entryId: string): Promise<void> {
    const entry = this.entryIndex.get(entryId);
    if (entry) {
      entry.committed = true;
    }
  }

  async getUncommitted(partitionIndex: number): Promise<WalEntry[]> {
    const partitionEntries = this.entries.get(partitionIndex) ?? [];
    return partitionEntries
      .filter((e) => !e.committed)
      .sort((a, b) => {
        if (a.sequenceNumber < b.sequenceNumber) return -1;
        if (a.sequenceNumber > b.sequenceNumber) return 1;
        return 0;
      });
  }

  async readAfter(partitionIndex: number, afterSequenceNumber: bigint): Promise<WalEntry[]> {
    const partitionEntries = this.entries.get(partitionIndex) ?? [];
    return partitionEntries
      .filter((e) => e.sequenceNumber > afterSequenceNumber)
      .sort((a, b) => {
        if (a.sequenceNumber < b.sequenceNumber) return -1;
        if (a.sequenceNumber > b.sequenceNumber) return 1;
        return 0;
      });
  }

  getLatestSequenceNumber(partitionIndex: number): bigint {
    return this.latestSeqNums.get(partitionIndex) ?? -1n;
  }

  async truncateBefore(partitionIndex: number, beforeSequenceNumber: bigint): Promise<void> {
    const partitionEntries = this.entries.get(partitionIndex);
    if (!partitionEntries) return;

    const kept = partitionEntries.filter((e) => e.sequenceNumber > beforeSequenceNumber);
    const removed = partitionEntries.filter((e) => e.sequenceNumber <= beforeSequenceNumber);

    // Clean up entry index
    for (const entry of removed) {
      this.entryIndex.delete(entry.entryId);
    }

    this.entries.set(partitionIndex, kept);
  }

  async close(): Promise<void> {
    // No-op for in-memory
  }

  /** Test helper: get all entries for a partition */
  getAllEntries(partitionIndex: number): WalEntry[] {
    return [...(this.entries.get(partitionIndex) ?? [])];
  }

  /** Test helper: get entry count across all partitions */
  getTotalEntryCount(): number {
    let total = 0;
    for (const entries of this.entries.values()) {
      total += entries.length;
    }
    return total;
  }

  /** Test helper: clear all entries */
  clear(): void {
    this.entries.clear();
    this.entryIndex.clear();
    this.latestSeqNums.clear();
  }
}

// ─── File WAL Provider ──────────────────────────────────

/**
 * FileWalProvider — WAL backed by append-only NDJSON files.
 *
 * Production implementation. Each partition gets its own WAL file.
 * Each append() writes one JSON line + fsync.
 * Commit markers are inline: the entry's `committed` field is set
 * by appending a commit line `{"commit":"entryId"}`.
 *
 * On startup, the file is read line-by-line to rebuild the in-memory
 * index. Partial/corrupt lines (from crash mid-write) are skipped.
 */
export class FileWalProvider implements IWalProvider {
  private config: WalConfig;
  /** In-memory copy of all entries (rebuilt from file on init) */
  private entries: Map<number, WalEntry[]> = new Map();
  private entryIndex: Map<string, WalEntry> = new Map();
  private latestSeqNums: Map<number, bigint> = new Map();
  /** Whether the provider has been initialized */
  private initialized: Map<number, boolean> = new Map();

  constructor(config: WalConfig) {
    this.config = config;
  }

  /** Lazily initialize a partition's WAL from disk */
  private async ensureInitialized(partitionIndex: number): Promise<void> {
    if (this.initialized.get(partitionIndex)) return;

    // Dynamic import for fs (ESM compatible)
    const fs = await import('fs');
    const path = await import('path');

    const walDir = path.join(this.config.dataDir, 'wal');
    const walFile = path.join(walDir, `partition-${partitionIndex}.wal`);

    // Ensure directory exists
    fs.mkdirSync(walDir, { recursive: true });

    // Read existing WAL file if it exists
    if (fs.existsSync(walFile)) {
      const content = fs.readFileSync(walFile, 'utf-8');
      const lines = content.split('\n').filter((l) => l.trim().length > 0);

      const partitionEntries: WalEntry[] = [];
      const commitSet = new Set<string>();

      // First pass: find all commit markers
      for (const line of lines) {
        try {
          const parsed = l2Parse<Record<string, unknown>>(line);
          if (parsed.commit && typeof parsed.commit === 'string') {
            commitSet.add(parsed.commit);
          }
        } catch {
          // Skip corrupt lines (crash mid-write)
        }
      }

      // Second pass: load entries, apply commit markers
      for (const line of lines) {
        try {
          const parsed = l2Parse<Record<string, unknown>>(line);
          if (parsed.commit) continue; // Skip commit markers
          if (!parsed.entryId || !parsed.type) continue; // Skip invalid entries

          const entry = parsed as unknown as WalEntry;

          // Verify integrity hash — skip tampered/corrupt entries
          if (entry.integrityHash) {
            const recomputed = computeWalIntegrityHash(entry);
            if (entry.integrityHash !== recomputed) {
              console.warn(`[WAL] Corrupt entry ${entry.entryId} in partition ${partitionIndex} (hash mismatch), skipping`);
              continue;
            }
          }

          if (commitSet.has(entry.entryId)) {
            entry.committed = true;
          }
          partitionEntries.push(entry);
          this.entryIndex.set(entry.entryId, entry);

          const currentLatest = this.latestSeqNums.get(partitionIndex) ?? -1n;
          if (entry.sequenceNumber > currentLatest) {
            this.latestSeqNums.set(partitionIndex, entry.sequenceNumber);
          }
        } catch {
          // Skip corrupt lines
        }
      }

      this.entries.set(partitionIndex, partitionEntries);
    } else {
      this.entries.set(partitionIndex, []);
    }

    this.initialized.set(partitionIndex, true);
  }

  /** Write a line to the WAL file + optional fsync */
  private async writeLine(partitionIndex: number, line: string): Promise<void> {
    const fs = await import('fs');
    const path = await import('path');

    const walDir = path.join(this.config.dataDir, 'wal');
    const walFile = path.join(walDir, `partition-${partitionIndex}.wal`);

    fs.mkdirSync(walDir, { recursive: true });

    // Append line
    const fd = fs.openSync(walFile, 'a', 0o600);
    try {
      fs.writeSync(fd, line + '\n');
      if (this.config.fsyncOnWrite) {
        fs.fsyncSync(fd);
      }
    } finally {
      fs.closeSync(fd);
    }
  }

  async append(
    entry: Omit<WalEntry, 'entryId' | 'committed' | 'integrityHash'>,
  ): Promise<string> {
    await this.ensureInitialized(entry.partitionIndex);

    const entryId = generateEntryId(entry);
    const integrityHash = computeWalIntegrityHash(entry);

    const fullEntry: WalEntry = {
      ...entry,
      entryId,
      integrityHash,
      committed: false,
    };

    // Write to disk first (WAL contract: durable before in-memory)
    await this.writeLine(entry.partitionIndex, l2Stringify(fullEntry));

    // Then update in-memory index
    let partitionEntries = this.entries.get(entry.partitionIndex);
    if (!partitionEntries) {
      partitionEntries = [];
      this.entries.set(entry.partitionIndex, partitionEntries);
    }
    partitionEntries.push(fullEntry);
    this.entryIndex.set(entryId, fullEntry);

    const currentLatest = this.latestSeqNums.get(entry.partitionIndex) ?? -1n;
    if (entry.sequenceNumber > currentLatest) {
      this.latestSeqNums.set(entry.partitionIndex, entry.sequenceNumber);
    }

    return entryId;
  }

  async commit(entryId: string): Promise<void> {
    const entry = this.entryIndex.get(entryId);
    if (!entry) return;

    // Write commit marker to disk
    await this.writeLine(entry.partitionIndex, l2Stringify({ commit: entryId }));

    // Update in-memory
    entry.committed = true;
  }

  async getUncommitted(partitionIndex: number): Promise<WalEntry[]> {
    await this.ensureInitialized(partitionIndex);
    const partitionEntries = this.entries.get(partitionIndex) ?? [];
    return partitionEntries
      .filter((e) => !e.committed)
      .sort((a, b) => {
        if (a.sequenceNumber < b.sequenceNumber) return -1;
        if (a.sequenceNumber > b.sequenceNumber) return 1;
        return 0;
      });
  }

  async readAfter(partitionIndex: number, afterSequenceNumber: bigint): Promise<WalEntry[]> {
    await this.ensureInitialized(partitionIndex);
    const partitionEntries = this.entries.get(partitionIndex) ?? [];
    return partitionEntries
      .filter((e) => e.sequenceNumber > afterSequenceNumber)
      .sort((a, b) => {
        if (a.sequenceNumber < b.sequenceNumber) return -1;
        if (a.sequenceNumber > b.sequenceNumber) return 1;
        return 0;
      });
  }

  getLatestSequenceNumber(partitionIndex: number): bigint {
    return this.latestSeqNums.get(partitionIndex) ?? -1n;
  }

  async truncateBefore(partitionIndex: number, beforeSequenceNumber: bigint): Promise<void> {
    await this.ensureInitialized(partitionIndex);

    const partitionEntries = this.entries.get(partitionIndex) ?? [];
    const kept = partitionEntries.filter((e) => e.sequenceNumber > beforeSequenceNumber);
    const removed = partitionEntries.filter((e) => e.sequenceNumber <= beforeSequenceNumber);

    // Clean up entry index
    for (const entry of removed) {
      this.entryIndex.delete(entry.entryId);
    }
    this.entries.set(partitionIndex, kept);

    // Rewrite the WAL file with only kept entries + their commit markers
    const fs = await import('fs');
    const path = await import('path');

    const walDir = path.join(this.config.dataDir, 'wal');
    const walFile = path.join(walDir, `partition-${partitionIndex}.wal`);
    const tmpFile = walFile + '.tmp';

    const lines: string[] = [];
    for (const entry of kept) {
      lines.push(l2Stringify(entry));
      if (entry.committed) {
        lines.push(l2Stringify({ commit: entry.entryId }));
      }
    }

    // Atomic write: temp file + fsync + rename
    const content = lines.length > 0 ? lines.join('\n') + '\n' : '';
    const fd = fs.openSync(tmpFile, 'w', 0o600);
    try {
      fs.writeSync(fd, content);
      if (this.config.fsyncOnWrite) {
        fs.fsyncSync(fd);
      }
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpFile, walFile);
  }

  async close(): Promise<void> {
    // File handles are opened/closed per operation, nothing to clean up
    this.entries.clear();
    this.entryIndex.clear();
    this.latestSeqNums.clear();
    this.initialized.clear();
  }
}
