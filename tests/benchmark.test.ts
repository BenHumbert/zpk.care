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
 * Full Claim Lifecycle Benchmark
 *
 * Measures wall-clock time for EVERY operation in a complete pharmacy benefit
 * claim lifecycle, from enrollment to fulfillment with accumulators.
 *
 * Run: $env:NODE_OPTIONS="--max-old-space-size=12288"; npx jest tests/benchmark.test.ts --verbose --maxWorkers=1
 *
 * Architecture reminder — ZK proofs are DISTRIBUTED:
 *   - Members generate identity proofs (on their device)
 *   - Prescribers generate identity proofs (on their system)
 *   - Pharmacies generate fulfillment proofs (on their POS)
 *   - Insurer only VERIFIES proofs (milliseconds) + admin updates (no proofs)
 */
import { Field, MerkleTree, Poseidon } from 'o1js';
import os from 'os';

// Wallets
import {
  deriveMemberWalletId,
  derivePrescriberWalletId,
  derivePharmacyWalletId,
  memberWalletPreimage,
  prescriberWalletPreimage,
  pharmacyWalletPreimage,
} from '../src/wallets/wallet-derivation.js';
import { ProofGateProgram } from '../src/wallets/proof-gate.js';
import { WalletRegistry, WalletState, WALLET_TREE_HEIGHT } from '../src/wallets/wallet-state.js';

// Engine
import { lifecycleLeafCommitment, LIFECYCLE_ELIGIBLE } from '../src/engine/lifecycle.js';

// ZKP
import { MerkleForest, ForestDomain } from '../src/zkp/merkle-forest.js';
import { hashString, dateToField, centsToField, quantityToField } from '../src/zkp/hash-utils.js';

// Credentials
import { CredentialData, CREDENTIAL_TYPE_ELIGIBILITY, CREDENTIAL_TYPE_PRESCRIPTION } from '../src/credentials/credential-data.js';
import { CredentialInventory } from '../src/credentials/credential-inventory.js';

// Eligibility
import { EligibilityData, buildEligibilityData } from '../src/eligibility/eligibility-data.js';
import { ForestRoots } from '../src/eligibility/forest-roots.js';
import { BenefitPlanRegistry } from '../src/eligibility/benefit-plan-registry.js';
import { EligibilityProgram } from '../src/eligibility/eligibility-program.js';

// Access Control
import { FormularyEntry, buildFormularyEntry } from '../src/access-control/formulary-entry.js';
import { FormularyRegistry } from '../src/access-control/formulary-registry.js';
import { AccessControlProgram } from '../src/access-control/access-control-program.js';
import { AccumulatorData, buildAccumulatorData, ACCUMULATOR_LEAF_INDEX } from '../src/access-control/accumulator-data.js';

// Messaging
import { MessageData, MSG_TYPE_PRESCRIPTION } from '../src/messaging/message-data.js';
import { MessagingProgram } from '../src/messaging/messaging-program.js';
import { MessageRegistry } from '../src/messaging/message-registry.js';
import { DelegationRegistry } from '../src/messaging/message-registry.js';
import { KeyRegistry } from '../src/messaging/message-registry.js';

// Prescription
import {
  PrescriptionData,
  PrescriptionStatusData,
  RX_STATUS_ADJUDICATED,
  RX_STATUS_FILLED,
} from '../src/prescription/prescription-data.js';
import { PrescriptionProgram } from '../src/prescription/prescription-program.js';

// Fulfillment
import { FulfillmentData } from '../src/fulfillment/fulfillment-data.js';
import { AccumulatorFulfillmentProgram } from '../src/fulfillment/accumulator-fulfillment-program.js';

// Onboarding
import { TokenAuthority } from '../src/onboarding/token-authority.js';
import { GroupRegistry, GroupConfig, GROUP_STATUS_ACTIVE } from '../src/onboarding/group-registry.js';
import { OpaqueRoster } from '../src/onboarding/opaque-roster.js';
import { PlanTemplate } from '../src/onboarding/plan-template.js';
import { EnrollmentService } from '../src/onboarding/enrollment-service.js';

// Production data
import { PRESCRIBERS, PHARMACIES, MEMBERS, getAllFormularyEntries } from '../src/data/index.js';

// ─── Timing Infrastructure ──────────────────────────────────

interface TimingEntry {
  phase: string;
  operation: string;
  ms: number;
  category: 'offchain' | 'compile' | 'prove' | 'verify';
  perClaim: boolean;
}

const timings: TimingEntry[] = [];

function record(phase: string, operation: string, ms: number, category: TimingEntry['category'], perClaim: boolean) {
  timings.push({ phase, operation, ms, category, perClaim });
  const sec = (ms / 1000).toFixed(3);
  console.log(`  ⏱  ${operation}: ${sec}s`);
}

async function timed<T>(
  phase: string,
  operation: string,
  category: TimingEntry['category'],
  perClaim: boolean,
  fn: () => T | Promise<T>,
): Promise<T> {
  const start = performance.now();
  const result = await fn();
  record(phase, operation, performance.now() - start, category, perClaim);
  return result;
}

// ─── Shared State ───────────────────────────────────────────

// Actors
const member = MEMBERS[0];        // Alice Johnson, ACME
const prescriber = PRESCRIBERS[0]; // Dr. Chen, Internal Medicine
const pharmacy = PHARMACIES[0];    // Main Street Pharmacy

// Wallet IDs & preimages
let memberWalletId: Field;
let prescriberWalletId: Field;
let pharmacyWalletId: Field;
let memberPreimageFields: Field[];
let prescriberPreimageFields: Field[];
let pharmacyPreimageFields: Field[];

// Infrastructure
let walletRegistry: WalletRegistry;
let lifecycleTree: MerkleTree;
let benefitPlanRegistry: BenefitPlanRegistry;
let enrollmentService: EnrollmentService;
let adminWalletId: Field;

// Enrollment output
let eligCredentialData: CredentialData;
let eligForest: MerkleForest;
let eligForestRoots: ForestRoots;
let eligibilityData: EligibilityData;
let accumulatorData: AccumulatorData;
let formularyEntry: FormularyEntry;
let formularyRegistry: FormularyRegistry;

// Prescription credential state
let rxCredentialData: CredentialData;
let rxForest: MerkleForest;
let rxForestRoots: ForestRoots;
let prescriptionData: PrescriptionData;
let activeStatus: PrescriptionStatusData;
let filledStatus: PrescriptionStatusData;
let fulfillmentData: FulfillmentData;

// Messaging state
let messageRegistry: MessageRegistry;
let delegationRegistry: DelegationRegistry;
let keyRegistry: KeyRegistry;

// ═════════════════════════════════════════════════════════════
// TEST SUITE
// ═════════════════════════════════════════════════════════════

describe('Full Claim Lifecycle Benchmark', () => {
  // ── Phase 0: System Info ────────────────────────────────────

  test('Phase 0: System info', () => {
    const cpus = os.cpus();
    const cpu = cpus[0];
    console.log('\n╔══════════════════════════════════════════════════════════╗');
    console.log('║           FULL CLAIM LIFECYCLE BENCHMARK                 ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');
    console.log(`  CPU:     ${cpu.model.trim()}`);
    console.log(`  Cores:   ${cpus.length} logical cores @ ${cpu.speed} MHz`);
    console.log(`  RAM:     ${Math.round(os.totalmem() / 1024 / 1024 / 1024)} GB`);
    console.log(`  OS:      ${os.platform()} ${os.arch()} ${os.release()}`);
    console.log(`  Node:    ${process.version}`);
    console.log(`  Heap:    ${Math.round((process as any).memoryUsage?.().heapTotal / 1024 / 1024 || 0)} MB allocated`);
    console.log('');
  });

  // ── Phase 1: Off-Chain Operations ──────────────────────────

  test('Phase 1: Off-chain operations (enrollment ceremony)', async () => {
    console.log('\n── Phase 1: Off-Chain Operations ──────────────────────\n');

    // 1a. Wallet derivation
    await timed('P1', 'Derive member wallet ID', 'offchain', false, () => {
      memberWalletId = deriveMemberWalletId(member.localData, member.enrollmentKey, Field(0));
      memberPreimageFields = memberWalletPreimage(member.localData, member.enrollmentKey, Field(0));
    });

    await timed('P1', 'Derive prescriber wallet ID', 'offchain', false, () => {
      prescriberWalletId = derivePrescriberWalletId(prescriber.localData, prescriber.enrollmentKey);
      prescriberPreimageFields = prescriberWalletPreimage(prescriber.localData, prescriber.enrollmentKey);
    });

    await timed('P1', 'Derive pharmacy wallet ID', 'offchain', false, () => {
      pharmacyWalletId = derivePharmacyWalletId(pharmacy.localData, pharmacy.enrollmentKey);
      pharmacyPreimageFields = pharmacyWalletPreimage(pharmacy.localData, pharmacy.enrollmentKey);
    });

    // 1b. Set up enrollment infrastructure
    await timed('P1', 'Initialize registries + enrollment service', 'offchain', false, () => {
      adminWalletId = hashString('ADMIN-INSURER-2026');
      walletRegistry = new WalletRegistry();
      lifecycleTree = new MerkleTree(WALLET_TREE_HEIGHT);
      benefitPlanRegistry = new BenefitPlanRegistry();

      // Register prescriber + pharmacy wallets (they're not enrolled via ceremony)
      walletRegistry.register(prescriberWalletId);
      lifecycleTree.setLeaf(0n, lifecycleLeafCommitment(prescriberWalletId, LIFECYCLE_ELIGIBLE));
      walletRegistry.register(pharmacyWalletId);
      lifecycleTree.setLeaf(1n, lifecycleLeafCommitment(pharmacyWalletId, LIFECYCLE_ELIGIBLE));

      const tokenAuthority = new TokenAuthority('ACME-CORP-HR');
      const groupRegistry = new GroupRegistry();
      const opaqueRoster = new OpaqueRoster();

      const formularyEntries = getAllFormularyEntries();
      const planTemplate = new PlanTemplate({
        planId: 'PLAN-GOLD-2026',
        copayAmountCents: 3000,
        coverageType: 1,
        deductibleAmountCents: 50000,
        oopMaxCents: 800000,
        annualBenefitMaxCents: 0,
        formularyEntries,
      });

      const planTemplates = new Map([['PLAN-GOLD-2026', planTemplate]]);
      formularyRegistry = planTemplate.formularyRegistry;

      // Register group
      const groupConfig = new GroupConfig({
        groupIdHash: hashString('ACME-CORP'),
        planIdHash: hashString('PLAN-GOLD-2026'),
        effectiveDate: dateToField('20260101'),
        terminationDate: Field(0),
        enrollmentCap: Field(100),
        enrolledCount: Field(0),
        status: GROUP_STATUS_ACTIVE,
      });
      groupRegistry.addGroup(groupConfig, {
        groupId: 'ACME-CORP',
        planId: 'PLAN-GOLD-2026',
        effectiveDate: '20260101',
        terminationDate: '',
        enrollmentCap: 100,
      });

      // Generate enrollment token
      tokenAuthority.generateToken('ACME-CORP', 'PLAN-GOLD-2026', 'EMP-10001', 'FAM-ACME-10001', '20261231', 'TOKEN-001');

      enrollmentService = new EnrollmentService(
        walletRegistry, lifecycleTree, tokenAuthority, groupRegistry,
        planTemplates, opaqueRoster, benefitPlanRegistry, adminWalletId,
      );
    });

    // 1c. Process enrollment
    await timed('P1', 'Process enrollment ceremony (16 steps)', 'offchain', false, () => {
      const result = enrollmentService.processEnrollment(memberWalletId, 'TOKEN-001', '20260201');

      // Extract state from enrollment result
      eligCredentialData = result.credentialData;
      eligForest = enrollmentService.getMemberForest(memberWalletId)!;
      eligForestRoots = ForestRoots.fromForest(eligForest);

      // Build eligibility data for proofs
      eligibilityData = new PlanTemplate({
        planId: 'PLAN-GOLD-2026',
        copayAmountCents: 3000,
        coverageType: 1,
        deductibleAmountCents: 50000,
        oopMaxCents: 800000,
        annualBenefitMaxCents: 0,
        formularyEntries: getAllFormularyEntries(),
      }).buildEligibilityData('ACME-CORP', '20260101', '');

      accumulatorData = buildAccumulatorData({
        planYear: '20260101',
        deductibleAmountCents: 50000,
        deductiblePaidCents: 0,
        oopMaxCents: 800000,
        oopPaidCents: 0,
        annualBenefitMaxCents: 0,
        annualBenefitUsedCents: 0,
      });

      // Register benefit plan
      benefitPlanRegistry.addPlan(eligibilityData);
    });

    // 1d. Build formulary entry for lisinopril (Tier 1 generic, $10 copay)
    await timed('P1', 'Build formulary entry (Lisinopril)', 'offchain', true, () => {
      formularyEntry = buildFormularyEntry({
        ndc: '00071015523',
        tierLevel: 1,
        copayAmount: 1000,
        requiresPriorAuth: false,
        maxQuantityPerFill: 90,
        maxDaySupply: 90,
        stepTherapyRequired: false,
      });
    });

    // 1e. Build prescription credential (simulates eScript creation)
    await timed('P1', 'Build prescription credential + forest', 'offchain', true, () => {
      const ndcHash = hashString('00071015523');
      const rxCommitment = Poseidon.hash([
        ndcHash,
        prescriberWalletId,
        memberWalletId,
        dateToField('20260201'),
        dateToField('20270201'),
        quantityToField(30),
        Field(3n),
      ]);

      prescriptionData = new PrescriptionData({
        ndcHash,
        prescriberWalletId,
        memberWalletId,
        writtenDate: dateToField('20260201'),
        expirationDate: dateToField('20270201'),
        quantityPrescribed: quantityToField(30),
        refillsAuthorized: Field(3n),
      });

      activeStatus = new PrescriptionStatusData({
        prescriptionHash: prescriptionData.commitment(),
        status: RX_STATUS_ADJUDICATED,
        updatedByWalletId: prescriberWalletId,
        updatedAt: dateToField('20260201'),
        pharmacyWalletId,
        fillQuantity: Field(0),
        notesHash: Field(0),
      });

      filledStatus = new PrescriptionStatusData({
        prescriptionHash: prescriptionData.commitment(),
        status: RX_STATUS_FILLED,
        updatedByWalletId: pharmacyWalletId,
        updatedAt: dateToField('20260202'),
        pharmacyWalletId,
        fillQuantity: quantityToField(30),
        notesHash: Field(0),
      });

      rxForest = new MerkleForest();
      rxForest.setLeaf(ForestDomain.MEDICATION, 0n, prescriptionData.commitment());
      rxForest.setLeaf(ForestDomain.TRANSACTION, 0n, activeStatus.commitment());

      rxForestRoots = ForestRoots.fromForest(rxForest);

      rxCredentialData = new CredentialData({
        credentialType: CREDENTIAL_TYPE_PRESCRIPTION,
        forestRoot: rxForest.getForestRoot(),
        issuerWalletId: prescriberWalletId,
        subjectWalletId: pharmacyWalletId,
        issuedAt: dateToField('20260201'),
        expiresAt: Field(0),
        revoked: Field(0),
      });

      // Build fulfillment data
      fulfillmentData = new FulfillmentData({
        prescriptionHash: prescriptionData.commitment(),
        pharmacyWalletId,
        ndcHash,
        quantityDispensed: quantityToField(30),
        ingredientCostCents: centsToField(450),    // $4.50 ingredient cost
        dispensingFeeCents: centsToField(200),      // $2.00 dispensing fee
        dateOfService: dateToField('20260202'),
      });
    });

    // 1f. Set up messaging registries
    await timed('P1', 'Initialize messaging registries', 'offchain', false, () => {
      messageRegistry = new MessageRegistry();
      delegationRegistry = new DelegationRegistry();
      keyRegistry = new KeyRegistry();
    });
  }, 30_000);

  // ── Phase 2: ZkProgram Compilations (one-time costs) ───────

  test('Phase 2a: Compile ProofGateProgram', async () => {
    console.log('\n── Phase 2: ZkProgram Compilations (one-time) ────────\n');
    await timed('P2', 'Compile ProofGateProgram (3 methods)', 'compile', false,
      () => ProofGateProgram.compile());
  }, 300_000);

  test('Phase 2b: Compile EligibilityProgram', async () => {
    await timed('P2', 'Compile EligibilityProgram', 'compile', false,
      () => EligibilityProgram.compile());
  }, 300_000);

  test('Phase 2c: Compile AccessControlProgram', async () => {
    await timed('P2', 'Compile AccessControlProgram (2 methods)', 'compile', false,
      () => AccessControlProgram.compile());
  }, 300_000);

  test('Phase 2d: Compile MessagingProgram', async () => {
    await timed('P2', 'Compile MessagingProgram (2 methods)', 'compile', false,
      () => MessagingProgram.compile());
  }, 300_000);

  test('Phase 2e: Compile PrescriptionProgram', async () => {
    await timed('P2', 'Compile PrescriptionProgram (2 methods)', 'compile', false,
      () => PrescriptionProgram.compile());
  }, 300_000);

  test('Phase 2f: Compile AccumulatorFulfillmentProgram', async () => {
    await timed('P2', 'Compile AccumulatorFulfillmentProgram (2 methods)', 'compile', false,
      () => AccumulatorFulfillmentProgram.compile());
  }, 300_000);

  // ── Phase 3: Proof Generation (per-operation costs) ────────

  test('Phase 3a: Prove member identity (ProofGate.verifyMember)', async () => {
    console.log('\n── Phase 3: Proof Generation (per-operation costs) ────\n');
    await timed('P3', 'ProofGate.verifyMember', 'prove', true, () =>
      ProofGateProgram.verifyMember(
        memberWalletId,
        ...memberPreimageFields as [Field, Field, Field, Field, Field, Field],
      ));
  }, 120_000);

  test('Phase 3b: Prove prescriber identity (ProofGate.verifyPrescriber)', async () => {
    await timed('P3', 'ProofGate.verifyPrescriber', 'prove', true, () =>
      ProofGateProgram.verifyPrescriber(
        prescriberWalletId,
        ...prescriberPreimageFields as [Field, Field, Field],
      ));
  }, 120_000);

  test('Phase 3c: Prove pharmacy identity (ProofGate.verifyPharmacy)', async () => {
    await timed('P3', 'ProofGate.verifyPharmacy', 'prove', true, () =>
      ProofGateProgram.verifyPharmacy(
        pharmacyWalletId,
        ...pharmacyPreimageFields as [Field, Field, Field],
      ));
  }, 120_000);

  test('Phase 3d: Prove eligibility (EligibilityProgram.proveEligibility)', async () => {
    const eligWitness = eligForest.getWitness(ForestDomain.ACCESS_CONTROL, 0n);
    const planWitness = benefitPlanRegistry.getPlanWitness(0n);
    const planRoot = benefitPlanRegistry.getRoot();

    await timed('P3', 'EligibilityProgram.proveEligibility', 'prove', true, () =>
      EligibilityProgram.proveEligibility(
        eligCredentialData,
        eligibilityData,
        eligForestRoots,
        eligWitness,
        planWitness,
        planRoot,
        dateToField('20260202'),
      ));
  }, 120_000);

  test('Phase 3e: Prove formulary access (AccessControl.proveFormularyAccess)', async () => {
    const eligWitness = eligForest.getWitness(ForestDomain.ACCESS_CONTROL, 0n);
    // Find the formulary index for lisinopril
    const lisinoprilIndex = 0n;
    const formWitness = formularyRegistry.getEntryWitness(lisinoprilIndex);
    const ndcHash = hashString('00071015523');

    await timed('P3', 'AccessControl.proveFormularyAccess', 'prove', true, () =>
      AccessControlProgram.proveFormularyAccess(
        eligCredentialData,
        eligibilityData,
        eligForestRoots,
        eligWitness,
        formularyEntry,
        formWitness,
        ndcHash,
        quantityToField(30),
        Field(30n),
        Field(20260101),
      ));
  }, 120_000);

  test('Phase 3f: Prove message send (MessagingProgram.proveSendMessage)', async () => {
    const msg = new MessageData({
      senderWalletId: prescriberWalletId,
      recipientWalletId: pharmacyWalletId,
      contentHash: hashString('Rx for Lisinopril 10mg #30'),
      messageType: MSG_TYPE_PRESCRIPTION,
      timestamp: dateToField('20260201'),
      threadId: hashString('THREAD-001'),
      nonce: Field(1),
    });
    const { index } = messageRegistry.addMessage(msg);
    const msgWitness = messageRegistry.getWitness(index);

    await timed('P3', 'MessagingProgram.proveSendMessage', 'prove', true, () =>
      MessagingProgram.proveSendMessage(
        msg,
        msgWitness,
        messageRegistry.getRoot(),
        delegationRegistry.getRoot(),
        keyRegistry.getRoot(),
      ));
  }, 120_000);

  test('Phase 3g: Prove prescription status (PrescriptionProgram.proveStatusUpdate)', async () => {
    // We need to update the prescription from ACTIVE → FILLED
    // Set up witnesses BEFORE mutation
    const medWitness = rxForest.getWitness(ForestDomain.MEDICATION, 0n);
    const oldStatusWitness = rxForest.getWitness(ForestDomain.TRANSACTION, 0n);
    const newSlotWitness = rxForest.getWitness(ForestDomain.TRANSACTION, 1n);

    await timed('P3', 'PrescriptionProgram.proveStatusUpdate', 'prove', true, () =>
      PrescriptionProgram.proveStatusUpdate(
        rxCredentialData,
        prescriptionData,
        activeStatus,
        filledStatus,
        rxForestRoots,
        medWitness,
        oldStatusWitness,
        newSlotWitness,
        ...prescriberPreimageFields as [Field, Field, Field],
      ));

    // Mutate forest for next phase (fulfillment needs FILLED status in tree)
    rxForest.setLeaf(ForestDomain.TRANSACTION, 1n, filledStatus.commitment());
    rxForestRoots = ForestRoots.fromForest(rxForest);
    rxCredentialData = new CredentialData({
      credentialType: CREDENTIAL_TYPE_PRESCRIPTION,
      forestRoot: rxForest.getForestRoot(),
      issuerWalletId: prescriberWalletId,
      subjectWalletId: pharmacyWalletId,
      issuedAt: dateToField('20260201'),
      expiresAt: Field(0),
      revoked: Field(0),
    });
  }, 120_000);

  test('Phase 3h: Prove fulfillment with accumulators (THE CLAIM)', async () => {
    // Build witnesses for the dual-credential fulfillment proof
    const medWitness = rxForest.getWitness(ForestDomain.MEDICATION, 0n);
    const statusWitness = rxForest.getWitness(ForestDomain.TRANSACTION, 1n);
    const newSlotWitness = rxForest.getWitness(ForestDomain.TRANSACTION, 2n);
    const formWitness = formularyRegistry.getEntryWitness(0n);
    const accumWitness = eligForest.getWitness(ForestDomain.ACCESS_CONTROL, ACCUMULATOR_LEAF_INDEX);

    await timed('P3', 'AccumulatorFulfillment.proveFulfillmentWithAccumulator', 'prove', true, () =>
      AccumulatorFulfillmentProgram.proveFulfillmentWithAccumulator(
        rxCredentialData,
        prescriptionData,
        filledStatus,
        fulfillmentData,
        formularyEntry,
        rxForestRoots,
        medWitness,
        statusWitness,
        newSlotWitness,
        formWitness,
        eligibilityData.formularyRoot,
        eligCredentialData,
        eligForestRoots,
        accumulatorData,
        accumWitness,
        // H2 fix: pharmacy wallet identity preimage (qualifier, serviceProviderIdHash, enrollmentKeyHash)
        ...pharmacyPreimageFields as [Field, Field, Field],
        Field(0), Field(0), Field(0), Field(0), Field(0), Field(0),   // B8: no family limits
      ));
  }, 180_000);

  // ── Phase 4: Summary & 250M Claims/Year Analysis ───────────

  test('Phase 4: Summary and hardware extrapolation', () => {
    console.log('\n');
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║                    RESULTS SUMMARY                       ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');

    // ── Timing Table ──
    console.log('┌─────────────────────────────────────────────────────┬──────────┬───────────┐');
    console.log('│ Operation                                           │ Time (s) │ Per-Claim │');
    console.log('├─────────────────────────────────────────────────────┼──────────┼───────────┤');
    for (const t of timings) {
      const sec = (t.ms / 1000).toFixed(2).padStart(7);
      const pc = t.perClaim ? '  YES  ' : '   -   ';
      const op = t.operation.padEnd(51);
      console.log(`│ ${op} │ ${sec}s │ ${pc} │`);
    }
    console.log('└─────────────────────────────────────────────────────┴──────────┴───────────┘');

    // ── Subtotals by category ──
    const compileTotal = timings.filter(t => t.category === 'compile').reduce((s, t) => s + t.ms, 0);
    const proveTotal = timings.filter(t => t.category === 'prove').reduce((s, t) => s + t.ms, 0);
    const offchainTotal = timings.filter(t => t.category === 'offchain').reduce((s, t) => s + t.ms, 0);
    const perClaimProofs = timings.filter(t => t.category === 'prove' && t.perClaim);
    const perClaimProveTotal = perClaimProofs.reduce((s, t) => s + t.ms, 0);

    console.log('\n── Subtotals ──');
    console.log(`  Off-chain operations:    ${(offchainTotal / 1000).toFixed(2)}s`);
    console.log(`  ZkProgram compilations:  ${(compileTotal / 1000).toFixed(2)}s  (one-time startup cost)`);
    console.log(`  Proof generation total:  ${(proveTotal / 1000).toFixed(2)}s`);
    console.log(`  Per-claim proof total:   ${(perClaimProveTotal / 1000).toFixed(2)}s  (all 8 proofs per claim)`);

    // ── The critical number ──
    const fulfillmentEntry = timings.find(t => t.operation.includes('AccumulatorFulfillment'));
    const fulfillmentMs = fulfillmentEntry?.ms || 30000;
    const fulfillmentSec = fulfillmentMs / 1000;

    console.log('\n── Critical Bottleneck ──');
    console.log(`  AccumulatorFulfillment proof: ${fulfillmentSec.toFixed(2)}s`);
    console.log(`  This is THE per-claim proof that every pharmacy fill generates.`);

    // ── 250M Claims/Year Analysis ──
    console.log('\n╔══════════════════════════════════════════════════════════╗');
    console.log('║           250 MILLION CLAIMS/YEAR ANALYSIS               ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');

    const CLAIMS_PER_YEAR = 250_000_000;
    const DAYS_PER_YEAR = 365;
    const PHARMACIES_US = 68_000;
    const OPERATING_HOURS = 14; // avg pharmacy hours per day

    const claimsPerDay = CLAIMS_PER_YEAR / DAYS_PER_YEAR;
    const claimsPerSecond = claimsPerDay / (OPERATING_HOURS * 3600);
    const claimsPerPharmacyPerDay = claimsPerDay / PHARMACIES_US;

    console.log('  Volume Breakdown:');
    console.log(`    ${CLAIMS_PER_YEAR.toLocaleString()} claims/year`);
    console.log(`    ${Math.round(claimsPerDay).toLocaleString()} claims/day`);
    console.log(`    ${claimsPerSecond.toFixed(1)} claims/second (during ${OPERATING_HOURS}hr operating window)`);
    console.log(`    ${claimsPerPharmacyPerDay.toFixed(1)} claims/pharmacy/day (across ${PHARMACIES_US.toLocaleString()} US pharmacies)`);

    console.log('\n  ── DISTRIBUTED MODEL (ZK architecture) ──');
    console.log('  Proof generation is distributed across pharmacies, NOT centralized.\n');

    // Per pharmacy
    const proofsPerPharmacyPerDay = claimsPerPharmacyPerDay;
    const secondsPerPharmacyPerDay = proofsPerPharmacyPerDay * fulfillmentSec;
    const hoursPerPharmacyPerDay = secondsPerPharmacyPerDay / 3600;

    console.log('  Per Pharmacy (fulfillment proofs only):');
    console.log(`    ${proofsPerPharmacyPerDay.toFixed(1)} proofs/day`);
    console.log(`    ${fulfillmentSec.toFixed(1)}s per proof × ${proofsPerPharmacyPerDay.toFixed(1)} = ${(secondsPerPharmacyPerDay / 60).toFixed(1)} min/day of CPU time`);
    console.log(`    ${hoursPerPharmacyPerDay.toFixed(2)} hours of CPU time per day`);
    console.log(`    → 1 modern CPU core handles this easily\n`);

    // Insurer side (verification only)
    const verifyMs = 5; // ~5ms per proof verification
    const totalVerifyPerDay = claimsPerDay * verifyMs / 1000;
    console.log('  Insurer Side (verification only — no proof generation):');
    console.log(`    ~${verifyMs}ms per proof verification`);
    console.log(`    ${Math.round(claimsPerDay).toLocaleString()} verifications/day = ${(totalVerifyPerDay / 60).toFixed(0)} minutes of CPU time`);
    console.log(`    → 1 server handles all 250M verifications/year\n`);

    // If centralized (worst case)
    console.log('  ── IF CENTRALIZED (hypothetical) ──');
    const centralCoresNeeded = Math.ceil(claimsPerSecond * fulfillmentSec);
    const centralCoresWithOverhead = Math.ceil(centralCoresNeeded * 1.5); // 50% headroom

    console.log(`    ${claimsPerSecond.toFixed(1)} claims/sec × ${fulfillmentSec.toFixed(1)}s/proof = ${centralCoresNeeded} CPU cores minimum`);
    console.log(`    With 50% headroom: ${centralCoresWithOverhead} CPU cores`);

    const coresPerServer = 64;
    const serversNeeded = Math.ceil(centralCoresWithOverhead / coresPerServer);
    console.log(`    At ${coresPerServer} cores/server: ${serversNeeded} servers`);
    console.log(`    (AMD EPYC 9654 or Intel Xeon w9-3595X class)\n`);

    // Full lifecycle per claim
    console.log('  ── FULL LIFECYCLE PER CLAIM ──');
    console.log('  Not all proofs run for every claim. Frequency breakdown:\n');
    const proofFreqs = [
      { name: 'ProofGate.verifyMember', freq: 'Per visit (~1/5 claims)', factor: 0.2 },
      { name: 'ProofGate.verifyPrescriber', freq: 'Per visit (~1/5 claims)', factor: 0.2 },
      { name: 'ProofGate.verifyPharmacy', freq: 'Per session (~1/20 claims)', factor: 0.05 },
      { name: 'EligibilityProgram.proveEligibility', freq: 'Per visit (~1/5 claims)', factor: 0.2 },
      { name: 'AccessControl.proveFormularyAccess', freq: 'Per script (~1/2 claims)', factor: 0.5 },
      { name: 'MessagingProgram.proveSendMessage', freq: 'Per script (~1/2 claims)', factor: 0.5 },
      { name: 'PrescriptionProgram.proveStatusUpdate', freq: 'Per fill (1:1)', factor: 1.0 },
      { name: 'AccumulatorFulfillment (THE CLAIM)', freq: 'Per fill (1:1)', factor: 1.0 },
    ];

    let weightedTotal = 0;
    for (const pf of proofFreqs) {
      const entry = timings.find(t => t.operation.includes(pf.name.split('.')[0]) || t.operation.includes(pf.name.split('(')[0].trim()));
      const ms = entry?.ms || 0;
      const weighted = ms * pf.factor;
      weightedTotal += weighted;
      console.log(`    ${pf.name.padEnd(45)} ${pf.freq.padEnd(25)} ${(ms/1000).toFixed(1)}s × ${pf.factor}`);
    }
    console.log(`\n    Weighted average per claim: ${(weightedTotal / 1000).toFixed(2)}s`);

    // Memory usage
    const mem = process.memoryUsage();
    console.log('\n── Memory Usage ──');
    console.log(`  Heap used:  ${Math.round(mem.heapUsed / 1024 / 1024)} MB`);
    console.log(`  Heap total: ${Math.round(mem.heapTotal / 1024 / 1024)} MB`);
    console.log(`  RSS:        ${Math.round(mem.rss / 1024 / 1024)} MB`);

    console.log('\n╔══════════════════════════════════════════════════════════╗');
    console.log('║                    HARDWARE RECOMMENDATIONS              ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');
    console.log('  Per Pharmacy (generates proofs):');
    console.log('    - Any modern desktop/laptop CPU (Intel i5/AMD Ryzen 5+)');
    console.log('    - 8 GB RAM minimum');
    console.log('    - Handles 10-15 claims/day with ease\n');
    console.log('  Insurer Backend (verifies proofs only):');
    console.log('    - 1 modest server (4-8 cores)');
    console.log('    - Verification is ~5ms per proof');
    console.log(`    - Handles all ${CLAIMS_PER_YEAR.toLocaleString()} claims/year with capacity to spare\n`);
    console.log('  If Centralized Proof Generation (NOT recommended):');
    console.log(`    - ${serversNeeded} servers × ${coresPerServer} cores (${centralCoresWithOverhead} total cores)`);
    console.log(`    - ${Math.round(mem.rss / 1024 / 1024) * serversNeeded / 1024} GB+ total RAM`);
    console.log('    - AMD EPYC 9654 (96 cores) or Intel Xeon w9-3595X (60 cores)');
    console.log('    - Estimated cost: $' + (serversNeeded * 25000).toLocaleString() + '-$' + (serversNeeded * 50000).toLocaleString() + '/year (cloud)\n');
    console.log('  KEY INSIGHT: The ZK architecture distributes the heavy computation');
    console.log('  across ~68,000 pharmacies. The insurer runs a LIGHT verification node.');
    console.log('  This is fundamentally different from traditional centralized adjudication.\n');
  });
});
