// Seed Data — Fictional sample data for testing
//
// Sources modeled after:
//   - NPPES (National Plan and Provider Enumeration System) — prescriber data
//   - NCPDP (National Council for Prescription Drug Programs) — pharmacy data
//   - Medispan (NDC/GPI drug database) — medication data
//
// ALL data is FICTIONAL. No real NPIs, NDCs, or individuals.

// Prescribers (NPPES-style)
export { PRESCRIBERS, PRESCRIBER_BY_NPI } from './prescribers.js';
export type { SeedPrescriber } from './prescribers.js';

// Pharmacies (NCPDP-style)
export { PHARMACIES, PHARMACY_BY_NPI, PHARMACY_BY_NCPDP } from './pharmacies.js';
export type { SeedPharmacy } from './pharmacies.js';

// Members (sample beneficiaries)
export {
  MEMBERS,
  MEMBER_BY_CARDHOLDER_ID,
  getMembersByFamily,
  getMembersByEmployee,
  getSubscribers,
  getAcmeMembers,
  getGlobexMembers,
} from './members.js';
export type { SeedMember } from './members.js';
