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
 * start-leviathan.ts — Leviathan Sequencer Entry Point
 *
 * Starts a partitioned sequencer node for the Adjuda-GATOR Network.
 * Accepts proofs for its assigned partition, builds batches on a timer,
 * gossips state to peers, and serves RPC queries.
 *
 * Configuration via environment variables (all optional — sensible defaults):
 *
 *   ZKTRIDENT_PORT             — RPC server port (default: 3030)
 *   ZKTRIDENT_HOST             — RPC bind address (default: 127.0.0.1, loopback only)
 *   ZKTRIDENT_NODE_ID          — Unique node identifier (default: auto-generated)
 *   ZKTRIDENT_BATCH_INTERVAL_MS — Batch timer interval in ms (default: 180000 = 3 min)
 *   ZKTRIDENT_PARTITION_COUNT  — Total partitions in the network (default: 1)
 *   ZKTRIDENT_PARTITION_INDEX  — This sequencer's partition index (default: 0)
 *   ZKTRIDENT_SEED_PEERS       — Comma-separated peer URLs (default: none)
 *   ZKTRIDENT_ADMIN_TOKEN      — Bearer token for admin RPC methods (default: none)
 *   ZKTRIDENT_INSURER_SIGNING_SEED — Insurer's Ed25519 attestation seed. NOT the admin
 *                                token (A-14). Random per boot if unset, which
 *                                invalidates attestations from a previous run.
 *   ZKTRIDENT_GOSSIP_SECRET    — HMAC-SHA256 shared secret for gossip auth (default: none)
 *   ZKTRIDENT_CHECKPOINT_DIR   — Directory for checkpoint files (default: ./l2-data)
 *   ZKTRIDENT_MAX_CHECKPOINTS  — Max checkpoint files to keep (default: 10)
 *   ZKTRIDENT_L2_ONLY          — Skip MINA L1 settlement (default: true)
 *   ZKTRIDENT_SSE              — Enable SSE event streaming (default: true)
 *   ZKTRIDENT_MAX_SSE          — Max concurrent SSE connections (default: 100)
 *   ZKTRIDENT_TLS_CERT         — Path to a PEM certificate. With ZKTRIDENT_TLS_KEY the
 *                                RPC server serves HTTPS instead of HTTP.
 *   ZKTRIDENT_TLS_KEY          — Path to the matching PEM private key.
 *   ZKTRIDENT_CORS_ORIGINS     — Comma-separated allowed CORS origins
 *                                (default: the local dashboard origins)
 *   ZKTRIDENT_POOL_SIZE        — Proving pool workers: number or "auto" (default: "auto", min 3)
 *   ZKTRIDENT_MEMBER_DEVICE_PORTS — Extra member devices to boot, comma-separated ports (default: none)
 *   ZKTRIDENT_MEMBER_DEVICES_DIR  — Their state directories, one per port (default: ./e2e-devices)
 *   ZKTRIDENT_PROVING_LEASE_MS   — How long one prover may hold a partition's witnesses (default: 120000)
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
import { L2SequencerService } from '../l2/l2-sequencer-service.js';
import { L2RpcServer } from '../l2/l2-rpc-server.js';
import type { L2RpcServerOptions } from '../l2/l2-rpc-server.js';
import { L2CheckpointStore } from '../l2/l2-checkpoint.js';
import { InMemoryStore } from '../storage/local-store.js';
import { WALLET_TREE_HEIGHT } from '../wallets/wallet-state.js';
import type { PartitionConfig } from '../l2/l2-partition.js';
import type { VizEvent } from '../l2/l2-rpc-server.js';
import http from 'http';
import { resolveBindHost, resolveAllowedOrigins } from '../security/network-policy.js';
import crypto from 'crypto';
import { insurerPublicKeyFromSeed } from '../onboarding/employer-attestation.js';
import { generateNodeKey, childEnvironment, deriveNodeAdminToken, NODE_ID_ENV, NODE_KEY_SEED_ENV, type NodeRole } from '../security/node-roles.js';
import { InvariantMonitor, snapshotOf } from '../l2/invariant-monitor.js';
import { AdjudicationService } from '../adjudication/interactive-service.js';
import { registerInteractiveRoutes } from '../adjudication/interactive-routes.js';
import { ProofPool } from '../adjudication/proof-pool.js';

// ─── Environment Parsing ──────────────────────────────────────

const env = process.env;

const port = parseInt(env.ZKTRIDENT_PORT ?? '3030', 10);
const host = resolveBindHost(env, 'sequencer');
const nodeId = env.ZKTRIDENT_NODE_ID;
const batchIntervalMs = parseInt(env.ZKTRIDENT_BATCH_INTERVAL_MS ?? '30000', 10);
const partitionCount = parseInt(env.ZKTRIDENT_PARTITION_COUNT ?? '1', 10);
const partitionIndex = parseInt(env.ZKTRIDENT_PARTITION_INDEX ?? '0', 10);
const seedPeers = env.ZKTRIDENT_SEED_PEERS
  ? env.ZKTRIDENT_SEED_PEERS.split(',').map((s) => s.trim()).filter(Boolean)
  : [];
const unsecureMode = env.ZKTRIDENT_UNSECURE === 'true';
const adminToken = unsecureMode ? (env.ZKTRIDENT_ADMIN_TOKEN ?? 'admin123') : env.ZKTRIDENT_ADMIN_TOKEN;
/*
 * The insurer node's own admin token — phase A item A9, finding A-14. The operator's token above
 * is accepted by the sequencer only; the insurer's routes take this one. Explicit when the
 * deployment sets it, otherwise derived from the operator's token in a way the insurer node cannot
 * reverse, so a one-variable deployment keeps working without the insurer holding the network's
 * credential. Member, prescriber and pharmacy nodes have no admin routes and get no token at all.
 */
const insurerAdminToken = env.ZKTRIDENT_INSURER_ADMIN_TOKEN
  ?? (adminToken ? deriveNodeAdminToken(adminToken, 'insurer') : undefined);
const gossipSecret = env.ZKTRIDENT_GOSSIP_SECRET;

/*
 * The insurer's attestation signing seed, and its public half — phase A item A9, findings A-14
 * and A-29.
 *
 * Employer attestations used to be counter-signed with the admin token, which every child node
 * receives at boot and which is `admin123` in unsecure mode. And the sequencer verified the
 * counter-signature against the key carried **inside** the attestation, so anyone could sign one
 * with their own keypair and register an employer.
 *
 * Both halves are now generated here, in one place, because they have to agree: the insurer child
 * gets the seed and the sequencer gets the public key to pin. Generated randomly when not
 * configured, so a default boot is correct rather than convenient — but note that a random seed
 * changes on every restart, which invalidates attestations signed under the previous one. A
 * deployment that keeps employer attestations across restarts must set
 * ZKTRIDENT_INSURER_SIGNING_SEED.
 */
const insurerSigningSeed = env.ZKTRIDENT_INSURER_SIGNING_SEED
  ?? crypto.randomBytes(32).toString('base64url');
const insurerAttestationPublicKeyHex = insurerPublicKeyFromSeed(insurerSigningSeed);
const checkpointDir = env.ZKTRIDENT_CHECKPOINT_DIR ?? './l2-data';
const maxCheckpoints = parseInt(env.ZKTRIDENT_MAX_CHECKPOINTS ?? '10', 10);
const l2Only = (env.ZKTRIDENT_L2_ONLY ?? 'true') !== 'false';
const enableSSE = (env.ZKTRIDENT_SSE ?? 'true') !== 'false';
const maxSseConnections = parseInt(env.ZKTRIDENT_MAX_SSE ?? '100', 10);
// Local dashboard origins by default. A wildcard is only honoured when it is asked
// for explicitly AND the node is in unsecure mode; it is never the default.
const allowedOrigins = resolveAllowedOrigins(env, {
  role: 'sequencer',
  allowWildcard: unsecureMode,
});

const leaderKey = generateNodeKey(nodeId ?? 'sequencer');

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
  // A13: the leader's own key; its replicas register it under the `sequencer` role and it signs the
  // gossip it pushes to them. Fresh on every boot, like every node key the launcher issues.
  nodeKey: leaderKey,
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
  ...(unsecureMode ? { unsecureMode: true } : {}),
  ...(hasDashboard ? { dashboardDir } : {}),
  // A9: the insurer key the sequencer pins when verifying employer registrations.
  insurerAttestationPublicKeyHex,
  // TLS is configuration, not code: set both paths and the server listens HTTPS. Left
  // unset it listens HTTP, which is why the default bind is loopback only.
  ...(env.ZKTRIDENT_TLS_CERT && env.ZKTRIDENT_TLS_KEY
    ? { tlsCert: env.ZKTRIDENT_TLS_CERT, tlsKey: env.ZKTRIDENT_TLS_KEY }
    : {}),
};

// ─── Main ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('');
  console.log('  ╔══════════════════════════════════════════════╗');
  console.log('  ║     🐊  LEVIATHAN SEQUENCER — Adjuda-GATOR  ║');
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
    // D7 (A-33): the proving lease — one prover at a time per partition — lasts this long before it lapses
    L2SequencerService.defaultProvingLeaseMs = parseInt(env.ZKTRIDENT_PROVING_LEASE_MS ?? '', 10) || L2SequencerService.defaultProvingLeaseMs;
    node = new L2Node(nodeOptions, store, emptyRoot, emptyRoot, Field(0));
    console.log('  [genesis] Empty Merkle trees initialized (height=%d)', WALLET_TREE_HEIGHT);
  }

  // ── Checkpoint Store ──

  node.setCheckpointStore(checkpointStore, {
    autoCheckpoint: true,
    maxCheckpoints,
  });

  // ── Proof verification (required: the sequencer refuses submissions without it) ──
  //
  // Verification runs in its own process. It has to: the engine compiles ten ZkPrograms
  // into this process's single o1js context, and after that every o1js call here stalls
  // for good. Measured 2026-10-17 — set up before the engine, the compile succeeds and the
  // first verification never returns; set up after it, the compile never returns and the
  // boot hangs. In a clean process the same verification takes about a second. This is the
  // wall that put batch proving in a worker, met from the other side.
  //
  // The boot then verifies a stored proof, because a worker that compiled is not proof that
  // it can verify: that is exactly the pair of symptoms above. Failing here stops the boot,
  // rather than leaving every member's first submission to discover it.
  {
    const { VerifyPool } = await import('../l2/l2-verify-pool.js');
    const expectedVkHash = env.ZKTRIDENT_TRANSITION_VK_HASH;
    const pool = new VerifyPool({
      size: parseInt(env.ZKTRIDENT_VERIFY_POOL_SIZE ?? '1', 10) || 1,
      expectedVkHash,
    });

    try {
      const { vkHash, compileMs } = await pool.start();
      console.log('  [verify] verifier process ready, program compiled in %d ms', compileMs);
      if (expectedVkHash) {
        console.log('  [verify] verification key matches the pinned hash %s…', vkHash.slice(0, 16));
      } else {
        console.warn(
          '  [verify] no ZKTRIDENT_TRANSITION_VK_HASH pinned. Set it to %s so that a swapped ' +
            'or recompiled program is refused at boot.',
          vkHash,
        );
      }

      const verifier = pool.asVerifier();

      // Self-test against a stored proof. Its roots need not match current state; what is
      // being checked is that this deployment can verify at all.
      const fixturePath = path.resolve(thisDir, '..', '..', 'scripts', 'e2e-verify', 'fixtures', 'state-transition-proof.json');
      if (fs.existsSync(fixturePath)) {
        const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
        const t0 = Date.now();
        await verifier({ toJSON: () => fixture } as never);
        console.log('  [verify] self-test passed: a stored proof verified in %d ms', Date.now() - t0);
      } else {
        console.warn('  [verify] no self-test fixture at %s — verification is unproven until the first submission', fixturePath);
      }

      node.getSequencer().setTransitionVerifier(verifier);
      console.log('  [verify] submitted proofs are verified before any state is written');

      const stopVerifier = async (): Promise<void> => { await pool.shutdown(); };
      process.once('SIGINT', () => void stopVerifier());
      process.once('SIGTERM', () => void stopVerifier());
    } catch (err) {
      console.error('  [verify] cannot establish proof verification:', err instanceof Error ? err.message : err);
      console.error('  [verify] refusing to start. A sequencer that cannot verify proofs must not accept them.');
      await pool.shutdown();
      throw err;
    }
  }

  // ── Proving Pool (optional — auto-detect worker count from available RAM) ──

  const poolSizeEnv = env.ZKTRIDENT_POOL_SIZE ?? 'auto';
  const recycleAfterJobs = parseInt(env.ZKTRIDENT_POOL_RECYCLE ?? '3', 10);
  const MIN_POOL_WORKERS = 1;
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
  } else if (poolSizeEnv === '0') {
    poolWorkerCount = 0; // explicitly disabled
  } else {
    poolWorkerCount = Math.min(MAX_POOL_WORKERS, Math.max(1, parseInt(poolSizeEnv, 10) || 0));
  }

  // ── Load Canonical Formulary (Option C) ──
  // Load all 32K NADAC drugs into FormularyService for paginated queries.
  // Plan overlays are published later by the Insurer node.
  // Runs before the proving pool starts: this load blocks the main thread for minutes,
  // and the pool's compile timeout would otherwise expire while worker 'ready'
  // messages wait to be processed.
  try {
    const { formularyRaw } = await import('../data/formulary-loader.js');
    const { readFormularyTreeCache, writeFormularyTreeCache } =
      await import('../l2/formulary-tree-cache.js');
    const formulary = node.getSequencer().getFormularyService();

    // The tree is identical for identical input, so it is built once and reused. On the full
    // 32,768-drug set that is the difference between minutes and seconds, and it is the longest
    // single step in this boot. A cache that does not describe this exact data is refused and
    // the tree is rebuilt; see FormularyTreeCache for the checks.
    const startedAt = Date.now();
    formulary.loadFromNadac(formularyRaw, readFormularyTreeCache(checkpointDir));
    const loadMs = Date.now() - startedAt;

    if (formulary.treeCameFromCache) {
      console.log('  [formulary] Loaded %d NADAC drugs in %d ms (tree restored from cache)',
        formulary.drugCount, loadMs);
    } else {
      console.log('  [formulary] Loaded %d NADAC drugs in %d ms (tree built)',
        formulary.drugCount, loadMs);
      const cache = formulary.exportTreeCache();
      if (cache && writeFormularyTreeCache(checkpointDir, cache)) {
        console.log('  [formulary] Tree cached for the next boot (root %s…)',
          cache.root.slice(0, 12));
      }
    }
  } catch (err) {
    console.error('  [formulary] Failed to load NADAC formulary:', err);
  }

  if (poolWorkerCount > 0) {
    const compileConcurrency = Math.max(1, Math.min(poolWorkerCount, Math.floor(os.cpus().length / 4)));
    const { ProvingPool } = await import('../l2/l2-proving-pool.js');
    const pool = new ProvingPool(poolWorkerCount, { recycleAfterJobs, compileConcurrency });

    // Resolve worker script path relative to this module (ESM)
    const workerPath = path.resolve(thisDir, '..', 'l2', 'l2-proving-worker.ts');
    pool.setWorkerScriptPath(workerPath);

    pool.on((event) => {
      switch (event.type) {
        case 'worker:spawned':
          console.log('  [pool] Worker %d spawned', event.workerId);
          break;
        case 'worker:compiling':
          console.log('  [pool] Worker %d compiling...', event.workerId);
          break;
        case 'worker:ready':
          console.log('  [pool] Worker %d ready (compile %dms)', event.workerId, event.data.compileTimeMs);
          break;
        case 'worker:compile_timeout':
          console.error('  [pool] Worker %d compilation TIMEOUT (%dms)', event.workerId, event.data.timeoutMs);
          break;
        case 'worker:compile_failed':
          console.error('  [pool] Worker %d compilation FAILED: %s', event.workerId, event.data.error);
          break;
        case 'worker:dispatched':
          console.log('  [pool] Worker %d dispatched %s', event.workerId, event.data.jobId);
          break;
        case 'worker:completed':
          console.log('  [pool] Worker %d completed %s (%dms)', event.workerId, event.data.jobId, event.data.proveTimeMs);
          break;
        case 'worker:crashed':
          console.error('  [pool] Worker %d CRASHED (code=%s, signal=%s, restarts=%d)',
            event.workerId, event.data.code, event.data.signal, event.data.restartCount);
          break;
        case 'worker:recycled':
          console.log('  [pool] Worker %d recycled after %d jobs (WASM heap reclaimed)', event.workerId, event.data.jobsProcessed);
          break;
      }
    });

    // Pipe worker stderr so o1js compilation/runtime errors are visible
    pool.onStderr((workerId, data) => {
      console.error('  [pool:stderr] Worker %d: %s', workerId, data);
    });

    console.log('  [pool] Starting %d proving worker(s) (compile %d at a time, recycle every %d jobs)...', poolWorkerCount, compileConcurrency, recycleAfterJobs);
    // Don't await — compile in background so RPC server starts immediately
    pool.start().then(() => {
      node.setProvingPool(pool);
      console.log('  [pool] Proving pool ready');
    }).catch((err) => {
      console.error('  [pool] Failed to start proving pool:', err);
    });
  }

  // ── RPC Server (start before pool compilation to pass Render health check) ──

  const rpcServer = new L2RpcServer(node, rpcOptions);
  await rpcServer.start();

  // Wire admin registry into checkpoint persistence
  node.setAdminRegistryProvider(() => rpcServer.getAdminRegistryState());
  if (node._checkpointAdminRegistryState) {
    rpcServer.restoreAdminRegistryState(node._checkpointAdminRegistryState);
    node._checkpointAdminRegistryState = null;
    console.log('  [security] Admin registry restored from checkpoint (%d keys)', rpcServer.getAdminKeyRegistry().size);
  }

  // Provider credentialing + formulary publishing is handled by the Insurer node.
  // The Leviathan is pure infrastructure — no seed data injection.

  // ── NFC Attestation Authority ──
  // Enable Ed25519 attestation signing for NFC credential cards.
  // Uses GOSSIP_SECRET as deterministic seed (if available) for stable key across restarts.

  await node.enableAttestations(gossipSecret ?? undefined);
  console.log('  [init] NFC attestation authority enabled (Ed25519)');

  // ── Adjudication Service (Full ZK Proof Generation) ──
  // Provides AccumulatorFulfillmentProgram proof generation for pharmacy PAID flow.
  // Compiles 10 ZkPrograms in background (~3-5 min); proofs available once compiled.
  // The engine is part of the boot: if it cannot load, the sequencer does not start.

  let interactiveReady = false;
  let saveAdjudicationState: (() => void) | null = null;

  // Console emitter → stdout
  const consoleEmitter = (event: { type: string; message: string; timestamp: number; elapsedMs?: number }) => {
    const ts = new Date(event.timestamp).toLocaleTimeString();
    const elapsed = event.elapsedMs ? ` (${(event.elapsedMs / 1000).toFixed(2)}s)` : '';
    console.log(`  [interactive] [${event.type}] ${event.message}${elapsed}`);
  };

  // Viz emitter → loopback POST to /viz/emit
  const vizEmitter = (event: VizEvent): void => {
    const body = JSON.stringify(event);
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/viz/emit',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    });
    req.on('error', () => {});
    req.write(body);
    req.end();
  };

  const interactiveService = new AdjudicationService(consoleEmitter, vizEmitter, node);
  registerInteractiveRoutes(rpcServer, interactiveService);
  console.log('  [interactive] Routes registered on RPC server');

  // ── Adjudication State Persistence ──
  // Save/restore prescription workflow state alongside L2 checkpoints.
  // Uses a separate file in the same checkpoint directory.
  const adjCheckpointPath = path.join(checkpointDir, 'adjudication-state.json');

  // Restore adjudication state if exists
  try {
    if (fs.existsSync(adjCheckpointPath)) {
      const adjData = JSON.parse(fs.readFileSync(adjCheckpointPath, 'utf-8'));
      interactiveService.restoreState(adjData);
      console.log('  [interactive] Adjudication state restored (%d prescriptions, %d members)',
        adjData.prescriptions?.length ?? 0, adjData.enrolledMembers?.length ?? 0);
    }
  } catch (err) {
    console.warn('  [interactive] Failed to restore adjudication state:', err instanceof Error ? err.message : err);
  }

  // Auto-save adjudication state after each batch settlement + on shutdown
  saveAdjudicationState = () => {
    try {
      // Ensure checkpoint directory exists (clean:state deletes it)
      const dir = path.dirname(adjCheckpointPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      const state = interactiveService.exportState();
      const tmpPath = adjCheckpointPath + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(state));
      fs.renameSync(tmpPath, adjCheckpointPath);
    } catch (err) {
      console.warn('  [interactive] Failed to save adjudication state:', err instanceof Error ? err.message : err);
    }
  };

  // Piggyback on L2 node events — save after each batch settlement
  node.on((event) => {
    if (event.type === 'batch:settled' || event.type === 'batch:built') {
      saveAdjudicationState?.();
    }
  });

  // Also save periodically (every 60s) to capture mark-filled and other non-batch state changes
  setInterval(() => saveAdjudicationState?.(), 60_000);

  // Proof pool — offloads ZK proving to child processes, keeps main event loop free
  const proofPoolSize = parseInt(env.ZKTRIDENT_PROOF_POOL_SIZE ?? '4', 10);
  if (proofPoolSize > 0) {
    const proofPool = new ProofPool(proofPoolSize, { recycleAfterJobs: 50 });
    const workerPath = path.resolve(thisDir, '..', 'adjudication', 'proof-pool-worker.ts');
    proofPool.setWorkerScriptPath(workerPath);
    console.log('  [proof-pool] Starting %d proof worker(s)...', proofPoolSize);
    proofPool.on((event: { type: string; workerId: number; data?: Record<string, unknown> }) => {
      switch (event.type) {
        case 'worker:dispatched':
          console.log('  [proof-pool] Worker %d dispatched %s', event.workerId, event.data?.description || event.data?.jobId);
          break;
        case 'worker:completed':
          console.log('  [proof-pool] Worker %d completed %s (%dms)', event.workerId, event.data?.jobId, event.data?.proveTimeMs);
          break;
        case 'worker:crashed':
          console.error('  [proof-pool] Worker %d CRASHED (code %s)', event.workerId, event.data?.code);
          break;
        case 'worker:recycled':
          console.log('  [proof-pool] Worker %d recycled after %d jobs', event.workerId, event.data?.jobsProcessed);
          break;
      }
    });
    proofPool.start().then(() => {
      interactiveService.setProofPool(proofPool);
      rpcServer.setEntityProofPoolStatus(() => ({
        status: { ...proofPool.getStatus() },
        workers: proofPool.getWorkerStatuses(),
      }));
      console.log('  [proof-pool] Proof pool ready — proving offloaded to child processes');
    }).catch((err: unknown) => {
      console.error('  [proof-pool] Failed to start proof pool:', err);
      console.log('  [proof-pool] Falling back to inline proving (will block event loop)');
    });
  }

  // Compile in background (non-blocking — same pattern as proving pool)
  interactiveService.compileAllPrograms().then(async () => {
    interactiveReady = true;
    console.log('  [interactive] ZkPrograms compiled — full proof generation available');

    // Set VK commitment on the RPC server AND peer network for software identity verification
    if (interactiveService.vkCommitment) {
      rpcServer.setVkCommitment(interactiveService.vkCommitment);
      const peerNet = node.getPeerNetwork?.();
      if (peerNet) peerNet.setVkCommitment(interactiveService.vkCommitment);
      console.log('  [security] VK commitment set: %s…', interactiveService.vkCommitment.slice(0, 24));
    }

    // Open all boot-time dashboards in browser when ready.
    // Employer node + HR Tool are spawned on-demand by marketplace activation
    // and are NOT included here — they open via the marketplace activate screen.
    if (env.ZKTRIDENT_OPEN_BROWSERS !== '0') {
      const urls = [
        `http://localhost:${port}/`,      // Leviathan sequencer
        `http://localhost:4001/`,          // Member
        `http://localhost:4002/`,          // Prescriber
        `http://localhost:4003/`,          // Pharmacy
        `http://localhost:4004/`,          // Insurer (includes marketplace at /marketplace/)
        `http://localhost:8000/`,          // Explorer
      ];
      const { exec } = await import('child_process');
      const openCmd = process.platform === 'win32' ? 'start ""' : process.platform === 'darwin' ? 'open' : 'xdg-open';
      for (const url of urls) {
        exec(`${openCmd} ${url}`, { windowsHide: true });
      }
      console.log('  [browser] Opened %d dashboards', urls.length);
    }
  }).catch((err: unknown) => {
    console.error('  [interactive] ZkProgram compilation failed:', err);
  });

  // ── Start Node ──

  node.start();

  // ── Replica Nodes (2 replicators per sequencer) ──

  const replicaNodes: L2Node[] = [];
  const replicaServers: L2RpcServer[] = [];
  // A13: one key per replica, registered on the leader under the `replica` role; each replica's own
  // server registers the leader under `sequencer` and its sibling replicas under `replica`, so gossip
  // travels node-to-node on signatures and the operator's token opens nothing on a replica.
  const replicaKeys = Array.from({ length: 2 }, (_, i) => generateNodeKey(`replica-${i + 1}`));
  const REPLICA_COUNT = replicaKeys.length;
  const sequencerUrl = `http://localhost:${port}`;
  for (const key of replicaKeys) {
    rpcServer.registerNodeKey(key.nodeId, key.publicKeyHex, 'replica', 'in-process replica of this leader');
  }

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
      nodeKey: replicaKeys[ri],
    };

    const replica = new L2Node(replicaOpts, replicaStore, emptyRoot, emptyRoot, Field(0));

    const replicaRpcOpts: Partial<L2RpcServerOptions> = {
      port: replicaPort,
      host,
      enableSSE: false,
      allowedOrigins,
      ...(env.ZKTRIDENT_TLS_CERT && env.ZKTRIDENT_TLS_KEY
        ? { tlsCert: env.ZKTRIDENT_TLS_CERT, tlsKey: env.ZKTRIDENT_TLS_KEY }
        : {}),
    };
    const replicaRpc = new L2RpcServer(replica, replicaRpcOpts);
    replicaRpc.registerNodeKey(leaderKey.nodeId, leaderKey.publicKeyHex, 'sequencer', 'the leader this replica follows');
    for (const key of replicaKeys) {
      if (key.nodeId !== replicaId) replicaRpc.registerNodeKey(key.nodeId, key.publicKeyHex, 'replica', 'sibling replica');
    }
    await replicaRpc.start();
    replica.start();

    replicaNodes.push(replica);
    replicaServers.push(replicaRpc);
    console.log('  [replica] %s started on port %d (seed: %s)', replicaId, replicaPort, sequencerUrl);
  }

  // Wait for replicas to initialize their peer networks before connecting
  await new Promise(resolve => setTimeout(resolve, 1000));

  // A13: a server relays gossip through its node's peer network; until now no server here was ever
  // given one, so l2_gossipRelay could only answer "Peer network not configured" once past the gate.
  for (let ri = 0; ri < REPLICA_COUNT; ri++) {
    const peerNet = replicaNodes[ri].getPeerNetwork();
    if (peerNet) replicaServers[ri].setPeerNetwork(peerNet);
    else console.warn('  [replica] %s has no peer network yet; gossip to it will be refused', `replica-${ri + 1}`);
  }

  // Connect the leader to its replicas (A13: through the node's own call, with the replicas as seeds)
  const leaderPeerNet = await node.ensurePeerNetwork(replicaNodes.map((_, i) => `http://localhost:${port + 1 + i}`));
  for (let ri = 0; ri < REPLICA_COUNT; ri++) {
    try {
      await leaderPeerNet.connectToPeer(`http://localhost:${port + 1 + ri}`);
    } catch { /* replica may still be starting; the announce loop reconnects */ }
  }
  rpcServer.setPeerNetwork(leaderPeerNet);

  // A13: the invariant monitor. Every replica's roots must equal the leader's once gossip has had
  // its grace period, and a leader with proofs pending must build a batch within three intervals;
  // a breach is logged once and carried on l2_getStatus as `invariants`.
  const invariantMonitor = new InvariantMonitor({
    leader: () => snapshotOf(node.getStatus(), leaderKey.nodeId),
    replicas: () => replicaNodes.map((r, i) => snapshotOf(r.getStatus(), replicaKeys[i].nodeId)),
    divergenceGraceMs: 30_000,
    batchStallMs: Math.max(60_000, batchIntervalMs * 3),
    log: (line) => console.log('  ' + line),
  });
  invariantMonitor.start(5_000);
  rpcServer.setInvariantMonitor(invariantMonitor);

  // ── Child Processes ──

  let stopping = false;

  // ── Proof Delegate (child process on port 4040) ──

  let proverChild: ChildProcess | null = null;
  const proverPort = parseInt(env.ZKTRIDENT_PROVER_PORT ?? '4040', 10);
  const proverApiKey = env.ZKTRIDENT_PROVER_API_KEY ?? 'dev-key';
  const proverScript = path.resolve(thisDir, 'start-prover.ts');

  if (fs.existsSync(proverScript)) {
    // A9: the prover gets its own API key and nothing else of this process's secrets.
    const proverEnv = childEnvironment(process.env, {
      ZKTRIDENT_PROVER_PORT: String(proverPort),
      ZKTRIDENT_PROVER_API_KEY: proverApiKey,
      ZKTRIDENT_PARENT_PID: String(process.pid),
    });
    proverChild = spawn(process.execPath, ['--import', 'tsx', proverScript], {
      env: proverEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
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

  /*
   * Spawn one node — phase A item A9, finding A-14. Each child gets an Ed25519 key of its own,
   * generated here and never written to disk; its public half is registered on this process's RPC
   * server with the child's role before the child exists, so the first request it signs is already
   * authorised by role and nothing else. The environment it inherits carries none of this
   * process's secrets; what a child needs is passed by name in `extraEnv`. No shell, no npx: the
   * script runs under this same Node with tsx, and the child watches this PID (A7).
   */
  function spawnEntity(name: string, script: string, entityPort: number, extraEnv: Record<string, string> = {}, role: NodeRole = name as NodeRole): void {
    const scriptPath = path.resolve(thisDir, script);
    if (!fs.existsSync(scriptPath)) {
      console.log('  [entity] %s script not found — skipping', name);
      return;
    }
    const nodeKey = generateNodeKey(name);
    rpcServer.registerNodeKey(nodeKey.nodeId, nodeKey.publicKeyHex, role, `spawned by the launcher as ${role}`);
    const childEnv = childEnvironment(process.env, {
      ZKTRIDENT_PORT: String(entityPort),
      ZKTRIDENT_SEQUENCER_URL: `http://localhost:${port}`,
      ZKTRIDENT_PARENT_PID: String(process.pid),
      [NODE_ID_ENV]: nodeKey.nodeId,
      [NODE_KEY_SEED_ENV]: nodeKey.seedHex,
      ...extraEnv,
    });
    const child = spawn(process.execPath, ['--import', 'tsx', scriptPath], {
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
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
    // A9: the insurer's own admin token for its own routes; the operator's token never leaves this process.
    ...(insurerAdminToken ? { ZKTRIDENT_ADMIN_TOKEN: insurerAdminToken } : {}),
    // A9: the insurer's own signing seed, which only the insurer gets. Its public half is pinned
    // on the sequencer above, so the two cannot drift.
    ZKTRIDENT_INSURER_SIGNING_SEED: insurerSigningSeed,
    ...(unsecureMode ? { ZKTRIDENT_UNSECURE: 'true' } : {}),
  });

  // Phase 2: Wait for insurer to become ready (providers credentialed + formulary published)
  console.log('  [boot] Waiting for insurer to credential providers...');
  const insurerReady = await waitForHealth(`http://localhost:4004/health`, 120);
  if (insurerReady) {
    console.log('  [boot] Insurer ready — providers credentialed');
  } else {
    console.log('  [boot] Insurer health timeout — continuing with remaining entities');
  }

  // Phase 2: Provider nodes + member (employer + HR Tool are on-demand)
  console.log('');
  console.log('  ── Boot Phase 2: Provider nodes + member ──');

  // Prescriber (port 4002) — uses seed identity index 0 (row 0 of src/data/prescribers.json)
  // Will poll l2_getProvider to confirm credentialing before ready
  spawnEntity('prescriber', 'start-prescriber-nautilus.ts', 4002, {
    ZKTRIDENT_SEED_PRESCRIBER: '0',
  });

  // Pharmacy (port 4003) — uses seed identity index 0
  // Will poll l2_getProvider to confirm credentialing before ready
  spawnEntity('pharmacy', 'start-pharmacy-nautilus.ts', 4003, {
    ZKTRIDENT_SEED_PHARMACY: '0',
  });

  // NOTE: Employer nodes and HR Tools are NOT spawned at boot time.
  // They are spawned on-demand by the marketplace activation handler
  // once an employer has completed the marketplace ceremony and received
  // a signed EmployerAttestation from the sequencer. This ensures that
  // every running employer node has a real, cryptographically-pinned
  // identity — no hardcoded ACME-001 fallback.
  //
  // See: src/nodes/employer-orchestrator.ts (Phase C)
  //      src/nodes/routes/marketplace-routes.ts activate handler

  // Member (port 4001) — member onboarding portal, shared by all employees
  // regardless of employer. The member's group binding comes from their
  // enrollment token, not from environment variables.
  spawnEntity('member', 'start-member-nautilus.ts', 4001, {
    ...(env.ZKTRIDENT_MEMBER_PIN ? { ZKTRIDENT_PIN: env.ZKTRIDENT_MEMBER_PIN } : {}),
    ZKTRIDENT_INSURER_URL: `http://localhost:4004`,
  });

  // Additional member devices, one keyed node each with its own encrypted state directory, for a
  // network with more than one member on this machine (the multi-member harness expects 4011-4013).
  // ZKTRIDENT_MEMBER_DEVICE_PORTS=4011,4012,4013  ZKTRIDENT_MEMBER_DEVICES_DIR=./e2e-devices
  {
    const devicePorts = (env.ZKTRIDENT_MEMBER_DEVICE_PORTS ?? '').split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isInteger(n) && n > 0);
    const devicesDir = path.resolve(env.ZKTRIDENT_MEMBER_DEVICES_DIR ?? './e2e-devices');
    for (const devicePort of devicePorts) {
      spawnEntity(`member-${devicePort}`, 'start-member-nautilus.ts', devicePort, {
        ...(env.ZKTRIDENT_MEMBER_PIN ? { ZKTRIDENT_PIN: env.ZKTRIDENT_MEMBER_PIN } : {}),
        ZKTRIDENT_INSURER_URL: `http://localhost:4004`,
        ZKTRIDENT_STATE_DIR: path.join(devicesDir, `member-${devicePort}`),
      }, 'member');
    }
  }

  console.log('  [boot] Employer nodes + HR Tools: on-demand via marketplace activation (no boot-time spawn)');

  // Explorer (port 8000) — static file server + proxy to sequencer
  {
    const explorerScript = path.resolve(thisDir, 'start-explorer.ts');
    if (fs.existsSync(explorerScript)) {
      const child = spawn(process.execPath, ['--import', 'tsx', explorerScript], {
        // A9: the explorer serves pages and proxies read methods; it gets no secret and no key.
        env: childEnvironment(process.env, { ZKTRIDENT_EXPLORER_PORT: '8000', ZKTRIDENT_SEQUENCER_URL: `http://localhost:${port}`, ZKTRIDENT_PARENT_PID: String(process.pid) }),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
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

  // NOTE: HR Tool is NOT spawned at boot. Like the employer node, it is
  // spawned on-demand by the marketplace activation handler, bound 1:1
  // to its employer node via EMPLOYER_NODE_URL and pinned to a specific
  // employerId + public key.

  // Auto-enrollment removed — members enroll manually via dashboard onboarding flow.

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
  console.log('  Interactive:   %s', interactiveReady ? 'ready' : 'compiling (proof generation pending)');
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
  console.log('  Security:      %s', unsecureMode ? 'UNSECURE MODE (admin123 shared token)' : 'Ed25519 per-node identity');
  console.log('  Admin token:   %s', adminToken ? 'configured' : 'NONE (admin RPC disabled)');
  console.log('  Insurer token: %s', env.ZKTRIDENT_INSURER_ADMIN_TOKEN ? 'configured (ZKTRIDENT_INSURER_ADMIN_TOKEN)' : insurerAdminToken ? 'derived from the operator token' : 'NONE');
  console.log('  Node keys:     one per child, registered by role; no child holds the operator token');
  console.log('  Gossip secret: %s', gossipSecret ? 'configured' : 'NONE (unauthenticated gossip)');
  console.log('  Replicas:      %d, each with its own key (A13); invariant monitor every 5 s, divergence grace 30 s', REPLICA_COUNT);
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
    invariantMonitor.stop();
    // Stop replicas
    for (let ri = 0; ri < replicaNodes.length; ri++) {
      await replicaNodes[ri].stop();
      await replicaServers[ri].stop();
    }
    console.log('  [shutdown] %d replica(s) stopped', replicaNodes.length);
    await node.stop();
    console.log('  [shutdown] Sequencer stopped (checkpoint saved)');
    // Save adjudication state on shutdown
    if (saveAdjudicationState) {
      saveAdjudicationState();
      console.log('  [shutdown] Adjudication state saved');
    }
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
