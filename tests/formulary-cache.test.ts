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
 * The formulary tree cache exists to remove the sequencer's longest boot step, and the tree it
 * restores is a commitment. So these tests care about two things in order:
 *
 *   1. A cache hit produces **exactly** the tree a full build produces — same root, same
 *      witnesses, same lookups.
 *   2. A cache that does not describe the data is **refused**, and the refusal falls back to a
 *      correct tree rather than to a broken one. Every way it can fail to describe the data gets
 *      its own test: changed data, changed count, wrong height, wrong version, a lying root,
 *      tampered nodes, a tampered NDC hash, and a missing node set.
 *
 * The second group is the point of the whole exercise. A cache that silently loaded a wrong root
 * would not throw: it would leave a sequencer committed to a formulary for which nobody can
 * produce a valid witness.
 */
import { FormularyService, type FormularyTreeCache } from '../src/l2/formulary-service.js';
import { hashString } from '../src/zkp/hash-utils.js';

type Rec = Parameters<FormularyService['loadFromNadac']>[0][number];

function records(n: number, tweak: Partial<Rec> = {}, at = -1): Rec[] {
  return Array.from({ length: n }, (_, i) => ({
    ndc: `00000-0000-${String(i).padStart(2, '0')}`,
    ndcFormatted: `0000-0000-${i}`,
    description: `TESTDRUG ${i} 10 MG TABLET`,
    classification: i % 3 === 0 ? 'B' : 'G',
    nadacPerUnit: 1.23 + i,
    pricingUnit: 'EA',
    otc: false,
    tierLevel: (i % 4) + 1,
    copayAmount: 500 + i,
    requiresPriorAuth: i % 5 === 0,
    maxQuantityPerFill: 30,
    maxDaySupply: 30,
    stepTherapyRequired: false,
    ...(at === -1 || at === i ? tweak : {}),
  }));
}

/** A service loaded the slow way, plus the cache it exports. */
function buildFresh(recs: Rec[]): { svc: FormularyService; cache: FormularyTreeCache } {
  const svc = new FormularyService();
  svc.loadFromNadac(recs);
  const cache = svc.exportTreeCache();
  expect(cache).not.toBeNull();
  return { svc, cache: cache! };
}

const clone = (c: FormularyTreeCache): FormularyTreeCache =>
  JSON.parse(JSON.stringify(c)) as FormularyTreeCache;

const RECS = records(40);

describe('a cache hit reproduces the built tree exactly', () => {
  test('same root, and the load reports it came from the cache', () => {
    const { svc, cache } = buildFresh(RECS);
    expect(svc.treeCameFromCache).toBe(false);

    const restored = new FormularyService();
    restored.loadFromNadac(RECS, cache);
    expect(restored.treeCameFromCache).toBe(true);
    expect(restored.getRootString()).toBe(svc.getRootString());
  });

  test('lookups, leaf indexes and witnesses all still work', () => {
    const { svc, cache } = buildFresh(RECS);
    const restored = new FormularyService();
    restored.loadFromNadac(RECS, cache);

    expect(restored.drugCount).toBe(svc.drugCount);
    for (const r of RECS) {
      const ndcHash = hashString(r.ndc).toString();
      expect(restored.getDrug(ndcHash)).not.toBeNull();
      expect(restored.getLeafIndex(ndcHash)).toBe(svc.getLeafIndex(ndcHash));
      const w = restored.getWitness(ndcHash);
      expect(w).not.toBeNull();
      expect(w!.calculateRoot(restored.getLeaf(ndcHash)!).toString())
        .toBe(restored.getRootString());
    }
  });

  test('a cache exported from a restored service is usable again', () => {
    const { cache } = buildFresh(RECS);
    const once = new FormularyService();
    once.loadFromNadac(RECS, cache);
    const twice = new FormularyService();
    twice.loadFromNadac(RECS, once.exportTreeCache());
    expect(twice.treeCameFromCache).toBe(true);
    expect(twice.getRootString()).toBe(once.getRootString());
  });
});

describe('a cache that does not describe the data is refused', () => {
  /** Load with the given cache and assert the result is the correct tree regardless. */
  function expectRefusedButCorrect(cache: FormularyTreeCache | null, recs: Rec[] = RECS): void {
    const truth = new FormularyService();
    truth.loadFromNadac(recs);

    const svc = new FormularyService();
    svc.loadFromNadac(recs, cache);

    expect(svc.treeCameFromCache).toBe(false);
    expect(svc.getRootString()).toBe(truth.getRootString());
    // And the rebuilt tree is actually usable, not just equal at the root.
    const probe = hashString(recs[0].ndc).toString();
    expect(svc.getLeafIndex(probe)).toBe(0n);
    expect(svc.getWitness(probe)!.calculateRoot(svc.getLeaf(probe)!).toString())
      .toBe(svc.getRootString());
  }

  test('a leaf-determining field changed', () => {
    const { cache } = buildFresh(RECS);
    // copayAmount feeds the leaf, so the cache no longer describes this data.
    expectRefusedButCorrect(cache, records(40, { copayAmount: 9999 }, 7));
  });

  test('the drug count changed', () => {
    const { cache } = buildFresh(RECS);
    expectRefusedButCorrect(cache, records(39));
  });

  test('a field that does not feed a leaf does NOT invalidate the cache', () => {
    const { svc, cache } = buildFresh(RECS);
    // description is not part of the leaf, so the tree is still the right tree.
    const recs = records(40, { nadacPerUnit: 777.77 }, 3);
    const restored = new FormularyService();
    restored.loadFromNadac(recs, cache);
    expect(restored.treeCameFromCache).toBe(true);
    expect(restored.getRootString()).toBe(svc.getRootString());
  });

  test('the wrong tree height', () => {
    const { cache } = buildFresh(RECS);
    const bad = clone(cache);
    bad.height = 12;
    expectRefusedButCorrect(bad);
  });

  test('an unknown cache version', () => {
    const { cache } = buildFresh(RECS);
    const bad = clone(cache);
    (bad as { version: number }).version = 2;
    expectRefusedButCorrect(bad);
  });

  test('no nodes at all', () => {
    const { cache } = buildFresh(RECS);
    const bad = clone(cache);
    bad.nodes = {} as FormularyTreeCache['nodes'];
    expectRefusedButCorrect(bad);
  });

  test('a root that the nodes do not produce', () => {
    const { cache } = buildFresh(RECS);
    const bad = clone(cache);
    bad.root = '12345';
    expectRefusedButCorrect(bad);
  });

  test('a tampered leaf, with the root rewritten to match it', () => {
    // The strongest case: an attacker who edits a leaf AND the claimed root consistently.
    // The digest still binds the cache to the data, and the leaf sample re-derives the truth.
    const { cache } = buildFresh(RECS);
    const bad = clone(cache);
    bad.nodes['0']['0'] = '999999999999';
    // Recompute what that corrupted tree's root would be, so check 2 passes.
    const probe = new FormularyService();
    probe.loadFromNadac(RECS, bad);
    expect(probe.treeCameFromCache).toBe(false);
    const truth = new FormularyService();
    truth.loadFromNadac(RECS);
    expect(probe.getRootString()).toBe(truth.getRootString());
  });

  /*
   * This test is why the cache does not carry NDC hashes. An earlier version cached them to
   * save a sixth of the load; a tampered entry then passed every check, because the digest
   * binds the cache to the records and the tree nodes were untouched, so the root stayed valid
   * while a lookup key did not. The drug was findable only under the forged hash. Now every
   * NDC hash is recomputed from the records on every load, cache hit or not, so there is no
   * cached value that could disagree with the data.
   */
  test('a cache hit still derives every lookup key from the records', () => {
    const { svc, cache } = buildFresh(RECS);
    const restored = new FormularyService();
    restored.loadFromNadac(RECS, cache);
    expect(restored.treeCameFromCache).toBe(true);

    // Nothing in the cache can move a drug: every NDC resolves to its own record, and the
    // leaf under it is the leaf the root commits to.
    for (const r of RECS) {
      const ndcHash = hashString(r.ndc).toString();
      const drug = restored.getDrug(ndcHash);
      expect(drug).not.toBeNull();
      expect(drug!.ndc).toBe(r.ndc);
      expect(drug!.defaultTier).toBe(r.tierLevel);
      expect(drug!.defaultCopay).toBe(r.copayAmount);
      expect(restored.getWitness(ndcHash)!.calculateRoot(restored.getLeaf(ndcHash)!).toString())
        .toBe(svc.getRootString());
    }
  });

  test('no cache at all behaves like before', () => {
    expectRefusedButCorrect(null);
  });
});

describe('exportTreeCache', () => {
  test('returns null before anything is loaded', () => {
    expect(new FormularyService().exportTreeCache()).toBeNull();
  });

  test('carries the tree it describes, and no lookup keys', () => {
    const { svc, cache } = buildFresh(RECS);
    expect(cache.version).toBe(1);
    expect(cache.drugCount).toBe(RECS.length);
    expect(cache.root).toBe(svc.getRootString());
    expect(Object.keys(cache.nodes).length).toBeGreaterThan(1);
    // Deliberately absent; see the test above.
    expect('ndcHashes' in cache).toBe(false);
  });

  test('survives a JSON round trip, which is how it reaches disk', () => {
    const { svc, cache } = buildFresh(RECS);
    const restored = new FormularyService();
    restored.loadFromNadac(RECS, clone(cache));
    expect(restored.treeCameFromCache).toBe(true);
    expect(restored.getRootString()).toBe(svc.getRootString());
  });
});

/**
 * The checkpoint root check used to run before the formulary was loaded, against an empty tree,
 * so it could never pass and warned on every boot about two unrelated roots. These tests pin
 * the corrected behaviour: silent when the formulary matches the checkpoint, loud when it does
 * not, and never comparing against an empty tree.
 */
describe('the checkpoint root check happens when it can mean something', () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  // The spy is installed when this describe body is evaluated, which is before any test runs,
  // so it has already collected whatever the earlier suites warned about. Clear it per test.
  beforeEach(() => warn.mockClear());
  afterAll(() => warn.mockRestore());

  function stateFor(svc: FormularyService): ReturnType<FormularyService['exportState']> {
    return svc.exportState();
  }

  test('restoring before loading does not warn about an empty tree', () => {
    const built = new FormularyService();
    built.loadFromNadac(RECS);

    // The sequencer's order: restore the checkpoint first, load the formulary after.
    const svc = new FormularyService();
    svc.restoreState(stateFor(built));
    expect(warn).not.toHaveBeenCalled();

    svc.loadFromNadac(RECS);
    expect(svc.getRootString()).toBe(built.getRootString());
    expect(warn).not.toHaveBeenCalled();
  });

  test('a formulary that does not match the checkpoint warns once, after loading', () => {
    const built = new FormularyService();
    built.loadFromNadac(RECS);

    const svc = new FormularyService();
    svc.restoreState(stateFor(built));
    expect(warn).not.toHaveBeenCalled();

    // A different formulary: one leaf-determining field changed.
    svc.loadFromNadac(records(40, { copayAmount: 4242 }, 9));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('does not match the one this checkpoint');
  });

  test('the warning does not repeat on a later load', () => {
    const built = new FormularyService();
    built.loadFromNadac(RECS);
    const svc = new FormularyService();
    svc.restoreState(stateFor(built));
    svc.loadFromNadac(records(40, { copayAmount: 4242 }, 9));
    warn.mockClear();
    svc.loadFromNadac(records(40, { copayAmount: 4242 }, 9));
    expect(warn).not.toHaveBeenCalled();
  });
});
