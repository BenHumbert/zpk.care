/**
 * ChainProgram — GlobalState + ChainOutput + ChainProgram Tests
 *
 * Section A: Fast unit tests for GlobalState and ChainOutput Structs (no compilation).
 * Section B: Recursive proof tests — full 3-tier zkTrident chain:
 *            StateTransitionProof → BatchProof → ChainProof
 *
 * The 3-tier chain was blocked by the Pickles dummy-proof bug (o1js #1939) when
 * BatchProgram had heterogeneous methods (wrapTransition=1 proof, mergeBatches=2).
 * Fixed via uniform pair pattern: both wrapPair and mergeBatches take 2 proofs.
 *
 * Run fast tests:
 *   npx jest tests/chain-program.test.ts --verbose --testNamePattern="unit tests"
 *
 * Run full 3-tier recursive tests:
 *   $env:NODE_OPTIONS="--max-old-space-size=12288"; npx jest tests/chain-program.test.ts --verbose --maxWorkers=1
 */
import { Field, Poseidon, MerkleTree } from 'o1js';
import {
  GlobalState,
  computeGlobalStateRoot,
  GLOBAL_STATE_FIELD_COUNT,
  ChainOutput,
} from '../src/l2/global-state.js';
import {
  StateTransitionProgram,
  EMPTY_CREDENTIAL_ROOT,
} from '../src/engine/state-transition.js';
import {
  BatchProgram,
  BatchProof,
  BatchOutput,
} from '../src/l2/batch-program.js';
import { ChainProgram, ChainProof } from '../src/l2/chain-program.js';
import {
  WalletRegistryWitness,
  WALLET_TREE_HEIGHT,
} from '../src/wallets/wallet-state.js';
import {
  LifecycleWitness,
  LIFECYCLE_REGISTERED,
  lifecycleLeafCommitment,
} from '../src/engine/lifecycle.js';
import {
  deriveMemberWalletId,
  memberWalletPreimage,
  DOMAIN_TAG_MEMBER,
} from '../src/wallets/wallet-derivation.js';
import type { MemberLocalData } from '../src/models/member.js';

// ═══════════════════════════════════════════════════════════
//  A. FAST UNIT TESTS (no compilation)
// ═══════════════════════════════════════════════════════════

describe('GlobalState — unit tests', () => {
  const fields = {
    walletRegistryRoot: Field(100),
    walletCount: Field(5),
    adminPublicKeyHash: Field(200),
    lifecycleRoot: Field(300),
    benefitPlanRoot: Field(400),
    credentialRegistryRoot: Field(500),
    eligibilityVkHash: Field(600),
    messagingRoot: Field(700),
    auditChainHash: Field(800),
    blockHeight: Field(10),
  };

  test('GLOBAL_STATE_FIELD_COUNT is 10', () => {
    expect(GLOBAL_STATE_FIELD_COUNT).toBe(10);
  });

  test('computeGlobalStateRoot is deterministic', () => {
    const root1 = computeGlobalStateRoot(
      fields.walletRegistryRoot,
      fields.walletCount,
      fields.adminPublicKeyHash,
      fields.lifecycleRoot,
      fields.benefitPlanRoot,
      fields.credentialRegistryRoot,
      fields.eligibilityVkHash,
      fields.messagingRoot,
      fields.auditChainHash,
      fields.blockHeight,
    );
    const root2 = computeGlobalStateRoot(
      fields.walletRegistryRoot,
      fields.walletCount,
      fields.adminPublicKeyHash,
      fields.lifecycleRoot,
      fields.benefitPlanRoot,
      fields.credentialRegistryRoot,
      fields.eligibilityVkHash,
      fields.messagingRoot,
      fields.auditChainHash,
      fields.blockHeight,
    );
    expect(root1.toString()).toBe(root2.toString());
  });

  test('computeGlobalStateRoot changes when any field changes', () => {
    const baseRoot = computeGlobalStateRoot(
      fields.walletRegistryRoot,
      fields.walletCount,
      fields.adminPublicKeyHash,
      fields.lifecycleRoot,
      fields.benefitPlanRoot,
      fields.credentialRegistryRoot,
      fields.eligibilityVkHash,
      fields.messagingRoot,
      fields.auditChainHash,
      fields.blockHeight,
    );

    // Change each field and verify root changes
    const fieldNames = Object.keys(fields) as (keyof typeof fields)[];
    for (const name of fieldNames) {
      const modified = { ...fields, [name]: Field(9999) };
      const modRoot = computeGlobalStateRoot(
        modified.walletRegistryRoot,
        modified.walletCount,
        modified.adminPublicKeyHash,
        modified.lifecycleRoot,
        modified.benefitPlanRoot,
        modified.credentialRegistryRoot,
        modified.eligibilityVkHash,
        modified.messagingRoot,
        modified.auditChainHash,
        modified.blockHeight,
      );
      expect(modRoot.toString()).not.toBe(baseRoot.toString());
    }
  });

  test('GlobalState Struct has all 10 fields', () => {
    const state = new GlobalState(fields);
    expect(state.walletRegistryRoot.toString()).toBe('100');
    expect(state.walletCount.toString()).toBe('5');
    expect(state.adminPublicKeyHash.toString()).toBe('200');
    expect(state.lifecycleRoot.toString()).toBe('300');
    expect(state.benefitPlanRoot.toString()).toBe('400');
    expect(state.credentialRegistryRoot.toString()).toBe('500');
    expect(state.eligibilityVkHash.toString()).toBe('600');
    expect(state.messagingRoot.toString()).toBe('700');
    expect(state.auditChainHash.toString()).toBe('800');
    expect(state.blockHeight.toString()).toBe('10');
  });

  test('GlobalState.computeRoot() matches computeGlobalStateRoot()', () => {
    const state = new GlobalState(fields);
    const fromMethod = state.computeRoot();
    const fromFunction = computeGlobalStateRoot(
      fields.walletRegistryRoot,
      fields.walletCount,
      fields.adminPublicKeyHash,
      fields.lifecycleRoot,
      fields.benefitPlanRoot,
      fields.credentialRegistryRoot,
      fields.eligibilityVkHash,
      fields.messagingRoot,
      fields.auditChainHash,
      fields.blockHeight,
    );
    expect(fromMethod.toString()).toBe(fromFunction.toString());
  });

  test('computeGlobalStateRoot matches Poseidon.hash of same 10 fields', () => {
    const root = computeGlobalStateRoot(
      fields.walletRegistryRoot,
      fields.walletCount,
      fields.adminPublicKeyHash,
      fields.lifecycleRoot,
      fields.benefitPlanRoot,
      fields.credentialRegistryRoot,
      fields.eligibilityVkHash,
      fields.messagingRoot,
      fields.auditChainHash,
      fields.blockHeight,
    );
    const expected = Poseidon.hash([
      fields.walletRegistryRoot,
      fields.walletCount,
      fields.adminPublicKeyHash,
      fields.lifecycleRoot,
      fields.benefitPlanRoot,
      fields.credentialRegistryRoot,
      fields.eligibilityVkHash,
      fields.messagingRoot,
      fields.auditChainHash,
      fields.blockHeight,
    ]);
    expect(root.toString()).toBe(expected.toString());
  });

  test('field ordering matters — different order gives different root', () => {
    const rootCorrect = computeGlobalStateRoot(
      Field(1), Field(2), Field(3), Field(4), Field(5),
      Field(6), Field(7), Field(8), Field(9), Field(10),
    );
    // Swap walletRegistryRoot and walletCount
    const rootSwapped = computeGlobalStateRoot(
      Field(2), Field(1), Field(3), Field(4), Field(5),
      Field(6), Field(7), Field(8), Field(9), Field(10),
    );
    expect(rootCorrect.toString()).not.toBe(rootSwapped.toString());
  });

  test('GlobalState with all zeros produces a valid root', () => {
    const state = new GlobalState({
      walletRegistryRoot: Field(0),
      walletCount: Field(0),
      adminPublicKeyHash: Field(0),
      lifecycleRoot: Field(0),
      benefitPlanRoot: Field(0),
      credentialRegistryRoot: Field(0),
      eligibilityVkHash: Field(0),
      messagingRoot: Field(0),
      auditChainHash: Field(0),
      blockHeight: Field(0),
    });
    const root = state.computeRoot();
    // Should be a valid non-zero Poseidon hash
    expect(root.toBigInt()).not.toBe(0n);
  });
});

describe('ChainOutput — unit tests', () => {
  test('creates ChainOutput with all 5 fields', () => {
    const output = new ChainOutput({
      globalStateRoot: Field(111),
      blockHeight: Field(0),
      registryRoot: Field(222),
      lifecycleRoot: Field(333),
      walletCount: Field(5),
    });
    expect(output.globalStateRoot.toString()).toBe('111');
    expect(output.blockHeight.toString()).toBe('0');
    expect(output.registryRoot.toString()).toBe('222');
    expect(output.lifecycleRoot.toString()).toBe('333');
    expect(output.walletCount.toString()).toBe('5');
  });

  test('ChainOutput with genesis values', () => {
    const output = new ChainOutput({
      globalStateRoot: Poseidon.hash([Field(42)]),
      blockHeight: Field(0),
      registryRoot: Field(0),
      lifecycleRoot: Field(0),
      walletCount: Field(0),
    });
    expect(output.blockHeight.toString()).toBe('0');
    expect(output.walletCount.toString()).toBe('0');
  });
});

// ═══════════════════════════════════════════════════════════
//  B. RECURSIVE PROOF TESTS — Full 3-Tier zkTrident Chain
//
//  StateTransitionProof → BatchProof → ChainProof
//
//  Previously blocked by Pickles dummy-proof bug (o1js #1939) when
//  BatchProgram had heterogeneous methods. Fixed via uniform pair
//  pattern: both wrapPair and mergeBatches take exactly 2 proofs.
//
//  Run:
//  $env:NODE_OPTIONS="--max-old-space-size=12288"; npx jest tests/chain-program.test.ts --verbose --maxWorkers=1
// ═══════════════════════════════════════════════════════════

// ─── Test Data ──────────────────────────────────────────

const mem = () => {
  const m = process.memoryUsage();
  return `heap=${(m.heapUsed / 1024 / 1024).toFixed(0)}MB rss=${(m.rss / 1024 / 1024).toFixed(0)}MB`;
};
const secs = (t: number) => ((Date.now() - t) / 1000).toFixed(1);

const chainMember1: MemberLocalData = {
  cardholderId: 'CHAIN_CARD_001',
  dateOfBirth: '19850315',
  genderCode: 1,
  firstName: 'Alice',
  lastName: 'Chain',
};
const chainMember2: MemberLocalData = {
  cardholderId: 'CHAIN_CARD_002',
  dateOfBirth: '19900710',
  genderCode: 2,
  firstName: 'Bob',
  lastName: 'Chain',
};
const chainMember3: MemberLocalData = {
  cardholderId: 'CHAIN_CARD_003',
  dateOfBirth: '19880520',
  genderCode: 1,
  firstName: 'Charlie',
  lastName: 'Chain',
};
const chainMember4: MemberLocalData = {
  cardholderId: 'CHAIN_CARD_004',
  dateOfBirth: '19950101',
  genderCode: 2,
  firstName: 'Diana',
  lastName: 'Chain',
};

const CHAIN_KEY_1 = 'cK1#xP3$zL6nQ9wR4jF8';
const CHAIN_KEY_2 = 'dB4@mR5%sK8nJ0xW3pL9';
const CHAIN_KEY_3 = 'eC6!fH9^gJ2kL5mN7pQ0';
const CHAIN_KEY_4 = 'fD7@nS0^hK3lM6oP8qR1';

// Admin state fields (constant across tests — not modified by state transitions)
const adminPkHash = Poseidon.hash([Field(42)]);
const benefitPlanRoot = Poseidon.hash([Field(100)]);
const credentialRegistryRoot = Poseidon.hash([Field(200)]);
const eligibilityVkHash = Poseidon.hash([Field(300)]);
const messagingRoot = Poseidon.hash([Field(400)]);
const auditChainHash = Poseidon.hash([Field(500)]);

describe('ChainProgram — 3-tier recursive proofs (zkTrident chain)', () => {
  // Trees for state tracking
  let regTree: MerkleTree;
  let lcTree: MerkleTree;

  // Stored proofs for multi-test flow
  let batchProof1: BatchProof;  // genesis batch (2 registrations)
  let batchProof2: BatchProof;  // advance batch (2 more registrations)
  let batchProof3: BatchProof;  // wallet update batch (registration + update)
  let genesisChainProof: ChainProof;
  let block1ChainProof: ChainProof;

  let walletId1: Field;

  beforeAll(async () => {
    const t0 = Date.now();
    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log('║  3-TIER CHAIN COMPILATION (zkTrident)             ║');
    console.log('╚══════════════════════════════════════════════════╝\n');

    console.log(`[compile] StateTransitionProgram... (${mem()})`);
    let t = Date.now();
    await StateTransitionProgram.compile();
    console.log(`[compile] StateTransitionProgram DONE in ${secs(t)}s (${mem()})\n`);

    console.log(`[compile] BatchProgram (uniform pair)... (${mem()})`);
    t = Date.now();
    await BatchProgram.compile();
    console.log(`[compile] BatchProgram DONE in ${secs(t)}s (${mem()})\n`);

    console.log(`[compile] ChainProgram... (${mem()})`);
    t = Date.now();
    await ChainProgram.compile();
    console.log(`[compile] ChainProgram DONE in ${secs(t)}s (${mem()})\n`);

    console.log(`✓ Total compilation: ${secs(t0)}s — ready for 3-tier proofs\n`);

    // Initialize trees
    regTree = new MerkleTree(WALLET_TREE_HEIGHT);
    lcTree = new MerkleTree(WALLET_TREE_HEIGHT);

    // ── Generate BatchProof #1: 2 registrations (for genesis) ──
    console.log(`[setup] Generating BatchProof #1 (2 registrations)...`);
    t = Date.now();

    walletId1 = deriveMemberWalletId(chainMember1, CHAIN_KEY_1, Field(0));
    const pre1 = memberWalletPreimage(chainMember1, CHAIN_KEY_1, Field(0));
    const st1 = await StateTransitionProgram.proveRegistration(
      DOMAIN_TAG_MEMBER,
      pre1[0]!, pre1[1]!, pre1[2]!, pre1[3]!, pre1[4]!, pre1[5]!,
      new WalletRegistryWitness(regTree.getWitness(0n)),
      new LifecycleWitness(lcTree.getWitness(0n)),
      regTree.getRoot(), lcTree.getRoot(),
    );
    regTree.setLeaf(0n, Poseidon.hash([walletId1, EMPTY_CREDENTIAL_ROOT, Field(0)]));
    lcTree.setLeaf(0n, lifecycleLeafCommitment(walletId1, LIFECYCLE_REGISTERED));

    const walletId2 = deriveMemberWalletId(chainMember2, CHAIN_KEY_2, Field(0));
    const pre2 = memberWalletPreimage(chainMember2, CHAIN_KEY_2, Field(0));
    const st2 = await StateTransitionProgram.proveRegistration(
      DOMAIN_TAG_MEMBER,
      pre2[0]!, pre2[1]!, pre2[2]!, pre2[3]!, pre2[4]!, pre2[5]!,
      new WalletRegistryWitness(regTree.getWitness(1n)),
      new LifecycleWitness(lcTree.getWitness(1n)),
      regTree.getRoot(), lcTree.getRoot(),
    );
    regTree.setLeaf(1n, Poseidon.hash([walletId2, EMPTY_CREDENTIAL_ROOT, Field(0)]));
    lcTree.setLeaf(1n, lifecycleLeafCommitment(walletId2, LIFECYCLE_REGISTERED));

    const batch1 = await BatchProgram.wrapPair(st1.proof, st2.proof);
    batchProof1 = batch1.proof as BatchProof;
    console.log(`[setup] BatchProof #1 done in ${secs(t)}s (${mem()})\n`);

    // ── Generate BatchProof #2: 2 more registrations (for advance) ──
    console.log(`[setup] Generating BatchProof #2 (2 registrations)...`);
    t = Date.now();

    const walletId3 = deriveMemberWalletId(chainMember3, CHAIN_KEY_3, Field(0));
    const pre3 = memberWalletPreimage(chainMember3, CHAIN_KEY_3, Field(0));
    const st3 = await StateTransitionProgram.proveRegistration(
      DOMAIN_TAG_MEMBER,
      pre3[0]!, pre3[1]!, pre3[2]!, pre3[3]!, pre3[4]!, pre3[5]!,
      new WalletRegistryWitness(regTree.getWitness(2n)),
      new LifecycleWitness(lcTree.getWitness(2n)),
      regTree.getRoot(), lcTree.getRoot(),
    );
    regTree.setLeaf(2n, Poseidon.hash([walletId3, EMPTY_CREDENTIAL_ROOT, Field(0)]));
    lcTree.setLeaf(2n, lifecycleLeafCommitment(walletId3, LIFECYCLE_REGISTERED));

    const walletId4 = deriveMemberWalletId(chainMember4, CHAIN_KEY_4, Field(0));
    const pre4 = memberWalletPreimage(chainMember4, CHAIN_KEY_4, Field(0));
    const st4 = await StateTransitionProgram.proveRegistration(
      DOMAIN_TAG_MEMBER,
      pre4[0]!, pre4[1]!, pre4[2]!, pre4[3]!, pre4[4]!, pre4[5]!,
      new WalletRegistryWitness(regTree.getWitness(3n)),
      new LifecycleWitness(lcTree.getWitness(3n)),
      regTree.getRoot(), lcTree.getRoot(),
    );
    regTree.setLeaf(3n, Poseidon.hash([walletId4, EMPTY_CREDENTIAL_ROOT, Field(0)]));
    lcTree.setLeaf(3n, lifecycleLeafCommitment(walletId4, LIFECYCLE_REGISTERED));

    const batch2 = await BatchProgram.wrapPair(st3.proof, st4.proof);
    batchProof2 = batch2.proof as BatchProof;
    console.log(`[setup] BatchProof #2 done in ${secs(t)}s (${mem()})\n`);

    // ── Generate BatchProof #3: registration + wallet update (for block 2) ──
    console.log(`[setup] Generating BatchProof #3 (registration + wallet update)...`);
    t = Date.now();

    // Register a new member at slot 4
    const chainMember5: MemberLocalData = {
      cardholderId: 'CHAIN_CARD_005',
      dateOfBirth: '20000301',
      genderCode: 1,
      firstName: 'Eve',
      lastName: 'Chain',
    };
    const chainKey5 = 'gE8!oT1^iU4vX7yZ0aB2';
    const walletId5 = deriveMemberWalletId(chainMember5, chainKey5, Field(0));
    const pre5 = memberWalletPreimage(chainMember5, chainKey5, Field(0));
    const st5 = await StateTransitionProgram.proveRegistration(
      DOMAIN_TAG_MEMBER,
      pre5[0]!, pre5[1]!, pre5[2]!, pre5[3]!, pre5[4]!, pre5[5]!,
      new WalletRegistryWitness(regTree.getWitness(4n)),
      new LifecycleWitness(lcTree.getWitness(4n)),
      regTree.getRoot(), lcTree.getRoot(),
    );
    regTree.setLeaf(4n, Poseidon.hash([walletId5, EMPTY_CREDENTIAL_ROOT, Field(0)]));
    lcTree.setLeaf(4n, lifecycleLeafCommitment(walletId5, LIFECYCLE_REGISTERED));

    // Wallet update for member1 at slot 0
    const pre1update = memberWalletPreimage(chainMember1, CHAIN_KEY_1, Field(0));
    const newCredRoot = Poseidon.hash([Field(7777)]);
    const st6 = await StateTransitionProgram.proveWalletUpdate(
      DOMAIN_TAG_MEMBER,
      pre1update[0]!, pre1update[1]!, pre1update[2]!, pre1update[3]!, pre1update[4]!, pre1update[5]!,
      EMPTY_CREDENTIAL_ROOT, Field(0), newCredRoot,
      new WalletRegistryWitness(regTree.getWitness(0n)),
      new LifecycleWitness(lcTree.getWitness(0n)),
      regTree.getRoot(), lcTree.getRoot(),
      LIFECYCLE_REGISTERED,
    );
    regTree.setLeaf(0n, Poseidon.hash([walletId1, newCredRoot, Field(1)]));

    const batch3 = await BatchProgram.wrapPair(st5.proof, st6.proof);
    batchProof3 = batch3.proof as BatchProof;
    console.log(`[setup] BatchProof #3 done in ${secs(t)}s (${mem()})\n`);

    console.log(`✓ All 3 BatchProofs generated — ready for ChainProgram tests\n`);
  }, 1_200_000); // 20 min for full compilation + proof generation

  // 05-R01
  test('genesis: creates block 0 from first batch', async () => {
    const t = Date.now();
    console.log(`\n── 05-R01: genesis (${mem()}) ──`);

    const result = await ChainProgram.genesis(
      batchProof1,
      adminPkHash,
      benefitPlanRoot,
      credentialRegistryRoot,
      eligibilityVkHash,
      messagingRoot,
      auditChainHash,
    );
    console.log(`[05-R01] genesis done in ${secs(t)}s`);

    genesisChainProof = result.proof as ChainProof;
    const output = genesisChainProof.publicOutput as unknown as ChainOutput;

    expect(output.blockHeight.toString()).toBe('0');

    const bOut = batchProof1.publicOutput as unknown as BatchOutput;
    expect(output.walletCount.toString()).toBe(bOut.registrationCount.toString());
    expect(output.registryRoot.toString()).toBe(bOut.newRegistryRoot.toString());
    expect(output.lifecycleRoot.toString()).toBe(bOut.newLifecycleRoot.toString());

    // Verify globalStateRoot matches manual computation
    const expectedRoot = computeGlobalStateRoot(
      bOut.newRegistryRoot,
      bOut.registrationCount,
      adminPkHash,
      bOut.newLifecycleRoot,
      benefitPlanRoot,
      credentialRegistryRoot,
      eligibilityVkHash,
      messagingRoot,
      auditChainHash,
      Field(0), // blockHeight
    );
    expect(output.globalStateRoot.toString()).toBe(expectedRoot.toString());

    console.log(`✓ 05-R01 PASSED in ${secs(t)}s (${mem()})\n`);
  }, 600_000);

  // 05-R02
  test('advance: creates block 1 from genesis + new batch', async () => {
    const t = Date.now();
    console.log(`\n── 05-R02: advance block 1 (${mem()}) ──`);

    const result = await ChainProgram.advance(
      genesisChainProof,
      batchProof2,
      adminPkHash,
      benefitPlanRoot,
      credentialRegistryRoot,
      eligibilityVkHash,
      messagingRoot,
      auditChainHash,
    );
    console.log(`[05-R02] advance done in ${secs(t)}s`);

    block1ChainProof = result.proof as ChainProof;
    const output = block1ChainProof.publicOutput as unknown as ChainOutput;

    // Block height incremented
    expect(output.blockHeight.toString()).toBe('1');

    // Wallet count accumulated: genesis had 2, batch2 has 2 → total 4
    const b2Out = batchProof2.publicOutput as unknown as BatchOutput;
    expect(output.walletCount.toString()).toBe('4');
    expect(output.registryRoot.toString()).toBe(b2Out.newRegistryRoot.toString());
    expect(output.lifecycleRoot.toString()).toBe(b2Out.newLifecycleRoot.toString());

    console.log(`✓ 05-R02 PASSED in ${secs(t)}s (${mem()})\n`);
  }, 600_000);

  // 05-R03
  test('advance: rejects batch with mismatched roots (chain break)', async () => {
    const t = Date.now();
    console.log(`\n── 05-R03: chain break detection (${mem()}) ──`);

    // batchProof1 has old roots from initial state, not from block 1's end state.
    // Attempting to advance from block1ChainProof with batchProof1 should fail.
    await expect(
      ChainProgram.advance(
        block1ChainProof,
        batchProof1, // wrong — old roots don't match block 1's end
        adminPkHash,
        benefitPlanRoot,
        credentialRegistryRoot,
        eligibilityVkHash,
        messagingRoot,
        auditChainHash,
      ),
    ).rejects.toThrow();

    console.log(`✓ 05-R03 PASSED in ${secs(t)}s (${mem()})\n`);
  }, 600_000);

  // 05-R04
  test('advance: block 2 with registration + wallet update', async () => {
    const t = Date.now();
    console.log(`\n── 05-R04: advance block 2 with mixed batch (${mem()}) ──`);

    const result = await ChainProgram.advance(
      block1ChainProof,
      batchProof3,
      adminPkHash,
      benefitPlanRoot,
      credentialRegistryRoot,
      eligibilityVkHash,
      messagingRoot,
      auditChainHash,
    );
    console.log(`[05-R04] advance done in ${secs(t)}s`);

    const output = (result.proof as ChainProof).publicOutput as unknown as ChainOutput;

    // Block height incremented
    expect(output.blockHeight.toString()).toBe('2');

    // batchProof3 has 1 registration + 1 wallet update
    // Previous walletCount was 4, +1 registration = 5
    const b3Out = batchProof3.publicOutput as unknown as BatchOutput;
    expect(b3Out.registrationCount.toString()).toBe('1');
    expect(output.walletCount.toString()).toBe('5');

    console.log(`✓ 05-R04 PASSED in ${secs(t)}s (${mem()})\n`);
  }, 600_000);

  // 05-R05
  test('ChainProof verifies standalone (offline verification)', async () => {
    const t = Date.now();
    console.log(`\n── 05-R05: standalone verification (${mem()}) ──`);

    const isValid = await ChainProgram.verify(genesisChainProof);
    expect(isValid).toBe(true);

    console.log(`✓ 05-R05 PASSED in ${secs(t)}s (${mem()})\n`);
  }, 600_000);

  // 05-R06 (new)
  test('full 3-tier chain end-to-end: ST → Batch → Chain verified', async () => {
    const t = Date.now();
    console.log(`\n── 05-R06: end-to-end 3-tier verification (${mem()}) ──`);

    // Verify block1ChainProof (which wraps genesis + advance)
    const isValid = await ChainProgram.verify(block1ChainProof);
    expect(isValid).toBe(true);

    // The chain: 4 StateTransitionProofs → 2 BatchProofs → 2 ChainProofs
    // This test verifies the full pipeline compiles, proves, and verifies
    const output = block1ChainProof.publicOutput as unknown as ChainOutput;
    expect(output.blockHeight.toString()).toBe('1');
    expect(output.walletCount.toString()).toBe('4');
    expect(output.globalStateRoot.toBigInt()).not.toBe(0n);

    console.log(`✓ 05-R06 PASSED — full 3-tier zkTrident chain verified in ${secs(t)}s (${mem()})\n`);
  }, 600_000);
});
