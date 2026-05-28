/**
 * L2RpcServer — HTTP JSON-RPC server for the zkpCare L2 chain.
 *
 * Wraps an L2Node with an HTTP API:
 *   POST /rpc     — JSON-RPC 2.0 endpoint (proof submission, queries)
 *   GET  /events  — Server-Sent Events stream (real-time chain events)
 *   GET  /health  — Simple health check
 *
 * Zero external dependencies — uses Node.js built-in http module.
 *
 * Usage:
 *   const server = new L2RpcServer(node, { port: 3030 });
 *   await server.start();
 *   // ... clients connect via L2Client ...
 *   await server.stop();
 */
import fs from 'fs';
import path from 'path';
import http from 'http';
import https from 'https';
import type { IncomingMessage, ServerResponse } from 'http';
import { timingSafeEqual, createHash, createPublicKey, verify } from 'crypto';
import { Field } from 'o1js';
import { WalletState } from '../wallets/wallet-state.js';
import { StateTransitionProof } from '../engine/state-transition.js';
import type { L2Node, L2ChainEvent, L2EventHandler } from './l2-node.js';
import { L2Leviathan } from './l2-leviathan.js';
import { l2Stringify, l2Parse } from './l2-json.js';
import type { L2PeerNetwork } from './l2-peer-network.js';
import type { GossipMessage, PeerInfo, StateDigest } from './l2-peer-types.js';
import { ProviderLifecycle, PROVIDER_TYPE_TAG } from './provider-registry-types.js';
import type { ProviderType } from './provider-registry-types.js';
import type { BenefitPlanConfig } from './l2-types.js';
import { hashString } from '../zkp/hash-utils.js';
import { AuditService } from '../audit/audit-service.js';

// ─── Visualization Types ──────────────────────────────────

/** Visualization event types for the dashboard */
export type VizEventType =
  | 'viz:token:generated' | 'viz:token:consumed'
  | 'viz:enrollment:started' | 'viz:enrollment:complete'
  | 'viz:eligibility:check' | 'viz:eligibility:verified'
  | 'viz:formulary:check' | 'viz:formulary:verified'
  | 'viz:prescription:written' | 'viz:prescription:sent'
  | 'viz:prescription:received' | 'viz:prescription:status'
  | 'viz:fulfillment:started' | 'viz:fulfillment:settled' | 'viz:fulfillment:reversed'
  | 'viz:pharmacy:dispensed' | 'viz:pharmacy:rejected' | 'viz:pharmacy:credential_scan'
  | 'viz:accumulator:updated' | 'viz:reversal:processed'
  | 'viz:message:sent' | 'viz:message:received'
  | 'viz:delegation:created'
  | 'viz:batch:submitted' | 'viz:batch:settled'
  | 'viz:enrollment:wallet_derived' | 'viz:enrollment:proof_gate'
  | 'viz:enrollment:registration' | 'viz:enrollment:credential_mint'
  | 'viz:enrollment:lifecycle' | 'viz:enrollment:provider_notify'
  | 'viz:enrollment:terminated'
  | 'viz:credential:generated'
  | 'viz:proving:started' | 'viz:proving:completed'
  | 'viz:leviathan:heartbeat' | 'viz:leviathan:failover' | 'viz:leviathan:gossip'
  | 'viz:worker:spawned' | 'viz:worker:compiling' | 'viz:worker:ready'
  | 'viz:worker:compile_timeout' | 'viz:worker:compile_failed'
  | 'viz:worker:assigned' | 'viz:worker:completed' | 'viz:worker:crashed';

/** Lane names for the horse-race view */
export type VizLane = 'enrollment' | 'eligibility' | 'prescription' | 'fulfillment' | 'messaging' | 'batch' | 'leviathan';

/** Actor types in the system */
export type VizActorType = 'member' | 'prescriber' | 'pharmacy' | 'insurer' | 'employer' | 'leviathan' | 'worker';

/** A visualization event pushed by the scenario script */
export interface VizEvent {
  type: VizEventType;
  timestamp: number;
  id: string;
  actor: string;
  actorType: VizActorType;
  actorWalletId?: string;
  target?: string;
  targetType?: string;
  targetWalletId?: string;
  data: Record<string, unknown>;
  lane: VizLane;
  stage: number;
  totalStages: number;
}

/** Entity metadata for display */
export interface VizEntity {
  walletId: string;
  displayName: string;
  type: VizActorType;
  group?: string;
  specialty?: string;
  pharmacyType?: string;
  /** X25519 encryption public key hex (64 chars = 32 bytes) for E2E messaging.
   *  Derived from enrollment key. NOT wallet key material — ancillary encryption only. */
  encryptionPublicKeyHex?: string;
}

// ─── Configuration ──────────────────────────────────────

/** Configuration for the L2 RPC server */
export interface L2RpcServerOptions {
  /** Port to listen on. Default 3030. */
  port: number;
  /** Host to bind to. Default '127.0.0.1'. */
  host: string;
  /** Maximum request body size in bytes. Default 10MB (proofs are large). */
  maxBodyBytes: number;
  /** Whether to enable SSE event streaming. Default true. */
  enableSSE: boolean;
  /** Bearer token for admin RPC methods (unsecure mode only). When set, admin methods require Authorization header. */
  adminToken?: string;
  /** Authorized admin node public keys: Map<nodeId, publicKeyHex>. When set, admin methods require Ed25519 signature. */
  adminKeys?: Map<string, string>;
  /** Whether to use unsecure mode (shared Bearer token instead of Ed25519 signatures). */
  unsecureMode?: boolean;
  /** Allowed CORS origins. Default ['http://localhost', 'http://127.0.0.1']. Set to ['*'] for open access. */
  allowedOrigins?: string[];
  /** Maximum concurrent SSE connections. Default 100. */
  maxSseConnections?: number;
  /** Max proof submissions per IP per minute. Default 60. Set to 0 to disable. */
  proofRateLimitPerMinute?: number;
  /** TLS certificate file path (PEM). When set with tlsKey, enables HTTPS. */
  tlsCert?: string;
  /** TLS private key file path (PEM). When set with tlsCert, enables HTTPS. */
  tlsKey?: string;
  /** Directory containing dashboard static files. When set, serves files at /. */
  dashboardDir?: string;
}

/** Default server options */
export const DEFAULT_RPC_SERVER_OPTIONS: L2RpcServerOptions = {
  port: 3030,
  host: '127.0.0.1',
  maxBodyBytes: 20 * 1024 * 1024, // 20MB — Option C eliminates 10MB formulary blobs
  enableSSE: true,
};

// ─── JSON-RPC 2.0 Types ────────────────────────────────

/** JSON-RPC 2.0 request */
export interface RpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

/** JSON-RPC 2.0 response */
export interface RpcResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// ─── RPC Error Codes ────────────────────────────────────

/** Standard JSON-RPC 2.0 error codes */
export const RPC_PARSE_ERROR = -32700;
export const RPC_INVALID_REQUEST = -32600;
export const RPC_METHOD_NOT_FOUND = -32601;
export const RPC_INVALID_PARAMS = -32602;
export const RPC_INTERNAL_ERROR = -32603;

/** Custom error codes */
export const RPC_PROOF_REJECTED = -32001;
export const RPC_NODE_NOT_RUNNING = -32002;
export const RPC_UNAUTHORIZED = -32003;

// ─── L2RpcServer ────────────────────────────────────────

export class L2RpcServer {
  private node: L2Node | L2Leviathan;
  private options: L2RpcServerOptions;
  private server: http.Server | https.Server;
  private sseClients: Set<ServerResponse> = new Set();
  private eventHandler: L2EventHandler;
  private listening = false;

  /** Optional entity proof pool status getter (set by start-leviathan.ts) */
  private entityProofPoolStatusFn: (() => { status: Record<string, unknown>; workers: Record<string, unknown>[] }) | null = null;

  /** Register an entity proof pool status provider for the health/status endpoints. */
  setEntityProofPoolStatus(fn: () => { status: Record<string, unknown>; workers: Record<string, unknown>[] }): void {
    this.entityProofPoolStatusFn = fn;
  }

  /** Admin-only RPC methods that require authentication (Ed25519 signature or Bearer token) */
  private static readonly ADMIN_METHODS = new Set([
    'l2_forceBatch',
    'l2_storeFormulary',
    'l2_storePlan',
    'l2_deletePlan',
    'l2_registerEntity',
    'l2_credentialProvider',
    'l2_updateProviderStatus',
    'l2_requestSnapshot',
    'l2_gossipRelay',
    'l2_recordFill',
    'l2_publishPlanOverlay',
    'l2_revokeAdminKey',
    'l2_approveAdmission',
    'l2_registerEmployer',
    'l2_revokeEmployerAttestation',
    'l2_registerEmployerNode',
    'l2_deregisterEmployerNode',
  ]);

  // M9 fix: SSE replay buffer for chain events (ring buffer, max 256)
  private sseReplayBuffer: { id: number; event: L2ChainEvent }[] = [];
  private sseEventIdCounter = 0;
  private static readonly SSE_REPLAY_BUFFER_SIZE = 256;

  // Visualization support
  private vizSseClients: Set<ServerResponse> = new Set();
  private vizEventBuffer: VizEvent[] = [];
  private vizEventIdCounter = 0;
  private entityRegistry: Map<string, VizEntity> = new Map();

  // PCP assignment registry: prescriberWalletId → [{ memberWalletId, effectiveDate }]
  private pcpAssignments: Map<string, { memberWalletId: string; effectiveDate: string; timestamp: number }[]> = new Map();

  // Peer network (set externally when replication is enabled)
  private peerNetwork: L2PeerNetwork | null = null;

  // Rate limiting
  private proofSubmissionLog: Map<string, number[]> = new Map();
  private rateLimitSweepTimer: ReturnType<typeof setInterval> | null = null;

  // Dynamic route registration
  private additionalRoutes: Map<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>> = new Map();

  // Dashboard static file directory
  private dashboardDir: string | null = null;

  constructor(node: L2Node | L2Leviathan, options?: Partial<L2RpcServerOptions>) {
    this.node = node;
    this.options = { ...DEFAULT_RPC_SERVER_OPTIONS, ...options };
    this.dashboardDir = this.options.dashboardDir ?? null;

    // Initialize admin key registry from options
    this.initAdminKeys();

    // Bridge L2Node events to SSE clients
    this.eventHandler = (event: L2ChainEvent) => {
      this.broadcastSSE(event);
    };

    if (this.options.enableSSE) {
      this.node.on(this.eventHandler);
    }

    const requestHandler = (req: IncomingMessage, res: ServerResponse) => {
      this.handleRequest(req, res).catch(() => {
        if (!res.writableEnded) {
          res.writeHead(500);
          res.end('Internal Server Error');
        }
      });
    };

    // Create HTTP or HTTPS server based on TLS configuration
    if (this.options.tlsCert && this.options.tlsKey) {
      this.server = https.createServer({
        cert: fs.readFileSync(this.options.tlsCert),
        key: fs.readFileSync(this.options.tlsKey),
      }, requestHandler);
    } else {
      this.server = http.createServer(requestHandler);
    }
  }

  /** Programmatically seed entities into the entity registry (e.g. seed providers on startup) */
  seedEntities(entities: VizEntity[]): void {
    for (const entity of entities) {
      this.entityRegistry.set(entity.walletId, entity);
    }
  }

  // ─── Lifecycle ──────────────────────────────────────────

  /** Start listening for HTTP connections */
  async start(): Promise<void> {
    if (this.listening) return;

    // Prune inactive IPs from rate limit map every 5 minutes
    this.rateLimitSweepTimer = setInterval(() => {
      const now = Date.now();
      const windowMs = 60_000;
      for (const [ip, timestamps] of this.proofSubmissionLog) {
        const active = timestamps.filter(t => now - t < windowMs);
        if (active.length === 0) {
          this.proofSubmissionLog.delete(ip);
        } else {
          this.proofSubmissionLog.set(ip, active);
        }
      }
    }, 300_000);

    return new Promise<void>((resolve, reject) => {
      this.server.listen(this.options.port, this.options.host, () => {
        this.listening = true;
        resolve();
      });
      this.server.once('error', reject);
    });
  }

  /** Gracefully stop the server. Closes all SSE connections. */
  async stop(): Promise<void> {
    if (!this.listening) return;

    // Close all SSE connections
    for (const client of this.sseClients) {
      try { client.end(); } catch { /* ignore */ }
    }
    this.sseClients.clear();

    // Close viz SSE connections
    for (const client of this.vizSseClients) {
      try { client.end(); } catch { /* ignore */ }
    }
    this.vizSseClients.clear();

    // Unsubscribe from node events
    if (this.options.enableSSE) {
      this.node.off(this.eventHandler);
    }

    // Clear rate limiting state
    if (this.rateLimitSweepTimer) {
      clearInterval(this.rateLimitSweepTimer);
      this.rateLimitSweepTimer = null;
    }
    this.proofSubmissionLog.clear();

    return new Promise<void>((resolve) => {
      this.server.close(() => {
        this.listening = false;
        resolve();
      });
    });
  }

  /** Whether the server is currently listening */
  isListening(): boolean {
    return this.listening;
  }

  /** Number of connected SSE clients */
  getSSEClientCount(): number {
    return this.sseClients.size;
  }

  /** Get the actual port the server is listening on (useful when port=0) */
  getPort(): number {
    const addr = this.server.address();
    if (addr && typeof addr === 'object') {
      return addr.port;
    }
    return this.options.port;
  }

  /**
   * Register a custom route handler.
   * Routes are matched as "METHOD:PATH" (e.g. "GET:/interactive/state").
   */
  registerRoute(
    method: string,
    path: string,
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
    options?: { adminOnly?: boolean },
  ): void {
    this.additionalRoutes.set(`${method.toUpperCase()}:${path}`, handler);
    if (options?.adminOnly) {
      this.adminGatedRoutes.add(`${method.toUpperCase()}:${path}`);
    }
  }

  /** Routes registered via registerRoute that require admin auth */
  private adminGatedRoutes: Set<string> = new Set();

  /** Set the peer network for gossip relay and peer queries */
  setPeerNetwork(network: L2PeerNetwork): void {
    this.peerNetwork = network;
  }

  // ─── Request Handling ─────────────────────────────────

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // M10 fix: Server-side request timeout (30s default, excludes SSE streams)
    const isSSE = req.url?.startsWith('/events') || req.url?.startsWith('/viz/events') || req.url?.startsWith('/interactive/console');
    if (!isSSE) {
      const timeout = setTimeout(() => {
        if (!res.writableEnded) {
          res.writeHead(504, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Request timeout' }));
        }
      }, 30_000);
      res.on('finish', () => clearTimeout(timeout));
    }

    // CORS headers — default restrictive (localhost only)
    const origin = req.headers.origin ?? '';
    const allowed = this.options.allowedOrigins ?? ['http://localhost', 'http://127.0.0.1'];
    const corsOrigin = allowed.includes('*') ? '*' : (allowed.includes(origin) ? origin : 'null');
    res.setHeader('Access-Control-Allow-Origin', corsOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Admin-Signature');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; connect-src 'self' http://localhost:* http://127.0.0.1:*; img-src 'self' data:");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const pathname = url.pathname;

    if (pathname === '/health' && req.method === 'GET') {
      return this.handleHealth(res);
    }

    if (pathname === '/events' && req.method === 'GET') {
      return this.handleSSE(req, res);
    }

    if (pathname === '/rpc' && req.method === 'POST') {
      return this.handleRpc(req, res);
    }

    // ── Viz Endpoints ──
    // Write endpoints require admin token; read endpoints are open
    if (pathname === '/viz/emit' && req.method === 'POST') {
      if (!this.checkAdminAuth(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
      return this.handleVizEmit(req, res);
    }

    if (pathname === '/viz/events' && req.method === 'GET') {
      return this.handleVizSSE(req, res);
    }

    if (pathname === '/viz/entities' && req.method === 'POST') {
      if (!this.checkAdminAuth(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
      return this.handleVizEntityRegister(req, res);
    }

    if (pathname === '/viz/entities' && req.method === 'GET') {
      return this.handleVizEntitiesGet(res);
    }

    if (pathname === '/viz/state' && req.method === 'GET') {
      return this.handleVizState(res);
    }

    if (pathname === '/viz/history' && req.method === 'GET') {
      return this.handleVizHistory(res);
    }

    if (pathname === '/viz/clear' && req.method === 'POST') {
      if (!this.checkAdminAuth(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
      return this.handleVizClear(res);
    }

    // Check dynamically registered routes
    const routeKey = `${req.method}:${pathname}`;
    const customHandler = this.additionalRoutes.get(routeKey);
    if (customHandler) {
      // Admin auth check for gated routes (Tier 3 interactive routes)
      if (this.adminGatedRoutes.has(routeKey) && !this.checkAdminAuth(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized — admin auth required' }));
        return;
      }
      return customHandler(req, res);
    }

    // ── Dashboard static files ──
    if (req.method === 'GET' && this.dashboardDir) {
      const safePath = pathname === '/' ? '/index.html' : pathname;
      // Only allow alphanumeric, dots, hyphens, slashes — no ..
      if (/^[/a-zA-Z0-9._-]+$/.test(safePath) && !safePath.includes('..')) {
        // Strip leading slash so path.resolve treats it as relative to dashboardDir
        const relativePath = safePath.replace(/^\/+/, '');
        // Canonicalize and verify the resolved path stays within the dashboard directory
        const resolved = path.resolve(this.dashboardDir, relativePath);
        if (!resolved.startsWith(this.dashboardDir)) {
          // Path escapes dashboard directory
          res.writeHead(403);
          res.end('Forbidden');
          return;
        }
        const filePath = resolved;
        try {
          const content = fs.readFileSync(filePath);
          const ext = path.extname(filePath).toLowerCase();
          const mimeTypes: Record<string, string> = {
            '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
            '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
            '.ico': 'image/x-icon',
          };
          res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
          res.end(content);
          return;
        } catch { /* file not found, fall through to 404 */ }
      }
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }

  // ─── Health ───────────────────────────────────────────

  private handleHealth(res: ServerResponse): void {
    const mem = process.memoryUsage();
    const nodeStatus = this.node.getStatus() as unknown as Record<string, unknown>;

    const health: Record<string, unknown> = {
      ok: true,
      running: this.node.isRunning(),
      sseClients: this.sseClients.size,
      timestamp: Date.now(),
      memory: {
        rssMB: Math.round(mem.rss / 1024 / 1024),
        heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
        heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
        externalMB: Math.round(mem.external / 1024 / 1024),
      },
      chain: {
        pendingProofs: nodeStatus.pendingProofs ?? null,
        inFlightBatch: nodeStatus.inFlightBatch?.toString() ?? null,
        totalBatchesBuilt: nodeStatus.totalBatchesBuilt ?? null,
        totalBatchesSettled: nodeStatus.totalBatchesSettled ?? null,
        totalBatchesFailed: nodeStatus.totalBatchesFailed ?? null,
      },
    };

    // Include proving pool status if available (L2Node only, not Leviathan)
    if (!(this.node instanceof L2Leviathan)) {
      const pool = (this.node as L2Node).getProvingPool();
      if (pool) {
        health.provingPool = pool.getStatus();
        health.workers = pool.getWorkerStatuses();
      }
    }

    // Include entity proof pool status if registered
    if (this.entityProofPoolStatusFn) {
      const ep = this.entityProofPoolStatusFn();
      health.entityProofPool = ep.status;
      health.entityWorkers = ep.workers;
    }

    const body = JSON.stringify(health);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(body);
  }

  // ─── SSE ──────────────────────────────────────────────

  private handleSSE(req: IncomingMessage, res: ServerResponse): void {
    if (!this.options.enableSSE) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'SSE disabled' }));
      return;
    }

    // SSE connection limit — prevent memory exhaustion
    const maxSSE = this.options.maxSseConnections ?? 100;
    if (this.sseClients.size >= maxSSE) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Too many SSE connections' }));
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    this.sseClients.add(res);

    // Send initial connection event
    res.write(`data: ${l2Stringify({ type: 'connected', timestamp: Date.now() })}\n\n`);

    // M9 fix: Replay missed events from ring buffer.
    // Client can pass ?lastEventId=N to replay events after that ID.
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const lastEventIdParam = url.searchParams.get('lastEventId');
    if (lastEventIdParam !== null) {
      const lastEventId = parseInt(lastEventIdParam, 10);
      if (!isNaN(lastEventId)) {
        for (const entry of this.sseReplayBuffer) {
          if (entry.id > lastEventId) {
            const data = l2Stringify(entry.event);
            res.write(`id: ${entry.id}\ndata: ${data}\n\n`);
          }
        }
      }
    }

    // Clean up on disconnect
    req.on('close', () => {
      this.sseClients.delete(res);
      try { res.end(); } catch { /* already closed */ }
    });
  }

  private broadcastSSE(event: L2ChainEvent): void {
    // M9 fix: Store in ring buffer before broadcasting
    this.sseEventIdCounter = (this.sseEventIdCounter + 1) % Number.MAX_SAFE_INTEGER;
    this.sseReplayBuffer.push({ id: this.sseEventIdCounter, event });
    if (this.sseReplayBuffer.length > L2RpcServer.SSE_REPLAY_BUFFER_SIZE) {
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

  // ─── JSON-RPC ─────────────────────────────────────────

  private async handleRpc(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Read body with size limit
    let body: string;
    try {
      body = await this.readBody(req);
    } catch (err) {
      return this.sendRpcError(res, 0, RPC_PARSE_ERROR,
        err instanceof Error ? err.message : 'Failed to read request body');
    }

    // Parse JSON-RPC request
    let rpcReq: RpcRequest;
    try {
      rpcReq = l2Parse<RpcRequest>(body);
    } catch {
      return this.sendRpcError(res, 0, RPC_PARSE_ERROR, 'Invalid JSON');
    }

    // Validate JSON-RPC structure
    if (!rpcReq.jsonrpc || rpcReq.jsonrpc !== '2.0' || !rpcReq.method || rpcReq.id === undefined) {
      return this.sendRpcError(res, rpcReq?.id ?? 0, RPC_INVALID_REQUEST,
        'Invalid JSON-RPC 2.0 request');
    }

    // Admin auth gate — Ed25519 signature (secure) or Bearer token (unsecure)
    // l2_registerAdminKey is special: requires auth UNLESS this is genesis (no keys exist yet)
    const needsAuth = L2RpcServer.ADMIN_METHODS.has(rpcReq.method)
      || (rpcReq.method === 'l2_registerAdminKey' && this.adminKeyRegistry.size > 0);
    if (needsAuth) {
      if (this.options.unsecureMode || !this.adminKeyRegistry.size) {
        // Unsecure mode: legacy Bearer token check. Default-deny when no token configured.
        if (!this.options.adminToken) {
          return this.sendRpcError(res, rpcReq.id, RPC_UNAUTHORIZED, 'Unauthorized — no admin token configured');
        }
        const authHeader = req.headers['authorization'] ?? '';
        if (!L2RpcServer.safeEquals(authHeader, `Bearer ${this.options.adminToken}`)) {
          return this.sendRpcError(res, rpcReq.id, RPC_UNAUTHORIZED, 'Unauthorized');
        }
      } else {
        // Secure mode: Ed25519 signature required
        const sigResult = this.verifyAdminSignature(req, rpcReq.method, rpcReq.params ?? {});
        if (!sigResult.valid) {
          return this.sendRpcError(res, rpcReq.id, RPC_UNAUTHORIZED, 'Unauthorized — valid Ed25519 admin signature required');
        }
        // Inject verified signer identity into params for downstream handlers
        if (!rpcReq.params) rpcReq.params = {};
        (rpcReq.params as any)._verifiedNodeId = sigResult.nodeId;
        // Log the admin action with attribution
        console.log(`  [admin] ${rpcReq.method} by ${sigResult.nodeId} at ${new Date().toISOString()}`);
      }
    }

    // Proof submission rate limiting
    if (rpcReq.method === 'l2_submitProof') {
      const ip = req.socket.remoteAddress ?? 'unknown';
      if (!this.checkProofRateLimit(ip)) {
        return this.sendRpcError(res, rpcReq.id, RPC_INVALID_PARAMS, 'Rate limit exceeded');
      }
    }

    // Dispatch to method handler
    try {
      const result = await this.dispatchMethod(rpcReq.method, rpcReq.params ?? {});
      this.sendRpcResult(res, rpcReq.id, result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      // Classify error — pass through client-facing messages, sanitize internal errors
      if (message.includes('not found') || message.includes('Unknown method')) {
        this.sendRpcError(res, rpcReq.id, RPC_METHOD_NOT_FOUND, message);
      } else if (message.includes('verification failed') || message.includes('mismatch') || message.includes('REJECTED')) {
        this.sendRpcError(res, rpcReq.id, RPC_PROOF_REJECTED, message);
      } else if (message.includes('not running')) {
        this.sendRpcError(res, rpcReq.id, RPC_NODE_NOT_RUNNING, message);
      } else if (message.includes('Missing or invalid') || message.includes('not configured') || message.includes('Duplicate proof') || message.includes('Wrong partition') || message.includes('Not leader') || message.includes('Not a leviathan') || message.includes('already registered') || message.includes('registry full') || message.includes('unavailable') || message.includes('not known')) {
        this.sendRpcError(res, rpcReq.id, RPC_INVALID_PARAMS, message);
      } else {
        console.error(`[rpc] Internal error in ${rpcReq.method}:`, err);
        this.sendRpcError(res, rpcReq.id, RPC_INTERNAL_ERROR, 'Internal error');
      }
    }
  }

  // ─── Method Dispatch ──────────────────────────────────

  private async dispatchMethod(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    switch (method) {
      case 'l2_submitProof': {
        const proofJson = params.proofJson;
        if (!proofJson || typeof proofJson !== 'object') {
          throw new Error('Missing or invalid proofJson parameter');
        }
        const proof = await StateTransitionProof.fromJSON(
          proofJson as Parameters<typeof StateTransitionProof.fromJSON>[0],
        );
        const result = await this.node.submitProof(proof);

        // Auto-register entity metadata if provided alongside a registration proof.
        // The metadata is untrusted display data — the ZK proof guarantees the walletId.
        const entityMeta = params.entityMetadata as Record<string, string> | undefined;
        if (entityMeta && result && typeof result === 'object' && 'isRegistration' in result && (result as any).isRegistration) {
          const walletId = (result as any).walletId as string;
          if (walletId && entityMeta.displayName && entityMeta.type) {
            this.entityRegistry.set(walletId, {
              walletId,
              displayName: entityMeta.displayName,
              type: entityMeta.type as VizActorType,
              specialty: entityMeta.specialty,
              pharmacyType: entityMeta.pharmacyType,
              group: entityMeta.group,
            });
          }
        }

        return result;
      }

      case 'l2_syncWalletState': {
        // Sync the sequencer's walletRegistry tree with externally-submitted wallet updates.
        // Called by Nautilus nodes after submitting wallet update proofs (PCP assignment, etc.)
        // so the sequencer's witness tree stays in sync for future proof generation.
        const syncWalletId = params.walletId as string;
        const syncNewCredRoot = params.newCredentialInventoryRoot as string;
        const syncNewNonce = params.newNonce as string;
        if (!syncWalletId || !syncNewCredRoot || !syncNewNonce) {
          throw new Error('Missing walletId, newCredentialInventoryRoot, or newNonce');
        }
        try {
          const seq = this.node.getSequencer();
          const wid = Field(BigInt(syncWalletId));
          const newState = new WalletState({
            walletId: wid,
            credentialInventoryRoot: Field(BigInt(syncNewCredRoot)),
            nonce: Field(BigInt(syncNewNonce)),
          });
          seq.syncWalletState(wid, newState);
          return { synced: true };
        } catch (err) {
          return { synced: false, error: err instanceof Error ? err.message : String(err) };
        }
      }

      // ── Admin Key Management + Quorum Admission ──

      // l2_registerAdminKey — genesis-only direct registration (backward compat + bootstrap)
      case 'l2_registerAdminKey': {
        const nodeId = params.nodeId as string;
        const publicKeyHex = params.publicKeyHex as string;
        const reason = params.reason as string;
        if (!nodeId || !publicKeyHex || !reason) {
          throw new Error('Missing nodeId, publicKeyHex, or reason');
        }
        if (publicKeyHex.length !== 64) {
          throw new Error('publicKeyHex must be 32 bytes (64 hex chars)');
        }
        if (this.blacklistedNodes.has(nodeId) || this.blacklistedPublicKeys.has(publicKeyHex)) {
          throw new Error(`Node ${nodeId} is blacklisted`);
        }
        // Genesis bootstrap: only works when no admin keys exist yet
        if (this.adminKeyRegistry.size === 0) {
          const genesisKey = process.env.ZKTRIDENT_GENESIS_ADMIN_KEY;
          if (!genesisKey && !this.options.unsecureMode) {
            throw new Error('ZKTRIDENT_GENESIS_ADMIN_KEY must be set for first admin key registration in secure mode');
          }
          if (genesisKey && publicKeyHex !== genesisKey) {
            throw new Error('First admin key must match ZKTRIDENT_GENESIS_ADMIN_KEY');
          }
          this.adminKeyRegistry.set(nodeId, {
            publicKeyHex,
            admittedBy: 'genesis-bootstrap',
            reason,
            timestamp: Date.now(),
          });
          console.log(`  [admin] Genesis admin key registered: ${nodeId} (${publicKeyHex.slice(0, 16)}…)`);
          return { registered: true, nodeId, genesis: true };
        }
        // Non-genesis in unsecure mode: direct registration (backward compat)
        if (this.options.unsecureMode) {
          const admittedBy = params.admittedBy as string ?? 'admin';
          this.adminKeyRegistry.set(nodeId, {
            publicKeyHex,
            admittedBy,
            reason,
            timestamp: Date.now(),
          });
          console.log(`  [admin] Admin key registered (unsecure): ${nodeId} by ${admittedBy} — ${reason}`);
          return { registered: true, nodeId, genesis: false };
        }
        // Non-genesis in secure mode: must use l2_requestAdmission + l2_approveAdmission
        throw new Error('Post-genesis admin registration requires quorum admission — use l2_requestAdmission');
      }

      // l2_requestAdmission — new node requests to join the network (no auth required)
      case 'l2_requestAdmission': {
        const nodeId = params.nodeId as string;
        const publicKeyHex = params.publicKeyHex as string;
        if (!nodeId || !publicKeyHex) {
          throw new Error('Missing nodeId or publicKeyHex');
        }
        if (publicKeyHex.length !== 64) {
          throw new Error('publicKeyHex must be 32 bytes (64 hex chars)');
        }
        if (this.blacklistedNodes.has(nodeId) || this.blacklistedPublicKeys.has(publicKeyHex)) {
          throw new Error(`Node ${nodeId} is blacklisted`);
        }
        if (this.adminKeyRegistry.has(nodeId)) {
          return { status: 'already_admitted', nodeId };
        }
        if (this.pendingAdmissions.has(nodeId)) {
          const pending = this.pendingAdmissions.get(nodeId)!;
          return {
            status: 'pending',
            nodeId,
            approvals: pending.approvals.size,
            required: this.getAdmissionThreshold(),
          };
        }
        // Enforce capacity limit + sweep stale entries (24h TTL)
        const MAX_PENDING = 100;
        const TTL_MS = 24 * 60 * 60 * 1000;
        const now = Date.now();
        for (const [pid, pentry] of this.pendingAdmissions) {
          if (now - pentry.requestedAt > TTL_MS) this.pendingAdmissions.delete(pid);
        }
        if (this.pendingAdmissions.size >= MAX_PENDING) {
          throw new Error('Too many pending admissions — try again later');
        }
        this.pendingAdmissions.set(nodeId, {
          nodeId,
          publicKeyHex,
          requestedAt: now,
          approvals: new Map(),
        });
        console.log(`  [admission] Admission requested: ${nodeId} (${publicKeyHex.slice(0, 16)}…)`);
        return {
          status: 'pending',
          nodeId,
          approvals: 0,
          required: this.getAdmissionThreshold(),
        };
      }

      // l2_approveAdmission — existing admin approves a pending admission (auth required)
      case 'l2_approveAdmission': {
        const targetNodeId = params.nodeId as string;
        const reason = params.reason as string;
        if (!targetNodeId || !reason) {
          throw new Error('Missing nodeId or reason');
        }
        if (this.blacklistedNodes.has(targetNodeId)) {
          this.pendingAdmissions.delete(targetNodeId); // Clean stale pending
          throw new Error(`Node ${targetNodeId} is blacklisted — cannot approve`);
        }
        const pendingCheck = this.pendingAdmissions.get(targetNodeId);
        if (pendingCheck && this.blacklistedPublicKeys.has(pendingCheck.publicKeyHex)) {
          this.pendingAdmissions.delete(targetNodeId);
          throw new Error(`Node ${targetNodeId} public key is blacklisted — cannot approve`);
        }
        const pending = this.pendingAdmissions.get(targetNodeId);
        if (!pending) {
          throw new Error(`No pending admission for ${targetNodeId}`);
        }
        // Determine approver identity — injected by auth gate in secure mode
        const approverNodeId = (params as any)._verifiedNodeId as string ?? 'admin';

        // Record the approval with reason string
        pending.approvals.set(approverNodeId, {
          approverNodeId,
          reason,
          timestamp: Date.now(),
        });

        const threshold = this.getAdmissionThreshold();
        console.log(`  [admission] ${targetNodeId} approved by ${approverNodeId}: "${reason}" (${pending.approvals.size}/${threshold})`);

        // Filter out approvals from admins that have since been revoked
        for (const [approverId] of pending.approvals) {
          if (approverId !== 'admin' && !this.adminKeyRegistry.has(approverId)) {
            pending.approvals.delete(approverId);
          }
        }

        // Check if quorum is reached (with valid approvals only)
        if (pending.approvals.size >= threshold) {
          // Build the approval history
          const approvalHistory: { approverNodeId: string; reason: string; timestamp: number }[] = [];
          for (const [, approval] of pending.approvals) {
            approvalHistory.push(approval);
          }

          // Admit the node
          this.adminKeyRegistry.set(targetNodeId, {
            publicKeyHex: pending.publicKeyHex,
            admittedBy: approvalHistory.map(a => a.approverNodeId).join(','),
            reason: approvalHistory.map(a => `${a.approverNodeId}: "${a.reason}"`).join('; '),
            timestamp: Date.now(),
          });
          this.pendingAdmissions.delete(targetNodeId);

          console.log(`  [admission] ✓ ${targetNodeId} ADMITTED — quorum reached (${pending.approvals.size}/${threshold})`);

          return {
            status: 'admitted',
            nodeId: targetNodeId,
            approvals: pending.approvals.size,
            required: threshold,
            approvalHistory,
          };
        }

        return {
          status: 'pending',
          nodeId: targetNodeId,
          approvals: pending.approvals.size,
          required: threshold,
        };
      }

      // l2_getPendingAdmissions — list all pending admission requests
      case 'l2_getPendingAdmissions': {
        const pending: Record<string, unknown>[] = [];
        for (const [, entry] of this.pendingAdmissions) {
          const approvals: Record<string, unknown>[] = [];
          for (const [, a] of entry.approvals) approvals.push(a);
          pending.push({
            nodeId: entry.nodeId,
            publicKeyHex: entry.publicKeyHex,
            requestedAt: entry.requestedAt,
            approvals,
            required: this.getAdmissionThreshold(),
          });
        }
        return pending;
      }

      case 'l2_getAdminKeys': {
        const keys: Record<string, unknown>[] = [];
        for (const [nid, entry] of this.adminKeyRegistry) {
          keys.push({ nodeId: nid, ...entry });
        }
        return keys;
      }

      case 'l2_revokeAdminKey': {
        const targetNodeId = params.nodeId as string;
        const revokeReason = params.reason as string;
        const blacklist = params.blacklist as boolean ?? false;
        if (!targetNodeId) throw new Error('Missing nodeId');
        if (!revokeReason) throw new Error('Missing reason — revocation requires justification');
        // Capture publicKeyHex before deleting for blacklist
        const revokedEntry = this.adminKeyRegistry.get(targetNodeId);
        const revokedPending = this.pendingAdmissions.get(targetNodeId);
        const existed = this.adminKeyRegistry.delete(targetNodeId);
        this.pendingAdmissions.delete(targetNodeId); // Clean any pending admission
        if (blacklist) {
          this.blacklistedNodes.add(targetNodeId);
          const pubKey = revokedEntry?.publicKeyHex ?? revokedPending?.publicKeyHex;
          if (pubKey) this.blacklistedPublicKeys.add(pubKey);
        }
        if (existed) {
          console.log(`  [admin] Admin key revoked: ${targetNodeId} — ${revokeReason}${blacklist ? ' (BLACKLISTED)' : ''}`);
        }
        return { revoked: existed, nodeId: targetNodeId, blacklisted: blacklist };
      }

      case 'l2_getStatus': {
        const status = this.node.getStatus();
        return { ...status, vkCommitment: this.vkCommitment };
      }

      case 'l2_getHealth': {
        const mem = process.memoryUsage();
        const pool = !(this.node instanceof L2Leviathan)
          ? (this.node as L2Node).getProvingPool()
          : null;
        const epFn = this.entityProofPoolStatusFn;
        const ep = epFn ? epFn() : null;
        return {
          memory: {
            rss: mem.rss,
            heapUsed: mem.heapUsed,
            heapTotal: mem.heapTotal,
            external: mem.external,
            arrayBuffers: mem.arrayBuffers,
            rssMB: Math.round(mem.rss / 1024 / 1024),
          },
          provingPool: pool?.getStatus() ?? null,
          workers: pool?.getWorkerStatuses() ?? [],
          entityProofPool: ep?.status ?? null,
          entityWorkers: ep?.workers ?? [],
          timestamp: Date.now(),
        };
      }

      case 'l2_getReceipt': {
        const receiptId = params.receiptId;
        if (typeof receiptId !== 'string') {
          throw new Error('Missing or invalid receiptId parameter');
        }
        // Leviathans search across all partition sequencers
        if (this.node instanceof L2Leviathan) {
          return this.node.getReceipt(receiptId) ?? null;
        }
        return this.node.getSequencer().getReceipt(receiptId) ?? null;
      }

      case 'l2_getBlock': {
        const blockNum = params.blockNumber;
        if (typeof blockNum !== 'string' && typeof blockNum !== 'bigint') {
          throw new Error('Missing or invalid blockNumber parameter');
        }
        const bn = typeof blockNum === 'bigint' ? blockNum : BigInt(blockNum);
        if (this.node instanceof L2Leviathan) {
          return this.node.getBlock(bn) ?? null;
        }
        return this.node.getSequencer().getBlock(bn) ?? null;
      }

      case 'l2_getBatch': {
        const batchNum = params.batchNumber;
        if (typeof batchNum !== 'string' && typeof batchNum !== 'bigint') {
          throw new Error('Missing or invalid batchNumber parameter');
        }
        const bn = typeof batchNum === 'bigint' ? batchNum : BigInt(batchNum);
        if (this.node instanceof L2Leviathan) {
          return this.node.getBatch(bn) ?? null;
        }
        return this.node.getSequencer().getBatch(bn) ?? null;
      }

      case 'l2_forceBatch': {
        if (this.node instanceof L2Leviathan && params.partitionIndex !== undefined) {
          const idx = typeof params.partitionIndex === 'number'
            ? params.partitionIndex : Number(params.partitionIndex);
          return this.node.forceBatch(idx);
        }
        return this.node.forceBatch();
      }

      case 'l2_getAuditLog': {
        // H9 fix: paginate audit events (metadata always included)
        const fullLog = this.node instanceof L2Leviathan
          ? this.node.getAuditLog()
          : this.node.getSequencer().getAuditLog();
        const aLimit = typeof params.limit === 'number' ? Math.min(params.limit, 1000) : 1000;
        const aOffset = typeof params.offset === 'number' ? Math.max(params.offset, 0) : 0;
        return {
          ...fullLog,
          events: fullLog.events.slice(aOffset, aOffset + aLimit),
        };
      }

      case 'l2_verifyChainIntegrity': {
        const ciLog = this.node instanceof L2Leviathan
          ? this.node.getAuditLog()
          : this.node.getSequencer().getAuditLog();
        const ciResult = AuditService.verifyReceiptChain(ciLog);
        return {
          valid: ciResult.isValid,
          integrity: ciResult.isValid,
          totalEvents: ciResult.totalEvents,
          brokenLinks: ciResult.brokenLinks,
          reason: ciResult.reason,
        };
      }

      case 'l2_verifyFinancialBalance': {
        const fbLog = this.node instanceof L2Leviathan
          ? this.node.getAuditLog()
          : this.node.getSequencer().getAuditLog();
        const fbResult = AuditService.verifyFinancialBalance(fbLog.events);
        return {
          valid: fbResult.isValid,
          balanced: fbResult.isValid,
          totalClaims: fbResult.totalClaims,
          imbalancedClaims: fbResult.imbalancedClaims,
          totalPatientPayCents: fbResult.totalPatientPayCents,
          totalPlanPayCents: fbResult.totalPlanPayCents,
          totalIngredientCostCents: fbResult.totalIngredientCostCents,
          totalDispensingFeeCents: fbResult.totalDispensingFeeCents,
          reason: fbResult.reason,
        };
      }

      case 'l2_detectDuplicateClaims': {
        const ddLog = this.node instanceof L2Leviathan
          ? this.node.getAuditLog()
          : this.node.getSequencer().getAuditLog();
        const ddResult = AuditService.detectDuplicateClaims(ddLog.events);
        return {
          hasDuplicates: ddResult.hasDuplicates,
          duplicates: ddResult.duplicateGroups,
          totalDuplicates: ddResult.totalDuplicates,
        };
      }

      case 'l2_getChainState': {
        const seq = this.node.getSequencer();
        const latestBatchNum = seq.getLatestBatchNumber();
        const latestBatch = latestBatchNum !== null ? seq.getBatch(latestBatchNum) : undefined;
        return {
          registryRoot: seq.getCurrentRegistryRoot().toString(),
          lifecycleRoot: seq.getCurrentLifecycleRoot().toString(),
          walletCount: seq.getCurrentWalletCount().toString(),
          globalStateRoot: seq.getCurrentGlobalStateRoot().toString(),
          blockHeight: seq.getCurrentBlockHeight().toString(),
          chainProofEnabled: seq.isChainProofEnabled(),
          auditChainHash: seq.getLatestChainHash(),
          pendingProofs: seq.getPendingCount(),
          latestBatchNumber: latestBatchNum !== null ? latestBatchNum.toString() : null,
          latestBatchStatus: latestBatch?.l1Status ?? null,
        };
      }

      case 'l2_getReceiptsByWallet': {
        const walletId = params.walletId;
        if (typeof walletId !== 'string') {
          throw new Error('Missing or invalid walletId parameter');
        }
        // Leviathans route to the correct partition sequencer
        if (this.node instanceof L2Leviathan) {
          return this.node.getReceiptsByWallet(walletId);
        }
        return this.node.getSequencer().getReceiptsByWallet(walletId);
      }

      case 'l2_getAllReceipts': {
        // H9 fix: paginate receipts (default 1000, max 1000)
        const allReceipts = this.node instanceof L2Leviathan
          ? this.node.getAllReceipts()
          : this.node.getSequencer().getAllReceipts();
        const rLimit = typeof params.limit === 'number' ? Math.min(params.limit, 1000) : 1000;
        const rOffset = typeof params.offset === 'number' ? Math.max(params.offset, 0) : 0;
        return allReceipts.slice(rOffset, rOffset + rLimit);
      }

      case 'l2_getAllBatches': {
        // H9 fix: paginate batches (default 1000, max 1000)
        const allBatches = this.node instanceof L2Leviathan
          ? this.node.getAllBatches()
          : this.node.getSequencer().getAllBatches();
        const bLimit = typeof params.limit === 'number' ? Math.min(params.limit, 1000) : 1000;
        const bOffset = typeof params.offset === 'number' ? Math.max(params.offset, 0) : 0;
        return allBatches.slice(bOffset, bOffset + bLimit);
      }

      case 'l2_getChainProof': {
        const seq = this.node.getSequencer();
        return {
          enabled: seq.isChainProofEnabled(),
          proofJson: seq.getLatestChainProofJson(),
          globalStateRoot: seq.getCurrentGlobalStateRoot().toString(),
          blockHeight: seq.getCurrentBlockHeight().toString(),
        };
      }

      case 'l2_getFormulary': {
        const planIdHash = params.planIdHash;
        if (typeof planIdHash !== 'string') {
          throw new Error('Missing or invalid planIdHash parameter');
        }
        return this.node.getSequencer().getFormulary(planIdHash);
      }

      case 'l2_storeFormulary': {
        const planIdHash = params.planIdHash;
        const formularyRoot = params.formularyRoot;
        const entriesJson = params.entriesJson;
        if (typeof planIdHash !== 'string') {
          throw new Error('Missing or invalid planIdHash parameter');
        }
        if (typeof formularyRoot !== 'string') {
          throw new Error('Missing or invalid formularyRoot parameter');
        }
        if (typeof entriesJson !== 'string') {
          throw new Error('Missing or invalid entriesJson parameter');
        }
        // Use gossip-aware method for replication to peers
        // Both L2Node and L2Leviathan implement storeFormularyWithGossip()
        await (this.node as unknown as { storeFormularyWithGossip(p: string, r: string, e: string): Promise<void> })
          .storeFormularyWithGossip(planIdHash, formularyRoot, entriesJson);
        this.node.emit({
          type: 'formulary:updated',
          timestamp: Date.now(),
          data: { planIdHash, formularyRoot },
        });
        return { success: true, planIdHash, formularyRoot };
      }

      // ── Plan Store CRUD ──

      case 'l2_storePlan': {
        const plan = params.plan as BenefitPlanConfig | undefined;
        if (!plan || typeof plan.planId !== 'string' || typeof plan.name !== 'string') {
          throw new Error('Missing or invalid plan parameter (requires planId, name)');
        }
        await this.node.storePlan(plan);
        this.node.emit({ type: 'plan:updated', timestamp: Date.now(), data: { planId: plan.planId } });
        return { success: true, planId: plan.planId };
      }

      case 'l2_getPlan': {
        const planId = params.planId;
        if (typeof planId !== 'string') throw new Error('Missing planId parameter');
        return this.node.getSequencer().getPlan(planId);
      }

      case 'l2_getPlans': {
        return this.node.getSequencer().getPlans();
      }

      case 'l2_getPlanLimits': {
        const planId = params.planId;
        if (typeof planId !== 'string') throw new Error('Missing planId parameter');
        const plan = this.node.getSequencer().getPlan(planId);
        if (!plan) return null;
        return {
          planId: plan.planId,
          name: plan.name,
          coverageType: plan.coverageType,
          copayAmountCents: plan.copayAmountCents,
          deductibleAmountCents: plan.deductibleAmountCents,
          oopMaxCents: plan.oopMaxCents,
          annualBenefitMaxCents: plan.annualBenefitMaxCents,
          familyDeductibleAmountCents: plan.familyDeductibleAmountCents,
          familyOopMaxCents: plan.familyOopMaxCents,
          familyAnnualBenefitMaxCents: plan.familyAnnualBenefitMaxCents,
        };
      }

      case 'l2_deletePlan': {
        const planId = params.planId;
        if (typeof planId !== 'string') throw new Error('Missing planId parameter');
        const deleted = await this.node.deletePlan(planId);
        if (deleted) {
          this.node.emit({ type: 'plan:deleted', timestamp: Date.now(), data: { planId } });
        }
        return { success: deleted, planId };
      }

      // ── Employer Attestation ──

      case 'l2_registerEmployer': {
        const att = params.attestation as import('./l2-types.js').EmployerAttestation | undefined;
        if (!att || typeof att.employerId !== 'string' || typeof att.publicKeyHex !== 'string') {
          throw new Error('Missing or invalid attestation parameter');
        }
        // Phase D: schema check — v2 attestations must carry a numeric seq
        if (att.v !== 2 || typeof att.attestationSeq !== 'number' || !Number.isInteger(att.attestationSeq) || att.attestationSeq < 0) {
          throw new Error('Invalid attestation: must be v2 with non-negative integer attestationSeq');
        }

        // Phase D: monotonic sequence enforcement
        // - First registration MUST have seq=0
        // - Subsequent registrations MUST have seq = existing.seq + 1 (no gaps, no replays)
        const existing = this.node.getSequencer().getEmployerAttestation(att.employerId);
        if (!existing) {
          if (att.attestationSeq !== 0) {
            throw new Error(`First registration for employerId=${att.employerId} must have attestationSeq=0, got ${att.attestationSeq}`);
          }
        } else {
          const expected = (existing.attestationSeq ?? 0) + 1;
          if (att.attestationSeq !== expected) {
            throw new Error(`Expected attestationSeq=${expected} for employerId=${att.employerId}, got ${att.attestationSeq}`);
          }
        }

        // Verify both signatures before accepting (signatures bind the seq via canonical message)
        const { verifyEmployerSignature, verifyInsurerSignature } = await import('../onboarding/employer-attestation.js');
        if (!verifyEmployerSignature(att)) throw new Error('Invalid employer signature');
        if (!verifyInsurerSignature(att)) throw new Error('Invalid insurer signature');
        this.node.getSequencer().storeEmployerAttestation(att);
        this.node.emit({ type: 'employer:registered', timestamp: Date.now(), data: { employerId: att.employerId, attestationSeq: att.attestationSeq } });
        return { success: true, employerId: att.employerId, attestationSeq: att.attestationSeq };
      }

      case 'l2_getEmployerAttestation': {
        const employerId = params.employerId;
        if (typeof employerId !== 'string') throw new Error('Missing employerId parameter');
        return this.node.getSequencer().getEmployerAttestation(employerId);
      }

      case 'l2_getEmployerAttestations': {
        return this.node.getSequencer().getEmployerAttestations();
      }

      case 'l2_revokeEmployerAttestation': {
        const employerId = params.employerId;
        if (typeof employerId !== 'string') throw new Error('Missing employerId parameter');
        const existing = this.node.getSequencer().getEmployerAttestation(employerId);
        if (!existing) throw new Error('No attestation found for employer');
        // Remove from store — allows re-registration with new key
        (this.node.getSequencer() as any).employerAttestationStore.delete(employerId);
        this.node.emit({ type: 'employer:revoked', timestamp: Date.now(), data: { employerId } });
        return { success: true, employerId };
      }

      case 'l2_verifyEmployer': {
        const employerId = params.employerId;
        if (typeof employerId !== 'string') throw new Error('Missing employerId parameter');
        const att = this.node.getSequencer().getEmployerAttestation(employerId);
        if (!att) return { valid: false, reason: 'No attestation found for employer' };
        const { verifyEmployerSignature, verifyInsurerSignature } = await import('../onboarding/employer-attestation.js');
        const empValid = verifyEmployerSignature(att);
        const insValid = verifyInsurerSignature(att);
        return { valid: empValid && insValid, attestation: att, employerSigValid: empValid, insurerSigValid: insValid };
      }

      // ── Employer Node Registry (Phase C) ──

      case 'l2_registerEmployerNode': {
        const employerId = params.employerId;
        const employerNodeUrl = params.employerNodeUrl;
        const hrToolUrl = params.hrToolUrl;
        const pid = params.pid;
        const adminTokenFingerprint = params.adminTokenFingerprint;
        if (typeof employerId !== 'string' || typeof employerNodeUrl !== 'string' ||
            typeof hrToolUrl !== 'string' || typeof pid !== 'number') {
          throw new Error('Missing or invalid parameters: employerId, employerNodeUrl, hrToolUrl, pid are required');
        }
        // Must have an attestation first — cannot register a node for an
        // employerId that has never signed an agreement
        const att = this.node.getSequencer().getEmployerAttestation(employerId);
        if (!att) {
          throw new Error(`Cannot register employer node for "${employerId}": no attestation on sequencer`);
        }
        this.node.getSequencer().registerEmployerNode({
          employerId,
          employerNodeUrl,
          hrToolUrl,
          pid,
          adminTokenFingerprint: typeof adminTokenFingerprint === 'string' ? adminTokenFingerprint : undefined,
        });
        this.node.emit({ type: 'employer:node-registered', timestamp: Date.now(), data: { employerId, employerNodeUrl, hrToolUrl, pid } });
        return { success: true, employerId };
      }

      case 'l2_getEmployerNode': {
        const employerId = params.employerId;
        if (typeof employerId !== 'string') throw new Error('Missing employerId parameter');
        return this.node.getSequencer().getEmployerNode(employerId);
      }

      case 'l2_listEmployerNodes': {
        return this.node.getSequencer().listEmployerNodes();
      }

      case 'l2_deregisterEmployerNode': {
        const employerId = params.employerId;
        if (typeof employerId !== 'string') throw new Error('Missing employerId parameter');
        const removed = this.node.getSequencer().deregisterEmployerNode(employerId);
        if (removed) {
          this.node.emit({ type: 'employer:node-deregistered', timestamp: Date.now(), data: { employerId } });
        }
        return { success: removed, employerId };
      }

      // ── Encryption Key Lookup (for E2E messaging) ──

      case 'l2_getEncryptionKey': {
        const walletId = params.walletId;
        if (typeof walletId !== 'string') throw new Error('Missing walletId parameter');
        const entity = this.entityRegistry.get(walletId);
        if (!entity?.encryptionPublicKeyHex) return null;
        return { walletId, encryptionPublicKeyHex: entity.encryptionPublicKeyHex };
      }

      // ── Formulary Service (Option C — paginated queries) ──

      case 'l2_getFormularyCategories': {
        return this.node.getSequencer().getFormularyService().getCategories();
      }

      case 'l2_getFormularyPage': {
        const filter = params.filter ?? {};
        const offset = typeof params.offset === 'number' ? params.offset : 0;
        const limit = typeof params.limit === 'number' ? Math.min(params.limit, 500) : 100;
        return this.node.getSequencer().getFormularyService().getPage(filter, offset, limit);
      }

      case 'l2_getDrugDetail': {
        const ndcHash = params.ndcHash;
        if (typeof ndcHash !== 'string') throw new Error('Missing ndcHash parameter');
        const drug = this.node.getSequencer().getFormularyService().getDrug(ndcHash);
        if (!drug) throw new Error(`Drug not found: ${ndcHash}`);
        return drug;
      }

      case 'l2_checkCoverage': {
        const planIdHash = params.planIdHash;
        const ndcHash = params.ndcHash;
        if (typeof planIdHash !== 'string') throw new Error('Missing planIdHash parameter');
        if (typeof ndcHash !== 'string') throw new Error('Missing ndcHash parameter');
        const result = this.node.getSequencer().getFormularyService().checkCoverage(planIdHash, ndcHash);
        if (!result) throw new Error(`Drug not found: ${ndcHash}`);
        return result;
      }

      case 'l2_estimateCost': {
        const estNdcHash = params.ndcHash;
        const estPlanId = params.planId;
        const estWalletId = params.walletId;
        const estQuantity = typeof params.quantity === 'number' ? params.quantity : 30;
        const estDispensingFeeCents = typeof params.dispensingFeeCents === 'number' ? params.dispensingFeeCents : 300;
        if (typeof estNdcHash !== 'string') throw new Error('Missing ndcHash parameter');

        const seq = this.node.getSequencer();
        const fSvc = seq.getFormularyService();

        // Look up drug in formulary
        const drug = fSvc.getDrug(estNdcHash);
        if (!drug) throw new Error(`Drug not found: ${estNdcHash}`);

        // Get plan-specific coverage if planId provided
        let copayAmountCents = drug.defaultCopay;
        let tierLevel = drug.defaultTier;
        if (typeof estPlanId === 'string') {
          const coverage = fSvc.checkCoverage(estPlanId, estNdcHash);
          if (coverage && coverage.covered) {
            copayAmountCents = coverage.copayAmount;
            tierLevel = coverage.tierLevel;
          } else if (coverage && !coverage.covered) {
            return {
              covered: false,
              drugName: drug.genericName || drug.brandName || drug.description,
              ndcHash: estNdcHash,
              reason: 'Drug excluded from this plan',
            };
          }
        }

        // Compute total cost
        const ingredientCostCents = Math.round(drug.nadacPerUnit * estQuantity * 100);
        const totalCostCents = ingredientCostCents + estDispensingFeeCents;

        // Estimate member/employer split using accumulator if walletId provided
        let memberPayCents = Math.min(totalCostCents, copayAmountCents);
        let employerPayCents = totalCostCents - memberPayCents;

        if (typeof estWalletId === 'string') {
          const accum = seq.reconstructAccumulator(estWalletId);
          if (accum) {
            // Get plan limits from planStore (authoritative source) — not from caller params
            let deductibleAmountCents = 0;
            let oopMaxCents = 0;
            let annualBenefitMaxCents = 0;
            if (typeof estPlanId === 'string') {
              const planConfig = seq.getPlan(estPlanId);
              if (planConfig) {
                deductibleAmountCents = planConfig.deductibleAmountCents ?? 0;
                oopMaxCents = planConfig.oopMaxCents ?? 0;
                annualBenefitMaxCents = planConfig.annualBenefitMaxCents ?? 0;
              }
            }
            const deductiblePaidCents = Number(accum.deductiblePaidCents);
            const oopPaidCents = Number(accum.oopPaidCents);
            const benefitUsedCents = Number(accum.benefitUsedCents);

            // Deductible phase
            const inDeductiblePhase = deductibleAmountCents > 0 && deductiblePaidCents < deductibleAmountCents;
            const remainingDeductible = inDeductiblePhase ? deductibleAmountCents - deductiblePaidCents : 0;
            const deductiblePay = Math.min(totalCostCents, remainingDeductible);
            const afterDeductible = totalCostCents - deductiblePay;
            const copayOnRemainder = Math.min(afterDeductible, copayAmountCents);
            const normalPay = Math.min(totalCostCents, copayAmountCents);
            const basePay = inDeductiblePhase ? deductiblePay + copayOnRemainder : normalPay;

            // Benefit max
            let basePlanPay = totalCostCents - basePay;
            if (annualBenefitMaxCents > 0) {
              const remainingBenefit = Math.max(0, annualBenefitMaxCents - benefitUsedCents);
              if (basePlanPay > remainingBenefit) basePlanPay = remainingBenefit;
            }
            let patientPay = totalCostCents - basePlanPay;

            // OOPM cap
            if (oopMaxCents > 0) {
              const remainingOopm = Math.max(0, oopMaxCents - oopPaidCents);
              if (patientPay > remainingOopm) patientPay = remainingOopm;
            }

            memberPayCents = patientPay;
            employerPayCents = totalCostCents - patientPay;
          }
        }

        return {
          covered: true,
          drugName: drug.genericName || drug.brandName || drug.description,
          ndcHash: estNdcHash,
          classification: drug.classification,
          tierLevel,
          nadacPerUnit: drug.nadacPerUnit,
          quantity: estQuantity,
          ingredientCostCents,
          dispensingFeeCents: estDispensingFeeCents,
          totalCostCents,
          copayAmountCents,
          memberPayCents,
          employerPayCents,
        };
      }

      case 'l2_publishPlanOverlay': {
        const fSvc = this.node.getSequencer().getFormularyService();
        const planIdHash = params.planIdHash;
        const planName = (params.planName as string) ?? '';
        const overrides = (params.overrides ?? []) as import('./formulary-service.js').DrugOverride[];
        const defaults = params.defaults as import('./formulary-service.js').PlanDefaults;
        if (typeof planIdHash !== 'string') throw new Error('Missing planIdHash parameter');
        if (!defaults || typeof defaults !== 'object') throw new Error('Missing defaults parameter');
        const overlay = fSvc.publishOverlay(planIdHash, planName, overrides, defaults);
        this.node.emit({
          type: 'formulary:updated',
          timestamp: Date.now(),
          data: { planIdHash, type: 'overlay', version: overlay.version },
        });
        return { success: true, planIdHash, version: overlay.version };
      }

      case 'l2_getFormularyRoutes': {
        return this.node.getSequencer().getFormularyService().getRoutes();
      }

      case 'l2_getFormularyDrugCount': {
        return { count: this.node.getSequencer().getFormularyService().drugCount };
      }

      case 'l2_getFormularyRoot': {
        const root = this.node.getSequencer().getFormularyService().getRootString();
        return { formularyRoot: root, drugCount: this.node.getSequencer().getFormularyService().drugCount };
      }

      case 'l2_getFormularyWitness': {
        const ndcHash = params.ndcHash;
        if (typeof ndcHash !== 'string') throw new Error('Missing ndcHash parameter');
        const fSvc = this.node.getSequencer().getFormularyService();
        const witness = fSvc.getWitness(ndcHash);
        if (!witness) throw new Error(`Drug not found in Merkle tree: ${ndcHash}`);
        const leafIndex = fSvc.getLeafIndex(ndcHash);
        const drug = fSvc.getDrug(ndcHash);
        // Serialize witness path as array of { isLeft, sibling } for client consumption
        const path = witness.path.map((f: any) => f.toString());
        const isLeft = witness.isLeft.map((b: any) => b.toBoolean());
        return {
          ndcHash,
          leafIndex: leafIndex!.toString(),
          formularyRoot: fSvc.getRootString(),
          witnessPath: path,
          witnessIsLeft: isLeft,
          drug: drug ? { genericName: drug.genericName, brandName: drug.brandName, tierLevel: drug.defaultTier, copayAmount: drug.defaultCopay } : null,
        };
      }

      case 'l2_syncFromL1': {
        // L1 sync disabled — Leviathan is the sole trust layer (no MINA L1)
        throw new Error('l2_syncFromL1 is disabled: this network operates in L2-only mode without MINA L1');
      }

      // ── Claim Accumulator queries ──

      case 'l2_getClaimsByMember': {
        const walletId = params.walletId;
        if (typeof walletId !== 'string') {
          throw new Error('Missing or invalid walletId parameter');
        }
        return this.node.getClaimsByMember(walletId);
      }

      case 'l2_getClaimsByPharmacy': {
        const walletId = params.walletId;
        if (typeof walletId !== 'string') {
          throw new Error('Missing or invalid walletId parameter');
        }
        return this.node.getClaimsByPharmacy(walletId);
      }

      case 'l2_getClaimsByPrescriber': {
        const walletId = params.walletId;
        if (typeof walletId !== 'string') {
          throw new Error('Missing or invalid walletId parameter');
        }
        return this.node.getClaimsByPrescriber(walletId);
      }

      case 'l2_getClaimsByNdc': {
        const ndcHash = params.ndcHash;
        if (typeof ndcHash !== 'string') {
          throw new Error('Missing or invalid ndcHash parameter');
        }
        return this.node.getClaimsByNdc(ndcHash);
      }

      case 'l2_getClaimWithProof': {
        const leafIdx = params.leafIndex;
        if (typeof leafIdx !== 'string' && typeof leafIdx !== 'bigint') {
          throw new Error('Missing or invalid leafIndex parameter');
        }
        const idx = typeof leafIdx === 'bigint' ? leafIdx : BigInt(leafIdx);
        return this.node.getClaimWithProof(idx) ?? null;
      }

      case 'l2_getClaimAccumulatorRoot': {
        return {
          root: this.node.getClaimAccumulatorRoot(),
          leafCount: this.node.getClaimLeafCount().toString(),
        };
      }

      case 'l2_recordFill': {
        const fillMember = params.memberWalletId as string;
        const fillNdc = params.ndcHash as string;
        const fillPharmacy = params.pharmacyWalletId as string;
        const fillPrescriber = (params.prescriberWalletId as string) ?? '0';
        if (!fillMember || !fillNdc || !fillPharmacy) {
          throw new Error('Missing required fields: memberWalletId, ndcHash, pharmacyWalletId');
        }
        const fillDate = (params.dateOfService as string) ?? new Date().toISOString().replace(/[-:T]/g, '').slice(0, 8);
        const fillPatientPay = (params.patientPayCents as string) ?? '0';
        const fillPlanPay = (params.planPayCents as string) ?? '0';
        const fillOpType = (params.operationType as string) ?? '1';
        const fillDeductible = (params.deductibleCreditCents as string) ?? '0';
        const fillSeq = this.node.getSequencer();
        const fillIngredient = params.ingredientCostCents != null ? Number(params.ingredientCostCents) : undefined;
        const fillDispFee = params.dispensingFeeCents != null ? Number(params.dispensingFeeCents) : undefined;
        const fillQty = params.quantityDispensed != null ? Number(params.quantityDispensed) : undefined;
        const fillTotalDrug = (fillIngredient != null && fillDispFee != null) ? fillIngredient + fillDispFee : undefined;

        // Check for duplicate fill before recording (pre-check for response flag)
        const fillLeaf = { memberWalletId: fillMember, ndcHash: fillNdc, pharmacyWalletId: fillPharmacy, prescriberWalletId: fillPrescriber, dateOfService: fillDate, patientPayCents: fillPatientPay, planPayCents: fillPlanPay, operationType: fillOpType, deductibleCreditCents: fillDeductible };
        const priorLeafCount = fillSeq.getClaimAccumulator().getLeafCount();

        const fillEntry = fillSeq.recordFill(
          fillLeaf,
          { receiptId: `FILL-${Date.now()}`, timestamp: Date.now(), dateOfService: fillDate, ndc: params.ndc as string, brandName: params.brandName as string, daysSupply: params.daysSupply as number, fillNumber: params.fillNumber as number, ingredientCostCents: fillIngredient, dispensingFeeCents: fillDispFee, totalDrugCostCents: fillTotalDrug, quantityDispensed: fillQty, planIdHash: params.planIdHash as string | undefined },
        );

        // Detect if this was a duplicate (leaf count didn't change)
        const isDuplicate = fillSeq.getClaimAccumulator().getLeafCount() === priorLeafCount;

        // Only emit viz event for new fills (not duplicates)
        if (!isDuplicate) {
          const fillPharmacyEntity = this.entityRegistry.get(fillPharmacy);
          const fillMemberEntity = this.entityRegistry.get(fillMember);
          this.emitVizEvent('viz:pharmacy:dispensed', 'fulfillment',
            fillPharmacyEntity?.displayName ?? fillPharmacy.slice(0, 12) + '…',
            'pharmacy',
            { memberWalletId: fillMember, ndcHash: fillNdc, leafIndex: fillEntry.leafIndex.toString(), brandName: params.brandName, daysSupply: params.daysSupply },
            { target: fillMemberEntity?.displayName ?? fillMember.slice(0, 12) + '…', targetType: 'member' },
          );
        }
        return { ok: true, leafIndex: fillEntry.leafIndex.toString(), leafHash: fillEntry.leafHash, duplicate: isDuplicate };
      }

      case 'l2_getRegistrationWitnesses': {
        return this.node.getSequencer().getRegistrationWitnesses();
      }

      case 'l2_getWalletWitnesses': {
        const wid = params.walletId ?? params[0];
        if (typeof wid !== 'string') throw new Error('Missing walletId parameter');
        return this.node.getSequencer().getWalletWitnesses(wid);
      }

      case 'l2_getWalletState': {
        const wid = params.walletId ?? params[0];
        if (typeof wid !== 'string') throw new Error('Missing walletId parameter');
        return this.node.getSequencer().getWalletStateForRpc(wid);
      }

      // ── Message Store queries ──

      case 'l2_getMessagesByWallet': {
        const walletId = params.walletId;
        if (typeof walletId !== 'string') {
          throw new Error('Missing or invalid walletId parameter');
        }
        return this.node.getSequencer().getMessagesByWallet(walletId);
      }

      case 'l2_getMessagesBySender': {
        const walletId = params.walletId;
        if (typeof walletId !== 'string') {
          throw new Error('Missing or invalid walletId parameter');
        }
        return this.node.getSequencer().getMessagesBySender(walletId);
      }

      case 'l2_getMessagesByRecipient': {
        const walletId = params.walletId;
        if (typeof walletId !== 'string') {
          throw new Error('Missing or invalid walletId parameter');
        }
        return this.node.getSequencer().getMessagesByRecipient(walletId);
      }

      case 'l2_getMessagesByThread': {
        const threadIdHash = params.threadIdHash;
        if (typeof threadIdHash !== 'string') {
          throw new Error('Missing or invalid threadIdHash parameter');
        }
        return this.node.getSequencer().getMessagesByThread(threadIdHash);
      }

      case 'l2_getMessageStoreRoot': {
        return {
          root: this.node.getSequencer().getMessageStoreRoot(),
          messageCount: this.node.getSequencer().getMessageCount().toString(),
        };
      }

      case 'l2_storeMessage': {
        const msg = params.message as Record<string, unknown> | undefined;
        const pl = params.payload as Record<string, unknown> | undefined;
        if (!msg || typeof msg.messageCommitment !== 'string' ||
            typeof msg.senderWalletId !== 'string' ||
            typeof msg.recipientWalletId !== 'string' ||
            typeof msg.messageType !== 'string' ||
            typeof msg.threadIdHash !== 'string') {
          throw new Error('Missing or invalid message parameter (requires messageCommitment, senderWalletId, recipientWalletId, messageType, threadIdHash)');
        }
        if (!pl || typeof pl.ciphertext !== 'string' ||
            typeof pl.iv !== 'string' ||
            typeof pl.tag !== 'string') {
          throw new Error('Missing or invalid payload parameter (requires ciphertext, iv, tag)');
        }
        // Map human-readable messageType to numeric codes for Poseidon hashing
        const MESSAGE_TYPE_MAP: Record<string, string> = {
          clinical: '1', '1': '1',
          administrative: '2', admin: '2', '2': '2',
          escript: '3', '3': '3',
          text: '4', '4': '4',
          system: '5', '5': '5',
          pcp_assign: '6', '6': '6',
          access_grant: '7', '7': '7',
        };
        const rawType = (msg.messageType as string).toLowerCase();
        const numericType = MESSAGE_TYPE_MAP[rawType] ?? '4'; // default to text

        const storedMessage = {
          messageCommitment: msg.messageCommitment as string,
          senderWalletId: msg.senderWalletId as string,
          recipientWalletId: msg.recipientWalletId as string,
          messageType: numericType,
          threadIdHash: msg.threadIdHash as string,
        };
        const messagePayload = {
          ciphertext: pl.ciphertext as string,
          iv: pl.iv as string,
          tag: pl.tag as string,
          timestamp: typeof pl.timestamp === 'number' ? pl.timestamp : Date.now(),
          receiptId: typeof pl.receiptId === 'string' ? pl.receiptId : undefined,
        };
        const storeResult = this.node.storeMessage(storedMessage, messagePayload);
        // Emit viz event for messaging
        const senderEntity = this.entityRegistry.get(storedMessage.senderWalletId);
        const recipientEntity = this.entityRegistry.get(storedMessage.recipientWalletId);
        this.emitVizEvent('viz:message:sent', 'messaging',
          senderEntity?.displayName ?? storedMessage.senderWalletId.slice(0, 12) + '…',
          (senderEntity?.type as VizActorType) ?? 'member',
          { messageType: rawType, threadIdHash: storedMessage.threadIdHash, leafIndex: String(storeResult.leafIndex), leafHash: storeResult.leafHash },
          { target: recipientEntity?.displayName ?? storedMessage.recipientWalletId.slice(0, 12) + '…', targetType: recipientEntity?.type ?? 'prescriber' },
        );
        return storeResult;
      }

      // ── Entity Registry (admin-gated) — dual-writes to viz registry + provider registry ──

      case 'l2_registerEntity': {
        const walletId = params.walletId as string;
        const displayName = params.displayName as string;
        const type = params.type as string;
        if (!walletId || !displayName || !type) {
          throw new Error('Missing walletId, displayName, or type');
        }
        // Viz registry (backward compat) + encryption public key for E2E messaging
        this.entityRegistry.set(walletId, {
          walletId,
          displayName,
          type: type as VizActorType,
          specialty: params.specialty as string | undefined,
          pharmacyType: params.pharmacyType as string | undefined,
          group: params.group as string | undefined,
          encryptionPublicKeyHex: params.encryptionPublicKeyHex as string | undefined,
        });
        // Also credential into provider registry if prescriber/pharmacy
        if (type === 'prescriber' || type === 'pharmacy') {
          const seq = this.node.getSequencer();
          const providerType = type as ProviderType;
          const npi = (params.npi as string) ?? '';
          const npiHash = npi ? hashString(npi).toString() : walletId; // fallback to walletId as NPI hash
          try {
            seq.credentialProvider(
              {
                walletId,
                npiHash,
                providerTypeTag: String(PROVIDER_TYPE_TAG[providerType]),
                credentialState: String(ProviderLifecycle.ACTIVE),
                credentialedAt: String(Math.floor(Date.now() / 1000)),
                credentialedByHash: '0', // system/admin
              },
              {
                displayName,
                providerType,
                specialty: params.specialty as string | undefined,
                pharmacyType: params.pharmacyType as string | undefined,
                npi: npi || undefined,
                verificationMethod: 'manual',
                updatedAt: Date.now(),
              },
            );
          } catch {
            // Already registered — ignore duplicate (idempotent)
          }
        }
        // Track wallet for attestation eligibility
        if ('registerKnownWallet' in this.node) {
          (this.node as L2Node).registerKnownWallet(walletId);
        }
        // Emit viz event for entity registration
        this.emitVizEvent('viz:enrollment:started', 'enrollment',
          displayName, type as VizActorType,
          { walletId, type, specialty: params.specialty, pharmacyType: params.pharmacyType },
        );
        return { ok: true, walletId, displayName, type };
      }

      // ── Entity Lookup (non-admin — used by insurer to verify enrollment) ──

      case 'l2_getEntity': {
        const walletId = params.walletId as string;
        if (!walletId) throw new Error('Missing walletId');
        const entity = this.entityRegistry.get(walletId);
        if (!entity) return null;
        return {
          walletId: entity.walletId,
          displayName: entity.displayName,
          type: entity.type,
          group: entity.group,
          specialty: entity.specialty,
          pharmacyType: entity.pharmacyType,
        };
      }

      // ── Provider Credentialing (admin-gated) ──

      case 'l2_credentialProvider': {
        const walletId = params.walletId as string;
        const displayName = params.displayName as string;
        const providerType = params.providerType as ProviderType;
        const npi = params.npi as string;
        if (!walletId || !displayName || !providerType) {
          throw new Error('Missing walletId, displayName, or providerType');
        }
        if (providerType !== 'prescriber' && providerType !== 'pharmacy') {
          throw new Error('providerType must be "prescriber" or "pharmacy"');
        }
        const npiHash = npi ? hashString(npi).toString() : walletId;
        const initialState = params.initialState !== undefined
          ? parseInt(String(params.initialState), 10) as ProviderLifecycle
          : ProviderLifecycle.ACTIVE;
        const seq = this.node.getSequencer();
        const entry = seq.credentialProvider(
          {
            walletId,
            npiHash,
            providerTypeTag: String(PROVIDER_TYPE_TAG[providerType]),
            credentialState: String(initialState),
            credentialedAt: String(Math.floor(Date.now() / 1000)),
            credentialedByHash: params.credentialedByHash as string ?? '0',
          },
          {
            displayName,
            providerType,
            specialty: params.specialty as string | undefined,
            pharmacyType: params.pharmacyType as string | undefined,
            npi: npi || undefined,
            deaNumber: params.deaNumber as string | undefined,
            stateOfLicense: params.stateOfLicense as string | undefined,
            verificationMethod: (params.verificationMethod as 'nppes' | 'ncpdp' | 'manual' | undefined) ?? 'manual',
            applicationId: params.applicationId as string | undefined,
            updatedAt: Date.now(),
          },
        );
        // Also add to viz registry
        this.entityRegistry.set(walletId, {
          walletId,
          displayName,
          type: providerType as VizActorType,
          specialty: params.specialty as string | undefined,
          pharmacyType: params.pharmacyType as string | undefined,
        });
        // Emit viz event for provider credentialing
        this.emitVizEvent('viz:credential:generated', 'enrollment',
          displayName, providerType as VizActorType,
          { walletId, providerType, leafIndex: entry.leafIndex.toString(), credentialState: entry.leaf.credentialState, npi: npi || undefined },
          { target: 'Provider Registry', targetType: 'leviathan' },
        );
        return {
          ok: true,
          leafIndex: entry.leafIndex.toString(),
          walletId,
          displayName,
          providerType,
          credentialState: entry.leaf.credentialState,
        };
      }

      case 'l2_updateProviderStatus': {
        const walletId = params.walletId as string;
        if (!walletId) throw new Error('Missing walletId');
        if (params.newState === undefined || params.newState === null) {
          throw new Error('Missing newState parameter');
        }
        const newState = parseInt(String(params.newState), 10) as ProviderLifecycle;
        if (isNaN(newState) || newState < 0 || newState > 4) {
          throw new Error('newState must be 0-4 (PENDING=0, VERIFIED=1, ACTIVE=2, SUSPENDED=3, TERMINATED=4)');
        }
        const seq = this.node.getSequencer();
        const entry = seq.updateProviderStatus(walletId, newState);
        // Emit viz event for provider status update
        const STATE_NAMES = ['pending', 'verified', 'active', 'suspended', 'terminated'];
        this.emitVizEvent('viz:enrollment:lifecycle', 'enrollment',
          entry.metadata.displayName, entry.metadata.providerType as VizActorType,
          { walletId, newState, stateName: STATE_NAMES[newState] ?? 'unknown', providerType: entry.metadata.providerType },
          { target: 'Provider Registry', targetType: 'leviathan' },
        );
        return {
          ok: true,
          walletId,
          credentialState: entry.leaf.credentialState,
          displayName: entry.metadata.displayName,
        };
      }

      // ── Provider Queries ──

      case 'l2_getProvider': {
        const walletId = params.walletId as string;
        if (!walletId) throw new Error('Missing walletId');
        const entry = this.node.getSequencer().getProvider(walletId);
        if (!entry) return null;
        return {
          walletId: entry.leaf.walletId,
          displayName: entry.metadata.displayName,
          providerType: entry.metadata.providerType,
          credentialState: parseInt(entry.leaf.credentialState, 10),
          credentialStateName: ['pending', 'verified', 'active', 'suspended', 'terminated'][parseInt(entry.leaf.credentialState, 10)] ?? 'unknown',
          specialty: entry.metadata.specialty,
          pharmacyType: entry.metadata.pharmacyType,
          npi: entry.metadata.npi,
          leafIndex: entry.leafIndex.toString(),
          leafHash: entry.leafHash,
        };
      }

      case 'l2_getProviderByNpi': {
        const npiHash = params.npiHash as string;
        if (!npiHash) throw new Error('Missing npiHash');
        const entry = this.node.getSequencer().getProviderByNpi(npiHash);
        if (!entry) return null;
        return {
          walletId: entry.leaf.walletId,
          displayName: entry.metadata.displayName,
          providerType: entry.metadata.providerType,
          credentialState: parseInt(entry.leaf.credentialState, 10),
          specialty: entry.metadata.specialty,
          pharmacyType: entry.metadata.pharmacyType,
          leafIndex: entry.leafIndex.toString(),
        };
      }

      case 'l2_getProviderRegistryRoot': {
        return {
          root: this.node.getSequencer().getProviderRegistryRoot(),
          providerCount: this.node.getSequencer().getProviderCount().toString(),
        };
      }

      case 'l2_getProviderWithProof': {
        const walletId = params.walletId as string;
        if (!walletId) throw new Error('Missing walletId');
        const result = this.node.getSequencer().getProviderWithProof(walletId);
        if (!result) return null;
        return {
          walletId: result.entry.leaf.walletId,
          displayName: result.entry.metadata.displayName,
          providerType: result.entry.metadata.providerType,
          credentialState: parseInt(result.entry.leaf.credentialState, 10),
          leafIndex: result.entry.leafIndex.toString(),
          witnessJson: result.witnessJson,
          root: result.root,
        };
      }

      // ── Network Providers (reads from provider registry, falls back to viz registry) ──

      case 'l2_getNetworkProviders': {
        const roleFilter = params.role as string | undefined;
        const seq = this.node.getSequencer();

        // Try provider registry first
        const providerType = roleFilter === 'prescriber' || roleFilter === 'pharmacy'
          ? roleFilter as ProviderType : undefined;
        const registryEntries = seq.getProviders(providerType, ProviderLifecycle.ACTIVE);

        if (registryEntries.length > 0) {
          return registryEntries.map((e) => ({
            walletId: e.leaf.walletId,
            displayName: e.metadata.displayName,
            providerType: e.metadata.providerType,
            role: e.metadata.providerType,  // backward compat
            npi: e.metadata.npi,
            specialty: e.metadata.specialty,
            pharmacyType: e.metadata.pharmacyType,
            stateOfLicense: e.metadata.stateOfLicense,
            credentialState: parseInt(e.leaf.credentialState, 10),
            leafIndex: e.leafIndex.toString(),
          }));
        }

        // Fall back to viz registry (backward compat)
        const entities = Array.from(this.entityRegistry.values())
          .filter((e) => {
            if (roleFilter) return e.type === roleFilter;
            return e.type === 'prescriber' || e.type === 'pharmacy';
          })
          .map((e) => ({
            walletId: e.walletId,
            displayName: e.displayName,
            providerType: e.type,
            role: e.type,  // backward compat
            npi: (e as any).npi || '',
            specialty: e.specialty,
            pharmacyType: e.pharmacyType,
            group: e.group,
          }));
        return entities;
      }

      // ── PCP Assignment Registry ──

      case 'l2_registerPcpAssignment': {
        const memberWalletId = params.memberWalletId as string;
        const prescriberWalletId = params.prescriberWalletId as string;
        const effectiveDate = params.effectiveDate as string;
        if (!memberWalletId || !prescriberWalletId) {
          throw new Error('Missing memberWalletId or prescriberWalletId');
        }
        const list = this.pcpAssignments.get(prescriberWalletId) ?? [];
        // Avoid duplicates
        if (!list.some((a) => a.memberWalletId === memberWalletId)) {
          list.push({ memberWalletId, effectiveDate: effectiveDate ?? new Date().toISOString().slice(0, 10), timestamp: Date.now() });
          this.pcpAssignments.set(prescriberWalletId, list);
        }
        return { ok: true, prescriberWalletId, memberWalletId, effectiveDate };
      }

      case 'l2_getPcpAssignments': {
        const prescriberWalletId = params.prescriberWalletId as string;
        if (!prescriberWalletId) {
          throw new Error('Missing prescriberWalletId');
        }
        return this.pcpAssignments.get(prescriberWalletId) ?? [];
      }

      // ── Accumulator Reconstruction ──

      case 'l2_reconstructAccumulator': {
        const walletId = params.walletId;
        if (typeof walletId !== 'string') {
          throw new Error('Missing or invalid walletId parameter');
        }
        const planFilter = typeof params.planIdHash === 'string' && params.planIdHash.length > 0
          ? params.planIdHash : undefined;
        return this.node.getSequencer().reconstructAccumulator(walletId, planFilter);
      }

      // ── NFC Attestation ──

      case 'l2_requestAttestation': {
        if (!('requestAttestation' in this.node)) {
          throw new Error('Attestation not available on this node type');
        }
        const walletId = params.walletId;
        if (typeof walletId !== 'string') {
          throw new Error('Missing or invalid walletId parameter');
        }
        // Ensure entity-registry wallets are known to the node (survives restarts)
        if (this.entityRegistry.has(walletId) && 'registerKnownWallet' in this.node) {
          (this.node as L2Node).registerKnownWallet(walletId);
        }
        const expirySeconds = typeof params.expirySeconds === 'number'
          ? params.expirySeconds : undefined;
        const att = (this.node as L2Node).requestAttestation(walletId, expirySeconds);
        if (!att) {
          throw new Error('Attestation unavailable — wallet not found or attestation authority not configured');
        }
        return att;
      }

      case 'l2_getAttestation': {
        if (!('getAttestation' in this.node)) {
          throw new Error('Attestation not available on this node type');
        }
        const walletId = params.walletId;
        if (typeof walletId !== 'string') {
          throw new Error('Missing or invalid walletId parameter');
        }
        const cached = (this.node as L2Node).getAttestation(walletId);
        if (!cached) {
          throw new Error('No cached attestation for this wallet');
        }
        return cached;
      }

      case 'l2_getAttestationPublicKey': {
        if (!('getAttestationPublicKey' in this.node)) {
          throw new Error('Attestation not available on this node type');
        }
        const pk = (this.node as L2Node).getAttestationPublicKey();
        if (!pk) throw new Error('Attestation authority not configured');
        return { publicKey: pk };
      }

      // ── Peer Network / Gossip methods ──

      case 'l2_gossipRelay': {
        if (!this.peerNetwork) {
          throw new Error('Peer network not configured');
        }
        const message = params.message as GossipMessage;
        if (!message || !message.messageId || !message.type) {
          throw new Error('Missing or invalid message parameter');
        }
        const fromPeerId = typeof params.fromPeerId === 'string'
          ? params.fromPeerId : undefined;
        const accepted = await this.peerNetwork.handleIncomingAndRelay(
          message, fromPeerId,
        );
        return { accepted };
      }

      case 'l2_getPeerInfo': {
        const seq = this.node.getSequencer();
        const nodeId = this.peerNetwork?.getConfig().nodeId
          ?? (this.node as any).nodeId
          ?? (this.node as any).options?.nodeId
          ?? 'unknown';
        const nodeRole = this.peerNetwork?.getConfig().role
          ?? (this.node as any).role
          ?? 'sequencer';
        const peerInfo: PeerInfo = {
          peerId: nodeId,
          url: '', // Caller knows the URL they connected to
          role: nodeRole,
          status: 'connected',
          lastSeen: Date.now(),
          latestSequenceNumber: seq.getLatestSequenceNumber(),
          latestBatchNumber: seq.getLatestBatchNumber(),
          ...(this.vkCommitment ? { vkCommitment: this.vkCommitment } : {}),
        };
        return peerInfo;
      }

      case 'l2_getPeerList': {
        if (!this.peerNetwork) {
          return [];
        }
        return this.peerNetwork.getPeers().map((p) => ({
          nodeId: p.peerId,
          id: p.peerId,
          url: p.url,
          role: p.role,
          status: p.status === 'connected' ? 'active' : p.status,
          lastSeen: p.lastSeen,
        }));
      }

      case 'l2_requestSnapshot': {
        return this.node.getSequencer().exportState();
      }

      case 'l2_getStateDigest': {
        const seq = this.node.getSequencer();
        const digest: StateDigest = {
          latestSequenceNumber: seq.getLatestSequenceNumber(),
          latestBatchNumber: seq.getLatestBatchNumber(),
          auditChainHash: seq.getLatestChainHash(),
          claimAccumulatorRoot: this.node.getClaimAccumulatorRoot(),
          registryRoot: seq.getCurrentRegistryRoot().toString(),
          lifecycleRoot: seq.getCurrentLifecycleRoot().toString(),
          walletCount: seq.getCurrentWalletCount().toString(),
        };
        return digest;
      }

      case 'l2_getPartitionInfo': {
        const partConfig = this.node.getPartitionConfig();
        const router = this.node.getPartitionRouter();
        return {
          partitioned: partConfig !== null,
          partitionConfig: partConfig,
          allPartitions: router ? router.getAllPartitions() : [],
          l2Only: this.node.isL2Only(),
        };
      }

      // ── Leviathan-specific methods ──

      case 'l2_getLeviathanStatus': {
        if (!(this.node instanceof L2Leviathan)) {
          throw new Error('Not a leviathan node');
        }
        return this.node.getStatus();
      }

      case 'l2_getPartitionLeaders': {
        if (!(this.node instanceof L2Leviathan)) {
          throw new Error('Not a leviathan node');
        }
        const leaderMap: Record<number, string> = {};
        for (const [idx, entry] of this.node.getLeaderMap()) {
          leaderMap[idx] = entry.currentLeader;
        }
        return {
          leaderMap,
          activeLeaderPartitions: this.node.getActiveLeaderPartitions(),
        };
      }

      case 'l2_getPartitionStatus': {
        if (!(this.node instanceof L2Leviathan)) {
          throw new Error('Not a leviathan node');
        }
        const pIdx = params.partitionIndex;
        if (typeof pIdx !== 'number') {
          throw new Error('Missing or invalid partitionIndex parameter');
        }
        return this.node.getPartitionStatus(pIdx) ?? null;
      }

      // ── Quorum Protocol Methods ────────────────────────

      case 'l2_getQuorumStatus': {
        if (!(this.node instanceof L2Leviathan)) {
          throw new Error('Not a leviathan node');
        }
        return this.node.getQuorumStatus();
      }

      case 'l2_getStateCertificate': {
        if (!(this.node instanceof L2Leviathan)) {
          throw new Error('Not a leviathan node');
        }
        const certPartIdx = params.partitionIndex;
        if (typeof certPartIdx !== 'number') {
          throw new Error('Missing or invalid partitionIndex parameter');
        }
        return this.node.getLatestStateCertificate(certPartIdx) ?? null;
      }

      case 'l2_verifyStateCertificate': {
        if (!(this.node instanceof L2Leviathan)) {
          throw new Error('Not a leviathan node');
        }
        const cert = params.certificate;
        if (!cert) {
          throw new Error('Missing certificate parameter');
        }
        const quorumSvc = this.node.getQuorumService();
        if (!quorumSvc) {
          throw new Error('Quorum not enabled');
        }
        const valid = quorumSvc.verifyStateCertificate(
          cert as import('./l2-quorum-types.js').StateCertificate,
        );
        return { valid };
      }

      default:
        throw new Error(`Unknown method: ${method}`);
    }
  }

  // ─── Response Helpers ─────────────────────────────────

  private sendRpcResult(res: ServerResponse, id: string | number, result: unknown): void {
    const response: RpcResponse = { jsonrpc: '2.0', id, result };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(l2Stringify(response));
  }

  private sendRpcError(
    res: ServerResponse,
    id: string | number,
    code: number,
    message: string,
    data?: unknown,
  ): void {
    const response: RpcResponse = {
      jsonrpc: '2.0',
      id,
      error: { code, message, ...(data !== undefined ? { data } : {}) },
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(l2Stringify(response));
  }

  // ─── Viz Endpoints ───────────────────────────────────

  /** Accept a VizEvent from the scenario script */
  private async handleVizEmit(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: string;
    try {
      body = await this.readBody(req);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to read body' }));
      return;
    }

    let event: VizEvent;
    try {
      event = JSON.parse(body) as VizEvent;
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    // Assign sequential ID if missing
    if (!event.id) {
      this.vizEventIdCounter = (this.vizEventIdCounter + 1) % Number.MAX_SAFE_INTEGER;
      event.id = `viz-${String(this.vizEventIdCounter).padStart(6, '0')}`;
    }
    if (!event.timestamp) {
      event.timestamp = Date.now();
    }

    this.vizEventBuffer.push(event);
    if (this.vizEventBuffer.length > 10_000) {
      this.vizEventBuffer.shift();
    }
    this.broadcastVizSSE(event);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, id: event.id }));
  }

  /** SSE stream for visualization events — replays buffer on connect */
  private handleVizSSE(req: IncomingMessage, res: ServerResponse): void {
    // SSE connection limit — prevent memory exhaustion
    const maxSSE = this.options.maxSseConnections ?? 100;
    if (this.vizSseClients.size >= maxSSE) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Too many SSE connections' }));
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    this.vizSseClients.add(res);

    // Send connection acknowledgement only — no replay of past events.
    // Replaying the buffer caused a burst of stale animations on every page refresh.
    res.write(`data: ${JSON.stringify({ type: 'connected', timestamp: Date.now(), buffered: 0 })}\n\n`);

    req.on('close', () => {
      this.vizSseClients.delete(res);
      try { res.end(); } catch { /* already closed */ }
    });
  }

  /** Return viz event history as JSON array (GET /viz/history) */
  private handleVizHistory(res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(l2Stringify(this.vizEventBuffer));
  }

  /** Clear viz event buffer and entity registry (POST /viz/clear) */
  private handleVizClear(res: ServerResponse): void {
    const count = this.vizEventBuffer.length;
    this.vizEventBuffer = [];
    this.vizEventIdCounter = 0;
    this.entityRegistry.clear();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, cleared: count }));
  }

  /** Register entity metadata (POST /viz/entities) */
  private async handleVizEntityRegister(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: string;
    try {
      body = await this.readBody(req);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to read body' }));
      return;
    }

    try {
      const entities = JSON.parse(body) as VizEntity[];
      for (const entity of entities) {
        if (this.entityRegistry.size >= 1_000 && !this.entityRegistry.has(entity.walletId)) {
          res.writeHead(429, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Entity registry full (max 1000)' }));
          return;
        }
        this.entityRegistry.set(entity.walletId, entity);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, count: entities.length }));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
    }
  }

  /** Get entity registry (GET /viz/entities) */
  private handleVizEntitiesGet(res: ServerResponse): void {
    const entities: VizEntity[] = [];
    for (const entity of this.entityRegistry.values()) {
      entities.push(entity);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(entities));
  }

  /** Full state snapshot for late-joining browsers (GET /viz/state) */
  private handleVizState(res: ServerResponse): void {
    const state = {
      events: this.vizEventBuffer,
      entities: Array.from(this.entityRegistry.values()),
      nodeRunning: this.node.isRunning(),
      vizSseClients: this.vizSseClients.size,
      chainSseClients: this.sseClients.size,
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(state));
  }

  /** Broadcast a VizEvent to all viz SSE clients */
  private broadcastVizSSE(event: VizEvent): void {
    const data = l2Stringify(event);
    for (const client of this.vizSseClients) {
      try {
        client.write(`data: ${data}\n\n`);
      } catch {
        this.vizSseClients.delete(client);
        try { client.end(); } catch { /* socket already dead */ }
      }
    }
  }

  /**
   * Emit a viz event from an RPC handler — pushes to buffer + broadcasts via SSE.
   * This wires up sequencer operations that are otherwise silent (no chain event).
   */
  private emitVizEvent(
    type: VizEventType,
    lane: VizLane,
    actor: string,
    actorType: VizActorType,
    data: Record<string, unknown>,
    opts?: { target?: string; targetType?: string; stage?: number; totalStages?: number },
  ): void {
    const event: VizEvent = {
      type,
      timestamp: Date.now(),
      id: `viz-${String(this.vizEventIdCounter = (this.vizEventIdCounter + 1) % Number.MAX_SAFE_INTEGER).padStart(6, '0')}`,
      actor,
      actorType,
      data,
      lane,
      stage: opts?.stage ?? 1,
      totalStages: opts?.totalStages ?? 1,
      target: opts?.target,
      targetType: opts?.targetType,
    };
    this.vizEventBuffer.push(event);
    if (this.vizEventBuffer.length > 10_000) {
      this.vizEventBuffer.shift();
    }
    this.broadcastVizSSE(event);
  }

  /** Number of connected viz SSE clients */
  getVizSSEClientCount(): number {
    return this.vizSseClients.size;
  }

  // ─── Auth Helpers ──────────────────────────────────

  /** Admitted admin entry — a fully admitted node with voting rights */
  static readonly ADMIN_ENTRY_VERSION = 1;

  /** Runtime admin key registry — initialized from options, mutable at runtime for admissions */
  private adminKeyRegistry: Map<string, { publicKeyHex: string; admittedBy: string; reason: string; timestamp: number }> = new Map();

  /** Pending admission requests — awaiting quorum approval */
  private pendingAdmissions: Map<string, {
    nodeId: string;
    publicKeyHex: string;
    requestedAt: number;
    approvals: Map<string, { approverNodeId: string; reason: string; timestamp: number }>;
  }> = new Map();

  /** Blacklisted node IDs — permanently rejected */
  private blacklistedNodes: Set<string> = new Set();
  /** Blacklisted public keys — prevents re-registration under a different nodeId */
  private blacklistedPublicKeys: Set<string> = new Set();

  /** Initialize admin key registry from options */
  private initAdminKeys(): void {
    if (this.options.adminKeys) {
      for (const [nodeId, pubKeyHex] of this.options.adminKeys) {
        this.adminKeyRegistry.set(nodeId, {
          publicKeyHex: pubKeyHex,
          admittedBy: 'genesis',
          reason: 'Genesis admin key',
          timestamp: Date.now(),
        });
      }
    }
  }

  /** Constant-time comparison of two strings (prevents timing side-channel). */
  private static safeEquals(a: string, b: string): boolean {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
  }

  /**
   * Verify an Ed25519-signed admin request.
   *
   * Header format: `X-Admin-Signature: <nodeId>:<timestamp>:<signature_hex>`
   * The signature covers: `method|paramsHash|timestamp`
   * Replay window: 30 seconds.
   */
  private verifyAdminSignature(req: IncomingMessage, method: string, params: Record<string, unknown>): { valid: boolean; nodeId?: string } {
    const sigHeader = req.headers['x-admin-signature'] as string | undefined;
    if (!sigHeader) return { valid: false };

    const parts = sigHeader.split(':');
    if (parts.length < 3) return { valid: false };

    const nodeId = parts[0];
    const timestamp = parts[1];
    const signatureHex = parts.slice(2).join(':'); // signature may contain colons in hex

    // Check replay window (30 seconds)
    const ts = parseInt(timestamp, 10);
    if (isNaN(ts) || Math.abs(Date.now() - ts) > 30_000) return { valid: false };

    // Look up the node's public key
    const entry = this.adminKeyRegistry.get(nodeId);
    if (!entry) return { valid: false };

    // Verify Ed25519 signature
    const paramsHash = createHash('sha256').update(JSON.stringify(params)).digest('hex');
    const message = `${method}|${paramsHash}|${timestamp}`;

    try {
      const pubKeyDer = Buffer.from(
        '302a300506032b6570032100' + entry.publicKeyHex,
        'hex',
      );
      const pubKey = createPublicKey({ key: pubKeyDer, format: 'der', type: 'spki' });
      const isValid = verify(null, Buffer.from(message), pubKey, Buffer.from(signatureHex, 'hex'));
      return { valid: isValid, nodeId: isValid ? nodeId : undefined };
    } catch {
      return { valid: false };
    }
  }

  /** Check admin auth — Ed25519 signature in secure mode, Bearer token in unsecure mode. */
  private checkAdminAuth(req: IncomingMessage): boolean {
    // Unsecure mode — use legacy Bearer token
    if (this.options.unsecureMode || !this.adminKeyRegistry.size) {
      if (!this.options.adminToken) return false; // Default-deny — no token configured = reject
      const authHeader = req.headers['authorization'] ?? '';
      return L2RpcServer.safeEquals(authHeader, `Bearer ${this.options.adminToken}`);
    }
    // Secure mode — verify Ed25519 signature (non-RPC endpoints use a generic method check)
    const result = this.verifyAdminSignature(req, 'admin-endpoint', {});
    return result.valid;
  }

  /** Get the admin key registry (for status/debug endpoints) */
  getAdminKeyRegistry(): Map<string, { publicKeyHex: string; admittedBy: string; reason: string; timestamp: number }> {
    return this.adminKeyRegistry;
  }

  // ─── Admission Helpers ──────────────────────────────

  /** BFT quorum threshold: 2N/3+1 of existing admin nodes. Minimum 1. */
  private getAdmissionThreshold(): number {
    const n = this.adminKeyRegistry.size;
    if (n <= 1) return 1; // Single node can admit the next one
    return Math.floor((2 * n) / 3) + 1;
  }

  /** Get the admin key registry for checkpoint persistence */
  getAdminRegistryState(): {
    keys: Array<{ nodeId: string; publicKeyHex: string; admittedBy: string; reason: string; timestamp: number }>;
    blacklist: string[];
    blacklistedKeys: string[];
  } {
    const keys: Array<{ nodeId: string; publicKeyHex: string; admittedBy: string; reason: string; timestamp: number }> = [];
    for (const [nid, entry] of this.adminKeyRegistry) {
      keys.push({ nodeId: nid, ...entry });
    }
    return { keys, blacklist: [...this.blacklistedNodes], blacklistedKeys: [...this.blacklistedPublicKeys] };
  }

  /** Restore admin key registry from checkpoint */
  restoreAdminRegistryState(state: {
    keys: Array<{ nodeId: string; publicKeyHex: string; admittedBy: string; reason: string; timestamp: number }>;
    blacklist: string[];
    blacklistedKeys?: string[];
  }): void {
    this.adminKeyRegistry.clear();
    for (const entry of state.keys) {
      this.adminKeyRegistry.set(entry.nodeId, {
        publicKeyHex: entry.publicKeyHex,
        admittedBy: entry.admittedBy,
        reason: entry.reason,
        timestamp: entry.timestamp,
      });
    }
    this.blacklistedNodes.clear();
    for (const nid of state.blacklist) {
      this.blacklistedNodes.add(nid);
    }
    this.blacklistedPublicKeys.clear();
    for (const pk of state.blacklistedKeys ?? []) {
      this.blacklistedPublicKeys.add(pk);
    }
  }

  // ─── VK Commitment ──────────────────────────────────

  /** VK commitment — Poseidon.hash of all ZkProgram VK hashes. Set after compilation. */
  private vkCommitment: string | null = null;

  /** Set the VK commitment after ZkProgram compilation. Used for software identity verification. */
  setVkCommitment(commitment: string): void {
    this.vkCommitment = commitment;
  }

  /** Get the current VK commitment. */
  getVkCommitment(): string | null {
    return this.vkCommitment;
  }

  // ─── Rate Limiting ──────────────────────────────────

  private checkProofRateLimit(ip: string): boolean {
    const limit = this.options.proofRateLimitPerMinute ?? 60;
    if (limit <= 0) return true;
    const now = Date.now();
    const windowMs = 60_000;
    let timestamps = this.proofSubmissionLog.get(ip) ?? [];
    timestamps = timestamps.filter(t => now - t < windowMs);
    if (timestamps.length >= limit) return false;
    timestamps.push(now);
    this.proofSubmissionLog.set(ip, timestamps);
    return true;
  }

  // ─── Body Reader ──────────────────────────────────────

  private readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let totalBytes = 0;

      req.on('data', (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes > this.options.maxBodyBytes) {
          req.destroy();
          reject(new Error(`Request body exceeds ${this.options.maxBodyBytes} bytes`));
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
}
