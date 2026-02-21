/**
 * ChainProgram — GlobalState + ChainOutput + ChainProgram Tests
 *
 * Fast unit tests for GlobalState and ChainOutput Structs.
 * Recursive proof tests are SKIPPED due to a pre-existing
 * BatchProgram.wrapTransition pickles issue (see section B).
 *
 * Run: npx jest tests/chain-program.test.ts --verbose
 */
import { Field, Poseidon } from 'o1js';
import {
  GlobalState,
  computeGlobalStateRoot,
  GLOBAL_STATE_FIELD_COUNT,
  ChainOutput,
} from '../src/l2/global-state.js';

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
//  B. RECURSIVE PROOF TESTS
//
//  BLOCKED: BatchProgram.wrapTransition() fails with a pickles
//  constraint error (Checked.inv assert_non_zero in wrap_main.ml).
//  This is a PRE-EXISTING issue — tests/l2-recursive.test.ts also
//  fails with the same error. Layer3 recursive tests (2-level:
//  ProofGate → StateTransition) pass, but 3-level (→ Batch wrapping)
//  does not. Root cause: o1js 2.13.0 pickles wrapping issue on this
//  platform (Windows 10 / Node.js).
//
//  ChainProgram requires BatchProofs as input, so recursive tests
//  are blocked until BatchProgram.wrapTransition is fixed.
//
//  The ChainProgram code follows the same proven patterns as
//  BatchProgram (which was working before the wrapping issue),
//  and the fast unit tests above validate all Struct/hash logic.
//
//  To run once BatchProgram wrapping is fixed:
//  $env:NODE_OPTIONS="--max-old-space-size=12288"; npx jest tests/chain-program.test.ts --verbose --maxWorkers=1
// ═══════════════════════════════════════════════════════════

describe('ChainProgram — recursive proofs (blocked by BatchProgram wrapping issue)', () => {
  test.skip('genesis: creates block 0 from first batch', () => {
    // Requires: BatchProof from wrapTransition → ChainProgram.genesis
    // Verifies: blockHeight=0, walletCount=registrationCount, globalStateRoot correct
  });

  test.skip('advance: creates block 1 from genesis + new batch', () => {
    // Requires: genesis ChainProof + new BatchProof → ChainProgram.advance
    // Verifies: blockHeight increment, walletCount accumulation, root chaining
  });

  test.skip('advance: rejects batch with mismatched roots (chain break)', () => {
    // Requires: ChainProof + BatchProof with wrong old roots
    // Verifies: assertEquals on batch.oldRegistryRoot == prev.registryRoot
  });

  test.skip('advance: block 2 with wallet update (no registration)', () => {
    // Requires: block 1 ChainProof + wallet update BatchProof
    // Verifies: walletCount unchanged when registrationCount=0
  });

  test.skip('ChainProof verifies standalone (offline verification)', () => {
    // Requires: any valid ChainProof
    // Verifies: ChainProgram.verify(chainProof) === true
  });
});
