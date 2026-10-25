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
 * The claim entry gossiped with an accepted proof is the receipt's own: option A, step 1, for the money
 * half of finding A-22.
 *
 * What was wrong: the leader gossiped `proof:accepted` with the member's latest claim whenever the proof came
 * with metadata, and every device update comes with metadata (its new credential root; see l2_submitProof).
 * A primary-care, prior-authorization or rollover update therefore sent the member's previous claim again, and
 * the replica appended it again: a reversal twice, so the replica's claim root and totals drifted from the
 * leader's; a fill met the replica's duplicate check after the receipt was already half-applied, and the peer
 * network swallowed the error. A replica also wrote whatever entry came at its own next leaf, so claims that
 * arrived out of order sat at leaves the leader never gave them.
 *
 * How it was found: the option A specification, docs/research/a22-option-a-spec.md, 2026-10-24 (section 6,
 * Gossip; section 7.1, test 7).
 *
 * What is true now: the leader sends the receipt's own leaf, and nothing when the receipt made no claim. A
 * replica appends an entry only when it is the receipt's own and lands at the leaf the leader gave it;
 * otherwise it leaves the entry out and says so, so its claim ledger is the leader's or stops short of it,
 * never a different tree.
 *
 * The review of option A step 1, 2026-10-24, found three more faults on this path. L2Leviathan, which the RPC
 * server also serves, still gossiped the member's latest claim with every receipt that came with metadata, and
 * its replicas appended whatever entry came. The replica's checks lived in L2Node alone and ran beside a write
 * order that put the receipt, its audit event and the roots down before the claim, so an entry the ledger then
 * refused (a second unreversed fill of one key) or could not hash left the receipt half applied: written, the
 * claim missing, the error swallowed, nothing announced or reported. And the audit event gossiped beside each
 * receipt was the last event of the whole log, copied whole on every accepted proof to read it, which is another
 * receipt's when a second submission lands while the first waits on the store.
 *
 * Now applyReplicatedReceipt decides about the claim entry before it writes anything, for every caller: an entry
 * that is not the receipt's own, not at this replica's next leaf, or that the ledger would refuse, is left out and
 * the receipt is applied whole without it. The method returns what it left out; L2Node and L2Leviathan log it, and
 * report it when their claim ledger no longer follows the leader's. Both leaders gossip the receipt's own claim
 * entry and its own audit event.
 *
 * No circuits are compiled: transitions are mock proofs whose roots come from a reference model of the wallet
 * trees, as in registry-consistency.test.ts. The first two cases wire a leader and a replica over HTTP, each
 * with its own peer network, the way claim09 wires nodes; the others hand the leader's messages to the
 * replica's gossip handler in an order a network could deliver them.
 *
 * Run: npx jest tests/claim-entry-gossip.test.ts
 */
import { Field, MerkleTree, Poseidon } from 'o1js';
import { InMemoryStore } from '../src/storage/local-store.js';
import { WalletRegistry, WalletState, WALLET_TREE_HEIGHT } from '../src/wallets/wallet-state.js';
import { lifecycleLeafCommitment, LIFECYCLE_REGISTERED } from '../src/engine/lifecycle.js';
import { TransitionOutput } from '../src/engine/state-transition.js';
import { L2Node } from '../src/l2/l2-node.js';
import type { L2ChainEvent } from '../src/l2/l2-node.js';
import { L2Leviathan } from '../src/l2/l2-leviathan.js';
import type { LeviathanConfig } from '../src/l2/l2-leviathan-types.js';
import { L2SequencerService } from '../src/l2/l2-sequencer-service.js';
import { getPartition } from '../src/l2/l2-partition.js';
import { L2RpcServer } from '../src/l2/l2-rpc-server.js';
import { createAcceptAllVerifierForTests } from '../src/l2/l2-proof-verifier.js';
import { l2Stringify, l2Parse } from '../src/l2/l2-json.js';
import type { GossipMessage, ProofAcceptedPayload } from '../src/l2/l2-peer-types.js';
import type { ClaimSubmissionMetadata, L2Receipt } from '../src/l2/l2-types.js';

jest.setTimeout(30_000);

const THIS_FILE = 'tests/claim-entry-gossip.test.ts';
const ADMIN = 'claim-entry-gossip-admin';
const EMPTY = new MerkleTree(WALLET_TREE_HEIGHT).getRoot();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 5_000): Promise<boolean> {
  const t = Date.now();
  while (Date.now() - t < ms) { if (cond()) return true; await sleep(20); }
  return cond();
}

// ─── Wallets: a reference model of the trees, and mock proofs built from it ─────

class Reference {
  reg = new WalletRegistry();
  lc = new MerkleTree(WALLET_TREE_HEIGHT);
  roots() { return { reg: this.reg.getRoot(), lc: this.lc.getRoot() }; }
  register(wid: Field) {
    this.reg.register(wid);
    this.lc.setLeaf(this.reg.getIndex(wid), lifecycleLeafCommitment(wid, LIFECYCLE_REGISTERED));
  }
  update(wid: Field, newCred: Field) {
    const s = this.reg.getState(wid);
    this.reg.updateState(wid, new WalletState({ walletId: wid, credentialInventoryRoot: newCred, nonce: s.nonce.add(1) }));
  }
}

/** A stand-in for a StateTransitionProof: the sequencer reads publicOutput only. */
function mockProof(walletId: Field, before: { reg: Field; lc: Field }, after: { reg: Field; lc: Field }) {
  return {
    publicOutput: new TransitionOutput({
      walletId,
      oldRegistryRoot: before.reg, newRegistryRoot: after.reg,
      oldLifecycleRoot: before.lc, newLifecycleRoot: after.lc,
    }),
    verify() { /* no-op, as in o1js outside a circuit */ },
    toJSON() { return {}; },
  } as any;
}

const wallet = (n: number) => Poseidon.hash([Field(7), Field(n)]);
const PHARMACY = wallet(1);
const PRESCRIBER = wallet(2);
const NDC_HASH = Poseidon.hash([Field(11), Field(3)]);
const DATE_OF_SERVICE = '20261024';

/** What a leader accepts proofs through: an L2Node, or an L2Leviathan for the partitions it leads. */
interface Leader { submitProof(proof: any, metadata?: ClaimSubmissionMetadata): Promise<L2Receipt> }

/** A member's device: its own proofs, each update sent with the metadata l2_submitProof builds for it. */
function device(leader: Leader, ref: Reference, n: number) {
  const id = wallet(100 + n);
  let credentials = 0;
  const update = (claim?: Partial<ClaimSubmissionMetadata>): Promise<L2Receipt> => {
    const cred = Poseidon.hash([Field(99), Field(n), Field(++credentials)]);
    const before = ref.roots();
    ref.update(id, cred);
    // l2_submitProof sends every wallet update with its new credential root, and a committed claim beside it
    return leader.submitProof(
      mockProof(id, before, ref.roots()),
      { ...claim, newCredentialInventoryRoot: cred.toString() } as unknown as ClaimSubmissionMetadata,
    );
  };
  const claim = (operationType: '1' | '2', dateOfService = DATE_OF_SERVICE): Partial<ClaimSubmissionMetadata> => ({
    memberWalletId: id.toString(), ndcHash: NDC_HASH.toString(), pharmacyWalletId: PHARMACY.toString(),
    prescriberWalletId: PRESCRIBER.toString(), dateOfService, patientPayCents: '1500',
    planPayCents: '4500', operationType, fillNumber: 0,
  });
  return {
    register: (): Promise<L2Receipt> => {
      const before = ref.roots();
      ref.register(id);
      return leader.submitProof(mockProof(id, before, ref.roots()));
    },
    mint: () => update(),
    fill: (dateOfService?: string) => update(claim('1', dateOfService)),
    reverse: () => update(claim('2')),
    choosePrimaryCare: () => update(),
  };
}

const payloadOf = (msg: GossipMessage) => msg.payload as ProofAcceptedPayload;

// ─── Nodes ─────────────────────────────────────────────────

function newLeader(nodeId: string, adminToken?: string): L2Node {
  const leader = new L2Node(
    { batchIntervalMs: 999_999, autoSettle: false, nodeId, role: 'sequencer', ...(adminToken ? { adminToken } : {}) },
    new InMemoryStore(), EMPTY, EMPTY, Field(0),
  );
  leader.getSequencer().setTransitionVerifier(createAcceptAllVerifierForTests(THIS_FILE));
  return leader;
}

function newReplica(nodeId: string, adminToken?: string): L2Node {
  return new L2Node(
    { batchIntervalMs: 999_999, autoSettle: false, nodeId, role: 'replica', ...(adminToken ? { adminToken } : {}) },
    new InMemoryStore(), EMPTY, EMPTY, Field(0),
  );
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup().catch(() => {});
});

/** A leader and a replica on random ports, each with its own peer network, the leader connected to the replica. */
async function wiredPair(tag: string) {
  const leader = newLeader(`leader-${tag}`, ADMIN);
  const replica = newReplica(`replica-${tag}`, ADMIN);
  const leaderServer = new L2RpcServer(leader, { port: 0, host: '127.0.0.1', adminToken: ADMIN, enableSSE: false });
  const replicaServer = new L2RpcServer(replica, { port: 0, host: '127.0.0.1', adminToken: ADMIN, enableSSE: false });
  cleanups.push(async () => {
    await replica.stop();
    await replicaServer.stop();
    await leader.stop();
    await leaderServer.stop();
  });
  await leaderServer.start();
  await replicaServer.start();
  leader.start();
  replica.start();
  const replicaNet = await replica.ensurePeerNetwork();
  replicaServer.setPeerNetwork(replicaNet);
  const leaderNet = await leader.ensurePeerNetwork();
  leaderServer.setPeerNetwork(leaderNet);
  await leaderNet.connectToPeer(`http://127.0.0.1:${replicaServer.getPort()}`);

  // what reached the replica, as its gossip handler saw it
  const gossiped: ProofAcceptedPayload[] = [];
  replicaNet.on((msg) => { if (msg.type === 'proof:accepted') gossiped.push(msg.payload as ProofAcceptedPayload); });

  /** The leader accepts a proof; resolves once the replica holds the receipt, with what was gossiped for it. */
  const land = async (submitted: Promise<L2Receipt>) => {
    const receipt = await submitted;
    expect(await until(() => replica.getSequencer().getReceipt(receipt.receiptId) !== undefined)).toBe(true);
    return { receipt, gossiped: gossiped.find((p) => p.receipt.receiptId === receipt.receiptId)! };
  };
  return { leader, replica, land };
}

/** Keep what a node would have broadcast, each message through the wire's bigint codec, for a test to deliver in any order. */
function keepBroadcasts(node: L2Node | L2Leviathan) {
  const sent: GossipMessage[] = [];
  // a node gossips only when it has a peer network; this one keeps what would have gone out
  (node as any).peerNetwork = {
    broadcast: async (msg: GossipMessage) => { sent.push(l2Parse<GossipMessage>(l2Stringify(msg))); },
    stop: () => {},
  };
  const sentFor = (receipt: L2Receipt): GossipMessage =>
    sent.find((m) => m.type === 'proof:accepted' && payloadOf(m).receipt.receiptId === receipt.receiptId)!;
  return { sent, sentFor };
}

/** A leader whose broadcasts are kept, each through the wire's bigint codec, for a test to deliver in any order. */
function capturingLeader(nodeId: string) {
  const leader = newLeader(nodeId);
  return { leader, ...keepBroadcasts(leader) };
}

/** A replica fed by hand through its own gossip handler, and the errors it reports. */
function handFedReplica(nodeId: string) {
  const replica = newReplica(nodeId);
  const errors: L2ChainEvent[] = [];
  const announced: unknown[] = [];
  replica.on((e) => {
    if (e.type === 'node:error') errors.push(e);
    if (e.type === 'proof:accepted') announced.push(e.data.receiptId);
  });
  const deliver = async (...msgs: GossipMessage[]) => {
    for (const msg of msgs) await (replica as any).handleGossip(msg);
  };
  return { replica, errors, announced, deliver };
}

/** Two partitions: the leader leads partition 0 and the replica partition 1, so the replica follows partition 0 by gossip. */
function leviathanConfig(primaryPartition: number): LeviathanConfig {
  return {
    partitionCount: 2,
    primaryPartition,
    failoverChain: new Map([[0, ['lev-leader', 'lev-replica']], [1, ['lev-replica', 'lev-leader']]]),
    heartbeatIntervalMs: 999_999,
    heartbeatTimeoutMs: 999_999,
  };
}

/** The member numbers from `from` on whose wallets fall in partition 0, the one the L2Leviathan leader leads. */
function partitionZeroMembers(count: number, from = 50): number[] {
  const found: number[] = [];
  for (let n = from; found.length < count; n++) if (getPartition(wallet(100 + n).toString(), 2) === 0) found.push(n);
  return found;
}

/** An L2Leviathan leading partition 0, whose broadcasts are kept. */
function capturingLeviathan(nodeId: string, l2Only = true) {
  const lev = new L2Leviathan(leviathanConfig(0), { batchIntervalMs: 999_999, l2Only, nodeId }, new InMemoryStore(), EMPTY, EMPTY, Field(0));
  lev.getSequencer(0).setTransitionVerifier(createAcceptAllVerifierForTests(THIS_FILE));
  return { lev, ...keepBroadcasts(lev) };
}

/** An L2Leviathan that follows partition 0 by gossip, fed by hand, and what it reports. */
function handFedLeviathan(nodeId: string) {
  const lev = new L2Leviathan(leviathanConfig(1), { batchIntervalMs: 999_999, l2Only: true, nodeId }, new InMemoryStore(), EMPTY, EMPTY, Field(0));
  const errors: L2ChainEvent[] = [];
  const announced: unknown[] = [];
  lev.on((e) => {
    if (e.type === 'node:error') errors.push(e);
    if (e.type === 'proof:accepted') announced.push(e.data.receiptId);
  });
  const deliver = async (...msgs: GossipMessage[]) => {
    for (const msg of msgs) await (lev as any).handleGossip(msg);
  };
  return { lev, seq: lev.getSequencer(0), errors, announced, deliver };
}

/** A leader and a replica fed by hand, of either kind, with the member numbers the leader accepts proofs for. */
type Kind = 'L2Node' | 'L2Leviathan';
function handFedNetwork(kind: Kind, tag: string) {
  if (kind === 'L2Node') {
    const { leader, sent, sentFor } = capturingLeader(`leader-${tag}`);
    const { replica, errors, announced, deliver } = handFedReplica(`replica-${tag}`);
    const members = (count: number) => Array.from({ length: count }, (_, i) => 20 + i);
    return { leader, leaderSeq: leader.getSequencer(), sent, sentFor, replicaSeq: replica.getSequencer(), errors, announced, deliver, members };
  }
  const { lev, sent, sentFor } = capturingLeviathan(`lev-leader-${tag}`);
  const { seq, errors, announced, deliver } = handFedLeviathan(`lev-replica-${tag}`);
  return { leader: lev, leaderSeq: lev.getSequencer(0), sent, sentFor, replicaSeq: seq, errors, announced, deliver, members: partitionZeroMembers };
}

/** Each audit event of a sequencer's chain, by the receipt it records and the hash that links it. */
const auditChain = (seq: L2SequencerService) => seq.getAuditLog().events.map((e) => [e.receiptId, e.chainHash]);

// ─── Tests ─────────────────────────────────────────────────

describe("the leader gossips the receipt's own claim entry", () => {
  test("after a fill, a reversal and a primary-care update, each gossiped entry is the receipt's own leaf and the replica's claim ledger equals the leader's", async () => {
    const { leader, replica, land } = await wiredPair('a');
    const member = device(leader, new Reference(), 1);
    await land(member.register());
    await land(member.mint());

    const fill = await land(member.fill());
    expect(fill.receipt.claimLeafIndex).toBe(0n);
    expect(fill.gossiped.claimEntry?.leafIndex).toBe(0n);
    expect(fill.gossiped.claimEntry?.metadata.receiptId).toBe(fill.receipt.receiptId);

    const reversal = await land(member.reverse());
    expect(reversal.receipt.claimLeafIndex).toBe(1n);
    expect(reversal.gossiped.claimEntry?.leafIndex).toBe(1n);
    expect(reversal.gossiped.claimEntry?.metadata.receiptId).toBe(reversal.receipt.receiptId);

    const primaryCare = await land(member.choosePrimaryCare());
    expect(primaryCare.receipt.claimLeafIndex).toBeUndefined();
    expect(primaryCare.gossiped.claimEntry).toBeUndefined(); // before: the reversal at leaf 1 was sent again

    const leaderSeq = leader.getSequencer();
    const replicaSeq = replica.getSequencer();
    expect(leaderSeq.getClaimLeafCount()).toBe(2n);
    expect(replicaSeq.getClaimLeafCount()).toBe(2n); // before: 3n, the reversal appended a second time
    expect(replicaSeq.getClaimAccumulatorRoot()).toBe(leaderSeq.getClaimAccumulatorRoot()); // before: the roots differed
    expect(replicaSeq.getClaimAccumulator().getTotals()).toEqual(leaderSeq.getClaimAccumulator().getTotals()); // before: the replica took the reversal's money off twice
  });

  test('after a fill, a primary-care update lands whole on the replica: no duplicate-fill error is raised and swallowed', async () => {
    const { leader, replica, land } = await wiredPair('b');
    const announced: unknown[] = [];
    replica.on((e) => { if (e.type === 'proof:accepted') announced.push(e.data.receiptId); });
    const member = device(leader, new Reference(), 2);
    await land(member.register());
    await land(member.mint());
    await land(member.fill());
    const primaryCare = await land(member.choosePrimaryCare());

    expect(primaryCare.gossiped.claimEntry).toBeUndefined(); // before: the fill at leaf 0 was sent again
    // that copy met the replica's duplicate check after the receipt was written, and the peer network
    // swallowed the error, so the replica neither counted nor announced the receipt
    expect(announced).toContain(primaryCare.receipt.receiptId); // before: the primary-care receipt was never announced
    expect(replica.getStatus().totalProofsAccepted).toBe(leader.getStatus().totalProofsAccepted); // before: one short
    expect(replica.getSequencer().getClaimAccumulatorRoot()).toBe(leader.getSequencer().getClaimAccumulatorRoot());
  });
});

describe("a replica appends only the receipt's own claim entry, at the leaf the leader gave it", () => {
  test("a primary-care receipt that comes with the member's previous claim, as a leader sent it before this fix, leaves the replica's ledger equal to the leader's", async () => {
    const { leader, sent, sentFor } = capturingLeader('leader-c');
    const { replica, errors, deliver } = handFedReplica('replica-c');
    const member = device(leader, new Reference(), 3);
    await member.register();
    await member.mint();
    await member.fill();
    const reversal = await member.reverse();
    const primaryCare = await member.choosePrimaryCare();
    // what the leader sent before this fix: the member's latest claim, here the reversal, beside a receipt that made none
    payloadOf(sentFor(primaryCare)).claimEntry = payloadOf(sentFor(reversal)).claimEntry;
    await deliver(...sent);

    const replicaSeq = replica.getSequencer();
    expect(replicaSeq.getReceipt(primaryCare.receiptId)).toBeDefined();
    expect(replicaSeq.getClaimLeafCount()).toBe(2n); // before: 3n, the reversal appended a second time
    expect(replicaSeq.getClaimAccumulatorRoot()).toBe(leader.getSequencer().getClaimAccumulatorRoot()); // before: the roots differed
    // the stray entry is another receipt's; leaving it out leaves the replica's ledger whole, so nothing is reported
    expect(errors).toHaveLength(0);
  });

  test('a claim entry that arrives before the one ahead of it is left out and reported, never written at a leaf the leader did not give it', async () => {
    const { leader, sent, sentFor } = capturingLeader('leader-d');
    const { replica, errors, deliver } = handFedReplica('replica-d');
    const ref = new Reference();
    const first = device(leader, ref, 4);
    const second = device(leader, ref, 5);
    await first.register();
    await second.register();
    await first.mint();
    await second.mint();
    const fillFirst = await first.fill();
    const rootAfterFirst = leader.getSequencer().getClaimAccumulatorRoot();
    const fillSecond = await second.fill();
    expect(fillSecond.claimLeafIndex).toBe(1n);

    // the network delivers the second fill's message before the first's
    const earlier = sent.filter((m) => m !== sentFor(fillFirst) && m !== sentFor(fillSecond));
    await deliver(...earlier, sentFor(fillSecond), sentFor(fillFirst));

    const replicaSeq = replica.getSequencer();
    expect(replicaSeq.getReceipt(fillFirst.receiptId)).toBeDefined();
    expect(replicaSeq.getReceipt(fillSecond.receiptId)).toBeDefined();
    expect(replicaSeq.getClaimAccumulator().getEntry(0n)?.metadata.receiptId).toBe(fillFirst.receiptId); // before: the second fill sat at leaf 0
    expect(replicaSeq.getClaimLeafCount()).toBe(1n); // before: 2n, each fill at the other's leaf
    expect(replicaSeq.getClaimAccumulatorRoot()).toBe(rootAfterFirst); // before: a root the leader never had
    expect(errors.map((e) => e.data.receiptId)).toEqual([fillSecond.receiptId]); // before: nothing was reported
  });

  test('a message delivered twice, or a receipt sent again under a new message id, appends nothing twice', async () => {
    const { leader, sent, sentFor } = capturingLeader('leader-e');
    const { replica, errors, deliver } = handFedReplica('replica-e');
    const member = device(leader, new Reference(), 6);
    await member.register();
    await member.mint();
    await member.fill();
    const reversal = await member.reverse();
    await deliver(...sent);
    await deliver(sentFor(reversal), { ...sentFor(reversal), messageId: 'reversal-sent-again' });

    // a known receipt is skipped whole by applyReplicatedReceipt, its entry with it; this held before the fix too
    expect(replica.getSequencer().getClaimLeafCount()).toBe(2n);
    expect(replica.getSequencer().getClaimAccumulatorRoot()).toBe(leader.getSequencer().getClaimAccumulatorRoot());
    // and a copy of a receipt the replica already holds is no sign that its ledger has fallen out of step
    expect(errors).toHaveLength(0);
  });
});

describe('an L2Leviathan leader and its replicas do the same', () => {
  test("the leader gossips the receipt's own claim entry, and none with a primary-care update, so a replica's ledger equals the leader's", async () => {
    const { lev, sent, sentFor } = capturingLeviathan('lev-leader-f');
    const { seq: replicaSeq, errors, deliver } = handFedLeviathan('lev-replica-f');
    const [n] = partitionZeroMembers(1);
    const member = device(lev, new Reference(), n);
    await member.register();
    await member.mint();
    const fill = await member.fill();
    const reversal = await member.reverse();
    const primaryCare = await member.choosePrimaryCare();

    expect(payloadOf(sentFor(fill)).claimEntry?.leafIndex).toBe(0n);
    expect(payloadOf(sentFor(fill)).claimEntry?.metadata.receiptId).toBe(fill.receiptId);
    expect(payloadOf(sentFor(reversal)).claimEntry?.leafIndex).toBe(1n);
    expect(payloadOf(sentFor(reversal)).claimEntry?.metadata.receiptId).toBe(reversal.receiptId);
    expect(primaryCare.claimLeafIndex).toBeUndefined();
    expect(payloadOf(sentFor(primaryCare)).claimEntry).toBeUndefined(); // before: the reversal at leaf 1, the member's latest claim

    await deliver(...sent);
    const leaderSeq = lev.getSequencer(0);
    expect(replicaSeq.getReceipt(primaryCare.receiptId)).toBeDefined();
    expect(replicaSeq.getClaimLeafCount()).toBe(2n); // before: 3n, the reversal appended a second time
    expect(replicaSeq.getClaimAccumulatorRoot()).toBe(leaderSeq.getClaimAccumulatorRoot()); // before: the roots differed
    expect(replicaSeq.getClaimAccumulator().getTotals()).toEqual(leaderSeq.getClaimAccumulator().getTotals()); // before: the reversal's money taken off twice
    expect(errors).toHaveLength(0);
  });

  test("a replica leaves out a stray entry and a misplaced one, applies each receipt whole without it, and reports the one its ledger now lacks", async () => {
    const { lev, sent, sentFor } = capturingLeviathan('lev-leader-g');
    const { seq: replicaSeq, errors, announced, deliver } = handFedLeviathan('lev-replica-g');
    const [a, b] = partitionZeroMembers(2);
    const ref = new Reference();
    const first = device(lev, ref, a);
    const second = device(lev, ref, b);
    await first.register();
    await second.register();
    await first.mint();
    await second.mint();
    const fillFirst = await first.fill();
    const rootAfterFirst = lev.getSequencer(0).getClaimAccumulatorRoot();
    const fillSecond = await second.fill();
    const primaryCare = await first.choosePrimaryCare();
    // a stray entry, as a leader before this fix sent it: the member's latest claim beside a receipt that made none
    payloadOf(sentFor(primaryCare)).claimEntry = payloadOf(sentFor(fillFirst)).claimEntry;
    // and the network delivers the second fill's message before the first's
    const rest = sent.filter((m) => m !== sentFor(fillFirst) && m !== sentFor(fillSecond) && m !== sentFor(primaryCare));
    const delivered = await deliver(...rest, sentFor(fillSecond), sentFor(fillFirst), sentFor(primaryCare))
      .then(() => 'delivered', (err: Error) => err.message);
    expect(delivered).toBe('delivered'); // before: a duplicate-fill error, thrown when the stray copy of the first fill was appended after the primary-care receipt was written

    // each receipt is applied whole: the receipt, its own audit event once, and the leader's roots
    for (const receipt of [fillFirst, fillSecond, primaryCare]) {
      expect(replicaSeq.getReceipt(receipt.receiptId)).toBeDefined();
      expect(replicaSeq.getAuditLog().events.filter((e) => e.receiptId === receipt.receiptId)).toHaveLength(1);
      expect(announced).toContain(receipt.receiptId); // before: the primary-care receipt was never announced
    }
    expect(replicaSeq.getCurrentRegistryRoot().toString()).toBe(lev.getSequencer(0).getCurrentRegistryRoot().toString());
    // and only the receipt's own entry at the replica's next leaf was appended
    expect(replicaSeq.getClaimAccumulator().getEntry(0n)?.metadata.receiptId).toBe(fillFirst.receiptId); // before: the second fill sat at leaf 0
    expect(replicaSeq.getClaimLeafCount()).toBe(1n);                    // before: 2n, each fill at the other's leaf
    expect(replicaSeq.getClaimAccumulatorRoot()).toBe(rootAfterFirst);  // before: a root the leader never had
    // the misplaced entry leaves the replica's ledger short of the leader's, which it reports; the stray one does not
    expect(errors.map((e) => [e.data.receiptId, e.data.partitionIndex])).toEqual([[fillSecond.receiptId, 0]]); // before: nothing was reported
  });
});

describe('applyReplicatedReceipt decides about the claim entry before it writes anything', () => {
  // An entry the replica cannot take is left out and the receipt applied whole without it: the receipt, its audit event
  // and the leader's roots, announced, and reported as a ledger that no longer follows the leader's. Before, the
  // receipt, its audit event and the roots were written first, and the claim append then threw.
  const unappendable: Array<[string, (entry: NonNullable<ProofAcceptedPayload['claimEntry']>) => void, RegExp]> = [
    ['that the ledger refuses as a second unreversed fill of one key', (entry) => { entry.leaf.dateOfService = DATE_OF_SERVICE; }, /already holds an unreversed fill of the same key at leaf 0/],
    ['whose leaf does not hash', (entry) => { entry.leaf.patientPayCents = 'not-a-number'; }, /its leaf does not hash/],
  ];
  describe.each(['L2Node', 'L2Leviathan'] as Kind[])('on an %s replica', (kind) => {
    test.each(unappendable)('the receipt\'s own entry at the next leaf, but one %s, is left out and the receipt lands whole', async (_what, spoil, reason) => {
      const net = handFedNetwork(kind, `h-${kind}`);
      const [n] = net.members(1);
      const member = device(net.leader, new Reference(), n);
      await member.register();
      await member.mint();
      await member.fill();
      const secondFill = await member.fill('20261025');   // another day, so the leader takes it
      expect(secondFill.claimLeafIndex).toBe(1n);
      spoil(payloadOf(net.sentFor(secondFill)).claimEntry!);

      const delivered = await net.deliver(...net.sent).then(() => 'delivered', (err: Error) => err.message);
      expect(delivered).toBe('delivered');   // before: the claim append threw after the receipt, its audit event and the roots were written
      expect(net.replicaSeq.getReceipt(secondFill.receiptId)).toBeDefined();
      expect(net.replicaSeq.getAuditLog().events.filter((e) => e.receiptId === secondFill.receiptId)).toHaveLength(1);
      expect(net.replicaSeq.getCurrentRegistryRoot().toString()).toBe(net.leaderSeq.getCurrentRegistryRoot().toString());
      expect(net.replicaSeq.getClaimLeafCount()).toBe(1n);
      expect(net.announced).toContain(secondFill.receiptId);   // before: the receipt was never announced
      expect(net.errors.map((e) => e.data.receiptId)).toEqual([secondFill.receiptId]); // before: nothing was reported
      expect(String(net.errors[0].data.error)).toMatch(reason);
    });
  });

  test('called directly, as an L2Leviathan partition or a workflow hands it gossip, it leaves out a stray or misplaced entry and returns why', async () => {
    const { leader, sent, sentFor } = capturingLeader('leader-i');
    const ref = new Reference();
    const first = device(leader, ref, 30);
    const second = device(leader, ref, 31);
    for (const step of [first.register, second.register, first.mint, second.mint]) await step();
    const fillFirst = await first.fill();
    const fillSecond = await second.fill();
    const primaryCare = await first.choosePrimaryCare();

    const replica = new L2SequencerService(new InMemoryStore(), EMPTY, EMPTY, Field(0));
    const apply = (msg: GossipMessage, entry = payloadOf(msg).claimEntry) => {
      const p = payloadOf(msg);
      return replica.applyReplicatedReceipt(p.receipt, p.auditEvent, entry, p.currentRegistryRoot, p.currentLifecycleRoot, p.currentWalletCount);
    };
    const results = [];
    for (const msg of sent.filter((m) => ![fillFirst, fillSecond, primaryCare].some((r) => m === sentFor(r)))) results.push(apply(msg));
    expect(results).toEqual([undefined, undefined, undefined, undefined]);

    const misplaced = apply(sentFor(fillSecond));
    expect(misplaced).toEqual({ ledgerBehind: true, message: expect.stringMatching(/its leaf is 1 and this replica's next leaf is 0/) }); // before: undefined, the entry written at leaf 0
    expect(replica.getClaimLeafCount()).toBe(0n);   // before: 1n
    expect(apply(sentFor(fillFirst))).toBeUndefined();
    const stray = apply(sentFor(primaryCare), payloadOf(sentFor(fillFirst)).claimEntry);
    expect(stray).toEqual({ ledgerBehind: false, message: expect.stringMatching(/which made no claim/) }); // before: the stray copy of the first fill met the duplicate check only after the receipt was written, and threw
    expect(replica.getClaimLeafCount()).toBe(1n);
    expect(replica.getClaimAccumulator().getEntry(0n)?.metadata.receiptId).toBe(fillFirst.receiptId);
  });
});

/** Hold the sequencer's store write of the next receipt, which it awaits after pushing the receipt's audit event. */
function holdNextStoreWrite(seq: L2SequencerService) {
  const store = (seq as unknown as { store: InMemoryStore }).store;
  const write = store.saveProof.bind(store);
  const hold = { held: false, release: () => {} };
  jest.spyOn(store, 'saveProof').mockImplementationOnce(async (id: string, json: string) => {
    hold.held = true;
    await new Promise<void>((r) => { hold.release = r; });
    return write(id, json);
  });
  return hold;
}

describe.each(['L2Node', 'L2Leviathan'] as Kind[])("an %s leader gossips each receipt's own audit event", (kind) => {
  test("with a second submission landing while the first waits on the store, each gossiped receipt carries its own audit event, and a replica's audit chain is the leader's", async () => {
    const net = handFedNetwork(kind, `audit-${kind}`);
    const [m, n] = net.members(2);
    const ref = new Reference();
    const first = device(net.leader, ref, m);
    const second = device(net.leader, ref, n);
    for (const step of [first.register, second.register, first.mint, second.mint]) await step();

    const hold = holdNextStoreWrite(net.leaderSeq);
    const firstFill = first.fill();
    expect(await until(() => hold.held)).toBe(true);
    const secondUpdate = await second.choosePrimaryCare();   // lands whole meanwhile; its audit event follows the fill's
    hold.release();
    const fill = await firstFill;
    expect(fill.sequenceNumber).toBeLessThan(secondUpdate.sequenceNumber);

    const fillEvent = payloadOf(net.sentFor(fill)).auditEvent;
    expect(fillEvent.receiptId).toBe(fill.receiptId);      // before: the second update's, the last event of the log when the fill's gossip was built
    expect(fillEvent.chainHash).toBe(fill.auditEventHash);  // before: the second update's chain hash
    expect(payloadOf(net.sentFor(secondUpdate)).auditEvent.receiptId).toBe(secondUpdate.receiptId);

    // delivered in the leader's order, the replica holds the leader's audit chain
    const inOrder = [...net.sent].sort((x, y) => Number(payloadOf(x).receipt.sequenceNumber - payloadOf(y).receipt.sequenceNumber));
    await net.deliver(...inOrder);
    expect(auditChain(net.replicaSeq)).toEqual(auditChain(net.leaderSeq)); // before: the second update's event twice, the fill's never
    expect(net.replicaSeq.getLatestChainHash()).toBe(net.leaderSeq.getLatestChainHash());
  });

  test("a receipt whose audit event a failed batch rolled back while its proof was stored is not gossiped, where another receipt's event went with it", async () => {
    // a leader that settles on L1, the one mode in which a batch fails after it was built
    const { leader, seq, sent, sentFor } = kind === 'L2Node'
      ? (() => { const l = capturingLeader('leader-rollback'); return { ...l, seq: l.leader.getSequencer() }; })()
      : (() => { const l = capturingLeviathan('lev-leader-rollback', false); return { leader: l.lev, seq: l.lev.getSequencer(0), sent: l.sent, sentFor: l.sentFor }; })();
    const [n] = kind === 'L2Node' ? [40] : partitionZeroMembers(1);
    const member = device(leader, new Reference(), n);
    await member.register();
    const mint = await member.mint();
    // the registration and the mint go in flight as one batch, awaiting L1
    expect(seq.prepareBatch().job).not.toBeNull();
    await seq.finalizeBatch({
      batchProofJson: '{"proof":"stand-in"}',
      batchOutput: {
        oldRegistryRoot: EMPTY.toString(), newRegistryRoot: seq.getCurrentRegistryRoot().toString(),
        oldLifecycleRoot: EMPTY.toString(), newLifecycleRoot: seq.getCurrentLifecycleRoot().toString(),
        registrationCount: '1', transitionCount: '2',
      },
      proveTimeMs: 1,
      workerId: 0,
    });
    const inFlight = seq.getInFlightBatchNumber();
    expect(inFlight).not.toBeNull();

    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // the member's next update is accepted while the batch waits, and L1 refuses the batch while the update is stored
      const hold = holdNextStoreWrite(seq);
      const submitted = member.choosePrimaryCare();
      expect(await until(() => hold.held)).toBe(true);
      seq.markBatchFailed(inFlight!, 'L1 refused the batch');   // rolls the audit log back to before the batch, the update's event with it
      hold.release();
      const update = await submitted;
      expect(seq.getAuditLog().events.map((e) => e.receiptId)).not.toContain(update.receiptId);

      expect(sentFor(update)).toBeUndefined(); // before: gossiped with the mint's audit event, the last one left in the log
      expect(sentFor(mint)).toBeDefined();
      const notGossiped = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('is not gossiped'));
      expect(notGossiped).toHaveLength(1);
      expect(notGossiped[0]).toContain(`${update.receiptId} is not gossiped: a failed batch rolled its audit event back before it was sent`);
      const accepted = sent.filter((m) => m.type === 'proof:accepted');
      expect(accepted.map((m) => payloadOf(m).auditEvent.receiptId)).toEqual(accepted.map((m) => payloadOf(m).receipt.receiptId));
    } finally {
      warn.mockRestore();
    }
  });
});
