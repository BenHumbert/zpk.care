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
 * NADAC Data Import — Real Drug Pricing from CMS
 *
 * Downloads the NADAC (National Average Drug Acquisition Cost) dataset from CMS
 * and converts it into FormularyEntryLocalData records.
 *
 * Data source: https://data.medicaid.gov/dataset/fbb83258-11c7-47f5-8b18-5f8e79f7e704
 * All data is PUBLIC RECORD from CMS — no licensing concerns.
 *
 * Tier assignment based on NADAC Classification + acquisition cost:
 *   G (Generic)                          → Tier 1, copay $10
 *   B (Brand) + NADAC < $50/unit         → Tier 2, copay $35
 *   B (Brand) + NADAC $50-$500/unit      → Tier 3, copay $75
 *   B (Brand) + NADAC > $500/unit        → Tier 4, copay $150, prior auth required
 *
 * Usage: npx tsx src/data/import-nadac.ts
 */

import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Configuration ────────────────────────────────────────

const NADAC_URL = 'https://download.medicaid.gov/data/nadac-national-average-drug-acquisition-cost-03-11-2026.csv';
const MAX_FORMULARY_SIZE = 32_768; // MerkleTree(16) capacity

// Tier thresholds (NADAC per unit in dollars)
const BRAND_TIER2_MAX = 50;    // < $50/unit → Tier 2
const BRAND_TIER3_MAX = 500;   // $50-$500/unit → Tier 3
                                // > $500/unit → Tier 4

// Copay schedule (cents)
const COPAY_TIER1 = 1000;   // $10
const COPAY_TIER2 = 3500;   // $35
const COPAY_TIER3 = 7500;   // $75
const COPAY_TIER4 = 15000;  // $150

// ── Types ────────────────────────────────────────────────

interface NadacRow {
  description: string;
  ndc: string;
  nadacPerUnit: number;
  effectiveDate: string;
  pricingUnit: string;
  pharmacyTypeIndicator: string;
  otc: string;
  explanationCode: string;
  classification: string; // G=Generic, B=Brand
}

interface FormularyRecord {
  ndc: string;
  ndcFormatted: string;
  description: string;
  classification: string;
  nadacPerUnit: number;
  pricingUnit: string;
  otc: boolean;
  effectiveDate: string;
  // Formulary fields
  tierLevel: number;
  copayAmount: number;
  requiresPriorAuth: boolean;
  maxQuantityPerFill: number;
  maxDaySupply: number;
  stepTherapyRequired: boolean;
}

// ── Download & Parse ─────────────────────────────────────

function downloadCsv(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    console.log(`  Downloading from ${url.slice(0, 80)}...`);
    const makeRequest = (reqUrl: string) => {
      https.get(reqUrl, (res) => {
        // Follow redirects
        if (res.statusCode === 301 || res.statusCode === 302) {
          const location = res.headers.location;
          if (location) return makeRequest(location);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        let data = '';
        let received = 0;
        res.on('data', (chunk) => {
          data += chunk;
          received += chunk.length;
          if (received % (10 * 1024 * 1024) === 0) {
            console.log(`  Downloaded ${(received / 1024 / 1024).toFixed(1)} MB...`);
          }
        });
        res.on('end', () => {
          console.log(`  Download complete: ${(received / 1024 / 1024).toFixed(1)} MB`);
          resolve(data);
        });
      }).on('error', reject);
    };
    makeRequest(url);
  });
}

function parseCsvRow(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      fields.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current.trim());
  return fields;
}

function parseNadac(csv: string): NadacRow[] {
  const lines = csv.split('\n');
  const rows: NadacRow[] = [];

  // Skip header
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const fields = parseCsvRow(line);
    if (fields.length < 9) continue;

    const ndc = fields[1];
    if (!ndc || ndc.length < 11) continue; // Skip malformed NDCs

    rows.push({
      description: fields[0],
      ndc,
      nadacPerUnit: parseFloat(fields[2]) || 0,
      effectiveDate: fields[3],
      pricingUnit: fields[4],
      pharmacyTypeIndicator: fields[5],
      otc: fields[6],
      explanationCode: fields[7],
      classification: fields[8], // G or B
    });
  }

  return rows;
}

// ── Deduplicate & Tier ───────────────────────────────────

function deduplicateToLatest(rows: NadacRow[]): Map<string, NadacRow> {
  const latest = new Map<string, NadacRow>();

  for (const row of rows) {
    const existing = latest.get(row.ndc);
    if (!existing || row.effectiveDate > existing.effectiveDate) {
      latest.set(row.ndc, row);
    }
  }

  return latest;
}

function assignTier(row: NadacRow): { tier: number; copay: number; priorAuth: boolean; stepTherapy: boolean } {
  const isGeneric = row.classification === 'G';

  if (isGeneric) {
    return { tier: 1, copay: COPAY_TIER1, priorAuth: false, stepTherapy: false };
  }

  // Brand classification
  if (row.nadacPerUnit < BRAND_TIER2_MAX) {
    return { tier: 2, copay: COPAY_TIER2, priorAuth: false, stepTherapy: false };
  }

  if (row.nadacPerUnit < BRAND_TIER3_MAX) {
    return { tier: 3, copay: COPAY_TIER3, priorAuth: false, stepTherapy: true };
  }

  // Specialty tier
  return { tier: 4, copay: COPAY_TIER4, priorAuth: true, stepTherapy: true };
}

function formatNdc(ndc: string): string {
  // Format as 5-4-2
  if (ndc.length === 11) {
    return `${ndc.slice(0, 5)}-${ndc.slice(5, 9)}-${ndc.slice(9)}`;
  }
  return ndc;
}

function buildFormularyRecords(deduped: Map<string, NadacRow>): FormularyRecord[] {
  const records: FormularyRecord[] = [];

  for (const [ndc, row] of deduped) {
    const { tier, copay, priorAuth, stepTherapy } = assignTier(row);

    // Default max quantities based on common dispensing practices
    let maxQty = 90;  // 90-day supply typical
    let maxDays = 90;

    // Specialty drugs often limited to 30-day supply
    if (tier === 4) {
      maxQty = 30;
      maxDays = 30;
    }

    records.push({
      ndc,
      ndcFormatted: formatNdc(ndc),
      description: row.description,
      classification: row.classification,
      nadacPerUnit: row.nadacPerUnit,
      pricingUnit: row.pricingUnit,
      otc: row.otc === 'Y',
      effectiveDate: row.effectiveDate,
      tierLevel: tier,
      copayAmount: copay,
      requiresPriorAuth: priorAuth,
      maxQuantityPerFill: maxQty,
      maxDaySupply: maxDays,
      stepTherapyRequired: stepTherapy,
    });
  }

  // Sort by description for readability
  records.sort((a, b) => a.description.localeCompare(b.description));

  return records;
}

// ── Main ─────────────────────────────────────────────────

async function main() {
  console.log('NADAC Data Import — CMS Drug Pricing');
  console.log('=====================================\n');

  const csv = await downloadCsv(NADAC_URL);

  console.log('\nParsing CSV...');
  const allRows = parseNadac(csv);
  console.log(`  → ${allRows.length} total rows parsed`);

  console.log('Deduplicating to latest effective date per NDC...');
  const deduped = deduplicateToLatest(allRows);
  console.log(`  → ${deduped.size} unique NDCs`);

  console.log('Assigning tiers and building formulary records...');
  let records = buildFormularyRecords(deduped);

  // Cap at MerkleTree(16) capacity if needed
  if (records.length > MAX_FORMULARY_SIZE) {
    console.log(`  ⚠ ${records.length} drugs exceeds MerkleTree(16) capacity of ${MAX_FORMULARY_SIZE}`);
    console.log(`  → Trimming to ${MAX_FORMULARY_SIZE} (keeping prescription drugs, dropping OTC)`);

    // Prioritize: prescription drugs first, then OTC
    const rx = records.filter((r) => !r.otc);
    const otc = records.filter((r) => r.otc);
    records = rx.length <= MAX_FORMULARY_SIZE ? rx : rx.slice(0, MAX_FORMULARY_SIZE);
    if (records.length < MAX_FORMULARY_SIZE) {
      records.push(...otc.slice(0, MAX_FORMULARY_SIZE - records.length));
    }
    console.log(`  → Final count: ${records.length}`);
  }

  // Tier summary
  const tierCounts = [0, 0, 0, 0, 0];
  for (const r of records) tierCounts[r.tierLevel]++;
  console.log(`\n── Tier Distribution ──`);
  console.log(`  Tier 1 (Generic, $10 copay):       ${tierCounts[1]}`);
  console.log(`  Tier 2 (Pref Brand, $35 copay):     ${tierCounts[2]}`);
  console.log(`  Tier 3 (Non-Pref Brand, $75 copay): ${tierCounts[3]}`);
  console.log(`  Tier 4 (Specialty, $150 copay):      ${tierCounts[4]}`);
  console.log(`  Total:                               ${records.length}`);

  // Write full formulary
  const formularyPath = path.join(__dirname, 'formulary.json');
  fs.writeFileSync(formularyPath, JSON.stringify(records, null, 2));
  console.log(`\nWritten: ${formularyPath} (${(fs.statSync(formularyPath).size / 1024 / 1024).toFixed(1)} MB)`);

  // Also write a compact version (FormularyEntryLocalData only — for direct use in code)
  const compactRecords = records.map((r) => ({
    ndc: r.ndc,
    tierLevel: r.tierLevel,
    copayAmount: r.copayAmount,
    requiresPriorAuth: r.requiresPriorAuth,
    maxQuantityPerFill: r.maxQuantityPerFill,
    maxDaySupply: r.maxDaySupply,
    stepTherapyRequired: r.stepTherapyRequired,
  }));
  const compactPath = path.join(__dirname, 'formulary-entries.json');
  fs.writeFileSync(compactPath, JSON.stringify(compactRecords));
  console.log(`Written: ${compactPath} (${(fs.statSync(compactPath).size / 1024 / 1024).toFixed(1)} MB)`);

  // Write a lookup table (NDC → description + tier + price) for dashboards
  const lookupRecords = records.map((r) => ({
    ndc: r.ndc,
    name: r.description,
    tier: r.tierLevel,
    copay: r.copayAmount,
    nadac: r.nadacPerUnit,
    unit: r.pricingUnit,
    class: r.classification,
    otc: r.otc,
  }));
  const lookupPath = path.join(__dirname, 'formulary-lookup.json');
  fs.writeFileSync(lookupPath, JSON.stringify(lookupRecords));
  console.log(`Written: ${lookupPath} (${(fs.statSync(lookupPath).size / 1024 / 1024).toFixed(1)} MB)`);
}

main().catch((err) => {
  console.error('Import failed:', err);
  process.exit(1);
});
