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
 * Production Data — Real CMS/NPPES provider and drug data for Madison, WI
 *
 * Data sources (all PUBLIC RECORD):
 *   - NPPES (NPI Registry) — prescribers and pharmacies
 *   - NADAC (CMS Medicaid drug pricing) — formulary with 32,768 medications
 *
 * This module exports the same interfaces and constants as src/seed/index.ts
 * so existing code can swap imports with minimal changes.
 *
 * Members remain POC-specific (configurable test beneficiaries).
 */

import * as fs from 'fs';
import * as path from 'path';

import type { PrescriberLocalData } from '../models/prescriber.js';
import type { PharmacyLocalData } from '../models/pharmacy.js';
import type { MemberLocalData } from '../models/member.js';
import type { FormularyEntryLocalData } from '../access-control/formulary-entry.js';
import type { MedicationLocalData, MedicationPricingLocalData } from '../models/medication.js';

// Locate data JSON files. Works in both CJS (Jest) and ESM (tsx/tsc).
// Resolve from project root → src/data/ to avoid import.meta.url (breaks Jest CJS).
const _dataDir = path.resolve(
  process.env.ZKP_DATA_DIR ||
  path.join(process.cwd(), 'src', 'data'),
);

// ── Types (re-export compatible interfaces) ─────────────────

/**
 * Prescriber record — real NPPES data.
 * Compatible with SeedPrescriber interface from src/seed/.
 */
export interface SeedPrescriber {
  localData: PrescriberLocalData;
  enrollmentKey: string;
  firstName: string;
  lastName: string;
  credential: string;
  specialty: string;
  taxonomyCode: string;
  stateLicense: string;
  state: string;
  deaNumber: string;
}

/**
 * Pharmacy record — real NPPES data.
 * Compatible with SeedPharmacy interface from src/seed/.
 */
export interface SeedPharmacy {
  localData: PharmacyLocalData;
  enrollmentKey: string;
  ncpdpProviderId: string;
  storeName: string;
  chain: string;
  pharmacyType: string;
  pharmacyTypeDesc: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  phone: string;
  deaNumber: string;
}

/**
 * Medication record — real NADAC data mapped to formulary structure.
 * Compatible with SeedMedication interface from src/seed/.
 */
export interface SeedMedication {
  ndc: string;
  ndcFormatted: string;
  gpi: string;
  brandName: string;
  genericName: string;
  strength: string;
  dosageForm: string;
  route: string;
  manufacturer: string;
  therapeuticClass: string;
  deaSchedule: number;
  awpUnitPriceCents: number;
  awpPackagePriceCents: number;
  packageSize: number;
  formularyEntry: FormularyEntryLocalData;
  initiallyOnFormulary?: boolean;
}

/**
 * Member record — POC beneficiaries (configurable test data).
 * Compatible with SeedMember interface from src/seed/.
 */
export interface SeedMember {
  localData: MemberLocalData;
  enrollmentKey: string;
  employeeId: string;
  familyId: string;
  relationship: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  phone: string;
  email: string;
}

// ── JSON Loaders ────────────────────────────────────────────

function loadJson<T>(filename: string): T {
  const filePath = path.join(_dataDir, filename);
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

// Raw JSON shapes from import scripts
interface PrescriberJson {
  localData: { prescriberIdQualifier: number; prescriberId: string };
  enrollmentKey: string;
  firstName: string;
  lastName: string;
  credential: string;
  specialty: string;
  taxonomyCode: string;
  stateLicense: string;
  state: string;
  deaNumber: string;
  npi: string;
  address: string;
  city: string;
  zip: string;
  phone: string;
}

interface PharmacyJson {
  localData: { serviceProviderIdQualifier: number; serviceProviderId: string };
  enrollmentKey: string;
  storeName: string;
  chain: string;
  pharmacyType: string;
  pharmacyTypeDesc: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  phone: string;
  npi: string;
  ncpdpProviderId: string;
  taxonomyCode: string;
}

interface FormularyJson {
  ndc: string;
  ndcFormatted: string;
  description: string;
  classification: string;
  nadacPerUnit: number;
  pricingUnit: string;
  otc: boolean;
  effectiveDate: string;
  tierLevel: number;
  copayAmount: number;
  requiresPriorAuth: boolean;
  maxQuantityPerFill: number;
  maxDaySupply: number;
  stepTherapyRequired: boolean;
}

// ── Parse NADAC description into medication fields ──────────

const DOSAGE_FORMS = [
  'TABLET', 'CAPSULE', 'SOLUTION', 'SUSPENSION', 'INJECTION', 'CREAM',
  'OINTMENT', 'GEL', 'PATCH', 'INHALER', 'SPRAY', 'DROPS', 'SUPPOSITORY',
  'POWDER', 'LIQUID', 'SYRUP', 'LOTION', 'FOAM', 'AEROSOL', 'ENEMA',
  'IMPLANT', 'FILM', 'GRANULES', 'PELLETS', 'RING', 'INSERT', 'KIT',
  'SWAB', 'SHAMPOO', 'EMULSION', 'PASTE', 'STRIP', 'WAFER', 'LOZENGE',
  'ELIXIR', 'TINCTURE', 'OIL', 'VIAL', 'PEN', 'SYRINGE', 'CARTRIDGE',
  'AMPULE', 'PACKET', 'SACHET', 'POUCH', 'CHEWABLE', 'DELAYED-RELEASE',
  'EXTENDED-RELEASE', 'ER', 'DR', 'CR', 'SR', 'XR', 'XL', 'LA', 'HFA',
  'MDI', 'DPI', 'OPHTHALMIC', 'OTIC', 'NASAL', 'RECTAL', 'VAGINAL',
  'TOPICAL', 'ORAL', 'SUBLINGUAL', 'BUCCAL', 'TRANSDERMAL',
];

function parseDescription(desc: string): { genericName: string; strength: string; dosageForm: string } {
  // NADAC descriptions are like "LISINOPRIL 10 MG TABLET" or "ATORVASTATIN CALCIUM 20 MG TABLET"
  const parts = desc.split(/\s+/);

  // Find strength pattern (number + unit)
  let strengthIdx = -1;
  for (let i = 0; i < parts.length; i++) {
    if (/^\d/.test(parts[i]) && i + 1 < parts.length &&
        /^(MG|MCG|ML|MG\/ML|MCG\/ML|%|UNIT|GM|GR|MEQ|IU|MG\/HR|MCG\/HR|MG\/ACTUATION|MCG\/ACTUATION)$/i.test(parts[i + 1])) {
      strengthIdx = i;
      break;
    }
    // Combined like "10MG"
    if (/^\d+\.?\d*(MG|MCG|ML|%)$/i.test(parts[i])) {
      strengthIdx = i;
      break;
    }
  }

  let genericName: string;
  let strength: string;
  let dosageForm: string;

  if (strengthIdx > 0) {
    genericName = parts.slice(0, strengthIdx).join(' ');
    // Find where dosage form starts
    let dosageIdx = parts.length;
    for (let i = strengthIdx; i < parts.length; i++) {
      if (DOSAGE_FORMS.some(f => parts[i].toUpperCase().includes(f))) {
        dosageIdx = i;
        break;
      }
    }
    strength = parts.slice(strengthIdx, dosageIdx).join(' ');
    dosageForm = dosageIdx < parts.length ? parts.slice(dosageIdx).join(' ') : '';
  } else {
    genericName = desc;
    strength = '';
    dosageForm = '';
  }

  return { genericName, strength, dosageForm };
}

function guessRoute(dosageForm: string): string {
  const df = dosageForm.toUpperCase();
  if (df.includes('OPHTHALMIC')) return 'Ophthalmic';
  if (df.includes('OTIC')) return 'Otic';
  if (df.includes('NASAL')) return 'Nasal';
  if (df.includes('RECTAL') || df.includes('SUPPOSITORY') || df.includes('ENEMA')) return 'Rectal';
  if (df.includes('VAGINAL') || df.includes('INSERT') || df.includes('RING')) return 'Vaginal';
  if (df.includes('TOPICAL') || df.includes('CREAM') || df.includes('OINTMENT') ||
      df.includes('GEL') || df.includes('LOTION') || df.includes('FOAM') ||
      df.includes('SHAMPOO') || df.includes('PATCH') || df.includes('TRANSDERMAL')) return 'Topical';
  if (df.includes('INJECTION') || df.includes('SYRINGE') || df.includes('VIAL') ||
      df.includes('AMPULE') || df.includes('CARTRIDGE')) return 'Injectable';
  if (df.includes('INHALER') || df.includes('HFA') || df.includes('MDI') ||
      df.includes('DPI') || df.includes('AEROSOL') || df.includes('INHALATION')) return 'Inhalation';
  if (df.includes('SUBLINGUAL')) return 'Sublingual';
  if (df.includes('BUCCAL')) return 'Buccal';
  return 'Oral';
}

// ── Load & Transform ────────────────────────────────────────

const prescribersRaw = loadJson<PrescriberJson[]>('prescribers.json');
const pharmaciesRaw = loadJson<PharmacyJson[]>('pharmacies.json');

// When ZKTRIDENT_FORMULARY_LIMIT is set, load the pre-built 100-drug subset
// instead of parsing the full 32K NADAC JSON (saves ~2s startup).
const _formularyLimit = parseInt(process.env.ZKTRIDENT_FORMULARY_LIMIT || '0', 10);
const formularyRaw = _formularyLimit > 0 && _formularyLimit <= 100
  ? loadJson<FormularyJson[]>('formulary-100.json')
  : loadJson<FormularyJson[]>('formulary.json');

// ── Prescribers ─────────────────────────────────────────────

export const PRESCRIBERS: SeedPrescriber[] = prescribersRaw.map((p) => ({
  localData: p.localData,
  enrollmentKey: p.enrollmentKey,
  firstName: p.firstName,
  lastName: p.lastName,
  credential: p.credential,
  specialty: p.specialty,
  taxonomyCode: p.taxonomyCode,
  stateLicense: p.stateLicense,
  state: p.state,
  deaNumber: p.deaNumber,
}));

export const PRESCRIBER_BY_NPI = new Map<string, SeedPrescriber>(
  PRESCRIBERS.map((p) => [p.localData.prescriberId, p]),
);

// ── Pharmacies ──────────────────────────────────────────────

export const PHARMACIES: SeedPharmacy[] = pharmaciesRaw.map((p) => ({
  localData: p.localData,
  enrollmentKey: p.enrollmentKey,
  ncpdpProviderId: p.ncpdpProviderId || '',
  storeName: p.storeName,
  chain: p.chain,
  pharmacyType: p.pharmacyType,
  pharmacyTypeDesc: p.pharmacyTypeDesc,
  address: p.address,
  city: p.city,
  state: p.state,
  zip: p.zip,
  phone: p.phone,
  deaNumber: '', // DEA not available from NPPES
}));

export const PHARMACY_BY_NPI = new Map<string, SeedPharmacy>(
  PHARMACIES.map((p) => [p.localData.serviceProviderId, p]),
);

export const PHARMACY_BY_NCPDP = new Map<string, SeedPharmacy>(
  PHARMACIES.filter((p) => p.ncpdpProviderId).map((p) => [p.ncpdpProviderId, p]),
);

// ── Medications (from NADAC formulary) ──────────────────────

function nadacToMedication(f: FormularyJson): SeedMedication {
  const { genericName, strength, dosageForm } = parseDescription(f.description);
  const route = guessRoute(dosageForm);

  // Convert NADAC per-unit price (dollars) to AWP cents (~20% markup typical)
  const nadacCents = Math.round(f.nadacPerUnit * 100);
  const awpUnitCents = Math.round(nadacCents * 1.2); // ~20% AWP markup over acquisition

  return {
    ndc: f.ndc,
    ndcFormatted: f.ndcFormatted,
    gpi: '', // GPI requires Medispan subscription — not available from NADAC
    brandName: f.classification === 'B' ? f.description : `${genericName} (Generic)`,
    genericName,
    strength,
    dosageForm,
    route,
    manufacturer: '', // Not available from NADAC
    therapeuticClass: '', // Not available from NADAC
    deaSchedule: 0,
    awpUnitPriceCents: awpUnitCents,
    awpPackagePriceCents: awpUnitCents * 30, // Default 30-unit package
    packageSize: 30,
    formularyEntry: {
      ndc: f.ndc,
      tierLevel: f.tierLevel,
      copayAmount: f.copayAmount,
      requiresPriorAuth: f.requiresPriorAuth,
      maxQuantityPerFill: f.maxQuantityPerFill,
      maxDaySupply: f.maxDaySupply,
      stepTherapyRequired: f.stepTherapyRequired,
    },
  };
}

export const MEDICATIONS: SeedMedication[] = formularyRaw.map(nadacToMedication);

// Tier arrays
export const TIER1_GENERICS = MEDICATIONS.filter((m) => m.formularyEntry.tierLevel === 1);
export const TIER2_PREFERRED = MEDICATIONS.filter((m) => m.formularyEntry.tierLevel === 2);
export const TIER3_NON_PREFERRED = MEDICATIONS.filter((m) => m.formularyEntry.tierLevel === 3);
export const TIER4_SPECIALTY = MEDICATIONS.filter((m) => m.formularyEntry.tierLevel === 4);

export const MEDICATION_BY_NDC = new Map<string, SeedMedication>(
  MEDICATIONS.map((m) => [m.ndc, m]),
);

export const MEDICATION_BY_GPI = new Map<string, SeedMedication>(
  MEDICATIONS.filter((m) => m.gpi).map((m) => [m.gpi, m]),
);

export function getAllFormularyEntries(): FormularyEntryLocalData[] {
  return MEDICATIONS.map((m) => m.formularyEntry);
}

export function getFormularyEntriesByTier(tier: number): FormularyEntryLocalData[] {
  return MEDICATIONS
    .filter((m) => m.formularyEntry.tierLevel === tier)
    .map((m) => m.formularyEntry);
}

export function buildMedicationLocalData(
  med: SeedMedication,
  rxRefNumber: string,
  quantity: number,
  fillNumber: number,
  daysSupply: number,
): MedicationLocalData {
  return {
    rxServiceRefNumQualifier: 1,
    rxServiceRefNumber: rxRefNumber,
    productServiceIdQualifier: 3, // 03 = NDC
    productServiceId: med.ndc,
    quantityDispensed: quantity,
    fillNumber,
    daysSupply,
    compoundCode: 0,
    dawProductSelectionCode: 0,
  };
}

export function buildMedicationPricingLocalData(
  med: SeedMedication,
  quantity: number,
  dispensingFeeCents: number = 200,
): MedicationPricingLocalData {
  const ingredientCost = med.awpUnitPriceCents * quantity;
  return {
    usualAndCustomaryCharge: ingredientCost + dispensingFeeCents,
    quantityPrescribed: quantity,
    ingredientCostSubmitted: ingredientCost,
    dispensingFeeSubmitted: dispensingFeeCents,
    basisOfCostDetermination: 1, // 01 = AWP
  };
}

// ── Members (POC beneficiaries — Madison, WI) ───────────────

export const MEMBERS: SeedMember[] = [
  {
    localData: {
      cardholderId: 'EPIC-EMP-001',
      dateOfBirth: '19850315',
      genderCode: 2,
      firstName: 'Alice',
      lastName: 'Johnson',
    },
    enrollmentKey: 'JQPHJGskGApMqdkhO54jBMMHkt-X7F9qtzL1-XWcLgg',
    employeeId: 'EMP-10001',
    familyId: 'FAM-EPIC-10001',
    relationship: 'SELF',
    address: '742 Regent Street',
    city: 'Madison',
    state: 'WI',
    zip: '53715',
    phone: '608-555-1001',
    email: 'alice.johnson@epicmail.com',
  },
  {
    localData: {
      cardholderId: 'EPIC-EMP-002',
      dateOfBirth: '19780622',
      genderCode: 1,
      firstName: 'Bob',
      lastName: 'Martinez',
    },
    enrollmentKey: 'Hi-q1tOsEq4wQyZbjFH3RGVpOTFpEx6jHmfVVeavJLM',
    employeeId: 'EMP-10002',
    familyId: 'FAM-EPIC-10002',
    relationship: 'SELF',
    address: '400 University Ave',
    city: 'Madison',
    state: 'WI',
    zip: '53703',
    phone: '608-555-1002',
    email: 'bob.martinez@epicmail.com',
  },
  {
    localData: {
      cardholderId: 'EPIC-EMP-003',
      dateOfBirth: '19920108',
      genderCode: 2,
      firstName: 'Carol',
      lastName: 'Williams',
    },
    enrollmentKey: 'TIWNbqbc3A0plIcxHaambI39sR2U_Eai3StqyAoX6yk',
    employeeId: 'EMP-10003',
    familyId: 'FAM-EPIC-10003',
    relationship: 'SELF',
    address: '2001 Monroe St',
    city: 'Madison',
    state: 'WI',
    zip: '53711',
    phone: '608-555-1003',
    email: 'carol.williams@epicmail.com',
  },
  {
    localData: {
      cardholderId: 'EPIC-DEP-003A',
      dateOfBirth: '19940715',
      genderCode: 1,
      firstName: 'Daniel',
      lastName: 'Williams',
    },
    enrollmentKey: 'YBPTaHEaJhkZ6OlmQKnM9YF0ab8NNK71X_wFXOFd3QE',
    employeeId: 'EMP-10003',
    familyId: 'FAM-EPIC-10003',
    relationship: 'SPOUSE',
    address: '2001 Monroe St',
    city: 'Madison',
    state: 'WI',
    zip: '53711',
    phone: '608-555-1004',
    email: 'daniel.williams@epicmail.com',
  },
  {
    localData: {
      cardholderId: 'EPIC-DEP-003B',
      dateOfBirth: '20150420',
      genderCode: 2,
      firstName: 'Emma',
      lastName: 'Williams',
    },
    enrollmentKey: '6iWfcfRkeTzvMcWWL2ZnDAHaCExfA1adtMSdT9hbt8o',
    employeeId: 'EMP-10003',
    familyId: 'FAM-EPIC-10003',
    relationship: 'CHILD',
    address: '2001 Monroe St',
    city: 'Madison',
    state: 'WI',
    zip: '53711',
    phone: '608-555-1003',
    email: 'carol.williams@epicmail.com',
  },
  {
    localData: {
      cardholderId: 'EXACT-EMP-001',
      dateOfBirth: '19700101',
      genderCode: 1,
      firstName: 'Frank',
      lastName: 'Lee',
    },
    enrollmentKey: 'C_7-Nfw7z_SXsgaIh4eNoMVW3Tlsh_xMIFkfcHy0S5Q',
    employeeId: 'EX-50001',
    familyId: 'FAM-EX-50001',
    relationship: 'SELF',
    address: '5775 Verona Rd',
    city: 'Madison',
    state: 'WI',
    zip: '53711',
    phone: '608-555-1005',
    email: 'frank.lee@exactsciences.com',
  },
  {
    localData: {
      cardholderId: 'EXACT-EMP-002',
      dateOfBirth: '19880930',
      genderCode: 2,
      firstName: 'Grace',
      lastName: 'Nakamura',
    },
    enrollmentKey: 'SpTd-J0WgzvQg2Y-5iGcHPZ5XDOvl3KoFK_0xXpWZNY',
    employeeId: 'EX-50002',
    familyId: 'FAM-EX-50002',
    relationship: 'SELF',
    address: '441 Charmany Dr',
    city: 'Madison',
    state: 'WI',
    zip: '53719',
    phone: '608-555-1006',
    email: 'grace.nakamura@exactsciences.com',
  },
  {
    localData: {
      cardholderId: 'EXACT-EMP-003',
      dateOfBirth: '19950212',
      genderCode: 1,
      firstName: 'Henry',
      lastName: 'Okafor',
    },
    enrollmentKey: 'u1so1epbAeoqZleQMbKYfXNQ9-hzZfbEvrEn78ymyrU',
    employeeId: 'EX-50003',
    familyId: 'FAM-EX-50003',
    relationship: 'SELF',
    address: '1 Science Dr',
    city: 'Madison',
    state: 'WI',
    zip: '53711',
    phone: '608-555-1007',
    email: 'henry.okafor@exactsciences.com',
  },
];

export const MEMBER_BY_CARDHOLDER_ID = new Map<string, SeedMember>(
  MEMBERS.map((m) => [m.localData.cardholderId, m]),
);

export function getMembersByEmployee(employeeId: string): SeedMember[] {
  return MEMBERS.filter((m) => m.employeeId === employeeId);
}

export function getMembersByFamily(familyId: string): SeedMember[] {
  return MEMBERS.filter((m) => m.familyId === familyId);
}

export function getSubscribers(): SeedMember[] {
  return MEMBERS.filter((m) => m.relationship === 'SELF');
}

/** Get Epic Systems employer members */
export function getEpicMembers(): SeedMember[] {
  return MEMBERS.filter((m) => m.localData.cardholderId.startsWith('EPIC'));
}

/** Get Exact Sciences employer members */
export function getExactMembers(): SeedMember[] {
  return MEMBERS.filter((m) => m.localData.cardholderId.startsWith('EXACT'));
}

// Backward-compatible aliases
export const getAcmeMembers = getEpicMembers;
export const getGlobexMembers = getExactMembers;
