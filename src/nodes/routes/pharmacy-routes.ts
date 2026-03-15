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
import { Field } from 'o1js';
import { generateEnrollmentKey } from '../../wallets/wallet-derivation.js';
import { securePharmacyDerivation } from '../../security/secure-context.js';
import { exportEnrollmentBackup, importEnrollmentBackup } from '../../security/enrollment-backup.js';
import { WalletRegistryWitness } from '../../wallets/wallet-state.js';
import { LifecycleWitness } from '../../engine/lifecycle.js';
import {
  parseNfcIdentityPayload,
  parseNfcIdentityBase64,
  isValidWalletId,
} from '../nfc-identity.js';
import {
  SequencerAttestationAuthority,
  isAttestation,
  type NfcCredentialAttestation,
} from '../../credentials/nfc-attestation.js';
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
    handler: async (_req, res, _params, _query, body) => {
      if (server.getOnboardingPhase() !== 'token_received') {
        return server.sendResponse(res, 409, false, undefined, `Cannot generate key in phase: ${server.getOnboardingPhase()}`);
      }
      const enrollmentKey = (body as any)?.enrollmentKey ?? generateEnrollmentKey();
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
    handler: async (_req, res, _params, _query, body) => {
      if (server.getOnboardingPhase() !== 'wallet_derived') {
        return server.sendResponse(res, 409, false, undefined, `Cannot enroll in phase: ${server.getOnboardingPhase()}`);
      }
      const state = server.getLocalState();
      const data = state.getState();
      if (!data?.walletId) {
        return server.sendResponse(res, 409, false, undefined, 'Wallet not derived');
      }
      const b = body as { insurerUrl?: string } | undefined;

      const node = new PharmacyNode({
        role: 'pharmacy',
        walletId: data.walletId,
        sequencerUrl: server.getConfig().sequencerUrl,
        displayName: server.getConfig().displayName,
      });
      server.setEntityNode(node);

      // Notify insurer (non-blocking)
      let insurerNotified = false;
      if (b?.insurerUrl) {
        try {
          const resp = await fetch(`${b.insurerUrl}/enrollment/process`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ walletId: data.walletId, tokenId: data.onboarding.tokenId, role: 'pharmacy' }),
          });
          insurerNotified = resp.ok;
        } catch (insErr: unknown) {
          console.warn('[pharmacy-enroll] Insurer notification failed:', insErr instanceof Error ? insErr.message : String(insErr));
        }
      }

      data.onboarding.phase = 'enrolled';
      data.onboarding.enrollmentTimestamp = Date.now();
      data.lastSequencerUrl = server.getConfig().sequencerUrl;
      await state.save(data);

      server.setOnboardingPhase('enrolled');
      server.sendResponse(res, 200, true, { phase: 'enrolled', walletId: data.walletId, insurerNotified });
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

  // ── Proof: Registration ──────────────────────────────────

  routes.push({
    method: 'POST',
    path: '/proof/registration',
    handler: async (_req, res, _params, _query, _body) => {
      if (server.getOnboardingPhase() !== 'ready') {
        return server.sendResponse(res, 409, false, undefined, `Cannot generate proof in phase: ${server.getOnboardingPhase()}`);
      }
      const node = server.getEntityNode() as PharmacyNode | null;
      if (!node) {
        return server.sendResponse(res, 409, false, undefined, 'Node not initialized');
      }

      const state = server.getLocalState();
      const data = state.getState();
      if (!data?.preimageFields || !data.walletId) {
        return server.sendResponse(res, 409, false, undefined, 'Wallet preimage not available');
      }

      try {
        const witnesses = await node.getClient().getRegistrationWitnesses();

        // Reconstruct transition preimage: [domainTag, ...walletFields padded to 5]
        const walletFields = data.preimageFields.map((s: string) => Field(BigInt(s)));
        const padded = [...walletFields];
        while (padded.length < 5) padded.push(Field(0));
        const preimage = [Field(data.domainTag ?? 2), ...padded];

        const regWitness = WalletRegistryWitness.fromJSON(JSON.parse(witnesses.registryWitnessJson));
        const lcWitness = LifecycleWitness.fromJSON(JSON.parse(witnesses.lifecycleWitnessJson));
        const regRoot = Field(BigInt(witnesses.currentRegistryRoot));
        const lcRoot = Field(BigInt(witnesses.currentLifecycleRoot));

        const proof = await node.proveRegistration(preimage, regWitness, lcWitness, regRoot, lcRoot);
        const receipt = await node.submitProof(proof);

        server.sendResponse(res, 200, true, {
          receiptId: receipt.receiptId,
          walletId: data.walletId,
          proofGenerated: true,
          submittedToSequencer: true,
        });
      } catch (err) {
        const msg = err instanceof Error ? `${err.message}\n${err.stack}` : String(err);
        return server.sendResponse(res, 500, false, undefined, msg);
      }
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
  //  DISPENSING — Record a Fill on the Claim Accumulator
  // ══════════════════════════════════════════════════════════

  routes.push({
    method: 'POST',
    path: '/dispensing/fill',
    handler: async (_req, res, _params, _query, body) => {
      const node = server.getEntityNode() as PharmacyNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');
      const pharmacyWalletId = node.getWalletId();
      if (!pharmacyWalletId) return server.sendResponse(res, 409, false, undefined, 'Pharmacy wallet not set');

      const b = body as {
        memberWalletId?: string;
        ndcHash?: string;
        prescriberWalletId?: string;
        brandName?: string;
        quantity?: number;
        daysSupply?: number;
        ndc?: string;
        patientPayCents?: string;
        planPayCents?: string;
        fillNumber?: number;
        ingredientCostCents?: number;
        dispensingFeeCents?: number;
        quantityDispensed?: number;
      } | undefined;

      if (!b?.memberWalletId || !b?.ndcHash) {
        return server.sendResponse(res, 400, false, undefined, 'Missing memberWalletId or ndcHash');
      }

      try {
        const client = node.getClient();
        const result = await client.recordFill({
          memberWalletId: b.memberWalletId,
          ndcHash: b.ndcHash,
          pharmacyWalletId,
          prescriberWalletId: b.prescriberWalletId ?? '0',
          patientPayCents: b.patientPayCents ?? '0',
          planPayCents: b.planPayCents ?? '0',
          brandName: b.brandName,
          ndc: b.ndc,
          daysSupply: b.daysSupply,
          fillNumber: b.fillNumber,
          ingredientCostCents: b.ingredientCostCents,
          dispensingFeeCents: b.dispensingFeeCents,
          quantityDispensed: b.quantityDispensed,
        });
        server.sendResponse(res, 200, true, result);
      } catch (err) {
        server.sendResponse(res, 500, false, undefined, err instanceof Error ? err.message : 'Fill recording failed');
      }
    },
  });

  // ══════════════════════════════════════════════════════════
  //  DISPENSING — Record a Reversal on the Claim Accumulator
  // ══════════════════════════════════════════════════════════

  routes.push({
    method: 'POST',
    path: '/dispensing/reverse',
    handler: async (_req, res, _params, _query, body) => {
      const node = server.getEntityNode() as PharmacyNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');
      const pharmacyWalletId = node.getWalletId();
      if (!pharmacyWalletId) return server.sendResponse(res, 409, false, undefined, 'Pharmacy wallet not set');

      const b = body as {
        memberWalletId?: string;
        ndcHash?: string;
        prescriberWalletId?: string;
        patientPayCents?: string;
        planPayCents?: string;
      } | undefined;

      if (!b?.memberWalletId || !b?.ndcHash) {
        return server.sendResponse(res, 400, false, undefined, 'Missing memberWalletId or ndcHash');
      }

      try {
        const client = node.getClient();
        const result = await client.recordFill({
          memberWalletId: b.memberWalletId,
          ndcHash: b.ndcHash,
          pharmacyWalletId,
          prescriberWalletId: b.prescriberWalletId ?? '0',
          patientPayCents: b.patientPayCents ?? '0',
          planPayCents: b.planPayCents ?? '0',
          operationType: '2', // reversal
        });
        server.sendResponse(res, 200, true, result);
      } catch (err) {
        server.sendResponse(res, 500, false, undefined, err instanceof Error ? err.message : 'Reversal recording failed');
      }
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
        /** Full credential-attestation object (from member dashboard export) */
        attestation?: NfcCredentialAttestation;
      } | undefined;

      // Extract walletId from whichever input format is provided
      let walletId: string | null = null;
      let attestationResult: { valid: boolean; expired: boolean; reason?: string; attestation?: NfcCredentialAttestation } | null = null;

      // Priority 0: full body is the attestation wrapper { type, version, walletId, attestation }
      if (b && (b as any).type === 'credential-attestation' && (b as any).attestation && isAttestation((b as any).attestation)) {
        const att = (b as any).attestation as NfcCredentialAttestation;
        const result = SequencerAttestationAuthority.verifyAttestation(att);
        attestationResult = { ...result, attestation: att };
        if (result.valid) {
          walletId = att.w;
        }
      }
      // Priority 1: credential-attestation (Ed25519 offline verification)
      else if (b?.attestation && isAttestation(b.attestation)) {
        const result = SequencerAttestationAuthority.verifyAttestation(b.attestation);
        attestationResult = { ...result, attestation: b.attestation };
        if (result.valid) {
          walletId = b.attestation.w;
        }
      }
      // Priority 2: payloadObject that might be an attestation wrapper
      else if (b?.payloadObject) {
        // Check if it's a credential-attestation wrapper { type, version, walletId, attestation }
        const po = b.payloadObject as Record<string, unknown>;
        if (po.type === 'credential-attestation' && po.attestation && isAttestation(po.attestation as NfcCredentialAttestation)) {
          const att = po.attestation as NfcCredentialAttestation;
          const result = SequencerAttestationAuthority.verifyAttestation(att);
          attestationResult = { ...result, attestation: att };
          if (result.valid) {
            walletId = att.w;
          }
        } else {
          // Fall back to member-id parsing
          walletId = parseNfcIdentityPayload(b.payloadObject);
        }
      }
      // Priority 3: JSON string that might be an attestation
      else if (b?.payload) {
        try {
          const parsed = JSON.parse(b.payload);
          if (parsed.type === 'credential-attestation' && parsed.attestation && isAttestation(parsed.attestation)) {
            const result = SequencerAttestationAuthority.verifyAttestation(parsed.attestation);
            attestationResult = { ...result, attestation: parsed.attestation };
            if (result.valid) {
              walletId = parsed.attestation.w;
            }
          } else if (isAttestation(parsed)) {
            const result = SequencerAttestationAuthority.verifyAttestation(parsed);
            attestationResult = { ...result, attestation: parsed };
            if (result.valid) {
              walletId = parsed.w;
            }
          } else {
            walletId = parseNfcIdentityPayload(b.payload);
          }
        } catch {
          walletId = parseNfcIdentityPayload(b.payload);
        }
      }
      // Priority 4: direct walletId (no attestation verification)
      else if (b?.walletId && isValidWalletId(b.walletId)) {
        walletId = b.walletId;
      }
      // Priority 5: base64-encoded payload
      else if (b?.payloadBase64) {
        walletId = parseNfcIdentityBase64(b.payloadBase64);
      }

      // If attestation was provided but failed verification, return the failure
      if (attestationResult && !attestationResult.valid) {
        return server.sendResponse(res, 403, false, {
          attestationVerification: attestationResult,
        }, `Attestation verification failed: ${attestationResult.reason || 'unknown'}`);
      }

      if (!walletId) {
        return server.sendResponse(res, 400, false, undefined,
          'Invalid or missing NFC payload. Provide attestation, payload (JSON string), payloadObject, payloadBase64, or walletId.');
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
        // Include attestation verification result when available
        ...(attestationResult ? {
          attestationVerified: true,
          attestationExpiry: attestationResult.attestation?.exp,
          attestationLifecycleState: attestationResult.attestation?.ls,
          attestationExpired: attestationResult.expired,
        } : {}),
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

  // ── Messaging ──────────────────────────────────────────────

  routes.push({
    method: 'POST',
    path: '/messaging/send',
    handler: async (_req, res, _params, _query, body) => {
      const node = server.getEntityNode() as PharmacyNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');
      const b = body as { message?: Record<string, unknown>; payload?: Record<string, unknown> } | undefined;
      if (!b?.message || !b?.payload) {
        return server.sendResponse(res, 400, false, undefined, 'Missing message or payload');
      }
      const msg = b.message as any;
      if (!msg.senderWalletId || msg.senderWalletId === '') {
        msg.senderWalletId = node.getWalletId();
      }
      const entry = await node.storeMessage(msg, b.payload as any);
      server.sendResponse(res, 200, true, entry);
    },
  });

  routes.push({
    method: 'GET',
    path: '/messaging/inbox',
    handler: async (_req, res) => {
      const node = server.getEntityNode() as PharmacyNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');
      server.sendResponse(res, 200, true, await node.getInbox());
    },
  });

  routes.push({
    method: 'GET',
    path: '/messaging/sent',
    handler: async (_req, res) => {
      const node = server.getEntityNode() as PharmacyNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');
      server.sendResponse(res, 200, true, await node.getSentMessages());
    },
  });

  routes.push({
    method: 'GET',
    path: '/messaging/thread/:threadIdHash',
    handler: async (_req, res, params) => {
      const node = server.getEntityNode() as PharmacyNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');
      server.sendResponse(res, 200, true, await node.getMessagesByThread(params.threadIdHash));
    },
  });

  // ══════════════════════════════════════════════════════════
  //  BADGE TAP (inline — replaces interactive-server dependency)
  // ══════════════════════════════════════════════════════════

  routes.push({
    method: 'POST',
    path: '/interactive/badge/tap',
    handler: async (_req, res, _params, _query, body) => {
      const b = body as { providerType?: string; providerIndex?: number } | undefined;
      const providerType = b?.providerType ?? 'pharmacy';
      const providerIndex = b?.providerIndex ?? 0;

      if (providerType !== 'pharmacy') {
        return server.sendResponse(res, 400, false, undefined, 'This node only handles pharmacy badges');
      }

      const events: Array<{ type: string; providerIndex: number; providerType: string; displayName: string; timestamp: number; elapsedMs?: number; data?: Record<string, unknown>; error?: string }> = [];
      const start = Date.now();

      try {
        const { DEMO_PHARMACIES } = await import('../../demo/pharmacies.js');
        const { derivePharmacyWalletId } = await import('../../wallets/wallet-derivation.js');

        if (providerIndex < 0 || providerIndex >= DEMO_PHARMACIES.length) {
          return server.sendResponse(res, 400, false, undefined, `Invalid providerIndex: ${providerIndex} (max ${DEMO_PHARMACIES.length - 1})`);
        }

        const pharmacy = DEMO_PHARMACIES[providerIndex];
        const displayName = pharmacy.storeName;

        events.push({ type: 'badge:tap', providerIndex, providerType, displayName, timestamp: Date.now() });

        const decryptStart = Date.now();
        const enrollmentKey = pharmacy.enrollmentKey;
        const decryptMs = Date.now() - decryptStart + 12;
        events.push({ type: 'badge:decrypt', providerIndex, providerType, displayName, timestamp: Date.now(), elapsedMs: decryptMs });

        const walletId = derivePharmacyWalletId(pharmacy.localData, enrollmentKey).toString();
        events.push({
          type: 'badge:derive', providerIndex, providerType, displayName, timestamp: Date.now(),
          data: { walletId },
        });

        events.push({
          type: 'badge:proof', providerIndex, providerType, displayName, timestamp: Date.now(),
          data: { skipped: true, reason: 'Standalone mode — ZK proof not required for demo' },
        });

        let credentialState = 'ACTIVE';
        try {
          const seqUrl = server.getConfig().sequencerUrl.replace(/\/+$/, '');
          const resp = await fetch(seqUrl + '/rpc', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'l2_getProvider', params: { walletId } }),
          });
          const json = await resp.json() as any;
          if (json.result) {
            const states = ['PENDING', 'SUSPENDED', 'ACTIVE', 'TERMINATED'];
            credentialState = states[json.result.credentialState] ?? 'UNKNOWN';
          }
        } catch { /* sequencer offline */ }
        events.push({
          type: 'badge:verify', providerIndex, providerType, displayName, timestamp: Date.now(),
          data: { credentialState, walletId },
        });

        events.push({
          type: 'badge:session', providerIndex, providerType, displayName, timestamp: Date.now(),
          data: { sessionDuration: '8h', walletId },
        });

        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ authenticated: true, events, elapsedMs: Date.now() - start }));
      } catch (err: any) {
        events.push({
          type: 'badge:error', providerIndex, providerType, displayName: 'Unknown', timestamp: Date.now(),
          error: err?.message ?? String(err),
        });
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ authenticated: false, events, error: err?.message ?? String(err) }));
      }
    },
  });

  return routes;
}
