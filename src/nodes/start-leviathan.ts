#!/usr/bin/env node
/**
 * start-leviathan.ts — Leviathan Sequencer Entry Point
 *
 * Starts a partitioned sequencer node for the zkTrident Network.
 * Accepts proofs for its assigned partition, builds batches on a timer,
 * gossips state to peers, and serves RPC queries.
 *
 * Configuration via environment variables (all optional — sensible defaults):
 *
 *   ZKTRIDENT_PORT             — RPC server port (default: 3030)
 *   ZKTRIDENT_HOST             — RPC bind address (default: 0.0.0.0)
 *   ZKTRIDENT_NODE_ID          — Unique node identifier (default: auto-generated)
 *   ZKTRIDENT_BATCH_INTERVAL_MS — Batch timer interval in ms (default: 180000 = 3 min)
 *   ZKTRIDENT_PARTITION_COUNT  — Total partitions in the network (default: 1)
 *   ZKTRIDENT_PARTITION_INDEX  — This sequencer's partition index (default: 0)
 *   ZKTRIDENT_SEED_PEERS       — Comma-separated peer URLs (default: none)
 *   ZKTRIDENT_ADMIN_TOKEN      — Bearer token for admin RPC methods (default: none)
 *   ZKTRIDENT_GOSSIP_SECRET    — HMAC-SHA256 shared secret for gossip auth (default: none)
 *   ZKTRIDENT_CHECKPOINT_DIR   — Directory for checkpoint files (default: ./l2-data)
 *   ZKTRIDENT_MAX_CHECKPOINTS  — Max checkpoint files to keep (default: 10)
 *   ZKTRIDENT_L2_ONLY          — Skip MINA L1 settlement (default: true)
 *   ZKTRIDENT_SSE              — Enable SSE event streaming (default: true)
 *   ZKTRIDENT_MAX_SSE          — Max concurrent SSE connections (default: 100)
 *   ZKTRIDENT_CORS_ORIGINS     — Comma-separated allowed CORS origins (default: *)
 *   ZKTRIDENT_POOL_SIZE        — Proving pool workers: number or "auto" (default: "auto", min 3)
 *   ZKTRIDENT_POOL_RECYCLE     — Recycle worker after N jobs to reclaim WASM heap (default: 3)
 *   ZKTRIDENT_PRODUCTION_FORMULARY — Load 500 NDC NADAC formulary on startup (default: false)
 *
 * Usage:
 *   npx tsx src/nodes/start-leviathan.ts
 *   ZKTRIDENT_PORT=3030 ZKTRIDENT_PARTITION_COUNT=3 ZKTRIDENT_PARTITION_INDEX=0 npx tsx src/nodes/start-leviathan.ts
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { Field, MerkleTree } from 'o1js';
import { L2Node } from '../l2/l2-node.js';
import type { L2NodeOptions } from '../l2/l2-node.js';
import { L2RpcServer } from '../l2/l2-rpc-server.js';
import type { L2RpcServerOptions } from '../l2/l2-rpc-server.js';
import { L2CheckpointStore } from '../l2/l2-checkpoint.js';
import { InMemoryStore } from '../storage/local-store.js';
import { WALLET_TREE_HEIGHT } from '../wallets/wallet-state.js';
import type { PartitionConfig } from '../l2/l2-partition.js';

// ─── Environment Parsing ──────────────────────────────────────

const env = process.env;

const port = parseInt(env.ZKTRIDENT_PORT ?? '3030', 10);
const host = env.ZKTRIDENT_HOST ?? '0.0.0.0';
const nodeId = env.ZKTRIDENT_NODE_ID;
const batchIntervalMs = parseInt(env.ZKTRIDENT_BATCH_INTERVAL_MS ?? '180000', 10);
const partitionCount = parseInt(env.ZKTRIDENT_PARTITION_COUNT ?? '1', 10);
const partitionIndex = parseInt(env.ZKTRIDENT_PARTITION_INDEX ?? '0', 10);
const seedPeers = env.ZKTRIDENT_SEED_PEERS
  ? env.ZKTRIDENT_SEED_PEERS.split(',').map((s) => s.trim()).filter(Boolean)
  : [];
const adminToken = env.ZKTRIDENT_ADMIN_TOKEN;
const gossipSecret = env.ZKTRIDENT_GOSSIP_SECRET;
const checkpointDir = env.ZKTRIDENT_CHECKPOINT_DIR ?? './l2-data';
const maxCheckpoints = parseInt(env.ZKTRIDENT_MAX_CHECKPOINTS ?? '10', 10);
const l2Only = (env.ZKTRIDENT_L2_ONLY ?? 'true') !== 'false';
const enableSSE = (env.ZKTRIDENT_SSE ?? 'true') !== 'false';
const maxSseConnections = parseInt(env.ZKTRIDENT_MAX_SSE ?? '100', 10);
const allowedOrigins = env.ZKTRIDENT_CORS_ORIGINS
  ? env.ZKTRIDENT_CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
  : ['*'];

// ─── Build Options ────────────────────────────────────────────

const partitionConfig: PartitionConfig | undefined =
  partitionCount > 1
    ? { partitionCount, partitionIndex }
    : undefined;

const nodeOptions: Partial<L2NodeOptions> = {
  batchIntervalMs,
  autoSettle: true,
  settlementDelayMs: 1_000,
  maxBatchRetries: 3,
  role: 'sequencer',
  l2Only,
  seedPeers: seedPeers.length > 0 ? seedPeers : undefined,
  ...(nodeId ? { nodeId } : {}),
  ...(partitionConfig ? { partitionConfig } : {}),
  ...(adminToken ? { adminToken } : {}),
  ...(gossipSecret ? { gossipSecret } : {}),
};

// Resolve dashboard directory (relative to project root)
const thisDir = path.dirname(fileURLToPath(import.meta.url));
const dashboardDir = path.resolve(thisDir, '..', '..', 'dashboard');
const hasDashboard = fs.existsSync(path.join(dashboardDir, 'index.html'));

const rpcOptions: Partial<L2RpcServerOptions> = {
  port,
  host,
  enableSSE,
  maxSseConnections,
  allowedOrigins,
  ...(adminToken ? { adminToken } : {}),
  ...(hasDashboard ? { dashboardDir } : {}),
};

// ─── Main ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('');
  console.log('  ╔══════════════════════════════════════════════╗');
  console.log('  ║     🔱  LEVIATHAN SEQUENCER — zkTrident     ║');
  console.log('  ╚══════════════════════════════════════════════╝');
  console.log('');

  const store = new InMemoryStore();
  const checkpointStore = new L2CheckpointStore(checkpointDir);

  // ── Recovery or Genesis ──

  let node: L2Node;
  const checkpoint = await checkpointStore.loadLatest();

  if (checkpoint) {
    console.log(`  [recovery] Restoring from checkpoint (batch #${checkpoint.lastSettledBatchNumber ?? 'none'})`);
    console.log(`  [recovery] Checkpoint created at ${new Date(checkpoint.createdAt).toISOString()}`);
    node = L2Node.fromCheckpoint(checkpoint, store, nodeOptions);
    console.log('  [recovery] State restored successfully');
  } else {
    console.log('  [genesis] No checkpoint found — starting fresh');
    const emptyTree = new MerkleTree(WALLET_TREE_HEIGHT);
    const emptyRoot = emptyTree.getRoot();
    node = new L2Node(nodeOptions, store, emptyRoot, emptyRoot, Field(0));
    console.log('  [genesis] Empty Merkle trees initialized (height=%d)', WALLET_TREE_HEIGHT);
  }

  // ── Checkpoint Store ──

  node.setCheckpointStore(checkpointStore, {
    autoCheckpoint: true,
    maxCheckpoints,
  });

  // ── Proving Pool (optional — auto-detect worker count from available RAM) ──

  const poolSizeEnv = env.ZKTRIDENT_POOL_SIZE ?? 'auto';
  const recycleAfterJobs = parseInt(env.ZKTRIDENT_POOL_RECYCLE ?? '3', 10);
  const MIN_POOL_WORKERS = 3;
  const MAX_POOL_WORKERS = 6; // cap — more than 6 just burns RAM on compilation
  let poolWorkerCount = 0;

  if (poolSizeEnv === 'auto') {
    // Auto-detect: each worker needs ~800MB for compile + prove.
    // Reserve 400MB for the main process (L2Node + RPC + overhead).
    // In containers, os.totalmem() returns host RAM — read cgroup limit instead.
    let totalMemMB = Math.floor(os.totalmem() / (1024 * 1024));
    try {
      const cgroupLimit = fs.readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim();
      if (cgroupLimit !== 'max') totalMemMB = Math.floor(parseInt(cgroupLimit, 10) / (1024 * 1024));
    } catch { /* not in a cgroup — use os.totalmem() */ }
    const freeMemMB = Math.min(Math.floor(os.freemem() / (1024 * 1024)), totalMemMB);
    const usableMemMB = Math.min(totalMemMB, freeMemMB + 200); // allow some reclaim
    const MAIN_RESERVE_MB = 400;
    const WORKER_MB = 800;
    const feasible = Math.floor((usableMemMB - MAIN_RESERVE_MB) / WORKER_MB);
    poolWorkerCount = Math.min(MAX_POOL_WORKERS, Math.max(MIN_POOL_WORKERS, feasible));
    console.log('  [pool] Memory detection: %dMB total, %dMB free → %d worker(s) (feasible %d, min %d, max %d)',
      totalMemMB, freeMemMB, poolWorkerCount, feasible, MIN_POOL_WORKERS, MAX_POOL_WORKERS);
  } else {
    poolWorkerCount = Math.min(MAX_POOL_WORKERS, Math.max(MIN_POOL_WORKERS, parseInt(poolSizeEnv, 10) || MIN_POOL_WORKERS));
  }

  if (poolWorkerCount > 0) {
    const { ProvingPool } = await import('../l2/l2-proving-pool.js');
    const pool = new ProvingPool(poolWorkerCount, { recycleAfterJobs });

    // Resolve worker script path relative to this module (ESM)
    const workerPath = path.resolve(thisDir, '..', 'l2', 'l2-proving-worker.ts');
    pool.setWorkerScriptPath(workerPath);

    pool.on((event) => {
      if (event.type === 'worker:crashed') {
        console.error('  [pool] Worker %d crashed', event.workerId);
      } else if (event.type === 'worker:recycled') {
        console.log('  [pool] Worker %d recycled (WASM heap reclaimed)', event.workerId);
      }
    });

    console.log('  [pool] Starting %d proving worker(s) (recycle every %d jobs)...', poolWorkerCount, recycleAfterJobs);
    // Don't await — compile in background so RPC server starts immediately
    pool.start().then(() => {
      node.setProvingPool(pool);
      console.log('  [pool] Proving pool ready');
    }).catch((err) => {
      console.error('  [pool] Failed to start proving pool:', err);
    });
  }

  // ── RPC Server (start before pool compilation to pass Render health check) ──
  // Formulary is published by the Insurer node via l2_storeFormulary — not loaded at startup.

  const rpcServer = new L2RpcServer(node, rpcOptions);
  await rpcServer.start();

  // ── Seed Demo Providers ──
  // Register demo prescribers and pharmacies in the entity registry so
  // member apps can see the network providers immediately.
  {
    const { DEMO_PRESCRIBERS } = await import('../demo/prescribers.js');
    const { DEMO_PHARMACIES } = await import('../demo/pharmacies.js');
    const { derivePrescriberWalletId, derivePharmacyWalletId } = await import('../wallets/wallet-derivation.js');

    const entities = [
      ...DEMO_PRESCRIBERS.map((p) => ({
        walletId: derivePrescriberWalletId(p.localData, p.enrollmentKey).toString(),
        displayName: `Dr. ${p.firstName} ${p.lastName}, ${p.credential}`,
        type: 'prescriber' as const,
        specialty: p.specialty,
      })),
      ...DEMO_PHARMACIES.map((p) => ({
        walletId: derivePharmacyWalletId(p.localData, p.enrollmentKey).toString(),
        displayName: p.storeName,
        type: 'pharmacy' as const,
        pharmacyType: p.pharmacyTypeDesc,
      })),
    ];

    rpcServer.seedEntities(entities);
    console.log('  [init] Seeded %d network providers (%d prescribers, %d pharmacies)',
      entities.length, DEMO_PRESCRIBERS.length, DEMO_PHARMACIES.length);

    // Seed demo formulary so member apps can see medications immediately.
    // Published under the "standard-plan" planIdHash that the employer group uses.
    const { DEMO_MEDICATIONS } = await import('../demo/medications.js');
    const { Poseidon } = await import('o1js');
    const { hashString } = await import('../zkp/hash-utils.js');

    const standardPlanIdHash = Poseidon.hash(
      [...'standard-plan'].map((c) => Field(c.charCodeAt(0))),
    ).toString();

    const formularyEntries = DEMO_MEDICATIONS.map((m) => ({
      ndc: m.ndc,
      brandName: m.brandName,
      genericName: m.genericName,
      dosageForm: m.dosageForm,
      strength: m.strength,
      tierLevel: m.formularyEntry.tierLevel,
      therapeuticClass: m.therapeuticClass,
      gpi: m.gpi,
      ndcHash: hashString(m.ndc).toString(),
      pricePerUnit: m.awpUnitPriceCents / 100,
      copayAmountCents: m.formularyEntry.copayAmount,
      requiresPriorAuth: m.formularyEntry.requiresPriorAuth,
      maxDaySupply: m.formularyEntry.maxDaySupply,
      maxQuantityPerFill: m.formularyEntry.maxQuantityPerFill,
    }));

    const formularyRoot = Poseidon.hash([Field(formularyEntries.length)]).toString();
    const entriesJson = JSON.stringify(formularyEntries);
    node.getSequencer().storeFormulary(standardPlanIdHash, formularyRoot, entriesJson);
    // Also store under "default" so apps without a planIdHash can still find it
    node.getSequencer().storeFormulary('default', formularyRoot, entriesJson);
    console.log('  [init] Seeded formulary: %d medications (planIdHash: %s...)',
      formularyEntries.length, standardPlanIdHash.slice(0, 16));
  }

  // ── NFC Attestation Authority ──
  // Enable Ed25519 attestation signing for NFC credential cards.
  // Uses GOSSIP_SECRET as deterministic seed (if available) for stable key across restarts.

  await node.enableAttestations(gossipSecret ?? undefined);
  console.log('  [init] NFC attestation authority enabled (Ed25519)');

  // ── Start Node ──

  node.start();

  // ── Startup Banner ──

  console.log('');
  console.log('  Leviathan Sequencer is running');
  console.log('  ─────────────────────────────────');
  console.log('  Node ID:       %s', nodeId ?? '(auto-generated)');
  console.log('  Role:          sequencer');
  console.log('  RPC:           http://%s:%d/rpc', host, port);
  console.log('  SSE:           %s', enableSSE ? `http://${host}:${port}/events` : 'disabled');
  console.log('  Dashboard:     %s', hasDashboard ? `http://${host}:${port}/` : 'not found');
  console.log('  Batch interval: %ds', batchIntervalMs / 1000);
  console.log('  L2-only:       %s', l2Only);
  console.log('  Proving pool:  %s', poolWorkerCount > 0 ? `${poolWorkerCount} worker(s)` : 'disabled');
  if (partitionConfig) {
    console.log('  Partition:     %d of %d', partitionIndex, partitionCount);
  }
  if (seedPeers.length > 0) {
    console.log('  Seed peers:    %s', seedPeers.join(', '));
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
    // ProvingPool is shut down by node.stop() via provingPool.shutdown()
    console.log('  [shutdown] Leviathan sequencer shut down cleanly');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('  [FATAL] Leviathan startup failed:', err);
  process.exit(1);
});
