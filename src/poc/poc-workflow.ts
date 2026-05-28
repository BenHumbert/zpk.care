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
 * PoC Workflow Engine — Drives the 100-claim lifecycle through the multi-node network.
 *
 * Orchestrates: enrollment (9 entities) → prescribing (100 Rx) → filling (100 claims)
 * → batching (3 partitions) → verification (audit chain, gossip, entity queries).
 *
 * Uses mock receipts via applyReplicatedReceipt() for instant execution.
 */

import { Field, Poseidon } from 'o1js';
import type { L2Leviathan } from '../l2/l2-leviathan.js';
import { getPartition } from '../l2/l2-partition.js';
import { MEDICATIONS } from '../data/index.js';
import { hashString } from '../zkp/hash-utils.js';
import {
  ReceiptFactory,
  getMedicationPricing,
  type DerivedWallets,
} from './poc-receipt-factory.js';
import type {
  PocEventEmitter,
  PocCounters,
  WorkflowStep,
  PrescriptionInfo,
} from './poc-types.js';

// ─── Workflow Configuration ──────────────────────────────

const MEMBERS_COUNT = 5;
const CLAIMS_PER_MEMBER = 20;
const TOTAL_CLAIMS = MEMBERS_COUNT * CLAIMS_PER_MEMBER;
const PARTITION_COUNT = 3;

// ─── Workflow Engine ─────────────────────────────────────

export class PocWorkflow {
  private leviathans: L2Leviathan[];
  private wallets: DerivedWallets;
  private emitter: PocEventEmitter;
  private counters: PocCounters;
  private steps: WorkflowStep[] = [];
  private factory: ReceiptFactory;
  private prescriptions: Map<string, PrescriptionInfo> = new Map();

  constructor(
    leviathans: L2Leviathan[],
    wallets: DerivedWallets,
    factory: ReceiptFactory,
    emitter: PocEventEmitter,
    counters: PocCounters,
  ) {
    this.leviathans = leviathans;
    this.wallets = wallets;
    this.factory = factory;
    this.emitter = emitter;
    this.counters = counters;
  }

  getSteps(): WorkflowStep[] {
    return this.steps;
  }

  /**
   * Run the full 100-claim workflow.
   * Returns true if all steps succeed, false if any fail.
   */
  async run(): Promise<boolean> {
    let success = true;

    // Step 1: Enrollment
    success = await this.executeStep(
      { id: 'enroll', phase: 'enrollment', description: 'Enroll 5 members + 2 prescribers + 2 pharmacies' },
      () => this.runEnrollment(),
    ) && success;

    // Step 2: Prescribing
    success = await this.executeStep(
      { id: 'prescribe', phase: 'prescribing', description: `Create ${TOTAL_CLAIMS} prescriptions (${CLAIMS_PER_MEMBER} per member)` },
      () => this.runPrescribing(),
    ) && success;

    // Step 3: Filling
    success = await this.executeStep(
      { id: 'fill', phase: 'filling', description: `Fill ${TOTAL_CLAIMS} prescriptions across ${PARTITION_COUNT} partitions` },
      () => this.runFilling(),
    ) && success;

    // Step 4: Batching
    success = await this.executeStep(
      { id: 'batch', phase: 'batching', description: `Force-batch ${PARTITION_COUNT} partitions` },
      () => this.runBatching(),
    ) && success;

    // Step 5: Verification
    success = await this.executeStep(
      { id: 'verify', phase: 'verification', description: 'Verify gossip, audit chain, entity queries' },
      () => this.runVerification(),
    ) && success;

    return success;
  }

  // ─── Step Execution ────────────────────────────────────

  private async executeStep(
    stepDef: Pick<WorkflowStep, 'id' | 'phase' | 'description'>,
    fn: () => Promise<void>,
  ): Promise<boolean> {
    const step: WorkflowStep = {
      ...stepDef,
      status: 'running',
      startedAt: Date.now(),
    };
    this.steps.push(step);

    this.emitter.emit({
      timestamp: Date.now(),
      source: 'workflow',
      level: 'info',
      message: `Starting: ${step.description}`,
      phase: step.phase,
    });

    try {
      await fn();
      step.status = 'success';
      step.completedAt = Date.now();
      const elapsed = step.completedAt - step.startedAt!;

      this.emitter.emit({
        timestamp: Date.now(),
        source: 'workflow',
        level: 'success',
        message: `Completed: ${step.description} (${elapsed}ms)`,
        phase: step.phase,
      });
      return true;
    } catch (err) {
      step.status = 'error';
      step.error = err instanceof Error ? err.message : String(err);
      step.completedAt = Date.now();

      this.emitter.emit({
        timestamp: Date.now(),
        source: 'workflow',
        level: 'error',
        message: `Failed: ${step.description} — ${step.error}`,
        phase: step.phase,
      });
      return false;
    }
  }

  // ─── Step 1: Enrollment ────────────────────────────────

  private async runEnrollment(): Promise<void> {
    this.counters.enrollments.total = 9; // 5 members + 2 prescribers + 2 pharmacies

    // Enroll members
    for (let i = 0; i < this.wallets.members.length; i++) {
      const m = this.wallets.members[i];
      const partition = getPartition(m.walletIdStr, PARTITION_COUNT);
      const { receipt, auditEvent } = this.factory.createRegistrationReceipt(m.walletId, partition);

      // Inject into ALL 3 leviathans (simulates gossip replication)
      for (const lev of this.leviathans) {
        lev.getSequencer(partition).applyReplicatedReceipt(
          receipt,
          auditEvent,
          undefined,
          receipt.newRegistryRoot,
          receipt.newLifecycleRoot,
          this.factory.getPartitionState(partition).walletCount.toString(),
        );
      }

      this.counters.enrollments.success++;
      this.emitter.emit({
        timestamp: Date.now(),
        source: `member-${i}`,
        level: 'success',
        message: `Enrolled member: ${m.displayName} (partition ${partition})`,
        phase: 'enrollment',
      });
    }

    // Enroll prescribers
    for (let i = 0; i < this.wallets.prescribers.length; i++) {
      const p = this.wallets.prescribers[i];
      const partition = getPartition(p.walletIdStr, PARTITION_COUNT);
      const { receipt, auditEvent } = this.factory.createRegistrationReceipt(p.walletId, partition);

      for (const lev of this.leviathans) {
        lev.getSequencer(partition).applyReplicatedReceipt(
          receipt,
          auditEvent,
          undefined,
          receipt.newRegistryRoot,
          receipt.newLifecycleRoot,
          this.factory.getPartitionState(partition).walletCount.toString(),
        );
      }

      this.counters.enrollments.success++;
      this.emitter.emit({
        timestamp: Date.now(),
        source: `prescriber-${i}`,
        level: 'success',
        message: `Enrolled prescriber: ${p.displayName} (partition ${partition})`,
        phase: 'enrollment',
      });
    }

    // Enroll pharmacies
    for (let i = 0; i < this.wallets.pharmacies.length; i++) {
      const ph = this.wallets.pharmacies[i];
      const partition = getPartition(ph.walletIdStr, PARTITION_COUNT);
      const { receipt, auditEvent } = this.factory.createRegistrationReceipt(ph.walletId, partition);

      for (const lev of this.leviathans) {
        lev.getSequencer(partition).applyReplicatedReceipt(
          receipt,
          auditEvent,
          undefined,
          receipt.newRegistryRoot,
          receipt.newLifecycleRoot,
          this.factory.getPartitionState(partition).walletCount.toString(),
        );
      }

      this.counters.enrollments.success++;
      this.emitter.emit({
        timestamp: Date.now(),
        source: `pharmacy-${i}`,
        level: 'success',
        message: `Enrolled pharmacy: ${ph.displayName} (partition ${partition})`,
        phase: 'enrollment',
      });
    }
  }

  // ─── Step 2: Prescribing ───────────────────────────────

  private async runPrescribing(): Promise<void> {
    let rxId = 0;
    const meds = MEDICATIONS;

    for (let mi = 0; mi < MEMBERS_COUNT; mi++) {
      const member = this.wallets.members[mi];
      for (let ci = 0; ci < CLAIMS_PER_MEMBER; ci++) {
        // Distribute across 2 prescribers (10 each per member)
        const prescriberIdx = ci < 10 ? 0 : 1;
        // Alternate pharmacy
        const pharmacyIdx = ci % 2;
        // Round-robin medication from 33 available
        const medIdx = (mi * CLAIMS_PER_MEMBER + ci) % meds.length;

        const prescriptionId = `rx-${String(rxId).padStart(4, '0')}`;
        const info: PrescriptionInfo = {
          prescriptionId,
          memberWalletId: member.walletIdStr,
          prescriberWalletId: this.wallets.prescribers[prescriberIdx].walletIdStr,
          pharmacyWalletId: this.wallets.pharmacies[pharmacyIdx].walletIdStr,
          ndcHash: hashString(MEDICATIONS[medIdx].ndc).toString(),
          filled: false,
        };
        this.prescriptions.set(prescriptionId, info);
        rxId++;
      }
    }

    this.emitter.emit({
      timestamp: Date.now(),
      source: 'workflow',
      level: 'info',
      message: `Created ${this.prescriptions.size} prescriptions across ${MEMBERS_COUNT} members`,
      phase: 'prescribing',
    });
  }

  // ─── Step 3: Filling ──────────────────────────────────

  private async runFilling(): Promise<void> {
    this.counters.claims.total = TOTAL_CLAIMS;
    const meds = MEDICATIONS;
    let filled = 0;

    for (const [, rx] of this.prescriptions) {
      try {
        const medication = meds.find(m => hashString(m.ndc).toString() === rx.ndcHash)!;
        const memberWalletId = this.wallets.members.find(
          (m) => m.walletIdStr === rx.memberWalletId,
        )!.walletId;
        const prescriberWalletId = this.wallets.prescribers.find(
          (p) => p.walletIdStr === rx.prescriberWalletId,
        )!.walletId;
        const pharmacyWalletId = this.wallets.pharmacies.find(
          (p) => p.walletIdStr === rx.pharmacyWalletId,
        )!.walletId;

        const partition = getPartition(rx.memberWalletId, PARTITION_COUNT);
        const { patientPayCents, planPayCents } = getMedicationPricing(medication);

        const { receipt, auditEvent, claimEntry } = this.factory.createClaimReceipt(
          memberWalletId,
          prescriberWalletId,
          pharmacyWalletId,
          medication,
          partition,
          patientPayCents,
          planPayCents,
        );

        // Inject into ALL 3 leviathans
        for (const lev of this.leviathans) {
          lev.getSequencer(partition).applyReplicatedReceipt(
            receipt,
            auditEvent,
            claimEntry,
            receipt.newRegistryRoot,
            receipt.newLifecycleRoot,
          );
        }

        rx.filled = true;
        this.counters.claims.success++;
        filled++;

        // Log every 10 claims
        if (filled % 10 === 0) {
          this.emitter.emit({
            timestamp: Date.now(),
            source: 'workflow',
            level: 'info',
            message: `Filled ${filled}/${TOTAL_CLAIMS} claims (${medication.brandName}, partition ${partition})`,
            phase: 'filling',
          });
        }
      } catch (err) {
        this.counters.claims.failed++;
        this.emitter.emit({
          timestamp: Date.now(),
          source: 'workflow',
          level: 'error',
          message: `Fill failed for ${rx.prescriptionId}: ${err instanceof Error ? err.message : err}`,
          phase: 'filling',
        });
      }
    }

    this.emitter.emit({
      timestamp: Date.now(),
      source: 'workflow',
      level: 'success',
      message: `Filled ${this.counters.claims.success}/${TOTAL_CLAIMS} claims`,
      phase: 'filling',
    });
  }

  // ─── Step 4: Batching ─────────────────────────────────

  private async runBatching(): Promise<void> {
    this.counters.batches.total = PARTITION_COUNT;

    for (let p = 0; p < PARTITION_COUNT; p++) {
      try {
        // Only the leader for this partition can batch
        const leader = this.leviathans[p];
        const batch = await leader.forceBatch(p);

        if (batch) {
          this.counters.batches.success++;
          this.emitter.emit({
            timestamp: Date.now(),
            source: `lev-${p}`,
            level: 'success',
            message: `Partition ${p} batch #${batch.batchNumber}: ${batch.transitionCount} transitions, l1Status=${batch.l1Status}`,
            phase: 'batching',
          });
        } else {
          // Empty batch (no receipts on this partition)
          this.counters.batches.success++;
          this.emitter.emit({
            timestamp: Date.now(),
            source: `lev-${p}`,
            level: 'info',
            message: `Partition ${p}: no pending receipts to batch`,
            phase: 'batching',
          });
        }
      } catch (err) {
        this.counters.batches.failed++;
        this.emitter.emit({
          timestamp: Date.now(),
          source: `lev-${p}`,
          level: 'error',
          message: `Partition ${p} batch failed: ${err instanceof Error ? err.message : err}`,
          phase: 'batching',
        });
      }
    }
  }

  // ─── Step 5: Verification ─────────────────────────────

  private async runVerification(): Promise<void> {
    // V1: Receipt count consistency across all 3 leviathans
    this.verifyReceiptConsistency();

    // V2: Audit chain integrity per partition
    this.verifyAuditChains();

    // V3: Claim accumulator consistency
    this.verifyClaimAccumulator();

    // V4: Entity queries
    this.verifyEntityQueries();
  }

  private verifyReceiptConsistency(): void {
    this.counters.verifications.total++;
    const counts = this.leviathans.map((lev) => lev.getAllReceipts().length);
    const allEqual = counts.every((c) => c === counts[0]);

    if (allEqual) {
      this.counters.verifications.passed++;
      this.emitter.emit({
        timestamp: Date.now(),
        source: 'verify',
        level: 'success',
        message: `Receipt consistency: all ${this.leviathans.length} leviathans have ${counts[0]} receipts`,
        phase: 'verification',
      });
    } else {
      this.counters.verifications.failed++;
      this.emitter.emit({
        timestamp: Date.now(),
        source: 'verify',
        level: 'error',
        message: `Receipt consistency FAILED: counts = [${counts.join(', ')}]`,
        phase: 'verification',
      });
    }
  }

  private verifyAuditChains(): void {
    // Verify per-partition audit chain (each partition has its own chain)
    for (let p = 0; p < PARTITION_COUNT; p++) {
      this.counters.verifications.total++;
      const seq = this.leviathans[0].getSequencer(p);
      const log = seq.getAuditLog();

      if (log.events.length === 0) {
        this.counters.verifications.passed++;
        this.emitter.emit({
          timestamp: Date.now(),
          source: 'verify',
          level: 'info',
          message: `Partition ${p} audit chain: empty (no receipts)`,
          phase: 'verification',
        });
        continue;
      }

      // Walk the chain manually
      let valid = true;
      let chainHash = log.genesisHash;
      for (const event of log.events) {
        const commitment = Field(BigInt(event.eventCommitment));
        const expected = Poseidon.hash([Field(BigInt(chainHash)), commitment]);
        if (expected.toString() !== event.chainHash) {
          valid = false;
          break;
        }
        chainHash = event.chainHash;
      }

      if (valid) {
        this.counters.verifications.passed++;
        this.emitter.emit({
          timestamp: Date.now(),
          source: 'verify',
          level: 'success',
          message: `Partition ${p} audit chain: ${log.events.length} events, integrity verified`,
          phase: 'verification',
        });
      } else {
        this.counters.verifications.failed++;
        this.emitter.emit({
          timestamp: Date.now(),
          source: 'verify',
          level: 'error',
          message: `Partition ${p} audit chain: INTEGRITY FAILURE`,
          phase: 'verification',
        });
      }
    }
  }

  private verifyClaimAccumulator(): void {
    this.counters.verifications.total++;
    // All leviathans should have the same claim accumulator root per partition
    let allMatch = true;
    for (let p = 0; p < PARTITION_COUNT; p++) {
      const roots = this.leviathans.map(
        (lev) => lev.getSequencer(p).getClaimAccumulatorRoot(),
      );
      if (!roots.every((r) => r === roots[0])) {
        allMatch = false;
        this.emitter.emit({
          timestamp: Date.now(),
          source: 'verify',
          level: 'error',
          message: `Partition ${p} claim root mismatch: ${roots.join(' vs ')}`,
          phase: 'verification',
        });
      }
    }

    if (allMatch) {
      this.counters.verifications.passed++;
      this.emitter.emit({
        timestamp: Date.now(),
        source: 'verify',
        level: 'success',
        message: `Claim accumulator roots consistent across all leviathans`,
        phase: 'verification',
      });
    } else {
      this.counters.verifications.failed++;
    }
  }

  private verifyEntityQueries(): void {
    // Verify insurer can see all receipts
    this.counters.verifications.total++;
    const totalReceipts = this.leviathans[0].getAllReceipts().length;
    const expectedReceipts = 9 + this.counters.claims.success; // 9 registrations + filled claims

    if (totalReceipts === expectedReceipts) {
      this.counters.verifications.passed++;
      this.emitter.emit({
        timestamp: Date.now(),
        source: 'verify',
        level: 'success',
        message: `Entity query: insurer sees ${totalReceipts} receipts (9 enrollments + ${this.counters.claims.success} claims)`,
        phase: 'verification',
      });
    } else {
      this.counters.verifications.failed++;
      this.emitter.emit({
        timestamp: Date.now(),
        source: 'verify',
        level: 'error',
        message: `Entity query FAILED: expected ${expectedReceipts} receipts, got ${totalReceipts}`,
        phase: 'verification',
      });
    }

    // Verify per-member claim counts
    this.counters.verifications.total++;
    let memberClaimsCorrect = true;
    for (const member of this.wallets.members) {
      const claims = this.leviathans[0].getClaimsByMember(member.walletIdStr);
      if (claims.length !== CLAIMS_PER_MEMBER) {
        memberClaimsCorrect = false;
        this.emitter.emit({
          timestamp: Date.now(),
          source: 'verify',
          level: 'error',
          message: `Member ${member.displayName}: expected ${CLAIMS_PER_MEMBER} claims, got ${claims.length}`,
          phase: 'verification',
        });
      }
    }

    if (memberClaimsCorrect) {
      this.counters.verifications.passed++;
      this.emitter.emit({
        timestamp: Date.now(),
        source: 'verify',
        level: 'success',
        message: `Per-member claim counts: all ${MEMBERS_COUNT} members have ${CLAIMS_PER_MEMBER} claims each`,
        phase: 'verification',
      });
    } else {
      this.counters.verifications.failed++;
    }
  }
}
