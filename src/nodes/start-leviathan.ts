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
import { spawn, type ChildProcess } from 'child_process';
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
const dashboardDir = path.resolve(thisDir, '..', '..', 'dashboard-leviathan');
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

  // Provider credentialing + formulary publishing is handled by the Insurer node.
  // The Leviathan is pure infrastructure — no demo data seeding.

  // ── NFC Attestation Authority ──
  // Enable Ed25519 attestation signing for NFC credential cards.
  // Uses GOSSIP_SECRET as deterministic seed (if available) for stable key across restarts.

  await node.enableAttestations(gossipSecret ?? undefined);
  console.log('  [init] NFC attestation authority enabled (Ed25519)');

  // ── Start Node ──

  node.start();

  // ── Replica Nodes (2 replicators per sequencer) ──

  const replicaNodes: L2Node[] = [];
  const replicaServers: L2RpcServer[] = [];
  const REPLICA_COUNT = 2;
  const sequencerUrl = `http://localhost:${port}`;

  for (let ri = 0; ri < REPLICA_COUNT; ri++) {
    const replicaPort = port + 1 + ri;
    const replicaId = `replica-${ri + 1}`;
    const replicaStore = new InMemoryStore();
    const emptyTree = new MerkleTree(WALLET_TREE_HEIGHT);
    const emptyRoot = emptyTree.getRoot();

    const replicaOpts: Partial<L2NodeOptions> = {
      role: 'replica',
      nodeId: replicaId,
      l2Only,
      seedPeers: [sequencerUrl],
      batchIntervalMs,
      ...(gossipSecret ? { gossipSecret } : {}),
    };

    const replica = new L2Node(replicaOpts, replicaStore, emptyRoot, emptyRoot, Field(0));

    const replicaRpcOpts: Partial<L2RpcServerOptions> = {
      port: replicaPort,
      host,
      enableSSE: false,
      allowedOrigins,
    };
    const replicaRpc = new L2RpcServer(replica, replicaRpcOpts);
    await replicaRpc.start();
    replica.start();

    replicaNodes.push(replica);
    replicaServers.push(replicaRpc);
    console.log('  [replica] %s started on port %d (seed: %s)', replicaId, replicaPort, sequencerUrl);
  }

  // Connect sequencer to replicas so it knows about them
  if (!node.getPeerNetwork()) {
    // Force peer network init on sequencer by adding replica URLs as seed peers
    (node as any).options.seedPeers = replicaNodes.map((_, i) => `http://localhost:${port + 1 + i}`);
    await (node as any).initPeerNetwork();
  } else {
    for (let ri = 0; ri < REPLICA_COUNT; ri++) {
      try {
        await node.getPeerNetwork()!.connectToPeer(`http://localhost:${port + 1 + ri}`);
      } catch { /* replica may still be starting */ }
    }
  }

  // ── Child Processes ──

  let stopping = false;

  // ── Proof Delegate (child process on port 4040) ──

  let proverChild: ChildProcess | null = null;
  const proverPort = parseInt(env.ZKTRIDENT_PROVER_PORT ?? '4040', 10);
  const proverApiKey = env.ZKTRIDENT_PROVER_API_KEY ?? 'dev-key';
  const proverScript = path.resolve(thisDir, 'start-prover.ts');

  if (fs.existsSync(proverScript)) {
    const proverEnv = {
      ...process.env,
      ZKTRIDENT_PROVER_PORT: String(proverPort),
      ZKTRIDENT_PROVER_API_KEY: proverApiKey,
    };
    proverChild = spawn('npx', ['tsx', proverScript], {
      env: proverEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
    });
    proverChild.stdout?.on('data', (d: Buffer) => process.stdout.write(d));
    proverChild.stderr?.on('data', (d: Buffer) => process.stderr.write(d));
    proverChild.on('exit', (code) => {
      if (!stopping) console.error('  [prover] Proof delegate exited unexpectedly (code %d)', code);
      proverChild = null;
    });
    console.log('  [prover] Proof delegate spawned (port %d, api-key: %s)', proverPort, proverApiKey ? 'configured' : 'NONE');
  } else {
    console.log('  [prover] start-prover.ts not found — skipping proof delegate');
  }

  // ── Entity Nodes (child processes) ──
  // Spawn all entity nodes as child processes of the leviathan.
  // Each node connects back to the sequencer on this port.

  interface EntityChild { name: string; child: ChildProcess; port: number; }
  const entityChildren: EntityChild[] = [];

  function spawnEntity(name: string, script: string, entityPort: number, extraEnv: Record<string, string> = {}): void {
    const scriptPath = path.resolve(thisDir, script);
    if (!fs.existsSync(scriptPath)) {
      console.log('  [entity] %s script not found — skipping', name);
      return;
    }
    const childEnv = {
      ...process.env,
      ZKTRIDENT_PORT: String(entityPort),
      ZKTRIDENT_SEQUENCER_URL: `http://localhost:${port}`,
      ...extraEnv,
    };
    const child = spawn('npx', ['tsx', scriptPath], {
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
    });
    child.stdout?.on('data', (d: Buffer) => process.stdout.write(d));
    child.stderr?.on('data', (d: Buffer) => process.stderr.write(d));
    child.on('exit', (code) => {
      if (!stopping) console.error('  [entity] %s exited unexpectedly (code %d)', name, code);
    });
    entityChildren.push({ name, child, port: entityPort });
    console.log('  [entity] %s spawned (port %d)', name, entityPort);
  }

  // ── Health-Gated Boot Sequence ──
  //
  // Phase 1: Insurer (credentials providers + publishes formulary)
  // Phase 2: Wait for insurer health → ready (providers credentialed)
  // Phase 3: Provider nodes + employer + member (can now verify credentialing)
  //
  // This ensures the provider registry is populated before nodes
  // attempt to self-gate on their credentialing status.

  async function waitForHealth(healthUrl: string, maxAttempts: number = 45): Promise<boolean> {
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const resp = await fetch(healthUrl);
        if (resp.ok) {
          const data = await resp.json() as { data?: { phase?: string } };
          if (data?.data?.phase === 'ready') return true;
        }
      } catch { /* not ready yet */ }
      await new Promise((r) => setTimeout(r, 1000));
    }
    return false;
  }

  // Phase 1: Insurer (port 4004) — must start first to credential providers
  console.log('');
  console.log('  ── Boot Phase 1: Insurer (credentialing authority) ──');
  spawnEntity('insurer', 'start-insurer-nautilus.ts', 4004, {
    ZKTRIDENT_ADMIN_TOKEN: adminToken ?? 'admin123',
  });

  // Phase 2: Wait for insurer to become ready (providers credentialed + formulary published)
  console.log('  [boot] Waiting for insurer to credential providers...');
  const insurerReady = await waitForHealth(`http://localhost:4004/health`, 120);
  if (insurerReady) {
    console.log('  [boot] Insurer ready — providers credentialed');
  } else {
    console.log('  [boot] Insurer health timeout — continuing with remaining entities');
  }

  // Phase 3: Provider nodes + employer + member
  console.log('');
  console.log('  ── Boot Phase 2: Provider nodes + employer + member ──');

  // Prescriber (port 4002) — uses demo identity index 0 (Dr. Sarah Chen)
  // Will poll l2_getProvider to confirm credentialing before ready
  spawnEntity('prescriber', 'start-prescriber-nautilus.ts', 4002, {
    ZKTRIDENT_DEMO_PRESCRIBER: '0',
  });

  // Pharmacy (port 4003) — uses demo identity index 0
  // Will poll l2_getProvider to confirm credentialing before ready
  spawnEntity('pharmacy', 'start-pharmacy-nautilus.ts', 4003, {
    ZKTRIDENT_DEMO_PHARMACY: '0',
  });

  // Employer (port 4005) — needs employer ID + insurer URL
  spawnEntity('employer', 'start-employer-nautilus.ts', 4005, {
    ZKTRIDENT_EMPLOYER_ID: env.ZKTRIDENT_EMPLOYER_ID ?? 'ACME-001',
    ZKTRIDENT_ADMIN_TOKEN: adminToken ?? 'admin123',
    ZKTRIDENT_INSURER_URL: `http://localhost:4004`,
  });

  // Member (port 4001) — depends on employer tokens + insurer plan
  // Pass ZKTRIDENT_MEMBER_PIN through so local state can be unlocked for onboarding
  spawnEntity('member', 'start-member-nautilus.ts', 4001, {
    ...(env.ZKTRIDENT_MEMBER_PIN ? { ZKTRIDENT_PIN: env.ZKTRIDENT_MEMBER_PIN } : {}),
  });

  // Explorer (port 8000) — static file server + proxy to sequencer
  {
    const explorerScript = path.resolve(thisDir, 'start-explorer.ts');
    if (fs.existsSync(explorerScript)) {
      const child = spawn('npx', ['tsx', explorerScript], {
        env: { ...process.env, ZKTRIDENT_EXPLORER_PORT: '8000', ZKTRIDENT_SEQUENCER_URL: `http://localhost:${port}` },
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: true,
      });
      child.stdout?.on('data', (d: Buffer) => process.stdout.write(d));
      child.stderr?.on('data', (d: Buffer) => process.stderr.write(d));
      child.on('exit', (code) => {
        if (!stopping) console.error('  [entity] explorer exited unexpectedly (code %d)', code);
      });
      entityChildren.push({ name: 'explorer', child, port: 8000 });
      console.log('  [entity] explorer spawned (port 8000)');
    }
  }

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
  console.log('  Replicas:      %d (ports %d–%d)', REPLICA_COUNT, port + 1, port + REPLICA_COUNT);
  console.log('  Proof delegate: %s', proverChild ? `http://${host}:${proverPort}/prove` : 'disabled');
  if (entityChildren.length > 0) {
    console.log('  Entity nodes:  %s', entityChildren.map(e => `${e.name}(:${e.port})`).join(', '));
  }
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

  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log('');
    console.log('  [%s] Shutting down gracefully...', signal);
    // Stop entity nodes
    for (const e of entityChildren) {
      try { e.child.kill('SIGTERM'); } catch {}
    }
    if (entityChildren.length > 0) {
      console.log('  [shutdown] %d entity node(s) stopped', entityChildren.length);
    }
    // Stop prover delegate
    if (proverChild) {
      proverChild.kill('SIGTERM');
      console.log('  [shutdown] Proof delegate stopped');
    }
    // Stop replicas
    for (let ri = 0; ri < replicaNodes.length; ri++) {
      await replicaNodes[ri].stop();
      await replicaServers[ri].stop();
    }
    console.log('  [shutdown] %d replica(s) stopped', replicaNodes.length);
    await node.stop();
    console.log('  [shutdown] Sequencer stopped (checkpoint saved)');
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
