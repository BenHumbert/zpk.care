import { Field, MerkleTree } from 'o1js';
import { ProofGateProgram } from '../wallets/proof-gate.js';
import {
  WalletRegistry,
  WalletState,
} from '../wallets/wallet-state.js';
import {
  LifecycleWitness,
  lifecycleLeafCommitment,
} from '../engine/lifecycle.js';
import type { ILocalStore } from '../storage/local-store.js';
import { NftData, NFT_TYPE_ELIGIBILITY } from '../nft/nft-data.js';
import { NftInventory } from '../nft/nft-inventory.js';
import { MerkleForest, ForestDomain, ForestMerkleWitness } from '../zkp/merkle-forest.js';
import { EligibilityData } from './eligibility-data.js';
import { ForestRoots } from './forest-roots.js';
import { BenefitPlanRegistry } from './benefit-plan-registry.js';
import { EligibilityProgram, InNetworkProgram } from './eligibility-program.js';

/**
 * Entity type for ProofGateProgram dispatch.
 */
export type EligibilityEntityType = 'member' | 'prescriber' | 'pharmacy';

/**
 * Result of an eligibility mint operation.
 */
export interface EligibilityMintResult {
  /** The ELIGIBILITY NFT that was minted */
  nftData: NftData;
  /** Proof that eligibility rules are valid */
  eligibilityProof: Awaited<ReturnType<typeof EligibilityProgram.proveEligibility>>['proof'];
  /** The slot index where the NFT was minted */
  nftIndex: bigint;
  /** New NFT inventory root after minting */
  newInventoryRoot: Field;
  /** New wallet registry root after update */
  newRegistryRoot: Field;
}

/**
 * EligibilityService — insurer-side orchestration for eligibility determination.
 *
 * This service combines all L5 pieces into high-level operations:
 *
 *   buildEligibilityNft()     — construct ELIGIBILITY NFT from benefit plan + forest
 *   mintEligibilityNft()      — full flow: build NFT + mint + generate proofs
 *   proveEligibility()        — generate an EligibilityProof for an existing NFT
 *   proveInNetwork()          — generate an InNetworkProof for a prescriber/pharmacy
 *
 * Preconditions:
 *   await EligibilityProgram.compile();
 *   await InNetworkProgram.compile();   // only for proveInNetwork
 *   await ProofGateProgram.compile();   // only for proveInNetwork
 */
export class EligibilityService {
  private store: ILocalStore;
  private registry: WalletRegistry;
  private lifecycleTree: MerkleTree;
  private benefitPlanRegistry: BenefitPlanRegistry;
  private adminWalletId: Field;

  constructor(
    store: ILocalStore,
    registry: WalletRegistry,
    lifecycleTree: MerkleTree,
    benefitPlanRegistry: BenefitPlanRegistry,
    adminWalletId: Field,
  ) {
    this.store = store;
    this.registry = registry;
    this.lifecycleTree = lifecycleTree;
    this.benefitPlanRegistry = benefitPlanRegistry;
    this.adminWalletId = adminWalletId;
  }

  /**
   * Build an ELIGIBILITY NFT from eligibility data and a MerkleForest.
   *
   * The eligibility data is inserted into the forest's ACCESS_CONTROL tree,
   * and the resulting forestRoot is embedded in the NftData.
   *
   * @param memberWalletId — the member who will hold this NFT
   * @param eligibilityData — the benefit plan configuration
   * @param forest — MerkleForest containing member/medication data
   * @param eligLeafIndex — which leaf in the ACCESS_CONTROL tree to use
   * @param issuedAt — issue date as CCYYMMDD Field
   * @param expiresAt — expiration date as CCYYMMDD Field (Field(0) = never)
   */
  buildEligibilityNft(
    memberWalletId: Field,
    eligibilityData: EligibilityData,
    forest: MerkleForest,
    eligLeafIndex: bigint,
    issuedAt: Field,
    expiresAt: Field = Field(0),
  ): NftData {
    // Insert eligibility commitment into ACCESS_CONTROL tree
    forest.setLeaf(
      ForestDomain.ACCESS_CONTROL,
      eligLeafIndex,
      eligibilityData.commitment(),
    );

    return new NftData({
      nftType: NFT_TYPE_ELIGIBILITY,
      forestRoot: forest.getForestRoot(),
      issuerWalletId: this.adminWalletId,
      subjectWalletId: memberWalletId,
      issuedAt,
      expiresAt,
      revoked: Field(0),
    });
  }

  /**
   * Full eligibility mint flow (off-chain state updates).
   *
   * 1. Build NftData with forestRoot
   * 2. Generate EligibilityProof (validates benefit plan rules)
   * 3. Mint into member's NftInventory
   * 4. Update WalletRegistry with new nftInventoryRoot
   * 5. Store proof metadata
   *
   * Note: On-chain settlement (CareContract.updateWalletState + registerGlobalNft)
   * must be done separately by the admin.
   */
  async mintEligibilityNft(
    memberWalletId: Field,
    eligibilityData: EligibilityData,
    forest: MerkleForest,
    memberInventory: NftInventory,
    eligLeafIndex: bigint,
    benefitPlanIndex: bigint,
    currentDate: Field,
    issuedAt: Field,
    expiresAt: Field = Field(0),
  ): Promise<EligibilityMintResult> {
    // 1. Build NFT
    const nftData = this.buildEligibilityNft(
      memberWalletId,
      eligibilityData,
      forest,
      eligLeafIndex,
      issuedAt,
      expiresAt,
    );

    // 2. Generate eligibility proof
    const eligibilityProof = await this.proveEligibility(
      nftData,
      eligibilityData,
      forest,
      eligLeafIndex,
      benefitPlanIndex,
      currentDate,
    );

    // 3. Mint into member's inventory
    const { index: nftIndex, newRoot: newInventoryRoot } =
      memberInventory.mint(nftData);

    // 4. Update wallet registry
    const oldState = this.registry.getState(memberWalletId);
    const newNonce = Field(BigInt(oldState.nonce.toString()) + 1n);
    const newWalletState = new WalletState({
      walletId: memberWalletId,
      nftInventoryRoot: newInventoryRoot,
      nonce: newNonce,
    });
    this.registry.updateState(memberWalletId, newWalletState);

    // 5. Store proof metadata
    const proofId = `eligibility-${nftIndex}-${Date.now()}`;
    await this.store.saveProof(
      proofId,
      JSON.stringify(eligibilityProof.toJSON()),
    );

    return {
      nftData,
      eligibilityProof,
      nftIndex,
      newInventoryRoot,
      newRegistryRoot: this.registry.getRoot(),
    };
  }

  /**
   * Generate an EligibilityProof for an existing ELIGIBILITY NFT.
   *
   * Proves that the NFT contains valid eligibility data: correct type,
   * not revoked, data in forest, plan in registry, dates valid.
   */
  async proveEligibility(
    nftData: NftData,
    eligibilityData: EligibilityData,
    forest: MerkleForest,
    eligLeafIndex: bigint,
    benefitPlanIndex: bigint,
    currentDate: Field,
  ) {
    const forestRoots = ForestRoots.fromForest(forest);
    const forestWitness = forest.getWitness(
      ForestDomain.ACCESS_CONTROL,
      eligLeafIndex,
    );
    const benefitPlanWitness =
      this.benefitPlanRegistry.getPlanWitness(benefitPlanIndex);
    const benefitPlanRoot = this.benefitPlanRegistry.getRoot();

    const result = await EligibilityProgram.proveEligibility(
      nftData,
      eligibilityData,
      forestRoots,
      forestWitness,
      benefitPlanWitness,
      benefitPlanRoot,
      currentDate,
    );

    return result.proof;
  }

  /**
   * Generate an InNetworkProof for a prescriber or pharmacy.
   *
   * Proves wallet ownership (recursive ProofGateProof) and that the
   * wallet's lifecycle state is ELIGIBLE or ACTIVE (in-network).
   *
   * @param preimage — private Fields for ProofGateProgram
   * @param entityType — prescriber or pharmacy
   * @param walletId — the wallet to prove is in-network
   * @param lifecycle — the current lifecycle Field value
   */
  async proveInNetwork(
    preimage: Field[],
    entityType: EligibilityEntityType,
    walletId: Field,
    lifecycle: Field,
  ) {
    // 1. Generate ownership proof
    let pgResult;
    switch (entityType) {
      case 'member':
        pgResult = await ProofGateProgram.verifyMember(
          walletId,
          preimage[0]!, preimage[1]!, preimage[2]!, preimage[3]!, preimage[4]!,
        );
        break;
      case 'prescriber':
        pgResult = await ProofGateProgram.verifyPrescriber(
          walletId,
          preimage[0]!, preimage[1]!, preimage[2]!,
        );
        break;
      case 'pharmacy':
        pgResult = await ProofGateProgram.verifyPharmacy(
          walletId,
          preimage[0]!, preimage[1]!, preimage[2]!,
        );
        break;
    }

    // 2. Get lifecycle witness
    const walletIndex = this.registry.getIndex(walletId);
    const lifecycleLeaf = lifecycleLeafCommitment(walletId, lifecycle);
    this.lifecycleTree.setLeaf(walletIndex, lifecycleLeaf);
    const lifecycleWitness = new LifecycleWitness(
      this.lifecycleTree.getWitness(walletIndex),
    );
    const lifecycleRoot = this.lifecycleTree.getRoot();

    // 3. Generate InNetwork proof
    const result = await InNetworkProgram.proveInNetwork(
      pgResult.proof,
      lifecycle,
      lifecycleWitness,
      lifecycleRoot,
    );

    return result.proof;
  }
}
