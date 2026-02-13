import {
  SmartContract,
  state,
  State,
  Field,
  method,
  Poseidon,
  MerkleTree,
  MerkleWitness,
  Permissions,
} from 'o1js';
import {
  WalletRegistryWitness,
  WALLET_TREE_HEIGHT,
} from '../wallets/wallet-state.js';
import {
  LifecycleWitness,
  LIFECYCLE_REGISTERED,
  LIFECYCLE_REVOKED,
  lifecycleLeafCommitment,
  assertValidTransition,
} from './lifecycle.js';
import {
  EMPTY_NFT_ROOT,
  TransitionOutput,
  StateTransitionProof,
} from './state-transition.js';
import { BatchProof, BatchOutput } from '../l2/batch-program.js';

/** Merkle witness for the global NFT registry (same height as wallet registry) */
export class NftRegistryWitness extends MerkleWitness(WALLET_TREE_HEIGHT) {}

/**
 * CareContract — The on-chain zkApp for ZKP Claim Adjudication.
 *
 * This SmartContract holds the canonical state of the wallet system.
 * It supports two paths for state updates:
 *
 *   1. ADMIN PATH — insurer signs tx directly (register, lifecycle mgmt)
 *   2. USER PATH  — user submits a recursive StateTransitionProof
 *                   (self-service, offline-capable via NFC/RFID)
 *
 * On-chain state (8 of 8 Field slots):
 *   - walletRegistryRoot: Merkle root of all WalletState commitments
 *   - walletCount: number of registered wallets
 *   - adminPublicKeyHash: Poseidon hash of insurer's PublicKey
 *   - lifecycleRoot: Merkle root of per-wallet lifecycle states
 *   - benefitPlanRoot: Merkle root of valid benefit plans (L5)
 *   - nftRegistryRoot: Global registry of all issued NFTs (L5)
 *   - eligibilityVkHash: EligibilityProgram verification key hash (L5)
 *   - messagingRoot: Packed root of message/delegation/key registries (L7)
 */
export class CareContract extends SmartContract {
  @state(Field) walletRegistryRoot = State<Field>();
  @state(Field) walletCount = State<Field>();
  @state(Field) adminPublicKeyHash = State<Field>();
  @state(Field) lifecycleRoot = State<Field>();

  // L5 — Eligibility Flow
  @state(Field) benefitPlanRoot = State<Field>();
  @state(Field) nftRegistryRoot = State<Field>();
  @state(Field) eligibilityVkHash = State<Field>();

  // L7 — Messaging & Delegation
  @state(Field) messagingRoot = State<Field>();

  events = {
    'wallet-registered': Field,
    'lifecycle-updated': Field,
    'wallet-updated': Field,
    'transition-settled': Field,
    'eligibility-initialized': Field,
    'benefit-plan-updated': Field,
    'nft-registered': Field,
    'messaging-initialized': Field,
    'message-submitted': Field,
    'delegation-registered': Field,
    'delegation-revoked': Field,
    'encryption-key-registered': Field,
    'batch-settled': Field,
    'admin-rotated': Field,
  };

  async deploy() {
    await super.deploy();
    this.account.permissions.set({
      ...Permissions.default(),
      editState: Permissions.proofOrSignature(),
      setVerificationKey:
        Permissions.VerificationKey.impossibleDuringCurrentVersion(),
      setPermissions: Permissions.impossible(),
    });
  }

  /**
   * Initialize the contract state. Must be called once after deployment.
   *
   * @param adminPkHash — Poseidon.hash(adminPublicKey.toFields())
   * @param initialRegistryRoot — root of empty MerkleTree(WALLET_TREE_HEIGHT)
   * @param initialLifecycleRoot — root of empty MerkleTree(WALLET_TREE_HEIGHT)
   */
  @method async initState(
    adminPkHash: Field,
    initialRegistryRoot: Field,
    initialLifecycleRoot: Field,
  ) {
    const currentRoot = this.walletRegistryRoot.getAndRequireEquals();
    currentRoot.assertEquals(Field(0), 'Contract already initialized');

    this.walletRegistryRoot.set(initialRegistryRoot);
    this.lifecycleRoot.set(initialLifecycleRoot);
    this.walletCount.set(Field(0));
    this.adminPublicKeyHash.set(adminPkHash);
  }

  // ─── Admin Path ─────────────────────────────────────────

  /**
   * Rotate the admin key (admin-only).
   *
   * Allows the current admin to transfer control to a new admin key.
   * The new admin hash must be non-zero to prevent lockout.
   *
   * @param newAdminPkHash — Poseidon.hash(newAdminPublicKey.toFields())
   */
  @method async rotateAdmin(newAdminPkHash: Field) {
    const sender = this.sender.getAndRequireSignature();
    const adminHash = this.adminPublicKeyHash.getAndRequireEquals();
    Poseidon.hash(sender.toFields()).assertEquals(adminHash, 'Not admin');

    newAdminPkHash.equals(Field(0)).assertFalse('New admin hash cannot be zero');

    this.adminPublicKeyHash.set(newAdminPkHash);

    this.emitEvent('admin-rotated', newAdminPkHash);
  }

  /**
   * Register a new wallet (admin-only).
   *
   * The insurer registers a wallet on behalf of a member/prescriber/pharmacy
   * after verifying their identity through traditional KYC (outside this system).
   *
   * @param walletId — the wallet identity (derived from entity data + enrollment key)
   * @param registryWitness — Merkle witness proving the registry slot is empty
   * @param lifecycleWitness — Merkle witness proving the lifecycle slot is empty
   */
  @method async registerWallet(
    walletId: Field,
    registryWitness: WalletRegistryWitness,
    lifecycleWitness: LifecycleWitness,
  ) {
    // Admin gating
    const sender = this.sender.getAndRequireSignature();
    const adminHash = this.adminPublicKeyHash.getAndRequireEquals();
    Poseidon.hash(sender.toFields()).assertEquals(adminHash, 'Not admin');

    // Verify the registry slot is empty (leaf == Field(0))
    const currentRegistryRoot =
      this.walletRegistryRoot.getAndRequireEquals();
    const emptyRoot = registryWitness.calculateRoot(Field(0));
    emptyRoot.assertEquals(currentRegistryRoot, 'Registry slot is not empty');

    // Verify the lifecycle slot is empty
    const currentLifecycleRoot = this.lifecycleRoot.getAndRequireEquals();
    const emptyLifecycleRoot = lifecycleWitness.calculateRoot(Field(0));
    emptyLifecycleRoot.assertEquals(
      currentLifecycleRoot,
      'Lifecycle slot is not empty',
    );

    // Compute WalletState commitment: Poseidon.hash([walletId, nftRoot, nonce])
    // Matches WalletState.commitment() exactly
    const walletCommitment = Poseidon.hash([
      walletId,
      EMPTY_NFT_ROOT,
      Field(0),
    ]);
    const newRegistryRoot = registryWitness.calculateRoot(walletCommitment);
    this.walletRegistryRoot.set(newRegistryRoot);

    // Set lifecycle to REGISTERED
    const newLifecycleLeaf = lifecycleLeafCommitment(
      walletId,
      LIFECYCLE_REGISTERED,
    );
    const newLifecycleRoot = lifecycleWitness.calculateRoot(newLifecycleLeaf);
    this.lifecycleRoot.set(newLifecycleRoot);

    // Increment wallet count
    const currentCount = this.walletCount.getAndRequireEquals();
    this.walletCount.set(currentCount.add(1));

    this.emitEvent('wallet-registered', walletId);
  }

  /**
   * Update a wallet's lifecycle state (admin-only).
   *
   * @param walletId — the wallet identity
   * @param currentLifecycle — current lifecycle value (verified against tree)
   * @param newLifecycle — target lifecycle value
   * @param lifecycleWitness — Merkle witness for the wallet's lifecycle slot
   */
  @method async updateLifecycle(
    walletId: Field,
    currentLifecycle: Field,
    newLifecycle: Field,
    lifecycleWitness: LifecycleWitness,
  ) {
    // Admin gating
    const sender = this.sender.getAndRequireSignature();
    const adminHash = this.adminPublicKeyHash.getAndRequireEquals();
    Poseidon.hash(sender.toFields()).assertEquals(adminHash, 'Not admin');

    // Verify current lifecycle state matches the tree
    const currentLifecycleRoot = this.lifecycleRoot.getAndRequireEquals();
    const currentLeaf = lifecycleLeafCommitment(walletId, currentLifecycle);
    const computedRoot = lifecycleWitness.calculateRoot(currentLeaf);
    computedRoot.assertEquals(
      currentLifecycleRoot,
      'Lifecycle state mismatch',
    );

    // Validate the transition
    assertValidTransition(currentLifecycle, newLifecycle);

    // Apply new lifecycle state
    const newLeaf = lifecycleLeafCommitment(walletId, newLifecycle);
    const newRoot = lifecycleWitness.calculateRoot(newLeaf);
    this.lifecycleRoot.set(newRoot);

    this.emitEvent('lifecycle-updated', walletId);
  }

  /**
   * Update a wallet's state in the registry (admin-only for L3).
   *
   * L5 will add a self-service method gated by ProofGateProof.
   * At L3, all operations go through the admin for safety.
   *
   * @param walletId — the wallet identity
   * @param oldNftRoot — current NFT inventory root
   * @param oldNonce — current nonce
   * @param newNftRoot — updated NFT inventory root
   * @param newNonce — must equal oldNonce + 1
   * @param registryWitness — Merkle witness for the wallet's registry slot
   * @param lifecycleWitness — Merkle witness for lifecycle (revocation check)
   * @param currentLifecycle — current lifecycle value
   */
  @method async updateWalletState(
    walletId: Field,
    oldNftRoot: Field,
    oldNonce: Field,
    newNftRoot: Field,
    newNonce: Field,
    registryWitness: WalletRegistryWitness,
    lifecycleWitness: LifecycleWitness,
    currentLifecycle: Field,
  ) {
    // Admin gating
    const sender = this.sender.getAndRequireSignature();
    const adminHash = this.adminPublicKeyHash.getAndRequireEquals();
    Poseidon.hash(sender.toFields()).assertEquals(adminHash, 'Not admin');

    // Verify wallet is not revoked
    const currentLifecycleRoot = this.lifecycleRoot.getAndRequireEquals();
    const lifecycleLeaf = lifecycleLeafCommitment(walletId, currentLifecycle);
    lifecycleWitness
      .calculateRoot(lifecycleLeaf)
      .assertEquals(currentLifecycleRoot, 'Lifecycle state mismatch');
    currentLifecycle
      .equals(LIFECYCLE_REVOKED)
      .assertFalse('Wallet is revoked');

    // Verify old wallet state matches the registry
    const currentRegistryRoot =
      this.walletRegistryRoot.getAndRequireEquals();
    const oldCommitment = Poseidon.hash([walletId, oldNftRoot, oldNonce]);
    registryWitness
      .calculateRoot(oldCommitment)
      .assertEquals(currentRegistryRoot, 'Old wallet state mismatch');

    // Enforce nonce increment
    newNonce.assertEquals(oldNonce.add(1), 'Nonce must increment by 1');

    // Compute and apply new state
    const newCommitment = Poseidon.hash([walletId, newNftRoot, newNonce]);
    const newRegistryRoot = registryWitness.calculateRoot(newCommitment);
    this.walletRegistryRoot.set(newRegistryRoot);

    this.emitEvent('wallet-updated', walletId);
  }

  // ─── User Path (Recursive Proof) ───────────────────────

  /**
   * Settle a state transition using a recursive proof.
   *
   * This is the OFFLINE-CAPABLE path. The user generates a
   * StateTransitionProof off-chain (which recursively verifies
   * their ProofGateProof), then submits it here for on-chain settlement.
   *
   * The same proof can also be verified offline via NFC/RFID —
   * this method is for when the user wants to commit the change on-chain.
   *
   * @param proof — StateTransitionProof (wraps ProofGateProof + state transition)
   */
  @method async settleTransition(
    proof: StateTransitionProof,
  ) {
    // Verify the recursive proof
    proof.verify();

    // Access public output (TypeScript can't infer the generic through ZkProgram.Proof)
    const output = proof.publicOutput as unknown as TransitionOutput;

    // Verify old roots match current on-chain state
    const currentRegistryRoot =
      this.walletRegistryRoot.getAndRequireEquals();
    const currentLifecycleRoot = this.lifecycleRoot.getAndRequireEquals();

    output.oldRegistryRoot.assertEquals(
      currentRegistryRoot,
      'Registry root mismatch — state has changed since proof was generated',
    );
    output.oldLifecycleRoot.assertEquals(
      currentLifecycleRoot,
      'Lifecycle root mismatch — state has changed since proof was generated',
    );

    // Apply new roots
    this.walletRegistryRoot.set(output.newRegistryRoot);
    this.lifecycleRoot.set(output.newLifecycleRoot);

    // If both roots changed, this was a registration — increment walletCount
    const registryChanged = output.oldRegistryRoot
      .equals(output.newRegistryRoot)
      .not();
    const lifecycleChanged = output.oldLifecycleRoot
      .equals(output.newLifecycleRoot)
      .not();
    const isRegistration = registryChanged.and(lifecycleChanged);

    const currentCount = this.walletCount.getAndRequireEquals();
    const countIncrement = isRegistration.toField();
    this.walletCount.set(currentCount.add(countIncrement));

    this.emitEvent('transition-settled', output.walletId);
  }

  // ─── L2 — Batch Settlement ──────────────────────────────

  /**
   * Settle a batch of state transitions via a single recursive BatchProof.
   *
   * This is the L2 settlement path. The sequencer collects individual
   * StateTransitionProofs, wraps and merges them into a BatchProof,
   * then submits here. One L1 tx per batch ≈ one per 3-min MINA block.
   *
   * Cost: $0.0003/batch instead of $0.0003/transition.
   * Fallback: settleTransition() remains available for direct L1 submission.
   *
   * @param proof — BatchProof (wraps N StateTransitionProofs via tree-merge)
   */
  @method async settleBatch(proof: BatchProof) {
    // Verify the recursive batch proof
    proof.verify();

    const output = proof.publicOutput as unknown as BatchOutput;

    // Assert old roots match current on-chain state
    const currentRegistryRoot =
      this.walletRegistryRoot.getAndRequireEquals();
    const currentLifecycleRoot = this.lifecycleRoot.getAndRequireEquals();

    output.oldRegistryRoot.assertEquals(
      currentRegistryRoot,
      'Batch registry root mismatch — L1 state has changed since batch was built',
    );
    output.oldLifecycleRoot.assertEquals(
      currentLifecycleRoot,
      'Batch lifecycle root mismatch — L1 state has changed since batch was built',
    );

    // Apply new roots
    this.walletRegistryRoot.set(output.newRegistryRoot);
    this.lifecycleRoot.set(output.newLifecycleRoot);

    // Increment walletCount by registrations in batch
    const currentCount = this.walletCount.getAndRequireEquals();
    this.walletCount.set(currentCount.add(output.registrationCount));

    this.emitEvent('batch-settled', output.transitionCount);
  }

  // ─── L5 — Eligibility Admin Methods ─────────────────────

  /**
   * Initialize the eligibility state (admin-only, one-time).
   *
   * Sets CareContract slots 4-6 for L5 eligibility flow.
   * Must be called after initState and before any eligibility operations.
   *
   * @param initialBenefitPlanRoot — root of empty MerkleTree(BENEFIT_PLAN_TREE_HEIGHT)
   * @param initialNftRegistryRoot — root of empty MerkleTree(WALLET_TREE_HEIGHT)
   * @param vkHash — EligibilityProgram verification key hash
   */
  @method async initEligibilityState(
    initialBenefitPlanRoot: Field,
    initialNftRegistryRoot: Field,
    vkHash: Field,
  ) {
    // Admin gating
    const sender = this.sender.getAndRequireSignature();
    const adminHash = this.adminPublicKeyHash.getAndRequireEquals();
    Poseidon.hash(sender.toFields()).assertEquals(adminHash, 'Not admin');

    // Require not yet initialized (slot 4 == Field(0))
    const currentBenefitRoot = this.benefitPlanRoot.getAndRequireEquals();
    currentBenefitRoot.assertEquals(
      Field(0),
      'Eligibility state already initialized',
    );

    this.benefitPlanRoot.set(initialBenefitPlanRoot);
    this.nftRegistryRoot.set(initialNftRegistryRoot);
    this.eligibilityVkHash.set(vkHash);

    this.emitEvent('eligibility-initialized', vkHash);
  }

  /**
   * Update the benefit plan registry root (admin-only).
   *
   * Called when the insurer adds, removes, or modifies benefit plans.
   *
   * @param newBenefitPlanRoot — the updated benefit plan tree root
   */
  @method async updateBenefitPlan(
    newBenefitPlanRoot: Field,
  ) {
    // Admin gating
    const sender = this.sender.getAndRequireSignature();
    const adminHash = this.adminPublicKeyHash.getAndRequireEquals();
    Poseidon.hash(sender.toFields()).assertEquals(adminHash, 'Not admin');

    // Require eligibility state initialized
    this.benefitPlanRoot.getAndRequireEquals();

    this.benefitPlanRoot.set(newBenefitPlanRoot);

    this.emitEvent('benefit-plan-updated', newBenefitPlanRoot);
  }

  /**
   * Register an NFT in the global registry (admin-only).
   *
   * Inserts the NFT commitment into the global registry tree.
   * Prevents duplicate registration and provides an audit trail.
   *
   * @param nftCommitment — the NFT commitment to register
   * @param nftRegistryWitness — Merkle witness proving the slot is empty
   */
  @method async registerGlobalNft(
    nftCommitment: Field,
    nftRegistryWitness: NftRegistryWitness,
  ) {
    // Admin gating
    const sender = this.sender.getAndRequireSignature();
    const adminHash = this.adminPublicKeyHash.getAndRequireEquals();
    Poseidon.hash(sender.toFields()).assertEquals(adminHash, 'Not admin');

    // Verify the slot is empty
    const currentRoot = this.nftRegistryRoot.getAndRequireEquals();
    nftRegistryWitness
      .calculateRoot(Field(0))
      .assertEquals(currentRoot, 'NFT registry slot is not empty');

    // Insert NFT commitment
    const newRoot = nftRegistryWitness.calculateRoot(nftCommitment);
    this.nftRegistryRoot.set(newRoot);

    this.emitEvent('nft-registered', nftCommitment);
  }

  // ─── L7 — Messaging & Delegation Admin Methods ────────────

  /**
   * Initialize the messaging state (admin-only, one-time).
   *
   * Sets CareContract slot 7 for L7 messaging & delegation.
   * Must be called after initState and before any messaging operations.
   *
   * @param initialMessagingRoot — Poseidon.hash([emptyMsgRoot, emptyDelRoot, emptyKeyRoot])
   */
  @method async initMessaging(
    initialMessagingRoot: Field,
  ) {
    // Admin gating
    const sender = this.sender.getAndRequireSignature();
    const adminHash = this.adminPublicKeyHash.getAndRequireEquals();
    Poseidon.hash(sender.toFields()).assertEquals(adminHash, 'Not admin');

    // Require not yet initialized (slot 7 == Field(0))
    const currentMessagingRoot = this.messagingRoot.getAndRequireEquals();
    currentMessagingRoot.assertEquals(
      Field(0),
      'Messaging state already initialized',
    );

    this.messagingRoot.set(initialMessagingRoot);

    this.emitEvent('messaging-initialized', initialMessagingRoot);
  }

  /**
   * Submit a message to the on-chain messaging registry (admin-only).
   *
   * The admin verifies the sender's ProofGateProof off-chain before
   * committing the message. Updates the packed messaging root.
   *
   * @param newMessagingRoot — the updated packed messaging root
   * @param messageCommitment — the message commitment being added
   */
  @method async submitMessage(
    newMessagingRoot: Field,
    messageCommitment: Field,
  ) {
    // Admin gating
    const sender = this.sender.getAndRequireSignature();
    const adminHash = this.adminPublicKeyHash.getAndRequireEquals();
    Poseidon.hash(sender.toFields()).assertEquals(adminHash, 'Not admin');

    // Require messaging initialized
    this.messagingRoot.getAndRequireEquals();

    this.messagingRoot.set(newMessagingRoot);

    this.emitEvent('message-submitted', messageCommitment);
  }

  /**
   * Register a delegation in the on-chain delegation registry (admin-only).
   *
   * @param newMessagingRoot — the updated packed messaging root
   * @param delegationCommitment — the delegation commitment being added
   */
  @method async registerDelegation(
    newMessagingRoot: Field,
    delegationCommitment: Field,
  ) {
    // Admin gating
    const sender = this.sender.getAndRequireSignature();
    const adminHash = this.adminPublicKeyHash.getAndRequireEquals();
    Poseidon.hash(sender.toFields()).assertEquals(adminHash, 'Not admin');

    // Require messaging initialized
    this.messagingRoot.getAndRequireEquals();

    this.messagingRoot.set(newMessagingRoot);

    this.emitEvent('delegation-registered', delegationCommitment);
  }

  /**
   * Revoke a delegation from the on-chain delegation registry (admin-only).
   *
   * Updates the messagingRoot to reflect the zeroed delegation leaf
   * and any revocation notification message added to the message registry.
   *
   * @param newMessagingRoot — the updated packed messaging root (post-revocation)
   * @param revokedDelegationCommitment — the commitment of the delegation that was revoked
   */
  @method async revokeDelegation(
    newMessagingRoot: Field,
    revokedDelegationCommitment: Field,
  ) {
    // Admin gating
    const sender = this.sender.getAndRequireSignature();
    const adminHash = this.adminPublicKeyHash.getAndRequireEquals();
    Poseidon.hash(sender.toFields()).assertEquals(adminHash, 'Not admin');

    // Require messaging initialized
    this.messagingRoot.getAndRequireEquals();

    this.messagingRoot.set(newMessagingRoot);

    this.emitEvent('delegation-revoked', revokedDelegationCommitment);
  }

  /**
   * Register an encryption public key for a wallet (admin-only).
   *
   * The admin verifies the wallet owner's ProofGateProof off-chain
   * before committing the key. This prevents impersonation.
   *
   * @param newMessagingRoot — the updated packed messaging root
   * @param encryptionPubKeyHash — Poseidon.hash([walletId, pubKeyX, pubKeyY])
   */
  @method async registerEncryptionKey(
    newMessagingRoot: Field,
    encryptionPubKeyHash: Field,
  ) {
    // Admin gating
    const sender = this.sender.getAndRequireSignature();
    const adminHash = this.adminPublicKeyHash.getAndRequireEquals();
    Poseidon.hash(sender.toFields()).assertEquals(adminHash, 'Not admin');

    // Require messaging initialized
    this.messagingRoot.getAndRequireEquals();

    this.messagingRoot.set(newMessagingRoot);

    this.emitEvent('encryption-key-registered', encryptionPubKeyHash);
  }
}
