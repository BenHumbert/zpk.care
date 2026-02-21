import { Field, Poseidon } from 'o1js';
import type { ILocalStore } from '../storage/local-store.js';
import { WalletRegistry, WalletState } from '../wallets/wallet-state.js';
import { CredentialData } from '../credentials/credential-data.js';
import { CredentialInventory } from '../credentials/credential-inventory.js';
import { MerkleForest, ForestDomain } from '../zkp/merkle-forest.js';
import { ForestRoots } from '../eligibility/forest-roots.js';
import { FormularyEntry } from '../access-control/formulary-entry.js';
import { FormularyRegistry } from '../access-control/formulary-registry.js';
import {
  PrescriptionData,
  PrescriptionStatusData,
  RX_STATUS_FILLED,
  RX_STATUS_PARTIALLY_FILLED,
} from '../prescription/prescription-data.js';
import { FulfillmentData, ReversalData } from './fulfillment-data.js';
import { FulfillmentProgram } from './fulfillment-program.js';

// ─── Result Types ───────────────────────────────────────────────

/**
 * Result of submitting a fulfillment claim.
 */
export interface FulfillmentResult {
  proof: Awaited<ReturnType<typeof FulfillmentProgram.proveFulfillment>>['proof'];
  newCredentialData: CredentialData;
  newInventoryRoot: Field;
  fulfillmentEntry: FulfillmentData;
  fulfillmentIndex: bigint;
  patientPayCents: Field;
  planPayCents: Field;
}

/**
 * Result of reversing a fulfillment.
 */
export interface ReversalResult {
  proof: Awaited<ReturnType<typeof FulfillmentProgram.proveReversal>>['proof'];
  newCredentialData: CredentialData;
  newInventoryRoot: Field;
  reversalEntry: ReversalData;
  reversalIndex: bigint;
  patientRefundCents: Field;
  planRefundCents: Field;
}

// ─── FulfillmentService ─────────────────────────────────────────

/**
 * FulfillmentService — orchestration layer for claim fulfillment.
 *
 * The ZK proof IS the adjudication — no separate insurer step needed.
 * Settlement amounts are computed deterministically from the formulary.
 *
 * Preconditions:
 *   await FulfillmentProgram.compile();  // for proof generation
 */
export class FulfillmentService {
  private store: ILocalStore;
  private registry: WalletRegistry;
  private formularyRegistry: FormularyRegistry;

  constructor(
    store: ILocalStore,
    registry: WalletRegistry,
    formularyRegistry: FormularyRegistry,
  ) {
    this.store = store;
    this.registry = registry;
    this.formularyRegistry = formularyRegistry;
  }

  // ─── Fulfillment (single step) ─────────────────────────────

  /**
   * Submit a fulfillment claim with ZK-enforced settlement.
   *
   * @param pharmacyWalletId — the pharmacy holding the prescription credential
   * @param credentialData — the current prescription credential
   * @param prescriptionData — the prescription in MEDICATION tree
   * @param latestStatus — latest status (must be FILLED or PARTIALLY_FILLED)
   * @param fulfillmentData — the claim being submitted
   * @param forest — the MerkleForest (will be mutated after proof)
   * @param rxLeafIndex — prescription leaf in MEDICATION tree
   * @param latestStatusIndex — latest status leaf in TRANSACTION tree
   * @param formularyEntryIndex — formulary entry index in formulary tree
   * @param pharmacyInventory — the pharmacy's credential inventory
   * @param credentialSlotIndex — the credential's slot in the inventory
   */
  async submitFulfillment(
    pharmacyWalletId: Field,
    credentialData: CredentialData,
    prescriptionData: PrescriptionData,
    latestStatus: PrescriptionStatusData,
    fulfillmentData: FulfillmentData,
    forest: MerkleForest,
    rxLeafIndex: bigint,
    latestStatusIndex: bigint,
    formularyEntryIndex: bigint,
    pharmacyInventory: CredentialInventory,
    credentialSlotIndex: bigint,
    pharmacyPreimage: Field[] = [],
  ): Promise<FulfillmentResult> {
    // Off-chain validation: status must be FILLED or PARTIALLY_FILLED
    const statusVal = BigInt(latestStatus.status.toString());
    const isFilled = statusVal === BigInt(RX_STATUS_FILLED.toString());
    const isPartiallyFilled = statusVal === BigInt(RX_STATUS_PARTIALLY_FILLED.toString());
    if (!isFilled && !isPartiallyFilled) {
      throw new Error(
        `Prescription must be FILLED or PARTIALLY_FILLED, got status ${statusVal}`,
      );
    }

    // 1. Build ALL witnesses BEFORE any mutation
    const forestRoots = ForestRoots.fromForest(forest);
    const medicationWitness = forest.getWitness(
      ForestDomain.MEDICATION,
      rxLeafIndex,
    );
    const statusWitness = forest.getWitness(
      ForestDomain.TRANSACTION,
      latestStatusIndex,
    );
    const fulfillmentSlotIndex = latestStatusIndex + 1n;
    const newSlotWitness = forest.getWitness(
      ForestDomain.TRANSACTION,
      fulfillmentSlotIndex,
    );

    // Build formulary witness from registry
    const formularyEntry = this.formularyRegistry.getEntry(formularyEntryIndex);
    if (!formularyEntry) {
      throw new Error(`Formulary entry not found at index ${formularyEntryIndex}`);
    }
    const formularyWitness = this.formularyRegistry.getEntryWitness(formularyEntryIndex);
    const formularyRoot = this.formularyRegistry.getRoot();

    // 2. Generate FulfillmentProgram.proveFulfillment proof
    const result = await FulfillmentProgram.proveFulfillment(
      credentialData,
      prescriptionData,
      latestStatus,
      fulfillmentData,
      formularyEntry,
      forestRoots,
      medicationWitness,
      statusWitness,
      newSlotWitness,
      formularyWitness,
      formularyRoot,
      // H2: pharmacy wallet identity preimage (qualifier, serviceProviderIdHash, enrollmentKeyHash)
      pharmacyPreimage[0] ?? Field(0),
      pharmacyPreimage[1] ?? Field(0),
      pharmacyPreimage[2] ?? Field(0),
    );

    // 3. Compute settlement commitment (matches what the circuit stored)
    const output = result.proof.publicOutput;
    const settlementCommitment = Poseidon.hash([
      fulfillmentData.commitment(),
      output.patientPayCents,
      output.planPayCents,
    ]);

    // 4. Append settlement commitment to TRANSACTION tree
    forest.setLeaf(
      ForestDomain.TRANSACTION,
      fulfillmentSlotIndex,
      settlementCommitment,
    );

    // 5. Create new CredentialData with updated forestRoot
    const newCredentialData = new CredentialData({
      credentialType: credentialData.credentialType,
      forestRoot: forest.getForestRoot(),
      issuerWalletId: credentialData.issuerWalletId,
      subjectWalletId: credentialData.subjectWalletId,
      issuedAt: credentialData.issuedAt,
      expiresAt: credentialData.expiresAt,
      revoked: credentialData.revoked,
    });

    // 6. Replace credential in pharmacy inventory (same slot)
    const newInventoryRoot = pharmacyInventory.updateCredential(credentialSlotIndex, newCredentialData);

    // 7. Update wallet registry nonce
    const oldState = this.registry.getState(pharmacyWalletId);
    const newNonce = Field(BigInt(oldState.nonce.toString()) + 1n);
    this.registry.updateState(
      pharmacyWalletId,
      new WalletState({
        walletId: pharmacyWalletId,
        credentialInventoryRoot: newInventoryRoot,
        nonce: newNonce,
      }),
    );

    // 8. Store proof
    const proofId = `fulfill-${fulfillmentSlotIndex}-${Date.now()}`;
    await this.store.saveProof(proofId, JSON.stringify(result.proof.toJSON()));

    return {
      proof: result.proof,
      newCredentialData,
      newInventoryRoot,
      fulfillmentEntry: fulfillmentData,
      fulfillmentIndex: fulfillmentSlotIndex,
      patientPayCents: output.patientPayCents,
      planPayCents: output.planPayCents,
    };
  }

  // ─── Reversal ──────────────────────────────────────────────

  /**
   * Reverse a previously fulfilled claim.
   *
   * @param pharmacyWalletId — the pharmacy holding the prescription credential
   * @param credentialData — the current prescription credential (post-fulfillment)
   * @param prescriptionData — the prescription in MEDICATION tree
   * @param originalFulfillment — the original fulfillment entry
   * @param reversalData — the reversal entry
   * @param forest — the MerkleForest (will be mutated after proof)
   * @param rxLeafIndex — prescription leaf in MEDICATION tree
   * @param originalFulfillmentIndex — fulfillment leaf in TRANSACTION tree
   * @param formularyEntryIndex — formulary entry index in formulary tree
   * @param pharmacyInventory — the pharmacy's credential inventory
   * @param credentialSlotIndex — the credential's slot in the inventory
   */
  async reverseFulfillment(
    pharmacyWalletId: Field,
    credentialData: CredentialData,
    prescriptionData: PrescriptionData,
    originalFulfillment: FulfillmentData,
    reversalData: ReversalData,
    forest: MerkleForest,
    rxLeafIndex: bigint,
    originalFulfillmentIndex: bigint,
    formularyEntryIndex: bigint,
    pharmacyInventory: CredentialInventory,
    credentialSlotIndex: bigint,
    pharmacyPreimage: Field[] = [],
  ): Promise<ReversalResult> {
    // 1. Build ALL witnesses BEFORE any mutation
    const forestRoots = ForestRoots.fromForest(forest);
    const medicationWitness = forest.getWitness(
      ForestDomain.MEDICATION,
      rxLeafIndex,
    );
    const fulfillmentWitness = forest.getWitness(
      ForestDomain.TRANSACTION,
      originalFulfillmentIndex,
    );
    const reversalSlotIndex = originalFulfillmentIndex + 1n;
    const reversalSlotWitness = forest.getWitness(
      ForestDomain.TRANSACTION,
      reversalSlotIndex,
    );

    // Build formulary witness from registry
    const formularyEntry = this.formularyRegistry.getEntry(formularyEntryIndex);
    if (!formularyEntry) {
      throw new Error(`Formulary entry not found at index ${formularyEntryIndex}`);
    }
    const formularyWitness = this.formularyRegistry.getEntryWitness(formularyEntryIndex);
    const formularyRoot = this.formularyRegistry.getRoot();

    // 2. Generate FulfillmentProgram.proveReversal proof
    const result = await FulfillmentProgram.proveReversal(
      credentialData,
      prescriptionData,
      originalFulfillment,
      reversalData,
      formularyEntry,
      forestRoots,
      medicationWitness,
      fulfillmentWitness,
      reversalSlotWitness,
      formularyWitness,
      formularyRoot,
      // H2: pharmacy wallet identity preimage
      pharmacyPreimage[0] ?? Field(0),
      pharmacyPreimage[1] ?? Field(0),
      pharmacyPreimage[2] ?? Field(0),
    );

    // 3. Append reversal to TRANSACTION tree
    forest.setLeaf(
      ForestDomain.TRANSACTION,
      reversalSlotIndex,
      reversalData.commitment(),
    );

    // 4. Create new CredentialData with updated forestRoot
    const newCredentialData = new CredentialData({
      credentialType: credentialData.credentialType,
      forestRoot: forest.getForestRoot(),
      issuerWalletId: credentialData.issuerWalletId,
      subjectWalletId: credentialData.subjectWalletId,
      issuedAt: credentialData.issuedAt,
      expiresAt: credentialData.expiresAt,
      revoked: credentialData.revoked,
    });

    // 5. Replace credential in pharmacy inventory
    const newInventoryRoot = pharmacyInventory.updateCredential(credentialSlotIndex, newCredentialData);

    // 6. Update wallet registry nonce
    const oldState = this.registry.getState(pharmacyWalletId);
    const newNonce = Field(BigInt(oldState.nonce.toString()) + 1n);
    this.registry.updateState(
      pharmacyWalletId,
      new WalletState({
        walletId: pharmacyWalletId,
        credentialInventoryRoot: newInventoryRoot,
        nonce: newNonce,
      }),
    );

    // 7. Store proof
    const proofId = `reversal-${reversalSlotIndex}-${Date.now()}`;
    await this.store.saveProof(proofId, JSON.stringify(result.proof.toJSON()));

    // Extract refund amounts from proof output
    const output = result.proof.publicOutput;

    return {
      proof: result.proof,
      newCredentialData,
      newInventoryRoot,
      reversalEntry: reversalData,
      reversalIndex: reversalSlotIndex,
      patientRefundCents: output.patientPayCents,
      planRefundCents: output.planPayCents,
    };
  }

  // ─── Helpers ───────────────────────────────────────────────

  /**
   * Calculate settlement amounts off-chain.
   *
   * copay = formularyEntry.copayAmountCents
   * total = ingredientCostCents + dispensingFeeCents
   * If total < copay: patientPay = total, planPay = 0
   * Else: patientPay = copay, planPay = total - copay
   */
  calculateAmounts(
    fulfillmentData: FulfillmentData,
    formularyEntry: FormularyEntry,
  ): { patientPayCents: Field; planPayCents: Field } {
    const total = BigInt(fulfillmentData.ingredientCostCents.toString())
      + BigInt(fulfillmentData.dispensingFeeCents.toString());
    const copay = BigInt(formularyEntry.copayAmountCents.toString());

    if (total < copay) {
      return {
        patientPayCents: Field(total),
        planPayCents: Field(0),
      };
    }

    return {
      patientPayCents: Field(copay),
      planPayCents: Field(total - copay),
    };
  }
}
