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
 * Verification worker — verifies submitted state-transition proofs in its own process.
 *
 * Why a separate process at all. The sequencer's main process mounts the adjudication
 * engine, which compiles ten ZkPrograms into o1js's single global proving context. After
 * that, every further o1js operation in that process stalls indefinitely. Both halves were
 * measured on 2026-10-17: with verification set up before the engine, the compile succeeds
 * and the first verification never returns; set up after the engine, the compile itself
 * never returns and the boot hangs. Standalone, in a clean process, the same verification
 * takes about a second.
 *
 * This is the same wall that put batch proving into `l2-proving-worker.ts`, approached from
 * the other side. The fix is the same: a process with its own context, which does nothing
 * else.
 *
 * The parent sends the proof exactly as the client serialized it, so nothing is re-encoded
 * on the way in and a transport fault can only make a proof fail, never pass.
 */
import { verify } from 'o1js';
import { StateTransitionProgram } from '../engine/state-transition.js';

/** Parent to worker. */
export type VerifyRequest =
  | { type: 'compile'; expectedVkHash?: string }
  | { type: 'verify'; id: string; proofJson: unknown }
  | { type: 'shutdown' };

/** Worker to parent. */
export type VerifyResponse =
  | { type: 'ready'; vkHash: string; compileMs: number }
  | { type: 'compile-failed'; message: string }
  | { type: 'result'; id: string; valid: boolean; verifyMs: number }
  | { type: 'error'; id: string; message: string; undecodable: boolean };

function send(msg: VerifyResponse): void {
  if (process.send) process.send(msg);
}

let verificationKey: Awaited<ReturnType<typeof StateTransitionProgram.compile>>['verificationKey'] | null = null;

async function onCompile(expectedVkHash?: string): Promise<void> {
  try {
    const startedAt = Date.now();
    const compiled = await StateTransitionProgram.compile();
    verificationKey = compiled.verificationKey;
    const vkHash = verificationKey.hash.toString();

    if (expectedVkHash && expectedVkHash !== vkHash) {
      send({
        type: 'compile-failed',
        message:
          `verification key mismatch: expected ${expectedVkHash}, compiled ${vkHash}. ` +
          'Refusing, because verifying against an unexpected key verifies the wrong program.',
      });
      return;
    }
    send({ type: 'ready', vkHash, compileMs: Date.now() - startedAt });
  } catch (err: unknown) {
    send({ type: 'compile-failed', message: err instanceof Error ? err.message : String(err) });
  }
}

async function onVerify(id: string, proofJson: unknown): Promise<void> {
  if (!verificationKey) {
    send({ type: 'error', id, message: 'worker has no verification key', undecodable: false });
    return;
  }
  const startedAt = Date.now();
  try {
    // `verify` accepts the serialized form directly, so the proof is checked in exactly the
    // shape the client sent rather than a re-encoding of it.
    const valid = await verify(proofJson as never, verificationKey);
    send({ type: 'result', id, valid, verifyMs: Date.now() - startedAt });
  } catch (err: unknown) {
    // A throw here means the bytes could not be decoded as a proof of this program, which
    // is a different signal from a proof that decodes and is simply not valid.
    send({
      type: 'error',
      id,
      message: err instanceof Error ? err.message : String(err),
      undecodable: true,
    });
  }
}

process.on('message', (msg: VerifyRequest) => {
  switch (msg.type) {
    case 'compile':
      void onCompile(msg.expectedVkHash);
      break;
    case 'verify':
      void onVerify(msg.id, msg.proofJson);
      break;
    case 'shutdown':
      process.exit(0);
      break;
  }
});

// A worker whose parent has gone should not linger holding a WASM heap.
process.on('disconnect', () => process.exit(0));
