/**
 * Seed Prescriber Data — NPPES-based
 *
 * Fictional prescribers with realistic NPPES-style identifiers.
 * NPI numbers are 10-digit, starting with 1 (individual) or 2 (organization).
 * All NPIs here are FICTIONAL — not real providers.
 *
 * NPPES fields mapped to our PrescriberLocalData:
 *   - prescriberIdQualifier: 01 (NPI)
 *   - prescriberId: NPI number
 *
 * Extended fields (display-only, not used in ZK circuits):
 *   - firstName, lastName, credential, specialty, taxonomyCode, stateLicense, state
 */
import type { PrescriberLocalData } from '../models/prescriber.js';

/**
 * Extended prescriber record with NPPES display fields.
 * The ZK system only uses PrescriberLocalData; the rest is for UI/reporting.
 */
export interface SeedPrescriber {
  /** ZK-compatible local data (goes into wallet derivation) */
  localData: PrescriberLocalData;
  /** Enrollment key (user-generated secret, stays on device) */
  enrollmentKey: string;
  /** Display: provider first name */
  firstName: string;
  /** Display: provider last name */
  lastName: string;
  /** Display: credential (MD, DO, PharmD, NP, PA) */
  credential: string;
  /** Display: medical specialty */
  specialty: string;
  /** Display: NUCC taxonomy code */
  taxonomyCode: string;
  /** Display: state license number */
  stateLicense: string;
  /** Display: practice state */
  state: string;
  /** Display: DEA number (for controlled substances) */
  deaNumber: string;
}

/**
 * 10 fictional prescribers across various specialties and states.
 *
 * NPI format: 1XXXXXXXXX (individual providers)
 * Taxonomy codes from NUCC Health Care Provider Taxonomy Code Set.
 */
export const PRESCRIBERS: SeedPrescriber[] = [
  {
    localData: { prescriberIdQualifier: 1, prescriberId: '1234567890' },
    enrollmentKey: 'gpRL1IB9NWulKfKjrjWK0QM7ahqIrOkodzEQn1NJb1M',
    firstName: 'Sarah',
    lastName: 'Chen',
    credential: 'MD',
    specialty: 'Internal Medicine',
    taxonomyCode: '207R00000X',
    stateLicense: 'MD-12345',
    state: 'CA',
    deaNumber: 'AC1234567',
  },
  {
    localData: { prescriberIdQualifier: 1, prescriberId: '1345678901' },
    enrollmentKey: 'VU-76Mog6u__oSejywybSCIwE4U3SNP1b9XJAI6WuWs',
    firstName: 'Raj',
    lastName: 'Patel',
    credential: 'MD',
    specialty: 'Cardiology',
    taxonomyCode: '207RC0000X',
    stateLicense: 'NY-67890',
    state: 'NY',
    deaNumber: 'AP3456789',
  },
  {
    localData: { prescriberIdQualifier: 1, prescriberId: '1456789012' },
    enrollmentKey: 'OOznCEj3yhv8WEY2aB_ixmMaFvBC6BGX21lNW9xV0_M',
    firstName: 'Michael',
    lastName: 'Jones',
    credential: 'DO',
    specialty: 'Family Medicine',
    taxonomyCode: '207Q00000X',
    stateLicense: 'TX-11223',
    state: 'TX',
    deaNumber: 'AJ5678901',
  },
  {
    localData: { prescriberIdQualifier: 1, prescriberId: '1567890123' },
    enrollmentKey: 'xUMyTg2Ebk30rW7pzPE7QmtuvSRB9q-gmy_w8jIwHGQ',
    firstName: 'Jennifer',
    lastName: 'Kim',
    credential: 'MD',
    specialty: 'Endocrinology',
    taxonomyCode: '207RE0101X',
    stateLicense: 'IL-44556',
    state: 'IL',
    deaNumber: 'AK7890123',
  },
  {
    localData: { prescriberIdQualifier: 1, prescriberId: '1678901234' },
    enrollmentKey: 'u6oJYMbXMtaklRKxEUSjIwXtTDNzYkWaQE8sqt1hM9I',
    firstName: 'Maria',
    lastName: 'Garcia',
    credential: 'NP',
    specialty: 'Nurse Practitioner - Family',
    taxonomyCode: '363LF0000X',
    stateLicense: 'FL-77889',
    state: 'FL',
    deaNumber: 'MG9012345',
  },
  {
    localData: { prescriberIdQualifier: 1, prescriberId: '1789012345' },
    enrollmentKey: 'VxwuV-VrkPAxoWRDK5fLhVVS_bDuQvSnYuIiPO0KInc',
    firstName: 'David',
    lastName: 'Thompson',
    credential: 'MD',
    specialty: 'Psychiatry',
    taxonomyCode: '2084P0800X',
    stateLicense: 'PA-99001',
    state: 'PA',
    deaNumber: 'AT1234098',
  },
  {
    localData: { prescriberIdQualifier: 1, prescriberId: '1890123456' },
    enrollmentKey: 'tr-yD6cbuBcWBm9dEjCD8x2D2PP5ZLWiI_AhoMqR80Q',
    firstName: 'Emily',
    lastName: 'Wilson',
    credential: 'PA',
    specialty: 'Physician Assistant',
    taxonomyCode: '363A00000X',
    stateLicense: 'OH-22334',
    state: 'OH',
    deaNumber: 'MW2345678',
  },
  {
    localData: { prescriberIdQualifier: 1, prescriberId: '1901234567' },
    enrollmentKey: '8IydwvtG_0ymWMZ9LX1I4wpZY9PH3qFcTEhqFY8R5DA',
    firstName: 'Thanh',
    lastName: 'Nguyen',
    credential: 'MD',
    specialty: 'Pulmonology',
    taxonomyCode: '207RP1001X',
    stateLicense: 'WA-55667',
    state: 'WA',
    deaNumber: 'AN3456789',
  },
  {
    localData: { prescriberIdQualifier: 1, prescriberId: '1012345678' },
    enrollmentKey: '3RMBQoAYuzb6CoD6oepLsSBN5ojn6_QnbFptjfE0ffg',
    firstName: 'Robert',
    lastName: 'Smith',
    credential: 'MD',
    specialty: 'Oncology',
    taxonomyCode: '207RX0202X',
    stateLicense: 'MA-88990',
    state: 'MA',
    deaNumber: 'AS4567890',
  },
  {
    localData: { prescriberIdQualifier: 1, prescriberId: '1123456789' },
    enrollmentKey: 'oIvqJdxtPqYPU0ENnyHPrbirjAbjEDS58686Z6Wibt4',
    firstName: 'Lisa',
    lastName: 'Brown',
    credential: 'PharmD',
    specialty: 'Clinical Pharmacist Practitioner',
    taxonomyCode: '183500000X',
    stateLicense: 'AZ-11234',
    state: 'AZ',
    deaNumber: 'AB5678901',
  },
];

/** Quick lookup: NPI → SeedPrescriber */
export const PRESCRIBER_BY_NPI = new Map<string, SeedPrescriber>(
  PRESCRIBERS.map((p) => [p.localData.prescriberId, p]),
);
