import { Field, MerkleTree, MerkleWitness, Poseidon } from 'o1js';

/**
 * Merkle Forest — a collection of domain-specific Merkle trees
 * that compose into a single forest root.
 *
 * Each NFT embeds a forest containing trees for:
 *   - Members
 *   - Prescribers
 *   - Pharmacies
 *   - Medications
 *   - Access Control (approvals/revocations)
 *
 * The forest root = Poseidon hash of all individual tree roots.
 * This is the single value stored on-chain in the NFT metadata.
 */

/** Tree height of 8 supports 128 leaves per tree — sufficient for initial scope */
export const TREE_HEIGHT = 8;

/** Circuit-compatible witness for our tree height */
export class ForestMerkleWitness extends MerkleWitness(TREE_HEIGHT) {}

/** Domain identifiers for each tree in the forest */
export enum ForestDomain {
  MEMBER = 0,
  PRESCRIBER = 1,
  PHARMACY = 2,
  MEDICATION = 3,
  ACCESS_CONTROL = 4,
  TRANSACTION = 5,
}

/**
 * MerkleForest manages multiple domain-specific Merkle trees
 * and produces a composite root hash.
 */
export class MerkleForest {
  private trees: Map<ForestDomain, MerkleTree>;

  constructor() {
    this.trees = new Map();
    // Initialize all domain trees
    for (const domain of Object.values(ForestDomain)) {
      if (typeof domain === 'number') {
        this.trees.set(domain, new MerkleTree(TREE_HEIGHT));
      }
    }
  }

  /**
   * Get a specific domain tree.
   */
  getTree(domain: ForestDomain): MerkleTree {
    const tree = this.trees.get(domain);
    if (!tree) throw new Error(`Unknown domain: ${domain}`);
    return tree;
  }

  /**
   * Set a leaf in a specific domain tree.
   */
  setLeaf(domain: ForestDomain, index: bigint, leaf: Field): void {
    this.getTree(domain).setLeaf(index, leaf);
  }

  /**
   * Get a leaf from a specific domain tree.
   */
  getLeaf(domain: ForestDomain, index: bigint): Field {
    return this.getTree(domain).getLeaf(index);
  }

  /**
   * Get the root of a specific domain tree.
   */
  getTreeRoot(domain: ForestDomain): Field {
    return this.getTree(domain).getRoot();
  }

  /**
   * Get a circuit-compatible witness for a leaf in a domain tree.
   */
  getWitness(domain: ForestDomain, index: bigint): ForestMerkleWitness {
    const witness = this.getTree(domain).getWitness(index);
    return new ForestMerkleWitness(witness);
  }

  /**
   * Compute the forest root — a single hash of all domain tree roots.
   * This is the value embedded in the NFT.
   */
  getForestRoot(): Field {
    const roots: Field[] = [];
    for (const domain of Object.values(ForestDomain)) {
      if (typeof domain === 'number') {
        roots.push(this.getTreeRoot(domain));
      }
    }
    return Poseidon.hash(roots);
  }

  /**
   * Get all individual tree roots (for verification purposes).
   */
  getTreeRoots(): Map<ForestDomain, Field> {
    const roots = new Map<ForestDomain, Field>();
    for (const domain of Object.values(ForestDomain)) {
      if (typeof domain === 'number') {
        roots.set(domain, this.getTreeRoot(domain));
      }
    }
    return roots;
  }
}
