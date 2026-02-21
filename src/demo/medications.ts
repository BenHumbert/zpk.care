/**
 * Demo Medication Data — NDC/GPI (Medispan-style)
 *
 * Fictional medication entries with realistic NDC codes and GPI classifications.
 * All NDC codes here are FICTIONAL — not real FDA-registered products.
 *
 * NDC format: 11-digit (5-4-2): Labeler-Product-Package
 *   - Labeler code: 5 digits (FDA-assigned manufacturer)
 *   - Product code: 4 digits (drug, strength, dosage form)
 *   - Package code: 2 digits (package size/type)
 *
 * GPI format: 14-digit (Medispan Generic Product Identifier)
 *   - Digits 1-2: Drug Group
 *   - Digits 3-4: Drug Class
 *   - Digits 5-6: Drug Sub-Class
 *   - Digits 7-8: Drug Name
 *   - Digits 9-10: Drug Name Extension
 *   - Digits 11-12: Dosage Form
 *   - Digits 13-14: Strength
 *
 * Tier assignments:
 *   Tier 1 (Generic): $10 copay
 *   Tier 2 (Preferred Brand): $30 copay
 *   Tier 3 (Non-Preferred Brand): $60 copay
 *   Tier 4 (Specialty): $150 copay, requires prior auth
 *
 * AWP (Average Wholesale Price) is the standard pharmacy pricing benchmark.
 * All prices are in cents.
 */
import type { FormularyEntryLocalData } from '../access-control/formulary-entry.js';
import type { MedicationLocalData, MedicationPricingLocalData } from '../models/medication.js';

/**
 * Extended medication record with Medispan-style display fields.
 * The ZK system uses FormularyEntryLocalData for formulary + MedicationLocalData for claims.
 */
export interface DemoMedication {
  /** NDC code (11-digit, no dashes) */
  ndc: string;
  /** Display: NDC formatted (5-4-2) */
  ndcFormatted: string;
  /** GPI code (14-digit Medispan Generic Product Identifier) */
  gpi: string;
  /** Display: drug brand name */
  brandName: string;
  /** Display: generic name */
  genericName: string;
  /** Display: strength (e.g., "10mg", "500mg") */
  strength: string;
  /** Display: dosage form (e.g., "Tablet", "Capsule", "Solution") */
  dosageForm: string;
  /** Display: route of administration */
  route: string;
  /** Display: manufacturer */
  manufacturer: string;
  /** Display: therapeutic class */
  therapeuticClass: string;
  /** Display: DEA schedule (0=non-controlled, 2-5=schedule) */
  deaSchedule: number;
  /** AWP unit price in cents (per tablet/mL/unit) */
  awpUnitPriceCents: number;
  /** AWP package price in cents */
  awpPackagePriceCents: number;
  /** Standard package size (tablets, mL, etc.) */
  packageSize: number;
  /** Formulary entry for this medication */
  formularyEntry: FormularyEntryLocalData;
  /** Whether this medication starts on the formulary (default true) */
  initiallyOnFormulary?: boolean;
}

// ─────────────────────────────────────────────────────────────
// TIER 1 — GENERIC MEDICATIONS ($10 copay)
// ─────────────────────────────────────────────────────────────

const TIER1_GENERICS: DemoMedication[] = [
  {
    ndc: '00071015523',
    ndcFormatted: '00071-0155-23',
    gpi: '27100010000110',
    brandName: 'Lisinopril (Generic)',
    genericName: 'Lisinopril',
    strength: '10mg',
    dosageForm: 'Tablet',
    route: 'Oral',
    manufacturer: 'Lupin Pharmaceuticals',
    therapeuticClass: 'ACE Inhibitor',
    deaSchedule: 0,
    awpUnitPriceCents: 15,
    awpPackagePriceCents: 450,
    packageSize: 30,
    formularyEntry: {
      ndc: '00071015523',
      tierLevel: 1,
      copayAmount: 1000,
      requiresPriorAuth: false,
      maxQuantityPerFill: 90,
      maxDaySupply: 90,
      stepTherapyRequired: false,
    },
  },
  {
    ndc: '00093505601',
    ndcFormatted: '00093-5056-01',
    gpi: '39400010100310',
    brandName: 'Metformin HCl (Generic)',
    genericName: 'Metformin Hydrochloride',
    strength: '500mg',
    dosageForm: 'Tablet',
    route: 'Oral',
    manufacturer: 'Teva Pharmaceuticals',
    therapeuticClass: 'Biguanide Antidiabetic',
    deaSchedule: 0,
    awpUnitPriceCents: 8,
    awpPackagePriceCents: 480,
    packageSize: 60,
    formularyEntry: {
      ndc: '00093505601',
      tierLevel: 1,
      copayAmount: 1000,
      requiresPriorAuth: false,
      maxQuantityPerFill: 180,
      maxDaySupply: 90,
      stepTherapyRequired: false,
    },
  },
  {
    ndc: '00781107201',
    ndcFormatted: '00781-1072-01',
    gpi: '33100020100110',
    brandName: 'Atorvastatin (Generic)',
    genericName: 'Atorvastatin Calcium',
    strength: '20mg',
    dosageForm: 'Tablet',
    route: 'Oral',
    manufacturer: 'Sandoz Inc',
    therapeuticClass: 'HMG-CoA Reductase Inhibitor (Statin)',
    deaSchedule: 0,
    awpUnitPriceCents: 25,
    awpPackagePriceCents: 750,
    packageSize: 30,
    formularyEntry: {
      ndc: '00781107201',
      tierLevel: 1,
      copayAmount: 1000,
      requiresPriorAuth: false,
      maxQuantityPerFill: 90,
      maxDaySupply: 90,
      stepTherapyRequired: false,
    },
  },
  {
    ndc: '00591024001',
    ndcFormatted: '00591-0240-01',
    gpi: '36100010100310',
    brandName: 'Levothyroxine (Generic)',
    genericName: 'Levothyroxine Sodium',
    strength: '50mcg',
    dosageForm: 'Tablet',
    route: 'Oral',
    manufacturer: 'Watson Laboratories',
    therapeuticClass: 'Thyroid Hormone',
    deaSchedule: 0,
    awpUnitPriceCents: 20,
    awpPackagePriceCents: 600,
    packageSize: 30,
    formularyEntry: {
      ndc: '00591024001',
      tierLevel: 1,
      copayAmount: 1000,
      requiresPriorAuth: false,
      maxQuantityPerFill: 90,
      maxDaySupply: 90,
      stepTherapyRequired: false,
    },
  },
  {
    ndc: '00185001001',
    ndcFormatted: '00185-0010-01',
    gpi: '66100010100110',
    brandName: 'Amoxicillin (Generic)',
    genericName: 'Amoxicillin',
    strength: '500mg',
    dosageForm: 'Capsule',
    route: 'Oral',
    manufacturer: 'Eon Labs',
    therapeuticClass: 'Aminopenicillin Antibiotic',
    deaSchedule: 0,
    awpUnitPriceCents: 12,
    awpPackagePriceCents: 360,
    packageSize: 30,
    formularyEntry: {
      ndc: '00185001001',
      tierLevel: 1,
      copayAmount: 1000,
      requiresPriorAuth: false,
      maxQuantityPerFill: 30,
      maxDaySupply: 14,
      stepTherapyRequired: false,
    },
  },
  {
    ndc: '00378180001',
    ndcFormatted: '00378-1800-01',
    gpi: '49200010000110',
    brandName: 'Omeprazole (Generic)',
    genericName: 'Omeprazole',
    strength: '20mg',
    dosageForm: 'Delayed-Release Capsule',
    route: 'Oral',
    manufacturer: 'Mylan Pharmaceuticals',
    therapeuticClass: 'Proton Pump Inhibitor',
    deaSchedule: 0,
    awpUnitPriceCents: 18,
    awpPackagePriceCents: 540,
    packageSize: 30,
    formularyEntry: {
      ndc: '00378180001',
      tierLevel: 1,
      copayAmount: 1000,
      requiresPriorAuth: false,
      maxQuantityPerFill: 90,
      maxDaySupply: 90,
      stepTherapyRequired: false,
    },
  },
  {
    ndc: '00143973501',
    ndcFormatted: '00143-9735-01',
    gpi: '65100030100110',
    brandName: 'Albuterol Sulfate (Generic)',
    genericName: 'Albuterol Sulfate',
    strength: '90mcg/actuation',
    dosageForm: 'Metered Dose Inhaler',
    route: 'Inhalation',
    manufacturer: 'West-Ward Pharmaceuticals',
    therapeuticClass: 'Short-Acting Beta-2 Agonist (SABA)',
    deaSchedule: 0,
    awpUnitPriceCents: 3500,
    awpPackagePriceCents: 3500,
    packageSize: 1,
    formularyEntry: {
      ndc: '00143973501',
      tierLevel: 1,
      copayAmount: 1000,
      requiresPriorAuth: false,
      maxQuantityPerFill: 3,
      maxDaySupply: 90,
      stepTherapyRequired: false,
    },
  },
];

// ─────────────────────────────────────────────────────────────
// TIER 2 — PREFERRED BRAND ($30 copay)
// ─────────────────────────────────────────────────────────────

const TIER2_PREFERRED: DemoMedication[] = [
  {
    ndc: '00002323030',
    ndcFormatted: '00002-3230-30',
    gpi: '27250060000120',
    brandName: 'Jardiance',
    genericName: 'Empagliflozin',
    strength: '10mg',
    dosageForm: 'Tablet',
    route: 'Oral',
    manufacturer: 'Boehringer Ingelheim',
    therapeuticClass: 'SGLT2 Inhibitor',
    deaSchedule: 0,
    awpUnitPriceCents: 1800,
    awpPackagePriceCents: 54000,
    packageSize: 30,
    formularyEntry: {
      ndc: '00002323030',
      tierLevel: 2,
      copayAmount: 3000,
      requiresPriorAuth: false,
      maxQuantityPerFill: 90,
      maxDaySupply: 90,
      stepTherapyRequired: false,
    },
  },
  {
    ndc: '00069015430',
    ndcFormatted: '00069-0154-30',
    gpi: '37200020200220',
    brandName: 'Eliquis',
    genericName: 'Apixaban',
    strength: '5mg',
    dosageForm: 'Tablet',
    route: 'Oral',
    manufacturer: 'Bristol-Myers Squibb',
    therapeuticClass: 'Factor Xa Inhibitor Anticoagulant',
    deaSchedule: 0,
    awpUnitPriceCents: 900,
    awpPackagePriceCents: 54000,
    packageSize: 60,
    formularyEntry: {
      ndc: '00069015430',
      tierLevel: 2,
      copayAmount: 3000,
      requiresPriorAuth: false,
      maxQuantityPerFill: 60,
      maxDaySupply: 30,
      stepTherapyRequired: false,
    },
  },
  {
    ndc: '00024563830',
    ndcFormatted: '00024-5638-30',
    gpi: '65200040102520',
    brandName: 'Symbicort',
    genericName: 'Budesonide/Formoterol',
    strength: '160/4.5mcg',
    dosageForm: 'Metered Dose Inhaler',
    route: 'Inhalation',
    manufacturer: 'AstraZeneca',
    therapeuticClass: 'ICS/LABA Combination',
    deaSchedule: 0,
    awpUnitPriceCents: 32000,
    awpPackagePriceCents: 32000,
    packageSize: 1,
    formularyEntry: {
      ndc: '00024563830',
      tierLevel: 2,
      copayAmount: 3000,
      requiresPriorAuth: false,
      maxQuantityPerFill: 3,
      maxDaySupply: 90,
      stepTherapyRequired: false,
    },
  },
  {
    ndc: '00006027731',
    ndcFormatted: '00006-0277-31',
    gpi: '27410060000110',
    brandName: 'Januvia',
    genericName: 'Sitagliptin',
    strength: '100mg',
    dosageForm: 'Tablet',
    route: 'Oral',
    manufacturer: 'Merck & Co',
    therapeuticClass: 'DPP-4 Inhibitor',
    deaSchedule: 0,
    awpUnitPriceCents: 1600,
    awpPackagePriceCents: 48000,
    packageSize: 30,
    formularyEntry: {
      ndc: '00006027731',
      tierLevel: 2,
      copayAmount: 3000,
      requiresPriorAuth: false,
      maxQuantityPerFill: 90,
      maxDaySupply: 90,
      stepTherapyRequired: true,
    },
  },
  {
    ndc: '50090286001',
    ndcFormatted: '50090-2860-01',
    gpi: '58200025100110',
    brandName: 'Entresto',
    genericName: 'Sacubitril/Valsartan',
    strength: '49/51mg',
    dosageForm: 'Tablet',
    route: 'Oral',
    manufacturer: 'Novartis',
    therapeuticClass: 'ARNI (Heart Failure)',
    deaSchedule: 0,
    awpUnitPriceCents: 1900,
    awpPackagePriceCents: 114000,
    packageSize: 60,
    formularyEntry: {
      ndc: '50090286001',
      tierLevel: 2,
      copayAmount: 3000,
      requiresPriorAuth: false,
      maxQuantityPerFill: 60,
      maxDaySupply: 30,
      stepTherapyRequired: false,
    },
  },
];

// ─────────────────────────────────────────────────────────────
// TIER 3 — NON-PREFERRED BRAND ($60 copay)
// ─────────────────────────────────────────────────────────────

const TIER3_NON_PREFERRED: DemoMedication[] = [
  {
    ndc: '00074390460',
    ndcFormatted: '00074-3904-60',
    gpi: '21100060001550',
    brandName: 'Rinvoq',
    genericName: 'Upadacitinib',
    strength: '15mg',
    dosageForm: 'Extended-Release Tablet',
    route: 'Oral',
    manufacturer: 'AbbVie',
    therapeuticClass: 'JAK Inhibitor',
    deaSchedule: 0,
    awpUnitPriceCents: 22000,
    awpPackagePriceCents: 660000,
    packageSize: 30,
    formularyEntry: {
      ndc: '00074390460',
      tierLevel: 3,
      copayAmount: 6000,
      requiresPriorAuth: true,
      maxQuantityPerFill: 30,
      maxDaySupply: 30,
      stepTherapyRequired: true,
    },
  },
  {
    ndc: '00078063915',
    ndcFormatted: '00078-0639-15',
    gpi: '65400025300830',
    brandName: 'Xolair',
    genericName: 'Omalizumab',
    strength: '150mg/mL',
    dosageForm: 'Prefilled Syringe',
    route: 'Subcutaneous',
    manufacturer: 'Genentech/Novartis',
    therapeuticClass: 'Anti-IgE Monoclonal Antibody',
    deaSchedule: 0,
    awpUnitPriceCents: 135000,
    awpPackagePriceCents: 135000,
    packageSize: 1,
    formularyEntry: {
      ndc: '00078063915',
      tierLevel: 3,
      copayAmount: 6000,
      requiresPriorAuth: true,
      maxQuantityPerFill: 4,
      maxDaySupply: 30,
      stepTherapyRequired: true,
    },
  },
  {
    ndc: '63459030310',
    ndcFormatted: '63459-0303-10',
    gpi: '57200010100330',
    brandName: 'Vyvanse',
    genericName: 'Lisdexamfetamine',
    strength: '30mg',
    dosageForm: 'Capsule',
    route: 'Oral',
    manufacturer: 'Takeda',
    therapeuticClass: 'CNS Stimulant',
    deaSchedule: 2,
    awpUnitPriceCents: 1300,
    awpPackagePriceCents: 39000,
    packageSize: 30,
    formularyEntry: {
      ndc: '63459030310',
      tierLevel: 3,
      copayAmount: 6000,
      requiresPriorAuth: false,
      maxQuantityPerFill: 30,
      maxDaySupply: 30,
      stepTherapyRequired: false,
    },
  },
  {
    ndc: '00002143380',
    ndcFormatted: '00002-1433-80',
    gpi: '59200045001540',
    brandName: 'Trulicity',
    genericName: 'Dulaglutide',
    strength: '1.5mg/0.5mL',
    dosageForm: 'Prefilled Pen',
    route: 'Subcutaneous',
    manufacturer: 'Eli Lilly',
    therapeuticClass: 'GLP-1 Receptor Agonist',
    deaSchedule: 0,
    awpUnitPriceCents: 95000,
    awpPackagePriceCents: 380000,
    packageSize: 4,
    formularyEntry: {
      ndc: '00002143380',
      tierLevel: 3,
      copayAmount: 6000,
      requiresPriorAuth: true,
      maxQuantityPerFill: 4,
      maxDaySupply: 30,
      stepTherapyRequired: true,
    },
  },
  {
    ndc: '00173088200',
    ndcFormatted: '00173-0882-00',
    gpi: '44200003600110',
    brandName: 'Breo Ellipta',
    genericName: 'Fluticasone Furoate/Vilanterol',
    strength: '100/25mcg',
    dosageForm: 'Dry Powder Inhaler',
    route: 'Inhalation',
    manufacturer: 'GlaxoSmithKline',
    therapeuticClass: 'ICS/LABA Combination',
    deaSchedule: 0,
    awpUnitPriceCents: 38000,
    awpPackagePriceCents: 38000,
    packageSize: 1,
    formularyEntry: {
      ndc: '00173088200',
      tierLevel: 3,
      copayAmount: 6000,
      requiresPriorAuth: false,
      maxQuantityPerFill: 3,
      maxDaySupply: 90,
      stepTherapyRequired: true,
    },
  },
];

// ─────────────────────────────────────────────────────────────
// TIER 4 — SPECIALTY ($150 copay, all require PA)
// ─────────────────────────────────────────────────────────────

const TIER4_SPECIALTY: DemoMedication[] = [
  {
    ndc: '00074055102',
    ndcFormatted: '00074-0551-02',
    gpi: '21200025200440',
    brandName: 'Humira',
    genericName: 'Adalimumab',
    strength: '40mg/0.4mL',
    dosageForm: 'Prefilled Syringe',
    route: 'Subcutaneous',
    manufacturer: 'AbbVie',
    therapeuticClass: 'TNF-alpha Inhibitor',
    deaSchedule: 0,
    awpUnitPriceCents: 680000,
    awpPackagePriceCents: 1360000,
    packageSize: 2,
    formularyEntry: {
      ndc: '00074055102',
      tierLevel: 4,
      copayAmount: 15000,
      requiresPriorAuth: true,
      maxQuantityPerFill: 2,
      maxDaySupply: 30,
      stepTherapyRequired: false,
    },
  },
  {
    ndc: '59353002701',
    ndcFormatted: '59353-0027-01',
    gpi: '21200063001640',
    brandName: 'Keytruda',
    genericName: 'Pembrolizumab',
    strength: '100mg/4mL',
    dosageForm: 'Vial',
    route: 'Intravenous',
    manufacturer: 'Merck & Co',
    therapeuticClass: 'PD-1 Inhibitor (Immunotherapy)',
    deaSchedule: 0,
    awpUnitPriceCents: 980000,
    awpPackagePriceCents: 980000,
    packageSize: 1,
    formularyEntry: {
      ndc: '59353002701',
      tierLevel: 4,
      copayAmount: 15000,
      requiresPriorAuth: true,
      maxQuantityPerFill: 1,
      maxDaySupply: 21,
      stepTherapyRequired: false,
    },
  },
  {
    ndc: '57894015001',
    ndcFormatted: '57894-0150-01',
    gpi: '22000070002040',
    brandName: 'Revlimid',
    genericName: 'Lenalidomide',
    strength: '25mg',
    dosageForm: 'Capsule',
    route: 'Oral',
    manufacturer: 'Celgene/BMS',
    therapeuticClass: 'Immunomodulatory Agent (Oncology)',
    deaSchedule: 0,
    awpUnitPriceCents: 75000,
    awpPackagePriceCents: 1575000,
    packageSize: 21,
    formularyEntry: {
      ndc: '57894015001',
      tierLevel: 4,
      copayAmount: 15000,
      requiresPriorAuth: true,
      maxQuantityPerFill: 21,
      maxDaySupply: 28,
      stepTherapyRequired: false,
    },
  },
  {
    ndc: '00169415012',
    ndcFormatted: '00169-4150-12',
    gpi: '27700010102220',
    brandName: 'Ozempic',
    genericName: 'Semaglutide',
    strength: '1mg/dose',
    dosageForm: 'Prefilled Pen',
    route: 'Subcutaneous',
    manufacturer: 'Novo Nordisk',
    therapeuticClass: 'GLP-1 Receptor Agonist',
    deaSchedule: 0,
    awpUnitPriceCents: 95000,
    awpPackagePriceCents: 95000,
    packageSize: 1,
    formularyEntry: {
      ndc: '00169415012',
      tierLevel: 4,
      copayAmount: 15000,
      requiresPriorAuth: true,
      maxQuantityPerFill: 3,
      maxDaySupply: 90,
      stepTherapyRequired: true,
    },
  },
  {
    ndc: '61755000501',
    ndcFormatted: '61755-0005-01',
    gpi: '30100060002240',
    brandName: 'Stelara',
    genericName: 'Ustekinumab',
    strength: '45mg/0.5mL',
    dosageForm: 'Prefilled Syringe',
    route: 'Subcutaneous',
    manufacturer: 'Janssen Biotech',
    therapeuticClass: 'IL-12/23 Inhibitor',
    deaSchedule: 0,
    awpUnitPriceCents: 2400000,
    awpPackagePriceCents: 2400000,
    packageSize: 1,
    formularyEntry: {
      ndc: '61755000501',
      tierLevel: 4,
      copayAmount: 15000,
      requiresPriorAuth: true,
      maxQuantityPerFill: 1,
      maxDaySupply: 90,
      stepTherapyRequired: false,
    },
  },
];

// ─────────────────────────────────────────────────────────────
// OFF-FORMULARY — Not initially covered (insurer can add)
// ─────────────────────────────────────────────────────────────

const OFF_FORMULARY: DemoMedication[] = [
  {
    ndc: '00169468412',
    ndcFormatted: '00169-4684-12',
    gpi: '27700010302220',
    brandName: 'Wegovy',
    genericName: 'Semaglutide (Weight Management)',
    strength: '2.4mg/dose',
    dosageForm: 'Prefilled Pen',
    route: 'Subcutaneous',
    manufacturer: 'Novo Nordisk',
    therapeuticClass: 'GLP-1 Receptor Agonist (Weight)',
    deaSchedule: 0,
    awpUnitPriceCents: 170000,
    awpPackagePriceCents: 170000,
    packageSize: 1,
    initiallyOnFormulary: false,
    formularyEntry: {
      ndc: '00169468412',
      tierLevel: 4,
      copayAmount: 20000,
      requiresPriorAuth: true,
      maxQuantityPerFill: 3,
      maxDaySupply: 90,
      stepTherapyRequired: true,
    },
  },
  {
    ndc: '00069025001',
    ndcFormatted: '00069-0250-01',
    gpi: '12300040100120',
    brandName: 'Paxlovid',
    genericName: 'Nirmatrelvir/Ritonavir',
    strength: '150mg/100mg',
    dosageForm: 'Tablet Pack',
    route: 'Oral',
    manufacturer: 'Pfizer',
    therapeuticClass: 'COVID-19 Antiviral (Protease Inhibitor)',
    deaSchedule: 0,
    awpUnitPriceCents: 26500,
    awpPackagePriceCents: 132500,
    packageSize: 5,
    initiallyOnFormulary: false,
    formularyEntry: {
      ndc: '00069025001',
      tierLevel: 3,
      copayAmount: 6000,
      requiresPriorAuth: false,
      maxQuantityPerFill: 5,
      maxDaySupply: 5,
      stepTherapyRequired: false,
    },
  },
  {
    ndc: '00074116802',
    ndcFormatted: '00074-1168-02',
    gpi: '21100080002440',
    brandName: 'Skyrizi',
    genericName: 'Risankizumab-rzaa',
    strength: '150mg/mL',
    dosageForm: 'Prefilled Syringe',
    route: 'Subcutaneous',
    manufacturer: 'AbbVie',
    therapeuticClass: 'IL-23 Inhibitor (Psoriasis)',
    deaSchedule: 0,
    awpUnitPriceCents: 2800000,
    awpPackagePriceCents: 2800000,
    packageSize: 1,
    initiallyOnFormulary: false,
    formularyEntry: {
      ndc: '00074116802',
      tierLevel: 4,
      copayAmount: 25000,
      requiresPriorAuth: true,
      maxQuantityPerFill: 1,
      maxDaySupply: 90,
      stepTherapyRequired: true,
    },
  },
  {
    ndc: '00002140580',
    ndcFormatted: '00002-1405-80',
    gpi: '27700030100220',
    brandName: 'Mounjaro',
    genericName: 'Tirzepatide',
    strength: '5mg/0.5mL',
    dosageForm: 'Prefilled Pen',
    route: 'Subcutaneous',
    manufacturer: 'Eli Lilly',
    therapeuticClass: 'GIP/GLP-1 Receptor Agonist',
    deaSchedule: 0,
    awpUnitPriceCents: 105000,
    awpPackagePriceCents: 420000,
    packageSize: 4,
    initiallyOnFormulary: false,
    formularyEntry: {
      ndc: '00002140580',
      tierLevel: 4,
      copayAmount: 17500,
      requiresPriorAuth: true,
      maxQuantityPerFill: 4,
      maxDaySupply: 30,
      stepTherapyRequired: true,
    },
  },
  {
    ndc: '00589060701',
    ndcFormatted: '00589-0607-01',
    gpi: '65300015200840',
    brandName: 'Adbry',
    genericName: 'Tralokinumab-ldrm',
    strength: '150mg/mL',
    dosageForm: 'Prefilled Syringe',
    route: 'Subcutaneous',
    manufacturer: 'LEO Pharma',
    therapeuticClass: 'IL-13 Inhibitor (Eczema/Dermatitis)',
    deaSchedule: 0,
    awpUnitPriceCents: 340000,
    awpPackagePriceCents: 680000,
    packageSize: 2,
    initiallyOnFormulary: false,
    formularyEntry: {
      ndc: '00589060701',
      tierLevel: 3,
      copayAmount: 8000,
      requiresPriorAuth: true,
      maxQuantityPerFill: 2,
      maxDaySupply: 30,
      stepTherapyRequired: true,
    },
  },
];

// ─────────────────────────────────────────────────────────────
// COMBINED EXPORTS
// ─────────────────────────────────────────────────────────────

/** All demo medications, all tiers (including off-formulary) */
export const DEMO_MEDICATIONS: DemoMedication[] = [
  ...TIER1_GENERICS,
  ...TIER2_PREFERRED,
  ...TIER3_NON_PREFERRED,
  ...TIER4_SPECIALTY,
  ...OFF_FORMULARY,
];

/** Tier arrays + off-formulary */
export { TIER1_GENERICS, TIER2_PREFERRED, TIER3_NON_PREFERRED, TIER4_SPECIALTY, OFF_FORMULARY };

/** Quick lookup: NDC → DemoMedication */
export const MEDICATION_BY_NDC = new Map<string, DemoMedication>(
  DEMO_MEDICATIONS.map((m) => [m.ndc, m]),
);

/** Quick lookup: GPI (14-digit) → DemoMedication */
export const MEDICATION_BY_GPI = new Map<string, DemoMedication>(
  DEMO_MEDICATIONS.map((m) => [m.gpi, m]),
);

/**
 * Extract all FormularyEntryLocalData for use with PlanTemplate.
 * This is the full formulary — all tiers — suitable for creating a plan.
 */
export function getAllFormularyEntries(): FormularyEntryLocalData[] {
  return DEMO_MEDICATIONS.map((m) => m.formularyEntry);
}

/**
 * Extract FormularyEntryLocalData by tier.
 */
export function getFormularyEntriesByTier(tier: number): FormularyEntryLocalData[] {
  return DEMO_MEDICATIONS
    .filter((m) => m.formularyEntry.tierLevel === tier)
    .map((m) => m.formularyEntry);
}

/**
 * Build MedicationLocalData from a DemoMedication (for use in claims).
 *
 * @param med — the demo medication
 * @param rxRefNumber — the prescription reference number
 * @param quantity — quantity dispensed
 * @param fillNumber — fill number (0=original, 1+=refill)
 * @param daysSupply — days supply
 */
export function buildMedicationLocalData(
  med: DemoMedication,
  rxRefNumber: string,
  quantity: number,
  fillNumber: number,
  daysSupply: number,
): MedicationLocalData {
  return {
    rxServiceRefNumQualifier: 1,
    rxServiceRefNumber: rxRefNumber,
    productServiceIdQualifier: 3,  // 03 = NDC
    productServiceId: med.ndc,
    quantityDispensed: quantity,
    fillNumber,
    daysSupply,
    compoundCode: 0,
    dawProductSelectionCode: 0,
  };
}

/**
 * Build MedicationPricingLocalData from a DemoMedication (for use in claims).
 *
 * @param med — the demo medication
 * @param quantity — quantity dispensed
 * @param dispensingFeeCents — pharmacy dispensing fee in cents
 */
export function buildMedicationPricingLocalData(
  med: DemoMedication,
  quantity: number,
  dispensingFeeCents: number = 200,
): MedicationPricingLocalData {
  const ingredientCost = med.awpUnitPriceCents * quantity;
  return {
    usualAndCustomaryCharge: ingredientCost + dispensingFeeCents,
    quantityPrescribed: quantity,
    ingredientCostSubmitted: ingredientCost,
    dispensingFeeSubmitted: dispensingFeeCents,
    basisOfCostDetermination: 1,  // 01 = AWP
  };
}
