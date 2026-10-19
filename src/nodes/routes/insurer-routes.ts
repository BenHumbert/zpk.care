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
import type { KeyObject } from 'crypto';
import { signRequest } from '../../security/signed-request.js';
import { timingSafeEqual } from 'crypto';
import { hashString } from '../../zkp/hash-utils.js';
import type { IncomingMessage, ServerResponse } from 'http';
import { join } from 'path';
import { PersistedAttemptLimiter } from '../../security/attempt-limiter.js';
import { SlidingWindowLimiter } from '../../security/rate-limit.js';
import type { RecoveryDeposit } from '../../security/recovery-card.js';
import { deriveInsurerKeypair } from '../../onboarding/employer-attestation.js';
import {
  canonicalizeEnrollmentCode,
  enrollmentCodeRoutingPrefix,
  routingPrefixOf,
} from '../../onboarding/enrollment-code.js';
import type {
  ReportFilter,
  PriorAuthContext,
  TimeBucket,
  CrossTabDimension,
  CrossTabMeasure,
  VerifiedClaim,
} from '../../reporting/report-types.js';

// ─── A6: enrollment-code redemption ─────────────────────────────────────────────────────────
// Kept out of the handler so /enrollment/process reads as the sequence it is. The Step 1 comment
// in that handler says what changed and why.

/** What the insurer remembers about a code it has redeemed, keyed by the canonical code. */
interface RedeemedCode {
  /** The wallet bound at /enrollment/complete; null between redemption and completion (C2). */
  walletId: string | null;
  /** The PIN hash the code was redeemed with, so a repeat from the same device is answered and a code-only holder is not. */
  pinHash: string | null;
  employerId: string | null;
  groupIdHash: string | null;
  planIdHash: string | null;
  /** The employer's opaque family hash from the code (A-34); absent on records written before it. */
  familyIdHash?: string | null;
  at: number;
  completedAt?: number;
}

/** A recovery deposit as filed — plan item A12b. The share is useless without the card; the verifier is a slow hash of the PIN under the card id. */
interface StoredDeposit extends RecoveryDeposit {
  walletId: string;
  filedAt: number;
  failures: number;
  releaseCount: number;
  releasedAt?: number;
  revokedAt?: number;
  revokedReason?: string;
}

function redeemedCodes(server: NautilusAppServer): Map<string, RedeemedCode> {
  const s = server as unknown as { __redeemedEnrollmentCodes?: Map<string, RedeemedCode> };
  return (s.__redeemedEnrollmentCodes ??= new Map<string, RedeemedCode>());
}

function restoreRedeemedCodes(server: NautilusAppServer, data: Record<string, unknown>): void {
  const persisted = data.redeemedEnrollmentCodes;
  if (!persisted || typeof persisted !== 'object') return;
  const map = redeemedCodes(server);
  for (const [code, rec] of Object.entries(persisted as Record<string, RedeemedCode>)) map.set(code, rec);
  if (map.size > 0) console.log('[insurer] Restored %d redeemed enrollment codes from local state', map.size);
}

/** Written before the handler does anything else with a redeemed code, so a crash cannot lose it. */
async function persistRedeemedCodes(server: NautilusAppServer): Promise<void> {
  try {
    const localState = server.getLocalState();
    const stateData = localState.getState() as any;
    if (!stateData) return;
    stateData.redeemedEnrollmentCodes = Object.fromEntries(redeemedCodes(server));
    await localState.save(stateData);
  } catch (err: unknown) {
    console.warn('[enrollment] Failed to persist redeemed codes:', err instanceof Error ? err.message : String(err));
  }
}

function recoveryDeposits(server: NautilusAppServer): Map<string, StoredDeposit> {
  const s = server as unknown as { __recoveryDeposits?: Map<string, StoredDeposit> };
  return (s.__recoveryDeposits ??= new Map<string, StoredDeposit>());
}
function restoreRecoveryDeposits(server: NautilusAppServer, data: Record<string, unknown>): void {
  const persisted = data.recoveryDeposits;
  if (!persisted || typeof persisted !== 'object') return;
  const map = recoveryDeposits(server);
  for (const [cardId, rec] of Object.entries(persisted as Record<string, StoredDeposit>)) map.set(cardId, rec);
  if (map.size > 0) console.log('[insurer] Restored %d recovery deposits from local state', map.size);
}
async function persistRecoveryDeposits(server: NautilusAppServer): Promise<void> {
  try {
    const localState = server.getLocalState();
    const stateData = localState.getState() as any;
    if (!stateData) return;
    stateData.recoveryDeposits = Object.fromEntries(recoveryDeposits(server));
    await localState.save(stateData);
  } catch (err: unknown) {
    console.warn('[recovery] Failed to persist recovery deposits:', err instanceof Error ? err.message : String(err));
  }
}
/** Release attempts per card: three free, then a doubling delay to fifteen minutes, counted in a plaintext sidecar (A7's limiter). */
function recoveryAttempts(server: NautilusAppServer): PersistedAttemptLimiter {
  const s = server as unknown as { __recoveryAttempts?: PersistedAttemptLimiter };
  return (s.__recoveryAttempts ??= new PersistedAttemptLimiter(join(server.getConfig().stateDir, 'recovery-attempts.json')));
}
function recoveryPerCaller(server: NautilusAppServer): SlidingWindowLimiter {
  const s = server as unknown as { __recoveryPerCaller?: SlidingWindowLimiter };
  return (s.__recoveryPerCaller ??= new SlidingWindowLimiter(30, 60_000));
}
const HEX16 = /^[0-9a-f]{16}$/i;
const HEX64 = /^[0-9a-f]{64}$/i;
const DECIMAL = /^\d+$/;
function parseDeposits(value: unknown): RecoveryDeposit[] | null {
  if (!Array.isArray(value) || value.length > 4) return null;
  const out: RecoveryDeposit[] = [];
  for (const d of value as Array<Record<string, unknown>>) {
    if (!d || typeof d !== 'object') return null;
    const { cardId, share2Hex, pinVerifier, identitySalt, groupIdHash, planIdHash, domainTag } = d;
    if (typeof cardId !== 'string' || !HEX16.test(cardId)) return null;
    if (typeof share2Hex !== 'string' || !/^[0-9a-f]+$/i.test(share2Hex) || share2Hex.length % 2 !== 0 || share2Hex.length < 32 || share2Hex.length > 256) return null;
    if (typeof pinVerifier !== 'string' || !HEX64.test(pinVerifier)) return null;
    if (typeof identitySalt !== 'string' || !HEX64.test(identitySalt)) return null;
    if (typeof groupIdHash !== 'string' || !DECIMAL.test(groupIdHash) || typeof planIdHash !== 'string' || !DECIMAL.test(planIdHash)) return null;
    if (typeof domainTag !== 'number' || !Number.isInteger(domainTag) || domainTag < 0 || domainTag > 3) return null;
    out.push({ cardId: cardId.toLowerCase(), share2Hex: share2Hex.toLowerCase(), pinVerifier: pinVerifier.toLowerCase(), identitySalt: identitySalt.toLowerCase(), groupIdHash, planIdHash, domainTag });
  }
  return out;
}
/** File deposits for an enrolled wallet; a card id already filed for another wallet is refused. */
function fileDeposits(server: NautilusAppServer, walletId: string, deposits: RecoveryDeposit[]): Array<{ cardId: string; filed: boolean }> {
  const map = recoveryDeposits(server);
  return deposits.map((d) => {
    const existing = map.get(d.cardId);
    if (existing && existing.walletId !== walletId) return { cardId: d.cardId, filed: false };
    map.set(d.cardId, { ...d, walletId, filedAt: Date.now(), failures: 0, releaseCount: 0 });
    return { cardId: d.cardId, filed: true };
  });
}
function sameHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
/** The insurer's request signer, derived once from the configured seed (the A9 key). */
function insurerSigner(server: NautilusAppServer): { privateKey: KeyObject } | null {
  const seed = server.getConfig().insurerSigningSeed;
  if (!seed) return null;
  const s = server as unknown as { __insurerRequestSigner?: { privateKey: KeyObject } };
  return (s.__insurerRequestSigner ??= { privateKey: deriveInsurerKeypair(seed).privateKey });
}

interface CodeTarget { employerId: string | null; url: string }
type ResolvedTargets = { candidates: CodeTarget[] } | { status: number; error: string };

/**
 * Which employer node(s) to ask about a code. A static `employerUrl` in the config (single-tenant
 * deployments) wins. Otherwise the sequencer's tenant registry is filtered by the code's routing
 * prefix, so one employer is asked; a code that is not canonical carries no prefix and is only
 * ever tried against the employer the member named. Nothing is fanned out, and the URL never comes
 * from the request body.
 */
async function resolveCodeTargets(
  server: NautilusAppServer,
  code: string,
  hintEmployerId: string | undefined,
): Promise<ResolvedTargets> {
  const staticUrl = (server.getConfig() as { employerUrl?: string }).employerUrl;
  if (staticUrl) return { candidates: [{ employerId: hintEmployerId ?? null, url: staticUrl }] };

  const seqUrl = server.getConfig().sequencerUrl.replace(/\/+$/, '');
  let nodes: Array<{ employerId: string; employerNodeUrl: string }> = [];
  try {
    const resp = await fetch(`${seqUrl}/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'l2_listEmployerNodes', params: {} }),
      signal: AbortSignal.timeout(5000),
    });
    const json = await resp.json() as { result?: unknown };
    nodes = Array.isArray(json.result) ? json.result as typeof nodes : [];
  } catch {
    return { status: 502, error: 'Cannot validate enrollment code: sequencer unreachable for employer lookup.' };
  }
  if (nodes.length === 0) {
    return {
      status: 503,
      error: 'Cannot validate enrollment code: no employer nodes are registered. ' +
        'The employer must complete marketplace activation before employees can enroll.',
    };
  }

  const prefix = routingPrefixOf(code);
  const matching = prefix
    ? nodes.filter((n) => typeof n.employerId === 'string' && enrollmentCodeRoutingPrefix(n.employerId) === prefix)
    : nodes.filter((n) => hintEmployerId !== undefined && n.employerId === hintEmployerId);
  if (matching.length === 0) {
    return { status: 403, error: 'Enrollment denied: this enrollment code is not recognized by any registered employer.' };
  }
  // A hint that agrees with the prefix goes first. One that disagrees is ignored, never trusted.
  matching.sort((a, b) => Number(b.employerId === hintEmployerId) - Number(a.employerId === hintEmployerId));
  return { candidates: matching.map((n) => ({ employerId: n.employerId, url: n.employerNodeUrl })) };
}

type RedeemOutcome =
  | { ok: true; employerId: string | null; groupIdHash: string | null; planIdHash: string | null; familyIdHash: string | null }
  | { ok: false; status: number; error: string };

/** Ask the candidate employer(s), signed as the insurer, to redeem the code. */
async function redeemWithEmployers(
  candidates: CodeTarget[],
  code: string,
  tokenPinHash: string | undefined,
  signer: { privateKey: KeyObject },
): Promise<RedeemOutcome> {
  const path = `/tokens/${encodeURIComponent(code)}/validate`;
  const body = JSON.stringify({ tokenPinHash });
  let refusal: string | null = null;
  let unreachable = 0;

  for (const c of candidates) {
    const headers = {
      'Content-Type': 'application/json',
      ...signRequest({ signerId: 'insurer', privateKey: signer.privateKey, method: 'POST', path, body }),
    };
    let status = 0;
    let json: Record<string, unknown> = {};
    try {
      const resp = await fetch(`${c.url.replace(/\/+$/, '')}${path}`, {
        method: 'POST', headers, body, signal: AbortSignal.timeout(5000),
      });
      status = resp.status;
      json = await resp.json() as Record<string, unknown>;
    } catch {
      unreachable++;
      continue;
    }
    const data = (json.data ?? json) as { valid?: boolean; reason?: string; groupIdHash?: string; planIdHash?: string; familyIdHash?: string };

    if (status === 401 || status === 503 || status === 429) {
      // The oracle would not answer us at all: a trust or capacity problem on that node, not a
      // verdict on the code. Report which, and do not read a verdict out of it.
      refusal = `employer ${c.employerId ?? '(static)'} returned ${status}: ${String(json.error ?? data.reason ?? 'refused')}`;
      continue;
    }
    if (data.valid === true) {
      // A-34: the family hash the code carries; anything but a decimal hash is no family.
      const familyIdHash = typeof data.familyIdHash === 'string' && DECIMAL.test(data.familyIdHash) ? data.familyIdHash : null;
      return { ok: true, employerId: c.employerId, groupIdHash: data.groupIdHash ?? null, planIdHash: data.planIdHash ?? null, familyIdHash };
    }
    const reason = String(data.reason ?? json.error ?? 'Token validation failed');
    // "Token not found" means this is not that employer's code; the next candidate may own it.
    // Anything else is a verdict: wrong PIN, expired, revoked, consumed, locked.
    if (/not found/i.test(reason)) continue;
    return { ok: false, status: 403, error: 'Enrollment denied: ' + reason };
  }

  if (refusal) return { ok: false, status: 502, error: 'Cannot validate enrollment code: ' + refusal };
  if (unreachable > 0) return { ok: false, status: 502, error: 'Cannot validate enrollment code: employer node unreachable.' };
  return { ok: false, status: 403, error: 'Enrollment denied: this enrollment code is not recognized by its employer.' };
}

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
        clientOptions: server.sequencerClientOptions(),
      });
      server.setEntityNode(node);

      const state = server.getLocalState();
      const data = state.getState();
      if (data) {
        data.onboarding.phase = 'ready';
        data.onboarding.enrollmentTimestamp = Date.now();
        data.lastSequencerUrl = server.getConfig().sequencerUrl;
        try {
          await state.save(data);
        } catch (err) {
          return server.sendResponse(res, 500, false, undefined, err instanceof Error ? err.message : 'Failed to save state');
        }
      }

      // Restore enrollment registry from persisted state (survives restarts)
      if (data) {
        const persisted = (data as any).enrollmentRegistry;
        if (persisted && typeof persisted === 'object') {
          const registry = (server as any).__enrollmentRegistry ??= new Map<string, unknown>();
          for (const [wid, record] of Object.entries(persisted)) {
            registry.set(wid, record);
          }
          console.log('[insurer] Restored %d enrollment records from local state', registry.size);
        }
      }
      // A6: the codes already redeemed, so a retry after a restart is still idempotent.
      if (data) restoreRedeemedCodes(server, data as unknown as Record<string, unknown>);
      // A12b: the recovery deposits, so a card issued before a restart still recovers.
      if (data) restoreRecoveryDeposits(server, data as unknown as Record<string, unknown>);

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
    handler: async (_req, res, _params, _query, body) => {
      const node = server.getEntityNode() as InsurerNode | null;
      if (!node) {
        return server.sendResponse(res, 503, false, undefined, 'Insurer node not configured');
      }
      /*
       * C2 (A-9): the code is redeemed BEFORE the member derives a wallet, because the group hash
       * the employer answers is one of the wallet's inputs. So this step takes no wallet. It redeems
       * the code with the issuing employer exactly as A6 built it (routed by its prefix, probed with
       * the insurer's own key, consumed on success, never fanned out), records the redemption against
       * the code with no wallet yet, and answers the group and plan hashes. /enrollment/complete binds
       * the wallet. A repeat with the same code and PIN hash (a device that died before deriving) is
       * answered from the record; a repeat with another PIN hash is refused, so a code-only holder
       * learns nothing after consumption.
       */
      const b = body as { tokenId?: string; tokenPinHash?: string; role?: string; employerId?: string } | undefined;
      if (typeof b?.tokenId !== 'string' || b.tokenId.trim().length === 0) {
        return server.sendResponse(res, 400, false, undefined, 'An enrollment code is required.');
      }
      if (typeof b.tokenPinHash !== 'string' || b.tokenPinHash.length === 0) {
        return server.sendResponse(res, 400, false, undefined, 'The enrollment PIN hash is required.');
      }
      const code = canonicalizeEnrollmentCode(b.tokenId) ?? b.tokenId.trim();
      const redeemed = redeemedCodes(server);
      const prior = redeemed.get(code);
      if (prior) {
        if (!prior.pinHash || !sameHex(prior.pinHash, b.tokenPinHash)) {
          return server.sendResponse(res, 403, false, undefined, 'Enrollment denied: this enrollment code has already been used.');
        }
        console.log('[enrollment] Code already redeemed with this PIN; answering the same group and plan');
        return server.sendResponse(res, 200, true, { redeemed: true, repeated: true, groupIdHash: prior.groupIdHash, planIdHash: prior.planIdHash, employerId: prior.employerId });
      }
      const signer = insurerSigner(server);
      if (!signer) {
        return server.sendResponse(res, 500, false, undefined,
          'The insurer signing seed is not configured, so enrollment codes cannot be validated.');
      }
      const targets = await resolveCodeTargets(server, code, b.employerId);
      if ('error' in targets) return server.sendResponse(res, targets.status, false, undefined, targets.error);
      const outcome = await redeemWithEmployers(targets.candidates, code, b.tokenPinHash, signer);
      if (!outcome.ok) return server.sendResponse(res, outcome.status, false, undefined, outcome.error);
      if (!outcome.groupIdHash || !outcome.planIdHash) {
        return server.sendResponse(res, 502, false, undefined, 'The employer redeemed the code but did not say which group and plan it enrols into.');
      }
      redeemed.set(code, {
        walletId: null,
        pinHash: b.tokenPinHash,
        employerId: outcome.employerId,
        groupIdHash: outcome.groupIdHash,
        planIdHash: outcome.planIdHash,
        familyIdHash: outcome.familyIdHash,
        at: Date.now(),
      });
      await persistRedeemedCodes(server);
      console.log('[enrollment] Code redeemed with employer %s; awaiting the wallet', outcome.employerId ?? 'static');
      server.sendResponse(res, 200, true, { redeemed: true, groupIdHash: outcome.groupIdHash, planIdHash: outcome.planIdHash, employerId: outcome.employerId });
    },
  });

  // ── Enrollment completion: the wallet, and the recovery deposits (C2, A12b) ──
  routes.push({
    method: 'POST',
    path: '/enrollment/complete',
    handler: async (_req, res, _params, _query, body) => {
      const node = server.getEntityNode() as InsurerNode | null;
      if (!node) {
        return server.sendResponse(res, 503, false, undefined, 'Insurer node not configured');
      }
      const b = body as { tokenId?: string; walletId?: string; role?: string; recoveryDeposits?: unknown } | undefined;
      if (typeof b?.walletId !== 'string' || !DECIMAL.test(b.walletId)) {
        return server.sendResponse(res, 400, false, undefined, 'Missing walletId');
      }
      if (typeof b.tokenId !== 'string' || b.tokenId.trim().length === 0) {
        return server.sendResponse(res, 400, false, undefined, 'An enrollment code is required.');
      }
      const code = canonicalizeEnrollmentCode(b.tokenId) ?? b.tokenId.trim();
      const rec = redeemedCodes(server).get(code);
      if (!rec) {
        return server.sendResponse(res, 404, false, undefined, 'This enrollment code has not been redeemed. Redeem it first.');
      }
      if (rec.walletId && rec.walletId !== b.walletId) {
        return server.sendResponse(res, 403, false, undefined, 'Enrollment denied: this enrollment code has already been used.');
      }
      const deposits = b.recoveryDeposits === undefined ? [] : parseDeposits(b.recoveryDeposits);
      if (deposits === null) {
        return server.sendResponse(res, 400, false, undefined, 'recoveryDeposits must be a list of {cardId, share2Hex, pinVerifier, identitySalt, groupIdHash, planIdHash, domainTag}');
      }
      const registry = (server as any).__enrollmentRegistry ??= new Map<string, Record<string, unknown>>();
      const existing = registry.get(b.walletId) as Record<string, unknown> | undefined;
      if (existing && existing.tokenId !== code) {
        return server.sendResponse(res, 409, false, undefined, 'Wallet already enrolled');
      }
      // Step 2 commit two (B2, C2): the engine provisions ELIGIBLE only for a wallet the insurer
      // approved, and binds the plan the approval names. The plan is the one the insurer sold,
      // resolved from the hash the employer's code carried; it has to be on the sequencer already.
      let plans: BenefitPlanConfig[] = [];
      try { plans = (await node.listPlans()) ?? []; } catch { plans = []; }
      if (!Array.isArray(plans)) plans = [];
      const plan = rec.planIdHash ? plans.find((p) => p && typeof p.planId === 'string' && hashString(p.planId).toString() === rec.planIdHash) : undefined;
      if (!plan) {
        return server.sendResponse(res, 409, false, undefined,
          'The plan this enrollment code enrols into is not on the sequencer; the insurer must publish it before members enroll.');
      }
      try {
        const seqUrl = server.getConfig().sequencerUrl.replace(/\/+$/, '');
        const approval = await server.signedFetch(`${seqUrl}/interactive/approve-member`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ walletId: b.walletId, groupIdHash: rec.groupIdHash, planIdHash: rec.planIdHash, planId: plan.planId, employerId: rec.employerId, familyIdHash: rec.familyIdHash ?? null }),
        });
        if (!approval.ok) {
          const text = await approval.text().catch(() => '');
          console.warn('[enrollment] The sequencer did not record the approval:', approval.status, text);
          return server.sendResponse(res, 502, false, undefined, 'The sequencer did not record the insurer approval for this wallet');
        }
      } catch (err: unknown) {
        console.warn('[enrollment] Cannot reach the sequencer to approve the wallet:', err instanceof Error ? err.message : String(err));
        return server.sendResponse(res, 502, false, undefined, 'Cannot reach the sequencer to approve the wallet. Try again later.');
      }
      if (!rec.walletId) {
        rec.walletId = b.walletId;
        rec.completedAt = Date.now();
        await persistRedeemedCodes(server);
      }
      const enrollmentRecord = {
        walletId: b.walletId,
        tokenId: code,
        role: b.role ?? 'member',
        groupId: null,
        planId: null,
        groupIdHash: rec.groupIdHash,
        planIdHash: rec.planIdHash,
        employerId: rec.employerId,
        enrolledAt: (existing?.enrolledAt as number | undefined) ?? Date.now(),
      };
      registry.set(b.walletId, enrollmentRecord);
      try {
        const localState = server.getLocalState();
        const stateData = localState.getState() as any;
        if (stateData) {
          if (!stateData.enrollmentRegistry) stateData.enrollmentRegistry = {};
          stateData.enrollmentRegistry[b.walletId] = enrollmentRecord;
          await localState.save(stateData);
        }
      } catch (saveErr: any) {
        console.warn('[enrollment] Failed to persist enrollment to local state:', saveErr?.message ?? saveErr);
      }
      const filed = fileDeposits(server, b.walletId, deposits);
      if (filed.length > 0) await persistRecoveryDeposits(server);
      console.log('[enrollment] Member enrolled: wallet=%s code=%s deposits=%d', b.walletId.slice(0, 16), code, filed.filter((f) => f.filed).length);
      server.sendResponse(res, 200, true, {
        enrolled: true,
        ...enrollmentRecord,
        recoveryCards: filed,
      });
    },
  });

  // ── Recovery deposits — plan item A12b (PRD-1) ───────────────────────────────
  // A card carries one share and nothing that depends on the PIN; the other share, the salt and
  // the group and plan hashes are here, released only against the PIN verifier the device computed
  // at enrollment, attempt-limited per card and locked after ten failures. Revocable.
  const RELEASE_LOCK_AFTER = 10;
  async function releaseOrRevoke(req: IncomingMessage, res: ServerResponse, body: unknown, mode: 'release' | 'revoke'): Promise<void> {
    const caller = req.socket?.remoteAddress ?? 'unknown';
    if (!recoveryPerCaller(server).allow(caller)) {
      res.setHeader('Retry-After', '60');
      return server.sendResponse(res, 429, false, undefined, 'Too many recovery requests. Try again in a minute.');
    }
    const b = body as { cardId?: string; pinVerifier?: string } | undefined;
    if (typeof b?.cardId !== 'string' || !HEX16.test(b.cardId) || typeof b.pinVerifier !== 'string' || !HEX64.test(b.pinVerifier)) {
      return server.sendResponse(res, 400, false, undefined, 'cardId (16 hex) and pinVerifier (64 hex) are required');
    }
    const cardId = b.cardId.toLowerCase();
    const key = 'recovery:' + cardId;
    const limiter = recoveryAttempts(server);
    const verdict = limiter.check(key);
    if (!verdict.allowed) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil(verdict.retryAfterMs / 1000))));
      return server.sendResponse(res, 429, false, undefined, 'Too many attempts for this card. Try again later.');
    }
    const dep = recoveryDeposits(server).get(cardId);
    const matches = Boolean(dep) && !dep!.revokedAt && sameHex(dep!.pinVerifier, b.pinVerifier.toLowerCase());
    if (!matches) {
      limiter.recordFailure(key);
      if (dep && !dep.revokedAt) {
        dep.failures = (dep.failures ?? 0) + 1;
        if (dep.failures >= RELEASE_LOCK_AFTER) { dep.revokedAt = Date.now(); dep.revokedReason = 'locked after repeated failed attempts'; }
        await persistRecoveryDeposits(server);
      }
      return server.sendResponse(res, 403, false, undefined, mode === 'release' ? 'This card and PIN do not release a deposit.' : 'This card and PIN do not revoke a deposit.');
    }
    limiter.reset(key);
    if (mode === 'revoke') {
      dep!.revokedAt = Date.now();
      dep!.revokedReason = 'revoked by the member';
      await persistRecoveryDeposits(server);
      console.log('[recovery] card %s revoked', cardId);
      return server.sendResponse(res, 200, true, { cardId, revoked: true });
    }
    dep!.releasedAt = Date.now();
    dep!.releaseCount = (dep!.releaseCount ?? 0) + 1;
    await persistRecoveryDeposits(server);
    console.log('[recovery] deposit released for card %s', cardId);
    server.sendResponse(res, 200, true, {
      share2Hex: dep!.share2Hex, identitySalt: dep!.identitySalt, groupIdHash: dep!.groupIdHash, planIdHash: dep!.planIdHash, domainTag: dep!.domainTag,
    });
  }
  routes.push({ method: 'POST', path: '/recovery/release', handler: (req, res, _p, _q, body) => releaseOrRevoke(req, res, body, 'release') });
  routes.push({ method: 'POST', path: '/recovery/revoke', handler: (req, res, _p, _q, body) => releaseOrRevoke(req, res, body, 'revoke') });
  routes.push({
    method: 'POST',
    path: '/recovery/deposit',
    handler: async (_req, res, _params, _query, body) => {
      const b = body as { walletId?: string; deposits?: unknown } | undefined;
      if (typeof b?.walletId !== 'string' || !DECIMAL.test(b.walletId)) return server.sendResponse(res, 400, false, undefined, 'Missing walletId');
      const registry = (server as any).__enrollmentRegistry as Map<string, unknown> | undefined;
      if (!registry?.has(b.walletId)) return server.sendResponse(res, 404, false, undefined, 'No enrollment for this wallet');
      const deposits = parseDeposits(b.deposits);
      if (!deposits || deposits.length === 0) return server.sendResponse(res, 400, false, undefined, 'deposits must be a non-empty list');
      const filed = fileDeposits(server, b.walletId, deposits);
      await persistRecoveryDeposits(server);
      server.sendResponse(res, 201, true, { recoveryCards: filed });
    },
  });

  // ── Roster (live view from sequencer + local enrollment records) ──

  routes.push({
    method: 'GET',
    path: '/roster',
    adminOnly: true, // D1: every registered wallet, read with the insurer's role key (see /claims/member/:walletId)
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
          const seqUrl = server.getConfig().sequencerUrl.replace(/\/+$/, ''); // the configured sequencer, not a field the client never has
          const entityResp = await server.signedFetch(`${seqUrl}/viz/entities`);
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
            groupId: enrollment?.groupId ?? entity?.group ?? null,
            planId: enrollment?.planId ?? null,
            employerId: enrollment?.employerId ?? null,
            registeredAt: r.acceptedAt,
            receiptId: r.receiptId,
            batchNumber: r.l1BatchNumber ?? null,
          };
        });

        // Group-level summary
        const groupFilter = query?.get('groupId') ?? undefined;
        const roleFilter = query?.get('role') ?? undefined;
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
        planId?: string;
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
        planId: b.planId ?? null,
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
    adminOnly: true, // D1: an enumeration the sequencer answers only the plan and the operator
    handler: async (_req, res, _params, query) => {
      const node = server.getEntityNode() as InsurerNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');
      try {
        const receipts = await node.getAllReceipts();
        const limit = Math.min(parseInt(query.get('limit') ?? '1000', 10) || 1000, 1000);
        const offset = Math.max(parseInt(query.get('offset') ?? '0', 10) || 0, 0);
        server.sendResponse(res, 200, true, receipts.slice(offset, offset + limit));
      } catch (err) {
        server.sendResponse(res, 500, false, undefined, err instanceof Error ? err.message : 'Operation failed');
      }
    },
  });

  routes.push({
    method: 'GET',
    path: '/batches/all',
    handler: async (_req, res, _params, query) => {
      const node = server.getEntityNode() as InsurerNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');
      try {
        const batches = await node.getAllBatches();
        const limit = Math.min(parseInt(query.get('limit') ?? '1000', 10) || 1000, 1000);
        const offset = Math.max(parseInt(query.get('offset') ?? '0', 10) || 0, 0);
        server.sendResponse(res, 200, true, batches.slice(offset, offset + limit));
      } catch (err) {
        server.sendResponse(res, 500, false, undefined, err instanceof Error ? err.message : 'Operation failed');
      }
    },
  });

  routes.push({
    method: 'GET',
    path: '/audit/log',
    adminOnly: true, // D1: an enumeration the sequencer answers only the plan and the operator
    handler: async (_req, res, _params, query) => {
      const node = server.getEntityNode() as InsurerNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');
      try {
        const log = await node.getAuditLog();
        const limit = Math.min(parseInt(query.get('limit') ?? '1000', 10) || 1000, 1000);
        const offset = Math.max(parseInt(query.get('offset') ?? '0', 10) || 0, 0);
        server.sendResponse(res, 200, true, {
          ...log,
          events: log.events.slice(offset, offset + limit),
        });
      } catch (err) {
        server.sendResponse(res, 500, false, undefined, err instanceof Error ? err.message : 'Operation failed');
      }
    },
  });

  routes.push({
    method: 'GET',
    path: '/chain-proof',
    handler: async (_req, res) => {
      const node = server.getEntityNode() as InsurerNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');
      try {
        server.sendResponse(res, 200, true, await node.getChainProof());
      } catch (err) {
        server.sendResponse(res, 500, false, undefined, err instanceof Error ? err.message : 'Operation failed');
      }
    },
  });

  // ══════════════════════════════════════════════════════════
  //  ENTITY-FILTERED CLAIM QUERIES
  // ══════════════════════════════════════════════════════════

  routes.push({
    method: 'GET',
    path: '/claims/member/:walletId',
    /*
     * D1: this node reads with the insurer's role key, which the sequencer lets read any member's
     * claims. Open, the route handed them to anyone who could reach the port with a bare wallet ID.
     */
    adminOnly: true,
    handler: async (_req, res, params) => {
      const node = server.getEntityNode() as InsurerNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');
      try {
        server.sendResponse(res, 200, true, await node.getMemberClaims(params.walletId));
      } catch (err) {
        server.sendResponse(res, 500, false, undefined, err instanceof Error ? err.message : 'Operation failed');
      }
    },
  });

  routes.push({
    method: 'GET',
    path: '/claims/prescriber/:walletId',
    handler: async (_req, res, params) => {
      const node = server.getEntityNode() as InsurerNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');
      try {
        server.sendResponse(res, 200, true, await node.getPrescriberClaims(params.walletId));
      } catch (err) {
        server.sendResponse(res, 500, false, undefined, err instanceof Error ? err.message : 'Operation failed');
      }
    },
  });

  routes.push({
    method: 'GET',
    path: '/claims/pharmacy/:walletId',
    handler: async (_req, res, params) => {
      const node = server.getEntityNode() as InsurerNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');
      try {
        server.sendResponse(res, 200, true, await node.getPharmacyClaims(params.walletId));
      } catch (err) {
        server.sendResponse(res, 500, false, undefined, err instanceof Error ? err.message : 'Operation failed');
      }
    },
  });

  routes.push({
    method: 'GET',
    path: '/claims/drug/:ndcHash',
    handler: async (_req, res, params) => {
      const node = server.getEntityNode() as InsurerNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');
      try {
        server.sendResponse(res, 200, true, await node.getDrugClaims(params.ndcHash));
      } catch (err) {
        server.sendResponse(res, 500, false, undefined, err instanceof Error ? err.message : 'Operation failed');
      }
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
      try {
        server.sendResponse(res, 200, true, await node.verifyChainIntegrity());
      } catch (err) {
        server.sendResponse(res, 500, false, undefined, err instanceof Error ? err.message : 'Operation failed');
      }
    },
  });

  routes.push({
    method: 'GET',
    path: '/audit/financial-balance',
    handler: async (_req, res) => {
      const node = server.getEntityNode() as InsurerNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');
      try {
        server.sendResponse(res, 200, true, await node.verifyFinancialBalance());
      } catch (err) {
        server.sendResponse(res, 500, false, undefined, err instanceof Error ? err.message : 'Operation failed');
      }
    },
  });

  routes.push({
    method: 'GET',
    path: '/audit/duplicate-claims',
    handler: async (_req, res) => {
      const node = server.getEntityNode() as InsurerNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');
      try {
        server.sendResponse(res, 200, true, await node.detectDuplicateClaims());
      } catch (err) {
        server.sendResponse(res, 500, false, undefined, err instanceof Error ? err.message : 'Operation failed');
      }
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

      try {
        const result = await node.runFullAudit(
          {
            walletRegistryRoot: b.onChainState.walletRegistryRoot,
            lifecycleRoot: b.onChainState.lifecycleRoot,
            walletCount: BigInt(b.onChainState.walletCount),
          },
          b.rosterEntries,
        );
        server.sendResponse(res, 200, true, result);
      } catch (err) {
        server.sendResponse(res, 500, false, undefined, err instanceof Error ? err.message : 'Operation failed');
      }
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
      try {
        server.sendResponse(res, 200, true, node.generateClaimsRegister(b.claims, b.filter));
      } catch (err) {
        server.sendResponse(res, 500, false, undefined, err instanceof Error ? err.message : 'Operation failed');
      }
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
      try {
        server.sendResponse(res, 200, true, node.generatePharmacyReport(b.claims, b.filter));
      } catch (err) {
        server.sendResponse(res, 500, false, undefined, err instanceof Error ? err.message : 'Operation failed');
      }
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
      try {
        server.sendResponse(res, 200, true, node.generatePrescriberReport(b.claims, b.filter));
      } catch (err) {
        server.sendResponse(res, 500, false, undefined, err instanceof Error ? err.message : 'Operation failed');
      }
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
      try {
        server.sendResponse(res, 200, true, node.generateMemberReport(b.claims, b.filter));
      } catch (err) {
        server.sendResponse(res, 500, false, undefined, err instanceof Error ? err.message : 'Operation failed');
      }
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
      try {
        server.sendResponse(res, 200, true, node.generateMedicationUtilization(b.claims, b.filter));
      } catch (err) {
        server.sendResponse(res, 500, false, undefined, err instanceof Error ? err.message : 'Operation failed');
      }
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
      try {
        server.sendResponse(res, 200, true, node.generateFinancialSummary(b.claims, b.filter));
      } catch (err) {
        server.sendResponse(res, 500, false, undefined, err instanceof Error ? err.message : 'Operation failed');
      }
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
      try {
        server.sendResponse(res, 200, true, node.generatePriorAuthReport(b.claims, b.priorAuths, b.filter));
      } catch (err) {
        server.sendResponse(res, 500, false, undefined, err instanceof Error ? err.message : 'Operation failed');
      }
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
      try {
        server.sendResponse(res, 200, true, node.generateReversalReport(b.claims, b.filter));
      } catch (err) {
        server.sendResponse(res, 500, false, undefined, err instanceof Error ? err.message : 'Operation failed');
      }
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
      try {
        server.sendResponse(res, 200, true, node.generateTierAnalysis(b.claims, b.filter));
      } catch (err) {
        server.sendResponse(res, 500, false, undefined, err instanceof Error ? err.message : 'Operation failed');
      }
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
      try {
        server.sendResponse(res, 200, true, node.generateTherapeuticClassReport(b.claims, b.filter));
      } catch (err) {
        server.sendResponse(res, 500, false, undefined, err instanceof Error ? err.message : 'Operation failed');
      }
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
      try {
        server.sendResponse(res, 200, true, node.generateTimeSeries(b.claims, b.bucket, b.filter));
      } catch (err) {
        server.sendResponse(res, 500, false, undefined, err instanceof Error ? err.message : 'Operation failed');
      }
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
      try {
        server.sendResponse(res, 200, true, node.generateCrossTab(b.claims, b.row, b.col, b.measure, b.filter));
      } catch (err) {
        server.sendResponse(res, 500, false, undefined, err instanceof Error ? err.message : 'Operation failed');
      }
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
      try {
        const batch = await node.forceBatch();
        server.sendResponse(res, 200, true, batch);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Operation failed';
        // A9: the insurer's node key does not carry l2_forceBatch (RPC_METHODS_BY_ROLE in
        // node-roles.ts), and the sequencer refuses it with RPC_FORBIDDEN (-32004). Batches belong
        // to the sequencer: they settle on its timer, and the operator can force one from the
        // Leviathan dashboard. Say that with a 403 instead of passing the refusal on as a 500.
        if (/^RPC error -32004:/.test(msg)) {
          return server.sendResponse(res, 403, false, undefined,
            'Forbidden: only the network operator can force a batch. Batches settle on the sequencer\'s timer.');
        }
        server.sendResponse(res, 500, false, undefined, msg);
      }
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

        const rpcRes = await server.signedFetch(seqUrl + '/rpc', {
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
              verificationMethod: 'manual',
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

        const rpcRes = await server.signedFetch(seqUrl + '/rpc', {
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

        const rpcRes = await server.signedFetch(seqUrl + '/rpc', {
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
      try {
        server.sendResponse(res, 200, true, await node.listPlans());
      } catch (err) {
        server.sendResponse(res, 500, false, undefined, err instanceof Error ? err.message : 'Operation failed');
      }
    },
  });

  // GET /plans/:planId — Get a specific plan
  routes.push({
    method: 'GET',
    path: '/plans/:planId',
    handler: async (_req, res, params) => {
      const node = server.getEntityNode() as InsurerNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');
      try {
        const plan = await node.getPlan(params.planId);
        if (!plan) return server.sendResponse(res, 404, false, undefined, 'Plan not found');
        server.sendResponse(res, 200, true, plan);
      } catch (err) {
        server.sendResponse(res, 500, false, undefined, err instanceof Error ? err.message : 'Operation failed');
      }
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

        // Auto-publish: push plan overlay to sequencer (Option C — lightweight ~5KB, not 10MB)
        // Empty formularyNdcs = all drugs (no per-drug overrides); empty networkProviderWalletIds = all providers
        try {
          const seqUrl = server.getConfig().sequencerUrl.replace(/\/+$/, '');
          const pubHeaders: Record<string, string> = { 'Content-Type': 'application/json' };

          // Build per-drug overrides only for explicitly listed NDCs
          const overrides: any[] = [];
          if (plan.formularyNdcs.length > 0) {
            // When NDCs are specified, mark all OTHER drugs as excluded
            // For now, just publish with the specified NDCs as the covered set
            // (the overlay defaults apply to all drugs not in overrides)
          }

          // Plan-wide tier copay defaults (cents) — derived from plan's base copay
          const baseCopay = plan.copayAmountCents || 1000;
          const defaults = {
            tier1Copay: baseCopay,
            tier2Copay: Math.round(baseCopay * 3.5),
            tier3Copay: Math.round(baseCopay * 7.5),
            tier4Copay: Math.round(baseCopay * 15),
          };

          const overlayRes = await server.signedFetch(seqUrl + '/rpc', {
            method: 'POST', headers: pubHeaders,
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'l2_publishPlanOverlay',
              params: { planIdHash: plan.planId, planName: plan.name, overrides, defaults } }),
          });
          const overlayJson = await overlayRes.json() as any;
          if (overlayJson.error) throw new Error(overlayJson.error.message ?? 'Sequencer error');

          const networkRoot = plan.networkProviderWalletIds.length > 0
            ? String(plan.networkProviderWalletIds.length)
            : '0';

          // Mark plan as published
          await node.markPlanPublished(plan.planId, String(overlayJson.result?.version ?? 1), networkRoot);
          plan.published = true;
          plan.formularyRoot = String(overlayJson.result?.version ?? 1);
          plan.networkRoot = networkRoot;
        } catch (pubErr: any) {
          // Plan created but publish failed — flag it clearly so the client can retry
          console.warn('[insurer] Auto-publish failed for %s: %s', plan.planId, pubErr.message);
          plan.publishError = pubErr.message;
        }

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
      try {
        const deleted = await node.deletePlan(params.planId);
        if (!deleted) return server.sendResponse(res, 404, false, undefined, 'Plan not found');
        server.sendResponse(res, 200, true, { deleted: true, planId: params.planId });
      } catch (err) {
        server.sendResponse(res, 500, false, undefined, err instanceof Error ? err.message : 'Operation failed');
      }
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
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };

        // Option C: Publish lightweight plan overlay (~5KB, not 10MB blob)
        const overrides: any[] = [];
        // Plan-wide tier copay defaults (cents) — derived from plan's base copay
        const baseCopay = plan.copayAmountCents || 1000;
        const defaults = {
          tier1Copay: baseCopay,
          tier2Copay: Math.round(baseCopay * 3.5),
          tier3Copay: Math.round(baseCopay * 7.5),
          tier4Copay: Math.round(baseCopay * 15),
        };

        const overlayRes = await server.signedFetch(seqUrl + '/rpc', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            jsonrpc: '2.0', id: 1,
            method: 'l2_publishPlanOverlay',
            params: { planIdHash: params.planId, planName: plan.name, overrides, defaults },
          }),
        });
        const overlayJson = await overlayRes.json() as any;
        if (overlayJson.error) throw new Error(overlayJson.error.message ?? 'Sequencer error');

        const networkRoot = plan.networkProviderWalletIds.length > 0
          ? String(plan.networkProviderWalletIds.length)
          : '0'; // 0 = all providers accepted

        // Mark plan as published
        const updated = await node.markPlanPublished(params.planId, String(overlayJson.result?.version ?? 1), networkRoot);

        server.sendResponse(res, 200, true, {
          published: true,
          planId: params.planId,
          overlayVersion: overlayJson.result?.version ?? 1,
          networkRoot,
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
    handler: async (_req, res, params, query) => {
      const node = server.getEntityNode() as InsurerNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');
      try {
        const messages = await node.getMessagesByWallet(params.walletId);
        const limit = Math.min(parseInt(query?.get('limit') ?? '500', 10) || 500, 500);
        const offset = Math.max(parseInt(query?.get('offset') ?? '0', 10) || 0, 0);
        server.sendResponse(res, 200, true, messages.slice(offset, offset + limit));
      } catch (err) {
        server.sendResponse(res, 500, false, undefined, err instanceof Error ? err.message : 'Operation failed');
      }
    },
  });

  routes.push({
    method: 'GET',
    path: '/messaging/thread/:threadIdHash',
    handler: async (_req, res, params, query) => {
      const node = server.getEntityNode() as InsurerNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');
      try {
        const messages = await node.getMessagesByThread(params.threadIdHash);
        const limit = Math.min(parseInt(query?.get('limit') ?? '500', 10) || 500, 500);
        const offset = Math.max(parseInt(query?.get('offset') ?? '0', 10) || 0, 0);
        server.sendResponse(res, 200, true, messages.slice(offset, offset + limit));
      } catch (err) {
        server.sendResponse(res, 500, false, undefined, err instanceof Error ? err.message : 'Operation failed');
      }
    },
  });

  routes.push({
    method: 'GET',
    path: '/messaging/status',
    handler: async (_req, res) => {
      const node = server.getEntityNode() as InsurerNode | null;
      if (!node) return server.sendResponse(res, 503, false, undefined, 'Node not initialized');
      try {
        server.sendResponse(res, 200, true, await node.getMessageStoreStatus());
      } catch (err) {
        server.sendResponse(res, 500, false, undefined, err instanceof Error ? err.message : 'Operation failed');
      }
    },
  });

  return routes;
}
