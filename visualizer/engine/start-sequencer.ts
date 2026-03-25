/**
 * Start Sequencer — Boots the L2Node + L2RpcServer.
 *
 * This is step 1 in the startup sequence. Run this first,
 * then start the visualizer (Parcel), then run a scenario.
 *
 * Usage: npx tsx engine/start-sequencer.ts
 */
import { Field, MerkleTree } from 'o1js';
import { InMemoryStore } from '../../src/storage/local-store.js';
import { L2Node } from '../../src/l2/l2-node.js';
import { L2RpcServer } from '../../src/l2/l2-rpc-server.js';

const REGISTRY_TREE_HEIGHT = 11;
const PORT = parseInt(process.env.PORT || '3030', 10);
const BATCH_INTERVAL = parseInt(process.env.BATCH_INTERVAL || '90000', 10);

async function main() {
  console.log('╔═══════════════════════════════════════════════╗');
  console.log('║     Adjuda-GATOR L2 Sequencer — Starting       ║');
  console.log('╚═══════════════════════════════════════════════╝\n');

  // 1. Initialize trees
  const store = new InMemoryStore();
  const emptyRegTree = new MerkleTree(REGISTRY_TREE_HEIGHT);
  const emptyLcTree = new MerkleTree(REGISTRY_TREE_HEIGHT);

  // 2. Create L2Node
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

  // 3. Create and start RPC Server
  const server = new L2RpcServer(node, { port: PORT, host: '0.0.0.0', allowedOrigins: ['*'] });
  await server.start();

  console.log(`[Sequencer] RPC Server listening on port ${PORT}`);
  console.log(`[Sequencer] Batch interval: ${BATCH_INTERVAL}ms`);
  console.log('');
  console.log('  Endpoints:');
  console.log(`    POST  http://127.0.0.1:${PORT}/rpc          — JSON-RPC 2.0`);
  console.log(`    GET   http://127.0.0.1:${PORT}/events       — L2 chain SSE`);
  console.log(`    GET   http://127.0.0.1:${PORT}/health       — Health check`);
  console.log(`    POST  http://127.0.0.1:${PORT}/viz/emit     — Viz event push`);
  console.log(`    GET   http://127.0.0.1:${PORT}/viz/events   — Viz SSE stream`);
  console.log(`    GET   http://127.0.0.1:${PORT}/viz/entities — Entity registry`);
  console.log(`    GET   http://127.0.0.1:${PORT}/viz/state    — Full state`);
  console.log('');

  // 4. Start L2Node
  node.start();
  console.log('[Sequencer] L2Node started. Waiting for proofs...');
  console.log('[Sequencer] Press Ctrl+C to stop.\n');

  // 5. Graceful shutdown
  const shutdown = async () => {
    console.log('\n[Sequencer] Shutting down...');
    await node.stop();
    await server.stop();
    console.log('[Sequencer] Done.');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Keep alive
  await new Promise(() => {});
}

main().catch((err) => {
  console.error('[Sequencer] Fatal error:', err);
  process.exit(1);
});
