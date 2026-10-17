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
 * Cryptographic verification of submitted state-transition proofs.
 *
 * Why this is a separate, injected dependency rather than a method on the sequencer:
 * the sequencer must not contain a code path that can accept an unverified transition.
 * A boolean option could be left false by a misconfiguration; an absent dependency
 * fails closed, because `submitProof` refuses outright when no verifier is set.
 *
 * `proof.verify()` is NOT verification. o1js documents it as having no effect outside
 * a circuit: it sets a flag used when a proof is consumed recursively inside another
 * circuit. Out here it is a no-op, which is why acceptance was previously gated only
 * by Merkle root equality.
 */
import { verify } from 'o1js';
import { StateTransitionProgram } from '../engine/state-transition.js';
import type { StateTransitionProof } from '../engine/state-transition.js';

/**
 * Verifies a submitted proof. Resolves if the proof is valid, throws `ProofRejected`
 * otherwise. Throwing rather than returning a boolean keeps the reason attached.
 */
export type TransitionProofVerifier = (proof: StateTransitionProof) => Promise<void>;

/** Why a submission was refused. Distinct causes so monitoring can tell them apart. */
export type ProofRejectionReason =
  /** Not a decodable proof at all: malformed, truncated, or not this proof system's. */
  | 'undecodable'
  /** Decodes, but is not valid against the pinned verification key. */
  | 'invalid'
  /** Verification did not finish in time, so the proof is refused rather than waited on. */
  | 'timeout';

/**
 * How long a single verification may take before the submission is refused. Measured cost
 * is around one second, with the first call after a compile taking several, so this is
 * generous by an order of magnitude and still well inside the server's request timeout.
 */
export const VERIFY_TIMEOUT_MS = 20_000;

export class ProofRejected extends Error {
  constructor(readonly reason: ProofRejectionReason, message: string) {
    super(message);
    this.name = 'ProofRejected';
  }
}

export interface TransitionVerifierOptions {
  /**
   * The verification key hash this deployment expects. When set, a mismatch throws at
   * construction so that a swapped or recompiled program is caught at boot rather than
   * silently accepted. Leave unset only on a first boot, to learn the hash to pin.
   */
  expectedVkHash?: string;
  /** Called once after compiling, with the hash to pin and how long it took. */
  onCompiled?: (info: { vkHash: string; compileMs: number }) => void;
}

/**
 * Compile `StateTransitionProgram` in THIS process and return a verifier bound to its key.
 *
 * **Do not use this inside the sequencer.** The adjudication engine compiles ten ZkPrograms
 * into that process's single o1js context, after which every o1js call there stalls
 * permanently — measured 2026-10-17, in both directions: set up before the engine, the
 * compile succeeds and the first verification never returns; set up after it, the compile
 * itself never returns. Use `VerifyPool` from `l2-verify-pool.ts`, which verifies in a child
 * process with its own context.
 *
 * This remains useful in a clean single-purpose process: tests, measurement scripts, tools.
 *
 * Compiling costs a few seconds once at startup (measured ~3.8 s). The returned
 * closure holds the key, so per-proof verification does no further setup.
 */
export async function createTransitionProofVerifier(
  options: TransitionVerifierOptions = {},
): Promise<TransitionProofVerifier> {
  const startedAt = Date.now();
  const { verificationKey } = await StateTransitionProgram.compile();
  const compileMs = Date.now() - startedAt;
  const vkHash = verificationKey.hash.toString();

  if (options.expectedVkHash && options.expectedVkHash !== vkHash) {
    throw new Error(
      'State-transition verification key mismatch: this deployment expects ' +
        `${options.expectedVkHash} but the compiled program produces ${vkHash}. ` +
        'Refusing to start, because accepting proofs against an unexpected key would ' +
        'verify the wrong program.',
    );
  }

  options.onCompiled?.({ vkHash, compileMs });

  // Verification now sits on the submit path, so its cost is worth knowing rather than
  // assuming. Logged on the first proof and every hundredth after, which is enough to
  // spot a regression without adding RPC surface.
  let verified = 0;
  let totalMs = 0;

  let attempted = 0;

  return async (proof: StateTransitionProof): Promise<void> => {
    let valid: boolean;
    const startedAt = Date.now();
    const attempt = ++attempted;
    console.log('  [verify] #%d verifying a submitted proof…', attempt);
    try {
      // A verification that never returns must not hold the request open forever: the
      // sequencer's own request timeout would answer 504 while the handler stayed stuck,
      // which looks identical to a hang and tells an operator nothing. Time it out and
      // refuse instead, so the failure is explicit and the submission is rejected.
      valid = await Promise.race([
        verify(proof, verificationKey),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new ProofRejected('timeout', `Proof rejected: verification did not finish within ${VERIFY_TIMEOUT_MS} ms`)),
            VERIFY_TIMEOUT_MS,
          ),
        ),
      ]);
      verified++;
      totalMs += Date.now() - startedAt;
      console.log(
        '  [verify] #%d %s in %d ms (%d verified, %d ms mean)',
        attempt,
        valid ? 'valid' : 'INVALID',
        Date.now() - startedAt,
        verified,
        Math.round(totalMs / verified),
      );
    } catch (err: unknown) {
      if (err instanceof ProofRejected) throw err;
      const detail = err instanceof Error ? err.message : String(err);
      throw new ProofRejected(
        'undecodable',
        `Proof rejected: not a decodable state-transition proof (${detail})`,
      );
    }
    if (!valid) {
      throw new ProofRejected(
        'invalid',
        'Proof rejected: the state-transition proof is not valid against this ' +
          "deployment's verification key",
      );
    }
  };
}

/**
 * A verifier that accepts everything, for tests that submit mock proofs rather than
 * real ones. Deliberately noisy and deliberately not reachable from any production
 * entry point: a caller has to name itself, and the name is logged on every use.
 *
 * The import-graph guard (plan phase F1) asserts the production launcher never reaches
 * this function.
 */
export function createAcceptAllVerifierForTests(calledBy: string): TransitionProofVerifier {
  let warned = false;
  return async (): Promise<void> => {
    if (!warned) {
      warned = true;
      console.warn(
        `[sequencer] PROOF VERIFICATION DISABLED for "${calledBy}". ` +
          'Mock proofs are being accepted. This must never appear in a deployment.',
      );
    }
  };
}
