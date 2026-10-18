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
 * AuditService — Stateless Data Availability & Audit Trail Verification.
 *
 * Follows the ReportingService pattern: no persistent state.
 * Takes audit data as input, computes verification results, returns them.
 *
 * In a ZK system, the proof IS the adjudication. Auditors verify:
 *   1. Chain integrity — Poseidon hash chain is unbroken (tamper-evident DA)
 *   2. Financial balance — patientPay + planPay == ingredientCost + dispensingFee
 *   3. Fraud detection — duplicate claims, sequence gaps, orphaned receipts
 *   4. L1 settlement — batches eventually settle with correct roots
 *   5. Enrollment consistency — roster entries match L2 registrations
 */

import { Field, Poseidon } from 'o1js';
import type {
  AuditEvent,
  AuditLog,
  OnChainState,
  ChainIntegrityResult,
  FinancialBalanceResult,
  DuplicateDetectionResult,
  SequenceGapResult,
  OrphanedReceiptResult,
  SettlementResult,
  EnrollmentConsistencyResult,
  FullAuditReport,
} from './audit-types.js';
import type { L2Batch } from '../l2/l2-types.js';

/** Default orphan threshold: 10 minutes (well beyond 3-min batch interval) */
export const DEFAULT_ORPHAN_THRESHOLD_MS = 600_000;

export class AuditService {
  // ─── DA Hash Chain ──────────────────────────────────────────

  /** Genesis hash — initial chain seed: Poseidon.hash([Field(0)]) */
  static readonly GENESIS_HASH: string = Poseidon.hash([Field(0)]).toString();

  /**
   * Compute the event commitment from an AuditEvent's core state fields.
   *
   * Hashes 10 Fields: walletId, oldRegistryRoot, newRegistryRoot,
   * oldLifecycleRoot, newLifecycleRoot, sequenceNumber, isRegistration,
   * ndcHash, patientPayCents, planPayCents, operationType (1 fill, 2 reversal).
   * Non-claim events use 0 for ndcHash, patientPayCents, planPayCents and operationType.
   */
  static computeEventCommitment(event: AuditEvent): Field {
    return Poseidon.hash([
      Field(BigInt(event.walletId)),
      Field(BigInt(event.oldRegistryRoot)),
      Field(BigInt(event.newRegistryRoot)),
      Field(BigInt(event.oldLifecycleRoot)),
      Field(BigInt(event.newLifecycleRoot)),
      Field(BigInt(event.sequenceNumber)),
      Field(BigInt(event.isRegistration ? 1 : 0)),
      Field(BigInt(event.ndcHash ?? '0')),
      Field(BigInt(event.patientPayCents ?? 0)),
      Field(BigInt(event.planPayCents ?? 0)),
      Field(BigInt(event.operationType ?? 0)),
    ]);
  }

  /**
   * Compute chain hash from previous chain hash and event commitment.
   * chainHash = Poseidon.hash([previousChainHash, eventCommitment])
   */
  static computeChainHash(previousChainHash: Field, eventCommitment: Field): Field {
    return Poseidon.hash([previousChainHash, eventCommitment]);
  }

  // ─── Chain Integrity ────────────────────────────────────────

  /**
   * Verify the Poseidon hash chain in an AuditLog.
   *
   * Walks events in order, recomputes each chainHash from eventCommitment,
   * and reports broken links where the recomputed value differs from stored.
   */
  static verifyReceiptChain(log: AuditLog): ChainIntegrityResult {
    if (log.events.length === 0) {
      return {
        isValid: true,
        totalEvents: 0,
        brokenLinks: [],
      };
    }

    const brokenLinks: number[] = [];
    let currentChainHash = Field(BigInt(log.genesisHash));

    for (const event of log.events) {
      const commitment = Field(BigInt(event.eventCommitment));
      const expectedChainHash = AuditService.computeChainHash(currentChainHash, commitment);

      if (expectedChainHash.toString() !== event.chainHash) {
        brokenLinks.push(Number(event.sequenceNumber));
      }

      // Advance chain using the STORED chainHash (to detect downstream breaks correctly)
      currentChainHash = Field(BigInt(event.chainHash));
    }

    return {
      isValid: brokenLinks.length === 0,
      totalEvents: log.events.length,
      brokenLinks,
      reason: brokenLinks.length > 0
        ? `Chain broken at sequence numbers: ${brokenLinks.join(', ')}`
        : undefined,
    };
  }

  // ─── Financial Balance ──────────────────────────────────────

  /**
   * Verify financial balance across all claims.
   *
   * For each event with a claimContext:
   *   patientPay + planPay should equal ingredientCost + dispensingFee
   *
   * Events without claimContext (registrations, wallet updates) are skipped.
   */
  static verifyFinancialBalance(events: AuditEvent[]): FinancialBalanceResult {
    // D5 (A-26): a claim event carries its amounts in the commitment; a fill adds, a reversal subtracts, and a fill
    // whose costs are known must split exactly into patient pay and plan pay.
    const imbalancedClaims: string[] = [];
    let totalClaims = 0;
    let reversals = 0;
    let totalPatientPayCents = 0;
    let totalPlanPayCents = 0;
    let totalIngredientCostCents = 0;
    let totalDispensingFeeCents = 0;
    for (const event of events) {
      if (event.patientPayCents === undefined || event.planPayCents === undefined) continue;
      const reversal = event.operationType === 2;
      const sign = reversal ? -1 : 1;
      if (reversal) reversals++; else totalClaims++;
      totalPatientPayCents += sign * event.patientPayCents;
      totalPlanPayCents += sign * event.planPayCents;
      const ctx = event.claimContext;
      if (ctx && !reversal) {
        const totalCost = ctx.ingredientCostCents + ctx.dispensingFeeCents;
        if (event.patientPayCents + event.planPayCents !== totalCost) imbalancedClaims.push(event.receiptId);
        totalIngredientCostCents += ctx.ingredientCostCents;
        totalDispensingFeeCents += ctx.dispensingFeeCents;
      }
    }
    return {
      isValid: imbalancedClaims.length === 0,
      totalClaims,
      reversals,
      imbalancedClaims,
      totalPatientPayCents,
      totalPlanPayCents,
      totalIngredientCostCents,
      totalDispensingFeeCents,
      reason: imbalancedClaims.length > 0
        ? `${imbalancedClaims.length} claim(s) with imbalanced amounts`
        : undefined,
    };
  }

  // ─── Fraud Detection ────────────────────────────────────────

  /**
   * Detect potential duplicate claims.
   *
   * Groups events by (walletId + ndcHash + dateOfService).
   * Same key appearing multiple times = potential duplicate.
   * Events without claimContext are excluded.
   */
  static detectDuplicateClaims(events: AuditEvent[]): DuplicateDetectionResult {
    const groups = new Map<string, string[]>();

    for (const event of events) {
      if (!event.claimContext || event.operationType === 2) continue; // a reversal is not a claim
      const key = `${event.walletId}|${event.claimContext.ndcHash}|${event.claimContext.dateOfService}|${event.claimContext.fillNumber ?? 0}`;
      const existing = groups.get(key) ?? [];
      existing.push(event.receiptId);
      groups.set(key, existing);
    }

    const duplicateGroups: { key: string; receiptIds: string[] }[] = [];
    for (const [key, receiptIds] of groups) {
      if (receiptIds.length > 1) {
        duplicateGroups.push({ key, receiptIds });
      }
    }

    const totalDuplicates = duplicateGroups.reduce(
      (sum, g) => sum + g.receiptIds.length, 0,
    );

    return {
      hasDuplicates: duplicateGroups.length > 0,
      duplicateGroups,
      totalDuplicates,
    };
  }

  /**
   * Detect gaps in the sequence number series.
   *
   * Walks events sorted by sequence number and reports any gaps.
   */
  static detectSequenceGaps(events: AuditEvent[]): SequenceGapResult {
    if (events.length === 0) {
      return { hasGaps: false, gaps: [], totalGaps: 0 };
    }

    const sorted = [...events].sort(
      (a, b) => Number(a.sequenceNumber - b.sequenceNumber),
    );

    const gaps: { expected: bigint; actual: bigint }[] = [];
    for (let i = 1; i < sorted.length; i++) {
      const expected = sorted[i - 1].sequenceNumber + 1n;
      const actual = sorted[i].sequenceNumber;
      if (actual !== expected) {
        gaps.push({ expected, actual });
      }
    }

    return {
      hasGaps: gaps.length > 0,
      gaps,
      totalGaps: gaps.length,
    };
  }

  /**
   * Detect orphaned receipts — events still pending beyond a threshold.
   *
   * @param events The audit events to check
   * @param now Current timestamp (default: Date.now())
   * @param thresholdMs Orphan threshold in ms (default: 10 minutes)
   */
  static detectOrphanedReceipts(
    events: AuditEvent[],
    now: number = Date.now(),
    thresholdMs: number = DEFAULT_ORPHAN_THRESHOLD_MS,
  ): OrphanedReceiptResult {
    const orphanedReceiptIds: string[] = [];

    for (const event of events) {
      if (event.l1Status === 'pending' && (now - event.timestamp) > thresholdMs) {
        orphanedReceiptIds.push(event.receiptId);
      }
    }

    return {
      hasOrphans: orphanedReceiptIds.length > 0,
      orphanedReceiptIds,
      totalOrphans: orphanedReceiptIds.length,
    };
  }

  // ─── Settlement Verification ────────────────────────────────

  /**
   * Verify L1 settlement status of batches.
   *
   * Checks:
   *   - How many batches are settled/pending/failed
   *   - Whether the latest settled batch root matches on-chain state
   */
  static verifyL1Settlement(
    batches: L2Batch[],
    onChainState: OnChainState,
  ): SettlementResult {
    if (batches.length === 0) {
      return {
        isComplete: true,
        settledBatches: 0,
        pendingBatches: 0,
        failedBatches: 0,
        rootConsistent: true,
      };
    }

    let settledBatches = 0;
    let pendingBatches = 0;
    let failedBatches = 0;

    for (const batch of batches) {
      switch (batch.l1Status) {
        case 'settled': settledBatches++; break;
        case 'pending':
        case 'batched': pendingBatches++; break;
        case 'failed': failedBatches++; break;
      }
    }

    // Find the latest settled batch by batch number
    const settledBatchList = batches
      .filter(b => b.l1Status === 'settled')
      .sort((a, b) => Number(b.batchNumber - a.batchNumber));

    let rootConsistent = true;
    if (settledBatchList.length > 0) {
      const latest = settledBatchList[0];
      rootConsistent =
        latest.newRegistryRoot === onChainState.walletRegistryRoot &&
        latest.newLifecycleRoot === onChainState.lifecycleRoot;
    }

    const isComplete = pendingBatches === 0 && failedBatches === 0 && rootConsistent;

    return {
      isComplete,
      settledBatches,
      pendingBatches,
      failedBatches,
      rootConsistent,
      reason: !isComplete
        ? `${pendingBatches} pending, ${failedBatches} failed${!rootConsistent ? ', root mismatch' : ''}`
        : undefined,
    };
  }

  // ─── Enrollment Consistency ─────────────────────────────────

  /**
   * Verify enrollment consistency between L2 registrations and roster.
   *
   * Compares wallet IDs from L2 registration events (isRegistration=true)
   * against wallet IDs in the roster. Reports mismatches in both directions.
   */
  static verifyEnrollmentConsistency(
    events: AuditEvent[],
    rosterEntries: { walletId: string }[],
  ): EnrollmentConsistencyResult {
    const registeredWallets = new Set<string>();
    for (const event of events) {
      if (event.isRegistration) {
        registeredWallets.add(event.walletId);
      }
    }

    const rosterWallets = new Set<string>();
    for (const entry of rosterEntries) {
      rosterWallets.add(entry.walletId);
    }

    const unregisteredWallets: string[] = [];
    for (const walletId of rosterWallets) {
      if (!registeredWallets.has(walletId)) {
        unregisteredWallets.push(walletId);
      }
    }

    const unrosteredWallets: string[] = [];
    for (const walletId of registeredWallets) {
      if (!rosterWallets.has(walletId)) {
        unrosteredWallets.push(walletId);
      }
    }

    const mismatchCount = unregisteredWallets.length + unrosteredWallets.length;

    return {
      isConsistent: mismatchCount === 0,
      registrationCount: registeredWallets.size,
      rosterCount: rosterWallets.size,
      mismatchCount,
      unregisteredWallets,
      unrosteredWallets,
      reason: mismatchCount > 0
        ? `${unregisteredWallets.length} unregistered, ${unrosteredWallets.length} unrostered`
        : undefined,
    };
  }

  // ─── Full Audit ─────────────────────────────────────────────

  /**
   * Run a full audit across all verification checks.
   *
   * overallHealthy = chain valid && no financial imbalance && no duplicates
   *                  && no gaps && enrollment consistent && settlement roots match
   *
   * Note: orphaned receipts and incomplete settlement DON'T fail overall health
   * (pending work is expected between batch intervals).
   */
  static runFullAudit(
    log: AuditLog,
    batches: L2Batch[],
    onChainState: OnChainState,
    rosterEntries: { walletId: string }[],
    orphanNow?: number,
    orphanThresholdMs?: number,
  ): FullAuditReport {
    const chainIntegrity = AuditService.verifyReceiptChain(log);
    const financialBalance = AuditService.verifyFinancialBalance(log.events);
    const duplicateDetection = AuditService.detectDuplicateClaims(log.events);
    const sequenceGaps = AuditService.detectSequenceGaps(log.events);
    const orphanedReceipts = AuditService.detectOrphanedReceipts(
      log.events, orphanNow, orphanThresholdMs,
    );
    const settlement = AuditService.verifyL1Settlement(batches, onChainState);
    const enrollmentConsistency = AuditService.verifyEnrollmentConsistency(
      log.events, rosterEntries,
    );

    // Critical checks — orphaned receipts and incomplete settlement excluded
    const overallHealthy =
      chainIntegrity.isValid &&
      financialBalance.isValid &&
      !duplicateDetection.hasDuplicates &&
      !sequenceGaps.hasGaps &&
      enrollmentConsistency.isConsistent &&
      settlement.rootConsistent;

    const details: string[] = [
      `Chain integrity: ${chainIntegrity.isValid ? 'PASS' : 'FAIL'} (${chainIntegrity.totalEvents} events)`,
      `Financial balance: ${financialBalance.isValid ? 'PASS' : 'FAIL'} (${financialBalance.totalClaims} claims)`,
      `Duplicate detection: ${duplicateDetection.hasDuplicates ? 'FOUND ' + duplicateDetection.totalDuplicates : 'NONE'}`,
      `Sequence gaps: ${sequenceGaps.hasGaps ? 'FOUND ' + sequenceGaps.totalGaps : 'NONE'}`,
      `Orphaned receipts: ${orphanedReceipts.hasOrphans ? orphanedReceipts.totalOrphans + ' orphaned' : 'NONE'}`,
      `Settlement: ${settlement.isComplete ? 'COMPLETE' : settlement.settledBatches + ' settled, ' + settlement.pendingBatches + ' pending'}`,
      `Enrollment: ${enrollmentConsistency.isConsistent ? 'CONSISTENT' : enrollmentConsistency.mismatchCount + ' mismatches'}`,
    ];

    return {
      chainIntegrity,
      financialBalance,
      duplicateDetection,
      sequenceGaps,
      orphanedReceipts,
      settlement,
      enrollmentConsistency,
      auditedAt: Date.now(),
      overallHealthy,
      details,
    };
  }
}
