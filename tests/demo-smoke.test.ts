import {
  DEMO_PRESCRIBERS, PRESCRIBER_BY_NPI,
  DEMO_PHARMACIES, PHARMACY_BY_NPI, PHARMACY_BY_NCPDP,
  DEMO_MEDICATIONS, TIER1_GENERICS, TIER2_PREFERRED, TIER3_NON_PREFERRED, TIER4_SPECIALTY,
  MEDICATION_BY_NDC, MEDICATION_BY_GPI, getAllFormularyEntries, getFormularyEntriesByTier,
  buildMedicationLocalData, buildMedicationPricingLocalData,
  DEMO_MEMBERS, MEMBER_BY_CARDHOLDER_ID, getMembersByEmployee, getSubscribers, getAcmeMembers, getGlobexMembers,
} from '../src/demo/index.js';

describe('Demo Data — Smoke Tests', () => {
  // ── Prescribers ──
  test('has 10 prescribers', () => {
    expect(DEMO_PRESCRIBERS).toHaveLength(10);
  });

  test('all prescribers have NPI qualifier = 1', () => {
    for (const p of DEMO_PRESCRIBERS) {
      expect(p.localData.prescriberIdQualifier).toBe(1);
    }
  });

  test('all prescribers have 10-digit NPI', () => {
    for (const p of DEMO_PRESCRIBERS) {
      expect(p.localData.prescriberId).toMatch(/^\d{10}$/);
    }
  });

  test('PRESCRIBER_BY_NPI lookup works', () => {
    const chen = PRESCRIBER_BY_NPI.get('1234567890');
    expect(chen).toBeDefined();
    expect(chen!.lastName).toBe('Chen');
    expect(chen!.specialty).toBe('Internal Medicine');
  });

  test('prescriber NPIs are unique', () => {
    const npis = DEMO_PRESCRIBERS.map((p) => p.localData.prescriberId);
    expect(new Set(npis).size).toBe(npis.length);
  });

  // ── Pharmacies ──
  test('has 8 pharmacies', () => {
    expect(DEMO_PHARMACIES).toHaveLength(8);
  });

  test('all pharmacies have qualifier = 1', () => {
    for (const p of DEMO_PHARMACIES) {
      expect(p.localData.serviceProviderIdQualifier).toBe(1);
    }
  });

  test('all pharmacies have 10-digit NPI starting with 2', () => {
    for (const p of DEMO_PHARMACIES) {
      expect(p.localData.serviceProviderId).toMatch(/^2\d{9}$/);
    }
  });

  test('PHARMACY_BY_NPI lookup works', () => {
    const mainSt = PHARMACY_BY_NPI.get('2345678901');
    expect(mainSt).toBeDefined();
    expect(mainSt!.storeName).toBe('Main Street Pharmacy');
  });

  test('PHARMACY_BY_NCPDP lookup works', () => {
    const rxDirect = PHARMACY_BY_NCPDP.get('5904567');
    expect(rxDirect).toBeDefined();
    expect(rxDirect!.storeName).toBe('RxDirect Mail');
    expect(rxDirect!.pharmacyType).toBe('04');
  });

  test('all pharmacy types are valid NCPDP codes', () => {
    const validTypes = ['01', '02', '03', '04', '05', '06', '07'];
    for (const p of DEMO_PHARMACIES) {
      expect(validTypes).toContain(p.pharmacyType);
    }
  });

  // ── Medications ──
  test('has 22 medications total', () => {
    expect(DEMO_MEDICATIONS).toHaveLength(22);
  });

  test('tier distribution: 7 + 5 + 5 + 5', () => {
    expect(TIER1_GENERICS).toHaveLength(7);
    expect(TIER2_PREFERRED).toHaveLength(5);
    expect(TIER3_NON_PREFERRED).toHaveLength(5);
    expect(TIER4_SPECIALTY).toHaveLength(5);
  });

  test('all NDCs are 11-digit', () => {
    for (const m of DEMO_MEDICATIONS) {
      expect(m.ndc).toMatch(/^\d{11}$/);
    }
  });

  test('all GPIs are 14-digit', () => {
    for (const m of DEMO_MEDICATIONS) {
      expect(m.gpi).toMatch(/^\d{14}$/);
    }
  });

  test('MEDICATION_BY_NDC lookup works', () => {
    const lisinopril = MEDICATION_BY_NDC.get('00071015523');
    expect(lisinopril).toBeDefined();
    expect(lisinopril!.genericName).toBe('Lisinopril');
    expect(lisinopril!.formularyEntry.tierLevel).toBe(1);
  });

  test('MEDICATION_BY_GPI lookup works', () => {
    const atorvastatin = MEDICATION_BY_GPI.get('33100020100110');
    expect(atorvastatin).toBeDefined();
    expect(atorvastatin!.genericName).toBe('Atorvastatin Calcium');
  });

  test('formulary entry NDCs match medication NDCs', () => {
    for (const m of DEMO_MEDICATIONS) {
      expect(m.formularyEntry.ndc).toBe(m.ndc);
    }
  });

  test('tier 1 copay = $10, tier 2 = $30, tier 3 = $60, tier 4 = $150', () => {
    for (const m of TIER1_GENERICS) expect(m.formularyEntry.copayAmount).toBe(1000);
    for (const m of TIER2_PREFERRED) expect(m.formularyEntry.copayAmount).toBe(3000);
    for (const m of TIER3_NON_PREFERRED) expect(m.formularyEntry.copayAmount).toBe(6000);
    for (const m of TIER4_SPECIALTY) expect(m.formularyEntry.copayAmount).toBe(15000);
  });

  test('all tier 4 meds require prior auth', () => {
    for (const m of TIER4_SPECIALTY) {
      expect(m.formularyEntry.requiresPriorAuth).toBe(true);
    }
  });

  test('getAllFormularyEntries returns all 22', () => {
    expect(getAllFormularyEntries()).toHaveLength(22);
  });

  test('getFormularyEntriesByTier filters correctly', () => {
    expect(getFormularyEntriesByTier(1)).toHaveLength(7);
    expect(getFormularyEntriesByTier(2)).toHaveLength(5);
    expect(getFormularyEntriesByTier(3)).toHaveLength(5);
    expect(getFormularyEntriesByTier(4)).toHaveLength(5);
  });

  test('buildMedicationLocalData produces valid MedicationLocalData', () => {
    const lisinopril = MEDICATION_BY_NDC.get('00071015523')!;
    const medData = buildMedicationLocalData(lisinopril, 'RX-001', 30, 0, 30);
    expect(medData.productServiceId).toBe('00071015523');
    expect(medData.productServiceIdQualifier).toBe(3);
    expect(medData.quantityDispensed).toBe(30);
    expect(medData.fillNumber).toBe(0);
    expect(medData.daysSupply).toBe(30);
  });

  test('buildMedicationPricingLocalData computes AWP-based costs', () => {
    const lisinopril = MEDICATION_BY_NDC.get('00071015523')!;
    const pricing = buildMedicationPricingLocalData(lisinopril, 30);
    expect(pricing.ingredientCostSubmitted).toBe(15 * 30); // 15 cents/unit * 30
    expect(pricing.dispensingFeeSubmitted).toBe(200); // default $2.00
    expect(pricing.usualAndCustomaryCharge).toBe(15 * 30 + 200);
  });

  // ── Members ──
  test('has 8 members', () => {
    expect(DEMO_MEMBERS).toHaveLength(8);
  });

  test('all members have valid DOB format', () => {
    for (const m of DEMO_MEMBERS) {
      expect(m.localData.dateOfBirth).toMatch(/^\d{8}$/);
    }
  });

  test('all members have valid gender codes', () => {
    for (const m of DEMO_MEMBERS) {
      expect([0, 1, 2]).toContain(m.localData.genderCode);
    }
  });

  test('MEMBER_BY_CARDHOLDER_ID lookup works', () => {
    const alice = MEMBER_BY_CARDHOLDER_ID.get('ACME-EMP-001');
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

  test('getAcmeMembers returns 5 ACME members', () => {
    expect(getAcmeMembers()).toHaveLength(5);
  });

  test('getGlobexMembers returns 3 Globex members', () => {
    expect(getGlobexMembers()).toHaveLength(3);
  });

  test('NDC uniqueness across all medications', () => {
    const ndcs = DEMO_MEDICATIONS.map((m) => m.ndc);
    expect(new Set(ndcs).size).toBe(ndcs.length);
  });

  test('cardholderId uniqueness', () => {
    const ids = DEMO_MEMBERS.map((m) => m.localData.cardholderId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
