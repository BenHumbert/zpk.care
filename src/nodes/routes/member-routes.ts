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
import { Encoding, Field, MerkleTree, Poseidon } from 'o1js';
import { generateEnrollmentKey, generateIdentitySalt } from '../../wallets/wallet-derivation.js';
import { hashString, isIdentitySalt } from '../../zkp/hash-utils.js';
import {
  issueRecoveryCards, validateRecoveryPin, isRecoveryCardV3, combineEnrollmentKey, recoveryPinVerifier, recoveryCardBytes,
} from '../../security/recovery-card.js';
import { canonicalizeEnrollmentCode } from '../../onboarding/enrollment-code.js';
import { WalletRegistryWitness, CREDENTIAL_INVENTORY_HEIGHT } from '../../wallets/wallet-state.js';
import { LifecycleWitness } from '../../engine/lifecycle.js';
import { secureMemberDerivation } from '../../security/secure-context.js';
import { buildPcpAssignmentData, PCP_ASSIGNMENT_LEAF_INDEX } from '../../eligibility/pcp-assignment-data.js';
import type { PcpAssignmentLocalData } from '../../eligibility/pcp-assignment-data.js';
import { MerkleForest, ForestDomain } from '../../zkp/merkle-forest.js';
import { CredentialData, CREDENTIAL_TYPE_ELIGIBILITY } from '../../credentials/credential-data.js';
import { buildNfcIdentityRecord, fitsOnTag } from '../nfc-identity.js';
import { deriveEncryptionKeyPair } from '../../messaging/encryption.js';
import { deriveWalletSigningKey } from '../../security/wallet-key.js';
import { rederiveInventoryRoot, type WalletUpdatePayload } from '../../credentials/wallet-update.js';
import { MemberNode } from '../member-node.js';
import type { NautilusAppServer } from '../nautilus-app-server.js';
import type { RouteRegistration } from '../nautilus-app-types.js';
import type { MemberLocalData } from '../../models/member.js';
import { PinAttemptThrottled } from '../nautilus-local-state.js';

/** Domain tag for members */
const DOMAIN_TAG_MEMBER = 0;

/**
 * Build all member routes. The server reference is captured in closures
 * so route handlers can access the entity node and local state.
 */
/** What one pass over the wallet's queued updates did. */
export interface WalletUpdateRun {
  applied: number;
  pending: number;
  refused: string[];
  errors: string[];
}

let walletUpdateRun: Promise<WalletUpdateRun> | null = null;

/**
 * The device proves every change to its wallet (B1 step two). The engine queues each update as the
 * credential as it should now be and the root it yields; the device fetches them in order, rebuilds
 * the root from exactly the parts it was given and refuses anything that does not add up, proves
 * the update with the preimage only it holds against the sequencer's live tree, submits it, and
 * reports the receipt. One pass at a time per process; a second caller joins the pass in flight.
 */
export function applyPendingWalletUpdates(server: NautilusAppServer): Promise<WalletUpdateRun> {
  if (walletUpdateRun) return walletUpdateRun;
  walletUpdateRun = runWalletUpdates(server).finally(() => { walletUpdateRun = null; });
  return walletUpdateRun;
}

async function runWalletUpdates(server: NautilusAppServer): Promise<WalletUpdateRun> {
  const run: WalletUpdateRun = { applied: 0, pending: 0, refused: [], errors: [] };
  const node = server.getEntityNode() as MemberNode | null;
  const data = server.getLocalState().getState();
  if (!node || !data?.walletId || !data?.preimageFields) { run.errors.push('wallet not ready'); return run; }
  if (!node.isCompiled()) { run.errors.push('programs not compiled'); return run; }
  const seqUrl = server.getConfig().sequencerUrl.replace(/\/+$/, '');
  let listing: { pending?: WalletUpdatePayload[]; error?: string } = {};
  try {
    const r = await server.walletSignedFetch(`${seqUrl}/interactive/wallet-updates?walletId=${data.walletId}`, { method: 'GET' });
    listing = await r.json() as typeof listing;
    if (!r.ok) { run.errors.push(`the engine refused the listing: ${r.status} ${listing?.error ?? ''}`); return run; }
  } catch (err) {
    run.errors.push(`could not fetch the wallet updates: ${err instanceof Error ? err.message : String(err)}`);
    return run;
  }
  const pending = Array.isArray(listing.pending) ? listing.pending : [];
  run.pending = pending.length;
  const walletFields = data.preimageFields.map((s: string) => Field(BigInt(s)));
  const padded = [...walletFields];
  while (padded.length < 6) padded.push(Field(0));
  const preimage = [Field(data.domainTag ?? 0), ...padded];
  const client = node.getClient();
  for (const update of pending) {
    // 1. What the engine asks us to commit to must add up from the parts it sent.
    let derived: ReturnType<typeof rederiveInventoryRoot>;
    try {
      derived = rederiveInventoryRoot(update);
    } catch (err) {
      run.refused.push(`${update.updateId}: ${err instanceof Error ? err.message : String(err)}`);
      break;
    }
    if (derived.inventoryRoot !== update.newInventoryRoot) {
      run.refused.push(`${update.updateId}: the parts do not yield the root the engine named`);
      break;
    }
    // 2. Prove it against the live tree, re-proving if another change lands first.
    let receiptId: string | null = null;
    for (let attempt = 1; attempt <= 4 && !receiptId; attempt++) {
      const live = await client.getWalletState(data.walletId);
      if (!live || typeof live.nonce !== 'string' || typeof live.credentialInventoryRoot !== 'string') {
        run.errors.push('the sequencer returned no wallet state');
        return run;
      }
      if (live.credentialInventoryRoot !== update.oldInventoryRoot) {
        run.errors.push(`${update.updateId}: starts from root ${update.oldInventoryRoot.slice(0, 12)}… but the ledger holds ${live.credentialInventoryRoot.slice(0, 12)}…`);
        return run;
      }
      const witnesses = await client.getWalletWitnesses(data.walletId);
      const regWitnessData = typeof witnesses.registryWitnessJson === 'string' ? JSON.parse(witnesses.registryWitnessJson) : witnesses.registryWitnessJson;
      const lcWitnessData = typeof witnesses.lifecycleWitnessJson === 'string' ? JSON.parse(witnesses.lifecycleWitnessJson) : witnesses.lifecycleWitnessJson;
      const regWitness = WalletRegistryWitness.fromJSON(regWitnessData);
      const lcWitness = LifecycleWitness.fromJSON(lcWitnessData);
      const proof = await node.proveWalletUpdate(
        preimage,
        Field(BigInt(live.credentialInventoryRoot)),
        Field(BigInt(live.nonce)),
        Field(BigInt(update.newInventoryRoot)),
        regWitness,
        lcWitness,
        Field(BigInt(witnesses.currentRegistryRoot)),
        Field(BigInt(witnesses.currentLifecycleRoot)),
        Field(BigInt(witnesses.currentLifecycleState)),
      );
      try {
        const receipt = await node.submitProof(proof, { newCredentialInventoryRoot: update.newInventoryRoot });
        receiptId = receipt.receiptId;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const contended = /root mismatch|does not match the sequencer tree|state changed while/i.test(msg);
        if (!contended || attempt >= 4) { run.errors.push(`${update.updateId}: ${msg}`); return run; }
        await new Promise((r) => setTimeout(r, 250 + Math.floor(Math.random() * 1500)));
      }
    }
    // 3. Tell the engine, signed as the wallet.
    const done = await server.walletSignedFetch(`${seqUrl}/interactive/wallet-update-applied`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ walletId: data.walletId, updateId: update.updateId, receiptId }),
    });
    if (!done.ok) {
      run.errors.push(`${update.updateId}: proved and accepted (receipt ${receiptId}) but the engine did not record it: ${done.status} ${(await done.text().catch(() => '')).slice(0, 160)}`);
      return run;
    }
    run.applied += 1;
    run.pending -= 1;
  }
  return run;
}

export function buildMemberRoutes(server: NautilusAppServer): RouteRegistration[] {
  const routes: RouteRegistration[] = [];

  // ── Onboarding: Unlock State (PIN entry) ─────────────────

  routes.push({
    method: 'POST',
    path: '/onboarding/unlock',
    handler: async (_req, res, _params, _query, body) => {
      const state = server.getLocalState();

      const b = body as { pin?: string } | undefined;
      if (!b?.pin) {
        return server.sendResponse(res, 400, false, undefined, 'Missing pin');
      }

      /*
       * Already unlocked still means checking the PIN (A4, found by probing a live node).
       *
       * This used to return `{ unlocked: true, alreadyUnlocked: true }` the moment the state was
       * unlocked, without looking at the PIN. Since the launcher auto-unlocks from the
       * environment, that is the device's normal state after boot, so the app's PIN screen
       * accepted **any** PIN for the rest of the process's life. It granted nothing a caller did
       * not already have, but it did make the member-facing PIN gate decorative, and a PIN screen
       * that accepts anything is worse than no PIN screen because it implies a check.
       *
       * So the PIN is verified either way. The attempt is rate-limited on the same counter, and
       * a wrong PIN here does not lock a device that was legitimately unlocked: it is refused,
       * counted, and the state is left as it was.
       */
      if (state.isUnlocked()) {
        try {
          if (!(await state.verifyPin(b.pin))) {
            return server.sendResponse(res, 401, false, undefined, 'Incorrect PIN.');
          }
        } catch (err: unknown) {
          if (err instanceof PinAttemptThrottled) {
            res.setHeader('Retry-After', String(Math.ceil(err.retryAfterMs / 1000)));
            return server.sendResponse(res, 429, false, undefined, err.message);
          }
          throw err;
        }
        // A fresh session even when already unlocked: the PIN was just proved, and the caller
        // may be a new client that has none.
        const session = server.issueDeviceSession();
        return server.sendResponse(res, 200, true, {
          unlocked: true,
          alreadyUnlocked: true,
          deviceSession: session.token,
          expiresInMs: session.expiresInMs,
        });
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
        // A5: the session the rest of this node's routes require. Issued only here, and only
        // after unlock() has verified the PIN against the encrypted state (A4).
        const session = server.issueDeviceSession();
        server.sendResponse(res, 200, true, {
          unlocked: true,
          deviceSession: session.token,
          expiresInMs: session.expiresInMs,
        });
      } catch (err: unknown) {
        /*
         * A4: a failed unlock leaves the device locked, and the failure is counted.
         *
         * `unlock()` wipes the derived key before throwing, so there is nothing to clear here
         * and no partially-unlocked state for a later request to inherit. The separate status
         * for throttling is so the app can show a wait rather than repeat "wrong PIN" while
         * every attempt is being refused unread.
         */
        if (err instanceof PinAttemptThrottled) {
          res.setHeader('Retry-After', String(Math.ceil(err.retryAfterMs / 1000)));
          return server.sendResponse(res, 429, false, undefined, err.message);
        }
        const msg = err instanceof Error ? err.message : String(err);
        server.sendResponse(res, 400, false, undefined, msg);
      }
    },
  });

  // ── Onboarding: Accept Token ──────────────────────────────

  routes.push({
    method: 'POST',
    path: '/onboarding/accept-token',
    deviceOnly: true,
    handler: async (_req, res, _params, _query, body) => {
      if (server.getOnboardingPhase() !== 'awaiting_token') {
        return server.sendResponse(res, 409, false, undefined, `Cannot accept token in phase: ${server.getOnboardingPhase()}`);
      }

      const b = body as { tokenId?: string; groupId?: string; planId?: string; validUntil?: string } | undefined;
      if (!b?.tokenId || typeof b.tokenId !== 'string' || !b.tokenId.trim()) {
        return server.sendResponse(res, 400, false, undefined, 'Missing tokenId');
      }
      // A6: people type these. Canonicalise case, spacing and the O/0 and I/L/1 confusions here,
      // so the PIN hash is computed over exactly the string the employer holds.
      const tokenId = canonicalizeEnrollmentCode(b.tokenId) ?? b.tokenId.trim();

      const state = server.getLocalState();
      const data = state.getState();
      if (data) {
        data.onboarding.phase = 'token_received';
        data.onboarding.tokenId = tokenId;
        data.onboarding.tokenData = {
          groupId: b.groupId ?? '',
          planId: b.planId ?? '',
          validUntil: b.validUntil ?? '',
        };
        await state.save(data);
      }

      server.setOnboardingPhase('token_received');
      server.sendResponse(res, 200, true, { phase: 'token_received', tokenId });
    },
  });

  // ── Onboarding: Generate Enrollment Key ───────────────────

  routes.push({
    method: 'POST',
    path: '/onboarding/generate-key',
    deviceOnly: true,
    handler: async (_req, res, _params, _query, body) => {
      if (server.getOnboardingPhase() !== 'token_received') {
        return server.sendResponse(res, 409, false, undefined, `Cannot generate key in phase: ${server.getOnboardingPhase()}`);
      }

      /*
       * The key is generated here and only here. This used to read
       * `(body as any)?.enrollmentKey ?? generateEnrollmentKey()`, with no validation and no
       * authentication, under a comment about deterministic testing — finding MEM-C2. Two
       * things were wrong with it. An attacker could inject a key they knew before
       * `derive-wallet`, so the wallet would be derived under their key. And accepting an
       * enrollment key *inbound over the network at all* is the thing rule I3 forbids,
       * whatever the key turns out to be.
       *
       * A test or a seeding tool that needs a specific key sets it on the device's own local
       * state in-process, which is what a device does; it does not post it to a port.
       */
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

  // ── Onboarding: Redeem the enrollment code — plan item C2, finding A-9 ──────
  // Before the wallet is derived, because the group hash the employer answers is one of the
  // wallet's inputs. The insurer redeems the code with the issuing employer (A6) and answers the
  // group and plan hashes; the wallet is bound to them at derivation, and `/onboarding/enroll`
  // then binds the wallet to this redemption. The device never sends a wallet before it has one.
  routes.push({
    method: 'POST',
    path: '/onboarding/redeem',
    deviceOnly: true,
    handler: async (_req, res, _params, _query, body) => {
      const phase = server.getOnboardingPhase();
      if (phase !== 'key_generated' && phase !== 'code_redeemed') {
        return server.sendResponse(res, 409, false, undefined, `Cannot redeem the enrollment code in phase: ${phase}`);
      }
      const state = server.getLocalState();
      const data = state.getState();
      if (!data?.onboarding?.tokenId) {
        return server.sendResponse(res, 409, false, undefined, 'No enrollment code has been accepted on this device');
      }
      const insurerUrl = server.getConfig().insurerUrl || null;
      if (!insurerUrl) {
        return server.sendResponse(res, 503, false, undefined, 'No insurer is configured for this device, so the enrollment code cannot be redeemed');
      }
      const b = body as { tokenPIN?: string } | undefined;
      if (typeof b?.tokenPIN !== 'string' || b.tokenPIN.length === 0) {
        return server.sendResponse(res, 400, false, undefined, 'The enrollment PIN is required');
      }
      const tokenPinHash = Poseidon.hash([
        ...Encoding.stringToFields(data.onboarding.tokenId),
        Field(0),
        ...Encoding.stringToFields(b.tokenPIN),
      ]).toString();
      let answer: { groupIdHash?: string; planIdHash?: string; employerId?: string | null } | undefined;
      try {
        const resp = await fetch(`${insurerUrl.replace(/\/+$/, '')}/enrollment/process`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tokenId: data.onboarding.tokenId, tokenPinHash, role: 'member' }),
        });
        if (!resp.ok) {
          const text = await resp.text().catch(() => '');
          console.warn('[redeem] The insurer refused the enrollment code:', resp.status, text);
          return server.sendResponse(res, resp.status === 429 ? 429 : 403, false, undefined,
            'The insurer did not accept this enrollment code and PIN.');
        }
        const json = await resp.json() as { data?: typeof answer } & NonNullable<typeof answer>;
        answer = json.data ?? json;
      } catch (err: unknown) {
        console.warn('[redeem] Insurer unreachable:', err instanceof Error ? err.message : String(err));
        return server.sendResponse(res, 502, false, undefined, 'Cannot reach the insurer to redeem the enrollment code. Try again later.');
      }
      if (!answer?.groupIdHash || !/^\d+$/.test(answer.groupIdHash) || !answer.planIdHash || !/^\d+$/.test(answer.planIdHash)) {
        return server.sendResponse(res, 502, false, undefined, 'The insurer answered without the group and plan this code enrols into.');
      }
      data.enrollment = { groupIdHash: answer.groupIdHash, planIdHash: answer.planIdHash, employerId: answer.employerId ?? null, redeemedAt: Date.now() };
      data.onboarding.phase = 'code_redeemed';
      await state.save(data);
      server.setOnboardingPhase('code_redeemed');
      server.sendResponse(res, 200, true, { phase: 'code_redeemed', groupIdHash: answer.groupIdHash, planIdHash: answer.planIdHash, employerId: answer.employerId ?? null });
    },
  });

  // ── Onboarding: Derive Wallet ─────────────────────────────
  // This is the ONLY endpoint that receives raw PHI (cardholderId, dob, etc.)

  routes.push({
    method: 'POST',
    path: '/onboarding/derive-wallet',
    deviceOnly: true,
    handler: async (_req, res, _params, _query, body) => {
      {
        const phase = server.getOnboardingPhase();
        const insurerConfigured = Boolean(server.getConfig().insurerUrl);
        // C2: with an insurer, the code is redeemed first so the wallet can carry the real group.
        if (phase !== 'code_redeemed' && !(phase === 'key_generated' && !insurerConfigured)) {
          return server.sendResponse(res, 409, false, undefined, phase === 'key_generated'
            ? 'Redeem the enrollment code first: the wallet is bound to the group the code enrols into'
            : `Cannot derive wallet in phase: ${phase}`);
        }
      }

      const b = body as {
        cardholderId?: string;
        dateOfBirth?: string;
        genderCode?: number;
        firstName?: string;
        lastName?: string;
        /** HIPAA authorization record — required per 45 CFR 164.508(b)(1) */
        consentRecord?: {
          phiDescription?: string;
          disclosingParty?: string;
          receivingParty?: string;
          purpose?: string;
          expiration?: string;
          signatureDate?: string;
        };
      } | undefined;

      // HIPAA 164.508(b)(1): Require documented authorization before PHI processing
      if (!b?.consentRecord?.phiDescription || !b?.consentRecord?.disclosingParty ||
          !b?.consentRecord?.receivingParty || !b?.consentRecord?.purpose ||
          !b?.consentRecord?.expiration || !b?.consentRecord?.signatureDate) {
        return server.sendResponse(res, 400, false, undefined,
          'HIPAA authorization required. Provide consentRecord with: phiDescription, disclosingParty, receivingParty, purpose, expiration, signatureDate');
      }

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

      // C2: the group hash the insurer answered when the code was redeemed, so the wallet is bound
      // to the group the employer enrolled this person into. A device with no insurer configured
      // has no group and derives an unbound wallet, which the response says.
      const data = state.getState();
      // A standalone device (no insurer) keeps the pre-C2 behaviour: the group named with the code, or none.
      const groupIdHash = data?.enrollment?.groupIdHash
        ? Field(BigInt(data.enrollment.groupIdHash))
        : (data?.onboarding?.tokenData?.groupId ? hashString(data.onboarding.tokenData.groupId) : Field(0));
      // C1: the identity salt is made here, once, and lives only in this device's encrypted state
      // and inside the recovery deposit. It goes into every identity field hash.
      const identitySalt = data?.identitySalt && isIdentitySalt(data.identitySalt) ? data.identitySalt : generateIdentitySalt();

      // Enrollment key is reconstructed only for the duration of derivation
      const result = state.useEnrollmentKey((key) =>
        secureMemberDerivation(localData, key, groupIdHash, identitySalt),
      );
      const walletId = result.walletId.toString();

      // Save preimage Fields as decimal strings for later proof generation
      const preimageFields = result.preimage.map((f) => f.toString());
      if (data) {
        data.walletId = walletId;
        data.preimageFields = preimageFields;
        data.identitySalt = identitySalt;
        data.domainTag = DOMAIN_TAG_MEMBER;
        data.onboarding.phase = 'wallet_derived';
        // Store HIPAA consent record with timestamp
        (data as any).consentRecord = {
          ...b!.consentRecord,
          recordedAt: new Date().toISOString(),
        };
      }
      await state.save(data!);

      // Don't dispose preimage yet — needed for proof generation
      server.setOnboardingPhase('wallet_derived');
      server.sendResponse(res, 200, true, { phase: 'wallet_derived', walletId, boundToGroup: groupIdHash.toString() !== '0' });
    },
  });

  // ── Onboarding: Enroll ────────────────────────────────────

  routes.push({
    method: 'POST',
    path: '/onboarding/enroll',
    deviceOnly: true,
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
      // SSRF fix: insurerUrl must come from server config, never from request body
      const insurerUrl = server.getConfig().insurerUrl || null;
      const seqUrl = server.getConfig().sequencerUrl;

      // NOTE: MemberNode creation + phase change deferred to AFTER insurer validation.
      // If insurer rejects, in-memory phase stays at 'wallet_derived' so retry works.

      // Build auth headers for cross-node calls
      const rpcHeaders: Record<string, string> = { 'Content-Type': 'application/json' };

      /*
       * C2 + A12b. The code was redeemed at /onboarding/redeem; this completes it with the wallet.
       * At the same tap, the only moment the enrollment key is at hand, two recovery cards are
       * issued (PRD-1): each carries one share of the key and a random id, nothing that depends on
       * the PIN; the other shares, the identity salt, the group and plan hashes and a PIN verifier
       * computed here go to the insurer with the completion. The device keeps the card ids only.
       */
      const b = body as { recoveryPin?: string } | undefined;
      let insurerNotified = false;
      let issued: ReturnType<typeof issueRecoveryCards> | null = null;
      if (insurerUrl) {
        if (!data.enrollment?.groupIdHash || !data.enrollment.planIdHash) {
          return server.sendResponse(res, 409, false, undefined, 'Redeem the enrollment code first');
        }
        if (!data.identitySalt || !isIdentitySalt(data.identitySalt)) {
          return server.sendResponse(res, 409, false, undefined, 'The wallet was derived without an identity salt; derive it again');
        }
        try {
          validateRecoveryPin(b?.recoveryPin);
        } catch {
          return server.sendResponse(res, 400, false, undefined,
            'A recovery PIN of 6 to 32 characters is required: it protects the two recovery cards issued now.');
        }
        const recoveryPin = b!.recoveryPin!;
        const { groupIdHash, planIdHash } = data.enrollment;
        const identitySalt = data.identitySalt;
        issued = state.useEnrollmentKey((key) => issueRecoveryCards({
          enrollmentKey: key, recoveryPin, identitySalt, groupIdHash, planIdHash, domainTag: 0,
        }));
        try {
          const iUrl = insurerUrl.replace(/\/+$/, '');
          console.log('[enroll] Completing the enrollment with the insurer at %s...', iUrl);
          const resp = await fetch(`${iUrl}/enrollment/complete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              walletId: data.walletId,
              tokenId: data.onboarding.tokenId,
              role: 'member',
              recoveryDeposits: issued.deposits,
            }),
          });
          if (!resp.ok) {
            const errBody = await resp.text().catch(() => '');
            console.warn('[enroll] Insurer rejected the enrollment:', resp.status, errBody);
            return server.sendResponse(res, 403, false, undefined,
              'Enrollment rejected by insurer. Check your enrollment code and PIN.');
          }
          insurerNotified = true;
          console.log('[enroll] Insurer completed the enrollment and filed %d recovery deposits', issued.deposits.length);
        } catch (insErr: unknown) {
          console.warn('[enroll] Insurer unreachable:', insErr instanceof Error ? insErr.message : String(insErr));
          return server.sendResponse(res, 502, false, undefined,
            'Cannot reach insurer for enrollment validation. Try again later.');
        }
      }

      // Insurer approved (or no insurer configured) — NOW persist enrollment state locally
      data.onboarding.phase = 'enrolled';
      data.onboarding.enrollmentTimestamp = Date.now();
      data.lastSequencerUrl = server.getConfig().sequencerUrl;
      if (issued) {
        // card ids only: a share never rests on this device
        data.recoveryCards = issued.cards.map((c) => ({ cardId: c.id, issuedAt: Date.now() }));
        if (data.enrollment) data.enrollment.completedAt = Date.now();
      }
      await state.save(data);
      // Create MemberNode and advance in-memory phase (deferred from before insurer validation)
      const node = new MemberNode({
        role: 'member',
        walletId: data.walletId,
        sequencerUrl: server.getConfig().sequencerUrl,
        displayName: server.getConfig().displayName,
        clientOptions: server.sequencerClientOptions(),
      });
      server.setEntityNode(node);
      server.setOnboardingPhase('enrolled');

      // ── Step 2: Derive X25519 encryption keypair for E2E messaging
      let encryptionPublicKeyHex: string | undefined;
      try {
        if (state.hasEnrollmentKey()) {
          const { deriveEncryptionKeyPair } = await import('../../messaging/encryption.js');
          encryptionPublicKeyHex = state.useEnrollmentKey((ek) =>
            deriveEncryptionKeyPair(ek).publicKey.toString('hex')
          );
        }
      } catch (encErr: unknown) {
        console.warn('[enroll] Could not derive encryption keypair:', encErr instanceof Error ? encErr.message : String(encErr));
      }

      // A10b: the wallet's own signing key, registered beside the encryption key. Wallet-scoped
      // sequencer calls (messages, the PCP link, attestation requests) are signed with it from now on.
      let signingPublicKeyHex: string | undefined;
      try {
        if (state.hasEnrollmentKey()) {
          signingPublicKeyHex = state.useEnrollmentKey((ek) => deriveWalletSigningKey(ek).publicKeyHex);
        }
      } catch (keyErr: unknown) {
        console.warn('[enroll] Could not derive the wallet signing key:', keyErr instanceof Error ? keyErr.message : String(keyErr));
      }

      // ── Step 3: Register wallet on sequencer (ONLY after insurer approved)
      let sequencerRegistered = false;
      try {
        const seqUrl = server.getConfig().sequencerUrl.replace(/\/+$/, '');
        const regResp = await server.signedFetch(`${seqUrl}/rpc`, {
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
              encryptionPublicKeyHex,
              signingPublicKeyHex,
            },
          }),
        });
        sequencerRegistered = regResp.ok;
      } catch (seqErr: unknown) {
        console.warn('[enroll] Sequencer registration failed:', seqErr instanceof Error ? seqErr.message : String(seqErr));
      }

      // A6: the member no longer tells the employer anything. The old callback posted the wallet
      // ID to the employer's /enrollment/confirm, which rule I6 forbids; it only ever failed with a
      // 401 because that route is admin-only. The code is consumed by the employer's validate
      // oracle during the insurer step above, so there is nothing left to confirm.

      // Adjudication engine registration is deferred to /proof/registration.
      // Calling /interactive/register-member here would pre-register the wallet
      // on the sequencer via applyAdminRootUpdate(), causing "Wallet already
      // registered" when the ZK registration proof is later submitted.

      server.sendResponse(res, 200, true, {
        phase: sequencerRegistered ? 'enrolled' : 'enrolled-pending',
        walletId: data.walletId,
        sequencerUrl: seqUrl,
        insurerNotified,
        sequencerRegistered,
        // A12b: shown once, for the app to write to the two tags; the device keeps the ids only
        recoveryCards: issued?.cards ?? [],
        recoveryCardBytes: issued ? issued.cards.map(recoveryCardBytes) : [],
        ...(sequencerRegistered ? {} : {
          warning: 'Enrollment approved but network registration pending. Your enrollment is valid but claims may not work until registration completes.',
        }),
      });
    },
  });

  // ── Onboarding: Recover a wallet onto this device from a recovery card — plan item A12b ──
  // The card plus the recovery PIN on a new phone: the insurer releases the deposited share only
  // against the PIN verifier, attempt-limited per card; the shares recombine into the enrollment
  // key; the released salt and group re-derive the same wallet from the fields the member types;
  // and the sequencer confirms the wallet exists. No migration: it is the same wallet again.
  routes.push({
    method: 'POST',
    path: '/onboarding/recover',
    deviceOnly: true,
    handler: async (_req, res, _params, _query, body) => {
      if (server.getOnboardingPhase() !== 'awaiting_token') {
        return server.sendResponse(res, 409, false, undefined, `Cannot recover in phase: ${server.getOnboardingPhase()}`);
      }
      const insurerUrl = server.getConfig().insurerUrl || null;
      if (!insurerUrl) return server.sendResponse(res, 503, false, undefined, 'No insurer is configured for this device, so a recovery card cannot be used');
      const b = body as {
        card?: unknown; recoveryPin?: string;
        cardholderId?: string; dateOfBirth?: string; genderCode?: number; firstName?: string; lastName?: string;
      } | undefined;
      if (!isRecoveryCardV3(b?.card)) return server.sendResponse(res, 400, false, undefined, 'A v3 recovery card ({v, id, s}) is required');
      try { validateRecoveryPin(b?.recoveryPin); } catch { return server.sendResponse(res, 400, false, undefined, 'The recovery PIN is required (6 to 32 characters)'); }
      if (!b?.cardholderId || !b?.dateOfBirth || !b?.firstName || !b?.lastName || !/^\d{8}$/.test(b.dateOfBirth)) {
        return server.sendResponse(res, 400, false, undefined, 'Missing required fields: cardholderId, dateOfBirth (CCYYMMDD), firstName, lastName');
      }
      const card = b.card;
      const pinVerifier = recoveryPinVerifier(b.recoveryPin!, card.id);
      let released: { share2Hex?: string; identitySalt?: string; groupIdHash?: string; planIdHash?: string; domainTag?: number } | undefined;
      try {
        const resp = await fetch(`${insurerUrl.replace(/\/+$/, '')}/recovery/release`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cardId: card.id, pinVerifier }),
        });
        if (resp.status === 429) {
          const retry = resp.headers.get('retry-after');
          if (retry) res.setHeader('Retry-After', retry);
          return server.sendResponse(res, 429, false, undefined, 'Too many recovery attempts for this card. Try again later.');
        }
        if (!resp.ok) return server.sendResponse(res, 403, false, undefined, 'This card and PIN do not recover a wallet.');
        const json = await resp.json() as { data?: typeof released } & NonNullable<typeof released>;
        released = json.data ?? json;
      } catch (err: unknown) {
        console.warn('[recover] Insurer unreachable:', err instanceof Error ? err.message : String(err));
        return server.sendResponse(res, 502, false, undefined, 'Cannot reach the insurer to release the recovery deposit. Try again later.');
      }
      if (!released?.share2Hex || !isIdentitySalt(released.identitySalt) || !released.groupIdHash || !/^\d+$/.test(released.groupIdHash) || released.domainTag !== 0) {
        return server.sendResponse(res, 502, false, undefined, 'The insurer released an incomplete deposit');
      }
      let enrollmentKey: string;
      try { enrollmentKey = combineEnrollmentKey(card, released.share2Hex); }
      catch { return server.sendResponse(res, 502, false, undefined, 'The released share does not belong to this card'); }
      const genderCode = typeof b.genderCode === 'number' && Number.isInteger(b.genderCode) && b.genderCode >= 0 && b.genderCode <= 9 ? b.genderCode : 0;
      const localData: MemberLocalData = { cardholderId: b.cardholderId, dateOfBirth: b.dateOfBirth, genderCode, firstName: b.firstName, lastName: b.lastName };
      const groupIdHash = Field(BigInt(released.groupIdHash));
      const result = secureMemberDerivation(localData, enrollmentKey, groupIdHash, released.identitySalt);
      const walletId = result.walletId.toString();
      // The wallet has to exist on the network: a wrong name or birth date derives a wallet nobody registered.
      let known = false;
      try {
        const seqUrl = server.getConfig().sequencerUrl.replace(/\/+$/, '');
        const resp = await fetch(`${seqUrl}/rpc`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'l2_getEntity', params: { walletId } }),
        });
        const json = await resp.json() as { result?: unknown };
        known = Boolean(json.result);
      } catch (err: unknown) {
        console.warn('[recover] Sequencer unreachable:', err instanceof Error ? err.message : String(err));
        return server.sendResponse(res, 502, false, undefined, 'Cannot reach the sequencer to confirm the recovered wallet. Try again later.');
      }
      if (!known) {
        result.dispose();
        return server.sendResponse(res, 404, false, undefined, 'No wallet on the network matches this card and these details. Check the name, cardholder ID and date of birth exactly as enrolled.');
      }
      const state = server.getLocalState();
      const data = state.getState();
      if (!data) return server.sendResponse(res, 409, false, undefined, 'Device state is not open');
      state.setEnrollmentKey(enrollmentKey);
      data.walletId = walletId;
      data.preimageFields = result.preimage.map((f) => f.toString());
      data.domainTag = DOMAIN_TAG_MEMBER;
      data.identitySalt = released.identitySalt;
      data.enrollment = { groupIdHash: released.groupIdHash, planIdHash: released.planIdHash ?? '0', employerId: null, redeemedAt: Date.now(), completedAt: Date.now() };
      data.onboarding.phase = 'enrolled';
      data.onboarding.enrollmentTimestamp = Date.now();
      data.lastSequencerUrl = server.getConfig().sequencerUrl;
      await state.save(data);
      result.dispose();
      const node = new MemberNode({
        role: 'member',
        walletId,
        sequencerUrl: server.getConfig().sequencerUrl,
        displayName: server.getConfig().displayName,
        clientOptions: server.sequencerClientOptions(),
      });
      server.setEntityNode(node);
      server.setOnboardingPhase('enrolled');
      console.log('[recover] Wallet %s… recovered from card %s', walletId.slice(0, 16), card.id);
      server.sendResponse(res, 200, true, { phase: 'enrolled', walletId, recoveredFromCard: card.id });
    },
  });

  // ── Recovery cards: issue a fresh pair later (a lost card, or after revoking one) ──
  routes.push({
    method: 'POST',
    path: '/recovery-card/issue',
    deviceOnly: true,
    handler: async (_req, res, _params, _query, body) => {
      const phase = server.getOnboardingPhase();
      if (phase !== 'enrolled' && phase !== 'compiling' && phase !== 'ready') {
        return server.sendResponse(res, 409, false, undefined, `Cannot issue recovery cards in phase: ${phase}`);
      }
      const insurerUrl = server.getConfig().insurerUrl || null;
      if (!insurerUrl) return server.sendResponse(res, 503, false, undefined, 'No insurer is configured for this device');
      const state = server.getLocalState();
      const data = state.getState();
      if (!data?.walletId || !data.identitySalt || !data.enrollment?.groupIdHash || !state.hasEnrollmentKey()) {
        return server.sendResponse(res, 409, false, undefined, 'This device holds no enrolled wallet with an identity salt');
      }
      const b = body as { recoveryPin?: string } | undefined;
      try { validateRecoveryPin(b?.recoveryPin); } catch { return server.sendResponse(res, 400, false, undefined, 'A recovery PIN of 6 to 32 characters is required'); }
      const recoveryPin = b!.recoveryPin!;
      const { groupIdHash, planIdHash } = data.enrollment;
      const identitySalt = data.identitySalt;
      const issued = state.useEnrollmentKey((key) => issueRecoveryCards({ enrollmentKey: key, recoveryPin, identitySalt, groupIdHash, planIdHash, domainTag: 0 }));
      try {
        const resp = await fetch(`${insurerUrl.replace(/\/+$/, '')}/recovery/deposit`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ walletId: data.walletId, deposits: issued.deposits }),
        });
        if (!resp.ok) return server.sendResponse(res, 502, false, undefined, 'The insurer did not file the recovery deposits');
      } catch (err: unknown) {
        return server.sendResponse(res, 502, false, undefined, 'Cannot reach the insurer to file the recovery deposits');
      }
      data.recoveryCards = [...(data.recoveryCards ?? []), ...issued.cards.map((c) => ({ cardId: c.id, issuedAt: Date.now() }))];
      await state.save(data);
      server.sendResponse(res, 200, true, { recoveryCards: issued.cards, recoveryCardBytes: issued.cards.map(recoveryCardBytes) });
    },
  });

  // ── Onboarding: Compile Programs ──────────────────────────
  routes.push({
    method: 'POST',
    path: '/onboarding/compile',
    deviceOnly: true,
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
    deviceOnly: true,
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
      // Reconstruct transition preimage: [domainTag, ...walletFields padded to 5]
      const walletFields = data.preimageFields.map((s: string) => Field(BigInt(s)));
      const padded = [...walletFields];
      while (padded.length < 6) padded.push(Field(0));
      const preimage = [Field(data.domainTag ?? 0), ...padded];

      // Registration proofs commit to the current registry root and the next free slot.
      // If another member registers first, the sequencer reports a root mismatch; fetch
      // fresh witnesses and prove again. This is what lets several employers enroll at once.
      const MAX_ATTEMPTS = 6;
      let receipt: Awaited<ReturnType<typeof node.submitProof>> | undefined;
      for (let attempt = 1; ; attempt++) {
        const witnesses = await node.getClient().getRegistrationWitnesses();
        const regWitnessData = typeof witnesses.registryWitnessJson === 'string'
          ? JSON.parse(witnesses.registryWitnessJson)
          : witnesses.registryWitnessJson;
        const lcWitnessData = typeof witnesses.lifecycleWitnessJson === 'string'
          ? JSON.parse(witnesses.lifecycleWitnessJson)
          : witnesses.lifecycleWitnessJson;
        const regWitness = WalletRegistryWitness.fromJSON(regWitnessData);
        const lcWitness = LifecycleWitness.fromJSON(lcWitnessData);
        const regRoot = Field(BigInt(String(witnesses.currentRegistryRoot)));
        const lcRoot = Field(BigInt(String(witnesses.currentLifecycleRoot)));

        // Generate real ZK proof (~20-120s)
        const proof = await node.proveRegistration(preimage, regWitness, lcWitness, regRoot, lcRoot);
        try {
          receipt = await node.submitProof(proof);
          break;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const contended = /root mismatch|does not match the sequencer tree|state changed while/i.test(msg);
          if (!contended || attempt >= MAX_ATTEMPTS) throw err;
          console.log(`[registration] another registration landed first (attempt ${attempt}/${MAX_ATTEMPTS}); re-proving against the new root`);
          await new Promise(r => setTimeout(r, 250 + Math.floor(Math.random() * 1500)));
        }
      }

      // Register proving context with adjudication engine AFTER proof is accepted.
      // This must happen after submitProof so the wallet is already in the
      // sequencer's WalletRegistry — register-member uses applyAdminRootUpdate
      // which skips wallets that are already registered.
      let adjudicationRegistered = false;
      if (data.preimageFields) {
        try {
          // Derive encryption public key from enrollment key (private key stays on device)
          let publicKeyHex: string | undefined;
          const localState = server.getLocalState();
          if (localState.hasEnrollmentKey()) {
            publicKeyHex = localState.useEnrollmentKey((key) => {
              const kp = deriveEncryptionKeyPair(key);
              const hex = kp.publicKey.toString('hex');
              kp.privateKey.fill(0); // scrub private key immediately
              return hex;
            });
          }

          const seqUrlClean = server.getConfig().sequencerUrl.replace(/\/+$/, '');
          // B2: the engine never receives the identity preimage. The device proves the wallet is its
          // own (ProofGate.verifyMember over the six salted fields) and sends that proof; the engine
          // verifies it and keeps it for the portable credential.
          const ownershipProofJson = await node.proveOwnership(Field(BigInt(data.walletId)), padded.slice(0, 6));
          const regResp = await fetch(`${seqUrlClean}/interactive/register-member`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              walletId: data.walletId,
              ownershipProofJson,
              displayName: server.getConfig().displayName || 'Member',
              // Step 2 commit two: the engine binds the plan and the group from the insurer's approval;
              // nothing the device says about either is read.
              publicKeyHex,
            }),
          });
          adjudicationRegistered = regResp.ok;
          if (!regResp.ok) {
            console.warn(`[registration] the engine refused the registration: ${regResp.status} ${(await regResp.text().catch(() => '')).slice(0, 200)}`);
          }
        } catch { /* non-critical — adjudication proofs won't be available */ }
      }

      // B1 step two: the credential mint is a wallet update the device proves; done here, right after.
      let walletUpdates: WalletUpdateRun | undefined;
      if (adjudicationRegistered) {
        try {
          walletUpdates = await applyPendingWalletUpdates(server);
        } catch (err) {
          console.warn('[registration] the credential mint could not be proved yet:', err instanceof Error ? err.message : String(err));
        }
      }

      server.sendResponse(res, 200, true, {
        receiptId: receipt!.receiptId,
        walletId: data.walletId,
        proofGenerated: true,
        submittedToSequencer: true,
        adjudicationRegistered,
        walletUpdates,
      });
      } catch (err) {
        const msg = err instanceof Error ? `${err.message}\n${err.stack}` : String(err);
        return server.sendResponse(res, 500, false, undefined, msg);
      }
    },
  });

  /*
   * `POST /onboarding/backup-key` and `POST /onboarding/restore-key` were here. Both are gone
   * — phase A item A3, findings A-5, MEM-C1 and MEM-H2.
   *
   * `backup-key` took the PIN **from the request body** and returned the AES-GCM blob in the
   * response. So the caller chose the PIN, received the ciphertext, and decrypted the raw
   * 256-bit enrollment key at leisure. The card-plus-PIN second factor only means anything if
   * the holder of the card is not also the party that set the PIN, and over HTTP they always
   * were. It was gated on the onboarding phase and on a key existing, and on nothing else: no
   * authentication at all.
   *
   * `restore-key` had neither authentication nor a phase check, and wrote whatever it decrypted
   * straight into local state. One request replaced the key the wallet is derived from, which
   * either hijacks the wallet or destroys it.
   *
   * Rule I3: the enrollment key lives in the device's secure storage and on an offline card
   * under a PIN, and nowhere else. A route that exports it cannot be made to satisfy that by
   * adding authentication, because the export itself is the breach. Backup becomes an in-app
   * operation that writes the card at the enrollment tap — item A12b, which is in phase A
   * precisely because that tap is the only moment the key is in hand.
   */

  // ── Query: Drug History ───────────────────────────────────

  routes.push({
    method: 'GET',
    path: '/drugs',
    deviceOnly: true,
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
    deviceOnly: true,
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
    deviceOnly: true,
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
    deviceOnly: true,
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
    deviceOnly: true,
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
    deviceOnly: true,
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
    deviceOnly: true,
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
    deviceOnly: true,
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
    deviceOnly: true,
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
    deviceOnly: true,
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
    deviceOnly: true,
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
    deviceOnly: true,
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
    deviceOnly: true,
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
    deviceOnly: true,
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

        // 9. Submit proof to sequencer, with the new credential root so it can update its tree
        const receipt = await node.submitProof(proof, { newCredentialInventoryRoot: newCredentialRoot.toString() });
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
          await client.registerPcpAssignment(data.walletId, pcpWid, pcpDate, node.walletSigner() ?? undefined);
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

  // ── Wallet updates the device proves (B1 step two) ───────
  // The app (or the sync loop) asks the device to fetch, check, prove and report every update the
  // engine queued for its wallet: the credential mint, each fill, a prior authorization, a plan change.

  routes.push({
    method: 'POST',
    path: '/proof/wallet-updates',
    deviceOnly: true,
    handler: async (_req, res) => {
      if (server.getOnboardingPhase() !== 'ready') {
        return server.sendResponse(res, 409, false, undefined, `Cannot prove in phase: ${server.getOnboardingPhase()}`);
      }
      try {
        const run = await applyPendingWalletUpdates(server);
        server.sendResponse(res, 200, true, run);
      } catch (err) {
        server.sendResponse(res, 500, false, undefined, err instanceof Error ? err.message : 'Wallet updates failed');
      }
    },
  });

  // ── NFC attestation (A10b) ───────────────────────────────
  // The member asks for its sequencer-signed attestation through its own node, which signs the
  // request as the wallet; the sequencer answers no unsigned l2_requestAttestation any more.

  routes.push({
    method: 'POST',
    path: '/attestation/request',
    deviceOnly: true,
    handler: async (_req, res, _params, _query, body) => {
      const node = server.getEntityNode() as MemberNode | null;
      const data = server.getLocalState().getState();
      if (!node || !data?.walletId) {
        return server.sendResponse(res, 409, false, undefined, 'Wallet not derived — complete onboarding first');
      }
      if (!node.walletSigner()) {
        return server.sendResponse(res, 409, false, undefined, 'Device is locked — the enrollment key is needed to sign as the wallet');
      }
      const b = body as { expirySeconds?: number } | undefined;
      const expirySeconds = typeof b?.expirySeconds === 'number' && b.expirySeconds > 0
        ? Math.min(Math.floor(b.expirySeconds), 7 * 86_400)
        : undefined;
      try {
        const attestation = await node.requestAttestation(data.walletId, expirySeconds);
        server.sendResponse(res, 200, true, attestation);
      } catch (err) {
        server.sendResponse(res, 502, false, undefined, err instanceof Error ? err.message : 'Attestation request failed');
      }
    },
  });

  // ── NFC Identity (tap-to-identify at pharmacy) ─────────────

  routes.push({
    method: 'GET',
    path: '/nfc/id-payload',
    deviceOnly: true,
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
    deviceOnly: true,
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
    deviceOnly: true,
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

  // Simplified E2E encrypted send — handles encryption server-side using enrollment key
  routes.push({
    method: 'POST',
    path: '/messaging/send',
    deviceOnly: true,
    handler: async (_req, res, _params, _query, body) => {
      const node = server.getEntityNode() as MemberNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');

      const b = body as { recipientWalletId?: string; body?: string; message?: Record<string, unknown>; payload?: Record<string, unknown> } | undefined;

      // New simplified path: { recipientWalletId, body } → server handles encryption
      if (b?.recipientWalletId && b?.body && !b?.message) {
        try {
          const walletId = node.getWalletId();
          const plaintext = b.body;
          const seqUrl = server.getConfig().sequencerUrl.replace(/\/+$/, '');
          const threadIdHash = Poseidon.hash([
            Field(BigInt(walletId)),
            ...Encoding.stringToFields(b.recipientWalletId),
          ]).toString();
          const messageCommitment = Poseidon.hash([
            ...Encoding.stringToFields(walletId + ':' + Date.now()),
          ]).toString();

          // E2E encrypt using enrollment key + recipient's public key
          let ciphertextHex: string;
          let ivHex = '0';
          let tagHex = '0';

          const lState = server.getLocalState();
          if (lState.hasEnrollmentKey()) {
            try {
              const { deriveEncryptionKeyPair: dkp, deriveSharedSecret: dss, encryptMessage: em } = await import('../../messaging/encryption.js');
              // Step 1 (async): fetch recipient pubkey
              const keyResp = await fetch(`${seqUrl}/rpc`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'l2_getEncryptionKey', params: { walletId: b.recipientWalletId } }),
              });
              const keyJson = await keyResp.json() as any;
              if (keyJson.result?.encryptionPublicKeyHex) {
                const recipientPub = Buffer.from(keyJson.result.encryptionPublicKeyHex, 'hex');
                // Step 2 (sync inside callback): encrypt
                const result = lState.useEnrollmentKey((ek) => {
                  const senderKp = dkp(ek);
                  const shared = dss(senderKp.privateKey, recipientPub);
                  const encrypted = em(plaintext, shared);
                  return { c: encrypted.ciphertext.toString('hex'), i: encrypted.iv.toString('hex'), t: encrypted.tag.toString('hex') };
                });
                ciphertextHex = result.c;
                ivHex = result.i;
                tagHex = result.t;
              } else {
                ciphertextHex = Buffer.from(plaintext, 'utf8').toString('hex');
              }
            } catch {
              ciphertextHex = Buffer.from(plaintext, 'utf8').toString('hex');
            }
          } else {
            ciphertextHex = Buffer.from(plaintext, 'utf8').toString('hex');
          }

          const entry = await node.storeMessage(
            { messageCommitment, senderWalletId: walletId, recipientWalletId: b.recipientWalletId, messageType: '1', threadIdHash },
            { ciphertext: ciphertextHex, iv: ivHex, tag: tagHex, timestamp: Date.now() },
          );
          return server.sendResponse(res, 200, true, entry);
        } catch (err) {
          return server.sendResponse(res, 500, false, undefined, err instanceof Error ? err.message : 'Send failed');
        }
      }

      // Legacy path: pre-built { message, payload } — pass through as-is
      if (!b?.message || !b?.payload) {
        return server.sendResponse(res, 400, false, undefined, 'Missing recipientWalletId+body or message+payload');
      }
      try {
        const msg = b.message;
        const pl = b.payload;
        for (const f of ['messageCommitment', 'recipientWalletId', 'messageType', 'threadIdHash']) {
          if (!(f in msg) || msg[f] === undefined || msg[f] === '') {
            return server.sendResponse(res, 400, false, undefined, `Message missing required field: ${f}`);
          }
        }
        if (!msg.senderWalletId || msg.senderWalletId === '') {
          msg.senderWalletId = node.getWalletId();
        }
        const entry = await node.storeMessage(msg as any, pl as any);
        server.sendResponse(res, 200, true, entry);
      } catch (err) {
        server.sendResponse(res, 500, false, undefined, err instanceof Error ? err.message : 'Message send failed');
      }
    },
  });

  routes.push({
    method: 'GET',
    path: '/messaging/inbox',
    deviceOnly: true,
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
    deviceOnly: true,
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
    deviceOnly: true,
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

  // ══════════════════════════════════════════════════════════
  //  EJECT — Full local state reset
  // ══════════════════════════════════════════════════════════
  //
  // Nukes all local state (encrypted file + in-memory node reference) and
  // returns the member to the very beginning of onboarding. The member will
  // need a new enrollment token from their employer to start over.
  //
  // Does NOT affect sequencer state — any already-submitted ZK proof and
  // wallet registration persist on-chain. The ejected walletId becomes
  // orphaned (harmless).

  routes.push({
    method: 'POST',
    path: '/onboarding/eject',
    /*
     * Deliberately NOT deviceOnly. This route verifies the PIN itself (A4), which is strictly
     * stronger than holding a session that a PIN once produced. Requiring both would mean a
     * member who knows their PIN cannot wipe a device whose session has expired without first
     * unlocking it, which is a two-step for no gain. The PIN is the authorisation here.
     */
    handler: async (_req, res, _params, _query, body) => {
      const state = server.getLocalState();
      if (!state) {
        return server.sendResponse(res, 503, false, undefined, 'State manager not initialized');
      }

      /*
       * A fresh PIN, every time (A4, finding A-20).
       *
       * This used to accept `isUnlocked()` as proof that the owner was present. That flag meant
       * only that a key had been derived at some point, and deriving a key cannot fail, so one
       * unlock attempt with six characters of junk made it true and this route then deleted the
       * device's state. The launcher's environment PIN made it true at boot, so eject needed no
       * PIN at all.
       *
       * `unlock()` now verifies, which closes that path. This route asks again anyway, because
       * an irreversible action should prove the person is at the device *now* rather than that
       * someone unlocked it this morning. The check is rate-limited on the same counter as
       * unlocking, so eject cannot be used to grind through PINs.
       */
      const b = body as { pin?: string } | undefined;
      if (!b?.pin) {
        return server.sendResponse(res, 400, false, undefined,
          'Ejecting erases this device. Send your PIN to confirm.');
      }

      try {
        if (!(await state.verifyPin(b.pin))) {
          return server.sendResponse(res, 401, false, undefined,
            'Incorrect PIN. Nothing was erased.');
        }
      } catch (err: unknown) {
        if (err instanceof PinAttemptThrottled) {
          res.setHeader('Retry-After', String(Math.ceil(err.retryAfterMs / 1000)));
          return server.sendResponse(res, 429, false, undefined, err.message);
        }
        throw err;
      }

      try {
        // 1. Delete the encrypted state file from disk
        await state.destroy();

        // 2. Clear in-memory state (enrollment key, derived key, etc.)
        state.lock();
        // A5: and the device session, which outlived the state it authorised access to.
        server.clearDeviceSession();

        // 3. Reset the phase BEFORE clearing the node — if setEntityNode
        //    throws, at least the phase is correct for the next request.
        server.setOnboardingPhase('awaiting_token');

        // 4. Clear the MemberNode reference (compiled ZkPrograms, proofs, etc.)
        server.setEntityNode(null);

        console.log('[eject] All local state destroyed. Member must re-enroll with a new token.');

        server.sendResponse(res, 200, true, {
          ejected: true,
          message: 'All local enrollment data has been erased. You will need a new enrollment token from your employer to start over.',
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[eject] Failed to destroy state:', msg);
        server.sendResponse(res, 500, false, undefined, 'Eject failed: ' + msg);
      }
    },
  });

  return routes;
}
