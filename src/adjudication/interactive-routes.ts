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
 * Adjudication Routes — HTTP handlers for ZK proof claim adjudication.
 *
 * Registers endpoints on L2RpcServer:
 *   GET  /interactive/state          — current session state
 *   GET  /interactive/console        — SSE stream of console events
 *   GET  /interactive/ready          — whether the engine is ready to prove (open; 503 with Retry-After until it is)
 *   POST /interactive/enroll         — execute member enrollment
 *   POST /interactive/enroll-family  — enroll subscriber + all dependents
 *   POST /interactive/assign-pcp     — assign PCP with consent proof
 *   GET  /interactive/member-history  — get member's Rx history (PCP-gated)
 *   GET  /interactive/family-history  — get family-level history + pooled accumulators
 *   POST /interactive/request-prior-auth — prescriber requests PA for PA-required med (signed as the prescriber's wallet; the console as the operator)
 *   GET  /interactive/prior-auth-status  — a member's PA status for one drug (the prescriber's wallet, with the member's consent; the operator)
 *   POST /interactive/approve-prior-auth — insurer approves PA (generates provePriorAuth proof)
 *   POST /interactive/deny-prior-auth    — insurer denies PA request (with its reason)
 *   GET  /interactive/prior-auths        — the PA requests for the plan's review (?status=PENDING|RESOLVED|ALL)
 *   POST /interactive/prescribe          — create prescription with proofs (enforces PA)
 *   POST /interactive/fill               — dispense step (backward-compat path, returns 202, poll fill-status)
 *   GET  /interactive/fill-status       — poll fill job status
 *   POST /interactive/mark-filled       — pharmacist marks prescription as physically prepared
 *   POST /interactive/update-rx-status   — cancel/reject prescription (state machine enforced)
 *   POST /interactive/reverse            — reverse a filled prescription (ZK proof + accumulator rollback)
 *   POST /interactive/terminate-member   — terminate a member (revoke credential, cancel Rx)
 *   POST /interactive/terminate-group    — terminate all members in a group
 *   POST /interactive/send-message       — send encrypted message (any party → any party)
 *   POST /interactive/decrypt-thread    — batch decrypt messages in a thread
 *   GET  /interactive/threads           — get conversation threads for a wallet
 *   POST /interactive/create-delegation  — create delegation (member → member, ZK proof)
 *   POST /interactive/generate-credential — generate portable credential (ZK proof)
 *   POST /interactive/verify-credential   — verify portable credential offline
 *   POST /interactive/update-formulary    — modify/remove/add formulary entries (cascades to credentials)
 *   POST /interactive/plan-year-rollover  — reset accumulators for new plan year
 *   GET  /interactive/step-therapy-check  — check step therapy eligibility for a medication
 *   POST /interactive/reset              — reset session state
 *   GET  /interactive/badge/list       — list all provider badges
 *   POST /interactive/badge/tap        — simulate single badge tap (real ZK proof)
 *   POST /interactive/badge/auto-tap   — auto-tap all providers (real ZK proofs)
 *   GET  /interactive/badge/:key       — get specific badge payload
 */
import type { IncomingMessage, ServerResponse } from 'http';
import { DEFAULT_RPC_SERVER_OPTIONS, type L2RpcServer } from '../l2/l2-rpc-server.js';
import type { AdjudicationService, ConsoleEvent } from './interactive-service.js';
import { RegistrationRefused } from './interactive-service.js';
import { priceDispense, statedCostMismatch, quantityError } from '../fulfillment/nadac-pricing.js';
import type { NfcReader, NfcTagEvent, NdefPayload } from './nfc-port.js';
import type { NfcCredentialAttestation } from '../credentials/nfc-attestation.js';
import { MEDICATIONS, PRESCRIBERS, PHARMACIES } from '../data/index.js';
import { readRequestBody } from '../security/request-body.js';
import { displayNameError } from '../security/free-text.js';
import { walletIdError } from '../security/wallet-id.js';

type RouteHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

/** What a route that makes proofs answers, with 503, while the engine is still starting its provers. */
export const PROVERS_STARTING_MESSAGE = 'The claims engine is still starting its provers; try again shortly.';

/** The Retry-After, in seconds, of that answer and of GET /interactive/ready while the engine is not ready to prove. */
export const PROVERS_RETRY_AFTER_SECONDS = 10;

/**
 * The most bytes an engine route reads from a request body: the sequencer's own limit, the one its gates read a signed
 * request's body under (DEFAULT_RPC_SERVER_OPTIONS.maxBodyBytes, which the launcher keeps), so a body meets the same
 * limit whichever reader comes first. The engine read with no limit until the sweep of the open routes (2026-10-24):
 * register-member and verify-credential take no credential, so one request could make the sequencer hold any amount of
 * text, then parse it.
 */
export const ENGINE_BODY_LIMIT_BYTES = DEFAULT_RPC_SERVER_OPTIONS.maxBodyBytes;

/**
 * What the 504 of a route that answers from a locked engine call adds to 'Request timeout' when its budget ran out while
 * it still waited for the proving lock: it was dropped there and changed nothing (underProvingLock).
 */
export const TIMED_OUT_WAITING_DETAIL = 'The request waited for the proving lock past its budget and was dropped: nothing was changed, and it may be sent again.';

/** What that 504 adds when the budget ran out after the request's work had started under the lock. */
export const TIMED_OUT_RUNNING_DETAIL = 'The request had started its work when its budget ran out, and the work goes on to finish: check the outcome before sending it again.';

export function registerInteractiveRoutes(
  server: L2RpcServer,
  service: AdjudicationService,
  nfcBridge?: NfcReader,
): void {
  // CORS is applied once by L2RpcServer.handleRequest, from the deployment's origin
  // allowlist. Naming Access-Control-Allow-Origin in a writeHead header object here
  // would override that policy with a wildcard, so no handler below sets it.

  // Tier 3 admin-only routes — destructive or privilege-escalating operations
  const ADMIN_ROUTES = new Set([
    '/interactive/approve-prior-auth',
    '/interactive/deny-prior-auth',
    '/interactive/terminate-member',
    '/interactive/terminate-group',
    '/interactive/decrypt-thread',
    '/interactive/create-delegation',
    '/interactive/update-formulary',
    '/interactive/plan-year-rollover',
    '/interactive/reset',
    // Step 2 commit two: only the insurer (role) or the operator may approve a wallet for ELIGIBLE
    '/interactive/approve-member',

    /*
     * Added by phase A item A11.
     *
     * `/interactive/state` — finding A-13. Open, and 137,035 bytes measured on a live run: every
     * enrolled member's wallet ID beside their display name, employee ID and family ID, their
     * accumulators, their portable credential JSON and attestations, prescriptions linking a
     * wallet to a drug, and the fixture members' names, cardholder IDs, dates of birth and home
     * addresses. One unauthenticated GET returned all of it. No production dashboard reads this
     * route; the readers are the visualizer, which the production launcher does not serve.
     *
     * `update-provider-network` — finding A-19. Admin-class work on an open route: a per-member
     * cascade that rewrites every member's eligibility and submits a proof for each. Its sibling
     * `update-formulary` was already gated, which is what made the omission visible.
     *
     * The batch and checkpoint controls — ENG-11. `force-batch` was confirmed open on a live run
     * by the e2e harness, which asserts it should be refused and got a 200. A caller who can
     * force batches, retry them, simulate failures or write checkpoints controls when and whether
     * the ledger advances.
     */
    '/interactive/state',
    '/interactive/update-provider-network',

    /*
     * Added by A12, and the reason is a consequence of A12 itself.
     *
     * Finding A-17 says open credential minting would allow offline impersonation at a pharmacy,
     * and the audit's own note says it is "blocked in this deployment only by A-24: credential
     * generation currently fails in the proof pool. Treat as critical the moment A-24 is fixed."
     * A12 fixed A-24. So the bug that was accidentally holding the door shut is gone, and these
     * two routes — one that mints a portable credential for any wallet, one that returns it —
     * had to be closed in the same change rather than shipped newly exploitable.
     *
     * Admin is an interim gate, chosen because it is consistent with the rest of this Set and
     * costs nothing: only the visualizer calls these, and the production launcher does not serve
     * it. The real fix is a proof that the caller owns the wallet, which is the second half of
     * item A10.
     */
    '/interactive/generate-credential',
    '/interactive/credential-status',
    '/interactive/force-batch',
    '/interactive/save-checkpoint',
    '/interactive/retry-batch',
    '/interactive/simulate-batch-failure',

    /*
     * The engine's console stream. It prints display names beside wallet ID prefixes, and a delegation's
     * names and relationship label, so it is the operator's log tail and nobody else's. The sequencer
     * sends a stream through its stream gate, so a browser's EventSource may carry the operator's token
     * in ?token=. No node role lists it.
     */
    '/interactive/console',
  ]);

  /**
   * Routes a prescriber calls as itself (owner decision 2026-10-19): the prescriber node signs as the prescriber's own
   * wallet, the sequencer verifies that wallet's registered key, and the handler takes the prescriber from the signature
   * (L2RpcServer.principalOf), never from the body. The operator's credential opens them too, for the console.
   */
  const PROVIDER_ROUTES: Record<string, 'prescriber' | 'pharmacy'> = {
    'POST:/interactive/request-prior-auth': 'prescriber',
    'GET:/interactive/prior-auth-status': 'prescriber',
  };

  /** Routes that take only the signature of the wallet they name (B2), and where the request names it. */
  const WALLET_ROUTES: Record<string, { from: 'query' | 'body'; param: string }> = {
    'GET:/interactive/wallet-updates': { from: 'query', param: 'walletId' },
    'POST:/interactive/wallet-update-applied': { from: 'body', param: 'walletId' },
    'POST:/interactive/pcp-assignment': { from: 'body', param: 'walletId' },
    'POST:/interactive/prescriber-authorization': { from: 'body', param: 'walletId' },
  };

  /**
   * How long one of the engine's write routes may run before the sequencer answers 504. Prescribing
   * makes four proofs in about 35 s on a workstation; the default budget is 30 s. The same budget the
   * nodes' proof routes carry (PROVING_BUDGET_MS); a lookup finishes long before it matters.
   */
  const ENGINE_ROUTE_BUDGET_MS = 180_000;

  /**
   * D2: every write route needs a credential — the operator's token or a node key whose role may call
   * it (ROUTES_BY_ROLE) — except the two that need none: register-member carries the device's
   * ownership proof, which the handler checks, and verify-credential changes nothing. The wallet-signed
   * routes carry the wallet's own signature instead. The member-data reads among the GET routes need a
   * credential too, as does the `/node/*` mirror of the sequencer's reads, which until D2 answered any
   * wallet's claims and the identity dump to anyone; the chain's own state, proof, batches and
   * formulary name no wallet and stay open.
   *
   * Neither open write tells its caller anything about a member until a proof says it may (the security review of the
   * sweep fixes, 2026-10-24): the engine verifies register-member's ownership proof before it reads the wallet's name,
   * its approval or its place on the ledger, and verify-credential names a member only by the wallet its verified proof
   * carries, never by the credential's unverified copy of that output.
   *
   * The engine's chain status (l2-status) is one of the member-data reads, though it stayed open until the sweep of the
   * open routes (2026-10-24): every call lists every receipt's wallet and the whole audit log, each claim with its
   * member, prescriber and pharmacy wallets, drug and amounts, the enumerations D1 gives the plan and the operator. No
   * node role lists it, so it answers the operator, whose console's sequencer tab is its one reader, as the engine's
   * other copies of those lists (/node/all-receipts, /node/audit-log) do; the plan reads them from the sequencer itself
   * (l2_getAllReceipts, l2_getAuditLog).
   */
  const OPEN_POSTS = new Set(['/interactive/register-member', '/interactive/verify-credential']);
  const GATED_READS = new Set([
    '/interactive/member-history', '/interactive/family-history', '/interactive/threads',
    '/interactive/prescriptions-by-pharmacy', '/interactive/fill-status', '/interactive/step-therapy-check',
    '/interactive/enroll-status', '/interactive/prior-auths', '/interactive/l2-status',
  ]);
  const OPEN_NODE_READS = new Set(['/node/chain-state', '/node/chain-proof', '/node/all-batches', '/node/formulary']);
  /**
   * Reads open by design: a caller with no credential needs them, and they name nothing about members. The engine's
   * readiness to prove is one (a provider node, a harness or the launcher waits on it before a first proof). A GET
   * outside GATED_READS is open anyway; these are named so that no later change puts one behind a gate, which reg refuses.
   */
  const OPEN_READS = new Set(['/interactive/ready']);

  /**
   * The routes that make proofs: each handler reaches the engine's prover (dispatchProof) through the service, as
   * prescribing, dispensing, a reversal and a prior-authorization approval do, and the console's enrollments, its PCP
   * assignment (assign-pcp), messages, delegations, credentials and badge taps; the formulary, provider-network and
   * plan-year cascades prove for the console's members. While the engine is not ready to prove (its programs compile, or
   * its proof pool's workers are still compiling after boot) each answers 503 with Retry-After before it reads its body,
   * takes the proving lock or changes anything, and the caller tries again: a provider node's job stays pending and does.
   * The prover's own wait for a starting pool stays as the safety net; GET /interactive/ready says when the engine is
   * ready. pcp-assignment, a member device's own PCP choice, is not here: it makes no proof (the device proves the wallet
   * update it queues), as tests/engine-ready-route.test.ts checks against the code.
   */
  const PROVING_ROUTES = new Set([
    '/interactive/enroll', '/interactive/enroll-family', '/interactive/approve-prior-auth',
    '/interactive/prescribe', '/interactive/fill', '/interactive/prescribe-and-fill', '/interactive/reverse',
    '/interactive/assign-pcp', '/interactive/send-message', '/interactive/create-delegation', '/interactive/generate-credential',
    '/interactive/update-formulary', '/interactive/update-provider-network', '/interactive/plan-year-rollover',
    '/interactive/badge/tap', '/interactive/badge/auto-tap',
  ]);

  /** A proving route's handler behind the engine's readiness to prove: 503 with Retry-After until the engine is ready. */
  function untilProvingReady(method: string, path: string, handler: RouteHandler): RouteHandler {
    return async (req: IncomingMessage, res: ServerResponse) => {
      if (!service.isProvingReady()) {
        console.log(`  [interactive] ${method} ${path} answered 503: the provers are still starting (retry after ${PROVERS_RETRY_AFTER_SECONDS} s)`);
        res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': String(PROVERS_RETRY_AFTER_SECONDS) });
        res.end(JSON.stringify({ error: PROVERS_STARTING_MESSAGE, retryAfterSeconds: PROVERS_RETRY_AFTER_SECONDS }));
        return;
      }
      return handler(req, res);
    };
  }

  /**
   * A write route's handler behind the engine's body limit: a body that declares more than ENGINE_BODY_LIMIT_BYTES is
   * answered 413 before any of it is read, so nothing of it is parsed, and Node discards the rest once the answer is
   * sent, so the connection serves the next request. A body sent in chunks declares no length; readBody reads it no
   * further than the same limit, where the shared reader closes the connection.
   */
  function withinBodyLimit(handler: RouteHandler): RouteHandler {
    return async (req: IncomingMessage, res: ServerResponse) => {
      const declared = Number(req.headers['content-length']);
      if (declared > ENGINE_BODY_LIMIT_BYTES) {
        sendError(res, 413, `The engine reads a request body of at most ${ENGINE_BODY_LIMIT_BYTES} bytes; this one declares ${declared}`);
        return;
      }
      return handler(req, res);
    };
  }

  // The prescriber's pre-script estimate (l2_estimateCost with a walletId) is this engine's quote for that member,
  // reached through one narrow call that can become an RPC when the engine moves into its own process, together with the
  // member's consent the read gate asks before a prescriber reads it (B5: the named primary-care prescriber, or one the
  // member's device authorized for the visit). The service is asked only when a quote or a consent is.
  server.setMemberCostQuoteProvider({
    quote: (request) => service.quoteMemberCost(request.walletId, request.ndcHash, request.quantity),
    mayPrescribe: (request) => service.prescribingConsentFor(request.memberWalletId, request.prescriberWalletId, request.ndcHash) !== null,
  });

  // Helper: register route with the admin gate (A11, D2), the wallet gate for wallet routes, the proving budget and the
  // body limit for every write route, and the readiness gate for the routes that make proofs
  function reg(method: string, path: string, handler: RouteHandler): void {
    const upper = method.toUpperCase();
    const walletSigned = WALLET_ROUTES[`${upper}:${path}`];
    const timeoutMs = upper === 'POST' ? ENGINE_ROUTE_BUDGET_MS : undefined;
    const providerSigned = PROVIDER_ROUTES[`${upper}:${path}`];
    if (OPEN_READS.has(path) && (upper !== 'GET' || providerSigned || walletSigned || ADMIN_ROUTES.has(path) || GATED_READS.has(path))) {
      throw new Error(`${upper} ${path} is an open read (OPEN_READS) and is never registered behind a gate`);
    }
    // The body limit sits inside the readiness gate: a route that makes proofs still answers 503 first while its provers
    // start, and neither reads the body.
    if (upper === 'POST') handler = withinBodyLimit(handler);
    const route = upper === 'POST' && PROVING_ROUTES.has(path) ? untilProvingReady(upper, path, handler) : handler;
    if (providerSigned) {
      server.registerRoute(method, path, route, timeoutMs ? { providerSigned, timeoutMs } : { providerSigned });
      return;
    }
    const adminOnly = ADMIN_ROUTES.has(path)
      || (upper === 'POST' && !walletSigned && !OPEN_POSTS.has(path))
      || (upper === 'GET' && GATED_READS.has(path))
      || (path.startsWith('/node/') && !OPEN_NODE_READS.has(path));
    server.registerRoute(method, path, route, adminOnly ? { adminOnly: true, timeoutMs } : walletSigned ? { walletSigned, timeoutMs } : timeoutMs ? { timeoutMs } : undefined);
  }

  /** The requests whose work has started under the proving lock (underProvingLock): answered or not, each finishes. */
  const startedUnderLock = new WeakSet<ServerResponse>();

  /**
   * Run the engine call a route answers from under the proving lock, unless the request was answered while it waited.
   *
   * The lock is held until its holder settles, so a request can wait for it past its route's budget; the sequencer then
   * answers it 504, and nothing cancels the handler. Until the review of option A step 1, round two (2026-10-24), the
   * change was made whenever the lock came free, after its caller had been told it timed out and had perhaps sent it
   * again, so it was made twice. Now a request answered while it waits, by that 504 or because its caller went away, lets
   * the lock go as soon as it has it and changes nothing, and the engine logs one line naming the route. A request whose
   * work has started finishes, as before, its later locked calls included (an auto-tap round's next taps). The 504 says
   * which of the two it was. The background jobs (enroll, fill, prescribe-and-fill, generate-credential) answer at once
   * and take the lock afterwards, so they must not come here: their own answer would read as one the budget gave.
   */
  function underProvingLock<T>(req: IncomingMessage, res: ServerResponse, fn: () => Promise<T>): Promise<T> {
    if (!startedUnderLock.has(res)) server.setTimeoutDetail(res, TIMED_OUT_WAITING_DETAIL);
    return service.getL2Node().withProvingLock(async () => {
      if (!startedUnderLock.has(res) && (res.writableEnded || res.destroyed)) {
        const route = `${req.method} ${new URL(req.url ?? '/', 'http://localhost').pathname}`;
        const why = res.writableEnded ? 'it was answered 504 while it waited for the proving lock' : 'its caller went away while it waited for the proving lock';
        console.warn(`  [interactive] ${route} dropped without running: ${why}`);
        throw new Error(`${route} dropped without running: ${why}`);
      }
      startedUnderLock.add(res);
      server.setTimeoutDetail(res, TIMED_OUT_RUNNING_DETAIL);
      return fn();
    });
  }

  // Console SSE clients
  const consoleSseClients: Set<ServerResponse> = new Set();

  // Bridge console events from the service to SSE clients
  const consoleEmitter = (event: ConsoleEvent): void => {
    const data = JSON.stringify(event);
    for (const client of consoleSseClients) {
      try {
        client.write(`event: console\ndata: ${data}\n\n`);
      } catch {
        consoleSseClients.delete(client);
      }
    }
    // Also log to server console for debugging
    const ts = new Date(event.timestamp).toLocaleTimeString();
    const elapsed = event.elapsedMs ? ` (${(event.elapsedMs / 1000).toFixed(2)}s)` : '';
    console.log(`[${ts}] [${event.type}] ${event.message}${elapsed}`);
  };

  // GET /interactive/console — SSE stream
  reg('GET', '/interactive/console', async (req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    consoleSseClients.add(res);
    res.write(`data: ${JSON.stringify({ type: 'connected', timestamp: Date.now() })}\n\n`);

    req.on('close', () => {
      consoleSseClients.delete(res);
    });
  });

  // GET /interactive/state
  reg('GET', '/interactive/state', async (_req: IncomingMessage, res: ServerResponse) => {
    try {
      const state = service.getState();
      res.writeHead(200, {
        'Content-Type': 'application/json',
      });
      res.end(safeJsonStringify(state, 'getState'));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[/interactive/state] Error:', message);
      sendError(res, 500, message);
    }
  });

  // GET /interactive/ready — whether the engine is ready to prove: { ready, compiled, prover }, and nothing about members.
  // Open (OPEN_READS). 200 when ready; 503 with Retry-After while its programs compile or its proof pool is starting.
  reg('GET', '/interactive/ready', async (_req: IncomingMessage, res: ServerResponse) => {
    try {
      const readiness = service.provingReadiness();
      const summary = { ready: readiness.ready === true, compiled: readiness.compiled === true, prover: readiness.prover };
      res.writeHead(summary.ready ? 200 : 503, summary.ready
        ? { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
        : { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Retry-After': String(PROVERS_RETRY_AFTER_SECONDS) });
      res.end(JSON.stringify(summary));
    } catch (err) {
      sendError(res, 500, err instanceof Error ? err.message : String(err));
    }
  });

  // ─── Async Enrollment ─────────────────────────────────────
  // Enrollment runs ZK proof generation which can take 30-60s.
  // We fire-and-forget, then the client polls for status every 15s.
  const enrollmentJobs = new Map<number, { status: 'pending' | 'complete' | 'error'; result?: unknown; error?: string }>();

  // One badge request at a time: another, sent while a tap or an auto-tap round runs or waits for the proving lock, is
  // answered 429 at once rather than queued behind it. Keeping a badge's proof from running beside any other proof is the
  // proving lock's work, which each tap takes.
  let badgeTapInProgress = false;

  // POST /interactive/register-member — register an externally-enrolled member's proving context
  // Called by the member Nautilus node at enrollment completion so the adjudication engine
  // can generate proofs on behalf of the member. No seed data required.
  reg('POST', '/interactive/register-member', async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const body = await readBody(req);
      const params = JSON.parse(body);

      // B2: the identity preimage is never sent to the engine; the device sends its ownership proof.
      if (params.preimageFields !== undefined) {
        sendError(res, 400, 'The identity preimage is never sent to the engine: send the ownership proof made on the device as ownershipProofJson (B2)');
        return;
      }
      // A-34: the family comes from the insurer's approval, which carries the employer's opaque family hash;
      // the employee ID stays with the employer (I5). Neither is read from this body.
      if (params.familyId !== undefined || params.employeeId !== undefined) {
        sendError(res, 400, 'The family comes from the insurer approval and the employee ID stays with the employer: send neither (A-34)');
        return;
      }
      if (!params.walletId || typeof params.ownershipProofJson !== 'string') {
        sendError(res, 400, 'Missing required fields: walletId, ownershipProofJson (ProofGate.verifyMember proof made on the device)');
        return;
      }
      // The engine's first step is BigInt(walletId), which reads every digit it is given and reads '0x3e9' or ' 1001' as
      // wallet 1001, so the ID is held to the form the network writes (A-74) before anything parses it (the sweep of the
      // open routes, 2026-10-24).
      const walletIdProblem = walletIdError(params.walletId);
      if (walletIdProblem) {
        sendError(res, 400, walletIdProblem);
        return;
      }
      // A-61: the name the device gives is what the operator console and the other screens list for this wallet,
      // so it is held to a short line of plain text before the engine keeps it.
      const displayName = params.displayName || 'Member';
      const displayNameProblem = displayNameError(displayName);
      if (displayNameProblem) {
        sendError(res, 400, displayNameProblem);
        return;
      }

      // Step 2 commit two: the group and plan come from the insurer's approval, never from this body.
      const result = await service.registerMemberFromEnrollment({
        walletId: String(params.walletId),
        ownershipProofJson: params.ownershipProofJson,
        displayName,
        relationship: params.relationship,
        publicKeyHex: params.publicKeyHex ? String(params.publicKeyHex) : undefined,
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      if (err instanceof RegistrationRefused) return sendError(res, err.status, err.message);
      sendError(res, 500, err instanceof Error ? err.message : String(err));
    }
  });

  // B1 step two: the member's device proves every change to its wallet. The engine queues the
  // update; the device fetches it, re-derives the root, proves and submits it, and reports the
  // receipt. Both routes take only the signature of the wallet they name.
  reg('GET', '/interactive/wallet-updates', async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const walletId = new URL(req.url ?? '/', 'http://localhost').searchParams.get('walletId') ?? '';
      if (!/^[0-9]+$/.test(walletId)) { sendError(res, 400, 'walletId (decimal) is required'); return; }
      const updates = service.walletUpdatesFor(walletId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        walletId,
        pending: updates.filter((u) => u.status === 'pending'),
        applied: updates.filter((u) => u.status === 'applied').slice(-20).map((u) => ({ updateId: u.updateId, reason: u.reason, receiptId: u.receiptId, appliedAt: u.appliedAt })),
      }));
    } catch (err) {
      sendError(res, 500, err instanceof Error ? err.message : String(err));
    }
  });

  reg('POST', '/interactive/wallet-update-applied', async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const params = JSON.parse(await readBody(req) || '{}');
      for (const field of ['walletId', 'updateId', 'receiptId']) {
        if (typeof params[field] !== 'string' || params[field].length === 0) { sendError(res, 400, `Missing ${field}`); return; }
      }
      const update = service.markWalletUpdateApplied(params.walletId, params.updateId, params.receiptId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ updateId: update.updateId, reason: update.reason, status: update.status, receiptId: update.receiptId }));
    } catch (err) {
      if (err instanceof RegistrationRefused) return sendError(res, err.status, err.message);
      sendError(res, 500, err instanceof Error ? err.message : String(err));
    }
  });

  // B1 step two, commit three: a member with a device names its primary-care prescriber. The engine
  // records it on the member's credential and queues the wallet update for the device to prove.
  // Wallet-signed: only the member's own key opens it. It runs under the proving lock (option A, step 1): a
  // fill reads the member's forest and credential before its 25-45 s proof and writes them after it, so a
  // choice recorded in between put a leaf the proof never saw into the update the fill queued. Nothing it
  // calls takes the lock, which is not re-entrant: it only queues the device's update, with no proof and no batch.
  reg('POST', '/interactive/pcp-assignment', async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const params = JSON.parse(await readBody(req) || '{}');
      for (const field of ['walletId', 'pcpWalletId', 'effectiveDate']) {
        if (typeof params[field] !== 'string' || params[field].length === 0) { sendError(res, 400, `Missing ${field}`); return; }
      }
      const result = await underProvingLock(req, res, () => service.assignPcpForDevice({
        walletId: String(params.walletId),
        pcpWalletId: String(params.pcpWalletId),
        effectiveDate: String(params.effectiveDate),
        specialty: typeof params.specialty === 'string' && params.specialty.length > 0 ? params.specialty : 'General Practice',
        consentScopeFlags: typeof params.consentScopeFlags === 'number' ? params.consentScopeFlags : 7,
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      if (err instanceof RegistrationRefused) return sendError(res, err.status, err.message);
      sendError(res, 500, err instanceof Error ? err.message : String(err));
    }
  });

  // B5: a member with a device authorizes a prescriber who is not its primary-care prescriber, for a
  // visit. Wallet-signed: only the member's own key grants it.
  reg('POST', '/interactive/prescriber-authorization', async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const params = JSON.parse(await readBody(req) || '{}');
      for (const field of ['walletId', 'prescriberWalletId']) {
        if (typeof params[field] !== 'string' || params[field].length === 0) { sendError(res, 400, `Missing ${field}`); return; }
      }
      const result = await service.authorizePrescriber({
        walletId: String(params.walletId),
        prescriberWalletId: String(params.prescriberWalletId),
        ndcHash: typeof params.ndcHash === 'string' && params.ndcHash.length > 0 ? params.ndcHash : null,
        hours: typeof params.hours === 'number' ? params.hours : undefined,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      if (err instanceof RegistrationRefused) return sendError(res, err.status, err.message);
      sendError(res, 500, err instanceof Error ? err.message : String(err));
    }
  });

  // POST /interactive/approve-member — the insurer approves a wallet for ELIGIBLE and names its plan
  // (Step 2 commit two; admin-gated, insurer role). register-member honours only approved wallets.
  reg('POST', '/interactive/approve-member', async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const params = JSON.parse(await readBody(req) || '{}');
      const decimal = /^\d+$/;
      if (typeof params.walletId !== 'string' || !decimal.test(params.walletId)
        || typeof params.groupIdHash !== 'string' || !decimal.test(params.groupIdHash)
        || typeof params.planIdHash !== 'string' || !decimal.test(params.planIdHash)
        || typeof params.planId !== 'string' || params.planId.length === 0 || params.planId.length > 64) {
        sendError(res, 400, 'Required: walletId, groupIdHash, planIdHash (decimal strings) and planId');
        return;
      }
      // A-34: the employer's opaque family hash from the enrollment code, or none.
      if (params.familyIdHash !== undefined && params.familyIdHash !== null
        && (typeof params.familyIdHash !== 'string' || !decimal.test(params.familyIdHash))) {
        sendError(res, 400, 'familyIdHash, when given, is a decimal string');
        return;
      }
      const result = service.approveMember({
        walletId: params.walletId,
        groupIdHash: params.groupIdHash,
        planIdHash: params.planIdHash,
        planId: params.planId,
        employerId: typeof params.employerId === 'string' ? params.employerId : null,
        familyIdHash: typeof params.familyIdHash === 'string' ? params.familyIdHash : null,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ...result, walletId: params.walletId }));
    } catch (err) {
      if (err instanceof RegistrationRefused) return sendError(res, err.status, err.message);
      sendError(res, 500, err instanceof Error ? err.message : String(err));
    }
  });

  // POST /interactive/enroll — kicks off enrollment, returns immediately
  reg('POST', '/interactive/enroll', async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const body = await readBody(req);
      const params = JSON.parse(body);
      const memberIndex = params.memberIndex;

      if (typeof memberIndex !== 'number') {
        sendError(res, 400, 'Missing or invalid memberIndex');
        return;
      }

      // If already running or complete, return current status
      const existing = enrollmentJobs.get(memberIndex);
      if (existing) {
        res.writeHead(200, {
          'Content-Type': 'application/json',
        });
        res.end(safeJsonStringify(existing, 'enroll'));
        return;
      }

      // Mark as pending and kick off in background
      enrollmentJobs.set(memberIndex, { status: 'pending' });

      service.getL2Node().withProvingLock(() => service.enrollMember(memberIndex))
        .then(async (result) => {
          enrollmentJobs.set(memberIndex, { status: 'complete', result });
          // Batch is now built inside enrollMember() (before admin lifecycle update)
          // so the pending pool is already drained. No need for forceBatch here.
        })
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          enrollmentJobs.set(memberIndex, { status: 'error', error: message });
        });

      res.writeHead(202, {
        'Content-Type': 'application/json',
      });
      res.end(safeJsonStringify({ status: 'pending', memberIndex }, 'enroll'));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, message);
    }
  });

  // GET /interactive/enroll-status?memberIndex=N — poll for enrollment result
  reg('GET', '/interactive/enroll-status', async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? '', `http://${req.headers.host}`);
      const memberIndex = parseInt(url.searchParams.get('memberIndex') ?? '', 10);

      if (isNaN(memberIndex)) {
        sendError(res, 400, 'Missing or invalid memberIndex query parameter');
        return;
      }

      const job = enrollmentJobs.get(memberIndex);
      if (!job) {
        res.writeHead(200, {
          'Content-Type': 'application/json',
        });
        res.end(JSON.stringify({ status: 'not_started' }));
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'application/json',
      });

      // Clear completed/errored jobs so re-enrollment is possible after reset
      if (job.status === 'complete' || job.status === 'error') {
        enrollmentJobs.delete(memberIndex);
      }

      res.end(safeJsonStringify(job, 'enroll-status'));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, message);
    }
  });

  // POST /interactive/request-prior-auth
  //
  // Two callers. A prescriber node signs the request as the prescriber's own wallet: the prescriber is the wallet that
  // signed (server.principalOf), and a body that names a prescriber is refused; the engine refuses a prescriber without
  // the member's consent, a drug that needs no prior authorization on the member's plan and a duplicate of a pending
  // request (requestPriorAuthAsPrescriber). The console's operator path: the operator's credential, the prescriber
  // named by its seed index, for the console's members (requestPriorAuth). Nobody else.
  reg('POST', '/interactive/request-prior-auth', async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const who = server.principalOf(req);
      const body = await readBody(req);
      let params: Record<string, unknown>;
      try {
        const parsed = JSON.parse(body || '{}') as unknown;
        params = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
      } catch {
        sendError(res, 400, 'The body is not JSON');
        return;
      }

      if (who?.kind === 'wallet') {
        if (params.prescriberIndex !== undefined || params.prescriberWalletId !== undefined) {
          sendError(res, 400, "A prescriber's own request names no prescriber: the engine takes the prescriber from the wallet that signed it");
          return;
        }
        if (typeof params.memberWalletId !== 'string' || !/^\d+$/.test(params.memberWalletId) ||
            typeof params.ndcHash !== 'string' || !/^\d+$/.test(params.ndcHash)) {
          sendError(res, 400, 'Missing required fields: memberWalletId and ndcHash, as decimal strings');
          return;
        }
        if (params.reason !== undefined && typeof params.reason !== 'string') {
          sendError(res, 400, 'reason is optional text');
          return;
        }
        const result = service.requestPriorAuthAsPrescriber({
          prescriberWalletId: who.walletId,
          memberWalletId: params.memberWalletId,
          ndcHash: params.ndcHash,
          quantity: params.quantity as number,
          reason: params.reason === undefined ? undefined : (params.reason as string).trim(),
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(safeJsonStringify(result));
        return;
      }

      if (who?.kind !== 'operator' && !(who?.kind === 'node' && who.role === 'operator')) {
        sendError(res, 403, "A prior authorization is requested by the prescriber, signed as the prescriber's own wallet, or by the operator");
        return;
      }
      // The console's operator path: the prescriber is named by its seed index
      if (typeof params.memberWalletId !== 'string' ||
          typeof params.prescriberIndex !== 'number' ||
          typeof params.ndcHash !== 'string') {
        sendError(res, 400, 'Missing required fields: memberWalletId, prescriberIndex, ndcHash');
        return;
      }

      const result = service.requestPriorAuth({
        memberWalletId: params.memberWalletId,
        prescriberIndex: params.prescriberIndex,
        ndcHash: params.ndcHash,
      });
      res.writeHead(200, {
        'Content-Type': 'application/json',
      });
      res.end(safeJsonStringify(result));
    } catch (err) {
      if (err instanceof RegistrationRefused) return sendError(res, err.status, err.message);
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, message);
    }
  });

  // GET /interactive/prior-auths?status=PENDING|RESOLVED|ALL — the prior-authorization requests for the plan's review:
  // the insurer node (its role) or the operator. Each names the member by wallet ID only, the drug, the quantity asked
  // for, the prescriber, the dates and both reasons.
  reg('GET', '/interactive/prior-auths', async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const status = (new URL(req.url ?? '/', 'http://localhost').searchParams.get('status') ?? 'ALL').toUpperCase();
      if (status !== 'PENDING' && status !== 'RESOLVED' && status !== 'ALL') {
        sendError(res, 400, 'status is PENDING, RESOLVED or ALL');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ priorAuths: service.listPriorAuths(status) }));
    } catch (err) {
      sendError(res, 500, err instanceof Error ? err.message : String(err));
    }
  });

  // GET /interactive/prior-auth-status?memberWalletId=&ndcHash= — a member's prior-authorization status for one drug.
  // A prescriber reads it signed as its own wallet and only with the member's consent (priorAuthStatusForPrescriber);
  // the operator reads any member's. The answer names no request ID.
  reg('GET', '/interactive/prior-auth-status', async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const who = server.principalOf(req);
      const query = new URL(req.url ?? '/', 'http://localhost').searchParams;
      const memberWalletId = query.get('memberWalletId') ?? '';
      const ndcHash = query.get('ndcHash') ?? '';
      if (!/^\d+$/.test(memberWalletId) || !/^\d+$/.test(ndcHash)) {
        sendError(res, 400, 'memberWalletId and ndcHash (decimal) are required');
        return;
      }
      let status;
      if (who?.kind === 'wallet') {
        status = service.priorAuthStatusForPrescriber(who.walletId, memberWalletId, ndcHash);
      } else if (who?.kind === 'operator' || (who?.kind === 'node' && who.role === 'operator')) {
        status = service.priorAuthStatusOf(memberWalletId, ndcHash);
      } else {
        sendError(res, 403, "A member's prior authorization is read by a prescriber with the member's consent, signed as its own wallet, or by the operator");
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ memberWalletId, ndcHash, ...status }));
    } catch (err) {
      if (err instanceof RegistrationRefused) return sendError(res, err.status, err.message);
      sendError(res, 500, err instanceof Error ? err.message : String(err));
    }
  });

  // POST /interactive/approve-prior-auth
  reg('POST', '/interactive/approve-prior-auth', async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const body = await readBody(req);
      const params = JSON.parse(body);

      if (typeof params.priorAuthId !== 'string') {
        sendError(res, 400, 'Missing required field: priorAuthId');
        return;
      }

      const result = await underProvingLock(req, res, () => service.approvePriorAuth(params.priorAuthId));
      res.writeHead(200, {
        'Content-Type': 'application/json',
      });
      res.end(safeJsonStringify(result));
      // Force batch to settle any pending transitions immediately
      service.forceBatch().catch(() => {});
    } catch (err) {
      // an unknown request 404; one already decided, or an approval of it already being proven, 409
      if (err instanceof RegistrationRefused) return sendError(res, err.status, err.message);
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, message);
    }
  });

  // POST /interactive/deny-prior-auth {priorAuthId, reason?} — the insurer's reason, at most 500 characters, goes to the
  // prescriber in the PA_RESPONSE message and into the review list, and is kept in memory only
  reg('POST', '/interactive/deny-prior-auth', async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const body = await readBody(req);
      const params = JSON.parse(body);

      if (typeof params.priorAuthId !== 'string') {
        sendError(res, 400, 'Missing required field: priorAuthId');
        return;
      }
      if (params.reason !== undefined && (typeof params.reason !== 'string' || params.reason.trim().length > 500)) {
        sendError(res, 400, 'reason is optional text of at most 500 characters');
        return;
      }
      const reason = typeof params.reason === 'string' && params.reason.trim().length > 0 ? params.reason.trim() : undefined;

      const result = service.denyPriorAuth(params.priorAuthId, reason);
      res.writeHead(200, {
        'Content-Type': 'application/json',
      });
      res.end(safeJsonStringify(result));
    } catch (err) {
      // a reason that is not plain text 400; an unknown request 404; one already decided, or being approved, 409
      if (err instanceof RegistrationRefused) return sendError(res, err.status, err.message);
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, message);
    }
  });

  // POST /interactive/resolve-indices — map walletIds/ndcHash to seed data indices
  // Used by entity Nautilus nodes to translate dashboard params into proof params.
  reg('POST', '/interactive/resolve-indices', async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const body = await readBody(req);
      const params = JSON.parse(body);

      let prescriberIndex = -1;
      let pharmacyIndex = -1;

      if (params.prescriberWalletId) {
        const pwid = String(params.prescriberWalletId);
        for (let i = 0; i < PRESCRIBERS.length; i++) {
          if (service.getPrescriberWalletId(i)?.toString() === pwid) {
            prescriberIndex = i;
            break;
          }
        }
      }

      if (params.pharmacyWalletId) {
        const phwid = String(params.pharmacyWalletId);
        for (let i = 0; i < PHARMACIES.length; i++) {
          if (service.getPharmacyWalletId(i)?.toString() === phwid) {
            pharmacyIndex = i;
            break;
          }
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ prescriberIndex, pharmacyIndex }));
    } catch (err) {
      sendError(res, 500, err instanceof Error ? err.message : String(err));
    }
  });

  // POST /interactive/prescribe
  reg('POST', '/interactive/prescribe', async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const body = await readBody(req);
      const params = JSON.parse(body);

      if (typeof params.prescriberIndex !== 'number' ||
          typeof params.memberWalletId !== 'string' ||
          typeof params.ndcHash !== 'string' ||
          typeof params.pharmacyIndex !== 'number') {
        sendError(res, 400, 'Missing required fields: prescriberIndex, memberWalletId, ndcHash, pharmacyIndex');
        return;
      }
      // The quantity counts the drug's NADAC pricing unit (EA, ML or GM), to thousandths
      const quantity = params.quantity ?? 30;
      const quantityProblem = quantityError(quantity);
      if (quantityProblem) {
        sendError(res, 400, quantityProblem);
        return;
      }

      const result = await underProvingLock(req, res, () => service.createPrescription({
        prescriberIndex: params.prescriberIndex,
        memberWalletId: params.memberWalletId,
        ndcHash: params.ndcHash,
        pharmacyIndex: params.pharmacyIndex,
        quantity,
        refills: params.refills ?? 3,
        rxId: params.rxId,  // optional: prescriber-supplied ID for cross-node ID consistency
      }));
      res.writeHead(200, {
        'Content-Type': 'application/json',
      });
      res.end(safeJsonStringify(result));
      // Force batch to settle prescription proof immediately
      service.forceBatch().catch(() => {});
    } catch (err) {
      if (err instanceof RegistrationRefused) return sendError(res, err.status, err.message);
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, message);
    }
  });

  // POST /interactive/fill — dispense step (backward-compat path; canonical name is dispensePrescription)
  interface FillJob { status: 'pending' | 'complete' | 'error'; result?: unknown; error?: string; completedAt?: number; }
  const fillJobs = new Map<string, FillJob>();
  const FILL_JOB_TTL_MS = 5 * 60 * 1000; // Keep completed jobs for 5 minutes

  reg('POST', '/interactive/fill', async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const body = await readBody(req);
      const params = JSON.parse(body);

      if (typeof params.prescriptionId !== 'string') {
        sendError(res, 400, 'Missing required field: prescriptionId');
        return;
      }
      // A quantity dispensed counts the drug's NADAC pricing unit, to thousandths; absent, the engine dispenses the quantity prescribed
      if (params.quantityDispensed !== undefined) {
        const quantityProblem = quantityError(params.quantityDispensed, 'quantityDispensed');
        if (quantityProblem) {
          sendError(res, 400, quantityProblem);
          return;
        }
      }
      const jobKey = params.prescriptionId;
      // D4: a job still running is shared with a second request for the same prescription (one dispense is one
      // event); a finished job, complete or failed, no longer stands in the way of the next request. Until D4 a
      // rejected attempt left its error in the map, and the next dispense of that prescription was answered with
      // that error as if it were its own result and never ran.
      const existing = fillJobs.get(jobKey);
      if (existing && existing.status === 'pending') {
        res.writeHead(202, {
          'Content-Type': 'application/json',
        });
        res.end(safeJsonStringify({ status: 'pending', prescriptionId: jobKey }, 'fill'));
        return;
      }

      // Mark as pending and kick off in background
      fillJobs.set(jobKey, { status: 'pending' });

      // Owner decision 2026-10-18: the pharmacy does not set the price. Costs in the request are only checked against
      // the engine's NADAC price; a fill that states different ones is refused before any proof.
      service.getL2Node().withProvingLock(() => service.dispensePrescription({
        prescriptionId: params.prescriptionId,
        quantityDispensed: params.quantityDispensed,
        statedIngredientCostCents: params.ingredientCostCents,
        statedDispensingFeeCents: params.dispensingFeeCents,
      }))
        .then(async (result) => {
          fillJobs.set(jobKey, { status: 'complete', result, completedAt: Date.now() });
          // Force batch to settle any pending transitions immediately
          try { await service.forceBatch(); } catch (e) { console.warn('[fill] forceBatch after fill:', e instanceof Error ? e.message : e); }
        })
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          fillJobs.set(jobKey, { status: 'error', error: message, completedAt: Date.now() });
        });

      res.writeHead(202, {
        'Content-Type': 'application/json',
      });
      res.end(safeJsonStringify({ status: 'pending', prescriptionId: jobKey }, 'fill'));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, message);
    }
  });

  // GET /interactive/fill-status?prescriptionId=X — poll for fill result
  reg('GET', '/interactive/fill-status', async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? '', `http://${req.headers.host}`);
      const prescriptionId = url.searchParams.get('prescriptionId') ?? '';

      if (!prescriptionId) {
        sendError(res, 400, 'Missing prescriptionId query parameter');
        return;
      }

      const job = fillJobs.get(prescriptionId);

      if (!job) {
        res.writeHead(200, {
          'Content-Type': 'application/json',
        });
        res.end(JSON.stringify({ status: 'not_started' }));
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'application/json',
      });

      // Prune old completed jobs (TTL-based, not delete-on-read)
      const now = Date.now();
      for (const [k, j] of fillJobs) {
        if (j.completedAt && now - j.completedAt > FILL_JOB_TTL_MS) {
          fillJobs.delete(k);
        }
      }

      res.end(safeJsonStringify(job, 'fill-status'));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, message);
    }
  });

  // GET /interactive/prescriptions-by-pharmacy?pharmacyIndex=N — all prescriptions for a pharmacy
  reg('GET', '/interactive/prescriptions-by-pharmacy', async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? '', `http://${req.headers.host}`);
      const pharmacyIndex = parseInt(url.searchParams.get('pharmacyIndex') ?? '', 10);
      if (isNaN(pharmacyIndex) || service.getPharmacyWalletId(pharmacyIndex) === undefined) {
        sendError(res, 400, 'Missing or unknown pharmacyIndex');
        return;
      }
      const prescriptions = service.getPrescriptionsByPharmacy(pharmacyIndex);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(safeJsonStringify({ prescriptions }, 'prescriptions-by-pharmacy'));
    } catch (err: any) {
      sendError(res, 500, err.message);
    }
  });

  // POST /interactive/mark-filled — pharmacist marks prescription as physically prepared
  reg('POST', '/interactive/mark-filled', async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const body = await readBody(req);
      const params = JSON.parse(body);
      if (!params.prescriptionId) {
        sendError(res, 400, 'Missing prescriptionId');
        return;
      }
      const result = service.markFilled({ prescriptionId: params.prescriptionId });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(safeJsonStringify(result, 'mark-filled'));
    } catch (err: any) {
      sendError(res, 500, err.message);
    }
  });

  // POST /interactive/prescribe-and-fill — combined prescribe + fill for pharmacy PAID flow
  // Passes ndcHash directly, creates prescription, then fills it (async).
  // Accepts: { memberWalletId, ndcHash, prescriberWalletId?, pharmacyIndex?, quantity?, prescriberIndex? }
  reg('POST', '/interactive/prescribe-and-fill', async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const body = await readBody(req);
      const params = JSON.parse(body);

      if (!params.memberWalletId || !params.ndcHash) {
        sendError(res, 400, 'Missing required fields: memberWalletId, ndcHash');
        return;
      }

      const ndcHashStr = String(params.ndcHash);

      // A provider is named by its seed index, or the prescriber by a wallet the engine has a seed for. One the
      // engine does not know is refused: the old default to index 0 put another provider's name on the claim.
      let prescriberIndex = typeof params.prescriberIndex === 'number' ? params.prescriberIndex : -1;
      if (prescriberIndex < 0 && params.prescriberWalletId != null) {
        const pwid = String(params.prescriberWalletId);
        for (let i = 0; i < PRESCRIBERS.length; i++) {
          if (service.getPrescriberWalletId(i)?.toString() === pwid) {
            prescriberIndex = i;
            break;
          }
        }
        if (prescriberIndex < 0) {
          sendError(res, 409, `Prescriber ${pwid} is not a provider this engine can adjudicate for`);
          return;
        }
      }
      if (service.getPrescriberWalletId(prescriberIndex) === undefined) {
        sendError(res, 400, 'Missing or unknown prescriber: send prescriberIndex or a known prescriberWalletId');
        return;
      }
      const pharmacyIndex = params.pharmacyIndex;
      if (typeof pharmacyIndex !== 'number' || service.getPharmacyWalletId(pharmacyIndex) === undefined) {
        sendError(res, 400, 'Missing or unknown pharmacyIndex');
        return;
      }
      const quantity = params.quantity ?? 30;
      const quantityDispensed = params.quantityDispensed ?? quantity;
      const refills = params.refills ?? 3;
      // Quantities count the drug's NADAC pricing unit (EA, ML or GM), to thousandths
      const quantityProblem = quantityError(quantity) ?? quantityError(quantityDispensed, 'quantityDispensed');
      if (quantityProblem) {
        sendError(res, 400, quantityProblem);
        return;
      }
      // Owner decision 2026-10-18: the pharmacy does not set the price. A request that states costs must state the
      // engine's NADAC price; checked here, before the prescription's proofs, and again at the dispense.
      if (params.ingredientCostCents != null || params.dispensingFeeCents != null) {
        const quoted = priceDispense(service.quoteFill(String(params.memberWalletId), ndcHashStr), quantityDispensed);
        const mismatch = statedCostMismatch(quoted, { ingredientCostCents: params.ingredientCostCents, dispensingFeeCents: params.dispensingFeeCents });
        if (mismatch) { sendError(res, 409, mismatch); return; }
      }

      // Build a job key from the claim data
      const jobKey = `pf_${params.memberWalletId}_${ndcHashStr}_${Date.now()}`;

      // Check if already running
      const existing = fillJobs.get(jobKey);
      if (existing) {
        res.writeHead(200, {
          'Content-Type': 'application/json',
        });
        res.end(safeJsonStringify({ ...existing, prescriptionId: jobKey }, 'prescribe-and-fill'));
        return;
      }

      fillJobs.set(jobKey, { status: 'pending' });

      // Run prescribe + fill in background
      service.getL2Node().withProvingLock(async () => {
        // Step 1: Create prescription
        const rxResult = await service.createPrescription({
          prescriberIndex,
          memberWalletId: params.memberWalletId,
          ndcHash: ndcHashStr,
          pharmacyIndex,
          quantity,
          refills,
        }) as { prescriptionId?: string };

        const prescriptionId = rxResult.prescriptionId;
        if (!prescriptionId) throw new Error('Prescription creation did not return prescriptionId');

        // Step 2: Fill the prescription
        const fillResult = await service.dispensePrescription({
          prescriptionId,
          quantityDispensed,
          statedIngredientCostCents: params.ingredientCostCents,
          statedDispensingFeeCents: params.dispensingFeeCents,
        });

        return fillResult;
      })
        .then(async (result) => {
          fillJobs.set(jobKey, { status: 'complete', result });
          try { await service.forceBatch(); } catch (e) { console.warn('[prescribe-and-fill] forceBatch:', e instanceof Error ? e.message : e); }
        })
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          fillJobs.set(jobKey, { status: 'error', error: message });
        });

      res.writeHead(202, {
        'Content-Type': 'application/json',
      });
      res.end(safeJsonStringify({ status: 'pending', prescriptionId: jobKey }, 'prescribe-and-fill'));
    } catch (err) {
      if (err instanceof RegistrationRefused) return sendError(res, err.status, err.message);
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, message);
    }
  });

  // POST /interactive/update-rx-status
  //
  // Under the proving lock (option A, step 1): a fill and a reversal read the prescription's status before their proofs
  // and write their own after them without reading it again, so a status recorded in between (a prescriber's
  // cancellation) was overwritten when the proof ended, and lost without a word. Now it waits and applies to the
  // prescription as the fill or reversal left it, where the engine's state rules decide it: a dispensed prescription can
  // no longer be cancelled, and the caller is told so. The status change is synchronous and takes no lock itself, which
  // matters because the lock is not re-entrant.
  reg('POST', '/interactive/update-rx-status', async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const body = await readBody(req);
      const params = JSON.parse(body);

      if (typeof params.prescriptionId !== 'string' ||
          typeof params.newStatus !== 'string' ||
          typeof params.role !== 'string' ||
          typeof params.actorIndex !== 'number') {
        sendError(res, 400, 'Missing required fields: prescriptionId, newStatus, role, actorIndex');
        return;
      }

      if (!['CANCELLED', 'REJECTED', 'COMPLETED', 'DISPENSED'].includes(params.newStatus)) {
        sendError(res, 400, 'newStatus must be CANCELLED, REJECTED, COMPLETED, or DISPENSED');
        return;
      }

      if (!['prescriber', 'pharmacy'].includes(params.role)) {
        sendError(res, 400, 'role must be prescriber or pharmacy');
        return;
      }

      const result = await underProvingLock(req, res, async () => service.updateRxStatus({
        prescriptionId: params.prescriptionId,
        newStatus: params.newStatus,
        role: params.role,
        actorIndex: params.actorIndex,
        note: params.note,
      }));
      res.writeHead(200, {
        'Content-Type': 'application/json',
      });
      res.end(safeJsonStringify(result));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, message);
    }
  });

  // POST /interactive/reverse
  reg('POST', '/interactive/reverse', async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const body = await readBody(req);
      const params = JSON.parse(body);

      if (typeof params.prescriptionId !== 'string') {
        sendError(res, 400, 'Missing required field: prescriptionId');
        return;
      }

      const result = await underProvingLock(req, res, () => service.reversePrescription({
        prescriptionId: params.prescriptionId,
        fillIndex: params.fillIndex,
        reason: params.reason,
      }));
      res.writeHead(200, {
        'Content-Type': 'application/json',
      });
      res.end(safeJsonStringify(result));
      // Force batch to settle any pending transitions immediately
      service.forceBatch().catch(() => {});
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, message);
    }
  });

  // POST /interactive/assign-pcp
  reg('POST', '/interactive/assign-pcp', async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const body = await readBody(req);
      const params = JSON.parse(body);

      if (typeof params.memberWalletId !== 'string' || typeof params.prescriberIndex !== 'number') {
        sendError(res, 400, 'Missing required fields: memberWalletId, prescriberIndex');
        return;
      }

      const result = await underProvingLock(req, res, () => service.assignPcp({
        memberWalletId: params.memberWalletId,
        prescriberIndex: params.prescriberIndex,
      }));
      res.writeHead(200, {
        'Content-Type': 'application/json',
      });
      res.end(safeJsonStringify(result));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, message);
    }
  });

  // GET /interactive/member-history
  reg('GET', '/interactive/member-history', async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url!, `http://${req.headers.host}`);
      const walletId = url.searchParams.get('walletId');

      if (!walletId) {
        sendError(res, 400, 'Missing required query parameter: walletId');
        return;
      }

      const result = service.getMemberHistory({ memberWalletId: walletId });
      res.writeHead(200, {
        'Content-Type': 'application/json',
      });
      res.end(safeJsonStringify(result));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, message);
    }
  });

  // POST /interactive/enroll-family
  reg('POST', '/interactive/enroll-family', async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const body = await readBody(req);
      const params = JSON.parse(body);
      const subscriberIndex = params.subscriberIndex;

      if (typeof subscriberIndex !== 'number') {
        sendError(res, 400, 'Missing or invalid subscriberIndex');
        return;
      }

      const result = await underProvingLock(req, res, () => service.enrollFamily(subscriberIndex));
      res.writeHead(200, {
        'Content-Type': 'application/json',
      });
      res.end(safeJsonStringify(result));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, message);
    }
  });

  // GET /interactive/family-history
  reg('GET', '/interactive/family-history', async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url!, `http://${req.headers.host}`);
      const walletId = url.searchParams.get('walletId');

      if (!walletId) {
        sendError(res, 400, 'Missing required query parameter: walletId');
        return;
      }

      const result = service.getFamilyHistory({ memberWalletId: walletId });
      res.writeHead(200, {
        'Content-Type': 'application/json',
      });
      res.end(safeJsonStringify(result));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, message);
    }
  });

  // POST /interactive/terminate-member
  //
  // Under the proving lock (option A, step 1), as terminate-group is: a termination during a fill's proof flipped revoked
  // into the credential the fill then queued, and the fill overwrote the termination's cancellation of its prescription.
  // The termination is synchronous and takes no lock itself, which matters because the lock is not re-entrant.
  reg('POST', '/interactive/terminate-member', async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const body = await readBody(req);
      const params = JSON.parse(body);

      if (typeof params.memberWalletId !== 'string') {
        sendError(res, 400, 'Missing required field: memberWalletId');
        return;
      }

      const result = await underProvingLock(req, res, async () => service.terminateMember({
        memberWalletId: params.memberWalletId,
        terminationDate: params.terminationDate,
      }));
      res.writeHead(200, {
        'Content-Type': 'application/json',
      });
      res.end(safeJsonStringify(result));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, message);
    }
  });

  // POST /interactive/terminate-group — each member's termination, under the proving lock as terminate-member's is
  reg('POST', '/interactive/terminate-group', async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const body = await readBody(req);
      const params = JSON.parse(body);

      if (typeof params.groupId !== 'string') {
        sendError(res, 400, 'Missing required field: groupId');
        return;
      }

      const result = await underProvingLock(req, res, async () => service.terminateGroup({
        groupId: params.groupId,
        terminationDate: params.terminationDate,
      }));
      res.writeHead(200, {
        'Content-Type': 'application/json',
      });
      res.end(safeJsonStringify(result));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, message);
    }
  });

  // POST /interactive/send-message
  reg('POST', '/interactive/send-message', async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const body = await readBody(req);
      const params = JSON.parse(body);

      if (!params.senderType || !params.recipientType || !params.subject || !params.body) {
        sendError(res, 400, 'Missing required fields: senderType, recipientType, subject, body');
        return;
      }

      const result = await underProvingLock(req, res, () => service.sendMessage(params));
      res.writeHead(200, {
        'Content-Type': 'application/json',
      });
      res.end(safeJsonStringify(result));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, message);
    }
  });

  // POST /interactive/decrypt-thread — batch decrypt messages in a thread
  reg('POST', '/interactive/decrypt-thread', async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const body = await readBody(req);
      const params = JSON.parse(body);

      if (!Array.isArray(params.messageIndices) || !params.walletId) {
        sendError(res, 400, 'Missing required fields: messageIndices (array), walletId');
        return;
      }

      const result = service.decryptThread(params.messageIndices, params.walletId);
      res.writeHead(200, {
        'Content-Type': 'application/json',
      });
      res.end(safeJsonStringify(result));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, message);
    }
  });

  // GET /interactive/threads — get conversation threads for a wallet
  reg('GET', '/interactive/threads', async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
      const walletId = url.searchParams.get('walletId');

      if (!walletId) {
        sendError(res, 400, 'Missing required query parameter: walletId');
        return;
      }

      const result = service.getThreads(walletId);
      res.writeHead(200, {
        'Content-Type': 'application/json',
      });
      res.end(safeJsonStringify(result));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, message);
    }
  });

  // POST /interactive/create-delegation
  reg('POST', '/interactive/create-delegation', async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const body = await readBody(req);
      const params = JSON.parse(body);

      if (!params.delegatorWalletId || !params.delegateWalletId ||
          typeof params.scopeFlags !== 'number' || typeof params.relationshipCode !== 'number') {
        sendError(res, 400, 'Missing required fields: delegatorWalletId, delegateWalletId, scopeFlags, relationshipCode');
        return;
      }

      const result = await underProvingLock(req, res, () => service.createDelegation(params));
      res.writeHead(200, {
        'Content-Type': 'application/json',
      });
      res.end(safeJsonStringify(result));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, message);
    }
  });

  // ─── Async Credential Generation ──────────────────────────
  // Credential generation runs ZK proofs (ProofGate + CredentialProgram) which can take 30-60s.
  // Same fire-and-forget + poll pattern as enrollment.
  const credentialJobs = new Map<string, { status: 'pending' | 'complete' | 'error'; result?: unknown; error?: string }>();

  // POST /interactive/generate-credential — kicks off, returns immediately
  reg('POST', '/interactive/generate-credential', async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const body = await readBody(req);
      const params = JSON.parse(body);
      if (!params.walletId) {
        sendError(res, 400, 'Missing required field: walletId');
        return;
      }

      const proofType = params.proofType || 'holding';
      const jobKey = `${params.walletId}:${proofType}`;

      // If already running or complete, return current status
      const existing = credentialJobs.get(jobKey);
      if (existing) {
        res.writeHead(200, {
          'Content-Type': 'application/json',
        });
        res.end(safeJsonStringify(existing, 'generate-credential'));
        return;
      }

      // Mark as pending and kick off in background
      credentialJobs.set(jobKey, { status: 'pending' });

      service.getL2Node().withProvingLock(() => service.generateCredential(params.walletId, proofType))
        .then((result) => {
          credentialJobs.set(jobKey, { status: 'complete', result });
        })
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          credentialJobs.set(jobKey, { status: 'error', error: message });
        });

      res.writeHead(202, {
        'Content-Type': 'application/json',
      });
      res.end(safeJsonStringify({ status: 'pending', walletId: params.walletId, proofType }, 'generate-credential'));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, message);
    }
  });

  // GET /interactive/credential-status?walletId=X&proofType=Y — poll for credential result
  reg('GET', '/interactive/credential-status', async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? '', `http://${req.headers.host}`);
      const walletId = url.searchParams.get('walletId') ?? '';
      const proofType = url.searchParams.get('proofType') ?? 'holding';

      if (!walletId) {
        sendError(res, 400, 'Missing walletId query parameter');
        return;
      }

      const jobKey = `${walletId}:${proofType}`;
      const job = credentialJobs.get(jobKey);

      if (!job) {
        res.writeHead(200, {
          'Content-Type': 'application/json',
        });
        res.end(JSON.stringify({ status: 'not_started' }));
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'application/json',
      });

      // Clear completed/errored jobs so regeneration is possible
      if (job.status === 'complete' || job.status === 'error') {
        credentialJobs.delete(jobKey);
      }

      res.end(safeJsonStringify(job, 'credential-status'));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, message);
    }
  });

  // POST /interactive/verify-credential
  reg('POST', '/interactive/verify-credential', async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const body = await readBody(req);
      const params = JSON.parse(body);
      if (!params.credentialJson) {
        sendError(res, 400, 'Missing required field: credentialJson');
        return;
      }
      const result = await underProvingLock(req, res, () => service.verifyCredential(params.credentialJson));
      res.writeHead(200, {
        'Content-Type': 'application/json',
      });
      res.end(safeJsonStringify(result));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, message);
    }
  });

  // POST /interactive/update-formulary
  reg('POST', '/interactive/update-formulary', async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const body = await readBody(req);
      const params = JSON.parse(body);

      if (typeof params.ndcHash !== 'string' ||
          !['MODIFY', 'REMOVE', 'ADD'].includes(params.action)) {
        sendError(res, 400, 'Missing required fields: ndcHash, action (MODIFY|REMOVE|ADD)');
        return;
      }

      const result = await underProvingLock(req, res, () => service.updateFormularyEntry(params));
      res.writeHead(200, {
        'Content-Type': 'application/json',
      });
      res.end(safeJsonStringify(result));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, message);
    }
  });

  // POST /interactive/update-provider-network
  reg('POST', '/interactive/update-provider-network', async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const body = await readBody(req);
      const params = JSON.parse(body);

      if (typeof params.prescriberWalletId !== 'string' ||
          !['ADD', 'REMOVE'].includes(params.action)) {
        sendError(res, 400, 'Missing required fields: prescriberWalletId, action (ADD|REMOVE)');
        return;
      }

      const result = await underProvingLock(req, res, () => service.updateProviderNetwork(params));
      res.writeHead(200, {
        'Content-Type': 'application/json',
      });
      res.end(safeJsonStringify(result));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, message);
    }
  });

  // POST /interactive/plan-year-rollover
  reg('POST', '/interactive/plan-year-rollover', async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const body = await readBody(req);
      const params = JSON.parse(body);

      if (typeof params.newPlanYear !== 'string') {
        sendError(res, 400, 'Missing required field: newPlanYear');
        return;
      }

      const result = await underProvingLock(req, res, () => service.planYearRollover(params));
      res.writeHead(200, {
        'Content-Type': 'application/json',
      });
      res.end(safeJsonStringify(result));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, message);
    }
  });

  // GET /interactive/step-therapy-check
  reg('GET', '/interactive/step-therapy-check', async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url!, `http://${req.headers.host}`);
      const walletId = url.searchParams.get('memberWalletId');
      const ndcHash = url.searchParams.get('ndcHash');

      if (!walletId || !ndcHash) {
        sendError(res, 400, 'Missing query params: memberWalletId, ndcHash');
        return;
      }

      const result = service.checkStepTherapy(walletId, ndcHash);
      res.writeHead(200, {
        'Content-Type': 'application/json',
      });
      res.end(safeJsonStringify(result));
    } catch (err) {
      // plan-bound formularies: a drug off the member's plan is refused with its own status (403), not a server error
      if (err instanceof RegistrationRefused) return sendError(res, err.status, err.message);
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, message);
    }
  });

  // ─── L2 Chain Routes ──────────────────────────────────────

  // GET /interactive/l2-status — the chain status the operator console's sequencer tab shows; the operator's only
  // (GATED_READS): it lists every receipt's wallet and the whole audit log with each claim's parties
  reg('GET', '/interactive/l2-status', async (_req: IncomingMessage, res: ServerResponse) => {
    const rawStatus = service.getL2Node().getStatus();
    const seq = service.getL2Node().getSequencer();
    // Sanitize bigints for JSON serialization
    const status = {
      ...rawStatus,
      inFlightBatch: rawStatus.inFlightBatch !== null ? Number(rawStatus.inFlightBatch) : null,
    };
    const receipts = seq.getAllReceipts().map(r => ({
      ...r,
      sequenceNumber: Number(r.sequenceNumber),
      l2BlockNumber: r.l2BlockNumber !== undefined ? Number(r.l2BlockNumber) : undefined,
      l1BatchNumber: r.l1BatchNumber !== undefined ? Number(r.l1BatchNumber) : undefined,
      claimLeafIndex: r.claimLeafIndex !== undefined ? Number(r.claimLeafIndex) : undefined,
    }));
    const batches = seq.getAllBatches().map(b => ({
      ...b,
      batchNumber: Number(b.batchNumber),
      blockNumbers: b.blockNumbers.map(Number),
      blockHeight: b.blockHeight !== undefined ? Number(b.blockHeight) : undefined,
    }));
    const auditLog = seq.getAuditLog();
    const sanitizedEvents = auditLog.events.map(e => ({
      ...e,
      sequenceNumber: Number(e.sequenceNumber),
      l2BlockNumber: e.l2BlockNumber !== undefined ? Number(e.l2BlockNumber) : undefined,
      l1BatchNumber: e.l1BatchNumber !== undefined ? Number(e.l1BatchNumber) : undefined,
    }));
    res.writeHead(200, {
      'Content-Type': 'application/json',
    });
    res.end(safeJsonStringify({
      status,
      receipts,
      batches,
      auditLog: { ...auditLog, events: sanitizedEvents, eventCount: Number(auditLog.eventCount) },
    }, 'l2-status'));
  });

  // POST /interactive/force-batch
  reg('POST', '/interactive/force-batch', async (_req: IncomingMessage, res: ServerResponse) => {
    try {
      const batch = await service.forceBatch();
      res.writeHead(200, {
        'Content-Type': 'application/json',
      });
      res.end(safeJsonStringify({
        ok: true,
        batch: batch ? { batchNumber: Number((batch as any).batchNumber), transitionCount: (batch as any).transitionCount } : null,
        message: batch ? 'Batch built and settled' : 'No pending proofs to batch',
      }, 'force-batch'));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    }
  });

  // POST /interactive/save-checkpoint
  reg('POST', '/interactive/save-checkpoint', async (_req: IncomingMessage, res: ServerResponse) => {
    try {
      const filename = await service.saveCheckpoint();
      res.writeHead(200, {
        'Content-Type': 'application/json',
      });
      res.end(safeJsonStringify({ ok: true, filename, message: filename ? `Checkpoint saved: ${filename}` : 'No checkpoint store configured' }, 'save-checkpoint'));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    }
  });

  // POST /interactive/retry-batch
  reg('POST', '/interactive/retry-batch', async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const seq = service.getL2Node().getSequencer();
      // Auto-detect latest failed batch if no body provided
      let batchNumber: bigint;
      const rawBody = await readBody(req);
      if (rawBody.trim()) {
        const body = JSON.parse(rawBody);
        batchNumber = BigInt(body.batchNumber);
      } else {
        const failedBatch = seq.getAllBatches().find(b => b.l1Status === 'failed');
        if (!failedBatch) throw new Error('No failed batches to retry');
        batchNumber = failedBatch.batchNumber;
      }
      const batch = seq.retryBatch(batchNumber);
      res.writeHead(200, {
        'Content-Type': 'application/json',
      });
      res.end(safeJsonStringify({ ok: true, batchNumber: Number(batch.batchNumber), l1Status: batch.l1Status, message: `Batch ${batch.batchNumber} retried` }, 'retry-batch'));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    }
  });

  // POST /interactive/simulate-batch-failure
  reg('POST', '/interactive/simulate-batch-failure', async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const seq = service.getL2Node().getSequencer();
      // Auto-detect latest settled batch if no body provided
      let batchNumber: bigint;
      const rawBody = await readBody(req);
      if (rawBody.trim()) {
        const body = JSON.parse(rawBody);
        batchNumber = BigInt(body.batchNumber);
      } else {
        const allBatches = seq.getAllBatches();
        const settledBatch = [...allBatches].reverse().find(b => b.l1Status === 'settled');
        if (!settledBatch) throw new Error('No settled batches to simulate failure on');
        batchNumber = settledBatch.batchNumber;
      }
      seq.markBatchFailed(batchNumber, 'Simulated L1 settlement failure');
      res.writeHead(200, {
        'Content-Type': 'application/json',
      });
      res.end(safeJsonStringify({ ok: true, message: `Batch ${batchNumber} marked as failed` }, 'simulate-failure'));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    }
  });

  // POST /interactive/reset
  //
  // Under the proving lock (option A, step 1): a reset during a proof cleared the records the proving request then wrote
  // to, so a fill caught by it committed its claim and queued its wallet update for a member the engine no longer held.
  // The reset is synchronous and takes no lock itself, which matters because the lock is not re-entrant.
  reg('POST', '/interactive/reset', async (req: IncomingMessage, res: ServerResponse) => {
    await underProvingLock(req, res, async () => {
      service.reset();
      enrollmentJobs.clear();
      credentialJobs.clear();
    });
    res.writeHead(200, {
      'Content-Type': 'application/json',
    });
    res.end(safeJsonStringify({ ok: true, message: 'Session reset. Ready for new enrollments.' }, 'reset'));
  });

  // ─── Entity Node Dashboard Routes ────────────────────────

  // GET /node/state — session state + seed data for entity dashboards
  reg('GET', '/node/state', async (_req: IncomingMessage, res: ServerResponse) => {
    try {
      const state = service.getState();

      res.writeHead(200, {
        'Content-Type': 'application/json',
      });
      res.end(safeJsonStringify({
        ...state,
        prescribers: PRESCRIBERS.map((p, i) => ({
          index: i,
          firstName: p.firstName,
          lastName: p.lastName,
          credential: p.credential,
          specialty: p.specialty,
          npi: p.localData.prescriberId,
          state: p.state,
          deaNumber: p.deaNumber,
        })),
        pharmacies: PHARMACIES.map((p, i) => ({
          index: i,
          storeName: p.storeName,
          chain: p.chain,
          pharmacyType: p.pharmacyTypeDesc,
          npi: p.localData.serviceProviderId,
          ncpdpId: p.ncpdpProviderId,
          address: p.address,
          city: p.city,
          state: p.state,
          phone: p.phone,
        })),
        medications: MEDICATIONS.map((m, i) => ({
          index: i,
          brandName: m.brandName,
          genericName: m.genericName,
          strength: m.strength,
          ndc: m.ndc,
          tier: m.formularyEntry.tierLevel,
          // what a fill is priced at: NADAC per pricing unit (EA, ML or GM); the pharmacy console's formulary lists it
          nadacPerUnit: m.nadacPerUnit,
          pricingUnit: m.pricingUnit,
        })),
      }, 'node-state'));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, message);
    }
  });

  // GET /node/claims-by-member?walletId=X — claim history for a member
  reg('GET', '/node/claims-by-member', async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url!, `http://${req.headers.host}`);
      const walletId = url.searchParams.get('walletId');

      if (!walletId) {
        sendError(res, 400, 'Missing required query parameter: walletId');
        return;
      }

      const seq = service.getL2Node().getSequencer();
      const claims = seq.getClaimsByMember(walletId);

      res.writeHead(200, {
        'Content-Type': 'application/json',
      });
      res.end(safeJsonStringify({ claims }, 'claims-by-member'));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, message);
    }
  });

  // GET /node/claims-by-prescriber?walletId=X — claims by prescriber
  reg('GET', '/node/claims-by-prescriber', async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url!, `http://${req.headers.host}`);
      const walletId = url.searchParams.get('walletId');

      if (!walletId) {
        sendError(res, 400, 'Missing required query parameter: walletId');
        return;
      }

      const seq = service.getL2Node().getSequencer();
      const claims = seq.getClaimsByPrescriber(walletId);

      res.writeHead(200, {
        'Content-Type': 'application/json',
      });
      res.end(safeJsonStringify({ claims }, 'claims-by-prescriber'));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, message);
    }
  });

  // GET /node/claims-by-pharmacy?walletId=X — claims by pharmacy
  reg('GET', '/node/claims-by-pharmacy', async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url!, `http://${req.headers.host}`);
      const walletId = url.searchParams.get('walletId');

      if (!walletId) {
        sendError(res, 400, 'Missing required query parameter: walletId');
        return;
      }

      const seq = service.getL2Node().getSequencer();
      const claims = seq.getClaimsByPharmacy(walletId);

      res.writeHead(200, {
        'Content-Type': 'application/json',
      });
      res.end(safeJsonStringify({ claims }, 'claims-by-pharmacy'));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, message);
    }
  });

  // GET /node/claims-by-ndc?ndcHash=X — claims by drug
  reg('GET', '/node/claims-by-ndc', async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url!, `http://${req.headers.host}`);
      const ndcHash = url.searchParams.get('ndcHash');

      if (!ndcHash) {
        sendError(res, 400, 'Missing required query parameter: ndcHash');
        return;
      }

      const seq = service.getL2Node().getSequencer();
      const claims = seq.getClaimsByNdc(ndcHash);

      res.writeHead(200, {
        'Content-Type': 'application/json',
      });
      res.end(safeJsonStringify({ claims }, 'claims-by-ndc'));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, message);
    }
  });

  // GET /node/receipts-by-wallet?walletId=X — receipts for a wallet
  reg('GET', '/node/receipts-by-wallet', async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url!, `http://${req.headers.host}`);
      const walletId = url.searchParams.get('walletId');

      if (!walletId) {
        sendError(res, 400, 'Missing required query parameter: walletId');
        return;
      }

      const seq = service.getL2Node().getSequencer();
      const receipts = seq.getReceiptsByWallet(walletId);

      res.writeHead(200, {
        'Content-Type': 'application/json',
      });
      res.end(safeJsonStringify({ receipts }, 'receipts-by-wallet'));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, message);
    }
  });

  // GET /node/dur?memberWalletId=X — cross-pharmacy DUR for a patient
  reg('GET', '/node/dur', async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url!, `http://${req.headers.host}`);
      const memberWalletId = url.searchParams.get('memberWalletId');

      if (!memberWalletId) {
        sendError(res, 400, 'Missing required query parameter: memberWalletId');
        return;
      }

      const seq = service.getL2Node().getSequencer();
      // DUR is essentially the member's claim history across all pharmacies
      const claims = seq.getClaimsByMember(memberWalletId);

      res.writeHead(200, {
        'Content-Type': 'application/json',
      });
      res.end(safeJsonStringify({
        memberWalletId,
        claims,
        claimCount: claims.length,
      }, 'dur'));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, message);
    }
  });

  // GET /node/claim-proof?leafIndex=N — claim + Merkle proof
  reg('GET', '/node/claim-proof', async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url!, `http://${req.headers.host}`);
      const leafIndexStr = url.searchParams.get('leafIndex');

      if (!leafIndexStr) {
        sendError(res, 400, 'Missing required query parameter: leafIndex');
        return;
      }

      const leafIndex = BigInt(leafIndexStr);
      const seq = service.getL2Node().getSequencer();
      const result = seq.getClaimWithProof(leafIndex);

      res.writeHead(200, {
        'Content-Type': 'application/json',
      });
      res.end(safeJsonStringify(result, 'claim-proof'));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, message);
    }
  });

  // GET /node/formulary?planIdHash=X — formulary data for a plan
  reg('GET', '/node/formulary', async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url!, `http://${req.headers.host}`);
      const planIdHash = url.searchParams.get('planIdHash');

      if (!planIdHash) {
        sendError(res, 400, 'Missing required query parameter: planIdHash');
        return;
      }

      const seq = service.getL2Node().getSequencer();
      const formulary = seq.getFormulary(planIdHash);

      res.writeHead(200, {
        'Content-Type': 'application/json',
      });
      res.end(safeJsonStringify(formulary, 'formulary'));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, message);
    }
  });

  // GET /node/all-receipts — all receipts (insurer view)
  reg('GET', '/node/all-receipts', async (_req: IncomingMessage, res: ServerResponse) => {
    try {
      const seq = service.getL2Node().getSequencer();
      const receipts = seq.getAllReceipts();

      res.writeHead(200, {
        'Content-Type': 'application/json',
      });
      res.end(safeJsonStringify({ receipts }, 'all-receipts'));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, message);
    }
  });

  // GET /node/all-batches — all batches (insurer view)
  reg('GET', '/node/all-batches', async (_req: IncomingMessage, res: ServerResponse) => {
    try {
      const seq = service.getL2Node().getSequencer();
      const batches = seq.getAllBatches();

      res.writeHead(200, {
        'Content-Type': 'application/json',
      });
      res.end(safeJsonStringify({ batches }, 'all-batches'));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, message);
    }
  });

  // GET /node/audit-log — audit log (insurer view)
  reg('GET', '/node/audit-log', async (_req: IncomingMessage, res: ServerResponse) => {
    try {
      const seq = service.getL2Node().getSequencer();
      const auditLog = seq.getAuditLog();
      const sanitized = {
        ...auditLog,
        eventCount: Number(auditLog.eventCount),
        events: auditLog.events.map(e => ({
          ...e,
          sequenceNumber: Number(e.sequenceNumber),
          l2BlockNumber: e.l2BlockNumber !== undefined ? Number(e.l2BlockNumber) : undefined,
          l1BatchNumber: e.l1BatchNumber !== undefined ? Number(e.l1BatchNumber) : undefined,
        })),
      };

      res.writeHead(200, {
        'Content-Type': 'application/json',
      });
      res.end(safeJsonStringify(sanitized, 'audit-log'));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, message);
    }
  });

  // GET /node/chain-proof — latest chain proof
  reg('GET', '/node/chain-proof', async (_req: IncomingMessage, res: ServerResponse) => {
    try {
      const seq = service.getL2Node().getSequencer();
      const chainProofJson = seq.getLatestChainProofJson();
      const globalStateRoot = seq.getCurrentGlobalStateRoot().toString();
      const blockHeight = Number(seq.getCurrentBlockHeight().toBigInt());

      res.writeHead(200, {
        'Content-Type': 'application/json',
      });
      res.end(safeJsonStringify({
        chainProofJson,
        globalStateRoot,
        blockHeight,
        available: chainProofJson !== null,
      }, 'chain-proof'));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, message);
    }
  });

  // GET /node/chain-state — chain state (roots, counts)
  reg('GET', '/node/chain-state', async (_req: IncomingMessage, res: ServerResponse) => {
    try {
      const seq = service.getL2Node().getSequencer();
      const chainState = {
        currentRegistryRoot: seq.getCurrentRegistryRoot().toString(),
        currentLifecycleRoot: seq.getCurrentLifecycleRoot().toString(),
        currentWalletCount: Number(seq.getCurrentWalletCount().toBigInt()),
        lastSettledRegistryRoot: seq.getLastSettledRegistryRoot().toString(),
        lastSettledLifecycleRoot: seq.getLastSettledLifecycleRoot().toString(),
        lastSettledWalletCount: Number(seq.getLastSettledWalletCount().toBigInt()),
        globalStateRoot: seq.getCurrentGlobalStateRoot().toString(),
        blockHeight: Number(seq.getCurrentBlockHeight().toBigInt()),
        chainProofEnabled: seq.isChainProofEnabled(),
        latestBatchNumber: seq.getLatestBatchNumber() !== null ? Number(seq.getLatestBatchNumber()) : null,
        latestSequenceNumber: Number(seq.getLatestSequenceNumber()),
        claimAccumulatorRoot: seq.getClaimAccumulatorRoot(),
        claimLeafCount: Number(seq.getClaimLeafCount()),
      };

      res.writeHead(200, {
        'Content-Type': 'application/json',
      });
      res.end(safeJsonStringify(chainState, 'chain-state'));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, message);
    }
  });

  // POST /node/force-batch — force batch settlement
  reg('POST', '/node/force-batch', async (_req: IncomingMessage, res: ServerResponse) => {
    try {
      const batch = await service.forceBatch();
      res.writeHead(200, {
        'Content-Type': 'application/json',
      });
      res.end(safeJsonStringify({
        ok: true,
        batch: batch ? { batchNumber: Number((batch as any).batchNumber), transitionCount: (batch as any).transitionCount } : null,
        message: batch ? 'Batch built and settled' : 'No pending proofs to batch',
      }, 'node-force-batch'));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, message);
    }
  });

  // POST /node/publish-formulary — publish formulary for a plan
  reg('POST', '/node/publish-formulary', async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const body = await readBody(req);
      const params = JSON.parse(body);

      if (typeof params.planIdHash !== 'string' ||
          typeof params.formularyRoot !== 'string' ||
          typeof params.entriesJson !== 'string') {
        sendError(res, 400, 'Missing required fields: planIdHash, formularyRoot, entriesJson');
        return;
      }

      const seq = service.getL2Node().getSequencer();
      // Store formulary in sequencer's registry
      seq.getFormulary(params.planIdHash); // This will create it if it doesn't exist

      res.writeHead(200, {
        'Content-Type': 'application/json',
      });
      res.end(safeJsonStringify({
        ok: true,
        message: `Formulary published for plan ${params.planIdHash}`,
      }, 'publish-formulary'));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, message);
    }
  });

  // ─── NFC Bridge Routes ─────────────────────────────────────
  // Only registered if nfcBridge is provided. Graceful no-op if NFC reader is absent.

  if (nfcBridge) {
    const nfcSseClients: Set<ServerResponse> = new Set();

    /** Broadcast an NFC event to all SSE clients */
    const emitNfcEvent = (eventType: string, data: unknown): void => {
      const payload = JSON.stringify(data);
      for (const client of nfcSseClients) {
        try {
          client.write(`event: ${eventType}\ndata: ${payload}\n\n`);
        } catch {
          nfcSseClients.delete(client);
        }
      }
    };

    // Forward all bridge events to SSE clients
    nfcBridge.on('status', (status) => {
      emitNfcEvent('nfc:status', status);
    });

    nfcBridge.on('tag:detected', (evt: NfcTagEvent) => {
      emitNfcEvent('nfc:tag_detected', evt);
    });

    nfcBridge.on('tag:read', async (evt: NfcTagEvent) => {
      if (evt.attestation) {
        // ── Attestation-based verification (Ed25519, instant) ──
        const att = evt.attestation as unknown as NfcCredentialAttestation;
        const result = service.verifyAttestation(att);

        // Look up member display name
        const state = service.getState() as any;
        const members = Array.isArray(state.members) ? state.members : [];
        const member = members.find((m: any) => m.enrolled?.walletId === att.w);
        const memberName = member?.enrolled?.displayName ?? member?.name ?? null;

        emitNfcEvent('nfc:tag_read', {
          ...evt,
          verified: result.valid && !result.expired && !result.revoked,
          verificationMethod: 'ed25519-attestation',
          memberName,
          walletId: att.w,
          attestationDetails: {
            lifecycleState: att.ls,
            forestRoot: att.fr,
            credentialCommitment: att.cc,
            issuedAt: att.ts,
            expiresAt: att.exp,
            signatureValid: result.valid,
            expired: result.expired,
            revoked: result.revoked,
          },
        });
      } else if (evt.walletId) {
        // ── Legacy walletId-only verification (full ZK proof) ──
        let verificationResult: Record<string, unknown> | null = null;
        try {
          const state = service.getState() as any;
          const members = Array.isArray(state.members) ? state.members : [];
          const member = members.find((m: any) => m.enrolled?.walletId === evt.walletId);
          const credentialJson = member?.enrolled?.lastCredentialJson ?? member?.enrolled?.credentialJson;
          if (credentialJson) {
            // Under the proving lock, as the verify-credential route's verification is: an engine that proves inline
            // would otherwise verify in the o1js context a fill is proving in. The verification takes no lock itself,
            // and the lock is not re-entrant.
            verificationResult = await service.getL2Node().withProvingLock(() => service.verifyCredential(
              typeof credentialJson === 'string' ? credentialJson : JSON.stringify(credentialJson),
            ));
          } else {
            verificationResult = { valid: false, reason: 'No credential found for this walletId' };
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          verificationResult = { valid: false, reason: `Verification error: ${msg}` };
        }

        emitNfcEvent('nfc:tag_read', {
          ...evt,
          verified: verificationResult?.valid ?? false,
          verificationMethod: 'zk-proof',
          verification: verificationResult,
        });
      } else {
        emitNfcEvent('nfc:tag_read', {
          ...evt,
          verified: false,
          verificationMethod: 'none',
        });
      }
    });

    nfcBridge.on('tag:written', (evt: NfcTagEvent) => {
      emitNfcEvent('nfc:tag_written', evt);
    });

    nfcBridge.on('tag:removed', (evt: NfcTagEvent) => {
      emitNfcEvent('nfc:tag_removed', evt);
    });

    nfcBridge.on('tag:error', (evt: NfcTagEvent) => {
      emitNfcEvent('nfc:tag_error', evt);
    });

    // GET /interactive/nfc/events — SSE stream for NFC events
    reg('GET', '/interactive/nfc/events', async (_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });

      // Send initial status
      const status = nfcBridge.getStatus();
      res.write(`event: nfc:status\ndata: ${JSON.stringify(status)}\n\n`);

      nfcSseClients.add(res);
      res.on('close', () => nfcSseClients.delete(res));
    });

    // POST /interactive/nfc/write — queue a write to the next NFC tag
    // Auto-upgrades to attestation format if an attestation exists for the walletId
    reg('POST', '/interactive/nfc/write', async (req: IncomingMessage, res: ServerResponse) => {
      try {
        const body = await readBody(req);
        const params = JSON.parse(body);
        if (!params.walletId) {
          sendError(res, 400, 'Missing required field: walletId');
          return;
        }

        if (nfcBridge.getStatus().state === 'disconnected') {
          sendError(res, 503, 'NFC reader not connected');
          return;
        }

        // Auto-upgrade: if an attestation exists, write that instead of bare walletId
        const attestation = service.getAttestation(params.walletId);
        let payload: NdefPayload;
        let format: string;

        if (attestation) {
          payload = { type: 'credential-attestation', attestation: attestation as unknown as Record<string, unknown> };
          format = 'attestation';
        } else {
          payload = { type: 'member-id', walletId: params.walletId };
          format = 'member-id';
        }

        // Queue the write — resolves when tag is placed and written
        nfcBridge.queueWrite(payload).catch(() => {
          // Error is emitted via SSE tag:error event
        });

        res.writeHead(200, {
          'Content-Type': 'application/json',
        });
        res.end(JSON.stringify({ status: 'queued', walletId: params.walletId, format }));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        sendError(res, 500, message);
      }
    });

    // POST /interactive/nfc/cancel — cancel a pending write
    reg('POST', '/interactive/nfc/cancel', async (_req: IncomingMessage, res: ServerResponse) => {
      nfcBridge.cancelWrite();
      res.writeHead(200, {
        'Content-Type': 'application/json',
      });
      res.end(JSON.stringify({ status: 'cancelled' }));
    });

    // GET /interactive/nfc/status — get current NFC bridge status
    reg('GET', '/interactive/nfc/status', async (_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200, {
        'Content-Type': 'application/json',
      });
      res.end(JSON.stringify(nfcBridge.getStatus()));
    });

    // GET /interactive/nfc/sequencer-pubkey — sequencer's Ed25519 public key for offline verification
    reg('GET', '/interactive/nfc/sequencer-pubkey', async (_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200, {
        'Content-Type': 'application/json',
      });
      res.end(JSON.stringify({ publicKey: service.getSequencerPublicKey() }));
    });
  }

  // ─── Provider Badge Routes ─────────────────────────────────

  // GET /interactive/badge/list — list all provider badges
  reg('GET', '/interactive/badge/list', async (_req: IncomingMessage, res: ServerResponse) => {
    try {
      const badges = service.getAllProviderBadges().map(({ key, badge }) => ({
        key,
        providerType: badge.pt,
        providerId: badge.pid,
        displayName: badge.dn,
        walletId: badge.w.slice(0, 16) + '...',
        createdAt: badge.ts,
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ badges, count: badges.length }));
    } catch (err) {
      sendError(res, 500, err instanceof Error ? err.message : String(err));
    }
  });

  // POST /interactive/badge/tap — simulate a single badge tap with real ZK proof
  reg('POST', '/interactive/badge/tap', async (req: IncomingMessage, res: ServerResponse) => {
    try {
      if (badgeTapInProgress) {
        sendError(res, 429, 'Badge tap already in progress — please wait');
        return;
      }

      const body = JSON.parse(await readBody(req));
      const providerType = body.providerType as 'prescriber' | 'pharmacy';
      const providerIndex = typeof body.providerIndex === 'number' ? body.providerIndex : 0;

      if (providerType !== 'prescriber' && providerType !== 'pharmacy') {
        sendError(res, 400, 'providerType must be "prescriber" or "pharmacy"');
        return;
      }

      badgeTapInProgress = true;
      let events;
      try {
        // Under the proving lock, as every other proof is: an engine that proves inline would otherwise make the badge's
        // ProofGate proof beside a fill's in o1js's one proving context. The tap takes no lock itself, and the lock is
        // not re-entrant.
        events = await underProvingLock(req, res, () => service.simulateBadgeTap(providerType, providerIndex));
      } finally {
        badgeTapInProgress = false;
      }
      const success = events.some(e => e.type === 'badge:session');
      const error = events.find(e => e.type === 'badge:error');

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(safeJsonStringify({
        authenticated: success,
        events,
        error: error?.error,
      }));
    } catch (err) {
      sendError(res, 500, err instanceof Error ? err.message : String(err));
    }
  });

  // POST /interactive/badge/auto-tap — run auto-tap simulation for all providers
  reg('POST', '/interactive/badge/auto-tap', async (req: IncomingMessage, res: ServerResponse) => {
    try {
      if (badgeTapInProgress) {
        sendError(res, 429, 'Badge tap already in progress — please wait');
        return;
      }

      const body = JSON.parse(await readBody(req));
      const includePharmacies = body.includePharmacies === true;
      const maxProviders = typeof body.maxProviders === 'number' ? body.maxProviders : undefined;

      badgeTapInProgress = true;
      let events;
      try {
        // Each tap under the proving lock, let go before the next, so a fill waits for one badge proof at most, never the
        // whole round. The engine's round taps each provider through this.simulateBadgeTap; run on this view of the
        // engine, each of those calls takes the lock, and the round's counts and console lines stay the engine's own.
        // Neither the round nor a tap takes the lock itself, and the lock is not re-entrant. A round answered before its
        // first tap had the lock runs no tap; one whose first tap had begun runs them all (underProvingLock).
        const tapsUnderLock: AdjudicationService = Object.create(service, {
          simulateBadgeTap: {
            value: (type: 'prescriber' | 'pharmacy', index: number) =>
              underProvingLock(req, res, () => service.simulateBadgeTap(type, index)),
          },
        });
        events = await tapsUnderLock.autoTapSimulation({ includePharmacies, maxProviders });
      } finally {
        badgeTapInProgress = false;
      }
      const authenticated = events.filter(e => e.type === 'badge:session').length;
      const errors = events.filter(e => e.type === 'badge:error').length;
      const proofs = events.filter(e => e.type === 'badge:proof' && e.data?.verified).length;

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(safeJsonStringify({
        summary: {
          totalProviders: authenticated + errors,
          authenticated,
          errors,
          proofsGenerated: proofs,
        },
        events,
      }));
    } catch (err) {
      sendError(res, 500, err instanceof Error ? err.message : String(err));
    }
  });

  // GET /interactive/badge/:key — get a specific badge payload
  reg('GET', '/interactive/badge/', async (req: IncomingMessage, res: ServerResponse) => {
    try {
      // Extract key from URL: /interactive/badge/prescriber-0
      const url = req.url ?? '';
      const match = url.match(/\/interactive\/badge\/([a-z]+-\d+)/);
      if (!match) {
        sendError(res, 400, 'Badge key required (e.g., /interactive/badge/prescriber-0)');
        return;
      }
      const key = match[1];
      const badge = service.getProviderBadge(key);
      if (!badge) {
        sendError(res, 404, `Badge not found: ${key}`);
        return;
      }

      // Redact the encrypted key for security display
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        key,
        badge: {
          ...badge,
          ek: badge.ek.slice(0, 16) + '...[encrypted]',
        },
        estimatedBytes: JSON.stringify(badge).length,
        fitsNtag216: JSON.stringify(badge).length < 888,
      }));
    } catch (err) {
      sendError(res, 500, err instanceof Error ? err.message : String(err));
    }
  });

  // Return the emitter so the startup script can wire it to the service
  (server as any).__interactiveConsoleEmitter = consoleEmitter;
  (server as any).__interactiveConsoleSseClients = consoleSseClients;
}

/**
 * Get the console emitter that was installed by registerInteractiveRoutes.
 * This allows the startup script to wire it before creating the service.
 */
export function getConsoleEmitter(server: L2RpcServer): (event: ConsoleEvent) => void {
  return (server as any).__interactiveConsoleEmitter;
}

// ─── Helpers ────────────────────────────────────────────

// One read per request: a signed request's body was already read by the admin gate (A9), under the sequencer's limit;
// any other is read here under the same one, past which the shared reader stops and closes the connection rather than
// keep the rest (a body that declares more was answered 413 before its handler ran: withinBodyLimit).
function readBody(req: IncomingMessage): Promise<string> {
  return readRequestBody(req, ENGINE_BODY_LIMIT_BYTES);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  // A request answered already (the sequencer's 504 once its budget ran out), or whose caller went away, gets nothing more
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(status, {
    'Content-Type': 'application/json',
  });
  res.end(JSON.stringify({ error: message }));
}

/**
 * BigInt-safe JSON serializer — safety net for missed BigInt conversions.
 *
 * JSON.stringify() throws "Do not know how to serialize a BigInt" when it
 * encounters BigInt values (common in o1js Field.toBigInt() and L2 types).
 * Callers should convert BigInts explicitly before reaching this function.
 * Any BigInt that leaks through is logged as a warning so we can fix the source.
 */
function safeJsonStringify(data: unknown, _context?: string): string {
  return JSON.stringify(data, (_key: string, value: unknown): unknown => {
    if (typeof value === 'bigint') {
      return value.toString();
    }
    return value;
  });
}
