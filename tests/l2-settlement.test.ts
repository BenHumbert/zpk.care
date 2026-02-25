/**
 * L2 Settlement — End-to-End LocalBlockchain Tests
 *
 * Proves the full L2→L1 settlement path:
 *   1. Compile StateTransitionProgram + BatchProgram + CareContract
 *   2. Deploy CareContract on LocalBlockchain (proofsEnabled: true)
 *   3. Generate real StateTransitionProofs in pairs (wrapPair pattern)
 *   4. Build real BatchProofs (wrapPair + merge)
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
 *   Total: ~20-35 min
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

const member3: MemberLocalData = {
  cardholderId: 'CARD555444333',
  dateOfBirth: '19880520',
  genderCode: 1,
  firstName: 'Bob',
  lastName: 'Johnson',
};

const member4: MemberLocalData = {
  cardholderId: 'CARD111222333',
  dateOfBirth: '19920815',
  genderCode: 2,
  firstName: 'Carol',
  lastName: 'Williams',
};

const member5: MemberLocalData = {
  cardholderId: 'CARD444555666',
  dateOfBirth: '19870310',
  genderCode: 1,
  firstName: 'Dave',
  lastName: 'Brown',
};

const ENROLLMENT_KEY_1 = 'xK9#mP2$vL5nQ8wR3jF7';
const ENROLLMENT_KEY_2 = 'aB3@nR4%tK7mJ9xW2pL8';
const ENROLLMENT_KEY_3 = 'cD5!fH8^gJ1kL4mN6pQ9';
const ENROLLMENT_KEY_4 = 'eF7@hJ2$kL5mN8pQ1rS4';
const ENROLLMENT_KEY_5 = 'gH9#jK3%lM6nP0qR2tU5';
const ENROLLMENT_KEY_6 = 'iJ1!kL4^mN7pQ3rS5tU8';

// ─── Registration Helper ─────────────────────────────────

/** Generate a registration StateTransitionProof and update the trees. */
async function generateRegistration(
  member: MemberLocalData,
  enrollmentKey: string,
  slot: bigint,
  regTree: MerkleTree,
  lcTree: MerkleTree,
): Promise<{ proof: any; walletId: Field }> {
  const walletId = deriveMemberWalletId(member, enrollmentKey);
  const preimage = memberWalletPreimage(member, enrollmentKey);

  const regWitness = new WalletRegistryWitness(regTree.getWitness(slot));
  const lcWitness = new LifecycleWitness(lcTree.getWitness(slot));

  const result = await StateTransitionProgram.proveRegistration(
    DOMAIN_TAG_MEMBER,
    preimage[0]!, preimage[1]!, preimage[2]!, preimage[3]!, preimage[4]!,
    regWitness,
    lcWitness,
    regTree.getRoot(),
    lcTree.getRoot(),
  );

  // Update trees to reflect registration
  const walletCommitment = Poseidon.hash([walletId, EMPTY_CREDENTIAL_ROOT, Field(0)]);
  regTree.setLeaf(slot, walletCommitment);
  const lcLeaf = lifecycleLeafCommitment(walletId, LIFECYCLE_REGISTERED);
  lcTree.setLeaf(slot, lcLeaf);

  return { proof: result.proof, walletId };
}

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

  // Wallet IDs tracked across tests
  let walletId1: Field;

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

    console.log(`[compile] BatchProgram (RECURSIVE, uniform pair)... (${mem()})`);
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

  // ─── Test 2: Settle paired registration batch ─────────

  test('settles a paired registration batch (wrapPair) on-chain', async () => {
    const t = Date.now();
    console.log(`\n── Test 2: Paired registration settlement (${mem()}) ──`);

    // Register member1 at slot 0
    console.log(`[test2] Generating StateTransitionProof #1 (register member1)...`);
    let s = Date.now();
    const reg1 = await generateRegistration(member1, ENROLLMENT_KEY_1, 0n, regTree, lcTree);
    walletId1 = reg1.walletId;
    console.log(`[test2] ST proof #1 done in ${secs(s)}s`);

    // Register member2 at slot 1
    console.log(`[test2] Generating StateTransitionProof #2 (register member2)...`);
    s = Date.now();
    const reg2 = await generateRegistration(member2, ENROLLMENT_KEY_2, 1n, regTree, lcTree);
    console.log(`[test2] ST proof #2 done in ${secs(s)}s`);

    // wrapPair: wrap both registrations
    console.log(`[test2] wrapPair (2 registration proofs)...`);
    s = Date.now();
    const batchResult = await BatchProgram.wrapPair(reg1.proof, reg2.proof);
    const batchProof = batchResult.proof as BatchProof;
    console.log(`[test2] wrapPair done in ${secs(s)}s`);

    const batchOutput = batchProof.publicOutput as unknown as BatchOutput;
    expect(batchOutput.registrationCount.toString()).toBe('2');
    expect(batchOutput.transitionCount.toString()).toBe('2');

    // Settle on-chain via CareContract.settleBatch()
    console.log(`[test2] Settling on LocalBlockchain...`);
    s = Date.now();
    const tx = await Mina.transaction(admin, async () => {
      await contract.settleBatch(batchProof);
    });
    await tx.prove();
    await tx.sign([admin.key]).send();
    console.log(`[test2] Settlement tx done in ${secs(s)}s`);

    // Verify on-chain state
    expect(contract.walletRegistryRoot.get().toString())
      .toBe(regTree.getRoot().toString());
    expect(contract.lifecycleRoot.get().toString())
      .toBe(lcTree.getRoot().toString());
    expect(contract.walletCount.get().toString()).toBe('2');

    console.log(`✓ Test 2 PASSED in ${secs(t)}s (${mem()})\n`);
  }, 600_000);

  // ─── Test 3: Settle merged batch (2 wrapPairs) ────────

  test('settles a merged batch (2 wrapPairs merged) on-chain', async () => {
    const t = Date.now();
    console.log(`\n── Test 3: Merged batch settlement (${mem()}) ──`);

    // --- Pair A: Register member3 at slot 2 + member4 at slot 3 ---
    console.log(`[test3a] Pair A: register member3 + member4...`);
    let s = Date.now();
    const reg3 = await generateRegistration(member3, ENROLLMENT_KEY_3, 2n, regTree, lcTree);
    const reg4 = await generateRegistration(member4, ENROLLMENT_KEY_4, 3n, regTree, lcTree);

    const pairA = await BatchProgram.wrapPair(reg3.proof, reg4.proof);
    const pairAProof = pairA.proof as BatchProof;
    console.log(`[test3a] Pair A done in ${secs(s)}s`);

    // --- Pair B: Register member5 at slot 4 + wallet update member1 at slot 0 ---
    console.log(`[test3b] Pair B: register member5 + wallet update member1...`);
    s = Date.now();
    const reg5 = await generateRegistration(member5, ENROLLMENT_KEY_5, 4n, regTree, lcTree);

    // Wallet update for member1 (already registered at slot 0)
    const preimage1 = memberWalletPreimage(member1, ENROLLMENT_KEY_1);
    const newCredentialRoot = Poseidon.hash([Field(42)]);
    const regWitness1 = new WalletRegistryWitness(regTree.getWitness(0n));
    const lcWitness1 = new LifecycleWitness(lcTree.getWitness(0n));

    const stUpdate = await StateTransitionProgram.proveWalletUpdate(
      DOMAIN_TAG_MEMBER,
      preimage1[0]!, preimage1[1]!, preimage1[2]!, preimage1[3]!, preimage1[4]!,
      EMPTY_CREDENTIAL_ROOT,   // oldCredentialRoot
      Field(0),                // oldNonce
      newCredentialRoot,       // newCredentialRoot
      regWitness1,
      lcWitness1,
      regTree.getRoot(),
      lcTree.getRoot(),
      LIFECYCLE_REGISTERED,
    );

    // Update local registry tree for new wallet state
    const newCommitment1 = Poseidon.hash([walletId1, newCredentialRoot, Field(1)]);
    regTree.setLeaf(0n, newCommitment1);

    const pairB = await BatchProgram.wrapPair(reg5.proof, stUpdate.proof);
    const pairBProof = pairB.proof as BatchProof;
    console.log(`[test3b] Pair B done in ${secs(s)}s`);

    // --- Merge Pair A + Pair B ---
    console.log(`[test3c] Merging Pair A + Pair B...`);
    s = Date.now();
    const mergedResult = await BatchProgram.mergeBatches(pairAProof, pairBProof);
    const mergedProof = mergedResult.proof as BatchProof;
    console.log(`[test3c] mergeBatches done in ${secs(s)}s`);

    const mergedOutput = mergedProof.publicOutput as unknown as BatchOutput;
    expect(mergedOutput.registrationCount.toString()).toBe('3'); // 2 from A + 1 from B
    expect(mergedOutput.transitionCount.toString()).toBe('4');   // 2 + 2

    // --- Settle merged batch on-chain ---
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
    expect(contract.walletCount.get().toString()).toBe('5'); // was 2, +3 registrations

    console.log(`✓ Test 3 PASSED in ${secs(t)}s (${mem()})\n`);
  }, 900_000);

  // ─── Test 4: Reject stale batch (root mismatch) ─────────

  test('rejects a batch with stale roots (state already changed)', async () => {
    const t = Date.now();
    console.log(`\n── Test 4: Stale batch rejection (${mem()}) ──`);

    // Current tree: slots 0-4 filled (slot 0 has updated member1).
    // Generate a STALE batch from current state, then settle a different batch first.

    // --- Stale pair: register at slots 5,6 ---
    console.log(`[test4] Generating stale pair (slots 5,6)...`);
    let s = Date.now();

    const staleMember1: MemberLocalData = {
      cardholderId: 'CARD_STALE_001',
      dateOfBirth: '19930101',
      genderCode: 1,
      firstName: 'Stale',
      lastName: 'One',
    };
    const staleMember2: MemberLocalData = {
      cardholderId: 'CARD_STALE_002',
      dateOfBirth: '19940201',
      genderCode: 2,
      firstName: 'Stale',
      lastName: 'Two',
    };

    const staleReg1 = await generateRegistration(
      staleMember1, ENROLLMENT_KEY_1, 5n, regTree, lcTree,
    );
    const staleReg2 = await generateRegistration(
      staleMember2, ENROLLMENT_KEY_2, 6n, regTree, lcTree,
    );
    const staleBatch = await BatchProgram.wrapPair(staleReg1.proof, staleReg2.proof);
    const staleBatchProof = staleBatch.proof as BatchProof;
    console.log(`[test4] Stale pair done in ${secs(s)}s`);

    // Reset tree: undo slots 5,6 (restore to pre-stale state)
    regTree.setLeaf(5n, Field(0));
    lcTree.setLeaf(5n, Field(0));
    regTree.setLeaf(6n, Field(0));
    lcTree.setLeaf(6n, Field(0));

    // --- Intervening pair: register at slots 7,8 from original state ---
    console.log(`[test4] Generating intervening pair (slots 7,8)...`);
    s = Date.now();

    const interMember1: MemberLocalData = {
      cardholderId: 'CARD_INTER_001',
      dateOfBirth: '19960301',
      genderCode: 1,
      firstName: 'Inter',
      lastName: 'One',
    };
    const interMember2: MemberLocalData = {
      cardholderId: 'CARD_INTER_002',
      dateOfBirth: '19970401',
      genderCode: 2,
      firstName: 'Inter',
      lastName: 'Two',
    };

    const interReg1 = await generateRegistration(
      interMember1, ENROLLMENT_KEY_3, 7n, regTree, lcTree,
    );
    const interReg2 = await generateRegistration(
      interMember2, ENROLLMENT_KEY_4, 8n, regTree, lcTree,
    );
    const interBatch = await BatchProgram.wrapPair(interReg1.proof, interReg2.proof);
    const interBatchProof = interBatch.proof as BatchProof;
    console.log(`[test4] Intervening pair done in ${secs(s)}s`);

    // Settle the intervening batch first
    console.log(`[test4] Settling intervening batch...`);
    s = Date.now();
    const tx1 = await Mina.transaction(admin, async () => {
      await contract.settleBatch(interBatchProof);
    });
    await tx1.prove();
    await tx1.sign([admin.key]).send();
    console.log(`[test4] Intervening settlement done in ${secs(s)}s`);

    expect(contract.walletCount.get().toString()).toBe('7'); // 5 + 2

    // Now try to settle the stale batch — should fail (old roots don't match)
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

    // Current state: slots 0-4, 7, 8 filled. Slots 5, 6 empty (stale rejected).
    // walletCount = 7. Fill slots 5,6 now.

    const seqMember1: MemberLocalData = {
      cardholderId: 'CARD_SEQ_001',
      dateOfBirth: '19980501',
      genderCode: 1,
      firstName: 'Seq',
      lastName: 'One',
    };
    const seqMember2: MemberLocalData = {
      cardholderId: 'CARD_SEQ_002',
      dateOfBirth: '19990601',
      genderCode: 2,
      firstName: 'Seq',
      lastName: 'Two',
    };

    console.log(`[test5] Generating paired registration (slots 5,6)...`);
    let s = Date.now();
    const seqReg1 = await generateRegistration(
      seqMember1, ENROLLMENT_KEY_5, 5n, regTree, lcTree,
    );
    const seqReg2 = await generateRegistration(
      seqMember2, ENROLLMENT_KEY_6, 6n, regTree, lcTree,
    );
    const seqBatch = await BatchProgram.wrapPair(seqReg1.proof, seqReg2.proof);
    const seqBatchProof = seqBatch.proof as BatchProof;
    console.log(`[test5] wrapPair done in ${secs(s)}s`);

    // Settle
    console.log(`[test5] Settling...`);
    s = Date.now();
    const tx = await Mina.transaction(admin, async () => {
      await contract.settleBatch(seqBatchProof);
    });
    await tx.prove();
    await tx.sign([admin.key]).send();
    console.log(`[test5] Settlement done in ${secs(s)}s`);

    // Verify: walletCount = 7 + 2 = 9
    expect(contract.walletRegistryRoot.get().toString())
      .toBe(regTree.getRoot().toString());
    expect(contract.lifecycleRoot.get().toString())
      .toBe(lcTree.getRoot().toString());
    expect(contract.walletCount.get().toString()).toBe('9');

    console.log(`✓ Test 5 PASSED in ${secs(t)}s (${mem()})\n`);
  }, 600_000);
});
