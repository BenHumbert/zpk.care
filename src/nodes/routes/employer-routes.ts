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
 * Employer Routes — REST endpoints for EmployerNode Nautilus Apps.
 *
 * Pattern: follows insurer-routes.ts (no wallet, no enrollment key).
 * Single-step onboarding: configure → ready.
 *
 * Capabilities:
 *   - Group management (create, list, terminate)
 *   - Token generation, revocation, validation, submission to insurer
 *   - Roster management (list, query, terminate)
 *   - Read-only sequencer queries (chain state, status)
 */
import { EmployerNode } from '../employer-node.js';
import type { NautilusAppServer } from '../nautilus-app-server.js';
import type { RouteRegistration } from '../nautilus-app-types.js';
import { verifySignedRequest, ReplayCache } from '../../security/signed-request.js';
import { SlidingWindowLimiter } from '../../security/rate-limit.js';
import { normalizeTokenId } from '../../onboarding/enrollment-code.js';

/**
 * Build all employer routes.
 */
export function buildEmployerRoutes(server: NautilusAppServer): RouteRegistration[] {
  const routes: RouteRegistration[] = [];

  // A6: the validate oracle's own limiters and replay memory. Per node, so one tenant's traffic
  // never counts against another's. A caller is charged only for the requests the insurer did not
  // sign; one the insurer signed spends the overall budget alone (the route says why).
  const VALIDATE_PER_CALLER_PER_MINUTE = 60;
  const validatePerCaller = new SlidingWindowLimiter(VALIDATE_PER_CALLER_PER_MINUTE, 60_000);
  const validateOverall = new SlidingWindowLimiter(600, 60_000);
  const validateReplay = new ReplayCache();

  // ══════════════════════════════════════════════════════════
  //  ONBOARDING (simplified — no wallet, no key)
  // ══════════════════════════════════════════════════════════

  routes.push({
    method: 'POST',
    path: '/onboarding/configure',
    handler: async (_req, res, _params, _query, body) => {
      const phase = server.getOnboardingPhase();
      if (phase === 'ready') {
        return server.sendResponse(res, 409, false, undefined, 'Already configured');
      }

      const b = body as { employerId?: string } | undefined;
      if (!b?.employerId) {
        return server.sendResponse(res, 400, false, undefined, 'Missing employerId');
      }

      // SSRF fix: insurerUrl must come from server config, never from request body
      const node = new EmployerNode({
        role: 'employer',
        sequencerUrl: server.getConfig().sequencerUrl,
        displayName: server.getConfig().displayName,
        employerId: b.employerId,
        insurerUrl: (server.getConfig() as any).insurerUrl ?? null,
        clientOptions: server.sequencerClientOptions(),
      });
      server.setEntityNode(node);

      const state = server.getLocalState();
      const data = state.getState();
      if (data) {
        data.onboarding.phase = 'ready';
        data.onboarding.enrollmentTimestamp = Date.now();
        data.lastSequencerUrl = server.getConfig().sequencerUrl;
        await state.save(data);
      }

      server.setOnboardingPhase('ready');
      server.sendResponse(res, 200, true, {
        phase: 'ready',
        employerId: b.employerId,
        sequencerUrl: server.getConfig().sequencerUrl,
      });
    },
  });

  // /onboarding/status is handled by NautilusAppServer built-in route

  // ══════════════════════════════════════════════════════════
  //  GROUPS
  // ══════════════════════════════════════════════════════════

  routes.push({
    method: 'POST',
    path: '/groups',
    adminOnly: true,
    handler: async (_req, res, _params, _query, body) => {
      const node = server.getEntityNode() as EmployerNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Employer node not configured');

      const b = body as {
        groupId?: string;
        planId?: string;
        effectiveDate?: string;
        enrollmentCap?: number;
      } | undefined;
      if (!b?.groupId || !b?.planId || !b?.effectiveDate) {
        return server.sendResponse(res, 400, false, undefined, 'Missing groupId, planId, or effectiveDate');
      }

      try {
        const group = node.createGroup(b.groupId, b.planId, b.effectiveDate, b.enrollmentCap ?? 0);
        server.sendResponse(res, 201, true, group);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        server.sendResponse(res, 409, false, undefined, msg);
      }
    },
  });

  routes.push({
    method: 'GET',
    path: '/groups',
    // A7 (AUTH-13): group IDs, plan IDs and utilisation are the employer's to read, not the
    // network's. The HR Tool and the employer dashboard both hold the admin token.
    adminOnly: true,
    handler: async (_req, res) => {
      const node = server.getEntityNode() as EmployerNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Employer node not configured');
      // Phase F1: return groups with inlined utilization stats so the HR Tool
      // Group Selection Screen and the Employer Dashboard Groups tab can both
      // populate from one call without N+1 follow-up requests.
      server.sendResponse(res, 200, true, node.listGroupsWithStats());
    },
  });

  routes.push({
    method: 'GET',
    path: '/groups/:groupId',
    adminOnly: true,
    handler: async (_req, res, params) => {
      const node = server.getEntityNode() as EmployerNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Employer node not configured');
      const group = node.getGroup(params.groupId);
      if (!group) return server.sendResponse(res, 404, false, undefined, 'Group not found');
      server.sendResponse(res, 200, true, group);
    },
  });

  // Phase F1: dedicated stats endpoint. The HR Tool calls this before
  // initiating an import to check remainingSlots against the CSV row count.
  routes.push({
    method: 'GET',
    path: '/groups/:groupId/stats',
    adminOnly: true,
    handler: async (_req, res, params) => {
      const node = server.getEntityNode() as EmployerNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Employer node not configured');
      const stats = node.getGroupStats(params.groupId);
      if (!stats) return server.sendResponse(res, 404, false, undefined, 'Group not found');
      server.sendResponse(res, 200, true, stats);
    },
  });

  routes.push({
    method: 'DELETE',
    path: '/groups/:groupId',
    adminOnly: true,
    handler: async (_req, res, params, _query, body) => {
      const node = server.getEntityNode() as EmployerNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Employer node not configured');

      const b = body as { terminationDate?: string } | undefined;
      const termDate = b?.terminationDate ?? new Date().toISOString().replace(/\D/g, '').slice(0, 8);

      try {
        node.terminateGroup(params.groupId, termDate);
        server.sendResponse(res, 200, true, { terminated: true, groupId: params.groupId });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        server.sendResponse(res, 409, false, undefined, msg);
      }
    },
  });

  // ══════════════════════════════════════════════════════════
  //  TOKENS
  // ══════════════════════════════════════════════════════════

  routes.push({
    method: 'POST',
    path: '/tokens/generate',
    adminOnly: true,
    handler: async (_req, res, _params, _query, body) => {
      const node = server.getEntityNode() as EmployerNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Employer node not configured');

      const b = body as {
        groupId?: string;
        employeeIdHash?: string;
        familyIdHash?: string;
        validUntil?: string;
      } | undefined;
      if (!b?.groupId || !b?.employeeIdHash || !b?.validUntil) {
        return server.sendResponse(res, 400, false, undefined, 'Missing groupId, employeeIdHash, or validUntil');
      }
      // A6: the node chooses the code. A caller-chosen one would be exactly as guessable as its
      // caller, and the HR Tool never sends one.
      if ((b as { tokenId?: unknown }).tokenId !== undefined) {
        return server.sendResponse(res, 400, false, undefined,
          'Enrollment codes are generated by this node; a caller-chosen code is not accepted.');
      }
      const familyIdHash = b.familyIdHash || b.employeeIdHash;
      // Accept ISO date (2026-12-31) or CCYYMMDD (20261231)
      let validUntil = b.validUntil!;
      if (validUntil.includes('-')) {
        validUntil = validUntil.replace(/-/g, '');
      }

      try {
        const result = node.generateToken(b.groupId, b.employeeIdHash, familyIdHash, validUntil);
        server.sendResponse(res, 201, true, {
          tokenId: result.tokenId,
          tokenIdHash: result.token.tokenIdHash.toString(),
          groupIdHash: result.token.groupIdHash.toString(),
          validUntil: b.validUntil,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        server.sendResponse(res, 409, false, undefined, msg);
      }
    },
  });

  routes.push({
    method: 'GET',
    path: '/tokens/:tokenId',
    adminOnly: true,
    handler: async (_req, res, params) => {
      const node = server.getEntityNode() as EmployerNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Employer node not configured');
      const record = node.getTokenRecord(params.tokenId);
      if (!record) return server.sendResponse(res, 404, false, undefined, 'Token not found');
      server.sendResponse(res, 200, true, {
        tokenId: params.tokenId,
        status: record.status,
        groupIdHash: record.groupIdHash,
        planIdHash: record.planIdHash,
        validUntil: record.validUntil.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3'),
        consumedByWalletId: record.consumedByWalletId ?? null,
        consumedAt: record.consumedAt ?? null,
      });
    },
  });

  routes.push({
    method: 'POST',
    path: '/tokens/:tokenId/revoke',
    adminOnly: true,
    handler: async (_req, res, params) => {
      const node = server.getEntityNode() as EmployerNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Employer node not configured');
      try {
        node.revokeToken(params.tokenId);
        server.sendResponse(res, 200, true, { revoked: true, tokenId: params.tokenId });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        server.sendResponse(res, 409, false, undefined, msg);
      }
    },
  });

  // Set PIN hash on a token — called by HR Tool after token generation
  routes.push({
    method: 'POST',
    path: '/tokens/:tokenId/set-pin-hash',
    adminOnly: true,
    handler: async (_req, res, params, _query, body) => {
      const node = server.getEntityNode() as EmployerNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Employer node not configured');
      const b = body as { tokenPinHash?: string } | undefined;
      if (!b?.tokenPinHash) {
        return server.sendResponse(res, 400, false, undefined, 'Missing tokenPinHash');
      }
      try {
        node.setTokenPinHash(params.tokenId, b.tokenPinHash);
        server.sendResponse(res, 200, true, { tokenId: params.tokenId, pinHashSet: true });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        server.sendResponse(res, 409, false, undefined, msg);
      }
    },
  });

  routes.push({
    method: 'POST',
    path: '/tokens/:tokenId/validate',
    handler: async (req, res, params, _query, body) => {
      /*
       * The validate oracle — phase A item A6, findings AUTH-13 and A-31.
       *
       * Who may ask: the insurer, and only the insurer, proven by an Ed25519 signature over the
       * method, path, timestamp and the body actually received, verified against the insurer key
       * inside this employer's own attestation. That key got there because the sequencer checked
       * the insurer's counter-signature against the key it pins (A9), so the trust chain runs
       * insurer → sequencer → attestation → here, and no secret had to be handed to this node.
       *
       * What it answers: a verdict on one code and PIN hash, and on success the code is consumed in
       * the same step. It no longer answers anonymous callers, so it is no longer an oracle that
       * leaks "token not found" versus "wrong PIN (3 attempts remaining)" to anyone on the network.
       *
       * Two rate limits, in addition to the authority's own lock after five wrong PINs on a token:
       * 60 requests a minute from one caller that the insurer did not sign, and 600 a minute in
       * all that it did. A caller is what server.callerKey names: its address, an IPv6 address's
       * /64, or behind a reverse proxy this node trusts, the client the proxy forwards for. The raw
       * socket address counted here before made an IPv4 caller and its IPv4-mapped form two
       * callers, one IPv6 host as many as its /64 has addresses, and everyone behind a proxy one.
       */
      const node = server.getEntityNode() as EmployerNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Employer node not configured');

      // The order of the checks is what keeps junk off the insurer's budget. A caller already over
      // its own limit is refused first, whoever signed the request, by a count that records
      // nothing, so a flood costs no signature check and spends nothing. A request that then fails
      // to prove it is the insurer's (unsigned, unverifiable for want of an attestation, or not
      // verifying) is charged to its caller and to nothing else. Only a request the insurer signed
      // spends the overall budget, and it is never charged to its caller: the insurer is the one
      // caller this oracle answers, and it relays every member's enrollment. Before, the overall
      // limit was recorded first, for every request: one client's 600 unsigned requests a minute
      // (60 answered 401, 540 refused by its own limit, all 600 counted) had the insurer's next
      // signed request refused 429, and every enrollment with this employer failed for that
      // minute; and the insurer had only the 60 a minute any caller has.
      const caller = server.callerKey(req);
      if (validatePerCaller.count(caller) >= VALIDATE_PER_CALLER_PER_MINUTE) {
        return server.sendResponse(res, 429, false, undefined, 'Too many validation requests. Try again in a minute.');
      }

      // An unsigned request is the caller's problem and is answered as such, before anything about
      // this node's own readiness is disclosed.
      if (!req.headers['x-admin-signature']) {
        validatePerCaller.allow(caller);
        return server.sendResponse(res, 401, false, undefined, 'This oracle answers only the insurer: the request is not signed.');
      }

      const pinnedInsurerKey = node.getInsurerPublicKeyHex();
      if (!pinnedInsurerKey) {
        validatePerCaller.allow(caller);
        return server.sendResponse(res, 503, false, undefined,
          'This employer node has no attestation loaded, so it cannot tell who the insurer is. Refresh the attestation first.');
      }

      let pathname: string;
      try { pathname = new URL(req.url ?? '/', 'http://localhost').pathname; } catch { pathname = req.url ?? '/'; }
      const verdict = verifySignedRequest({
        method: 'POST',
        path: pathname,
        headers: req.headers,
        expectedSignerId: 'insurer',
        publicKeyHex: pinnedInsurerKey,
        body: body === undefined ? '' : JSON.stringify(body),
        replayCache: validateReplay,
      });
      if (!verdict.ok) {
        validatePerCaller.allow(caller);
        return server.sendResponse(res, 401, false, undefined, `This oracle answers only the insurer: ${verdict.reason}.`);
      }
      if (!validateOverall.allow('*')) {
        return server.sendResponse(res, 429, false, undefined, 'Too many validation requests. Try again in a minute.');
      }

      const tokenId = normalizeTokenId(params.tokenId);
      const b = body as { tokenPinHash?: unknown } | undefined;
      if (typeof b?.tokenPinHash !== 'string' || b.tokenPinHash.length === 0) {
        return server.sendResponse(res, 400, false, undefined, 'Enrollment PIN hash is required.');
      }

      // An orphan: generation succeeded and set-pin-hash never landed. It cannot be redeemed and the
      // HR Tool revokes these; say so rather than counting a PIN attempt against it.
      const record = node.getTokenRecord(tokenId);
      if (record && record.status === 'unused' && !record.tokenPinHash) {
        return server.sendResponse(res, 409, false, undefined, 'Token PIN hash not yet set — retry enrollment code generation');
      }

      const date = new Date().toISOString().replace(/\D/g, '').slice(0, 8);
      const result = node.redeemTokenWithPin(tokenId, date, b.tokenPinHash);
      server.sendResponse(res, 200, true, result);
    },
  });

  // ══════════════════════════════════════════════════════════
  //  ENROLLMENT CONFIRMATION — removed in A6 (see the note below)
  // ══════════════════════════════════════════════════════════

  // A6: there is no POST /enrollment/confirm and no POST /tokens/:id/submit any more. Both carried
  // the member's wallet ID to the employer, which rule I6 forbids, and the only reason the first
  // never leaked one is that the member's call landed on an admin-only route and got a 401. A code
  // is now consumed by the validate oracle itself, so neither route had a job left to do.

  // ══════════════════════════════════════════════════════════
  //  ROSTER
  // ══════════════════════════════════════════════════════════

  routes.push({
    method: 'GET',
    path: '/roster',
    adminOnly: true,
    handler: async (_req, res, _params, query) => {
      const node = server.getEntityNode() as EmployerNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Employer node not configured');
      const entries = node.listRoster();
      const statusFilter = query.get('status');
      const filtered = statusFilter
        ? entries.filter((e) => e.status === statusFilter)
        : entries;
      server.sendResponse(res, 200, true, {
        total: filtered.length,
        active: node.activeRosterCount,
        entries: filtered,
      });
    },
  });

  routes.push({
    method: 'GET',
    path: '/roster/:employeeIdHash',
    adminOnly: true,
    handler: async (_req, res, params) => {
      const node = server.getEntityNode() as EmployerNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Employer node not configured');
      const entry = node.getRosterEntry(params.employeeIdHash);
      if (!entry) return server.sendResponse(res, 404, false, undefined, 'Roster entry not found');
      server.sendResponse(res, 200, true, entry);
    },
  });

  routes.push({
    method: 'DELETE',
    path: '/roster/:employeeIdHash',
    adminOnly: true,
    handler: async (_req, res, params) => {
      const node = server.getEntityNode() as EmployerNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Employer node not configured');
      try {
        node.terminateRosterEntry(params.employeeIdHash);
        server.sendResponse(res, 200, true, { terminated: true });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        server.sendResponse(res, 404, false, undefined, msg);
      }
    },
  });

  // ══════════════════════════════════════════════════════════
  //  SEQUENCER QUERIES (Read-Only)
  // ══════════════════════════════════════════════════════════

  routes.push({
    method: 'GET',
    path: '/sequencer/chain-state',
    handler: async (_req, res) => {
      const node = server.getEntityNode() as EmployerNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Employer node not configured');
      server.sendResponse(res, 200, true, await node.getChainState());
    },
  });

  routes.push({
    method: 'GET',
    path: '/sequencer/status',
    handler: async (_req, res) => {
      const node = server.getEntityNode() as EmployerNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Employer node not configured');
      server.sendResponse(res, 200, true, await node.getSequencerStatus());
    },
  });

  // ══════════════════════════════════════════════════════════
  //  MESSAGING (proxy to sequencer message store)
  // ══════════════════════════════════════════════════════════

  routes.push({
    method: 'POST',
    path: '/messaging/send',
    handler: async (_req, res, _params, _query, body) => {
      const node = server.getEntityNode() as EmployerNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Employer node not configured');
      const b = body as { recipientWalletId?: string; subject?: string; body?: string } | undefined;
      if (!b?.recipientWalletId || !b?.body) {
        return server.sendResponse(res, 400, false, undefined, 'Missing recipientWalletId or body');
      }
      try {
        const result = await node.sendMessage(b.recipientWalletId, b.subject || '', b.body);
        server.sendResponse(res, 200, true, result);
      } catch (err: any) {
        server.sendResponse(res, 502, false, undefined, err.message);
      }
    },
  });

  routes.push({
    method: 'GET',
    path: '/messaging/inbox',
    handler: async (_req, res) => {
      const node = server.getEntityNode() as EmployerNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Employer node not configured');
      try {
        const messages = await node.getInbox();
        server.sendResponse(res, 200, true, messages);
      } catch (err: any) {
        server.sendResponse(res, 502, false, undefined, err.message);
      }
    },
  });

  routes.push({
    method: 'GET',
    path: '/messaging/sent',
    handler: async (_req, res) => {
      const node = server.getEntityNode() as EmployerNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Employer node not configured');
      try {
        const messages = await node.getSent();
        server.sendResponse(res, 200, true, messages);
      } catch (err: any) {
        server.sendResponse(res, 502, false, undefined, err.message);
      }
    },
  });

  routes.push({
    method: 'GET',
    path: '/messaging/thread/:threadIdHash',
    handler: async (_req, res, params) => {
      const node = server.getEntityNode() as EmployerNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Employer node not configured');
      try {
        const messages = await node.getThread(params.threadIdHash);
        server.sendResponse(res, 200, true, messages);
      } catch (err: any) {
        server.sendResponse(res, 502, false, undefined, err.message);
      }
    },
  });

  // ══════════════════════════════════════════════════════════
  //  AVAILABLE PLANS (from sequencer plan store)
  // ══════════════════════════════════════════════════════════

  // Phase 3.3: Expose current attestation status so the dashboard can show a banner.
  // Not admin-gated — this is purely read-only status for the employer's own node.
  routes.push({
    method: 'GET',
    path: '/attestation',
    handler: async (_req, res) => {
      const node = server.getEntityNode() as EmployerNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Employer node not configured');
      const att = node.getAttestation();
      // Where the employer signs: the dashboard links to it, to sign first or to sign new terms
      const marketplaceUrl = node.getMarketplaceUrl();
      if (!att) {
        return server.sendResponse(res, 200, true, { loaded: false, authorizedPlanIds: [], enrollmentCap: null, effectiveDate: null, marketplaceUrl });
      }
      // Whether the terms the employer signed are still what its plans' members are billed (null: could not tell), and
      // the plans it selected that are published now and its attestation does not cover (the insurer's answer; null:
      // could not ask). The node reads the plans from the sequencer, and asks the insurer, at most once per
      // EmployerNode.TERMS_STATUS_TTL_MS for this open route. When any of them calls for it, the employer signs the new
      // terms on the marketplace.
      const [terms, plansToAdd] = await Promise.all([node.attestationTermsStatus(), node.attestationPlansToAdd()]);
      server.sendResponse(res, 200, true, {
        loaded: true,
        authorizedPlanIds: att.authorizedPlanIds || [],
        enrollmentCap: att.enrollmentCap,
        effectiveDate: att.effectiveDate,
        employerId: att.employerId,
        attestationSeq: att.attestationSeq,
        termsChanged: terms.termsChanged,
        signedBeforeFullTerms: terms.signedBeforeFullTerms,
        unavailablePlanIds: terms.unavailablePlanIds,
        plansToAdd,
        marketplaceUrl,
      });
    },
  });

  // Phase 3.3: Force the employer node to refresh its attestation from the sequencer.
  // Eliminates the 60s polling race condition after the marketplace ceremony completes.
  // adminOnly because it triggers an outbound RPC to the sequencer.
  routes.push({
    method: 'POST',
    path: '/attestation/refresh',
    adminOnly: true,
    handler: async (_req, res) => {
      const node = server.getEntityNode() as EmployerNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Employer node not configured');
      const result = await node.refreshAttestationFromSequencer();
      if (result.loaded) {
        server.sendResponse(res, 200, true, { loaded: true, authorizedPlanIds: result.authorizedPlanIds });
      } else {
        server.sendResponse(res, 200, true, { loaded: false, authorizedPlanIds: [], reason: result.reason || 'No attestation found' });
      }
    },
  });

  routes.push({
    method: 'GET',
    path: '/plans/available',
    handler: async (_req, res) => {
      const node = server.getEntityNode() as EmployerNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Employer node not configured');

      try {
        const allPlans = await node.getClient().getPlans();
        // Plan-bound formularies: only plans with published terms are offered to employers, shown at those terms (what
        // members are billed), never a draft the insurer is still editing.
        const { planAsPublished, publishedTermsOf } = await import('../../l2/plan-terms.js');
        const published = (Array.isArray(allPlans) ? allPlans : []).filter((p) => publishedTermsOf(p)).map((p) => planAsPublished(p));
        server.sendResponse(res, 200, true, published);
      } catch (err: any) {
        server.sendResponse(res, 502, false, undefined, 'Failed to fetch plans: ' + err.message);
      }
    },
  });

  // ═════════════════════════════════════════════
  //  CLIENT KEYS — plan item A9, finding A-14
  //
  //  The HR Tool generates an Ed25519 client key at setup and keeps it under its passphrase. This
  //  node accepts that key for its admin routes once it is registered here, which the tenant's
  //  admin token (presented once, at setup) authorises. After that the HR Tool signs every request
  //  and the token is needed only to register again after this node has restarted: keys live in
  //  memory, and a tenant dies with its parent.
  // ═════════════════════════════════════════════

  const CLIENT_ID_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

  routes.push({
    method: 'POST',
    path: '/admin/client-keys',
    adminOnly: true,
    handler: async (_req, res, _params, _query, body) => {
      const b = body as { clientId?: string; publicKeyHex?: string } | undefined;
      if (!b?.clientId || !CLIENT_ID_PATTERN.test(b.clientId)) {
        return server.sendResponse(res, 400, false, undefined, 'clientId is required: 1-64 characters of letters, digits, dot, dash or underscore');
      }
      if (!b.publicKeyHex || !/^[0-9a-f]{64}$/i.test(b.publicKeyHex)) {
        return server.sendResponse(res, 400, false, undefined, 'publicKeyHex is required: 64 hex characters');
      }
      server.registerClientKey(b.clientId, b.publicKeyHex.toLowerCase());
      server.sendResponse(res, 201, true, { clientId: b.clientId, registered: true });
    },
  });

  routes.push({
    method: 'GET',
    path: '/admin/client-keys',
    adminOnly: true,
    handler: async (_req, res) => {
      server.sendResponse(res, 200, true, { clientKeys: server.listClientKeys() });
    },
  });

  routes.push({
    method: 'DELETE',
    path: '/admin/client-keys/:clientId',
    adminOnly: true,
    handler: async (_req, res, params) => {
      const removed = server.revokeClientKey(params.clientId);
      server.sendResponse(res, removed ? 200 : 404, removed, removed ? { clientId: params.clientId, revoked: true } : undefined, removed ? undefined : 'No such client key');
    },
  });

  return routes;
}
