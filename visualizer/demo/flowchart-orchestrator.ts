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
import { FlowchartDashboardServer } from '../../src/poc/flowchart-dashboard-server.js';

const REGISTRY_TREE_HEIGHT = 11;
const BACKEND_PORT = parseInt(process.env.BACKEND_PORT || '3030', 10);
const DASHBOARD_PORT = parseInt(process.env.DASHBOARD_PORT || '8080', 10);
const BATCH_INTERVAL = parseInt(process.env.BATCH_INTERVAL || '90000', 10);

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

// ─── Leviathan Visual State ───────────────────────────

interface LeviathanVisual {
  id: string;
  name: string;
  status: 'running' | 'stopped';
  isPrimary: boolean;
}

const leviathanVisuals: LeviathanVisual[] = [
  { id: 'lev-alpha', name: 'Leviathan Alpha', status: 'running', isPrimary: true },
  { id: 'lev-beta', name: 'Leviathan Beta', status: 'running', isPrimary: false },
  { id: 'lev-gamma', name: 'Leviathan Gamma', status: 'running', isPrimary: false },
];

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
      autoSettle: true,
      settlementDelayMs: 1_000,
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

  // 4. Register interactive routes on the RPC server
  registerInteractiveRoutes(rpcServer, service);
  realConsoleEmitter = getConsoleEmitter(rpcServer);

  // Replay buffered events
  for (const event of pendingConsoleEvents) {
    realConsoleEmitter(event);
  }
  pendingConsoleEvents.length = 0;

  // 5. Register flowchart-specific routes
  registerFlowchartRoutes(rpcServer, service, node);

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
    }
  });

  // 6. Start backend RPC server
  await rpcServer.start();
  node.start();

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
    console.log('');
  } catch (err) {
    compilationState.status = 'error';
    console.error('  [Flowchart] Compilation error:', err);
  }

  // 9. Graceful shutdown
  const shutdown = async () => {
    console.log('\n  [Flowchart] Shutting down...');
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
      ready: compilationState.status === 'complete',
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

  // POST /flowchart/leviathan/stop — visually stop a leviathan
  server.registerRoute('POST', '/flowchart/leviathan/stop', async (req, res) => {
    const body = await readBody(req);
    const { id } = JSON.parse(body || '{}');
    const lev = leviathanVisuals.find(l => l.id === id);
    if (!lev) {
      res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'Leviathan not found' }));
      return;
    }
    lev.status = 'stopped';
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ ok: true, id, status: 'stopped' }));
  });

  // POST /flowchart/leviathan/start — visually start a leviathan
  server.registerRoute('POST', '/flowchart/leviathan/start', async (req, res) => {
    const body = await readBody(req);
    const { id } = JSON.parse(body || '{}');
    const lev = leviathanVisuals.find(l => l.id === id);
    if (!lev) {
      res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'Leviathan not found' }));
      return;
    }
    lev.status = 'running';
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ ok: true, id, status: 'running' }));
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
        { id: 'fill-alice', description: 'Fill: Alice Lisinopril at CVS', status: 'pending' },
        { id: 'fill-bob', description: 'Fill: Bob Metformin at CVS', status: 'pending' },
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

  // GET /flowchart/batch-detail — enriched per-batch data for block visualization
  server.registerRoute('GET', '/flowchart/batch-detail', async (_req, res) => {
    const seq = node.getSequencer();
    const nodeStatus = node.getStatus();
    const allBatches = seq.getAllBatches();
    const allReceipts = seq.getAllReceipts();

    // Recent settled batches (last 8)
    const recentBatches = allBatches.slice(-8).map(batch => {
      const batchReceipts = allReceipts
        .filter(r => r.l1BatchNumber === batch.batchNumber)
        .map(r => {
          let claimDetail: Record<string, unknown> | null = null;
          if (r.claimLeafIndex !== undefined) {
            try {
              const result = seq.getClaimWithProof(r.claimLeafIndex);
              if (result) {
                claimDetail = {
                  patientPayCents: result.entry.leaf.patientPayCents,
                  planPayCents: result.entry.leaf.planPayCents,
                  operationType: result.entry.leaf.operationType,
                  brandName: result.entry.metadata.brandName ?? null,
                  ndc: result.entry.metadata.ndc ?? null,
                  tierLevel: result.entry.metadata.tierLevel ?? null,
                  daysSupply: result.entry.metadata.daysSupply ?? null,
                };
              }
            } catch {
              // Claim data not available — skip enrichment
            }
          }
          return {
            receiptId: r.receiptId,
            walletId: r.walletId,
            isRegistration: r.isRegistration,
            sequenceNumber: Number(r.sequenceNumber),
            acceptedAt: r.acceptedAt,
            l1Status: r.l1Status,
            claimDetail,
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
        receipts: batchReceipts,
      };
    });

    // Pending receipts (not yet batched)
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

    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({
      batches: recentBatches,
      pendingReceipts,
      batchIntervalMs: nodeStatus.batchIntervalMs,
      nextBatchInMs: nodeStatus.nextBatchInMs,
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
        pharmacyIndex: 0,   // CVS
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
        pharmacyIndex: 0,   // CVS
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
