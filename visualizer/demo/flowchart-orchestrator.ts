/**
 * Flowchart Orchestrator — Boots L2Node + InteractiveDemoService + Dashboard.
 *
 * This is the main entry point for the interactive animated flowchart dashboard.
 * It reuses the existing InteractiveDemoService for real ZK proof orchestration
 * and adds a dashboard HTTP server with SVG flowchart visualization.
 *
 * Architecture:
 *   - L2Node + L2RpcServer on port 3030 (proof engine)
 *   - InteractiveDemoService (real ZK proofs, all /interactive/* routes)
 *   - FlowchartDashboardServer on port 8080 (static files + API proxy)
 *   - /flowchart/* routes for dashboard-specific state and controls
 *
 * Usage: npx tsx visualizer/demo/flowchart-orchestrator.ts
 */
import { Field, MerkleTree } from 'o1js';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { InMemoryStore } from '../../src/storage/local-store.js';
import { L2Node } from '../../src/l2/l2-node.js';
import { L2RpcServer } from '../../src/l2/l2-rpc-server.js';
import { L2CheckpointStore } from '../../src/l2/l2-checkpoint.js';
import type { VizEvent } from '../../src/l2/l2-rpc-server.js';
import { InteractiveDemoService, type ConsoleEvent } from './interactive-service.js';
import { registerInteractiveRoutes, getConsoleEmitter } from './interactive-routes.js';
import { AutoModeController } from './auto-mode-controller.js';
import { FlowchartDashboardServer } from '../../src/poc/flowchart-dashboard-server.js';
import { ProvingPool } from '../../src/l2/l2-proving-pool.js';

const REGISTRY_TREE_HEIGHT = 11;
const BACKEND_PORT = parseInt(process.env.BACKEND_PORT || '3030', 10);
const DASHBOARD_PORT = parseInt(process.env.DASHBOARD_PORT || '8080', 10);
const BATCH_INTERVAL = parseInt(process.env.BATCH_INTERVAL || '90000', 10);
const POOL_SIZE = parseInt(process.env.POOL_SIZE || '3', 10);
const POOL_COMPILE_TIMEOUT = parseInt(process.env.POOL_COMPILE_TIMEOUT || '900000', 10); // 15 min default

// ─── Smoke Test State ──────────────────────────────────

interface SmokeTestStep {
  id: string;
  description: string;
  status: 'pending' | 'running' | 'complete' | 'error';
  elapsedMs?: number;
  error?: string;
}

interface SmokeTestState {
  status: 'idle' | 'running' | 'complete' | 'error';
  currentStep: number;
  steps: SmokeTestStep[];
  startedAt?: number;
  completedAt?: number;
  error?: string;
}

let smokeTestState: SmokeTestState = { status: 'idle', currentStep: 0, steps: [] };
let compilationState = {
  status: 'pending' as 'pending' | 'compiling' | 'complete' | 'error',
  programs: [] as Array<{ name: string; status: 'pending' | 'compiling' | 'complete'; elapsedMs?: number }>,
  startedAt: 0,
};

// Module-level so registerFlowchartRoutes() can access it (initialized in main())
let autoModeController: AutoModeController;
let provingPool: ProvingPool | null = null;

// ─── Leviathan Visual State ───────────────────────────

interface LeviathanVisual {
  id: string;
  name: string;
  status: 'running' | 'stopped';
  isPrimary: boolean;
  role: 'sequencer' | 'replica';
  primaryPartition: number;
  activePartitions: number[];
  lastHeartbeat: number;
}

const PARTITION_COUNT = 3;

const leviathanVisuals: LeviathanVisual[] = [
  { id: 'lev-alpha', name: 'Leviathan Alpha', status: 'running', isPrimary: true, role: 'sequencer', primaryPartition: 0, activePartitions: [0], lastHeartbeat: Date.now() },
  { id: 'lev-beta', name: 'Leviathan Beta', status: 'running', isPrimary: false, role: 'replica', primaryPartition: 1, activePartitions: [1], lastHeartbeat: Date.now() },
  { id: 'lev-gamma', name: 'Leviathan Gamma', status: 'running', isPrimary: false, role: 'replica', primaryPartition: 2, activePartitions: [2], lastHeartbeat: Date.now() },
];

// Leader map: partition index → leviathan id
const leaderMap: Record<number, string> = { 0: 'lev-alpha', 1: 'lev-beta', 2: 'lev-gamma' };

// Failover chain: partition → ordered priority list of leviathan ids
const failoverChain: Record<number, string[]> = {
  0: ['lev-alpha', 'lev-beta', 'lev-gamma'],
  1: ['lev-beta', 'lev-gamma', 'lev-alpha'],
  2: ['lev-gamma', 'lev-alpha', 'lev-beta'],
};

/** Reassign partitions after a leviathan stops. */
function handleLeviathanStop(stoppedId: string, vizEmitter: (event: VizEvent) => void): void {
  const stopped = leviathanVisuals.find(l => l.id === stoppedId);
  if (!stopped) return;
  stopped.status = 'stopped';
  stopped.lastHeartbeat = 0;

  // Reassign each partition this node was leading
  const partitionsToReassign = [...stopped.activePartitions];
  stopped.activePartitions = [];

  for (const partition of partitionsToReassign) {
    const chain = failoverChain[partition];
    const newLeader = chain.find(id => {
      const lev = leviathanVisuals.find(l => l.id === id);
      return lev && lev.status === 'running' && lev.id !== stoppedId;
    });
    if (newLeader) {
      leaderMap[partition] = newLeader;
      const newLev = leviathanVisuals.find(l => l.id === newLeader)!;
      if (!newLev.activePartitions.includes(partition)) {
        newLev.activePartitions.push(partition);
      }
      // Emit failover event
      vizEmitter({
        type: 'viz:leviathan:failover',
        timestamp: Date.now(),
        id: `viz-failover-${Date.now()}`,
        actor: stoppedId,
        actorType: 'leviathan',
        target: newLeader,
        targetType: 'leviathan',
        data: { partitionIndex: partition, reason: 'timeout', oldLeader: stoppedId, newLeader },
        lane: 'leviathan',
        stage: 1,
        totalStages: 1,
      });
    }
  }
}

/** Reclaim partitions when a leviathan starts back up. */
function handleLeviathanStart(startedId: string, vizEmitter: (event: VizEvent) => void): void {
  const started = leviathanVisuals.find(l => l.id === startedId);
  if (!started) return;
  started.status = 'running';
  started.lastHeartbeat = Date.now();

  // Reclaim home partition if currently led by a backup
  const homePartition = started.primaryPartition;
  const currentLeader = leaderMap[homePartition];
  if (currentLeader !== startedId) {
    // Remove partition from current leader's active list
    const oldLev = leviathanVisuals.find(l => l.id === currentLeader);
    if (oldLev) {
      oldLev.activePartitions = oldLev.activePartitions.filter(p => p !== homePartition);
    }
    leaderMap[homePartition] = startedId;
    started.activePartitions = [homePartition];

    vizEmitter({
      type: 'viz:leviathan:failover',
      timestamp: Date.now(),
      id: `viz-recovery-${Date.now()}`,
      actor: currentLeader,
      actorType: 'leviathan',
      target: startedId,
      targetType: 'leviathan',
      data: { partitionIndex: homePartition, reason: 'recovery', oldLeader: currentLeader, newLeader: startedId },
      lane: 'leviathan',
      stage: 1,
      totalStages: 1,
    });
  } else {
    started.activePartitions = [homePartition];
  }
}

/** Start heartbeat timer — emits viz:leviathan:heartbeat every 5s for running nodes. */
function startHeartbeatTimer(vizEmitter: (event: VizEvent) => void): NodeJS.Timeout {
  return setInterval(() => {
    for (const lev of leviathanVisuals) {
      if (lev.status !== 'running') continue;
      lev.lastHeartbeat = Date.now();

      vizEmitter({
        type: 'viz:leviathan:heartbeat',
        timestamp: Date.now(),
        id: `viz-hb-${lev.id}-${Date.now()}`,
        actor: lev.id,
        actorType: 'leviathan',
        data: { partitions: lev.activePartitions, role: lev.role },
        lane: 'leviathan',
        stage: 1,
        totalStages: 1,
      });
    }
  }, 5000);
}

/** Emit gossip relay events from batch source to all running replicas. */
function emitGossipRelay(sourceId: string, vizEmitter: (event: VizEvent) => void): void {
  const runningPeers = leviathanVisuals.filter(l => l.status === 'running' && l.id !== sourceId);
  let delay = 0;
  for (const peer of runningPeers) {
    setTimeout(() => {
      vizEmitter({
        type: 'viz:leviathan:gossip',
        timestamp: Date.now(),
        id: `viz-gossip-${sourceId}-${peer.id}-${Date.now()}`,
        actor: sourceId,
        actorType: 'leviathan',
        target: peer.id,
        targetType: 'leviathan',
        data: { messageType: 'batch:built' },
        lane: 'leviathan',
        stage: 1,
        totalStages: 1,
      });
    }, delay);
    delay += 200;
  }
}

/** Reset leviathan state to defaults. */
function resetLeviathanState(): void {
  leviathanVisuals[0] = { id: 'lev-alpha', name: 'Leviathan Alpha', status: 'running', isPrimary: true, role: 'sequencer', primaryPartition: 0, activePartitions: [0], lastHeartbeat: Date.now() };
  leviathanVisuals[1] = { id: 'lev-beta', name: 'Leviathan Beta', status: 'running', isPrimary: false, role: 'replica', primaryPartition: 1, activePartitions: [1], lastHeartbeat: Date.now() };
  leviathanVisuals[2] = { id: 'lev-gamma', name: 'Leviathan Gamma', status: 'running', isPrimary: false, role: 'replica', primaryPartition: 2, activePartitions: [2], lastHeartbeat: Date.now() };
  leaderMap[0] = 'lev-alpha';
  leaderMap[1] = 'lev-beta';
  leaderMap[2] = 'lev-gamma';
}

// ─── Main ──────────────────────────────────────────────

async function main() {
  console.log('');
  console.log('  +============================================================+');
  console.log('  |   zkpCare — Interactive Flowchart Dashboard (Real Proofs)   |');
  console.log('  +============================================================+');
  console.log('');

  // 0. Clear stale L2 checkpoints to avoid "Wallet already registered" errors.
  //    enrolledMembers is in-memory only, but checkpoints persist the wallet
  //    registry — on restart the registry thinks wallets exist while enrolledMembers
  //    is empty, causing enrollment to fail.
  const checkpointDir = path.join(process.cwd(), '.l2-checkpoints');
  if (fs.existsSync(checkpointDir)) {
    for (const file of fs.readdirSync(checkpointDir)) {
      fs.unlinkSync(path.join(checkpointDir, file));
    }
    console.log('  [Flowchart] Cleared stale L2 checkpoints for clean startup.');
  }

  // 1. Initialize L2Node
  const store = new InMemoryStore();
  const emptyRegTree = new MerkleTree(REGISTRY_TREE_HEIGHT);
  const emptyLcTree = new MerkleTree(REGISTRY_TREE_HEIGHT);

  const node = new L2Node(
    {
      batchIntervalMs: BATCH_INTERVAL,
      l2Only: true, // No L1 settlement — batches finalize immediately at build time
      autoSettle: false,
      maxBatchRetries: 3,
    },
    store,
    Field(emptyRegTree.getRoot()),
    Field(emptyLcTree.getRoot()),
    Field(0),
  );

  // 2. Create L2RpcServer
  const rpcServer = new L2RpcServer(node, {
    port: BACKEND_PORT,
    host: '0.0.0.0',
    allowedOrigins: ['*'],
  });

  // Buffered console emitter (same pattern as start-interactive.ts)
  const pendingConsoleEvents: ConsoleEvent[] = [];
  let realConsoleEmitter: ((event: ConsoleEvent) => void) | null = null;

  const bufferedConsoleEmitter = (event: ConsoleEvent): void => {
    // Track compilation progress
    trackCompilationEvent(event);

    if (realConsoleEmitter) {
      realConsoleEmitter(event);
    } else {
      pendingConsoleEvents.push(event);
    }
  };

  // Viz emitter posts to the server's viz endpoint via HTTP loopback
  const vizEmitter = (event: VizEvent): void => {
    const body = JSON.stringify(event);
    const req = http.request({
      hostname: '127.0.0.1',
      port: BACKEND_PORT,
      path: '/viz/emit',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    });
    req.on('error', () => {});
    req.write(body);
    req.end();
  };

  // 2b. Configure checkpoint store (reuses checkpointDir from step 0)
  const checkpointStore = new L2CheckpointStore(checkpointDir);
  node.setCheckpointStore(checkpointStore, { autoCheckpoint: true, maxCheckpoints: 5 });

  // 3. Create the InteractiveDemoService
  const service = new InteractiveDemoService(bufferedConsoleEmitter, vizEmitter, node);

  // 3b. Create AutoModeController (module-level variable, assigned here)
  autoModeController = new AutoModeController(service, node);

  // 4. Register interactive routes on the RPC server
  registerInteractiveRoutes(rpcServer, service);
  realConsoleEmitter = getConsoleEmitter(rpcServer);

  // Replay buffered events
  for (const event of pendingConsoleEvents) {
    realConsoleEmitter(event);
  }
  pendingConsoleEvents.length = 0;

  // 5. Register flowchart-specific routes
  registerFlowchartRoutes(rpcServer, service, node, vizEmitter);

  // 5b. Forward L2Node batch events to console SSE (for block-viz awareness)
  node.on((event) => {
    if (event.type === 'batch:building') {
      bufferedConsoleEmitter({
        type: 'offchain', phase: 'batch',
        message: `Batch building... (${(event.data as Record<string, unknown>).pendingCount} pending transitions)`,
        status: 'start', timestamp: event.timestamp,
      });
    } else if (event.type === 'batch:built') {
      const d = event.data as Record<string, unknown>;
      bufferedConsoleEmitter({
        type: 'offchain', phase: 'batch',
        message: `Batch #${d.batchNumber} built (${d.transitionCount} tx, ${d.buildTimeMs}ms)`,
        status: 'complete', timestamp: event.timestamp,
      });
      // Emit gossip relay from primary sequencer to replicas
      emitGossipRelay('lev-alpha', vizEmitter);
    } else if (event.type === 'batch:settled') {
      const d = event.data as Record<string, unknown>;
      bufferedConsoleEmitter({
        type: 'offchain', phase: 'batch',
        message: `Batch #${d.batchNumber} settled (${d.transitionCount} tx)`,
        status: 'complete', timestamp: event.timestamp,
      });
    } else if (event.type === 'batch:failed') {
      const d = event.data as Record<string, unknown>;
      bufferedConsoleEmitter({
        type: 'offchain', phase: 'batch',
        message: `Batch failed: ${d.reason}`,
        status: 'error', timestamp: event.timestamp,
      });
    } else if (event.type === 'batch:empty') {
      // Skip — too noisy (fires every 90s with no pending)
    } else if (event.type.startsWith('pool:')) {
      // Forward pool events to viz dashboard
      const workerId = (event.data as Record<string, unknown>).workerId;
      const poolSubtype = event.type.replace('pool:', '');
      const vizType = `viz:${poolSubtype}` as VizEvent['type'];
      vizEmitter({
        type: vizType,
        timestamp: event.timestamp,
        id: `viz-pool-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        actor: `worker-${workerId}`,
        actorType: 'worker',
        target: 'lev-alpha',
        targetType: 'leviathan',
        data: event.data as Record<string, unknown>,
        lane: 'batch',
        stage: 1,
        totalStages: 1,
      });
    }
  });

  // 6. Start backend RPC server
  await rpcServer.start();
  node.start();

  // 6b. Start leviathan heartbeat timer (5s pulses for running nodes)
  startHeartbeatTimer(vizEmitter);

  console.log(`  [Flowchart] Backend RPC server on port ${BACKEND_PORT}`);

  // 7. Start dashboard server
  const dashboard = new FlowchartDashboardServer(DASHBOARD_PORT, BACKEND_PORT);
  await dashboard.start();

  console.log(`  [Flowchart] Dashboard server on port ${DASHBOARD_PORT}`);
  console.log('');
  console.log(`  Dashboard:  http://localhost:${DASHBOARD_PORT}`);
  console.log(`  Backend:    http://localhost:${BACKEND_PORT}`);
  console.log('');

  // 8. Compile ZkPrograms (streams progress to console SSE)
  compilationState.status = 'compiling';
  compilationState.startedAt = Date.now();
  compilationState.programs = [
    { name: 'ProofGateProgram', status: 'pending' },
    { name: 'EligibilityProgram', status: 'pending' },
    { name: 'AccessControlProgram', status: 'pending' },
    { name: 'MessagingProgram', status: 'pending' },
    { name: 'PrescriptionProgram', status: 'pending' },
    { name: 'AccumulatorFulfillmentProgram', status: 'pending' },
    { name: 'PcpVerificationProgram', status: 'pending' },
    { name: 'CredentialProgram', status: 'pending' },
    { name: 'StateTransitionProgram', status: 'pending' },
    { name: 'BatchProgram', status: 'pending' },
  ];

  console.log('  [Flowchart] Starting ZkProgram compilation...');
  console.log('  [Flowchart] Open http://localhost:8080 to see progress.');
  console.log('');

  try {
    await service.compileAllPrograms();
    compilationState.status = 'complete';
    console.log('');
    console.log('  [Flowchart] All programs compiled. Ready for interaction!');

    // Start proving pool — workers compile in parallel (~5 min each)
    // Isolated from main compilation so a pool failure doesn't block the dashboard.
    if (POOL_SIZE > 0) {
      console.log(`  [Flowchart] Starting proving pool with ${POOL_SIZE} workers (timeout: ${POOL_COMPILE_TIMEOUT / 1000}s)...`);
      try {
        provingPool = new ProvingPool(POOL_SIZE, { compileTimeoutMs: POOL_COMPILE_TIMEOUT });

        // Forward worker stderr to console SSE — so users can see compilation errors
        provingPool.onStderr((workerId, text) => {
          bufferedConsoleEmitter({
            type: 'error', phase: 'pool',
            message: `[Worker ${workerId} stderr] ${text}`,
            status: 'error', timestamp: Date.now(),
          });
        });

        // Forward pool lifecycle events to console SSE
        provingPool.on((event) => {
          if (event.type === 'worker:spawned') {
            bufferedConsoleEmitter({
              type: 'info', phase: 'pool',
              message: `Worker ${event.workerId} spawned (compiling ZkPrograms...)`,
              status: 'start', timestamp: event.timestamp,
            });
          } else if (event.type === 'worker:ready') {
            bufferedConsoleEmitter({
              type: 'compile', phase: 'pool',
              message: `Worker ${event.workerId} compiled (${(event.data as Record<string, unknown>).compileTimeMs}ms)`,
              status: 'complete', timestamp: event.timestamp,
              elapsedMs: (event.data as Record<string, unknown>).compileTimeMs as number,
            });
          } else if (event.type === 'worker:compile_timeout') {
            bufferedConsoleEmitter({
              type: 'error', phase: 'pool',
              message: `Worker ${event.workerId} compilation TIMED OUT after ${((event.data as Record<string, unknown>).timeoutMs as number) / 1000}s`,
              status: 'error', timestamp: event.timestamp,
            });
          } else if (event.type === 'worker:compile_failed') {
            bufferedConsoleEmitter({
              type: 'error', phase: 'pool',
              message: `Worker ${event.workerId} compilation FAILED: ${(event.data as Record<string, unknown>).error}`,
              status: 'error', timestamp: event.timestamp,
            });
          } else if (event.type === 'worker:crashed') {
            bufferedConsoleEmitter({
              type: 'error', phase: 'pool',
              message: `Worker ${event.workerId} CRASHED (code=${(event.data as Record<string, unknown>).code}, signal=${(event.data as Record<string, unknown>).signal})`,
              status: 'error', timestamp: event.timestamp,
            });
          }
        });
        await provingPool.start();
        node.setProvingPool(provingPool);
        const aliveCount = provingPool.getWorkerStatuses().length;
        console.log(`  [Flowchart] Proving pool ready (${aliveCount}/${POOL_SIZE} workers).`);
      } catch (poolErr) {
        console.warn(`  [Flowchart] Proving pool failed to start: ${poolErr instanceof Error ? poolErr.message : poolErr}`);
        console.warn('  [Flowchart] Falling back to single-process proving (no pool).');
        provingPool = null;
      }
    }

    console.log('');
  } catch (err) {
    compilationState.status = 'error';
    console.error('  [Flowchart] Compilation error:', err);
  }

  // 9. Graceful shutdown
  const shutdown = async () => {
    console.log('\n  [Flowchart] Shutting down...');
    if (provingPool) {
      console.log('  [Flowchart] Shutting down proving pool...');
      await provingPool.shutdown();
    }
    await node.stop();
    await rpcServer.stop();
    await dashboard.stop();
    console.log('  [Flowchart] Done.');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Keep alive
  await new Promise(() => {});
}

// ─── Compilation Tracking ────────────────────────────────

function trackCompilationEvent(event: ConsoleEvent): void {
  if (event.type !== 'compile') return;

  const msg = event.message;

  // Match "[N/M] Compiling XxxProgram..." or "Compiling XxxProgram..."
  const compileMatch = msg.match(/Compiling (\w+)/);
  if (compileMatch) {
    const name = compileMatch[1];
    const prog = compilationState.programs.find(p => p.name === name);
    if (prog) prog.status = 'compiling';
  }

  // Match "[N/M] XxxProgram ... compiled" or "XxxProgram compiled"
  const doneMatch = msg.match(/(\w+Program)\b.*compiled/);
  if (doneMatch) {
    const name = doneMatch[1];
    const prog = compilationState.programs.find(p => p.name === name);
    if (prog) {
      prog.status = 'complete';
      prog.elapsedMs = event.elapsedMs;
    }
  }
}

// ─── Flowchart Routes ──────────────────────────────────

function registerFlowchartRoutes(
  server: L2RpcServer,
  service: InteractiveDemoService,
  node: L2Node,
  vizEmitter: (event: VizEvent) => void,
): void {
  // GET /flowchart/status — aggregated dashboard status
  server.registerRoute('GET', '/flowchart/status', async (_req, res) => {
    const seq = node.getSequencer();
    const nodeStatus = node.getStatus();

    const status = {
      compilation: {
        status: compilationState.status,
        programs: compilationState.programs,
        startedAt: compilationState.startedAt,
        elapsedMs: compilationState.startedAt > 0 ? Date.now() - compilationState.startedAt : 0,
      },
      leviathans: leviathanVisuals,
      partitionMap: { ...leaderMap },
      failoverChain: { ...failoverChain },
      partitionCount: PARTITION_COUNT,
      chain: {
        blockHeight: Number(seq.getCurrentBlockHeight().toBigInt()),
        receiptCount: seq.getAllReceipts().length,
        batchCount: seq.getAllBatches().length,
        claimLeafCount: Number(seq.getClaimLeafCount()),
        registryRoot: seq.getCurrentRegistryRoot().toString(),
        lifecycleRoot: seq.getCurrentLifecycleRoot().toString(),
        walletCount: Number(seq.getCurrentWalletCount().toBigInt()),
        nextBatchInMs: nodeStatus.nextBatchInMs,
        batchIntervalMs: nodeStatus.batchIntervalMs,
        latestBatchNumber: (() => {
          const batches = seq.getAllBatches();
          return batches.length > 0 ? Number(batches[batches.length - 1].batchNumber) : null;
        })(),
      },
      smokeTest: smokeTestState,
      autoMode: autoModeController.getState(),
      ready: compilationState.status === 'complete',
      provingPool: provingPool ? {
        poolSize: provingPool.getPoolSize(),
        workers: provingPool.getWorkerStatuses(),
      } : null,
    };

    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(status));
  });

  // GET /flowchart/compilation — compilation progress only
  server.registerRoute('GET', '/flowchart/compilation', async (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({
      status: compilationState.status,
      programs: compilationState.programs,
      startedAt: compilationState.startedAt,
      elapsedMs: compilationState.startedAt > 0 ? Date.now() - compilationState.startedAt : 0,
    }));
  });

  // POST /flowchart/leviathan/stop — stop a leviathan + trigger failover
  server.registerRoute('POST', '/flowchart/leviathan/stop', async (req, res) => {
    const body = await readBody(req);
    const { id } = JSON.parse(body || '{}');
    const lev = leviathanVisuals.find(l => l.id === id);
    if (!lev) {
      res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'Leviathan not found' }));
      return;
    }
    handleLeviathanStop(id, vizEmitter);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ ok: true, id, status: 'stopped' }));
  });

  // POST /flowchart/leviathan/start — start a leviathan + reclaim partition
  server.registerRoute('POST', '/flowchart/leviathan/start', async (req, res) => {
    const body = await readBody(req);
    const { id } = JSON.parse(body || '{}');
    const lev = leviathanVisuals.find(l => l.id === id);
    if (!lev) {
      res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'Leviathan not found' }));
      return;
    }
    handleLeviathanStart(id, vizEmitter);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ ok: true, id, status: 'running' }));
  });

  // POST /flowchart/reset — full state reset (keeps compiled programs, restarts L2 node)
  server.registerRoute('POST', '/flowchart/reset', async (_req, res) => {
    if (smokeTestState.status === 'running') {
      res.writeHead(409, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'Cannot reset while smoke test is running' }));
      return;
    }

    // Stop auto mode if running
    autoModeController.reset();

    // 1. Stop the L2 node (clears batch timer, waits for in-progress batches)
    await node.stop();

    // 2. Clear stale checkpoint files
    const cpDir = path.join(process.cwd(), '.l2-checkpoints');
    if (fs.existsSync(cpDir)) {
      for (const file of fs.readdirSync(cpDir)) {
        fs.unlinkSync(path.join(cpDir, file));
      }
    }

    // 3. Reset sequencer to fresh empty state
    const freshRegTree = new MerkleTree(REGISTRY_TREE_HEIGHT);
    const freshLcTree = new MerkleTree(REGISTRY_TREE_HEIGHT);
    node.getSequencer().resetForDemo(
      Field(freshRegTree.getRoot()),
      Field(freshLcTree.getRoot()),
    );

    // 4. Reset interactive service (rebuilds infrastructure + syncs sequencer roots)
    service.reset();

    // 5. Reset leviathan visuals to all running
    resetLeviathanState();

    // 6. Reset smoke test UI state
    smokeTestState = { status: 'idle', currentStep: 0, steps: [] };

    // 7. Restart the L2 node (fresh batch timer)
    node.start();

    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ ok: true, message: 'Full reset complete. Leviathans restarted. Ready for new smoke test.' }));
  });

  // POST /flowchart/smoke-test — kick off automated smoke test
  server.registerRoute('POST', '/flowchart/smoke-test', async (_req, res) => {
    if (compilationState.status !== 'complete') {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'Programs not yet compiled' }));
      return;
    }
    if (smokeTestState.status === 'running') {
      res.writeHead(409, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'Smoke test already running' }));
      return;
    }
    if (autoModeController.getState().status === 'running') {
      res.writeHead(409, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'Cannot run smoke test while Auto Mode is active' }));
      return;
    }

    // Auto-reset before each smoke test run (full clean slate)
    await node.stop();
    const cpDir = path.join(process.cwd(), '.l2-checkpoints');
    if (fs.existsSync(cpDir)) {
      for (const file of fs.readdirSync(cpDir)) {
        fs.unlinkSync(path.join(cpDir, file));
      }
    }
    const freshRegTree = new MerkleTree(REGISTRY_TREE_HEIGHT);
    const freshLcTree = new MerkleTree(REGISTRY_TREE_HEIGHT);
    node.getSequencer().resetForDemo(
      Field(freshRegTree.getRoot()),
      Field(freshLcTree.getRoot()),
    );
    service.reset();
    autoModeController.reset();
    for (const lev of leviathanVisuals) {
      lev.status = 'running';
      lev.isPrimary = lev.id === 'lev-alpha';
    }
    node.start();

    // Reset and start
    smokeTestState = {
      status: 'running',
      currentStep: 0,
      startedAt: Date.now(),
      steps: [
        { id: 'enroll-alice', description: 'Enroll Alice Johnson', status: 'pending' },
        { id: 'enroll-bob', description: 'Enroll Bob Martinez', status: 'pending' },
        { id: 'assign-pcp', description: 'Assign PCP: Alice → Dr. Chen', status: 'pending' },
        { id: 'prescribe-alice', description: 'Prescribe: Alice → Lisinopril', status: 'pending' },
        { id: 'prescribe-bob', description: 'Prescribe: Bob → Metformin', status: 'pending' },
        { id: 'fill-alice', description: 'Fill: Alice Lisinopril at Main Street Pharmacy', status: 'pending' },
        { id: 'fill-bob', description: 'Fill: Bob Metformin at Main Street Pharmacy', status: 'pending' },
        { id: 'reverse-alice', description: 'Reverse: Alice Lisinopril fill', status: 'pending' },
        { id: 'prior-auth', description: 'Prior Auth: Humira for Alice', status: 'pending' },
        { id: 'batch-verify', description: 'Force batch + verify chain', status: 'pending' },
      ],
    };

    res.writeHead(202, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ ok: true, status: 'started' }));

    // Run smoke test in background
    runSmokeTest(service).catch(err => {
      smokeTestState.status = 'error';
      smokeTestState.error = err instanceof Error ? err.message : String(err);
    });
  });

  // GET /flowchart/smoke-test-status — poll smoke test progress
  server.registerRoute('GET', '/flowchart/smoke-test-status', async (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(smokeTestState));
  });

  // POST /flowchart/auto-mode/start — begin continuous simulation
  server.registerRoute('POST', '/flowchart/auto-mode/start', async (_req, res) => {
    if (compilationState.status !== 'complete') {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'Programs not yet compiled' }));
      return;
    }
    if (smokeTestState.status === 'running') {
      res.writeHead(409, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'Cannot start Auto Mode while smoke test is running' }));
      return;
    }
    if (autoModeController.getState().status === 'running') {
      res.writeHead(409, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'Auto Mode already running' }));
      return;
    }
    autoModeController.start().catch(() => {}); // fire-and-forget
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ ok: true, status: 'started' }));
  });

  // POST /flowchart/auto-mode/stop — stop continuous simulation
  server.registerRoute('POST', '/flowchart/auto-mode/stop', async (_req, res) => {
    autoModeController.stop();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ ok: true, status: 'stopping' }));
  });

  // GET /flowchart/batch-detail — enriched per-batch data for block visualization
  // Query params: zoom (0-4), from (ISO date), to (ISO date)
  //   zoom=0: individual batch cards (default, last 50)
  //   zoom=1: group by day, zoom=2: month, zoom=3: quarter, zoom=4: year
  server.registerRoute('GET', '/flowchart/batch-detail', async (_req, res) => {
    const seq = node.getSequencer();
    const nodeStatus = node.getStatus();
    const allBatches = seq.getAllBatches();
    const allReceipts = seq.getAllReceipts();

    // Parse query params
    const reqUrl = new URL(_req.url ?? '/', `http://${_req.headers.host ?? 'localhost'}`);
    const zoom = Math.max(0, Math.min(4, parseInt(reqUrl.searchParams.get('zoom') ?? '0', 10) || 0));
    const fromParam = reqUrl.searchParams.get('from');
    const toParam = reqUrl.searchParams.get('to');
    const fromTs = fromParam ? new Date(fromParam).getTime() : null;
    const toTs = toParam ? new Date(toParam).getTime() : null;

    // Build walletId → member name lookup from enrolled members
    const stateData = service.getState() as Record<string, unknown>;
    const walletNameMap: Record<string, string> = {};
    const enrolledArr = (stateData.enrolledMembers ?? []) as Array<Record<string, unknown>>;
    for (const m of enrolledArr) {
      if (m.walletId && m.displayName) {
        walletNameMap[String(m.walletId)] = String(m.displayName);
      }
    }

    // Filter batches by date range if specified
    let filteredBatches = allBatches;
    if (fromTs != null) filteredBatches = filteredBatches.filter(b => b.createdAt >= fromTs);
    if (toTs != null) filteredBatches = filteredBatches.filter(b => b.createdAt <= toTs);

    // Pending receipts (not yet batched) — always included regardless of zoom
    const pendingReceipts = allReceipts
      .filter(r => r.l1Status === 'pending')
      .map(r => ({
        receiptId: r.receiptId,
        walletId: r.walletId,
        isRegistration: r.isRegistration,
        sequenceNumber: Number(r.sequenceNumber),
        acceptedAt: r.acceptedAt,
        l1Status: r.l1Status,
      }));

    const baseResponse = {
      totalBatches: allBatches.length,
      batchIntervalMs: nodeStatus.batchIntervalMs,
      nextBatchInMs: nodeStatus.nextBatchInMs,
      pendingReceipts,
    };

    if (zoom === 0) {
      // ─── Individual batch cards (existing logic) ───
      const recentBatches = filteredBatches.slice(-50).map(batch => {
        const batchReceipts = allReceipts
          .filter(r => r.l1BatchNumber === batch.batchNumber)
          .map(r => {
            const memberName = walletNameMap[r.walletId] ?? null;
            let operationType: string = r.isRegistration ? 'registration' : 'transition';
            let patientPayCents = 0;
            let planPayCents = 0;
            let brandName: string | null = null;
            let ndc: string | null = null;
            let tierLevel: number | null = null;
            let daysSupply: number | null = null;

            if (r.claimLeafIndex !== undefined) {
              try {
                const result = seq.getClaimWithProof(r.claimLeafIndex);
                if (result) {
                  patientPayCents = Number(result.entry.leaf.patientPayCents);
                  planPayCents = Number(result.entry.leaf.planPayCents);
                  const op = String(result.entry.leaf.operationType);
                  operationType = op === '1' ? 'fulfillment' : op === '2' ? 'reversal' : operationType;
                  brandName = (result.entry.metadata.brandName as string) ?? null;
                  ndc = (result.entry.metadata.ndc as string) ?? null;
                  tierLevel = (result.entry.metadata.tierLevel as number) ?? null;
                  daysSupply = (result.entry.metadata.daysSupply as number) ?? null;
                }
              } catch { /* skip */ }
            }

            return {
              receiptId: r.receiptId, walletId: r.walletId, memberName,
              isRegistration: r.isRegistration, operationType,
              sequenceNumber: Number(r.sequenceNumber), acceptedAt: r.acceptedAt,
              l1Status: r.l1Status,
              patientPayCents, planPayCents, brandName, ndc, tierLevel, daysSupply,
            };
          });

        return {
          batchNumber: Number(batch.batchNumber),
          transitionCount: batch.transitionCount,
          registrationCount: batch.registrationCount,
          createdAt: batch.createdAt,
          l1Status: batch.l1Status,
          claimAccumulatorRoot: batch.claimAccumulatorRoot ?? null,
          messageStoreRoot: batch.messageStoreRoot ?? null,
          workerId: batch.workerId ?? null,
          proveTimeMs: batch.proveTimeMs ?? null,
          receipts: batchReceipts,
        };
      });

      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ type: 'individual', batches: recentBatches, ...baseResponse }));
      return;
    }

    // ─── Grouped view (zoom 1-4) ───
    const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    function getTimeKey(timestamp: number, z: number): string {
      const d = new Date(timestamp);
      const y = d.getFullYear();
      const m = d.getMonth();
      if (z === 4) return `${y}`;
      if (z === 3) return `${y}-Q${Math.floor(m / 3) + 1}`;
      if (z === 2) return `${y}-${String(m + 1).padStart(2, '0')}`;
      return `${y}-${String(m + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    function getTimeLabel(key: string, z: number): string {
      if (z === 4) return key; // "2026"
      if (z === 3) { // "2026-Q1" → "Q1 2026"
        const [y, q] = key.split('-');
        return `${q} ${y}`;
      }
      if (z === 2) { // "2026-01" → "Jan 2026"
        const [y, m] = key.split('-');
        return `${MONTH_NAMES[parseInt(m, 10) - 1]} ${y}`;
      }
      // z === 1: "2026-01-15" → "Jan 15"
      const [, m, d] = key.split('-');
      return `${MONTH_NAMES[parseInt(m, 10) - 1]} ${parseInt(d, 10)}`;
    }

    interface BatchGroup {
      key: string; label: string; zoom: number;
      batchCount: number; registrationCount: number;
      fulfillmentCount: number; reversalCount: number;
      totalPatientPayCents: number; totalPlanPayCents: number;
      firstBatchAt: number; lastBatchAt: number;
      workerIds: number[];
    }

    const groups = new Map<string, BatchGroup>();
    for (const batch of filteredBatches) {
      const key = getTimeKey(batch.createdAt, zoom);
      if (!groups.has(key)) {
        groups.set(key, {
          key, label: getTimeLabel(key, zoom), zoom,
          batchCount: 0, registrationCount: 0,
          fulfillmentCount: 0, reversalCount: 0,
          totalPatientPayCents: 0, totalPlanPayCents: 0,
          firstBatchAt: batch.createdAt, lastBatchAt: batch.createdAt,
          workerIds: [],
        });
      }
      const g = groups.get(key)!;
      g.batchCount++;
      g.registrationCount += batch.registrationCount ?? 0;
      if (batch.createdAt < g.firstBatchAt) g.firstBatchAt = batch.createdAt;
      if (batch.createdAt > g.lastBatchAt) g.lastBatchAt = batch.createdAt;
      if (batch.workerId != null && !g.workerIds.includes(batch.workerId)) {
        g.workerIds.push(batch.workerId);
      }

      // Aggregate receipt-level stats
      const batchReceipts = allReceipts.filter(r => r.l1BatchNumber === batch.batchNumber);
      for (const r of batchReceipts) {
        if (r.claimLeafIndex !== undefined) {
          try {
            const result = seq.getClaimWithProof(r.claimLeafIndex);
            if (result) {
              g.totalPatientPayCents += Number(result.entry.leaf.patientPayCents);
              g.totalPlanPayCents += Number(result.entry.leaf.planPayCents);
              const op = String(result.entry.leaf.operationType);
              if (op === '1') g.fulfillmentCount++;
              else if (op === '2') g.reversalCount++;
            }
          } catch { /* skip */ }
        }
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({
      type: 'grouped',
      groups: [...groups.values()],
      ...baseResponse,
    }));
  });
}

// ─── Smoke Test Runner ──────────────────────────────────

async function runSmokeTest(service: InteractiveDemoService): Promise<void> {
  const l2Node = service.getL2Node();

  async function runStep(index: number, fn: () => Promise<void>): Promise<void> {
    smokeTestState.currentStep = index;
    smokeTestState.steps[index].status = 'running';
    const start = Date.now();
    try {
      await fn();
      smokeTestState.steps[index].status = 'complete';
      smokeTestState.steps[index].elapsedMs = Date.now() - start;
    } catch (err) {
      smokeTestState.steps[index].status = 'error';
      smokeTestState.steps[index].elapsedMs = Date.now() - start;
      smokeTestState.steps[index].error = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  // Track enrollment results for later steps
  let aliceWalletId = '';
  let bobWalletId = '';
  let aliceCredentialJson = '';
  let bobCredentialJson = '';
  let alicePrescriptionId = '';
  let bobPrescriptionId = '';

  try {
    // Step 0: Enroll Alice
    await runStep(0, async () => {
      const result = await l2Node.withProvingLock(() => service.enrollMember(0));
      aliceWalletId = (result as any).walletId;
    });

    // Step 1: Enroll Bob
    await runStep(1, async () => {
      const result = await l2Node.withProvingLock(() => service.enrollMember(1));
      bobWalletId = (result as any).walletId;
    });

    // Step 2: Assign PCP
    await runStep(2, async () => {
      await l2Node.withProvingLock(() => service.assignPcp({
        memberWalletId: aliceWalletId,
        prescriberIndex: 0,
      }));
    });

    // Step 3: Generate credential for Alice, then prescribe
    await runStep(3, async () => {
      const credResult = await l2Node.withProvingLock(() => service.generateCredential(aliceWalletId, 'holding'));
      aliceCredentialJson = (credResult as any).credentialJson;
      const rxResult = await l2Node.withProvingLock(() => service.createPrescription({
        prescriberIndex: 0,
        memberWalletId: aliceWalletId,
        medicationIndex: 0, // Lisinopril
        pharmacyIndex: 0,   // Main Street Pharmacy
        quantity: 30,
        refills: 3,
      }));
      alicePrescriptionId = (rxResult as any).prescriptionId;
    });

    // Step 4: Generate credential for Bob, then prescribe
    await runStep(4, async () => {
      const credResult = await l2Node.withProvingLock(() => service.generateCredential(bobWalletId, 'holding'));
      bobCredentialJson = (credResult as any).credentialJson;
      const rxResult = await l2Node.withProvingLock(() => service.createPrescription({
        prescriberIndex: 1,
        memberWalletId: bobWalletId,
        medicationIndex: 1, // Metformin
        pharmacyIndex: 0,   // Main Street Pharmacy
        quantity: 60,
        refills: 2,
      }));
      bobPrescriptionId = (rxResult as any).prescriptionId;
    });

    // Step 5: Fill Alice's prescription
    await runStep(5, async () => {
      await l2Node.withProvingLock(() => service.fillPrescription({
        prescriptionId: alicePrescriptionId,
        credentialJson: aliceCredentialJson,
      }));
    });

    // Step 6: Fill Bob's prescription
    await runStep(6, async () => {
      await l2Node.withProvingLock(() => service.fillPrescription({
        prescriptionId: bobPrescriptionId,
        credentialJson: bobCredentialJson,
      }));
    });

    // Step 7: Reverse Alice's fill
    await runStep(7, async () => {
      await l2Node.withProvingLock(() => service.reversePrescription({
        prescriptionId: alicePrescriptionId,
        reason: 'Patient returned medication',
      }));
    });

    // Step 8: Prior Auth for Humira (PA-required, medication index 4 = Humira)
    await runStep(8, async () => {
      const paResult = service.requestPriorAuth({
        memberWalletId: aliceWalletId,
        prescriberIndex: 0,
        medicationIndex: 4, // Humira (requires PA)
      });
      const paId = (paResult as any).priorAuthId;
      await l2Node.withProvingLock(() => service.approvePriorAuth(paId));
    });

    // Step 9: Force batch + verify
    await runStep(9, async () => {
      await service.forceBatch();
      // Verify chain state is consistent
      const seq = l2Node.getSequencer();
      const receipts = seq.getAllReceipts();
      const batches = seq.getAllBatches();
      if (receipts.length === 0) throw new Error('No receipts found');
      if (batches.length === 0) throw new Error('No batches found');
    });

    smokeTestState.status = 'complete';
    smokeTestState.completedAt = Date.now();
  } catch (err) {
    smokeTestState.status = 'error';
    smokeTestState.error = err instanceof Error ? err.message : String(err);
    smokeTestState.completedAt = Date.now();
  }
}

// ─── Helpers ───────────────────────────────────────────

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

// ─── Entry Point ─────────────────────────────────────────

main().catch((err) => {
  console.error('[Flowchart] Fatal error:', err);
  process.exit(1);
});
