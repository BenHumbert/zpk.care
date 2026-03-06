#!/usr/bin/env node
/**
 * PoC Orchestrator — Main entry point for the zkpCare proof-of-concept.
 *
 * Boots a full multi-node network (3 Leviathans, 1 Insurer, 5 Members,
 * 2 Prescribers, 2 Pharmacies), serves a monitoring dashboard, and runs
 * a 100-claim workflow through the complete lifecycle.
 *
 * Usage:
 *   npx tsx src/poc/poc-orchestrator.ts
 *   npm run start:poc
 *
 * Dashboard: http://localhost:8080
 */

import { Field, MerkleTree } from 'o1js';
import { InMemoryStore } from '../storage/local-store.js';
import { WALLET_TREE_HEIGHT } from '../wallets/wallet-state.js';
import { L2Leviathan } from '../l2/l2-leviathan.js';
import { L2RpcServer } from '../l2/l2-rpc-server.js';
import type { LeviathanConfig } from '../l2/l2-leviathan-types.js';
import { NautilusAppServer } from '../nodes/nautilus-app-server.js';
import { MemberNode } from '../nodes/member-node.js';
import { PrescriberNode } from '../nodes/prescriber-node.js';
import { PharmacyNode } from '../nodes/pharmacy-node.js';
import { InsurerNode } from '../nodes/insurer-node.js';
import { buildMemberRoutes } from '../nodes/routes/member-routes.js';
import { buildPrescriberRoutes } from '../nodes/routes/prescriber-routes.js';
import { buildPharmacyRoutes } from '../nodes/routes/pharmacy-routes.js';
import { buildInsurerRoutes } from '../nodes/routes/insurer-routes.js';

import { PORT_MAP } from './poc-types.js';
import type { PocStatus, PocPhase, PocEvent, PocEventEmitter, PocCounters, PocNodeInfo } from './poc-types.js';
import { ReceiptFactory, deriveAllWalletIds, type DerivedWallets } from './poc-receipt-factory.js';
import { PocNodeRegistry } from './poc-node-registry.js';
import { PocDashboardServer } from './poc-dashboard-server.js';
import { PocWorkflow } from './poc-workflow.js';

// ─── Constants ───────────────────────────────────────────

const PARTITION_COUNT = 3;
const NODE_IDS = ['lev-alpha', 'lev-beta', 'lev-gamma'];
const ADMIN_TOKEN = 'poc-admin-token';

// ─── Event Emitter ───────────────────────────────────────

class SimplePocEmitter implements PocEventEmitter {
  private handlers: ((event: PocEvent) => void)[] = [];
  private events: PocEvent[] = [];

  emit(event: PocEvent): void {
    this.events.push(event);
    // Keep last 500 events
    if (this.events.length > 500) {
      this.events = this.events.slice(-500);
    }
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch {
        // Ignore handler errors
      }
    }
    // Also log to console
    const levelIcon = { info: ' ', success: '+', error: '!', warn: '?' }[event.level];
    const ts = new Date(event.timestamp).toLocaleTimeString();
    console.log(`  [${ts}] [${levelIcon}] [${event.source}] ${event.message}`);
  }

  onEvent(handler: (event: PocEvent) => void): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((h) => h !== handler);
    };
  }

  getEvents(): PocEvent[] {
    return this.events;
  }
}

// ─── Main ────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('');
  console.log('  ╔══════════════════════════════════════════════════════════╗');
  console.log('  ║     zkpCare Proof-of-Concept — Multi-Node Dashboard      ║');
  console.log('  ╚══════════════════════════════════════════════════════════╝');
  console.log('');

  const startTime = Date.now();
  const emitter = new SimplePocEmitter();
  const registry = new PocNodeRegistry(emitter);
  const counters: PocCounters = {
    enrollments: { total: 0, success: 0, failed: 0 },
    claims: { total: 0, success: 0, failed: 0 },
    batches: { total: 0, success: 0, failed: 0 },
    verifications: { total: 0, passed: 0, failed: 0 },
  };

  let currentPhase: PocPhase = 'booting';
  let workflowSteps: { getSteps: () => any[] } = { getSteps: () => [] };

  // Status provider for the dashboard
  const statusProvider = (): PocStatus => ({
    nodes: registry.getAll(),
    workflow: workflowSteps.getSteps(),
    events: emitter.getEvents(),
    counters,
    phase: currentPhase,
    startedAt: startTime,
    elapsedMs: Date.now() - startTime,
  });

  // Track all cleanup functions
  const cleanups: (() => Promise<void>)[] = [];

  try {
    // ── Phase 1: Boot Leviathans ─────────────────────────

    emitter.emit({
      timestamp: Date.now(), source: 'orchestrator', level: 'info',
      message: 'Phase 1: Booting 3 Leviathan nodes...', phase: 'booting',
    });

    const emptyTree = new MerkleTree(WALLET_TREE_HEIGHT);
    const INITIAL_ROOT = emptyTree.getRoot();

    const leviathans: L2Leviathan[] = [];
    const rpcServers: L2RpcServer[] = [];

    for (let i = 0; i < PARTITION_COUNT; i++) {
      const failoverChain = new Map<number, string[]>();
      for (let p = 0; p < PARTITION_COUNT; p++) {
        const chain = [...NODE_IDS.slice(p), ...NODE_IDS.slice(0, p)];
        failoverChain.set(p, chain);
      }

      const config: LeviathanConfig = {
        partitionCount: PARTITION_COUNT,
        primaryPartition: i,
        failoverChain,
        heartbeatIntervalMs: 60_000,   // suppress auto-heartbeat
        heartbeatTimeoutMs: 120_000,
      };

      // For nodes after the first, add seedPeers pointing to prior nodes
      const seedPeers: string[] = [];
      for (let j = 0; j < i; j++) {
        seedPeers.push(`http://127.0.0.1:${PORT_MAP.leviathans[j]}`);
      }

      const lev = new L2Leviathan(
        config,
        {
          l2Only: true,
          batchIntervalMs: 999_999,   // prevent auto-batch
          nodeId: NODE_IDS[i],
          seedPeers,
          adminToken: ADMIN_TOKEN,
        },
        new InMemoryStore(),
        INITIAL_ROOT,
        INITIAL_ROOT,
        Field(0),
      );
      lev.start();

      const server = new L2RpcServer(lev, {
        port: PORT_MAP.leviathans[i],
        adminToken: ADMIN_TOKEN,
        allowedOrigins: ['*'],
      });
      await server.start();

      leviathans.push(lev);
      rpcServers.push(server);
      cleanups.push(async () => {
        await lev.stop();
        await server.stop();
      });

      const levUrl = `http://127.0.0.1:${PORT_MAP.leviathans[i]}`;
      registry.register({
        id: NODE_IDS[i],
        role: 'leviathan',
        displayName: NODE_IDS[i],
        port: PORT_MAP.leviathans[i],
        url: levUrl,
        partitionIndex: i,
        status: 'running',
      });
    }

    emitter.emit({
      timestamp: Date.now(), source: 'orchestrator', level: 'success',
      message: `3 Leviathans running on ports ${PORT_MAP.leviathans.join(', ')}`,
      phase: 'booting',
    });

    // ── Phase 2: Derive Wallet IDs ──────────────────────

    emitter.emit({
      timestamp: Date.now(), source: 'orchestrator', level: 'info',
      message: 'Deriving wallet IDs from demo data...', phase: 'booting',
    });

    const wallets: DerivedWallets = deriveAllWalletIds();

    emitter.emit({
      timestamp: Date.now(), source: 'orchestrator', level: 'success',
      message: `Derived ${wallets.members.length} member + ${wallets.prescribers.length} prescriber + ${wallets.pharmacies.length} pharmacy walletIds`,
      phase: 'booting',
    });

    // ── Phase 3: Boot Entity Nodes ──────────────────────

    emitter.emit({
      timestamp: Date.now(), source: 'orchestrator', level: 'info',
      message: 'Phase 2: Booting 10 entity nodes...', phase: 'booting',
    });

    const primaryUrl = `http://127.0.0.1:${PORT_MAP.leviathans[0]}`;

    // Insurer
    const insurerServer = new NautilusAppServer({
      role: 'insurer',
      port: PORT_MAP.insurer,
      host: '0.0.0.0',
      sequencerUrl: primaryUrl,
      stateDir: './poc-data/insurer',
      enableSSE: true,
      maxSseConnections: 10,
      allowedOrigins: ['*'],
      adminToken: ADMIN_TOKEN,
      displayName: 'Insurer (PBM)',
    });
    insurerServer.registerRoutes(buildInsurerRoutes(insurerServer));
    const insurerNode = new InsurerNode({
      role: 'insurer',
      sequencerUrl: primaryUrl,
      displayName: 'Insurer (PBM)',
    });
    insurerServer.setEntityNode(insurerNode);
    insurerServer.setOnboardingPhase('ready');
    await insurerServer.start();
    cleanups.push(async () => { await insurerServer.stop(); });
    registry.register({
      id: 'insurer',
      role: 'insurer',
      displayName: 'Insurer (PBM)',
      port: PORT_MAP.insurer,
      url: `http://127.0.0.1:${PORT_MAP.insurer}`,
      status: 'running',
    });

    // Members (5x)
    for (let i = 0; i < wallets.members.length; i++) {
      const m = wallets.members[i];
      const memberServer = new NautilusAppServer({
        role: 'member',
        port: PORT_MAP.members[i],
        host: '0.0.0.0',
        sequencerUrl: primaryUrl,
        stateDir: `./poc-data/member-${i}`,
        enableSSE: true,
        maxSseConnections: 10,
        allowedOrigins: ['*'],
        displayName: m.displayName,
      });
      memberServer.registerRoutes(buildMemberRoutes(memberServer));
      const memberNode = new MemberNode({
        role: 'member',
        walletId: m.walletIdStr,
        sequencerUrl: primaryUrl,
        displayName: m.displayName,
      });
      memberServer.setEntityNode(memberNode);
      memberServer.setOnboardingPhase('ready');
      await memberServer.start();
      cleanups.push(async () => { await memberServer.stop(); });
      registry.register({
        id: `member-${i}`,
        role: 'member',
        displayName: m.displayName,
        port: PORT_MAP.members[i],
        url: `http://127.0.0.1:${PORT_MAP.members[i]}`,
        walletId: m.walletIdStr.slice(0, 12) + '...',
        status: 'running',
      });
    }

    // Prescribers (2x)
    for (let i = 0; i < wallets.prescribers.length; i++) {
      const p = wallets.prescribers[i];
      const prescriberServer = new NautilusAppServer({
        role: 'prescriber',
        port: PORT_MAP.prescribers[i],
        host: '0.0.0.0',
        sequencerUrl: primaryUrl,
        stateDir: `./poc-data/prescriber-${i}`,
        enableSSE: true,
        maxSseConnections: 10,
        allowedOrigins: ['*'],
        displayName: p.displayName,
      });
      prescriberServer.registerRoutes(buildPrescriberRoutes(prescriberServer));
      const prescriberNode = new PrescriberNode({
        role: 'prescriber',
        walletId: p.walletIdStr,
        sequencerUrl: primaryUrl,
        displayName: p.displayName,
      });
      prescriberServer.setEntityNode(prescriberNode);
      prescriberServer.setOnboardingPhase('ready');
      await prescriberServer.start();
      cleanups.push(async () => { await prescriberServer.stop(); });
      registry.register({
        id: `prescriber-${i}`,
        role: 'prescriber',
        displayName: p.displayName,
        port: PORT_MAP.prescribers[i],
        url: `http://127.0.0.1:${PORT_MAP.prescribers[i]}`,
        walletId: p.walletIdStr.slice(0, 12) + '...',
        status: 'running',
      });
    }

    // Pharmacies (2x)
    for (let i = 0; i < wallets.pharmacies.length; i++) {
      const ph = wallets.pharmacies[i];
      const pharmacyServer = new NautilusAppServer({
        role: 'pharmacy',
        port: PORT_MAP.pharmacies[i],
        host: '0.0.0.0',
        sequencerUrl: primaryUrl,
        stateDir: `./poc-data/pharmacy-${i}`,
        enableSSE: true,
        maxSseConnections: 10,
        allowedOrigins: ['*'],
        displayName: ph.displayName,
      });
      pharmacyServer.registerRoutes(buildPharmacyRoutes(pharmacyServer));
      const pharmacyNode = new PharmacyNode({
        role: 'pharmacy',
        walletId: ph.walletIdStr,
        sequencerUrl: primaryUrl,
        displayName: ph.displayName,
      });
      pharmacyServer.setEntityNode(pharmacyNode);
      pharmacyServer.setOnboardingPhase('ready');
      await pharmacyServer.start();
      cleanups.push(async () => { await pharmacyServer.stop(); });
      registry.register({
        id: `pharmacy-${i}`,
        role: 'pharmacy',
        displayName: ph.displayName,
        port: PORT_MAP.pharmacies[i],
        url: `http://127.0.0.1:${PORT_MAP.pharmacies[i]}`,
        walletId: ph.walletIdStr.slice(0, 12) + '...',
        status: 'running',
      });
    }

    emitter.emit({
      timestamp: Date.now(), source: 'orchestrator', level: 'success',
      message: '10 entity nodes running (1 insurer + 5 members + 2 prescribers + 2 pharmacies)',
      phase: 'booting',
    });

    // ── Phase 4: Start Dashboard ────────────────────────

    const dashboard = new PocDashboardServer(PORT_MAP.dashboard, statusProvider, emitter);
    await dashboard.start();
    cleanups.push(async () => { await dashboard.stop(); });

    emitter.emit({
      timestamp: Date.now(), source: 'orchestrator', level: 'success',
      message: `Dashboard running at http://localhost:${PORT_MAP.dashboard}`,
      phase: 'booting',
    });

    // ── Phase 5: Health Check ───────────────────────────

    emitter.emit({
      timestamp: Date.now(), source: 'orchestrator', level: 'info',
      message: 'Running health checks on all 13 nodes...', phase: 'booting',
    });

    await registry.pollAllHealth();

    const allRunning = registry.getAll().every((n) => n.status === 'running');
    if (!allRunning) {
      const failed = registry.getAll().filter((n) => n.status !== 'running');
      emitter.emit({
        timestamp: Date.now(), source: 'orchestrator', level: 'error',
        message: `Health check failed for: ${failed.map((n) => n.displayName).join(', ')}`,
        phase: 'booting',
      });
    } else {
      emitter.emit({
        timestamp: Date.now(), source: 'orchestrator', level: 'success',
        message: 'All 13 nodes healthy',
        phase: 'booting',
      });
    }

    // ── Phase 6: Run Workflow ───────────────────────────

    emitter.emit({
      timestamp: Date.now(), source: 'orchestrator', level: 'info',
      message: 'Starting 100-claim workflow...', phase: 'enrolling',
    });

    const factory = new ReceiptFactory(PARTITION_COUNT, INITIAL_ROOT, INITIAL_ROOT);
    const workflow = new PocWorkflow(leviathans, wallets, factory, emitter, counters);
    workflowSteps = workflow;

    // Run enrollment phase
    currentPhase = 'enrolling';
    const success = await workflow.run();

    // Update phase as workflow progresses
    const steps = workflow.getSteps();
    if (steps.length > 0) {
      const lastStep = steps[steps.length - 1];
      if (lastStep.phase === 'verification') {
        currentPhase = success ? 'complete' : 'error';
      }
    }

    // ── Phase 7: Print Summary ──────────────────────────

    const elapsed = Date.now() - startTime;
    console.log('');
    console.log('  ┌──────────────────────────────────────────────────────┐');
    console.log('  │                  PoC RESULTS SUMMARY                  │');
    console.log('  ├──────────────────────────────────────────────────────┤');
    console.log(`  │  Status:          ${success ? 'ALL PASSED' : 'FAILURES DETECTED'}${' '.repeat(success ? 19 : 14)}│`);
    console.log(`  │  Elapsed:         ${elapsed}ms${' '.repeat(Math.max(0, 29 - String(elapsed).length - 2))}│`);
    console.log(`  │  Enrollments:     ${counters.enrollments.success}/${counters.enrollments.total}${' '.repeat(Math.max(0, 30 - String(counters.enrollments.success).length - String(counters.enrollments.total).length - 1))}│`);
    console.log(`  │  Claims:          ${counters.claims.success}/${counters.claims.total}${' '.repeat(Math.max(0, 30 - String(counters.claims.success).length - String(counters.claims.total).length - 1))}│`);
    console.log(`  │  Batches:         ${counters.batches.success}/${counters.batches.total}${' '.repeat(Math.max(0, 30 - String(counters.batches.success).length - String(counters.batches.total).length - 1))}│`);
    console.log(`  │  Verifications:   ${counters.verifications.passed}/${counters.verifications.total}${' '.repeat(Math.max(0, 30 - String(counters.verifications.passed).length - String(counters.verifications.total).length - 1))}│`);
    console.log('  └──────────────────────────────────────────────────────┘');
    console.log('');
    console.log(`  Dashboard: http://localhost:${PORT_MAP.dashboard}`);
    console.log('  Press Ctrl+C to shutdown all nodes.');
    console.log('');

    // Keep process alive for dashboard viewing
    await new Promise<void>((resolve) => {
      let stopping = false;
      const shutdown = async () => {
        if (stopping) return;
        stopping = true;
        console.log('');
        console.log('  Shutting down...');
        for (const cleanup of cleanups.reverse()) {
          try { await cleanup(); } catch { /* ignore */ }
        }
        console.log('  All nodes stopped.');
        resolve();
      };
      process.on('SIGINT', () => shutdown());
      process.on('SIGTERM', () => shutdown());
    });

  } catch (err) {
    currentPhase = 'error';
    console.error('  [FATAL]', err);
    // Cleanup on failure
    for (const cleanup of cleanups.reverse()) {
      try { await cleanup(); } catch { /* ignore */ }
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('  [FATAL] Orchestrator failed:', err);
  process.exit(1);
});
