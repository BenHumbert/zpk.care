/**
 * L2 — BatchProgram Recursive Proof Tests (zkpCare Chain)
 *
 * SEPARATE FILE from l2.test.ts — recursive proofs MUST NOT run
 * alongside LocalBlockchain tests (Mina global state conflict).
 *
 * Tests:
 *   1. wrapTransition: wraps a registration proof (registrationCount=1)
 *   2. wrapTransition: wraps a wallet update proof (registrationCount=0)
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
 *   Total:       ~6-10 min
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

const ENROLLMENT_KEY_1 = 'xK9#mP2$vL5nQ8wR3jF7';
const ENROLLMENT_KEY_2 = 'aB3@nR4%tK7mJ9xW2pL8';

// ─── Tests ───────────────────────────────────────────────

describe('L2 — BatchProgram Recursive Proofs', () => {
  // Store proofs generated in earlier tests for use in merge tests
  let registrationBatchProof: BatchProof;
  let walletUpdateBatchProof: BatchProof;

  // Track tree state across tests
  let regTree: MerkleTree;
  let lcTree: MerkleTree;
  let walletId1: Field;

  beforeAll(async () => {
    const t0 = Date.now();
    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log('║  L2 BATCH PROGRAM COMPILATION                    ║');
    console.log('╚══════════════════════════════════════════════════╝\n');

    console.log(`[compile] StateTransitionProgram (inline wallet verification)... (${mem()})`);
    let t = Date.now();
    await StateTransitionProgram.compile();
    console.log(`[compile] StateTransitionProgram DONE in ${secs(t)}s (${mem()})\n`);

    console.log(`[compile] BatchProgram (RECURSIVE)... (${mem()})`);
    t = Date.now();
    await BatchProgram.compile();
    console.log(`[compile] BatchProgram DONE in ${secs(t)}s (${mem()})\n`);

    console.log(`✓ Total compilation: ${secs(t0)}s — ready to run proofs\n`);
  }, 600_000); // 10 min timeout for compilation

  test('wrapTransition: wraps a registration proof (registrationCount=1)', async () => {
    const t = Date.now();
    console.log(`\n── Test 1/5: wrapTransition (registration) (${mem()}) ──`);

    // Set up fresh trees
    regTree = new MerkleTree(WALLET_TREE_HEIGHT);
    lcTree = new MerkleTree(WALLET_TREE_HEIGHT);

    walletId1 = deriveMemberWalletId(member1, ENROLLMENT_KEY_1);
    const preimage = memberWalletPreimage(member1, ENROLLMENT_KEY_1);

    // StateTransitionProof (registration — wallet verification inlined)
    console.log(`[test1] Generating StateTransitionProof (registration)...`);
    let s = Date.now();
    const regWitness = new WalletRegistryWitness(regTree.getWitness(0n));
    const lcWitness = new LifecycleWitness(lcTree.getWitness(0n));

    const stResult = await StateTransitionProgram.proveRegistration(
      DOMAIN_TAG_MEMBER,
      preimage[0]!, preimage[1]!, preimage[2]!, preimage[3]!, preimage[4]!,
      regWitness,
      lcWitness,
      regTree.getRoot(),
      lcTree.getRoot(),
    );
    console.log(`[test1] StateTransitionProof done in ${secs(s)}s`);

    // Update trees to match new state
    const walletCommitment = Poseidon.hash([walletId1, EMPTY_CREDENTIAL_ROOT, Field(0)]);
    regTree.setLeaf(0n, walletCommitment);
    const lcLeaf = lifecycleLeafCommitment(walletId1, LIFECYCLE_REGISTERED);
    lcTree.setLeaf(0n, lcLeaf);

    // Step 3: wrapTransition
    console.log(`[test1] Wrapping into BatchProof...`);
    s = Date.now();
    const batchResult = await BatchProgram.wrapTransition(stResult.proof);
    console.log(`[test1] wrapTransition done in ${secs(s)}s`);

    registrationBatchProof = batchResult.proof as BatchProof;
    const output = registrationBatchProof.publicOutput as unknown as BatchOutput;

    expect(output.registrationCount.toString()).toBe('1');
    expect(output.transitionCount.toString()).toBe('1');
    expect(output.oldRegistryRoot.toString()).not.toBe(output.newRegistryRoot.toString());
    expect(output.oldLifecycleRoot.toString()).not.toBe(output.newLifecycleRoot.toString());

    console.log(`✓ Test 1/5 PASSED in ${secs(t)}s (${mem()})\n`);
  }, 600_000);

  test('wrapTransition: wraps a wallet update proof (registrationCount=0)', async () => {
    const t = Date.now();
    console.log(`\n── Test 2/5: wrapTransition (wallet update) (${mem()}) ──`);

    // Use current tree state from test 1 (wallet is registered)
    const preimage = memberWalletPreimage(member1, ENROLLMENT_KEY_1);

    // StateTransitionProof (wallet update — wallet verification inlined)
    console.log(`[test2] Generating StateTransitionProof (wallet update)...`);
    let s = Date.now();

    const newCredentialRoot = Poseidon.hash([Field(9999)]); // Simulated new credential inventory
    const regWitness = new WalletRegistryWitness(regTree.getWitness(0n));
    const lcWitness = new LifecycleWitness(lcTree.getWitness(0n));

    const stResult = await StateTransitionProgram.proveWalletUpdate(
      DOMAIN_TAG_MEMBER,
      preimage[0]!, preimage[1]!, preimage[2]!, preimage[3]!, preimage[4]!,
      EMPTY_CREDENTIAL_ROOT,   // oldCredentialRoot
      Field(0),          // oldNonce
      newCredentialRoot,        // newCredentialRoot
      regWitness,
      lcWitness,
      regTree.getRoot(),
      lcTree.getRoot(),
      LIFECYCLE_REGISTERED,
    );
    console.log(`[test2] StateTransitionProof done in ${secs(s)}s`);

    // Update registry tree for new wallet state
    const newCommitment = Poseidon.hash([walletId1, newCredentialRoot, Field(1)]);
    regTree.setLeaf(0n, newCommitment);

    // Step 3: wrapTransition
    console.log(`[test2] Wrapping into BatchProof...`);
    s = Date.now();
    const batchResult = await BatchProgram.wrapTransition(stResult.proof);
    console.log(`[test2] wrapTransition done in ${secs(s)}s`);

    walletUpdateBatchProof = batchResult.proof as BatchProof;
    const output = walletUpdateBatchProof.publicOutput as unknown as BatchOutput;

    expect(output.registrationCount.toString()).toBe('0');
    expect(output.transitionCount.toString()).toBe('1');
    // Registry root changed (wallet state updated)
    expect(output.oldRegistryRoot.toString()).not.toBe(output.newRegistryRoot.toString());
    // Lifecycle root unchanged (wallet updates don't affect lifecycle)
    expect(output.oldLifecycleRoot.toString()).toBe(output.newLifecycleRoot.toString());

    console.log(`✓ Test 2/5 PASSED in ${secs(t)}s (${mem()})\n`);
  }, 600_000);

  test('mergeBatches: merges two batch proofs with correct root chaining', async () => {
    const t = Date.now();
    console.log(`\n── Test 3/5: mergeBatches (${mem()}) ──`);

    // Verify chain: registration.new roots == walletUpdate.old roots
    const regOutput = registrationBatchProof.publicOutput as unknown as BatchOutput;
    const updOutput = walletUpdateBatchProof.publicOutput as unknown as BatchOutput;

    expect(regOutput.newRegistryRoot.toString()).toBe(
      updOutput.oldRegistryRoot.toString(),
    );
    expect(regOutput.newLifecycleRoot.toString()).toBe(
      updOutput.oldLifecycleRoot.toString(),
    );

    // Merge
    console.log(`[test3] Merging two BatchProofs...`);
    const s = Date.now();
    const mergedResult = await BatchProgram.mergeBatches(
      registrationBatchProof,
      walletUpdateBatchProof,
    );
    console.log(`[test3] mergeBatches done in ${secs(s)}s`);

    const mergedProof = mergedResult.proof as BatchProof;
    const output = mergedProof.publicOutput as unknown as BatchOutput;

    // A→C: old from registration, new from wallet update
    expect(output.oldRegistryRoot.toString()).toBe(
      regOutput.oldRegistryRoot.toString(),
    );
    expect(output.newRegistryRoot.toString()).toBe(
      updOutput.newRegistryRoot.toString(),
    );
    expect(output.oldLifecycleRoot.toString()).toBe(
      regOutput.oldLifecycleRoot.toString(),
    );
    expect(output.newLifecycleRoot.toString()).toBe(
      updOutput.newLifecycleRoot.toString(),
    );

    // Counts: 1 registration + 0 = 1, 1 transition + 1 = 2
    expect(output.registrationCount.toString()).toBe('1');
    expect(output.transitionCount.toString()).toBe('2');

    console.log(`✓ Test 3/5 PASSED in ${secs(t)}s (${mem()})\n`);
  }, 600_000);

  test('mergeBatches: rejects mismatched roots (chain violation)', async () => {
    const t = Date.now();
    console.log(`\n── Test 4/5: mergeBatches chain violation (${mem()}) ──`);

    // Try to merge in wrong order: walletUpdate first, then registration
    // walletUpdate.new roots != registration.old roots — chain is broken
    console.log(`[test4] Attempting merge with wrong order (should fail)...`);

    // This should throw a constraint failure during proof generation
    await expect(
      BatchProgram.mergeBatches(
        walletUpdateBatchProof,
        registrationBatchProof,
      ),
    ).rejects.toThrow();

    console.log(`✓ Test 4/5 PASSED in ${secs(t)}s (${mem()})\n`);
  }, 600_000);

  test('BatchProof verifies standalone (offline verification)', async () => {
    const t = Date.now();
    console.log(`\n── Test 5/5: Standalone BatchProof verification (${mem()}) ──`);

    // Verify the registration batch proof offline
    console.log(`[test5] Verifying BatchProof offline...`);
    const s = Date.now();
    const isValid = await BatchProgram.verify(registrationBatchProof);
    console.log(`[test5] verify() done in ${secs(s)}s — valid=${isValid}`);

    expect(isValid).toBe(true);

    console.log(`✓ Test 5/5 PASSED in ${secs(t)}s (${mem()})\n`);
  }, 600_000);
});
