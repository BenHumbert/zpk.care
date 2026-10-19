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
 * Marketplace Routes — Employer self-service onboarding via the insurer node.
 *
 * Flow: Browse Plans → Apply → Sign Agreement → Activate
 *
 * Council fixes applied:
 *   - Timestamp stored in agreement cache, employer submits ts with signature
 *   - Insurer signs with SequencerAttestationAuthority private key (no fallback)
 *   - Status only transitions to 'signed' AFTER sequencer confirms
 *   - Application IDs use 128-bit entropy (randomBytes(16))
 *   - Agreement cache invalidated when re-fetched
 *   - DOCX download requires signed/active status
 *   - Config endpoint is POST (not GET) to avoid idempotency violation
 *   - Duplicate employer attestation blocked on sequencer
 *   - Content-Disposition filename sanitized
 */
import { randomBytes, createHash, timingSafeEqual, sign as ed25519Sign, createPrivateKey, createPublicKey } from 'crypto';
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import type { NautilusAppServer } from '../nautilus-app-server.js';
import type { RouteRegistration } from '../nautilus-app-types.js';
import type { EmployerApplication, EmployerAttestation, BenefitPlanConfig } from '../../l2/l2-types.js';
import { planAsPublished, publishedTermsOf } from '../../l2/plan-terms.js';
import {
  computeAgreementCommitment,
  computeDocumentHash,
  buildAttestationMessage,
  buildAgreementTerms,
  attestationTermsStatus,
  verifyAttestationSignature,
  generateAgreementDocx,
  deriveInsurerKeypair,
  type AgreementTerms,
} from '../../onboarding/employer-attestation.js';

// ─── Shared Application Store (persisted to stateDir) ───────

const applicationStore: Map<string, EmployerApplication> = new Map();
const agreementCache: Map<string, { terms: AgreementTerms; commitment: string; documentHash: string; ts: number; attestationSeq: number }> = new Map();
const docxCache: Map<string, Buffer> = new Map();

// Phase C: async tenant spawn jobs. Activate returns 202 immediately with a
// jobKey; frontend polls for completion. Keyed by applicationId since only
// one spawn can be in-flight per application.
interface ActivationJob {
  status: 'pending' | 'complete' | 'error';
  startedAt: number;
  result?: { employerNodeUrl: string; adminToken: string; hrToolSetup: import('../employer-orchestrator.js').HrToolSetup };
  error?: string;
}
const activationJobs: Map<string, ActivationJob> = new Map();

let applicationStorePath: string | null = null;

/** Load application store from disk */
function loadApplicationStore(): void {
  if (!applicationStorePath || !existsSync(applicationStorePath)) return;
  try {
    const json = readFileSync(applicationStorePath, 'utf8');
    const entries = JSON.parse(json) as EmployerApplication[];
    applicationStore.clear();
    for (const app of entries) {
      applicationStore.set(app.applicationId, app);
    }
    console.log('[marketplace] Loaded %d applications from disk', entries.length);
  } catch (e: any) {
    console.warn('[marketplace] Failed to load applications:', e.message);
  }
}

/** Save application store to disk */
/** Save application store atomically: write temp → rename (crash-safe) */
function saveApplicationStore(): void {
  if (!applicationStorePath) return;
  try {
    const entries = Array.from(applicationStore.values());
    const json = JSON.stringify(entries, null, 2);
    const tmpPath = applicationStorePath + '.tmp.' + process.pid;
    writeFileSync(tmpPath, json);
    renameSync(tmpPath, applicationStorePath);
  } catch (e: any) {
    console.warn('[marketplace] Failed to save applications:', e.message);
  }
}

/** 128-bit entropy application ID */
function generateApplicationId(): string {
  const rand = randomBytes(16).toString('hex');
  return `EMPAPP-${rand}`;
}

/*
 * ── The activation secret (phase A item A8, finding A-4) ──────────────────────────────────
 *
 * `GET /marketplace/api/activate-status/:id` returned the employer node's admin token in clear
 * to anyone who presented the application ID. The audit retrieved one and replayed it against
 * that tenant's roster for a 200, reading token IDs, wallet IDs and hashes.
 *
 * The code's own comment on the rekey route says the intent: "applicationId (128-bit random)
 * acts as the bearer secret". The entropy is fine. The problem is that the same value is also
 * an identifier, and this one is written to `marketplace-applications.json` in plaintext,
 * printed to the console on submission, and carried in URL paths where any proxy or access log
 * records it. A secret that is logged, filed in the clear and put in a URL is not a secret.
 *
 * So the two roles are split. `applicationId` stays the identifier and keeps doing all of the
 * above. A separate secret is generated at submission, returned **once**, and kept only as a
 * SHA-256 hash. Credentials are collected by presenting it in a request **body**, once; the
 * progress poll stays open because progress is not a credential.
 *
 * Why not gate the whole thing behind insurer admin, as the plan item first proposed: that would
 * end self-service employer signup, which is a product goal rather than an accident. This closes
 * the hole and keeps the employer able to finish their own activation.
 */

function generateClaimSecret(): string {
  return randomBytes(32).toString('base64url');
}

function hashClaimSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf-8').digest('hex');
}

/** Constant-time compare, so a wrong secret leaks nothing through timing. */
function claimSecretMatches(application: EmployerApplication, presented: string): boolean {
  if (!application.claimSecretHash || !presented) return false;
  const expected = Buffer.from(application.claimSecretHash, 'hex');
  const actual = Buffer.from(hashClaimSecret(presented), 'hex');
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

export function getApplicationStore(): Map<string, EmployerApplication> {
  return applicationStore;
}

// ─── Insurer Signing Helper ─────────────────────────────────

/** PKCS8 DER prefix for Ed25519 private keys */
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/**
 * Sign a message with the insurer's Ed25519 key.
 * Uses a deterministic key derived from a dedicated signing seed (NOT the admin token).
 * The signing seed should be configured via environment variable in production.
 */
function insurerSign(message: Buffer, signingSecret: string): { signature: string; publicKeyHex: string } {
  // Derivation lives in employer-attestation.ts so the signer and anything that needs to pin the
  // public half cannot drift apart.
  const { privateKey, publicKeyHex } = deriveInsurerKeypair(signingSecret);
  const sig = ed25519Sign(null, message, privateKey);
  return { signature: Buffer.from(sig).toString('hex'), publicKeyHex };
}

// ─── Route Builder ──────────────────────────────────────────

export function buildMarketplaceRoutes(server: NautilusAppServer): RouteRegistration[] {
  const routes: RouteRegistration[] = [];

  // Initialize persistence: load from stateDir
  const stateDir = server.getConfig().stateDir;
  if (stateDir) {
    mkdirSync(stateDir, { recursive: true });
    applicationStorePath = join(stateDir, 'marketplace-applications.json');
    loadApplicationStore();
  }

  // Rate limiting: max applications per minute
  const recentApplications: number[] = [];
  const MAX_APPS_PER_MINUTE = 10;

  function checkRateLimit(): boolean {
    const now = Date.now();
    while (recentApplications.length > 0 && recentApplications[0] < now - 60_000) recentApplications.shift();
    return recentApplications.length < MAX_APPS_PER_MINUTE;
  }

  // ══════════════════════════════════════════════════════════
  //  PLAN BROWSING (Public)
  // ══════════════════════════════════════════════════════════

  routes.push({
    method: 'GET',
    path: '/marketplace/api/plans',
    handler: async (_req, res) => {
      try {
        const seqUrl = server.getConfig().sequencerUrl.replace(/\/+$/, '');
        const resp = await fetch(`${seqUrl}/rpc`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'l2_getPlans', params: {} }),
        });
        const json = await resp.json() as any;
        const plans: BenefitPlanConfig[] = Array.isArray(json.result) ? json.result : [];
        // Plan-bound formularies: an employer is offered a plan only once it has published terms, and is shown those
        // terms (what members are billed), not a draft the insurer is still editing.
        server.sendResponse(res, 200, true, plans.filter((p) => publishedTermsOf(p)).map((p) => planAsPublished(p)));
      } catch {
        server.sendResponse(res, 502, false, undefined, 'Cannot fetch plans');
      }
    },
  });

  routes.push({
    method: 'GET',
    path: '/marketplace/api/plans/:planId',
    handler: async (_req, res, params) => {
      try {
        const seqUrl = server.getConfig().sequencerUrl.replace(/\/+$/, '');
        const resp = await fetch(`${seqUrl}/rpc`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'l2_getPlan', params: { planId: params.planId } }),
        });
        const json = await resp.json() as any;
        // As the list: a plan with no published terms is not offered, and a published one is shown as published.
        if (!json.result || !publishedTermsOf(json.result)) return server.sendResponse(res, 404, false, undefined, 'Plan not found');
        server.sendResponse(res, 200, true, planAsPublished(json.result as BenefitPlanConfig));
      } catch {
        server.sendResponse(res, 502, false, undefined, 'Cannot fetch plan');
      }
    },
  });

  // ══════════════════════════════════════════════════════════
  //  APPLICATION (Rate-limited, 128-bit ID)
  // ══════════════════════════════════════════════════════════

  // Phase B: reusable employerId collision check. Queries BOTH the local
  // applicationStore (in-flight applications) AND the sequencer's registered
  // attestation store. Returns { available, reason, warning } — the warning
  // flag tells callers that the check is partial (e.g. sequencer unreachable).
  async function checkEmployerIdAvailable(
    employerId: string,
    strict: boolean,
  ): Promise<{ available: boolean; reason?: string; warning?: string }> {
    // Local: any non-denied application with this ID blocks
    for (const app of applicationStore.values()) {
      if (app.employerId === employerId && app.status !== 'denied') {
        return { available: false, reason: `An application for "${employerId}" is already ${app.status}` };
      }
    }
    // Remote: any existing attestation on the sequencer blocks.
    try {
      const seqUrl = server.getConfig().sequencerUrl.replace(/\/+$/, '');
      const resp = await fetch(`${seqUrl}/rpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'l2_getEmployerAttestation', params: { employerId } }),
      });
      const json = await resp.json() as any;
      if (json.result && json.result.employerId === employerId) {
        return { available: false, reason: `"${employerId}" is already registered on the sequencer` };
      }
    } catch {
      // Sequencer unreachable — we can't verify remote uniqueness.
      // strict=true  (used by POST /apply): fail-closed, reject the request
      // strict=false (used by precheck):    pass-through with a warning
      if (strict) {
        return { available: false, reason: 'Cannot reach sequencer to verify uniqueness. Please try again.' };
      }
      return { available: true, warning: 'Could not reach sequencer to verify remote uniqueness — local check only' };
    }
    return { available: true };
  }

  // Phase B: live-validation endpoint. The marketplace frontend calls this
  // as the employer types, debounced, so they get immediate feedback.
  routes.push({
    method: 'GET',
    path: '/marketplace/api/check-employer-id/:employerId',
    handler: async (_req, res, params) => {
      const employerId = (params.employerId || '').trim();
      if (!employerId) {
        return server.sendResponse(res, 400, false, undefined, 'employerId is required');
      }
      // Format guard — employerIds must be alphanumeric + hyphen/underscore,
      // 2-64 chars. This keeps them safe to use in URL paths and filenames.
      if (!/^[A-Za-z0-9_-]{2,64}$/.test(employerId)) {
        return server.sendResponse(res, 200, true, {
          available: false,
          reason: 'employerId must be 2-64 characters, letters/numbers/hyphens/underscores only',
        });
      }
      // Precheck: strict=false — sequencer-unreachable is a warning, not a block
      const result = await checkEmployerIdAvailable(employerId, false);
      server.sendResponse(res, 200, true, result);
    },
  });

  routes.push({
    method: 'POST',
    path: '/marketplace/api/apply',
    handler: async (_req, res, _params, _query, body) => {
      if (!checkRateLimit()) {
        return server.sendResponse(res, 429, false, undefined, 'Too many applications. Try again in a minute.');
      }

      const b = body as any;
      if (!b?.companyName || !b?.contactName || !b?.contactEmail || !b?.employerId ||
          !b?.selectedPlanIds || !Array.isArray(b.selectedPlanIds) || b.selectedPlanIds.length === 0 ||
          !b?.effectiveDate || !b?.enrollmentCap || !b?.publicKeyHex) {
        return server.sendResponse(res, 400, false, undefined, 'Missing required fields');
      }

      if (typeof b.publicKeyHex !== 'string' || !/^[0-9a-f]{64}$/i.test(b.publicKeyHex)) {
        return server.sendResponse(res, 400, false, undefined, 'Invalid public key format (expected 64 hex characters)');
      }

      // Format guard for employerId (matches the check-employer-id endpoint)
      if (!/^[A-Za-z0-9_-]{2,64}$/.test(b.employerId)) {
        return server.sendResponse(res, 400, false, undefined,
          'employerId must be 2-64 characters, letters/numbers/hyphens/underscores only');
      }

      // Phase B: authoritative collision check (local + sequencer).
      // strict=true — sequencer-unreachable is a hard block.
      const availability = await checkEmployerIdAvailable(b.employerId, true);
      if (!availability.available) {
        return server.sendResponse(res, 409, false, undefined, availability.reason || 'employerId is not available');
      }

      const applicationId = generateApplicationId();
      // Returned once, below, and never recoverable from the store or the logs.
      const claimSecret = generateClaimSecret();
      const application: EmployerApplication = {
        applicationId,
        claimSecretHash: hashClaimSecret(claimSecret),
        employerId: b.employerId,
        companyName: b.companyName,
        contactName: b.contactName,
        contactEmail: b.contactEmail,
        contactPhone: b.contactPhone || undefined,
        ein: b.ein || undefined,
        state: b.state || '',
        industry: b.industry || undefined,
        selectedPlanIds: b.selectedPlanIds,
        effectiveDate: b.effectiveDate.replace(/-/g, ''),
        enrollmentCap: Number(b.enrollmentCap),
        publicKeyHex: b.publicKeyHex,
        submittedAt: Date.now(),
        status: 'submitted',
      };

      applicationStore.set(applicationId, application);
      saveApplicationStore();
      recentApplications.push(Date.now());
      console.log('[marketplace] Application submitted: %s (%s)', applicationId, b.companyName);

      /*
       * One string for the employer to keep. The identifier before the dot is what appears in
       * URLs and logs; the part after it is the secret and appears nowhere else, including in
       * the console line above, which prints only the identifier.
       */
      server.sendResponse(res, 201, true, {
        applicationId,
        activationCode: `${applicationId}.${claimSecret}`,
        status: 'submitted',
        message:
          'Application received. Save your activation code now — it is shown once and cannot ' +
          'be recovered. You need it to collect your administrator credentials.',
      });
    },
  });

  // ══════════════════════════════════════════════════════════
  //  STATUS CHECK
  // ══════════════════════════════════════════════════════════

  routes.push({
    method: 'GET',
    path: '/marketplace/api/status/:applicationId',
    handler: async (_req, res, params) => {
      const app = applicationStore.get(params.applicationId);
      if (!app) return server.sendResponse(res, 404, false, undefined, 'Application not found');
      server.sendResponse(res, 200, true, {
        applicationId: app.applicationId,
        employerId: app.employerId,
        companyName: app.companyName,
        status: app.status,
        submittedAt: app.submittedAt,
        approvedAt: app.approvedAt || null,
        denialReason: app.denialReason || null,
        // Whether an IRS letter is on file, so the employer's screen offers the upload only until one is.
        documentUploaded: !!app.cp575DocumentId,
      });
    },
  });

  // ══════════════════════════════════════════════════════════
  //  CP 575 DOCUMENT UPLOAD
  // ══════════════════════════════════════════════════════════

  routes.push({
    method: 'POST',
    path: '/marketplace/api/upload-document/:applicationId',
    handler: async (req, res, params) => {
      const app = applicationStore.get(params.applicationId);
      if (!app) return server.sendResponse(res, 404, false, undefined, 'Application not found');
      if (app.status !== 'submitted' && app.status !== 'needs_documents' && app.status !== 'under_review') {
        return server.sendResponse(res, 409, false, undefined, `Cannot upload documents in status: ${app.status}`);
      }

      // Check resubmission cap
      const resubCount = app.resubmissionCount ?? 0;
      if (resubCount >= 3) {
        app.status = 'denied';
        app.denialReason = 'Maximum document resubmission attempts exceeded';
        saveApplicationStore();
        return server.sendResponse(res, 403, false, undefined, 'Maximum resubmission attempts reached. Application denied.');
      }

      // Read raw body as buffer for PDF validation
      const chunks: Buffer[] = [];
      let totalSize = 0;
      const MAX_DOC_SIZE = 5 * 1024 * 1024; // 5MB

      try {
        await new Promise<void>((resolve, reject) => {
          req.on('data', (chunk: Buffer) => {
            totalSize += chunk.length;
            if (totalSize > MAX_DOC_SIZE) { req.destroy(); reject(new Error('File too large (max 5MB)')); return; }
            chunks.push(chunk);
          });
          req.on('error', reject);
          req.on('end', resolve);
        });
      } catch (e: any) {
        return server.sendResponse(res, 413, false, undefined, e.message || 'Upload failed');
      }

      const fileBuffer = Buffer.concat(chunks);

      // Validate PDF magic bytes
      if (fileBuffer.length < 4 || fileBuffer.subarray(0, 4).toString('ascii') !== '%PDF') {
        return server.sendResponse(res, 400, false, undefined, 'Only PDF files are accepted. The uploaded file is not a valid PDF.');
      }

      // Store with UUID filename in stateDir/employer-documents/
      const stateDir = server.getConfig().stateDir;
      const docDir = join(stateDir, 'employer-documents');
      mkdirSync(docDir, { recursive: true });
      const docId = randomBytes(16).toString('hex');
      const docPath = join(docDir, `${docId}.pdf`);
      writeFileSync(docPath, fileBuffer);

      app.cp575DocumentId = docId;
      app.resubmissionCount = resubCount + 1;
      if (app.status === 'needs_documents') app.status = 'under_review';
      saveApplicationStore();

      console.log('[marketplace] CP 575 uploaded for %s (doc: %s, attempt %d/3)', app.employerId, docId, resubCount + 1);
      server.sendResponse(res, 200, true, { documentId: docId, resubmissionCount: resubCount + 1, maxAttempts: 3 });
    },
  });

  // Serve uploaded document (admin-only)
  routes.push({
    method: 'GET',
    path: '/marketplace/api/document/:applicationId',
    adminOnly: true,
    handler: async (_req, res, params) => {
      const app = applicationStore.get(params.applicationId);
      if (!app?.cp575DocumentId) return server.sendResponse(res, 404, false, undefined, 'No document uploaded');
      const stateDir = server.getConfig().stateDir;
      const docPath = join(stateDir, 'employer-documents', `${app.cp575DocumentId}.pdf`);
      try {
        const content = readFileSync(docPath);
        res.writeHead(200, {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `attachment; filename="cp575-${app.employerId.replace(/[^a-zA-Z0-9_-]/g, '_')}.pdf"`,
          'Content-Length': content.length,
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(content);
      } catch {
        server.sendResponse(res, 404, false, undefined, 'Document file not found');
      }
    },
  });

  // ══════════════════════════════════════════════════════════
  //  AGREEMENT TERMS (stores ts for signature consistency)
  // ══════════════════════════════════════════════════════════

  routes.push({
    method: 'GET',
    path: '/marketplace/api/agreement/:applicationId',
    handler: async (_req, res, params) => {
      const app = applicationStore.get(params.applicationId);
      if (!app) return server.sendResponse(res, 404, false, undefined, 'Application not found');
      if (app.status !== 'approved' && app.status !== 'signed' && app.status !== 'active') {
        return server.sendResponse(res, 409, false, undefined, `Status is ${app.status} — must be approved first`);
      }

      // Always recompute (invalidate cache) to pick up plan changes
      let plans: BenefitPlanConfig[] = [];
      try {
        const seqUrl = server.getConfig().sequencerUrl.replace(/\/+$/, '');
        const resp = await fetch(`${seqUrl}/rpc`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'l2_getPlans', params: {} }),
        });
        const json = await resp.json() as any;
        plans = json.result || [];
      } catch {
        return server.sendResponse(res, 502, false, undefined, 'Cannot fetch plans');
      }

      // Phase D: look up the existing attestation on the sequencer to compute
      // the next monotonic seq. If none exists, this is the first registration
      // (seq=0). If one exists, this is a renewal (seq = existing + 1). The
      // sequencer enforces this exact value at l2_registerEmployer time.
      let attestationSeq = 0;
      let existing: EmployerAttestation | null = null;
      try {
        const seqUrl = server.getConfig().sequencerUrl.replace(/\/+$/, '');
        const attResp = await fetch(`${seqUrl}/rpc`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'l2_getEmployerAttestation', params: { employerId: app.employerId } }),
        });
        const attJson = await attResp.json() as any;
        if (attJson.result && typeof attJson.result.attestationSeq === 'number') {
          existing = attJson.result as EmployerAttestation;
          attestationSeq = attJson.result.attestationSeq + 1;
        }
      } catch {
        return server.sendResponse(res, 502, false, undefined, 'Cannot reach sequencer to compute attestation seq');
      }

      // Plan-bound formularies: the agreement states what members are billed, each plan's published terms and fee.
      const terms = buildAgreementTerms(app, plans);
      const commitment = computeAgreementCommitment(terms);
      const documentHash = computeDocumentHash(terms);
      const ts = Math.floor(Date.now() / 1000);

      // Store ts and attestationSeq in cache so the sign endpoint uses the SAME values
      agreementCache.set(params.applicationId, { terms, commitment, documentHash, ts, attestationSeq });

      // An attestation already registered: say whether the terms it committed to are still what members are billed, whether
      // it was signed before agreements covered every published term, and which selected plans it does not authorize
      // that are published now. In each case the employer can sign these terms as the next attestation (attestationSeq).
      let signed: { attestationSeq: number; signedAt: number; termsChanged: boolean; signedBeforeFullTerms: boolean; plansToAdd: string[] } | null = null;
      if (existing) {
        const status = attestationTermsStatus(existing, plans);
        const authorized = new Set(existing.authorizedPlanIds ?? []);
        signed = {
          attestationSeq: existing.attestationSeq,
          signedAt: existing.ts,
          termsChanged: status.termsChanged,
          signedBeforeFullTerms: status.signedBeforeFullTerms,
          plansToAdd: terms.selectedPlans.map((p) => p.planId).filter((planId) => !authorized.has(planId)),
        };
      }

      server.sendResponse(res, 200, true, {
        terms,
        commitment,
        documentHash,
        ts,
        attestationSeq,
        signedAttestation: signed,
        canonicalMessage: buildAttestationMessage({
          employerId: app.employerId,
          publicKeyHex: app.publicKeyHex,
          // the plans the agreement covers, never a selected plan it lists as unavailable (its terms are not committed to)
          authorizedPlanIds: terms.selectedPlans.map((p) => p.planId),
          enrollmentCap: app.enrollmentCap,
          agreementCommitment: commitment,
          documentHash,
          effectiveDate: app.effectiveDate,
          ts,
          attestationSeq,
        }).toString('utf8'),
      });
    },
  });

  // ══════════════════════════════════════════════════════════
  //  SIGN AGREEMENT
  // ══════════════════════════════════════════════════════════

  routes.push({
    method: 'POST',
    path: '/marketplace/api/sign/:applicationId',
    handler: async (_req, res, params, _query, body) => {
      const app = applicationStore.get(params.applicationId);
      if (!app) return server.sendResponse(res, 404, false, undefined, 'Application not found');
      // Phase D: allow signing from `approved` (first sign) and from `signed`/`active`
      // (renewal — employer wants to add plans, rotate signer, etc.). The sequencer's
      // monotonic seq enforcement is the authoritative guard against replay.
      const allowedSignStatuses = ['approved', 'signed', 'active'];
      if (!allowedSignStatuses.includes(app.status)) {
        return server.sendResponse(res, 409, false, undefined, `Cannot sign: status is ${app.status}`);
      }
      const isRenewal = app.status === 'signed' || app.status === 'active';

      const b = body as {
        employerSignature?: string;
        ts?: number;
        signerName?: string;
        signerTitle?: string;
        reviewedAt?: number;
      } | undefined;
      if (!b?.employerSignature || typeof b.employerSignature !== 'string') {
        return server.sendResponse(res, 400, false, undefined, 'Missing employerSignature');
      }
      if (!b?.signerName || !b?.signerTitle) {
        return server.sendResponse(res, 400, false, undefined, 'Missing signerName or signerTitle');
      }

      // Store review timestamp per ESIGN §7001(c)(1)
      if (b.reviewedAt) app.reviewedAgreementAt = b.reviewedAt;

      const cached = agreementCache.get(params.applicationId);
      if (!cached) {
        return server.sendResponse(res, 409, false, undefined, 'Call GET /agreement first');
      }
      // An agreement covering no published plan states no terms anyone is billed under, so there is nothing to sign.
      if (cached.terms.selectedPlans.length === 0) {
        return server.sendResponse(res, 409, false, undefined,
          'None of the plans in this application is published, so the agreement covers no plan. The insurer must publish them first.');
      }

      // Use the ts and attestationSeq from the agreement cache exclusively.
      // Neither can be supplied by the client — both MUST come from the cache
      // populated by GET /agreement, so the server controls the canonical
      // message the employer signed. The client's `b.ts` is silently ignored.
      const ts = cached.ts;
      const attestationSeq = cached.attestationSeq;

      // The attestation authorizes the plans the signed agreement covers and nothing else: a selected plan with no published
      // terms is not committed to, so publishing it later does not admit it under this signature; the employer signs again
      // (attestation seq + 1) to add it, at the terms it is published with.
      const attestationBase = {
        employerId: app.employerId,
        publicKeyHex: app.publicKeyHex,
        authorizedPlanIds: cached.terms.selectedPlans.map((p) => p.planId),
        enrollmentCap: app.enrollmentCap,
        agreementCommitment: cached.commitment,
        documentHash: cached.documentHash,
        effectiveDate: app.effectiveDate,
        ts,
        attestationSeq,
        signerName: b.signerName,
        signerTitle: b.signerTitle,
      };

      // Verify employer signature against the canonical message
      if (!verifyAttestationSignature(attestationBase, b.employerSignature, app.publicKeyHex)) {
        return server.sendResponse(res, 403, false, undefined, 'Invalid employer signature');
      }

      /*
       * Insurer counter-signs with its **dedicated** signing seed (A9, finding A-14).
       *
       * This line read `server.getConfig().adminToken`, while the helper's own comment said "NOT
       * the admin token" — the helper was right and the caller was wrong. The admin token is given
       * to every child node at boot and is `admin123` in unsecure mode, so anyone holding it could
       * counter-sign as the insurer. Refusing to sign when the two are the same is a guard against
       * a deployment wiring them back together.
       */
      const message = buildAttestationMessage(attestationBase);
      const signingSecret = server.getConfig().insurerSigningSeed;
      if (!signingSecret) {
        return server.sendResponse(res, 500, false, undefined,
          'Insurer signing is not configured: set ZKTRIDENT_INSURER_SIGNING_SEED.');
      }
      if (signingSecret === server.getConfig().adminToken) {
        return server.sendResponse(res, 500, false, undefined,
          'Insurer signing seed must not be the admin token. See A-14.');
      }

      let insurerSig: { signature: string; publicKeyHex: string };
      try {
        insurerSig = insurerSign(message, signingSecret);
      } catch (e: any) {
        return server.sendResponse(res, 500, false, undefined, 'Insurer signing failed');
      }

      const attestation: EmployerAttestation = {
        v: 2,
        ...attestationBase,
        employerSignature: b.employerSignature,
        insurerSignature: insurerSig.signature,
        insurerPublicKeyHex: insurerSig.publicKeyHex,
        applicationId: app.applicationId,
      };

      // Register on sequencer — MUST succeed before marking signed
      try {
        const seqUrl = server.getConfig().sequencerUrl.replace(/\/+$/, '');
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };

        const regResp = await server.signedFetch(`${seqUrl}/rpc`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            jsonrpc: '2.0', id: 1,
            method: 'l2_registerEmployer',
            params: { attestation },
          }),
        });
        const regJson = await regResp.json() as any;
        if (regJson.error) {
          const errMsg = regJson.error.message || regJson.error;
          // Phase D: translate concurrent-seq race into a user-actionable message
          if (typeof errMsg === 'string' && errMsg.includes('Expected attestationSeq')) {
            // Clear the stale cache so the frontend's next refetch gets the real seq
            agreementCache.delete(params.applicationId);
            return server.sendResponse(res, 409, false, undefined,
              'The attestation sequence advanced while you were signing. Please refresh and sign again.');
          }
          return server.sendResponse(res, 502, false, undefined, 'Sequencer rejected attestation: ' + errMsg);
        }
      } catch (e: any) {
        return server.sendResponse(res, 502, false, undefined, 'Cannot register attestation — sequencer unreachable');
      }

      // Sequencer confirmed — now safe to update status
      server.registerPartnerKey(app.employerId, app.publicKeyHex);
      app.authorizedPlanIds = attestation.authorizedPlanIds;
      // On first signing, advance to 'signed'. On renewal, preserve the
      // existing 'active' status (a renewed active employer stays active).
      if (!isRenewal) {
        app.status = 'signed';
      }
      saveApplicationStore();

      // Generate DOCX (best effort — signing succeeds regardless)
      try {
        const docx = await generateAgreementDocx(
          cached.terms, cached.commitment, cached.documentHash,
          b.employerSignature, insurerSig.signature, insurerSig.publicKeyHex,
          b.signerName, b.signerTitle,
        );
        docxCache.set(params.applicationId, docx);
      } catch (e: any) {
        console.warn('[marketplace] DOCX generation failed:', e.message);
      }

      console.log('[marketplace] Agreement signed: %s (%s)', app.employerId, app.companyName);

      server.sendResponse(res, 200, true, {
        status: 'signed',
        attestation,
        docxAvailable: docxCache.has(params.applicationId),
      });
    },
  });

  // ══════════════════════════════════════════════════════════
  //  DOCX DOWNLOAD (requires signed/active status)
  // ══════════════════════════════════════════════════════════

  routes.push({
    method: 'GET',
    path: '/marketplace/api/docx/:applicationId',
    handler: async (_req, res, params) => {
      const app = applicationStore.get(params.applicationId);
      if (!app) return server.sendResponse(res, 404, false, undefined, 'Application not found');
      if (app.status !== 'signed' && app.status !== 'active') {
        return server.sendResponse(res, 409, false, undefined, 'Agreement not yet signed');
      }
      const docx = docxCache.get(params.applicationId);
      if (!docx) return server.sendResponse(res, 404, false, undefined, 'Document not yet generated');

      // Sanitize filename
      const safeId = app.employerId.replace(/[^a-zA-Z0-9_-]/g, '_');
      res.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Content-Disposition': `attachment; filename="agreement-${safeId}.docx"`,
        'Content-Length': docx.length,
      });
      res.end(docx);
    },
  });

  // ══════════════════════════════════════════════════════════
  //  ACTIVATION CONFIG (POST to avoid GET side-effects)
  // ══════════════════════════════════════════════════════════

  routes.push({
    method: 'POST',
    path: '/marketplace/api/activate/:applicationId',
    handler: async (_req, res, params) => {
      const app = applicationStore.get(params.applicationId);
      if (!app) return server.sendResponse(res, 404, false, undefined, 'Application not found');
      if (app.status !== 'signed' && app.status !== 'active') {
        return server.sendResponse(res, 409, false, undefined, 'Agreement not yet signed');
      }

      // Phase C: spawn a real employer node + HR Tool for this tenant.
      const sequencerUrl = server.getConfig().sequencerUrl;
      const insurerUrl = `http://localhost:${(server.getConfig() as any).port || 4004}`;
      // A9: the tenant is registered on the sequencer with the insurer node's own key, under the insurer role.
      if (!server.getConfig().nodeKey) {
        return server.sendResponse(res, 500, false, undefined,
          'The insurer node has no sequencer credential (ZKTRIDENT_NODE_KEY_SEED) — it cannot register tenants on the sequencer');
      }

      /*
       * Idempotency: if a job for this applicationId is already complete, report that.
       *
       * This branch also used to return `adminToken`, which is the second half of finding A-4:
       * re-POSTing activate for an already-provisioned tenant handed the token out again, so
       * closing only `activate-status` would have left the same credential on an open route one
       * request away. It now reports completion and nothing more; the token comes from
       * activate-credentials with the activation secret.
       */
      const existingJob = activationJobs.get(params.applicationId);
      if (existingJob && existingJob.status === 'complete' && existingJob.result) {
        return server.sendResponse(res, 200, true, {
          jobKey: params.applicationId,
          status: 'complete',
          employerId: app.employerId,
          sequencerUrl,
          insurerUrl,
          // what the registered attestation authorizes (older applications kept no copy: they authorized every selected plan)
          authorizedPlanIds: app.authorizedPlanIds ?? app.selectedPlanIds,
          enrollmentCap: app.enrollmentCap,
          publicKeyHex: app.publicKeyHex,
          effectiveDate: app.effectiveDate,
          employerNodeUrl: existingJob.result.employerNodeUrl,
          hrToolSetup: existingJob.result.hrToolSetup,
          credentialsCollected: Boolean(app.credentialsCollectedAt),
        });
      }
      if (existingJob && existingJob.status === 'pending') {
        return server.sendResponse(res, 202, true, {
          jobKey: params.applicationId,
          status: 'pending',
          message: 'Tenant spawn already in progress. Poll /marketplace/api/activate-status/:jobKey.',
        });
      }

      // Fresh spawn — start the job and return 202 immediately
      const job: ActivationJob = { status: 'pending', startedAt: Date.now() };
      activationJobs.set(params.applicationId, job);

      // Async spawn — do NOT await; fire-and-forget so the HTTP response
      // returns before the 30s NautilusAppServer timeout fires.
      (async () => {
        try {
          const { spawnEmployerTenant } = await import('../employer-orchestrator.js');
          const spawnResult = await spawnEmployerTenant({
            employerId: app.employerId,
            employerPubKeyHex: app.publicKeyHex,
            sequencerUrl,
            insurerUrl,
            signSequencerRequest: (m, p, b) => server.sequencerAuthHeaders(m, p, b),
          });
          job.status = 'complete';
          job.result = {
            employerNodeUrl: spawnResult.employerNodeUrl,
            hrToolSetup: spawnResult.hrToolSetup,
            adminToken: spawnResult.adminToken,
          };
          // Only flip app status after successful spawn
          app.status = 'active';
          saveApplicationStore();
          console.log('[marketplace] Tenant %s activated: %s', app.employerId, spawnResult.employerNodeUrl);
        } catch (e: any) {
          job.status = 'error';
          job.error = e?.message || 'unknown spawn error';
          console.error('[marketplace] Tenant spawn failed for %s: %s', app.employerId, job.error);
        }
      })();

      server.sendResponse(res, 202, true, {
        jobKey: params.applicationId,
        status: 'pending',
        message: 'Provisioning tenant infrastructure. Poll /marketplace/api/activate-status/:jobKey for progress.',
      });
    },
  });

  // Phase C: poll endpoint for async tenant spawn
  routes.push({
    method: 'GET',
    path: '/marketplace/api/activate-status/:jobKey',
    handler: async (_req, res, params) => {
      const app = applicationStore.get(params.jobKey);
      if (!app) return server.sendResponse(res, 404, false, undefined, 'Application not found');
      const job = activationJobs.get(params.jobKey);
      if (!job) return server.sendResponse(res, 404, false, undefined, 'No activation job for this application');

      const sequencerUrl = server.getConfig().sequencerUrl;
      const insurerUrl = `http://localhost:${(server.getConfig() as any).port || 4004}`;

      if (job.status === 'pending') {
        const elapsed = Date.now() - job.startedAt;
        return server.sendResponse(res, 200, true, {
          status: 'pending',
          elapsedMs: elapsed,
          message: `Provisioning... (${Math.floor(elapsed / 1000)}s)`,
        });
      }
      if (job.status === 'error') {
        return server.sendResponse(res, 200, true, {
          status: 'error',
          error: job.error,
        });
      }
      /*
       * Complete, and **without the admin token** (A8, finding A-4). This route is open so the
       * browser can poll progress, and progress is not a credential. The token is collected from
       * `POST /marketplace/api/activate-credentials/:applicationId` by presenting the activation
       * secret, once.
       *
       * The URLs stay: the employer needs them, and a port is not a secret. They were only
       * dangerous beside the token.
       */
      return server.sendResponse(res, 200, true, {
        status: 'complete',
        employerId: app.employerId,
        sequencerUrl,
        insurerUrl,
        authorizedPlanIds: app.authorizedPlanIds ?? app.selectedPlanIds,
        enrollmentCap: app.enrollmentCap,
        publicKeyHex: app.publicKeyHex,
        effectiveDate: app.effectiveDate,
        employerNodeUrl: job.result!.employerNodeUrl,
        hrToolSetup: job.result!.hrToolSetup,
        credentialsCollected: Boolean(app.credentialsCollectedAt),
      });
    },
  });


  /*
   * Collect the employer node's administrator credentials. Replaces the open handout that
   * `activate-status` used to perform (A8, finding A-4).
   *
   * Three properties, in the order that matters:
   *
   *   1. **The secret travels in the body, not the path.** A URL lands in proxy logs, browser
   *      history and the server's own access log. That is what disqualified `applicationId` from
   *      being the secret in the first place.
   *   2. **Single use.** Once collected, a replay is refused. The token is shown to the employer
   *      exactly once, which the dashboard already told them to expect, so this makes the
   *      promise true rather than changing it.
   *   3. **A wrong secret is indistinguishable from a wrong application.** Both answer 401 with
   *      the same text, so the route is not an oracle for which application IDs exist.
   */
  routes.push({
    method: 'POST',
    path: '/marketplace/api/activate-credentials/:applicationId',
    handler: async (_req, res, params, _query, body) => {
      const b = body as { claimSecret?: string } | undefined;
      const app = applicationStore.get(params.applicationId);

      // Same answer for an unknown application and a wrong secret.
      if (!app || !b?.claimSecret || !claimSecretMatches(app, b.claimSecret)) {
        return server.sendResponse(res, 401, false, undefined,
          'Invalid activation code.');
      }

      const job = activationJobs.get(params.applicationId);
      if (!job || job.status !== 'complete' || !job.result) {
        return server.sendResponse(res, 409, false, undefined,
          'This tenant is not provisioned yet. Poll activate-status until it reports complete.');
      }

      if (app.credentialsCollectedAt) {
        return server.sendResponse(res, 410, false, undefined,
          'These credentials were already collected. Use the rekey flow to obtain new ones.');
      }

      app.credentialsCollectedAt = Date.now();
      saveApplicationStore();
      // The identifier is logged; the secret and the token are not.
      console.log('[marketplace] Admin credentials collected for %s', app.applicationId);

      return server.sendResponse(res, 200, true, {
        employerId: app.employerId,
        employerNodeUrl: job.result.employerNodeUrl,
        hrToolSetup: job.result.hrToolSetup,
        adminToken: job.result.adminToken,
        message: 'Store this token securely. It will not be shown again.',
      });
    },
  });

  return routes;
}

// ─── Admin Endpoints ────────────────────────────────────────

export function buildEmployerAdminRoutes(server: NautilusAppServer): RouteRegistration[] {
  const routes: RouteRegistration[] = [];

  /**
   * For each signed or active employer: whether the terms its attestation committed to are still what its plans'
   * members are billed, and whether it was signed before agreements covered every published term
   * (attestationTermsStatus). Two sequencer reads, the plans and the attestations; null for an employer with no
   * attestation, or when the sequencer cannot be read.
   */
  async function termsStatusByEmployer(apps: EmployerApplication[]): Promise<Map<string, { termsChanged: boolean; signedBeforeFullTerms: boolean } | null>> {
    const out = new Map<string, { termsChanged: boolean; signedBeforeFullTerms: boolean } | null>();
    const signed = apps.filter((a) => a.status === 'signed' || a.status === 'active');
    if (signed.length === 0) return out;
    try {
      const seqUrl = server.getConfig().sequencerUrl.replace(/\/+$/, '');
      const read = async (method: string): Promise<unknown> => {
        const resp = await fetch(`${seqUrl}/rpc`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: {} }),
          signal: AbortSignal.timeout(5000),
        });
        return ((await resp.json()) as { result?: unknown }).result;
      };
      const [plans, attestations] = await Promise.all([read('l2_getPlans'), read('l2_getEmployerAttestations')]);
      const planList = Array.isArray(plans) ? plans as BenefitPlanConfig[] : [];
      const byEmployer = new Map<string, EmployerAttestation>();
      for (const att of Array.isArray(attestations) ? attestations as EmployerAttestation[] : []) {
        if (att && typeof att.employerId === 'string') byEmployer.set(att.employerId, att);
      }
      for (const app of signed) {
        const att = byEmployer.get(app.employerId);
        if (!att) { out.set(app.applicationId, null); continue; }
        const status = attestationTermsStatus(att, planList);
        out.set(app.applicationId, { termsChanged: status.termsChanged, signedBeforeFullTerms: status.signedBeforeFullTerms });
      }
    } catch {
      for (const app of signed) out.set(app.applicationId, null);
    }
    return out;
  }

  routes.push({
    method: 'GET',
    path: '/employer-applications',
    adminOnly: true,
    handler: async (_req, res) => {
      const termsStatus = await termsStatusByEmployer(Array.from(applicationStore.values()));
      // Strip sensitive fields from admin view (keep cp575DocumentId + resubmissionCount for review workflow)
      const apps = Array.from(applicationStore.values()).map(app => ({
        applicationId: app.applicationId,
        employerId: app.employerId,
        companyName: app.companyName,
        contactName: app.contactName,
        contactEmail: app.contactEmail,
        ein: app.ein,
        state: app.state,
        selectedPlanIds: app.selectedPlanIds,
        enrollmentCap: app.enrollmentCap,
        effectiveDate: app.effectiveDate,
        status: app.status,
        submittedAt: app.submittedAt,
        approvedAt: app.approvedAt || null,
        cp575DocumentId: app.cp575DocumentId || null,
        resubmissionCount: app.resubmissionCount || 0,
        // signed or active only: true when a plan's published terms changed after the employer signed
        termsChanged: termsStatus.get(app.applicationId)?.termsChanged ?? null,
        // signed or active only: true when it was signed before agreements covered fees, formularies, family limits and the
        // network, and the terms it did cover are unchanged
        signedBeforeFullTerms: termsStatus.get(app.applicationId)?.signedBeforeFullTerms ?? null,
      }));
      server.sendResponse(res, 200, true, apps);
    },
  });

  routes.push({
    method: 'POST',
    path: '/employer-applications/:applicationId/approve',
    adminOnly: true,
    handler: async (_req, res, params) => {
      const app = applicationStore.get(params.applicationId);
      if (!app) return server.sendResponse(res, 404, false, undefined, 'Application not found');
      if (app.status !== 'submitted' && app.status !== 'under_review' && app.status !== 'needs_documents') {
        return server.sendResponse(res, 409, false, undefined, `Cannot approve: status is ${app.status}`);
      }
      // Require CP 575 document before approval
      if (!app.cp575DocumentId) {
        return server.sendResponse(res, 409, false, undefined, 'Cannot approve: CP 575 document not yet uploaded. Use "Request Documents" first.');
      }
      app.status = 'approved';
      app.approvedAt = Date.now();
      saveApplicationStore();
      // Invalidate any stale agreement cache
      agreementCache.delete(params.applicationId);
      console.log('[marketplace] Application approved: %s (%s)', app.applicationId, app.companyName);
      server.sendResponse(res, 200, true, { applicationId: app.applicationId, status: 'approved' });
    },
  });

  routes.push({
    method: 'POST',
    path: '/employer-applications/:applicationId/deny',
    adminOnly: true,
    handler: async (_req, res, params, _query, body) => {
      const app = applicationStore.get(params.applicationId);
      if (!app) return server.sendResponse(res, 404, false, undefined, 'Application not found');
      if (app.status === 'signed' || app.status === 'active') {
        return server.sendResponse(res, 409, false, undefined, 'Cannot deny a signed/active application');
      }
      const b = body as { reason?: string } | undefined;
      app.status = 'denied';
      app.denialReason = b?.reason || 'Application denied';
      app.reviewedAt = Date.now();
      saveApplicationStore();
      server.sendResponse(res, 200, true, { applicationId: app.applicationId, status: 'denied' });
    },
  });

  // Request documents from employer (sets needs_documents status)
  routes.push({
    method: 'POST',
    path: '/employer-applications/:applicationId/request-documents',
    adminOnly: true,
    handler: async (_req, res, params) => {
      const app = applicationStore.get(params.applicationId);
      if (!app) return server.sendResponse(res, 404, false, undefined, 'Application not found');
      if (app.status !== 'submitted' && app.status !== 'under_review') {
        return server.sendResponse(res, 409, false, undefined, `Cannot request documents: status is ${app.status}`);
      }
      app.status = 'needs_documents';
      app.reviewedAt = Date.now();
      saveApplicationStore();
      console.log('[marketplace] Documents requested for: %s (%s)', app.applicationId, app.companyName);
      server.sendResponse(res, 200, true, { applicationId: app.applicationId, status: 'needs_documents' });
    },
  });

  /*
   * Allow re-keying: the employer lost their browser key and needs to update publicKeyHex.
   *
   * This route's previous comment read "Not admin-gated — applicationId (128-bit random) acts as
   * the bearer secret", and that is the same mistake as finding A-4, in a second place the audit
   * did not list. The entropy was never the issue: `applicationId` is printed to the console on
   * submission, written to `marketplace-applications.json` in plaintext, and carried in this very
   * URL path. Anyone who read it from a log could **replace the public key the insurer will
   * attest**, substituting their own signing identity for the employer's before signature.
   *
   * It now requires the activation secret, in the body, like credential collection. Still not
   * insurer-admin gated, because an employer who has lost their key has to be able to recover
   * without the insurer's help, which is the point of the route.
   */
  routes.push({
    method: 'POST',
    path: '/employer-applications/:applicationId/rekey',
    adminOnly: false,
    handler: async (_req, res, params, _query, body) => {
      const app = applicationStore.get(params.applicationId);
      const b = body as { publicKeyHex?: string; claimSecret?: string } | undefined;

      // Same answer for an unknown application and a wrong secret: no existence oracle.
      if (!app || !b?.claimSecret || !claimSecretMatches(app, b.claimSecret)) {
        return server.sendResponse(res, 401, false, undefined, 'Invalid activation code.');
      }
      if (app.status !== 'approved') {
        return server.sendResponse(res, 409, false, undefined, 'Can only rekey approved applications');
      }
      if (!b?.publicKeyHex || !/^[0-9a-f]{64}$/i.test(b.publicKeyHex)) {
        return server.sendResponse(res, 400, false, undefined, 'Invalid public key');
      }
      app.publicKeyHex = b.publicKeyHex;
      agreementCache.delete(params.applicationId);
      saveApplicationStore();
      console.log('[marketplace] Employer rekeyed: %s', app.employerId);
      server.sendResponse(res, 200, true, { applicationId: app.applicationId, rekeyed: true });
    },
  });

  // Post-sign rekey: employer lost key after signing. Revokes old attestation, re-signs with new key.
  routes.push({
    method: 'POST',
    path: '/employer-applications/:applicationId/rekey-signed',
    adminOnly: true,
    handler: async (_req, res, params, _query, body) => {
      const app = applicationStore.get(params.applicationId);
      if (!app) return server.sendResponse(res, 404, false, undefined, 'Application not found');
      if (app.status !== 'signed' && app.status !== 'active') {
        return server.sendResponse(res, 409, false, undefined, 'Only signed/active applications can be rekeyed');
      }
      const b = body as { publicKeyHex?: string } | undefined;
      if (!b?.publicKeyHex || !/^[0-9a-f]{64}$/i.test(b.publicKeyHex)) {
        return server.sendResponse(res, 400, false, undefined, 'Invalid public key (64 hex chars required)');
      }

      const seqUrl = server.getConfig().sequencerUrl.replace(/\/+$/, '');
      const hdrs: Record<string, string> = { 'Content-Type': 'application/json' };

      // Step 1: Revoke old attestation on sequencer
      try {
        await server.signedFetch(`${seqUrl}/rpc`, {
          method: 'POST', headers: hdrs,
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'l2_revokeEmployerAttestation', params: { employerId: app.employerId } }),
        });
      } catch {
        return server.sendResponse(res, 502, false, undefined, 'Cannot revoke old attestation — sequencer unreachable');
      }

      // Step 2: Update key + reset to approved for re-signing
      app.publicKeyHex = b.publicKeyHex;
      app.status = 'approved';
      agreementCache.delete(params.applicationId);
      docxCache.delete(params.applicationId);
      saveApplicationStore();
      server.registerPartnerKey(app.employerId, b.publicKeyHex);

      console.log('[marketplace] Post-sign rekey: %s (%s)', app.employerId, app.companyName);
      server.sendResponse(res, 200, true, {
        applicationId: app.applicationId, rekeyed: true, status: 'approved',
        message: 'Old attestation revoked. Fetch new agreement and re-sign.',
      });
    },
  });

  return routes;
}
