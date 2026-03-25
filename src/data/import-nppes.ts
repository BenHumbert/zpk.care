/**
 * NPPES Data Import — Real Prescriber & Pharmacy Data for Madison, WI
 *
 * Queries the CMS NPPES NPI Registry API to download real provider data.
 * Generates prescribers.json and pharmacies.json with production-ready records.
 *
 * Data source: https://npiregistry.cms.hhs.gov/api/
 * All data is PUBLIC RECORD from CMS — no PHI/PII concerns.
 *
 * Usage: npx tsx src/data/import-nppes.ts
 */

import * as https from 'https';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Configuration ────────────────────────────────────────

const CITY = 'Madison';
const STATE = 'WI';
const TARGET_PRESCRIBERS = 20;
const TARGET_PHARMACIES = 15;

// Specialties to sample prescribers from (diverse mix for realistic POC)
const PRESCRIBER_SPECIALTIES = [
  'Internal Medicine',
  'Family Medicine',
  'Pediatrics',
  'Psychiatry',
  'Dermatology',
  'Cardiology',
  'Orthopedic Surgery',
  'Obstetrics & Gynecology',
  'Neurology',
  'Ophthalmology',
];

// ── Types ────────────────────────────────────────────────

interface NppesResult {
  result_count: number;
  results: NppesRecord[];
}

interface NppesRecord {
  number: string; // NPI
  enumeration_type: string;
  basic: {
    first_name?: string;
    last_name?: string;
    credential?: string;
    organization_name?: string;
    sex?: string;
    status: string;
    enumeration_date: string;
    sole_proprietor?: string;
  };
  addresses: {
    address_purpose: string;
    address_1: string;
    city: string;
    state: string;
    postal_code: string;
    telephone_number?: string;
  }[];
  taxonomies: {
    code: string;
    desc: string;
    license: string;
    primary: boolean;
    state: string;
  }[];
}

// Output interfaces (match existing SeedPrescriber/SeedPharmacy structure)
interface PrescriberRecord {
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
  // NPPES metadata
  npi: string;
  address: string;
  city: string;
  zip: string;
  phone: string;
}

interface PharmacyRecord {
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
  // NPPES metadata
  npi: string;
  ncpdpProviderId: string;
  taxonomyCode: string;
}

// ── API Helpers ──────────────────────────────────────────

function queryNppes(params: Record<string, string>): Promise<NppesResult> {
  return new Promise((resolve, reject) => {
    const qs = Object.entries(params)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join('&');
    const url = `https://npiregistry.cms.hhs.gov/api/?version=2.1&${qs}`;

    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Failed to parse NPPES response: ${e}`));
        }
      });
    }).on('error', reject);
  });
}

/** Generate a deterministic enrollment key from NPI (for POC repeatability) */
function deriveEnrollmentKey(npi: string, salt: string): string {
  // Simple deterministic key — in production each entity generates their own
  return crypto.createHash('sha256').update(`zkpcare-${salt}-${npi}`).digest('hex').slice(0, 32);
}

function getLocation(record: NppesRecord) {
  return record.addresses.find((a) => a.address_purpose === 'LOCATION') || record.addresses[0] || {};
}

function getPrimaryTaxonomy(record: NppesRecord) {
  return record.taxonomies.find((t) => t.primary) || record.taxonomies[0] || {};
}

// ── Import Prescribers ───────────────────────────────────

async function importPrescribers(): Promise<PrescriberRecord[]> {
  const results: PrescriberRecord[] = [];
  const seenNpis = new Set<string>();

  // Sample 2 prescribers per specialty (round-robin until we hit target)
  const perSpecialty = Math.ceil(TARGET_PRESCRIBERS / PRESCRIBER_SPECIALTIES.length);

  for (const specialty of PRESCRIBER_SPECIALTIES) {
    if (results.length >= TARGET_PRESCRIBERS) break;

    console.log(`  Querying ${specialty}...`);
    const data = await queryNppes({
      city: CITY,
      state: STATE,
      enumeration_type: 'NPI-1',
      taxonomy_description: specialty,
      limit: String(Math.min(perSpecialty + 5, 10)), // fetch extra in case of duplicates
    });

    let taken = 0;
    for (const r of data.results || []) {
      if (taken >= perSpecialty || results.length >= TARGET_PRESCRIBERS) break;
      if (r.basic.status !== 'A') continue; // active only
      if (seenNpis.has(r.number)) continue;
      seenNpis.add(r.number);

      const loc = getLocation(r);
      const tax = getPrimaryTaxonomy(r);

      results.push({
        localData: {
          prescriberIdQualifier: 1, // NPI
          prescriberId: r.number,
        },
        enrollmentKey: deriveEnrollmentKey(r.number, 'prescriber'),
        firstName: r.basic.first_name || '',
        lastName: r.basic.last_name || '',
        credential: r.basic.credential || 'MD',
        specialty: tax.desc || specialty,
        taxonomyCode: tax.code || '',
        stateLicense: tax.license || '',
        state: tax.state || STATE,
        deaNumber: '', // Not available via NPPES API (DEA is separate registry)
        npi: r.number,
        address: loc.address_1 || '',
        city: loc.city || CITY,
        zip: (loc.postal_code || '').slice(0, 5),
        phone: loc.telephone_number || '',
      });
      taken++;
    }

    // Rate limiting — be respectful to CMS API
    await new Promise((r) => setTimeout(r, 200));
  }

  return results;
}

// ── Import Pharmacies ────────────────────────────────────

async function importPharmacies(): Promise<PharmacyRecord[]> {
  const results: PharmacyRecord[] = [];
  const seenNpis = new Set<string>();

  console.log(`  Querying Community/Retail Pharmacies...`);
  const data = await queryNppes({
    city: CITY,
    state: STATE,
    enumeration_type: 'NPI-2',
    taxonomy_description: 'Community/Retail Pharmacy',
    limit: String(TARGET_PHARMACIES + 10),
  });

  for (const r of data.results || []) {
    if (results.length >= TARGET_PHARMACIES) break;
    if (r.basic.status !== 'A') continue;
    if (seenNpis.has(r.number)) continue;
    seenNpis.add(r.number);

    const loc = getLocation(r);
    const tax = getPrimaryTaxonomy(r);
    const orgName = r.basic.organization_name || '';

    // Detect chain from org name
    const chains = ['CVS', 'WALGREENS', 'WALMART', 'COSTCO', 'TARGET', 'RITE AID', 'KROGER', 'HY-VEE'];
    const chain = chains.find((c) => orgName.toUpperCase().includes(c)) || 'Independent';

    results.push({
      localData: {
        serviceProviderIdQualifier: 1, // NPI
        serviceProviderId: r.number,
      },
      enrollmentKey: deriveEnrollmentKey(r.number, 'pharmacy'),
      storeName: orgName,
      chain,
      pharmacyType: '01',
      pharmacyTypeDesc: 'Community/Retail',
      address: loc.address_1 || '',
      city: loc.city || CITY,
      state: loc.state || STATE,
      zip: (loc.postal_code || '').slice(0, 5),
      phone: loc.telephone_number || '',
      npi: r.number,
      ncpdpProviderId: '', // NCPDP ID not available from NPPES — would need paid NCPDP subscription
      taxonomyCode: tax.code || '3336C0003X',
    });
  }

  return results;
}

// ── Main ─────────────────────────────────────────────────

async function main() {
  console.log('NPPES Data Import — Madison, WI');
  console.log('================================\n');

  console.log('Importing prescribers...');
  const prescribers = await importPrescribers();
  console.log(`  → ${prescribers.length} prescribers imported\n`);

  console.log('Importing pharmacies...');
  const pharmacies = await importPharmacies();
  console.log(`  → ${pharmacies.length} pharmacies imported\n`);

  // Write output files
  const prescriberPath = path.join(__dirname, 'prescribers.json');
  const pharmacyPath = path.join(__dirname, 'pharmacies.json');

  fs.writeFileSync(prescriberPath, JSON.stringify(prescribers, null, 2));
  fs.writeFileSync(pharmacyPath, JSON.stringify(pharmacies, null, 2));

  console.log(`Written: ${prescriberPath}`);
  console.log(`Written: ${pharmacyPath}`);

  // Summary
  console.log('\n── Summary ──');
  console.log('Prescribers:');
  const specCount = new Map<string, number>();
  for (const p of prescribers) {
    specCount.set(p.specialty, (specCount.get(p.specialty) || 0) + 1);
  }
  for (const [spec, count] of specCount) {
    console.log(`  ${spec}: ${count}`);
  }
  console.log('\nPharmacies:');
  for (const p of pharmacies) {
    console.log(`  ${p.npi} — ${p.storeName} (${p.address})`);
  }
}

main().catch((err) => {
  console.error('Import failed:', err);
  process.exit(1);
});
