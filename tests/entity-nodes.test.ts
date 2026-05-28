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
 * Entity Node SDK — Unit Tests
 *
 * Tests for EntityNodeBase, MemberNode, PrescriberNode, PharmacyNode,
 * InsurerNode, and ProofDelegateClient/Server.
 *
 * All tests are mock-based (no ZkProgram compilation, no real proofs).
 * Run: npx jest tests/entity-nodes.test.ts --verbose
 */
import { Field, Poseidon } from 'o1js';
import { EntityNodeBase } from '../src/nodes/entity-node-base.js';
import { MemberNode } from '../src/nodes/member-node.js';
import { PrescriberNode } from '../src/nodes/prescriber-node.js';
import { PharmacyNode } from '../src/nodes/pharmacy-node.js';
import { InsurerNode } from '../src/nodes/insurer-node.js';
import { ProofDelegateClient, ProofDelegateServer } from '../src/nodes/proof-delegate.js';
import type {
  EntityClaimView,
  MemberNodeConfig,
  PrescriberNodeConfig,
  PharmacyNodeConfig,
  InsurerNodeConfig,
} from '../src/nodes/entity-node-types.js';
import type { ClaimAccumulatorEntry } from '../src/l2/claim-accumulator-types.js';

// ─── Test Helpers ─────────────────────────────────────────────

const MOCK_SEQUENCER_URL = 'http://localhost:9999';

function makeMemberWalletId(): string {
  return Poseidon.hash([Field(0), Field(100), Field(200), Field(300), Field(400), Field(500), Field(0)]).toString();
}

function makePrescriberWalletId(): string {
  return Poseidon.hash([Field(1), Field(101), Field(201), Field(301)]).toString();
}

function makePharmacyWalletId(): string {
  return Poseidon.hash([Field(2), Field(102), Field(202), Field(302)]).toString();
}

function makeNdcHash(n: number): string {
  return Poseidon.hash([Field(n)]).toString();
}

/** Build a mock ClaimAccumulatorEntry */
function mockClaimEntry(overrides: Partial<{
  leafIndex: bigint;
  memberWalletId: string;
  pharmacyWalletId: string;
  prescriberWalletId: string;
  ndcHash: string;
  dateOfService: string;
  patientPayCents: string;
  planPayCents: string;
  operationType: string;
  receiptId: string;
  brandName: string;
  tierLevel: number;
  therapeuticClass: string;
}> = {}): ClaimAccumulatorEntry {
  const leaf = {
    memberWalletId: overrides.memberWalletId ?? makeMemberWalletId(),
    ndcHash: overrides.ndcHash ?? makeNdcHash(1),
    pharmacyWalletId: overrides.pharmacyWalletId ?? makePharmacyWalletId(),
    prescriberWalletId: overrides.prescriberWalletId ?? makePrescriberWalletId(),
    dateOfService: overrides.dateOfService ?? '20260115',
    patientPayCents: overrides.patientPayCents ?? '1000',
    planPayCents: overrides.planPayCents ?? '5000',
    operationType: overrides.operationType ?? '1',
  };
  return {
    leafIndex: overrides.leafIndex ?? 0n,
    leaf,
    leafHash: Poseidon.hash([
      Field(BigInt(leaf.memberWalletId)),
      Field(BigInt(leaf.ndcHash)),
      Field(BigInt(leaf.pharmacyWalletId)),
      Field(BigInt(leaf.prescriberWalletId)),
      Field(BigInt(leaf.dateOfService)),
      Field(BigInt(leaf.patientPayCents)),
      Field(BigInt(leaf.planPayCents)),
      Field(BigInt(leaf.operationType)),
    ]).toString(),
    metadata: {
      receiptId: overrides.receiptId ?? 'rcpt-001',
      timestamp: Date.now(),
      brandName: overrides.brandName ?? 'TestDrug',
      tierLevel: overrides.tierLevel ?? 1,
      therapeuticClass: overrides.therapeuticClass ?? 'Cardiology',
    },
  };
}

/** Concrete subclass for testing the abstract EntityNodeBase */
class TestEntityNode extends EntityNodeBase {
  // Expose protected methods for testing
  public testToClaimViews(entries: ClaimAccumulatorEntry[]): EntityClaimView[] {
    return this.toClaimViews(entries);
  }
  public testSummarize(views: EntityClaimView[]) {
    return this.summarize(views);
  }
  public testFilterByDateRange(views: EntityClaimView[], start: string, end: string) {
    return this.filterByDateRange(views, start, end);
  }
  public testMedicationBreakdown(views: EntityClaimView[]) {
    return this.medicationBreakdown(views);
  }
}

// ═══════════════════════════════════════════════════════════════
// EntityNodeBase
// ═══════════════════════════════════════════════════════════════

describe('EntityNodeBase', () => {
  test('construction requires sequencerUrl', () => {
    expect(() => new TestEntityNode({
      role: 'member',
      sequencerUrl: '',
      walletId: '123',
    })).toThrow('sequencerUrl is required');
  });

  test('construction requires role', () => {
    expect(() => new TestEntityNode({
      role: '' as any,
      sequencerUrl: MOCK_SEQUENCER_URL,
    })).toThrow('role is required');
  });

  test('construction succeeds with valid config', () => {
    const node = new TestEntityNode({
      role: 'member',
      sequencerUrl: MOCK_SEQUENCER_URL,
      walletId: '12345',
      displayName: 'Test Node',
    });
    expect(node.getRole()).toBe('member');
    expect(node.getWalletId()).toBe('12345');
    expect(node.getDisplayName()).toBe('Test Node');
  });

  test('getPartitionRouter returns null before discovery', () => {
    const node = new TestEntityNode({
      role: 'member',
      sequencerUrl: MOCK_SEQUENCER_URL,
    });
    expect(node.getPartitionRouter()).toBeNull();
  });

  // ─── toClaimViews ────────────────────────────────

  test('toClaimViews transforms entries correctly', () => {
    const node = new TestEntityNode({
      role: 'member',
      sequencerUrl: MOCK_SEQUENCER_URL,
    });

    const entries = [
      mockClaimEntry({ leafIndex: 0n, patientPayCents: '1000', planPayCents: '5000' }),
      mockClaimEntry({ leafIndex: 1n, operationType: '2', patientPayCents: '1000', planPayCents: '5000' }),
    ];

    const views = node.testToClaimViews(entries);

    expect(views).toHaveLength(2);
    expect(views[0].leafIndex).toBe(0n);
    expect(views[0].operationType).toBe('fulfillment');
    expect(views[0].patientPayCents).toBe('1000');
    expect(views[0].planPayCents).toBe('5000');
    expect(views[0].brandName).toBe('TestDrug');
    expect(views[0].tierLevel).toBe(1);

    expect(views[1].leafIndex).toBe(1n);
    expect(views[1].operationType).toBe('reversal');
  });

  // ─── summarize ───────────────────────────────────

  test('summarize computes correct totals', () => {
    const node = new TestEntityNode({
      role: 'member',
      sequencerUrl: MOCK_SEQUENCER_URL,
    });

    const ndcHash1 = makeNdcHash(1);
    const ndcHash2 = makeNdcHash(2);

    const views: EntityClaimView[] = [
      {
        leafIndex: 0n, dateOfService: '20260110', patientPayCents: '1000', planPayCents: '5000',
        operationType: 'fulfillment', memberWalletId: 'M1', pharmacyWalletId: 'P1',
        prescriberWalletId: 'D1', ndcHash: ndcHash1, receiptId: 'r1', timestamp: 100,
      },
      {
        leafIndex: 1n, dateOfService: '20260115', patientPayCents: '3000', planPayCents: '9000',
        operationType: 'fulfillment', memberWalletId: 'M1', pharmacyWalletId: 'P1',
        prescriberWalletId: 'D1', ndcHash: ndcHash2, receiptId: 'r2', timestamp: 200,
      },
      {
        leafIndex: 2n, dateOfService: '20260120', patientPayCents: '1000', planPayCents: '5000',
        operationType: 'reversal', memberWalletId: 'M1', pharmacyWalletId: 'P1',
        prescriberWalletId: 'D1', ndcHash: ndcHash1, receiptId: 'r3', timestamp: 300,
      },
    ];

    const summary = node.testSummarize(views);

    expect(summary.totalClaims).toBe(2);
    expect(summary.totalReversals).toBe(1);
    expect(summary.activeClaims).toBe(1);
    // Reversals are subtracted: (1000+3000-1000)=3000, (5000+9000-5000)=9000
    expect(summary.totalPatientPayCents).toBe(3000n);
    expect(summary.totalPlanPayCents).toBe(9000n);
    expect(summary.uniqueMedications).toBe(2);
    expect(summary.dateRange).toEqual({ earliest: '20260110', latest: '20260120' });
  });

  test('summarize returns null dateRange for empty views', () => {
    const node = new TestEntityNode({
      role: 'member',
      sequencerUrl: MOCK_SEQUENCER_URL,
    });
    const summary = node.testSummarize([]);
    expect(summary.totalClaims).toBe(0);
    expect(summary.totalReversals).toBe(0);
    expect(summary.dateRange).toBeNull();
  });

  // ─── filterByDateRange ───────────────────────────

  test('filterByDateRange filters inclusively', () => {
    const node = new TestEntityNode({
      role: 'member',
      sequencerUrl: MOCK_SEQUENCER_URL,
    });

    const views: EntityClaimView[] = [
      { leafIndex: 0n, dateOfService: '20260110', patientPayCents: '0', planPayCents: '0', operationType: 'fulfillment', memberWalletId: 'M', pharmacyWalletId: 'P', prescriberWalletId: 'D', ndcHash: 'N', receiptId: 'r1', timestamp: 100 },
      { leafIndex: 1n, dateOfService: '20260115', patientPayCents: '0', planPayCents: '0', operationType: 'fulfillment', memberWalletId: 'M', pharmacyWalletId: 'P', prescriberWalletId: 'D', ndcHash: 'N', receiptId: 'r2', timestamp: 200 },
      { leafIndex: 2n, dateOfService: '20260120', patientPayCents: '0', planPayCents: '0', operationType: 'fulfillment', memberWalletId: 'M', pharmacyWalletId: 'P', prescriberWalletId: 'D', ndcHash: 'N', receiptId: 'r3', timestamp: 300 },
    ];

    const filtered = node.testFilterByDateRange(views, '20260110', '20260115');
    expect(filtered).toHaveLength(2);
    expect(filtered[0].dateOfService).toBe('20260110');
    expect(filtered[1].dateOfService).toBe('20260115');
  });

  // ─── medicationBreakdown ─────────────────────────

  test('medicationBreakdown groups by NDC and sorts by count', () => {
    const node = new TestEntityNode({
      role: 'member',
      sequencerUrl: MOCK_SEQUENCER_URL,
    });

    const ndcA = makeNdcHash(1);
    const ndcB = makeNdcHash(2);

    const views: EntityClaimView[] = [
      { leafIndex: 0n, dateOfService: '20260110', patientPayCents: '500', planPayCents: '2000', operationType: 'fulfillment', memberWalletId: 'M', pharmacyWalletId: 'P', prescriberWalletId: 'D', ndcHash: ndcA, brandName: 'DrugA', tierLevel: 1, receiptId: 'r1', timestamp: 100 },
      { leafIndex: 1n, dateOfService: '20260111', patientPayCents: '500', planPayCents: '2000', operationType: 'fulfillment', memberWalletId: 'M', pharmacyWalletId: 'P', prescriberWalletId: 'D', ndcHash: ndcA, brandName: 'DrugA', tierLevel: 1, receiptId: 'r2', timestamp: 200 },
      { leafIndex: 2n, dateOfService: '20260112', patientPayCents: '3000', planPayCents: '6000', operationType: 'fulfillment', memberWalletId: 'M', pharmacyWalletId: 'P', prescriberWalletId: 'D', ndcHash: ndcB, brandName: 'DrugB', tierLevel: 2, receiptId: 'r3', timestamp: 300 },
    ];

    const breakdown = node.testMedicationBreakdown(views);

    expect(breakdown).toHaveLength(2);
    // DrugA has 2 claims, DrugB has 1 → DrugA first
    expect(breakdown[0].ndcHash).toBe(ndcA);
    expect(breakdown[0].claimCount).toBe(2);
    expect(breakdown[0].totalPatientPayCents).toBe(1000n);
    expect(breakdown[0].brandName).toBe('DrugA');

    expect(breakdown[1].ndcHash).toBe(ndcB);
    expect(breakdown[1].claimCount).toBe(1);
    expect(breakdown[1].totalPlanPayCents).toBe(6000n);
  });
});

// ═══════════════════════════════════════════════════════════════
// MemberNode
// ═══════════════════════════════════════════════════════════════

describe('MemberNode', () => {
  const walletId = makeMemberWalletId();

  test('construction requires walletId', () => {
    expect(() => new MemberNode({
      role: 'member',
      sequencerUrl: MOCK_SEQUENCER_URL,
      walletId: '',
    } as MemberNodeConfig)).toThrow('walletId is required');
  });

  test('construction succeeds with valid config', () => {
    const node = new MemberNode({
      role: 'member',
      sequencerUrl: MOCK_SEQUENCER_URL,
      walletId,
      displayName: 'Alice',
    });
    expect(node.getRole()).toBe('member');
    expect(node.getWalletId()).toBe(walletId);
    expect(node.isCompiled()).toBe(false);
  });

  test('proof methods throw before compilation', async () => {
    const node = new MemberNode({
      role: 'member',
      sequencerUrl: MOCK_SEQUENCER_URL,
      walletId,
    });

    await expect(
      node.proveRegistration(
        [Field(0), Field(0), Field(0), Field(0), Field(0), Field(0), Field(0)],
        {} as any, {} as any, Field(0), Field(0),
      ),
    ).rejects.toThrow('Programs not compiled');

    await expect(
      node.proveWalletUpdate(
        [Field(0), Field(0), Field(0), Field(0), Field(0), Field(0), Field(0)],
        Field(0), Field(0), Field(0),
        {} as any, {} as any, Field(0), Field(0), Field(0),
      ),
    ).rejects.toThrow('Programs not compiled');
  });

  test('getProofTimings returns empty before any proofs', () => {
    const node = new MemberNode({
      role: 'member',
      sequencerUrl: MOCK_SEQUENCER_URL,
      walletId,
    });
    expect(node.getProofTimings()).toHaveLength(0);
  });

  test('buildPreimage returns 7-element array', () => {
    const preimage = MemberNode.buildPreimage(
      {
        cardholderId: 'CH001',
        dateOfBirth: '19900101',
        firstName: 'Alice',
        lastName: 'Smith',
      },
      'SuperSecretKey123456!@#$',
    );
    expect(preimage).toHaveLength(7);
    // First element is domain tag (0 for member)
    expect(preimage[0].toString()).toBe(Field(0).toString());
  });
});

// ═══════════════════════════════════════════════════════════════
// PrescriberNode
// ═══════════════════════════════════════════════════════════════

describe('PrescriberNode', () => {
  const walletId = makePrescriberWalletId();

  test('construction requires walletId', () => {
    expect(() => new PrescriberNode({
      role: 'prescriber',
      sequencerUrl: MOCK_SEQUENCER_URL,
      walletId: '',
    } as PrescriberNodeConfig)).toThrow('walletId is required');
  });

  test('construction succeeds with valid config', () => {
    const node = new PrescriberNode({
      role: 'prescriber',
      sequencerUrl: MOCK_SEQUENCER_URL,
      walletId,
      displayName: 'Dr. Smith',
    });
    expect(node.getRole()).toBe('prescriber');
    expect(node.isCompiled()).toBe(false);
  });

  test('proof methods throw before compilation', async () => {
    const node = new PrescriberNode({
      role: 'prescriber',
      sequencerUrl: MOCK_SEQUENCER_URL,
      walletId,
    });

    await expect(
      node.proveRegistration(
        [Field(0), Field(0), Field(0), Field(0), Field(0), Field(0), Field(0)],
        {} as any, {} as any, Field(0), Field(0),
      ),
    ).rejects.toThrow('Programs not compiled');
  });

  test('buildPreimage returns 7-element array with prescriber domain tag', () => {
    const preimage = PrescriberNode.buildPreimage(
      {
        prescriberIdQualifier: 1,
        prescriberId: 'NPI1234567890',
      },
      'SuperSecretKey123456!@#$',
    );
    expect(preimage).toHaveLength(7);
    // First element is domain tag (1 for prescriber)
    expect(preimage[0].toString()).toBe(Field(1).toString());
    // Prescriber has 3 preimage fields + 3 zero padding
    expect(preimage[4].toString()).toBe(Field(0).toString());
    expect(preimage[5].toString()).toBe(Field(0).toString());
    expect(preimage[6].toString()).toBe(Field(0).toString());
  });
});

// ═══════════════════════════════════════════════════════════════
// PharmacyNode
// ═══════════════════════════════════════════════════════════════

describe('PharmacyNode', () => {
  const walletId = makePharmacyWalletId();

  test('construction requires walletId', () => {
    expect(() => new PharmacyNode({
      role: 'pharmacy',
      sequencerUrl: MOCK_SEQUENCER_URL,
      walletId: '',
    } as PharmacyNodeConfig)).toThrow('walletId is required');
  });

  test('construction succeeds with valid config', () => {
    const node = new PharmacyNode({
      role: 'pharmacy',
      sequencerUrl: MOCK_SEQUENCER_URL,
      walletId,
      displayName: 'Main St Pharmacy',
    });
    expect(node.getRole()).toBe('pharmacy');
    expect(node.isCompiled()).toBe(false);
  });

  test('proof methods throw before compilation', async () => {
    const node = new PharmacyNode({
      role: 'pharmacy',
      sequencerUrl: MOCK_SEQUENCER_URL,
      walletId,
    });

    await expect(
      node.proveRegistration(
        [Field(0), Field(0), Field(0), Field(0), Field(0), Field(0), Field(0)],
        {} as any, {} as any, Field(0), Field(0),
      ),
    ).rejects.toThrow('Programs not compiled');
  });

  test('buildPreimage returns 7-element array with pharmacy domain tag', () => {
    const preimage = PharmacyNode.buildPreimage(
      {
        serviceProviderIdQualifier: 1,
        serviceProviderId: 'NCPDP001',
      },
      'SuperSecretKey123456!@#$',
    );
    expect(preimage).toHaveLength(7);
    // First element is domain tag (2 for pharmacy)
    expect(preimage[0].toString()).toBe(Field(2).toString());
    // Pharmacy has 3 preimage fields + 3 zero padding
    expect(preimage[4].toString()).toBe(Field(0).toString());
    expect(preimage[5].toString()).toBe(Field(0).toString());
    expect(preimage[6].toString()).toBe(Field(0).toString());
  });
});

// ═══════════════════════════════════════════════════════════════
// InsurerNode
// ═══════════════════════════════════════════════════════════════

describe('InsurerNode', () => {
  test('construction succeeds without walletId', () => {
    const node = new InsurerNode({
      role: 'insurer',
      sequencerUrl: MOCK_SEQUENCER_URL,
      displayName: 'Test PBM',
    });
    expect(node.getRole()).toBe('insurer');
    expect(node.getWalletId()).toBeUndefined();
  });

  test('report generation methods exist and are callable', () => {
    const node = new InsurerNode({
      role: 'insurer',
      sequencerUrl: MOCK_SEQUENCER_URL,
    });

    // Verify all 12 report methods exist
    expect(typeof node.generateClaimsRegister).toBe('function');
    expect(typeof node.generatePharmacyReport).toBe('function');
    expect(typeof node.generatePrescriberReport).toBe('function');
    expect(typeof node.generateMemberReport).toBe('function');
    expect(typeof node.generateMedicationUtilization).toBe('function');
    expect(typeof node.generateFinancialSummary).toBe('function');
    expect(typeof node.generatePriorAuthReport).toBe('function');
    expect(typeof node.generateReversalReport).toBe('function');
    expect(typeof node.generateTierAnalysis).toBe('function');
    expect(typeof node.generateTherapeuticClassReport).toBe('function');
    expect(typeof node.generateTimeSeries).toBe('function');
    expect(typeof node.generateCrossTab).toBe('function');
  });

  test('report generation produces valid output with empty claims', () => {
    const node = new InsurerNode({
      role: 'insurer',
      sequencerUrl: MOCK_SEQUENCER_URL,
    });

    const report = node.generateClaimsRegister([]);
    expect(report.claims).toHaveLength(0);
    expect(report.totalClaimCount).toBe(0);
    expect(report.totalReversalCount).toBe(0);
  });

  test('financial summary report works with claims', () => {
    const node = new InsurerNode({
      role: 'insurer',
      sequencerUrl: MOCK_SEQUENCER_URL,
    });

    const claims = [
      {
        prescriptionHash: '0', entryCommitment: '0',
        patientPayCents: 1000, planPayCents: 4000,
        operationType: 'fulfillment' as const,
        pharmacyWalletId: 'P1', memberWalletId: 'M1', prescriberWalletId: 'D1',
        ndcHash: 'N1', ingredientCostCents: 4500, dispensingFeeCents: 500,
        quantityDispensed: '30000', dateOfService: 20260115,
      },
    ];

    const report = node.generateFinancialSummary(claims);
    expect(report.totalClaimCount).toBe(1);
    expect(report.costBreakdown.totalPatientPayCents).toBe(1000);
    expect(report.costBreakdown.totalPlanPayCents).toBe(4000);
  });

  test('tier analysis report works with tiered claims', () => {
    const node = new InsurerNode({
      role: 'insurer',
      sequencerUrl: MOCK_SEQUENCER_URL,
    });

    const claims = [
      {
        prescriptionHash: '0', entryCommitment: '0',
        patientPayCents: 1000, planPayCents: 4000,
        operationType: 'fulfillment' as const,
        pharmacyWalletId: 'P1', memberWalletId: 'M1', prescriberWalletId: 'D1',
        ndcHash: 'N1', ingredientCostCents: 4500, dispensingFeeCents: 500,
        quantityDispensed: '30000', dateOfService: 20260115,
        tierLevel: 1, brandName: 'Generic Drug',
      },
      {
        prescriptionHash: '0', entryCommitment: '0',
        patientPayCents: 3000, planPayCents: 9000,
        operationType: 'fulfillment' as const,
        pharmacyWalletId: 'P1', memberWalletId: 'M1', prescriberWalletId: 'D1',
        ndcHash: 'N2', ingredientCostCents: 11000, dispensingFeeCents: 1000,
        quantityDispensed: '30000', dateOfService: 20260116,
        tierLevel: 2, brandName: 'Brand Drug',
      },
    ];

    const report = node.generateTierAnalysis(claims);
    expect(report.tiers.length).toBeGreaterThanOrEqual(2);
    const tier1 = report.tiers.find(t => t.tierLevel === 1);
    expect(tier1).toBeDefined();
    expect(tier1!.claimCount).toBe(1);
  });

  test('audit methods exist and are callable', () => {
    const node = new InsurerNode({
      role: 'insurer',
      sequencerUrl: MOCK_SEQUENCER_URL,
    });

    expect(typeof node.verifyChainIntegrity).toBe('function');
    expect(typeof node.verifyFinancialBalance).toBe('function');
    expect(typeof node.detectDuplicateClaims).toBe('function');
    expect(typeof node.runFullAudit).toBe('function');
  });

  test('admin methods exist and are callable', () => {
    const node = new InsurerNode({
      role: 'insurer',
      sequencerUrl: MOCK_SEQUENCER_URL,
    });

    expect(typeof node.publishFormulary).toBe('function');
    expect(typeof node.forceBatch).toBe('function');
  });
});

// ═══════════════════════════════════════════════════════════════
// ProofDelegateClient
// ═══════════════════════════════════════════════════════════════

describe('ProofDelegateClient', () => {
  test('construction succeeds', () => {
    const client = new ProofDelegateClient('http://localhost:4040');
    expect(client).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════
// ProofDelegateServer
// ═══════════════════════════════════════════════════════════════

describe('ProofDelegateServer', () => {
  test('construction succeeds', () => {
    const server = new ProofDelegateServer(4041);
    expect(server).toBeDefined();
    expect(server.getPort()).toBe(4041);
    expect(server.isRunning()).toBe(false);
  });

  test('start throws before compilation', async () => {
    const server = new ProofDelegateServer(4042);
    await expect(server.start()).rejects.toThrow('Must call compile()');
  });
});

// ═══════════════════════════════════════════════════════════════
// Cross-Node Integration (Mock-Based)
// ═══════════════════════════════════════════════════════════════

describe('Cross-Node Integration', () => {
  test('all node types share the same L2Client configuration', () => {
    const config = {
      sequencerUrl: MOCK_SEQUENCER_URL,
      clientOptions: { timeoutMs: 60_000 },
    };

    const member = new MemberNode({ ...config, role: 'member', walletId: makeMemberWalletId() });
    const prescriber = new PrescriberNode({ ...config, role: 'prescriber', walletId: makePrescriberWalletId() });
    const pharmacy = new PharmacyNode({ ...config, role: 'pharmacy', walletId: makePharmacyWalletId() });
    const insurer = new InsurerNode({ ...config, role: 'insurer' });

    expect(member.getClient()).toBeDefined();
    expect(prescriber.getClient()).toBeDefined();
    expect(pharmacy.getClient()).toBeDefined();
    expect(insurer.getClient()).toBeDefined();
  });

  test('entity roles are correctly assigned', () => {
    expect(new MemberNode({
      role: 'member', sequencerUrl: MOCK_SEQUENCER_URL, walletId: '1',
    }).getRole()).toBe('member');

    expect(new PrescriberNode({
      role: 'prescriber', sequencerUrl: MOCK_SEQUENCER_URL, walletId: '1',
    }).getRole()).toBe('prescriber');

    expect(new PharmacyNode({
      role: 'pharmacy', sequencerUrl: MOCK_SEQUENCER_URL, walletId: '1',
    }).getRole()).toBe('pharmacy');

    expect(new InsurerNode({
      role: 'insurer', sequencerUrl: MOCK_SEQUENCER_URL,
    }).getRole()).toBe('insurer');
  });

  test('wallet IDs are correctly stored', () => {
    const mWallet = makeMemberWalletId();
    const pWallet = makePrescriberWalletId();
    const phWallet = makePharmacyWalletId();

    expect(new MemberNode({
      role: 'member', sequencerUrl: MOCK_SEQUENCER_URL, walletId: mWallet,
    }).getWalletId()).toBe(mWallet);

    expect(new PrescriberNode({
      role: 'prescriber', sequencerUrl: MOCK_SEQUENCER_URL, walletId: pWallet,
    }).getWalletId()).toBe(pWallet);

    expect(new PharmacyNode({
      role: 'pharmacy', sequencerUrl: MOCK_SEQUENCER_URL, walletId: phWallet,
    }).getWalletId()).toBe(phWallet);

    expect(new InsurerNode({
      role: 'insurer', sequencerUrl: MOCK_SEQUENCER_URL,
    }).getWalletId()).toBeUndefined();
  });
});
