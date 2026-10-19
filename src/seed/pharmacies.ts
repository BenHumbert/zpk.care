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

/**
 * Seed Pharmacy Data — NCPDP-based
 *
 * Fictional pharmacies with realistic NCPDP-style identifiers.
 * All NPI and NCPDP Provider IDs are FICTIONAL — not real pharmacies. Every NPI
 * starts with 2, a prefix NPPES has not issued yet, every DEA number fails the DEA
 * check digit, and phones use the 555-0100 to 555-0199 block kept for fiction.
 *
 * NCPDP fields mapped to our PharmacyLocalData:
 *   - serviceProviderIdQualifier: 1 (NPI) — NCPDP 201-B1
 *   - serviceProviderId: NPI number — NCPDP 202-B2
 *
 * Extended fields include NCPDP Provider ID (7-digit), store info, and pharmacy type.
 *
 * Pharmacy types follow NCPDP standard:
 *   01 = Community/Retail
 *   02 = Compounding
 *   03 = Long-Term Care
 *   04 = Mail Order
 *   05 = Institutional
 *   06 = Managed Care
 *   07 = Specialty
 */
import type { PharmacyLocalData } from '../models/pharmacy.js';

/**
 * Extended pharmacy record with NCPDP display fields.
 * The ZK system only uses PharmacyLocalData; the rest is for UI/reporting.
 */
export interface SeedPharmacy {
  /** ZK-compatible local data (goes into wallet derivation) */
  localData: PharmacyLocalData;
  /** Enrollment key (pharmacy-generated secret) */
  enrollmentKey: string;
  /** Display: NCPDP Provider ID (7-digit) */
  ncpdpProviderId: string;
  /** Display: store name */
  storeName: string;
  /** Display: chain name (or "Independent") */
  chain: string;
  /** Display: pharmacy type code */
  pharmacyType: string;
  /** Display: pharmacy type description */
  pharmacyTypeDesc: string;
  /** Display: street address */
  address: string;
  /** Display: city */
  city: string;
  /** Display: state */
  state: string;
  /** Display: ZIP code */
  zip: string;
  /** Display: phone number */
  phone: string;
  /** Display: DEA number */
  deaNumber: string;
}

/**
 * 8 fictional pharmacies across various types and locations.
 *
 * NPI format: 2XXXXXXXXX (a prefix NPPES has not issued yet)
 * NCPDP Provider ID: 7-digit unique identifier
 */
export const PHARMACIES: SeedPharmacy[] = [
  {
    localData: { serviceProviderIdQualifier: 1, serviceProviderId: '2345678901' },
    enrollmentKey: 'ksmHyIHcdsHWalWhdIq2SHTSIDdDYQQohZZ7zYqHE8w',
    ncpdpProviderId: '5901234',
    storeName: 'Main Street Pharmacy',
    chain: 'Independent',
    pharmacyType: '01',
    pharmacyTypeDesc: 'Community/Retail',
    address: '100 Main Street',
    city: 'Springfield',
    state: 'IL',
    zip: '62701',
    phone: '217-555-0100',
    deaNumber: 'BM1234567',
  },
  {
    localData: { serviceProviderIdQualifier: 1, serviceProviderId: '2456789012' },
    enrollmentKey: 'flh-P_pasPQJYzMDtt3pI46hP1lRiQinsA2l3WDBN3I',
    ncpdpProviderId: '5902345',
    storeName: 'Marrowind Drugs #1042',
    chain: 'Marrowind Drugs',
    pharmacyType: '01',
    pharmacyTypeDesc: 'Community/Retail',
    address: '2500 Oak Avenue',
    city: 'Dallas',
    state: 'TX',
    zip: '75201',
    phone: '214-555-0101',
    deaNumber: 'BM2345678',
  },
  {
    localData: { serviceProviderIdQualifier: 1, serviceProviderId: '2567890123' },
    enrollmentKey: 'KEgaiKG6VDsjhVexjx4EkGyoB9gx6az_NmdEQqXGY58',
    ncpdpProviderId: '5903456',
    storeName: 'Quillfeather Pharmacy #8871',
    chain: 'Quillfeather',
    pharmacyType: '01',
    pharmacyTypeDesc: 'Community/Retail',
    address: '750 Copperfen Street',
    city: 'New York',
    state: 'NY',
    zip: '10003',
    phone: '212-555-0102',
    deaNumber: 'BQ3456789',
  },
  {
    localData: { serviceProviderIdQualifier: 1, serviceProviderId: '2678901234' },
    enrollmentKey: 'LWhNOwcuVkvOmf5a0FIeF1BMICZhw8qgSTx4NKw5Ezs',
    ncpdpProviderId: '5904567',
    storeName: 'RxDirect Mail',
    chain: 'RxDirect',
    pharmacyType: '04',
    pharmacyTypeDesc: 'Mail Order',
    address: '8000 Fulfillment Drive',
    city: 'Memphis',
    state: 'TN',
    zip: '38118',
    phone: '901-555-0103',
    deaNumber: 'BR4567891',
  },
  {
    localData: { serviceProviderIdQualifier: 1, serviceProviderId: '2789012345' },
    enrollmentKey: '2FC4Ry7-7yefEpO9lG1uS4MIuel6PzKCzenV3ROnpIg',
    ncpdpProviderId: '5905678',
    storeName: 'BioSpecialty Pharmacy',
    chain: 'BioSpecialty',
    pharmacyType: '07',
    pharmacyTypeDesc: 'Specialty',
    address: '1200 Research Parkway',
    city: 'Boston',
    state: 'MA',
    zip: '02210',
    phone: '617-555-0104',
    deaNumber: 'BB5678901',
  },
  {
    localData: { serviceProviderIdQualifier: 1, serviceProviderId: '2890123456' },
    enrollmentKey: 'alxF58WQuyoJODDLXSDo_k6Fn5VZdKa04NJ6I5GhiQM',
    ncpdpProviderId: '5906789',
    storeName: 'Precision Compounding',
    chain: 'Independent',
    pharmacyType: '02',
    pharmacyTypeDesc: 'Compounding',
    address: '445 Elm Street',
    city: 'San Francisco',
    state: 'CA',
    zip: '94102',
    phone: '415-555-0105',
    deaNumber: 'BP6789012',
  },
  {
    localData: { serviceProviderIdQualifier: 1, serviceProviderId: '2901234567' },
    enrollmentKey: 'TWjO1KMau6G3YHSx15e_9Yt43nQxyiojEeST_rHq4-w',
    ncpdpProviderId: '5907890',
    storeName: 'Sunrise LTC Pharmacy',
    chain: 'Sunrise Health',
    pharmacyType: '03',
    pharmacyTypeDesc: 'Long-Term Care',
    address: '3300 Care Center Blvd',
    city: 'Miami',
    state: 'FL',
    zip: '33130',
    phone: '305-555-0106',
    deaNumber: 'BS7890123',
  },
  {
    localData: { serviceProviderIdQualifier: 1, serviceProviderId: '2012345678' },
    enrollmentKey: 'j9x6rhZCTX0LXYj_FwysyYTvicocA7kumsTtghxZys4',
    ncpdpProviderId: '5908901',
    storeName: 'Campus Health Pharmacy',
    chain: 'Independent',
    pharmacyType: '05',
    pharmacyTypeDesc: 'Institutional',
    address: '500 University Drive',
    city: 'Ann Arbor',
    state: 'MI',
    zip: '48109',
    phone: '734-555-0107',
    deaNumber: 'BC8901234',
  },
];

/** Quick lookup: NPI → SeedPharmacy */
export const PHARMACY_BY_NPI = new Map<string, SeedPharmacy>(
  PHARMACIES.map((p) => [p.localData.serviceProviderId, p]),
);

/** Quick lookup: NCPDP Provider ID → SeedPharmacy */
export const PHARMACY_BY_NCPDP = new Map<string, SeedPharmacy>(
  PHARMACIES.map((p) => [p.ncpdpProviderId, p]),
);
