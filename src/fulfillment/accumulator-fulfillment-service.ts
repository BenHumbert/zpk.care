import { Field, Poseidon } from 'o1js';
import type { ILocalStore } from '../storage/local-store.js';
import { WalletRegistry, WalletState } from '../wallets/wallet-state.js';
import { NftData } from '../nft/nft-data.js';
import { NftInventory } from '../nft/nft-inventory.js';
import { MerkleForest, ForestDomain } from '../zkp/merkle-forest.js';
import { ForestRoots } from '../eligibility/forest-roots.js';
import { FormularyEntry } from '../access-control/formulary-entry.js';
import { FormularyRegistry } from '../access-control/formulary-registry.js';
import { AccumulatorData } from '../access-control/accumulator-data.js';
import {
  PrescriptionStatusData,
  PrescriptionData,
  RX_STATUS_FILLED,
  RX_STATUS_PARTIALLY_FILLED,
} from '../prescription/prescription-data.js';
import { FulfillmentData, ReversalData } from './fulfillment-data.js';
import { AccumulatorFulfillmentProgram } from './accumulator-fulfillment-program.js';

// ─── Result Types ───────────────────────────────────────────────

/**
 * Result of submitting a fulfillment claim with accumulator.
 */
export interface AccumulatorFulfillmentResult {
  proof: Awaited<ReturnType<typeof AccumulatorFulfillmentProgram.proveFulfillmentWithAccumulator>>['proof'];
  newPrescriptionNftData: NftData;
  newEligibilityNftData: NftData;
  newPharmacyInventoryRoot: Field;
  newMemberInventoryRoot: Field;
  fulfillmentEntry: FulfillmentData;
  fulfillmentIndex: bigint;
  patientPayCents: Field;
  planPayCents: Field;
  newAccumulatorData: AccumulatorData;
}

/**
 * Result of reversing a fulfillment with accumulator.
 */
export interface AccumulatorReversalResult {
  proof: Awaited<ReturnType<typeof AccumulatorFulfillmentProgram.proveReversalWithAccumulator>>['proof'];
  newPrescriptionNftData: NftData;
  newEligibilityNftData: NftData;
  newPharmacyInventoryRoot: Field;
  newMemberInventoryRoot: Field;
  reversalEntry: ReversalData;
  reversalIndex: bigint;
  patientRefundCents: Field;
  planRefundCents: Field;
  newAccumulatorData: AccumulatorData;
}

// ─── AccumulatorFulfillmentService ──────────────────────────────

/**
 * AccumulatorFulfillmentService — orchestration for accumulator-aware claims.
 *
 * Operates on TWO NFTs:
 *   - Prescription NFT (pharmacy wallet): claim data + TRANSACTION tree
 *   - Eligibility NFT (member wallet): accumulator at ACCESS_CONTROL leaf 127
 *
 * Preconditions:
 *   await AccumulatorFulfillmentProgram.compile();
 */
export class AccumulatorFulfillmentService {
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

  // ─── Fulfillment with Accumulator ──────────────────────────

  async submitFulfillmentWithAccumulator(
    pharmacyWalletId: Field,
    memberWalletId: Field,
    prescriptionNft: NftData,
    eligibilityNft: NftData,
    prescriptionData: PrescriptionData,
    latestStatus: PrescriptionStatusData,
    fulfillmentData: FulfillmentData,
    prescriptionForest: MerkleForest,
    eligibilityForest: MerkleForest,
    rxLeafIndex: bigint,
    latestStatusIndex: bigint,
    formularyEntryIndex: bigint,
    accumulatorData: AccumulatorData,
    accumulatorLeafIndex: bigint,
    pharmacyInventory: NftInventory,
    memberInventory: NftInventory,
    prescriptionNftSlot: bigint,
    eligibilityNftSlot: bigint,
  ): Promise<AccumulatorFulfillmentResult> {
    // 1. Pre-flight validation (circuit also enforces — fail-fast only)
    const statusVal = BigInt(latestStatus.status.toString());
    const isFilled = statusVal === BigInt(RX_STATUS_FILLED.toString());
    const isPartiallyFilled = statusVal === BigInt(RX_STATUS_PARTIALLY_FILLED.toString());
    if (!isFilled && !isPartiallyFilled) {
      throw new Error(
        `Prescription must be FILLED or PARTIALLY_FILLED, got status ${statusVal}`,
      );
    }

    // 2. Build ALL witnesses BEFORE any mutation
    const rxForestRoots = ForestRoots.fromForest(prescriptionForest);
    const medicationWitness = prescriptionForest.getWitness(
      ForestDomain.MEDICATION,
      rxLeafIndex,
    );
    const statusWitness = prescriptionForest.getWitness(
      ForestDomain.TRANSACTION,
      latestStatusIndex,
    );
    const fulfillmentSlotIndex = latestStatusIndex + 1n;
    const newSlotWitness = prescriptionForest.getWitness(
      ForestDomain.TRANSACTION,
      fulfillmentSlotIndex,
    );

    const formularyEntry = this.formularyRegistry.getEntry(formularyEntryIndex);
    if (!formularyEntry) {
      throw new Error(`Formulary entry not found at index ${formularyEntryIndex}`);
    }
    const formularyWitness = this.formularyRegistry.getEntryWitness(formularyEntryIndex);
    const formularyRoot = this.formularyRegistry.getRoot();

    const eligForestRoots = ForestRoots.fromForest(eligibilityForest);
    const accumulatorWitness = eligibilityForest.getWitness(
      ForestDomain.ACCESS_CONTROL,
      accumulatorLeafIndex,
    );

    // 3. Generate proof
    const result = await AccumulatorFulfillmentProgram.proveFulfillmentWithAccumulator(
      prescriptionNft,
      prescriptionData,
      latestStatus,
      fulfillmentData,
      formularyEntry,
      rxForestRoots,
      medicationWitness,
      statusWitness,
      newSlotWitness,
      formularyWitness,
      formularyRoot,
      eligibilityNft,
      eligForestRoots,
      accumulatorData,
      accumulatorWitness,
    );

    const output = result.proof.publicOutput;

    // 4. Compute settlement commitment and mutate prescription forest
    const settlementCommitment = Poseidon.hash([
      fulfillmentData.commitment(),
      output.patientPayCents,
      output.planPayCents,
    ]);
    prescriptionForest.setLeaf(
      ForestDomain.TRANSACTION,
      fulfillmentSlotIndex,
      settlementCommitment,
    );

    // 5. Create new prescription NftData
    const newPrescriptionNftData = new NftData({
      nftType: prescriptionNft.nftType,
      forestRoot: prescriptionForest.getForestRoot(),
      issuerWalletId: prescriptionNft.issuerWalletId,
      subjectWalletId: prescriptionNft.subjectWalletId,
      issuedAt: prescriptionNft.issuedAt,
      expiresAt: prescriptionNft.expiresAt,
      revoked: prescriptionNft.revoked,
    });

    // 6. Update prescription NFT in pharmacy inventory
    const newPharmacyInventoryRoot = pharmacyInventory.updateNft(
      prescriptionNftSlot,
      newPrescriptionNftData,
    );

    // 7. Compute new accumulator data off-chain
    const patientPayBig = BigInt(output.patientPayCents.toString());
    const planPayBig = BigInt(output.planPayCents.toString());
    const newAccumulatorData = new AccumulatorData({
      planYear: accumulatorData.planYear,
      deductibleAmountCents: accumulatorData.deductibleAmountCents,
      deductiblePaidCents: Field(
        BigInt(accumulatorData.deductiblePaidCents.toString()) + patientPayBig,
      ),
      oopMaxCents: accumulatorData.oopMaxCents,
      oopPaidCents: Field(
        BigInt(accumulatorData.oopPaidCents.toString()) + patientPayBig,
      ),
      annualBenefitMaxCents: accumulatorData.annualBenefitMaxCents,
      annualBenefitUsedCents: Field(
        BigInt(accumulatorData.annualBenefitUsedCents.toString()) + planPayBig,
      ),
    });

    // 8. Mutate eligibility forest
    eligibilityForest.setLeaf(
      ForestDomain.ACCESS_CONTROL,
      accumulatorLeafIndex,
      newAccumulatorData.commitment(),
    );

    // 9. Create new eligibility NftData
    const newEligibilityNftData = new NftData({
      nftType: eligibilityNft.nftType,
      forestRoot: eligibilityForest.getForestRoot(),
      issuerWalletId: eligibilityNft.issuerWalletId,
      subjectWalletId: eligibilityNft.subjectWalletId,
      issuedAt: eligibilityNft.issuedAt,
      expiresAt: eligibilityNft.expiresAt,
      revoked: eligibilityNft.revoked,
    });

    // 10. Update eligibility NFT in member inventory
    const newMemberInventoryRoot = memberInventory.updateNft(
      eligibilityNftSlot,
      newEligibilityNftData,
    );

    // 11. Update wallet registry for both wallets
    const oldPharmacyState = this.registry.getState(pharmacyWalletId);
    this.registry.updateState(
      pharmacyWalletId,
      new WalletState({
        walletId: pharmacyWalletId,
        nftInventoryRoot: newPharmacyInventoryRoot,
        nonce: Field(BigInt(oldPharmacyState.nonce.toString()) + 1n),
      }),
    );

    const oldMemberState = this.registry.getState(memberWalletId);
    this.registry.updateState(
      memberWalletId,
      new WalletState({
        walletId: memberWalletId,
        nftInventoryRoot: newMemberInventoryRoot,
        nonce: Field(BigInt(oldMemberState.nonce.toString()) + 1n),
      }),
    );

    // 12. Store proof
    const proofId = `acc-fulfill-${fulfillmentSlotIndex}-${Date.now()}`;
    await this.store.saveProof(proofId, JSON.stringify(result.proof.toJSON()));

    return {
      proof: result.proof,
      newPrescriptionNftData,
      newEligibilityNftData,
      newPharmacyInventoryRoot,
      newMemberInventoryRoot,
      fulfillmentEntry: fulfillmentData,
      fulfillmentIndex: fulfillmentSlotIndex,
      patientPayCents: output.patientPayCents,
      planPayCents: output.planPayCents,
      newAccumulatorData,
    };
  }

  // ─── Reversal with Accumulator ─────────────────────────────

  async reverseFulfillmentWithAccumulator(
    pharmacyWalletId: Field,
    memberWalletId: Field,
    prescriptionNft: NftData,
    eligibilityNft: NftData,
    prescriptionData: PrescriptionData,
    originalFulfillment: FulfillmentData,
    reversalData: ReversalData,
    prescriptionForest: MerkleForest,
    eligibilityForest: MerkleForest,
    rxLeafIndex: bigint,
    originalFulfillmentIndex: bigint,
    originalPatientPay: Field,
    originalPlanPay: Field,
    accumulatorData: AccumulatorData,
    accumulatorLeafIndex: bigint,
    pharmacyInventory: NftInventory,
    memberInventory: NftInventory,
    prescriptionNftSlot: bigint,
    eligibilityNftSlot: bigint,
  ): Promise<AccumulatorReversalResult> {
    // 1. Build ALL witnesses BEFORE mutation
    const rxForestRoots = ForestRoots.fromForest(prescriptionForest);
    const medicationWitness = prescriptionForest.getWitness(
      ForestDomain.MEDICATION,
      rxLeafIndex,
    );
    const fulfillmentWitness = prescriptionForest.getWitness(
      ForestDomain.TRANSACTION,
      originalFulfillmentIndex,
    );
    const reversalSlotIndex = originalFulfillmentIndex + 1n;
    const reversalSlotWitness = prescriptionForest.getWitness(
      ForestDomain.TRANSACTION,
      reversalSlotIndex,
    );

    const eligForestRoots = ForestRoots.fromForest(eligibilityForest);
    const accumulatorWitness = eligibilityForest.getWitness(
      ForestDomain.ACCESS_CONTROL,
      accumulatorLeafIndex,
    );

    // 2. Generate proof
    const result = await AccumulatorFulfillmentProgram.proveReversalWithAccumulator(
      prescriptionNft,
      prescriptionData,
      originalFulfillment,
      reversalData,
      rxForestRoots,
      medicationWitness,
      fulfillmentWitness,
      reversalSlotWitness,
      originalPatientPay,
      originalPlanPay,
      eligibilityNft,
      eligForestRoots,
      accumulatorData,
      accumulatorWitness,
    );

    const output = result.proof.publicOutput;

    // 3. Mutate prescription forest (reversal commitment)
    prescriptionForest.setLeaf(
      ForestDomain.TRANSACTION,
      reversalSlotIndex,
      reversalData.commitment(),
    );

    // 4. Create new prescription NftData
    const newPrescriptionNftData = new NftData({
      nftType: prescriptionNft.nftType,
      forestRoot: prescriptionForest.getForestRoot(),
      issuerWalletId: prescriptionNft.issuerWalletId,
      subjectWalletId: prescriptionNft.subjectWalletId,
      issuedAt: prescriptionNft.issuedAt,
      expiresAt: prescriptionNft.expiresAt,
      revoked: prescriptionNft.revoked,
    });

    // 5. Update prescription NFT in pharmacy inventory
    const newPharmacyInventoryRoot = pharmacyInventory.updateNft(
      prescriptionNftSlot,
      newPrescriptionNftData,
    );

    // 6. Compute reversed accumulator off-chain
    const origPatBig = BigInt(originalPatientPay.toString());
    const origPlanBig = BigInt(originalPlanPay.toString());
    const newAccumulatorData = new AccumulatorData({
      planYear: accumulatorData.planYear,
      deductibleAmountCents: accumulatorData.deductibleAmountCents,
      deductiblePaidCents: Field(
        BigInt(accumulatorData.deductiblePaidCents.toString()) - origPatBig,
      ),
      oopMaxCents: accumulatorData.oopMaxCents,
      oopPaidCents: Field(
        BigInt(accumulatorData.oopPaidCents.toString()) - origPatBig,
      ),
      annualBenefitMaxCents: accumulatorData.annualBenefitMaxCents,
      annualBenefitUsedCents: Field(
        BigInt(accumulatorData.annualBenefitUsedCents.toString()) - origPlanBig,
      ),
    });

    // 7. Mutate eligibility forest
    eligibilityForest.setLeaf(
      ForestDomain.ACCESS_CONTROL,
      accumulatorLeafIndex,
      newAccumulatorData.commitment(),
    );

    // 8. Create new eligibility NftData
    const newEligibilityNftData = new NftData({
      nftType: eligibilityNft.nftType,
      forestRoot: eligibilityForest.getForestRoot(),
      issuerWalletId: eligibilityNft.issuerWalletId,
      subjectWalletId: eligibilityNft.subjectWalletId,
      issuedAt: eligibilityNft.issuedAt,
      expiresAt: eligibilityNft.expiresAt,
      revoked: eligibilityNft.revoked,
    });

    // 9. Update eligibility NFT in member inventory
    const newMemberInventoryRoot = memberInventory.updateNft(
      eligibilityNftSlot,
      newEligibilityNftData,
    );

    // 10. Update wallet registry for both wallets
    const oldPharmacyState = this.registry.getState(pharmacyWalletId);
    this.registry.updateState(
      pharmacyWalletId,
      new WalletState({
        walletId: pharmacyWalletId,
        nftInventoryRoot: newPharmacyInventoryRoot,
        nonce: Field(BigInt(oldPharmacyState.nonce.toString()) + 1n),
      }),
    );

    const oldMemberState = this.registry.getState(memberWalletId);
    this.registry.updateState(
      memberWalletId,
      new WalletState({
        walletId: memberWalletId,
        nftInventoryRoot: newMemberInventoryRoot,
        nonce: Field(BigInt(oldMemberState.nonce.toString()) + 1n),
      }),
    );

    // 11. Store proof
    const proofId = `acc-reversal-${reversalSlotIndex}-${Date.now()}`;
    await this.store.saveProof(proofId, JSON.stringify(result.proof.toJSON()));

    return {
      proof: result.proof,
      newPrescriptionNftData,
      newEligibilityNftData,
      newPharmacyInventoryRoot,
      newMemberInventoryRoot,
      reversalEntry: reversalData,
      reversalIndex: reversalSlotIndex,
      patientRefundCents: output.patientPayCents,
      planRefundCents: output.planPayCents,
      newAccumulatorData,
    };
  }

  // ─── Helpers ───────────────────────────────────────────────

  /**
   * Calculate accumulator-aware settlement amounts off-chain.
   *
   * Mirrors the in-circuit logic exactly:
   *   1. OOPM met → patient $0
   *   2. Benefit exhausted → patient pays total
   *   3. In deductible → patient pays min(total, remaining deductible)
   *   4. Normal → patient pays min(total, formulary copay)
   */
  calculateAccumulatorAwareAmounts(
    fulfillmentData: FulfillmentData,
    formularyEntry: FormularyEntry,
    accumulatorData: AccumulatorData,
  ): { patientPayCents: Field; planPayCents: Field } {
    const total = BigInt(fulfillmentData.ingredientCostCents.toString())
      + BigInt(fulfillmentData.dispensingFeeCents.toString());
    const copay = BigInt(formularyEntry.copayAmountCents.toString());
    const deductibleLimit = BigInt(accumulatorData.deductibleAmountCents.toString());
    const deductiblePaid = BigInt(accumulatorData.deductiblePaidCents.toString());
    const oopMax = BigInt(accumulatorData.oopMaxCents.toString());
    const oopPaid = BigInt(accumulatorData.oopPaidCents.toString());
    const benefitMax = BigInt(accumulatorData.annualBenefitMaxCents.toString());
    const benefitUsed = BigInt(accumulatorData.annualBenefitUsedCents.toString());

    // OOPM met → patient pays $0 (highest priority)
    if (oopMax > 0n && oopPaid >= oopMax) {
      return { patientPayCents: Field(0), planPayCents: Field(total) };
    }

    // Benefit exhausted → patient pays total
    if (benefitMax > 0n && benefitUsed >= benefitMax) {
      return { patientPayCents: Field(total), planPayCents: Field(0) };
    }

    let patientPay: bigint;

    // Deductible phase
    if (deductibleLimit > 0n && deductiblePaid < deductibleLimit) {
      const remaining = deductibleLimit - deductiblePaid;
      patientPay = total < remaining ? total : remaining;
    } else {
      // Normal copay phase
      patientPay = total < copay ? total : copay;
    }

    const planPay = total - patientPay;
    return { patientPayCents: Field(patientPay), planPayCents: Field(planPay) };
  }
}
