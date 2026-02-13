import { Field, MerkleTree, MerkleWitness } from 'o1js';
import { EligibilityData } from './eligibility-data.js';

/**
 * Height of the benefit plan tree — 128 plans (same as MerkleForest trees).
 * This is the insurer's master registry of all valid benefit configurations.
 */
export const BENEFIT_PLAN_TREE_HEIGHT = 8;

/** Maximum number of benefit plans (2^(height-1) = 128) */
const MAX_PLANS = 2 ** (BENEFIT_PLAN_TREE_HEIGHT - 1);

/** Circuit-compatible witness for benefit plan inclusion proofs */
export class BenefitPlanWitness extends MerkleWitness(BENEFIT_PLAN_TREE_HEIGHT) {}

/**
 * BenefitPlanRegistry — off-chain manager for the insurer's benefit plan tree.
 *
 * Each leaf holds an EligibilityData commitment (Poseidon hash of plan fields).
 * The root is stored on-chain in CareContract.benefitPlanRoot.
 *
 * Used in EligibilityProgram.proveEligibility to verify that the eligibility
 * data in an NFT corresponds to a legitimate, registered benefit plan.
 *
 * Pattern: modeled after NftInventory in src/nft/nft-inventory.ts
 */
export class BenefitPlanRegistry {
  private tree: MerkleTree;
  private plans: Map<bigint, EligibilityData>;
  private nextIndex: bigint;

  constructor() {
    this.tree = new MerkleTree(BENEFIT_PLAN_TREE_HEIGHT);
    this.plans = new Map();
    this.nextIndex = 0n;
  }

  /** Get the current registry Merkle root */
  getRoot(): Field {
    return this.tree.getRoot();
  }

  /** Get the number of registered benefit plans */
  get count(): number {
    return this.plans.size;
  }

  /**
   * Add a benefit plan to the registry.
   * Inserts the EligibilityData commitment at the next available slot.
   *
   * @returns The assigned index and the new registry root
   */
  addPlan(eligData: EligibilityData): { index: bigint; newRoot: Field } {
    if (this.nextIndex >= BigInt(MAX_PLANS)) {
      throw new Error(
        `Benefit plan registry full: cannot exceed ${MAX_PLANS} plans`,
      );
    }

    const index = this.nextIndex++;
    const commitment = eligData.commitment();

    this.plans.set(index, eligData);
    this.tree.setLeaf(index, commitment);

    return { index, newRoot: this.tree.getRoot() };
  }

  /**
   * Get the EligibilityData stored at a given index.
   * Returns undefined if the slot is empty.
   */
  getPlan(index: bigint): EligibilityData | undefined {
    return this.plans.get(index);
  }

  /**
   * Get a circuit-compatible witness for a plan's position in the registry.
   * Used in EligibilityProgram to prove plan existence.
   */
  getPlanWitness(index: bigint): BenefitPlanWitness {
    return new BenefitPlanWitness(this.tree.getWitness(index));
  }
}
