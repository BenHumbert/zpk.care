/**
 * Member Routes — REST endpoints for MemberNode Nautilus Apps.
 *
 * Onboarding flow:
 *   accept-token → generate-key → derive-wallet → enroll → compile → ready
 *
 * Query endpoints (active after enrolled/ready):
 *   Drug history, activity summary, formulary, receipts, claim proofs
 *
 * Security:
 *   - POST /onboarding/derive-wallet is the ONLY endpoint that receives raw PHI
 *   - secureMemberDerivation() immediately scrubs the input
 *   - The enrollment key NEVER appears in any API response
 */
import { generateEnrollmentKey } from '../../wallets/wallet-derivation.js';
import { secureMemberDerivation } from '../../security/secure-context.js';
import { exportEnrollmentBackup, importEnrollmentBackup } from '../../security/enrollment-backup.js';
import { buildPcpAssignmentData } from '../../eligibility/pcp-assignment-data.js';
import type { PcpAssignmentLocalData } from '../../eligibility/pcp-assignment-data.js';
import { buildNfcIdentityRecord, fitsOnTag } from '../nfc-identity.js';
import { MemberNode } from '../member-node.js';
import type { NautilusAppServer } from '../nautilus-app-server.js';
import type { RouteRegistration } from '../nautilus-app-types.js';
import type { MemberLocalData } from '../../models/member.js';

/** Domain tag for members */
const DOMAIN_TAG_MEMBER = 0;

/**
 * Build all member routes. The server reference is captured in closures
 * so route handlers can access the entity node and local state.
 */
export function buildMemberRoutes(server: NautilusAppServer): RouteRegistration[] {
  const routes: RouteRegistration[] = [];

  // ── Onboarding: Accept Token ──────────────────────────────

  routes.push({
    method: 'POST',
    path: '/onboarding/accept-token',
    handler: async (_req, res, _params, _query, body) => {
      if (server.getOnboardingPhase() !== 'awaiting_token') {
        return server.sendResponse(res, 409, false, undefined, `Cannot accept token in phase: ${server.getOnboardingPhase()}`);
      }

      const b = body as { tokenId?: string; groupId?: string; planId?: string; validUntil?: string } | undefined;
      if (!b?.tokenId) {
        return server.sendResponse(res, 400, false, undefined, 'Missing tokenId');
      }

      const state = server.getLocalState();
      const data = state.getState();
      if (data) {
        data.onboarding.phase = 'token_received';
        data.onboarding.tokenId = b.tokenId;
        data.onboarding.tokenData = {
          groupId: b.groupId ?? '',
          planId: b.planId ?? '',
          validUntil: b.validUntil ?? '',
        };
        await state.save(data);
      }

      server.setOnboardingPhase('token_received');
      server.sendResponse(res, 200, true, { phase: 'token_received', tokenId: b.tokenId });
    },
  });

  // ── Onboarding: Generate Enrollment Key ───────────────────

  routes.push({
    method: 'POST',
    path: '/onboarding/generate-key',
    handler: async (_req, res, _params, _query, _body) => {
      if (server.getOnboardingPhase() !== 'token_received') {
        return server.sendResponse(res, 409, false, undefined, `Cannot generate key in phase: ${server.getOnboardingPhase()}`);
      }

      const enrollmentKey = generateEnrollmentKey();

      const state = server.getLocalState();
      const data = state.getState();
      if (data) {
        data.onboarding.phase = 'key_generated';
        // Enrollment key is immediately wrapped in XOR-split obfuscation
        state.setEnrollmentKey(enrollmentKey);
        await state.save(data);
      }

      server.setOnboardingPhase('key_generated');
      // Key is stored encrypted at rest — NEVER returned in API response
      server.sendResponse(res, 200, true, { phase: 'key_generated' });
    },
  });

  // ── Onboarding: Derive Wallet ─────────────────────────────
  // This is the ONLY endpoint that receives raw PHI (cardholderId, dob, etc.)

  routes.push({
    method: 'POST',
    path: '/onboarding/derive-wallet',
    handler: async (_req, res, _params, _query, body) => {
      if (server.getOnboardingPhase() !== 'key_generated') {
        return server.sendResponse(res, 409, false, undefined, `Cannot derive wallet in phase: ${server.getOnboardingPhase()}`);
      }

      const b = body as {
        cardholderId?: string;
        dateOfBirth?: string;
        genderCode?: number;
        firstName?: string;
        lastName?: string;
      } | undefined;

      if (!b?.cardholderId || !b?.dateOfBirth || !b?.firstName || !b?.lastName) {
        return server.sendResponse(res, 400, false, undefined, 'Missing required fields: cardholderId, dateOfBirth, firstName, lastName');
      }

      const state = server.getLocalState();
      if (!state.hasEnrollmentKey()) {
        return server.sendResponse(res, 409, false, undefined, 'Enrollment key not generated');
      }

      // Build a mutable copy of the local data — secureMemberDerivation scrubs it
      const localData: MemberLocalData = {
        cardholderId: b.cardholderId,
        dateOfBirth: b.dateOfBirth,
        genderCode: b.genderCode ?? 0,
        firstName: b.firstName,
        lastName: b.lastName,
      };

      // Enrollment key is reconstructed only for the duration of derivation
      const result = state.useEnrollmentKey((key) =>
        secureMemberDerivation(localData, key),
      );
      const walletId = result.walletId.toString();

      // Save preimage Fields as decimal strings for later proof generation
      const preimageFields = result.preimage.map((f) => f.toString());

      const data = state.getState();
      if (data) {
        data.walletId = walletId;
        data.preimageFields = preimageFields;
        data.domainTag = DOMAIN_TAG_MEMBER;
        data.onboarding.phase = 'wallet_derived';
      }
      await state.save(data!);

      // Don't dispose preimage yet — needed for proof generation
      server.setOnboardingPhase('wallet_derived');
      server.sendResponse(res, 200, true, { phase: 'wallet_derived', walletId });
    },
  });

  // ── Onboarding: Enroll ────────────────────────────────────

  routes.push({
    method: 'POST',
    path: '/onboarding/enroll',
    handler: async (_req, res, _params, _query, body) => {
      if (server.getOnboardingPhase() !== 'wallet_derived') {
        return server.sendResponse(res, 409, false, undefined, `Cannot enroll in phase: ${server.getOnboardingPhase()}`);
      }

      const state = server.getLocalState();
      const data = state.getState();
      if (!data?.walletId) {
        return server.sendResponse(res, 409, false, undefined, 'Wallet not derived');
      }

      // The insurer enrollment endpoint URL can be provided in the body
      // or defaults to the sequencer URL (insurer processes via sequencer)
      const b = body as { insurerUrl?: string } | undefined;
      const enrollUrl = b?.insurerUrl ?? server.getConfig().sequencerUrl;

      // Create the MemberNode now that we have a walletId
      const node = new MemberNode({
        role: 'member',
        walletId: data.walletId,
        sequencerUrl: server.getConfig().sequencerUrl,
        displayName: server.getConfig().displayName,
      });
      server.setEntityNode(node);

      data.onboarding.phase = 'enrolled';
      data.onboarding.enrollmentTimestamp = Date.now();
      data.lastSequencerUrl = server.getConfig().sequencerUrl;
      await state.save(data);

      server.setOnboardingPhase('enrolled');
      server.sendResponse(res, 200, true, {
        phase: 'enrolled',
        walletId: data.walletId,
        sequencerUrl: enrollUrl,
      });
    },
  });

  // ── Onboarding: Compile Programs ──────────────────────────

  routes.push({
    method: 'POST',
    path: '/onboarding/compile',
    handler: async (_req, res, _params, _query, _body) => {
      if (server.getOnboardingPhase() !== 'enrolled') {
        return server.sendResponse(res, 409, false, undefined, `Cannot compile in phase: ${server.getOnboardingPhase()}`);
      }

      const node = server.getEntityNode() as MemberNode | null;
      if (!node) {
        return server.sendResponse(res, 409, false, undefined, 'Node not initialized');
      }

      server.setOnboardingPhase('compiling');
      const results = await node.compilePrograms();

      const state = server.getLocalState();
      const data = state.getState();
      if (data) {
        data.onboarding.phase = 'ready';
        data.onboarding.compilationStatus = results;
        await state.save(data);
      }

      server.setOnboardingPhase('ready');
      server.sendResponse(res, 200, true, { phase: 'ready', compilationStatus: results });
    },
  });

  // ── Onboarding: Backup Key ────────────────────────────────

  routes.push({
    method: 'POST',
    path: '/onboarding/backup-key',
    handler: async (_req, res, _params, _query, body) => {
      const phase = server.getOnboardingPhase();
      if (phase === 'awaiting_token' || phase === 'token_received') {
        return server.sendResponse(res, 409, false, undefined, 'Enrollment key not yet generated');
      }

      const b = body as { pin?: string } | undefined;
      if (!b?.pin) {
        return server.sendResponse(res, 400, false, undefined, 'Missing pin');
      }

      const state = server.getLocalState();
      const data = state.getState();
      if (!state.hasEnrollmentKey()) {
        return server.sendResponse(res, 409, false, undefined, 'No enrollment key in state');
      }

      // Capture values before entering useEnrollmentKey closure
      const pin = b.pin;
      const walletIdForBackup = data?.walletId ?? '0';
      const domainTagForBackup = data?.domainTag ?? DOMAIN_TAG_MEMBER;

      // Reconstruct key only for the duration of backup export
      const backup = state.useEnrollmentKey((key) =>
        exportEnrollmentBackup(key, pin, walletIdForBackup, domainTagForBackup),
      );

      server.sendResponse(res, 200, true, { backup });
    },
  });

  // ── Onboarding: Restore Key ───────────────────────────────

  routes.push({
    method: 'POST',
    path: '/onboarding/restore-key',
    handler: async (_req, res, _params, _query, body) => {
      const b = body as { backup?: Record<string, unknown>; pin?: string } | undefined;
      if (!b?.backup || !b?.pin) {
        return server.sendResponse(res, 400, false, undefined, 'Missing backup or pin');
      }

      try {
        const enrollmentKey = importEnrollmentBackup(
          b.backup as unknown as Parameters<typeof importEnrollmentBackup>[0],
          b.pin,
        );

        const state = server.getLocalState();
        // Wrap restored key in XOR-split obfuscation immediately
        state.setEnrollmentKey(enrollmentKey);
        const data = state.getState();
        if (data) {
          await state.save(data);
        }

        // Key is restored — NEVER returned in response
        server.sendResponse(res, 200, true, { restored: true });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Restore failed';
        server.sendResponse(res, 400, false, undefined, msg);
      }
    },
  });

  // ── Query: Drug History ───────────────────────────────────

  routes.push({
    method: 'GET',
    path: '/drugs',
    handler: async (_req, res, _params, _query, _body) => {
      const node = server.getEntityNode() as MemberNode | null;
      if (!node) {
        return server.sendResponse(res, 503, false, undefined, 'Node not initialized');
      }
      const history = await node.getDrugHistory();
      server.sendResponse(res, 200, true, history);
    },
  });

  routes.push({
    method: 'GET',
    path: '/drugs/summary',
    handler: async (_req, res, _params, _query, _body) => {
      const node = server.getEntityNode() as MemberNode | null;
      if (!node) {
        return server.sendResponse(res, 503, false, undefined, 'Node not initialized');
      }
      const summary = await node.getActivitySummary();
      server.sendResponse(res, 200, true, summary);
    },
  });

  routes.push({
    method: 'GET',
    path: '/drugs/range',
    handler: async (_req, res, _params, query, _body) => {
      const node = server.getEntityNode() as MemberNode | null;
      if (!node) {
        return server.sendResponse(res, 503, false, undefined, 'Node not initialized');
      }
      const start = query.get('start');
      const end = query.get('end');
      if (!start || !end) {
        return server.sendResponse(res, 400, false, undefined, 'Missing start or end query param');
      }
      const history = await node.getDrugHistoryByDateRange(start, end);
      server.sendResponse(res, 200, true, history);
    },
  });

  routes.push({
    method: 'GET',
    path: '/drugs/medication/:ndcHash',
    handler: async (_req, res, params, _query, _body) => {
      const node = server.getEntityNode() as MemberNode | null;
      if (!node) {
        return server.sendResponse(res, 503, false, undefined, 'Node not initialized');
      }
      const claims = await node.getClaimsByMedication(params.ndcHash);
      server.sendResponse(res, 200, true, claims);
    },
  });

  routes.push({
    method: 'GET',
    path: '/drugs/claim/:leafIndex',
    handler: async (_req, res, params, _query, _body) => {
      const node = server.getEntityNode() as MemberNode | null;
      if (!node) {
        return server.sendResponse(res, 503, false, undefined, 'Node not initialized');
      }
      const result = await node.getClaimWithProof(BigInt(params.leafIndex));
      if (!result) {
        return server.sendResponse(res, 404, false, undefined, 'Claim not found');
      }
      server.sendResponse(res, 200, true, result);
    },
  });

  routes.push({
    method: 'GET',
    path: '/drugs/tree-status',
    handler: async (_req, res, _params, _query, _body) => {
      const node = server.getEntityNode() as MemberNode | null;
      if (!node) {
        return server.sendResponse(res, 503, false, undefined, 'Node not initialized');
      }
      const status = await node.getClaimTreeStatus();
      server.sendResponse(res, 200, true, status);
    },
  });

  // ── Query: Receipts ───────────────────────────────────────

  routes.push({
    method: 'GET',
    path: '/receipts',
    handler: async (_req, res, _params, _query, _body) => {
      const node = server.getEntityNode() as MemberNode | null;
      if (!node) {
        return server.sendResponse(res, 503, false, undefined, 'Node not initialized');
      }
      const receipts = await node.getMyReceipts();
      server.sendResponse(res, 200, true, receipts);
    },
  });

  // ── Query: Formulary ──────────────────────────────────────

  routes.push({
    method: 'GET',
    path: '/formulary/:planIdHash',
    handler: async (_req, res, params, _query, _body) => {
      const node = server.getEntityNode() as MemberNode | null;
      if (!node) {
        return server.sendResponse(res, 503, false, undefined, 'Node not initialized');
      }
      const formulary = await node.getFormulary(params.planIdHash);
      if (!formulary) {
        return server.sendResponse(res, 404, false, undefined, 'Formulary not found');
      }
      server.sendResponse(res, 200, true, formulary);
    },
  });

  // ── PCP Assignment (member chooses their PCP) ──────────────

  routes.push({
    method: 'POST',
    path: '/pcp/assign',
    handler: async (_req, res, _params, _query, body) => {
      const node = server.getEntityNode() as MemberNode | null;
      if (!node) {
        return server.sendResponse(res, 503, false, undefined, 'Node not initialized');
      }

      const b = body as {
        pcpWalletId?: string;
        effectiveDate?: string;
        specialty?: string;
        consentScopeFlags?: number;
      } | undefined;

      if (!b?.pcpWalletId || !b?.effectiveDate) {
        return server.sendResponse(res, 400, false, undefined, 'Missing pcpWalletId or effectiveDate');
      }

      const memberWalletId = node.getWalletId();
      if (!memberWalletId) {
        return server.sendResponse(res, 409, false, undefined, 'Member wallet ID not set');
      }

      const assignmentData: PcpAssignmentLocalData = {
        memberWalletId,
        pcpWalletId: b.pcpWalletId,
        effectiveDate: b.effectiveDate,
        terminationDate: '',
        specialty: b.specialty ?? 'General Practice',
        consentTimestamp: b.effectiveDate,
        consentScopeFlags: b.consentScopeFlags ?? 7, // PCP_SCOPE_ALL
      };

      const pcpAssignment = buildPcpAssignmentData(assignmentData);
      const commitment = pcpAssignment.commitment().toString();

      server.sendResponse(res, 200, true, {
        memberWalletId,
        pcpWalletId: b.pcpWalletId,
        commitment,
        effectiveDate: b.effectiveDate,
        consentScopeFlags: b.consentScopeFlags ?? 7,
      });
    },
  });

  routes.push({
    method: 'GET',
    path: '/pcp/current',
    handler: async (_req, res, _params, _query, _body) => {
      // Return PCP info from local state if available
      const data = server.getLocalState().getState();
      const pcpInfo = (data as any)?.pcpAssignment ?? null;
      server.sendResponse(res, 200, true, pcpInfo);
    },
  });

  // ── NFC Identity (tap-to-identify at pharmacy) ─────────────

  routes.push({
    method: 'GET',
    path: '/nfc/id-payload',
    handler: async (_req, res, _params, _query, _body) => {
      const data = server.getLocalState().getState();
      if (!data?.walletId) {
        return server.sendResponse(res, 409, false, undefined, 'Wallet not derived — complete onboarding first');
      }

      const record = buildNfcIdentityRecord(data.walletId);
      server.sendResponse(res, 200, true, {
        record,
        tagCompatibility: {
          NTAG213: fitsOnTag(record, 'NTAG213'),
          NTAG215: fitsOnTag(record, 'NTAG215'),
          NTAG216: fitsOnTag(record, 'NTAG216'),
        },
        instructions: {
          android: 'Use NdefRecord(TNF_EXTERNAL_TYPE, type, null, payloadJson.getBytes()) or enable HCE with the payloadJson.',
          ios: 'Use NFCNDEFPayload(format: .nfcExternal, type: type, identifier: Data(), payload: payloadData).',
          physicalTag: 'Write the payloadJson as an NDEF External Type Record to any NTAG213+ tag.',
        },
      });
    },
  });

  routes.push({
    method: 'GET',
    path: '/nfc/id-qr',
    handler: async (_req, res, _params, _query, _body) => {
      const data = server.getLocalState().getState();
      if (!data?.walletId) {
        return server.sendResponse(res, 409, false, undefined, 'Wallet not derived — complete onboarding first');
      }

      const record = buildNfcIdentityRecord(data.walletId);
      // QR code: base64url-encoded payload for scanning at pharmacies without NFC readers
      server.sendResponse(res, 200, true, {
        qrData: record.payloadBase64,
        walletId: data.walletId,
      });
    },
  });

  // ── Query: Proof Timings ──────────────────────────────────

  routes.push({
    method: 'GET',
    path: '/proof-timings',
    handler: async (_req, res, _params, _query, _body) => {
      const node = server.getEntityNode() as MemberNode | null;
      if (!node) {
        return server.sendResponse(res, 503, false, undefined, 'Node not initialized');
      }
      const timings = node.getProofTimings();
      server.sendResponse(res, 200, true, timings);
    },
  });

  return routes;
}
