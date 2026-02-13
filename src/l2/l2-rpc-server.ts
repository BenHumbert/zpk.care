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
import http from 'http';
import type { IncomingMessage, ServerResponse } from 'http';
import { StateTransitionProof } from '../engine/state-transition.js';
import type { L2Node, L2ChainEvent, L2EventHandler } from './l2-node.js';
import { l2Stringify, l2Parse } from './l2-json.js';

// ─── Configuration ──────────────────────────────────────

/** Configuration for the L2 RPC server */
export interface L2RpcServerOptions {
  /** Port to listen on. Default 3030. */
  port: number;
  /** Host to bind to. Default '0.0.0.0'. */
  host: string;
  /** Maximum request body size in bytes. Default 10MB (proofs are large). */
  maxBodyBytes: number;
  /** Whether to enable SSE event streaming. Default true. */
  enableSSE: boolean;
}

/** Default server options */
export const DEFAULT_RPC_SERVER_OPTIONS: L2RpcServerOptions = {
  port: 3030,
  host: '0.0.0.0',
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

// ─── L2RpcServer ────────────────────────────────────────

export class L2RpcServer {
  private node: L2Node;
  private options: L2RpcServerOptions;
  private server: http.Server;
  private sseClients: Set<ServerResponse> = new Set();
  private eventHandler: L2EventHandler;
  private listening = false;

  constructor(node: L2Node, options?: Partial<L2RpcServerOptions>) {
    this.node = node;
    this.options = { ...DEFAULT_RPC_SERVER_OPTIONS, ...options };

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

    // Unsubscribe from node events
    if (this.options.enableSSE) {
      this.node.off(this.eventHandler);
    }

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

  // ─── Request Handling ─────────────────────────────────

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

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

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }

  // ─── Health ───────────────────────────────────────────

  private handleHealth(res: ServerResponse): void {
    const body = JSON.stringify({
      ok: true,
      running: this.node.isRunning(),
      sseClients: this.sseClients.size,
    });
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

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    this.sseClients.add(res);

    // Send initial connection event
    res.write(`data: ${l2Stringify({ type: 'connected', timestamp: Date.now() })}\n\n`);

    // Clean up on disconnect
    req.on('close', () => {
      this.sseClients.delete(res);
    });
  }

  private broadcastSSE(event: L2ChainEvent): void {
    const data = l2Stringify(event);
    for (const client of this.sseClients) {
      try {
        client.write(`event: ${event.type}\ndata: ${data}\n\n`);
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

    // Dispatch to method handler
    try {
      const result = await this.dispatchMethod(rpcReq.method, rpcReq.params ?? {});
      this.sendRpcResult(res, rpcReq.id, result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      // Classify error
      if (message.includes('not found') || message.includes('Unknown method')) {
        this.sendRpcError(res, rpcReq.id, RPC_METHOD_NOT_FOUND, message);
      } else if (message.includes('verification failed') || message.includes('mismatch') || message.includes('REJECTED')) {
        this.sendRpcError(res, rpcReq.id, RPC_PROOF_REJECTED, message);
      } else if (message.includes('not running')) {
        this.sendRpcError(res, rpcReq.id, RPC_NODE_NOT_RUNNING, message);
      } else {
        this.sendRpcError(res, rpcReq.id, RPC_INTERNAL_ERROR, message);
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
        return this.node.submitProof(proof);
      }

      case 'l2_getStatus':
        return this.node.getStatus();

      case 'l2_getReceipt': {
        const receiptId = params.receiptId;
        if (typeof receiptId !== 'string') {
          throw new Error('Missing or invalid receiptId parameter');
        }
        return this.node.getSequencer().getReceipt(receiptId) ?? null;
      }

      case 'l2_getBlock': {
        const blockNum = params.blockNumber;
        if (typeof blockNum !== 'string' && typeof blockNum !== 'bigint') {
          throw new Error('Missing or invalid blockNumber parameter');
        }
        const bn = typeof blockNum === 'bigint' ? blockNum : BigInt(blockNum);
        return this.node.getSequencer().getBlock(bn) ?? null;
      }

      case 'l2_getBatch': {
        const batchNum = params.batchNumber;
        if (typeof batchNum !== 'string' && typeof batchNum !== 'bigint') {
          throw new Error('Missing or invalid batchNumber parameter');
        }
        const bn = typeof batchNum === 'bigint' ? batchNum : BigInt(batchNum);
        return this.node.getSequencer().getBatch(bn) ?? null;
      }

      case 'l2_forceBatch':
        return this.node.forceBatch();

      case 'l2_getAuditLog':
        return this.node.getSequencer().getAuditLog();

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
