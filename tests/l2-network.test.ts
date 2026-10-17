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
 * L2 Network — RPC Server, Client SDK, JSON Utilities, SSE Tests
 *
 * All FAST tests (no ZkProgram compilation). Server uses port 0
 * (OS-assigned random port) to avoid conflicts.
 *
 * Run: npx jest tests/l2-network.test.ts --verbose
 */
import http from 'http';
import { Field, MerkleTree } from 'o1js';
import {
  bigintReplacer,
  bigintReviver,
  l2Stringify,
  l2Parse,
  BIGINT_PREFIX,
} from '../src/l2/l2-json.js';
import { L2RpcServer, RPC_METHOD_NOT_FOUND, RPC_PARSE_ERROR, RPC_INVALID_REQUEST } from '../src/l2/l2-rpc-server.js';
import type { RpcRequest, RpcResponse } from '../src/l2/l2-rpc-server.js';
import { L2Client } from '../src/l2/l2-client.js';
import { L2Node } from '../src/l2/l2-node.js';
import type { L2ChainEvent } from '../src/l2/l2-node.js';
import { InMemoryStore } from '../src/storage/local-store.js';
import { WALLET_TREE_HEIGHT } from '../src/wallets/wallet-state.js';
import type { L2Receipt, L2Batch } from '../src/l2/l2-types.js';
import { createAcceptAllVerifierForTests } from '../src/l2/l2-proof-verifier.js';

// ─── Test Setup ─────────────────────────────────────────────

const emptyRegTree = new MerkleTree(WALLET_TREE_HEIGHT);
const emptyLcTree = new MerkleTree(WALLET_TREE_HEIGHT);
const INITIAL_REG_ROOT = emptyRegTree.getRoot();
const INITIAL_LC_ROOT = emptyLcTree.getRoot();

/** Helper: raw HTTP POST to the RPC endpoint */
function rawRpc(port: number, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: '/rpc', method: 'POST', headers: { 'Content-Type': 'application/json' } },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/** Helper: raw HTTP GET */
function rawGet(port: number, path: string): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port, path }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data, headers: res.headers }));
    }).on('error', reject);
  });
}

// ═══════════════════════════════════════════════════════════
// L2 JSON Utilities
// ═══════════════════════════════════════════════════════════

describe('L2 JSON Utilities', () => {
  test('bigintReplacer encodes bigint as prefixed string', () => {
    const result = bigintReplacer('', 42n);
    expect(result).toBe('__bigint__:42');
  });

  test('bigintReviver decodes prefixed string back to bigint', () => {
    const result = bigintReviver('', '__bigint__:42');
    expect(result).toBe(42n);
  });

  test('non-bigint values pass through replacer unchanged', () => {
    expect(bigintReplacer('', 'hello')).toBe('hello');
    expect(bigintReplacer('', 123)).toBe(123);
    expect(bigintReplacer('', true)).toBe(true);
    expect(bigintReplacer('', null)).toBe(null);
  });

  test('non-prefixed strings pass through reviver unchanged', () => {
    expect(bigintReviver('', 'hello')).toBe('hello');
    expect(bigintReviver('', '12345')).toBe('12345');
    expect(bigintReviver('', 123)).toBe(123);
  });

  test('l2Stringify/l2Parse round-trips object with bigint fields', () => {
    const original = {
      receiptId: 'l2-00000001',
      sequenceNumber: 5n,
      blockNumber: 0n,
      batchNumber: 0n,
      data: 'normal string',
      count: 42,
    };

    const json = l2Stringify(original);
    expect(json).toContain('__bigint__:5');
    expect(json).toContain('__bigint__:0');

    const parsed = l2Parse<typeof original>(json);
    expect(parsed.sequenceNumber).toBe(5n);
    expect(parsed.blockNumber).toBe(0n);
    expect(parsed.batchNumber).toBe(0n);
    expect(parsed.receiptId).toBe('l2-00000001');
    expect(parsed.data).toBe('normal string');
    expect(parsed.count).toBe(42);
  });

  test('l2Stringify/l2Parse round-trips bigint arrays', () => {
    const original = { blockNumbers: [0n, 1n, 2n] };
    const json = l2Stringify(original);
    const parsed = l2Parse<typeof original>(json);
    expect(parsed.blockNumbers).toEqual([0n, 1n, 2n]);
  });

  test('l2Stringify/l2Parse handles null bigint field', () => {
    const original = { inFlightBatch: null as bigint | null };
    const json = l2Stringify(original);
    const parsed = l2Parse<typeof original>(json);
    expect(parsed.inFlightBatch).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════
// L2RpcServer
// ═══════════════════════════════════════════════════════════

describe('L2RpcServer', () => {
  let node: L2Node;
  let server: L2RpcServer;
  let port: number;

  beforeEach(async () => {
    const store = new InMemoryStore();
    node = new L2Node(
      { batchIntervalMs: 60_000, autoSettle: false },
      store,
      INITIAL_REG_ROOT,
      INITIAL_LC_ROOT,
      Field(0),
    );
    node.getSequencer().setTransitionVerifier(createAcceptAllVerifierForTests('tests/l2-network.test.ts'));
    server = new L2RpcServer(node, { port: 0 }); // Random port
    await server.start();
    port = server.getPort();
  });

  afterEach(async () => {
    await server.stop();
    await node.stop();
  });

  test('health endpoint returns ok:true when node is stopped', async () => {
    const res = await rawGet(port, '/health');
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.ok).toBe(true);
    expect(data.running).toBe(false);
  });

  test('health endpoint returns running:true when node is started', async () => {
    node.start();
    const res = await rawGet(port, '/health');
    const data = JSON.parse(res.body);
    expect(data.ok).toBe(true);
    expect(data.running).toBe(true);
  });

  test('RPC l2_getStatus returns node status', async () => {
    node.start();
    const rpcReq: RpcRequest = { jsonrpc: '2.0', id: 1, method: 'l2_getStatus' };
    const res = await rawRpc(port, l2Stringify(rpcReq));
    const rpcRes = l2Parse<RpcResponse>(res.body);
    expect(rpcRes.result).toBeDefined();
    expect(rpcRes.error).toBeUndefined();
    const status = rpcRes.result as Record<string, unknown>;
    expect(status.running).toBe(true);
    expect(status.pendingProofs).toBe(0);
  });

  test('RPC returns method-not-found for unknown method', async () => {
    const rpcReq: RpcRequest = { jsonrpc: '2.0', id: 1, method: 'l2_unknownMethod' };
    const res = await rawRpc(port, l2Stringify(rpcReq));
    const rpcRes = l2Parse<RpcResponse>(res.body);
    expect(rpcRes.error).toBeDefined();
    expect(rpcRes.error!.code).toBe(RPC_METHOD_NOT_FOUND);
  });

  test('RPC returns parse-error for malformed JSON', async () => {
    const res = await rawRpc(port, '{not valid json');
    const rpcRes = l2Parse<RpcResponse>(res.body);
    expect(rpcRes.error).toBeDefined();
    expect(rpcRes.error!.code).toBe(RPC_PARSE_ERROR);
  });

  test('RPC returns invalid-request for missing jsonrpc field', async () => {
    const res = await rawRpc(port, JSON.stringify({ id: 1, method: 'l2_getStatus' }));
    const rpcRes = l2Parse<RpcResponse>(res.body);
    expect(rpcRes.error).toBeDefined();
    expect(rpcRes.error!.code).toBe(RPC_INVALID_REQUEST);
  });

  test('RPC l2_getReceipt returns null for unknown receipt', async () => {
    const rpcReq: RpcRequest = {
      jsonrpc: '2.0', id: 1, method: 'l2_getReceipt',
      params: { receiptId: 'nonexistent' },
    };
    const res = await rawRpc(port, l2Stringify(rpcReq));
    const rpcRes = l2Parse<RpcResponse>(res.body);
    expect(rpcRes.result).toBeNull();
  });

  test('RPC l2_getBlock returns null for unknown block', async () => {
    const rpcReq: RpcRequest = {
      jsonrpc: '2.0', id: 1, method: 'l2_getBlock',
      params: { blockNumber: '999' },
    };
    const res = await rawRpc(port, l2Stringify(rpcReq));
    const rpcRes = l2Parse<RpcResponse>(res.body);
    expect(rpcRes.result).toBeNull();
  });

  test('RPC l2_getBatch returns null for unknown batch', async () => {
    const rpcReq: RpcRequest = {
      jsonrpc: '2.0', id: 1, method: 'l2_getBatch',
      params: { batchNumber: '999' },
    };
    const res = await rawRpc(port, l2Stringify(rpcReq));
    const rpcRes = l2Parse<RpcResponse>(res.body);
    expect(rpcRes.result).toBeNull();
  });

  test('CORS headers are set on responses', async () => {
    const res = await rawGet(port, '/health');
    // Default restrictive CORS: no matching origin → 'null'
    expect(res.headers['access-control-allow-origin']).toBe('null');
  });

  test('404 for unknown paths', async () => {
    const res = await rawGet(port, '/unknown');
    expect(res.status).toBe(404);
  });

  test('server start/stop lifecycle', async () => {
    expect(server.isListening()).toBe(true);
    await server.stop();
    expect(server.isListening()).toBe(false);
    // Re-create to avoid afterEach double-stop issue
    server = new L2RpcServer(node, { port: 0 });
    await server.start();
    port = server.getPort();
    expect(server.isListening()).toBe(true);
  });

  test('server rejects body exceeding maxBodyBytes', async () => {
    // Create server with tiny body limit
    await server.stop();
    server = new L2RpcServer(node, { port: 0, maxBodyBytes: 50 });
    await server.start();
    port = server.getPort();

    const bigBody = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'l2_getStatus', extra: 'x'.repeat(100) });
    // Server destroys the socket when body is too large, causing a connection error
    await expect(rawRpc(port, bigBody)).rejects.toThrow();
  });

  // ─── State-Serving RPC Methods (P4) ─────────────────────

  test('RPC l2_getChainState returns chain state with correct roots', async () => {
    const rpcReq: RpcRequest = { jsonrpc: '2.0', id: 1, method: 'l2_getChainState' };
    const res = await rawRpc(port, l2Stringify(rpcReq));
    const rpcRes = l2Parse<RpcResponse>(res.body);
    expect(rpcRes.error).toBeUndefined();
    const state = rpcRes.result as Record<string, unknown>;
    expect(state.registryRoot).toBe(INITIAL_REG_ROOT.toString());
    expect(state.lifecycleRoot).toBe(INITIAL_LC_ROOT.toString());
    expect(state.walletCount).toBe('0');
    expect(state.chainProofEnabled).toBe(false);
    expect(state.pendingProofs).toBe(0);
    expect(state.latestBatchNumber).toBeNull();
    expect(state.latestBatchStatus).toBeNull();
    expect(typeof state.auditChainHash).toBe('string');
    expect(typeof state.globalStateRoot).toBe('string');
    expect(typeof state.blockHeight).toBe('string');
  });

  test('RPC l2_getReceiptsByWallet returns empty array for unknown wallet', async () => {
    const rpcReq: RpcRequest = {
      jsonrpc: '2.0', id: 1, method: 'l2_getReceiptsByWallet',
      params: { walletId: 'nonexistent-wallet' },
    };
    const res = await rawRpc(port, l2Stringify(rpcReq));
    const rpcRes = l2Parse<RpcResponse>(res.body);
    expect(rpcRes.error).toBeUndefined();
    expect(rpcRes.result).toEqual([]);
  });

  test('RPC l2_getAllReceipts returns empty array initially', async () => {
    const rpcReq: RpcRequest = { jsonrpc: '2.0', id: 1, method: 'l2_getAllReceipts' };
    const res = await rawRpc(port, l2Stringify(rpcReq));
    const rpcRes = l2Parse<RpcResponse>(res.body);
    expect(rpcRes.error).toBeUndefined();
    expect(rpcRes.result).toEqual([]);
  });

  test('RPC l2_getAllBatches returns empty array initially', async () => {
    const rpcReq: RpcRequest = { jsonrpc: '2.0', id: 1, method: 'l2_getAllBatches' };
    const res = await rawRpc(port, l2Stringify(rpcReq));
    const rpcRes = l2Parse<RpcResponse>(res.body);
    expect(rpcRes.error).toBeUndefined();
    expect(rpcRes.result).toEqual([]);
  });

  test('RPC l2_getChainProof returns enabled:false when no admin state set', async () => {
    const rpcReq: RpcRequest = { jsonrpc: '2.0', id: 1, method: 'l2_getChainProof' };
    const res = await rawRpc(port, l2Stringify(rpcReq));
    const rpcRes = l2Parse<RpcResponse>(res.body);
    expect(rpcRes.error).toBeUndefined();
    const proof = rpcRes.result as Record<string, unknown>;
    expect(proof.enabled).toBe(false);
    expect(proof.proofJson).toBeNull();
    expect(typeof proof.globalStateRoot).toBe('string');
    expect(typeof proof.blockHeight).toBe('string');
  });
});

// ═══════════════════════════════════════════════════════════
// L2Client
// ═══════════════════════════════════════════════════════════

describe('L2Client', () => {
  let node: L2Node;
  let server: L2RpcServer;
  let client: L2Client;

  beforeEach(async () => {
    const store = new InMemoryStore();
    node = new L2Node(
      { batchIntervalMs: 60_000, autoSettle: false },
      store,
      INITIAL_REG_ROOT,
      INITIAL_LC_ROOT,
      Field(0),
    );
    node.getSequencer().setTransitionVerifier(createAcceptAllVerifierForTests('tests/l2-network.test.ts'));
    node.start();
    server = new L2RpcServer(node, { port: 0 });
    await server.start();
    const port = server.getPort();
    client = new L2Client({ sequencerUrl: `http://127.0.0.1:${port}` });
  });

  afterEach(async () => {
    await server.stop();
    await node.stop();
  });

  test('getStatus returns node status over HTTP', async () => {
    const status = await client.getStatus();
    expect(status.running).toBe(true);
    expect(status.pendingProofs).toBe(0);
    expect(status.totalProofsAccepted).toBe(0);
  });

  test('getReceipt returns null for unknown receipt', async () => {
    const receipt = await client.getReceipt('nonexistent');
    expect(receipt).toBeNull();
  });

  test('isHealthy returns true when server is running', async () => {
    const healthy = await client.isHealthy();
    expect(healthy).toBe(true);
  });

  test('isHealthy returns false when server is down', async () => {
    await server.stop();
    const badClient = new L2Client({ sequencerUrl: 'http://127.0.0.1:59999', timeoutMs: 1000 });
    const healthy = await badClient.isHealthy();
    expect(healthy).toBe(false);
  });

  test('rpc error throws with error message', async () => {
    await expect(
      client.getBlock(-1n), // Invalid but parseable
    ).resolves.toBeNull(); // Returns null for not-found, not an error

    // Force a method-not-found error by calling a raw bad method
    await expect(async () => {
      // Access the private rpcCall via any
      const c = client as unknown as { rpcCall: (m: string) => Promise<unknown> };
      await c.rpcCall('l2_nonexistent');
    }).rejects.toThrow('RPC error');
  });

  // ─── State-Serving SDK Methods (P4) ─────────────────────

  test('getChainState returns chain state over HTTP', async () => {
    const state = await client.getChainState();
    expect(state.registryRoot).toBe(INITIAL_REG_ROOT.toString());
    expect(state.lifecycleRoot).toBe(INITIAL_LC_ROOT.toString());
    expect(state.walletCount).toBe('0');
    expect(state.chainProofEnabled).toBe(false);
    expect(state.pendingProofs).toBe(0);
    expect(state.latestBatchNumber).toBeNull();
    expect(state.latestBatchStatus).toBeNull();
  });

  test('getReceiptsByWallet returns empty for unknown wallet', async () => {
    const receipts = await client.getReceiptsByWallet('unknown-wallet-id');
    expect(receipts).toEqual([]);
  });

  test('getAllReceipts returns empty initially', async () => {
    const receipts = await client.getAllReceipts();
    expect(receipts).toEqual([]);
  });

  test('getAllBatches returns empty initially', async () => {
    const batches = await client.getAllBatches();
    expect(batches).toEqual([]);
  });

  test('getChainProof returns chain proof state over HTTP', async () => {
    const proof = await client.getChainProof();
    expect(proof.enabled).toBe(false);
    expect(proof.proofJson).toBeNull();
    expect(typeof proof.globalStateRoot).toBe('string');
    expect(typeof proof.blockHeight).toBe('string');
  });
});

// ═══════════════════════════════════════════════════════════
// SSE Event Streaming
// ═══════════════════════════════════════════════════════════

describe('SSE Event Streaming', () => {
  let node: L2Node;
  let server: L2RpcServer;
  let port: number;

  beforeEach(async () => {
    const store = new InMemoryStore();
    node = new L2Node(
      { batchIntervalMs: 60_000, autoSettle: false },
      store,
      INITIAL_REG_ROOT,
      INITIAL_LC_ROOT,
      Field(0),
    );
    node.getSequencer().setTransitionVerifier(createAcceptAllVerifierForTests('tests/l2-network.test.ts'));
    server = new L2RpcServer(node, { port: 0 });
    await server.start();
    port = server.getPort();
  });

  afterEach(async () => {
    await server.stop();
    await node.stop();
  });

  test('SSE endpoint returns event-stream content type', async () => {
    // Manual SSE connection to verify headers
    const res = await new Promise<http.IncomingMessage>((resolve) => {
      http.get({ hostname: '127.0.0.1', port, path: '/events' }, resolve);
    });

    expect(res.headers['content-type']).toBe('text/event-stream');
    expect(res.headers['cache-control']).toBe('no-cache');

    res.destroy();
    // Give time for cleanup
    await new Promise((r) => setTimeout(r, 50));
  });

  test('SSE sends initial connected event', async () => {
    const events: unknown[] = [];

    const res = await new Promise<http.IncomingMessage>((resolve) => {
      http.get({ hostname: '127.0.0.1', port, path: '/events' }, resolve);
    });

    await new Promise<void>((resolve) => {
      let buffer = '';
      res.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';
        for (const frame of frames) {
          const dataLine = frame.split('\n').find((l) => l.startsWith('data:'));
          if (dataLine) {
            events.push(JSON.parse(dataLine.slice(5).trim()));
          }
        }
        if (events.length >= 1) resolve();
      });
    });

    expect(events.length).toBeGreaterThanOrEqual(1);
    expect((events[0] as { type: string }).type).toBe('connected');

    res.destroy();
    await new Promise((r) => setTimeout(r, 50));
  });

  test('SSE receives node events after start', async () => {
    const events: L2ChainEvent[] = [];

    const client = new L2Client({ sequencerUrl: `http://127.0.0.1:${port}` });
    const disconnect = client.connectEvents((event) => {
      events.push(event);
    });

    // Wait for connection
    await new Promise((r) => setTimeout(r, 200));

    // Start the node — should emit 'node:started' event
    node.start();

    // Wait for event propagation
    await new Promise((r) => setTimeout(r, 200));

    // Find the node:started event (filter out 'connected' initial event)
    const startEvent = events.find((e) => e.type === 'node:started');
    expect(startEvent).toBeDefined();
    expect(startEvent!.type).toBe('node:started');

    disconnect();
    await new Promise((r) => setTimeout(r, 50));
  });

  test('server tracks SSE client count correctly', async () => {
    expect(server.getSSEClientCount()).toBe(0);

    const res = await new Promise<http.IncomingMessage>((resolve) => {
      http.get({ hostname: '127.0.0.1', port, path: '/events' }, resolve);
    });

    // Wait for connection to register
    await new Promise((r) => setTimeout(r, 100));
    expect(server.getSSEClientCount()).toBe(1);

    res.destroy();
    await new Promise((r) => setTimeout(r, 100));
    expect(server.getSSEClientCount()).toBe(0);
  });

  test('disconnect function stops receiving events', async () => {
    const events: L2ChainEvent[] = [];

    const client = new L2Client({ sequencerUrl: `http://127.0.0.1:${port}` });
    const disconnect = client.connectEvents((event) => {
      events.push(event);
    });

    // Wait for connection
    await new Promise((r) => setTimeout(r, 200));
    const countBefore = events.length;

    // Disconnect
    disconnect();
    await new Promise((r) => setTimeout(r, 100));

    // Start node — events should NOT reach the disconnected client
    node.start();
    await new Promise((r) => setTimeout(r, 200));

    // No new events after disconnect (at most 1 more from the connected event)
    // The key assertion is that node:started does NOT appear
    const nodeStarted = events.find((e) => e.type === 'node:started');
    expect(nodeStarted).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════
// Client-Server Integration
// ═══════════════════════════════════════════════════════════

describe('L2 Client-Server Integration', () => {
  let node: L2Node;
  let server: L2RpcServer;
  let client: L2Client;

  beforeEach(async () => {
    const store = new InMemoryStore();
    node = new L2Node(
      { batchIntervalMs: 60_000, autoSettle: false },
      store,
      INITIAL_REG_ROOT,
      INITIAL_LC_ROOT,
      Field(0),
    );
    node.getSequencer().setTransitionVerifier(createAcceptAllVerifierForTests('tests/l2-network.test.ts'));
    node.start();
    server = new L2RpcServer(node, { port: 0 });
    await server.start();
    const port = server.getPort();
    client = new L2Client({ sequencerUrl: `http://127.0.0.1:${port}` });
  });

  afterEach(async () => {
    await server.stop();
    await node.stop();
  });

  test('getAuditLog returns audit events over HTTP', async () => {
    const auditLog = await client.getAuditLog();
    expect(auditLog).toBeDefined();
    expect(auditLog.events).toEqual([]);
    expect(auditLog.eventCount).toBe(0n);
    expect(typeof auditLog.genesisHash).toBe('string');
    expect(typeof auditLog.latestChainHash).toBe('string');
  });

  test('getBlock and getBatch return null when no batches exist', async () => {
    const block = await client.getBlock(0n);
    expect(block).toBeNull();

    const batch = await client.getBatch(0n);
    expect(batch).toBeNull();
  });

  test('status bigint fields round-trip correctly', async () => {
    const status = await client.getStatus();
    // inFlightBatch is bigint | null
    expect(status.inFlightBatch).toBeNull();
    expect(typeof status.running).toBe('boolean');
    expect(typeof status.pendingProofs).toBe('number');
    expect(typeof status.currentRegistryRoot).toBe('string');
  });
});
