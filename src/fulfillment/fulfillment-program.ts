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

import { Field, Struct, Poseidon, Provable, ZkProgram } from 'o1js';
import { CredentialData, CREDENTIAL_TYPE_PRESCRIPTION } from '../credentials/credential-data.js';
import { ForestRoots } from '../eligibility/forest-roots.js';
import { ForestMerkleWitness } from '../zkp/merkle-forest.js';
import { FormularyEntry } from '../access-control/formulary-entry.js';
import { FormularyMerkleWitness } from '../access-control/formulary-registry.js';
import {
  PrescriptionData,
  PrescriptionStatusData,
  RX_STATUS_FILLED,
  RX_STATUS_PARTIALLY_FILLED,
} from '../prescription/prescription-data.js';
import { FulfillmentData, ReversalData } from './fulfillment-data.js';
import { DOMAIN_TAG_PHARMACY } from '../wallets/wallet-derivation.js';

// ─── FulfillmentOutput ──────────────────────────────────────────

/**
 * FulfillmentOutput — public output of FulfillmentProgram methods.
 *
 * Contains the prescription identity, forest root transition,
 * ZK-computed settlement amounts, and operation type.
 */
export class FulfillmentOutput extends Struct({
  /** Links to PrescriptionData.commitment() */
  prescriptionHash: Field,
  /** Forest root before the update */
  oldForestRoot: Field,
  /** Forest root after the update (TRANSACTION tree changed) */
  newForestRoot: Field,
  /** Commitment of the fulfillment or reversal entry */
  entryCommitment: Field,
  /** Patient pay in cents (copay for fulfillment, refund for reversal) */
  patientPayCents: Field,
  /** Plan pay in cents (insurer share for fulfillment, refund for reversal) */
  planPayCents: Field,
  /** Field(1) = fulfillment, Field(2) = reversal */
  operationType: Field,
  /** Poseidon hash of NDC code — drug identity proven by circuit */
  ndcHash: Field,
}) {}

// ─── Operation Type Constants ────────────────────────────────────

export const FULFILL_OP_CLAIM = Field(1);
export const FULFILL_OP_REVERSAL = Field(2);

// ─── FulfillmentProgram ─────────────────────────────────────────

/**
 * FulfillmentProgram — ZkProgram for claim fulfillment (Use Cases E + F).
 *
 * STANDALONE (no recursion) — proves:
 *   1. proveFulfillment — pharmacy claim with ZK-enforced copay settlement
 *   2. proveReversal — reversal of a previous fulfillment
 *
 * The ZK proof IS the adjudication — no separate insurer step needed.
 * Settlement amounts are computed deterministically from the formulary.
 */
export const FulfillmentProgram = ZkProgram({
  name: 'Fulfillment',
  publicOutput: FulfillmentOutput,

  methods: {
    /**
     * Prove a valid claim fulfillment with ZK-enforced settlement.
     *
     * Verification chain:
     *   1. Credential type is PRESCRIPTION, not revoked
     *   2. Forest root integrity (6 roots → forestRoot)
     *   3. PrescriptionData in MEDICATION tree
     *   4. Latest status in TRANSACTION tree; is FILLED or PARTIALLY_FILLED
     *   5. New TRANSACTION slot is empty
     *   6. FulfillmentData links to correct prescription
     *   7. NDC matches prescription
     *   8. Quantity within formulary limits
     *   9. Formulary entry in formulary tree
     *  10. Formulary NDC matches claim NDC
     *  11. Compute settlement amounts (copay from formulary)
     *  12. Compute new forest root
     */
    proveFulfillment: {
      privateInputs: [
        CredentialData,
        PrescriptionData,
        PrescriptionStatusData,
        FulfillmentData,
        FormularyEntry,
        ForestRoots,
        ForestMerkleWitness,       // MEDICATION: prescription at leaf
        ForestMerkleWitness,       // TRANSACTION: latest status at leaf N
        ForestMerkleWitness,       // TRANSACTION: new fulfillment slot (empty)
        FormularyMerkleWitness,    // formulary entry in formulary tree
        Field,                      // formularyRoot
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
        pharmacyQualifier: Field,
        pharmacyServiceProviderIdHash: Field,
        pharmacyEnrollmentKeyHash: Field,
      ) {
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

        // 13. Compute settlement amounts (ZK-enforced copay)
        const total = fulfillmentData.ingredientCostCents.add(
          fulfillmentData.dispensingFeeCents,
        );
        const copay = formularyEntry.copayAmountCents;
        const totalLessThanCopay = total.lessThan(copay);
        const patientPay = Provable.if(totalLessThanCopay, total, copay);
        const planPay = Provable.if(
          totalLessThanCopay,
          Field(0),
          total.sub(copay),
        );

        // 14. Compute settlement commitment and new TRANSACTION root
        const fulfillmentCommitment = fulfillmentData.commitment();
        const settlementCommitment = Poseidon.hash([
          fulfillmentCommitment,
          patientPay,
          planPay,
        ]);
        const newTransactionRoot = newSlotWitness.calculateRoot(
          settlementCommitment,
        );
        const newForestRoot = Poseidon.hash([
          forestRoots.memberRoot,
          forestRoots.prescriberRoot,
          forestRoots.pharmacyRoot,
          forestRoots.medicationRoot,
          forestRoots.accessControlRoot,
          newTransactionRoot,
        ]);

        return {
          publicOutput: new FulfillmentOutput({
            prescriptionHash: rxCommitment,
            oldForestRoot: credentialData.forestRoot,
            newForestRoot,
            entryCommitment: fulfillmentCommitment,
            patientPayCents: patientPay,
            planPayCents: planPay,
            operationType: FULFILL_OP_CLAIM,
            ndcHash: fulfillmentData.ndcHash,
          }),
        };
      },
    },

    /**
     * Prove a valid reversal of a previous fulfillment.
     *
     * Verification chain:
     *   1. Credential type is PRESCRIPTION, not revoked
     *   2. Forest root integrity
     *   3. PrescriptionData in MEDICATION tree
     *   4. Original FulfillmentData in TRANSACTION tree
     *   5. New TRANSACTION slot is empty
     *   6. ReversalData.fulfillmentHash matches original
     *   7. Formulary entry in formulary tree; NDC matches
     *   8. Recompute original amounts; verify reversal amounts match
     *   9. Compute new forest root
     */
    proveReversal: {
      privateInputs: [
        CredentialData,
        PrescriptionData,
        FulfillmentData,
        ReversalData,
        FormularyEntry,
        ForestRoots,
        ForestMerkleWitness,       // MEDICATION: prescription at leaf
        ForestMerkleWitness,       // TRANSACTION: original fulfillment at leaf K
        ForestMerkleWitness,       // TRANSACTION: reversal slot (empty)
        FormularyMerkleWitness,    // formulary entry in formulary tree
        Field,                      // formularyRoot
        Field,                      // H2: pharmacy qualifier
        Field,                      // H2: pharmacy serviceProviderIdHash
        Field,                      // H2: pharmacy enrollmentKeyHash
      ],
      async method(
        credentialData: CredentialData,
        prescriptionData: PrescriptionData,
        originalFulfillment: FulfillmentData,
        reversalData: ReversalData,
        formularyEntry: FormularyEntry,
        forestRoots: ForestRoots,
        medicationWitness: ForestMerkleWitness,
        fulfillmentWitness: ForestMerkleWitness,
        reversalSlotWitness: ForestMerkleWitness,
        formularyWitness: FormularyMerkleWitness,
        formularyRoot: Field,
        pharmacyQualifier: Field,
        pharmacyServiceProviderIdHash: Field,
        pharmacyEnrollmentKeyHash: Field,
      ) {
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

        // 5. Original fulfillment commitment (tree verification deferred to step 10b)
        const origCommitment = originalFulfillment.commitment();

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

        // 8. Formulary entry in formulary tree
        formularyWitness
          .calculateRoot(formularyEntry.commitment())
          .assertEquals(
            formularyRoot,
            'Formulary entry not in formulary tree',
          );

        // 9. Formulary NDC matches original fulfillment NDC
        formularyEntry.ndcHash.assertEquals(
          originalFulfillment.ndcHash,
          'Formulary NDC does not match fulfillment',
        );

        // 10. Recompute original settlement amounts
        const total = originalFulfillment.ingredientCostCents.add(
          originalFulfillment.dispensingFeeCents,
        );
        const copay = formularyEntry.copayAmountCents;
        const totalLessThanCopay = total.lessThan(copay);
        const originalPatientPay = Provable.if(totalLessThanCopay, total, copay);
        const originalPlanPay = Provable.if(
          totalLessThanCopay,
          Field(0),
          total.sub(copay),
        );

        // 10b. Verify original settlement commitment in TRANSACTION tree
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

        // 11. Reversal amounts must match original
        reversalData.patientRefundCents.assertEquals(
          originalPatientPay,
          'Patient refund does not match original copay',
        );
        reversalData.planRefundCents.assertEquals(
          originalPlanPay,
          'Plan refund does not match original plan pay',
        );

        // 12. Compute new TRANSACTION root and forest root
        const reversalCommitment = reversalData.commitment();
        const newTransactionRoot = reversalSlotWitness.calculateRoot(
          reversalCommitment,
        );
        const newForestRoot = Poseidon.hash([
          forestRoots.memberRoot,
          forestRoots.prescriberRoot,
          forestRoots.pharmacyRoot,
          forestRoots.medicationRoot,
          forestRoots.accessControlRoot,
          newTransactionRoot,
        ]);

        return {
          publicOutput: new FulfillmentOutput({
            prescriptionHash: rxCommitment,
            oldForestRoot: credentialData.forestRoot,
            newForestRoot,
            entryCommitment: reversalCommitment,
            patientPayCents: originalPatientPay,
            planPayCents: originalPlanPay,
            operationType: FULFILL_OP_REVERSAL,
            ndcHash: originalFulfillment.ndcHash,
          }),
        };
      },
    },
  },
});

/** Named class for SmartContract compatibility (reflect-metadata needs named class) */
export class FulfillmentProof extends ZkProgram.Proof(FulfillmentProgram) {}
