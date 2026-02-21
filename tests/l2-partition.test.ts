/**
 * L2 Partition — Multi-Sequencer Wallet Partitioning Tests
 *
 * Tests partition assignment, routing, and sequencer integration.
 *
 * Run: npx jest tests/l2-partition.test.ts --verbose
 */
import { Field, Poseidon } from 'o1js';
import {
  getPartition,
  isMyPartition,
  PartitionRouter,
} from '../src/l2/l2-partition.js';
import type { PartitionConfig } from '../src/l2/l2-partition.js';
import { L2SequencerService } from '../src/l2/l2-sequencer-service.js';
import { InMemoryStore } from '../src/storage/local-store.js';

// ─── Partition Assignment ─────────────────────────────────────

describe('getPartition', () => {
  test('returns 0 for single partition', () => {
    expect(getPartition('12345', 1)).toBe(0);
    expect(getPartition('99999999999999', 1)).toBe(0);
  });

  test('partitions deterministically with 2 partitions', () => {
    // Even bigint → partition 0, odd → partition 1
    const even = BigInt(100);
    const odd = BigInt(101);
    expect(getPartition(even.toString(), 2)).toBe(0);
    expect(getPartition(odd.toString(), 2)).toBe(1);
  });

  test('distributes across N partitions', () => {
    const results = new Set<number>();
    // Use sequential bigints — should cover multiple partitions
    for (let i = 0; i < 10; i++) {
      results.add(getPartition(String(i), 4));
    }
    // With values 0-9 mod 4, we get {0, 1, 2, 3}
    expect(results.size).toBe(4);
  });

  test('Poseidon hash walletIds distribute uniformly', () => {
    const partitionCount = 4;
    const counts = [0, 0, 0, 0];

    // Generate 100 random walletIds via Poseidon
    for (let i = 0; i < 100; i++) {
      const walletId = Poseidon.hash([Field(i)]).toString();
      const partition = getPartition(walletId, partitionCount);
      counts[partition]++;
    }

    // Each partition should get ~25 (allow generous range)
    for (const count of counts) {
      expect(count).toBeGreaterThan(10);
      expect(count).toBeLessThan(45);
    }
  });

  test('same walletId always maps to same partition', () => {
    const walletId = Poseidon.hash([Field(42), Field(99)]).toString();
    const first = getPartition(walletId, 8);
    for (let i = 0; i < 10; i++) {
      expect(getPartition(walletId, 8)).toBe(first);
    }
  });

  test('throws for zero or negative partition count', () => {
    expect(() => getPartition('123', 0)).toThrow('partitionCount must be positive');
    expect(() => getPartition('123', -1)).toThrow('partitionCount must be positive');
  });
});

// ─── isMyPartition ────────────────────────────────────────────

describe('isMyPartition', () => {
  test('returns true when walletId belongs to this partition', () => {
    const config: PartitionConfig = { partitionCount: 4, partitionIndex: 2 };
    // walletId "2" → 2 % 4 = 2 → partition 2
    expect(isMyPartition('2', config)).toBe(true);
    // walletId "6" → 6 % 4 = 2 → partition 2
    expect(isMyPartition('6', config)).toBe(true);
  });

  test('returns false when walletId belongs to different partition', () => {
    const config: PartitionConfig = { partitionCount: 4, partitionIndex: 0 };
    // walletId "1" → 1 % 4 = 1 → partition 1 (not 0)
    expect(isMyPartition('1', config)).toBe(false);
    expect(isMyPartition('3', config)).toBe(false);
  });

  test('single partition always returns true', () => {
    const config: PartitionConfig = { partitionCount: 1, partitionIndex: 0 };
    expect(isMyPartition('0', config)).toBe(true);
    expect(isMyPartition('999999', config)).toBe(true);
  });
});

// ─── PartitionRouter ──────────────────────────────────────────

describe('PartitionRouter', () => {
  test('constructor validates partition count', () => {
    expect(() => new PartitionRouter(0)).toThrow('partitionCount must be positive');
    expect(() => new PartitionRouter(-1)).toThrow('partitionCount must be positive');
    const router = new PartitionRouter(4);
    expect(router.getPartitionCount()).toBe(4);
  });

  test('setPartition registers a URL', () => {
    const router = new PartitionRouter(2);
    router.setPartition(0, 'http://seq0:3030');
    router.setPartition(1, 'http://seq1:3030');

    expect(router.getUrlForPartition(0)).toBe('http://seq0:3030');
    expect(router.getUrlForPartition(1)).toBe('http://seq1:3030');
    expect(router.getUrlForPartition(2)).toBeUndefined();
  });

  test('setPartition rejects out-of-range index', () => {
    const router = new PartitionRouter(3);
    expect(() => router.setPartition(3, 'http://seq3:3030'))
      .toThrow('partitionIndex 3 out of range [0, 3)');
    expect(() => router.setPartition(-1, 'http://neg:3030'))
      .toThrow('partitionIndex -1 out of range [0, 3)');
  });

  test('getSequencerUrl routes walletId to correct partition URL', () => {
    const router = new PartitionRouter(3);
    router.setPartition(0, 'http://seq0:3030');
    router.setPartition(1, 'http://seq1:3030');
    router.setPartition(2, 'http://seq2:3030');

    // walletId "0" → 0 % 3 = 0
    expect(router.getSequencerUrl('0')).toBe('http://seq0:3030');
    // walletId "1" → 1 % 3 = 1
    expect(router.getSequencerUrl('1')).toBe('http://seq1:3030');
    // walletId "2" → 2 % 3 = 2
    expect(router.getSequencerUrl('2')).toBe('http://seq2:3030');
    // walletId "3" → 3 % 3 = 0
    expect(router.getSequencerUrl('3')).toBe('http://seq0:3030');
  });

  test('getSequencerUrl returns undefined for unregistered partition', () => {
    const router = new PartitionRouter(3);
    router.setPartition(0, 'http://seq0:3030');
    // Partition 1 and 2 not registered
    expect(router.getSequencerUrl('1')).toBeUndefined();
  });

  test('getAllPartitions returns sorted list', () => {
    const router = new PartitionRouter(3);
    router.setPartition(2, 'http://seq2:3030');
    router.setPartition(0, 'http://seq0:3030');
    router.setPartition(1, 'http://seq1:3030');

    const all = router.getAllPartitions();
    expect(all).toEqual([
      { partitionIndex: 0, url: 'http://seq0:3030' },
      { partitionIndex: 1, url: 'http://seq1:3030' },
      { partitionIndex: 2, url: 'http://seq2:3030' },
    ]);
  });

  test('isComplete returns true when all partitions registered', () => {
    const router = new PartitionRouter(2);
    expect(router.isComplete()).toBe(false);
    router.setPartition(0, 'http://seq0:3030');
    expect(router.isComplete()).toBe(false);
    router.setPartition(1, 'http://seq1:3030');
    expect(router.isComplete()).toBe(true);
  });
});

// ─── L2SequencerService Partition Integration ─────────────────

describe('L2SequencerService — Partition Config', () => {
  test('getPartitionConfig returns null by default', () => {
    const store = new InMemoryStore();
    const service = new L2SequencerService(store, Field(0), Field(0), Field(0));
    expect(service.getPartitionConfig()).toBeNull();
  });

  test('setPartitionConfig stores config', () => {
    const store = new InMemoryStore();
    const service = new L2SequencerService(store, Field(0), Field(0), Field(0));
    service.setPartitionConfig({ partitionCount: 4, partitionIndex: 1 });

    const config = service.getPartitionConfig();
    expect(config).toEqual({ partitionCount: 4, partitionIndex: 1 });
  });

  test('getPartitionConfig returns a copy (not a reference)', () => {
    const store = new InMemoryStore();
    const service = new L2SequencerService(store, Field(0), Field(0), Field(0));
    service.setPartitionConfig({ partitionCount: 4, partitionIndex: 1 });

    const config1 = service.getPartitionConfig();
    const config2 = service.getPartitionConfig();
    expect(config1).toEqual(config2);
    expect(config1).not.toBe(config2);
  });
});
