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
 * Seed data — the fixture providers and members, and the NADAC formulary.
 *
 * The people and businesses are fictional:
 *   - prescribers.json, pharmacies.json — invented providers in an invented town (Sorrel Prairie, WI).
 *     Every NPI starts with 2, which NPPES has never issued, and carries a valid check digit. Names,
 *     streets and phone numbers (608-555-01xx, the block reserved for fiction) are made up, and each
 *     NPI and name returned no match from the NPPES registry. There are no DEA numbers or NCPDP IDs,
 *     because a well-formed one cannot be shown to be unassigned.
 *   - MEMBERS — eight test beneficiaries working for two invented employers (FIXTURE_EMPLOYERS).
 *   tests/fixture-identities.test.ts holds these rules.
 *
 * The drug data is public record: NADAC (CMS Medicaid drug pricing), a formulary of 32,768 medications.
 *
 * This module exports the same interfaces and constants as src/seed/index.ts
 * so existing code can swap imports with minimal changes.
 */

import * as fs from 'fs';
import { createHash } from 'crypto';
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
 * Prescriber record — a fictional fixture provider from prescribers.json.
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
 * Pharmacy record — a fictional fixture pharmacy from pharmacies.json.
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

// Raw JSON shapes of prescribers.json and pharmacies.json
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

/** Credentials that carry the title "Dr." on screen: physicians. Nurse practitioners and physician assistants do not. */
const PHYSICIAN_CREDENTIALS = new Set(['MD', 'DO']);

/** How a fixture prescriber is named on screen: "Dr. First Last" for an MD or DO, "First Last" for an NP or PA-C. */
export function prescriberDisplayName(p: Pick<SeedPrescriber, 'firstName' | 'lastName' | 'credential'>): string {
  const name = `${p.firstName} ${p.lastName}`;
  return PHYSICIAN_CREDENTIALS.has(p.credential.replace(/\./g, '').toUpperCase()) ? `Dr. ${name}` : name;
}

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
  deaNumber: '', // fixtures carry no DEA number: a well-formed one cannot be shown to be unassigned
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

// ── Members (fictional beneficiaries — Sorrel Prairie, WI) ──

/**
 * The two invented employers the member fixtures work for; a web search finds no company by either
 * name. A member's employer is the one whose prefix starts its cardholder ID.
 */
export const FIXTURE_EMPLOYERS = [
  { name: 'Fernhill Instruments', cardholderPrefix: 'FERN-', familyPrefix: 'FAM-FERN-' },
  { name: 'Bayside Test Works', cardholderPrefix: 'BAY-', familyPrefix: 'FAM-BAY-' },
] as const;

export const MEMBERS: SeedMember[] = [
  {
    localData: {
      cardholderId: 'FERN-EMP-001',
      dateOfBirth: '19850315',
      genderCode: 2,
      firstName: 'Alice',
      lastName: 'Johnson',
    },
    enrollmentKey: 'JQPHJGskGApMqdkhO54jBMMHkt-X7F9qtzL1-XWcLgg',
    employeeId: 'EMP-10001',
    familyId: 'FAM-FERN-10001',
    relationship: 'SELF',
    address: '316 Fenmoor Avenue',
    city: 'Sorrel Prairie',
    state: 'WI',
    zip: '53519',
    phone: '608-555-0101',
    email: 'alice.johnson@example.test',
  },
  {
    localData: {
      cardholderId: 'FERN-EMP-002',
      dateOfBirth: '19780622',
      genderCode: 1,
      firstName: 'Bob',
      lastName: 'Martinez',
    },
    enrollmentKey: 'Hi-q1tOsEq4wQyZbjFH3RGVpOTFpEx6jHmfVVeavJLM',
    employeeId: 'EMP-10002',
    familyId: 'FAM-FERN-10002',
    relationship: 'SELF',
    address: '1209 Coburn Way, Apt 4',
    city: 'Sorrel Prairie',
    state: 'WI',
    zip: '53519',
    phone: '608-555-0102',
    email: 'bob.martinez@example.test',
  },
  {
    localData: {
      cardholderId: 'FERN-EMP-003',
      dateOfBirth: '19920108',
      genderCode: 2,
      firstName: 'Carol',
      lastName: 'Williams',
    },
    enrollmentKey: 'TIWNbqbc3A0plIcxHaambI39sR2U_Eai3StqyAoX6yk',
    employeeId: 'EMP-10003',
    familyId: 'FAM-FERN-10003',
    relationship: 'SELF',
    address: '2207 Hollis Ridge Drive',
    city: 'Sorrel Prairie',
    state: 'WI',
    zip: '53524',
    phone: '608-555-0103',
    email: 'carol.williams@example.test',
  },
  {
    localData: {
      cardholderId: 'FERN-DEP-003A',
      dateOfBirth: '19940715',
      genderCode: 1,
      firstName: 'Daniel',
      lastName: 'Williams',
    },
    enrollmentKey: 'YBPTaHEaJhkZ6OlmQKnM9YF0ab8NNK71X_wFXOFd3QE',
    employeeId: 'EMP-10003',
    familyId: 'FAM-FERN-10003',
    relationship: 'SPOUSE',
    address: '2207 Hollis Ridge Drive',
    city: 'Sorrel Prairie',
    state: 'WI',
    zip: '53524',
    phone: '608-555-0104',
    email: 'daniel.williams@example.test',
  },
  {
    localData: {
      cardholderId: 'FERN-DEP-003B',
      dateOfBirth: '20150420',
      genderCode: 2,
      firstName: 'Emma',
      lastName: 'Williams',
    },
    enrollmentKey: '6iWfcfRkeTzvMcWWL2ZnDAHaCExfA1adtMSdT9hbt8o',
    employeeId: 'EMP-10003',
    familyId: 'FAM-FERN-10003',
    relationship: 'CHILD',
    address: '2207 Hollis Ridge Drive',
    city: 'Sorrel Prairie',
    state: 'WI',
    zip: '53524',
    phone: '608-555-0103',
    email: 'carol.williams@example.test',
  },
  {
    localData: {
      cardholderId: 'BAY-EMP-001',
      dateOfBirth: '19700101',
      genderCode: 1,
      firstName: 'Frank',
      lastName: 'Lee',
    },
    enrollmentKey: 'C_7-Nfw7z_SXsgaIh4eNoMVW3Tlsh_xMIFkfcHy0S5Q',
    employeeId: 'BAY-50001',
    familyId: 'FAM-BAY-50001',
    relationship: 'SELF',
    address: '58 Stanwick Lane',
    city: 'Sorrel Prairie',
    state: 'WI',
    zip: '53524',
    phone: '608-555-0105',
    email: 'frank.lee@example.test',
  },
  {
    localData: {
      cardholderId: 'BAY-EMP-002',
      dateOfBirth: '19880930',
      genderCode: 2,
      firstName: 'Grace',
      lastName: 'Nakamura',
    },
    enrollmentKey: 'SpTd-J0WgzvQg2Y-5iGcHPZ5XDOvl3KoFK_0xXpWZNY',
    employeeId: 'BAY-50002',
    familyId: 'FAM-BAY-50002',
    relationship: 'SELF',
    address: '4410 Kestrel Run',
    city: 'Sorrel Prairie',
    state: 'WI',
    zip: '53519',
    phone: '608-555-0106',
    email: 'grace.nakamura@example.test',
  },
  {
    localData: {
      cardholderId: 'BAY-EMP-003',
      dateOfBirth: '19950212',
      genderCode: 1,
      firstName: 'Henry',
      lastName: 'Okafor',
    },
    enrollmentKey: 'u1so1epbAeoqZleQMbKYfXNQ9-hzZfbEvrEn78ymyrU',
    employeeId: 'BAY-50003',
    familyId: 'FAM-BAY-50003',
    relationship: 'SELF',
    address: '903 Dunmore Court',
    city: 'Sorrel Prairie',
    state: 'WI',
    zip: '53524',
    phone: '608-555-0107',
    email: 'henry.okafor@example.test',
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

/** Members who work for Fernhill Instruments (cardholder IDs FERN-*) */
export function getFernhillMembers(): SeedMember[] {
  return MEMBERS.filter((m) => m.localData.cardholderId.startsWith('FERN-'));
}

/** Members who work for Bayside Test Works (cardholder IDs BAY-*) */
export function getBaysideMembers(): SeedMember[] {
  return MEMBERS.filter((m) => m.localData.cardholderId.startsWith('BAY-'));
}

// Backward-compatible aliases (src/index.ts re-exports these names)
export const getAcmeMembers = getFernhillMembers;
export const getGlobexMembers = getBaysideMembers;

/**
 * A fixture person's identity salt — plan item C1. Real members generate theirs on the device; the
 * fixture people are fictional and the console and the suites need them reproducible, so theirs is
 * a function of the fixture itself. F1 isolates the fixtures from the production entry point.
 */
export function fixtureIdentitySalt(seed: { localData: { cardholderId: string } }): string {
  return createHash('sha256').update('zpk.care/fixture-identity-salt/v1\n' + seed.localData.cardholderId, 'utf8').digest('hex');
}
