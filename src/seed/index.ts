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
