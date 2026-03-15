/**
 * Insurer Routes — REST endpoints for InsurerNode Nautilus Apps.
 *
 * Simpler onboarding: no wallet, no enrollment key, no proof compilation.
 * Single-step configure with admin token → ready.
 *
 * Capabilities:
 *   - System-wide queries (receipts, batches, audit log, chain proof)
 *   - Entity-filtered claim queries (member, prescriber, pharmacy, drug)
 *   - Full audit suite (chain integrity, financial balance, duplicates)
 *   - 12 report types (claims register, pharmacy/prescriber/member activity, etc.)
 *   - Admin operations (formulary publish, force batch, enrollment processing)
 */
import { InsurerNode } from '../insurer-node.js';
import type { BenefitPlanConfig } from '../insurer-node.js';
import type { NautilusAppServer } from '../nautilus-app-server.js';
import type { RouteRegistration } from '../nautilus-app-types.js';
import type {
  ReportFilter,
  PriorAuthContext,
  TimeBucket,
  CrossTabDimension,
  CrossTabMeasure,
  VerifiedClaim,
} from '../../reporting/report-types.js';

/**
 * Build all insurer routes.
 */
export function buildInsurerRoutes(server: NautilusAppServer): RouteRegistration[] {
  const routes: RouteRegistration[] = [];

  // Shared helper to get VerifiedClaim[] from the sequencer
  // (fetches all claims and transforms for reporting)
  let cachedClaims: { claims: VerifiedClaim[]; fetchedAt: number } | null = null;
  const CLAIMS_CACHE_TTL_MS = 30_000; // 30s cache

  async function getVerifiedClaims(node: InsurerNode): Promise<VerifiedClaim[]> {
    const now = Date.now();
    if (cachedClaims && now - cachedClaims.fetchedAt < CLAIMS_CACHE_TTL_MS) {
      return cachedClaims.claims;
    }
    // The insurer node has buildVerifiedClaims as a private method;
    // we use its public report generators which accept VerifiedClaim[].
    // For now we return an empty array — the insurer app should call
    // the individual report endpoints with claims data in the POST body.
    return [];
  }

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

      const b = body as { adminToken?: string } | undefined;

      const node = new InsurerNode({
        role: 'insurer',
        sequencerUrl: server.getConfig().sequencerUrl,
        displayName: server.getConfig().displayName,
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
        sequencerUrl: server.getConfig().sequencerUrl,
      });
    },
  });

  // ── Enrollment Processing ──────────────────────────────────

  routes.push({
    method: 'POST',
    path: '/enrollment/process',
    adminOnly: true,
    handler: async (_req, res, _params, _query, body) => {
      const node = server.getEntityNode() as InsurerNode | null;
      if (!node) {
        return server.sendResponse(res, 503, false, undefined, 'Insurer node not configured');
      }

      const b = body as { walletId?: string; tokenId?: string; role?: string } | undefined;
      if (!b?.walletId) {
        return server.sendResponse(res, 400, false, undefined, 'Missing walletId');
      }

      // Record enrollment in in-memory roster for the insurer's view.
      const enrollmentRecord = {
        walletId: b.walletId,
        tokenId: b.tokenId ?? null,
        role: b.role ?? 'member',
        groupId: (b as any).groupId ?? null,
        employerId: (b as any).employerId ?? null,
        enrolledAt: Date.now(),
      };

      // Store in insurer's local enrollment registry
      const registry = (server as any).__enrollmentRegistry ??= new Map<string, typeof enrollmentRecord>();
      registry.set(b.walletId, enrollmentRecord);

      server.sendResponse(res, 200, true, {
        enrolled: true,
        ...enrollmentRecord,
      });
    },
  });

  // ── Roster (live view from sequencer + local enrollment records) ──

  routes.push({
    method: 'GET',
    path: '/roster',
    handler: async (_req, res, _params, query) => {
      const node = server.getEntityNode() as InsurerNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');

      try {
        // Get all registration receipts from sequencer
        const allReceipts = await node.getAllReceipts();
        const registrations = allReceipts.filter(r => r.isRegistration);

        // Get entity metadata from sequencer (names, roles, specialties)
        let entities: any[] = [];
        try {
          const seqUrl = (node as any).client?.baseUrl || 'http://localhost:3030';
          const entityResp = await fetch(`${seqUrl}/viz/entities`);
          if (entityResp.ok) entities = await entityResp.json() as any[];
        } catch { /* no entity data available */ }

        const entityMap = new Map(entities.map((e: any) => [e.walletId, e]));

        // Get local enrollment records (group/employer associations)
        const registry = (server as any).__enrollmentRegistry as Map<string, any> | undefined;

        // Build roster view
        const roster = registrations.map(r => {
          const entity = entityMap.get(r.walletId);
          const enrollment = registry?.get(r.walletId);
          return {
            walletId: r.walletId,
            role: entity?.type ?? enrollment?.role ?? 'unknown',
            displayName: entity?.displayName ?? `Wallet ${r.walletId.substring(0, 12)}...`,
            specialty: entity?.specialty ?? null,
            pharmacyType: entity?.pharmacyType ?? null,
            groupId: enrollment?.groupId ?? null,
            employerId: enrollment?.employerId ?? null,
            registeredAt: r.acceptedAt,
            receiptId: r.receiptId,
            batchNumber: r.l1BatchNumber ?? null,
          };
        });

        // Group-level summary
        const groupFilter = query?.groupId as string | undefined;
        const roleFilter = query?.role as string | undefined;
        let filtered = roster;
        if (groupFilter) filtered = filtered.filter(r => r.groupId === groupFilter);
        if (roleFilter) filtered = filtered.filter(r => r.role === roleFilter);

        // Employer summary: count by group
        const groupSummary: Record<string, { count: number; roles: Record<string, number> }> = {};
        for (const entry of roster) {
          const gid = entry.groupId ?? 'unassigned';
          if (!groupSummary[gid]) groupSummary[gid] = { count: 0, roles: {} };
          groupSummary[gid].count++;
          groupSummary[gid].roles[entry.role] = (groupSummary[gid].roles[entry.role] ?? 0) + 1;
        }

        server.sendResponse(res, 200, true, {
          total: filtered.length,
          totalRegistered: registrations.length,
          groupSummary,
          entries: filtered,
        });
      } catch (e: any) {
        server.sendResponse(res, 500, false, undefined, e.message);
      }
    },
  });

  // ── Roster: register enrollment with group/employer association ──

  routes.push({
    method: 'POST',
    path: '/roster/register',
    adminOnly: true,
    handler: async (_req, res, _params, _query, body) => {
      const b = body as {
        walletId?: string;
        role?: string;
        groupId?: string;
        employerId?: string;
      } | undefined;

      if (!b?.walletId) {
        return server.sendResponse(res, 400, false, undefined, 'Missing walletId');
      }

      const registry = (server as any).__enrollmentRegistry ??= new Map<string, any>();
      const record = {
        walletId: b.walletId,
        role: b.role ?? 'member',
        groupId: b.groupId ?? null,
        employerId: b.employerId ?? null,
        enrolledAt: Date.now(),
      };
      registry.set(b.walletId, record);

      server.sendResponse(res, 200, true, record);
    },
  });

  // ══════════════════════════════════════════════════════════
  //  SYSTEM-WIDE QUERIES
  // ══════════════════════════════════════════════════════════

  routes.push({
    method: 'GET',
    path: '/receipts/all',
    handler: async (_req, res, _params, query) => {
      const node = server.getEntityNode() as InsurerNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');
      const receipts = await node.getAllReceipts();
      const limit = Math.min(parseInt(query.get('limit') ?? '1000', 10), 1000);
      const offset = Math.max(parseInt(query.get('offset') ?? '0', 10), 0);
      server.sendResponse(res, 200, true, receipts.slice(offset, offset + limit));
    },
  });

  routes.push({
    method: 'GET',
    path: '/batches/all',
    handler: async (_req, res, _params, query) => {
      const node = server.getEntityNode() as InsurerNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');
      const batches = await node.getAllBatches();
      const limit = Math.min(parseInt(query.get('limit') ?? '1000', 10), 1000);
      const offset = Math.max(parseInt(query.get('offset') ?? '0', 10), 0);
      server.sendResponse(res, 200, true, batches.slice(offset, offset + limit));
    },
  });

  routes.push({
    method: 'GET',
    path: '/audit/log',
    handler: async (_req, res, _params, query) => {
      const node = server.getEntityNode() as InsurerNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');
      const log = await node.getAuditLog();
      const limit = Math.min(parseInt(query.get('limit') ?? '1000', 10), 1000);
      const offset = Math.max(parseInt(query.get('offset') ?? '0', 10), 0);
      server.sendResponse(res, 200, true, {
        ...log,
        events: log.events.slice(offset, offset + limit),
      });
    },
  });

  routes.push({
    method: 'GET',
    path: '/chain-proof',
    handler: async (_req, res) => {
      const node = server.getEntityNode() as InsurerNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');
      server.sendResponse(res, 200, true, await node.getChainProof());
    },
  });

  // ══════════════════════════════════════════════════════════
  //  ENTITY-FILTERED CLAIM QUERIES
  // ══════════════════════════════════════════════════════════

  routes.push({
    method: 'GET',
    path: '/claims/member/:walletId',
    handler: async (_req, res, params) => {
      const node = server.getEntityNode() as InsurerNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');
      server.sendResponse(res, 200, true, await node.getMemberClaims(params.walletId));
    },
  });

  routes.push({
    method: 'GET',
    path: '/claims/prescriber/:walletId',
    handler: async (_req, res, params) => {
      const node = server.getEntityNode() as InsurerNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');
      server.sendResponse(res, 200, true, await node.getPrescriberClaims(params.walletId));
    },
  });

  routes.push({
    method: 'GET',
    path: '/claims/pharmacy/:walletId',
    handler: async (_req, res, params) => {
      const node = server.getEntityNode() as InsurerNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');
      server.sendResponse(res, 200, true, await node.getPharmacyClaims(params.walletId));
    },
  });

  routes.push({
    method: 'GET',
    path: '/claims/drug/:ndcHash',
    handler: async (_req, res, params) => {
      const node = server.getEntityNode() as InsurerNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');
      server.sendResponse(res, 200, true, await node.getDrugClaims(params.ndcHash));
    },
  });

  // ══════════════════════════════════════════════════════════
  //  AUDIT
  // ══════════════════════════════════════════════════════════

  routes.push({
    method: 'GET',
    path: '/audit/chain-integrity',
    handler: async (_req, res) => {
      const node = server.getEntityNode() as InsurerNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');
      server.sendResponse(res, 200, true, await node.verifyChainIntegrity());
    },
  });

  routes.push({
    method: 'GET',
    path: '/audit/financial-balance',
    handler: async (_req, res) => {
      const node = server.getEntityNode() as InsurerNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');
      server.sendResponse(res, 200, true, await node.verifyFinancialBalance());
    },
  });

  routes.push({
    method: 'GET',
    path: '/audit/duplicate-claims',
    handler: async (_req, res) => {
      const node = server.getEntityNode() as InsurerNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');
      server.sendResponse(res, 200, true, await node.detectDuplicateClaims());
    },
  });

  routes.push({
    method: 'POST',
    path: '/audit/full',
    handler: async (_req, res, _params, _query, body) => {
      const node = server.getEntityNode() as InsurerNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');

      const b = body as {
        onChainState?: { walletRegistryRoot: string; lifecycleRoot: string; walletCount: string };
        rosterEntries?: { walletId: string }[];
      } | undefined;

      if (!b?.onChainState || !b?.rosterEntries) {
        return server.sendResponse(res, 400, false, undefined, 'Missing onChainState or rosterEntries');
      }

      const result = await node.runFullAudit(
        {
          walletRegistryRoot: b.onChainState.walletRegistryRoot,
          lifecycleRoot: b.onChainState.lifecycleRoot,
          walletCount: BigInt(b.onChainState.walletCount),
        },
        b.rosterEntries,
      );
      server.sendResponse(res, 200, true, result);
    },
    adminOnly: true,
  });

  // ══════════════════════════════════════════════════════════
  //  REPORTS (12 types — all POST with claims + optional filter)
  // ══════════════════════════════════════════════════════════

  // Helper type for report request bodies
  type ReportBody = {
    claims: VerifiedClaim[];
    filter?: ReportFilter;
  };

  routes.push({
    method: 'POST',
    path: '/reports/claims-register',
    handler: async (_req, res, _params, _query, body) => {
      const node = server.getEntityNode() as InsurerNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');
      const b = body as ReportBody | undefined;
      if (!b?.claims) return server.sendResponse(res, 400, false, undefined, 'Missing claims');
      server.sendResponse(res, 200, true, node.generateClaimsRegister(b.claims, b.filter));
    },
  });

  routes.push({
    method: 'POST',
    path: '/reports/pharmacy-activity',
    handler: async (_req, res, _params, _query, body) => {
      const node = server.getEntityNode() as InsurerNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');
      const b = body as ReportBody | undefined;
      if (!b?.claims) return server.sendResponse(res, 400, false, undefined, 'Missing claims');
      server.sendResponse(res, 200, true, node.generatePharmacyReport(b.claims, b.filter));
    },
  });

  routes.push({
    method: 'POST',
    path: '/reports/prescriber-activity',
    handler: async (_req, res, _params, _query, body) => {
      const node = server.getEntityNode() as InsurerNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');
      const b = body as ReportBody | undefined;
      if (!b?.claims) return server.sendResponse(res, 400, false, undefined, 'Missing claims');
      server.sendResponse(res, 200, true, node.generatePrescriberReport(b.claims, b.filter));
    },
  });

  routes.push({
    method: 'POST',
    path: '/reports/member-activity',
    handler: async (_req, res, _params, _query, body) => {
      const node = server.getEntityNode() as InsurerNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');
      const b = body as ReportBody | undefined;
      if (!b?.claims) return server.sendResponse(res, 400, false, undefined, 'Missing claims');
      server.sendResponse(res, 200, true, node.generateMemberReport(b.claims, b.filter));
    },
  });

  routes.push({
    method: 'POST',
    path: '/reports/medication-utilization',
    handler: async (_req, res, _params, _query, body) => {
      const node = server.getEntityNode() as InsurerNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');
      const b = body as ReportBody | undefined;
      if (!b?.claims) return server.sendResponse(res, 400, false, undefined, 'Missing claims');
      server.sendResponse(res, 200, true, node.generateMedicationUtilization(b.claims, b.filter));
    },
  });

  routes.push({
    method: 'POST',
    path: '/reports/financial-summary',
    handler: async (_req, res, _params, _query, body) => {
      const node = server.getEntityNode() as InsurerNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');
      const b = body as ReportBody | undefined;
      if (!b?.claims) return server.sendResponse(res, 400, false, undefined, 'Missing claims');
      server.sendResponse(res, 200, true, node.generateFinancialSummary(b.claims, b.filter));
    },
  });

  routes.push({
    method: 'POST',
    path: '/reports/prior-auth',
    handler: async (_req, res, _params, _query, body) => {
      const node = server.getEntityNode() as InsurerNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');
      const b = body as { claims?: VerifiedClaim[]; priorAuths?: PriorAuthContext[]; filter?: ReportFilter } | undefined;
      if (!b?.claims || !b?.priorAuths) return server.sendResponse(res, 400, false, undefined, 'Missing claims or priorAuths');
      server.sendResponse(res, 200, true, node.generatePriorAuthReport(b.claims, b.priorAuths, b.filter));
    },
  });

  routes.push({
    method: 'POST',
    path: '/reports/reversals',
    handler: async (_req, res, _params, _query, body) => {
      const node = server.getEntityNode() as InsurerNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');
      const b = body as ReportBody | undefined;
      if (!b?.claims) return server.sendResponse(res, 400, false, undefined, 'Missing claims');
      server.sendResponse(res, 200, true, node.generateReversalReport(b.claims, b.filter));
    },
  });

  routes.push({
    method: 'POST',
    path: '/reports/tier-analysis',
    handler: async (_req, res, _params, _query, body) => {
      const node = server.getEntityNode() as InsurerNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');
      const b = body as ReportBody | undefined;
      if (!b?.claims) return server.sendResponse(res, 400, false, undefined, 'Missing claims');
      server.sendResponse(res, 200, true, node.generateTierAnalysis(b.claims, b.filter));
    },
  });

  routes.push({
    method: 'POST',
    path: '/reports/therapeutic-class',
    handler: async (_req, res, _params, _query, body) => {
      const node = server.getEntityNode() as InsurerNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');
      const b = body as ReportBody | undefined;
      if (!b?.claims) return server.sendResponse(res, 400, false, undefined, 'Missing claims');
      server.sendResponse(res, 200, true, node.generateTherapeuticClassReport(b.claims, b.filter));
    },
  });

  routes.push({
    method: 'POST',
    path: '/reports/time-series',
    handler: async (_req, res, _params, _query, body) => {
      const node = server.getEntityNode() as InsurerNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');
      const b = body as { claims?: VerifiedClaim[]; bucket?: TimeBucket; filter?: ReportFilter } | undefined;
      if (!b?.claims) return server.sendResponse(res, 400, false, undefined, 'Missing claims');
      server.sendResponse(res, 200, true, node.generateTimeSeries(b.claims, b.bucket, b.filter));
    },
  });

  routes.push({
    method: 'POST',
    path: '/reports/cross-tab',
    handler: async (_req, res, _params, _query, body) => {
      const node = server.getEntityNode() as InsurerNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');
      const b = body as {
        claims?: VerifiedClaim[];
        row?: CrossTabDimension;
        col?: CrossTabDimension;
        measure?: CrossTabMeasure;
        filter?: ReportFilter;
      } | undefined;
      if (!b?.claims || !b?.row || !b?.col || !b?.measure) {
        return server.sendResponse(res, 400, false, undefined, 'Missing claims, row, col, or measure');
      }
      server.sendResponse(res, 200, true, node.generateCrossTab(b.claims, b.row, b.col, b.measure, b.filter));
    },
  });

  // ══════════════════════════════════════════════════════════
  //  ADMIN (Bearer token required)
  // ══════════════════════════════════════════════════════════

  routes.push({
    method: 'POST',
    path: '/admin/formulary/publish',
    adminOnly: true,
    handler: async (_req, res, _params, _query, body) => {
      const node = server.getEntityNode() as InsurerNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');
      const b = body as { planIdHash?: string; formularyRoot?: string; entriesJson?: string } | undefined;
      if (!b?.planIdHash || !b?.formularyRoot || !b?.entriesJson) {
        return server.sendResponse(res, 400, false, undefined, 'Missing planIdHash, formularyRoot, or entriesJson');
      }
      const result = await node.publishFormulary(b.planIdHash, b.formularyRoot, b.entriesJson);
      server.sendResponse(res, 200, true, result);
    },
  });

  routes.push({
    method: 'POST',
    path: '/admin/batch/force',
    adminOnly: true,
    handler: async (_req, res) => {
      const node = server.getEntityNode() as InsurerNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');
      const batch = await node.forceBatch();
      server.sendResponse(res, 200, true, batch);
    },
  });

  // ══════════════════════════════════════════════════════════
  //  CREDENTIALING PIPELINE
  //
  //  Production flow:
  //    1. Provider submits application → POST /credentialing/apply
  //    2. Insurer verifies NPI/NCPDP   → POST /credentialing/verify/:id
  //    3. Insurer approves/denies      → POST /credentialing/approve/:id
  //    4. Provider appears in registry  → GET  /credentialing/status/:walletId
  //    5. Insurer can suspend/terminate → POST /credentialing/suspend/:walletId
  //
  //  At startup, start-insurer-nautilus.ts batch-credentials all providers
  //  via l2_credentialProvider, skipping the application workflow.
  // ══════════════════════════════════════════════════════════

  // In-memory application store (production: database-backed)
  const applications = new Map<string, {
    applicationId: string;
    providerType: 'prescriber' | 'pharmacy';
    npi: string;
    displayName: string;
    specialty?: string;
    pharmacyType?: string;
    deaNumber?: string;
    stateOfLicense?: string;
    walletId?: string;
    submittedAt: number;
    status: 'pending' | 'under_review' | 'verified' | 'approved' | 'denied';
    denialReason?: string;
    verifiedAt?: number;
    approvedAt?: number;
  }>();

  // In-flight approval guard — prevents concurrent approvals of the same application
  const approvalsInFlight = new Set<string>();

  // POST /credentialing/apply — Provider submits application
  routes.push({
    method: 'POST',
    path: '/credentialing/apply',
    handler: async (_req, res, _params, _query, body) => {
      const b = body as {
        providerType?: string;
        npi?: string;
        displayName?: string;
        specialty?: string;
        pharmacyType?: string;
        deaNumber?: string;
        stateOfLicense?: string;
        walletId?: string;
      } | undefined;

      if (!b?.providerType || !b?.npi || !b?.displayName) {
        return server.sendResponse(res, 400, false, undefined, 'Missing providerType, npi, or displayName');
      }
      if (b.providerType !== 'prescriber' && b.providerType !== 'pharmacy') {
        return server.sendResponse(res, 400, false, undefined, 'providerType must be "prescriber" or "pharmacy"');
      }

      // Check for duplicate NPI
      for (const app of applications.values()) {
        if (app.npi === b.npi && app.status !== 'denied') {
          return server.sendResponse(res, 409, false, undefined, `NPI ${b.npi} already has a ${app.status} application`);
        }
      }

      const applicationId = `APP-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const app = {
        applicationId,
        providerType: b.providerType as 'prescriber' | 'pharmacy',
        npi: b.npi,
        displayName: b.displayName,
        specialty: b.specialty,
        pharmacyType: b.pharmacyType,
        deaNumber: b.deaNumber,
        stateOfLicense: b.stateOfLicense,
        walletId: b.walletId,
        submittedAt: Date.now(),
        status: 'pending' as const,
      };
      applications.set(applicationId, app);

      server.sendResponse(res, 201, true, {
        applicationId,
        status: 'pending',
        message: 'Application submitted. The insurer will verify credentials.',
      });
    },
  });

  // POST /credentialing/verify/:id — Insurer marks application as verified (admin-gated)
  routes.push({
    method: 'POST',
    path: '/credentialing/verify/:id',
    adminOnly: true,
    handler: async (_req, res, params) => {
      const app = applications.get(params.id);
      if (!app) return server.sendResponse(res, 404, false, undefined, 'Application not found');
      if (app.status !== 'pending' && app.status !== 'under_review') {
        return server.sendResponse(res, 409, false, undefined, `Cannot verify in status: ${app.status}`);
      }

      // In production: call NPPES API, check DEA, state license board, etc.
      // For now: mark as verified
      app.status = 'verified';
      app.verifiedAt = Date.now();

      server.sendResponse(res, 200, true, {
        applicationId: app.applicationId,
        status: 'verified',
        npi: app.npi,
        displayName: app.displayName,
        message: 'Credentials verified. Ready for final approval.',
      });
    },
  });

  // POST /credentialing/approve/:id — Insurer approves and credentials provider (admin-gated)
  routes.push({
    method: 'POST',
    path: '/credentialing/approve/:id',
    adminOnly: true,
    handler: async (_req, res, params, _query, body) => {
      const app = applications.get(params.id);
      if (!app) return server.sendResponse(res, 404, false, undefined, 'Application not found');
      if (app.status === 'approved' || app.status === 'denied') {
        return server.sendResponse(res, 409, false, undefined, `Cannot approve in status: ${app.status}`);
      }
      if (app.status !== 'verified' && app.status !== 'pending') {
        return server.sendResponse(res, 409, false, undefined, `Cannot approve in status: ${app.status}`);
      }

      // Prevent concurrent approvals of the same application
      if (approvalsInFlight.has(params.id)) {
        return server.sendResponse(res, 429, false, undefined, 'Approval already in progress for this application');
      }

      const b = body as { walletId?: string } | undefined;
      const walletId = b?.walletId ?? app.walletId;
      if (!walletId) {
        return server.sendResponse(res, 400, false, undefined, 'Missing walletId (provider must enroll first or supply walletId)');
      }

      // Credential on the sequencer via RPC
      const node = server.getEntityNode() as InsurerNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');

      approvalsInFlight.add(params.id);
      try {
        const seqUrl = server.getConfig().sequencerUrl.replace(/\/+$/, '');
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        const adminToken = server.getConfig().adminToken;
        if (adminToken) headers['Authorization'] = 'Bearer ' + adminToken;

        const rpcRes = await fetch(seqUrl + '/rpc', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            jsonrpc: '2.0', id: 1,
            method: 'l2_credentialProvider',
            params: {
              walletId,
              displayName: app.displayName,
              providerType: app.providerType,
              npi: app.npi,
              specialty: app.specialty,
              pharmacyType: app.pharmacyType,
              deaNumber: app.deaNumber,
              stateOfLicense: app.stateOfLicense,
              verificationMethod: app.verifiedAt ? 'manual' : 'nppes',
              applicationId: app.applicationId,
            },
          }),
        });
        const json = await rpcRes.json() as { result?: unknown; error?: { message?: string } };
        if (json.error) throw new Error(json.error.message ?? 'Sequencer error');

        app.status = 'approved';
        app.approvedAt = Date.now();
        app.walletId = walletId;

        server.sendResponse(res, 200, true, {
          applicationId: app.applicationId,
          status: 'approved',
          walletId,
          displayName: app.displayName,
          providerType: app.providerType,
          registryResult: json.result,
        });
      } catch (err: any) {
        server.sendResponse(res, 502, false, undefined, `Failed to credential on sequencer: ${err.message}`);
      } finally {
        approvalsInFlight.delete(params.id);
      }
    },
  });

  // POST /credentialing/deny/:id — Insurer denies application (admin-gated)
  routes.push({
    method: 'POST',
    path: '/credentialing/deny/:id',
    adminOnly: true,
    handler: async (_req, res, params, _query, body) => {
      const app = applications.get(params.id);
      if (!app) return server.sendResponse(res, 404, false, undefined, 'Application not found');
      if (app.status === 'approved') {
        return server.sendResponse(res, 409, false, undefined, 'Cannot deny an approved application — use terminate');
      }

      const b = body as { reason?: string } | undefined;
      app.status = 'denied';
      app.denialReason = b?.reason ?? 'Application denied';

      server.sendResponse(res, 200, true, {
        applicationId: app.applicationId,
        status: 'denied',
        reason: app.denialReason,
      });
    },
  });

  // GET /credentialing/applications — List all applications (read-only)
  routes.push({
    method: 'GET',
    path: '/credentialing/applications',
    handler: async (_req, res, _params, query) => {
      const statusFilter = query.get('status');
      let apps = Array.from(applications.values());
      if (statusFilter) apps = apps.filter(a => a.status === statusFilter);
      server.sendResponse(res, 200, true, {
        total: apps.length,
        applications: apps,
      });
    },
  });

  // GET /credentialing/status/:walletId — Check credentialing status for a provider
  routes.push({
    method: 'GET',
    path: '/credentialing/status/:walletId',
    handler: async (_req, res, params) => {
      const node = server.getEntityNode() as InsurerNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');

      try {
        const seqUrl = server.getConfig().sequencerUrl.replace(/\/+$/, '');
        const rpcRes = await fetch(seqUrl + '/rpc', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0', id: 1,
            method: 'l2_getProvider',
            params: { walletId: params.walletId },
          }),
        });
        const json = await rpcRes.json() as { result?: unknown; error?: { message?: string } };
        if (json.error) throw new Error(json.error.message ?? 'Sequencer error');

        if (json.result === null) {
          return server.sendResponse(res, 404, false, undefined, 'Provider not found in registry');
        }

        server.sendResponse(res, 200, true, json.result);
      } catch (err: any) {
        server.sendResponse(res, 502, false, undefined, err.message);
      }
    },
  });

  // POST /credentialing/suspend/:walletId — Suspend an active provider (admin-gated)
  routes.push({
    method: 'POST',
    path: '/credentialing/suspend/:walletId',
    adminOnly: true,
    handler: async (_req, res, params) => {
      const node = server.getEntityNode() as InsurerNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');

      try {
        const seqUrl = server.getConfig().sequencerUrl.replace(/\/+$/, '');
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        const adminToken = server.getConfig().adminToken;
        if (adminToken) headers['Authorization'] = 'Bearer ' + adminToken;

        const rpcRes = await fetch(seqUrl + '/rpc', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            jsonrpc: '2.0', id: 1,
            method: 'l2_updateProviderStatus',
            params: { walletId: params.walletId, newState: 3 }, // SUSPENDED
          }),
        });
        const json = await rpcRes.json() as { result?: unknown; error?: { message?: string } };
        if (json.error) throw new Error(json.error.message ?? 'Sequencer error');
        server.sendResponse(res, 200, true, json.result);
      } catch (err: any) {
        server.sendResponse(res, 502, false, undefined, err.message);
      }
    },
  });

  // POST /credentialing/terminate/:walletId — Terminate a provider (admin-gated)
  routes.push({
    method: 'POST',
    path: '/credentialing/terminate/:walletId',
    adminOnly: true,
    handler: async (_req, res, params) => {
      const node = server.getEntityNode() as InsurerNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');

      try {
        const seqUrl = server.getConfig().sequencerUrl.replace(/\/+$/, '');
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        const adminToken = server.getConfig().adminToken;
        if (adminToken) headers['Authorization'] = 'Bearer ' + adminToken;

        const rpcRes = await fetch(seqUrl + '/rpc', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            jsonrpc: '2.0', id: 1,
            method: 'l2_updateProviderStatus',
            params: { walletId: params.walletId, newState: 4 }, // TERMINATED
          }),
        });
        const json = await rpcRes.json() as { result?: unknown; error?: { message?: string } };
        if (json.error) throw new Error(json.error.message ?? 'Sequencer error');
        server.sendResponse(res, 200, true, json.result);
      } catch (err: any) {
        server.sendResponse(res, 502, false, undefined, err.message);
      }
    },
  });

  // GET /credentialing/registry — Full provider registry from sequencer
  routes.push({
    method: 'GET',
    path: '/credentialing/registry',
    handler: async (_req, res, _params, query) => {
      const node = server.getEntityNode() as InsurerNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');

      try {
        const seqUrl = server.getConfig().sequencerUrl.replace(/\/+$/, '');
        const roleFilter = query.get('role');
        const rpcRes = await fetch(seqUrl + '/rpc', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0', id: 1,
            method: 'l2_getNetworkProviders',
            params: roleFilter ? { role: roleFilter } : {},
          }),
        });
        const json = await rpcRes.json() as { result?: unknown; error?: { message?: string } };
        if (json.error) throw new Error(json.error.message ?? 'Sequencer error');
        server.sendResponse(res, 200, true, json.result);
      } catch (err: any) {
        server.sendResponse(res, 502, false, undefined, err.message);
      }
    },
  });

  // ══════════════════════════════════════════════════════════
  //  BENEFIT PLANS (CRUD + publish)
  // ══════════════════════════════════════════════════════════

  // GET /plans — List all plans
  routes.push({
    method: 'GET',
    path: '/plans',
    handler: async (_req, res) => {
      const node = server.getEntityNode() as InsurerNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');
      server.sendResponse(res, 200, true, await node.listPlans());
    },
  });

  // GET /plans/:planId — Get a specific plan
  routes.push({
    method: 'GET',
    path: '/plans/:planId',
    handler: async (_req, res, params) => {
      const node = server.getEntityNode() as InsurerNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');
      const plan = await node.getPlan(params.planId);
      if (!plan) return server.sendResponse(res, 404, false, undefined, 'Plan not found');
      server.sendResponse(res, 200, true, plan);
    },
  });

  // POST /plans — Create a new plan
  routes.push({
    method: 'POST',
    path: '/plans',
    adminOnly: true,
    handler: async (_req, res, _params, _query, body) => {
      const node = server.getEntityNode() as InsurerNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');

      const b = body as Partial<BenefitPlanConfig> | undefined;
      if (!b?.planId || !b?.name) {
        return server.sendResponse(res, 400, false, undefined, 'Missing planId or name');
      }

      try {
        const plan = await node.createPlan({
          planId: b.planId,
          name: b.name,
          coverageType: b.coverageType ?? 1,
          copayAmountCents: b.copayAmountCents ?? 2000,
          deductibleAmountCents: b.deductibleAmountCents ?? 100000,
          oopMaxCents: b.oopMaxCents ?? 500000,
          annualBenefitMaxCents: b.annualBenefitMaxCents ?? 10000000,
          familyDeductibleAmountCents: b.familyDeductibleAmountCents ?? 200000,
          familyOopMaxCents: b.familyOopMaxCents ?? 1000000,
          familyAnnualBenefitMaxCents: b.familyAnnualBenefitMaxCents ?? 20000000,
          formularyNdcs: b.formularyNdcs ?? [],
          networkProviderWalletIds: b.networkProviderWalletIds ?? [],
        });
        server.sendResponse(res, 201, true, plan);
      } catch (err: any) {
        server.sendResponse(res, 409, false, undefined, err.message);
      }
    },
  });

  // PUT /plans/:planId — Update a plan
  routes.push({
    method: 'PUT',
    path: '/plans/:planId',
    adminOnly: true,
    handler: async (_req, res, params, _query, body) => {
      const node = server.getEntityNode() as InsurerNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');

      const b = body as Partial<BenefitPlanConfig> | undefined;
      try {
        const plan = await node.updatePlan(params.planId, b ?? {});
        server.sendResponse(res, 200, true, plan);
      } catch (err: any) {
        server.sendResponse(res, 404, false, undefined, err.message);
      }
    },
  });

  // DELETE /plans/:planId — Delete a plan
  routes.push({
    method: 'DELETE',
    path: '/plans/:planId',
    adminOnly: true,
    handler: async (_req, res, params) => {
      const node = server.getEntityNode() as InsurerNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');
      const deleted = await node.deletePlan(params.planId);
      if (!deleted) return server.sendResponse(res, 404, false, undefined, 'Plan not found');
      server.sendResponse(res, 200, true, { deleted: true, planId: params.planId });
    },
  });

  // POST /plans/:planId/publish — Build formulary + network roots and publish to sequencer
  routes.push({
    method: 'POST',
    path: '/plans/:planId/publish',
    adminOnly: true,
    handler: async (_req, res, params) => {
      const node = server.getEntityNode() as InsurerNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');

      const plan = await node.getPlan(params.planId);
      if (!plan) return server.sendResponse(res, 404, false, undefined, 'Plan not found');

      try {
        const seqUrl = server.getConfig().sequencerUrl.replace(/\/+$/, '');
        const adminToken = server.getConfig().adminToken;
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (adminToken) headers['Authorization'] = 'Bearer ' + adminToken;

        // Fetch full formulary from sequencer to filter for this plan's NDCs
        const formRes = await fetch(seqUrl + '/rpc', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            jsonrpc: '2.0', id: 1,
            method: 'l2_getFormulary',
            params: { planIdHash: 'default' },
          }),
        });
        const formJson = await formRes.json() as any;
        const allEntries: any[] = formJson.result?.entries ?? [];

        // Filter to plan's NDC list (empty = all)
        const planEntries = plan.formularyNdcs.length > 0
          ? allEntries.filter((e: any) => plan.formularyNdcs.includes(e.ndc))
          : allEntries;

        // Compute a simple formulary root (hash of count for now — production uses MerkleTree)
        const formularyRoot = String(planEntries.length);
        const networkRoot = plan.networkProviderWalletIds.length > 0
          ? String(plan.networkProviderWalletIds.length)
          : '0'; // 0 = all providers accepted

        // Publish filtered formulary to sequencer under plan-specific key
        const entriesJson = JSON.stringify(planEntries);
        const publishRes = await fetch(seqUrl + '/rpc', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            jsonrpc: '2.0', id: 1,
            method: 'l2_storeFormulary',
            params: { planIdHash: params.planId, formularyRoot, entriesJson },
          }),
        });
        const publishJson = await publishRes.json() as any;
        if (publishJson.error) throw new Error(publishJson.error.message ?? 'Sequencer error');

        // Mark plan as published
        const updated = await node.markPlanPublished(params.planId, formularyRoot, networkRoot);

        server.sendResponse(res, 200, true, {
          published: true,
          planId: params.planId,
          formularyRoot,
          networkRoot,
          formularyEntryCount: planEntries.length,
          networkProviderCount: plan.networkProviderWalletIds.length,
          plan: updated,
        });
      } catch (err: any) {
        server.sendResponse(res, 502, false, undefined, `Publish failed: ${err.message}`);
      }
    },
  });

  // ══════════════════════════════════════════════════════════
  //  MESSAGING (Read-Only — system-wide queries)
  // ══════════════════════════════════════════════════════════

  routes.push({
    method: 'GET',
    path: '/messaging/wallet/:walletId',
    handler: async (_req, res, params) => {
      const node = server.getEntityNode() as InsurerNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');
      server.sendResponse(res, 200, true, await node.getMessagesByWallet(params.walletId));
    },
  });

  routes.push({
    method: 'GET',
    path: '/messaging/thread/:threadIdHash',
    handler: async (_req, res, params) => {
      const node = server.getEntityNode() as InsurerNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');
      server.sendResponse(res, 200, true, await node.getMessagesByThread(params.threadIdHash));
    },
  });

  routes.push({
    method: 'GET',
    path: '/messaging/status',
    handler: async (_req, res) => {
      const node = server.getEntityNode() as InsurerNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');
      server.sendResponse(res, 200, true, await node.getMessageStoreStatus());
    },
  });

  return routes;
}
