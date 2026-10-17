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
  | 'invalid';

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
 * Compile `StateTransitionProgram` and return a verifier bound to its verification key.
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

  return async (proof: StateTransitionProof): Promise<void> => {
    let valid: boolean;
    const startedAt = Date.now();
    try {
      valid = await verify(proof, verificationKey);
      verified++;
      totalMs += Date.now() - startedAt;
      if (verified === 1 || verified % 100 === 0) {
        console.log(
          '  [verify] %d proof(s) verified, %d ms last, %d ms mean',
          verified,
          Date.now() - startedAt,
          Math.round(totalMs / verified),
        );
      }
    } catch (err: unknown) {
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
