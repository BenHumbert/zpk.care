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
 * Measures what verifying a state-transition proof costs, and confirms that a tampered
 * proof fails verification. Both numbers matter for phase A item A1: verification now sits
 * on the submit path, so if it is slow it becomes the sequencer's throughput limit, and
 * the sequencer's own 30-second request timeout will cut submissions short.
 *
 * Also writes the generated proof to a file so that submission can be retested without
 * paying to prove again.
 *
 * Usage:
 *   npx tsx scripts/e2e-verify/measure-verify.ts [outFile]
 *   E2E_SEQ   sequencer base URL (default http://localhost:3030)
 */
import crypto from 'crypto';
import fs from 'fs';
import { Field, verify } from 'o1js';
import { StateTransitionProgram } from '../../src/engine/state-transition.js';
import { WalletRegistryWitness } from '../../src/wallets/wallet-state.js';
import { LifecycleWitness } from '../../src/engine/lifecycle.js';
import { hashString } from '../../src/zkp/hash-utils.js';

const SEQ = process.env.E2E_SEQ ?? 'http://localhost:3030';
const OUT = process.argv[2];

async function main(): Promise<void> {
  const resp = await fetch(`${SEQ}/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'l2_getRegistrationWitnesses', params: {} }),
  });
  const w = (await resp.json()).result;
  if (!w) throw new Error('no witnesses from the sequencer');

  const t0 = Date.now();
  const { verificationKey } = await StateTransitionProgram.compile();
  console.log(`compile          ${Date.now() - t0} ms`);
  console.log(`vk hash          ${verificationKey.hash.toString()}`);

  const pre = [
    Field(0),
    hashString(`MEASURE-${Date.now()}`),
    hashString('19700101'),
    hashString('Meas'),
    hashString('Ure'),
    hashString(crypto.randomBytes(32).toString('base64url')),
    Field(0),
  ];

  const t1 = Date.now();
  const { proof } = await StateTransitionProgram.proveRegistration(
    pre[0], pre[1], pre[2], pre[3], pre[4], pre[5], pre[6],
    WalletRegistryWitness.fromJSON(JSON.parse(w.registryWitnessJson)),
    LifecycleWitness.fromJSON(JSON.parse(w.lifecycleWitnessJson)),
    Field(w.currentRegistryRoot),
    Field(w.currentLifecycleRoot),
  );
  console.log(`prove            ${Date.now() - t1} ms`);

  const json = proof.toJSON();
  console.log(`proof size       ${JSON.stringify(json).length} bytes json, ${json.proof.length} chars base64`);
  if (OUT) {
    fs.writeFileSync(OUT, JSON.stringify(json));
    console.log(`saved            ${OUT}`);
  }

  for (let i = 1; i <= 3; i++) {
    const t = Date.now();
    const ok = await verify(proof, verificationKey);
    console.log(`verify #${i}        ${ok} in ${Date.now() - t} ms`);
  }

  // The case the gate exists for: public output altered, proof bytes untouched.
  const tampered = JSON.parse(JSON.stringify(json));
  tampered.publicOutput[0] = (BigInt(tampered.publicOutput[0]) + 1n).toString();
  const t3 = Date.now();
  let badOk: boolean;
  try {
    badOk = await verify(tampered, verificationKey);
  } catch (err) {
    console.log(`verify tampered  threw after ${Date.now() - t3} ms: ${err instanceof Error ? err.message : err}`);
    return;
  }
  console.log(`verify tampered  ${badOk} in ${Date.now() - t3} ms   <-- must be false`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
