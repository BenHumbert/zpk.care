/**
 * Pharmacy Routes — REST endpoints for PharmacyNode Nautilus Apps.
 *
 * Same onboarding as member/prescriber but uses securePharmacyDerivation()
 * with NPI credentials (serviceProviderIdQualifier, serviceProviderId).
 *
 * Key feature: DUR (Drug Utilization Review) endpoints that query the
 * gossip-replicated claim accumulator for CROSS-PHARMACY full drug history.
 * This is what makes the pharmacy node a sideloaded program for existing POS.
 */
import { generateEnrollmentKey } from '../../wallets/wallet-derivation.js';
import { securePharmacyDerivation } from '../../security/secure-context.js';
import { exportEnrollmentBackup, importEnrollmentBackup } from '../../security/enrollment-backup.js';
import {
  parseNfcIdentityPayload,
  parseNfcIdentityBase64,
  isValidWalletId,
} from '../nfc-identity.js';
import { PharmacyNode } from '../pharmacy-node.js';
import type { NautilusAppServer } from '../nautilus-app-server.js';
import type { RouteRegistration } from '../nautilus-app-types.js';
import type { PharmacyLocalData } from '../../models/pharmacy.js';

const DOMAIN_TAG_PHARMACY = 2;

/**
 * Build all pharmacy routes.
 */
export function buildPharmacyRoutes(server: NautilusAppServer): RouteRegistration[] {
  const routes: RouteRegistration[] = [];

  // ══════════════════════════════════════════════════════════
  //  ONBOARDING
  // ══════════════════════════════════════════════════════════

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
        state.setEnrollmentKey(enrollmentKey);
        await state.save(data);
      }
      server.setOnboardingPhase('key_generated');
      server.sendResponse(res, 200, true, { phase: 'key_generated' });
    },
  });

  // Pharmacy uses NPI credentials
  routes.push({
    method: 'POST',
    path: '/onboarding/derive-wallet',
    handler: async (_req, res, _params, _query, body) => {
      if (server.getOnboardingPhase() !== 'key_generated') {
        return server.sendResponse(res, 409, false, undefined, `Cannot derive wallet in phase: ${server.getOnboardingPhase()}`);
      }
      const b = body as { serviceProviderIdQualifier?: number; serviceProviderId?: string } | undefined;
      if (b?.serviceProviderIdQualifier === undefined || !b?.serviceProviderId) {
        return server.sendResponse(res, 400, false, undefined, 'Missing serviceProviderIdQualifier or serviceProviderId');
      }
      const state = server.getLocalState();
      if (!state.hasEnrollmentKey()) {
        return server.sendResponse(res, 409, false, undefined, 'Enrollment key not generated');
      }

      const localData: PharmacyLocalData = {
        serviceProviderIdQualifier: b.serviceProviderIdQualifier,
        serviceProviderId: b.serviceProviderId,
      };
      const result = state.useEnrollmentKey((key) =>
        securePharmacyDerivation(localData, key),
      );
      const walletId = result.walletId.toString();
      const preimageFields = result.preimage.map((f) => f.toString());

      const data = state.getState();
      if (data) {
        data.walletId = walletId;
        data.preimageFields = preimageFields;
        data.domainTag = DOMAIN_TAG_PHARMACY;
        data.onboarding.phase = 'wallet_derived';
      }
      await state.save(data!);

      server.setOnboardingPhase('wallet_derived');
      server.sendResponse(res, 200, true, { phase: 'wallet_derived', walletId });
    },
  });

  routes.push({
    method: 'POST',
    path: '/onboarding/enroll',
    handler: async (_req, res, _params, _query, _body) => {
      if (server.getOnboardingPhase() !== 'wallet_derived') {
        return server.sendResponse(res, 409, false, undefined, `Cannot enroll in phase: ${server.getOnboardingPhase()}`);
      }
      const state = server.getLocalState();
      const data = state.getState();
      if (!data?.walletId) {
        return server.sendResponse(res, 409, false, undefined, 'Wallet not derived');
      }
      const node = new PharmacyNode({
        role: 'pharmacy',
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
      server.sendResponse(res, 200, true, { phase: 'enrolled', walletId: data.walletId });
    },
  });

  routes.push({
    method: 'POST',
    path: '/onboarding/compile',
    handler: async (_req, res, _params, _query, _body) => {
      if (server.getOnboardingPhase() !== 'enrolled') {
        return server.sendResponse(res, 409, false, undefined, `Cannot compile in phase: ${server.getOnboardingPhase()}`);
      }
      const node = server.getEntityNode() as PharmacyNode | null;
      if (!node) return server.sendResponse(res, 409, false, undefined, 'Node not initialized');
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

  routes.push({
    method: 'POST',
    path: '/onboarding/backup-key',
    handler: async (_req, res, _params, _query, body) => {
      const phase = server.getOnboardingPhase();
      if (phase === 'awaiting_token' || phase === 'token_received') {
        return server.sendResponse(res, 409, false, undefined, 'Enrollment key not yet generated');
      }
      const b = body as { pin?: string } | undefined;
      if (!b?.pin) return server.sendResponse(res, 400, false, undefined, 'Missing pin');
      const state = server.getLocalState();
      if (!state.hasEnrollmentKey()) return server.sendResponse(res, 409, false, undefined, 'No enrollment key');
      const data = state.getState();
      const pin = b.pin;
      const walletIdForBackup = data?.walletId ?? '0';
      const backup = state.useEnrollmentKey((key) =>
        exportEnrollmentBackup(key, pin, walletIdForBackup, DOMAIN_TAG_PHARMACY),
      );
      server.sendResponse(res, 200, true, { backup });
    },
  });

  routes.push({
    method: 'POST',
    path: '/onboarding/restore-key',
    handler: async (_req, res, _params, _query, body) => {
      const b = body as { backup?: Record<string, unknown>; pin?: string } | undefined;
      if (!b?.backup || !b?.pin) return server.sendResponse(res, 400, false, undefined, 'Missing backup or pin');
      try {
        const enrollmentKey = importEnrollmentBackup(
          b.backup as unknown as Parameters<typeof importEnrollmentBackup>[0],
          b.pin,
        );
        const state = server.getLocalState();
        state.setEnrollmentKey(enrollmentKey);
        const data = state.getState();
        if (data) {
          await state.save(data);
        }
        server.sendResponse(res, 200, true, { restored: true });
      } catch (err) {
        server.sendResponse(res, 400, false, undefined, err instanceof Error ? err.message : 'Restore failed');
      }
    },
  });

  // ══════════════════════════════════════════════════════════
  //  DISPENSING HISTORY
  // ══════════════════════════════════════════════════════════

  routes.push({
    method: 'GET',
    path: '/dispensing',
    handler: async (_req, res) => {
      const node = server.getEntityNode() as PharmacyNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');
      server.sendResponse(res, 200, true, await node.getDispensingHistory());
    },
  });

  routes.push({
    method: 'GET',
    path: '/dispensing/summary',
    handler: async (_req, res) => {
      const node = server.getEntityNode() as PharmacyNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');
      server.sendResponse(res, 200, true, await node.getActivitySummary());
    },
  });

  routes.push({
    method: 'GET',
    path: '/dispensing/range',
    handler: async (_req, res, _params, query) => {
      const node = server.getEntityNode() as PharmacyNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');
      const start = query.get('start');
      const end = query.get('end');
      if (!start || !end) return server.sendResponse(res, 400, false, undefined, 'Missing start or end');
      server.sendResponse(res, 200, true, await node.getDispensingHistoryByDateRange(start, end));
    },
  });

  routes.push({
    method: 'GET',
    path: '/dispensing/patient/:memberWalletId',
    handler: async (_req, res, params) => {
      const node = server.getEntityNode() as PharmacyNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');
      server.sendResponse(res, 200, true, await node.getPatientHistory(params.memberWalletId));
    },
  });

  routes.push({
    method: 'GET',
    path: '/dispensing/prescriber/:prescriberWalletId',
    handler: async (_req, res, params) => {
      const node = server.getEntityNode() as PharmacyNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');
      server.sendResponse(res, 200, true, await node.getClaimsByPrescriber(params.prescriberWalletId));
    },
  });

  routes.push({
    method: 'GET',
    path: '/dispensing/medication/:ndcHash',
    handler: async (_req, res, params) => {
      const node = server.getEntityNode() as PharmacyNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');
      server.sendResponse(res, 200, true, await node.getClaimsByMedication(params.ndcHash));
    },
  });

  routes.push({
    method: 'GET',
    path: '/dispensing/medications/breakdown',
    handler: async (_req, res) => {
      const node = server.getEntityNode() as PharmacyNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');
      server.sendResponse(res, 200, true, await node.getMedicationBreakdown());
    },
  });

  routes.push({
    method: 'GET',
    path: '/dispensing/prescribers/breakdown',
    handler: async (_req, res) => {
      const node = server.getEntityNode() as PharmacyNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');
      server.sendResponse(res, 200, true, await node.getPrescriberBreakdown());
    },
  });

  // ══════════════════════════════════════════════════════════
  //  DUR — Drug Utilization Review (cross-pharmacy)
  // ══════════════════════════════════════════════════════════

  routes.push({
    method: 'GET',
    path: '/dur/patient/:memberWalletId/full-history',
    handler: async (_req, res, params) => {
      const node = server.getEntityNode() as PharmacyNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');
      server.sendResponse(res, 200, true, await node.getPatientFullDrugHistory(params.memberWalletId));
    },
  });

  routes.push({
    method: 'GET',
    path: '/dur/patient/:memberWalletId/active-medications',
    handler: async (_req, res, params) => {
      const node = server.getEntityNode() as PharmacyNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');
      server.sendResponse(res, 200, true, await node.getPatientActiveMedications(params.memberWalletId));
    },
  });

  routes.push({
    method: 'GET',
    path: '/dur/patient/:memberWalletId/check/:ndcHash',
    handler: async (_req, res, params) => {
      const node = server.getEntityNode() as PharmacyNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');
      const active = await node.hasActiveClaim(params.memberWalletId, params.ndcHash);
      server.sendResponse(res, 200, true, {
        memberWalletId: params.memberWalletId,
        ndcHash: params.ndcHash,
        activeClaim: active,
      });
    },
  });

  routes.push({
    method: 'GET',
    path: '/dur/claim/:leafIndex',
    handler: async (_req, res, params) => {
      const node = server.getEntityNode() as PharmacyNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');
      const result = await node.getClaimWithProof(BigInt(params.leafIndex));
      if (!result) return server.sendResponse(res, 404, false, undefined, 'Claim not found');
      server.sendResponse(res, 200, true, result);
    },
  });

  // ══════════════════════════════════════════════════════════
  //  NFC SCAN — Accept member ID from NFC tap or QR scan
  // ══════════════════════════════════════════════════════════

  routes.push({
    method: 'POST',
    path: '/nfc/scan',
    handler: async (_req, res, _params, _query, body) => {
      const node = server.getEntityNode() as PharmacyNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');

      const b = body as {
        /** Raw NFC NDEF payload JSON string */
        payload?: string;
        /** Pre-parsed NFC payload object */
        payloadObject?: Record<string, unknown>;
        /** Base64url-encoded payload (from QR code fallback) */
        payloadBase64?: string;
        /** Direct walletId (manual entry or already-extracted) */
        walletId?: string;
      } | undefined;

      // Extract walletId from whichever input format is provided
      let walletId: string | null = null;

      if (b?.walletId && isValidWalletId(b.walletId)) {
        walletId = b.walletId;
      } else if (b?.payload) {
        walletId = parseNfcIdentityPayload(b.payload);
      } else if (b?.payloadObject) {
        walletId = parseNfcIdentityPayload(b.payloadObject);
      } else if (b?.payloadBase64) {
        walletId = parseNfcIdentityBase64(b.payloadBase64);
      }

      if (!walletId) {
        return server.sendResponse(res, 400, false, undefined,
          'Invalid or missing NFC payload. Provide payload (JSON string), payloadObject, payloadBase64, or walletId.');
      }

      // One-shot patient lookup: active medications + claim count + latest claims
      const [activeMeds, fullHistory] = await Promise.all([
        node.getPatientActiveMedications(walletId),
        node.getPatientFullDrugHistory(walletId),
      ]);

      server.sendResponse(res, 200, true, {
        walletId,
        activeMedications: activeMeds,
        activeMedicationCount: Array.isArray(activeMeds) ? activeMeds.length : 0,
        totalClaims: Array.isArray(fullHistory) ? fullHistory.length : 0,
        fullHistory,
      });
    },
  });

  // ── Query: Proof Timings ──────────────────────────────────

  routes.push({
    method: 'GET',
    path: '/proof-timings',
    handler: async (_req, res) => {
      const node = server.getEntityNode() as PharmacyNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');
      server.sendResponse(res, 200, true, node.getProofTimings());
    },
  });

  return routes;
}
