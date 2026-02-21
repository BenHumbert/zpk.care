/**
 * L3 Recursive Proof Tests
 *
 * Separated from layer3.test.ts because Mina.LocalBlockchain (proofsEnabled: false)
 * global state conflicts with real proof generation. Must run in its own process.
 *
 * Run: $env:NODE_OPTIONS="--max-old-space-size=12288"; npx jest tests/layer3-recursive.test.ts --verbose --maxWorkers=1
 *
 * Timing (typical):
 *   Compilation: ~35s (StateTransition only — wallet verification inlined)
 *   Each proof:  ~35s
 *   Total:       ~2-3 min for all 3 tests
 */
import { MerkleTree } from 'o1js';
import { StateTransitionProgram, TransitionOutput } from '../src/engine/state-transition.js';
import { WalletRegistryWitness, WALLET_TREE_HEIGHT } from '../src/wallets/wallet-state.js';
import { LifecycleWitness } from '../src/engine/lifecycle.js';
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

const testMember: MemberLocalData = {
  cardholderId: 'CARD123456789',
  dateOfBirth: '19850315',
  genderCode: 1,
  firstName: 'John',
  lastName: 'Doe',
};

const TEST_ENROLLMENT_KEY = 'xK9#mP2$vL5nQ8wR3jF7';

// ─── Tests ───────────────────────────────────────────────

describe('L3 — StateTransitionProgram Recursive Proofs', () => {
  beforeAll(async () => {
    const t0 = Date.now();
    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log('║  L3 RECURSIVE PROOF COMPILATION                  ║');
    console.log('║  (wallet verification inlined — no ProofGateProof)║');
    console.log('╚══════════════════════════════════════════════════╝\n');

    console.log(`[compile] StateTransitionProgram... (${mem()})`);
    const t = Date.now();
    await StateTransitionProgram.compile();
    console.log(`[compile] StateTransitionProgram DONE in ${secs(t)}s (${mem()})\n`);

    console.log(`✓ Total compilation: ${secs(t0)}s — ready to run proofs\n`);
  }, 300_000);

  test('proveRegistration: generates a valid proof (inline wallet verification)', async () => {
    const t = Date.now();
    console.log(`\n── Test 1/3: Generate Proof (${mem()}) ──`);

    const regTree = new MerkleTree(WALLET_TREE_HEIGHT);
    const lcTree = new MerkleTree(WALLET_TREE_HEIGHT);

    const walletId = deriveMemberWalletId(testMember, TEST_ENROLLMENT_KEY);
    const preimage = memberWalletPreimage(testMember, TEST_ENROLLMENT_KEY);

    // StateTransitionProof (wallet verification inlined — no ProofGateProof needed)
    console.log(`[test1] Generating StateTransitionProof...`);
    const s = Date.now();
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
    console.log(`[test1] StateTransitionProof done in ${secs(s)}s (${mem()})`);

    expect(stResult.proof).toBeDefined();
    const output = stResult.proof.publicOutput as unknown as TransitionOutput;
    expect(output.walletId.toString()).toBe(walletId.toString());
    expect(output.oldRegistryRoot.toString()).toBe(regTree.getRoot().toString());
    expect(output.oldLifecycleRoot.toString()).toBe(lcTree.getRoot().toString());
    expect(output.newRegistryRoot.toString()).not.toBe(output.oldRegistryRoot.toString());
    expect(output.newLifecycleRoot.toString()).not.toBe(output.oldLifecycleRoot.toString());
    console.log(`✓ Test 1/3 PASSED in ${secs(t)}s\n`);
  }, 300_000);

  test('proveRegistration proof verifies standalone (offline verification)', async () => {
    const t = Date.now();
    console.log(`── Test 2/3: Offline Proof Verification (${mem()}) ──`);

    const regTree = new MerkleTree(WALLET_TREE_HEIGHT);
    const lcTree = new MerkleTree(WALLET_TREE_HEIGHT);

    const preimage = memberWalletPreimage(testMember, TEST_ENROLLMENT_KEY);

    console.log(`[test2] Generating StateTransitionProof...`);
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
    console.log(`[test2] StateTransitionProof done in ${secs(s)}s (${mem()})`);

    // NFC/RFID offline verification — no blockchain needed
    console.log(`[test2] Verifying proof offline (NFC/RFID simulation)...`);
    s = Date.now();
    const isValid = await StateTransitionProgram.verify(stResult.proof);
    console.log(`[test2] verify() done in ${secs(s)}s — valid=${isValid} (${mem()})`);

    expect(isValid).toBe(true);
    console.log(`✓ Test 2/3 PASSED in ${secs(t)}s\n`);
  }, 300_000);

  test('proveRegistration: different identity fields register different wallet', async () => {
    const t = Date.now();
    console.log(`── Test 3/3: Different Identity Fields (${mem()}) ──`);

    const regTree = new MerkleTree(WALLET_TREE_HEIGHT);
    const lcTree = new MerkleTree(WALLET_TREE_HEIGHT);

    const walletId = deriveMemberWalletId(testMember, TEST_ENROLLMENT_KEY);
    const wrongMember = { ...testMember, firstName: 'Jane' };
    const wrongPreimage = memberWalletPreimage(wrongMember, TEST_ENROLLMENT_KEY);
    const wrongWalletId = deriveMemberWalletId(wrongMember, TEST_ENROLLMENT_KEY);

    console.log(`[test3] Generating StateTransitionProof with different identity...`);
    const s = Date.now();
    const regWitness = new WalletRegistryWitness(regTree.getWitness(0n));
    const lcWitness = new LifecycleWitness(lcTree.getWitness(0n));

    const stResult = await StateTransitionProgram.proveRegistration(
      DOMAIN_TAG_MEMBER,
      wrongPreimage[0]!, wrongPreimage[1]!, wrongPreimage[2]!,
      wrongPreimage[3]!, wrongPreimage[4]!,
      regWitness,
      lcWitness,
      regTree.getRoot(),
      lcTree.getRoot(),
    );
    console.log(`[test3] StateTransitionProof done in ${secs(s)}s (${mem()})`);

    // The proof computes walletId from the provided preimage — registers the "wrong" wallet
    const output = stResult.proof.publicOutput as unknown as TransitionOutput;
    expect(output.walletId.toString()).toBe(wrongWalletId.toString());
    expect(output.walletId.toString()).not.toBe(walletId.toString());
    console.log(`✓ Test 3/3 PASSED in ${secs(t)}s\n`);
  }, 300_000);
});
