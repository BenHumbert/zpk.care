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
 * The formulary tree is a commitment, so the fast build has to produce the same tree as the
 * slow one, not merely a similar one. These tests pin that: same root, same leaves, same
 * witnesses, across sizes that exercise the awkward cases — one leaf, odd counts where a level
 * has a lone child, and exact powers of two.
 *
 * A wrong root here would not throw anywhere. It would quietly commit the sequencer to a
 * formulary nobody can produce a valid witness against, which is why this is a test and not a
 * comment.
 */
import { Field, MerkleTree } from 'o1js';
import {
  buildTreeBottomUp,
  FORMULARY_TREE_HEIGHT,
  FormularyService,
  computeFormularyLeafHash,
} from '../src/l2/formulary-service.js';
import { hashString } from '../src/zkp/hash-utils.js';

/** Build the same leaves the slow way, one setLeaf at a time. */
function buildWithSetLeaf(leaves: Field[]): MerkleTree {
  const tree = new MerkleTree(FORMULARY_TREE_HEIGHT);
  leaves.forEach((leaf, i) => tree.setLeaf(BigInt(i), leaf));
  return tree;
}

function buildFast(leaves: Field[]): MerkleTree {
  const tree = new MerkleTree(FORMULARY_TREE_HEIGHT);
  buildTreeBottomUp(tree, leaves);
  return tree;
}

const leavesOf = (n: number): Field[] =>
  Array.from({ length: n }, (_, i) => Field(1000n + BigInt(i)));

describe('buildTreeBottomUp matches setLeaf exactly', () => {
  // 0 and 1 are the degenerate cases; 3, 5 and 7 leave a lone child at some level; 4 and 8 are
  // exact powers of two; 17 and 100 are ordinary.
  for (const n of [0, 1, 2, 3, 4, 5, 7, 8, 17, 100]) {
    test(`${n} leaves produce the same root`, () => {
      const leaves = leavesOf(n);
      expect(buildFast(leaves).getRoot().toString())
        .toBe(buildWithSetLeaf(leaves).getRoot().toString());
    });
  }

  test('every leaf and every internal node matches, not just the root', () => {
    const leaves = leavesOf(37);
    const fast = buildFast(leaves);
    const slow = buildWithSetLeaf(leaves);

    for (let level = 0; level < FORMULARY_TREE_HEIGHT; level++) {
      const width = Math.ceil(37 / 2 ** level);
      // One past the filled range too, to catch a build that writes where setLeaf does not.
      for (let i = 0; i <= width; i++) {
        expect(fast.getNode(level, BigInt(i)).toString())
          .toBe(slow.getNode(level, BigInt(i)).toString());
      }
    }
  });

  test('witnesses from the fast tree verify against its own root', () => {
    const leaves = leavesOf(23);
    const fast = buildFast(leaves);
    const root = fast.getRoot();

    for (const i of [0n, 1n, 11n, 22n]) {
      const witness = fast.getWitness(i);
      const slow = buildWithSetLeaf(leaves);
      expect(witness.map((w) => w.sibling.toString()))
        .toEqual(slow.getWitness(i).map((w) => w.sibling.toString()));
      // The leaf is where we put it.
      expect(fast.getLeaf(i).toString()).toBe(leaves[Number(i)].toString());
    }
    expect(root.toString()).toBe(buildWithSetLeaf(leaves).getRoot().toString());
  });

  test('an empty build leaves the canonical empty root', () => {
    expect(buildFast([]).getRoot().toString())
      .toBe(new MerkleTree(FORMULARY_TREE_HEIGHT).getRoot().toString());
  });
});

describe('FormularyService root is unchanged by the faster build', () => {
  const records = Array.from({ length: 50 }, (_, i) => ({
    ndc: `00000-0000-${String(i).padStart(2, '0')}`,
    ndcFormatted: `0000-0000-${i}`,
    description: `TESTDRUG ${i} 10 MG TABLET`,
    classification: i % 3 === 0 ? 'B' : 'G',
    nadacPerUnit: 1.23 + i,
    pricingUnit: 'EA',
    otc: i % 7 === 0,
    tierLevel: (i % 4) + 1,
    copayAmount: 500 + i,
    requiresPriorAuth: i % 5 === 0,
    maxQuantityPerFill: 30,
    maxDaySupply: 30,
    stepTherapyRequired: false,
  }));

  /** The leaves the service must have committed to, derived independently from the records. */
  const expectedLeaves = (): Field[] => records.map((r) => computeFormularyLeafHash(
    hashString(r.ndc).toString(),
    r.classification, r.tierLevel, r.copayAmount, r.requiresPriorAuth, r.maxDaySupply,
  ));

  test('the service root equals a setLeaf tree over the same leaves', () => {
    const svc = new FormularyService();
    svc.loadFromNadac(records);
    expect(svc.getRootString()).toBe(buildWithSetLeaf(expectedLeaves()).getRoot().toString());
  });

  test('each drug lands at its record index', () => {
    const svc = new FormularyService();
    svc.loadFromNadac(records);
    records.forEach((r, i) => {
      expect(svc.getLeafIndex(hashString(r.ndc).toString())).toBe(BigInt(i));
    });
  });

  test('a witness from the service recomputes the service root for every drug', () => {
    const svc = new FormularyService();
    svc.loadFromNadac(records);
    const leaves = expectedLeaves();
    records.forEach((r, i) => {
      const witness = svc.getWitness(hashString(r.ndc).toString());
      expect(witness).not.toBeNull();
      expect(witness!.calculateRoot(leaves[i]).toString()).toBe(svc.getRootString());
    });
  });
});
