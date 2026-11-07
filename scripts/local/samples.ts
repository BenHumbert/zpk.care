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
 * The two files the walkthrough asks a first-time user for, made by `npm run setup` so nobody has to write them:
 *
 *  - an employee roster for the HR Tool's import (fictional people; the mobile column is where the HR Tool texts each
 *    employee's enrollment PIN, which on one machine goes to the HR Tool's outbox, and `npm run texts` shows it);
 *  - a one-page sample EIN letter for the marketplace's CP 575 upload. It says on its face that it is fictional and was
 *    not issued by any agency, and it does not imitate any government notice.
 *
 * Every name, date of birth, number and the EIN are fictional: the mobile numbers are in the 555-0100 to 555-0199 range
 * set aside for fiction, the emails use the reserved example.test domain, and EINs beginning 00 are never issued.
 */
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import path from 'path';

export const SAMPLE_EMPLOYER = { company: 'Fernhill Tool Works (fictional)', ein: '00-4417321', state: 'WI' };

export const SAMPLE_ROSTER: ReadonlyArray<Record<'employee_id' | 'family_id' | 'first_name' | 'last_name' | 'dob' | 'email' | 'mobile', string>> = [
  { employee_id: 'FTW-001', family_id: 'FAM-01', first_name: 'Avery', last_name: 'Quillfeather', dob: '19870412', email: 'avery.quillfeather@example.test', mobile: '+1 608 555 0101' },
  { employee_id: 'FTW-002', family_id: 'FAM-01', first_name: 'Rowan', last_name: 'Quillfeather', dob: '19890930', email: '', mobile: '+1 608 555 0102' },
  { employee_id: 'FTW-003', family_id: 'FAM-02', first_name: 'Jordan', last_name: 'Okafor-Lind', dob: '19750203', email: '', mobile: '+1 608 555 0103' },
  { employee_id: 'FTW-004', family_id: 'FAM-03', first_name: 'Sam', last_name: 'Delacroix-Hale', dob: '19920718', email: '', mobile: '+1 608 555 0104' },
  { employee_id: 'FTW-005', family_id: 'FAM-04', first_name: 'Kai', last_name: 'Brennwald', dob: '20010111', email: '', mobile: '+1 608 555 0105' },
];

const csvCell = (v: string): string => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** The roster as the HR Tool imports it: a header row, then one employee per line. */
export function rosterCsv(roster = SAMPLE_ROSTER): string {
  const columns = ['employee_id', 'family_id', 'first_name', 'last_name', 'dob', 'email', 'mobile'] as const;
  return [columns.join(','), ...roster.map((row) => columns.map((c) => csvCell(row[c])).join(','))].join('\n') + '\n';
}

/** A minimal, valid one-page PDF in Helvetica, with correct cross-reference offsets. */
export function sampleLetterPdf(employer = SAMPLE_EMPLOYER): Buffer {
  const escape = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`).replace(/[^\x20-\x7e]/g, '?');
  const lines: Array<[number, string]> = [
    [20, 'Sample EIN letter: fictional'],
    [12, ''],
    [12, `Business name: ${employer.company}`],
    [12, `Employer identification number: ${employer.ein}`],
    [12, `State: ${employer.state}`],
    [12, ''],
    [11, 'This page is a stand-in for trying zpk.care on one machine.'],
    [11, 'It was not issued by any government agency and does not imitate one.'],
    [11, 'The business, the people and the number above are fictional.'],
  ];
  let y = 720;
  const content = lines
    .map(([size, text]) => {
      const op = `BT /F1 ${size} Tf 72 ${y} Td (${escape(text)}) Tj ET`;
      y -= size + 12;
      return op;
    })
    .join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

/** Writes both files into `dir` unless they are there already; returns their paths. */
export function writeSamples(dir: string): { roster: string; letter: string } {
  mkdirSync(dir, { recursive: true });
  const roster = path.join(dir, 'roster.csv');
  const letter = path.join(dir, 'sample-ein-letter.pdf');
  if (!existsSync(roster)) writeFileSync(roster, rosterCsv());
  if (!existsSync(letter)) writeFileSync(letter, sampleLetterPdf());
  return { roster, letter };
}
