#!/usr/bin/env node
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
 * start-nautilus.ts — Nautilus Replica Entry Point
 *
 * Starts a read-only replica node for the Adjuda-GATOR Network.
 * Receives state via gossip from Leviathan sequencers, serves RPC queries
 * across all partitions, and maintains its own checkpoint for crash recovery.
 *
 * A Nautilus replica can bootstrap from either:
 *   1. A local checkpoint (fastest — no network required)
 *   2. Initial Block Download from a peer (ZKTRIDENT_SYNC_PEER)
 *
 * Configuration via environment variables:
 *
 *   ZKTRIDENT_PORT             — RPC server port (default: 3031)
 *   ZKTRIDENT_HOST             — RPC bind address (default: 0.0.0.0)
 *   ZKTRIDENT_NODE_ID          — Unique node identifier (default: auto-generated)
 *   ZKTRIDENT_SEED_PEERS       — Comma-separated peer URLs (default: none)
 *   ZKTRIDENT_ADMIN_TOKEN      — Bearer token for admin RPC methods (default: none)
 *   ZKTRIDENT_GOSSIP_SECRET    — HMAC-SHA256 shared secret for gossip auth (default: none)
 *   ZKTRIDENT_CHECKPOINT_DIR   — Directory for checkpoint files (default: ./l2-data)
 *   ZKTRIDENT_MAX_CHECKPOINTS  — Max checkpoint files to keep (default: 10)
 *   ZKTRIDENT_SYNC_PEER        — Peer URL for Initial Block Download (default: none)
 *   ZKTRIDENT_SSE              — Enable SSE event streaming (default: true)
 *   ZKTRIDENT_MAX_SSE          — Max concurrent SSE connections (default: 100)
 *   ZKTRIDENT_CORS_ORIGINS     — Comma-separated allowed CORS origins (default: *)
 *
 * Usage:
 *   ZKTRIDENT_SYNC_PEER=http://localhost:3030 npx tsx src/nodes/start-nautilus.ts
 *   ZKTRIDENT_PORT=3031 ZKTRIDENT_CHECKPOINT_DIR=./replica-data npx tsx src/nodes/start-nautilus.ts
 */
import { L2Node } from '../l2/l2-node.js';
import type { L2NodeOptions } from '../l2/l2-node.js';
import { L2RpcServer } from '../l2/l2-rpc-server.js';
import type { L2RpcServerOptions } from '../l2/l2-rpc-server.js';
import { L2CheckpointStore } from '../l2/l2-checkpoint.js';
import { InMemoryStore } from '../storage/local-store.js';

// ─── Environment Parsing ──────────────────────────────────────

const env = process.env;

const port = parseInt(env.ZKTRIDENT_PORT ?? '3031', 10);
const host = env.ZKTRIDENT_HOST ?? '0.0.0.0';
const nodeId = env.ZKTRIDENT_NODE_ID;
const seedPeers = env.ZKTRIDENT_SEED_PEERS
  ? env.ZKTRIDENT_SEED_PEERS.split(',').map((s) => s.trim()).filter(Boolean)
  : [];
const adminToken = env.ZKTRIDENT_ADMIN_TOKEN;
const gossipSecret = env.ZKTRIDENT_GOSSIP_SECRET;
const checkpointDir = env.ZKTRIDENT_CHECKPOINT_DIR ?? './l2-data';
const maxCheckpoints = parseInt(env.ZKTRIDENT_MAX_CHECKPOINTS ?? '10', 10);
const syncPeer = env.ZKTRIDENT_SYNC_PEER;
const enableSSE = (env.ZKTRIDENT_SSE ?? 'true') !== 'false';
const maxSseConnections = parseInt(env.ZKTRIDENT_MAX_SSE ?? '100', 10);
const allowedOrigins = env.ZKTRIDENT_CORS_ORIGINS
  ? env.ZKTRIDENT_CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
  : ['*'];

// ─── Build Options ────────────────────────────────────────────

const nodeOptions: Partial<L2NodeOptions> = {
  batchIntervalMs: 180_000, // Not used by replicas, but required by L2NodeOptions
  autoSettle: true,
  settlementDelayMs: 1_000,
  maxBatchRetries: 3,
  role: 'replica',
  l2Only: true, // Replicas don't settle to L1
  seedPeers: seedPeers.length > 0 ? seedPeers : undefined,
  ...(nodeId ? { nodeId } : {}),
  ...(adminToken ? { adminToken } : {}),
  ...(gossipSecret ? { gossipSecret } : {}),
};

const rpcOptions: Partial<L2RpcServerOptions> = {
  port,
  host,
  enableSSE,
  maxSseConnections,
  allowedOrigins,
  ...(adminToken ? { adminToken } : {}),
};

// ─── Main ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('');
  console.log('  ╔══════════════════════════════════════════════╗');
  console.log('  ║     🐊  NAUTILUS REPLICA — Adjuda-GATOR     ║');
  console.log('  ╚══════════════════════════════════════════════╝');
  console.log('');

  const store = new InMemoryStore();
  const checkpointStore = new L2CheckpointStore(checkpointDir);

  // ── Recovery or IBD ──

  let node: L2Node;
  const checkpoint = await checkpointStore.loadLatest();

  if (checkpoint) {
    console.log(`  [recovery] Restoring from checkpoint (batch #${checkpoint.lastSettledBatchNumber ?? 'none'})`);
    console.log(`  [recovery] Checkpoint created at ${new Date(checkpoint.createdAt).toISOString()}`);
    node = L2Node.fromCheckpoint(checkpoint, store, nodeOptions);
    console.log('  [recovery] State restored successfully');
  } else if (syncPeer) {
    console.log('  [ibd] No checkpoint found — syncing from peer: %s', syncPeer);
    node = await L2Node.fromPeerSync(syncPeer, store, nodeOptions);
    console.log('  [ibd] State downloaded successfully');
  } else {
    console.error('');
    console.error('  ERROR: No checkpoint found and no ZKTRIDENT_SYNC_PEER configured.');
    console.error('');
    console.error('  A Nautilus replica cannot start from genesis — it needs either:');
    console.error('    1. An existing checkpoint in %s', checkpointDir);
    console.error('    2. A peer to sync from: ZKTRIDENT_SYNC_PEER=http://sequencer:3030');
    console.error('');
    process.exit(1);
  }

  // ── Checkpoint Store ──

  node.setCheckpointStore(checkpointStore, {
    autoCheckpoint: true,
    maxCheckpoints,
  });

  // ── RPC Server ──

  const rpcServer = new L2RpcServer(node, rpcOptions);
  await rpcServer.start();

  // ── Start Node ──

  node.start();

  // ── Startup Banner ──

  console.log('');
  console.log('  Nautilus Replica is running');
  console.log('  ─────────────────────────────────');
  console.log('  Node ID:       %s', nodeId ?? '(auto-generated)');
  console.log('  Role:          replica');
  console.log('  RPC:           http://%s:%d/rpc', host, port);
  console.log('  SSE:           %s', enableSSE ? `http://${host}:${port}/events` : 'disabled');
  if (seedPeers.length > 0) {
    console.log('  Seed peers:    %s', seedPeers.join(', '));
  }
  if (syncPeer) {
    console.log('  Sync peer:     %s', syncPeer);
  }
  console.log('  Checkpoint:    %s (max %d)', checkpointDir, maxCheckpoints);
  console.log('  Admin token:   %s', adminToken ? 'configured' : 'NONE (admin RPC disabled)');
  console.log('  Gossip secret: %s', gossipSecret ? 'configured' : 'NONE (unauthenticated gossip)');
  console.log('');

  // ── Graceful Shutdown ──

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log('');
    console.log('  [%s] Shutting down gracefully...', signal);
    await node.stop();
    console.log('  [shutdown] Node stopped (checkpoint saved)');
    await rpcServer.stop();
    console.log('  [shutdown] RPC server stopped');
    console.log('  [shutdown] Nautilus replica shut down cleanly');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('  [FATAL] Nautilus startup failed:', err);
  process.exit(1);
});
