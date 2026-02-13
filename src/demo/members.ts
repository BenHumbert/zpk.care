/**
 * Demo Member Data — Sample Beneficiaries
 *
 * Fictional members with realistic demographic fields.
 * All personal data is FICTIONAL — not real individuals.
 *
 * NCPDP fields mapped to our MemberLocalData:
 *   - cardholderId: 302-C2 (plan-assigned ID)
 *   - dateOfBirth: 304-C4 (CCYYMMDD)
 *   - genderCode: 305-C5 (1=Male, 2=Female, 0=Not Specified)
 *   - firstName: 310-CA
 *   - lastName: 311-CB
 *
 * Extended fields (display-only, for demo UI):
 *   - employeeId, relationship, address, phone, email
 */
import type { MemberLocalData } from '../models/member.js';

/**
 * Extended member record with display-friendly fields.
 * The ZK system only uses MemberLocalData + enrollmentKey; the rest is for demo UI.
 */
export interface DemoMember {
  /** ZK-compatible local data (goes into wallet derivation) */
  localData: MemberLocalData;
  /** Enrollment key (user-generated 2FA secret, stays on device) */
  enrollmentKey: string;
  /** Display: employer-assigned employee ID */
  employeeId: string;
  /** Display: relationship to subscriber (SELF, SPOUSE, CHILD, OTHER) */
  relationship: string;
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
  /** Display: email */
  email: string;
}

/**
 * 8 fictional members across different demographics.
 *
 * Cardholder IDs follow typical PBM patterns: group prefix + sequence.
 * Enrollment keys are user-generated secrets — in production, these
 * would be cryptographically random; here they're descriptive for demo clarity.
 */
export const DEMO_MEMBERS: DemoMember[] = [
  {
    localData: {
      cardholderId: 'ACME-EMP-001',
      dateOfBirth: '19850315',
      genderCode: 2,
      firstName: 'Alice',
      lastName: 'Johnson',
    },
    enrollmentKey: 'alice-enrollment-secret-2026',
    employeeId: 'EMP-10001',
    relationship: 'SELF',
    address: '742 Evergreen Terrace',
    city: 'Springfield',
    state: 'IL',
    zip: '62704',
    phone: '217-555-1001',
    email: 'alice.johnson@example.com',
  },
  {
    localData: {
      cardholderId: 'ACME-EMP-002',
      dateOfBirth: '19780622',
      genderCode: 1,
      firstName: 'Bob',
      lastName: 'Martinez',
    },
    enrollmentKey: 'bob-enrollment-secret-2026',
    employeeId: 'EMP-10002',
    relationship: 'SELF',
    address: '1600 Pennsylvania Ave',
    city: 'Dallas',
    state: 'TX',
    zip: '75201',
    phone: '214-555-1002',
    email: 'bob.martinez@example.com',
  },
  {
    localData: {
      cardholderId: 'ACME-EMP-003',
      dateOfBirth: '19920108',
      genderCode: 2,
      firstName: 'Carol',
      lastName: 'Williams',
    },
    enrollmentKey: 'carol-enrollment-secret-2026',
    employeeId: 'EMP-10003',
    relationship: 'SELF',
    address: '221B Baker Street',
    city: 'New York',
    state: 'NY',
    zip: '10001',
    phone: '212-555-1003',
    email: 'carol.williams@example.com',
  },
  {
    localData: {
      cardholderId: 'ACME-DEP-003A',
      dateOfBirth: '19940715',
      genderCode: 1,
      firstName: 'Daniel',
      lastName: 'Williams',
    },
    enrollmentKey: 'daniel-enrollment-secret-2026',
    employeeId: 'EMP-10003',
    relationship: 'SPOUSE',
    address: '221B Baker Street',
    city: 'New York',
    state: 'NY',
    zip: '10001',
    phone: '212-555-1004',
    email: 'daniel.williams@example.com',
  },
  {
    localData: {
      cardholderId: 'ACME-DEP-003B',
      dateOfBirth: '20150420',
      genderCode: 2,
      firstName: 'Emma',
      lastName: 'Williams',
    },
    enrollmentKey: 'emma-enrollment-secret-2026',
    employeeId: 'EMP-10003',
    relationship: 'CHILD',
    address: '221B Baker Street',
    city: 'New York',
    state: 'NY',
    zip: '10001',
    phone: '212-555-1003',
    email: 'carol.williams@example.com',
  },
  {
    localData: {
      cardholderId: 'GLOBEX-EMP-001',
      dateOfBirth: '19700101',
      genderCode: 1,
      firstName: 'Frank',
      lastName: 'Lee',
    },
    enrollmentKey: 'frank-enrollment-secret-2026',
    employeeId: 'GX-50001',
    relationship: 'SELF',
    address: '350 Fifth Avenue',
    city: 'New York',
    state: 'NY',
    zip: '10118',
    phone: '212-555-1005',
    email: 'frank.lee@example.com',
  },
  {
    localData: {
      cardholderId: 'GLOBEX-EMP-002',
      dateOfBirth: '19880930',
      genderCode: 2,
      firstName: 'Grace',
      lastName: 'Nakamura',
    },
    enrollmentKey: 'grace-enrollment-secret-2026',
    employeeId: 'GX-50002',
    relationship: 'SELF',
    address: '1000 Sunset Blvd',
    city: 'San Francisco',
    state: 'CA',
    zip: '94102',
    phone: '415-555-1006',
    email: 'grace.nakamura@example.com',
  },
  {
    localData: {
      cardholderId: 'GLOBEX-EMP-003',
      dateOfBirth: '19950212',
      genderCode: 1,
      firstName: 'Henry',
      lastName: 'Okafor',
    },
    enrollmentKey: 'henry-enrollment-secret-2026',
    employeeId: 'GX-50003',
    relationship: 'SELF',
    address: '555 Collins Avenue',
    city: 'Miami',
    state: 'FL',
    zip: '33139',
    phone: '305-555-1007',
    email: 'henry.okafor@example.com',
  },
];

/** Quick lookup: cardholderId → DemoMember */
export const MEMBER_BY_CARDHOLDER_ID = new Map<string, DemoMember>(
  DEMO_MEMBERS.map((m) => [m.localData.cardholderId, m]),
);

/** Quick lookup: employeeId → DemoMember[] (employee + dependents) */
export function getMembersByEmployee(employeeId: string): DemoMember[] {
  return DEMO_MEMBERS.filter((m) => m.employeeId === employeeId);
}

/** Get only subscribers (relationship=SELF) */
export function getSubscribers(): DemoMember[] {
  return DEMO_MEMBERS.filter((m) => m.relationship === 'SELF');
}

/** Get ACME Corp members */
export function getAcmeMembers(): DemoMember[] {
  return DEMO_MEMBERS.filter((m) => m.localData.cardholderId.startsWith('ACME'));
}

/** Get Globex Corp members */
export function getGlobexMembers(): DemoMember[] {
  return DEMO_MEMBERS.filter((m) => m.localData.cardholderId.startsWith('GLOBEX'));
}
