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
import { Field, Poseidon } from 'o1js';
import { generateEnrollmentKey } from '../../wallets/wallet-derivation.js';
import { hashString } from '../../zkp/hash-utils.js';
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

  /** Sync PCP assignments from the sequencer registry */
  async function syncPcpFromSequencer() {
    try {
      const seqUrl = server.getConfig().sequencerUrl.replace(/\/+$/, '');
      const node = server.getEntityNode() as PrescriberNode | null;

      // Collect all prescriber wallet IDs to check
      const walletsToCheck: string[] = [];
      if (node) {
        const ownWid = node.getWalletId();
        if (ownWid) walletsToCheck.push(ownWid);
      }

      // Always check seeded prescriber wallets from entity registry
      try {
        const res = await fetch(seqUrl + '/rpc', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'l2_getNetworkProviders', params: { role: 'prescriber' } }),
        });
        const json = await res.json() as any;
        if (json.result && Array.isArray(json.result)) {
          for (const p of json.result) {
            if (p.walletId && !walletsToCheck.includes(p.walletId)) walletsToCheck.push(p.walletId);
          }
        }
      } catch { /* ignore */ }

      if (walletsToCheck.length === 0) return;

      // Query PCP assignments for each wallet
      for (const wid of walletsToCheck) {
        try {
          const res = await fetch(seqUrl + '/rpc', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'l2_getPcpAssignments', params: { prescriberWalletId: wid } }),
          });
          const json = await res.json() as any;
          if (json.result && Array.isArray(json.result)) {
            for (const a of json.result) {
              if (!pcpPatients.has(a.memberWalletId)) {
                pcpPatients.set(a.memberWalletId, {
                  memberWalletId: a.memberWalletId,
                  effectiveDate: a.effectiveDate ?? new Date().toISOString().slice(0, 10),
                  specialty: 'Primary Care',
                });
              }
            }
          }
        } catch { /* ignore */ }
      }

      // Also scan inbox for PCP_ASSIGN messages (type '6') if node is ready
      if (node) {
        try {
          const inbox = await node.getInbox();
          for (const entry of inbox) {
            if (entry.message.messageType === '6') {
              const mid = entry.message.senderWalletId;
              if (!pcpPatients.has(mid)) {
                const date = entry.payload?.timestamp
                  ? new Date(entry.payload.timestamp).toISOString().slice(0, 10)
                  : new Date().toISOString().slice(0, 10);
                pcpPatients.set(mid, { memberWalletId: mid, effectiveDate: date, specialty: 'Primary Care' });
              }
            }
          }
        } catch { /* ignore */ }
      }
    } catch { /* sequencer not ready */ }
  }

  // Poll sequencer every 10s for PCP assignments
  setInterval(syncPcpFromSequencer, 10_000);
  setTimeout(syncPcpFromSequencer, 3_000);

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
        clientOptions: server.getConfig().adminToken ? { adminToken: server.getConfig().adminToken } : undefined,
      });
      server.setEntityNode(node);

      // Notify insurer (non-blocking)
      let insurerNotified = false;
      if (b?.insurerUrl) {
        try {
          const enrollHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
          const adminToken = server.getConfig().adminToken;
          if (adminToken) enrollHeaders['Authorization'] = `Bearer ${adminToken}`;
          const resp = await fetch(`${b.insurerUrl}/enrollment/process`, {
            method: 'POST',
            headers: enrollHeaders,
            body: JSON.stringify({ walletId: data.walletId, tokenId: data.onboarding.tokenId, role: 'prescriber' }),
          });
          insurerNotified = resp.ok;
        } catch (insErr: unknown) {
          console.warn('[prescriber-enroll] Insurer notification failed:', insErr instanceof Error ? insErr.message : String(insErr));
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

        // Reconstruct transition preimage: [domainTag, ...walletFields padded to 6]
        const walletFields = data.preimageFields.map((s: string) => Field(BigInt(s)));
        const padded = [...walletFields];
        while (padded.length < 6) padded.push(Field(0));
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
      const threadIdHash = hashString(`rx-${rxId}`);
      const messageCommitment = Poseidon.hash([Field(BigInt(walletId)), Field(Date.now())]).toString();

      try {
        // Send to pharmacy
        const pharmacyMsg = await node.storeMessage(
          {
            messageCommitment: messageCommitment,
            senderWalletId: walletId,
            recipientWalletId: b.pharmacyWalletId,
            messageType: '3', // eScript
            threadIdHash: threadIdHash,
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
            messageCommitment: messageCommitment,
            senderWalletId: walletId,
            recipientWalletId: b.memberWalletId,
            messageType: '3',
            threadIdHash: threadIdHash,
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
          threadIdHash: threadIdHash,
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
  //  PRESCRIBE WITH ZK PROOF (async — polls for result)
  // ══════════════════════════════════════════════════════════

  // In-memory job map for async prescription proof tracking
  const prescribeJobs = new Map<string, {
    status: 'pending' | 'complete' | 'error';
    result?: unknown;
    error?: string;
    rxId?: string;
    createdAt: number;
  }>();

  routes.push({
    method: 'POST',
    path: '/prescriptions/prescribe',
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
      const jobKey = `prescribe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      // 1. Store eScript messages (pharmacy + member) — immediate delivery
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

      const rxJson = JSON.stringify(prescription);
      const rxHex = Buffer.from(rxJson, 'utf8').toString('hex');
      const threadIdHash = hashString(`rx-${rxId}`).toString();
      const messageCommitment = Poseidon.hash([Field(BigInt(walletId)), Field(Date.now())]).toString();

      try {
        await node.storeMessage(
          { messageCommitment, senderWalletId: walletId, recipientWalletId: b.pharmacyWalletId!, messageType: '3', threadIdHash },
          { ciphertext: rxHex, iv: '00', tag: '00', timestamp: Date.now() },
        );
        await node.storeMessage(
          { messageCommitment, senderWalletId: walletId, recipientWalletId: b.memberWalletId!, messageType: '3', threadIdHash },
          { ciphertext: rxHex, iv: '00', tag: '00', timestamp: Date.now() },
        );
      } catch (err) {
        return server.sendResponse(res, 500, false, undefined,
          'Failed to send eScript: ' + (err instanceof Error ? err.message : String(err)));
      }

      // 2. Fire-and-forget: call sequencer /interactive/prescribe for ZK proofs
      prescribeJobs.set(jobKey, { status: 'pending', rxId, createdAt: Date.now() });

      const seqUrl = server.getConfig().sequencerUrl.replace(/\/+$/, '');
      (async () => {
        try {
          // Resolve prescriberIndex from wallet ID via sequencer seed data
          const resolveResp = await fetch(`${seqUrl}/interactive/resolve-indices`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              prescriberWalletId: walletId,
              pharmacyWalletId: b!.pharmacyWalletId,
              ndcHash: b!.ndcHash,
            }),
          });

          let prescriberIndex: number;
          let pharmacyIndex: number;

          if (resolveResp.ok) {
            const indices = await resolveResp.json() as { prescriberIndex: number; pharmacyIndex: number };
            prescriberIndex = indices.prescriberIndex;
            pharmacyIndex = indices.pharmacyIndex;
          } else {
            // Fallback: use index 0 for all (first seed entity)
            prescriberIndex = 0;
            pharmacyIndex = 0;
          }

          const proveResp = await fetch(`${seqUrl}/interactive/prescribe`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              prescriberIndex,
              memberWalletId: b!.memberWalletId,
              ndcHash: b!.ndcHash,
              pharmacyIndex,
              quantity: b!.quantity ?? 30,
              refills: b!.refills ?? 0,
              rxId,  // pass prescriber-generated ID so both sides use the same prescription ID
            }),
          });

          const proveResult = await proveResp.json() as Record<string, unknown>;
          if (!proveResp.ok) {
            const job = prescribeJobs.get(jobKey);
            if (job) { job.status = 'error'; job.error = (proveResult.error as string) || `HTTP ${proveResp.status}`; }
          } else {
            const job = prescribeJobs.get(jobKey);
            if (job) { job.status = 'complete'; job.result = proveResult; }
          }
        } catch (err) {
          const job = prescribeJobs.get(jobKey);
          if (job) { job.status = 'error'; job.error = err instanceof Error ? err.message : String(err); }
        }
      })();

      // 3. Return 202 immediately — dashboard polls for status
      server.sendResponse(res, 202, true, {
        jobKey,
        rxId,
        prescription,
        eScriptDelivered: true,
        proofStatus: 'pending',
      });
    },
  });

  // Poll prescription proof status
  routes.push({
    method: 'GET',
    path: '/prescriptions/prescribe-status',
    handler: async (_req, res, _params, query) => {
      const jobKey = query?.get('jobKey') ?? undefined;
      if (!jobKey) return server.sendResponse(res, 400, false, undefined, 'Missing jobKey');

      const job = prescribeJobs.get(jobKey);
      if (!job) return server.sendResponse(res, 404, false, undefined, 'Job not found');

      server.sendResponse(res, 200, true, {
        status: job.status,
        rxId: job.rxId,
        ...(job.status === 'complete' ? { result: job.result } : {}),
        ...(job.status === 'error' ? { error: job.error } : {}),
        elapsedMs: Date.now() - job.createdAt,
      });

      // Clean up completed/failed jobs after read
      if (job.status !== 'pending') {
        prescribeJobs.delete(jobKey);
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

  // ── Option C: Paginated Formulary Queries (proxy to sequencer RPC) ──

  routes.push({
    method: 'GET',
    path: '/formulary-categories',
    handler: async (_req, res) => {
      try {
        const seqUrl = server.getConfig().sequencerUrl.replace(/\/+$/, '');
        const resp = await fetch(`${seqUrl}/rpc`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'l2_getFormularyCategories', params: {} }),
        });
        const json = await resp.json() as any;
        if (json.error) throw new Error(json.error.message);
        server.sendResponse(res, 200, true, json.result);
      } catch (err: any) {
        server.sendResponse(res, 502, false, undefined, err.message);
      }
    },
  });

  routes.push({
    method: 'GET',
    path: '/formulary-page',
    handler: async (_req, res, _params, query) => {
      try {
        const seqUrl = server.getConfig().sequencerUrl.replace(/\/+$/, '');
        const filter: any = {};
        if (query.get('namePrefix')) filter.namePrefix = query.get('namePrefix');
        if (query.get('classification')) filter.classification = query.get('classification');
        if (query.get('tierLevel')) filter.tierLevel = parseInt(query.get('tierLevel')!, 10);
        if (query.get('route')) filter.route = query.get('route');
        if (query.get('planIdHash')) filter.planIdHash = query.get('planIdHash');
        const offset = parseInt(query.get('offset') ?? '0', 10);
        const limit = parseInt(query.get('limit') ?? '100', 10);
        const resp = await fetch(`${seqUrl}/rpc`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'l2_getFormularyPage', params: { filter, offset, limit } }),
        });
        const json = await resp.json() as any;
        if (json.error) throw new Error(json.error.message);
        server.sendResponse(res, 200, true, json.result);
      } catch (err: any) {
        server.sendResponse(res, 502, false, undefined, err.message);
      }
    },
  });

  routes.push({
    method: 'GET',
    path: '/formulary-drug/:ndcHash',
    handler: async (_req, res, params) => {
      try {
        const seqUrl = server.getConfig().sequencerUrl.replace(/\/+$/, '');
        const resp = await fetch(`${seqUrl}/rpc`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'l2_getDrugDetail', params: { ndcHash: params.ndcHash } }),
        });
        const json = await resp.json() as any;
        if (json.error) throw new Error(json.error.message);
        server.sendResponse(res, 200, true, json.result);
      } catch (err: any) {
        server.sendResponse(res, 502, false, undefined, err.message);
      }
    },
  });

  routes.push({
    method: 'GET',
    path: '/formulary-routes',
    handler: async (_req, res) => {
      try {
        const seqUrl = server.getConfig().sequencerUrl.replace(/\/+$/, '');
        const resp = await fetch(`${seqUrl}/rpc`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'l2_getFormularyRoutes', params: {} }),
        });
        const json = await resp.json() as any;
        if (json.error) throw new Error(json.error.message);
        server.sendResponse(res, 200, true, json.result);
      } catch (err: any) {
        server.sendResponse(res, 502, false, undefined, err.message);
      }
    },
  });

  routes.push({
    method: 'GET',
    path: '/formulary-drug-count',
    handler: async (_req, res) => {
      try {
        const seqUrl = server.getConfig().sequencerUrl.replace(/\/+$/, '');
        const resp = await fetch(`${seqUrl}/rpc`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'l2_getFormularyDrugCount', params: {} }),
        });
        const json = await resp.json() as any;
        if (json.error) throw new Error(json.error.message);
        server.sendResponse(res, 200, true, json.result);
      } catch (err: any) {
        server.sendResponse(res, 502, false, undefined, err.message);
      }
    },
  });

  routes.push({
    method: 'GET',
    path: '/formulary-root',
    handler: async (_req, res) => {
      try {
        const seqUrl = server.getConfig().sequencerUrl.replace(/\/+$/, '');
        const resp = await fetch(`${seqUrl}/rpc`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'l2_getFormularyRoot', params: {} }),
        });
        const json = await resp.json() as any;
        if (json.error) throw new Error(json.error.message);
        server.sendResponse(res, 200, true, json.result);
      } catch (err: any) {
        server.sendResponse(res, 502, false, undefined, err.message);
      }
    },
  });

  routes.push({
    method: 'GET',
    path: '/formulary-witness/:ndcHash',
    handler: async (_req, res, params) => {
      try {
        const seqUrl = server.getConfig().sequencerUrl.replace(/\/+$/, '');
        const resp = await fetch(`${seqUrl}/rpc`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'l2_getFormularyWitness', params: { ndcHash: params.ndcHash } }),
        });
        const json = await resp.json() as any;
        if (json.error) throw new Error(json.error.message);
        server.sendResponse(res, 200, true, json.result);
      } catch (err: any) {
        server.sendResponse(res, 502, false, undefined, err.message);
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
      await syncPcpFromSequencer();
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
      // Ensure senderWalletId is set server-side (dashboard may not have it yet)
      const msg = b.message;
      if (!msg.senderWalletId || msg.senderWalletId === '') {
        msg.senderWalletId = node.getWalletId();
      }
      const entry = await node.storeMessage(msg as any, b.payload as any);
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

  // ══════════════════════════════════════════════════════════
  //  PRESCRIBER LIST (for dashboard dropdown)
  // ══════════════════════════════════════════════════════════

  routes.push({
    method: 'GET',
    path: '/prescribers/list',
    handler: async (_req, res) => {
      const { PRESCRIBERS } = await import('../../data/index.js');
      // Also load raw JSON for extra fields (city, address) not on SeedPrescriber type
      const fs = await import('fs');
      const path = await import('path');
      let rawData: Array<{ city?: string; address?: string }> = [];
      try {
        const dataDir = process.env.ZKP_DATA_DIR || path.join(process.cwd(), 'src', 'data');
        rawData = JSON.parse(fs.readFileSync(path.join(dataDir, 'prescribers.json'), 'utf-8'));
      } catch { /* fall back to empty */ }

      const list = PRESCRIBERS.map((p, i) => ({
        index: i,
        npi: p.localData.prescriberId,
        name: (p.credential === 'NP' || p.credential === 'PA')
          ? `${p.firstName} ${p.lastName}`
          : `Dr. ${p.firstName} ${p.lastName}`,
        firstName: p.firstName,
        lastName: p.lastName,
        credential: p.credential,
        specialty: p.specialty,
        state: p.state,
        city: rawData[i]?.city ?? '',
      }));
      server.sendResponse(res, 200, true, list);
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
      const providerType = b?.providerType ?? 'prescriber';
      const providerIndex = b?.providerIndex ?? 0;

      if (providerType !== 'prescriber') {
        return server.sendResponse(res, 400, false, undefined, 'This node only handles prescriber badges');
      }

      const events: Array<{ type: string; providerIndex: number; providerType: string; displayName: string; timestamp: number; elapsedMs?: number; data?: Record<string, unknown>; error?: string }> = [];
      const start = Date.now();

      try {
        // Load seed prescriber data
        const { PRESCRIBERS } = await import('../../data/index.js');
        const { derivePrescriberWalletId } = await import('../../wallets/wallet-derivation.js');

        if (providerIndex < 0 || providerIndex >= PRESCRIBERS.length) {
          return server.sendResponse(res, 400, false, undefined, `Invalid providerIndex: ${providerIndex} (max ${PRESCRIBERS.length - 1})`);
        }

        const prescriber = PRESCRIBERS[providerIndex];
        const displayName = `Dr. ${prescriber.firstName} ${prescriber.lastName}, ${prescriber.credential}`;

        // Step 1: badge:tap
        events.push({ type: 'badge:tap', providerIndex, providerType, displayName, timestamp: Date.now() });

        // Step 2: badge:decrypt — simulate decrypting enrollment key from badge
        const decryptStart = Date.now();
        // In production this would be AES-GCM decrypt of NFC payload
        const enrollmentKey = prescriber.enrollmentKey;
        const decryptMs = Date.now() - decryptStart + 12; // add realistic latency
        events.push({ type: 'badge:decrypt', providerIndex, providerType, displayName, timestamp: Date.now(), elapsedMs: decryptMs });

        // Step 3: badge:derive — derive walletId
        const walletId = derivePrescriberWalletId(prescriber.localData, enrollmentKey).toString();
        events.push({
          type: 'badge:derive', providerIndex, providerType, displayName, timestamp: Date.now(),
          data: { walletId },
        });

        // Step 4: badge:proof — skip ZK proof in standalone mode (programs not compiled)
        events.push({
          type: 'badge:proof', providerIndex, providerType, displayName, timestamp: Date.now(),
          data: { skipped: true, reason: 'Standalone mode — ZK proof not required in standalone mode' },
        });

        // Step 5: badge:verify — check provider registry on sequencer; register if first time
        let credentialState = 'ACTIVE';
        let isNewWallet = false;
        try {
          const seqUrl = server.getConfig().sequencerUrl.replace(/\/+$/, '');
          const adminToken = server.getConfig().adminToken ?? 'admin123';
          const resp = await fetch(seqUrl + '/rpc', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'l2_getProvider', params: { walletId } }),
          });
          const json = await resp.json() as any;
          if (json.result) {
            const states = ['PENDING', 'SUSPENDED', 'ACTIVE', 'TERMINATED'];
            credentialState = states[json.result.credentialState] ?? 'UNKNOWN';
          } else {
            // First time alias — register this prescriber's wallet on the sequencer
            isNewWallet = true;
            console.log(`[badge:tap] First alias for ${displayName} — registering wallet ${walletId.slice(0, 16)}… on sequencer`);
            const regResp = await fetch(seqUrl + '/rpc', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${adminToken}`,
              },
              body: JSON.stringify({
                jsonrpc: '2.0', id: 2, method: 'l2_registerEntity',
                params: {
                  walletId,
                  displayName,
                  type: 'prescriber',
                  npi: String(prescriber.localData.prescriberId),
                  specialty: prescriber.specialty,
                },
              }),
            });
            const regJson = await regResp.json() as any;
            if (regJson.error) {
              console.warn(`[badge:tap] Entity registration failed: ${regJson.error.message}`);
            } else {
              console.log(`[badge:tap] Prescriber ${displayName} registered on sequencer`);
              credentialState = 'ACTIVE';
            }
          }
        } catch (regErr: any) {
          console.warn(`[badge:tap] Sequencer check/register failed: ${regErr?.message ?? regErr}`);
        }
        events.push({
          type: 'badge:verify', providerIndex, providerType, displayName, timestamp: Date.now(),
          data: { credentialState, walletId, isNewWallet },
        });

        // Step 6: badge:session — issue session
        events.push({
          type: 'badge:session', providerIndex, providerType, displayName, timestamp: Date.now(),
          data: { sessionDuration: '8h', walletId, isNewWallet },
        });

        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({
          authenticated: true,
          events,
          elapsedMs: Date.now() - start,
        }));
      } catch (err: any) {
        const displayName = 'Unknown';
        events.push({
          type: 'badge:error', providerIndex, providerType, displayName, timestamp: Date.now(),
          error: err?.message ?? String(err),
        });
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({
          authenticated: false,
          events,
          error: err?.message ?? String(err),
        }));
      }
    },
  });

  return routes;
}
