/**
 * Employer Attestation — agreement commitment, signing, verification, and DOCX generation.
 *
 * Legal compliance (mean lawyer review):
 *   - BAA section (separable) per HIPAA §164.504(e)(2)
 *   - ERISA §408(b)(2) fee disclosure
 *   - Representations, warranties, and indemnification
 *   - State-specific provisions (MAC appeal, audit rights)
 *   - Grievance/appeals procedure per ERISA §503
 *   - Officer attestation with signer name + title in Ed25519 signed payload
 *   - Scroll/review confirmation per ESIGN §7001(c)(1)
 */
import { createHash, createPublicKey, verify as ed25519Verify } from 'crypto';
import { Poseidon, Encoding, Field } from 'o1js';
import { hashString, dateToField } from '../zkp/hash-utils.js';
import type { AgreementTerms, EmployerAttestation, EmployerApplication, BenefitPlanConfig } from '../l2/l2-types.js';
import {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  HeadingLevel, AlignmentType, WidthType,
} from 'docx';

// ─── Agreement Commitment ───────────────────────────────────

/**
 * Compute the Poseidon commitment over structured agreement terms.
 * Includes ALL material financial fields + signer identity.
 */
export function computeAgreementCommitment(terms: AgreementTerms, signerName?: string, signerTitle?: string): string {
  const planFinancials = terms.selectedPlans
    .slice()
    .sort((a, b) => a.planId.localeCompare(b.planId))
    .map(p => `${p.planId}:${p.copayAmountCents}:${p.deductibleAmountCents}:${p.oopMaxCents}:${p.annualBenefitMaxCents}`)
    .join(';');

  const fields = [
    hashString(terms.agreementId),
    hashString(terms.employerId),
    hashString(planFinancials),
    Field(BigInt(terms.enrollmentCap)),
    dateToField(terms.effectiveDate),
    hashString(terms.termsVersion),
  ];

  // Include signer identity in commitment — atomic: both or neither (matches buildAttestationMessage)
  if (signerName && signerTitle) {
    fields.push(hashString(signerName));
    fields.push(hashString(signerTitle));
  }

  return Poseidon.hash(fields).toString();
}

/**
 * Compute the document hash over canonical JSON of agreement terms.
 * Uses recursive key sorting. Excludes volatile `generatedAt`.
 */
export function computeDocumentHash(terms: AgreementTerms): string {
  const { generatedAt, ...stableTerms } = terms;
  const canonical = JSON.stringify(stableTerms, deepSortReplacer);
  return createHash('sha256').update(canonical).digest('hex');
}

function deepSortReplacer(_key: string, value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
    );
  }
  return value;
}

// ─── Canonical Attestation Message ──────────────────────────

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/**
 * Build the canonical pipe-delimited message for employer attestation signing.
 *
 * Phase D format (v2):
 *   zkpcare-employer-v2|{employerId}|{pubKey}|{plans}|{cap}|{commitment}|{docHash}|{date}|{ts}|{seq}|{signerName}|{signerTitle}
 *
 * The seq field binds the signature to a specific monotonic position in the
 * employer's attestation chain on the sequencer. seq=0 is the first
 * registration; +1 per renewal. Both employer and insurer signatures cover
 * this field, so it cannot be tampered with after signing.
 */
export function buildAttestationMessage(att: {
  employerId: string;
  publicKeyHex: string;
  authorizedPlanIds: string[];
  enrollmentCap: number;
  agreementCommitment: string;
  documentHash: string;
  effectiveDate: string;
  ts: number;
  attestationSeq: number;
  signerName?: string;
  signerTitle?: string;
}): Buffer {
  const plans = att.authorizedPlanIds.slice().sort().join(',');
  const signer = att.signerName && att.signerTitle
    ? `|${att.signerName}|${att.signerTitle}`
    : '';
  const msg = `zkpcare-employer-v2|${att.employerId}|${att.publicKeyHex}|${plans}|${att.enrollmentCap}|${att.agreementCommitment}|${att.documentHash}|${att.effectiveDate}|${att.ts}|${att.attestationSeq}${signer}`;
  return Buffer.from(msg, 'utf8');
}

/**
 * Verify an Ed25519 signature against the canonical attestation message.
 */
export function verifyAttestationSignature(
  att: { employerId: string; publicKeyHex: string; authorizedPlanIds: string[]; enrollmentCap: number; agreementCommitment: string; documentHash: string; effectiveDate: string; ts: number; attestationSeq: number; signerName?: string; signerTitle?: string },
  signatureHex: string,
  publicKeyHex: string,
): boolean {
  const message = buildAttestationMessage(att);
  try {
    const pubKeyDer = Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKeyHex, 'hex')]);
    const pubKey = createPublicKey({ key: pubKeyDer, format: 'der', type: 'spki' });
    return ed25519Verify(null, message, pubKey, Buffer.from(signatureHex, 'hex'));
  } catch {
    return false;
  }
}

export function verifyEmployerSignature(att: EmployerAttestation): boolean {
  return verifyAttestationSignature(att, att.employerSignature, att.publicKeyHex);
}

export function verifyInsurerSignature(att: EmployerAttestation): boolean {
  return verifyAttestationSignature(att, att.insurerSignature, att.insurerPublicKeyHex);
}

// ─── Verification Certificate ───────────────────────────────

/**
 * Build an opaque verification certificate: insurer attests that employer was verified.
 * Contains NO PII — only employerId (opaque), verification methods, and timestamp.
 */
export function buildVerificationCertMessage(employerId: string, methods: string[], ts: number): Buffer {
  const msg = `zkpcare-verification-v1|${employerId}|${methods.sort().join(',')}|${ts}`;
  return Buffer.from(msg, 'utf8');
}

// ─── Agreement Terms Builder ────────────────────────────────

export function buildAgreementTerms(
  application: EmployerApplication,
  plans: BenefitPlanConfig[],
  insurerName: string = 'zkpCare Network',
  termsVersion: string = '2026.1',
): AgreementTerms {
  const selectedPlans = application.selectedPlanIds
    .map(pid => plans.find(p => p.planId === pid))
    .filter((p): p is BenefitPlanConfig => !!p)
    .map(p => ({
      planId: p.planId,
      planName: p.name,
      copayAmountCents: p.copayAmountCents,
      deductibleAmountCents: p.deductibleAmountCents,
      oopMaxCents: p.oopMaxCents,
      annualBenefitMaxCents: p.annualBenefitMaxCents,
    }));

  return {
    agreementId: `AGR-${application.applicationId}`,
    applicationId: application.applicationId,
    employerId: application.employerId,
    companyName: application.companyName,
    selectedPlans,
    effectiveDate: application.effectiveDate,
    enrollmentCap: application.enrollmentCap,
    insurerName,
    termsVersion,
    generatedAt: Date.now(),
  };
}

// ─── DOCX Agreement Generation ──────────────────────────────

function fmtCents(cents: number): string {
  return '$' + (cents / 100).toFixed(2);
}

function textRun(text: string, bold = false, size = 22): TextRun {
  return new TextRun({ text, bold, size, font: 'Arial' });
}

function headerParagraph(text: string, level: (typeof HeadingLevel)[keyof typeof HeadingLevel] = HeadingLevel.HEADING_2): Paragraph {
  return new Paragraph({ heading: level, children: [textRun(text, true, level === HeadingLevel.HEADING_1 ? 32 : 26)] });
}

function bodyParagraph(text: string): Paragraph {
  return new Paragraph({ spacing: { after: 120 }, children: [textRun(text)] });
}

function cell(text: string, bold = false): TableCell {
  return new TableCell({
    children: [new Paragraph({ children: [textRun(text, bold, 20)] })],
    width: { size: 25, type: WidthType.PERCENTAGE },
  });
}

/**
 * Generate a DOCX agreement with all legally required sections.
 *
 * Sections:
 *   1. Parties
 *   2. Benefit Plans
 *   3. Terms and Conditions
 *   4. Business Associate Agreement (BAA) — separable, HIPAA §164.504(e)(2)
 *   5. ERISA §408(b)(2) Fee Disclosure
 *   6. Representations, Warranties, and Indemnification
 *   7. State-Specific Provisions
 *   8. Claims Appeals and Grievance Procedure — ERISA §503
 *   9. Cryptographic Binding
 *  10. Officer Attestation and Digital Signatures
 */
export async function generateAgreementDocx(
  terms: AgreementTerms,
  commitment: string,
  documentHash: string,
  employerSignature: string,
  insurerSignature: string,
  insurerPublicKeyHex: string,
  signerName?: string,
  signerTitle?: string,
): Promise<Buffer> {
  const s: Paragraph[] = [];

  // Title
  s.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 200 }, children: [textRun('EMPLOYER BENEFIT PLAN AGREEMENT', true, 36)] }));
  s.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 400 }, children: [textRun(terms.insurerName, false, 26)] }));

  // ── 1. Parties ──
  s.push(headerParagraph('1. Parties'));
  s.push(bodyParagraph(`This Agreement ("Agreement") is entered into between ${terms.insurerName} ("Insurer" or "PBM") and ${terms.companyName} ("Employer" or "Plan Sponsor"), identified as ${terms.employerId}.`));
  s.push(bodyParagraph(`Effective Date: ${terms.effectiveDate.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3')}`));
  s.push(bodyParagraph(`Maximum Enrollment: ${terms.enrollmentCap} members`));
  s.push(bodyParagraph(`Agreement ID: ${terms.agreementId}`));
  s.push(bodyParagraph(`Terms Version: ${terms.termsVersion}`));

  // ── 2. Benefit Plans ──
  s.push(headerParagraph('2. Benefit Plans'));
  if (terms.selectedPlans.length === 0) {
    s.push(bodyParagraph('No plans selected.'));
  } else {
    const headerRow = new TableRow({ children: [cell('Plan', true), cell('Copay', true), cell('Deductible', true), cell('OOP Max', true)] });
    const planRows = terms.selectedPlans.map(p => new TableRow({
      children: [cell(p.planName), cell(fmtCents(p.copayAmountCents)), cell(fmtCents(p.deductibleAmountCents)), cell(fmtCents(p.oopMaxCents))],
    }));
    s.push(new Table({ rows: [headerRow, ...planRows], width: { size: 100, type: WidthType.PERCENTAGE } }));
  }

  // ── 3. Terms and Conditions ──
  s.push(headerParagraph('3. Terms and Conditions'));
  s.push(bodyParagraph('3.1 PRIVACY: All employee personal information is processed locally by the Employer using the HR Tool. Only anonymized identifiers (Poseidon hash commitments) are transmitted to the enrollment system. The Insurer never receives employee names, dates of birth, Social Security numbers, or other personally identifiable information.'));
  s.push(bodyParagraph('3.2 PRICING: All drug pricing follows the NADAC (National Average Drug Acquisition Cost) Transparent Pricing model as published by CMS. No rebates, clawbacks, spread pricing, or DIR fees. The member pays the lower of the plan copay or the NADAC acquisition cost plus a dispensing fee.'));
  s.push(bodyParagraph('3.3 ENROLLMENT: The Employer generates enrollment codes via the HR Tool. Each code is paired with an 8-digit PIN delivered via a separate channel (SMS). Both the enrollment code and PIN are required to enroll. This two-factor enrollment prevents unauthorized access.'));
  s.push(bodyParagraph('3.4 TERMINATION: Either party may terminate this Agreement with thirty (30) days written notice. Active enrollments remain valid through the end of the current benefit period. Upon termination, the Insurer will destroy or return all data per Section 4.'));
  s.push(bodyParagraph('3.5 ENROLLMENT CAP: The Employer may enroll up to ' + terms.enrollmentCap + ' members under this Agreement. The cap may be increased by mutual written agreement.'));

  // ── 4. Business Associate Agreement (BAA) ──
  s.push(headerParagraph('4. Business Associate Agreement'));
  s.push(bodyParagraph('This section constitutes a Business Associate Agreement ("BAA") as required by the Health Insurance Portability and Accountability Act of 1996 ("HIPAA"), 45 CFR §164.504(e). The Employer, as Plan Sponsor, is the Covered Entity. The Insurer is the Business Associate.'));
  s.push(bodyParagraph('4.1 PERMITTED USES: The Business Associate shall use Protected Health Information ("PHI") only for the purposes of performing services under this Agreement, including claims processing, formulary management, and benefit administration.'));
  s.push(bodyParagraph('4.2 PROHIBITED DISCLOSURES: The Business Associate shall not use or disclose PHI other than as permitted or required by this Agreement or as required by law.'));
  s.push(bodyParagraph('4.3 SAFEGUARDS: The Business Associate shall implement appropriate administrative, physical, and technical safeguards per 45 CFR §164.312 to prevent unauthorized use or disclosure of PHI.'));
  s.push(bodyParagraph('4.4 BREACH NOTIFICATION: The Business Associate shall report any Breach of Unsecured PHI to the Covered Entity within sixty (60) days of discovery per 45 CFR §164.410.'));
  s.push(bodyParagraph('4.5 SUBCONTRACTORS: The Business Associate shall ensure that any subcontractors that create, receive, maintain, or transmit PHI on behalf of the Business Associate agree to the same restrictions and conditions per 45 CFR §164.502(e)(1)(ii).'));
  s.push(bodyParagraph('4.6 ACCESS RIGHTS: The Business Associate shall make PHI available to individuals for inspection and copying per 45 CFR §164.524.'));
  s.push(bodyParagraph('4.7 AMENDMENT: The Business Associate shall make PHI available for amendment and incorporate amendments per 45 CFR §164.526.'));
  s.push(bodyParagraph('4.8 ACCOUNTING: The Business Associate shall maintain and make available information required for an accounting of disclosures per 45 CFR §164.528.'));
  s.push(bodyParagraph('4.9 HHS ACCESS: The Business Associate shall make its internal practices, books, and records relating to PHI available to the Secretary of HHS for determining compliance.'));
  s.push(bodyParagraph('4.10 TERMINATION: Upon termination, the Business Associate shall return or destroy all PHI. If return or destruction is not feasible, protections shall be extended and uses limited.'));
  s.push(bodyParagraph('NOTE: The zkpCare system transmits only Poseidon hash commitments and zero-knowledge proofs, not Protected Health Information in cleartext. This BAA is executed to ensure full regulatory compliance regardless of the cryptographic architecture.'));

  // ── 5. ERISA §408(b)(2) Fee Disclosure ──
  s.push(headerParagraph('5. ERISA §408(b)(2) Fee Disclosure'));
  s.push(bodyParagraph('Pursuant to 29 CFR §2550.408b-2, the following fee disclosure is provided:'));
  s.push(bodyParagraph('5.1 SERVICES: Pharmacy benefit management including claims adjudication, formulary management, drug utilization review, and benefit administration.'));
  s.push(bodyParagraph('5.2 COMPENSATION: Administrative fee charged per paid claim only. No per-member-per-month (PMPM) fees. No minimum volume requirements.'));
  s.push(bodyParagraph('5.3 DRUG PRICING: Based on the National Average Drug Acquisition Cost (NADAC) as published by the Centers for Medicare & Medicaid Services (CMS), updated weekly.'));
  s.push(bodyParagraph('5.4 DISPENSING FEE: Pass-through dispensing fee paid to the dispensing pharmacy. No spread pricing — the amount paid to the pharmacy equals the amount charged to the plan.'));
  s.push(bodyParagraph('5.5 REBATES: No manufacturer rebates are collected, retained, or distributed. Pricing is based solely on NADAC acquisition cost.'));
  s.push(bodyParagraph('5.6 AUDIT RIGHTS: The Employer may audit the Insurer\'s claims records annually with a two (2) year lookback period. Audit results shall be provided within sixty (60) days of completion.'));
  s.push(bodyParagraph('5.7 FIDUCIARY STATUS: The Insurer acknowledges it may be deemed a functional fiduciary under ERISA §3(21) with respect to claims adjudication. The Employer retains overall fiduciary responsibility as Plan Sponsor.'));

  // ── 6. Representations, Warranties, and Indemnification ──
  s.push(headerParagraph('6. Representations, Warranties, and Indemnification'));
  s.push(bodyParagraph('6.1 EMPLOYER REPRESENTATIONS: The Employer represents and warrants that: (a) it is a duly organized and validly existing entity; (b) it sponsors or administers an employee health benefit plan; (c) the individual executing this Agreement has full authority to bind the Employer; and (d) all information provided in the application is true, complete, and accurate.'));
  s.push(bodyParagraph('6.2 INSURER REPRESENTATIONS: The Insurer represents and warrants that: (a) it holds all required PBM licenses in applicable jurisdictions; (b) it will comply with all applicable federal and state laws; and (c) it will process claims in accordance with the benefit design specified herein.'));
  s.push(bodyParagraph('6.3 INDEMNIFICATION: The undersigned signer personally represents that they have authority to execute this Agreement on behalf of the Employer. In the event the signer lacked such authority, the signer personally indemnifies the Insurer against all claims, damages, and expenses arising from unauthorized execution.'));

  // ── 7. State-Specific Provisions ──
  s.push(headerParagraph('7. State-Specific Provisions'));
  s.push(bodyParagraph('The following provisions apply to comply with state PBM transparency and consumer protection laws:'));
  s.push(bodyParagraph('7.1 MAC PRICING APPEALS: The Employer and its designated pharmacies shall have the right to appeal Maximum Allowable Cost (MAC) pricing decisions. Appeals shall be resolved within fourteen (14) business days.'));
  s.push(bodyParagraph('7.2 AUDIT RIGHTS: The Employer shall have the right to conduct an annual audit of claims data, pricing accuracy, and fee calculations with a two (2) year lookback. The Insurer shall provide full cooperation and access to relevant records.'));
  s.push(bodyParagraph('7.3 SPREAD PRICING PROHIBITION: The Insurer certifies that no spread pricing is applied. The amount charged to the plan for each drug equals the amount paid to the dispensing pharmacy plus the disclosed administrative fee.'));
  s.push(bodyParagraph('7.4 REBATE PASS-THROUGH: No manufacturer rebates are collected. If the Insurer\'s pricing model changes to include rebates in the future, 100% of rebates shall be passed through to the plan.'));

  // ── 8. Claims Appeals and Grievance Procedure ──
  s.push(headerParagraph('8. Claims Appeals and Grievance Procedure'));
  s.push(bodyParagraph('Pursuant to ERISA §503 (29 USC §1133), the following claims and appeals procedure is established:'));
  s.push(bodyParagraph('8.1 INITIAL CLAIM DENIAL: If a claim is denied in whole or in part, the member shall receive a written explanation including the reason for denial, the plan provision on which the denial is based, and a description of the appeals procedure.'));
  s.push(bodyParagraph('8.2 APPEAL SUBMISSION: A member or authorized representative may submit a written appeal within sixty (60) days of receiving the denial notice. Appeals shall be submitted to the Insurer\'s appeals department.'));
  s.push(bodyParagraph('8.3 APPEAL REVIEW: The appeal shall be reviewed by a qualified individual who was not involved in the initial denial decision. The reviewer shall consider all relevant information, including any new information submitted by the claimant.'));
  s.push(bodyParagraph('8.4 APPEAL DECISION: A written decision on the appeal shall be provided within thirty (30) days of receipt. The decision shall include the reasons for the determination and references to the plan provisions on which it is based.'));
  s.push(bodyParagraph('8.5 EXTERNAL REVIEW: If the internal appeal is denied, the member may request an external review by an independent review organization in accordance with applicable state law.'));

  // ── 9. Cryptographic Binding ──
  s.push(headerParagraph('9. Cryptographic Binding'));
  s.push(bodyParagraph('This Agreement is cryptographically bound to the zkpCare enrollment system. The following values are registered on the sequencer network and can be independently verified:'));
  s.push(bodyParagraph('Agreement Commitment (Poseidon Hash):'));
  s.push(new Paragraph({ spacing: { after: 80 }, children: [new TextRun({ text: commitment, font: 'Courier New', size: 18 })] }));
  s.push(bodyParagraph('Document Hash (SHA-256):'));
  s.push(new Paragraph({ spacing: { after: 80 }, children: [new TextRun({ text: documentHash, font: 'Courier New', size: 18 })] }));

  // ── 10. Officer Attestation and Digital Signatures ──
  s.push(headerParagraph('10. Officer Attestation and Digital Signatures'));
  if (signerName && signerTitle) {
    s.push(bodyParagraph(`I, ${signerName}, ${signerTitle} of ${terms.companyName}, hereby attest that:`));
    s.push(bodyParagraph('(a) I have full authority to execute this Agreement on behalf of the Employer;'));
    s.push(bodyParagraph('(b) I have reviewed the terms of this Agreement in their entirety;'));
    s.push(bodyParagraph('(c) The information provided in the application is true, complete, and accurate;'));
    s.push(bodyParagraph('(d) I understand that this digital signature is legally binding under the ESIGN Act (15 USC §7001) and UETA.'));
    s.push(bodyParagraph(''));
    s.push(bodyParagraph(`Signer: ${signerName}`));
    s.push(bodyParagraph(`Title: ${signerTitle}`));
  }
  s.push(bodyParagraph('Employer Signature: ' + employerSignature.slice(0, 64) + '...'));
  s.push(bodyParagraph('Insurer Signature: ' + insurerSignature.slice(0, 64) + '...'));
  s.push(bodyParagraph('Insurer Public Key: ' + insurerPublicKeyHex));
  s.push(bodyParagraph(`Signed: ${new Date().toISOString().slice(0, 10)}`));

  const doc = new Document({ sections: [{ children: s }] });
  return Buffer.from(await Packer.toBuffer(doc));
}
