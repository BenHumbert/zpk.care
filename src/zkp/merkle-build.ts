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

import { Field, Poseidon, MerkleTree } from 'o1js';

/**
 * Fill a MerkleTree from contiguous leaves in one bottom-up pass.
 *
 * Why this exists. `MerkleTree.setLeaf` rehashes the whole path to the root on every call, and
 * o1js's `fill()` is just a loop over `setLeaf`, so filling N leaves costs N × (height − 1)
 * hashes. For the formulary that is 32,768 drugs × 15 = about 491,000 Poseidon hashes, measured
 * at roughly 20 ms per drug, or eleven to thirteen minutes on the sequencer's main thread before
 * the RPC server can open its port.
 *
 * Building level by level instead computes each internal node exactly once: ceil(N/2) parents,
 * then ceil(N/4), and so on, which sums to about N hashes. Same tree, same root, roughly fifteen
 * times fewer hashes.
 *
 * The result is identical rather than merely equivalent, and `formulary-tree.test.ts` asserts
 * that against `setLeaf` for several sizes including odd counts, because this tree is a
 * commitment and a subtly different root would be a silent integrity failure.
 *
 * Nodes outside the filled range are left unset, which is what `setLeaf` also does: `getNode`
 * falls back to the level's canonical empty hash, so a partially filled tree has the same root
 * either way.
 */
export function buildTreeBottomUp(tree: MerkleTree, leaves: Field[]): void {
  // `nodes` is MerkleTree's public field; `setNode` is private, so write the same shape it
  // writes — level → index string → Field.
  const put = (level: number, index: number, value: Field): void => {
    (tree.nodes[level] ??= {})[index.toString()] = value;
  };

  for (let i = 0; i < leaves.length; i++) put(0, i, leaves[i]);

  let width = leaves.length;
  for (let level = 0; level < tree.height - 1 && width > 0; level++) {
    const parents = Math.ceil(width / 2);
    for (let p = 0; p < parents; p++) {
      put(level + 1, p, Poseidon.hash([
        tree.getNode(level, BigInt(2 * p)),
        tree.getNode(level, BigInt(2 * p + 1)),
      ]));
    }
    width = parents;
  }
}
