// ─── Shared Types ──────────────────────────────────────────

/** Date range filter using CCYYMMDD numeric format. */
export interface DateRange {
  startDate: number;
  endDate: number;
}

/** Aggregated cost breakdown across claims. */
export interface CostBreakdown {
  totalIngredientCostCents: number;
  totalDispensingFeeCents: number;
  totalPatientPayCents: number;
  totalPlanPayCents: number;
  totalGrossCostCents: number;
  /** Gross minus reversals. */
  netCostCents: number;
}

// ─── VerifiedClaim ─────────────────────────────────────────

/**
 * Transient data extracted from a verified FulfillmentProof + pharmacy-provided context.
 *
 * NOT stored — constructed in memory, used for report generation, then purged.
 */
export interface VerifiedClaim {
  /** From proof output — PrescriptionData.commitment() */
  prescriptionHash: string;
  /** From proof output — fulfillment or reversal entry commitment */
  entryCommitment: string;
  /** ZK-computed copay (fulfillment) or refund (reversal) in cents */
  patientPayCents: number;
  /** ZK-computed insurer share (fulfillment) or refund (reversal) in cents */
  planPayCents: number;
  /** 'fulfillment' or 'reversal' */
  operationType: 'fulfillment' | 'reversal';

  // From ClaimContext (pharmacy-provided, verifiable against entryCommitment)
  /** Opaque pharmacy wallet hash */
  pharmacyWalletId: string;
  /** Opaque member wallet hash */
  memberWalletId: string;
  /** Opaque prescriber wallet hash */
  prescriberWalletId: string;
  /** Poseidon hash of NDC code */
  ndcHash: string;
  /** Drug ingredient cost in cents */
  ingredientCostCents: number;
  /** Pharmacy dispensing fee in cents */
  dispensingFeeCents: number;
  /** Quantity dispensed — string for BigInt precision (x1000-scaled) */
  quantityDispensed: string;
  /** Date of service as CCYYMMDD numeric */
  dateOfService: number;
}

// ─── ClaimContext ──────────────────────────────────────────

/**
 * Pharmacy-provided metadata alongside a FulfillmentProof.
 *
 * Verifiable: Poseidon hash of FulfillmentData built from this context
 * must match proof output's entryCommitment.
 */
export interface ClaimContext {
  pharmacyWalletId: string;
  memberWalletId: string;
  prescriberWalletId: string;
  ndcHash: string;
  ingredientCostCents: number;
  dispensingFeeCents: number;
  quantityDispensed: string;
  dateOfService: number;
}

// ─── PriorAuthContext ──────────────────────────────────────

/**
 * Insurer-provided prior authorization data for cross-referencing.
 */
export interface PriorAuthContext {
  ndcHash: string;
  memberWalletId: string;
  prescriberWalletId: string;
  approvalDate: number;
  expirationDate: number;
  approvedQuantity: string;
}

// ─── Report Interfaces ─────────────────────────────────────

/** 1. Chronological claims register. */
export interface ClaimsRegisterReport {
  claims: VerifiedClaim[];
  costBreakdown: CostBreakdown;
  totalClaimCount: number;
  totalReversalCount: number;
  dateRange?: DateRange;
}

/** Per-pharmacy activity entry. */
export interface PharmacyActivityEntry {
  pharmacyWalletId: string;
  claimCount: number;
  reversalCount: number;
  uniqueMedications: number;
  uniqueMembers: number;
  costBreakdown: CostBreakdown;
}

/** 2. Pharmacy activity report. */
export interface PharmacyActivityReport {
  pharmacies: PharmacyActivityEntry[];
  dateRange?: DateRange;
}

/** Per-prescriber activity entry. */
export interface PrescriberActivityEntry {
  prescriberWalletId: string;
  prescriptionCount: number;
  claimCount: number;
  uniqueMedications: number;
  uniqueMembers: number;
  costBreakdown: CostBreakdown;
}

/** 3. Prescriber activity report. */
export interface PrescriberActivityReport {
  prescribers: PrescriberActivityEntry[];
  dateRange?: DateRange;
}

/** Per-member activity entry. */
export interface MemberActivityEntry {
  memberWalletId: string;
  claimCount: number;
  reversalCount: number;
  /** NDC hashes of medications with active (non-reversed) claims. */
  currentMedications: string[];
  costBreakdown: CostBreakdown;
}

/** 4. Member activity report. */
export interface MemberActivityReport {
  members: MemberActivityEntry[];
  dateRange?: DateRange;
}

/** Per-medication utilization entry. */
export interface MedicationUtilizationEntry {
  ndcHash: string;
  totalClaimCount: number;
  totalReversalCount: number;
  totalQuantity: string;
  uniquePharmacies: number;
  uniquePrescribers: number;
  uniqueMembers: number;
}

/** 5. Medication utilization report (sorted by claim count descending). */
export interface MedicationUtilizationReport {
  medications: MedicationUtilizationEntry[];
  dateRange?: DateRange;
}

/** 6. Financial summary report. */
export interface FinancialSummaryReport {
  costBreakdown: CostBreakdown;
  totalClaimCount: number;
  totalReversalCount: number;
  averageClaimCost: number;
  averagePatientPay: number;
  averagePlanPay: number;
  dateRange?: DateRange;
}

/** Per-PA utilization entry. */
export interface PriorAuthUtilizationEntry {
  ndcHash: string;
  memberWalletId: string;
  prescriberWalletId: string;
  approvalDate: number;
  expirationDate: number;
  approvedQuantity: string;
  utilizedQuantity: string;
  utilizationRate: number;
  hasClaimActivity: boolean;
}

/** 7. Prior authorization report. */
export interface PriorAuthReport {
  priorAuths: PriorAuthUtilizationEntry[];
  dateRange?: DateRange;
}

/** 8. Reversal report. */
export interface ReversalReport {
  reversals: VerifiedClaim[];
  totalPatientRefundCents: number;
  totalPlanRefundCents: number;
  dateRange?: DateRange;
}
