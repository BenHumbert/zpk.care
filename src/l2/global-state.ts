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

import { Field, Struct, Poseidon } from 'o1js';

/**
 * Number of Fields in the GlobalState commitment.
 *
 * 8 CareContract on-chain slots + auditChainHash + blockHeight = 10
 */
export const GLOBAL_STATE_FIELD_COUNT = 10;

/**
 * Compute the canonical GlobalState root from 10 fields.
 *
 * This is a standalone function so it can be called both inside
 * ZkProgram circuits and from service-layer code without
 * constructing a Struct instance.
 *
 * Field ordering (canonical — never change):
 *   0  walletRegistryRoot   — wallet registry Merkle root
 *   1  walletCount          — total registered wallets
 *   2  adminPublicKeyHash   — Poseidon hash of admin public key
 *   3  lifecycleRoot        — lifecycle tree Merkle root
 *   4  benefitPlanRoot      — benefit plan registry root
 *   5  credentialRegistryRoot — credential registry Merkle root
 *   6  eligibilityVkHash    — eligibility verification key hash
 *   7  messagingRoot        — messaging composite root
 *   8  auditChainHash       — Poseidon hash chain head (DA)
 *   9  blockHeight          — L2 block number
 */
export function computeGlobalStateRoot(
  walletRegistryRoot: Field,
  walletCount: Field,
  adminPublicKeyHash: Field,
  lifecycleRoot: Field,
  benefitPlanRoot: Field,
  credentialRegistryRoot: Field,
  eligibilityVkHash: Field,
  messagingRoot: Field,
  auditChainHash: Field,
  blockHeight: Field,
): Field {
  return Poseidon.hash([
    walletRegistryRoot,
    walletCount,
    adminPublicKeyHash,
    lifecycleRoot,
    benefitPlanRoot,
    credentialRegistryRoot,
    eligibilityVkHash,
    messagingRoot,
    auditChainHash,
    blockHeight,
  ]);
}

/**
 * GlobalState — full chain state commitment as an o1js Struct.
 *
 * Covers all 8 CareContract on-chain slots plus the audit chain hash
 * and block height. A single Poseidon hash of these 10 Fields is
 * the `globalStateRoot` committed in every ChainProof.
 *
 * The 22 kb chain proof certifies this root, so any node holding
 * just the proof can verify the entire chain state without storing
 * transaction history.
 */
export class GlobalState extends Struct({
  walletRegistryRoot: Field,
  walletCount: Field,
  adminPublicKeyHash: Field,
  lifecycleRoot: Field,
  benefitPlanRoot: Field,
  credentialRegistryRoot: Field,
  eligibilityVkHash: Field,
  messagingRoot: Field,
  auditChainHash: Field,
  blockHeight: Field,
}) {
  /**
   * Compute the canonical root for this state.
   * Delegates to the standalone function to guarantee identical ordering.
   */
  computeRoot(): Field {
    return computeGlobalStateRoot(
      this.walletRegistryRoot,
      this.walletCount,
      this.adminPublicKeyHash,
      this.lifecycleRoot,
      this.benefitPlanRoot,
      this.credentialRegistryRoot,
      this.eligibilityVkHash,
      this.messagingRoot,
      this.auditChainHash,
      this.blockHeight,
    );
  }
}

/**
 * ChainOutput — public output of the ChainProgram.
 *
 * Every block in the L2 chain produces a ChainProof whose public
 * output is a ChainOutput. This is the "22 kb proof" that certifies
 * the entire chain state.
 *
 * 5 Fields:
 *   - globalStateRoot: Poseidon hash of all 10 state fields
 *   - blockHeight:     L2 block number (0-indexed, genesis = 0)
 *   - registryRoot:    wallet registry root (exposed for chain continuity)
 *   - lifecycleRoot:   lifecycle tree root (exposed for chain continuity)
 *   - walletCount:     total wallets (accumulated across all blocks)
 *
 * registryRoot and lifecycleRoot are exposed explicitly because
 * the next block's BatchProof must chain from these roots, and
 * Poseidon hashes are not invertible inside a circuit.
 *
 * Defined here (not in chain-program.ts) so consumers can import
 * it without loading the ZkProgram, which registers proof classes
 * in the pickles system at module load time.
 */
export class ChainOutput extends Struct({
  globalStateRoot: Field,
  blockHeight: Field,
  registryRoot: Field,
  lifecycleRoot: Field,
  walletCount: Field,
}) {}
