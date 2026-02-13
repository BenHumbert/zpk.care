/**
 * Demo Pharmacy Data — NCPDP-based
 *
 * Fictional pharmacies with realistic NCPDP-style identifiers.
 * All NPI and NCPDP Provider IDs are FICTIONAL — not real pharmacies.
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
 * The ZK system only uses PharmacyLocalData; the rest is for demo UI/reporting.
 */
export interface DemoPharmacy {
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
 * NPI format: 2XXXXXXXXX (organizational providers)
 * NCPDP Provider ID: 7-digit unique identifier
 */
export const DEMO_PHARMACIES: DemoPharmacy[] = [
  {
    localData: { serviceProviderIdQualifier: 1, serviceProviderId: '2345678901' },
    enrollmentKey: 'pharmacy-key-mainst-2026',
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
    enrollmentKey: 'pharmacy-key-wellcare-2026',
    ncpdpProviderId: '5902345',
    storeName: 'WellCare Drugs #1042',
    chain: 'WellCare Drugs',
    pharmacyType: '01',
    pharmacyTypeDesc: 'Community/Retail',
    address: '2500 Oak Avenue',
    city: 'Dallas',
    state: 'TX',
    zip: '75201',
    phone: '214-555-0200',
    deaNumber: 'BW2345678',
  },
  {
    localData: { serviceProviderIdQualifier: 1, serviceProviderId: '2567890123' },
    enrollmentKey: 'pharmacy-key-health-2026',
    ncpdpProviderId: '5903456',
    storeName: 'HealthMart Pharmacy #8871',
    chain: 'HealthMart',
    pharmacyType: '01',
    pharmacyTypeDesc: 'Community/Retail',
    address: '750 Broadway',
    city: 'New York',
    state: 'NY',
    zip: '10003',
    phone: '212-555-0300',
    deaNumber: 'BH3456789',
  },
  {
    localData: { serviceProviderIdQualifier: 1, serviceProviderId: '2678901234' },
    enrollmentKey: 'pharmacy-key-rxdirect-2026',
    ncpdpProviderId: '5904567',
    storeName: 'RxDirect Mail',
    chain: 'RxDirect',
    pharmacyType: '04',
    pharmacyTypeDesc: 'Mail Order',
    address: '8000 Fulfillment Drive',
    city: 'Memphis',
    state: 'TN',
    zip: '38118',
    phone: '800-555-0400',
    deaNumber: 'BR4567890',
  },
  {
    localData: { serviceProviderIdQualifier: 1, serviceProviderId: '2789012345' },
    enrollmentKey: 'pharmacy-key-specialty-2026',
    ncpdpProviderId: '5905678',
    storeName: 'BioSpecialty Pharmacy',
    chain: 'BioSpecialty',
    pharmacyType: '07',
    pharmacyTypeDesc: 'Specialty',
    address: '1200 Research Parkway',
    city: 'Boston',
    state: 'MA',
    zip: '02210',
    phone: '617-555-0500',
    deaNumber: 'BB5678901',
  },
  {
    localData: { serviceProviderIdQualifier: 1, serviceProviderId: '2890123456' },
    enrollmentKey: 'pharmacy-key-compound-2026',
    ncpdpProviderId: '5906789',
    storeName: 'Precision Compounding',
    chain: 'Independent',
    pharmacyType: '02',
    pharmacyTypeDesc: 'Compounding',
    address: '445 Elm Street',
    city: 'San Francisco',
    state: 'CA',
    zip: '94102',
    phone: '415-555-0600',
    deaNumber: 'BP6789012',
  },
  {
    localData: { serviceProviderIdQualifier: 1, serviceProviderId: '2901234567' },
    enrollmentKey: 'pharmacy-key-sunrise-2026',
    ncpdpProviderId: '5907890',
    storeName: 'Sunrise LTC Pharmacy',
    chain: 'Sunrise Health',
    pharmacyType: '03',
    pharmacyTypeDesc: 'Long-Term Care',
    address: '3300 Care Center Blvd',
    city: 'Miami',
    state: 'FL',
    zip: '33130',
    phone: '305-555-0700',
    deaNumber: 'BS7890123',
  },
  {
    localData: { serviceProviderIdQualifier: 1, serviceProviderId: '2012345678' },
    enrollmentKey: 'pharmacy-key-campus-2026',
    ncpdpProviderId: '5908901',
    storeName: 'Campus Health Pharmacy',
    chain: 'Independent',
    pharmacyType: '05',
    pharmacyTypeDesc: 'Institutional',
    address: '500 University Drive',
    city: 'Ann Arbor',
    state: 'MI',
    zip: '48109',
    phone: '734-555-0800',
    deaNumber: 'BC8901234',
  },
];

/** Quick lookup: NPI → DemoPharmacy */
export const PHARMACY_BY_NPI = new Map<string, DemoPharmacy>(
  DEMO_PHARMACIES.map((p) => [p.localData.serviceProviderId, p]),
);

/** Quick lookup: NCPDP Provider ID → DemoPharmacy */
export const PHARMACY_BY_NCPDP = new Map<string, DemoPharmacy>(
  DEMO_PHARMACIES.map((p) => [p.ncpdpProviderId, p]),
);
