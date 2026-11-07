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
 * Terminating a console fixture member on the trees the engine shares with the sequencer.
 *
 * This is what is left of the in-process EnrollmentService, the insurer's half of the enrollment ceremony from before
 * enrollment went over the network (the member's device redeems its code with the insurer's node, which redeems it with
 * the employer's node: `src/nodes/routes/insurer-routes.ts`). Its enrollment, migration, group-termination and formulary
 * paths read the raw group, plan and family IDs, which an invite has not carried since A-109 (codes are kept by their
 * fingerprint), and nothing the network runs called them; the cleanup removed them (docs/CLEANUP-PLAN.md, phase 3.3).
 * The engine still terminates a console fixture member here (`AdjudicationService.terminateMember`) until the fixtures
 * go; a member with a device is terminated on the lifecycle tree directly.
 */
import { Field, MerkleTree } from 'o1js';
import { WalletRegistry } from '../wallets/wallet-state.js';
import { lifecycleLeafCommitment, LIFECYCLE_REVOKED } from '../engine/lifecycle.js';
import { dateToField } from '../zkp/hash-utils.js';
import { GroupRegistry, GroupConfig } from './group-registry.js';
import { OpaqueRoster, RosterEntry, ENROLLMENT_STATUS_TERMINATED } from './opaque-roster.js';

/** Result of a member termination. */
export interface TerminationResult {
  /** The terminated wallet ID */
  walletId: Field;
  /** New wallet registry Merkle root */
  newRegistryRoot: Field;
  /** New lifecycle tree Merkle root */
  newLifecycleRoot: Field;
}

export class EnrollmentService {
  constructor(
    private readonly walletRegistry: WalletRegistry,
    private readonly lifecycleTree: MerkleTree,
    private readonly groupRegistry: GroupRegistry,
    private readonly opaqueRoster: OpaqueRoster,
  ) {}

  /**
   * Terminate a member: lifecycle REVOKED, roster entry TERMINATED with the date, the group's enrolled count one lower.
   *
   * @param walletId — the member's wallet ID
   * @param terminationDate — CCYYMMDD
   */
  terminateMember(walletId: Field, terminationDate: string): TerminationResult {
    if (!this.walletRegistry.isRegistered(walletId)) {
      throw new Error('Wallet not registered');
    }
    const rosterResult = this.opaqueRoster.getEntryByWallet(walletId);
    if (!rosterResult) {
      throw new Error('Wallet not in roster');
    }

    const walletIndex = this.walletRegistry.getIndex(walletId);
    this.lifecycleTree.setLeaf(walletIndex, lifecycleLeafCommitment(walletId, LIFECYCLE_REVOKED));

    this.opaqueRoster.updateEntry(
      rosterResult.index,
      new RosterEntry({
        walletId: rosterResult.entry.walletId,
        planIdHash: rosterResult.entry.planIdHash,
        groupIdHash: rosterResult.entry.groupIdHash,
        familyIdHash: rosterResult.entry.familyIdHash,
        enrolledDate: rosterResult.entry.enrolledDate,
        terminatedDate: dateToField(terminationDate),
        status: ENROLLMENT_STATUS_TERMINATED,
        tokenIdHash: rosterResult.entry.tokenIdHash,
      }),
    );

    const group = this.groupRegistry.getGroupByHash(rosterResult.entry.groupIdHash);
    if (group) {
      const count = BigInt(group.config.enrolledCount.toString());
      if (count > 0n) {
        this.groupRegistry.updateGroup(
          group.index,
          new GroupConfig({
            groupIdHash: group.config.groupIdHash,
            planIdHash: group.config.planIdHash,
            effectiveDate: group.config.effectiveDate,
            terminationDate: group.config.terminationDate,
            enrollmentCap: group.config.enrollmentCap,
            enrolledCount: Field(count - 1n),
            status: group.config.status,
          }),
        );
      }
    }

    return {
      walletId,
      newRegistryRoot: this.walletRegistry.getRoot(),
      newLifecycleRoot: this.lifecycleTree.getRoot(),
    };
  }
}
