import { Field, Struct, Poseidon } from 'o1js';

/**
 * Medication — maps to NCPDP Claim + Pricing segments (minimum fields).
 *
 * NCPDP Source Fields:
 *   455-EM  Rx/Service Reference Number Qualifier
 *   402-D2  Rx/Service Reference Number
 *   436-E1  Product/Service ID Qualifier
 *   407-D7  Product/Service ID (NDC)
 *   442-E7  Quantity Dispensed
 *   403-D3  Fill Number
 *   405-D5  Days Supply
 *   406-D6  Compound Code
 *   408-D8  DAW/Product Selection Code
 *   426-DQ  Usual and Customary Charge
 *   460-ET  Quantity Prescribed
 *   409-D9  Ingredient Cost Submitted
 *   412-DC  Dispensing Fee Submitted
 *   423-DN  Basis of Cost Determination
 */
export class MedicationData extends Struct({
  /** Poseidon hash of Rx reference number (402-D2) */
  rxRefNumberHash: Field,
  /** Poseidon hash of NDC number (407-D7) */
  ndcHash: Field,
  /** Quantity dispensed (442-E7) — scaled to integer (x1000) */
  quantityDispensed: Field,
  /** Fill number (403-D3) */
  fillNumber: Field,
  /** Days supply (405-D5) */
  daysSupply: Field,
  /** Compound code (406-D6) */
  compoundCode: Field,
  /** DAW code (408-D8) */
  dawCode: Field,
}) {
  commitment(): Field {
    return Poseidon.hash([
      this.rxRefNumberHash,
      this.ndcHash,
      this.quantityDispensed,
      this.fillNumber,
      this.daysSupply,
      this.compoundCode,
      this.dawCode,
    ]);
  }
}

/**
 * Pricing data for the medication — separate struct to keep concerns clean.
 */
export class MedicationPricingData extends Struct({
  /** Usual and customary charge (426-DQ) — scaled to integer cents */
  usualAndCustomaryCharge: Field,
  /** Quantity prescribed (460-ET) — scaled to integer (x1000) */
  quantityPrescribed: Field,
  /** Ingredient cost submitted (409-D9) — scaled to integer cents */
  ingredientCostSubmitted: Field,
  /** Dispensing fee submitted (412-DC) — scaled to integer cents */
  dispensingFeeSubmitted: Field,
  /** Basis of cost determination (423-DN) */
  basisOfCostDetermination: Field,
}) {
  commitment(): Field {
    return Poseidon.hash([
      this.usualAndCustomaryCharge,
      this.quantityPrescribed,
      this.ingredientCostSubmitted,
      this.dispensingFeeSubmitted,
      this.basisOfCostDetermination,
    ]);
  }
}

/**
 * Raw medication data — lives locally, never on-chain.
 */
export interface MedicationLocalData {
  rxServiceRefNumQualifier: number;  // 455-EM
  rxServiceRefNumber: string;        // 402-D2
  productServiceIdQualifier: number; // 436-E1
  productServiceId: string;          // 407-D7 (NDC)
  quantityDispensed: number;         // 442-E7
  fillNumber: number;                // 403-D3
  daysSupply: number;                // 405-D5
  compoundCode: number;              // 406-D6
  dawProductSelectionCode: number;   // 408-D8
}

/**
 * Raw pricing data — lives locally, never on-chain.
 */
export interface MedicationPricingLocalData {
  usualAndCustomaryCharge: number;   // 426-DQ (in cents)
  quantityPrescribed: number;        // 460-ET
  ingredientCostSubmitted: number;   // 409-D9 (in cents)
  dispensingFeeSubmitted: number;    // 412-DC (in cents)
  basisOfCostDetermination: number;  // 423-DN
}
