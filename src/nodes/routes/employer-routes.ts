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

/**
 * Build all employer routes.
 */
export function buildEmployerRoutes(server: NautilusAppServer): RouteRegistration[] {
  const routes: RouteRegistration[] = [];

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

      const b = body as { employerId?: string; insurerUrl?: string } | undefined;
      if (!b?.employerId) {
        return server.sendResponse(res, 400, false, undefined, 'Missing employerId');
      }

      const node = new EmployerNode({
        role: 'employer',
        sequencerUrl: server.getConfig().sequencerUrl,
        displayName: server.getConfig().displayName,
        employerId: b.employerId,
        insurerUrl: b.insurerUrl,
        clientOptions: server.getConfig().adminToken ? { adminToken: server.getConfig().adminToken } : undefined,
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
    handler: async (_req, res) => {
      const node = server.getEntityNode() as EmployerNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Employer node not configured');
      server.sendResponse(res, 200, true, node.listGroups());
    },
  });

  routes.push({
    method: 'GET',
    path: '/groups/:groupId',
    handler: async (_req, res, params) => {
      const node = server.getEntityNode() as EmployerNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Employer node not configured');
      const group = node.getGroup(params.groupId);
      if (!group) return server.sendResponse(res, 404, false, undefined, 'Group not found');
      server.sendResponse(res, 200, true, group);
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
        employeeId?: string;
        familyId?: string;
        validUntil?: string;
        tokenId?: string;
      } | undefined;
      if (!b?.groupId || !b?.employeeId || !b?.validUntil) {
        return server.sendResponse(res, 400, false, undefined, 'Missing groupId, employeeId, or validUntil');
      }
      const familyId = b.familyId || b.employeeId;
      // Accept ISO date (2026-12-31) or CCYYMMDD (20261231)
      let validUntil = b.validUntil!;
      if (validUntil.includes('-')) {
        validUntil = validUntil.replace(/-/g, '');
      }

      try {
        const result = node.generateToken(b.groupId, b.employeeId, familyId, validUntil, b.tokenId);
        server.sendResponse(res, 201, true, {
          tokenId: result.tokenId,
          tokenIdHash: result.token.tokenIdHash.toString(),
          groupId: b.groupId,
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
        groupId: record.localData.groupId,
        planId: record.localData.planId,
        validUntil: record.localData.validUntil.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3'),
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

  routes.push({
    method: 'POST',
    path: '/tokens/:tokenId/validate',
    handler: async (_req, res, params, _query, body) => {
      const node = server.getEntityNode() as EmployerNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Employer node not configured');
      const b = body as { currentDate?: string } | undefined;
      const date = b?.currentDate ?? new Date().toISOString().replace(/\D/g, '').slice(0, 8);
      server.sendResponse(res, 200, true, node.validateToken(params.tokenId, date));
    },
  });

  routes.push({
    method: 'POST',
    path: '/tokens/:tokenId/submit',
    adminOnly: true,
    handler: async (_req, res, params, _query, body) => {
      const node = server.getEntityNode() as EmployerNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Employer node not configured');

      const b = body as { walletId?: string } | undefined;
      if (!b?.walletId) {
        return server.sendResponse(res, 400, false, undefined, 'Missing walletId');
      }

      const result = await node.submitTokenToInsurer(params.tokenId, b.walletId);
      if (result.success) {
        server.sendResponse(res, 200, true, { submitted: true, tokenId: params.tokenId });
      } else {
        server.sendResponse(res, 502, false, undefined, result.error ?? 'Submission failed');
      }
    },
  });

  // ══════════════════════════════════════════════════════════
  //  ENROLLMENT CONFIRMATION (called by member node after enrollment)
  // ══════════════════════════════════════════════════════════

  routes.push({
    method: 'POST',
    path: '/enrollment/confirm',
    handler: async (_req, res, _params, _query, body) => {
      const node = server.getEntityNode() as EmployerNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Employer node not configured');

      const b = body as { tokenId?: string; walletId?: string } | undefined;
      if (!b?.tokenId || !b?.walletId) {
        return server.sendResponse(res, 400, false, undefined, 'Missing tokenId or walletId');
      }

      const result = node.confirmEnrollment(b.tokenId, b.walletId);
      if (!result.found) {
        return server.sendResponse(res, 404, false, undefined, 'Token not found in roster');
      }

      server.sendResponse(res, 200, true, { confirmed: true, tokenId: b.tokenId });
    },
  });

  // ══════════════════════════════════════════════════════════
  //  ROSTER
  // ══════════════════════════════════════════════════════════

  routes.push({
    method: 'GET',
    path: '/roster',
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

  routes.push({
    method: 'GET',
    path: '/plans/available',
    handler: async (_req, res) => {
      const node = server.getEntityNode() as EmployerNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Employer node not configured');

      try {
        const allPlans = await node.getClient().getPlans();
        // Only return published plans to employers
        const published = allPlans.filter((p: any) => p.published);
        server.sendResponse(res, 200, true, published);
      } catch (err: any) {
        server.sendResponse(res, 502, false, undefined, 'Failed to fetch plans: ' + err.message);
      }
    },
  });

  return routes;
}
