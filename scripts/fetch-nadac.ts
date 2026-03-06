#!/usr/bin/env npx tsx
/**
 * fetch-nadac.ts — Fetch 500 real NDCs from the FDA NADAC public dataset.
 *
 * NADAC (National Average Drug Acquisition Cost) is published by CMS
 * and is freely available with no API key required.
 *
 * This script fetches 500 entries, maps them to the DemoMedication interface,
 * and writes `src/demo/nadac-formulary.ts` as a static TypeScript file.
 *
 * Run once:
 *   npx tsx scripts/fetch-nadac.ts
 *
 * The output is committed to the repo so the leviathan doesn't need
 * network access to the NADAC API at runtime.
 */
import fs from 'fs';
import path from 'path';

// ─── NADAC API ───────────────────────────────────────────────

const NADAC_API_URL =
  'https://data.medicaid.gov/api/1/datastore/query/4a00010a-132b-4e4d-a611-543c9521280f/0';

interface NadacRecord {
  ndc: string;
  ndc_description: string;
  nadac_per_unit: string;
  effective_date: string;
  pricing_unit: string;
  pharmacy_type_indicator: string;
  otc: string;
  explanation_code: string;
  classification_for_rate_setting: string; // 'B' = brand, 'G' = generic
  corresponding_generic_drug_nadac_per_unit: string;
  corresponding_generic_drug_effective_date: string;
  as_of_date: string;
}

// ─── Helpers ─────────────────────────────────────────────────

function formatNdc(ndc11: string): string {
  const n = ndc11.replace(/[^0-9]/g, '').padStart(11, '0');
  return `${n.slice(0, 5)}-${n.slice(5, 9)}-${n.slice(9, 11)}`;
}

/** Parse drug name into brand/generic + strength + dosage form */
function parseDrugName(desc: string): {
  brandName: string;
  genericName: string;
  strength: string;
  dosageForm: string;
  route: string;
} {
  // NADAC descriptions look like: "LISINOPRIL 10 MG TABLET"
  // or "ATORVASTATIN CALCIUM 20 MG TABLET"
  const parts = desc.trim().split(/\s+/);

  // Find strength pattern (number + unit): "10 MG", "0.5 MG", "100 MCG"
  let strengthIdx = -1;
  for (let i = 0; i < parts.length; i++) {
    if (/^\d/.test(parts[i]) && i + 1 < parts.length && /^(MG|MCG|ML|MG\/ML|%|UNIT|GM|MEQ)$/i.test(parts[i + 1])) {
      strengthIdx = i;
      break;
    }
  }

  let genericName: string;
  let strength: string;
  let dosageForm: string;

  if (strengthIdx > 0) {
    genericName = parts.slice(0, strengthIdx).join(' ');
    strength = `${parts[strengthIdx]} ${parts[strengthIdx + 1]}`.toLowerCase();
    dosageForm = parts.slice(strengthIdx + 2).join(' ') || 'Tablet';
  } else {
    genericName = parts.slice(0, Math.max(1, parts.length - 1)).join(' ');
    strength = '';
    dosageForm = parts[parts.length - 1] || 'Tablet';
  }

  // Title case
  genericName = genericName
    .split(' ')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
  dosageForm = dosageForm.charAt(0).toUpperCase() + dosageForm.slice(1).toLowerCase();

  // Guess route from dosage form
  let route = 'Oral';
  const dfLower = dosageForm.toLowerCase();
  if (dfLower.includes('inject') || dfLower.includes('syringe') || dfLower.includes('vial')) {
    route = 'Injectable';
  } else if (dfLower.includes('inhal') || dfLower.includes('nebul')) {
    route = 'Inhalation';
  } else if (dfLower.includes('ophthalm') || dfLower.includes('eye')) {
    route = 'Ophthalmic';
  } else if (dfLower.includes('topical') || dfLower.includes('cream') || dfLower.includes('ointment') || dfLower.includes('patch')) {
    route = 'Topical';
  } else if (dfLower.includes('suppository') || dfLower.includes('rectal')) {
    route = 'Rectal';
  }

  return {
    brandName: `${genericName} (Generic)`,
    genericName,
    strength,
    dosageForm,
    route,
  };
}

/** Assign tier based on NADAC classification + price */
function assignTier(
  classification: string,
  nadacPerUnit: number,
): { tier: number; copay: number; priorAuth: boolean; stepTherapy: boolean } {
  if (nadacPerUnit > 100) {
    return { tier: 4, copay: 15000, priorAuth: true, stepTherapy: false };
  }
  if (nadacPerUnit > 10) {
    return { tier: 3, copay: 6000, priorAuth: true, stepTherapy: true };
  }
  if (classification === 'B') {
    return { tier: 2, copay: 3000, priorAuth: false, stepTherapy: false };
  }
  return { tier: 1, copay: 1000, priorAuth: false, stepTherapy: false };
}

/** Generate a synthetic 14-digit GPI from the drug name */
function syntheticGpi(genericName: string, tier: number): string {
  // Use a hash-based approach to produce a deterministic GPI
  let hash = 0;
  for (let i = 0; i < genericName.length; i++) {
    hash = ((hash << 5) - hash + genericName.charCodeAt(i)) | 0;
  }
  const group = ((Math.abs(hash) % 98) + 1).toString().padStart(2, '0');
  const cls = ((Math.abs(hash >> 8) % 98) + 1).toString().padStart(2, '0');
  const sub = ((Math.abs(hash >> 16) % 98) + 1).toString().padStart(2, '0');
  const name = ((Math.abs(hash >> 24) % 98) + 1).toString().padStart(2, '0');
  return `${group}${cls}${sub}${name}${tier.toString().padStart(2, '0')}0110`;
}

// ─── Fetch + Transform ──────────────────────────────────────

async function fetchNadac(): Promise<void> {
  console.log('Fetching 500 NDCs from FDA NADAC...');

  const params = new URLSearchParams({
    limit: '600',   // fetch extra to filter duplicates
    offset: '0',
    sort: 'desc',
    'sort-by': 'effective_date',
  });

  const url = `${NADAC_API_URL}?${params.toString()}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`NADAC API returned ${resp.status}: ${await resp.text()}`);
  }

  const data = await resp.json() as { results: NadacRecord[] };
  const records = data.results;
  console.log(`  Received ${records.length} raw records`);

  // Deduplicate by NDC (keep first = most recent effective_date)
  const seen = new Set<string>();
  const unique: NadacRecord[] = [];
  for (const r of records) {
    const ndc = r.ndc.replace(/[^0-9]/g, '').padStart(11, '0');
    if (!seen.has(ndc)) {
      seen.add(ndc);
      unique.push(r);
    }
    if (unique.length >= 500) break;
  }

  console.log(`  Deduplicated to ${unique.length} unique NDCs`);

  // Transform to DemoMedication entries
  const entries: string[] = [];

  for (let i = 0; i < unique.length; i++) {
    const r = unique[i];
    const ndc = r.ndc.replace(/[^0-9]/g, '').padStart(11, '0');
    const nadacPerUnit = parseFloat(r.nadac_per_unit) || 0;
    const classification = r.classification_for_rate_setting || 'G';
    const parsed = parseDrugName(r.ndc_description || 'Unknown Drug Tablet');
    const tierInfo = assignTier(classification, nadacPerUnit);
    const gpi = syntheticGpi(parsed.genericName, tierInfo.tier);
    const awpUnitCents = Math.round(nadacPerUnit * 100 * 1.2); // AWP ~ 1.2x NADAC
    const packageSize = 30;
    const awpPackageCents = awpUnitCents * packageSize;
    const maxQty = tierInfo.tier >= 3 ? 30 : 90;
    const maxDays = tierInfo.tier >= 3 ? 30 : 90;

    entries.push(`  {
    ndc: '${ndc}',
    ndcFormatted: '${formatNdc(ndc)}',
    gpi: '${gpi}',
    brandName: ${JSON.stringify(parsed.brandName)},
    genericName: ${JSON.stringify(parsed.genericName)},
    strength: ${JSON.stringify(parsed.strength)},
    dosageForm: ${JSON.stringify(parsed.dosageForm)},
    route: ${JSON.stringify(parsed.route)},
    manufacturer: ${JSON.stringify(classification === 'B' ? 'Brand Manufacturer' : 'Generic Manufacturer')},
    therapeuticClass: ${JSON.stringify(parsed.genericName.split(' ')[0] + ' Agent')},
    deaSchedule: 0,
    awpUnitPriceCents: ${awpUnitCents},
    awpPackagePriceCents: ${awpPackageCents},
    packageSize: ${packageSize},
    formularyEntry: {
      ndc: '${ndc}',
      tierLevel: ${tierInfo.tier},
      copayAmount: ${tierInfo.copay},
      requiresPriorAuth: ${tierInfo.priorAuth},
      maxQuantityPerFill: ${maxQty},
      maxDaySupply: ${maxDays},
      stepTherapyRequired: ${tierInfo.stepTherapy},
    },
  }`);
  }

  // Generate the TypeScript file
  const output = `/**
 * NADAC Formulary — 500 Real NDCs from FDA NADAC (National Average Drug Acquisition Cost)
 *
 * AUTO-GENERATED by scripts/fetch-nadac.ts — do not edit manually.
 * Re-generate: npx tsx scripts/fetch-nadac.ts
 *
 * Source: CMS NADAC (data.medicaid.gov) — public domain, no API key required.
 * Generated: ${new Date().toISOString()}
 */
import type { DemoMedication } from './medications.js';

export const NADAC_MEDICATIONS: DemoMedication[] = [
${entries.join(',\n')}
];

/** NDC → DemoMedication lookup */
export const NADAC_MEDICATION_BY_NDC = new Map<string, DemoMedication>(
  NADAC_MEDICATIONS.map((m) => [m.ndc, m]),
);

/** GPI → DemoMedication lookup */
export const NADAC_MEDICATION_BY_GPI = new Map<string, DemoMedication>(
  NADAC_MEDICATIONS.map((m) => [m.gpi, m]),
);
`;

  const outPath = path.resolve(process.cwd(), 'src', 'demo', 'nadac-formulary.ts');
  fs.writeFileSync(outPath, output, 'utf-8');
  console.log(`  Written ${unique.length} entries to ${outPath}`);
  console.log('Done.');
}

fetchNadac().catch((err) => {
  console.error('NADAC fetch failed:', err);
  process.exit(1);
});
