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
 * NautilusAppServer — HTTPS/HTTP REST server for Nautilus Node Apps.
 *
 * Wraps entity-specific nodes (MemberNode, PrescriberNode, PharmacyNode, InsurerNode)
 * with a local REST API that entity frontends consume. Handles:
 *
 *   - Onboarding step-by-step REST endpoints
 *   - Encrypted local state persistence (PIN-gated)
 *   - Entity-specific query/proof endpoints (registered per-role)
 *   - SSE event streaming from the underlying entity node
 *   - CORS, admin auth, request timeouts, body size limits
 *   - TLS when cert/key PEM files are provided
 *
 * Zero external dependencies — uses Node.js built-in http/https + crypto modules.
 *
 * Usage:
 *   const server = new NautilusAppServer(config);
 *   server.registerRoutes(memberRoutes);
 *   await server.start();
 *   // frontend connects to http(s)://host:port/...
 *   await server.stop();
 */
import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { timingSafeEqual, randomBytes } from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import type { EntityNodeBase } from './entity-node-base.js';
import type { L2EventHandler, L2ChainEvent } from '../l2/l2-node.js';
import { l2Stringify } from '../l2/l2-json.js';
import { NautilusLocalState } from './nautilus-local-state.js';
import type {
  NautilusAppConfig,
  NautilusApiResponse,
  NautilusHealthResponse,
  RouteRegistration,
  RouteHandler,
  OnboardingPhase,
} from './nautilus-app-types.js';
import { corsOriginHeader } from '../security/network-policy.js';
import { verifySignedRequest, signerIdFromHeaders, signRequest, privateKeyFromSeedHex, ReplayCache } from '../security/signed-request.js';
import { readRequestBody } from '../security/request-body.js';
import { signedFetch as signedFetchWith, type SignedFetchInit } from './sequencer-fetch.js';
import { walletSigner as walletSignerFor, type RequestSigner } from '../security/wallet-key.js';
import type { L2ClientOptions } from '../l2/l2-client.js';

// ─── Constants ──────────────────────────────────────────────

const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5MB — Option C paginated queries keep responses small
const REQUEST_TIMEOUT_MS = 30_000;
const SSE_REPLAY_BUFFER_SIZE = 128;

// ─── Route Matching ─────────────────────────────────────────

/** Compiled route with param extraction */
interface CompiledRoute {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: RouteHandler;
  adminOnly: boolean;
  deviceOnly: boolean;
  timeoutMs?: number;
}

/** Compile a path like '/drugs/medication/:ndcHash' into a regex */
function compileRoute(reg: RouteRegistration): CompiledRoute {
  const paramNames: string[] = [];
  const pattern = reg.path.replace(/:([a-zA-Z0-9_]+)/g, (_match, name: string) => {
    paramNames.push(name);
    return '([^/]+)';
  });
  return {
    method: reg.method,
    pattern: new RegExp(`^${pattern}$`),
    paramNames,
    handler: reg.handler,
    adminOnly: reg.adminOnly ?? false,
    deviceOnly: reg.deviceOnly ?? false,
    timeoutMs: reg.timeoutMs,
  };
}

// ─── NautilusAppServer ──────────────────────────────────────

export class NautilusAppServer {
  private config: NautilusAppConfig;
  private server: http.Server | https.Server | null = null;
  private listening = false;
  private entityNode: EntityNodeBase | null = null;
  private localState: NautilusLocalState;
  private routes: CompiledRoute[] = [];
  private startTime = 0;
  private onboardingPhase: OnboardingPhase = 'awaiting_token';
  private tls = false;
  /** Replayed signatures are refused for the verifier's window (A9). */
  private readonly replayCache = new ReplayCache();

  // SSE
  private sseClients: Set<ServerResponse> = new Set();
  private sseReplayBuffer: { id: number; event: L2ChainEvent }[] = [];
  private sseEventIdCounter = 0;
  private eventDisconnect: (() => void) | null = null;

  constructor(config: NautilusAppConfig) {
    this.config = config;
    this.localState = new NautilusLocalState(config.stateDir);
  }

  // ─── Entity Node ──────────────────────────────────────────

  /** Set the entity node after onboarding completes, or null to clear (eject). */
  setEntityNode(node: EntityNodeBase | null): void {
    // A10b: the node signs wallet-scoped calls as its wallet, with the key this server can derive.
    node?.setWalletSignerSource(() => this.walletSigner());
    // Disconnect previous SSE bridge if any
    if (this.eventDisconnect) {
      this.eventDisconnect();
      this.eventDisconnect = null;
    }
    this.entityNode = node;

    // Bridge entity node SSE events to app SSE clients
    if (node && this.config.enableSSE) {
      this.eventDisconnect = node.connectEvents((event: L2ChainEvent) => {
        this.broadcastSSE(event);
      });
    }
  }

  /** Get the entity node (null before onboarding) */
  getEntityNode(): EntityNodeBase | null {
    return this.entityNode;
  }

  /** Get the encrypted local state manager */
  getLocalState(): NautilusLocalState {
    return this.localState;
  }

  /** Get/set onboarding phase */
  getOnboardingPhase(): OnboardingPhase {
    return this.onboardingPhase;
  }

  setOnboardingPhase(phase: OnboardingPhase): void {
    this.onboardingPhase = phase;
  }

  /** Get the app config */
  getConfig(): NautilusAppConfig {
    return this.config;
  }

  /**
   * Admin auth for this node's own routes — plan item A9, finding A-14 and AUTH-14.
   *
   * Two credentials, as alternatives rather than modes: this node's own bearer token, and a signed
   * request from a client key this node registered (the HR Tool on an employer node). The
   * signature is verified by `src/security/signed-request.ts`, which recomputes the content hash
   * from the bytes received; the verifier this replaces trusted the caller's own `X-Content-Hash`
   * header, so a signature was never bound to the request (AUTH-14). Reading the body here is
   * safe: every later reader of this request gets the same cached bytes.
   */
  private async checkNautilusAdminAuth(req: IncomingMessage, method: string, path: string): Promise<boolean> {
    const authHeader = req.headers['authorization'];
    if (typeof authHeader === 'string' && authHeader.length > 0) {
      if (!this.config.adminToken) return false; // Default-deny
      const a = Buffer.from(authHeader);
      const b = Buffer.from(`Bearer ${this.config.adminToken}`);
      if (a.length !== b.length) return false;
      return timingSafeEqual(a, b);
    }
    const clientId = signerIdFromHeaders(req.headers);
    if (!clientId) return false;
    const publicKeyHex = this.config.authorizedClientKeys?.get(clientId);
    if (!publicKeyHex) return false;
    let body: string;
    try {
      body = await readRequestBody(req, MAX_BODY_BYTES);
    } catch {
      return false;
    }
    return verifySignedRequest({ method, path, headers: req.headers, expectedSignerId: clientId, publicKeyHex, body, replayCache: this.replayCache }).ok;
  }

  /**
   * Register a key that may act as this node's own admin (for example the HR Tool on an
   * employer node). Registering one switches admin auth to signatures.
   */
  registerClientKey(clientId: string, publicKeyHex: string): void {
    if (!this.config.authorizedClientKeys) {
      this.config.authorizedClientKeys = new Map();
    }
    this.config.authorizedClientKeys.set(clientId, publicKeyHex);
  }

  // ─── Device session (A5) ──────────────────────────────────

  /*
   * The member node had 31 routes and none of them authenticated anything, which is MEM-H1 and
   * the local half of A-7. Anything that could reach the port could read the member's drug
   * history, send messages as them, assign their doctor or read their receipts.
   *
   * A device session is the answer rather than a per-request PIN. Since item A4, unlocking
   * actually verifies the PIN, so a session issued at unlock carries a real claim: someone proved
   * this device's PIN during this process's life. Requiring the PIN on every request would mean
   * the browser holding the PIN, which is strictly worse.
   *
   * What this is **not**. It is a local session on a loopback-bound node, so it defends the member
   * against software on their own machine and against anything that slips past the bind, not
   * against someone holding the unlocked phone. It also says nothing to the *sequencer*: the
   * sequencer's own open reads are A-2, and item D1 is what fixes those.
   */
  private deviceSession: { token: string; expiresAt: number } | null = null;

  /** How long a session lasts without being renewed. */
  private static readonly DEVICE_SESSION_TTL_MS = 60 * 60_000;

  /** Issue a session. Called only after the PIN has been verified. */
  issueDeviceSession(): { token: string; expiresInMs: number } {
    const token = randomBytes(32).toString('base64url');
    const ttl = NautilusAppServer.DEVICE_SESSION_TTL_MS;
    this.deviceSession = { token, expiresAt: Date.now() + ttl };
    return { token, expiresInMs: ttl };
  }

  /** Drop the session. Called when the device locks or is ejected. */
  clearDeviceSession(): void {
    this.deviceSession = null;
  }

  /** Whether a request carries this device's current session. */
  checkDeviceAuth(req: IncomingMessage): boolean {
    const session = this.deviceSession;
    if (!session) return false;
    if (Date.now() > session.expiresAt) {
      this.deviceSession = null;
      return false;
    }
    const header = (req.headers['x-device-session'] as string | undefined) ?? '';
    const presented = header || (() => {
      const auth = (req.headers['authorization'] as string | undefined) ?? '';
      return auth.startsWith('Device ') ? auth.slice('Device '.length) : '';
    })();
    if (!presented) return false;
    const a = Buffer.from(presented);
    const b = Buffer.from(session.token);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  /**
   * Record another organization's signing key (an employer signing its agreement with the
   * insurer). These keys identify that organization; they never grant this node's admin
   * rights and do not change how this node's own admin authenticates.
   */
  private partnerKeys = new Map<string, string>();
  registerPartnerKey(partnerId: string, publicKeyHex: string): void {
    this.partnerKeys.set(partnerId, publicKeyHex);
  }
  getPartnerKey(partnerId: string): string | undefined {
    return this.partnerKeys.get(partnerId);
  }

  /** Revoke a client's key */
  revokeClientKey(clientId: string): boolean {
    return this.config.authorizedClientKeys?.delete(clientId) ?? false;
  }

  /** The client keys this node accepts for its own admin routes (public halves only). */
  listClientKeys(): Array<{ clientId: string; publicKeyHex: string }> {
    return [...(this.config.authorizedClientKeys ?? new Map<string, string>())].map(([clientId, publicKeyHex]) => ({ clientId, publicKeyHex }));
  }

  /**
   * Headers that authenticate this node to the sequencer — plan item A9, finding A-14: a signature
   * with the node's own key over the exact bytes about to be sent, verified on the sequencer against
   * the key the launcher registered for this process, and authorised by the role it registered it
   * with. A node started without a key sends no credential at all; it never presents its own admin
   * token to the sequencer, because that token is not a sequencer credential.
   */
  sequencerAuthHeaders(method: string, path: string, body?: string): Record<string, string> {
    const key = this.config.nodeKey;
    if (!key) return {};
    return signRequest({ signerId: key.nodeId, privateKey: privateKeyFromSeedHex(key.seedHex), method, path, body });
  }

  /** `fetch` with this node's signature over the exact request (A9). */
  signedFetch(url: string, init: SignedFetchInit): Promise<Response> {
    return signedFetchWith((m, p, b) => this.sequencerAuthHeaders(m, p, b), url, init);
  }

  /** The client options that make an L2Client sign with this node's key; undefined for a node without one. */
  sequencerClientOptions(): Partial<L2ClientOptions> | undefined {
    const key = this.config.nodeKey;
    return key ? { adminPrivateKeyHex: key.seedHex, adminNodeId: key.nodeId } : undefined;
  }

  /**
   * This node's wallet signer (A10b): the wallet id from local state and the signing key derived from
   * the enrollment key, derived on each call and not kept. Null while the device is locked or before
   * a wallet exists, in which case a wallet-scoped call goes out unsigned and the sequencer refuses it.
   */
  walletSigner(): RequestSigner | null {
    const state = this.getLocalState();
    // The wallet id comes from the device state, or from the node itself for a node whose identity was
    // seeded in memory and never written to a state file (the provider nodes), which until D1 left
    // every provider unable to sign as its wallet.
    const walletId = (state.getState() as { walletId?: string } | null)?.walletId ?? this.entityNode?.getWalletId();
    if (!walletId || !state.hasEnrollmentKey()) return null;
    return state.useEnrollmentKey((enrollmentKey) => walletSignerFor(enrollmentKey, walletId));
  }

  /**
   * `fetch` signed as this node's wallet (B2): the engine's wallet routes take only this signature.
   * Rejects when the device cannot sign (no wallet yet, or the enrollment key is locked).
   */
  walletSignedFetch(url: string, init: SignedFetchInit): Promise<Response> {
    const signer = this.walletSigner();
    if (!signer) return Promise.reject(new Error('The device cannot sign as its wallet: no wallet, or the enrollment key is locked'));
    return signedFetchWith(
      (m, p, b) => signRequest({ signerId: signer.signerId, privateKey: signer.privateKey, method: m, path: p, body: b }),
      url,
      init,
    );
  }

  // ─── Route Registration ───────────────────────────────────

  /** Register entity-specific routes */
  registerRoutes(routes: RouteRegistration[]): void {
    for (const route of routes) {
      this.routes.push(compileRoute(route));
    }
  }

  // ─── Lifecycle ────────────────────────────────────────────

  /** Start the HTTP/HTTPS server */
  async start(): Promise<void> {
    if (this.listening) return;

    const handler = (req: IncomingMessage, res: ServerResponse) => {
      this.handleRequest(req, res).catch(() => {
        if (!res.writableEnded) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(l2Stringify({ ok: false, error: 'Internal Server Error', timestamp: Date.now() }));
        }
      });
    };

    // TLS or plain HTTP
    if (this.config.tlsCert && this.config.tlsKey) {
      const cert = fs.readFileSync(this.config.tlsCert, 'utf-8');
      const key = fs.readFileSync(this.config.tlsKey, 'utf-8');
      this.server = https.createServer({ cert, key }, handler);
      this.tls = true;
    } else {
      this.server = http.createServer(handler);
      this.tls = false;
    }

    return new Promise<void>((resolve, reject) => {
      this.server!.listen(this.config.port, this.config.host, () => {
        this.listening = true;
        this.startTime = Date.now();
        resolve();
      });
      this.server!.once('error', reject);
    });
  }

  /** Gracefully stop the server */
  async stop(): Promise<void> {
    if (!this.listening || !this.server) return;

    // Disconnect SSE bridge
    if (this.eventDisconnect) {
      this.eventDisconnect();
      this.eventDisconnect = null;
    }

    // Close SSE connections
    for (const client of this.sseClients) {
      try { client.end(); } catch { /* ignore */ }
    }
    this.sseClients.clear();

    return new Promise<void>((resolve) => {
      this.server!.close(() => {
        this.listening = false;
        resolve();
      });
    });
  }

  /** Whether the server is listening */
  isListening(): boolean {
    return this.listening;
  }

  /** Whether TLS is active */
  isTls(): boolean {
    return this.tls;
  }

  /** Check if the server is already listening */
  isRunning(): boolean {
    return this.server !== null && this.server.listening;
  }

  /** Get the actual port */
  getPort(): number {
    if (this.server) {
      const addr = this.server.address();
      if (addr && typeof addr === 'object') return addr.port;
    }
    return this.config.port;
  }

  // ─── Request Handling ─────────────────────────────────────

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const pathname = url.pathname;
    const method = req.method ?? 'GET';

    // Request budget (SSE excepted): the server's default, re-armed to the route's own `timeoutMs`
    // once the route is known — a route that proves runs for longer than a lookup.
    const isSSE = pathname === '/events';
    let budgetTimer: NodeJS.Timeout | null = null;
    const armBudget = (ms: number): void => {
      if (budgetTimer) clearTimeout(budgetTimer);
      budgetTimer = setTimeout(() => {
        if (!res.writableEnded) {
          this.sendJson(res, 504, { ok: false, error: 'Request timeout', timestamp: Date.now() });
        }
      }, ms);
    };
    if (!isSSE) {
      armBudget(this.config.requestTimeoutMs ?? REQUEST_TIMEOUT_MS);
      res.on('finish', () => { if (budgetTimer) clearTimeout(budgetTimer); });
    }

    // CORS (A2): one shared policy. A disallowed or absent origin gets no header at all,
    // rather than the literal 'null', which granted any null-origin context.
    const corsOrigin = corsOriginHeader(req.headers.origin, this.config.allowedOrigins);
    if (corsOrigin) res.setHeader('Access-Control-Allow-Origin', corsOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Admin-Signature, X-Content-Hash');

    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // ── Built-in routes ──

    if (pathname === '/health' && method === 'GET') {
      return this.handleHealth(req, res);
    }

    if (pathname === '/onboarding/status' && method === 'GET') {
      return this.handleOnboardingStatus(req, res);
    }

    if (pathname === '/events' && method === 'GET') {
      return this.handleSSE(req, res);
    }

    // ── JSON-RPC proxy to sequencer ──
    // The member dashboard sends JSON-RPC 2.0 to /rpc expecting to reach the
    // Leviathan sequencer. Proxy these requests so the dashboard works when
    // served from a Nautilus node (same pattern as start-explorer.ts).
    if (pathname === '/rpc' && method === 'POST') {
      return this.handleRpcProxy(req, res);
    }

    // ── Registered routes ──

    for (const route of this.routes) {
      if (route.method !== method) continue;
      const match = pathname.match(route.pattern);
      if (!match) continue;
      if (!isSSE && route.timeoutMs) armBudget(route.timeoutMs);

      // Admin auth (A9): this node's own bearer token, or a signature from a client key it registered
      if (route.adminOnly) {
        if (!(await this.checkNautilusAdminAuth(req, method, pathname))) {
          return this.sendResponse(res, 401, false, undefined, 'Unauthorized');
        }
      }

      // A5: device session. Admin auth also satisfies it, so an operator tool with the node's
      // own credential is not locked out of its own routes.
      if (route.deviceOnly && !this.checkDeviceAuth(req)) {
        if (!(await this.checkNautilusAdminAuth(req, method, pathname))) {
          return this.sendResponse(res, 401, false, undefined,
            'This device is locked. Unlock with your PIN to obtain a device session.');
        }
      }

      // Extract path params
      const params: Record<string, string> = {};
      for (let i = 0; i < route.paramNames.length; i++) {
        params[route.paramNames[i]] = decodeURIComponent(match[i + 1]);
      }

      // Parse body for POST/PUT/DELETE
      // Skip JSON parsing for binary uploads (PDF, octet-stream) — route handlers read req directly.
      let body: unknown = undefined;
      const contentType = req.headers['content-type'] ?? '';
      const isBinaryUpload = contentType.startsWith('application/pdf') || contentType.startsWith('application/octet-stream') || contentType.startsWith('multipart/');
      if ((method === 'POST' || method === 'PUT' || method === 'DELETE') && !isBinaryUpload) {
        try {
          const raw = await this.readBody(req);
          if (raw.length > 0) {
            body = JSON.parse(raw);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Invalid request body';
          return this.sendResponse(res, 400, false, undefined, msg);
        }
      }

      try {
        await route.handler(req, res, params, url.searchParams, body);
      } catch (err) {
        if (!res.writableEnded) {
          const msg = err instanceof Error ? err.message : 'Internal error';
          this.sendResponse(res, 500, false, undefined, msg);
        }
      }
      return;
    }

    // ── Marketplace dashboard files (served at /marketplace/) ──
    if (method === 'GET' && this.config.marketplaceDashboardDir && pathname.startsWith('/marketplace/')) {
      const subPath = pathname.slice('/marketplace'.length);
      const safePath = subPath === '/' || subPath === '' ? '/index.html' : subPath;
      if (/^[/a-zA-Z0-9._-]+$/.test(safePath) && !safePath.includes('..')) {
        const filePath = path.join(this.config.marketplaceDashboardDir, safePath);
        try {
          const content = fs.readFileSync(filePath);
          const ext = path.extname(filePath).toLowerCase();
          const mimeTypes: Record<string, string> = {
            '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
            '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
            '.ico': 'image/x-icon',
          };
          res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
          res.end(content);
          return;
        } catch { /* file not found, fall through */ }
      }
    }

    // ── Static dashboard files ──
    if (method === 'GET' && this.config.dashboardDir) {
      const safePath = pathname === '/' ? '/index.html' : pathname;
      if (/^[/a-zA-Z0-9._-]+$/.test(safePath) && !safePath.includes('..')) {
        const filePath = path.join(this.config.dashboardDir, safePath);
        try {
          const content = fs.readFileSync(filePath);
          const ext = path.extname(filePath).toLowerCase();
          const mimeTypes: Record<string, string> = {
            '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
            '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
            '.ico': 'image/x-icon',
          };
          res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
          res.end(content);
          return;
        } catch { /* file not found, fall through to 404 */ }
      }
    }

    // No route matched
    this.sendResponse(res, 404, false, undefined, 'Not found');
  }

  // ─── Built-in Endpoints ───────────────────────────────────

  /*
   * `/health` and `/onboarding/status` stay open, because a readiness probe and the app's own
   * onboarding screen both need them before any session exists. What changes (A5, MEM-H1) is that
   * they no longer hand out the member's **wallet ID**, or the enrollment token, to a caller that
   * has proved nothing.
   *
   * The wallet ID was the first link in a drive-by chain: `GET /health` gave it up, and the
   * sequencer's open reads turned it into the member's drug history, costs and message metadata.
   * A2 narrowed the proxy that made that reachable from a web page, but the identifier itself was
   * still free, and the sequencer's reads are still open until item D1.
   *
   * Both endpoints now disclose identity **only to a request carrying this device's session**, so
   * the member's own app sees everything it did before and an unauthenticated caller learns the
   * role, the phase and the uptime — enough to answer "is this node up and how far through
   * onboarding is it", which is all a probe needs.
   */
  /**
   * Whether identity may be disclosed on the open endpoints.
   *
   * **Member nodes only withhold it.** That was not the first version of this: A5 withheld it on
   * every role, and the e2e harness caught the consequence — it reads the prescriber's and
   * pharmacy's wallet IDs from their `/health` in order to write a prescription, and provider
   * nodes have **no unlock route**, so nothing can ever authenticate to one to get the value
   * back. The flow simply broke.
   *
   * Scoping it to members is also the right line rather than a workaround. MEM-H1 is about the
   * member node, and a member's wallet ID is the one that unlocks PHI through the sequencer's
   * open reads. A provider's is a hash of an NPI that is published in a federal directory, and it
   * is discoverable from the sequencer's own provider registry regardless, so withholding it here
   * would cost a working flow and buy nothing. What actually protects provider-keyed reads is
   * item D1, at the sequencer.
   */
  private async mayDiscloseIdentity(req: IncomingMessage, path: string): Promise<boolean> {
    if (this.config.role !== 'member') return true;
    if (this.checkDeviceAuth(req)) return true;
    return this.checkNautilusAdminAuth(req, 'GET', path);
  }

  private async handleHealth(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const identified = await this.mayDiscloseIdentity(req, '/health');
    const health: NautilusHealthResponse = {
      role: this.config.role,
      phase: this.onboardingPhase,
      sequencerConnected: this.entityNode !== null,
      // Same source as /onboarding/status. These disagreed before: health read the entity node
      // while status read local state, so a device that had derived a wallet but not yet built
      // its node reported one and not the other.
      ...(identified
        ? { walletId: this.localState.getState()?.walletId ?? this.entityNode?.getWalletId() }
        : {}),
      displayName: this.config.displayName,
      uptime: this.startTime > 0 ? Date.now() - this.startTime : 0,
      tls: this.tls,
      sequencerUrl: this.config.sequencerUrl,
    };
    // Admin token is never exposed via health endpoint — use a separate
    // authenticated endpoint or inject via server-rendered HTML if needed.
    this.sendResponse(res, 200, true, health);
  }

  private async handleOnboardingStatus(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const state = this.localState.getState();
    const identified = await this.mayDiscloseIdentity(req, '/onboarding/status');

    if (!identified) {
      // Phase only. `state.onboarding` carries `tokenData` with the enrollment token, group and
      // plan, which is the employer linkage rule I6 exists to prevent leaking.
      return this.sendResponse(res, 200, true, {
        phase: this.onboardingPhase,
        onboarding: { phase: state?.onboarding?.phase ?? this.onboardingPhase },
        role: this.config.role,
      });
    }

    this.sendResponse(res, 200, true, {
      phase: this.onboardingPhase,
      onboarding: state?.onboarding ?? { phase: this.onboardingPhase },
      walletId: state?.walletId ?? this.entityNode?.getWalletId(),
      role: this.config.role,
      displayName: this.config.displayName ?? this.entityNode?.getDisplayName(),
    });
  }

  // ─── JSON-RPC Proxy ──────────────────────────────────────

  private async handleRpcProxy(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const seqUrl = this.config.sequencerUrl;
    if (!seqUrl) {
      this.sendJson(res, 502, { jsonrpc: '2.0', id: null, error: { code: -32603, message: 'No sequencer URL configured' } });
      return;
    }

    // A2: forwards only the methods this role's own dashboard calls. It used to forward any
    // method at all, so a page served from this node could reach every method the sequencer
    // left open. The proxy stays on by default because real pages depend on it — the member
    // dashboard's helper defaults its base URL to location.origin, so without it every one of
    // its sequencer calls fails. See resolveRpcProxyPolicy for what the lists are and for what
    // this does not fix.
    const policy = this.config.rpcProxy;
    if (!policy?.enabled) {
      this.sendJson(res, 404, {
        jsonrpc: '2.0', id: null,
        error: { code: -32601, message: 'RPC proxying is disabled on this node' },
      });
      return;
    }

    try {
      const body = await this.readBody(req);

      let method: string | undefined;
      try {
        method = (JSON.parse(body) as { method?: string }).method;
      } catch {
        this.sendJson(res, 400, {
          jsonrpc: '2.0', id: null,
          error: { code: -32700, message: 'Parse error' },
        });
        return;
      }
      if (!method || !policy.allowed.has(method)) {
        this.sendJson(res, 403, {
          jsonrpc: '2.0', id: null,
          error: { code: -32601, message: `Method not available through this node's proxy: ${method ?? 'none'}` },
        });
        return;
      }

      // D1: the dashboard's reads of this node's own member data are signed as the wallet when the
      // device is unlocked, else with the node's key, which the sequencer accepts for what a node may read.
      const signer = this.walletSigner();
      const signed = signer
        ? signRequest({ signerId: signer.signerId, privateKey: signer.privateKey, method: 'POST', path: '/rpc', body })
        : this.sequencerAuthHeaders('POST', '/rpc', body);
      const upstream = await fetch(seqUrl.replace(/\/+$/, '') + '/rpc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...signed },
        body,
      });
      const text = await upstream.text();
      res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
      res.end(text);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Sequencer unreachable';
      this.sendJson(res, 502, { jsonrpc: '2.0', id: null, error: { code: -32603, message: msg } });
    }
  }

  // ─── SSE ──────────────────────────────────────────────────

  private handleSSE(req: IncomingMessage, res: ServerResponse): void {
    if (!this.config.enableSSE) {
      this.sendResponse(res, 404, false, undefined, 'SSE disabled');
      return;
    }

    if (this.sseClients.size >= this.config.maxSseConnections) {
      this.sendResponse(res, 503, false, undefined, 'Too many SSE connections');
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    this.sseClients.add(res);
    res.write(`data: ${l2Stringify({ type: 'connected', role: this.config.role, timestamp: Date.now() })}\n\n`);

    // Replay from buffer
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const lastIdParam = url.searchParams.get('lastEventId');
    if (lastIdParam !== null) {
      const lastId = parseInt(lastIdParam, 10);
      if (!isNaN(lastId)) {
        for (const entry of this.sseReplayBuffer) {
          if (entry.id > lastId) {
            res.write(`id: ${entry.id}\ndata: ${l2Stringify(entry.event)}\n\n`);
          }
        }
      }
    }

    req.on('close', () => {
      this.sseClients.delete(res);
      try { res.end(); } catch { /* already closed */ }
    });
  }

  private broadcastSSE(event: L2ChainEvent): void {
    this.sseEventIdCounter++;
    this.sseReplayBuffer.push({ id: this.sseEventIdCounter, event });
    if (this.sseReplayBuffer.length > SSE_REPLAY_BUFFER_SIZE) {
      this.sseReplayBuffer.shift();
    }

    const data = l2Stringify(event);
    for (const client of this.sseClients) {
      try {
        client.write(`id: ${this.sseEventIdCounter}\ndata: ${data}\n\n`);
      } catch {
        this.sseClients.delete(client);
        try { client.end(); } catch { /* socket already dead */ }
      }
    }
  }

  // ─── Response Helpers (public — routes use these) ─────────

  /** Send a standard NautilusApiResponse */
  sendResponse<T>(
    res: ServerResponse,
    statusCode: number,
    ok: boolean,
    data?: T,
    error?: string,
  ): void {
    const response: NautilusApiResponse<T> = {
      ok,
      timestamp: Date.now(),
      ...(data !== undefined ? { data } : {}),
      ...(error !== undefined ? { error } : {}),
    };
    this.sendJson(res, statusCode, response);
  }

  /** Send raw JSON (BigInt-safe) */
  sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
    if (res.writableEnded) return;
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(l2Stringify(body));
  }

  // ─── Body Reader ──────────────────────────────────────────

  private readBody(req: IncomingMessage): Promise<string> {
    return readRequestBody(req, MAX_BODY_BYTES);
  }

  /** Number of connected SSE clients */
  getSSEClientCount(): number {
    return this.sseClients.size;
  }
}
