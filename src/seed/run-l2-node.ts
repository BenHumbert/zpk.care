/**
 * Adjuda-GATOR — L2 Chain Node
 *
 * Runs a fully functional L2 chain with:
 *   - 3-level recursive proof compilation (ProofGate → StateTransition → BatchProgram)
 *   - Background batch timer with auto-settlement simulation
 *   - Live block watcher with timestamped event logging
 *   - Real ZK proof submission (registrations + wallet updates)
 *   - Audit trail verification
 *
 * Run:
 *   $env:NODE_OPTIONS="--max-old-space-size=12288"; npx tsx src/seed/run-l2-node.ts
 *
 * Duration: ~10-15 min (compilations ~3 min, proofs ~5-8 min, batch builds ~3-5 min)
 */
import { Field, MerkleTree, Poseidon } from 'o1js';
import os from 'os';

// Wallets
import {
  deriveMemberWalletId,
  memberWalletPreimage,
  DOMAIN_TAG_MEMBER,
} from '../wallets/wallet-derivation.js';
import {
  WalletRegistryWitness,
  WALLET_TREE_HEIGHT,
} from '../wallets/wallet-state.js';

// Engine
import {
  StateTransitionProgram,
  EMPTY_CREDENTIAL_ROOT,
} from '../engine/state-transition.js';
import {
  LifecycleWitness,
  LIFECYCLE_REGISTERED,
  lifecycleLeafCommitment,
} from '../engine/lifecycle.js';

// L2
import { BatchProgram } from '../l2/batch-program.js';
import { L2Node } from '../l2/l2-node.js';
import { L2BlockWatcher } from '../l2/l2-block-watcher.js';
import { InMemoryStore } from '../storage/local-store.js';
import { AuditService } from '../audit/audit-service.js';

// Seed data
import { MEMBERS } from './members.js';

// ─── Helpers ─────────────────────────────────────────────────

function memMB(): number {
  return Math.round(process.memoryUsage().rss / 1024 / 1024);
}

function truncField(f: Field): string {
  const s = f.toBigInt().toString();
  if (s.length <= 16) return s;
  return s.slice(0, 8) + '...' + s.slice(-8);
}

function elapsedSec(start: number): string {
  return ((performance.now() - start) / 1000).toFixed(1);
}

/** Wait for a condition with timeout */
async function waitFor(
  condition: () => boolean,
  description: string,
  timeoutMs: number = 300_000,
  pollMs: number = 500,
): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timeout waiting for: ${description}`);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

// ─── Main ────────────────────────────────────────────────────

async function main() {
  const wallStart = performance.now();

  // ═══════════════════════════════════════════════════════════
  // Phase 1: System Info
  // ═══════════════════════════════════════════════════════════

  console.log('');
  console.log('+==========================================================+');
  console.log('|         Adjuda-GATOR -- L2 CHAIN NODE                       |');
  console.log('|                                                          |');
  console.log('|  Live L2 chain with real ZK proofs, automatic batching,  |');
  console.log('|  simulated L1 settlement, and audit trail verification.  |');
  console.log('+==========================================================+');
  console.log('');

  const cpus = os.cpus();
  const cpu = cpus[0];
  console.log('-- Phase 1: System Info --');
  console.log('');
  console.log(`  CPU:     ${cpu.model.trim()}`);
  console.log(`  Cores:   ${cpus.length} logical @ ${cpu.speed} MHz`);
  console.log(`  RAM:     ${Math.round(os.totalmem() / 1024 / 1024 / 1024)} GB`);
  console.log(`  OS:      ${os.platform()} ${os.arch()} ${os.release()}`);
  console.log(`  Node:    ${process.version}`);
  console.log(`  Heap:    ${memMB()} MB RSS`);
  console.log('');

  // ═══════════════════════════════════════════════════════════
  // Phase 2: Compile 3 Recursive Programs
  // ═══════════════════════════════════════════════════════════

  console.log('-- Phase 2: Compile Recursive Programs (2-level chain) --');
  console.log('');
  console.log('  StateTransitionProgram (inline wallet verification) -> BatchProgram');
  console.log('  Wallet ownership verified inline — no ProofGateProof needed.');
  console.log('');

  const compileStart = performance.now();

  process.stdout.write('  > StateTransitionProgram (inline wallet verification) ... ');
  let t = performance.now();
  await StateTransitionProgram.compile();
  console.log(`${elapsedSec(t)}s (${memMB()} MB)`);

  process.stdout.write('  > BatchProgram (recursive) ... ');
  t = performance.now();
  await BatchProgram.compile();
  console.log(`${elapsedSec(t)}s (${memMB()} MB)`);

  const compileSec = elapsedSec(compileStart);
  console.log('');
  console.log(`  Total compilation: ${compileSec}s`);
  console.log('');

  // ═══════════════════════════════════════════════════════════
  // Phase 3: Derive Wallets & Prepare Trees
  // ═══════════════════════════════════════════════════════════

  console.log('-- Phase 3: Derive Wallets & Prepare State Trees --');
  console.log('');

  const alice = MEMBERS[0]; // Alice Johnson
  const bob = MEMBERS[1];   // Bob Martinez

  const aliceWalletId = deriveMemberWalletId(alice.localData, alice.enrollmentKey, Field(0));
  const alicePreimage = memberWalletPreimage(alice.localData, alice.enrollmentKey, Field(0));
  console.log(`  Alice: ${alice.localData.firstName} ${alice.localData.lastName} (${alice.localData.cardholderId})`);
  console.log(`         Wallet: ${truncField(aliceWalletId)}`);

  const bobWalletId = deriveMemberWalletId(bob.localData, bob.enrollmentKey, Field(0));
  const bobPreimage = memberWalletPreimage(bob.localData, bob.enrollmentKey, Field(0));
  console.log(`  Bob:   ${bob.localData.firstName} ${bob.localData.lastName} (${bob.localData.cardholderId})`);
  console.log(`         Wallet: ${truncField(bobWalletId)}`);

  // State trees (mirror what the L2 sequencer tracks internally)
  const regTree = new MerkleTree(WALLET_TREE_HEIGHT);
  const lcTree = new MerkleTree(WALLET_TREE_HEIGHT);

  console.log('');
  console.log(`  Registry tree: height ${WALLET_TREE_HEIGHT}, root = ${truncField(regTree.getRoot())}`);
  console.log(`  Lifecycle tree: height ${WALLET_TREE_HEIGHT}, root = ${truncField(lcTree.getRoot())}`);
  console.log('');

  // ═══════════════════════════════════════════════════════════
  // Phase 4: Start L2 Node
  // ═══════════════════════════════════════════════════════════

  const BATCH_INTERVAL_MS = 30_000; // 30s for local testing

  console.log('-- Phase 4: Start L2 Node --');
  console.log('');
  console.log(`  Batch interval: ${BATCH_INTERVAL_MS / 1000}s`);
  console.log('  Auto-settle: ON (simulated L1 settlement)');
  console.log('  Settlement delay: 500ms');
  console.log('');

  const store = new InMemoryStore();
  const node = new L2Node(
    {
      batchIntervalMs: BATCH_INTERVAL_MS,
      autoSettle: true,
      settlementDelayMs: 500,
    },
    store,
    regTree.getRoot(),
    lcTree.getRoot(),
    Field(0),
  );

  const watcher = new L2BlockWatcher(node, true);
  node.start();

  console.log('');

  // ═══════════════════════════════════════════════════════════
  // Phase 5: Generate & Submit Proofs
  // ═══════════════════════════════════════════════════════════

  console.log('-- Phase 5: Generate & Submit Proofs --');
  console.log('');
  console.log('  Proof chain per transaction: StateTransitionProof (inline wallet verification) -> L2Receipt');
  console.log('  The L2 node verifies each proof and issues an instant L2 receipt.');
  console.log('  Proofs accumulate in the pending pool until the batch timer fires.');
  console.log('');

  // ── 5a: Alice Registration ────────────────────────────────

  console.log('  --- Transaction 1: Alice Registration ---');
  console.log('');

  process.stdout.write('  > StateTransitionProof (registration) ... ');
  t = performance.now();
  const aliceRegWitness = new WalletRegistryWitness(regTree.getWitness(0n));
  const aliceLcWitness = new LifecycleWitness(lcTree.getWitness(0n));

  const aliceStResult = await StateTransitionProgram.proveRegistration(
    DOMAIN_TAG_MEMBER,
    alicePreimage[0]!, alicePreimage[1]!, alicePreimage[2]!, alicePreimage[3]!, alicePreimage[4]!, alicePreimage[5]!,
    aliceRegWitness,
    aliceLcWitness,
    regTree.getRoot(),
    lcTree.getRoot(),
  );
  console.log(`${elapsedSec(t)}s`);

  // Update local trees to match
  const aliceCommitment = Poseidon.hash([aliceWalletId, EMPTY_CREDENTIAL_ROOT, Field(0)]);
  regTree.setLeaf(0n, aliceCommitment);
  const aliceLcLeaf = lifecycleLeafCommitment(aliceWalletId, LIFECYCLE_REGISTERED);
  lcTree.setLeaf(0n, aliceLcLeaf);

  process.stdout.write('  > Submit to L2 node ... ');
  t = performance.now();
  const aliceReceipt = await node.submitProof(aliceStResult.proof);
  console.log(`${elapsedSec(t)}s -> receipt: ${aliceReceipt.receiptId}`);
  console.log('');

  // ── 5b: Bob Registration ──────────────────────────────────

  console.log('  --- Transaction 2: Bob Registration ---');
  console.log('');

  process.stdout.write('  > StateTransitionProof (registration) ... ');
  t = performance.now();
  const bobRegWitness = new WalletRegistryWitness(regTree.getWitness(1n));
  const bobLcWitness = new LifecycleWitness(lcTree.getWitness(1n));

  const bobStResult = await StateTransitionProgram.proveRegistration(
    DOMAIN_TAG_MEMBER,
    bobPreimage[0]!, bobPreimage[1]!, bobPreimage[2]!, bobPreimage[3]!, bobPreimage[4]!, bobPreimage[5]!,
    bobRegWitness,
    bobLcWitness,
    regTree.getRoot(),
    lcTree.getRoot(),
  );
  console.log(`${elapsedSec(t)}s`);

  // Update local trees
  const bobCommitment = Poseidon.hash([bobWalletId, EMPTY_CREDENTIAL_ROOT, Field(0)]);
  regTree.setLeaf(1n, bobCommitment);
  const bobLcLeaf = lifecycleLeafCommitment(bobWalletId, LIFECYCLE_REGISTERED);
  lcTree.setLeaf(1n, bobLcLeaf);

  process.stdout.write('  > Submit to L2 node ... ');
  t = performance.now();
  const bobReceipt = await node.submitProof(bobStResult.proof);
  console.log(`${elapsedSec(t)}s -> receipt: ${bobReceipt.receiptId}`);
  console.log('');

  // ── 5c: Wait for Batch #0 ─────────────────────────────────

  console.log('  --- Waiting for Batch Timer (batch #0: 2 registrations) ---');
  console.log('');
  console.log(`  The batch timer fires every ${BATCH_INTERVAL_MS / 1000}s.`);
  console.log('  Pending proofs will be paired (wrapPair) and tree-merged (mergeBatches).');
  console.log('  Watch the L2 block watcher output below...');
  console.log('');

  // Wait for batch #0 to settle
  await waitFor(
    () => watcher.getStats().totalSettled >= 1,
    'Batch #0 settlement',
    BATCH_INTERVAL_MS + 120_000, // batch interval + 2min for proof generation
  );

  console.log('');
  console.log('  Batch #0 settled!');
  console.log('');

  // ── 5d: Alice Wallet Update (credential mint) ─────────────────────

  console.log('  --- Transaction 3: Alice Wallet Update (simulated credential mint) ---');
  console.log('');

  // Simulate credential mint by changing the inventory root
  const newCredentialRoot = Poseidon.hash([Field(42), Field(999)]);

  process.stdout.write('  > StateTransitionProof (wallet update) ... ');
  t = performance.now();
  const aliceUpdRegWitness = new WalletRegistryWitness(regTree.getWitness(0n));
  const aliceUpdLcWitness = new LifecycleWitness(lcTree.getWitness(0n));

  const aliceUpdResult = await StateTransitionProgram.proveWalletUpdate(
    DOMAIN_TAG_MEMBER,
    alicePreimage[0]!, alicePreimage[1]!, alicePreimage[2]!, alicePreimage[3]!, alicePreimage[4]!, alicePreimage[5]!,
    EMPTY_CREDENTIAL_ROOT,        // oldCredentialRoot
    Field(0),               // oldNonce
    newCredentialRoot,             // newCredentialRoot
    aliceUpdRegWitness,
    aliceUpdLcWitness,
    regTree.getRoot(),
    lcTree.getRoot(),
    LIFECYCLE_REGISTERED,
  );
  console.log(`${elapsedSec(t)}s`);

  // Update local trees
  const aliceNewCommitment = Poseidon.hash([aliceWalletId, newCredentialRoot, Field(1)]);
  regTree.setLeaf(0n, aliceNewCommitment);

  process.stdout.write('  > Submit to L2 node ... ');
  t = performance.now();
  const aliceUpdReceipt = await node.submitProof(aliceUpdResult.proof);
  console.log(`${elapsedSec(t)}s -> receipt: ${aliceUpdReceipt.receiptId}`);
  console.log('');

  // ── 5e: Wait for Batch #1 ─────────────────────────────────

  console.log('  --- Waiting for Batch Timer (batch #1: 1 wallet update) ---');
  console.log('');

  await waitFor(
    () => watcher.getStats().totalSettled >= 2,
    'Batch #1 settlement',
    BATCH_INTERVAL_MS + 120_000,
  );

  console.log('');
  console.log('  Batch #1 settled!');
  console.log('');

  // ═══════════════════════════════════════════════════════════
  // Phase 6: Stop Node & Verify
  // ═══════════════════════════════════════════════════════════

  console.log('-- Phase 6: Stop Node & Verify --');
  console.log('');

  await node.stop();

  // ── Audit Trail ────────────────────────────────────────────

  const auditLog = node.getSequencer().getAuditLog();
  console.log('  Audit Trail:');
  console.log(`    Events:           ${auditLog.eventCount}`);
  console.log(`    Genesis hash:     ${auditLog.genesisHash.slice(0, 16)}...`);
  console.log(`    Latest chain hash: ${auditLog.latestChainHash.slice(0, 16)}...`);

  // Verify chain integrity
  const chainResult = AuditService.verifyReceiptChain(auditLog);
  console.log(`    Chain integrity:  ${chainResult.isValid ? 'VALID' : 'BROKEN'} (${chainResult.totalEvents} events verified)`);
  console.log('');

  // ── Receipt Status ─────────────────────────────────────────

  const seq = node.getSequencer();
  console.log('  Receipt Status:');
  const receipts = [
    { label: 'Alice registration', receipt: seq.getReceipt(aliceReceipt.receiptId) },
    { label: 'Bob registration', receipt: seq.getReceipt(bobReceipt.receiptId) },
    { label: 'Alice wallet update', receipt: seq.getReceipt(aliceUpdReceipt.receiptId) },
  ];
  for (const { label, receipt } of receipts) {
    if (receipt) {
      console.log(`    ${label}: ${receipt.receiptId} -> ${receipt.l1Status} (batch #${receipt.l1BatchNumber})`);
    }
  }
  console.log('');

  // ── Block & Batch Summary ──────────────────────────────────

  const block0 = seq.getBlock(0n);
  const block1 = seq.getBlock(1n);
  const batch0 = seq.getBatch(0n);
  const batch1 = seq.getBatch(1n);

  console.log('  Blocks:');
  if (block0) {
    console.log(`    Block #0: ${block0.receiptIds.length} receipts, ${block0.registrationCount} reg, ${block0.transitionCount} txns, status=${block0.l1Status}`);
  }
  if (block1) {
    console.log(`    Block #1: ${block1.receiptIds.length} receipts, ${block1.registrationCount} reg, ${block1.transitionCount} txns, status=${block1.l1Status}`);
  }
  console.log('');

  console.log('  Batches:');
  if (batch0) {
    console.log(`    Batch #0: ${batch0.registrationCount} reg, ${batch0.transitionCount} txns, status=${batch0.l1Status}, l1Tx=${batch0.l1TxHash}`);
  }
  if (batch1) {
    console.log(`    Batch #1: ${batch1.registrationCount} reg, ${batch1.transitionCount} txns, status=${batch1.l1Status}, l1Tx=${batch1.l1TxHash}`);
  }
  console.log('');

  // ── L2 State ───────────────────────────────────────────────

  console.log('  L2 Chain State:');
  console.log(`    Registry root:  ${truncField(seq.getCurrentRegistryRoot())}`);
  console.log(`    Lifecycle root: ${truncField(seq.getCurrentLifecycleRoot())}`);
  console.log(`    Wallet count:   ${seq.getCurrentWalletCount().toString()}`);
  console.log('');

  // ── Watcher Stats ──────────────────────────────────────────

  const stats = watcher.getStats();
  console.log('  Block Watcher Stats:');
  console.log(`    Total proofs:        ${stats.totalProofs}`);
  console.log(`    Total batches:       ${stats.totalBatches}`);
  console.log(`    Total settled:       ${stats.totalSettled}`);
  console.log(`    Total failed:        ${stats.totalFailed}`);
  console.log(`    Total registrations: ${stats.totalRegistrations}`);
  console.log(`    Total transitions:   ${stats.totalTransitions}`);
  console.log(`    Avg batch build:     ${(stats.avgBatchBuildTimeMs / 1000).toFixed(1)}s`);
  console.log(`    Total events:        ${stats.totalEvents}`);
  console.log('');

  // ═══════════════════════════════════════════════════════════
  // Phase 7: Summary
  // ═══════════════════════════════════════════════════════════

  const wallSec = ((performance.now() - wallStart) / 1000).toFixed(1);

  console.log('+==========================================================+');
  console.log('|                      SUMMARY                             |');
  console.log('+==========================================================+');
  console.log('');
  console.log(`  Wall clock:      ${wallSec}s`);
  console.log(`  Compilation:     ${compileSec}s (2 programs)`);
  console.log(`  Proofs generated: 3 (2 registrations + 1 wallet update)`);
  console.log(`  Proofs submitted: 3 (Alice reg + Bob reg + Alice update)`);
  console.log(`  Batches built:   ${stats.totalBatches} (auto-batched every ${BATCH_INTERVAL_MS / 1000}s)`);
  console.log(`  Batches settled: ${stats.totalSettled} (simulated L1 settlement)`);
  console.log(`  Audit chain:     ${chainResult.isValid ? 'INTACT' : 'BROKEN'} (${auditLog.eventCount} events)`);
  console.log(`  Memory:          ${memMB()} MB RSS`);
  console.log('');
  console.log('  Future: Replace settleBatch() simulation with real MINA L1 settlement.');
  console.log('  The BatchProof is already generated — just submit to CareContract.settleBatch().');
  console.log('');

  // Verify everything settled
  const allSettled = receipts.every((r) => r.receipt?.l1Status === 'settled');
  if (allSettled && chainResult.isValid) {
    console.log('  RESULT: ALL CHECKS PASSED');
  } else {
    console.log('  RESULT: SOME CHECKS FAILED');
    if (!allSettled) console.log('    - Not all receipts settled');
    if (!chainResult.isValid) console.log('    - Audit chain broken');
  }
  console.log('');
}

// ─── Run ─────────────────────────────────────────────────────

main().catch((err) => {
  console.error('\nFATAL ERROR:', err);
  process.exit(1);
});
