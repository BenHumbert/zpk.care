import { Field, Struct, Poseidon, Provable, ZkProgram } from 'o1js';
import { CredentialData, CREDENTIAL_TYPE_PRESCRIPTION, CREDENTIAL_TYPE_ELIGIBILITY } from '../credentials/credential-data.js';
import { ForestRoots } from '../eligibility/forest-roots.js';
import { ForestMerkleWitness } from '../zkp/merkle-forest.js';
import { FormularyEntry } from '../access-control/formulary-entry.js';
import { FormularyMerkleWitness } from '../access-control/formulary-registry.js';
import { AccumulatorData } from '../access-control/accumulator-data.js';
import {
  PrescriptionData,
  PrescriptionStatusData,
  RX_STATUS_FILLED,
  RX_STATUS_PARTIALLY_FILLED,
} from '../prescription/prescription-data.js';
import { FulfillmentData, ReversalData } from './fulfillment-data.js';
import { FULFILL_OP_CLAIM, FULFILL_OP_REVERSAL } from './fulfillment-program.js';
import { DOMAIN_TAG_PHARMACY } from '../wallets/wallet-derivation.js';

// ─── AccumulatorFulfillmentOutput ─────────────────────────────

/**
 * AccumulatorFulfillmentOutput — public output with accumulator support.
 *
 * Extends FulfillmentOutput pattern with newEligibilityForestRoot
 * to track the eligibility credential's forest root after accumulator update.
 */
export class AccumulatorFulfillmentOutput extends Struct({
  /** Links to PrescriptionData.commitment() */
  prescriptionHash: Field,
  /** Prescription credential's forest root before the update */
  oldForestRoot: Field,
  /** Prescription credential's forest root after the update */
  newForestRoot: Field,
  /** FulfillmentData.commitment() — claim data hash */
  entryCommitment: Field,
  /** Accumulator-adjusted patient pay in cents */
  patientPayCents: Field,
  /** Accumulator-adjusted plan pay in cents */
  planPayCents: Field,
  /** Field(1) = fulfillment, Field(2) = reversal */
  operationType: Field,
  /** Eligibility credential's forest root after accumulator update */
  newEligibilityForestRoot: Field,
  /** Portion of patientPay credited toward deductible (for reversal tracking) */
  deductibleCreditCents: Field,
  /** Poseidon hash of NDC code — drug identity proven by circuit */
  ndcHash: Field,
}) {}

// ─── AccumulatorFulfillmentProgram ────────────────────────────

/**
 * AccumulatorFulfillmentProgram — ZkProgram with accumulator-aware settlement.
 *
 * Operates on TWO credentials simultaneously:
 *   - Prescription credential (pharmacy's wallet): claim data + transaction history
 *   - Eligibility credential (member's wallet): accumulator state at leaf 127
 *
 * The ZK proof IS the adjudication — copay is computed in-circuit
 * considering deductible, OOPM, and annual benefit maximum.
 *
 * Priority order (outermost Provable.if = highest priority):
 *   1. OOPM met → patient pays $0 (highest — regulatory requirement)
 *   2. Benefit exhausted → patient pays total
 *   3. In deductible phase → patient pays min(total, remaining deductible)
 *   4. Normal → patient pays min(total, formulary copay)
 */
export const AccumulatorFulfillmentProgram = ZkProgram({
  name: 'AccumulatorFulfillment',
  publicOutput: AccumulatorFulfillmentOutput,

  methods: {
    /**
     * Prove a valid claim fulfillment with accumulator-aware settlement.
     *
     * Steps 1-12: Same as FulfillmentProgram.proveFulfillment
     * Steps 13-22: Eligibility credential verification + accumulator logic
     */
    proveFulfillmentWithAccumulator: {
      privateInputs: [
        CredentialData,                    // prescription credential
        PrescriptionData,
        PrescriptionStatusData,
        FulfillmentData,
        FormularyEntry,
        ForestRoots,                // prescription forest roots
        ForestMerkleWitness,        // MEDICATION: prescription at leaf
        ForestMerkleWitness,        // TRANSACTION: latest status at leaf N
        ForestMerkleWitness,        // TRANSACTION: new fulfillment slot (empty)
        FormularyMerkleWitness,     // formulary entry in formulary tree
        Field,                      // formularyRoot
        CredentialData,                    // eligibility credential
        ForestRoots,                // eligibility forest roots
        AccumulatorData,            // current accumulator state
        ForestMerkleWitness,        // accumulator in eligibility ACCESS_CONTROL tree
        Field,                      // H2: pharmacy qualifier
        Field,                      // H2: pharmacy serviceProviderIdHash
        Field,                      // H2: pharmacy enrollmentKeyHash
      ],
      async method(
        credentialData: CredentialData,
        prescriptionData: PrescriptionData,
        latestStatus: PrescriptionStatusData,
        fulfillmentData: FulfillmentData,
        formularyEntry: FormularyEntry,
        forestRoots: ForestRoots,
        medicationWitness: ForestMerkleWitness,
        statusWitness: ForestMerkleWitness,
        newSlotWitness: ForestMerkleWitness,
        formularyWitness: FormularyMerkleWitness,
        formularyRoot: Field,
        eligCredentialData: CredentialData,
        eligForestRoots: ForestRoots,
        accumulator: AccumulatorData,
        accumulatorWitness: ForestMerkleWitness,
        pharmacyQualifier: Field,
        pharmacyServiceProviderIdHash: Field,
        pharmacyEnrollmentKeyHash: Field,
      ) {
        // ── Steps 1-12: Prescription credential validation (same as FulfillmentProgram) ──

        // 1. Credential type is PRESCRIPTION
        credentialData.credentialType.assertEquals(
          CREDENTIAL_TYPE_PRESCRIPTION,
          'Credential type must be PRESCRIPTION',
        );

        // 2. Credential is not revoked
        credentialData.revoked.assertEquals(Field(0), 'Credential is revoked');

        // 2b. H2 fix: Verify pharmacy wallet identity binding.
        const computedPharmacyWalletId = Poseidon.hash([
          DOMAIN_TAG_PHARMACY,
          pharmacyQualifier,
          pharmacyServiceProviderIdHash,
          pharmacyEnrollmentKeyHash,
        ]);
        computedPharmacyWalletId.assertEquals(
          fulfillmentData.pharmacyWalletId,
          'Pharmacy wallet identity binding failed',
        );

        // 3. Forest root integrity
        const computedForestRoot = forestRoots.computeForestRoot();
        computedForestRoot.assertEquals(
          credentialData.forestRoot,
          'Forest root mismatch',
        );

        // 4. Prescription data in MEDICATION tree
        const rxCommitment = prescriptionData.commitment();
        medicationWitness
          .calculateRoot(rxCommitment)
          .assertEquals(
            forestRoots.medicationRoot,
            'Prescription not in MEDICATION tree',
          );

        // 5. Latest status in TRANSACTION tree
        statusWitness
          .calculateRoot(latestStatus.commitment())
          .assertEquals(
            forestRoots.transactionRoot,
            'Status not in TRANSACTION tree',
          );

        // 6. Status must be FILLED or PARTIALLY_FILLED
        const isFilled = latestStatus.status.equals(RX_STATUS_FILLED);
        const isPartiallyFilled = latestStatus.status.equals(RX_STATUS_PARTIALLY_FILLED);
        isFilled.or(isPartiallyFilled).assertTrue(
          'Prescription must be FILLED or PARTIALLY_FILLED',
        );

        // 7. New TRANSACTION slot is empty
        newSlotWitness
          .calculateRoot(Field(0))
          .assertEquals(
            forestRoots.transactionRoot,
            'New TRANSACTION slot is not empty',
          );

        // 8. FulfillmentData links to correct prescription
        fulfillmentData.prescriptionHash.assertEquals(
          rxCommitment,
          'Fulfillment prescriptionHash mismatch',
        );

        // 9. NDC matches prescription
        fulfillmentData.ndcHash.assertEquals(
          prescriptionData.ndcHash,
          'NDC does not match prescription',
        );

        // 10. Quantity within formulary limits
        fulfillmentData.quantityDispensed
          .lessThanOrEqual(formularyEntry.maxQuantityPerFill)
          .assertTrue('Quantity exceeds max per fill');

        // 10b. Quantity dispensed must not exceed quantity prescribed (FWA guard)
        fulfillmentData.quantityDispensed
          .lessThanOrEqual(prescriptionData.quantityPrescribed)
          .assertTrue('Quantity dispensed exceeds quantity prescribed');

        // 11. Formulary entry in formulary tree
        formularyWitness
          .calculateRoot(formularyEntry.commitment())
          .assertEquals(
            formularyRoot,
            'Formulary entry not in formulary tree',
          );

        // 12. Formulary NDC matches claim NDC
        formularyEntry.ndcHash.assertEquals(
          fulfillmentData.ndcHash,
          'Formulary NDC does not match claim',
        );

        // ── Steps 13-15: Eligibility credential + Accumulator verification ──

        // 13. Eligibility credential is ELIGIBILITY type, not revoked
        eligCredentialData.credentialType.assertEquals(
          CREDENTIAL_TYPE_ELIGIBILITY,
          'Elig credential type must be ELIGIBILITY',
        );
        eligCredentialData.revoked.assertEquals(Field(0), 'Elig credential is revoked');

        // 13b. Prescription patient must match eligibility credential subject (H1 fix).
        // Prevents using a different patient's accumulator state.
        prescriptionData.memberWalletId.assertEquals(
          eligCredentialData.subjectWalletId,
          'Prescription patient does not match eligibility credential subject',
        );

        // 14. Eligibility forest root integrity
        const eligComputedRoot = eligForestRoots.computeForestRoot();
        eligComputedRoot.assertEquals(
          eligCredentialData.forestRoot,
          'Elig forest root mismatch',
        );

        // 15. Accumulator in eligibility ACCESS_CONTROL tree
        accumulatorWitness
          .calculateRoot(accumulator.commitment())
          .assertEquals(
            eligForestRoots.accessControlRoot,
            'Accumulator not in ACCESS_CONTROL tree',
          );

        // ── Step 16: Accumulator-aware copay calculation ──
        //
        // Priority (outermost = highest):
        //   1. OOPM met/mid-claim cap → patient pays min(remaining OOPM, computed)
        //   2. Benefit exhausted/mid-claim cap → plan pays min(remaining benefit, computed)
        //   3. Deductible phase → patient pays deductible portion + copay on remainder
        //   4. Normal → patient pays min(total, formulary copay)

        const total = fulfillmentData.ingredientCostCents.add(
          fulfillmentData.dispensingFeeCents,
        );
        const copay = formularyEntry.copayAmountCents;

        // ── 16a: Deductible calculation ──
        const hasDeductible = accumulator.deductibleAmountCents.greaterThan(Field(0));
        const deductibleMet = accumulator.deductiblePaidCents
          .greaterThanOrEqual(accumulator.deductibleAmountCents);
        const inDeductiblePhase = hasDeductible.and(deductibleMet.not());

        const remainingDeductible = Provable.if(
          inDeductiblePhase,
          accumulator.deductibleAmountCents.sub(accumulator.deductiblePaidCents),
          Field(0),
        );

        // Deductible portion = min(total, remainingDeductible)
        const deductiblePay = Provable.if(
          total.lessThan(remainingDeductible),
          total,
          remainingDeductible,
        );

        // Amount remaining after deductible is satisfied
        const afterDeductible = total.sub(deductiblePay);

        // ── 16b: Copay on post-deductible amount (C5 fix: split payment) ──
        // When claim straddles deductible boundary, copay applies to the excess
        const copayOnRemainder = Provable.if(
          afterDeductible.lessThan(copay),
          afterDeductible,
          copay,
        );

        // Normal copay (when deductible already met or no deductible)
        const normalPay = Provable.if(total.lessThan(copay), total, copay);

        // Patient base pay:
        //   in deductible phase: deductiblePay + copayOnRemainder
        //   otherwise: normalPay
        const basePay = Provable.if(
          inDeductiblePhase,
          deductiblePay.add(copayOnRemainder),
          normalPay,
        );

        // ── 16c: Benefit maximum mid-claim cap (C2 fix) ──
        const hasBenefitMax = accumulator.annualBenefitMaxCents.greaterThan(Field(0));
        const benefitFullyExhausted = hasBenefitMax.and(
          accumulator.annualBenefitUsedCents
            .greaterThanOrEqual(accumulator.annualBenefitMaxCents),
        );

        const basePlanPay = total.sub(basePay);

        // Remaining benefit = benefit exhausted ? 0 : (has limit ? max-used : unlimited)
        const remainingBenefit = Provable.if(
          benefitFullyExhausted,
          Field(0),
          Provable.if(
            hasBenefitMax,
            accumulator.annualBenefitMaxCents.sub(accumulator.annualBenefitUsedCents),
            basePlanPay, // no limit → effectively unlimited
          ),
        );

        // Cap plan pay at remaining benefit
        const cappedPlanPay = Provable.if(
          hasBenefitMax.and(basePlanPay.greaterThan(remainingBenefit)),
          remainingBenefit,
          basePlanPay,
        );

        // Patient picks up what plan can't cover
        const postBenefitPay = total.sub(cappedPlanPay);

        // ── 16d: OOPM mid-claim cap (C3 fix — ACA requirement) ──
        const hasOopm = accumulator.oopMaxCents.greaterThan(Field(0));
        const oopFullyMet = hasOopm.and(
          accumulator.oopPaidCents
            .greaterThanOrEqual(accumulator.oopMaxCents),
        );

        // Remaining OOPM = OOPM met ? 0 : (has OOPM ? max-paid : unlimited)
        const remainingOopm = Provable.if(
          oopFullyMet,
          Field(0),
          Provable.if(
            hasOopm,
            accumulator.oopMaxCents.sub(accumulator.oopPaidCents),
            postBenefitPay, // no OOPM → effectively unlimited
          ),
        );

        // Cap patient pay at remaining OOPM
        const patientPay = Provable.if(
          hasOopm.and(postBenefitPay.greaterThan(remainingOopm)),
          remainingOopm,
          postBenefitPay,
        );

        const planPay = total.sub(patientPay);

        // ── 16e: Deductible credit for accumulator update (C4 fix) ──
        // Only the deductible portion counts toward deductiblePaidCents.
        // If OOPM/benefit caps reduced patientPay below deductiblePay,
        // credit = min(deductiblePay, patientPay)
        const deductibleCredit = Provable.if(
          patientPay.lessThan(deductiblePay),
          patientPay,
          deductiblePay,
        );

        // ── Step 17: Settlement commitment (includes deductibleCredit for reversal) ──

        const fulfillmentCommitment = fulfillmentData.commitment();
        const settlementCommitment = Poseidon.hash([
          fulfillmentCommitment,
          patientPay,
          planPay,
          deductibleCredit,
        ]);

        // ── Step 18: Update accumulator (C4 fix: deductibleCredit, not patientPay) ──

        const newAccumulatorCommitment = Poseidon.hash([
          accumulator.planYear,
          accumulator.deductibleAmountCents,
          accumulator.deductiblePaidCents.add(deductibleCredit),
          accumulator.oopMaxCents,
          accumulator.oopPaidCents.add(patientPay),
          accumulator.annualBenefitMaxCents,
          accumulator.annualBenefitUsedCents.add(planPay),
        ]);

        // ── Step 19-20: Compute new eligibility roots ──

        const newEligACRoot = accumulatorWitness.calculateRoot(
          newAccumulatorCommitment,
        );
        const newEligForestRoot = Poseidon.hash([
          eligForestRoots.memberRoot,
          eligForestRoots.prescriberRoot,
          eligForestRoots.pharmacyRoot,
          eligForestRoots.medicationRoot,
          newEligACRoot,
          eligForestRoots.transactionRoot,
        ]);

        // ── Step 21: Compute new prescription roots ──

        const newTxRoot = newSlotWitness.calculateRoot(settlementCommitment);
        const newForestRoot = Poseidon.hash([
          forestRoots.memberRoot,
          forestRoots.prescriberRoot,
          forestRoots.pharmacyRoot,
          forestRoots.medicationRoot,
          forestRoots.accessControlRoot,
          newTxRoot,
        ]);

        // ── Step 22: Return ──

        return {
          publicOutput: new AccumulatorFulfillmentOutput({
            prescriptionHash: rxCommitment,
            oldForestRoot: credentialData.forestRoot,
            newForestRoot,
            entryCommitment: fulfillmentCommitment,
            patientPayCents: patientPay,
            planPayCents: planPay,
            operationType: FULFILL_OP_CLAIM,
            newEligibilityForestRoot: newEligForestRoot,
            deductibleCreditCents: deductibleCredit,
            ndcHash: fulfillmentData.ndcHash,
          }),
        };
      },
    },

    /**
     * Prove a valid reversal with accumulator adjustment.
     *
     * Verifies the original settlement amounts via the settlement commitment
     * stored in the TRANSACTION tree, then reverses those amounts from the
     * accumulator.
     */
    proveReversalWithAccumulator: {
      privateInputs: [
        CredentialData,                    // prescription credential
        PrescriptionData,
        FulfillmentData,            // original fulfillment
        ReversalData,
        ForestRoots,                // prescription forest roots
        ForestMerkleWitness,        // MEDICATION: prescription at leaf
        ForestMerkleWitness,        // TRANSACTION: settlement commitment at leaf K
        ForestMerkleWitness,        // TRANSACTION: reversal slot (empty)
        Field,                      // originalPatientPay
        Field,                      // originalPlanPay
        Field,                      // originalDeductibleCredit
        CredentialData,                    // eligibility credential
        ForestRoots,                // eligibility forest roots
        AccumulatorData,            // current accumulator state
        ForestMerkleWitness,        // accumulator in eligibility ACCESS_CONTROL tree
        Field,                      // H2: pharmacy qualifier
        Field,                      // H2: pharmacy serviceProviderIdHash
        Field,                      // H2: pharmacy enrollmentKeyHash
      ],
      async method(
        credentialData: CredentialData,
        prescriptionData: PrescriptionData,
        originalFulfillment: FulfillmentData,
        reversalData: ReversalData,
        forestRoots: ForestRoots,
        medicationWitness: ForestMerkleWitness,
        fulfillmentWitness: ForestMerkleWitness,
        reversalSlotWitness: ForestMerkleWitness,
        originalPatientPay: Field,
        originalPlanPay: Field,
        originalDeductibleCredit: Field,
        eligCredentialData: CredentialData,
        eligForestRoots: ForestRoots,
        accumulator: AccumulatorData,
        accumulatorWitness: ForestMerkleWitness,
        pharmacyQualifier: Field,
        pharmacyServiceProviderIdHash: Field,
        pharmacyEnrollmentKeyHash: Field,
      ) {
        // ── Steps 1-3: Prescription credential validation ──

        // 1. Credential type is PRESCRIPTION
        credentialData.credentialType.assertEquals(
          CREDENTIAL_TYPE_PRESCRIPTION,
          'Credential type must be PRESCRIPTION',
        );

        // 2. Credential is not revoked
        credentialData.revoked.assertEquals(Field(0), 'Credential is revoked');

        // 2b. H2 fix: Verify pharmacy wallet identity binding for reversal.
        const computedPharmacyWalletId = Poseidon.hash([
          DOMAIN_TAG_PHARMACY,
          pharmacyQualifier,
          pharmacyServiceProviderIdHash,
          pharmacyEnrollmentKeyHash,
        ]);
        computedPharmacyWalletId.assertEquals(
          originalFulfillment.pharmacyWalletId,
          'Pharmacy wallet identity binding failed',
        );

        // 3. Forest root integrity
        const computedForestRoot = forestRoots.computeForestRoot();
        computedForestRoot.assertEquals(
          credentialData.forestRoot,
          'Forest root mismatch',
        );

        // 4. Prescription data in MEDICATION tree
        const rxCommitment = prescriptionData.commitment();
        medicationWitness
          .calculateRoot(rxCommitment)
          .assertEquals(
            forestRoots.medicationRoot,
            'Prescription not in MEDICATION tree',
          );

        // 5. Original fulfillment in TRANSACTION tree via SETTLEMENT commitment
        const origCommitment = originalFulfillment.commitment();
        const origSettlementCommitment = Poseidon.hash([
          origCommitment,
          originalPatientPay,
          originalPlanPay,
          originalDeductibleCredit,
        ]);
        fulfillmentWitness
          .calculateRoot(origSettlementCommitment)
          .assertEquals(
            forestRoots.transactionRoot,
            'Settlement commitment not in TRANSACTION tree',
          );

        // 6. Reversal slot is empty
        reversalSlotWitness
          .calculateRoot(Field(0))
          .assertEquals(
            forestRoots.transactionRoot,
            'Reversal slot is not empty',
          );

        // 7. ReversalData links to correct fulfillment
        reversalData.fulfillmentHash.assertEquals(
          origCommitment,
          'Reversal fulfillmentHash mismatch',
        );

        // 8. Reversal amounts must match original settlement
        reversalData.patientRefundCents.assertEquals(
          originalPatientPay,
          'Patient refund does not match original payment',
        );
        reversalData.planRefundCents.assertEquals(
          originalPlanPay,
          'Plan refund does not match original payment',
        );

        // ── Steps 9-11: Eligibility credential + Accumulator verification ──

        // 9. Eligibility credential is ELIGIBILITY type, not revoked
        eligCredentialData.credentialType.assertEquals(
          CREDENTIAL_TYPE_ELIGIBILITY,
          'Elig credential type must be ELIGIBILITY',
        );
        eligCredentialData.revoked.assertEquals(Field(0), 'Elig credential is revoked');

        // 9b. Prescription patient must match eligibility credential subject (H1 fix).
        prescriptionData.memberWalletId.assertEquals(
          eligCredentialData.subjectWalletId,
          'Prescription patient does not match eligibility credential subject',
        );

        // 10. Eligibility forest root integrity
        const eligComputedRoot = eligForestRoots.computeForestRoot();
        eligComputedRoot.assertEquals(
          eligCredentialData.forestRoot,
          'Elig forest root mismatch',
        );

        // 11. Accumulator in eligibility ACCESS_CONTROL tree
        accumulatorWitness
          .calculateRoot(accumulator.commitment())
          .assertEquals(
            eligForestRoots.accessControlRoot,
            'Accumulator not in ACCESS_CONTROL tree',
          );

        // ── Step 12: Reverse accumulator (C1 fix: safe subtraction, C4 fix: deductibleCredit) ──

        // Safe subtraction: clamp to 0 instead of wrapping mod p
        const newDeductiblePaid = Provable.if(
          accumulator.deductiblePaidCents.greaterThanOrEqual(originalDeductibleCredit),
          accumulator.deductiblePaidCents.sub(originalDeductibleCredit),
          Field(0),
        );
        const newOopPaid = Provable.if(
          accumulator.oopPaidCents.greaterThanOrEqual(originalPatientPay),
          accumulator.oopPaidCents.sub(originalPatientPay),
          Field(0),
        );
        const newBenefitUsed = Provable.if(
          accumulator.annualBenefitUsedCents.greaterThanOrEqual(originalPlanPay),
          accumulator.annualBenefitUsedCents.sub(originalPlanPay),
          Field(0),
        );

        const newAccumulatorCommitment = Poseidon.hash([
          accumulator.planYear,
          accumulator.deductibleAmountCents,
          newDeductiblePaid,
          accumulator.oopMaxCents,
          newOopPaid,
          accumulator.annualBenefitMaxCents,
          newBenefitUsed,
        ]);

        // ── Step 13-14: Compute new eligibility roots ──

        const newEligACRoot = accumulatorWitness.calculateRoot(
          newAccumulatorCommitment,
        );
        const newEligForestRoot = Poseidon.hash([
          eligForestRoots.memberRoot,
          eligForestRoots.prescriberRoot,
          eligForestRoots.pharmacyRoot,
          eligForestRoots.medicationRoot,
          newEligACRoot,
          eligForestRoots.transactionRoot,
        ]);

        // ── Step 15-16: Compute new prescription roots ──

        const reversalCommitment = reversalData.commitment();
        const newTxRoot = reversalSlotWitness.calculateRoot(reversalCommitment);
        const newForestRoot = Poseidon.hash([
          forestRoots.memberRoot,
          forestRoots.prescriberRoot,
          forestRoots.pharmacyRoot,
          forestRoots.medicationRoot,
          forestRoots.accessControlRoot,
          newTxRoot,
        ]);

        // ── Step 17: Return ──

        return {
          publicOutput: new AccumulatorFulfillmentOutput({
            prescriptionHash: rxCommitment,
            oldForestRoot: credentialData.forestRoot,
            newForestRoot,
            entryCommitment: origCommitment,
            patientPayCents: originalPatientPay,
            planPayCents: originalPlanPay,
            operationType: FULFILL_OP_REVERSAL,
            newEligibilityForestRoot: newEligForestRoot,
            deductibleCreditCents: originalDeductibleCredit,
            ndcHash: originalFulfillment.ndcHash,
          }),
        };
      },
    },
  },
});

/** Named class for SmartContract compatibility (reflect-metadata needs named class) */
export class AccumulatorFulfillmentProof extends ZkProgram.Proof(AccumulatorFulfillmentProgram) {}
