import { Field, MerkleTree } from 'o1js';
import { ProofGateProgram } from '../wallets/proof-gate.js';
import {
  WalletRegistry,
  WalletState,
  WalletRegistryWitness,
  WALLET_TREE_HEIGHT,
} from '../wallets/wallet-state.js';
import {
  LifecycleWitness,
  lifecycleLeafCommitment,
} from '../engine/lifecycle.js';
import {
  StateTransitionProgram,
} from '../engine/state-transition.js';
import {
  DOMAIN_TAG_MEMBER,
  DOMAIN_TAG_PRESCRIBER,
  DOMAIN_TAG_PHARMACY,
} from '../wallets/wallet-derivation.js';
import type { ILocalStore } from '../storage/local-store.js';
import { CredentialData } from './credential-data.js';
import { CredentialInventory } from './credential-inventory.js';
import { CredentialProgram, CredentialOperationOutput } from './credential-program.js';
import {
  PortableCredential,
  serializeCredential,
} from './portable-credential.js';

/**
 * Entity type for ProofGateProgram dispatch.
 */
export type EntityType = 'member' | 'prescriber' | 'pharmacy';

/**
 * Result of a mint operation — contains all proofs and metadata.
 */
export interface MintResult {
  /** Proof that the credential was correctly issued into the inventory */
  credentialProof: Awaited<ReturnType<typeof CredentialProgram.proveMint>>['proof'];
  /** Proof that the wallet state was correctly updated (for on-chain settlement) */
  stateProof: Awaited<ReturnType<typeof StateTransitionProgram.proveWalletUpdate>>['proof'];
  /** The slot index where the credential was issued */
  credentialIndex: bigint;
}

/**
 * UserWalletService — orchestrates the user path for credential operations.
 *
 * This is the main entry point for client applications. It combines
 * all the ZK pieces into high-level operations:
 *
 *   mintCredential()         — issue a credential + generate proofs for on-chain settlement
 *   proveCredentialHolding() — prove you hold a specific credential (offline-capable)
 *   proveCredentialByType()  — prove you hold a credential of a specific type (selective disclosure)
 *   exportCredential()       — serialize a proof for NFC/RFID/QR transport
 *
 * Precondition: All ZkPrograms must be compiled before using this service.
 *   await ProofGateProgram.compile();
 *   await CredentialProgram.compile();
 *   await StateTransitionProgram.compile();  // only needed for mintCredential
 */
export class UserWalletService {
  private store: ILocalStore;
  private walletId: Field;
  private inventory: CredentialInventory;
  private registry: WalletRegistry;
  private lifecycleTree: MerkleTree;

  constructor(
    store: ILocalStore,
    walletId: Field,
    inventory: CredentialInventory,
    registry: WalletRegistry,
    lifecycleTree: MerkleTree,
  ) {
    this.store = store;
    this.walletId = walletId;
    this.inventory = inventory;
    this.registry = registry;
    this.lifecycleTree = lifecycleTree;
  }

  /**
   * Generate a ProofGateProof for the wallet owner.
   *
   * @param preimage — the private Fields (from memberWalletPreimage etc.)
   * @param entityType — which ProofGateProgram method to call
   */
  private async generateOwnershipProof(
    preimage: Field[],
    entityType: EntityType,
  ) {
    switch (entityType) {
      case 'member':
        return ProofGateProgram.verifyMember(
          this.walletId,
          preimage[0]!, preimage[1]!, preimage[2]!, preimage[3]!, preimage[4]!,
        );
      case 'prescriber':
        return ProofGateProgram.verifyPrescriber(
          this.walletId,
          preimage[0]!, preimage[1]!, preimage[2]!,
        );
      case 'pharmacy':
        return ProofGateProgram.verifyPharmacy(
          this.walletId,
          preimage[0]!, preimage[1]!, preimage[2]!,
        );
    }
  }

  /**
   * Issue a credential into this wallet's inventory and generate all proofs
   * needed for on-chain settlement.
   *
   * Flow:
   *   1. Generate ProofGateProof (proves wallet ownership for CredentialProgram)
   *   2. CredentialProgram.proveMint (proves correct credential insertion)
   *   3. Update local CredentialInventory
   *   4. StateTransitionProgram.proveWalletUpdate (proves wallet state change,
   *      wallet verification inlined — no ProofGateProof needed)
   *   5. Update local WalletRegistry
   *   6. Store proof metadata via ILocalStore
   *
   * @param preimage — private Fields for ProofGateProgram
   * @param entityType — member/prescriber/pharmacy
   * @param credentialData — the credential to issue
   * @param currentLifecycle — current lifecycle value for this wallet
   */
  async mintCredential(
    preimage: Field[],
    entityType: EntityType,
    credentialData: CredentialData,
    currentLifecycle: Field,
  ): Promise<MintResult> {
    // 1. Generate ownership proof
    const pgResult = await this.generateOwnershipProof(preimage, entityType);

    // 2. Get current inventory state
    const oldInventoryRoot = this.inventory.getRoot();
    const oldNonce = this.registry.getState(this.walletId).nonce;

    // 3. Find next empty slot and generate witness BEFORE issuing
    const credentialIndex = BigInt(this.inventory.count);
    const inventoryWitness = this.inventory.getWitness(credentialIndex);

    // 4. Prove the mint operation
    const credentialResult = await CredentialProgram.proveMint(
      pgResult.proof,
      credentialData,
      inventoryWitness,
      oldInventoryRoot,
    );

    // 5. Actually update local inventory
    this.inventory.mint(credentialData);
    const newInventoryRoot = this.inventory.getRoot();

    // 6. Generate wallet state update proof
    const walletIndex = this.registry.getIndex(this.walletId);
    const registryWitness = this.registry.getWitness(this.walletId);

    const lifecycleLeaf = lifecycleLeafCommitment(this.walletId, currentLifecycle);

    // H6 fix: Validate caller's lifecycle matches current tree state.
    const currentLeaf = this.lifecycleTree.getNode(0, walletIndex);
    if (currentLeaf.toString() !== lifecycleLeaf.toString()) {
      throw new Error(
        `Lifecycle tree mismatch at index ${walletIndex}: caller's currentLifecycle ` +
        `does not match tree state. Tree may be out of sync.`,
      );
    }

    this.lifecycleTree.setLeaf(walletIndex, lifecycleLeaf);
    const lifecycleWitness = new LifecycleWitness(
      this.lifecycleTree.getWitness(walletIndex),
    );

    // Derive domain tag from entityType for multi-entity support
    const domainTag = entityType === 'prescriber' ? DOMAIN_TAG_PRESCRIBER
      : entityType === 'pharmacy' ? DOMAIN_TAG_PHARMACY
      : DOMAIN_TAG_MEMBER;
    // Pad preimage to 5 fields (prescriber/pharmacy have 3, member has 5)
    const p0 = preimage[0] ?? Field(0);
    const p1 = preimage[1] ?? Field(0);
    const p2 = preimage[2] ?? Field(0);
    const p3 = preimage[3] ?? Field(0);
    const p4 = preimage[4] ?? Field(0);

    const stResult = await StateTransitionProgram.proveWalletUpdate(
      domainTag, p0, p1, p2, p3, p4,
      oldInventoryRoot,
      oldNonce,
      newInventoryRoot,
      registryWitness,
      lifecycleWitness,
      this.registry.getRoot(),
      this.lifecycleTree.getRoot(),
      currentLifecycle,
    );

    // 7. Update local registry to reflect new wallet state
    const newNonce = Field(BigInt(oldNonce.toString()) + 1n);
    const newWalletState = new WalletState({
      walletId: this.walletId,
      credentialInventoryRoot: newInventoryRoot,
      nonce: newNonce,
    });
    this.registry.updateState(this.walletId, newWalletState);

    // 8. Store proof metadata
    const proofId = `mint-${credentialIndex}-${Date.now()}`;
    await this.store.saveProof(proofId, JSON.stringify(credentialResult.proof.toJSON()));

    return {
      credentialProof: credentialResult.proof,
      stateProof: stResult.proof,
      credentialIndex,
    };
  }

  /**
   * Prove that this wallet holds a specific credential.
   * Produces a portable CredentialOperationProof for offline verification.
   *
   * Use case: member proves eligibility at pharmacy, or pharmacy proves eScript.
   *
   * @param preimage — private Fields for ProofGateProgram
   * @param entityType — member/prescriber/pharmacy
   * @param credentialIndex — slot index of the credential to prove
   */
  async proveCredentialHolding(
    preimage: Field[],
    entityType: EntityType,
    credentialIndex: bigint,
  ) {
    const pgResult = await this.generateOwnershipProof(preimage, entityType);

    const credential = this.inventory.getCredential(credentialIndex);
    if (!credential) throw new Error(`No credential at index ${credentialIndex}`);

    const inventoryWitness = this.inventory.getWitness(credentialIndex);
    const inventoryRoot = this.inventory.getRoot();

    const result = await CredentialProgram.proveHolding(
      pgResult.proof,
      credential,
      inventoryWitness,
      inventoryRoot,
    );

    return result.proof;
  }

  /**
   * Prove that this wallet holds a credential of a specific type (selective disclosure).
   *
   * Use case: "I have an ELIGIBILITY credential" without revealing which one.
   *
   * @param preimage — private Fields for ProofGateProgram
   * @param entityType — member/prescriber/pharmacy
   * @param credentialIndex — slot index of the credential to prove
   * @param requiredType — CREDENTIAL_TYPE_ELIGIBILITY or CREDENTIAL_TYPE_PRESCRIPTION
   */
  async proveCredentialByType(
    preimage: Field[],
    entityType: EntityType,
    credentialIndex: bigint,
    requiredType: Field,
  ) {
    const pgResult = await this.generateOwnershipProof(preimage, entityType);

    const credential = this.inventory.getCredential(credentialIndex);
    if (!credential) throw new Error(`No credential at index ${credentialIndex}`);

    const inventoryWitness = this.inventory.getWitness(credentialIndex);
    const inventoryRoot = this.inventory.getRoot();

    const result = await CredentialProgram.proveHoldingByType(
      pgResult.proof,
      credential,
      inventoryWitness,
      inventoryRoot,
      requiredType,
    );

    return result.proof;
  }

  /**
   * Export a proof as a PortableCredential for NFC/RFID/QR transport.
   *
   * @param proof — any CredentialOperationProof
   * @param proofType — the type of credential
   * @param vkHash — verification key hash (for offline verifier confirmation)
   * @param expiresAt — optional expiration timestamp
   */
  exportCredential(
    proof: { toJSON(): any; publicOutput: CredentialOperationOutput },
    proofType: PortableCredential['proofType'],
    vkHash: Field,
    expiresAt?: number,
  ): PortableCredential {
    return serializeCredential(proof, proofType, vkHash, expiresAt);
  }

  /** Get the CredentialInventory for direct access */
  getInventory(): CredentialInventory {
    return this.inventory;
  }

  /** Get the number of credentials in this wallet */
  getCredentialCount(): number {
    return this.inventory.count;
  }
}
