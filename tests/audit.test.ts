/**
 * Audit — Data Availability & Audit Trail Tests
 *
 * All FAST (no ZkProgram compilation). Uses Poseidon from o1js for hash chain.
 *
 * Run: npx jest tests/audit.test.ts --verbose
 */
import { Field, Poseidon } from 'o1js';
import { AuditService, DEFAULT_ORPHAN_THRESHOLD_MS } from '../src/audit/audit-service.js';
import type {
  AuditEvent,
  AuditLog,
  OnChainState,
} from '../src/audit/audit-types.js';
import type { L2Batch } from '../src/l2/l2-types.js';
import type { ClaimContext } from '../src/reporting/report-types.js';

// ─── Helpers ────────────────────────────────────────────────

/** Build a minimal AuditEvent with sensible defaults. */
function makeEvent(overrides: Partial<AuditEvent> & { sequenceNumber: bigint; receiptId: string }): AuditEvent {
  return {
    walletId: '100',
    isRegistration: false,
    oldRegistryRoot: '200',
    newRegistryRoot: '201',
    oldLifecycleRoot: '300',
    newLifecycleRoot: '300',
    eventCommitment: '',
    chainHash: '',
    timestamp: Date.now(),
    l1Status: 'pending',
    ...overrides,
  };
}

/**
 * Build a valid chain of AuditEvents with correct Poseidon hash chain.
 */
function buildValidChain(count: number, baseTimestamp?: number): AuditEvent[] {
  const events: AuditEvent[] = [];
  let prevChainHash = Field(BigInt(AuditService.GENESIS_HASH));
  const ts = baseTimestamp ?? Date.now();

  for (let i = 0; i < count; i++) {
    const event = makeEvent({
      sequenceNumber: BigInt(i),
      receiptId: `l2-${String(i).padStart(8, '0')}`,
      walletId: String(1000 + i),
      isRegistration: i === 0, // First one is a registration
      oldRegistryRoot: String(2000 + i),
      newRegistryRoot: String(2001 + i),
      oldLifecycleRoot: String(3000 + i),
      newLifecycleRoot: i === 0 ? String(3001 + i) : String(3000 + i),
      timestamp: ts + i * 1000,
      l1Status: 'batched',
    });

    const commitment = AuditService.computeEventCommitment(event);
    const chainHash = AuditService.computeChainHash(prevChainHash, commitment);

    event.eventCommitment = commitment.toString();
    event.chainHash = chainHash.toString();
    prevChainHash = chainHash;

    events.push(event);
  }

  return events;
}

function makeAuditLog(events: AuditEvent[]): AuditLog {
  return {
    events,
    genesisHash: AuditService.GENESIS_HASH,
    latestChainHash: events.length > 0
      ? events[events.length - 1].chainHash
      : AuditService.GENESIS_HASH,
    eventCount: BigInt(events.length),
  };
}

function makeClaimContext(overrides?: Partial<ClaimContext>): ClaimContext {
  return {
    pharmacyWalletId: '5000',
    memberWalletId: '6000',
    prescriberWalletId: '7000',
    ndcHash: '8000',
    ingredientCostCents: 800,
    dispensingFeeCents: 200,
    quantityDispensed: '30000', // 30 x 1000
    dateOfService: 20250211,
    ...overrides,
  };
}

/** Attach financial data to an audit event (claimContext + pay amounts). */
function attachFinancialData(
  event: AuditEvent,
  opts: {
    ingredientCostCents: number;
    dispensingFeeCents: number;
    patientPayCents: number;
    planPayCents: number;
    ndcHash?: string;
    dateOfService?: number;
  },
): void {
  event.claimContext = makeClaimContext({
    ingredientCostCents: opts.ingredientCostCents,
    dispensingFeeCents: opts.dispensingFeeCents,
    ndcHash: opts.ndcHash,
    dateOfService: opts.dateOfService,
  });
  event.patientPayCents = opts.patientPayCents;
  event.planPayCents = opts.planPayCents;
}

// ─── AuditEvent Hash Chain ──────────────────────────────────

describe('AuditEvent Hash Chain', () => {
  test('computeEventCommitment produces deterministic hash from 7 fields', () => {
    const event = makeEvent({
      sequenceNumber: 0n,
      receiptId: 'l2-00000000',
      walletId: '100',
      isRegistration: true,
      oldRegistryRoot: '200',
      newRegistryRoot: '201',
      oldLifecycleRoot: '300',
      newLifecycleRoot: '301',
    });

    const hash1 = AuditService.computeEventCommitment(event);
    const hash2 = AuditService.computeEventCommitment(event);
    expect(hash1.toString()).toBe(hash2.toString());

    // Verify it matches manual Poseidon computation
    const manual = Poseidon.hash([
      Field(100n), Field(200n), Field(201n),
      Field(300n), Field(301n), Field(0n), Field(1n),
    ]);
    expect(hash1.toString()).toBe(manual.toString());
  });

  test('computeChainHash produces deterministic hash from prev + commitment', () => {
    const prev = Field(42);
    const commitment = Field(99);
    const hash1 = AuditService.computeChainHash(prev, commitment);
    const hash2 = AuditService.computeChainHash(prev, commitment);
    expect(hash1.toString()).toBe(hash2.toString());
    expect(hash1.toString()).toBe(Poseidon.hash([prev, commitment]).toString());
  });

  test('GENESIS_HASH is Poseidon.hash([Field(0)])', () => {
    const expected = Poseidon.hash([Field(0)]).toString();
    expect(AuditService.GENESIS_HASH).toBe(expected);
  });

  test('chain of 3 events produces correct sequential hashes', () => {
    const events = buildValidChain(3);

    // Manually verify chain
    let prevChain = Field(BigInt(AuditService.GENESIS_HASH));
    for (const event of events) {
      const commitment = Field(BigInt(event.eventCommitment));
      const expected = Poseidon.hash([prevChain, commitment]);
      expect(event.chainHash).toBe(expected.toString());
      prevChain = expected;
    }
  });

  test('tampering with one event breaks chain from that point forward', () => {
    const events = buildValidChain(3);

    // Tamper with event 1's eventCommitment — this breaks the chain hash verification
    const tampered = [...events];
    tampered[1] = { ...tampered[1], eventCommitment: Poseidon.hash([Field(99999)]).toString() };

    const log = makeAuditLog(tampered);
    const result = AuditService.verifyReceiptChain(log);

    // Event 1 should be broken (chain hash no longer matches recomputed value)
    expect(result.isValid).toBe(false);
    expect(result.brokenLinks).toContain(1);
  });
});

// ─── Chain Integrity Verification ───────────────────────────

describe('Chain Integrity Verification', () => {
  test('valid chain with 5 events returns isValid=true', () => {
    const events = buildValidChain(5);
    const log = makeAuditLog(events);
    const result = AuditService.verifyReceiptChain(log);

    expect(result.isValid).toBe(true);
    expect(result.totalEvents).toBe(5);
    expect(result.brokenLinks).toHaveLength(0);
    expect(result.reason).toBeUndefined();
  });

  test('empty log returns isValid=true (vacuously)', () => {
    const log = makeAuditLog([]);
    const result = AuditService.verifyReceiptChain(log);
    expect(result.isValid).toBe(true);
    expect(result.totalEvents).toBe(0);
  });

  test('single broken link detected at correct sequence number', () => {
    const events = buildValidChain(5);
    // Corrupt event 3's chainHash
    events[3] = { ...events[3], chainHash: '9999' };

    const log = makeAuditLog(events);
    const result = AuditService.verifyReceiptChain(log);

    expect(result.isValid).toBe(false);
    expect(result.brokenLinks).toContain(3);
  });

  test('multiple broken links all reported', () => {
    const events = buildValidChain(5);
    events[1] = { ...events[1], chainHash: '1111' };
    events[3] = { ...events[3], chainHash: '3333' };

    const log = makeAuditLog(events);
    const result = AuditService.verifyReceiptChain(log);

    expect(result.isValid).toBe(false);
    expect(result.brokenLinks).toContain(1);
    expect(result.brokenLinks).toContain(3);
  });

  test('chain with tampered eventCommitment detected', () => {
    const events = buildValidChain(3);
    // Tamper with event 1's eventCommitment (but keep chainHash as-is)
    events[1] = { ...events[1], eventCommitment: '12345' };

    const log = makeAuditLog(events);
    const result = AuditService.verifyReceiptChain(log);

    expect(result.isValid).toBe(false);
    expect(result.brokenLinks).toContain(1);
  });
});

// ─── Financial Balance ──────────────────────────────────────

describe('Financial Balance', () => {
  test('balanced claims returns isValid=true', () => {
    const events = buildValidChain(3);
    // ingredientCost(800) + dispensingFee(200) = 1000
    attachFinancialData(events[0], {
      ingredientCostCents: 800, dispensingFeeCents: 200,
      patientPayCents: 300, planPayCents: 700,
    });
    attachFinancialData(events[1], {
      ingredientCostCents: 500, dispensingFeeCents: 100,
      patientPayCents: 100, planPayCents: 500,
    });
    // Event 2 has no context (registration) — should be skipped

    const result = AuditService.verifyFinancialBalance(events);
    expect(result.isValid).toBe(true);
    expect(result.totalClaims).toBe(2);
    expect(result.imbalancedClaims).toHaveLength(0);
    expect(result.totalPatientPayCents).toBe(400);
    expect(result.totalPlanPayCents).toBe(1200);
  });

  test('imbalanced claim detected and reported', () => {
    const events = buildValidChain(2);
    attachFinancialData(events[0], {
      ingredientCostCents: 800, dispensingFeeCents: 200,
      patientPayCents: 300, planPayCents: 600, // 300+600=900 != 800+200=1000
    });

    const result = AuditService.verifyFinancialBalance(events);
    expect(result.isValid).toBe(false);
    expect(result.imbalancedClaims).toContain(events[0].receiptId);
    expect(result.reason).toContain('1 claim(s)');
  });

  test('events without claimContext skipped (registrations)', () => {
    const events = buildValidChain(3);
    // No claimContext on any event
    const result = AuditService.verifyFinancialBalance(events);
    expect(result.isValid).toBe(true);
    expect(result.totalClaims).toBe(0);
  });

  test('mix of balanced and imbalanced correctly categorized', () => {
    const events = buildValidChain(3);
    attachFinancialData(events[0], {
      ingredientCostCents: 800, dispensingFeeCents: 200,
      patientPayCents: 300, planPayCents: 700, // balanced
    });
    attachFinancialData(events[1], {
      ingredientCostCents: 500, dispensingFeeCents: 100,
      patientPayCents: 100, planPayCents: 400, // 100+400=500 != 500+100=600 — IMBALANCED
    });

    const result = AuditService.verifyFinancialBalance(events);
    expect(result.isValid).toBe(false);
    expect(result.totalClaims).toBe(2);
    expect(result.imbalancedClaims).toEqual([events[1].receiptId]);
  });

  test('reversals included in totals', () => {
    const events = buildValidChain(2);
    attachFinancialData(events[0], {
      ingredientCostCents: 800, dispensingFeeCents: 200,
      patientPayCents: 300, planPayCents: 700,
    });
    // Reversal: zero cost, zero pay — still balanced
    attachFinancialData(events[1], {
      ingredientCostCents: 0, dispensingFeeCents: 0,
      patientPayCents: 0, planPayCents: 0,
    });

    const result = AuditService.verifyFinancialBalance(events);
    expect(result.isValid).toBe(true);
    expect(result.totalClaims).toBe(2);
    expect(result.totalIngredientCostCents).toBe(800);
  });
});

// ─── Duplicate Detection ────────────────────────────────────

describe('Duplicate Detection', () => {
  test('no duplicates returns hasDuplicates=false', () => {
    const events = buildValidChain(3);
    events[0].claimContext = makeClaimContext({ ndcHash: '8001', dateOfService: 20250211 });
    events[1].claimContext = makeClaimContext({ ndcHash: '8002', dateOfService: 20250211 });

    const result = AuditService.detectDuplicateClaims(events);
    expect(result.hasDuplicates).toBe(false);
    expect(result.duplicateGroups).toHaveLength(0);
    expect(result.totalDuplicates).toBe(0);
  });

  test('same wallet+ndc+date detected as duplicate', () => {
    const events = buildValidChain(3);
    events[0].claimContext = makeClaimContext({ ndcHash: '8001', dateOfService: 20250211 });
    events[1].walletId = events[0].walletId; // Same wallet
    events[1].claimContext = makeClaimContext({ ndcHash: '8001', dateOfService: 20250211 });

    const result = AuditService.detectDuplicateClaims(events);
    expect(result.hasDuplicates).toBe(true);
    expect(result.duplicateGroups).toHaveLength(1);
    expect(result.duplicateGroups[0].receiptIds).toContain(events[0].receiptId);
    expect(result.duplicateGroups[0].receiptIds).toContain(events[1].receiptId);
  });

  test('different dates for same wallet+ndc = not duplicate', () => {
    const events = buildValidChain(2);
    events[0].claimContext = makeClaimContext({ ndcHash: '8001', dateOfService: 20250211 });
    events[1].walletId = events[0].walletId;
    events[1].claimContext = makeClaimContext({ ndcHash: '8001', dateOfService: 20250212 });

    const result = AuditService.detectDuplicateClaims(events);
    expect(result.hasDuplicates).toBe(false);
  });

  test('multiple duplicate groups reported separately', () => {
    const events = buildValidChain(4);
    // Group 1: events 0 and 1
    events[0].claimContext = makeClaimContext({ ndcHash: '8001', dateOfService: 20250211 });
    events[1].walletId = events[0].walletId;
    events[1].claimContext = makeClaimContext({ ndcHash: '8001', dateOfService: 20250211 });
    // Group 2: events 2 and 3
    events[2].claimContext = makeClaimContext({ ndcHash: '8002', dateOfService: 20250213 });
    events[3].walletId = events[2].walletId;
    events[3].claimContext = makeClaimContext({ ndcHash: '8002', dateOfService: 20250213 });

    const result = AuditService.detectDuplicateClaims(events);
    expect(result.hasDuplicates).toBe(true);
    expect(result.duplicateGroups).toHaveLength(2);
  });

  test('events without claimContext excluded from duplicate check', () => {
    const events = buildValidChain(2);
    // No claimContext — should not be considered duplicates even with same walletId
    const result = AuditService.detectDuplicateClaims(events);
    expect(result.hasDuplicates).toBe(false);
    expect(result.totalDuplicates).toBe(0);
  });
});

// ─── Sequence Gap Detection ─────────────────────────────────

describe('Sequence Gap Detection', () => {
  test('contiguous sequence returns hasGaps=false', () => {
    const events = buildValidChain(5);
    const result = AuditService.detectSequenceGaps(events);
    expect(result.hasGaps).toBe(false);
    expect(result.gaps).toHaveLength(0);
  });

  test('single gap detected (0,1,3 -> gap at 2)', () => {
    const events = buildValidChain(3);
    // Remove event 1 and shift event 2 to sequence 2 (simulating gap)
    events.splice(1, 1); // Now: seq 0, seq 2
    // events[1] has sequenceNumber 2n already from buildValidChain

    const result = AuditService.detectSequenceGaps(events);
    expect(result.hasGaps).toBe(true);
    expect(result.totalGaps).toBe(1);
    expect(result.gaps[0].expected).toBe(1n);
    expect(result.gaps[0].actual).toBe(2n);
  });

  test('multiple gaps detected', () => {
    const events = buildValidChain(5);
    // Keep only events 0, 2, 4 (gaps at 1 and 3)
    const sparse = [events[0], events[2], events[4]];

    const result = AuditService.detectSequenceGaps(sparse);
    expect(result.hasGaps).toBe(true);
    expect(result.totalGaps).toBe(2);
  });

  test('empty events returns hasGaps=false', () => {
    const result = AuditService.detectSequenceGaps([]);
    expect(result.hasGaps).toBe(false);
    expect(result.totalGaps).toBe(0);
  });
});

// ─── Orphaned Receipt Detection ─────────────────────────────

describe('Orphaned Receipt Detection', () => {
  test('all receipts batched returns hasOrphans=false', () => {
    const events = buildValidChain(3);
    // All events have l1Status='batched' from buildValidChain
    const result = AuditService.detectOrphanedReceipts(events);
    expect(result.hasOrphans).toBe(false);
    expect(result.totalOrphans).toBe(0);
  });

  test('pending receipt older than threshold detected', () => {
    const now = Date.now();
    const events = buildValidChain(3, now - DEFAULT_ORPHAN_THRESHOLD_MS - 60_000);
    events[1].l1Status = 'pending'; // Make event 1 pending

    const result = AuditService.detectOrphanedReceipts(events, now);
    expect(result.hasOrphans).toBe(true);
    expect(result.orphanedReceiptIds).toContain(events[1].receiptId);
    expect(result.totalOrphans).toBe(1);
  });

  test('recently pending receipt NOT flagged (within grace period)', () => {
    const now = Date.now();
    const events = buildValidChain(3, now - 1000); // Created 1s ago
    events[1].l1Status = 'pending';

    const result = AuditService.detectOrphanedReceipts(events, now);
    expect(result.hasOrphans).toBe(false);
  });

  test('multiple orphans reported', () => {
    const now = Date.now();
    const events = buildValidChain(4, now - DEFAULT_ORPHAN_THRESHOLD_MS - 60_000);
    events[0].l1Status = 'pending';
    events[2].l1Status = 'pending';

    const result = AuditService.detectOrphanedReceipts(events, now);
    expect(result.hasOrphans).toBe(true);
    expect(result.totalOrphans).toBe(2);
    expect(result.orphanedReceiptIds).toContain(events[0].receiptId);
    expect(result.orphanedReceiptIds).toContain(events[2].receiptId);
  });
});

// ─── L1 Settlement Verification ─────────────────────────────

describe('L1 Settlement Verification', () => {
  const baseState: OnChainState = {
    walletRegistryRoot: '5000',
    lifecycleRoot: '6000',
    walletCount: 10n,
  };

  function makeBatch(overrides: Partial<L2Batch> & { batchNumber: bigint }): L2Batch {
    return {
      blockNumbers: [0n],
      registrationCount: 1,
      transitionCount: 3,
      oldRegistryRoot: '4000',
      newRegistryRoot: '5000',
      oldLifecycleRoot: '5500',
      newLifecycleRoot: '6000',
      batchProofJson: '{}',
      createdAt: Date.now(),
      l1Status: 'settled',
      ...overrides,
    };
  }

  test('all batches settled with matching roots returns isComplete=true', () => {
    const batches: L2Batch[] = [
      makeBatch({ batchNumber: 0n, newRegistryRoot: '5000', newLifecycleRoot: '6000' }),
    ];
    const result = AuditService.verifyL1Settlement(batches, baseState);
    expect(result.isComplete).toBe(true);
    expect(result.settledBatches).toBe(1);
    expect(result.pendingBatches).toBe(0);
    expect(result.failedBatches).toBe(0);
    expect(result.rootConsistent).toBe(true);
  });

  test('pending batches reduce settled count', () => {
    const batches: L2Batch[] = [
      makeBatch({ batchNumber: 0n, l1Status: 'settled' }),
      makeBatch({ batchNumber: 1n, l1Status: 'batched' }),
    ];
    const result = AuditService.verifyL1Settlement(batches, baseState);
    expect(result.isComplete).toBe(false);
    expect(result.settledBatches).toBe(1);
    expect(result.pendingBatches).toBe(1);
  });

  test('failed batch reported', () => {
    const batches: L2Batch[] = [
      makeBatch({ batchNumber: 0n, l1Status: 'failed' }),
    ];
    const result = AuditService.verifyL1Settlement(batches, baseState);
    expect(result.isComplete).toBe(false);
    expect(result.failedBatches).toBe(1);
    expect(result.reason).toContain('failed');
  });

  test('root mismatch between latest batch and on-chain state detected', () => {
    const batches: L2Batch[] = [
      makeBatch({
        batchNumber: 0n,
        l1Status: 'settled',
        newRegistryRoot: '9999', // Doesn't match on-chain 5000
        newLifecycleRoot: '6000',
      }),
    ];
    const result = AuditService.verifyL1Settlement(batches, baseState);
    expect(result.isComplete).toBe(false);
    expect(result.rootConsistent).toBe(false);
    expect(result.reason).toContain('root mismatch');
  });

  test('empty batches returns isComplete=true (vacuously)', () => {
    const result = AuditService.verifyL1Settlement([], baseState);
    expect(result.isComplete).toBe(true);
    expect(result.rootConsistent).toBe(true);
  });
});

// ─── Enrollment Consistency ─────────────────────────────────

describe('Enrollment Consistency', () => {
  test('all registered wallets in roster returns isConsistent=true', () => {
    const events = buildValidChain(3);
    events[0].isRegistration = true;
    events[1].isRegistration = true;
    events[2].isRegistration = true;

    const roster = [
      { walletId: events[0].walletId },
      { walletId: events[1].walletId },
      { walletId: events[2].walletId },
    ];

    const result = AuditService.verifyEnrollmentConsistency(events, roster);
    expect(result.isConsistent).toBe(true);
    expect(result.mismatchCount).toBe(0);
    expect(result.registrationCount).toBe(3);
    expect(result.rosterCount).toBe(3);
  });

  test('wallet in roster but no L2 registration event detected', () => {
    const events = buildValidChain(2);
    events[0].isRegistration = true;
    events[1].isRegistration = false; // Not a registration

    const roster = [
      { walletId: events[0].walletId },
      { walletId: '999999' }, // Not in L2 events
    ];

    const result = AuditService.verifyEnrollmentConsistency(events, roster);
    expect(result.isConsistent).toBe(false);
    expect(result.unregisteredWallets).toContain('999999');
  });

  test('L2 registration but not in roster detected', () => {
    const events = buildValidChain(2);
    events[0].isRegistration = true;
    events[1].isRegistration = true;

    const roster = [
      { walletId: events[0].walletId }, // Only event 0 in roster
    ];

    const result = AuditService.verifyEnrollmentConsistency(events, roster);
    expect(result.isConsistent).toBe(false);
    expect(result.unrosteredWallets).toContain(events[1].walletId);
  });

  test('mixed mismatches reported', () => {
    const events = buildValidChain(2);
    events[0].isRegistration = true;
    events[1].isRegistration = true;

    const roster = [
      { walletId: '888888' }, // Unregistered
    ];

    const result = AuditService.verifyEnrollmentConsistency(events, roster);
    expect(result.isConsistent).toBe(false);
    expect(result.unregisteredWallets).toHaveLength(1);
    expect(result.unrosteredWallets).toHaveLength(2);
    expect(result.mismatchCount).toBe(3);
  });

  test('empty inputs returns isConsistent=true', () => {
    const result = AuditService.verifyEnrollmentConsistency([], []);
    expect(result.isConsistent).toBe(true);
    expect(result.registrationCount).toBe(0);
    expect(result.rosterCount).toBe(0);
  });
});

// ─── Full Audit Report ──────────────────────────────────────

describe('Full Audit Report', () => {
  const baseOnChainState: OnChainState = {
    walletRegistryRoot: '5000',
    lifecycleRoot: '6000',
    walletCount: 3n,
  };

  test('healthy system returns overallHealthy=true with all checks passing', () => {
    const events = buildValidChain(3);
    events[0].isRegistration = true;
    attachFinancialData(events[0], {
      ingredientCostCents: 800, dispensingFeeCents: 200,
      patientPayCents: 300, planPayCents: 700,
    });

    const roster = [
      { walletId: events[0].walletId },
    ];

    const batches: L2Batch[] = [{
      batchNumber: 0n,
      blockNumbers: [0n],
      registrationCount: 1,
      transitionCount: 3,
      oldRegistryRoot: '4000',
      newRegistryRoot: '5000',
      oldLifecycleRoot: '5500',
      newLifecycleRoot: '6000',
      batchProofJson: '{}',
      createdAt: Date.now(),
      l1Status: 'settled',
    }];

    const log = makeAuditLog(events);
    const report = AuditService.runFullAudit(
      log, batches, baseOnChainState, roster,
    );

    expect(report.overallHealthy).toBe(true);
    expect(report.chainIntegrity.isValid).toBe(true);
    expect(report.financialBalance.isValid).toBe(true);
    expect(report.duplicateDetection.hasDuplicates).toBe(false);
    expect(report.sequenceGaps.hasGaps).toBe(false);
    expect(report.details).toHaveLength(7);
  });

  test('chain break makes overallHealthy=false', () => {
    const events = buildValidChain(3);
    events[1] = { ...events[1], chainHash: '9999' };

    const log = makeAuditLog(events);
    const report = AuditService.runFullAudit(
      log, [], baseOnChainState, [],
    );

    expect(report.overallHealthy).toBe(false);
    expect(report.chainIntegrity.isValid).toBe(false);
  });

  test('financial imbalance makes overallHealthy=false', () => {
    const events = buildValidChain(2);
    attachFinancialData(events[0], {
      ingredientCostCents: 800, dispensingFeeCents: 200,
      patientPayCents: 100, planPayCents: 100, // 200 != 1000
    });

    const log = makeAuditLog(events);
    const report = AuditService.runFullAudit(
      log, [], baseOnChainState, [],
    );

    expect(report.overallHealthy).toBe(false);
    expect(report.financialBalance.isValid).toBe(false);
  });

  test('orphaned receipts DON\'T make overallHealthy=false (expected during normal ops)', () => {
    const now = Date.now();
    const events = buildValidChain(3, now - DEFAULT_ORPHAN_THRESHOLD_MS - 60_000);
    events[1].l1Status = 'pending'; // Orphaned

    // Provide matching roster entries for the registration event (event 0)
    const roster = events
      .filter(e => e.isRegistration)
      .map(e => ({ walletId: e.walletId }));

    const log = makeAuditLog(events);
    const report = AuditService.runFullAudit(
      log, [], baseOnChainState, roster, now,
    );

    expect(report.orphanedReceipts.hasOrphans).toBe(true);
    // But overallHealthy is still true (orphans don't fail health)
    expect(report.overallHealthy).toBe(true);
  });

  test('details array contains summary message for each check', () => {
    const events = buildValidChain(2);
    const log = makeAuditLog(events);
    const report = AuditService.runFullAudit(
      log, [], baseOnChainState, [],
    );

    expect(report.details).toHaveLength(7);
    expect(report.details[0]).toContain('Chain integrity');
    expect(report.details[1]).toContain('Financial balance');
    expect(report.details[2]).toContain('Duplicate detection');
    expect(report.details[3]).toContain('Sequence gaps');
    expect(report.details[4]).toContain('Orphaned receipts');
    expect(report.details[5]).toContain('Settlement');
    expect(report.details[6]).toContain('Enrollment');
  });
});
