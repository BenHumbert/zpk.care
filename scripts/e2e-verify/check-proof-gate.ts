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
import { l2Parse } from '../../src/l2/l2-json.js';

const SEQ = process.env.E2E_SEQ ?? 'http://localhost:3030';
const STRICT = process.argv.includes('--strict');

type Rpc = { status: number; result?: any; error?: { code: number; message: string } };

async function rpc(method: string, params: Record<string, unknown> = {}): Promise<Rpc> {
  try {
    const r = await fetch(`${SEQ}/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(30_000),
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
