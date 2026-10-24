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
import {
  corsOriginHeader, resolvePublicHosts, requestHostAllowed, bodyTypeAccepted,
  JSON_BODY, MISDIRECTED_REQUEST, UNSUPPORTED_BODY_TYPE, NO_FRAMING_HEADERS,
  resolveTrustedProxies, trustedProxyList, clientAddress, isLoopbackBind,
} from '../security/network-policy.js';
import { addressKey, normalizeAddress } from '../security/rate-limit.js';
import { callReadsMemberData } from '../l2/member-data-methods.js';
import { verifySignedRequest, signerIdFromHeaders, signRequest, privateKeyFromSeedHex, ReplayCache } from '../security/signed-request.js';
import { readRequestBody } from '../security/request-body.js';
import { signedFetch as signedFetchWith, type SignedFetchInit } from './sequencer-fetch.js';
import { walletSigner as walletSignerFor, type RequestSigner } from '../security/wallet-key.js';
import type { L2ClientOptions } from '../l2/l2-client.js';

// ─── Constants ──────────────────────────────────────────────

const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5MB — Option C paginated queries keep responses small
const REQUEST_TIMEOUT_MS = 30_000;
const SSE_REPLAY_BUFFER_SIZE = 128;
/** How long a stream ticket stays good: long enough for a page to open its EventSource with it (A-79). */
const STREAM_TICKET_TTL_MS = 30_000;
/** The most stream tickets outstanding at once; the oldest goes first. */
const STREAM_TICKET_LIMIT = 64;
/** How many levels into an event's data a member or insurer node reads its wallet fields (A-79). */
const EVENT_SCAN_DEPTH = 8;

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
  bodyTypes?: readonly string[];
}

/** A field that names wallets: one whose name ends in "walletId" (walletId, senderWalletId) or "walletIds", a list. */
const WALLET_FIELD = /walletids?$/i;

/** A run of digits long enough to be a wallet ID or a root: both are field elements, written in up to 77 digits. */
const LONG_DIGIT_RUN = /\d{30,}/g;

/**
 * The wallet IDs an event's data names: every string, number or bigint that a field whose name ends in "walletId" or
 * "walletIds" holds, one ID or a list of them, read EVENT_SCAN_DEPTH levels down. Null when the data nests deeper than
 * that, since a wallet below the walk would go unseen. Free text names no wallet here: the sequencer's rejection
 * reasons quote roots as well as wallet IDs, and the stream cuts both out of the copy it sends (withoutLongDigitRuns).
 */
function walletsNamed(value: unknown, depth = 0, inWalletField = false): string[] | null {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') return inWalletField ? [String(value)] : [];
  if (!value || typeof value !== 'object') return [];
  if (depth > EVENT_SCAN_DEPTH) return null;
  const found: string[] = [];
  for (const [key, field] of Object.entries(value as Record<string, unknown>)) {
    const named = walletsNamed(field, depth + 1, inWalletField || WALLET_FIELD.test(key));
    if (named === null) return null;
    found.push(...named);
  }
  return found;
}

/**
 * A copy of `value` in which every run of 30 or more digits inside free text, a string with any non-digit in it, is cut
 * to an ellipsis: a rejection reason may quote a wallet ID ("Wallet already registered: <wallet ID>") or roots
 * ("Registry root mismatch: proof expects <root> but L2 state is <root>"). A string of digits alone, a root or a hash,
 * is kept. `value` itself is left as it is, because the replay buffer keeps the event for every stream.
 */
function withoutLongDigitRuns(value: unknown): unknown {
  if (typeof value === 'string') return /\D/.test(value) ? value.replace(LONG_DIGIT_RUN, '…') : value;
  if (Array.isArray(value)) return value.map(withoutLongDigitRuns);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, field]) => [key, withoutLongDigitRuns(field)]));
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
    bodyTypes: reg.bodyTypes,
  };
}

// ─── Loopback Proxies ───────────────────────────────────────

/**
 * The loopback addresses a reverse proxy on this host connects from to reach a listener bound to `host`, as
 * normalizeAddress writes them: 127.0.0.1 for a bind in 127.0.0.0/8, ::1 for ::1, and both for localhost, which Node
 * binds to whichever of the two it resolves first. None for a bind that is not loopback.
 */
function loopbackProxySources(host: string | undefined): string[] {
  if (typeof host !== 'string' || !isLoopbackBind(host)) return [];
  const name = host.trim().toLowerCase();
  if (name === 'localhost') return ['127.0.0.1', '::1'];
  const bare = name.startsWith('[') && name.endsWith(']') ? name.slice(1, -1) : name;
  return [normalizeAddress(bare) === '::1' ? '::1' : '127.0.0.1'];
}

/**
 * Whether `trusted` lists a proxy connecting from `source`, an address loopbackProxySources named: ::1 itself for ::1,
 * and for 127.0.0.1 any address in 127.0.0.0/8, since a proxy may take its source anywhere in the block.
 */
function trustsLoopbackProxy(trusted: readonly string[], source: string): boolean {
  return trusted.some((proxy) => (source === '::1' ? proxy === '::1' : proxy.startsWith('127.')));
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
  /** The names this node answers to in a request's Host beside loopback and its bind address (A-82). */
  private readonly publicHosts: readonly string[];
  /** The reverse proxies whose X-Forwarded-For names the client a per-caller limit counts (callerKey). */
  private readonly trustedProxies: readonly string[];
  /** Each routed request's callerKey, read as it arrived. Weak: an answered request takes its entry with it. */
  private readonly callerKeys: WeakMap<IncomingMessage, string> = new WeakMap();

  // SSE
  private sseClients: Set<ServerResponse> = new Set();
  /** Streams opened under the device's session, with that session's token: they end with it (A-79). */
  private deviceStreams: Map<ServerResponse, string> = new Map();
  /** Stream tickets not yet used (A-79): each one's expiry, and the device session it was issued under, if any. */
  private streamTickets: Map<string, { expiresAt: number; deviceSession: string | null }> = new Map();
  private sseReplayBuffer: { id: number; event: L2ChainEvent }[] = [];
  private sseEventIdCounter = 0;
  private eventDisconnect: (() => void) | null = null;

  constructor(config: NautilusAppConfig) {
    this.config = config;
    this.localState = new NautilusLocalState(config.stateDir);
    this.publicHosts = config.publicHosts ?? resolvePublicHosts(process.env);
    // A list naming anything but addresses stops the node here, whether it came from the config or the environment.
    this.trustedProxies = config.trustedProxies
      ? trustedProxyList(config.trustedProxies, 'trustedProxies')
      : resolveTrustedProxies(process.env);
    // Bound to loopback, a node that answers a public name is reached through a reverse proxy on this host, so every
    // request's socket is the proxy's, and unless the node trusts that proxy each per-caller limit counts everyone as
    // one. A proxy on this host connects from a loopback address of the bind's family, so only a trusted address of
    // that family can be that proxy; the warning asked every loopback node for 127.0.0.1 and any entry silenced it, so
    // a node bound to ::1 that followed it still counted every caller as one (the review of the trusted-proxy fix).
    // Node binds localhost to whichever of 127.0.0.1 and ::1 it resolves first, unknown here, so localhost asks for
    // both: the one it did not bind costs nothing, since no connection comes from it.
    const sources = loopbackProxySources(config.host);
    const untrusted = sources.filter((source) => !trustsLoopbackProxy(this.trustedProxies, source));
    if (this.publicHosts.length > 0 && untrusted.length > 0) {
      console.warn(
        '  [net] %s is bound to %s and answers %s, so those requests come through a reverse proxy on this host, and ' +
          'unless ZKTRIDENT_TRUSTED_PROXIES lists the address that proxy connects from, every caller counts as the ' +
          'proxy: one source for each per-caller limit. Add %s to ZKTRIDENT_TRUSTED_PROXIES%s so the node reads ' +
          'X-Forwarded-For from the proxy.',
        config.displayName ?? `${config.role} node`, config.host, this.publicHosts.join(', '), untrusted.join(' and '),
        sources.length > 1 ? ' (Node binds localhost to whichever of 127.0.0.1 and ::1 it resolves first)' : '',
      );
    }
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

  /** Issue a session. Called only after the PIN has been verified. A session it replaces ends, with the streams it opened. */
  issueDeviceSession(): { token: string; expiresInMs: number } {
    const token = randomBytes(32).toString('base64url');
    const ttl = NautilusAppServer.DEVICE_SESSION_TTL_MS;
    this.deviceSession = { token, expiresAt: Date.now() + ttl };
    this.endDeviceStreams();
    return { token, expiresInMs: ttl };
  }

  /** Drop the session, and end the event streams it opened. Called when the device locks or is ejected. */
  clearDeviceSession(): void {
    this.deviceSession = null;
    this.endDeviceStreams();
  }

  /** Whether `token` is still this device's session: not replaced, cleared or expired. */
  private deviceSessionCurrent(token: string): boolean {
    const session = this.deviceSession;
    return session !== null && session.token === token && Date.now() <= session.expiresAt;
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
  signedFetch(url: string, init: SignedFetchInit = {}): Promise<Response> {
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

  // ─── Who a request comes from ─────────────────────────────

  /**
   * The key a per-caller limit counts a request under (the review of A-89's limits): addressKey of the client's
   * address, which is the socket's unless the socket is a reverse proxy this node trusts, and then the client that
   * proxy names in X-Forwarded-For (clientAddress). Behind a proxy it does not trust, every caller is the proxy.
   *
   * A request this server routes is keyed once, as it arrives (handleRequest), and keeps that key. Node reads a
   * socket's address from the open connection and has none to give once the socket has closed, so a route that read it
   * only after an await found none for a client that half-closed its connection right after sending, and counted that
   * client under 'unknown', the one key every such client shares (the review of the open-intake limits). A request the
   * server did not route, as a test that calls a handler directly makes, is keyed from its socket as it stands.
   */
  callerKey(req: IncomingMessage): string {
    return this.callerKeys.get(req) ?? this.callerKeyNow(req);
  }

  /** callerKey from the request as it stands: its socket's address now, which is gone once the socket has closed. */
  private callerKeyNow(req: IncomingMessage): string {
    return addressKey(clientAddress(req.socket?.remoteAddress, req.headers?.['x-forwarded-for'], this.trustedProxies));
  }

  // ─── Route Registration ───────────────────────────────────

  /** Register entity-specific routes */
  registerRoutes(routes: RouteRegistration[]): void {
    for (const route of routes) {
      this.routes.push(compileRoute(route));
    }
  }

  /** The body types the registered route a request reaches reads: its own (`bodyTypes`), otherwise JSON (A-82). */
  private bodyTypesFor(method: string, pathname: string): readonly string[] {
    const route = this.routes.find((r) => r.method === method && r.pattern.test(pathname));
    return route?.bodyTypes ?? JSON_BODY;
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
    this.deviceStreams.clear();
    this.streamTickets.clear();

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
    // Who the request comes from is read first, while its socket is still open: a closed one has no address (callerKey).
    this.callerKeys.set(req, this.callerKeyNow(req));

    // A-82: the request must name this node in its Host, or a page rebound to loopback could read every answer.
    if (!requestHostAllowed(req, { bindHost: this.config.host, publicHosts: this.publicHosts, tls: this.tls })) {
      return this.sendResponse(res, 421, false, undefined, MISDIRECTED_REQUEST);
    }

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
    // A-82: no other site may frame a page this node serves.
    for (const [name, value] of Object.entries(NO_FRAMING_HEADERS)) res.setHeader(name, value);

    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // A-82: a body method declares the type its route reads (JSON unless the route takes a document), so a browser
    // asks before it sends one cross-site, and a form or text/plain post from another site goes no further.
    if (!bodyTypeAccepted(req, this.bodyTypesFor(method, pathname))) {
      return this.sendResponse(res, 415, false, undefined, UNSUPPORTED_BODY_TYPE);
    }

    // ── Built-in routes ──

    if (pathname === '/health' && method === 'GET') {
      return this.handleHealth(req, res);
    }

    if (pathname === '/onboarding/status' && method === 'GET') {
      return this.handleOnboardingStatus(req, res);
    }

    if (pathname === '/events' && method === 'GET') {
      return this.handleSSE(req, res, url);
    }

    if (pathname === '/events/ticket' && method === 'POST') {
      return this.handleStreamTicket(req, res);
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

      // Parse body for POST/PUT/DELETE as JSON, except for a route that reads its own body type (bodyTypes, the CP 575
      // upload): its handler reads the request itself.
      let body: unknown = undefined;
      if ((method === 'POST' || method === 'PUT' || method === 'DELETE') && !route.bodyTypes) {
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

    // A member node signs what it forwards as the wallet, so its proxy answers only the device itself:
    // the session issued at unlock, or this node's own admin credential, as for every device-only route.
    // Before this, any local process or allowed origin could read the member's claims and messages
    // through this port for as long as the device's state stayed unlocked.
    if (this.config.role === 'member' && !this.checkDeviceAuth(req)
      && !(await this.checkNautilusAdminAuth(req, 'POST', '/rpc'))) {
      this.sendJson(res, 401, {
        jsonrpc: '2.0', id: null,
        error: { code: -32001, message: 'This device is locked. Unlock with your PIN to obtain a device session.' },
      });
      return;
    }

    try {
      const body = await this.readBody(req);

      let method: string | undefined;
      let params: unknown;
      try {
        const request = JSON.parse(body) as { method?: string; params?: unknown };
        method = request.method;
        params = request.params;
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

      // The proxy signs what it forwards with this node's key or wallet, so a read of a member's data sent through it
      // is read with this node's rights on behalf of whoever reached the port. An insurer node's key reads every
      // member as the plan (the sequencer's D1 gate admits it for any wallet), so an open proxy handed any member's
      // quote to anyone. A member node's proxy answers only the device's session (above); any other node forwards
      // such a read (callReadsMemberData: the D1 table) only for its own administrator.
      if (this.config.role !== 'member' && callReadsMemberData(method, params)
        && !(await this.checkNautilusAdminAuth(req, 'POST', '/rpc'))) {
        this.sendJson(res, 403, {
          jsonrpc: '2.0', id: null,
          error: { code: -32004, message: `Forbidden — ${method} returns a member's data, and this node's proxy forwards it only for this node's administrator` },
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

  /*
   * A-79, found by the security posture check of 2026-10-24. This relay re-served the sequencer's event stream, which
   * names the wallet of every proof it accepts, to anything that reached the port, though the sequencer gates its own
   * stream (D2). Once the insurer node serves the marketplace to employers, an employer's browser could read the wallet
   * stream, which I6 forbids; on any node, so could a page rebound to loopback.
   *
   * The stream now answers this node's own credential: the device's session on a member node, this node's admin
   * credential on any node. A browser's EventSource cannot send a header, so a page trades its credential for a ticket
   * (POST /events/ticket) and opens /events?ticket=...; a ticket opens one stream, within 30 s, so a URL copied out of
   * a log or the network panel opens nothing. A stream opened under the device's session ends with that session.
   *
   * What reaches a client is narrowed by role as well. A member node forwards an event that names a wallet only when
   * the wallet is its own, which is all its page reads. An insurer node, which also serves the marketplace's pages,
   * forwards none: its page counts and lists events and reads no wallet from them. The wallets an event names are read
   * from its wallet fields, one ID or a list, eight levels down, and an event nested deeper is not forwarded. Free text
   * is not read for wallets, since the sequencer's rejection reasons quote roots as well, and a root mismatch, the
   * routine rejection when enrollments race, belongs in the insurer's event log. Instead both nodes send a copy of the
   * event with every run of 30 or more digits in its free text cut to an ellipsis, so neither a quoted wallet nor a
   * quoted root reaches the page, and the event still arrives.
   */

  private async handleSSE(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (!this.config.enableSSE) {
      this.sendResponse(res, 404, false, undefined, 'SSE disabled');
      return;
    }

    const ticket = url.searchParams.get('ticket');
    const admitted = ticket !== null ? this.redeemStreamTicket(ticket) : await this.streamPrincipal(req, 'GET', '/events');
    if (!admitted) return this.sendResponse(res, 401, false, undefined, this.streamRefusal());

    if (this.sseClients.size >= this.config.maxSseConnections) {
      this.sendResponse(res, 503, false, undefined, 'Too many SSE connections');
      return;
    }

    // No Connection header, so Node answers as HTTP/1.1 has a server do: a client's connection stays open after its
    // stream for its next request, unless the client asked to close it, and then it closes as the stream ends (the
    // device's session ending, the node stopping). Naming keep-alive here overrode a client's "close", and the
    // connection outlived the stream by Node's keep-alive timeout, as the explorer's relay did before it (A-83).
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
    });

    this.sseClients.add(res);
    if (admitted.deviceSession !== null) this.deviceStreams.set(res, admitted.deviceSession);
    res.write(`data: ${l2Stringify({ type: 'connected', role: this.config.role, timestamp: Date.now() })}\n\n`);

    // Replay from buffer
    const lastIdParam = url.searchParams.get('lastEventId');
    if (lastIdParam !== null) {
      const lastId = parseInt(lastIdParam, 10);
      if (!isNaN(lastId)) {
        for (const entry of this.sseReplayBuffer) {
          if (entry.id > lastId && this.relays(entry.event)) {
            res.write(`id: ${entry.id}\ndata: ${l2Stringify(this.streamed(entry.event))}\n\n`);
          }
        }
      }
    }

    req.on('close', () => this.endStream(res));
  }

  /** POST /events/ticket: a single-use ticket that opens one stream, for the credential that asked (A-79). */
  private async handleStreamTicket(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.config.enableSSE) {
      this.sendResponse(res, 404, false, undefined, 'SSE disabled');
      return;
    }
    const principal = await this.streamPrincipal(req, 'POST', '/events/ticket');
    if (!principal) return this.sendResponse(res, 401, false, undefined, this.streamRefusal());
    this.sendResponse(res, 200, true, this.issueStreamTicket(principal.deviceSession));
  }

  /**
   * Who may read this node's event stream: on a member node the device, by its session, and on any node this node's
   * administrator. Null for anyone else. A stream the device's session opens carries that session's token.
   */
  private async streamPrincipal(req: IncomingMessage, method: string, path: string): Promise<{ deviceSession: string | null } | null> {
    const session = this.deviceSession;
    if (this.config.role === 'member' && session && this.checkDeviceAuth(req)) return { deviceSession: session.token };
    if (await this.checkNautilusAdminAuth(req, method, path)) return { deviceSession: null };
    return null;
  }

  private streamRefusal(): string {
    return this.config.role === 'member'
      ? 'This device is locked. Unlock with your PIN to obtain a device session.'
      : "Unauthorized: this node's event stream answers only this node's administrator";
  }

  private issueStreamTicket(deviceSession: string | null): { ticket: string; expiresInMs: number } {
    const now = Date.now();
    for (const [ticket, entry] of this.streamTickets) {
      if (entry.expiresAt < now) this.streamTickets.delete(ticket);
    }
    while (this.streamTickets.size >= STREAM_TICKET_LIMIT) {
      const oldest = this.streamTickets.keys().next().value;
      if (oldest === undefined) break;
      this.streamTickets.delete(oldest);
    }
    const ticket = randomBytes(32).toString('base64url');
    this.streamTickets.set(ticket, { expiresAt: now + STREAM_TICKET_TTL_MS, deviceSession });
    return { ticket, expiresInMs: STREAM_TICKET_TTL_MS };
  }

  /** A ticket opens one stream, within its lifetime, and only while the device session it was issued under lasts. */
  private redeemStreamTicket(ticket: string): { deviceSession: string | null } | null {
    const entry = this.streamTickets.get(ticket);
    if (!entry) return null;
    this.streamTickets.delete(ticket);
    if (Date.now() > entry.expiresAt) return null;
    if (entry.deviceSession !== null && !this.deviceSessionCurrent(entry.deviceSession)) return null;
    return { deviceSession: entry.deviceSession };
  }

  /** Whether an event goes to this node's stream clients: see the note above handleSSE. */
  private relays(event: L2ChainEvent): boolean {
    if (!this.narrowsStream()) return true;
    const wallets = walletsNamed(event.data);
    if (wallets === null) return false;
    if (wallets.length === 0) return true;
    if (this.config.role === 'insurer') return false;
    const own = this.localState.getState()?.walletId ?? this.entityNode?.getWalletId();
    return own !== undefined && wallets.every((w) => w === own);
  }

  /** The event a stream sends: on a member or insurer node, a copy with the long digit runs cut from its free text. */
  private streamed(event: L2ChainEvent): L2ChainEvent {
    if (!this.narrowsStream()) return event;
    return { ...event, data: withoutLongDigitRuns(event.data) as Record<string, unknown> };
  }

  /** Member and insurer nodes narrow what their streams carry: see the note above handleSSE. */
  private narrowsStream(): boolean {
    return this.config.role === 'member' || this.config.role === 'insurer';
  }

  private endStream(client: ServerResponse): void {
    this.sseClients.delete(client);
    this.deviceStreams.delete(client);
    try { client.end(); } catch { /* socket already dead */ }
  }

  /** End every stream the device's session opened: the session has ended or been replaced. */
  private endDeviceStreams(): void {
    for (const client of [...this.deviceStreams.keys()]) this.endStream(client);
  }

  private broadcastSSE(event: L2ChainEvent): void {
    this.sseEventIdCounter++;
    this.sseReplayBuffer.push({ id: this.sseEventIdCounter, event });
    if (this.sseReplayBuffer.length > SSE_REPLAY_BUFFER_SIZE) {
      this.sseReplayBuffer.shift();
    }
    if (!this.relays(event)) return;

    const data = l2Stringify(this.streamed(event));
    for (const client of this.sseClients) {
      // A stream the device's session opened ends once that session has expired.
      const session = this.deviceStreams.get(client);
      if (session !== undefined && !this.deviceSessionCurrent(session)) {
        this.endStream(client);
        continue;
      }
      try {
        client.write(`id: ${this.sseEventIdCounter}\ndata: ${data}\n\n`);
      } catch {
        this.endStream(client);
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
