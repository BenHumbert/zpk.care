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

import {
  PRESCRIBERS, PRESCRIBER_BY_NPI,
  PHARMACIES, PHARMACY_BY_NPI,
  MEDICATIONS, TIER1_GENERICS, TIER2_PREFERRED, TIER3_NON_PREFERRED, TIER4_SPECIALTY,
  MEDICATION_BY_NDC, getAllFormularyEntries, getFormularyEntriesByTier,
  buildMedicationLocalData, buildMedicationPricingLocalData,
  MEMBERS, MEMBER_BY_CARDHOLDER_ID, getMembersByEmployee, getSubscribers,
  getFernhillMembers, getBaysideMembers, getAcmeMembers, getGlobexMembers,
} from '../src/data/index.js';

describe('Seed Data — Smoke Tests', () => {
  // ── Prescribers (fictional fixtures; tests/fixture-identities.test.ts checks the identities) ──
  test('has 12 prescribers', () => {
    expect(PRESCRIBERS).toHaveLength(12);
  });

  test('all prescribers have NPI qualifier = 1', () => {
    for (const p of PRESCRIBERS) {
      expect(p.localData.prescriberIdQualifier).toBe(1);
    }
  });

  test('all prescribers have 10-digit NPI', () => {
    for (const p of PRESCRIBERS) {
      expect(p.localData.prescriberId).toMatch(/^\d{10}$/);
    }
  });

  test('PRESCRIBER_BY_NPI lookup works', () => {
    const first = PRESCRIBERS[0];
    const found = PRESCRIBER_BY_NPI.get(first.localData.prescriberId);
    expect(found).toBeDefined();
    expect(found!.lastName).toBe(first.lastName);
  });

  test('prescriber NPIs are unique', () => {
    const npis = PRESCRIBERS.map((p) => p.localData.prescriberId);
    expect(new Set(npis).size).toBe(npis.length);
  });

  // ── Pharmacies (fictional fixtures) ──
  test('has 8 pharmacies', () => {
    expect(PHARMACIES).toHaveLength(8);
  });

  test('all pharmacies have qualifier = 1', () => {
    for (const p of PHARMACIES) {
      expect(p.localData.serviceProviderIdQualifier).toBe(1);
    }
  });

  test('all pharmacies have 10-digit NPI', () => {
    for (const p of PHARMACIES) {
      expect(p.localData.serviceProviderId).toMatch(/^\d{10}$/);
    }
  });

  test('PHARMACY_BY_NPI lookup works', () => {
    const first = PHARMACIES[0];
    const found = PHARMACY_BY_NPI.get(first.localData.serviceProviderId);
    expect(found).toBeDefined();
    expect(found!.storeName).toBe(first.storeName);
  });

  test('all pharmacy types are valid NCPDP codes', () => {
    const validTypes = ['01', '02', '03', '04', '05', '06', '07'];
    for (const p of PHARMACIES) {
      expect(validTypes).toContain(p.pharmacyType);
    }
  });

  // ── Medications (NADAC — 32,768 real drugs) ──
  test('has 32,768 medications (MerkleTree(16) capacity)', () => {
    expect(MEDICATIONS).toHaveLength(32768);
  });

  test('tier distribution covers all 4 tiers', () => {
    expect(TIER1_GENERICS.length).toBeGreaterThan(0);
    expect(TIER2_PREFERRED.length).toBeGreaterThan(0);
    expect(TIER3_NON_PREFERRED.length).toBeGreaterThan(0);
    expect(TIER4_SPECIALTY.length).toBeGreaterThan(0);
    expect(TIER1_GENERICS.length + TIER2_PREFERRED.length +
           TIER3_NON_PREFERRED.length + TIER4_SPECIALTY.length).toBe(32768);
  });

  test('all NDCs are 11-digit', () => {
    for (const m of MEDICATIONS) {
      expect(m.ndc).toMatch(/^\d{11}$/);
    }
  });

  test('MEDICATION_BY_NDC lookup works', () => {
    const first = MEDICATIONS[0];
    const found = MEDICATION_BY_NDC.get(first.ndc);
    expect(found).toBeDefined();
    expect(found!.formularyEntry.ndc).toBe(first.ndc);
  });

  test('formulary entry NDCs match medication NDCs', () => {
    for (const m of MEDICATIONS) {
      expect(m.formularyEntry.ndc).toBe(m.ndc);
    }
  });

  test('tier copays: T1=$10, T2=$35, T3=$75, T4=$150', () => {
    for (const m of TIER1_GENERICS) expect(m.formularyEntry.copayAmount).toBe(1000);
    for (const m of TIER2_PREFERRED) expect(m.formularyEntry.copayAmount).toBe(3500);
    for (const m of TIER3_NON_PREFERRED) expect(m.formularyEntry.copayAmount).toBe(7500);
    for (const m of TIER4_SPECIALTY) expect(m.formularyEntry.copayAmount).toBe(15000);
  });

  test('all tier 4 meds require prior auth', () => {
    for (const m of TIER4_SPECIALTY) {
      expect(m.formularyEntry.requiresPriorAuth).toBe(true);
    }
  });

  test('getAllFormularyEntries returns all 32,768', () => {
    expect(getAllFormularyEntries()).toHaveLength(32768);
  });

  test('getFormularyEntriesByTier filters correctly', () => {
    expect(getFormularyEntriesByTier(1).length).toBe(TIER1_GENERICS.length);
    expect(getFormularyEntriesByTier(2).length).toBe(TIER2_PREFERRED.length);
    expect(getFormularyEntriesByTier(3).length).toBe(TIER3_NON_PREFERRED.length);
    expect(getFormularyEntriesByTier(4).length).toBe(TIER4_SPECIALTY.length);
  });

  test('buildMedicationLocalData produces valid MedicationLocalData', () => {
    const med = MEDICATIONS[0];
    const medData = buildMedicationLocalData(med, 'RX-001', 30, 0, 30);
    expect(medData.productServiceId).toBe(med.ndc);
    expect(medData.productServiceIdQualifier).toBe(3);
    expect(medData.quantityDispensed).toBe(30);
    expect(medData.fillNumber).toBe(0);
    expect(medData.daysSupply).toBe(30);
  });

  test('buildMedicationPricingLocalData computes AWP-based costs', () => {
    const med = MEDICATIONS[0];
    const pricing = buildMedicationPricingLocalData(med, 30);
    expect(pricing.ingredientCostSubmitted).toBe(med.awpUnitPriceCents * 30);
    expect(pricing.dispensingFeeSubmitted).toBe(200); // default $2.00
    expect(pricing.usualAndCustomaryCharge).toBe(med.awpUnitPriceCents * 30 + 200);
  });

  // ── Members (fictional fixtures — two invented employers) ──
  test('has 8 members', () => {
    expect(MEMBERS).toHaveLength(8);
  });

  test('all members have valid DOB format', () => {
    for (const m of MEMBERS) {
      expect(m.localData.dateOfBirth).toMatch(/^\d{8}$/);
    }
  });

  test('all members have valid gender codes', () => {
    for (const m of MEMBERS) {
      expect([0, 1, 2]).toContain(m.localData.genderCode);
    }
  });

  test('MEMBER_BY_CARDHOLDER_ID lookup works', () => {
    const alice = MEMBER_BY_CARDHOLDER_ID.get('FERN-EMP-001');
    expect(alice).toBeDefined();
    expect(alice!.localData.firstName).toBe('Alice');
    expect(alice!.localData.lastName).toBe('Johnson');
  });

  test('getSubscribers returns only SELF', () => {
    const subs = getSubscribers();
    for (const s of subs) expect(s.relationship).toBe('SELF');
    expect(subs.length).toBe(6);
  });

  test('getMembersByEmployee returns employee + dependents', () => {
    const family = getMembersByEmployee('EMP-10003');
    expect(family).toHaveLength(3);  // Carol + Daniel + Emma Williams
    expect(family.map((m) => m.relationship).sort()).toEqual(['CHILD', 'SELF', 'SPOUSE']);
  });

  test('getFernhillMembers returns the 5 Fernhill Instruments members', () => {
    const fernhill = getFernhillMembers();
    expect(fernhill).toHaveLength(5);
    for (const m of fernhill) expect(m.familyId.startsWith('FAM-FERN-')).toBe(true);
  });

  test('getBaysideMembers returns the 3 Bayside Test Works members', () => {
    const bayside = getBaysideMembers();
    expect(bayside).toHaveLength(3);
    for (const m of bayside) expect(m.familyId.startsWith('FAM-BAY-')).toBe(true);
  });

  test('the old helper names still answer, as the new ones', () => {
    expect(getAcmeMembers).toBe(getFernhillMembers);
    expect(getGlobexMembers).toBe(getBaysideMembers);
  });

  test('NDC uniqueness across all medications', () => {
    const ndcs = MEDICATIONS.map((m) => m.ndc);
    expect(new Set(ndcs).size).toBe(ndcs.length);
  });

  test('cardholderId uniqueness', () => {
    const ids = MEMBERS.map((m) => m.localData.cardholderId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
