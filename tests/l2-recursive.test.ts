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
 * L2 — BatchProgram Recursive Proof Tests (zkpCare Chain)
 *
 * SEPARATE FILE from l2.test.ts — recursive proofs MUST NOT run
 * alongside LocalBlockchain tests (Mina global state conflict).
 *
 * Tests (uniform pair pattern — both wrapPair and mergeBatches take 2 proofs):
 *   1. wrapPair: wraps two registration proofs (registrationCount=2)
 *   2. wrapPair: wraps registration + wallet update (registrationCount=1)
 *   3. mergeBatches: merges two batch proofs with correct root chaining
 *   4. mergeBatches: rejects mismatched roots (chain violation)
 *   5. BatchProof verifies standalone (offline verification)
 *
 * Run:
 *   $env:NODE_OPTIONS="--max-old-space-size=12288"; npx jest tests/l2-recursive.test.ts --verbose --maxWorkers=1
 *
 * Timing (estimated on Ryzen 7 5800XT):
 *   Compilation: ~2-3 min (StateTransition ~35s + BatchProgram ~60-120s)
 *   Each proof:  ~30-60s
 *   Total:       ~8-12 min
 */
import { Field, MerkleTree, Poseidon } from 'o1js';
import {
  StateTransitionProgram,
  TransitionOutput,
  EMPTY_CREDENTIAL_ROOT,
} from '../src/engine/state-transition.js';
import {
  BatchProgram,
  BatchProof,
  BatchOutput,
} from '../src/l2/batch-program.js';
import {
  WalletRegistryWitness,
  WALLET_TREE_HEIGHT,
} from '../src/wallets/wallet-state.js';
import { LifecycleWitness, LIFECYCLE_REGISTERED, lifecycleLeafCommitment } from '../src/engine/lifecycle.js';
import {
  deriveMemberWalletId,
  memberWalletPreimage,
  DOMAIN_TAG_MEMBER,
} from '../src/wallets/wallet-derivation.js';
import type { MemberLocalData } from '../src/models/member.js';

// ─── Helpers ─────────────────────────────────────────────

const mem = () => {
  const m = process.memoryUsage();
  return `heap=${(m.heapUsed / 1024 / 1024).toFixed(0)}MB rss=${(m.rss / 1024 / 1024).toFixed(0)}MB`;
};
const secs = (t: number) => ((Date.now() - t) / 1000).toFixed(1);

// ─── Test Data ───────────────────────────────────────────

const member1: MemberLocalData = {
  cardholderId: 'CARD123456789',
  dateOfBirth: '19850315',
  genderCode: 1,
  firstName: 'John',
  lastName: 'Doe',
};

const member2: MemberLocalData = {
  cardholderId: 'CARD987654321',
  dateOfBirth: '19900710',
  genderCode: 2,
  firstName: 'Jane',
  lastName: 'Smith',
};

const member3: MemberLocalData = {
  cardholderId: 'CARD555444333',
  dateOfBirth: '19880520',
  genderCode: 1,
  firstName: 'Bob',
  lastName: 'Johnson',
};

const ENROLLMENT_KEY_1 = 'xK9#mP2$vL5nQ8wR3jF7';
const ENROLLMENT_KEY_2 = 'aB3@nR4%tK7mJ9xW2pL8';
const ENROLLMENT_KEY_3 = 'cD5!fH8^gJ1kL4mN6pQ9';

// ─── Tests ───────────────────────────────────────────────

describe('L2 — BatchProgram Recursive Proofs (Uniform Pair)', () => {
  // Store proofs generated in earlier tests for use in merge tests
  let pairBatchProof1: BatchProof;   // test 1: 2 registrations
  let pairBatchProof2: BatchProof;   // test 2: registration + wallet update

  // Track tree state across tests
  let regTree: MerkleTree;
  let lcTree: MerkleTree;
  let walletId1: Field;

  beforeAll(async () => {
    const t0 = Date.now();
    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log('║  L2 BATCH PROGRAM COMPILATION (UNIFORM PAIR)     ║');
    console.log('╚══════════════════════════════════════════════════╝\n');

    console.log(`[compile] StateTransitionProgram (inline wallet verification)... (${mem()})`);
    let t = Date.now();
    await StateTransitionProgram.compile();
    console.log(`[compile] StateTransitionProgram DONE in ${secs(t)}s (${mem()})\n`);

    console.log(`[compile] BatchProgram (RECURSIVE, uniform pair)... (${mem()})`);
    t = Date.now();
    await BatchProgram.compile();
    console.log(`[compile] BatchProgram DONE in ${secs(t)}s (${mem()})\n`);

    console.log(`✓ Total compilation: ${secs(t0)}s — ready to run proofs\n`);
  }, 600_000); // 10 min timeout for compilation

  test('wrapPair: wraps two registration proofs (registrationCount=2)', async () => {
    const t = Date.now();
    console.log(`\n── Test 1/5: wrapPair (2 registrations) (${mem()}) ──`);

    // Set up fresh trees
    regTree = new MerkleTree(WALLET_TREE_HEIGHT);
    lcTree = new MerkleTree(WALLET_TREE_HEIGHT);

    // ── Registration 1: member1 at slot 0 ──
    walletId1 = deriveMemberWalletId(member1, ENROLLMENT_KEY_1, Field(0));
    const preimage1 = memberWalletPreimage(member1, ENROLLMENT_KEY_1, Field(0));

    console.log(`[test1] Generating StateTransitionProof #1 (register member1)...`);
    let s = Date.now();
    const regWitness1 = new WalletRegistryWitness(regTree.getWitness(0n));
    const lcWitness1 = new LifecycleWitness(lcTree.getWitness(0n));

    const stResult1 = await StateTransitionProgram.proveRegistration(
      DOMAIN_TAG_MEMBER,
      preimage1[0]!, preimage1[1]!, preimage1[2]!, preimage1[3]!, preimage1[4]!, preimage1[5]!,
      regWitness1,
      lcWitness1,
      regTree.getRoot(),
      lcTree.getRoot(),
    );
    console.log(`[test1] ST proof #1 done in ${secs(s)}s`);

    // Update trees to match new state
    const walletCommitment1 = Poseidon.hash([walletId1, EMPTY_CREDENTIAL_ROOT, Field(0)]);
    regTree.setLeaf(0n, walletCommitment1);
    const lcLeaf1 = lifecycleLeafCommitment(walletId1, LIFECYCLE_REGISTERED);
    lcTree.setLeaf(0n, lcLeaf1);

    // ── Registration 2: member2 at slot 1 ──
    const walletId2 = deriveMemberWalletId(member2, ENROLLMENT_KEY_2, Field(0));
    const preimage2 = memberWalletPreimage(member2, ENROLLMENT_KEY_2, Field(0));

    console.log(`[test1] Generating StateTransitionProof #2 (register member2)...`);
    s = Date.now();
    const regWitness2 = new WalletRegistryWitness(regTree.getWitness(1n));
    const lcWitness2 = new LifecycleWitness(lcTree.getWitness(1n));

    const stResult2 = await StateTransitionProgram.proveRegistration(
      DOMAIN_TAG_MEMBER,
      preimage2[0]!, preimage2[1]!, preimage2[2]!, preimage2[3]!, preimage2[4]!, preimage2[5]!,
      regWitness2,
      lcWitness2,
      regTree.getRoot(),
      lcTree.getRoot(),
    );
    console.log(`[test1] ST proof #2 done in ${secs(s)}s`);

    // Update trees for member2
    const walletCommitment2 = Poseidon.hash([walletId2, EMPTY_CREDENTIAL_ROOT, Field(0)]);
    regTree.setLeaf(1n, walletCommitment2);
    const lcLeaf2 = lifecycleLeafCommitment(walletId2, LIFECYCLE_REGISTERED);
    lcTree.setLeaf(1n, lcLeaf2);

    // ── wrapPair: wrap both registrations as a pair ──
    console.log(`[test1] wrapPair (2 registration proofs)...`);
    s = Date.now();
    const batchResult = await BatchProgram.wrapPair(stResult1.proof, stResult2.proof);
    console.log(`[test1] wrapPair done in ${secs(s)}s`);

    pairBatchProof1 = batchResult.proof as BatchProof;
    const output = pairBatchProof1.publicOutput as unknown as BatchOutput;

    // 2 registrations, 2 transitions
    expect(output.registrationCount.toString()).toBe('2');
    expect(output.transitionCount.toString()).toBe('2');
    // Both roots changed (registrations modify both registry and lifecycle)
    expect(output.oldRegistryRoot.toString()).not.toBe(output.newRegistryRoot.toString());
    expect(output.oldLifecycleRoot.toString()).not.toBe(output.newLifecycleRoot.toString());

    console.log(`✓ Test 1/5 PASSED in ${secs(t)}s (${mem()})\n`);
  }, 600_000);

  test('wrapPair: wraps registration + wallet update (registrationCount=1)', async () => {
    const t = Date.now();
    console.log(`\n── Test 2/5: wrapPair (registration + wallet update) (${mem()}) ──`);

    // ── Registration 3: member3 at slot 2 ──
    const walletId3 = deriveMemberWalletId(member3, ENROLLMENT_KEY_3, Field(0));
    const preimage3 = memberWalletPreimage(member3, ENROLLMENT_KEY_3, Field(0));

    console.log(`[test2] Generating StateTransitionProof #3 (register member3)...`);
    let s = Date.now();
    const regWitness3 = new WalletRegistryWitness(regTree.getWitness(2n));
    const lcWitness3 = new LifecycleWitness(lcTree.getWitness(2n));

    const stResult3 = await StateTransitionProgram.proveRegistration(
      DOMAIN_TAG_MEMBER,
      preimage3[0]!, preimage3[1]!, preimage3[2]!, preimage3[3]!, preimage3[4]!, preimage3[5]!,
      regWitness3,
      lcWitness3,
      regTree.getRoot(),
      lcTree.getRoot(),
    );
    console.log(`[test2] ST proof #3 done in ${secs(s)}s`);

    // Update trees for member3
    const walletCommitment3 = Poseidon.hash([walletId3, EMPTY_CREDENTIAL_ROOT, Field(0)]);
    regTree.setLeaf(2n, walletCommitment3);
    const lcLeaf3 = lifecycleLeafCommitment(walletId3, LIFECYCLE_REGISTERED);
    lcTree.setLeaf(2n, lcLeaf3);

    // ── Wallet update: member1 at slot 0 (already registered in test 1) ──
    const preimage1 = memberWalletPreimage(member1, ENROLLMENT_KEY_1, Field(0));

    console.log(`[test2] Generating StateTransitionProof #4 (wallet update member1)...`);
    s = Date.now();

    const newCredentialRoot = Poseidon.hash([Field(9999)]); // Simulated credential change
    const regWitness4 = new WalletRegistryWitness(regTree.getWitness(0n));
    const lcWitness4 = new LifecycleWitness(lcTree.getWitness(0n));

    const stResult4 = await StateTransitionProgram.proveWalletUpdate(
      DOMAIN_TAG_MEMBER,
      preimage1[0]!, preimage1[1]!, preimage1[2]!, preimage1[3]!, preimage1[4]!, preimage1[5]!,
      EMPTY_CREDENTIAL_ROOT,   // oldCredentialRoot
      Field(0),                // oldNonce
      newCredentialRoot,       // newCredentialRoot
      regWitness4,
      lcWitness4,
      regTree.getRoot(),
      lcTree.getRoot(),
      LIFECYCLE_REGISTERED,
    );
    console.log(`[test2] ST proof #4 done in ${secs(s)}s`);

    // Update registry tree for new wallet state
    const newCommitment = Poseidon.hash([walletId1, newCredentialRoot, Field(1)]);
    regTree.setLeaf(0n, newCommitment);

    // ── wrapPair: wrap registration + wallet update as a pair ──
    console.log(`[test2] wrapPair (registration + wallet update)...`);
    s = Date.now();
    const batchResult = await BatchProgram.wrapPair(stResult3.proof, stResult4.proof);
    console.log(`[test2] wrapPair done in ${secs(s)}s`);

    pairBatchProof2 = batchResult.proof as BatchProof;
    const output = pairBatchProof2.publicOutput as unknown as BatchOutput;

    // 1 registration + 0 registration = 1
    expect(output.registrationCount.toString()).toBe('1');
    expect(output.transitionCount.toString()).toBe('2');
    // Registry root changed (both proofs modify registry)
    expect(output.oldRegistryRoot.toString()).not.toBe(output.newRegistryRoot.toString());

    console.log(`✓ Test 2/5 PASSED in ${secs(t)}s (${mem()})\n`);
  }, 600_000);

  test('mergeBatches: merges two wrapPair batch proofs with correct root chaining', async () => {
    const t = Date.now();
    console.log(`\n── Test 3/5: mergeBatches (${mem()}) ──`);

    // Verify chain: pairBatch1.new roots == pairBatch2.old roots
    const out1 = pairBatchProof1.publicOutput as unknown as BatchOutput;
    const out2 = pairBatchProof2.publicOutput as unknown as BatchOutput;

    expect(out1.newRegistryRoot.toString()).toBe(
      out2.oldRegistryRoot.toString(),
    );
    expect(out1.newLifecycleRoot.toString()).toBe(
      out2.oldLifecycleRoot.toString(),
    );

    // Merge
    console.log(`[test3] Merging two BatchProofs...`);
    const s = Date.now();
    const mergedResult = await BatchProgram.mergeBatches(
      pairBatchProof1,
      pairBatchProof2,
    );
    console.log(`[test3] mergeBatches done in ${secs(s)}s`);

    const mergedProof = mergedResult.proof as BatchProof;
    const output = mergedProof.publicOutput as unknown as BatchOutput;

    // A→C: old from pair1, new from pair2
    expect(output.oldRegistryRoot.toString()).toBe(
      out1.oldRegistryRoot.toString(),
    );
    expect(output.newRegistryRoot.toString()).toBe(
      out2.newRegistryRoot.toString(),
    );
    expect(output.oldLifecycleRoot.toString()).toBe(
      out1.oldLifecycleRoot.toString(),
    );
    expect(output.newLifecycleRoot.toString()).toBe(
      out2.newLifecycleRoot.toString(),
    );

    // Counts: 2 + 1 = 3 registrations, 2 + 2 = 4 transitions
    expect(output.registrationCount.toString()).toBe('3');
    expect(output.transitionCount.toString()).toBe('4');

    console.log(`✓ Test 3/5 PASSED in ${secs(t)}s (${mem()})\n`);
  }, 600_000);

  test('mergeBatches: rejects mismatched roots (chain violation)', async () => {
    const t = Date.now();
    console.log(`\n── Test 4/5: mergeBatches chain violation (${mem()}) ──`);

    // Try to merge in wrong order: pairBatch2 first, then pairBatch1
    // pairBatch2.new roots != pairBatch1.old roots — chain is broken
    console.log(`[test4] Attempting merge with wrong order (should fail)...`);

    // This should throw a constraint failure during proof generation
    await expect(
      BatchProgram.mergeBatches(
        pairBatchProof2,
        pairBatchProof1,
      ),
    ).rejects.toThrow();

    console.log(`✓ Test 4/5 PASSED in ${secs(t)}s (${mem()})\n`);
  }, 600_000);

  test('BatchProof verifies standalone (offline verification)', async () => {
    const t = Date.now();
    console.log(`\n── Test 5/5: Standalone BatchProof verification (${mem()}) ──`);

    // Verify the pair batch proof offline
    console.log(`[test5] Verifying BatchProof offline...`);
    const s = Date.now();
    const isValid = await BatchProgram.verify(pairBatchProof1);
    console.log(`[test5] verify() done in ${secs(s)}s — valid=${isValid}`);

    expect(isValid).toBe(true);

    console.log(`✓ Test 5/5 PASSED in ${secs(t)}s (${mem()})\n`);
  }, 600_000);
});
