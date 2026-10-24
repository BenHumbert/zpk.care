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
 * The engine's two open writes tell a caller nothing about a member until a proof says the caller may hear it.
 *
 * What was wrong: POST /interactive/verify-credential looked the member up by the credential's publicOutput.walletId,
 * a copy src/credentials/portable-credential.ts keeps "for quick inspection" and that no verification reads. A junk
 * proof with a member's wallet in that copy answered {valid: false} with the member's display name, a wallet-to-name
 * oracle for anyone, and a credential whose proof verifies, carried with a copy that names another wallet, answered
 * valid with that other member's name and fillable prescriptions. POST /interactive/register-member answered an
 * enrolled wallet with its display name (alreadyRegistered), and said whether the insurer had approved a wallet and
 * whether the ledger held it, before it verified the device's ownership proof, so one junk proof drew a different
 * answer for each. The security review of the sweep fixes (2026-10-24) found both against the real engine and routes.
 *
 * Now verify-credential speaks only about the output the verified proof itself carries: a credential whose copy
 * differs from that output in any field is refused, and an answer for a credential that does not verify names no
 * member. register-member verifies the ownership proof before it reads anything about the wallet, so every answer
 * before that point is the same for every wallet; a device whose proof verifies still hears alreadyRegistered with
 * its name, and the truth about its own approval and its place on the ledger.
 *
 * A real L2Node sequencer and RPC server and a real AdjudicationService with the engine's routes; programs not
 * compiled, nothing proved. Where a test needs a proof that verifies, the verification is a stand-in. The credential's
 * proof is a dummy CredentialOperationProof for Alice's wallet (o1js builds one without compiling, and its JSON reads
 * back through the same fromJSON the verifier uses), serialized the way a device serializes its credential, with
 * CredentialProgram.verify answering true; without that stand-in the same proof is well formed and does not verify.
 * The device's ownership proof is answered by a stand-in for the engine's verifyOwnershipProof, as the other engine
 * suites answer it.
 */
import { Field, MerkleTree } from 'o1js';

jest.setTimeout(300_000);

const OPERATOR = 'operator-token-for-member-oracles';
/** Alice and Bob are enrolled; Erin is approved and registered on the ledger; Carol is approved and not on it; Dave is no one. */
const W = {
  alice: '81000000000000000001', bob: '81000000000000000002', erin: '81000000000000000003',
  carol: '81000000000000000004', dave: '81000000000000000005',
};
const NAMES = { alice: 'Alice Johnson', bob: 'Bob Martinez' };
/** What a device sends as its ownership proof; only the stand-in verifications read it. */
const PROOF = '{"made-on-the-device":true}';

let svc: any;
let server: any;
let url: string;
let CredentialProgram: any;
let RegistrationRefused: any;
/** Alice's portable credential, serialized from the dummy proof as a device serializes its own. */
let alice: any;

async function post(p: string, body: unknown) {
  const r = await fetch(url + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = await r.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: r.status, text, json };
}
const verifyCredential = (credential: unknown) => post('/interactive/verify-credential', { credentialJson: JSON.stringify(credential) });
const register = (walletId: string, ownershipProofJson: string) => post('/interactive/register-member', { walletId, ownershipProofJson, displayName: 'Probe' });
/** An answer without its timing, the one part that differs from call to call. */
const untimed = (answer: Record<string, unknown>) => { const { verificationTimeMs: _t, ...rest } = answer; return rest; };
/** A credential whose proof is not a proof, carrying a copy that names the given wallet. */
const junkCredential = (walletId: string) => ({ ...alice, proofJson: { junk: true }, publicOutput: { ...alice.publicOutput, walletId } });

beforeAll(async () => {
  process.env.ZKTRIDENT_FORMULARY_LIMIT = '100';
  const { InMemoryStore } = await import('../src/storage/local-store.js');
  const { WALLET_TREE_HEIGHT } = await import('../src/wallets/wallet-state.js');
  const { L2Node } = await import('../src/l2/l2-node.js');
  const { L2RpcServer } = await import('../src/l2/l2-rpc-server.js');
  const { registerInteractiveRoutes } = await import('../src/adjudication/interactive-routes.js');
  const engine = await import('../src/adjudication/interactive-service.js');
  const credentials = await import('../src/credentials/credential-program.js');
  const { serializeCredential } = await import('../src/credentials/portable-credential.js');
  const LC = await import('../src/engine/lifecycle.js');
  ({ RegistrationRefused } = engine);
  ({ CredentialProgram } = credentials);

  const emptyRoot = new MerkleTree(WALLET_TREE_HEIGHT).getRoot();
  const node = new L2Node({ batchIntervalMs: 999_999, autoSettle: false, nodeId: 'seq-member-oracles' }, new InMemoryStore(), emptyRoot, emptyRoot, Field(0));
  const seq = node.getSequencer();
  svc = new engine.AdjudicationService(() => {}, () => {}, node);
  svc.compiled = true;
  // Nothing is compiled: stand-ins for the two verification keys the routes look for before they read a proof. No
  // proof here reaches a verification that would use either.
  svc.proofGateVk = 'not compiled';
  svc.credentialProgramVk = 'not compiled';

  const ndcHash = svc.medByNdcHash.keys().next().value;
  for (const [who, walletId] of [['alice', W.alice], ['bob', W.bob]] as const) {
    const wid = Field(BigInt(walletId));
    seq.adminMutate('test', ({ provision }: any) => { provision(wid, LC.LIFECYCLE_ELIGIBLE); });
    svc.enrolledMembers.set(walletId, { memberIndex: -1, walletId: wid, walletIdStr: walletId, displayName: NAMES[who], lifecycle: 'ELIGIBLE' });
    svc.prescriptions.set(`RX-ORACLE-${who.toUpperCase()}`, {
      id: `RX-ORACLE-${who.toUpperCase()}`, memberWalletId: walletId, ndcHash, pharmacyIndex: 0, prescriberIndex: 0,
      quantity: 30, quantityDispensed: 0, status: 'ADJUDICATED', refills: 0, refillsUsed: 0, statusHistory: [],
    });
  }
  for (const walletId of [W.erin, W.carol]) {
    svc.approveMember({ walletId, groupIdHash: '777', planIdHash: '888', planId: 'PLAN-ORACLE', employerId: null, familyIdHash: null });
  }
  seq.adminMutate('test', ({ provision }: any) => { provision(Field(BigInt(W.erin)), LC.LIFECYCLE_REGISTERED); });

  const output = new credentials.CredentialOperationOutput({
    walletId: Field(BigInt(W.alice)), operationType: Field(2), credentialCommitment: Field(4242), oldInventoryRoot: Field(5151), newInventoryRoot: Field(5151),
  });
  const proof = await credentials.CredentialOperationProof.dummy(undefined, output, 1);
  alice = JSON.parse(JSON.stringify(serializeCredential(proof, 'credential-type-holding', Field(0), 0)));
  expect(alice.publicOutput.walletId).toBe(W.alice);

  server = new L2RpcServer(node, { port: 0, host: '127.0.0.1', adminToken: OPERATOR, enableSSE: false });
  registerInteractiveRoutes(server, svc);
  await server.start();
  url = `http://127.0.0.1:${server.getPort()}`;
});

afterAll(async () => { await server?.stop(); });

describe('verify-credential', () => {
  test('a credential that does not verify names no member, and is answered alike whichever wallet its copy names', async () => {
    // a proof that is not one, and a well-formed proof of Alice's wallet that does not verify (no stand-in here)
    for (const credential of [junkCredential(W.alice), alice]) {
      const r = await verifyCredential(credential);
      expect(r.status).toBe(200);
      expect(r.json.valid).toBe(false);
      expect(r.json.memberDisplayName).toBeUndefined();                       // before: 'Alice Johnson'
      expect(r.text).not.toContain(NAMES.alice);                              // before: her name
      expect(r.text).not.toContain(W.alice);                                  // before: her wallet, in the copy the answer echoed
    }
    const forAlice = await verifyCredential(junkCredential(W.alice));
    const forDave = await verifyCredential(junkCredential(W.dave));
    expect(untimed(forAlice.json)).toEqual(untimed(forDave.json));            // before: Alice's answer carried her name and wallet
  });

  test('a proof that verifies, carried with a copy that names another wallet or alters any field, is refused and names neither member (stand-in verification)', async () => {
    const verified = jest.spyOn(CredentialProgram, 'verify').mockResolvedValue(true);
    try {
      const swapped = await verifyCredential({ ...alice, publicOutput: { ...alice.publicOutput, walletId: W.bob } });
      expect(verified).toHaveBeenCalled();
      expect(swapped.status).toBe(200);
      expect(swapped.json.valid).toBe(false);                                 // before: true
      expect(swapped.json.reason).toMatch(/not the output its proof carries/);  // before: no reason, a valid answer
      expect(swapped.text).not.toContain(NAMES.bob);                          // before: Bob's name
      expect(swapped.text).not.toContain('RX-ORACLE-BOB');                    // before: Bob's fillable prescription
      expect(swapped.text).not.toContain(W.bob);                              // before: memberWalletId, Bob's wallet
      expect(swapped.text).not.toContain(NAMES.alice);
      expect(swapped.text).not.toContain('RX-ORACLE-ALICE');
      for (const field of ['operationType', 'credentialCommitment', 'oldInventoryRoot', 'newInventoryRoot']) {
        const altered = await verifyCredential({ ...alice, publicOutput: { ...alice.publicOutput, [field]: '999' } });
        expect(altered.json.valid).toBe(false);                               // before: true, with the altered copy echoed as the proof's output
        expect(altered.text).not.toContain(NAMES.alice);                      // before: her name
      }
    } finally {
      verified.mockRestore();
    }
  });

  test('a proof that verifies, with a copy that matches it, still answers valid with its member\'s name and fillable prescriptions (stand-in verification)', async () => {
    const verified = jest.spyOn(CredentialProgram, 'verify').mockResolvedValue(true);
    try {
      const r = await verifyCredential(alice);
      expect(r.status).toBe(200);
      expect(r.json).toMatchObject({ valid: true, memberDisplayName: NAMES.alice, memberWalletId: W.alice, publicOutput: alice.publicOutput, proofType: 'credential-type-holding' });
      expect(r.json.memberPrescriptions.map((p: { id: string }) => p.id)).toEqual(['RX-ORACLE-ALICE']);
    } finally {
      verified.mockRestore();
    }
  });
});

describe('register-member', () => {
  test('a junk ownership proof draws one answer for an enrolled, an approved-not-on-ledger and an unknown wallet, and no name', async () => {
    const answers = [];
    for (const walletId of [W.alice, W.carol, W.dave]) answers.push(await register(walletId, '{"junk":true}'));
    expect(answers[0].text).not.toContain(NAMES.alice);                       // before: 200 {alreadyRegistered: true, displayName: 'Alice Johnson'}
    expect(answers.map((a) => a.status)).toEqual([400, 400, 400]);            // before: [200, 409, 403]
    expect(new Set(answers.map((a) => a.text)).size).toBe(1);                 // before: three different answers
    expect(answers[0].json.error).toMatch(/^The ownership proof could not be read/);  // before: no error, Alice's 200
    expect(svc.enrolledMembers.has(W.carol) || svc.enrolledMembers.has(W.dave)).toBe(false);
  });

  test('an ownership proof that does not verify is refused alike for every wallet, checked before anything about the wallet is read', async () => {
    const proofCheck = jest.spyOn(svc, 'verifyOwnershipProof').mockRejectedValue(new RegistrationRefused(403, 'The ownership proof does not verify'));
    try {
      const answers = [];
      for (const walletId of [W.alice, W.erin, W.carol, W.dave]) answers.push(await register(walletId, PROOF));
      expect(proofCheck).toHaveBeenCalledTimes(4);                            // before: once, for Erin, the one wallet approved and on the ledger
      expect(answers.map((a) => a.status)).toEqual([403, 403, 403, 403]);     // before: [200, 403, 409, 403]
      expect(new Set(answers.map((a) => a.text)).size).toBe(1);               // before: four different answers, the first with Alice's name
      expect(answers[0].json).toEqual({ error: 'The ownership proof does not verify' });  // before: Alice's alreadyRegistered with her name
    } finally {
      proofCheck.mockRestore();
    }
  });

  test('a device whose proof verifies still hears alreadyRegistered with its name, and the truth about its own wallet', async () => {
    const proofCheck = jest.spyOn(svc, 'verifyOwnershipProof').mockImplementation(async (_walletId: unknown, json: unknown) => json);
    try {
      const enrolled = await register(W.alice, PROOF);
      expect(enrolled.status).toBe(200);
      expect(enrolled.json).toEqual({ walletId: W.alice, displayName: NAMES.alice, alreadyRegistered: true });
      const early = await register(W.carol, PROOF);
      expect(early.status).toBe(409);
      expect(early.json.error).toMatch(/not registered on the ledger yet/);
      const stranger = await register(W.dave, PROOF);
      expect(stranger.status).toBe(403);
      expect(stranger.json.error).toMatch(/no insurer approval/);
    } finally {
      proofCheck.mockRestore();
    }
  });
});
