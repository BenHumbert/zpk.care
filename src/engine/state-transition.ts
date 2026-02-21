import { Field, Struct, Poseidon, ZkProgram, MerkleTree, Provable } from 'o1js';
import {
  WalletRegistryWitness,
  CREDENTIAL_INVENTORY_HEIGHT,
} from '../wallets/wallet-state.js';
import {
  LifecycleWitness,
  LIFECYCLE_REGISTERED,
  LIFECYCLE_REVOKED,
  lifecycleLeafCommitment,
} from './lifecycle.js';
import {
  DOMAIN_TAG_MEMBER,
  DOMAIN_TAG_PRESCRIBER,
  DOMAIN_TAG_PHARMACY,
} from '../wallets/wallet-derivation.js';

/**
 * Empty credential inventory root — computed once at module load.
 * This is the Merkle root of a tree with all-zero leaves (height 7, 64 slots).
 * Used when creating a fresh WalletState with no credentials.
 */
export const EMPTY_CREDENTIAL_ROOT = new MerkleTree(CREDENTIAL_INVENTORY_HEIGHT).getRoot();

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
 * Compute walletId from domain tag and preimage fields using Provable.switch.
 *
 * Supports three entity types:
 *   - Member (tag=0): Poseidon.hash([0, f0, f1, f2, f3, f4]) — 6 fields
 *   - Prescriber (tag=1): Poseidon.hash([1, f0, f1, f2]) — 4 fields
 *   - Pharmacy (tag=2): Poseidon.hash([2, f0, f1, f2]) — 4 fields
 *
 * All three hash variants are computed inside the circuit; Provable.switch
 * selects the correct one based on domainTag. Non-member entities pass
 * Field(0) for unused f3/f4 — these zeros are included in the member hash
 * but the switch ensures the correct (shorter) hash is selected.
 *
 * @param domainTag — Field(0)=member, Field(1)=prescriber, Field(2)=pharmacy
 * @param f0..f4 — preimage fields (padded with Field(0) for non-members)
 */
function computeWalletId(
  domainTag: Field,
  f0: Field, f1: Field, f2: Field, f3: Field, f4: Field,
): Field {
  // Compute all three hash variants
  const memberHash = Poseidon.hash([DOMAIN_TAG_MEMBER, f0, f1, f2, f3, f4]);
  const prescriberHash = Poseidon.hash([DOMAIN_TAG_PRESCRIBER, f0, f1, f2]);
  const pharmacyHash = Poseidon.hash([DOMAIN_TAG_PHARMACY, f0, f1, f2]);

  // Select the correct one via domain tag
  const isMember = domainTag.equals(DOMAIN_TAG_MEMBER);
  const isPrescriber = domainTag.equals(DOMAIN_TAG_PRESCRIBER);
  const isPharmacy = domainTag.equals(DOMAIN_TAG_PHARMACY);

  // At least one must be true
  isMember.or(isPrescriber).or(isPharmacy).assertTrue('Invalid domain tag');

  return Provable.switch(
    [isMember, isPrescriber, isPharmacy],
    Field,
    [memberHash, prescriberHash, pharmacyHash],
  );
}

/**
 * StateTransitionProgram — ZkProgram for portable proofs.
 *
 * Each method:
 *   1. Verifies wallet ownership inline (Poseidon hash of preimage fields)
 *   2. Proves the state transition is valid (Merkle witness checks)
 *   3. Returns a TransitionOutput that can be verified anywhere
 *
 * Supports all entity types (member, prescriber, pharmacy) via domainTag
 * private input and Provable.switch for walletId computation.
 *
 * The resulting proof is SELF-CONTAINED — it wraps wallet ownership
 * AND state validity into a single proof. No internet needed to verify.
 *
 * NOTE: Wallet verification is inlined (not recursive via ProofGateProof)
 * to keep the proof chain at 2 levels, avoiding a Pickles wrap_main.ml
 * bug where maxProofsVerified=2 fails at recursion depth >= 2.
 * ProofGateProgram still exists for standalone wallet ownership proofs
 * (NFC/RFID verification, etc.).
 *
 * Flow: StateTransitionProof (depth 0) → BatchProof (depth 1) → settle on-chain
 */
export const StateTransitionProgram = ZkProgram({
  name: 'StateTransition',
  publicOutput: TransitionOutput,

  methods: {
    /**
     * Prove a valid wallet registration.
     *
     * Takes the entity's domain tag and preimage fields as private inputs,
     * computes the walletId inline via Provable.switch (supporting member,
     * prescriber, and pharmacy entity types), then proves the wallet was
     * correctly added to an empty slot in both the registry and lifecycle trees.
     *
     * After: registry has new WalletState, lifecycle is REGISTERED.
     *
     * @param domainTag — Field(0)=member, Field(1)=prescriber, Field(2)=pharmacy
     * @param f0..f4 — preimage fields (non-members pad unused fields with Field(0))
     */
    proveRegistration: {
      privateInputs: [
        Field, // domainTag
        Field, // f0 (cardholderIdHash / qualifierCode)
        Field, // f1 (dateOfBirth / prescriberIdHash / serviceProviderIdHash)
        Field, // f2 (firstNameHash / enrollmentKeyHash)
        Field, // f3 (lastNameHash / Field(0) for non-member)
        Field, // f4 (enrollmentKeyHash / Field(0) for non-member)
        WalletRegistryWitness,
        LifecycleWitness,
        Field, // currentRegistryRoot
        Field, // currentLifecycleRoot
      ],
      async method(
        domainTag: Field,
        f0: Field,
        f1: Field,
        f2: Field,
        f3: Field,
        f4: Field,
        registryWitness: WalletRegistryWitness,
        lifecycleWitness: LifecycleWitness,
        currentRegistryRoot: Field,
        currentLifecycleRoot: Field,
      ) {
        // 1. Compute wallet identity inline via domain-tag switch
        const walletId = computeWalletId(domainTag, f0, f1, f2, f3, f4);

        // 2. Verify the registry slot is empty
        const emptyRegistryRoot = registryWitness.calculateRoot(Field(0));
        emptyRegistryRoot.assertEquals(
          currentRegistryRoot,
          'Registry slot is not empty',
        );

        // 3. Compute new WalletState commitment and insert
        //    Matches WalletState.commitment(): Poseidon.hash([walletId, credentialRoot, nonce])
        const walletCommitment = Poseidon.hash([
          walletId,
          EMPTY_CREDENTIAL_ROOT,
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
     * Takes the entity's domain tag and preimage fields as private inputs,
     * computes the walletId inline via Provable.switch, checks the wallet
     * is not revoked, verifies the old state matches, enforces nonce
     * increment, and computes the new registry root.
     *
     * Lifecycle root is unchanged (state updates don't affect lifecycle).
     */
    proveWalletUpdate: {
      privateInputs: [
        Field, // domainTag
        Field, // f0
        Field, // f1
        Field, // f2
        Field, // f3
        Field, // f4
        Field, // oldCredentialRoot
        Field, // oldNonce
        Field, // newCredentialRoot
        WalletRegistryWitness,
        LifecycleWitness,
        Field, // currentRegistryRoot
        Field, // currentLifecycleRoot
        Field, // currentLifecycle (to verify not revoked)
      ],
      async method(
        domainTag: Field,
        f0: Field,
        f1: Field,
        f2: Field,
        f3: Field,
        f4: Field,
        oldCredentialRoot: Field,
        oldNonce: Field,
        newCredentialRoot: Field,
        registryWitness: WalletRegistryWitness,
        lifecycleWitness: LifecycleWitness,
        currentRegistryRoot: Field,
        currentLifecycleRoot: Field,
        currentLifecycle: Field,
      ) {
        // 1. Compute wallet identity inline via domain-tag switch
        const walletId = computeWalletId(domainTag, f0, f1, f2, f3, f4);

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
        const oldCommitment = Poseidon.hash([walletId, oldCredentialRoot, oldNonce]);
        const computedRegistryRoot =
          registryWitness.calculateRoot(oldCommitment);
        computedRegistryRoot.assertEquals(
          currentRegistryRoot,
          'Old wallet state mismatch',
        );

        // 4. Compute new state with incremented nonce
        const newNonce = oldNonce.add(1);
        const newCommitment = Poseidon.hash([walletId, newCredentialRoot, newNonce]);
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
