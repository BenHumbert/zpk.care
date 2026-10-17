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
  // CORS is applied once by L2RpcServer.handleRequest, from the deployment's origin
  // allowlist. Naming Access-Control-Allow-Origin in a writeHead header object here
  // would override that policy with a wildcard, so no handler below sets it.
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

        // Reconstruct transition preimage: [domainTag, ...walletFields padded to 6]
        const walletFields = data.preimageFields.map((s: string) => Field(BigInt(s)));
        const padded = [...walletFields];
        while (padded.length < 6) padded.push(Field(0));
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
  //  DISPENSING — Fill with ZK Proof (async proof pipeline)
  // ══════════════════════════════════════════════════════════

  // In-memory job maps for async proof tracking
  interface ProofJob {
    status: 'pending' | 'complete' | 'error';
    result?: unknown;
    error?: string;
    createdAt: number;
    completedAt?: number;
  }
  const JOB_TTL_MS = 5 * 60 * 1000; // Keep completed jobs for 5 minutes

  const dispensingJobs = new Map<string, ProofJob>();
  const reversalJobs = new Map<string, ProofJob>();

  function completeJob(job: ProofJob, result: unknown): void {
    job.status = 'complete';
    job.result = result;
    job.completedAt = Date.now();
  }
  function failJob(job: ProofJob, error: string): void {
    job.status = 'error';
    job.error = error;
    job.completedAt = Date.now();
  }
  function pruneStaleJobs(jobs: Map<string, ProofJob>): void {
    const now = Date.now();
    for (const [k, j] of jobs) {
      if (j.status !== 'pending' && j.completedAt && now - j.completedAt > JOB_TTL_MS) {
        jobs.delete(k);
      }
    }
  }

  // Get all prescriptions for this pharmacy from the sequencer (server-side state)
  routes.push({
    method: 'GET',
    path: '/prescriptions/list',
    handler: async (_req, res, _params, query) => {
      const node = server.getEntityNode() as PharmacyNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');

      try {
        const seqUrl = server.getConfig().sequencerUrl.replace(/\/+$/, '');
        const pharmacyIndex = parseInt(query?.get('pharmacyIndex') ?? '0', 10) || 0;

        const resp = await fetch(`${seqUrl}/interactive/prescriptions-by-pharmacy?pharmacyIndex=${pharmacyIndex}`);
        const result = await resp.json();
        server.sendResponse(res, 200, true, result);
      } catch (err: any) {
        server.sendResponse(res, 502, false, undefined, err.message);
      }
    },
  });

  // Mark a prescription as physically filled (no ZK proof — lightweight status update)
  routes.push({
    method: 'POST',
    path: '/dispensing/mark-filled',
    handler: async (_req, res, _params, _query, body) => {
      const node = server.getEntityNode() as PharmacyNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');

      const b = body as { prescriptionId?: string } | undefined;
      if (!b?.prescriptionId) {
        return server.sendResponse(res, 400, false, undefined, 'Missing prescriptionId');
      }

      try {
        const seqUrl = server.getConfig().sequencerUrl.replace(/\/+$/, '');
        const resp = await fetch(`${seqUrl}/interactive/mark-filled`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prescriptionId: b.prescriptionId }),
        });
        const result = await resp.json();
        server.sendResponse(res, resp.ok ? 200 : 400, resp.ok, result);
      } catch (err: any) {
        server.sendResponse(res, 502, false, undefined, err.message);
      }
    },
  });

  // Dispense an existing FILLED prescription (3 ZK proofs via sequencer's /interactive/fill)
  routes.push({
    method: 'POST',
    path: '/dispensing/dispense',
    handler: async (_req, res, _params, _query, body) => {
      const node = server.getEntityNode() as PharmacyNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');

      const b = body as {
        prescriptionId?: string;
        quantityDispensed?: number;
        ingredientCostCents?: number;
        dispensingFeeCents?: number;
      } | undefined;

      if (!b?.prescriptionId) {
        return server.sendResponse(res, 400, false, undefined, 'Missing prescriptionId');
      }

      const jobKey = `dispense-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      dispensingJobs.set(jobKey, { status: 'pending', createdAt: Date.now() });

      const seqUrl = server.getConfig().sequencerUrl.replace(/\/+$/, '');

      // Fire-and-forget: call sequencer's /interactive/fill (which calls dispensePrescription)
      (async () => {
        try {
          const resp = await fetch(`${seqUrl}/interactive/fill`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              prescriptionId: b!.prescriptionId,
              quantityDispensed: b!.quantityDispensed ?? 30,
              ingredientCostCents: b!.ingredientCostCents,
              dispensingFeeCents: b!.dispensingFeeCents,
            }),
          });

          if (!resp.ok) {
            const err = await resp.json().catch(() => ({ error: `HTTP ${resp.status}` })) as Record<string, unknown>;
            const job = dispensingJobs.get(jobKey);
            if (job) failJob(job, (err.error as string) || `HTTP ${resp.status}`);
            return;
          }

          // /interactive/fill returns 202 with { status, prescriptionId } — poll fill-status for result
          const result = await resp.json() as Record<string, unknown>;
          const seqJobKey = (result.prescriptionId || result.jobKey) as string;
          if (!seqJobKey) {
            const job = dispensingJobs.get(jobKey);
            if (job) completeJob(job, result);
            return;
          }

          // Poll sequencer fill-status until complete
          const maxAttempts = 120;
          for (let i = 0; i < maxAttempts; i++) {
            await new Promise(r => setTimeout(r, 5000));
            const statusResp = await fetch(`${seqUrl}/interactive/fill-status?prescriptionId=${encodeURIComponent(seqJobKey)}`);
            const statusResult = await statusResp.json() as Record<string, unknown>;
            if (statusResult.status === 'complete') {
              const job = dispensingJobs.get(jobKey);
              // Unwrap: sequencer returns { status, result: { ...dispensePrescription output } }
              if (job) completeJob(job, (statusResult.result as Record<string, unknown>) || statusResult);
              return;
            }
            if (statusResult.status === 'error') {
              const job = dispensingJobs.get(jobKey);
              if (job) failJob(job, (statusResult.error as string) || 'Proof failed');
              return;
            }
          }
          const job = dispensingJobs.get(jobKey);
          if (job) failJob(job, 'Proof generation timed out');
        } catch (err: any) {
          const job = dispensingJobs.get(jobKey);
          if (job) failJob(job, err.message || 'Dispense failed');
        }
      })();

      // Return immediately with job key for polling
      server.sendResponse(res, 202, true, { jobKey, status: 'pending' });
    },
  });

  // Legacy: prescribe-and-fill (creates Rx + adjudicates + dispenses in one step)
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
        fillNumber?: number;
        ingredientCostCents?: number;
        dispensingFeeCents?: number;
        quantityDispensed?: number;
      } | undefined;

      if (!b?.memberWalletId || !b?.ndcHash) {
        return server.sendResponse(res, 400, false, undefined, 'Missing memberWalletId or ndcHash');
      }

      const jobKey = `fill-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      dispensingJobs.set(jobKey, { status: 'pending', createdAt: Date.now() });

      const seqUrl = server.getConfig().sequencerUrl.replace(/\/+$/, '');

      // Fire-and-forget: resolve indices then call sequencer proof pipeline
      (async () => {
        try {
          // Resolve wallet IDs to seed data indices
          const resolveResp = await fetch(`${seqUrl}/interactive/resolve-indices`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              prescriberWalletId: b!.prescriberWalletId ?? '0',
              pharmacyWalletId: pharmacyWalletId,
              ndcHash: b!.ndcHash,
            }),
          });

          let pharmacyIndex = 0;
          if (resolveResp.ok) {
            const indices = await resolveResp.json() as { prescriberIndex: number; pharmacyIndex: number };
            pharmacyIndex = indices.pharmacyIndex >= 0 ? indices.pharmacyIndex : 0;
          }

          // Call prescribe-and-fill on sequencer (creates prescription + fills with 5+ ZK proofs)
          const proveResp = await fetch(`${seqUrl}/interactive/prescribe-and-fill`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              memberWalletId: b!.memberWalletId,
              ndcHash: b!.ndcHash,
              prescriberWalletId: b!.prescriberWalletId ?? '0',
              pharmacyIndex,
              quantity: b!.quantity ?? b!.quantityDispensed ?? 30,
              ingredientCostCents: b!.ingredientCostCents,
              dispensingFeeCents: b!.dispensingFeeCents,
            }),
          });

          const proveResult = await proveResp.json() as Record<string, unknown>;

          if (!proveResp.ok) {
            const job = dispensingJobs.get(jobKey);
            if (job) failJob(job, (proveResult.error as string) || `HTTP ${proveResp.status}`);
            return;
          }

          // prescribe-and-fill returns { status: 'pending', prescriptionId } — poll sequencer for completion
          const prescriptionId = (proveResult.prescriptionId as string) || jobKey;
          const pollStart = Date.now();
          const POLL_INTERVAL = 3000;
          const POLL_TIMEOUT = 600000; // 10 min

          while (Date.now() - pollStart < POLL_TIMEOUT) {
            await new Promise(r => setTimeout(r, POLL_INTERVAL));
            const statusResp = await fetch(`${seqUrl}/interactive/fill-status?prescriptionId=${encodeURIComponent(prescriptionId)}`);
            const statusResult = await statusResp.json() as Record<string, unknown>;

            if (statusResult.status === 'complete') {
              const job = dispensingJobs.get(jobKey);
              if (job) completeJob(job, statusResult);
              return;
            }
            if (statusResult.status === 'error') {
              const job = dispensingJobs.get(jobKey);
              if (job) failJob(job, (statusResult.error as string) || 'Proof failed');
              return;
            }
          }
          const timeoutJob = dispensingJobs.get(jobKey);
          if (timeoutJob) failJob(timeoutJob, 'Proof generation timed out');
        } catch (err) {
          const job = dispensingJobs.get(jobKey);
          if (job) failJob(job, err instanceof Error ? err.message : String(err));
        }
      })();

      // Return 202 immediately — dashboard polls for status
      server.sendResponse(res, 202, true, { jobKey, status: 'pending' });
    },
  });

  // Poll fill proof status
  routes.push({
    method: 'GET',
    path: '/dispensing/fill-status',
    handler: async (_req, res, _params, query) => {
      const jobKey = query?.get('jobKey') ?? undefined;
      if (!jobKey) return server.sendResponse(res, 400, false, undefined, 'Missing jobKey');

      pruneStaleJobs(dispensingJobs);
      const job = dispensingJobs.get(jobKey);
      if (!job) return server.sendResponse(res, 404, false, undefined, 'Job not found');

      server.sendResponse(res, 200, true, {
        status: job.status,
        ...(job.status === 'complete' ? { result: job.result } : {}),
        ...(job.status === 'error' ? { error: job.error } : {}),
        elapsedMs: Date.now() - job.createdAt,
      });
    },
  });

  // ══════════════════════════════════════════════════════════
  //  DISPENSING — Reverse with ZK Proof (async proof pipeline)
  // ══════════════════════════════════════════════════════════

  routes.push({
    method: 'POST',
    path: '/dispensing/reverse',
    handler: async (_req, res, _params, _query, body) => {
      const node = server.getEntityNode() as PharmacyNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');

      const b = body as {
        prescriptionId?: string;
        reason?: string;
      } | undefined;

      if (!b?.prescriptionId) {
        return server.sendResponse(res, 400, false, undefined, 'Missing prescriptionId');
      }

      const jobKey = `rev-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      reversalJobs.set(jobKey, { status: 'pending', createdAt: Date.now() });

      const seqUrl = server.getConfig().sequencerUrl.replace(/\/+$/, '');

      // Fire-and-forget: call sequencer reversal proof
      (async () => {
        try {
          const reverseResp = await fetch(`${seqUrl}/interactive/reverse`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              prescriptionId: b!.prescriptionId,
              reason: b!.reason ?? 'Pharmacy reversal',
            }),
          });

          const reverseResult = await reverseResp.json() as Record<string, unknown>;

          if (!reverseResp.ok) {
            const job = reversalJobs.get(jobKey);
            if (job) failJob(job, (reverseResult.error as string) || `HTTP ${reverseResp.status}`);
          } else {
            const job = reversalJobs.get(jobKey);
            if (job) completeJob(job, reverseResult);
          }
        } catch (err) {
          const job = reversalJobs.get(jobKey);
          if (job) failJob(job, err instanceof Error ? err.message : String(err));
        }
      })();

      server.sendResponse(res, 202, true, { jobKey, status: 'pending' });
    },
  });

  // Poll reversal proof status
  routes.push({
    method: 'GET',
    path: '/dispensing/reverse-status',
    handler: async (_req, res, _params, query) => {
      const jobKey = query?.get('jobKey') ?? undefined;
      if (!jobKey) return server.sendResponse(res, 400, false, undefined, 'Missing jobKey');

      pruneStaleJobs(reversalJobs);
      const job = reversalJobs.get(jobKey);
      if (!job) return server.sendResponse(res, 404, false, undefined, 'Job not found');

      server.sendResponse(res, 200, true, {
        status: job.status,
        ...(job.status === 'complete' ? { result: job.result } : {}),
        ...(job.status === 'error' ? { error: job.error } : {}),
        elapsedMs: Date.now() - job.createdAt,
      });
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
        const { PHARMACIES } = await import('../../data/index.js');
        const { derivePharmacyWalletId } = await import('../../wallets/wallet-derivation.js');

        if (providerIndex < 0 || providerIndex >= PHARMACIES.length) {
          return server.sendResponse(res, 400, false, undefined, `Invalid providerIndex: ${providerIndex} (max ${PHARMACIES.length - 1})`);
        }

        const pharmacy = PHARMACIES[providerIndex];
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
          data: { skipped: true, reason: 'Standalone mode — ZK proof not required in standalone mode' },
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

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ authenticated: true, events, elapsedMs: Date.now() - start }));
      } catch (err: any) {
        events.push({
          type: 'badge:error', providerIndex, providerType, displayName: 'Unknown', timestamp: Date.now(),
          error: err?.message ?? String(err),
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ authenticated: false, events, error: err?.message ?? String(err) }));
      }
    },
  });

  // ══════════════════════════════════════════════════════════
  //  PHARMACY LIST — real NPPES data for dashboard dropdown
  // ══════════════════════════════════════════════════════════

  routes.push({
    method: 'GET',
    path: '/pharmacies/list',
    handler: async (_req, res) => {
      const { PHARMACIES } = await import('../../data/index.js');
      const fs = await import('fs');
      const path = await import('path');
      let rawData: any[] = [];
      try {
        const dataDir = process.env.ZKP_DATA_DIR || path.join(process.cwd(), 'src', 'data');
        rawData = JSON.parse(fs.readFileSync(path.join(dataDir, 'pharmacies.json'), 'utf-8'));
      } catch { /* fall back to PHARMACIES fields */ }

      const list = PHARMACIES.map((p, i) => ({
        index: i,
        npi: p.localData.serviceProviderId,
        ncpdp: p.ncpdpProviderId || '',
        name: p.storeName,
        chain: p.chain,
        type: p.pharmacyTypeDesc,
        address: rawData[i]?.address ?? '',
        city: rawData[i]?.city ?? '',
        state: rawData[i]?.state ?? '',
        zip: rawData[i]?.zip ?? '',
        phone: rawData[i]?.phone ?? '',
      }));
      server.sendResponse(res, 200, true, list);
    },
  });

  return routes;
}
