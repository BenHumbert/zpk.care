/**
 * L2 Settlement — End-to-End LocalBlockchain Tests
 *
 * Proves the full L2→L1 settlement path:
 *   1. Compile StateTransitionProgram + BatchProgram + CareContract
 *   2. Deploy CareContract on LocalBlockchain (proofsEnabled: true)
 *   3. Generate real StateTransitionProofs
 *   4. Build real BatchProofs (wrap + merge)
 *   5. Call CareContract.settleBatch() on-chain
 *   6. Verify on-chain state updated correctly
 *
 * SEPARATE FILE — proofsEnabled:true conflicts with proofsEnabled:false
 * tests in layer3.test.ts (Mina global state).
 *
 * Run:
 *   $env:NODE_OPTIONS="--max-old-space-size=12288"; npx jest tests/l2-settlement.test.ts --verbose --maxWorkers=1
 *
 * Timing (estimated):
 *   Compilation: ~5-10 min (StateTransition + BatchProgram + CareContract)
 *   Each proof:  ~30-60s
 *   Each settlement tx: ~30-60s
 *   Total: ~15-25 min
 */
import {
  Field,
  Mina,
  PrivateKey,
  AccountUpdate,
  Poseidon,
  MerkleTree,
} from 'o1js';
import { CareContract } from '../src/engine/care-contract.js';
import {
  StateTransitionProgram,
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

describe('L2 Settlement — End-to-End on LocalBlockchain', () => {
  // Blockchain & contract
  let deployer: Mina.TestPublicKey;
  let admin: Mina.TestPublicKey;
  let contractKey: PrivateKey;
  let contract: CareContract;
  let adminPkHash: Field;

  // Trees — track state across tests
  let regTree: MerkleTree;
  let lcTree: MerkleTree;

  // Wallet IDs
  let walletId1: Field;
  let walletId2: Field;

  // Stored proofs for multi-test flow
  let registrationBatchProof1: BatchProof;
  let walletUpdateBatchProof: BatchProof;

  beforeAll(async () => {
    const t0 = Date.now();
    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log('║  L2 SETTLEMENT — END-TO-END COMPILATION          ║');
    console.log('╚══════════════════════════════════════════════════╝\n');

    // Compile all programs
    console.log(`[compile] StateTransitionProgram... (${mem()})`);
    let t = Date.now();
    await StateTransitionProgram.compile();
    console.log(`[compile] StateTransitionProgram DONE in ${secs(t)}s (${mem()})\n`);

    console.log(`[compile] BatchProgram (RECURSIVE)... (${mem()})`);
    t = Date.now();
    await BatchProgram.compile();
    console.log(`[compile] BatchProgram DONE in ${secs(t)}s (${mem()})\n`);

    console.log(`[compile] CareContract... (${mem()})`);
    t = Date.now();
    await CareContract.compile();
    console.log(`[compile] CareContract DONE in ${secs(t)}s (${mem()})\n`);

    console.log(`✓ Total compilation: ${secs(t0)}s — ready for settlement tests\n`);

    // Set up LocalBlockchain with proofs enabled
    const local = await Mina.LocalBlockchain({ proofsEnabled: true });
    Mina.setActiveInstance(local);

    [deployer, admin] = local.testAccounts;
    contractKey = PrivateKey.random();
    contract = new CareContract(contractKey.toPublicKey());
    adminPkHash = Poseidon.hash(admin.toFields());

    // Initialize trees
    regTree = new MerkleTree(WALLET_TREE_HEIGHT);
    lcTree = new MerkleTree(WALLET_TREE_HEIGHT);

    // Deploy
    console.log(`[setup] Deploying CareContract... (${mem()})`);
    t = Date.now();
    const deployTx = await Mina.transaction(deployer, async () => {
      AccountUpdate.fundNewAccount(deployer);
      await contract.deploy();
    });
    await deployTx.prove();
    await deployTx.sign([deployer.key, contractKey]).send();
    console.log(`[setup] Deploy DONE in ${secs(t)}s\n`);

    // Initialize state
    console.log(`[setup] Initializing CareContract state...`);
    t = Date.now();
    const initTx = await Mina.transaction(admin, async () => {
      await contract.initState(
        adminPkHash,
        regTree.getRoot(),
        lcTree.getRoot(),
      );
    });
    await initTx.prove();
    await initTx.sign([admin.key]).send();
    console.log(`[setup] InitState DONE in ${secs(t)}s\n`);

    console.log(`✓ CareContract deployed and initialized — ready for tests\n`);
  }, 900_000); // 15 min for compilation + deploy

  // ─── Test 1: Verify initial state ─────────────────────

  test('CareContract initialized with correct state', () => {
    expect(contract.walletRegistryRoot.get().toString())
      .toBe(regTree.getRoot().toString());
    expect(contract.lifecycleRoot.get().toString())
      .toBe(lcTree.getRoot().toString());
    expect(contract.walletCount.get().toString()).toBe('0');
    expect(contract.adminPublicKeyHash.get().toString())
      .toBe(adminPkHash.toString());
  });

  // ─── Test 2: Settle single-proof batch (registration) ─

  test('settles a single registration proof on-chain', async () => {
    const t = Date.now();
    console.log(`\n── Test 2: Single registration settlement (${mem()}) ──`);

    walletId1 = deriveMemberWalletId(member1, ENROLLMENT_KEY_1);
    const preimage = memberWalletPreimage(member1, ENROLLMENT_KEY_1);

    // Generate StateTransitionProof (registration)
    console.log(`[test2] Generating StateTransitionProof (registration)...`);
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
    console.log(`[test2] StateTransitionProof done in ${secs(s)}s`);

    // Update local trees to match proof output
    const walletCommitment = Poseidon.hash([walletId1, EMPTY_CREDENTIAL_ROOT, Field(0)]);
    regTree.setLeaf(0n, walletCommitment);
    const lcLeaf = lifecycleLeafCommitment(walletId1, LIFECYCLE_REGISTERED);
    lcTree.setLeaf(0n, lcLeaf);

    // Wrap into BatchProof
    console.log(`[test2] Wrapping into BatchProof...`);
    s = Date.now();
    const batchResult = await BatchProgram.wrapTransition(stResult.proof);
    console.log(`[test2] wrapTransition done in ${secs(s)}s`);

    registrationBatchProof1 = batchResult.proof as BatchProof;
    const batchOutput = registrationBatchProof1.publicOutput as unknown as BatchOutput;

    // Verify batch output
    expect(batchOutput.registrationCount.toString()).toBe('1');
    expect(batchOutput.transitionCount.toString()).toBe('1');

    // Settle on-chain via CareContract.settleBatch()
    console.log(`[test2] Settling on LocalBlockchain...`);
    s = Date.now();
    const tx = await Mina.transaction(admin, async () => {
      await contract.settleBatch(registrationBatchProof1);
    });
    await tx.prove();
    await tx.sign([admin.key]).send();
    console.log(`[test2] Settlement tx done in ${secs(s)}s`);

    // Verify on-chain state
    expect(contract.walletRegistryRoot.get().toString())
      .toBe(regTree.getRoot().toString());
    expect(contract.lifecycleRoot.get().toString())
      .toBe(lcTree.getRoot().toString());
    expect(contract.walletCount.get().toString()).toBe('1');

    console.log(`✓ Test 2 PASSED in ${secs(t)}s (${mem()})\n`);
  }, 600_000);

  // ─── Test 3: Settle merged batch (registration + wallet update) ─

  test('settles a merged batch (registration + wallet update) on-chain', async () => {
    const t = Date.now();
    console.log(`\n── Test 3: Merged batch settlement (${mem()}) ──`);

    // --- Part A: Register member2 ---
    walletId2 = deriveMemberWalletId(member2, ENROLLMENT_KEY_2);
    const preimage2 = memberWalletPreimage(member2, ENROLLMENT_KEY_2);

    console.log(`[test3a] Generating StateTransitionProof (registration member2)...`);
    let s = Date.now();
    const regWitness2 = new WalletRegistryWitness(regTree.getWitness(1n));
    const lcWitness2 = new LifecycleWitness(lcTree.getWitness(1n));

    const stResult2 = await StateTransitionProgram.proveRegistration(
      DOMAIN_TAG_MEMBER,
      preimage2[0]!, preimage2[1]!, preimage2[2]!, preimage2[3]!, preimage2[4]!,
      regWitness2,
      lcWitness2,
      regTree.getRoot(),
      lcTree.getRoot(),
    );
    console.log(`[test3a] StateTransitionProof done in ${secs(s)}s`);

    // Update local trees
    const walletCommitment2 = Poseidon.hash([walletId2, EMPTY_CREDENTIAL_ROOT, Field(0)]);
    regTree.setLeaf(1n, walletCommitment2);
    const lcLeaf2 = lifecycleLeafCommitment(walletId2, LIFECYCLE_REGISTERED);
    lcTree.setLeaf(1n, lcLeaf2);

    // Wrap registration into BatchProof
    console.log(`[test3a] Wrapping into BatchProof...`);
    s = Date.now();
    const batchResult2 = await BatchProgram.wrapTransition(stResult2.proof);
    const regBatchProof2 = batchResult2.proof as BatchProof;
    console.log(`[test3a] wrapTransition done in ${secs(s)}s`);

    // --- Part B: Update member1's wallet (add credential) ---
    const preimage1 = memberWalletPreimage(member1, ENROLLMENT_KEY_1);
    const newCredentialRoot = Poseidon.hash([Field(42)]);

    console.log(`[test3b] Generating StateTransitionProof (wallet update member1)...`);
    s = Date.now();
    const regWitness1 = new WalletRegistryWitness(regTree.getWitness(0n));
    const lcWitness1 = new LifecycleWitness(lcTree.getWitness(0n));

    const stResult1 = await StateTransitionProgram.proveWalletUpdate(
      DOMAIN_TAG_MEMBER,
      preimage1[0]!, preimage1[1]!, preimage1[2]!, preimage1[3]!, preimage1[4]!,
      EMPTY_CREDENTIAL_ROOT,  // oldCredentialRoot
      Field(0),         // oldNonce
      newCredentialRoot,       // newCredentialRoot
      regWitness1,
      lcWitness1,
      regTree.getRoot(),
      lcTree.getRoot(),
      LIFECYCLE_REGISTERED,
    );
    console.log(`[test3b] StateTransitionProof done in ${secs(s)}s`);

    // Update local registry tree for new wallet state
    const newCommitment1 = Poseidon.hash([walletId1, newCredentialRoot, Field(1)]);
    regTree.setLeaf(0n, newCommitment1);

    // Wrap wallet update into BatchProof
    console.log(`[test3b] Wrapping into BatchProof...`);
    s = Date.now();
    const batchResult1 = await BatchProgram.wrapTransition(stResult1.proof);
    walletUpdateBatchProof = batchResult1.proof as BatchProof;
    console.log(`[test3b] wrapTransition done in ${secs(s)}s`);

    // --- Part C: Merge the two batch proofs ---
    console.log(`[test3c] Merging two BatchProofs...`);
    s = Date.now();
    const mergedResult = await BatchProgram.mergeBatches(
      regBatchProof2,
      walletUpdateBatchProof,
    );
    const mergedProof = mergedResult.proof as BatchProof;
    console.log(`[test3c] mergeBatches done in ${secs(s)}s`);

    const mergedOutput = mergedProof.publicOutput as unknown as BatchOutput;
    expect(mergedOutput.registrationCount.toString()).toBe('1'); // 1 reg + 0 update
    expect(mergedOutput.transitionCount.toString()).toBe('2');

    // --- Part D: Settle merged batch on-chain ---
    console.log(`[test3d] Settling merged batch on LocalBlockchain...`);
    s = Date.now();
    const tx = await Mina.transaction(admin, async () => {
      await contract.settleBatch(mergedProof);
    });
    await tx.prove();
    await tx.sign([admin.key]).send();
    console.log(`[test3d] Settlement tx done in ${secs(s)}s`);

    // Verify on-chain state
    expect(contract.walletRegistryRoot.get().toString())
      .toBe(regTree.getRoot().toString());
    expect(contract.lifecycleRoot.get().toString())
      .toBe(lcTree.getRoot().toString());
    expect(contract.walletCount.get().toString()).toBe('2'); // was 1, +1 registration

    console.log(`✓ Test 3 PASSED in ${secs(t)}s (${mem()})\n`);
  }, 900_000);

  // ─── Test 4: Reject stale batch (root mismatch) ─────────

  test('rejects a batch with stale roots (state already changed)', async () => {
    const t = Date.now();
    console.log(`\n── Test 4: Stale batch rejection (${mem()}) ──`);

    // Generate a valid proof from current state
    const member3: MemberLocalData = {
      cardholderId: 'CARD555555555',
      dateOfBirth: '20000101',
      genderCode: 1,
      firstName: 'Bob',
      lastName: 'Test',
    };
    const preimage3 = memberWalletPreimage(member3, ENROLLMENT_KEY_1);

    console.log(`[test4] Generating StateTransitionProof...`);
    let s = Date.now();
    const regWitness = new WalletRegistryWitness(regTree.getWitness(2n));
    const lcWitness = new LifecycleWitness(lcTree.getWitness(2n));

    const stResult = await StateTransitionProgram.proveRegistration(
      DOMAIN_TAG_MEMBER,
      preimage3[0]!, preimage3[1]!, preimage3[2]!, preimage3[3]!, preimage3[4]!,
      regWitness,
      lcWitness,
      regTree.getRoot(),
      lcTree.getRoot(),
    );
    console.log(`[test4] StateTransitionProof done in ${secs(s)}s`);

    // Wrap into BatchProof (valid proof at this point)
    console.log(`[test4] Wrapping into BatchProof...`);
    s = Date.now();
    const batchResult = await BatchProgram.wrapTransition(stResult.proof);
    const staleBatchProof = batchResult.proof as BatchProof;
    console.log(`[test4] wrapTransition done in ${secs(s)}s`);

    // Now, settle a DIFFERENT batch first to mutate on-chain state
    // Generate another proof and settle it, making the staleBatchProof's old roots stale
    const member4: MemberLocalData = {
      cardholderId: 'CARD444444444',
      dateOfBirth: '19950601',
      genderCode: 2,
      firstName: 'Alice',
      lastName: 'Stale',
    };
    const preimage4 = memberWalletPreimage(member4, ENROLLMENT_KEY_2);
    const walletId4 = deriveMemberWalletId(member4, ENROLLMENT_KEY_2);

    // This proof uses the same trees (slot 2) — but we'll settle it first
    // Actually, we need a proof that uses a DIFFERENT slot to not conflict
    // with the stale proof. Use slot 3 for this intervening proof.
    const regWitness4 = new WalletRegistryWitness(regTree.getWitness(3n));
    const lcWitness4 = new LifecycleWitness(lcTree.getWitness(3n));

    console.log(`[test4] Generating intervening proof...`);
    s = Date.now();
    const stResult4 = await StateTransitionProgram.proveRegistration(
      DOMAIN_TAG_MEMBER,
      preimage4[0]!, preimage4[1]!, preimage4[2]!, preimage4[3]!, preimage4[4]!,
      regWitness4,
      lcWitness4,
      regTree.getRoot(),
      lcTree.getRoot(),
    );
    console.log(`[test4] Intervening proof done in ${secs(s)}s`);

    // Update trees for the intervening registration
    const walletCommitment4 = Poseidon.hash([walletId4, EMPTY_CREDENTIAL_ROOT, Field(0)]);
    regTree.setLeaf(3n, walletCommitment4);
    const lcLeaf4 = lifecycleLeafCommitment(walletId4, LIFECYCLE_REGISTERED);
    lcTree.setLeaf(3n, lcLeaf4);

    // Wrap and settle the intervening proof
    console.log(`[test4] Wrapping and settling intervening proof...`);
    s = Date.now();
    const interveningBatch = await BatchProgram.wrapTransition(stResult4.proof);
    const interveningProof = interveningBatch.proof as BatchProof;

    const tx1 = await Mina.transaction(admin, async () => {
      await contract.settleBatch(interveningProof);
    });
    await tx1.prove();
    await tx1.sign([admin.key]).send();
    console.log(`[test4] Intervening settlement done in ${secs(s)}s`);

    // Now the on-chain roots have changed. The staleBatchProof's oldRoots
    // no longer match. Attempting to settle should fail.
    console.log(`[test4] Attempting to settle stale batch (should fail)...`);
    await expect(async () => {
      const tx2 = await Mina.transaction(admin, async () => {
        await contract.settleBatch(staleBatchProof);
      });
      await tx2.prove();
      await tx2.sign([admin.key]).send();
    }).rejects.toThrow();

    console.log(`✓ Test 4 PASSED — stale batch correctly rejected in ${secs(t)}s (${mem()})\n`);
  }, 900_000);

  // ─── Test 5: Sequential batches chain correctly ────────

  test('sequential batches chain from previous settlement state', async () => {
    const t = Date.now();
    console.log(`\n── Test 5: Sequential batch chaining (${mem()}) ──`);

    // Current on-chain state has 3 wallets (member1, member2, member4 from test 4)
    // and regTree/lcTree are up to date.
    // Slot 2 is still empty (the stale proof from test 4 was rejected).
    // Let's register in slot 2 now.

    const member5: MemberLocalData = {
      cardholderId: 'CARD666666666',
      dateOfBirth: '19880220',
      genderCode: 1,
      firstName: 'Charlie',
      lastName: 'Chain',
    };
    const preimage5 = memberWalletPreimage(member5, ENROLLMENT_KEY_1);
    const walletId5 = deriveMemberWalletId(member5, ENROLLMENT_KEY_1);

    console.log(`[test5] Generating StateTransitionProof (registration slot 2)...`);
    let s = Date.now();
    const regWitness = new WalletRegistryWitness(regTree.getWitness(2n));
    const lcWitness = new LifecycleWitness(lcTree.getWitness(2n));

    const stResult = await StateTransitionProgram.proveRegistration(
      DOMAIN_TAG_MEMBER,
      preimage5[0]!, preimage5[1]!, preimage5[2]!, preimage5[3]!, preimage5[4]!,
      regWitness,
      lcWitness,
      regTree.getRoot(),
      lcTree.getRoot(),
    );
    console.log(`[test5] StateTransitionProof done in ${secs(s)}s`);

    // Update local trees
    const walletCommitment5 = Poseidon.hash([walletId5, EMPTY_CREDENTIAL_ROOT, Field(0)]);
    regTree.setLeaf(2n, walletCommitment5);
    const lcLeaf5 = lifecycleLeafCommitment(walletId5, LIFECYCLE_REGISTERED);
    lcTree.setLeaf(2n, lcLeaf5);

    // Wrap and settle
    console.log(`[test5] Wrapping and settling...`);
    s = Date.now();
    const batchResult = await BatchProgram.wrapTransition(stResult.proof);
    const batchProof = batchResult.proof as BatchProof;

    const tx = await Mina.transaction(admin, async () => {
      await contract.settleBatch(batchProof);
    });
    await tx.prove();
    await tx.sign([admin.key]).send();
    console.log(`[test5] Settlement done in ${secs(s)}s`);

    // Verify: walletCount should be 4 now (1 from test2, 1 from test3, 1 from test4, 1 from test5)
    expect(contract.walletRegistryRoot.get().toString())
      .toBe(regTree.getRoot().toString());
    expect(contract.lifecycleRoot.get().toString())
      .toBe(lcTree.getRoot().toString());
    expect(contract.walletCount.get().toString()).toBe('4');

    console.log(`✓ Test 5 PASSED in ${secs(t)}s (${mem()})\n`);
  }, 600_000);
});
