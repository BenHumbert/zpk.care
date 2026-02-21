import { Field } from 'o1js';
import type { ILocalStore } from '../storage/local-store.js';
import { MerkleForest, ForestDomain } from '../zkp/merkle-forest.js';
import { CredentialData } from '../credentials/credential-data.js';
import { EligibilityData } from '../eligibility/eligibility-data.js';
import { ForestRoots } from '../eligibility/forest-roots.js';
import { FormularyEntry } from './formulary-entry.js';
import { FormularyRegistry } from './formulary-registry.js';
import { PriorAuthData } from './prior-auth-data.js';
import { AccessControlProgram } from './access-control-program.js';

/**
 * AccessControlService — insurer-side orchestration for medication access rules.
 *
 * Manages the formulary and prior authorizations, generates ZK proofs.
 *
 * Preconditions:
 *   await AccessControlProgram.compile();
 */
export class AccessControlService {
  private store: ILocalStore;
  private formularyRegistry: FormularyRegistry;

  constructor(store: ILocalStore, formularyRegistry: FormularyRegistry) {
    this.store = store;
    this.formularyRegistry = formularyRegistry;
  }

  /**
   * Add a medication to the formulary.
   */
  addFormularyEntry(entry: FormularyEntry): { index: bigint; newRoot: Field } {
    return this.formularyRegistry.addEntry(entry);
  }

  /**
   * Create a prior authorization in the ACCESS_CONTROL tree.
   *
   * Inserts the PA commitment at the specified leaf index in the forest.
   * Returns the PA commitment and updated forest root.
   *
   * @param priorAuth — the prior authorization data
   * @param forest — the MerkleForest to insert into
   * @param paLeafIndex — leaf index in the ACCESS_CONTROL tree (must be > 0; leaf 0 is eligibility data)
   */
  createPriorAuth(
    priorAuth: PriorAuthData,
    forest: MerkleForest,
    paLeafIndex: bigint,
  ): { paCommitment: Field; newForestRoot: Field } {
    forest.setLeaf(
      ForestDomain.ACCESS_CONTROL,
      paLeafIndex,
      priorAuth.commitment(),
    );
    return {
      paCommitment: priorAuth.commitment(),
      newForestRoot: forest.getForestRoot(),
    };
  }

  /**
   * Generate a formulary access proof.
   *
   * Proves that a medication is on the formulary and the requested
   * quantity/day supply is within the plan's limits.
   */
  async proveFormularyAccess(
    credentialData: CredentialData,
    eligibilityData: EligibilityData,
    forest: MerkleForest,
    eligLeafIndex: bigint,
    formularyEntryIndex: bigint,
    ndcHash: Field,
    requestedQuantity: Field,
    requestedDaySupply: Field,
    currentDate: Field = Field(0),
  ) {
    const forestRoots = ForestRoots.fromForest(forest);
    const eligForestWitness = forest.getWitness(
      ForestDomain.ACCESS_CONTROL,
      eligLeafIndex,
    );
    const formularyEntry = this.formularyRegistry.getEntry(formularyEntryIndex);
    if (!formularyEntry) {
      throw new Error(`No formulary entry at index ${formularyEntryIndex}`);
    }
    const formularyWitness =
      this.formularyRegistry.getEntryWitness(formularyEntryIndex);

    const result = await AccessControlProgram.proveFormularyAccess(
      credentialData,
      eligibilityData,
      forestRoots,
      eligForestWitness,
      formularyEntry,
      formularyWitness,
      ndcHash,
      requestedQuantity,
      requestedDaySupply,
      currentDate,
    );

    const proofId = `formulary-access-${Date.now()}`;
    await this.store.saveProof(proofId, JSON.stringify(result.proof.toJSON()));

    return result.proof;
  }

  /**
   * Generate a prior auth proof.
   *
   * Proves that a valid prior authorization exists for a PA-required
   * medication. The PA must be in the ACCESS_CONTROL tree, not expired,
   * and have sufficient approved quantity.
   */
  async provePriorAuth(
    credentialData: CredentialData,
    eligibilityData: EligibilityData,
    forest: MerkleForest,
    eligLeafIndex: bigint,
    paLeafIndex: bigint,
    priorAuthData: PriorAuthData,
    formularyEntryIndex: bigint,
    currentDate: Field,
    requestedQuantity: Field,
  ) {
    const forestRoots = ForestRoots.fromForest(forest);
    const eligForestWitness = forest.getWitness(
      ForestDomain.ACCESS_CONTROL,
      eligLeafIndex,
    );
    const paForestWitness = forest.getWitness(
      ForestDomain.ACCESS_CONTROL,
      paLeafIndex,
    );
    const formularyEntry = this.formularyRegistry.getEntry(formularyEntryIndex);
    if (!formularyEntry) {
      throw new Error(`No formulary entry at index ${formularyEntryIndex}`);
    }
    const formularyWitness =
      this.formularyRegistry.getEntryWitness(formularyEntryIndex);

    const result = await AccessControlProgram.provePriorAuth(
      credentialData,
      eligibilityData,
      forestRoots,
      eligForestWitness,
      paForestWitness,
      priorAuthData,
      formularyEntry,
      formularyWitness,
      currentDate,
      requestedQuantity,
    );

    const proofId = `prior-auth-${Date.now()}`;
    await this.store.saveProof(proofId, JSON.stringify(result.proof.toJSON()));

    return result.proof;
  }
}
