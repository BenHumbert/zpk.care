/**
 * Start Interactive Demo — Boots L2Node + L2RpcServer + InteractiveDemoService.
 *
 * This is the single startup script for the interactive demo:
 *   1. Creates L2Node + L2RpcServer
 *   2. Registers /interactive/* routes
 *   3. Compiles all ZkPrograms (~3.5 min, streams progress to SSE)
 *   4. Server ready for browser interaction
 *
 * Usage: npx tsx demo/start-interactive.ts
 */
import { Field, MerkleTree } from 'o1js';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { InMemoryStore } from '../../src/storage/local-store.js';
import { L2Node } from '../../src/l2/l2-node.js';
import { L2RpcServer } from '../../src/l2/l2-rpc-server.js';
import { L2CheckpointStore } from '../../src/l2/l2-checkpoint.js';
import type { VizEvent } from '../../src/l2/l2-rpc-server.js';
import { InteractiveDemoService, type ConsoleEvent } from './interactive-service.js';
import { registerInteractiveRoutes, getConsoleEmitter } from './interactive-routes.js';

const REGISTRY_TREE_HEIGHT = 11;
const PORT = parseInt(process.env.PORT || '3030', 10);
const BATCH_INTERVAL = parseInt(process.env.BATCH_INTERVAL || '90000', 10);

async function main() {
  console.log('');
  console.log('+==========================================================+');
  console.log('|       zkpCare — Interactive Demo (Full Proof Mode)        |');
  console.log('+==========================================================+');
  console.log('');

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

  // 2. Create and start RPC Server
  const server = new L2RpcServer(node, { port: PORT, host: '0.0.0.0', allowedOrigins: ['*'] });

  // Collect console SSE clients before service creation
  // (Routes need to be registered before we create the service,
  // but the service needs the console emitter from the routes)
  // Solution: use a buffered emitter that stores events until the real
  // emitter is attached, then replays them.
  const pendingConsoleEvents: ConsoleEvent[] = [];
  let realConsoleEmitter: ((event: ConsoleEvent) => void) | null = null;

  const bufferedConsoleEmitter = (event: ConsoleEvent): void => {
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
      port: PORT,
      path: '/viz/emit',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    });
    req.on('error', () => {}); // ignore errors
    req.write(body);
    req.end();
  };

  // 2b. Clear stale checkpoints for clean startup
  const checkpointDir = path.join(process.cwd(), '.l2-checkpoints');
  if (fs.existsSync(checkpointDir)) {
    for (const file of fs.readdirSync(checkpointDir)) {
      fs.unlinkSync(path.join(checkpointDir, file));
    }
    console.log('  [Interactive] Cleared stale L2 checkpoints for clean startup.');
  }

  // 2c. Configure checkpoint store
  const checkpointStore = new L2CheckpointStore(checkpointDir);
  node.setCheckpointStore(checkpointStore, { autoCheckpoint: true, maxCheckpoints: 5 });

  // 3. Create the service (pass L2Node for real settlement)
  const service = new InteractiveDemoService(bufferedConsoleEmitter, vizEmitter, node);

  // 4. Register interactive routes
  registerInteractiveRoutes(server, service);
  realConsoleEmitter = getConsoleEmitter(server);

  // Replay buffered events
  for (const event of pendingConsoleEvents) {
    realConsoleEmitter(event);
  }
  pendingConsoleEvents.length = 0;

  // 5. Start HTTP server
  await server.start();
  node.start();

  console.log(`[Interactive] RPC Server listening on port ${PORT}`);
  console.log(`[Interactive] Batch interval: ${BATCH_INTERVAL}ms`);
  console.log('');
  console.log('  Endpoints:');
  console.log(`    GET   http://127.0.0.1:${PORT}/interactive/console   — Console SSE stream`);
  console.log(`    GET   http://127.0.0.1:${PORT}/interactive/state     — Session state`);
  console.log(`    POST  http://127.0.0.1:${PORT}/interactive/enroll    — Enroll member`);
  console.log(`    POST  http://127.0.0.1:${PORT}/interactive/prescribe — Create prescription`);
  console.log(`    POST  http://127.0.0.1:${PORT}/interactive/fill      — Fill prescription`);
  console.log(`    POST  http://127.0.0.1:${PORT}/interactive/reset     — Reset session`);
  console.log(`    GET   http://127.0.0.1:${PORT}/health                — Health check`);
  console.log(`    GET   http://127.0.0.1:${PORT}/viz/events            — Viz SSE stream`);
  console.log('');

  // 6. Compile ZkPrograms (streams progress to console SSE clients)
  console.log('[Interactive] Starting ZkProgram compilation (~3.5 minutes)...');
  console.log('[Interactive] Connect browser to see real-time progress.');
  console.log('');

  await service.compileAllPrograms();

  console.log('');
  console.log('[Interactive] All programs compiled. Ready for interaction!');
  console.log('[Interactive] Open http://localhost:1234 in your browser.');
  console.log('[Interactive] Press Ctrl+C to stop.');
  console.log('');

  // 7. Graceful shutdown
  const shutdown = async () => {
    console.log('\n[Interactive] Shutting down...');
    await node.stop();
    await server.stop();
    console.log('[Interactive] Done.');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Keep alive
  await new Promise(() => {});
}

main().catch((err) => {
  console.error('[Interactive] Fatal error:', err);
  process.exit(1);
});
