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
import type { IncomingMessage, ServerResponse } from 'http';
import { timingSafeEqual } from 'crypto';
import { Field } from 'o1js';
import { StateTransitionProof } from '../engine/state-transition.js';
import type { L2Node, L2ChainEvent, L2EventHandler } from './l2-node.js';
import { L2Leviathan } from './l2-leviathan.js';
import { l2Stringify, l2Parse } from './l2-json.js';
import type { L2PeerNetwork } from './l2-peer-network.js';
import type { GossipMessage, PeerInfo, StateDigest } from './l2-peer-types.js';
import { ProviderLifecycle, PROVIDER_TYPE_TAG } from './provider-registry-types.js';
import type { ProviderType } from './provider-registry-types.js';
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

/** A visualization event pushed by the demo scenario script */
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
  /** Bearer token for admin RPC methods. When set, admin methods require Authorization header. */
  adminToken?: string;
  /** Allowed CORS origins. Default ['http://localhost', 'http://127.0.0.1']. Set to ['*'] for open access. */
  allowedOrigins?: string[];
  /** Maximum concurrent SSE connections. Default 100. */
  maxSseConnections?: number;
  /** Max proof submissions per IP per minute. Default 60. Set to 0 to disable. */
  proofRateLimitPerMinute?: number;
  /** Directory containing dashboard static files. When set, serves files at /. */
  dashboardDir?: string;
}

/** Default server options */
export const DEFAULT_RPC_SERVER_OPTIONS: L2RpcServerOptions = {
  port: 3030,
  host: '127.0.0.1',
  maxBodyBytes: 10 * 1024 * 1024,
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
  private server: http.Server;
  private sseClients: Set<ServerResponse> = new Set();
  private eventHandler: L2EventHandler;
  private listening = false;

  /** Admin-only RPC methods that require bearer token authentication */
  private static readonly ADMIN_METHODS = new Set([
    'l2_forceBatch',
    'l2_storeFormulary',
    'l2_registerEntity',
    'l2_credentialProvider',
    'l2_updateProviderStatus',
    'l2_syncFromL1',
    'l2_requestSnapshot',
    'l2_gossipRelay',
    'l2_recordFill',
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

  // Dynamic route registration
  private additionalRoutes: Map<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>> = new Map();

  // Dashboard static file directory
  private dashboardDir: string | null = null;

  constructor(node: L2Node | L2Leviathan, options?: Partial<L2RpcServerOptions>) {
    this.node = node;
    this.options = { ...DEFAULT_RPC_SERVER_OPTIONS, ...options };
    this.dashboardDir = this.options.dashboardDir ?? null;

    // Bridge L2Node events to SSE clients
    this.eventHandler = (event: L2ChainEvent) => {
      this.broadcastSSE(event);
    };

    if (this.options.enableSSE) {
      this.node.on(this.eventHandler);
    }

    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res).catch(() => {
        if (!res.writableEnded) {
          res.writeHead(500);
          res.end('Internal Server Error');
        }
      });
    });
  }

  /** Programmatically seed entities into the entity registry (e.g. demo providers on startup) */
  seedEntities(entities: VizEntity[]): void {
    for (const entity of entities) {
      this.entityRegistry.set(entity.walletId, entity);
    }
  }

  // ─── Lifecycle ──────────────────────────────────────────

  /** Start listening for HTTP connections */
  async start(): Promise<void> {
    if (this.listening) return;

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
  ): void {
    this.additionalRoutes.set(`${method.toUpperCase()}:${path}`, handler);
  }

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
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

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
      return customHandler(req, res);
    }

    // ── Dashboard static files ──
    if (req.method === 'GET' && this.dashboardDir) {
      const safePath = pathname === '/' ? '/index.html' : pathname;
      // Only allow alphanumeric, dots, hyphens, slashes — no ..
      if (/^[/a-zA-Z0-9._-]+$/.test(safePath) && !safePath.includes('..')) {
        const filePath = path.join(this.dashboardDir, safePath);
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
    });
  }

  private broadcastSSE(event: L2ChainEvent): void {
    // M9 fix: Store in ring buffer before broadcasting
    this.sseEventIdCounter++;
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

    // Admin auth gate — require bearer token for privileged methods
    // No token configured = dev mode (open access)
    if (L2RpcServer.ADMIN_METHODS.has(rpcReq.method) && this.options.adminToken) {
      const authHeader = req.headers['authorization'] ?? '';
      if (!L2RpcServer.safeEquals(authHeader, `Bearer ${this.options.adminToken}`)) {
        return this.sendRpcError(res, rpcReq.id, RPC_UNAUTHORIZED, 'Unauthorized');
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
      } else if (message.includes('Missing or invalid') || message.includes('not configured') || message.includes('Duplicate proof') || message.includes('Wrong partition') || message.includes('Not leader') || message.includes('Not a leviathan') || message.includes('already registered') || message.includes('registry full')) {
        this.sendRpcError(res, rpcReq.id, RPC_INVALID_PARAMS, message);
      } else {
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

      case 'l2_getStatus':
        return this.node.getStatus();

      case 'l2_getHealth': {
        const mem = process.memoryUsage();
        const pool = !(this.node instanceof L2Leviathan)
          ? (this.node as L2Node).getProvingPool()
          : null;
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
        this.node.getSequencer().storeFormulary(planIdHash, formularyRoot, entriesJson);
        this.node.emit({
          type: 'formulary:updated',
          timestamp: Date.now(),
          data: { planIdHash, formularyRoot },
        });
        return { success: true, planIdHash, formularyRoot };
      }

      case 'l2_syncFromL1': {
        const regRoot = params.registryRoot;
        const lcRoot = params.lifecycleRoot;
        const walletCount = params.walletCount;
        if (typeof regRoot !== 'string') {
          throw new Error('Missing or invalid registryRoot parameter');
        }
        if (typeof lcRoot !== 'string') {
          throw new Error('Missing or invalid lifecycleRoot parameter');
        }
        if (typeof walletCount !== 'string') {
          throw new Error('Missing or invalid walletCount parameter');
        }
        this.node.syncFromL1(
          Field(BigInt(regRoot)),
          Field(BigInt(lcRoot)),
          Field(BigInt(walletCount)),
        );
        return { success: true, registryRoot: regRoot, lifecycleRoot: lcRoot, walletCount };
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
        const fillEntry = fillSeq.recordFill(
          { memberWalletId: fillMember, ndcHash: fillNdc, pharmacyWalletId: fillPharmacy, prescriberWalletId: fillPrescriber, dateOfService: fillDate, patientPayCents: fillPatientPay, planPayCents: fillPlanPay, operationType: fillOpType, deductibleCreditCents: fillDeductible },
          { receiptId: `FILL-${Date.now()}`, timestamp: Date.now(), ndc: params.ndc as string, brandName: params.brandName as string, daysSupply: params.daysSupply as number, fillNumber: params.fillNumber as number },
        );
        return { ok: true, leafIndex: fillEntry.leafIndex.toString(), leafHash: fillEntry.leafHash };
      }

      case 'l2_getRegistrationWitnesses': {
        return this.node.getSequencer().getRegistrationWitnesses();
      }

      case 'l2_getWalletWitnesses': {
        const wid = params.walletId ?? params[0];
        if (typeof wid !== 'string') throw new Error('Missing walletId parameter');
        return this.node.getSequencer().getWalletWitnesses(wid);
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
        return this.node.storeMessage(storedMessage, messagePayload);
      }

      // ── Entity Registry (admin-gated) — dual-writes to viz registry + provider registry ──

      case 'l2_registerEntity': {
        const walletId = params.walletId as string;
        const displayName = params.displayName as string;
        const type = params.type as string;
        if (!walletId || !displayName || !type) {
          throw new Error('Missing walletId, displayName, or type');
        }
        // Viz registry (backward compat)
        this.entityRegistry.set(walletId, {
          walletId,
          displayName,
          type: type as VizActorType,
          specialty: params.specialty as string | undefined,
          pharmacyType: params.pharmacyType as string | undefined,
          group: params.group as string | undefined,
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
                verificationMethod: 'demo',
                updatedAt: Date.now(),
              },
            );
          } catch {
            // Already registered — ignore duplicate (idempotent)
          }
        }
        // Track wallet for attestation eligibility
        this.node.registerKnownWallet(walletId);
        return { ok: true, walletId, displayName, type };
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
            verificationMethod: (params.verificationMethod as 'nppes' | 'ncpdp' | 'manual' | 'demo' | undefined) ?? 'manual',
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
        const newState = parseInt(String(params.newState), 10) as ProviderLifecycle;
        if (!walletId) throw new Error('Missing walletId');
        if (isNaN(newState) || newState < 0 || newState > 4) throw new Error('Invalid newState (0-4)');
        const seq = this.node.getSequencer();
        const entry = seq.updateProviderStatus(walletId, newState);
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
            role: e.metadata.providerType,
            specialty: e.metadata.specialty,
            pharmacyType: e.metadata.pharmacyType,
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
            role: e.type,
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
        return this.node.getSequencer().reconstructAccumulator(walletId);
      }

      // ── NFC Attestation ──

      case 'l2_requestAttestation': {
        const walletId = params.walletId;
        if (typeof walletId !== 'string') {
          throw new Error('Missing or invalid walletId parameter');
        }
        const expirySeconds = typeof params.expirySeconds === 'number'
          ? params.expirySeconds : undefined;
        const att = this.node.requestAttestation(walletId, expirySeconds);
        if (!att) {
          throw new Error('Attestation unavailable — wallet not found or attestation authority not configured');
        }
        return att;
      }

      case 'l2_getAttestation': {
        const walletId = params.walletId;
        if (typeof walletId !== 'string') {
          throw new Error('Missing or invalid walletId parameter');
        }
        const cached = this.node.getAttestation(walletId);
        if (!cached) {
          throw new Error('No cached attestation for this wallet');
        }
        return cached;
      }

      case 'l2_getAttestationPublicKey': {
        const pk = this.node.getAttestationPublicKey();
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
        const peerInfo: PeerInfo = {
          peerId: this.peerNetwork?.getConfig().nodeId ?? 'unknown',
          url: '', // Caller knows the URL they connected to
          role: this.peerNetwork?.getConfig().role ?? 'sequencer',
          status: 'connected',
          lastSeen: Date.now(),
          latestSequenceNumber: seq.getLatestSequenceNumber(),
          latestBatchNumber: seq.getLatestBatchNumber(),
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

  /** Accept a VizEvent from the demo script */
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
      this.vizEventIdCounter++;
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
    });
  }

  /** Return viz event history as JSON array (GET /viz/history) */
  private handleVizHistory(res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify(this.vizEventBuffer));
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
    const data = JSON.stringify(event);
    for (const client of this.vizSseClients) {
      try {
        client.write(`data: ${data}\n\n`);
      } catch {
        this.vizSseClients.delete(client);
      }
    }
  }

  /** Number of connected viz SSE clients */
  getVizSSEClientCount(): number {
    return this.vizSseClients.size;
  }

  // ─── Auth Helpers ──────────────────────────────────

  /** Constant-time comparison of two strings (prevents timing side-channel). */
  private static safeEquals(a: string, b: string): boolean {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
  }

  /** Check admin bearer token for non-RPC endpoints. No token configured = allow (dev mode). */
  private checkAdminAuth(req: IncomingMessage): boolean {
    if (!this.options.adminToken) return true; // Dev mode — no token = open access
    const authHeader = req.headers['authorization'] ?? '';
    return L2RpcServer.safeEquals(authHeader, `Bearer ${this.options.adminToken}`);
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
