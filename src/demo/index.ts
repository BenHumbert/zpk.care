// Demo Data — Fictional sample data for testing and demonstration
//
// Sources modeled after:
//   - NPPES (National Plan and Provider Enumeration System) — prescriber data
//   - NCPDP (National Council for Prescription Drug Programs) — pharmacy data
//   - Medispan (NDC/GPI drug database) — medication data
//
// ALL data is FICTIONAL. No real NPIs, NDCs, or individuals.

// Prescribers (NPPES-style)
export { DEMO_PRESCRIBERS, PRESCRIBER_BY_NPI } from './prescribers.js';
export type { DemoPrescriber } from './prescribers.js';

// Pharmacies (NCPDP-style)
export { DEMO_PHARMACIES, PHARMACY_BY_NPI, PHARMACY_BY_NCPDP } from './pharmacies.js';
export type { DemoPharmacy } from './pharmacies.js';

// Medications (Medispan-style NDC/GPI)
export {
  DEMO_MEDICATIONS,
  TIER1_GENERICS,
  TIER2_PREFERRED,
  TIER3_NON_PREFERRED,
  TIER4_SPECIALTY,
  MEDICATION_BY_NDC,
  MEDICATION_BY_GPI,
  getAllFormularyEntries,
  getFormularyEntriesByTier,
  buildMedicationLocalData,
  buildMedicationPricingLocalData,
} from './medications.js';
export type { DemoMedication } from './medications.js';

// Members (sample beneficiaries)
export {
  DEMO_MEMBERS,
  MEMBER_BY_CARDHOLDER_ID,
  getMembersByEmployee,
  getSubscribers,
  getAcmeMembers,
  getGlobexMembers,
} from './members.js';
export type { DemoMember } from './members.js';
