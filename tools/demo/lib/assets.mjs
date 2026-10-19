/**
 * Files the actors hand to the dashboards, made per take from the cast (lib/claim-script.mjs castOf), so they always
 * match the script and nothing about them lives in the repository:
 *  - the HR roster CSV (fictional employees; header employee_id,family_id,first_name,last_name,dob,email)
 *  - a one-page sample EIN letter PDF for the marketplace's CP 575 upload. It is headed as a fictional demo
 *    document and does not imitate any government notice.
 */
import fs from 'node:fs';
import path from 'node:path';

const csvCell = (v) => (/[",\n]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ''));

export function rosterCsv(cast) {
  const rows = [['employee_id', 'family_id', 'first_name', 'last_name', 'dob', 'email']];
  for (const e of cast.roster) rows.push([e.employeeId, e.familyId, e.firstName, e.lastName, e.dob, e.email || '']);
  return rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
}

/** A minimal, valid one-page PDF (Helvetica text), with correct cross-reference offsets. */
export function sampleLetterPdf(cast) {
  const esc = (s) => String(s).replace(/[\\()]/g, (c) => `\\${c}`).replace(/[^\x20-\x7e]/g, '?');
  const lines = [
    [20, 'Sample EIN letter: fictional, for this demo'],
    [12, ''],
    [12, `Business name: ${cast.employer.company}`],
    [12, `Employer identification number: ${cast.employer.ein}`],
    [12, `State: ${cast.employer.state}`],
    [12, ''],
    [11, 'This page is a stand-in made for a recorded product walkthrough of zpk.care.'],
    [11, 'It was not issued by any government agency and does not imitate one.'],
    [11, 'The business, the people and the number above are fictional.']
  ];
  let y = 720;
  const content = lines.map(([size, text]) => {
    const op = `BT /F1 ${size} Tf 72 ${y} Td (${esc(text)}) Tj ET`;
    y -= size + 12;
    return op;
  }).join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

/** Writes both into dir; returns their paths. */
export function writeTakeAssets(cast, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const csv = path.join(dir, cast.roster.fileName || 'roster.csv');
  const pdf = path.join(dir, cast.employer.letterFileName || 'sample-ein-letter.pdf');
  fs.writeFileSync(csv, rosterCsv(cast));
  fs.writeFileSync(pdf, sampleLetterPdf(cast));
  return { csv, pdf };
}
