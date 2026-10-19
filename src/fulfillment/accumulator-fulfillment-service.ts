/*
 * Copyright 2026 Ben Humbert
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { Field, Poseidon } from 'o1js';
import type { ILocalStore } from '../storage/local-store.js';
import { WalletRegistry, WalletState } from '../wallets/wallet-state.js';
import { CredentialData } from '../credentials/credential-data.js';
import { CredentialInventory } from '../credentials/credential-inventory.js';
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
  newPrescriptionCredentialData: CredentialData;
  newEligibilityCredentialData: CredentialData;
  newPharmacyInventoryRoot: Field;
  newMemberInventoryRoot: Field;
  fulfillmentEntry: FulfillmentData;
  fulfillmentIndex: bigint;
  patientPayCents: Field;
  planPayCents: Field;
  deductibleCreditCents: Field;
  newAccumulatorData: AccumulatorData;
}

/**
 * Result of reversing a fulfillment with accumulator.
 */
export interface AccumulatorReversalResult {
  proof: Awaited<ReturnType<typeof AccumulatorFulfillmentProgram.proveReversalWithAccumulator>>['proof'];
  newPrescriptionCredentialData: CredentialData;
  newEligibilityCredentialData: CredentialData;
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
 * Operates on TWO credentials:
 *   - Prescription credential (pharmacy wallet): claim data + TRANSACTION tree
 *   - Eligibility credential (member wallet): accumulator at ACCESS_CONTROL leaf 127
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
    prescriptionCredential: CredentialData,
    eligibilityCredential: CredentialData,
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
    pharmacyInventory: CredentialInventory,
    memberInventory: CredentialInventory,
    prescriptionCredentialSlot: bigint,
    eligibilityCredentialSlot: bigint,
    pharmacyPreimage: Field[] = [],
    /** B8: the family's totals before this fill and the plan's family limits, in cents; zeros mean no family pooling */
    family: { deductiblePaidCents: number; oopPaidCents: number; benefitUsedCents: number; deductibleAmountCents: number; oopMaxCents: number; benefitMaxCents: number } = { deductiblePaidCents: 0, oopPaidCents: 0, benefitUsedCents: 0, deductibleAmountCents: 0, oopMaxCents: 0, benefitMaxCents: 0 },
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
      prescriptionCredential,
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
      eligibilityCredential,
      eligForestRoots,
      accumulatorData,
      accumulatorWitness,
      // H2: pharmacy wallet identity preimage
      pharmacyPreimage[0] ?? Field(0),
      pharmacyPreimage[1] ?? Field(0),
      pharmacyPreimage[2] ?? Field(0),
      // B8: family pooling inside the circuit
      Field(family.deductiblePaidCents),
      Field(family.oopPaidCents),
      Field(family.benefitUsedCents),
      Field(family.deductibleAmountCents),
      Field(family.oopMaxCents),
      Field(family.benefitMaxCents),
    );

    const output = result.proof.publicOutput;

    // 4. Compute settlement commitment and mutate prescription forest
    const settlementCommitment = Poseidon.hash([
      fulfillmentData.commitment(),
      output.patientPayCents,
      output.planPayCents,
      output.deductibleCreditCents,
    ]);
    prescriptionForest.setLeaf(
      ForestDomain.TRANSACTION,
      fulfillmentSlotIndex,
      settlementCommitment,
    );

    // 5. Create new prescription CredentialData
    const newPrescriptionCredentialData = new CredentialData({
      credentialType: prescriptionCredential.credentialType,
      forestRoot: prescriptionForest.getForestRoot(),
      issuerWalletId: prescriptionCredential.issuerWalletId,
      subjectWalletId: prescriptionCredential.subjectWalletId,
      issuedAt: prescriptionCredential.issuedAt,
      expiresAt: prescriptionCredential.expiresAt,
      revoked: prescriptionCredential.revoked,
    });

    // 6. Update prescription credential in pharmacy inventory
    const newPharmacyInventoryRoot = pharmacyInventory.updateCredential(
      prescriptionCredentialSlot,
      newPrescriptionCredentialData,
    );

    // 7. Compute new accumulator data off-chain (C4 fix: deductibleCredit, not patientPay)
    const patientPayBig = BigInt(output.patientPayCents.toString());
    const planPayBig = BigInt(output.planPayCents.toString());
    const deductibleCreditBig = BigInt(output.deductibleCreditCents.toString());
    const newAccumulatorData = new AccumulatorData({
      planYear: accumulatorData.planYear,
      deductibleAmountCents: accumulatorData.deductibleAmountCents,
      deductiblePaidCents: Field(
        BigInt(accumulatorData.deductiblePaidCents.toString()) + deductibleCreditBig,
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

    // 9. Create new eligibility CredentialData
    const newEligibilityCredentialData = new CredentialData({
      credentialType: eligibilityCredential.credentialType,
      forestRoot: eligibilityForest.getForestRoot(),
      issuerWalletId: eligibilityCredential.issuerWalletId,
      subjectWalletId: eligibilityCredential.subjectWalletId,
      issuedAt: eligibilityCredential.issuedAt,
      expiresAt: eligibilityCredential.expiresAt,
      revoked: eligibilityCredential.revoked,
    });

    // 10. Update eligibility credential in member inventory
    const newMemberInventoryRoot = memberInventory.updateCredential(
      eligibilityCredentialSlot,
      newEligibilityCredentialData,
    );

    // 11. Update wallet registry for both wallets
    const oldPharmacyState = this.registry.getState(pharmacyWalletId);
    this.registry.updateState(
      pharmacyWalletId,
      new WalletState({
        walletId: pharmacyWalletId,
        credentialInventoryRoot: newPharmacyInventoryRoot,
        nonce: Field(BigInt(oldPharmacyState.nonce.toString()) + 1n),
      }),
    );

    const oldMemberState = this.registry.getState(memberWalletId);
    this.registry.updateState(
      memberWalletId,
      new WalletState({
        walletId: memberWalletId,
        credentialInventoryRoot: newMemberInventoryRoot,
        nonce: Field(BigInt(oldMemberState.nonce.toString()) + 1n),
      }),
    );

    // 12. Store proof
    const proofId = `acc-fulfill-${fulfillmentSlotIndex}-${Date.now()}`;
    await this.store.saveProof(proofId, JSON.stringify(result.proof.toJSON()));

    return {
      proof: result.proof,
      newPrescriptionCredentialData,
      newEligibilityCredentialData,
      newPharmacyInventoryRoot,
      newMemberInventoryRoot,
      fulfillmentEntry: fulfillmentData,
      fulfillmentIndex: fulfillmentSlotIndex,
      patientPayCents: output.patientPayCents,
      planPayCents: output.planPayCents,
      deductibleCreditCents: output.deductibleCreditCents,
      newAccumulatorData,
    };
  }

  // ─── Reversal with Accumulator ─────────────────────────────

  async reverseFulfillmentWithAccumulator(
    pharmacyWalletId: Field,
    memberWalletId: Field,
    prescriptionCredential: CredentialData,
    eligibilityCredential: CredentialData,
    prescriptionData: PrescriptionData,
    originalFulfillment: FulfillmentData,
    reversalData: ReversalData,
    prescriptionForest: MerkleForest,
    eligibilityForest: MerkleForest,
    rxLeafIndex: bigint,
    originalFulfillmentIndex: bigint,
    originalPatientPay: Field,
    originalPlanPay: Field,
    originalDeductibleCredit: Field,
    accumulatorData: AccumulatorData,
    accumulatorLeafIndex: bigint,
    pharmacyInventory: CredentialInventory,
    memberInventory: CredentialInventory,
    prescriptionCredentialSlot: bigint,
    eligibilityCredentialSlot: bigint,
    pharmacyPreimage: Field[] = [],
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
      prescriptionCredential,
      prescriptionData,
      originalFulfillment,
      reversalData,
      rxForestRoots,
      medicationWitness,
      fulfillmentWitness,
      reversalSlotWitness,
      originalPatientPay,
      originalPlanPay,
      originalDeductibleCredit,
      eligibilityCredential,
      eligForestRoots,
      accumulatorData,
      accumulatorWitness,
      // H2: pharmacy wallet identity preimage
      pharmacyPreimage[0] ?? Field(0),
      pharmacyPreimage[1] ?? Field(0),
      pharmacyPreimage[2] ?? Field(0),
    );

    const output = result.proof.publicOutput;

    // 3. Mutate prescription forest (reversal commitment)
    prescriptionForest.setLeaf(
      ForestDomain.TRANSACTION,
      reversalSlotIndex,
      reversalData.commitment(),
    );

    // 4. Create new prescription CredentialData
    const newPrescriptionCredentialData = new CredentialData({
      credentialType: prescriptionCredential.credentialType,
      forestRoot: prescriptionForest.getForestRoot(),
      issuerWalletId: prescriptionCredential.issuerWalletId,
      subjectWalletId: prescriptionCredential.subjectWalletId,
      issuedAt: prescriptionCredential.issuedAt,
      expiresAt: prescriptionCredential.expiresAt,
      revoked: prescriptionCredential.revoked,
    });

    // 5. Update prescription credential in pharmacy inventory
    const newPharmacyInventoryRoot = pharmacyInventory.updateCredential(
      prescriptionCredentialSlot,
      newPrescriptionCredentialData,
    );

    // 6. Compute reversed accumulator off-chain (C1 fix: safe sub, C4 fix: deductibleCredit)
    const origPatBig = BigInt(originalPatientPay.toString());
    const origPlanBig = BigInt(originalPlanPay.toString());
    const origDeductBig = BigInt(originalDeductibleCredit.toString());
    const curDeductPaid = BigInt(accumulatorData.deductiblePaidCents.toString());
    const curOopPaid = BigInt(accumulatorData.oopPaidCents.toString());
    const curBenefitUsed = BigInt(accumulatorData.annualBenefitUsedCents.toString());
    const newAccumulatorData = new AccumulatorData({
      planYear: accumulatorData.planYear,
      deductibleAmountCents: accumulatorData.deductibleAmountCents,
      deductiblePaidCents: Field(
        curDeductPaid >= origDeductBig ? curDeductPaid - origDeductBig : 0n,
      ),
      oopMaxCents: accumulatorData.oopMaxCents,
      oopPaidCents: Field(
        curOopPaid >= origPatBig ? curOopPaid - origPatBig : 0n,
      ),
      annualBenefitMaxCents: accumulatorData.annualBenefitMaxCents,
      annualBenefitUsedCents: Field(
        curBenefitUsed >= origPlanBig ? curBenefitUsed - origPlanBig : 0n,
      ),
    });

    // 7. Mutate eligibility forest
    eligibilityForest.setLeaf(
      ForestDomain.ACCESS_CONTROL,
      accumulatorLeafIndex,
      newAccumulatorData.commitment(),
    );

    // 8. Create new eligibility CredentialData
    const newEligibilityCredentialData = new CredentialData({
      credentialType: eligibilityCredential.credentialType,
      forestRoot: eligibilityForest.getForestRoot(),
      issuerWalletId: eligibilityCredential.issuerWalletId,
      subjectWalletId: eligibilityCredential.subjectWalletId,
      issuedAt: eligibilityCredential.issuedAt,
      expiresAt: eligibilityCredential.expiresAt,
      revoked: eligibilityCredential.revoked,
    });

    // 9. Update eligibility credential in member inventory
    const newMemberInventoryRoot = memberInventory.updateCredential(
      eligibilityCredentialSlot,
      newEligibilityCredentialData,
    );

    // 10. Update wallet registry for both wallets
    const oldPharmacyState = this.registry.getState(pharmacyWalletId);
    this.registry.updateState(
      pharmacyWalletId,
      new WalletState({
        walletId: pharmacyWalletId,
        credentialInventoryRoot: newPharmacyInventoryRoot,
        nonce: Field(BigInt(oldPharmacyState.nonce.toString()) + 1n),
      }),
    );

    const oldMemberState = this.registry.getState(memberWalletId);
    this.registry.updateState(
      memberWalletId,
      new WalletState({
        walletId: memberWalletId,
        credentialInventoryRoot: newMemberInventoryRoot,
        nonce: Field(BigInt(oldMemberState.nonce.toString()) + 1n),
      }),
    );

    // 11. Store proof
    const proofId = `acc-reversal-${reversalSlotIndex}-${Date.now()}`;
    await this.store.saveProof(proofId, JSON.stringify(result.proof.toJSON()));

    return {
      proof: result.proof,
      newPrescriptionCredentialData,
      newEligibilityCredentialData,
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
   *   1. Deductible phase: patient pays deductible portion + copay on remainder (C5)
   *   2. Benefit max: cap plan pay at remaining benefit (C2)
   *   3. OOPM: cap patient pay at remaining OOPM (C3)
   *   4. Track deductible credit separately (C4)
   */
  calculateAccumulatorAwareAmounts(
    fulfillmentData: FulfillmentData,
    formularyEntry: FormularyEntry,
    accumulatorData: AccumulatorData,
  ): { patientPayCents: Field; planPayCents: Field; deductibleCreditCents: Field } {
    const total = BigInt(fulfillmentData.ingredientCostCents.toString())
      + BigInt(fulfillmentData.dispensingFeeCents.toString());
    const copay = BigInt(formularyEntry.copayAmountCents.toString());
    const deductibleLimit = BigInt(accumulatorData.deductibleAmountCents.toString());
    const deductiblePaid = BigInt(accumulatorData.deductiblePaidCents.toString());
    const oopMax = BigInt(accumulatorData.oopMaxCents.toString());
    const oopPaid = BigInt(accumulatorData.oopPaidCents.toString());
    const benefitMax = BigInt(accumulatorData.annualBenefitMaxCents.toString());
    const benefitUsed = BigInt(accumulatorData.annualBenefitUsedCents.toString());

    // 16a: Deductible calculation
    const inDeductiblePhase = deductibleLimit > 0n && deductiblePaid < deductibleLimit;
    const remainingDeductible = inDeductiblePhase ? deductibleLimit - deductiblePaid : 0n;
    const deductiblePay = total < remainingDeductible ? total : remainingDeductible;
    const afterDeductible = total - deductiblePay;

    // 16b: Copay on post-deductible amount (C5 fix: split payment)
    const copayOnRemainder = afterDeductible < copay ? afterDeductible : copay;
    const normalPay = total < copay ? total : copay;
    const basePay = inDeductiblePhase ? deductiblePay + copayOnRemainder : normalPay;

    // 16c: Benefit maximum mid-claim cap (C2 fix)
    const basePlanPay = total - basePay;
    let cappedPlanPay = basePlanPay;
    if (benefitMax > 0n) {
      const remainingBenefit = benefitUsed >= benefitMax ? 0n : benefitMax - benefitUsed;
      if (basePlanPay > remainingBenefit) {
        cappedPlanPay = remainingBenefit;
      }
    }
    let patientPay = total - cappedPlanPay;

    // 16d: OOPM mid-claim cap (C3 fix)
    if (oopMax > 0n) {
      const remainingOopm = oopPaid >= oopMax ? 0n : oopMax - oopPaid;
      if (patientPay > remainingOopm) {
        patientPay = remainingOopm;
      }
    }

    const planPay = total - patientPay;

    // 16e: Deductible credit (C4 fix)
    const deductibleCredit = patientPay < deductiblePay ? patientPay : deductiblePay;

    return {
      patientPayCents: Field(patientPay),
      planPayCents: Field(planPay),
      deductibleCreditCents: Field(deductibleCredit),
    };
  }
}
