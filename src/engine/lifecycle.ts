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

import { Field, Poseidon, MerkleWitness } from 'o1js';
import { WALLET_TREE_HEIGHT } from '../wallets/wallet-state.js';

/**
 * Lifecycle States for Wallets in the CareContract.
 *
 * Each wallet progresses through these stages. All values
 * are Field constants for use inside ZK circuits.
 *
 * State machine:
 *   EMPTY ──► REGISTERED ──► ELIGIBLE ──► ACTIVE ──► REVOKED
 *                  │              │
 *                  └──────────────┴───────────────► REVOKED
 */
/** Merkle witness for the lifecycle tree (same height as wallet registry) */
export class LifecycleWitness extends MerkleWitness(WALLET_TREE_HEIGHT) {}

export const LIFECYCLE_EMPTY      = Field(0);
export const LIFECYCLE_REGISTERED = Field(1);
export const LIFECYCLE_ELIGIBLE   = Field(2);
export const LIFECYCLE_ACTIVE     = Field(3);
export const LIFECYCLE_REVOKED    = Field(4);

/**
 * Compute the lifecycle leaf commitment for the lifecycle Merkle tree.
 *
 * Binding the wallet ID into the leaf prevents observation of raw
 * lifecycle values by anyone inspecting the tree.
 *
 * leaf = Poseidon.hash([walletId, lifecycleState])
 */
export function lifecycleLeafCommitment(walletId: Field, lifecycle: Field): Field {
  return Poseidon.hash([walletId, lifecycle]);
}

/**
 * Assert a lifecycle transition is valid inside a ZK circuit.
 *
 * Uses only circuit-compatible operations (.equals, .and, .or, .assertTrue).
 * If no valid transition matches, the circuit constraint fails.
 *
 * Valid transitions:
 *   EMPTY(0)      → REGISTERED(1)
 *   REGISTERED(1) → ELIGIBLE(2)
 *   ELIGIBLE(2)   → ACTIVE(3)
 *   ACTIVE(3)     → REVOKED(4)
 *   REGISTERED(1) → REVOKED(4)   (admin revoke before eligibility)
 *   ELIGIBLE(2)   → REVOKED(4)   (admin revoke before activation)
 */
export function assertValidTransition(from: Field, to: Field): void {
  const t1 = from.equals(LIFECYCLE_EMPTY).and(to.equals(LIFECYCLE_REGISTERED));
  const t2 = from.equals(LIFECYCLE_REGISTERED).and(to.equals(LIFECYCLE_ELIGIBLE));
  const t3 = from.equals(LIFECYCLE_ELIGIBLE).and(to.equals(LIFECYCLE_ACTIVE));
  const t4 = from.equals(LIFECYCLE_ACTIVE).and(to.equals(LIFECYCLE_REVOKED));
  const t5 = from.equals(LIFECYCLE_REGISTERED).and(to.equals(LIFECYCLE_REVOKED));
  const t6 = from.equals(LIFECYCLE_ELIGIBLE).and(to.equals(LIFECYCLE_REVOKED));

  const isValid = t1.or(t2).or(t3).or(t4).or(t5).or(t6);
  isValid.assertTrue('Invalid lifecycle transition');
}

/**
 * Off-chain helper: check if a transition is valid (for tests and pre-validation).
 */
export function isValidTransition(from: bigint, to: bigint): boolean {
  const valid: [bigint, bigint][] = [
    [0n, 1n], // EMPTY → REGISTERED
    [1n, 2n], // REGISTERED → ELIGIBLE
    [2n, 3n], // ELIGIBLE → ACTIVE
    [3n, 4n], // ACTIVE → REVOKED
    [1n, 4n], // REGISTERED → REVOKED
    [2n, 4n], // ELIGIBLE → REVOKED
  ];
  return valid.some(([f, t]) => f === from && t === to);
}
