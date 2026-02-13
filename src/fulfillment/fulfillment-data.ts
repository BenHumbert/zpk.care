import { Field, Struct, Poseidon } from 'o1js';
import { hashString, dateToField, centsToField, quantityToField } from '../zkp/hash-utils.js';

// ─── FulfillmentData ───────────────────────────────────────────

/**
 * FulfillmentData — pharmacy's dispensing claim.
 *
 * Stored as a leaf in the MerkleForest TRANSACTION tree (append-only).
 * Appended after the last PrescriptionStatusData entry.
 *
 * The ZK proof (FulfillmentProgram.proveFulfillment) enforces formulary
 * compliance and computes settlement amounts in-circuit. No separate
 * insurer adjudication step is needed — the proof IS the adjudication.
 */
export class FulfillmentData extends Struct({
  /** Links to PrescriptionData.commitment() */
  prescriptionHash: Field,
  /** Pharmacy that dispensed the medication */
  pharmacyWalletId: Field,
  /** Poseidon hash of NDC code (must match prescription) */
  ndcHash: Field,
  /** Actual quantity dispensed (scaled x1000 via quantityToField) */
  quantityDispensed: Field,
  /** Drug ingredient cost in cents */
  ingredientCostCents: Field,
  /** Pharmacy dispensing fee in cents */
  dispensingFeeCents: Field,
  /** Date of service (CCYYMMDD numeric) */
  dateOfService: Field,
}) {
  commitment(): Field {
    return Poseidon.hash([
      this.prescriptionHash,
      this.pharmacyWalletId,
      this.ndcHash,
      this.quantityDispensed,
      this.ingredientCostCents,
      this.dispensingFeeCents,
      this.dateOfService,
    ]);
  }

  /** Total submitted cost = ingredient cost + dispensing fee */
  totalCostCents(): Field {
    return this.ingredientCostCents.add(this.dispensingFeeCents);
  }
}

/**
 * Raw fulfillment data — lives locally, never on-chain.
 */
export interface FulfillmentLocalData {
  /** Prescription commitment as bigint string */
  prescriptionHash: string;
  /** Pharmacy wallet ID as bigint string */
  pharmacyWalletId: string;
  /** NDC code (11-digit string) */
  ndcCode: string;
  /** Quantity dispensed (decimal) */
  quantityDispensed: number;
  /** Ingredient cost in cents */
  ingredientCostCents: number;
  /** Dispensing fee in cents */
  dispensingFeeCents: number;
  /** Date of service as CCYYMMDD string */
  dateOfService: string;
}

/**
 * Build a FulfillmentData from raw local data.
 */
export function buildFulfillmentData(local: FulfillmentLocalData): FulfillmentData {
  return new FulfillmentData({
    prescriptionHash: Field(BigInt(local.prescriptionHash)),
    pharmacyWalletId: Field(BigInt(local.pharmacyWalletId)),
    ndcHash: hashString(local.ndcCode),
    quantityDispensed: quantityToField(local.quantityDispensed),
    ingredientCostCents: centsToField(local.ingredientCostCents),
    dispensingFeeCents: centsToField(local.dispensingFeeCents),
    dateOfService: dateToField(local.dateOfService),
  });
}

// ─── ReversalData ──────────────────────────────────────────────

/**
 * ReversalData — reversal of a previously fulfilled claim.
 *
 * Stored as a leaf in the MerkleForest TRANSACTION tree (append-only).
 * The ZK proof (FulfillmentProgram.proveReversal) enforces that
 * refund amounts match the original fulfillment's computed amounts.
 */
export class ReversalData extends Struct({
  /** Links to FulfillmentData.commitment() */
  fulfillmentHash: Field,
  /** Pharmacy that initiated the reversal */
  pharmacyWalletId: Field,
  /** Patient refund in cents (must match original copay) */
  patientRefundCents: Field,
  /** Plan refund in cents (must match original planPay) */
  planRefundCents: Field,
  /** Reversal date (CCYYMMDD numeric) */
  reversalDate: Field,
  /** Poseidon hash of reason text (Field(0) if none) */
  reasonCodeHash: Field,
  /** Who authorized the reversal (wallet ID) */
  reversedByWalletId: Field,
}) {
  commitment(): Field {
    return Poseidon.hash([
      this.fulfillmentHash,
      this.pharmacyWalletId,
      this.patientRefundCents,
      this.planRefundCents,
      this.reversalDate,
      this.reasonCodeHash,
      this.reversedByWalletId,
    ]);
  }
}

/**
 * Raw reversal data — lives locally, never on-chain.
 */
export interface ReversalLocalData {
  /** Fulfillment commitment as bigint string */
  fulfillmentHash: string;
  /** Pharmacy wallet ID as bigint string */
  pharmacyWalletId: string;
  /** Patient refund in cents */
  patientRefundCents: number;
  /** Plan refund in cents */
  planRefundCents: number;
  /** Reversal date as CCYYMMDD string */
  reversalDate: string;
  /** Reason text (empty string if none) */
  reason: string;
  /** Who authorized (wallet ID as bigint string) */
  reversedByWalletId: string;
}

/**
 * Build a ReversalData from raw local data.
 */
export function buildReversalData(local: ReversalLocalData): ReversalData {
  return new ReversalData({
    fulfillmentHash: Field(BigInt(local.fulfillmentHash)),
    pharmacyWalletId: Field(BigInt(local.pharmacyWalletId)),
    patientRefundCents: centsToField(local.patientRefundCents),
    planRefundCents: centsToField(local.planRefundCents),
    reversalDate: dateToField(local.reversalDate),
    reasonCodeHash: local.reason ? hashString(local.reason) : Field(0),
    reversedByWalletId: Field(BigInt(local.reversedByWalletId)),
  });
}
