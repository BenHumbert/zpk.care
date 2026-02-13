import { Field, Struct, Poseidon, Provable, ZkProgram } from 'o1js';
import { NftData, NFT_TYPE_PRESCRIPTION, NFT_TYPE_ELIGIBILITY } from '../nft/nft-data.js';
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

// ─── AccumulatorFulfillmentOutput ─────────────────────────────

/**
 * AccumulatorFulfillmentOutput — public output with accumulator support.
 *
 * Extends FulfillmentOutput pattern with newEligibilityForestRoot
 * to track the eligibility NFT's forest root after accumulator update.
 */
export class AccumulatorFulfillmentOutput extends Struct({
  /** Links to PrescriptionData.commitment() */
  prescriptionHash: Field,
  /** Prescription NFT's forest root before the update */
  oldForestRoot: Field,
  /** Prescription NFT's forest root after the update */
  newForestRoot: Field,
  /** FulfillmentData.commitment() — claim data hash */
  entryCommitment: Field,
  /** Accumulator-adjusted patient pay in cents */
  patientPayCents: Field,
  /** Accumulator-adjusted plan pay in cents */
  planPayCents: Field,
  /** Field(1) = fulfillment, Field(2) = reversal */
  operationType: Field,
  /** Eligibility NFT's forest root after accumulator update */
  newEligibilityForestRoot: Field,
}) {}

// ─── AccumulatorFulfillmentProgram ────────────────────────────

/**
 * AccumulatorFulfillmentProgram — ZkProgram with accumulator-aware settlement.
 *
 * Operates on TWO NFTs simultaneously:
 *   - Prescription NFT (pharmacy's wallet): claim data + transaction history
 *   - Eligibility NFT (member's wallet): accumulator state at leaf 127
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
     * Steps 13-22: Eligibility NFT verification + accumulator logic
     */
    proveFulfillmentWithAccumulator: {
      privateInputs: [
        NftData,                    // prescription NFT
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
        NftData,                    // eligibility NFT
        ForestRoots,                // eligibility forest roots
        AccumulatorData,            // current accumulator state
        ForestMerkleWitness,        // accumulator in eligibility ACCESS_CONTROL tree
      ],
      async method(
        nftData: NftData,
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
        eligNftData: NftData,
        eligForestRoots: ForestRoots,
        accumulator: AccumulatorData,
        accumulatorWitness: ForestMerkleWitness,
      ) {
        // ── Steps 1-12: Prescription NFT validation (same as FulfillmentProgram) ──

        // 1. NFT type is PRESCRIPTION
        nftData.nftType.assertEquals(
          NFT_TYPE_PRESCRIPTION,
          'NFT type must be PRESCRIPTION',
        );

        // 2. NFT is not revoked
        nftData.revoked.assertEquals(Field(0), 'NFT is revoked');

        // 3. Forest root integrity
        const computedForestRoot = forestRoots.computeForestRoot();
        computedForestRoot.assertEquals(
          nftData.forestRoot,
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

        // ── Steps 13-15: Eligibility NFT + Accumulator verification ──

        // 13. Eligibility NFT is ELIGIBILITY type, not revoked
        eligNftData.nftType.assertEquals(
          NFT_TYPE_ELIGIBILITY,
          'Elig NFT type must be ELIGIBILITY',
        );
        eligNftData.revoked.assertEquals(Field(0), 'Elig NFT is revoked');

        // 14. Eligibility forest root integrity
        const eligComputedRoot = eligForestRoots.computeForestRoot();
        eligComputedRoot.assertEquals(
          eligNftData.forestRoot,
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

        const total = fulfillmentData.ingredientCostCents.add(
          fulfillmentData.dispensingFeeCents,
        );
        const copay = formularyEntry.copayAmountCents;

        // Deductible phase
        const hasDeductible = accumulator.deductibleAmountCents.greaterThan(Field(0));
        const deductibleMet = accumulator.deductiblePaidCents
          .greaterThanOrEqual(accumulator.deductibleAmountCents);
        const inDeductiblePhase = hasDeductible.and(deductibleMet.not());

        const remainingDeductible = Provable.if(
          inDeductiblePhase,
          accumulator.deductibleAmountCents.sub(accumulator.deductiblePaidCents),
          Field(0),
        );

        // Deductible pay = min(total, remainingDeductible)
        const deductiblePay = Provable.if(
          total.lessThan(remainingDeductible),
          total,
          remainingDeductible,
        );

        // Normal copay = min(total, formulary copay)
        const normalPay = Provable.if(total.lessThan(copay), total, copay);

        // Select based on deductible status
        const preCopay = Provable.if(inDeductiblePhase, deductiblePay, normalPay);

        // Benefit exhaustion check
        const hasBenefitMax = accumulator.annualBenefitMaxCents.greaterThan(Field(0));
        const benefitExhausted = hasBenefitMax.and(
          accumulator.annualBenefitUsedCents
            .greaterThanOrEqual(accumulator.annualBenefitMaxCents),
        );
        const postBenefitPay = Provable.if(benefitExhausted, total, preCopay);

        // OOPM check (highest priority — outermost Provable.if)
        const hasOopm = accumulator.oopMaxCents.greaterThan(Field(0));
        const oopMet = hasOopm.and(
          accumulator.oopPaidCents
            .greaterThanOrEqual(accumulator.oopMaxCents),
        );
        const patientPay = Provable.if(oopMet, Field(0), postBenefitPay);
        const planPay = total.sub(patientPay);

        // ── Step 17: Settlement commitment (for reversal verification) ──

        const fulfillmentCommitment = fulfillmentData.commitment();
        const settlementCommitment = Poseidon.hash([
          fulfillmentCommitment,
          patientPay,
          planPay,
        ]);

        // ── Step 18: Update accumulator ──

        const newAccumulatorCommitment = Poseidon.hash([
          accumulator.planYear,
          accumulator.deductibleAmountCents,
          accumulator.deductiblePaidCents.add(patientPay),
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
            oldForestRoot: nftData.forestRoot,
            newForestRoot,
            entryCommitment: fulfillmentCommitment,
            patientPayCents: patientPay,
            planPayCents: planPay,
            operationType: FULFILL_OP_CLAIM,
            newEligibilityForestRoot: newEligForestRoot,
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
        NftData,                    // prescription NFT
        PrescriptionData,
        FulfillmentData,            // original fulfillment
        ReversalData,
        ForestRoots,                // prescription forest roots
        ForestMerkleWitness,        // MEDICATION: prescription at leaf
        ForestMerkleWitness,        // TRANSACTION: settlement commitment at leaf K
        ForestMerkleWitness,        // TRANSACTION: reversal slot (empty)
        Field,                      // originalPatientPay
        Field,                      // originalPlanPay
        NftData,                    // eligibility NFT
        ForestRoots,                // eligibility forest roots
        AccumulatorData,            // current accumulator state
        ForestMerkleWitness,        // accumulator in eligibility ACCESS_CONTROL tree
      ],
      async method(
        nftData: NftData,
        prescriptionData: PrescriptionData,
        originalFulfillment: FulfillmentData,
        reversalData: ReversalData,
        forestRoots: ForestRoots,
        medicationWitness: ForestMerkleWitness,
        fulfillmentWitness: ForestMerkleWitness,
        reversalSlotWitness: ForestMerkleWitness,
        originalPatientPay: Field,
        originalPlanPay: Field,
        eligNftData: NftData,
        eligForestRoots: ForestRoots,
        accumulator: AccumulatorData,
        accumulatorWitness: ForestMerkleWitness,
      ) {
        // ── Steps 1-3: Prescription NFT validation ──

        // 1. NFT type is PRESCRIPTION
        nftData.nftType.assertEquals(
          NFT_TYPE_PRESCRIPTION,
          'NFT type must be PRESCRIPTION',
        );

        // 2. NFT is not revoked
        nftData.revoked.assertEquals(Field(0), 'NFT is revoked');

        // 3. Forest root integrity
        const computedForestRoot = forestRoots.computeForestRoot();
        computedForestRoot.assertEquals(
          nftData.forestRoot,
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

        // ── Steps 9-11: Eligibility NFT + Accumulator verification ──

        // 9. Eligibility NFT is ELIGIBILITY type, not revoked
        eligNftData.nftType.assertEquals(
          NFT_TYPE_ELIGIBILITY,
          'Elig NFT type must be ELIGIBILITY',
        );
        eligNftData.revoked.assertEquals(Field(0), 'Elig NFT is revoked');

        // 10. Eligibility forest root integrity
        const eligComputedRoot = eligForestRoots.computeForestRoot();
        eligComputedRoot.assertEquals(
          eligNftData.forestRoot,
          'Elig forest root mismatch',
        );

        // 11. Accumulator in eligibility ACCESS_CONTROL tree
        accumulatorWitness
          .calculateRoot(accumulator.commitment())
          .assertEquals(
            eligForestRoots.accessControlRoot,
            'Accumulator not in ACCESS_CONTROL tree',
          );

        // ── Step 12: Reverse accumulator ──

        const newAccumulatorCommitment = Poseidon.hash([
          accumulator.planYear,
          accumulator.deductibleAmountCents,
          accumulator.deductiblePaidCents.sub(originalPatientPay),
          accumulator.oopMaxCents,
          accumulator.oopPaidCents.sub(originalPatientPay),
          accumulator.annualBenefitMaxCents,
          accumulator.annualBenefitUsedCents.sub(originalPlanPay),
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
            oldForestRoot: nftData.forestRoot,
            newForestRoot,
            entryCommitment: origCommitment,
            patientPayCents: originalPatientPay,
            planPayCents: originalPlanPay,
            operationType: FULFILL_OP_REVERSAL,
            newEligibilityForestRoot: newEligForestRoot,
          }),
        };
      },
    },
  },
});

/** Named class for SmartContract compatibility (reflect-metadata needs named class) */
export class AccumulatorFulfillmentProof extends ZkProgram.Proof(AccumulatorFulfillmentProgram) {}
