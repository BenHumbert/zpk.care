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
import { Field, MerkleTree, Poseidon } from 'o1js';
import { generateEnrollmentKey } from '../../wallets/wallet-derivation.js';
import { hashString } from '../../zkp/hash-utils.js';
import { WalletRegistryWitness, CREDENTIAL_INVENTORY_HEIGHT } from '../../wallets/wallet-state.js';
import { LifecycleWitness } from '../../engine/lifecycle.js';
import { secureMemberDerivation } from '../../security/secure-context.js';
import { exportEnrollmentBackup, importEnrollmentBackup } from '../../security/enrollment-backup.js';
import { buildPcpAssignmentData, PCP_ASSIGNMENT_LEAF_INDEX } from '../../eligibility/pcp-assignment-data.js';
import type { PcpAssignmentLocalData } from '../../eligibility/pcp-assignment-data.js';
import { MerkleForest, ForestDomain } from '../../zkp/merkle-forest.js';
import { CredentialData, CREDENTIAL_TYPE_ELIGIBILITY } from '../../credentials/credential-data.js';
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

  // ── Onboarding: Unlock State (PIN entry) ─────────────────

  routes.push({
    method: 'POST',
    path: '/onboarding/unlock',
    handler: async (_req, res, _params, _query, body) => {
      const state = server.getLocalState();

      // Already unlocked — skip
      if (state.isUnlocked()) {
        return server.sendResponse(res, 200, true, { unlocked: true, alreadyUnlocked: true });
      }

      const b = body as { pin?: string } | undefined;
      if (!b?.pin) {
        return server.sendResponse(res, 400, false, undefined, 'Missing pin');
      }

      try {
        await state.unlock(b.pin);
        // Initialize state if first run
        const existing = await state.load();
        if (!existing) {
          const initialState = {
            version: 1,
            role: 'member' as const,
            onboarding: { phase: 'awaiting_token' },
            lastSavedAt: new Date().toISOString(),
          };
          await state.save(initialState);
        }
        server.sendResponse(res, 200, true, { unlocked: true });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        server.sendResponse(res, 400, false, undefined, msg);
      }
    },
  });

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
    handler: async (_req, res, _params, _query, body) => {
      if (server.getOnboardingPhase() !== 'token_received') {
        return server.sendResponse(res, 409, false, undefined, `Cannot generate key in phase: ${server.getOnboardingPhase()}`);
      }

      // Accept optional enrollmentKey for deterministic testing (key import)
      const enrollmentKey = (body as any)?.enrollmentKey ?? generateEnrollmentKey();

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

      // Validate DOB is a valid CCYYMMDD calendar date
      if (!/^\d{8}$/.test(b.dateOfBirth)) {
        return server.sendResponse(res, 400, false, undefined, 'dateOfBirth must be 8 digits in CCYYMMDD format');
      }
      const dobY = parseInt(b.dateOfBirth.slice(0, 4), 10);
      const dobM = parseInt(b.dateOfBirth.slice(4, 6), 10);
      const dobD = parseInt(b.dateOfBirth.slice(6, 8), 10);
      if (dobM < 1 || dobM > 12 || dobD < 1 || dobD > 31) {
        return server.sendResponse(res, 400, false, undefined, 'dateOfBirth contains an invalid month or day');
      }
      const maxDay = new Date(dobY, dobM, 0).getDate();
      if (dobD > maxDay) {
        return server.sendResponse(res, 400, false, undefined, `dateOfBirth day ${dobD} is invalid for month ${dobM}`);
      }

      const state = server.getLocalState();
      if (!state.hasEnrollmentKey()) {
        return server.sendResponse(res, 409, false, undefined, 'Enrollment key not generated');
      }

      // Build a mutable copy of the local data — secureMemberDerivation scrubs it
      const genderCode = typeof b.genderCode === 'number' ? b.genderCode : 0;
      if (genderCode < 0 || genderCode > 9 || !Number.isInteger(genderCode)) {
        return server.sendResponse(res, 400, false, undefined, 'genderCode must be an integer 0-9');
      }

      const localData: MemberLocalData = {
        cardholderId: b.cardholderId,
        dateOfBirth: b.dateOfBirth,
        genderCode,
        firstName: b.firstName,
        lastName: b.lastName,
      };

      // Compute groupIdHash from the accepted token's groupId
      const data = state.getState();
      const groupId = data?.onboarding?.tokenData?.groupId ?? '';
      const groupIdHash = groupId ? hashString(groupId) : Field(0);

      // Enrollment key is reconstructed only for the duration of derivation
      const result = state.useEnrollmentKey((key) =>
        secureMemberDerivation(localData, key, groupIdHash),
      );
      const walletId = result.walletId.toString();

      // Save preimage Fields as decimal strings for later proof generation
      const preimageFields = result.preimage.map((f) => f.toString());
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

      // Insurer URL: body override > config > none (skip notification)
      const b = body as { insurerUrl?: string } | undefined;
      const insurerUrl = b?.insurerUrl || server.getConfig().insurerUrl || null;
      const seqUrl = server.getConfig().sequencerUrl;

      // Create the MemberNode now that we have a walletId
      // Persist enrollment state FIRST — ensures device state is durable
      // before any external registration that could create phantom enrollment.
      data.onboarding.phase = 'enrolled';
      data.onboarding.enrollmentTimestamp = Date.now();
      data.lastSequencerUrl = server.getConfig().sequencerUrl;
      await state.save(data);

      const node = new MemberNode({
        role: 'member',
        walletId: data.walletId,
        sequencerUrl: server.getConfig().sequencerUrl,
        displayName: server.getConfig().displayName,
        clientOptions: server.getConfig().adminToken ? { adminToken: server.getConfig().adminToken } : undefined,
      });
      server.setEntityNode(node);
      server.setOnboardingPhase('enrolled');

      // Build auth headers for cross-node calls
      const adminToken = server.getConfig().adminToken;
      const rpcHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
      if (adminToken) rpcHeaders['Authorization'] = `Bearer ${adminToken}`;

      // Register wallet on the sequencer so it's known to the network
      let sequencerRegistered = false;
      try {
        const seqUrl = server.getConfig().sequencerUrl.replace(/\/+$/, '');
        const regResp = await fetch(`${seqUrl}/rpc`, {
          method: 'POST',
          headers: rpcHeaders,
          body: JSON.stringify({
            jsonrpc: '2.0', id: 1,
            method: 'l2_registerEntity',
            params: {
              walletId: data.walletId,
              displayName: 'Member',
              type: 'member',
              group: data.onboarding.tokenData?.groupId ?? undefined,
            },
          }),
        });
        sequencerRegistered = regResp.ok;
      } catch (seqErr: unknown) {
        console.warn('[enroll] Sequencer registration failed:', seqErr instanceof Error ? seqErr.message : String(seqErr));
      }

      // Notify insurer of enrollment (non-blocking — enrollment succeeds even if insurer is unreachable)
      let insurerNotified = false;
      if (insurerUrl) {
        try {
          const iUrl = insurerUrl.replace(/\/+$/, '');
          console.log('[enroll] Notifying insurer at %s...', iUrl);
          const resp = await fetch(`${iUrl}/enrollment/process`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              walletId: data.walletId,
              tokenId: data.onboarding.tokenId,
              role: 'member',
              groupId: data.onboarding.tokenData?.groupId ?? null,
            }),
          });
          insurerNotified = resp.ok;
          if (!resp.ok) console.warn('[enroll] Insurer notification returned non-OK:', resp.status);
          else console.log('[enroll] Insurer notified successfully');
        } catch (insErr: unknown) {
          console.warn('[enroll] Insurer notification failed:', insErr instanceof Error ? insErr.message : String(insErr));
        }
      }

      // Notify employer of enrollment (non-blocking — confirms token was used)
      let employerNotified = false;
      const employerUrl = server.getConfig().employerUrl || null;
      if (employerUrl && data.onboarding.tokenId) {
        try {
          const eUrl = employerUrl.replace(/\/+$/, '');
          console.log('[enroll] Notifying employer at %s...', eUrl);
          const resp = await fetch(`${eUrl}/enrollment/confirm`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              tokenId: data.onboarding.tokenId,
              walletId: data.walletId,
            }),
          });
          employerNotified = resp.ok;
          if (!resp.ok) console.warn('[enroll] Employer confirmation returned non-OK:', resp.status);
          else console.log('[enroll] Employer notified successfully');
        } catch (empErr: unknown) {
          console.warn('[enroll] Employer notification failed:', empErr instanceof Error ? empErr.message : String(empErr));
        }
      }

      // Adjudication engine registration is deferred to /proof/registration.
      // Calling /interactive/register-member here would pre-register the wallet
      // on the sequencer via applyAdminRootUpdate(), causing "Wallet already
      // registered" when the ZK registration proof is later submitted.

      server.sendResponse(res, 200, true, {
        phase: 'enrolled',
        walletId: data.walletId,
        sequencerUrl: seqUrl,
        insurerNotified,
        employerNotified,
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

  // ── Proof: Registration ──────────────────────────────────

  routes.push({
    method: 'POST',
    path: '/proof/registration',
    handler: async (_req, res, _params, _query, _body) => {
      if (server.getOnboardingPhase() !== 'ready') {
        return server.sendResponse(res, 409, false, undefined, `Cannot generate proof in phase: ${server.getOnboardingPhase()}`);
      }
      const node = server.getEntityNode() as MemberNode | null;
      if (!node) {
        return server.sendResponse(res, 409, false, undefined, 'Node not initialized');
      }

      // Read preimage from local state
      const state = server.getLocalState();
      const data = state.getState();
      if (!data?.preimageFields || !data.walletId) {
        return server.sendResponse(res, 409, false, undefined, 'Wallet preimage not available');
      }

      try {
      // Fetch witnesses from sequencer
      const witnesses = await node.getClient().getRegistrationWitnesses();

      // Reconstruct transition preimage: [domainTag, ...walletFields padded to 5]
      const walletFields = data.preimageFields.map((s: string) => Field(BigInt(s)));
      const padded = [...walletFields];
      while (padded.length < 6) padded.push(Field(0));
      const preimage = [Field(data.domainTag ?? 0), ...padded];

      // Deserialize witnesses from RPC JSON
      const regWitnessData = typeof witnesses.registryWitnessJson === 'string'
        ? JSON.parse(witnesses.registryWitnessJson)
        : witnesses.registryWitnessJson;
      const lcWitnessData = typeof witnesses.lifecycleWitnessJson === 'string'
        ? JSON.parse(witnesses.lifecycleWitnessJson)
        : witnesses.lifecycleWitnessJson;
      const regWitness = WalletRegistryWitness.fromJSON(regWitnessData);
      const lcWitness = LifecycleWitness.fromJSON(lcWitnessData);

      const regRootStr = typeof witnesses.currentRegistryRoot === 'string'
        ? witnesses.currentRegistryRoot
        : String(witnesses.currentRegistryRoot);
      const lcRootStr = typeof witnesses.currentLifecycleRoot === 'string'
        ? witnesses.currentLifecycleRoot
        : String(witnesses.currentLifecycleRoot);
      const regRoot = Field(BigInt(regRootStr));
      const lcRoot = Field(BigInt(lcRootStr));

      // Generate real ZK proof (~30-120s)
      const proof = await node.proveRegistration(preimage, regWitness, lcWitness, regRoot, lcRoot);

      // Submit proof to sequencer
      const receipt = await node.submitProof(proof);

      // Register proving context with adjudication engine AFTER proof is accepted.
      // This must happen after submitProof so the wallet is already in the
      // sequencer's WalletRegistry — register-member uses applyAdminRootUpdate
      // which skips wallets that are already registered.
      let adjudicationRegistered = false;
      if (data.preimageFields) {
        try {
          const seqUrlClean = server.getConfig().sequencerUrl.replace(/\/+$/, '');
          const regResp = await fetch(`${seqUrlClean}/interactive/register-member`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              walletId: data.walletId,
              preimageFields: data.preimageFields,
              displayName: server.getConfig().displayName || 'Member',
              groupId: data.onboarding?.tokenData?.groupId,
              planId: data.onboarding?.tokenData?.planId,
            }),
          });
          adjudicationRegistered = regResp.ok;
        } catch { /* non-critical — adjudication proofs won't be available */ }
      }

      server.sendResponse(res, 200, true, {
        receiptId: receipt.receiptId,
        walletId: data.walletId,
        proofGenerated: true,
        submittedToSequencer: true,
        adjudicationRegistered,
      });
      } catch (err) {
        const msg = err instanceof Error ? `${err.message}\n${err.stack}` : String(err);
        return server.sendResponse(res, 500, false, undefined, msg);
      }
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
      try {
        const history = await node.getDrugHistory();
        server.sendResponse(res, 200, true, history);
      } catch (err) {
        server.sendResponse(res, 500, false, undefined, err instanceof Error ? err.message : 'Drug history query failed');
      }
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
      try {
        const summary = await node.getActivitySummary();
        server.sendResponse(res, 200, true, summary);
      } catch (err) {
        server.sendResponse(res, 500, false, undefined, err instanceof Error ? err.message : 'Activity summary query failed');
      }
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
      try {
        const history = await node.getDrugHistoryByDateRange(start, end);
        server.sendResponse(res, 200, true, history);
      } catch (err) {
        server.sendResponse(res, 500, false, undefined, err instanceof Error ? err.message : 'Date range query failed');
      }
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
      try {
        const claims = await node.getClaimsByMedication(params.ndcHash);
        server.sendResponse(res, 200, true, claims);
      } catch (err) {
        server.sendResponse(res, 500, false, undefined, err instanceof Error ? err.message : 'Medication query failed');
      }
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
      try {
        const result = await node.getClaimWithProof(BigInt(params.leafIndex));
        if (!result) {
          return server.sendResponse(res, 404, false, undefined, 'Claim not found');
        }
        server.sendResponse(res, 200, true, result);
      } catch (err) {
        server.sendResponse(res, 500, false, undefined, err instanceof Error ? err.message : 'Claim proof query failed');
      }
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
      try {
        const status = await node.getClaimTreeStatus();
        server.sendResponse(res, 200, true, status);
      } catch (err) {
        server.sendResponse(res, 500, false, undefined, err instanceof Error ? err.message : 'Tree status query failed');
      }
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
      try {
        const receipts = await node.getMyReceipts();
        server.sendResponse(res, 200, true, receipts);
      } catch (err) {
        server.sendResponse(res, 500, false, undefined, err instanceof Error ? err.message : 'Receipts query failed');
      }
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

  // ── Option C: Paginated Formulary Queries (proxy to sequencer RPC) ──

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

      // Persist to local state (best-effort — state may not be unlocked)
      try {
        const localState = server.getLocalState();
        const stateData = localState.getState() as any;
        if (stateData) {
          stateData.pcpAssignment = {
            pcpWalletId: b.pcpWalletId,
            effectiveDate: b.effectiveDate,
            commitment,
            specialty: assignmentData.specialty,
            consentScopeFlags: assignmentData.consentScopeFlags,
            assignedAt: Date.now(),
          };
          await localState.save(stateData);
        }
      } catch (localErr: any) {
        console.warn('[PCP] Local state save failed:', localErr?.message ?? localErr);
      }

      // Do NOT register on sequencer here — PCP is saved locally only.
      // Registration happens AFTER the ZK proof succeeds in /proof/pcp-assignment.
      // Proofs are the truth; no optimistic state.

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

  routes.push({
    method: 'DELETE',
    path: '/pcp/current',
    handler: async (_req, res) => {
      try {
        const localState = server.getLocalState();
        const stateData = localState.getState() as any;
        if (stateData) {
          delete stateData.pcpAssignment;
          await localState.save(stateData);
        }
        server.sendResponse(res, 200, true, { removed: true });
      } catch (err) {
        server.sendResponse(res, 500, false, undefined, err instanceof Error ? err.message : 'PCP removal failed');
      }
    },
  });

  // ── Proof: PCP Assignment (wallet update) ─────────────────
  // Generates a ZK proof that commits the PCP assignment into the
  // MEMBER domain tree of the credential's MerkleForest, then submits
  // the wallet update proof to the sequencer.

  routes.push({
    method: 'POST',
    path: '/proof/pcp-assignment',
    handler: async (_req, res, _params, _query, _body) => {
      if (server.getOnboardingPhase() !== 'ready') {
        return server.sendResponse(res, 409, false, undefined, `Cannot generate proof in phase: ${server.getOnboardingPhase()}`);
      }
      const node = server.getEntityNode() as MemberNode | null;
      if (!node) {
        return server.sendResponse(res, 409, false, undefined, 'Node not initialized');
      }

      const state = server.getLocalState();
      const data = state.getState();
      if (!data?.walletId || !data?.preimageFields) {
        return server.sendResponse(res, 409, false, undefined, 'Wallet preimage not available');
      }

      const pcpAssignment = (data as any)?.pcpAssignment;
      if (!pcpAssignment?.pcpWalletId) {
        return server.sendResponse(res, 409, false, undefined, 'No PCP assignment — call /pcp/assign first');
      }

      try {
        const client = node.getClient();

        // 1. Get current wallet state from sequencer (nonce + credentialInventoryRoot)
        const walletState = await client.getWalletState(data.walletId);
        if (!walletState || typeof walletState.nonce !== 'string' || typeof walletState.credentialInventoryRoot !== 'string') {
          return server.sendResponse(res, 502, false, undefined,
            'Sequencer returned invalid wallet state — wallet may not be registered yet');
        }
        const oldNonce = Field(BigInt(walletState.nonce));
        const oldCredentialRoot = Field(BigInt(walletState.credentialInventoryRoot));

        // 2. Build PCP assignment data and compute its commitment
        const pcpData = buildPcpAssignmentData({
          memberWalletId: data.walletId,
          pcpWalletId: pcpAssignment.pcpWalletId,
          effectiveDate: pcpAssignment.effectiveDate,
          terminationDate: '',
          specialty: pcpAssignment.specialty ?? 'General Practice',
          consentTimestamp: pcpAssignment.effectiveDate,
          consentScopeFlags: pcpAssignment.consentScopeFlags ?? 7,
        });
        const pcpCommitment = pcpData.commitment();

        // 3. Reconstruct the member's credential state:
        //    - Empty MerkleForest (6 domain trees, height 8)
        //    - Mutate MEMBER tree leaf 0 with PCP commitment
        //    - Compute new forestRoot
        const forest = new MerkleForest();
        forest.setLeaf(ForestDomain.MEMBER, PCP_ASSIGNMENT_LEAF_INDEX, pcpCommitment);
        const newForestRoot = forest.getForestRoot();

        // 4. Build updated CredentialData with the new forestRoot
        const updatedCredential = new CredentialData({
          credentialType: CREDENTIAL_TYPE_ELIGIBILITY,
          forestRoot: newForestRoot,
          issuerWalletId: Field(0), // self-issued PCP assignment
          subjectWalletId: Field(BigInt(data.walletId)),
          issuedAt: Field(BigInt(pcpAssignment.effectiveDate.replace(/-/g, '') || '0')),
          expiresAt: Field(0),
          revoked: Field(0),
        });

        // 5. Compute the new credentialInventoryRoot:
        //    - Start with empty credential inventory tree (height 7)
        //    - Set slot 0 = updatedCredential.commitment()
        const inventoryTree = new MerkleTree(CREDENTIAL_INVENTORY_HEIGHT);
        inventoryTree.setLeaf(0n, updatedCredential.commitment());
        const newCredentialRoot = inventoryTree.getRoot();

        // 6. Get witnesses from sequencer
        const witnesses = await client.getWalletWitnesses(data.walletId);

        const regWitnessData = typeof witnesses.registryWitnessJson === 'string'
          ? JSON.parse(witnesses.registryWitnessJson)
          : witnesses.registryWitnessJson;
        const lcWitnessData = typeof witnesses.lifecycleWitnessJson === 'string'
          ? JSON.parse(witnesses.lifecycleWitnessJson)
          : witnesses.lifecycleWitnessJson;
        const regWitness = WalletRegistryWitness.fromJSON(regWitnessData);
        const lcWitness = LifecycleWitness.fromJSON(lcWitnessData);
        const regRoot = Field(BigInt(witnesses.currentRegistryRoot));
        const lcRoot = Field(BigInt(witnesses.currentLifecycleRoot));
        const currentLifecycle = Field(BigInt(witnesses.currentLifecycleState));

        // 7. Reconstruct preimage
        const walletFields = data.preimageFields.map((s: string) => Field(BigInt(s)));
        const padded = [...walletFields];
        while (padded.length < 6) padded.push(Field(0));
        const preimage = [Field(data.domainTag ?? 0), ...padded];

        // 8. Generate wallet update proof (~30-120s)
        console.log('[pcp-proof] Generating wallet update proof for PCP assignment...');
        const proof = await node.proveWalletUpdate(
          preimage,
          oldCredentialRoot,
          oldNonce,
          newCredentialRoot,
          regWitness,
          lcWitness,
          regRoot,
          lcRoot,
          currentLifecycle,
        );

        // 9. Submit proof to sequencer
        const receipt = await node.submitProof(proof);
        console.log('[pcp-proof] PCP assignment proof submitted, receipt:', receipt.receiptId);

        // 10b. Notify sequencer of new wallet state so its witness tree stays in sync
        try {
          const seqUrl = server.getConfig().sequencerUrl.replace(/\/+$/, '');
          await fetch(`${seqUrl}/rpc`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0', id: 1,
              method: 'l2_syncWalletState',
              params: {
                walletId: data.walletId,
                newCredentialInventoryRoot: newCredentialRoot.toString(),
                newNonce: (BigInt(walletState.nonce) + 1n).toString(),
              },
            }),
          });
        } catch { /* non-critical — sequencer tree may be stale until next sync */ }

        // 10. Save proof status to local state
        const stateData = state.getState() as any;
        if (stateData?.pcpAssignment) {
          stateData.pcpAssignment.proofSubmitted = true;
          stateData.pcpAssignment.receiptId = receipt.receiptId;
          await state.save(stateData);
        }

        // 11. NOW register on sequencer — proof succeeded, this is the truth
        try {
          const pcpWid = pcpAssignment.pcpWalletId;
          const pcpDate = pcpAssignment.effectiveDate;
          await client.registerPcpAssignment(data.walletId, pcpWid, pcpDate);
          console.log('[pcp-proof] PCP registered on sequencer after proof');
        } catch (regErr: any) {
          console.warn('[pcp-proof] Sequencer PCP registration failed (proof still valid):', regErr?.message);
        }

        server.sendResponse(res, 200, true, {
          receiptId: receipt.receiptId,
          walletId: data.walletId,
          pcpWalletId: pcpAssignment.pcpWalletId,
          proofGenerated: true,
          submittedToSequencer: true,
          newForestRoot: newForestRoot.toString(),
          newCredentialRoot: newCredentialRoot.toString(),
        });
      } catch (err) {
        const msg = err instanceof Error ? `${err.message}\n${err.stack}` : String(err);
        console.error('[pcp-proof] Failed:', msg);
        return server.sendResponse(res, 500, false, undefined, msg);
      }
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

  // ── Messaging ──────────────────────────────────────────────

  routes.push({
    method: 'POST',
    path: '/messaging/send',
    handler: async (_req, res, _params, _query, body) => {
      const node = server.getEntityNode() as MemberNode | null;
      if (!node) {
        return server.sendResponse(res, 503, false, undefined, 'Node not initialized');
      }
      const b = body as { message?: Record<string, unknown>; payload?: Record<string, unknown> } | undefined;
      if (!b?.message || !b?.payload) {
        return server.sendResponse(res, 400, false, undefined, 'Missing message or payload');
      }
      try {
        const msg = b.message;
        const pl = b.payload;
        // Validate required message fields
        for (const f of ['messageCommitment', 'recipientWalletId', 'messageType', 'threadIdHash']) {
          if (!(f in msg) || msg[f] === undefined || msg[f] === '') {
            return server.sendResponse(res, 400, false, undefined, `Message missing required field: ${f}`);
          }
        }
        // Validate required payload fields
        for (const f of ['ciphertext', 'iv', 'tag']) {
          if (!(f in pl) || pl[f] === undefined) {
            return server.sendResponse(res, 400, false, undefined, `Payload missing required field: ${f}`);
          }
        }
        // Ensure senderWalletId is set server-side (dashboard may not have it yet)
        if (!msg.senderWalletId || msg.senderWalletId === '') {
          msg.senderWalletId = node.getWalletId();
        }
        const entry = await node.storeMessage(
          msg as any,
          pl as any,
        );
        server.sendResponse(res, 200, true, entry);
      } catch (err) {
        server.sendResponse(res, 500, false, undefined, err instanceof Error ? err.message : 'Message send failed');
      }
    },
  });

  routes.push({
    method: 'GET',
    path: '/messaging/inbox',
    handler: async (_req, res) => {
      const node = server.getEntityNode() as MemberNode | null;
      if (!node) {
        return server.sendResponse(res, 503, false, undefined, 'Node not initialized');
      }
      try {
        server.sendResponse(res, 200, true, await node.getInbox());
      } catch (err) {
        server.sendResponse(res, 500, false, undefined, err instanceof Error ? err.message : 'Inbox query failed');
      }
    },
  });

  routes.push({
    method: 'GET',
    path: '/messaging/sent',
    handler: async (_req, res) => {
      const node = server.getEntityNode() as MemberNode | null;
      if (!node) {
        return server.sendResponse(res, 503, false, undefined, 'Node not initialized');
      }
      try {
        server.sendResponse(res, 200, true, await node.getSentMessages());
      } catch (err) {
        server.sendResponse(res, 500, false, undefined, err instanceof Error ? err.message : 'Sent messages query failed');
      }
    },
  });

  routes.push({
    method: 'GET',
    path: '/messaging/thread/:threadIdHash',
    handler: async (_req, res, params) => {
      const node = server.getEntityNode() as MemberNode | null;
      if (!node) {
        return server.sendResponse(res, 503, false, undefined, 'Node not initialized');
      }
      try {
        server.sendResponse(res, 200, true, await node.getMessagesByThread(params.threadIdHash));
      } catch (err) {
        server.sendResponse(res, 500, false, undefined, err instanceof Error ? err.message : 'Thread query failed');
      }
    },
  });

  return routes;
}
