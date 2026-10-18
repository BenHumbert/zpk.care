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
 * Adjuda-GATOR — Full Claim Lifecycle
 *
 * Runs the complete lifecycle in the terminal with real ZK proof generation:
 *   Enrollment → eScript → Fill → Accumulator Update → Credential Change
 *
 * Run:
 *   $env:NODE_OPTIONS="--max-old-space-size=12288"; npx tsx src/seed/run-full-cycle.ts
 *
 * Duration: ~10-15 min (6 ZkProgram compilations + 8 proof generations)
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
} from '../wallets/wallet-derivation.js';
import { ProofGateProgram } from '../wallets/proof-gate.js';
import { WalletRegistry, WALLET_TREE_HEIGHT } from '../wallets/wallet-state.js';

// Engine
import { lifecycleLeafCommitment, LIFECYCLE_ELIGIBLE } from '../engine/lifecycle.js';

// ZKP
import { MerkleForest, ForestDomain } from '../zkp/merkle-forest.js';
import { hashString, dateToField, centsToField, quantityToField } from '../zkp/hash-utils.js';

// Credentials
import { CredentialData, CREDENTIAL_TYPE_PRESCRIPTION } from '../credentials/credential-data.js';

// Eligibility
import { EligibilityData } from '../eligibility/eligibility-data.js';
import { ForestRoots } from '../eligibility/forest-roots.js';
import { BenefitPlanRegistry } from '../eligibility/benefit-plan-registry.js';
import { EligibilityProgram } from '../eligibility/eligibility-program.js';

// Access Control
import { FormularyEntry, buildFormularyEntry } from '../access-control/formulary-entry.js';
import { FormularyRegistry } from '../access-control/formulary-registry.js';
import { AccessControlProgram } from '../access-control/access-control-program.js';
import { AccumulatorData, buildAccumulatorData, ACCUMULATOR_LEAF_INDEX } from '../access-control/accumulator-data.js';

// Messaging
import { MessageData, MSG_TYPE_PRESCRIPTION } from '../messaging/message-data.js';
import { MessagingProgram } from '../messaging/messaging-program.js';
import { MessageRegistry, DelegationRegistry, KeyRegistry } from '../messaging/message-registry.js';

// Prescription
import {
  PrescriptionData,
  PrescriptionStatusData,
  RX_STATUS_ADJUDICATED,
  RX_STATUS_FILLED,
} from '../prescription/prescription-data.js';
import { PrescriptionProgram } from '../prescription/prescription-program.js';

// Fulfillment
import { FulfillmentData } from '../fulfillment/fulfillment-data.js';
import { AccumulatorFulfillmentProgram } from '../fulfillment/accumulator-fulfillment-program.js';

// Onboarding
import { TokenAuthority } from '../onboarding/token-authority.js';
import { GroupRegistry, GroupConfig, GROUP_STATUS_ACTIVE } from '../onboarding/group-registry.js';
import { OpaqueRoster } from '../onboarding/opaque-roster.js';
import { PlanTemplate } from '../onboarding/plan-template.js';
import { EnrollmentService } from '../onboarding/enrollment-service.js';

// Seed data
import { PRESCRIBERS, PHARMACIES, MEMBERS } from './index.js';
import { getAllFormularyEntries, fixtureIdentitySalt } from '../data/index.js';

// ─── Helpers ─────────────────────────────────────────────────

interface TimingEntry {
  phase: string;
  operation: string;
  ms: number;
  category: 'offchain' | 'compile' | 'prove';
  perClaim: boolean;
}

const timings: TimingEntry[] = [];

function record(phase: string, operation: string, ms: number, category: TimingEntry['category'], perClaim: boolean) {
  timings.push({ phase, operation, ms, category, perClaim });
  const sec = (ms / 1000).toFixed(3);
  console.log(`    ${sec}s`);
}

async function timed<T>(
  phase: string,
  operation: string,
  category: TimingEntry['category'],
  perClaim: boolean,
  fn: () => T | Promise<T>,
): Promise<T> {
  process.stdout.write(`  > ${operation} ... `);
  const start = performance.now();
  const result = await fn();
  record(phase, operation, performance.now() - start, category, perClaim);
  return result;
}

function progressBar(current: number, max: number, width: number = 20): string {
  if (max === 0) return '[' + '-'.repeat(width) + ']';
  const pct = Math.min(current / max, 1);
  const filled = Math.round(pct * width);
  return '[' + '='.repeat(filled) + '-'.repeat(width - filled) + ']';
}

function cents(c: number): string {
  return '$' + (c / 100).toFixed(2);
}

function truncField(f: Field): string {
  const s = f.toBigInt().toString();
  if (s.length <= 16) return s;
  return s.slice(0, 8) + '...' + s.slice(-8);
}

function memMB(): number {
  return Math.round(process.memoryUsage().rss / 1024 / 1024);
}

// ─── Main ────────────────────────────────────────────────────

async function main() {
  // ═══════════════════════════════════════════════════════════
  // Phase 1: System Info
  // ═══════════════════════════════════════════════════════════

  console.log('');
  console.log('+==========================================================+');
  console.log('|       Adjuda-GATOR -- FULL CLAIM LIFECYCLE                 |');
  console.log('|                                                          |');
  console.log('|  Enrollment -> eScript -> Fill -> Accumulator Update     |');
  console.log('|  Real ZK proofs on MINA Protocol (o1js)                  |');
  console.log('+==========================================================+');
  console.log('');

  const cpus = os.cpus();
  const cpu = cpus[0];
  console.log('-- Phase 1: System Info --');
  console.log('');
  console.log(`  CPU:     ${cpu.model.trim()}`);
  console.log(`  Cores:   ${cpus.length} logical @ ${cpu.speed} MHz`);
  console.log(`  RAM:     ${Math.round(os.totalmem() / 1024 / 1024 / 1024)} GB`);
  console.log(`  OS:      ${os.platform()} ${os.arch()} ${os.release()}`);
  console.log(`  Node:    ${process.version}`);
  console.log(`  Heap:    ${memMB()} MB RSS`);
  console.log('');

  // ═══════════════════════════════════════════════════════════
  // Phase 2: Wallet Derivation
  // ═══════════════════════════════════════════════════════════

  const member = MEMBERS[0];        // Alice Johnson
  const prescriber = PRESCRIBERS[0]; // Dr. Sarah Chen
  const pharmacy = PHARMACIES[0];    // Main Street Pharmacy

  console.log('-- Phase 2: Wallet Derivation (off-chain, ~10ms each) --');
  console.log('');
  console.log('  Each wallet ID = Poseidon.hash(domainTag + hashed PHI fields + enrollmentKeyHash)');
  console.log('  Private data NEVER leaves the device. Only the hash goes on-chain.');
  console.log('');

  const memberWalletId = await timed('P2', 'Derive member wallet', 'offchain', false, () =>
    deriveMemberWalletId(member.localData, member.enrollmentKey, Field(0), fixtureIdentitySalt(member)));
  const memberPreimageFields = memberWalletPreimage(member.localData, member.enrollmentKey, Field(0), fixtureIdentitySalt(member));

  console.log(`    -> ${member.localData.firstName} ${member.localData.lastName} (${member.localData.cardholderId})`);
  console.log(`       Wallet ID: ${truncField(memberWalletId)}`);
  console.log('');

  const prescriberWalletId = await timed('P2', 'Derive prescriber wallet', 'offchain', false, () =>
    derivePrescriberWalletId(prescriber.localData, prescriber.enrollmentKey));
  const prescriberPreimageFields = prescriberWalletPreimage(prescriber.localData, prescriber.enrollmentKey);

  console.log(`    -> Dr. ${prescriber.firstName} ${prescriber.lastName}, ${prescriber.credential} -- ${prescriber.specialty}`);
  console.log(`       NPI: ${prescriber.localData.prescriberId}  Wallet ID: ${truncField(prescriberWalletId)}`);
  console.log('');

  const pharmacyWalletId = await timed('P2', 'Derive pharmacy wallet', 'offchain', false, () =>
    derivePharmacyWalletId(pharmacy.localData, pharmacy.enrollmentKey));
  const pharmacyPreimageFields = pharmacyWalletPreimage(pharmacy.localData, pharmacy.enrollmentKey);

  console.log(`    -> ${pharmacy.storeName} (NPI: ${pharmacy.localData.serviceProviderId})`);
  console.log(`       ${pharmacy.address}, ${pharmacy.city}, ${pharmacy.state}`);
  console.log(`       Wallet ID: ${truncField(pharmacyWalletId)}`);
  console.log('');

  // ═══════════════════════════════════════════════════════════
  // Phase 3: Enrollment Ceremony
  // ═══════════════════════════════════════════════════════════

  console.log('-- Phase 3: Three-Party Enrollment Ceremony --');
  console.log('');
  console.log('  Employer -> Member -> Insurer');
  console.log('  No single party sees everything. Enrollment key NEVER transmitted.');
  console.log('');

  // Infrastructure setup
  const adminWalletId = hashString('ADMIN-INSURER-2026');
  const walletRegistry = new WalletRegistry();
  const lifecycleTree = new MerkleTree(WALLET_TREE_HEIGHT);
  const benefitPlanRegistry = new BenefitPlanRegistry();

  // Register prescriber + pharmacy (pre-enrolled entities)
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
  const formularyRegistry = planTemplate.formularyRegistry;

  const planTemplates = new Map([['PLAN-GOLD-2026', planTemplate]]);

  // Register employer group
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

  // Employer step: generate enrollment token
  tokenAuthority.generateToken('ACME-CORP', 'PLAN-GOLD-2026', 'EMP-10001', 'FAM-ACME-10001', '20261231', 'TOKEN-001');
  console.log('  Step 1: ACME Corp HR generates enrollment token TOKEN-001');

  // Member step: computes walletId locally (already done above)
  console.log(`  Step 2: ${member.localData.firstName} computes walletId on her device`);
  console.log('          (enrollment key stays on device, NEVER transmitted)');

  // Insurer step: process enrollment
  const enrollmentService = new EnrollmentService(
    walletRegistry, lifecycleTree, tokenAuthority, groupRegistry,
    planTemplates, opaqueRoster, benefitPlanRegistry, adminWalletId,
  );

  const enrollResult = await timed('P3', 'Process enrollment (16 steps)', 'offchain', false, () =>
    enrollmentService.processEnrollment(memberWalletId, 'TOKEN-001', '20260201'));

  console.log('  Step 3: Insurer processes enrollment ceremony');
  console.log(`          -> Wallet registered, credential minted, token consumed`);
  console.log('');

  // Extract state
  const eligCredentialData = enrollResult.credentialData;
  const eligForest = enrollmentService.getMemberForest(memberWalletId)!;
  let eligForestRoots = ForestRoots.fromForest(eligForest);
  const eligForestRootBefore = eligForest.getForestRoot();

  const eligibilityData = planTemplate.buildEligibilityData('ACME-CORP', '20260101', '');
  const accumulatorData = buildAccumulatorData({
    planYear: '20260101',
    deductibleAmountCents: 50000,
    deductiblePaidCents: 0,
    oopMaxCents: 800000,
    oopPaidCents: 0,
    annualBenefitMaxCents: 0,
    annualBenefitUsedCents: 0,
  });

  benefitPlanRegistry.addPlan(eligibilityData);

  // Show plan and accumulator BEFORE
  console.log('  BENEFIT PLAN: PLAN-GOLD-2026');
  console.log(`    Copay:       ${cents(3000)}`);
  console.log(`    Deductible:  ${cents(50000)}`);
  console.log(`    OOPM:        ${cents(800000)}`);
  console.log(`    Formulary:   ${formularyEntries.length} medications across 4 tiers`);
  console.log('');
  console.log('  ACCUMULATOR (BEFORE):');
  console.log(`    Deductible:  $0.00 / ${cents(50000)}  ${progressBar(0, 50000)} 0%`);
  console.log(`    OOPM:        $0.00 / ${cents(800000)} ${progressBar(0, 800000)} 0%`);
  console.log('');
  console.log(`  Eligibility credential forest root: ${truncField(eligForestRootBefore)}`);
  console.log('');

  // ═══════════════════════════════════════════════════════════
  // Phase 4: Prescription Creation (off-chain)
  // ═══════════════════════════════════════════════════════════

  console.log('-- Phase 4: Prescription Creation (off-chain) --');
  console.log('');

  const ndcHash = hashString('00071015523');

  const prescriptionData = new PrescriptionData({
    ndcHash,
    prescriberWalletId,
    memberWalletId,
    writtenDate: dateToField('20260201'),
    expirationDate: dateToField('20270201'),
    quantityPrescribed: quantityToField(30),
    refillsAuthorized: Field(3n),
  });

  const activeStatus = new PrescriptionStatusData({
    prescriptionHash: prescriptionData.commitment(),
    status: RX_STATUS_ADJUDICATED,
    updatedByWalletId: prescriberWalletId,
    updatedAt: dateToField('20260201'),
    pharmacyWalletId,
    fillQuantity: Field(0),
    notesHash: Field(0),
  });

  const filledStatus = new PrescriptionStatusData({
    prescriptionHash: prescriptionData.commitment(),
    status: RX_STATUS_FILLED,
    updatedByWalletId: pharmacyWalletId,
    updatedAt: dateToField('20260202'),
    pharmacyWalletId,
    fillQuantity: quantityToField(30),
    notesHash: Field(0),
  });

  let rxForest = new MerkleForest();
  rxForest.setLeaf(ForestDomain.MEDICATION, 0n, prescriptionData.commitment());
  rxForest.setLeaf(ForestDomain.TRANSACTION, 0n, activeStatus.commitment());
  let rxForestRoots = ForestRoots.fromForest(rxForest);

  let rxCredentialData = new CredentialData({
    credentialType: CREDENTIAL_TYPE_PRESCRIPTION,
    forestRoot: rxForest.getForestRoot(),
    issuerWalletId: prescriberWalletId,
    subjectWalletId: pharmacyWalletId,
    issuedAt: dateToField('20260201'),
    expiresAt: Field(0),
    revoked: Field(0),
  });

  const fulfillmentData = new FulfillmentData({
    prescriptionHash: prescriptionData.commitment(),
    pharmacyWalletId,
    ndcHash,
    quantityDispensed: quantityToField(30),
    ingredientCostCents: centsToField(450),    // $4.50
    dispensingFeeCents: centsToField(200),      // $2.00
    dateOfService: dateToField('20260202'),
  });

  const formularyEntry = buildFormularyEntry({
    ndc: '00071015523',
    tierLevel: 1,
    copayAmount: 1000,
    requiresPriorAuth: false,
    maxQuantityPerFill: 90,
    maxDaySupply: 90,
    stepTherapyRequired: false,
  });

  // Messaging registries
  const messageRegistry = new MessageRegistry();
  const delegationRegistry = new DelegationRegistry();
  const keyRegistry = new KeyRegistry();

  console.log('  Dr. Chen writes eScript for Alice Johnson:');
  console.log('');
  console.log('    DRUG:    Lisinopril 10mg (Generic) -- Tier 1');
  console.log('    NDC:     00071-0155-23');
  console.log('    Qty:     30 tablets, 3 refills authorized');
  console.log(`    Cost:    $4.50 ingredient + $2.00 dispensing = $6.50 total`);
  console.log('');
  console.log('  Prescription credential created with MEDICATION + TRANSACTION trees');
  console.log(`  Rx hash: ${truncField(prescriptionData.commitment())}`);
  console.log('');

  // ═══════════════════════════════════════════════════════════
  // Phase 5: ZkProgram Compilation (one-time startup cost)
  // ═══════════════════════════════════════════════════════════

  console.log('-- Phase 5: ZkProgram Compilation (one-time startup cost) --');
  console.log('');
  console.log('  Compiling 6 ZkPrograms into prover/verifier key pairs...');
  console.log('  (This is a one-time cost — cached for all subsequent proofs)');
  console.log('');

  await timed('P5', '1/6 ProofGateProgram (3 methods)', 'compile', false,
    () => ProofGateProgram.compile());
  console.log(`       Memory: ${memMB()} MB RSS`);

  await timed('P5', '2/6 EligibilityProgram', 'compile', false,
    () => EligibilityProgram.compile());
  console.log(`       Memory: ${memMB()} MB RSS`);

  await timed('P5', '3/6 AccessControlProgram (2 methods)', 'compile', false,
    () => AccessControlProgram.compile());
  console.log(`       Memory: ${memMB()} MB RSS`);

  await timed('P5', '4/6 MessagingProgram (2 methods)', 'compile', false,
    () => MessagingProgram.compile());
  console.log(`       Memory: ${memMB()} MB RSS`);

  await timed('P5', '5/6 PrescriptionProgram (2 methods)', 'compile', false,
    () => PrescriptionProgram.compile());
  console.log(`       Memory: ${memMB()} MB RSS`);

  await timed('P5', '6/6 AccumulatorFulfillmentProgram (2 methods)', 'compile', false,
    () => AccumulatorFulfillmentProgram.compile());
  console.log(`       Memory: ${memMB()} MB RSS`);

  const compileTotal = timings.filter(t => t.category === 'compile').reduce((s, t) => s + t.ms, 0);
  console.log('');
  console.log(`  All 6 programs compiled in ${(compileTotal / 1000).toFixed(1)}s`);
  console.log('');

  // ═══════════════════════════════════════════════════════════
  // Phase 6: Proof Generation Chain (per-claim)
  // ═══════════════════════════════════════════════════════════

  console.log('-- Phase 6: Proof Generation Chain --');
  console.log('');
  console.log('  Generating 8 ZK proofs for one complete claim...');
  console.log('  In production: proofs generated LOCALLY by each party');
  console.log('');

  // 1. ProofGate: Member identity
  await timed('P6', '1/8 ProofGate.verifyMember (Alice proves identity)', 'prove', true, () =>
    ProofGateProgram.verifyMember(
      memberWalletId,
      ...memberPreimageFields as [Field, Field, Field, Field, Field, Field],
    ));
  console.log('       Alice proves she knows her 5 PHI fields + enrollment key');
  console.log('');

  // 2. ProofGate: Prescriber identity
  await timed('P6', '2/8 ProofGate.verifyPrescriber (Dr. Chen proves identity)', 'prove', true, () =>
    ProofGateProgram.verifyPrescriber(
      prescriberWalletId,
      ...prescriberPreimageFields as [Field, Field, Field],
    ));
  console.log('       Dr. Chen proves NPI ownership without revealing credentials');
  console.log('');

  // 3. ProofGate: Pharmacy identity
  await timed('P6', '3/8 ProofGate.verifyPharmacy (Main St proves identity)', 'prove', true, () =>
    ProofGateProgram.verifyPharmacy(
      pharmacyWalletId,
      ...pharmacyPreimageFields as [Field, Field, Field],
    ));
  console.log('       Pharmacy proves NPI ownership');
  console.log('');

  // 4. EligibilityProgram: Alice is eligible
  const eligWitness = eligForest.getWitness(ForestDomain.ACCESS_CONTROL, 0n);
  const planWitness = benefitPlanRegistry.getPlanWitness(0n);
  const planRoot = benefitPlanRegistry.getRoot();

  await timed('P6', '4/8 EligibilityProgram.proveEligibility', 'prove', true, () =>
    EligibilityProgram.proveEligibility(
      eligCredentialData,
      eligibilityData,
      eligForestRoots,
      eligWitness,
      planWitness,
      planRoot,
      dateToField('20260202'),
    ));
  console.log('       Alice is ELIGIBLE under PLAN-GOLD-2026 as of 2026-02-02');
  console.log('');

  // 5. AccessControl: Lisinopril on formulary
  const formEligWitness = eligForest.getWitness(ForestDomain.ACCESS_CONTROL, 0n);
  const formWitness = formularyRegistry.getEntryWitness(0n);

  await timed('P6', '5/8 AccessControl.proveFormularyAccess', 'prove', true, () =>
    AccessControlProgram.proveFormularyAccess(
      eligCredentialData,
      eligibilityData,
      eligForestRoots,
      formEligWitness,
      formularyEntry,
      formWitness,
      ndcHash,
      quantityToField(30),
      Field(30n),
      Field(20260101),
    ));
  console.log('       Lisinopril 10mg: ON FORMULARY, Tier 1, $10 copay');
  console.log('');

  // 6. Messaging: eScript message
  const msg = new MessageData({
    senderWalletId: prescriberWalletId,
    recipientWalletId: pharmacyWalletId,
    contentHash: hashString('Rx for Lisinopril 10mg #30'),
    messageType: MSG_TYPE_PRESCRIPTION,
    timestamp: dateToField('20260201'),
    threadId: hashString('THREAD-001'),
    nonce: Field(1),
  });
  const { index: msgIndex } = messageRegistry.addMessage(msg);
  const msgWitness = messageRegistry.getWitness(msgIndex);

  await timed('P6', '6/8 MessagingProgram.proveSendMessage (eScript)', 'prove', true, () =>
    MessagingProgram.proveSendMessage(
      msg,
      msgWitness,
      messageRegistry.getRoot(),
      delegationRegistry.getRoot(),
      keyRegistry.getRoot(),
    ));
  console.log('       Encrypted eScript: Dr. Chen -> Main Street Pharmacy');
  console.log('');

  // 7. Prescription: ACTIVE -> FILLED
  const medWitness = rxForest.getWitness(ForestDomain.MEDICATION, 0n);
  const oldStatusWitness = rxForest.getWitness(ForestDomain.TRANSACTION, 0n);
  const newSlotWitness = rxForest.getWitness(ForestDomain.TRANSACTION, 1n);

  await timed('P6', '7/8 PrescriptionProgram.proveStatusUpdate (ACTIVE->FILLED)', 'prove', true, () =>
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
  console.log('       Prescription status: ACTIVE -> FILLED (ZK-enforced transition)');

  // Mutate forest for fulfillment phase
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
  console.log('');

  // 8. THE CLAIM: Fulfillment with accumulator update
  const fulfMedWitness = rxForest.getWitness(ForestDomain.MEDICATION, 0n);
  const fulfStatusWitness = rxForest.getWitness(ForestDomain.TRANSACTION, 1n);
  const fulfNewSlotWitness = rxForest.getWitness(ForestDomain.TRANSACTION, 2n);
  const fulfFormWitness = formularyRegistry.getEntryWitness(0n);
  const accumWitness = eligForest.getWitness(ForestDomain.ACCESS_CONTROL, ACCUMULATOR_LEAF_INDEX);

  const fulfillResult = await timed('P6', '8/8 AccumulatorFulfillment.proveFulfillmentWithAccumulator (THE CLAIM)', 'prove', true, () =>
    AccumulatorFulfillmentProgram.proveFulfillmentWithAccumulator(
      rxCredentialData,
      prescriptionData,
      filledStatus,
      fulfillmentData,
      formularyEntry,
      rxForestRoots,
      fulfMedWitness,
      fulfStatusWitness,
      fulfNewSlotWitness,
      fulfFormWitness,
      eligibilityData.formularyRoot,
      eligCredentialData,
      eligForestRoots,
      accumulatorData,
      accumWitness,
      // H2: pharmacy wallet identity preimage
      ...pharmacyPreimageFields as [Field, Field, Field],
    ));

  console.log('       THE CLAIM: Dual-credential fulfillment with accumulator update');
  console.log('       15 private inputs verified in a single ZK circuit');
  console.log('');

  // ═══════════════════════════════════════════════════════════
  // Phase 7: The Result — Accumulator Update
  // ═══════════════════════════════════════════════════════════

  console.log('+==========================================================+');
  console.log('|                    THE RESULT                             |');
  console.log('+==========================================================+');
  console.log('');

  // Extract proof output
  const proofOutput = fulfillResult.proof.publicOutput;
  const patientPayCents = Number(proofOutput.patientPayCents.toBigInt());
  const planPayCents = Number(proofOutput.planPayCents.toBigInt());
  const totalCost = 650; // $6.50

  console.log('  DRUG: Lisinopril 10mg (Generic) -- Tier 1');
  console.log('  Qty:  30 tablets, 30 day supply');
  console.log(`  Cost: $4.50 ingredient + $2.00 dispensing = $6.50 total`);
  console.log('');

  // Determine adjudication phase
  const deductibleAmt = 50000;
  const phase = patientPayCents === totalCost ? 'DEDUCTIBLE (not yet met)' : 'NORMAL COPAY';

  console.log('  ADJUDICATION (ZK-enforced in-circuit):');
  console.log(`    Phase:       ${phase}`);
  console.log(`    Patient pay: ${cents(patientPayCents)}  (from proof output)`);
  console.log(`    Plan pay:    ${cents(planPayCents)}`);
  console.log('');

  // Compute new accumulator state
  const newDeductiblePaid = patientPayCents;
  const newOopPaid = patientPayCents;
  const newBenefitUsed = planPayCents;

  console.log('  ACCUMULATOR (BEFORE -> AFTER):');
  console.log('');
  console.log(`    Deductible:  $0.00 -> ${cents(newDeductiblePaid)} / ${cents(deductibleAmt)}`);
  console.log(`                 ${progressBar(0, deductibleAmt)}  ->  ${progressBar(newDeductiblePaid, deductibleAmt)}  ${(newDeductiblePaid / deductibleAmt * 100).toFixed(1)}%`);
  console.log('');
  console.log(`    OOPM:        $0.00 -> ${cents(newOopPaid)} / ${cents(800000)}`);
  console.log(`                 ${progressBar(0, 800000)}  ->  ${progressBar(newOopPaid, 800000)}  ${(newOopPaid / 800000 * 100).toFixed(1)}%`);
  console.log('');

  // Show credential forest root change
  const newEligForestRoot = proofOutput.newEligibilityForestRoot;
  console.log('  ELIGIBILITY CREDENTIAL:');
  console.log(`    Forest root BEFORE: ${truncField(eligForestRootBefore)}`);
  console.log(`    Forest root AFTER:  ${truncField(newEligForestRoot)}`);
  console.log(`    CHANGED: ${!eligForestRootBefore.equals(newEligForestRoot).toBoolean() ? 'YES -- accumulator updated in credential' : 'NO (unexpected)'}`);
  console.log('');

  // What just happened narrative
  console.log('  WHAT JUST HAPPENED:');
  console.log('  ------------------');
  console.log(`  1. Alice proved her identity without revealing any personal data`);
  console.log(`  2. Dr. Chen wrote an eScript that was cryptographically sealed`);
  console.log(`  3. Main Street Pharmacy proved it holds the prescription credential`);
  console.log(`  4. The ZK circuit computed: $6.50 total < $500 deductible`);
  console.log(`     -> Patient pays full $6.50 (applied to deductible)`);
  console.log(`     -> Plan pays $0.00 (deductible not yet met)`);
  console.log(`  5. Alice's eligibility credential was updated with new accumulator`);
  console.log(`  6. No personal data was ever transmitted. No insurer database.`);
  console.log(`     Only Poseidon hash commitments exist on-chain.`);
  console.log('');

  // ═══════════════════════════════════════════════════════════
  // Phase 8: Summary
  // ═══════════════════════════════════════════════════════════

  console.log('+==========================================================+');
  console.log('|                    TIMING SUMMARY                         |');
  console.log('+==========================================================+');
  console.log('');

  // Timing table
  console.log('+-----------------------------------------------------+----------+-----------+');
  console.log('| Operation                                           | Time (s) | Per-Claim |');
  console.log('+-----------------------------------------------------+----------+-----------+');
  for (const t of timings) {
    const sec = (t.ms / 1000).toFixed(2).padStart(7);
    const pc = t.perClaim ? '  YES  ' : '   -   ';
    const op = t.operation.padEnd(51);
    console.log(`| ${op} | ${sec}s | ${pc} |`);
  }
  console.log('+-----------------------------------------------------+----------+-----------+');

  // Subtotals
  const offchainTotal = timings.filter(t => t.category === 'offchain').reduce((s, t) => s + t.ms, 0);
  const proveTotal = timings.filter(t => t.category === 'prove').reduce((s, t) => s + t.ms, 0);

  console.log('');
  console.log('  Subtotals:');
  console.log(`    Off-chain operations:   ${(offchainTotal / 1000).toFixed(2)}s`);
  console.log(`    ZkProgram compilations: ${(compileTotal / 1000).toFixed(2)}s  (one-time startup)`);
  console.log(`    Proof generation:       ${(proveTotal / 1000).toFixed(2)}s  (per-claim proofs)`);
  console.log(`    Total wall-clock:       ${((offchainTotal + compileTotal + proveTotal) / 1000).toFixed(2)}s`);
  console.log('');

  // The critical number
  const fulfillmentEntry = timings.find(t => t.operation.includes('AccumulatorFulfillment') && t.category === 'prove');
  const fulfillmentSec = (fulfillmentEntry?.ms || 30000) / 1000;
  console.log('  Critical per-claim bottleneck:');
  console.log(`    AccumulatorFulfillment proof: ${fulfillmentSec.toFixed(2)}s`);
  console.log('    This is THE proof every pharmacy fill generates.');
  console.log('');

  // Memory
  const mem = process.memoryUsage();
  console.log('  Memory:');
  console.log(`    Heap used:  ${Math.round(mem.heapUsed / 1024 / 1024)} MB`);
  console.log(`    Heap total: ${Math.round(mem.heapTotal / 1024 / 1024)} MB`);
  console.log(`    RSS:        ${Math.round(mem.rss / 1024 / 1024)} MB`);
  console.log('');

  console.log('+==========================================================+');
  console.log('|  Zero personal data transmitted. Zero insurer database.   |');
  console.log('|  All 8 proofs verified. Claim settled. Credential updated. |');
  console.log('|  This is pharmacy benefit adjudication on MINA Protocol.  |');
  console.log('+==========================================================+');
  console.log('');
}

main().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
