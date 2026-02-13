import { Field, Struct, Poseidon, ZkProgram, MerkleTree } from 'o1js';
import { ProofGateProof } from '../wallets/proof-gate.js';
import {
  WalletRegistryWitness,
  NFT_INVENTORY_HEIGHT,
} from '../wallets/wallet-state.js';
import {
  LifecycleWitness,
  LIFECYCLE_REGISTERED,
  LIFECYCLE_REVOKED,
  lifecycleLeafCommitment,
} from './lifecycle.js';

/**
 * Empty NFT inventory root — computed once at module load.
 * This is the Merkle root of a tree with all-zero leaves (height 7, 64 slots).
 * Used when creating a fresh WalletState with no NFTs.
 */
export const EMPTY_NFT_ROOT = new MerkleTree(NFT_INVENTORY_HEIGHT).getRoot();

/**
 * TransitionOutput — public output of every StateTransitionProgram proof.
 *
 * Contains the old and new Merkle roots so the CareContract (or any
 * offline verifier) can:
 *   1. Confirm the old roots match the expected on-chain state
 *   2. Apply the new roots as the updated state
 *
 * This is the PORTABLE CREDENTIAL — it can be verified offline
 * via NFC, RFID, or any device with the verification key.
 */
export class TransitionOutput extends Struct({
  /** The wallet involved in this transition */
  walletId: Field,
  /** Registry root BEFORE the transition */
  oldRegistryRoot: Field,
  /** Registry root AFTER the transition */
  newRegistryRoot: Field,
  /** Lifecycle root BEFORE the transition */
  oldLifecycleRoot: Field,
  /** Lifecycle root AFTER the transition */
  newLifecycleRoot: Field,
}) {}

/**
 * StateTransitionProgram — Recursive ZkProgram for portable proofs.
 *
 * Each method:
 *   1. Verifies a ProofGateProof (recursive proof composition!)
 *   2. Proves the state transition is valid (Merkle witness checks)
 *   3. Returns a TransitionOutput that can be verified anywhere
 *
 * The resulting proof is SELF-CONTAINED — it wraps wallet ownership
 * AND state validity into a single proof. No internet needed to verify.
 *
 * Flow: ProofGateProof → StateTransitionProof → verify offline or settle on-chain
 */
export const StateTransitionProgram = ZkProgram({
  name: 'StateTransition',
  publicOutput: TransitionOutput,

  methods: {
    /**
     * Prove a valid wallet registration.
     *
     * Verifies the user owns the wallet (recursive ProofGateProof),
     * then proves the wallet was correctly added to an empty slot
     * in both the registry and lifecycle trees.
     *
     * After: registry has new WalletState, lifecycle is REGISTERED.
     */
    proveRegistration: {
      privateInputs: [
        ProofGateProof,
        WalletRegistryWitness,
        LifecycleWitness,
        Field, // currentRegistryRoot
        Field, // currentLifecycleRoot
      ],
      async method(
        ownershipProof: InstanceType<typeof ProofGateProof>,
        registryWitness: WalletRegistryWitness,
        lifecycleWitness: LifecycleWitness,
        currentRegistryRoot: Field,
        currentLifecycleRoot: Field,
      ) {
        // 1. Recursively verify wallet ownership
        ownershipProof.verify();
        const walletId = ownershipProof.publicInput;

        // 2. Verify the registry slot is empty
        const emptyRegistryRoot = registryWitness.calculateRoot(Field(0));
        emptyRegistryRoot.assertEquals(
          currentRegistryRoot,
          'Registry slot is not empty',
        );

        // 3. Compute new WalletState commitment and insert
        //    Matches WalletState.commitment(): Poseidon.hash([walletId, nftRoot, nonce])
        const walletCommitment = Poseidon.hash([
          walletId,
          EMPTY_NFT_ROOT,
          Field(0), // nonce = 0 for fresh wallet
        ]);
        const newRegistryRoot = registryWitness.calculateRoot(walletCommitment);

        // 4. Verify the lifecycle slot is empty
        const emptyLifecycleRoot = lifecycleWitness.calculateRoot(Field(0));
        emptyLifecycleRoot.assertEquals(
          currentLifecycleRoot,
          'Lifecycle slot is not empty',
        );

        // 5. Set lifecycle to REGISTERED
        const newLifecycleLeaf = lifecycleLeafCommitment(
          walletId,
          LIFECYCLE_REGISTERED,
        );
        const newLifecycleRoot =
          lifecycleWitness.calculateRoot(newLifecycleLeaf);

        // 6. Return the portable transition output
        return {
          publicOutput: new TransitionOutput({
            walletId,
            oldRegistryRoot: currentRegistryRoot,
            newRegistryRoot,
            oldLifecycleRoot: currentLifecycleRoot,
            newLifecycleRoot,
          }),
        };
      },
    },

    /**
     * Prove a valid wallet state update.
     *
     * Verifies the user owns the wallet (recursive ProofGateProof),
     * checks the wallet is not revoked, verifies the old state matches,
     * enforces nonce increment, and computes the new registry root.
     *
     * Lifecycle root is unchanged (state updates don't affect lifecycle).
     */
    proveWalletUpdate: {
      privateInputs: [
        ProofGateProof,
        Field, // oldNftRoot
        Field, // oldNonce
        Field, // newNftRoot
        WalletRegistryWitness,
        LifecycleWitness,
        Field, // currentRegistryRoot
        Field, // currentLifecycleRoot
        Field, // currentLifecycle (to verify not revoked)
      ],
      async method(
        ownershipProof: InstanceType<typeof ProofGateProof>,
        oldNftRoot: Field,
        oldNonce: Field,
        newNftRoot: Field,
        registryWitness: WalletRegistryWitness,
        lifecycleWitness: LifecycleWitness,
        currentRegistryRoot: Field,
        currentLifecycleRoot: Field,
        currentLifecycle: Field,
      ) {
        // 1. Recursively verify wallet ownership
        ownershipProof.verify();
        const walletId = ownershipProof.publicInput;

        // 2. Verify wallet is not revoked
        const lifecycleLeaf = lifecycleLeafCommitment(
          walletId,
          currentLifecycle,
        );
        const computedLifecycleRoot =
          lifecycleWitness.calculateRoot(lifecycleLeaf);
        computedLifecycleRoot.assertEquals(
          currentLifecycleRoot,
          'Lifecycle state mismatch',
        );
        currentLifecycle
          .equals(LIFECYCLE_REVOKED)
          .assertFalse('Wallet is revoked');

        // 3. Verify old wallet state matches registry
        const oldCommitment = Poseidon.hash([walletId, oldNftRoot, oldNonce]);
        const computedRegistryRoot =
          registryWitness.calculateRoot(oldCommitment);
        computedRegistryRoot.assertEquals(
          currentRegistryRoot,
          'Old wallet state mismatch',
        );

        // 4. Compute new state with incremented nonce
        const newNonce = oldNonce.add(1);
        const newCommitment = Poseidon.hash([walletId, newNftRoot, newNonce]);
        const newRegistryRoot = registryWitness.calculateRoot(newCommitment);

        // 5. Return transition output (lifecycle unchanged)
        return {
          publicOutput: new TransitionOutput({
            walletId,
            oldRegistryRoot: currentRegistryRoot,
            newRegistryRoot,
            oldLifecycleRoot: currentLifecycleRoot,
            newLifecycleRoot: currentLifecycleRoot, // unchanged
          }),
        };
      },
    },
  },
});

/** The proof class for StateTransitionProgram — named class for SmartContract compatibility */
export class StateTransitionProof extends ZkProgram.Proof(StateTransitionProgram) {}
