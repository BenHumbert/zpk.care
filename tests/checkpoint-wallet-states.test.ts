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
 * Wallet states in checkpoints — a restored sequencer gives every wallet back its own credential root and nonce.
 *
 * What was wrong: exportState saved the wallets registered by receipts and their lifecycle states, nothing more, and
 * restoreState rebuilt every wallet with WalletState.init: an empty credential root and nonce 0. After any restart where
 * a wallet had proved an update, the rebuilt registry no longer hashed to the restored root, so treesAuthoritative was
 * false (every tree and root check relaxed) and getWalletStateForRpc told the phone the empty root and nonce 0. Wallets
 * the insurer provisioned have no receipt, so they were dropped and every wallet after them changed index.
 *
 * How it was found: the option A specification for the money half of A-22, docs/research/a22-option-a-spec.md
 * (2026-10-24), section 6, "Wallet states must be saved first"; it is part of step 1 of that spec's order of work.
 *
 * What is true now: the checkpoint carries walletStates, each wallet's index, credential root and nonce at the point
 * restoreState rolls back to. In L2-only mode that is the moment the last batch was finished; the pending pool is not
 * restored. Restore registers the wallets in index order, so the trees match the restored roots and stay authoritative,
 * even when proofs accepted after the last batch were pending when the checkpoint was written. A checkpoint without
 * walletStates restores exactly as before.
 *
 * The review of option A step 1, 2026-10-24, found the same flag left standing where a replica's roots move without its
 * trees. syncStateFrom restores the leader's snapshot, whose trees stand at the recovery point, and then takes the
 * leader's current roots; applyReplicatedRoots and applyReplicatedReceipt take the roots of every insurer change and
 * wallet update gossiped after that, while the replica's trees follow only registrations. Round two of the step made
 * treesAuthoritative follow treesMatchRoots() there, and the review of option A step 1, round two, 2026-10-24, found
 * what that opened: a false flag relaxes the checks, so a replica whose trees the leader's roots had moved past, once it
 * accepted proofs (a promoted L2Leviathan partition with a verifier), took them with a warning and no tree check, where it
 * had refused them as a divergence. Now roots that move without the trees never relax the checks. Trees that hash to the
 * roots the replica took are authoritative; trees that do not are not, so nothing reads them as current, and the replica
 * refuses every proof with a divergence error that names the roots it took, changing nothing, until it takes the
 * leader's state again. A re-sync whose trees hash to the leader's roots makes it authoritative again.
 *
 * No circuits are compiled: transitions are mock proofs whose roots come from an independent reference model, as in
 * tests/registry-consistency.test.ts. Batches go through the proving-pool split with a stand-in result, or through
 * buildBatch with BatchProgram's two base methods stubbed. The replica cases build an L2Node and an L2Leviathan with no
 * network and hand them the leader's snapshot and receipts directly.
 *
 * Run: npx jest tests/checkpoint-wallet-states.test.ts
 */
import { Field, MerkleTree, Poseidon } from 'o1js';
import { L2SequencerService } from '../src/l2/l2-sequencer-service.js';
import { L2Node } from '../src/l2/l2-node.js';
import { L2Leviathan } from '../src/l2/l2-leviathan.js';
import type { LeviathanConfig } from '../src/l2/l2-leviathan-types.js';
import { getPartition } from '../src/l2/l2-partition.js';
import { l2Parse, l2Stringify } from '../src/l2/l2-json.js';
import type { L2Receipt } from '../src/l2/l2-types.js';
import type { L2SequencerState } from '../src/l2/l2-checkpoint.js';
import { BatchProgram } from '../src/l2/batch-program.js';
import { InMemoryStore } from '../src/storage/local-store.js';
import {
  WalletRegistry, WalletState, WalletRegistryWitness, WALLET_TREE_HEIGHT, CREDENTIAL_INVENTORY_HEIGHT,
} from '../src/wallets/wallet-state.js';
import {
  lifecycleLeafCommitment, LIFECYCLE_REGISTERED, LIFECYCLE_ELIGIBLE, LIFECYCLE_REVOKED,
} from '../src/engine/lifecycle.js';
import { TransitionOutput } from '../src/engine/state-transition.js';
import { createAcceptAllVerifierForTests } from '../src/l2/l2-proof-verifier.js';

// ─── Reference model (independent of the sequencer) ─────────

class Reference {
  reg = new WalletRegistry();
  lc = new MerkleTree(WALLET_TREE_HEIGHT);
  roots() { return { reg: this.reg.getRoot(), lc: this.lc.getRoot() }; }
  provision(wid: Field, state: Field) {
    if (!this.reg.isRegistered(wid)) this.reg.register(wid);
    this.lc.setLeaf(this.reg.getIndex(wid), lifecycleLeafCommitment(wid, state));
  }
  register(wid: Field) { this.provision(wid, LIFECYCLE_REGISTERED); }
  update(wid: Field, newCred: Field) {
    const s = this.reg.getState(wid);
    this.reg.updateState(wid, new WalletState({ walletId: wid, credentialInventoryRoot: newCred, nonce: s.nonce.add(1) }));
  }
}

/** A stand-in for a StateTransitionProof: the sequencer reads publicOutput, and the batch split reads toJSON. */
function mockProof(walletId: Field, before: { reg: Field; lc: Field }, after: { reg: Field; lc: Field }) {
  const publicOutput = new TransitionOutput({
    walletId,
    oldRegistryRoot: before.reg, newRegistryRoot: after.reg,
    oldLifecycleRoot: before.lc, newLifecycleRoot: after.lc,
  });
  return {
    publicOutput,
    verify() { /* no-op, as in o1js outside a circuit */ },
    toJSON() { return { publicOutput: TransitionOutput.toJSON(publicOutput) }; },
  } as any;
}

const wallet = (n: number) => Poseidon.hash([Field(7), Field(n)]);
const credRoot = (n: number) => Poseidon.hash([Field(99), Field(n)]);
const EMPTY_INVENTORY_ROOT = new MerkleTree(CREDENTIAL_INVENTORY_HEIGHT).getRoot().toString();

function newSequencer(l2Only = true) {
  const empty = new MerkleTree(WALLET_TREE_HEIGHT).getRoot();
  const seq = new L2SequencerService(new InMemoryStore(), empty, empty, Field(0), 60_000, l2Only);
  // Mock proofs drive the trees here, so verification is explicitly stubbed. Production installs a real verifier at boot.
  seq.setTransitionVerifier(createAcceptAllVerifierForTests('tests/checkpoint-wallet-states.test.ts'));
  return seq;
}

/** What a node does at boot from a checkpoint: a fresh sequencer, then restoreState. */
function restore(state: L2SequencerState) {
  const seq = newSequencer();
  seq.restoreState(state);
  return seq;
}

const authoritative = (seq: L2SequencerService) => (seq as unknown as { treesAuthoritative: boolean }).treesAuthoritative;

// ─── Batches without a compile ──────────────────────────────

type BatchPath = 'the proving pool' | 'buildBatch';

/** A stand-in for a BatchProof: buildBatch reads its public output and its JSON only. */
function standInBatchProof(first: { publicOutput: TransitionOutput }, last: { publicOutput: TransitionOutput }, transitions: number) {
  return {
    publicOutput: {
      oldRegistryRoot: first.publicOutput.oldRegistryRoot, newRegistryRoot: last.publicOutput.newRegistryRoot,
      oldLifecycleRoot: first.publicOutput.oldLifecycleRoot, newLifecycleRoot: last.publicOutput.newLifecycleRoot,
      registrationCount: Field(0), transitionCount: Field(transitions),
    },
    toJSON: () => ({ proof: 'stand-in' }),
  };
}

/** One batch cycle in L2-only mode, through the proving pool's prepare and finalize or through buildBatch. */
async function buildOneBatch(seq: L2SequencerService, path: BatchPath, whileProving: () => Promise<void> = async () => {}) {
  if (path === 'buildBatch') {
    const single = jest.spyOn(BatchProgram, 'wrapSingle').mockImplementation((async (a: any) => {
      await whileProving();
      return { proof: standInBatchProof(a, a, 1) };
    }) as any);
    const pair = jest.spyOn(BatchProgram, 'wrapPair').mockImplementation((async (a: any, b: any) => {
      await whileProving();
      return { proof: standInBatchProof(a, b, 2) };
    }) as any);
    try {
      await seq.buildBatch();
    } finally {
      single.mockRestore();
      pair.mockRestore();
    }
    return;
  }
  const { job } = seq.prepareBatch();
  if (!job) return;
  const outputs = job.transitionProofJsons.map((j) => (j as { publicOutput: Record<string, string> }).publicOutput);
  await whileProving();
  await seq.finalizeBatch({
    batchProofJson: '{"proof":"stand-in"}',
    batchOutput: {
      oldRegistryRoot: outputs[0].oldRegistryRoot,
      newRegistryRoot: outputs[outputs.length - 1].newRegistryRoot,
      oldLifecycleRoot: outputs[0].oldLifecycleRoot,
      newLifecycleRoot: outputs[outputs.length - 1].newLifecycleRoot,
      registrationCount: '0',
      transitionCount: String(outputs.length),
    },
    proveTimeMs: 1,
    workerId: 0,
  });
}

/** Batch until nothing is pending, as the node's batch timer does. */
async function batchEverything(seq: L2SequencerService, path: BatchPath) {
  while (seq.getPendingCount() > 0) await buildOneBatch(seq, path);
}

/**
 * The engine's boot and one enrollment: two seed providers provisioned by the insurer (admin changes, no receipt), a
 * member's own registration proof, the insurer's ELIGIBLE, and the credential mint the member's device proves.
 */
async function networkWithMember(path: BatchPath) {
  const seq = newSequencer();
  const ref = new Reference();
  const providers = [wallet(1), wallet(2)];
  seq.adminMutate('provision seed providers', ({ provision }) => providers.forEach((p) => provision(p, LIFECYCLE_ELIGIBLE)));
  providers.forEach((p) => ref.provision(p, LIFECYCLE_ELIGIBLE));
  const member = wallet(100);
  let before = ref.roots(); ref.register(member);
  await seq.submitProof(mockProof(member, before, ref.roots()));
  seq.adminMutate('register member: ELIGIBLE', ({ setLifecycle }) => setLifecycle(member, LIFECYCLE_ELIGIBLE));
  ref.provision(member, LIFECYCLE_ELIGIBLE);
  before = ref.roots(); ref.update(member, credRoot(1));
  await seq.submitProof(mockProof(member, before, ref.roots()), { newCredentialInventoryRoot: credRoot(1).toString() } as any);
  await batchEverything(seq, path);
  return { seq, ref, providers, member };
}

/** The member's next wallet update, built by the reference model the way the device builds it from the ledger's state. */
async function proveUpdate(seq: L2SequencerService, ref: Reference, member: Field, cred: Field) {
  const before = ref.roots(); ref.update(member, cred);
  return seq.submitProof(mockProof(member, before, ref.roots()), { newCredentialInventoryRoot: cred.toString() } as any);
}

/** Every wallet's witness, with the state the sequencer reports for it, hashes to the published root. */
function expectWitnessesMatchRoot(seq: L2SequencerService, wallets: Field[]) {
  const root = seq.getCurrentRegistryRoot().toString();
  for (const w of wallets) {
    const state = seq.getWalletStateForRpc(w.toString());
    const leaf = new WalletState({
      walletId: w,
      credentialInventoryRoot: Field(BigInt(state.credentialInventoryRoot)),
      nonce: Field(BigInt(state.nonce)),
    }).commitment();
    const witness = WalletRegistryWitness.fromJSON(JSON.parse(seq.getWalletWitnesses(w.toString()).registryWitnessJson));
    expect(witness.calculateRoot(leaf).toString()).toBe(root);
  }
}

// ─── Tests ──────────────────────────────────────────────────

describe.each(['the proving pool', 'buildBatch'] as BatchPath[])('a batch finished by %s, then a restart', (path) => {
  test('a wallet that proved an update comes back with its own credential root and nonce, every wallet keeps its index, and the trees stay authoritative', async () => {
    const { seq, ref, providers, member } = await networkWithMember(path);
    expect(seq.getWalletStateForRpc(member.toString()).nonce).toBe('1');

    const restored = restore(seq.exportState());

    expect(restored.getCurrentRegistryRoot().toString()).toBe(ref.roots().reg.toString());
    expect(restored.getWalletStateForRpc(member.toString())).toEqual(seq.getWalletStateForRpc(member.toString())); // before: the empty inventory root and nonce '0'
    expect(restored.getWalletStateForRpc(member.toString()).credentialInventoryRoot).toBe(credRoot(1).toString()); // before: the empty inventory root
    for (const w of [...providers, member]) {
      expect(restored.getStateTrees().registry.getIndex(w)).toBe(seq.getStateTrees().registry.getIndex(w)); // before: the providers had no receipt and were gone ('Wallet not registered'); the member moved to index 0
    }
    expect(restored.treesMatchRoots()).toBe(true);   // before: false, the rebuilt registry held one empty wallet
    expect(authoritative(restored)).toBe(true);      // before: false, every tree and root check relaxed
    expectWitnessesMatchRoot(restored, [...providers, member]); // before: threw 'Wallet not registered' for the providers

    // The device goes on from the state the ledger reports: its next update lands and the trees still match.
    await proveUpdate(restored, ref, member, credRoot(2));
    expect(restored.getWalletStateForRpc(member.toString()).nonce).toBe('2'); // before: '1', counted from the empty wallet
    expect(restored.treesMatchRoots()).toBe(true);   // before: false
    // A forged update, whose credential root does not give the root its proof claims, is refused.
    const before = ref.roots();
    const forgedAfter = { reg: Poseidon.hash([Field(1)]), lc: before.lc };
    await expect(restored.submitProof(mockProof(member, before, forgedAfter), { newCredentialInventoryRoot: credRoot(3).toString() } as any))
      .rejects.toThrow(/does not match the sequencer tree/); // before: accepted, because the checks were relaxed
  });

  test('proofs accepted after the last batch are dropped on restore: the wallet comes back at its state when that batch was finished, and the trees stay authoritative', async () => {
    const { seq, ref, providers, member } = await networkWithMember(path);
    const atBatch = { root: seq.getCurrentRegistryRoot().toString(), member: seq.getWalletStateForRpc(member.toString()) };
    const refAtBatch = new Reference();
    providers.forEach((p) => refAtBatch.provision(p, LIFECYCLE_ELIGIBLE));
    refAtBatch.provision(member, LIFECYCLE_ELIGIBLE); refAtBatch.update(member, credRoot(1));
    expect(refAtBatch.roots().reg.toString()).toBe(atBatch.root);

    // After the batch, the member's next update and a second member's registration are accepted, not yet batched.
    await proveUpdate(seq, ref, member, credRoot(2));
    const later = wallet(101);
    const before = ref.roots(); ref.register(later);
    await seq.submitProof(mockProof(later, before, ref.roots()));
    expect(seq.getPendingCount()).toBe(2);
    expect(seq.getWalletStateForRpc(member.toString()).nonce).toBe('2');

    const restored = restore(seq.exportState());

    expect(restored.getPendingCount()).toBe(0);
    expect(restored.getCurrentRegistryRoot().toString()).toBe(atBatch.root);
    expect(restored.getWalletStateForRpc(member.toString())).toEqual(atBatch.member); // before: the empty inventory root and nonce '0'
    expect(restored.getStateTrees().registry.isRegistered(later)).toBe(false);       // before: true, rebuilt from its receipt
    expect(restored.treesMatchRoots()).toBe(true);   // before: false
    expect(authoritative(restored)).toBe(true);      // before: false
    expectWitnessesMatchRoot(restored, [...providers, member]); // before: threw 'Wallet not registered' for the providers

    // The device proves its next update from the state the ledger reports. Written down again before the next batch,
    // the checkpoint still restores the state at the batch.
    await proveUpdate(restored, refAtBatch, member, credRoot(4));
    expect(restored.getPendingCount()).toBe(1);
    const again = restore(restored.exportState());
    expect(again.getWalletStateForRpc(member.toString())).toEqual(atBatch.member); // before: the empty inventory root and nonce '0'
    expect(again.getCurrentRegistryRoot().toString()).toBe(atBatch.root);
    expect(authoritative(again)).toBe(true);         // before: false
  });
});

describe('the recovery point and its edges', () => {
  test('a proof accepted while a batch was being proved is in the roots that batch leaves behind, so it comes back too and the trees stay authoritative', async () => {
    const { seq, ref, providers, member } = await networkWithMember('the proving pool');
    await proveUpdate(seq, ref, member, credRoot(2));
    // The proving pool proves the batch holding the update to credRoot(2) while the device's next update lands.
    await buildOneBatch(seq, 'the proving pool', async () => { await proveUpdate(seq, ref, member, credRoot(3)); });
    expect(seq.getPendingCount()).toBe(1);
    expect(seq.getLastSettledRegistryRoot().toString()).toBe(ref.roots().reg.toString());

    const restored = restore(seq.exportState());

    expect(restored.getCurrentRegistryRoot().toString()).toBe(ref.roots().reg.toString());
    expect(restored.getWalletStateForRpc(member.toString())).toEqual({ walletId: member.toString(), credentialInventoryRoot: credRoot(3).toString(), nonce: '3' }); // before: the empty inventory root and nonce '0'
    expect(authoritative(restored)).toBe(true);      // before: false
    expectWitnessesMatchRoot(restored, [...providers, member]); // before: threw 'Wallet not registered' for the providers
  });

  test('with L1 settlement, a batch awaiting settlement is the recovery point: its end roots and the wallets that hash to them come back, before and after it settles', async () => {
    const seq = newSequencer(false);
    const ref = new Reference();
    const member = wallet(100);
    let before = ref.roots(); ref.register(member);
    await seq.submitProof(mockProof(member, before, ref.roots()));
    await buildOneBatch(seq, 'the proving pool');
    seq.markBatchSettled(seq.getInFlightBatchNumber()!, 'l1-tx-0');
    await proveUpdate(seq, ref, member, credRoot(1));
    await buildOneBatch(seq, 'the proving pool');
    const inFlight = seq.getInFlightBatchNumber()!;
    const atBatch = { root: ref.roots().reg.toString(), member: seq.getWalletStateForRpc(member.toString()) };
    // While the batch waits for L1, the device's next update is accepted.
    await proveUpdate(seq, ref, member, credRoot(2));

    const whileInFlight = restore(seq.exportState());
    expect(whileInFlight.getInFlightBatchNumber()).toBe(inFlight);
    expect(whileInFlight.getCurrentRegistryRoot().toString()).toBe(atBatch.root);
    expect(whileInFlight.getWalletStateForRpc(member.toString())).toEqual(atBatch.member); // before: the empty inventory root and nonce '0'
    expect(authoritative(whileInFlight)).toBe(true); // before: false

    seq.markBatchSettled(inFlight, 'l1-tx-1');
    const afterSettling = restore(seq.exportState());
    expect(afterSettling.getCurrentRegistryRoot().toString()).toBe(atBatch.root);
    expect(afterSettling.getWalletStateForRpc(member.toString())).toEqual(atBatch.member); // before: the empty inventory root and nonce '0'
    expect(authoritative(afterSettling)).toBe(true); // before: false
  });

  test('an insurer change after the last batch is outside the recovery point: restore names both pairs of roots in its warning and relaxes the checks', async () => {
    const { seq, member } = await networkWithMember('the proving pool');
    const settledLifecycleRoot = seq.getLastSettledLifecycleRoot().toString();
    seq.adminMutate('terminate member', ({ setLifecycle }) => setLifecycle(member, LIFECYCLE_REVOKED));
    const liveLifecycleRoot = seq.getCurrentLifecycleRoot().toString();
    expect(liveLifecycleRoot).not.toBe(settledLifecycleRoot);

    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const restored = restore(seq.exportState());
      expect(restored.getWalletStateForRpc(member.toString()).credentialInventoryRoot).toBe(credRoot(1).toString()); // before: the empty inventory root
      expect(restored.getCurrentLifecycleRoot().toString()).toBe(settledLifecycleRoot);
      expect(authoritative(restored)).toBe(false);
      const restoreWarnings = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('Restored'));
      expect(restoreWarnings).toHaveLength(1);
      expect(restoreWarnings[0]).toContain(`lifecycle tree ${liveLifecycleRoot} vs root ${settledLifecycleRoot}`); // before: the warning named no roots
    } finally {
      warn.mockRestore();
    }
  });

  test('a checkpoint written before wallet states were saved restores exactly as before: registrations from receipts, empty wallet states, relaxed checks', async () => {
    const { seq, ref, member } = await networkWithMember('the proving pool');
    const older: L2SequencerState = { ...seq.exportState() };
    delete (older as { walletStates?: unknown }).walletStates;

    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const restored = restore(older);
      // As before: only the wallet a receipt registered, at index 0, with an empty inventory and nonce 0; the
      // lifecycle leaf from the saved lifecycle states; the count from the rebuilt registry; the roots last settled.
      const rebuilt = new Reference();
      rebuilt.provision(member, LIFECYCLE_ELIGIBLE);
      expect(restored.getStateTrees().registry.count).toBe(1);
      expect(restored.getStateTrees().registry.getIndex(member)).toBe(0n);
      expect(restored.getStateTrees().registry.getRoot().toString()).toBe(rebuilt.roots().reg.toString());
      expect(restored.getStateTrees().lifecycle.getRoot().toString()).toBe(rebuilt.roots().lc.toString());
      expect(restored.getWalletStateForRpc(member.toString())).toEqual({ walletId: member.toString(), credentialInventoryRoot: EMPTY_INVENTORY_ROOT, nonce: '0' });
      expect(restored.getCurrentWalletCount().toString()).toBe('1');
      expect(restored.getCurrentRegistryRoot().toString()).toBe(ref.roots().reg.toString());
      expect(restored.treesMatchRoots()).toBe(false);
      expect(authoritative(restored)).toBe(false);
      expect(warn).toHaveBeenCalledWith('[sequencer] Restored roots do not match the rebuilt witness trees; tree/root checks are relaxed until the next admin rebuild.');
    } finally {
      warn.mockRestore();
    }
  });
});

describe("a replica whose roots move without its trees", () => {
  const EMPTY_ROOT = new MerkleTree(WALLET_TREE_HEIGHT).getRoot();

  /** A replica node before it connects. It holds a verifier, so only the tree checks decide what it accepts. */
  function replicaNode(): L2Node {
    const node = new L2Node({ batchIntervalMs: 999_999, autoSettle: false, role: 'replica', nodeId: 'replica-sync' }, new InMemoryStore(), EMPTY_ROOT, EMPTY_ROOT, Field(0));
    node.getSequencer().setTransitionVerifier(createAcceptAllVerifierForTests('tests/checkpoint-wallet-states.test.ts'));
    return node;
  }

  /** The replica takes this state as syncStateFrom takes a leader's snapshot over the wire, from a peer named 'leader'. */
  async function syncFrom(replica: L2Node, state: L2SequencerState): Promise<void> {
    const snapshot = l2Parse<L2SequencerState>(l2Stringify(state));
    (replica as unknown as { peerNetwork: unknown }).peerNetwork = { requestStateSync: async () => snapshot, stop: () => {} };
    await (replica as unknown as { syncStateFrom(peerId: string): Promise<void> }).syncStateFrom('leader');
  }

  /** The member's next wallet update, built by the reference model as the device builds it, not yet submitted. */
  function nextUpdate(ref: Reference, member: Field, cred: Field) {
    const before = ref.roots(); ref.update(member, cred);
    return { proof: mockProof(member, before, ref.roots()), metadata: { newCredentialInventoryRoot: cred.toString() } as any };
  }

  /** What a refused proof must leave as it was: the roots, receipts and pending proofs, the audit chain, the trees, the wallet. */
  function observable(seq: L2SequencerService, member: Field) {
    return {
      registryRoot: seq.getCurrentRegistryRoot().toString(),
      lifecycleRoot: seq.getCurrentLifecycleRoot().toString(),
      walletCount: seq.getCurrentWalletCount().toString(),
      receipts: seq.getAllReceipts().map((r) => r.receiptId),
      pending: seq.getPendingCount(),
      auditEvents: seq.getAuditLog().events.length,
      chainHash: seq.getLatestChainHash(),
      registryTree: seq.getStateTrees().registry.getRoot().toString(),
      lifecycleTree: seq.getStateTrees().lifecycle.getRoot().toString(),
      member: seq.getWalletStateForRpc(member.toString()),
    };
  }

  /** Offer an update: its refusal, or null when it was accepted, and the warnings that relaxed a tree check meanwhile. */
  async function offer(to: { submitProof(proof: any, metadata?: any): Promise<L2Receipt> }, update: { proof: unknown; metadata: unknown }) {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const refusal = await to.submitProof(update.proof, update.metadata).then(() => null, (err: Error) => err.message);
      return { refusal, relaxed: warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('not enforced')) };
    } finally {
      warn.mockRestore();
    }
  }

  /** Hand a leader's receipt to a replica as its gossip handler does, with the roots the leader stands at. */
  function relay(leader: L2SequencerService, replica: L2SequencerService, receipt: L2Receipt) {
    replica.applyReplicatedReceipt(
      receipt,
      leader.getAuditLog().events.find((e) => e.receiptId === receipt.receiptId)!,
      undefined,
      leader.getCurrentRegistryRoot().toString(),
      leader.getCurrentLifecycleRoot().toString(),
      leader.getCurrentWalletCount().toString(),
    );
  }

  test("restored with trees that match its roots, then handed the roots of an insurer change, the replica refuses a proof with the divergence error, names those roots, and changes nothing", async () => {
    const { seq: leader, ref, member } = await networkWithMember('the proving pool');
    const replica = restore(leader.exportState());
    expect(authoritative(replica)).toBe(true);

    // The insurer provisions a pharmacy; the replica takes the roots, as from state:roots gossip, but not the wallet.
    const pharmacy = wallet(3);
    leader.adminMutate('provision pharmacy', ({ provision }) => provision(pharmacy, LIFECYCLE_ELIGIBLE));
    ref.provision(pharmacy, LIFECYCLE_ELIGIBLE);
    replica.applyReplicatedRoots(leader.getCurrentRegistryRoot().toString(), leader.getCurrentLifecycleRoot().toString(), leader.getCurrentWalletCount().toString());
    expect(replica.treesMatchRoots()).toBe(false);
    expect(authoritative(replica)).toBe(false); // its trees are behind the roots, so nothing reads them as current

    // The member's next update, built against the roots both publish now.
    const update = nextUpdate(ref, member, credRoot(2));
    const untouched = observable(replica, member);
    const { refusal, relaxed } = await offer(replica, update);
    expect(refusal).toMatch(/^Wallet state divergence before applying a proof: /); // before: null, accepted with no tree check
    expect(refusal).toContain("This replica took the leader's roots after an insurer change, and its trees do not hash to them; it accepts no proof until it takes the leader's state again"); // before: null
    expect(observable(replica, member)).toEqual(untouched); // before: a receipt, a pending proof, the proof's roots over trees that do not hash to them, the member's next state
    expect(relaxed).toEqual([]); // before: the divergence only warned of, before and after the proof was applied

    // The proof is sound: the leader, whose trees are current, accepts it.
    await expect(leader.submitProof(update.proof, update.metadata)).resolves.toMatchObject({ walletId: member.toString() });
  });

  test('an L2Leviathan partition that took a registration and then a wallet update by gossip, once promoted, refuses a proof with the divergence error and changes nothing', async () => {
    const leader = newSequencer();
    const ref = new Reference();
    let n = 100;
    while (getPartition(wallet(n).toString(), 2) !== 0) n++;
    const member = wallet(n);
    // This node leads partition 1 and follows partition 0, the member's, by gossip until it takes over.
    const config: LeviathanConfig = {
      partitionCount: 2,
      primaryPartition: 1,
      failoverChain: new Map([[0, ['lev-leader', 'lev-follower']], [1, ['lev-follower', 'lev-leader']]]),
      heartbeatIntervalMs: 999_999,
      heartbeatTimeoutMs: 999_999,
    };
    const lev = new L2Leviathan(config, { batchIntervalMs: 999_999, l2Only: true, nodeId: 'lev-follower' }, new InMemoryStore(), EMPTY_ROOT, EMPTY_ROOT, Field(0));
    const partition = lev.getSequencer(0);
    partition.setTransitionVerifier(createAcceptAllVerifierForTests('tests/checkpoint-wallet-states.test.ts'));
    try {
      const before = ref.roots(); ref.register(member);
      relay(leader, partition, await leader.submitProof(mockProof(member, before, ref.roots())));
      expect(partition.treesMatchRoots()).toBe(true);
      expect(authoritative(partition)).toBe(true);
      const mint = await proveUpdate(leader, ref, member, credRoot(1));
      relay(leader, partition, mint);
      expect(partition.treesMatchRoots()).toBe(false);
      expect(authoritative(partition)).toBe(false);

      expect(lev.isLeaderFor(0)).toBe(false);
      lev.promoteToLeader(0, 'lev-leader', 'manual');
      expect(lev.isLeaderFor(0)).toBe(true);
      const update = nextUpdate(ref, member, credRoot(2));
      const untouched = observable(partition, member);
      const { refusal, relaxed } = await offer(lev, update);
      expect(refusal).toMatch(/^Wallet state divergence before applying a proof: /); // before: null, accepted with no tree check
      expect(refusal).toContain(`This replica took the leader's roots with ${mint.receiptId}, and its trees do not hash to them`); // before: null
      expect(observable(partition, member)).toEqual(untouched); // before: a receipt, a pending proof, the proof's roots over trees that do not hash to them, a made-up wallet state
      expect(relaxed).toEqual([]); // before: the divergence only warned of, before and after the proof was applied
    } finally {
      await lev.stop();
    }
  });

  test("synced while the leader has a wallet update pending, the replica refuses proofs; re-synced from a snapshot whose trees hash to the leader's roots, it is authoritative again", async () => {
    const { seq: leader, ref, providers, member } = await networkWithMember('the proving pool');
    await proveUpdate(leader, ref, member, credRoot(2));
    expect(leader.getPendingCount()).toBe(1);

    const node = replicaNode();
    const replica = node.getSequencer();
    await syncFrom(node, leader.exportState());
    expect(replica.getCurrentRegistryRoot().toString()).toBe(leader.getCurrentRegistryRoot().toString());
    expect(replica.getWalletStateForRpc(member.toString()).nonce).toBe('1'); // the trees stand at the last batch
    expect(authoritative(replica)).toBe(false);
    const update = nextUpdate(ref, member, credRoot(3));
    const untouched = observable(replica, member);
    const { refusal } = await offer(replica, update);
    expect(refusal).toContain("This replica took leader's current roots when it synced, and its trees do not hash to them"); // before: null, accepted with no tree check
    expect(observable(replica, member)).toEqual(untouched); // before: a receipt, a pending proof, the proof's roots and a made-up wallet state
    await leader.submitProof(update.proof, update.metadata);

    // The leader batches both updates, then revokes a provider. The restore inside a sync stands at the recovery
    // point, before the revocation, and cannot place it; the leader's current roots, taken next, include it.
    await batchEverything(leader, 'the proving pool');
    leader.adminMutate('revoke provider', ({ setLifecycle }) => setLifecycle(providers[1], LIFECYCLE_REVOKED));
    ref.provision(providers[1], LIFECYCLE_REVOKED);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await syncFrom(node, leader.exportState());
      expect(warn.mock.calls.some((c) => String(c[0]).startsWith('[sequencer] Restored wallet states do not reproduce the restored roots'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
    expect(replica.treesMatchRoots()).toBe(true);
    expect(authoritative(replica)).toBe(true);
    expect(replica.getWalletStateForRpc(member.toString())).toEqual(leader.getWalletStateForRpc(member.toString()));

    // It accepts the member's next update and holds a forged one to the tree checks.
    await expect(proveUpdate(replica, ref, member, credRoot(4))).resolves.toMatchObject({ walletId: member.toString() });
    expect(replica.treesMatchRoots()).toBe(true);
    const before = ref.roots();
    await expect(replica.submitProof(mockProof(member, before, { reg: Poseidon.hash([Field(1)]), lc: before.lc }), { newCredentialInventoryRoot: credRoot(5).toString() } as any))
      .rejects.toThrow(/does not match the sequencer tree/);
  });
});
