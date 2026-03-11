/**
 * Prescriber Routes — REST endpoints for PrescriberNode Nautilus Apps.
 *
 * Same onboarding flow as member but uses securePrescriberDerivation()
 * with NPI credentials (prescriberIdQualifier, prescriberId).
 *
 * Additional capabilities:
 *   - Provider network lookups (in-network prescribers)
 *   - Formulary queries (plan drug lists)
 *   - PCP patient queries (assignment is on the member node — consent-based)
 */
import { Field } from 'o1js';
import { generateEnrollmentKey } from '../../wallets/wallet-derivation.js';
import { securePrescriberDerivation } from '../../security/secure-context.js';
import { exportEnrollmentBackup, importEnrollmentBackup } from '../../security/enrollment-backup.js';
import { WalletRegistryWitness } from '../../wallets/wallet-state.js';
import { LifecycleWitness } from '../../engine/lifecycle.js';
import { PrescriberNode } from '../prescriber-node.js';
import type { NautilusAppServer } from '../nautilus-app-server.js';
import type { RouteRegistration } from '../nautilus-app-types.js';
import type { PrescriberLocalData } from '../../models/prescriber.js';
import { ProviderNetworkRegistry } from '../../eligibility/provider-network-registry.js';

const DOMAIN_TAG_PRESCRIBER = 1;

/**
 * Build all prescriber routes.
 *
 * @param server — NautilusAppServer reference (captured in closures)
 * @param networkRegistry — optional ProviderNetworkRegistry for in-network queries
 */
export function buildPrescriberRoutes(
  server: NautilusAppServer,
  networkRegistry?: ProviderNetworkRegistry,
): RouteRegistration[] {
  const routes: RouteRegistration[] = [];

  // Track PCP assignments locally (prescriber → member mappings)
  const pcpPatients: Map<string, { memberWalletId: string; effectiveDate: string; specialty: string }> = new Map();

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

  // Prescriber uses NPI credentials (not member PHI)
  routes.push({
    method: 'POST',
    path: '/onboarding/derive-wallet',
    handler: async (_req, res, _params, _query, body) => {
      if (server.getOnboardingPhase() !== 'key_generated') {
        return server.sendResponse(res, 409, false, undefined, `Cannot derive wallet in phase: ${server.getOnboardingPhase()}`);
      }
      const b = body as { prescriberIdQualifier?: number; prescriberId?: string } | undefined;
      if (b?.prescriberIdQualifier === undefined || !b?.prescriberId) {
        return server.sendResponse(res, 400, false, undefined, 'Missing prescriberIdQualifier or prescriberId');
      }
      const state = server.getLocalState();
      if (!state.hasEnrollmentKey()) {
        return server.sendResponse(res, 409, false, undefined, 'Enrollment key not generated');
      }

      const localData: PrescriberLocalData = {
        prescriberIdQualifier: b.prescriberIdQualifier,
        prescriberId: b.prescriberId,
      };
      const result = state.useEnrollmentKey((key) =>
        securePrescriberDerivation(localData, key),
      );
      const walletId = result.walletId.toString();
      const preimageFields = result.preimage.map((f) => f.toString());

      const data = state.getState();
      if (data) {
        data.walletId = walletId;
        data.preimageFields = preimageFields;
        data.domainTag = DOMAIN_TAG_PRESCRIBER;
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

      const node = new PrescriberNode({
        role: 'prescriber',
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
            body: JSON.stringify({ walletId: data.walletId, tokenId: data.onboarding.tokenId, role: 'prescriber' }),
          });
          insurerNotified = resp.ok;
        } catch { /* insurer unreachable — continue */ }
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
      const node = server.getEntityNode() as PrescriberNode | null;
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

  // ── Proof: Registration ──────────────────────────────────

  routes.push({
    method: 'POST',
    path: '/proof/registration',
    handler: async (_req, res, _params, _query, _body) => {
      if (server.getOnboardingPhase() !== 'ready') {
        return server.sendResponse(res, 409, false, undefined, `Cannot generate proof in phase: ${server.getOnboardingPhase()}`);
      }
      const node = server.getEntityNode() as PrescriberNode | null;
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
        const preimage = [Field(data.domainTag ?? 1), ...padded];

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
      if (!b?.pin) {
        return server.sendResponse(res, 400, false, undefined, 'Missing pin');
      }
      const state = server.getLocalState();
      if (!state.hasEnrollmentKey()) {
        return server.sendResponse(res, 409, false, undefined, 'No enrollment key in state');
      }
      const data = state.getState();
      const pin = b.pin;
      const walletIdForBackup = data?.walletId ?? '0';
      const backup = state.useEnrollmentKey((key) =>
        exportEnrollmentBackup(key, pin, walletIdForBackup, DOMAIN_TAG_PRESCRIBER),
      );
      server.sendResponse(res, 200, true, { backup });
    },
  });

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
  //  WRITE PRESCRIPTION (e-Script via message store)
  // ══════════════════════════════════════════════════════════

  routes.push({
    method: 'POST',
    path: '/prescriptions/write',
    handler: async (_req, res, _params, _query, body) => {
      const node = server.getEntityNode() as PrescriberNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');
      const walletId = node.getWalletId();
      if (!walletId) return server.sendResponse(res, 409, false, undefined, 'No wallet ID');

      const b = body as {
        memberWalletId?: string;
        pharmacyWalletId?: string;
        ndcHash?: string;
        brandName?: string;
        quantity?: number;
        daysSupply?: number;
        refills?: number;
        directions?: string;
        diagnosis?: string;
      } | undefined;

      if (!b?.memberWalletId) return server.sendResponse(res, 400, false, undefined, 'Missing memberWalletId');
      if (!b?.pharmacyWalletId) return server.sendResponse(res, 400, false, undefined, 'Missing pharmacyWalletId');
      if (!b?.ndcHash) return server.sendResponse(res, 400, false, undefined, 'Missing ndcHash');

      const rxId = `RX-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const prescription = {
        rxId,
        prescriberWalletId: walletId,
        memberWalletId: b.memberWalletId,
        pharmacyWalletId: b.pharmacyWalletId,
        ndcHash: b.ndcHash,
        brandName: b.brandName ?? '',
        quantity: b.quantity ?? 30,
        daysSupply: b.daysSupply ?? 30,
        refills: b.refills ?? 0,
        directions: b.directions ?? '',
        diagnosis: b.diagnosis ?? '',
        dateWritten: new Date().toISOString().replace(/[-:T]/g, '').slice(0, 8),
        status: 'pending',
      };

      // Serialize the prescription as the message payload
      const rxJson = JSON.stringify(prescription);
      const rxHex = Buffer.from(rxJson, 'utf8').toString('hex');
      const threadId = `rx-${rxId}`;

      try {
        // Send to pharmacy
        const pharmacyMsg = await node.storeMessage(
          {
            messageCommitment: '0', // placeholder
            senderWalletId: walletId,
            recipientWalletId: b.pharmacyWalletId,
            messageType: '3', // eScript
            threadIdHash: threadId,
          },
          {
            ciphertext: rxHex,
            iv: '00',
            tag: '00',
            timestamp: Date.now(),
          },
        );

        // Also notify the member
        await node.storeMessage(
          {
            messageCommitment: '0',
            senderWalletId: walletId,
            recipientWalletId: b.memberWalletId,
            messageType: '3',
            threadIdHash: threadId,
          },
          {
            ciphertext: rxHex,
            iv: '00',
            tag: '00',
            timestamp: Date.now(),
          },
        );

        server.sendResponse(res, 200, true, {
          rxId,
          threadId,
          prescription,
          sentToPharmacy: true,
          sentToMember: true,
          messageIndex: pharmacyMsg.index,
        });
      } catch (err) {
        server.sendResponse(res, 500, false, undefined, err instanceof Error ? err.message : 'Failed to send prescription');
      }
    },
  });

  // ══════════════════════════════════════════════════════════
  //  PRESCRIBING HISTORY QUERIES
  // ══════════════════════════════════════════════════════════

  routes.push({
    method: 'GET',
    path: '/prescriptions',
    handler: async (_req, res) => {
      const node = server.getEntityNode() as PrescriberNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');
      server.sendResponse(res, 200, true, await node.getPrescribingHistory());
    },
  });

  routes.push({
    method: 'GET',
    path: '/prescriptions/summary',
    handler: async (_req, res) => {
      const node = server.getEntityNode() as PrescriberNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');
      server.sendResponse(res, 200, true, await node.getActivitySummary());
    },
  });

  routes.push({
    method: 'GET',
    path: '/prescriptions/range',
    handler: async (_req, res, _params, query) => {
      const node = server.getEntityNode() as PrescriberNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');
      const start = query.get('start');
      const end = query.get('end');
      if (!start || !end) return server.sendResponse(res, 400, false, undefined, 'Missing start or end');
      server.sendResponse(res, 200, true, await node.getPrescribingHistoryByDateRange(start, end));
    },
  });

  routes.push({
    method: 'GET',
    path: '/prescriptions/patient/:memberWalletId',
    handler: async (_req, res, params) => {
      const node = server.getEntityNode() as PrescriberNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');
      server.sendResponse(res, 200, true, await node.getClaimsByPatient(params.memberWalletId));
    },
  });

  routes.push({
    method: 'GET',
    path: '/prescriptions/medication/:ndcHash',
    handler: async (_req, res, params) => {
      const node = server.getEntityNode() as PrescriberNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');
      server.sendResponse(res, 200, true, await node.getClaimsByMedication(params.ndcHash));
    },
  });

  routes.push({
    method: 'GET',
    path: '/prescriptions/pharmacy/:pharmacyWalletId',
    handler: async (_req, res, params) => {
      const node = server.getEntityNode() as PrescriberNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');
      server.sendResponse(res, 200, true, await node.getClaimsByPharmacy(params.pharmacyWalletId));
    },
  });

  routes.push({
    method: 'GET',
    path: '/prescriptions/patients/count',
    handler: async (_req, res) => {
      const node = server.getEntityNode() as PrescriberNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');
      server.sendResponse(res, 200, true, { count: await node.getUniquePatientCount() });
    },
  });

  routes.push({
    method: 'GET',
    path: '/prescriptions/pharmacies/count',
    handler: async (_req, res) => {
      const node = server.getEntityNode() as PrescriberNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');
      server.sendResponse(res, 200, true, { count: await node.getUniquePharmacyCount() });
    },
  });

  routes.push({
    method: 'GET',
    path: '/prescriptions/medications/breakdown',
    handler: async (_req, res) => {
      const node = server.getEntityNode() as PrescriberNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');
      server.sendResponse(res, 200, true, await node.getMedicationBreakdown());
    },
  });

  // ══════════════════════════════════════════════════════════
  //  PROVIDER NETWORK
  // ══════════════════════════════════════════════════════════

  routes.push({
    method: 'GET',
    path: '/network/prescribers',
    handler: async (_req, res) => {
      if (!networkRegistry) {
        return server.sendResponse(res, 404, false, undefined, 'Provider network not configured');
      }
      server.sendResponse(res, 200, true, {
        count: networkRegistry.count,
        root: networkRegistry.getRoot().toString(),
      });
    },
  });

  routes.push({
    method: 'GET',
    path: '/network/check/:walletId',
    handler: async (_req, res, params) => {
      if (!networkRegistry) {
        return server.sendResponse(res, 404, false, undefined, 'Provider network not configured');
      }
      const inNetwork = networkRegistry.isInNetwork(Field(BigInt(params.walletId)));
      server.sendResponse(res, 200, true, { walletId: params.walletId, inNetwork });
    },
  });

  routes.push({
    method: 'GET',
    path: '/network/count',
    handler: async (_req, res) => {
      if (!networkRegistry) {
        return server.sendResponse(res, 404, false, undefined, 'Provider network not configured');
      }
      server.sendResponse(res, 200, true, { count: networkRegistry.count });
    },
  });

  // ══════════════════════════════════════════════════════════
  //  FORMULARY
  // ══════════════════════════════════════════════════════════

  routes.push({
    method: 'GET',
    path: '/formulary/:planIdHash',
    handler: async (_req, res, params) => {
      const node = server.getEntityNode() as PrescriberNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');
      const formulary = await node.getFormulary(params.planIdHash);
      if (!formulary) return server.sendResponse(res, 404, false, undefined, 'Formulary not found');
      server.sendResponse(res, 200, true, formulary);
    },
  });

  routes.push({
    method: 'GET',
    path: '/formulary/:planIdHash/check/:ndcHash',
    handler: async (_req, res, params) => {
      const node = server.getEntityNode() as PrescriberNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');
      const formulary = await node.getFormulary(params.planIdHash);
      if (!formulary) return server.sendResponse(res, 404, false, undefined, 'Formulary not found');
      // Parse formulary entries to check for the specific drug
      try {
        const entries = JSON.parse(formulary.entriesJson) as Array<{ ndcHash?: string; tierLevel?: number; copay?: number }>;
        const entry = entries.find((e) => e.ndcHash === params.ndcHash);
        server.sendResponse(res, 200, true, {
          ndcHash: params.ndcHash,
          onFormulary: !!entry,
          tierLevel: entry?.tierLevel,
          copay: entry?.copay,
        });
      } catch {
        server.sendResponse(res, 200, true, { ndcHash: params.ndcHash, onFormulary: false });
      }
    },
  });

  // ══════════════════════════════════════════════════════════
  //  NETWORK PROVIDERS (query sequencer entity registry)
  // ══════════════════════════════════════════════════════════

  routes.push({
    method: 'GET',
    path: '/providers',
    handler: async (_req, res, _params, query) => {
      const node = server.getEntityNode() as PrescriberNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');
      const roleFilter = query.get('role') ?? undefined;
      try {
        const seqUrl = server.getConfig().sequencerUrl.replace(/\/+$/, '');
        const resp = await fetch(`${seqUrl}/rpc`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'l2_getNetworkProviders',
            params: roleFilter ? { role: roleFilter } : {},
          }),
        });
        const json = await resp.json() as { result?: unknown; error?: { message?: string } };
        if (json.error) {
          return server.sendResponse(res, 502, false, undefined, json.error.message ?? 'Sequencer error');
        }
        server.sendResponse(res, 200, true, json.result);
      } catch (err) {
        server.sendResponse(res, 502, false, undefined, err instanceof Error ? err.message : 'Sequencer unreachable');
      }
    },
  });

  // ══════════════════════════════════════════════════════════
  //  PCP QUERIES (assignment is on the MEMBER node — consent-based)
  // ══════════════════════════════════════════════════════════

  routes.push({
    method: 'GET',
    path: '/pcp/patients',
    handler: async (_req, res) => {
      const patients = Array.from(pcpPatients.values());
      server.sendResponse(res, 200, true, { patients, count: patients.length });
    },
  });

  // ── Query: Proof Timings ──────────────────────────────────

  routes.push({
    method: 'GET',
    path: '/proof-timings',
    handler: async (_req, res) => {
      const node = server.getEntityNode() as PrescriberNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');
      server.sendResponse(res, 200, true, node.getProofTimings());
    },
  });

  // ── Messaging ──────────────────────────────────────────────

  routes.push({
    method: 'POST',
    path: '/messaging/send',
    handler: async (_req, res, _params, _query, body) => {
      const node = server.getEntityNode() as PrescriberNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');
      const b = body as { message?: Record<string, unknown>; payload?: Record<string, unknown> } | undefined;
      if (!b?.message || !b?.payload) {
        return server.sendResponse(res, 400, false, undefined, 'Missing message or payload');
      }
      const entry = await node.storeMessage(b.message as any, b.payload as any);
      server.sendResponse(res, 200, true, entry);
    },
  });

  routes.push({
    method: 'GET',
    path: '/messaging/inbox',
    handler: async (_req, res) => {
      const node = server.getEntityNode() as PrescriberNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');
      server.sendResponse(res, 200, true, await node.getInbox());
    },
  });

  routes.push({
    method: 'GET',
    path: '/messaging/sent',
    handler: async (_req, res) => {
      const node = server.getEntityNode() as PrescriberNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');
      server.sendResponse(res, 200, true, await node.getSentMessages());
    },
  });

  routes.push({
    method: 'GET',
    path: '/messaging/thread/:threadIdHash',
    handler: async (_req, res, params) => {
      const node = server.getEntityNode() as PrescriberNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');
      server.sendResponse(res, 200, true, await node.getMessagesByThread(params.threadIdHash));
    },
  });

  return routes;
}
