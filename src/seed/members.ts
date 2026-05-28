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
 * Seed Member Data — Sample Beneficiaries
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
 * Extended fields (display-only, for UI):
 *   - employeeId, relationship, address, phone, email
 */
import type { MemberLocalData } from '../models/member.js';

/**
 * Extended member record with display-friendly fields.
 * The ZK system only uses MemberLocalData + enrollmentKey; the rest is for UI.
 */
export interface SeedMember {
  /** ZK-compatible local data (goes into wallet derivation) */
  localData: MemberLocalData;
  /** Enrollment key (user-generated 2FA secret, stays on device) */
  enrollmentKey: string;
  /** Display: employer-assigned employee ID */
  employeeId: string;
  /** Family identifier — groups subscriber + dependents. Employer-generated. */
  familyId: string;
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
 * Enrollment keys are 256-bit cryptographically random secrets (base64url).
 * Generated via crypto.randomBytes(32) — same format as production.
 */
export const MEMBERS: SeedMember[] = [
  {
    localData: {
      cardholderId: 'ACME-EMP-001',
      dateOfBirth: '19850315',
      genderCode: 2,
      firstName: 'Alice',
      lastName: 'Johnson',
    },
    enrollmentKey: 'JQPHJGskGApMqdkhO54jBMMHkt-X7F9qtzL1-XWcLgg',
    employeeId: 'EMP-10001',
    familyId: 'FAM-ACME-10001',
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
    enrollmentKey: 'Hi-q1tOsEq4wQyZbjFH3RGVpOTFpEx6jHmfVVeavJLM',
    employeeId: 'EMP-10002',
    familyId: 'FAM-ACME-10002',
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
    enrollmentKey: 'TIWNbqbc3A0plIcxHaambI39sR2U_Eai3StqyAoX6yk',
    employeeId: 'EMP-10003',
    familyId: 'FAM-ACME-10003',
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
    enrollmentKey: 'YBPTaHEaJhkZ6OlmQKnM9YF0ab8NNK71X_wFXOFd3QE',
    employeeId: 'EMP-10003',
    familyId: 'FAM-ACME-10003',
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
    enrollmentKey: '6iWfcfRkeTzvMcWWL2ZnDAHaCExfA1adtMSdT9hbt8o',
    employeeId: 'EMP-10003',
    familyId: 'FAM-ACME-10003',
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
    enrollmentKey: 'C_7-Nfw7z_SXsgaIh4eNoMVW3Tlsh_xMIFkfcHy0S5Q',
    employeeId: 'GX-50001',
    familyId: 'FAM-GX-50001',
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
    enrollmentKey: 'SpTd-J0WgzvQg2Y-5iGcHPZ5XDOvl3KoFK_0xXpWZNY',
    employeeId: 'GX-50002',
    familyId: 'FAM-GX-50002',
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
    enrollmentKey: 'u1so1epbAeoqZleQMbKYfXNQ9-hzZfbEvrEn78ymyrU',
    employeeId: 'GX-50003',
    familyId: 'FAM-GX-50003',
    relationship: 'SELF',
    address: '555 Collins Avenue',
    city: 'Miami',
    state: 'FL',
    zip: '33139',
    phone: '305-555-1007',
    email: 'henry.okafor@example.com',
  },
];

/** Quick lookup: cardholderId → SeedMember */
export const MEMBER_BY_CARDHOLDER_ID = new Map<string, SeedMember>(
  MEMBERS.map((m) => [m.localData.cardholderId, m]),
);

/** Quick lookup: employeeId → SeedMember[] (employee + dependents) */
export function getMembersByEmployee(employeeId: string): SeedMember[] {
  return MEMBERS.filter((m) => m.employeeId === employeeId);
}

/** Quick lookup: familyId → SeedMember[] (subscriber + all dependents) */
export function getMembersByFamily(familyId: string): SeedMember[] {
  return MEMBERS.filter((m) => m.familyId === familyId);
}

/** Get only subscribers (relationship=SELF) */
export function getSubscribers(): SeedMember[] {
  return MEMBERS.filter((m) => m.relationship === 'SELF');
}

/** Get ACME Corp members */
export function getAcmeMembers(): SeedMember[] {
  return MEMBERS.filter((m) => m.localData.cardholderId.startsWith('ACME'));
}

/** Get Globex Corp members */
export function getGlobexMembers(): SeedMember[] {
  return MEMBERS.filter((m) => m.localData.cardholderId.startsWith('GLOBEX'));
}
