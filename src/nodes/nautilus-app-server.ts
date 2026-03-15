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

// ─── Constants ──────────────────────────────────────────────

const MAX_BODY_BYTES = 1 * 1024 * 1024; // 1MB
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

  /** Set the entity node after onboarding completes */
  setEntityNode(node: EntityNodeBase): void {
    // Disconnect previous SSE bridge if any
    if (this.eventDisconnect) {
      this.eventDisconnect();
      this.eventDisconnect = null;
    }
    this.entityNode = node;

    // Bridge entity node SSE events to app SSE clients
    if (this.config.enableSSE) {
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

    // Request timeout (exclude SSE)
    const isSSE = pathname === '/events';
    if (!isSSE) {
      const timeout = setTimeout(() => {
        if (!res.writableEnded) {
          this.sendJson(res, 504, { ok: false, error: 'Request timeout', timestamp: Date.now() });
        }
      }, REQUEST_TIMEOUT_MS);
      res.on('finish', () => clearTimeout(timeout));
    }

    // CORS
    const origin = req.headers.origin ?? '*';
    const allowed = this.config.allowedOrigins;
    const corsOrigin = allowed.includes('*') ? '*' : (allowed.includes(origin) ? origin : 'null');
    res.setHeader('Access-Control-Allow-Origin', corsOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // ── Built-in routes ──

    if (pathname === '/health' && method === 'GET') {
      return this.handleHealth(res);
    }

    if (pathname === '/onboarding/status' && method === 'GET') {
      return this.handleOnboardingStatus(res);
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

      // Admin auth check — always enforce for admin routes
      if (route.adminOnly) {
        if (!this.config.adminToken) {
          return this.sendResponse(res, 403, false, undefined, 'Admin routes require adminToken configuration');
        }
        const authHeader = req.headers['authorization'];
        if (authHeader !== `Bearer ${this.config.adminToken}`) {
          return this.sendResponse(res, 401, false, undefined, 'Unauthorized');
        }
      }

      // Extract path params
      const params: Record<string, string> = {};
      for (let i = 0; i < route.paramNames.length; i++) {
        params[route.paramNames[i]] = decodeURIComponent(match[i + 1]);
      }

      // Parse body for POST/PUT/DELETE
      let body: unknown = undefined;
      if (method === 'POST' || method === 'PUT' || method === 'DELETE') {
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

  private handleHealth(res: ServerResponse): void {
    const health: NautilusHealthResponse = {
      role: this.config.role,
      phase: this.onboardingPhase,
      sequencerConnected: this.entityNode !== null,
      walletId: this.entityNode?.getWalletId(),
      displayName: this.config.displayName,
      uptime: this.startTime > 0 ? Date.now() - this.startTime : 0,
      tls: this.tls,
    };
    this.sendResponse(res, 200, true, health);
  }

  private handleOnboardingStatus(res: ServerResponse): void {
    const state = this.localState.getState();
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

    try {
      const body = await this.readBody(req);
      const upstream = await fetch(seqUrl.replace(/\/+$/, '') + '/rpc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let totalBytes = 0;

      req.on('data', (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_BODY_BYTES) {
          req.destroy();
          reject(new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes`));
          return;
        }
        chunks.push(chunk);
      });

      req.on('end', () => {
        resolve(Buffer.concat(chunks).toString('utf-8'));
      });

      req.on('error', reject);
    });
  }

  /** Number of connected SSE clients */
  getSSEClientCount(): number {
    return this.sseClients.size;
  }
}
