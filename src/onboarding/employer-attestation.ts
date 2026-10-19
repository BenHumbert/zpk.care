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
import {
  createHash,
  createPublicKey,
  createPrivateKey,
  timingSafeEqual,
  verify as ed25519Verify,
  type KeyObject,
} from 'crypto';
import { Poseidon, Encoding, Field } from 'o1js';
import { hashString, dateToField } from '../zkp/hash-utils.js';
import type { AgreementTerms, AgreementPlanTerms, EmployerAttestation, EmployerApplication, BenefitPlanConfig } from '../l2/l2-types.js';
import { planAsPublished, publishedTermsOf } from '../l2/plan-terms.js';
import { dispensingFeeOf } from '../fulfillment/nadac-pricing.js';
import {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  HeadingLevel, AlignmentType, WidthType,
} from 'docx';

// ─── Agreement Terms ────────────────────────────────────────

/**
 * The agreement an employer signs and one plan in it (src/l2/l2-types.ts): each selected plan that is published, at the
 * terms its members are billed; a selected plan with no published terms is listed in unavailablePlanIds.
 */
export type { AgreementTerms, AgreementPlanTerms };

/**
 * The terms version agreements are generated under. 2026.2: the commitment covers every term the plan was published
 * with, its fee, formulary and network, and its family limits.
 */
export const AGREEMENT_TERMS_VERSION = '2026.2';

/**
 * The version of agreements signed before 2026.2, whose commitment covered each plan's copay, deductible, OOP max and
 * annual max only (attestationTermsStatus still recognises them).
 */
export const LEGACY_AGREEMENT_TERMS_VERSION = '2026.1';

// ─── Agreement Commitment ───────────────────────────────────

/** The Poseidon commitment over an agreement's identity, its per-plan terms (as one string) and its version. */
function commitmentOver(
  agreement: { agreementId: string; employerId: string; enrollmentCap: number; effectiveDate: string; termsVersion: string },
  planFinancials: string,
  signerName?: string,
  signerTitle?: string,
): string {
  const fields = [
    hashString(agreement.agreementId),
    hashString(agreement.employerId),
    hashString(planFinancials),
    Field(BigInt(agreement.enrollmentCap)),
    dateToField(agreement.effectiveDate),
    hashString(agreement.termsVersion),
  ];

  // Include signer identity in commitment — atomic: both or neither (matches buildAttestationMessage)
  if (signerName && signerTitle) {
    fields.push(hashString(signerName));
    fields.push(hashString(signerTitle));
  }

  return Poseidon.hash(fields).toString();
}

/**
 * Compute the Poseidon commitment over structured agreement terms.
 * Includes ALL material financial fields + signer identity. Per plan, every term it was published with: coverage
 * type, copay, deductible, OOP max, annual max, the family deductible, OOP max and annual max (the fill circuit pools
 * a family against them), the dispensing fee every fill is charged and where it comes from, and the published
 * formulary and network roots. So a plan republished with any other terms no longer matches an agreement signed
 * before (see attestationTermsStatus).
 */
export function computeAgreementCommitment(terms: AgreementTerms, signerName?: string, signerTitle?: string): string {
  const planFinancials = terms.selectedPlans
    .slice()
    .sort((a, b) => a.planId.localeCompare(b.planId))
    .map(p => [
      p.planId, p.coverageType, p.copayAmountCents, p.deductibleAmountCents, p.oopMaxCents, p.annualBenefitMaxCents,
      p.familyDeductibleAmountCents, p.familyOopMaxCents, p.familyAnnualBenefitMaxCents,
      p.dispensingFeeCents, p.dispensingFeeSource, p.formularyRoot, p.networkRoot,
    ].join(':'))
    .join(';');
  return commitmentOver(terms, planFinancials, signerName, signerTitle);
}

/**
 * The commitment an attestation signed before 2026.2 carries if its plans still bill what it covered: per plan the
 * copay, deductible, OOP max and annual max (read from the plans as published), under LEGACY_AGREEMENT_TERMS_VERSION.
 * That format took every authorized plan the sequencer held, so a plan it cannot find is left out, as it was then.
 */
function legacyAgreementCommitment(
  att: Pick<EmployerAttestation, 'applicationId' | 'employerId' | 'authorizedPlanIds' | 'enrollmentCap' | 'effectiveDate'>,
  plans: BenefitPlanConfig[],
): string {
  const planFinancials = (att.authorizedPlanIds ?? [])
    .map((planId) => plans.find((p) => p && p.planId === planId))
    .filter((p): p is BenefitPlanConfig => !!p)
    .map((p) => planAsPublished(p))
    .sort((a, b) => a.planId.localeCompare(b.planId))
    .map((p) => `${p.planId}:${p.copayAmountCents}:${p.deductibleAmountCents}:${p.oopMaxCents}:${p.annualBenefitMaxCents}`)
    .join(';');
  return commitmentOver({
    agreementId: `AGR-${att.applicationId}`,
    employerId: att.employerId,
    enrollmentCap: att.enrollmentCap,
    effectiveDate: att.effectiveDate,
    termsVersion: LEGACY_AGREEMENT_TERMS_VERSION,
  }, planFinancials);
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

/**
 * Verify the **employer's** signature, against the key recorded in the attestation.
 *
 * Reading the key from the signed document is normally meaningless — it lets the document carry
 * its own trust anchor — and that is exactly what A-29 says. It is sound **only** in combination
 * with `verifyInsurerSignature` against a pinned key, because the insurer counter-signs the whole
 * attestation, and before it does so it verifies this employer signature against the public key in
 * its own approved application record (`marketplace-routes.ts` sign handler). So the insurer's
 * counter-signature is what attests that this key is the right one.
 *
 * A caller that checks only this function is checking nothing. The sequencer checks both.
 */
export function verifyEmployerSignature(att: EmployerAttestation): boolean {
  return verifyAttestationSignature(att, att.employerSignature, att.publicKeyHex);
}

/**
 * Verify the **insurer's** counter-signature against a key the verifier already trusts.
 *
 * This used to read `att.insurerPublicKeyHex` — the key inside the attestation — so anyone could
 * generate a keypair, sign an employer attestation with it, and have the sequencer accept the
 * registration. That is finding A-29, and it is the same mistake A10a fixed for NFC attestations.
 *
 * The insurer is the attestation authority here, so its key is the one anchor that has to be
 * pinned out of band. The sequencer gets it from configuration at boot.
 */
export function verifyInsurerSignature(
  att: EmployerAttestation,
  expectedInsurerPublicKeyHex: string,
): boolean {
  if (!expectedInsurerPublicKeyHex || expectedInsurerPublicKeyHex.length !== 64) {
    // Fail closed. A verifier with no pinned insurer key cannot tell a real attestation from one
    // an attacker signed with their own keypair, which is finding A-29.
    return false;
  }
  // The attestation must name the key we already trust, compared in constant time and before the
  // signature is checked.
  const claimed = Buffer.from(att.insurerPublicKeyHex ?? '', 'hex');
  const trusted = Buffer.from(expectedInsurerPublicKeyHex, 'hex');
  if (claimed.length !== trusted.length || !timingSafeEqual(claimed, trusted)) return false;

  return verifyAttestationSignature(att, att.insurerSignature, expectedInsurerPublicKeyHex);
}


// ─── Insurer signing identity (phase A item A9, findings A-14 and A-29) ────────────────────

/** PKCS8 DER prefix for Ed25519 private keys. */
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/*
 * The insurer's attestation keypair, derived from a **dedicated** seed.
 *
 * It used to be derived from `ZKTRIDENT_ADMIN_TOKEN`. Finding A-14 is that one secret is the whole
 * network's authority; this was its sharpest edge, because a bearer token being reused as a
 * signing seed is worse than one being shared. A bearer token is something you present; a signing
 * key is something that makes statements attributable to you. The admin token is given to every
 * child node at boot and is the literal string `admin123` in unsecure mode, so anyone holding it
 * could counter-sign employer attestations as the insurer.
 *
 * The signing helper's own comment already said "NOT the admin token"; only the caller was wrong.
 */
export function deriveInsurerKeypair(signingSeed: string): {
  privateKey: KeyObject;
  publicKeyHex: string;
} {
  if (!signingSeed) throw new Error('No insurer signing seed configured');
  const seed = createHash('sha256').update('zkpcare-insurer-signing:' + signingSeed).digest();
  const privateKey = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
  seed.fill(0);
  const spkiDer = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  return { privateKey, publicKeyHex: Buffer.from(spkiDer).subarray(12).toString('hex') };
}

/** The public half only, for configuring a verifier that must pin it. */
export function insurerPublicKeyFromSeed(signingSeed: string): string {
  return deriveInsurerKeypair(signingSeed).publicKeyHex;
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

/**
 * The agreement for an application, from the plans as their members are billed: each selected plan's published terms
 * (planAsPublished) and the fee a fill on it is charged. A selected plan that has no published terms (never published,
 * or published before the terms were kept) binds no member, so it is listed in unavailablePlanIds rather than agreed to.
 */
export function buildAgreementTerms(
  application: Pick<EmployerApplication, 'applicationId' | 'employerId' | 'companyName' | 'selectedPlanIds' | 'effectiveDate' | 'enrollmentCap'>,
  plans: BenefitPlanConfig[],
  insurerName: string = 'zkpCare Network',
  termsVersion: string = AGREEMENT_TERMS_VERSION,
): AgreementTerms {
  const selectedPlans: AgreementPlanTerms[] = [];
  const unavailablePlanIds: string[] = [];
  for (const planId of application.selectedPlanIds) {
    const plan = plans.find((p) => p && p.planId === planId);
    const published = publishedTermsOf(plan);
    if (!plan || !published) {
      unavailablePlanIds.push(planId);
      continue;
    }
    const billed = planAsPublished(plan);
    let fee: ReturnType<typeof dispensingFeeOf>;
    try {
      fee = dispensingFeeOf(billed);
    } catch {
      // a stored fee no fill could be charged (the plan store refuses one); the plan is not agreed to at it
      unavailablePlanIds.push(planId);
      continue;
    }
    selectedPlans.push({
      planId: plan.planId,
      planName: plan.name,
      coverageType: billed.coverageType,
      copayAmountCents: billed.copayAmountCents,
      deductibleAmountCents: billed.deductibleAmountCents,
      oopMaxCents: billed.oopMaxCents,
      annualBenefitMaxCents: billed.annualBenefitMaxCents,
      familyDeductibleAmountCents: billed.familyDeductibleAmountCents,
      familyOopMaxCents: billed.familyOopMaxCents,
      familyAnnualBenefitMaxCents: billed.familyAnnualBenefitMaxCents,
      dispensingFeeCents: fee.dispensingFeeCents,
      dispensingFeeSource: fee.dispensingFeeSource,
      formularyRoot: published.formularyRoot,
      networkRoot: published.networkRoot,
    });
  }

  return {
    agreementId: `AGR-${application.applicationId}`,
    applicationId: application.applicationId,
    employerId: application.employerId,
    companyName: application.companyName,
    selectedPlans,
    unavailablePlanIds,
    effectiveDate: application.effectiveDate,
    enrollmentCap: application.enrollmentCap,
    insurerName,
    termsVersion,
    generatedAt: Date.now(),
  };
}

/** Whether an attestation's terms still describe what its plans' members are billed: see attestationTermsStatus. */
export interface AttestationTermsStatus {
  /** The terms it committed to are no longer what its plans' members are billed */
  termsChanged: boolean;
  /**
   * It was signed before 2026.2, so it commits to each plan's copay, deductible, OOP max and annual max only, and those
   * are unchanged; it does not cover the fee, formulary, network or family limits. The employer can sign the full terms.
   */
  signedBeforeFullTerms: boolean;
  /** The commitment of the agreement its authorized plans make now */
  currentCommitment: string;
  /** Its authorized plans that have no published terms now */
  unavailablePlanIds: string[];
}

/**
 * Whether an employer's attestation still commits to what its plans' members are billed. The agreement it was signed
 * over is rebuilt from the attestation's own fields (application, employer, authorized plans, cap, effective date) and
 * the plans as they are published now, and that commitment is compared with the one the attestation carries. They
 * differ when a plan was published again with other terms, or withdrawn, after the employer signed. An attestation
 * signed before 2026.2 is compared with its own format (legacyAgreementCommitment): if the terms it covered are
 * unchanged it is reported as signedBeforeFullTerms, not as a terms change. The employer can then sign the current
 * terms (attestation seq + 1). Nothing here blocks a publish or an enrollment.
 */
export function attestationTermsStatus(
  att: Pick<EmployerAttestation, 'applicationId' | 'employerId' | 'authorizedPlanIds' | 'enrollmentCap' | 'effectiveDate' | 'agreementCommitment'>,
  plans: BenefitPlanConfig[],
): AttestationTermsStatus {
  const terms = buildAgreementTerms({
    applicationId: att.applicationId,
    employerId: att.employerId,
    companyName: '',   // not committed to
    selectedPlanIds: att.authorizedPlanIds ?? [],
    effectiveDate: att.effectiveDate,
    enrollmentCap: att.enrollmentCap,
  }, plans);
  const currentCommitment = computeAgreementCommitment(terms);
  const status = { currentCommitment, unavailablePlanIds: terms.unavailablePlanIds };
  if (currentCommitment === att.agreementCommitment) return { termsChanged: false, signedBeforeFullTerms: false, ...status };
  if (legacyAgreementCommitment(att, plans) === att.agreementCommitment) return { termsChanged: false, signedBeforeFullTerms: true, ...status };
  return { termsChanged: true, signedBeforeFullTerms: false, ...status };
}

// ─── DOCX Agreement Generation ──────────────────────────────

function fmtCents(cents: number): string {
  return '$' + (cents / 100).toFixed(2);
}

/** An OOP or benefit limit: 0 means the plan sets no limit (the fill circuit tests each for greater than 0). */
function fmtLimit(cents: number): string {
  return cents > 0 ? fmtCents(cents) : 'No limit';
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
    width: { size: 20, type: WidthType.PERCENTAGE },
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
  const s: Array<Paragraph | Table> = [];

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
    s.push(bodyParagraph('No published plans selected.'));
  } else {
    s.push(bodyParagraph('Members are billed under the terms each plan was last published with. Each fill costs the NADAC price per unit times the quantity dispensed, plus the plan\'s dispensing fee.'));
    const headerRow = new TableRow({ children: [cell('Plan', true), cell('Copay', true), cell('Deductible', true), cell('OOP Max', true), cell('Annual Max', true), cell('Dispensing Fee', true)] });
    const planRows = terms.selectedPlans.map(p => new TableRow({
      children: [cell(p.planName), cell(fmtCents(p.copayAmountCents)), cell(fmtCents(p.deductibleAmountCents)), cell(fmtLimit(p.oopMaxCents)),
        cell(fmtLimit(p.annualBenefitMaxCents)), cell(fmtCents(p.dispensingFeeCents) + (p.dispensingFeeSource === 'network-default' ? ' (network default)' : ''))],
    }));
    s.push(new Table({ rows: [headerRow, ...planRows], width: { size: 100, type: WidthType.PERCENTAGE } }));
    s.push(bodyParagraph('Family limits: the out-of-pocket and benefit amounts a family\'s members count together.'));
    const familyHeader = new TableRow({ children: [cell('Plan', true), cell('Family Deductible', true), cell('Family OOP Max', true), cell('Family Annual Max', true)] });
    const familyRows = terms.selectedPlans.map(p => new TableRow({
      children: [cell(p.planName), cell(fmtCents(p.familyDeductibleAmountCents)), cell(fmtLimit(p.familyOopMaxCents)), cell(fmtLimit(p.familyAnnualBenefitMaxCents))],
    }));
    s.push(new Table({ rows: [familyHeader, ...familyRows], width: { size: 100, type: WidthType.PERCENTAGE } }));
    for (const p of terms.selectedPlans) {
      s.push(bodyParagraph(`Published formulary root for ${p.planName} (${p.planId}):`));
      s.push(new Paragraph({ spacing: { after: 80 }, children: [new TextRun({ text: p.formularyRoot, font: 'Courier New', size: 18 })] }));
      s.push(bodyParagraph(`Published provider network root for ${p.planName} (${p.planId}):`));
      s.push(new Paragraph({ spacing: { after: 80 }, children: [new TextRun({ text: p.networkRoot, font: 'Courier New', size: 18 })] }));
    }
  }
  if (terms.unavailablePlanIds.length > 0) {
    s.push(bodyParagraph(`Not covered by this Agreement, because they had no published terms when it was signed: ${terms.unavailablePlanIds.join(', ')}. A plan published later is covered only under a new Agreement that the Employer signs.`));
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
