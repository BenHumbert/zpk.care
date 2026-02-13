import { Field, Struct, Poseidon } from 'o1js';
import { MerkleForest, ForestDomain } from '../zkp/merkle-forest.js';

/**
 * ForestRoots — provable Struct containing all 6 domain tree roots.
 *
 * The NftData.forestRoot is a single Poseidon hash of 6 tree roots.
 * To prove a leaf exists in one specific tree inside the forest,
 * the ZK circuit needs all 6 roots to:
 *   1. Verify the individual tree inclusion (witness check)
 *   2. Reconstruct and verify the composite forest root
 *
 * This Struct is a single ZkProgram input that carries all 6 roots.
 */
export class ForestRoots extends Struct({
  /** Root of the MEMBER domain tree */
  memberRoot: Field,
  /** Root of the PRESCRIBER domain tree */
  prescriberRoot: Field,
  /** Root of the PHARMACY domain tree */
  pharmacyRoot: Field,
  /** Root of the MEDICATION domain tree */
  medicationRoot: Field,
  /** Root of the ACCESS_CONTROL domain tree */
  accessControlRoot: Field,
  /** Root of the TRANSACTION domain tree */
  transactionRoot: Field,
}) {
  /**
   * Compute the composite forest root from the 6 domain tree roots.
   * Must match MerkleForest.getForestRoot() exactly (same field order).
   */
  computeForestRoot(): Field {
    return Poseidon.hash([
      this.memberRoot,
      this.prescriberRoot,
      this.pharmacyRoot,
      this.medicationRoot,
      this.accessControlRoot,
      this.transactionRoot,
    ]);
  }

  /**
   * Construct a ForestRoots from a MerkleForest instance.
   * Extracts all 6 tree roots in domain order.
   */
  static fromForest(forest: MerkleForest): ForestRoots {
    return new ForestRoots({
      memberRoot: forest.getTreeRoot(ForestDomain.MEMBER),
      prescriberRoot: forest.getTreeRoot(ForestDomain.PRESCRIBER),
      pharmacyRoot: forest.getTreeRoot(ForestDomain.PHARMACY),
      medicationRoot: forest.getTreeRoot(ForestDomain.MEDICATION),
      accessControlRoot: forest.getTreeRoot(ForestDomain.ACCESS_CONTROL),
      transactionRoot: forest.getTreeRoot(ForestDomain.TRANSACTION),
    });
  }
}
