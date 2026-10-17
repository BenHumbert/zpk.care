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
 * Registry consistency — the sequencer's wallet trees are the only copy of wallet state,
 * and the published roots always equal those trees' roots.
 *
 * Regression for the multi-member failure found in the live end-to-end run: the
 * adjudication engine kept a private registry, edited a wallet leaf without a proof,
 * then pushed its own root over the sequencer's (applyAdminRootUpdate). The sequencer's
 * tree stopped hashing to its root, so every later registration and fill failed with
 * "Registry slot is not empty" / root mismatch.
 *
 * No circuits are compiled: transitions are mock proofs whose roots come from an
 * independent reference model of the trees.
 *
 * Run: npx jest tests/registry-consistency.test.ts
 */
import { Field, MerkleTree, Poseidon } from 'o1js';
import { generateKeyPairSync, sign as edSign } from 'crypto';
import { L2SequencerService } from '../src/l2/l2-sequencer-service.js';
import { InMemoryStore } from '../src/storage/local-store.js';
import { WalletRegistry, WalletState, WalletRegistryWitness, WALLET_TREE_HEIGHT } from '../src/wallets/wallet-state.js';
import {
  lifecycleLeafCommitment, LifecycleWitness, LIFECYCLE_REGISTERED, LIFECYCLE_ELIGIBLE,
} from '../src/engine/lifecycle.js';
import { TransitionOutput } from '../src/engine/state-transition.js';
import { NautilusAppServer } from '../src/nodes/nautilus-app-server.js';

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
const credRoot = (n: number) => Poseidon.hash([Field(99), Field(n)]);

function newSequencer() {
  const empty = new MerkleTree(WALLET_TREE_HEIGHT).getRoot();
  return new L2SequencerService(new InMemoryStore(), empty, empty, Field(0), 60_000, true);
}

/** Every wallet witness, and the empty next-slot witness, must hash to the published root. */
function expectWitnessesMatchRoot(seq: L2SequencerService, wallets: Field[]) {
  expect(seq.treesMatchRoots()).toBe(true);
  const root = seq.getCurrentRegistryRoot().toString();
  const next = seq.getRegistrationWitnesses();
  const nextWitness = WalletRegistryWitness.fromJSON(JSON.parse(next.registryWitnessJson));
  expect(nextWitness.calculateRoot(Field(0)).toString()).toBe(root);
  expect(next.currentRegistryRoot).toBe(root);
  for (const w of wallets) {
    const ws = seq.getWalletWitnesses(w.toString());
    const state = seq.getWalletStateForRpc(w.toString());
    const leaf = new WalletState({
      walletId: w,
      credentialInventoryRoot: Field(BigInt(state.credentialInventoryRoot)),
      nonce: Field(BigInt(state.nonce)),
    }).commitment();
    expect(WalletRegistryWitness.fromJSON(JSON.parse(ws.registryWitnessJson)).calculateRoot(leaf).toString()).toBe(root);
  }
}

describe('Registry consistency — one copy of wallet state', () => {
  test('a fresh sequencer starts with trees that match its roots', () => {
    expect(newSequencer().treesMatchRoots()).toBe(true);
  });

  test('provisioning seed providers through adminMutate takes roots from the trees', () => {
    const seq = newSequencer();
    const ref = new Reference();
    const providers = [wallet(1), wallet(2), wallet(3)];
    seq.adminMutate('seed', ({ provision }) => providers.forEach(p => provision(p, LIFECYCLE_ELIGIBLE)));
    providers.forEach(p => ref.provision(p, LIFECYCLE_ELIGIBLE));
    expect(seq.getCurrentRegistryRoot().toString()).toBe(ref.roots().reg.toString());
    expect(seq.getCurrentLifecycleRoot().toString()).toBe(ref.roots().lc.toString());
    expectWitnessesMatchRoot(seq, providers);
    // Idempotent: a session reset re-provisions without re-registering.
    seq.adminMutate('seed again', ({ provision }) => providers.forEach(p => provision(p, LIFECYCLE_ELIGIBLE)));
    expect(seq.getCurrentRegistryRoot().toString()).toBe(ref.roots().reg.toString());
  });

  test('six members register, become eligible, get a credential and file fills — every witness matches the root throughout', async () => {
    const seq = newSequencer();
    const ref = new Reference();
    const providers = [wallet(1), wallet(2)];
    seq.adminMutate('seed', ({ provision }) => providers.forEach(p => provision(p, LIFECYCLE_ELIGIBLE)));
    providers.forEach(p => ref.provision(p, LIFECYCLE_ELIGIBLE));
    const members: Field[] = [];

    for (let m = 0; m < 6; m++) {
      const w = wallet(100 + m);
      // 1. Member's own registration proof.
      let before = ref.roots(); ref.register(w);
      await seq.submitProof(mockProof(w, before, ref.roots()));
      members.push(w);
      expectWitnessesMatchRoot(seq, [...providers, ...members]);
      // 2. Insurer marks the wallet ELIGIBLE (admin op).
      seq.adminMutate('eligible', ({ setLifecycle }) => setLifecycle(w, LIFECYCLE_ELIGIBLE));
      ref.provision(w, LIFECYCLE_ELIGIBLE);
      expect(seq.getCurrentLifecycleRoot().toString()).toBe(ref.roots().lc.toString());
      // 3. Credential mint: a proven wallet update that carries the new credential root.
      before = ref.roots(); ref.update(w, credRoot(m));
      await seq.submitProof(mockProof(w, before, ref.roots()), { newCredentialInventoryRoot: credRoot(m).toString() } as any);
      expectWitnessesMatchRoot(seq, [...providers, ...members]);
      // 4. Fills for every member so far (wallet updates on older leaves too).
      for (const [i, other] of members.entries()) {
        before = ref.roots(); ref.update(other, credRoot(1000 + m * 10 + i));
        await seq.submitProof(mockProof(other, before, ref.roots()), { newCredentialInventoryRoot: credRoot(1000 + m * 10 + i).toString() } as any);
      }
      expectWitnessesMatchRoot(seq, [...providers, ...members]);
    }
    expect(seq.getCurrentRegistryRoot().toString()).toBe(ref.roots().reg.toString());
    expect(seq.getWalletStateForRpc(members[0].toString()).nonce).toBe('7');   // 1 mint + 6 fills
  });

  test('the old pattern — editing a private copy and pushing its root — is refused', async () => {
    const seq = newSequencer();
    const ref = new Reference();
    const w = wallet(500);
    let before = ref.roots(); ref.register(w);
    await seq.submitProof(mockProof(w, before, ref.roots()));
    const goodRoot = seq.getCurrentRegistryRoot().toString();

    // A private registry edits the leaf without a proof (nonce 0 → 1) …
    const privateCopy = new Reference();
    privateCopy.register(w);
    privateCopy.update(w, credRoot(1));
    // … and tries to publish its root.
    expect(() => seq.applyAdminRootUpdate({ newRegistryRoot: privateCopy.roots().reg })).toThrow(/does not match the sequencer's tree/);
    expect(seq.getCurrentRegistryRoot().toString()).toBe(goodRoot);
    expectWitnessesMatchRoot(seq, [w]);

    // The next registration still succeeds (it failed with "Registry slot is not empty" before).
    const w2 = wallet(501);
    before = ref.roots(); ref.register(w2);
    await expect(seq.submitProof(mockProof(w2, before, ref.roots()))).resolves.toBeDefined();
    expectWitnessesMatchRoot(seq, [w, w2]);
  });

  test('a wallet update must say what the new credential root is, and it must match the proof', async () => {
    const seq = newSequencer();
    const ref = new Reference();
    const w = wallet(600);
    let before = ref.roots(); ref.register(w);
    await seq.submitProof(mockProof(w, before, ref.roots()));
    const stable = seq.getCurrentRegistryRoot().toString();

    before = ref.roots(); ref.update(w, credRoot(5));
    const after = ref.roots();
    await expect(seq.submitProof(mockProof(w, before, after))).rejects.toThrow(/newCredentialInventoryRoot/);
    await expect(seq.submitProof(mockProof(w, before, { reg: Poseidon.hash([Field(1)]), lc: after.lc }), { newCredentialInventoryRoot: credRoot(5).toString() } as any))
      .rejects.toThrow(/does not match the sequencer tree/);
    expect(seq.getCurrentRegistryRoot().toString()).toBe(stable);
    expectWitnessesMatchRoot(seq, [w]);
  });

  test('two registrations prepared against the same root: the second is refused with a root mismatch and succeeds after re-proving', async () => {
    const seq = newSequencer();
    const ref = new Reference();
    const a = wallet(700), b = wallet(701);
    const start = ref.roots();
    // Both members fetched witnesses at the same moment.
    const refA = new Reference(); refA.register(a);
    const refB = new Reference(); refB.register(b);
    await seq.submitProof(mockProof(a, start, refA.roots()));
    await expect(seq.submitProof(mockProof(b, start, refB.roots()))).rejects.toThrow(/root mismatch/i);
    // Member B fetches fresh witnesses and proves again.
    ref.register(a);
    const before = ref.roots(); ref.register(b);
    await expect(seq.submitProof(mockProof(b, before, ref.roots()))).resolves.toBeDefined();
    expectWitnessesMatchRoot(seq, [a, b]);
  });

  test('admin changes keep pending transitions so they are still batch-proven', async () => {
    const seq = newSequencer();
    const ref = new Reference();
    const w = wallet(800);
    const before = ref.roots(); ref.register(w);
    await seq.submitProof(mockProof(w, before, ref.roots()));
    expect(seq.getPendingCount()).toBe(1);
    seq.adminMutate('eligible', ({ setLifecycle }) => setLifecycle(w, LIFECYCLE_ELIGIBLE));
    expect(seq.getPendingCount()).toBe(1);   // the old code purged it as "admin-settled"
  });

  test('syncWalletState cannot rewrite the tree to a state that does not reproduce the root', async () => {
    const seq = newSequencer();
    const ref = new Reference();
    const w = wallet(900);
    const before = ref.roots(); ref.register(w);
    await seq.submitProof(mockProof(w, before, ref.roots()));
    const forged = new WalletState({ walletId: w, credentialInventoryRoot: credRoot(66), nonce: Field(9) });
    expect(() => seq.syncWalletState(w, forged)).toThrow(/refused/);
    expectWitnessesMatchRoot(seq, [w]);
  });
});

describe("Insurer admin auth — an employer's key is not an insurer credential", () => {
  function insurerServer() {
    return new NautilusAppServer({
      role: 'insurer', port: 0, host: '127.0.0.1', sequencerUrl: 'http://127.0.0.1:1', stateDir: '.',
      enableSSE: false, maxSseConnections: 0, allowedOrigins: [], adminToken: 'insurer-secret',
    } as any);
  }
  const req = (headers: Record<string, string>) => ({ headers } as any);
  const check = (server: NautilusAppServer, headers: Record<string, string>) =>
    (server as any).checkNautilusAdminAuth(req(headers), 'POST', '/plans');

  test('the insurer token keeps working after an employer signs its agreement', () => {
    const server = insurerServer();
    const { publicKey } = generateKeyPairSync('ed25519');
    server.registerPartnerKey('EMP-1', (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(12).toString('hex'));
    expect(check(server, { authorization: 'Bearer insurer-secret' })).toBe(true);
  });

  test("an employer's signature does not authorize insurer admin routes", () => {
    const server = insurerServer();
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    server.registerPartnerKey('EMP-1', (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(12).toString('hex'));
    const ts = Date.now().toString();
    const sig = edSign(null, Buffer.from(`POST:/plans|${ts}|`), privateKey).toString('hex');
    expect(check(server, { 'x-admin-signature': `EMP-1:${ts}:${sig}` })).toBe(false);
    expect(server.getPartnerKey('EMP-1')).toBeDefined();
  });
});
