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
import type { ILocalStore } from '../storage/local-store.js';
import { NftData } from './nft-data.js';
import { NftInventory } from './nft-inventory.js';
import { NftProgram, NftOperationOutput } from './nft-program.js';
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
  /** Proof that the NFT was correctly minted into the inventory */
  nftProof: Awaited<ReturnType<typeof NftProgram.proveMint>>['proof'];
  /** Proof that the wallet state was correctly updated (for on-chain settlement) */
  stateProof: Awaited<ReturnType<typeof StateTransitionProgram.proveWalletUpdate>>['proof'];
  /** The slot index where the NFT was minted */
  nftIndex: bigint;
}

/**
 * UserWalletService — orchestrates the user path for NFT operations.
 *
 * This is the main entry point for client applications. It combines
 * all the ZK pieces into high-level operations:
 *
 *   mintNft()         — mint an NFT + generate proofs for on-chain settlement
 *   proveNftHolding() — prove you hold a specific NFT (offline-capable)
 *   proveNftByType()  — prove you hold an NFT of a specific type (selective disclosure)
 *   exportCredential() — serialize a proof for NFC/RFID/QR transport
 *
 * Precondition: All ZkPrograms must be compiled before using this service.
 *   await ProofGateProgram.compile();
 *   await NftProgram.compile();
 *   await StateTransitionProgram.compile();  // only needed for mintNft
 */
export class UserWalletService {
  private store: ILocalStore;
  private walletId: Field;
  private inventory: NftInventory;
  private registry: WalletRegistry;
  private lifecycleTree: MerkleTree;

  constructor(
    store: ILocalStore,
    walletId: Field,
    inventory: NftInventory,
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
   * Mint an NFT into this wallet's inventory and generate all proofs
   * needed for on-chain settlement.
   *
   * Flow:
   *   1. Generate ProofGateProof (proves wallet ownership)
   *   2. NftProgram.proveMint (proves correct NFT insertion)
   *   3. Update local NftInventory
   *   4. StateTransitionProgram.proveWalletUpdate (proves wallet state change)
   *   5. Update local WalletRegistry
   *   6. Store proof metadata via ILocalStore
   *
   * @param preimage — private Fields for ProofGateProgram
   * @param entityType — member/prescriber/pharmacy
   * @param nftData — the NFT to mint
   * @param currentLifecycle — current lifecycle value for this wallet
   */
  async mintNft(
    preimage: Field[],
    entityType: EntityType,
    nftData: NftData,
    currentLifecycle: Field,
  ): Promise<MintResult> {
    // 1. Generate ownership proof
    const pgResult = await this.generateOwnershipProof(preimage, entityType);

    // 2. Get current inventory state
    const oldInventoryRoot = this.inventory.getRoot();
    const oldNonce = this.registry.getState(this.walletId).nonce;

    // 3. Find next empty slot and generate witness BEFORE minting
    const nftIndex = BigInt(this.inventory.count);
    const inventoryWitness = this.inventory.getWitness(nftIndex);

    // 4. Prove the mint operation
    const nftResult = await NftProgram.proveMint(
      pgResult.proof,
      nftData,
      inventoryWitness,
      oldInventoryRoot,
    );

    // 5. Actually update local inventory
    this.inventory.mint(nftData);
    const newInventoryRoot = this.inventory.getRoot();

    // 6. Generate wallet state update proof
    const walletIndex = this.registry.getIndex(this.walletId);
    const registryWitness = this.registry.getWitness(this.walletId);

    const lifecycleLeaf = lifecycleLeafCommitment(this.walletId, currentLifecycle);
    this.lifecycleTree.setLeaf(walletIndex, lifecycleLeaf);
    const lifecycleWitness = new LifecycleWitness(
      this.lifecycleTree.getWitness(walletIndex),
    );

    const stResult = await StateTransitionProgram.proveWalletUpdate(
      pgResult.proof,
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
      nftInventoryRoot: newInventoryRoot,
      nonce: newNonce,
    });
    this.registry.updateState(this.walletId, newWalletState);

    // 8. Store proof metadata
    const proofId = `mint-${nftIndex}-${Date.now()}`;
    await this.store.saveProof(proofId, JSON.stringify(nftResult.proof.toJSON()));

    return {
      nftProof: nftResult.proof,
      stateProof: stResult.proof,
      nftIndex,
    };
  }

  /**
   * Prove that this wallet holds a specific NFT.
   * Produces a portable NftOperationProof for offline verification.
   *
   * Use case: member proves eligibility at pharmacy, or pharmacy proves eScript.
   *
   * @param preimage — private Fields for ProofGateProgram
   * @param entityType — member/prescriber/pharmacy
   * @param nftIndex — slot index of the NFT to prove
   */
  async proveNftHolding(
    preimage: Field[],
    entityType: EntityType,
    nftIndex: bigint,
  ) {
    const pgResult = await this.generateOwnershipProof(preimage, entityType);

    const nft = this.inventory.getNft(nftIndex);
    if (!nft) throw new Error(`No NFT at index ${nftIndex}`);

    const inventoryWitness = this.inventory.getWitness(nftIndex);
    const inventoryRoot = this.inventory.getRoot();

    const result = await NftProgram.proveHolding(
      pgResult.proof,
      nft,
      inventoryWitness,
      inventoryRoot,
    );

    return result.proof;
  }

  /**
   * Prove that this wallet holds an NFT of a specific type (selective disclosure).
   *
   * Use case: "I have an ELIGIBILITY NFT" without revealing which one.
   *
   * @param preimage — private Fields for ProofGateProgram
   * @param entityType — member/prescriber/pharmacy
   * @param nftIndex — slot index of the NFT to prove
   * @param requiredType — NFT_TYPE_ELIGIBILITY or NFT_TYPE_PRESCRIPTION
   */
  async proveNftByType(
    preimage: Field[],
    entityType: EntityType,
    nftIndex: bigint,
    requiredType: Field,
  ) {
    const pgResult = await this.generateOwnershipProof(preimage, entityType);

    const nft = this.inventory.getNft(nftIndex);
    if (!nft) throw new Error(`No NFT at index ${nftIndex}`);

    const inventoryWitness = this.inventory.getWitness(nftIndex);
    const inventoryRoot = this.inventory.getRoot();

    const result = await NftProgram.proveHoldingByType(
      pgResult.proof,
      nft,
      inventoryWitness,
      inventoryRoot,
      requiredType,
    );

    return result.proof;
  }

  /**
   * Export a proof as a PortableCredential for NFC/RFID/QR transport.
   *
   * @param proof — any NftOperationProof
   * @param proofType — the type of credential
   * @param vkHash — verification key hash (for offline verifier confirmation)
   * @param expiresAt — optional expiration timestamp
   */
  exportCredential(
    proof: { toJSON(): any; publicOutput: NftOperationOutput },
    proofType: PortableCredential['proofType'],
    vkHash: Field,
    expiresAt?: number,
  ): PortableCredential {
    return serializeCredential(proof, proofType, vkHash, expiresAt);
  }

  /** Get the NftInventory for direct access */
  getInventory(): NftInventory {
    return this.inventory;
  }

  /** Get the number of NFTs in this wallet */
  getNftCount(): number {
    return this.inventory.count;
  }
}
