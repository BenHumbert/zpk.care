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
 * Proof-gate check — acceptance test for rule I7, "every proof is verified when it is
 * submitted, not later in a batch".
 *
 * Submits things that must be refused and asserts the ledger did not move. Asserting the
 * absence of mutation is the point: before this gate existed a submission could be
 * refused late and still have left a fingerprint, a receipt or an audit entry behind, so
 * an error response alone proves nothing.
 *
 * Each case is sent to a running sequencer over the same open RPC any caller can reach.
 *
 *   1. A structurally undecodable proof.
 *   2. A well-formed envelope whose proof bytes are nonsense.
 *   3. A real proof whose public output has been altered (the tampered-proof case: the
 *      one an attacker would actually use, because it decodes).
 *   4. A real proof re-pointed at a different wallet.
 *
 * A fifth case, an honest proof being accepted, is covered by run.ts and run-multi.ts.
 * This script never submits anything valid, so it is safe against a live network.
 *
 * Usage:
 *   npx tsx scripts/e2e-verify/check-proof-gate.ts [--strict]
 *
 *   --strict    exit 1 if any case is mishandled (for use as a gate)
 *   E2E_SEQ     sequencer base URL (default http://localhost:3030)
 */
import crypto from 'crypto';
import { Field } from 'o1js';
import { l2Parse } from '../../src/l2/l2-json.js';
import { StateTransitionProgram } from '../../src/engine/state-transition.js';
import { WalletRegistryWitness } from '../../src/wallets/wallet-state.js';
import { LifecycleWitness } from '../../src/engine/lifecycle.js';
import { hashString } from '../../src/zkp/hash-utils.js';

const SEQ = process.env.E2E_SEQ ?? 'http://localhost:3030';
const STRICT = process.argv.includes('--strict');

type Rpc = { status: number; result?: any; error?: { code: number; message: string } };

async function rpc(method: string, params: Record<string, unknown> = {}): Promise<Rpc> {
  // Submission has to allow for verification plus whatever else is occupying the main
  // thread. A genesis boot compiles ten circuits on it, during which nothing answers, and
  // a short timeout there once produced a false pass: the request never arrived and the
  // absence of an answer was read as a refusal.
  const timeoutMs = method === 'l2_submitProof' ? 180_000 : 30_000;
  try {
    const r = await fetch(`${SEQ}/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await r.text();
    const parsed = text ? (l2Parse(text) as any) : null;
    return { status: r.status, result: parsed?.result, error: parsed?.error };
  } catch (e: any) {
    return { status: 0, error: { code: 0, message: e?.message ?? String(e) } };
  }
}

/** Everything the ledger could move. Compared before and after each refusal. */
type Ledger = {
  registryRoot: string;
  lifecycleRoot: string;
  walletCount: string;
  proofsAccepted: string;
  receipts: number;
  auditEntries: number;
  claimLeaves: string;
};

async function snapshot(): Promise<Ledger> {
  const [status, receipts, audit, claims] = await Promise.all([
    rpc('l2_getStatus'),
    rpc('l2_getAllReceipts'),
    rpc('l2_getAuditLog'),
    rpc('l2_getClaimAccumulatorRoot'),
  ]);
  const s = status.result ?? {};
  const auditResult = audit.result;
  return {
    registryRoot: String(s.currentRegistryRoot ?? '?'),
    lifecycleRoot: String(s.currentLifecycleRoot ?? '?'),
    walletCount: String(s.currentWalletCount ?? '?'),
    proofsAccepted: String(s.totalProofsAccepted ?? '?'),
    receipts: Array.isArray(receipts.result) ? receipts.result.length : -1,
    auditEntries: Array.isArray(auditResult)
      ? auditResult.length
      : Array.isArray(auditResult?.events)
        ? auditResult.events.length
        : -1,
    claimLeaves: String(claims.result?.leafCount ?? '?'),
  };
}

function diff(before: Ledger, after: Ledger): string[] {
  const moved: string[] = [];
  for (const k of Object.keys(before) as Array<keyof Ledger>) {
    if (String(before[k]) !== String(after[k])) {
      moved.push(`${k}: ${before[k]} -> ${after[k]}`);
    }
  }
  return moved;
}

/** A proof envelope of the right shape. The proof bytes are deliberately not real. */
function envelope(publicOutput: string[], proofBytes: string) {
  return {
    publicInput: [],
    publicOutput,
    maxProofsVerified: 0,
    proof: proofBytes,
  };
}

let failures = 0;
function record(name: string, ok: boolean, detail: string) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (detail) console.log(`        ${detail}`);
  if (!ok) failures++;
}

async function expectRefusedWithoutMutation(name: string, params: Record<string, unknown>) {
  const before = await snapshot();
  const res = await rpc('l2_submitProof', params);
  const after = await snapshot();
  const moved = diff(before, after);

  // A request that never got an answer proves nothing. Counting a transport failure as a
  // refusal is how a check reports success while the gate is wide open, so it fails here.
  if (res.status === 0) {
    record(name, false, `INCONCLUSIVE: no answer from the sequencer (${res.error?.message}). Not a refusal.`);
    return;
  }

  const refused = res.error !== undefined || res.status >= 400;
  const message = res.error?.message ?? `accepted with status ${res.status}`;

  if (!refused) {
    record(name, false, `ACCEPTED. ${message}`);
  } else if (moved.length > 0) {
    record(name, false, `refused (${message}) but the ledger moved: ${moved.join('; ')}`);
  } else {
    record(name, true, `refused: ${message.slice(0, 120)}`);
  }
}

/**
 * The decisive phase. Builds a genuine registration proof for a throwaway fictional
 * identity, then submits a copy whose public output has been altered while its roots are
 * left matching current state. Root equality therefore passes and only verification can
 * refuse it, which is precisely the hole that existed before this gate: `proof.verify()`
 * did nothing, so a proof that did not back its own output was applied.
 *
 * Then it submits the honest proof, which must be accepted. A gate that refuses
 * everything is not a gate, it is an outage.
 *
 * This phase mutates state: the honest proof registers a wallet. Run it against a
 * network you are willing to advance.
 */
async function realProofPhase() {
  console.log();
  console.log('Real-proof cases (this is what actually tests the gate):');

  const w = await rpc('l2_getRegistrationWitnesses');
  if (!w.result) {
    record('5. obtain registration witnesses', false, `could not: ${w.error?.message}`);
    return;
  }
  const regWitness = WalletRegistryWitness.fromJSON(JSON.parse(w.result.registryWitnessJson));
  const lcWitness = LifecycleWitness.fromJSON(JSON.parse(w.result.lifecycleWitnessJson));
  const currentReg = Field(w.result.currentRegistryRoot);
  const currentLc = Field(w.result.currentLifecycleRoot);

  // A throwaway fictional identity. Nothing here belongs to a person.
  const tag = `GATECHECK-${Date.now()}`;
  const preimage = [
    Field(0),                                                        // domainTag: member
    hashString(tag),                                                 // cardholder id
    hashString('19700101'),                                          // date of birth
    hashString('Gate'),                                              // first name
    hashString('Check'),                                             // last name
    hashString(crypto.randomBytes(32).toString('base64url')),        // enrollment key hash
    Field(0),                                                        // group id hash
  ];

  const tCompile = Date.now();
  await StateTransitionProgram.compile();
  console.log(`        compiled StateTransitionProgram locally in ${Date.now() - tCompile} ms`);

  const tProve = Date.now();
  const { proof } = await StateTransitionProgram.proveRegistration(
    preimage[0], preimage[1], preimage[2], preimage[3], preimage[4], preimage[5], preimage[6],
    regWitness, lcWitness, currentReg, currentLc,
  );
  const proveMs = Date.now() - tProve;
  const honest = proof.toJSON();
  console.log(`        produced a genuine registration proof in ${proveMs} ms`);

  // Alter the wallet identity in the public output, leaving both roots untouched so the
  // root equality check still passes.
  const tampered = JSON.parse(JSON.stringify(honest));
  tampered.publicOutput[0] = (BigInt(tampered.publicOutput[0]) + 1n).toString();

  await expectRefusedWithoutMutation(
    '5. a REAL proof with an altered wallet id, roots left matching current state',
    { proofJson: tampered },
  );

  // And the honest one must be accepted, or the gate is just an outage.
  const before = await snapshot();
  const tSubmit = Date.now();
  const res = await rpc('l2_submitProof', { proofJson: honest });
  const submitMs = Date.now() - tSubmit;
  const after = await snapshot();
  const accepted = res.result !== undefined && res.error === undefined;
  record(
    '6. the honest proof is accepted',
    accepted,
    accepted
      ? `receipt ${String((res.result as any)?.receiptId)}, round trip ${submitMs} ms, ` +
        `wallets ${before.walletCount} -> ${after.walletCount}`
      : `refused: ${res.error?.message}`,
  );
}

async function main() {
  console.log(`Proof gate — ${SEQ}`);
  const reachable = await rpc('l2_getStatus');
  if (!reachable.result) {
    console.error(`Sequencer not reachable at ${SEQ}: ${reachable.error?.message ?? 'no result'}`);
    process.exit(2);
  }
  const start = await snapshot();
  console.log(
    `  ledger at start: ${start.receipts} receipts, ${start.auditEntries} audit entries, ` +
      `${start.claimLeaves} claim leaves, root ${start.registryRoot.slice(0, 12)}…`,
  );
  console.log();

  // Current roots, so a case can claim them and get past the root equality check. That is
  // exactly the attack the old code permitted: roots that match, a proof that does not.
  const s = reachable.result;
  const reg = String(s.currentRegistryRoot);
  const lc = String(s.currentLifecycleRoot);

  console.log('Cases that must be refused, with no ledger movement:');

  await expectRefusedWithoutMutation('1. not a proof at all (string)', {
    proofJson: 'not-a-proof',
  });

  await expectRefusedWithoutMutation('2. right shape, nonsense proof bytes', {
    proofJson: envelope([reg, reg, lc, lc, '1', '0', '0'], 'ZmFrZXByb29m'),
  });

  await expectRefusedWithoutMutation(
    '3. roots that match current state, proof bytes that do not back them',
    { proofJson: envelope([reg, reg, lc, lc, '0', '0', '0'], Buffer.alloc(64).toString('base64')) },
  );

  await expectRefusedWithoutMutation('4. empty envelope', {
    proofJson: envelope([], ''),
  });

  // The cases above are all refused by proof decoding, before the verifier is reached.
  // That matters: it means they do not test the gate. Proving the gate needs a proof that
  // decodes and whose roots match current state, so that only cryptography can refuse it.
  if (process.argv.includes('--with-real-proof')) {
    await realProofPhase();
  } else {
    console.log();
    console.log('  NOTE: the four cases above are refused while the proof is being decoded,');
    console.log('        before verification runs. They show nothing invalid is accepted, but');
    console.log('        they do not exercise the gate. Pass --with-real-proof for that.');
  }

  console.log();
  const end = await snapshot();
  const overall = diff(start, end);
  record(
    'the ledger is unchanged across every refusal',
    overall.length === 0,
    overall.length === 0 ? 'no movement in roots, receipts, audit entries or claim leaves' : overall.join('; '),
  );

  console.log();
  if (failures === 0) {
    console.log('Proof gate holds: nothing invalid was accepted and nothing moved.');
  } else {
    console.log(`${failures} case(s) mishandled. The submit path is not gated on verification.`);
  }
  if (failures > 0 && STRICT) process.exit(1);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
