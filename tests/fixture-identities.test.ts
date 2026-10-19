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
 * The fixture people and businesses are invented.
 *
 * The seed providers used to be real NPPES records, doctors and pharmacies in a real city, and the member
 * fixtures named two real employers. Both were replaced with invented ones, and the importer that wrote real
 * records into src/data is gone. This suite holds the replacement to rules that need no list of real names:
 *   - every provider NPI is 2 and nine more digits with a valid check digit (NPPES has issued only numbers
 *     that start with 1), and the claim identifiers equal it;
 *   - no DEA number and no NCPDP ID, because a well-formed one cannot be shown to be unassigned;
 *   - phone numbers only in 555-0100..0199, the block reserved for fiction, and e-mail only at example.test;
 *   - no member, employer or provider string names the old employers or their city.
 * Each name and NPI was also checked against the NPPES registry (no match) when it was chosen; a test
 * cannot repeat that without the network.
 *
 * The formulary is cut to 100 drugs before src/data loads, so this suite does not parse the full NADAC file.
 */
import fs from 'fs';
import path from 'path';
import { validateEnrollmentKey } from '../src/wallets/wallet-derivation.js';

type RawRow = Record<string, any>;

const DATA_DIR = path.resolve(__dirname, '..', 'src', 'data');
const rawPrescribers: RawRow[] = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'prescribers.json'), 'utf8'));
const rawPharmacies: RawRow[] = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'pharmacies.json'), 'utf8'));

let data: typeof import('../src/data/index.js');
let directory: typeof import('../src/data/fixture-directory.js');
let savedLimit: string | undefined;

beforeAll(async () => {
  savedLimit = process.env.ZKTRIDENT_FORMULARY_LIMIT;
  process.env.ZKTRIDENT_FORMULARY_LIMIT = '100';
  data = await import('../src/data/index.js');
  directory = await import('../src/data/fixture-directory.js');
});

afterAll(() => {
  if (savedLimit === undefined) delete process.env.ZKTRIDENT_FORMULARY_LIMIT;
  else process.env.ZKTRIDENT_FORMULARY_LIMIT = savedLimit;
});

/** The CMS check-digit rule for an NPI: the Luhn sum over 80840 followed by all ten digits is a multiple of 10. */
function npiCheckDigitValid(npi: string): boolean {
  const digits = '80840' + npi;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

const FICTION_PHONE = /^608-555-01\d\d$/;
const FICTIONAL_NPI = /^2\d{9}$/;

/** Every string in a value, with its path, skipping enrollment keys: those are random bytes, not identity text. */
function stringsIn(value: unknown, at: string, out: Array<[string, string]> = []): Array<[string, string]> {
  if (typeof value === 'string') out.push([at, value]);
  else if (Array.isArray(value)) value.forEach((v, i) => stringsIn(v, `${at}[${i}]`, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k !== 'enrollmentKey') stringsIn(v, `${at}.${k}`, out);
    }
  }
  return out;
}

describe('fixture provider identities', () => {
  test('the check-digit rule is the CMS one', () => {
    expect(npiCheckDigitValid('1234567893')).toBe(true);    // the worked example CMS publishes
    expect(npiCheckDigitValid('1234567890')).toBe(false);
    expect(npiCheckDigitValid('2999000013')).toBe(true);
  });

  test('every prescriber and pharmacy NPI is 2 and nine digits, with a valid check digit', () => {
    const npis = [...rawPrescribers, ...rawPharmacies].map((r) => String(r.npi));
    expect(npis.length).toBeGreaterThan(0);
    for (const npi of npis) {
      expect({ npi, format: FICTIONAL_NPI.test(npi), checkDigit: npiCheckDigitValid(npi) }).toEqual({ npi, format: true, checkDigit: true });
    }
    expect(new Set(npis).size).toBe(npis.length);
  });

  test('prescriberId and serviceProviderId equal the NPI, with qualifier 1', () => {
    for (const r of rawPrescribers) {
      expect(r.localData).toEqual({ prescriberIdQualifier: 1, prescriberId: r.npi });
    }
    for (const r of rawPharmacies) {
      expect(r.localData).toEqual({ serviceProviderIdQualifier: 1, serviceProviderId: r.npi });
    }
    expect(data.PRESCRIBERS.map((p) => p.localData.prescriberId)).toEqual(rawPrescribers.map((r) => r.npi));
    expect(data.PHARMACIES.map((p) => p.localData.serviceProviderId)).toEqual(rawPharmacies.map((r) => r.npi));
  });

  test('no provider carries a DEA number or an NCPDP ID, and state licenses are visibly fictional', () => {
    for (const r of rawPrescribers) {
      expect(r.deaNumber).toBe('');
      expect(r.stateLicense).toMatch(/^FX-\d{4}$/);
    }
    for (const r of rawPharmacies) expect(r.ncpdpProviderId).toBe('');
    for (const p of data.PHARMACIES) {
      expect(p.deaNumber).toBe('');
      expect(p.ncpdpProviderId).toBe('');
    }
  });

  test('every pharmacy is an independent community pharmacy', () => {
    for (const r of rawPharmacies) {
      expect(r.chain).toBe('Independent');
      expect(r.pharmacyType).toBe('01');
    }
  });

  test('phone numbers are in the 555-0100..0199 block reserved for fiction', () => {
    const phones = [...rawPrescribers, ...rawPharmacies].map((r) => String(r.phone)).concat(data.MEMBERS.map((m) => m.phone));
    for (const phone of phones) expect(phone).toMatch(FICTION_PHONE);
  });

  test('provider enrollment keys are fresh 32-byte keys that pass the wallet rules', () => {
    const keys = [...rawPrescribers, ...rawPharmacies].map((r) => String(r.enrollmentKey));
    for (const key of keys) {
      expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(() => validateEnrollmentKey(key)).not.toThrow();
    }
    const all = keys.concat(data.MEMBERS.map((m) => m.enrollmentKey));
    expect(new Set(all).size).toBe(all.length);
  });

  test('the rows keep their roles: prescriber 0 is a family physician, pharmacy 0 a community pharmacy', () => {
    expect(data.PRESCRIBERS[0]).toMatchObject({ credential: 'MD', specialty: 'Family Medicine', taxonomyCode: '207Q00000X' });
    expect(data.PHARMACIES[0]).toMatchObject({ chain: 'Independent', pharmacyType: '01', pharmacyTypeDesc: 'Community/Retail' });
  });

  test('only physicians are titled "Dr." on screen', () => {
    const shown = directory.fixtureDirectory().prescribers;
    expect(shown).toHaveLength(data.PRESCRIBERS.length);
    for (const p of shown) {
      const physician = p.credential === 'MD' || p.credential === 'DO';
      expect({ name: p.name, credential: p.credential, titled: p.name.startsWith('Dr. ') }).toEqual({ name: p.name, credential: p.credential, titled: physician });
    }
  });
});

describe('fixture members and employers', () => {
  test('member e-mail addresses are at example.test', () => {
    for (const m of data.MEMBERS) expect(m.email).toMatch(/@([a-z0-9-]+\.)*example\.test$/);
  });

  test('every member works for exactly one fixture employer, by cardholder and family prefix', () => {
    for (const m of data.MEMBERS) {
      const employers = data.FIXTURE_EMPLOYERS.filter((e) => m.localData.cardholderId.startsWith(e.cardholderPrefix) && m.familyId.startsWith(e.familyPrefix));
      expect({ cardholderId: m.localData.cardholderId, employers: employers.length }).toEqual({ cardholderId: m.localData.cardholderId, employers: 1 });
    }
    expect(data.getFernhillMembers().length + data.getBaysideMembers().length).toBe(data.MEMBERS.length);
  });
});

describe('no real employer or city', () => {
  test('no member, employer or provider string contains EPIC, EXACT, epicmail, exactsciences or Madison', () => {
    const retired = ['EPIC', 'EXACT', 'epicmail', 'exactsciences', 'Madison'].map((t) => t.toLowerCase());
    const strings = [
      ...stringsIn(data.MEMBERS, 'MEMBERS'),
      ...stringsIn(data.FIXTURE_EMPLOYERS, 'FIXTURE_EMPLOYERS'),
      ...stringsIn(rawPrescribers, 'prescribers.json'),
      ...stringsIn(rawPharmacies, 'pharmacies.json'),
      ...stringsIn(data.PRESCRIBERS, 'PRESCRIBERS'),
      ...stringsIn(data.PHARMACIES, 'PHARMACIES'),
      ...stringsIn(directory.fixtureDirectory(), 'fixtures.json'),
    ];
    expect(strings.length).toBeGreaterThan(100);
    const hits = strings.filter(([, s]) => retired.some((t) => s.toLowerCase().includes(t)));
    expect(hits).toEqual([]);
  });
});
