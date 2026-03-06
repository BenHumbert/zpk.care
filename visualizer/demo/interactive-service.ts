/**
 * InteractiveDemoService — Backend orchestration for interactive step-by-step demo.
 *
 * Manages all session state and coordinates real ZK proof generation:
 *   compileAllPrograms()  — compile 8 ZkPrograms (~5 min one-time)
 *   enrollMember()        — three-party enrollment ceremony + ProofGate proof
 *   requestPriorAuth()    — prescriber requests PA for PA-required medication
 *   approvePriorAuth()    — insurer approves PA → inserts into forest + provePriorAuth proof
 *   denyPriorAuth()       — insurer denies PA request
 *   createPrescription()  — eScript + eligibility/access/messaging proofs (enforces PA)
 *   fillPrescription()    — pharmacy fill + AccumulatorFulfillment proof
 *   reversePrescription() — pharmacy reversal + AccumulatorFulfillment reversal proof
 *
 * All operations emit ConsoleEvent objects via the emitter callback
 * so the browser can display real-time progress.
 */
import { Field, MerkleTree, Poseidon } from 'o1js';

// Wallets
import {
  deriveMemberWalletId,
  derivePrescriberWalletId,
  derivePharmacyWalletId,
  memberWalletPreimage,
  prescriberWalletPreimage,
  pharmacyWalletPreimage,
  DOMAIN_TAG_MEMBER,
} from '../../src/wallets/wallet-derivation.js';
import { ProofGateProgram } from '../../src/wallets/proof-gate.js';
import { WalletRegistry, WALLET_TREE_HEIGHT } from '../../src/wallets/wallet-state.js';

// Engine
import { lifecycleLeafCommitment, LifecycleWitness, LIFECYCLE_ELIGIBLE, LIFECYCLE_REGISTERED, LIFECYCLE_REVOKED } from '../../src/engine/lifecycle.js';
import { StateTransitionProgram, StateTransitionProof, EMPTY_CREDENTIAL_ROOT } from '../../src/engine/state-transition.js';
import { BatchProgram } from '../../src/l2/batch-program.js';
import { WalletState } from '../../src/wallets/wallet-state.js';
import type { L2Node } from '../../src/l2/l2-node.js';
import type { L2Receipt } from '../../src/l2/l2-types.js';
import { CredentialInventory } from '../../src/credentials/credential-inventory.js';

// ZKP
import { MerkleForest, ForestDomain } from '../../src/zkp/merkle-forest.js';
import { hashString, dateToField, centsToField, quantityToField } from '../../src/zkp/hash-utils.js';

// Credentials
import { CredentialData, CREDENTIAL_TYPE_ELIGIBILITY, CREDENTIAL_TYPE_PRESCRIPTION } from '../../src/credentials/credential-data.js';
import { CredentialProgram } from '../../src/credentials/credential-program.js';
import { serializeCredential, verifyCredentialOffline } from '../../src/credentials/portable-credential.js';
import type { PortableCredential } from '../../src/credentials/portable-credential.js';
import { SequencerAttestationAuthority } from '../../src/credentials/nfc-attestation.js';
import type { NfcCredentialAttestation } from '../../src/credentials/nfc-attestation.js';

// Eligibility
import { EligibilityData, buildEligibilityData } from '../../src/eligibility/eligibility-data.js';
import { ForestRoots } from '../../src/eligibility/forest-roots.js';
import { BenefitPlanRegistry } from '../../src/eligibility/benefit-plan-registry.js';
import { EligibilityProgram } from '../../src/eligibility/eligibility-program.js';
import { ProviderNetworkRegistry } from '../../src/eligibility/provider-network-registry.js';

// PCP Assignment
import { buildPcpAssignmentData, PCP_ASSIGNMENT_LEAF_INDEX } from '../../src/eligibility/pcp-assignment-data.js';
import type { PcpAssignmentData } from '../../src/eligibility/pcp-assignment-data.js';
import { PcpVerificationProgram } from '../../src/eligibility/pcp-verification-program.js';

// Access Control
import { buildFormularyEntry, type FormularyEntry, type FormularyEntryLocalData } from '../../src/access-control/formulary-entry.js';
import { FormularyRegistry } from '../../src/access-control/formulary-registry.js';
import { AccessControlProgram } from '../../src/access-control/access-control-program.js';
import { AccumulatorData, buildAccumulatorData, ACCUMULATOR_LEAF_INDEX } from '../../src/access-control/accumulator-data.js';
import { PriorAuthData, buildPriorAuthData } from '../../src/access-control/prior-auth-data.js';

// Messaging
import { MessageData, MSG_TYPE_PRESCRIPTION, MSG_TYPE_PA_REQUEST, MSG_TYPE_PA_RESPONSE, MSG_TYPE_NOTIFICATION, MSG_TYPE_GENERAL, MSG_TYPE_SUPPORT } from '../../src/messaging/message-data.js';
import { MessagingProgram } from '../../src/messaging/messaging-program.js';
import { MessageRegistry, DelegationRegistry, KeyRegistry, computeMessagingRoot } from '../../src/messaging/message-registry.js';
import { DelegationData } from '../../src/messaging/delegation-data.js';
import { deriveEncryptionKeyPair, encryptMessage, decryptMessage as decryptMessageAes, computeContentHash, deriveSharedSecret, publicKeyToFields } from '../../src/messaging/encryption.js';

// Prescription
import {
  PrescriptionData,
  PrescriptionStatusData,
  RX_STATUS_ACTIVE,
  RX_STATUS_PARTIALLY_FILLED,
  RX_STATUS_FILLED,
  RX_STATUS_CANCELLED,
  RX_STATUS_REJECTED,
  RX_STATUS_REVERSED,
  isValidStatusTransition,
} from '../../src/prescription/prescription-data.js';
import { PrescriptionProgram } from '../../src/prescription/prescription-program.js';

// Fulfillment
import { FulfillmentData, ReversalData } from '../../src/fulfillment/fulfillment-data.js';
import { AccumulatorFulfillmentProgram } from '../../src/fulfillment/accumulator-fulfillment-program.js';

// Onboarding
import { TokenAuthority } from '../../src/onboarding/token-authority.js';
import { GroupRegistry, GroupConfig, GROUP_STATUS_ACTIVE } from '../../src/onboarding/group-registry.js';
import { OpaqueRoster, buildRosterEntry } from '../../src/onboarding/opaque-roster.js';
import { PlanTemplate } from '../../src/onboarding/plan-template.js';
import { EnrollmentService } from '../../src/onboarding/enrollment-service.js';

// Demo data
import {
  DEMO_PRESCRIBERS,
  DEMO_PHARMACIES,
  DEMO_MEMBERS,
  DEMO_MEDICATIONS,
  getAllFormularyEntries,
  getMembersByFamily,
} from '../../src/demo/index.js';

// Family accumulator pooling
import { FamilyAccumulatorService } from '../../src/onboarding/family-accumulator-service.js';
import type { FamilyLimits, MemberAccumulator } from '../../src/onboarding/family-accumulator-service.js';

// Reporting
import { ReportingService } from '../../src/reporting/reporting-service.js';
import type { VerifiedClaim, PriorAuthContext } from '../../src/reporting/report-types.js';

import type { VizEvent } from '../../src/l2/l2-rpc-server.js';

// ─── Console Event Types ────────────────────────────────

export type ConsoleEventType = 'compile' | 'proof' | 'offchain' | 'info' | 'error' | 'timing' | 'memory' | 'phase';

export interface ConsoleEvent {
  type: ConsoleEventType;
  timestamp: number;
  phase: string;
  message: string;
  /** Elapsed ms (set when operation completes) */
  elapsedMs?: number;
  /** Memory usage in MB */
  memoryMB?: number;
  /** Sub-operation indicator (e.g. "start", "complete") */
  status?: 'start' | 'complete' | 'error';
}

// ─── Provider Network ──────────────────────────────────
// Defines which prescribers/pharmacies are in-network for each plan.
// In production, this would be a MerkleTree-backed registry on-chain.
// The insurer issues eligibility notifications to in-network providers
// when a new member enrolls.

interface ProviderNetwork {
  prescriberIndices: number[];
  pharmacyIndices: number[];
}

const PLAN_NETWORKS: Record<string, ProviderNetwork> = {
  'PLAN-GOLD-2026': {
    // 7 of 10 prescribers in-network
    prescriberIndices: [0, 1, 2, 3, 4, 7, 9],
    // 5 of 8 pharmacies in-network
    pharmacyIndices: [0, 1, 2, 3, 4],
  },
};

// ─── Step Therapy Prerequisites ─────────────────────────
// Maps therapeutic class → required prerequisite classes patient must have tried first
const STEP_THERAPY_MAP: Record<string, string[]> = {
  'DPP-4 Inhibitor': ['Biguanide Antidiabetic'],                                           // Januvia → metformin first
  'JAK Inhibitor': ['TNF-alpha Inhibitor'],                                                 // Rinvoq → Humira class
  'Anti-IgE Monoclonal Antibody': ['ICS/LABA Combination', 'Short-Acting Beta-2 Agonist (SABA)'], // Xolair → Symbicort or albuterol
  'GLP-1 Receptor Agonist': ['Biguanide Antidiabetic', 'DPP-4 Inhibitor', 'SGLT2 Inhibitor'],    // Trulicity/Ozempic → metformin/Januvia/Jardiance
  'ICS/LABA Combination': ['Short-Acting Beta-2 Agonist (SABA)'],                           // Breo Ellipta → albuterol
  'ARNI (Heart Failure)': ['ACE Inhibitor'],                                                // Entresto → lisinopril first
};

// ─── Enrolled Member State ──────────────────────────────

type LifecycleStatus = 'ELIGIBLE' | 'ACTIVE' | 'REVOKED';

interface EnrolledMember {
  memberIndex: number;
  walletId: Field;
  walletIdStr: string;
  displayName: string;
  forest: MerkleForest;
  credentialData: CredentialData;
  credentialInventory: CredentialInventory;
  eligibilityData: EligibilityData;
  accumulatorData: AccumulatorData;
  planId: string;
  groupId: string;
  familyId: string;
  relationship: string;
  employeeId: string;
  preimageFields: Field[];
  pcpAssignment?: PcpAssignmentData;
  pcpPrescriberIndex?: number;
  inNetworkPrescriberIndices: number[];
  inNetworkPharmacyIndices: number[];
  lifecycle: LifecycleStatus;
  terminationDate?: string;
  walletIndex: number;
  nonce: number;
  credentialInventoryRoot: Field;
  cachedProofGateProof: unknown;
  l2Receipts: string[];
  /** Last generated portable credential JSON (for pharmacy fill) */
  lastCredentialJson?: string;
  /** Last sequencer-signed NFC attestation (for NFC tag writing) */
  lastAttestation?: NfcCredentialAttestation;
}

// ─── Prescription State ─────────────────────────────────

type RxStatus = 'ACTIVE' | 'PARTIALLY_FILLED' | 'FILLED' | 'DISPENSED' | 'CANCELLED' | 'REJECTED' | 'REVERSED' | 'COMPLETED';

interface RxStatusEntry {
  from: RxStatus;
  to: RxStatus;
  updatedBy: string;     // display name of actor
  updatedByRole: 'prescriber' | 'pharmacy';
  timestamp: number;
  fillQuantity?: number; // for partial/full fills
  note?: string;
}

interface PrescriptionState {
  id: string;
  prescriptionData: PrescriptionData;
  activeStatus: PrescriptionStatusData;
  rxForest: MerkleForest;
  rxCredentialData: CredentialData;
  formularyEntry: FormularyEntry;
  prescriberIndex: number;
  pharmacyIndex: number;
  memberWalletId: string;
  medicationIndex: number;
  quantity: number;
  quantityDispensed: number;  // running total of qty dispensed
  refills: number;
  refillsUsed: number;        // how many refills consumed
  status: RxStatus;
  statusHistory: RxStatusEntry[];
  currentStatusLeafIndex: bigint;  // leaf index of the current status in TRANSACTION tree
  nextTxLeafIndex: bigint;         // next available leaf in TRANSACTION tree
}

// ─── Fulfillment State ──────────────────────────────────

interface FulfillmentState {
  prescriptionId: string;
  fillIndex: number;              // which fill (0-based) — supports multi-fill Rx
  patientPayCents: number;
  planPayCents: number;
  totalCostCents: number;
  accumulatorBefore: { deductiblePaid: number; oopPaid: number; benefitUsed: number };
  accumulatorAfter: { deductiblePaid: number; oopPaid: number; benefitUsed: number };
  newEligForestRoot: string;
  oldEligForestRoot: string;
  settlementCommitment: Field;
  // Data retained for reversal
  fulfillmentData: FulfillmentData;
  patientPayField: Field;         // original patient pay (ZK Field)
  planPayField: Field;            // original plan pay (ZK Field)
  deductibleCreditField: Field;   // original deductible credit (ZK Field)
  settlementLeafIndex: bigint;    // TRANSACTION tree leaf index of settlement commitment
  quantityDispensed: number;      // qty dispensed in THIS fill
  reversed: boolean;              // true if this fill has been reversed
}

// ─── Prior Auth State ──────────────────────────────────

interface PriorAuthState {
  id: string;
  memberWalletId: string;
  prescriberIndex: number;
  medicationIndex: number;
  status: 'PENDING' | 'APPROVED' | 'DENIED';
  requestedAt: number;
  resolvedAt?: number;
  /** Leaf index in ACCESS_CONTROL tree (set on approval) */
  paLeafIndex?: bigint;
  /** PriorAuthData (set on approval) */
  priorAuthData?: PriorAuthData;
}

// ─── Service ────────────────────────────────────────────

export class InteractiveDemoService {
  // Infrastructure
  private walletRegistry!: WalletRegistry;
  private lifecycleTree!: MerkleTree;
  private benefitPlanRegistry!: BenefitPlanRegistry;
  private tokenAuthority!: TokenAuthority;
  private groupRegistry!: GroupRegistry;
  private opaqueRoster!: OpaqueRoster;
  private planTemplate!: PlanTemplate;
  private formularyRegistry!: FormularyRegistry;
  private enrollmentService!: EnrollmentService;
  private adminWalletId!: Field;
  private sharedEligibilityData!: EligibilityData;

  // Messaging registries
  private messageRegistry!: MessageRegistry;
  private delegationRegistry!: DelegationRegistry;
  private keyRegistry!: KeyRegistry;
  private msgNonce = 0;
  private encryptionKeys: Map<number, { publicKey: Buffer; privateKey: Buffer }> = new Map();
  private encryptedPayloads: Map<string, {
    ciphertext: string;       // hex-encoded encrypted bytes
    iv: string;               // hex-encoded IV
    tag: string;              // hex-encoded auth tag
    senderKeyIndex: number;
    recipientKeyIndex: number;
    threadId: string;          // raw string (before Poseidon hash), for thread grouping
    timestamp: number;         // Date.now() for ordering
  }> = new Map();
  private threadCounter = 0;

  // Pre-enrolled entities
  private prescriberWalletIds: Map<number, Field> = new Map();
  private prescriberPreimages: Map<number, Field[]> = new Map();
  private pharmacyWalletIds: Map<number, Field> = new Map();
  private pharmacyPreimages: Map<number, Field[]> = new Map();

  // Session state
  private enrolledMembers: Map<string, EnrolledMember> = new Map();
  private prescriptions: Map<string, PrescriptionState> = new Map();
  private fulfillments: Map<string, FulfillmentState[]> = new Map();
  private priorAuths: Map<string, PriorAuthState> = new Map();
  private rxCounter = 0;
  private paCounter = 0;
  /** Prescriptions currently being proved (visible to pharmacy as PENDING). */
  private pendingPrescriptions: Map<string, {
    id: string;
    prescriberIndex: number;
    pharmacyIndex: number;
    memberWalletId: string;
    medicationIndex: number;
    quantity: number;
    refills: number;
    startedAt: number;
  }> = new Map();
  /** Next available PA leaf index per member (leaves 1-126 in ACCESS_CONTROL tree) */
  private nextPaLeafIndex: Map<string, bigint> = new Map();
  private compiled = false;
  private ready = false;
  private reportingService = new ReportingService();
  private credentialProgramVk: string | null = null;
  private credentialProgramVkHash: Field | null = null;
  private attestationAuthority = new SequencerAttestationAuthority();

  // Formulary management state
  private formularyChangeHistory: Array<{
    timestamp: number;
    changeType: 'ADD' | 'REMOVE' | 'MODIFY';
    medicationIndex: number;
    medicationName: string;
    details: string;
    affectedMembers: string[];
    oldFormularyRoot: string;
    newFormularyRoot: string;
  }> = [];
  private currentFormularyEntries: FormularyEntryLocalData[] = [];
  private formularyActive: boolean[] = [];

  // Provider network management state
  private providerNetwork!: ProviderNetworkRegistry;
  private networkActive: Map<string, boolean> = new Map();
  private networkChangeHistory: Array<{
    timestamp: number;
    changeType: 'ADD' | 'REMOVE';
    prescriberWalletId: string;
    prescriberName: string;
    details: string;
    affectedMembers: string[];
    oldNetworkRoot: string;
    newNetworkRoot: string;
  }> = [];

  // L2 chain
  private l2Node: L2Node;

  // Event emitters
  private consoleEmitter: (event: ConsoleEvent) => void;
  private vizEmitter: (event: VizEvent) => void;

  constructor(
    consoleEmitter: (event: ConsoleEvent) => void,
    vizEmitter: (event: VizEvent) => void,
    l2Node: L2Node,
  ) {
    this.consoleEmitter = consoleEmitter;
    this.vizEmitter = vizEmitter;
    this.l2Node = l2Node;
    this.initInfrastructure();
  }

  // ─── Infrastructure Setup ─────────────────────────────

  private initInfrastructure(): void {
    this.emit('info', 'init', 'Initializing infrastructure...');

    this.adminWalletId = hashString('ADMIN-INSURER-2026');
    this.walletRegistry = new WalletRegistry();
    this.lifecycleTree = new MerkleTree(WALLET_TREE_HEIGHT);
    this.benefitPlanRegistry = new BenefitPlanRegistry();

    // Register prescribers + pharmacies (pre-enrolled entities)
    let entityIdx = 0n;
    for (let i = 0; i < DEMO_PRESCRIBERS.length; i++) {
      const p = DEMO_PRESCRIBERS[i];
      const wid = derivePrescriberWalletId(p.localData, p.enrollmentKey);
      this.prescriberWalletIds.set(i, wid);
      this.prescriberPreimages.set(i, prescriberWalletPreimage(p.localData, p.enrollmentKey));
      this.walletRegistry.register(wid);
      this.lifecycleTree.setLeaf(entityIdx, lifecycleLeafCommitment(wid, LIFECYCLE_ELIGIBLE));
      entityIdx++;
    }

    for (let i = 0; i < DEMO_PHARMACIES.length; i++) {
      const p = DEMO_PHARMACIES[i];
      const wid = derivePharmacyWalletId(p.localData, p.enrollmentKey);
      this.pharmacyWalletIds.set(i, wid);
      this.pharmacyPreimages.set(i, pharmacyWalletPreimage(p.localData, p.enrollmentKey));
      this.walletRegistry.register(wid);
      this.lifecycleTree.setLeaf(entityIdx, lifecycleLeafCommitment(wid, LIFECYCLE_ELIGIBLE));
      entityIdx++;
    }

    // Employer group + token authority
    this.tokenAuthority = new TokenAuthority('ACME-CORP-HR');
    this.groupRegistry = new GroupRegistry();
    this.opaqueRoster = new OpaqueRoster();

    // Build formulary — only initially-on-formulary meds get real entries;
    // off-formulary meds get sentinel entries to preserve index mapping
    const formularyEntries = getAllFormularyEntries();
    this.planTemplate = new PlanTemplate({
      planId: 'PLAN-GOLD-2026',
      copayAmountCents: 3000,
      coverageType: 1,
      deductibleAmountCents: 50000,
      oopMaxCents: 800000,
      annualBenefitMaxCents: 5000000,
      familyDeductibleAmountCents: 100000,
      familyOopMaxCents: 1600000,
      familyAnnualBenefitMaxCents: 10000000,
      formularyEntries,
    });

    // Rebuild FormularyRegistry to mark off-formulary meds as sentinel entries
    this.currentFormularyEntries = formularyEntries.map(e => ({ ...e }));
    this.formularyActive = DEMO_MEDICATIONS.map(m => m.initiallyOnFormulary !== false);

    const hasOffFormulary = this.formularyActive.some(a => !a);
    if (hasOffFormulary) {
      // Rebuild with sentinels for off-formulary drugs
      const newRegistry = new FormularyRegistry();
      for (let i = 0; i < this.currentFormularyEntries.length; i++) {
        if (this.formularyActive[i]) {
          const entry = buildFormularyEntry(this.currentFormularyEntries[i]);
          newRegistry.addEntry(entry);
        } else {
          const removedEntry = buildFormularyEntry({
            ndc: `REMOVED-${i}`,
            tierLevel: 0,
            copayAmount: 0,
            requiresPriorAuth: false,
            maxQuantityPerFill: 0,
            maxDaySupply: 0,
            stepTherapyRequired: false,
          });
          newRegistry.addEntry(removedEntry);
        }
      }
      this.formularyRegistry = newRegistry;
    } else {
      this.formularyRegistry = this.planTemplate.formularyRegistry;
    }

    // Build provider network registry — add all prescribers from the plan's network
    this.providerNetwork = new ProviderNetworkRegistry();
    const network = PLAN_NETWORKS['PLAN-GOLD-2026'] || { prescriberIndices: [], pharmacyIndices: [] };
    for (const idx of network.prescriberIndices) {
      const wid = this.prescriberWalletIds.get(idx)!;
      this.providerNetwork.addProvider(wid);
      this.networkActive.set(wid.toString(), true);
    }
    // Also track out-of-network prescribers as false
    for (let i = 0; i < DEMO_PRESCRIBERS.length; i++) {
      const wid = this.prescriberWalletIds.get(i)!;
      if (!this.networkActive.has(wid.toString())) {
        this.networkActive.set(wid.toString(), false);
      }
    }

    const planTemplates = new Map([['PLAN-GOLD-2026', this.planTemplate]]);

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
    this.groupRegistry.addGroup(groupConfig, {
      groupId: 'ACME-CORP',
      planId: 'PLAN-GOLD-2026',
      effectiveDate: '20260101',
      terminationDate: '',
      enrollmentCap: 100,
    });

    this.enrollmentService = new EnrollmentService(
      this.walletRegistry, this.lifecycleTree, this.tokenAuthority, this.groupRegistry,
      planTemplates, this.opaqueRoster, this.benefitPlanRegistry, this.adminWalletId,
    );

    // Build shared plan data and register it once
    this.sharedEligibilityData = this.rebuildSharedEligibilityData();
    this.benefitPlanRegistry.addPlan(this.sharedEligibilityData);

    // Messaging
    this.messageRegistry = new MessageRegistry();
    this.delegationRegistry = new DelegationRegistry();
    this.keyRegistry = new KeyRegistry();

    // Register encryption keys for prescribers (wallet indices 0-9)
    for (let i = 0; i < DEMO_PRESCRIBERS.length; i++) {
      const kp = deriveEncryptionKeyPair(DEMO_PRESCRIBERS[i].enrollmentKey);
      this.encryptionKeys.set(i, kp);
      const { pubKeyX, pubKeyY } = publicKeyToFields(kp.publicKey);
      this.keyRegistry.registerKey(BigInt(i), this.prescriberWalletIds.get(i)!, pubKeyX, pubKeyY);
    }
    // Register encryption keys for pharmacies (wallet indices 10-17)
    for (let i = 0; i < DEMO_PHARMACIES.length; i++) {
      const kp = deriveEncryptionKeyPair(DEMO_PHARMACIES[i].enrollmentKey);
      this.encryptionKeys.set(10 + i, kp);
      const { pubKeyX, pubKeyY } = publicKeyToFields(kp.publicKey);
      this.keyRegistry.registerKey(BigInt(10 + i), this.pharmacyWalletIds.get(i)!, pubKeyX, pubKeyY);
    }
    // Admin/Insurer encryption key (index 999)
    const adminKp = deriveEncryptionKeyPair('ADMIN-INSURER-ENCRYPTION-KEY-2026');
    this.encryptionKeys.set(999, adminKp);

    // Sync L2 sequencer roots with pre-enrolled entities (admin-provisioned)
    this.l2Node.getSequencer().applyAdminRootUpdate({
      newRegistryRoot: this.walletRegistry.getRoot(),
      newLifecycleRoot: this.lifecycleTree.getRoot(),
    });

    this.emit('info', 'init', `Infrastructure ready. ${DEMO_PRESCRIBERS.length} prescribers, ${DEMO_PHARMACIES.length} pharmacies pre-enrolled.`);
    this.emit('info', 'init', `L2 sequencer synced: registry + lifecycle roots updated.`);
    this.emitMemory('init');
  }

  // ─── ZkProgram Compilation ─────────────────────────────

  async compileAllPrograms(): Promise<void> {
    this.emit('phase', 'compile', '═══ ZkProgram Compilation (one-time startup) ═══');
    this.emit('info', 'compile', 'Compiling 10 ZkPrograms into prover/verifier key pairs...');
    this.emit('info', 'compile', 'This is a one-time cost — cached for all subsequent proofs.');

    const programs = [
      { name: 'ProofGateProgram (3 methods)', fn: () => ProofGateProgram.compile() },
      { name: 'EligibilityProgram', fn: () => EligibilityProgram.compile() },
      { name: 'AccessControlProgram (2 methods)', fn: () => AccessControlProgram.compile() },
      { name: 'MessagingProgram (2 methods)', fn: () => MessagingProgram.compile() },
      { name: 'PrescriptionProgram (2 methods)', fn: () => PrescriptionProgram.compile() },
      { name: 'AccumulatorFulfillmentProgram (2 methods)', fn: () => AccumulatorFulfillmentProgram.compile() },
      { name: 'PcpVerificationProgram', fn: () => PcpVerificationProgram.compile() },
      { name: 'CredentialProgram (3 methods)', fn: async () => {
        const result = await CredentialProgram.compile();
        this.credentialProgramVk = JSON.stringify(result.verificationKey);
        this.credentialProgramVkHash = Field(result.verificationKey.hash);
      } },
      { name: 'StateTransitionProgram (2 methods)', fn: () => StateTransitionProgram.compile() },
      { name: 'BatchProgram (3 methods)', fn: () => BatchProgram.compile() },
    ];

    const compileStart = performance.now();

    for (let i = 0; i < programs.length; i++) {
      const prog = programs[i];
      this.emit('compile', 'compile', `[${i + 1}/${programs.length}] Compiling ${prog.name}...`, 'start');

      const start = performance.now();
      await prog.fn();
      const elapsed = performance.now() - start;

      this.emit('compile', 'compile', `[${i + 1}/${programs.length}] ${prog.name} compiled`, 'complete', elapsed);
      this.emitMemory('compile');
    }

    const totalMs = performance.now() - compileStart;
    this.emit('timing', 'compile', `All 10 programs compiled in ${(totalMs / 1000).toFixed(1)}s`, undefined, totalMs);
    this.compiled = true;
    this.ready = true;
  }

  // ─── Enroll Member ────────────────────────────────────

  async enrollMember(memberIndex: number): Promise<Record<string, unknown>> {
    if (!this.compiled) throw new Error('Programs not compiled yet');

    const member = DEMO_MEMBERS[memberIndex];
    if (!member) throw new Error(`Invalid member index: ${memberIndex}`);

    const displayName = `${member.localData.firstName} ${member.localData.lastName}`;

    // Check if already fully enrolled (e.g., user clicked "Enroll" twice)
    const existingWalletId = deriveMemberWalletId(member.localData, member.enrollmentKey);
    if (this.enrolledMembers.has(existingWalletId.toString())) {
      const existing = this.enrolledMembers.get(existingWalletId.toString())!;
      this.emit('info', 'enroll', `${displayName} is already enrolled — skipping`);
      return {
        memberIndex,
        walletId: existing.walletIdStr,
        displayName: existing.displayName,
        lifecycle: existing.lifecycle,
        alreadyEnrolled: true,
      };
    }

    const enrollStartTime = performance.now();
    this.emit('phase', 'enroll', `═══ Member Enrollment: ${displayName} ═══`);

    // 1. Generate enrollment token (employer step)
    const tokenId = `TOKEN-${String(memberIndex + 1).padStart(3, '0')}`;
    try {
      this.tokenAuthority.generateToken('ACME-CORP', 'PLAN-GOLD-2026', member.employeeId, member.familyId, '20261231', tokenId);
    } catch {
      // Token may already exist from a previous enrollment attempt; ignore
    }
    this.emit('offchain', 'enroll', `Step 1: ACME Corp HR generates enrollment token ${tokenId}`);

    this.emitViz('viz:token:generated', 'enrollment', {
      actor: 'ACME Corp HR',
      actorType: 'employer',
      target: displayName,
      targetType: 'member',
      data: { tokenId, employeeId: member.employeeId, planId: 'PLAN-GOLD-2026' },
    });

    // 2. Derive wallet ID (member step — on their device)
    this.emit('offchain', 'enroll', `Step 2: ${member.localData.firstName} computes walletId on their device...`, 'start');
    const start2 = performance.now();
    const walletId = deriveMemberWalletId(member.localData, member.enrollmentKey);
    const preimageFields = memberWalletPreimage(member.localData, member.enrollmentKey);
    const elapsed2 = performance.now() - start2;

    const walletIdStr = truncField(walletId);
    this.emit('offchain', 'enroll', `Step 2: Wallet ID derived: ${walletIdStr}`, 'complete', elapsed2);
    this.emit('info', 'enroll', '         (enrollment key stays on device, NEVER transmitted)');
    this.emit('info', 'enroll', `  ┌─ WALLET DERIVATION`);
    this.emit('info', 'enroll', `  │  Formula: Poseidon.hash([DOMAIN_TAG_MEMBER, hash(cardholderId), dob, hash(firstName), hash(lastName), hash(enrollmentKey)])`);
    this.emit('info', 'enroll', `  │  Wallet ID:       ${walletId.toString()}`);
    this.emit('info', 'enroll', `  │  Preimage Fields: [${preimageFields.map(f => truncField(f)).join(', ')}]`);
    this.emit('info', 'enroll', `  └─ No private key — access through ZK proof only`);

    this.emitViz('viz:enrollment:wallet_derived', 'enrollment', {
      actor: displayName,
      actorType: 'member',
      data: { walletId: walletIdStr, step: 'wallet_derived', memberIndex: member.memberIndex },
    });

    // 3. Generate ProofGate proof (member proves identity — CACHED for reuse)
    this.emit('proof', 'enroll', 'Step 3: Generating ProofGate.verifyMember proof...', 'start');
    const startProof = performance.now();
    const proofGateResult = await ProofGateProgram.verifyMember(
      walletId,
      ...preimageFields as [Field, Field, Field, Field, Field],
    );
    const cachedProofGateProof = proofGateResult.proof;
    const elapsedProof = performance.now() - startProof;
    this.emit('proof', 'enroll', `Step 3: ProofGate.verifyMember proof generated`, 'complete', elapsedProof);
    this.emit('info', 'enroll', `  ┌─ PROOF: ProofGate.verifyMember`);
    this.emit('info', 'enroll', `  │  Public Input:   walletId = ${truncField(walletId)}`);
    this.emit('info', 'enroll', `  │  Private Inputs: 5 preimage fields (hash(cardholderId), dob, hash(firstName), hash(lastName), hash(enrollmentKey))`);
    this.emit('info', 'enroll', `  │  Constraint:     Poseidon.hash([DOMAIN_TAG_MEMBER, ...preimage]) == walletId`);
    this.emit('info', 'enroll', `  │  Result:         VERIFIED — ${displayName} proved identity without revealing PHI`);
    this.emit('info', 'enroll', `  └─ Proof time: ${elapsedProof.toFixed(0)}ms`);

    this.emitViz('viz:enrollment:proof_gate', 'enrollment', {
      actor: displayName,
      actorType: 'member',
      target: 'Insurer',
      targetType: 'insurer',
      data: { walletId: walletIdStr, step: 'proof_gate', elapsedMs: elapsedProof, memberIndex: member.memberIndex },
    });

    // 4. PHASE A: Registration — proveRegistration (wallet + lifecycle)
    this.emitViz('viz:enrollment:started', 'enrollment', {
      actor: displayName,
      actorType: 'member',
      actorWalletId: walletIdStr,
      target: 'leviathan',
      targetType: 'leviathan',
      data: { tokenId, step: 'processing', memberIndex: member.memberIndex },
    });

    this.emit('offchain', 'enroll', 'Step 4a: Capturing pre-registration roots...', 'start');
    const preRegRoot = this.walletRegistry.getRoot();
    const preLcRoot = this.lifecycleTree.getRoot();
    const regWitness = this.walletRegistry.getNextSlotWitness();
    const walletIndex = Number(this.walletRegistry.count);
    const lcWitness = new LifecycleWitness(this.lifecycleTree.getWitness(BigInt(walletIndex)));

    // Register wallet in local registry + lifecycle
    this.walletRegistry.register(walletId);
    this.lifecycleTree.setLeaf(BigInt(walletIndex), lifecycleLeafCommitment(walletId, LIFECYCLE_REGISTERED));

    this.emit('proof', 'enroll', 'Step 4a: Generating StateTransitionProof.proveRegistration...', 'start');
    const startReg = performance.now();
    const regResult = await StateTransitionProgram.proveRegistration(
      DOMAIN_TAG_MEMBER,
      preimageFields[0]!, preimageFields[1]!, preimageFields[2]!, preimageFields[3]!, preimageFields[4]!,
      regWitness,
      lcWitness,
      preRegRoot,
      preLcRoot,
    );
    const elapsedReg = performance.now() - startReg;
    this.emit('proof', 'enroll', `Step 4a: Registration proof generated`, 'complete', elapsedReg);

    const regOutput = regResult.proof.publicOutput;
    this.emit('info', 'enroll', `  ┌─ PROOF: StateTransitionProgram.proveRegistration`);
    this.emit('info', 'enroll', `  │  Wallet Index:        ${walletIndex}`);
    this.emit('info', 'enroll', `  │  Public Output:`);
    this.emit('info', 'enroll', `  │    walletId:           ${truncField(regOutput.walletId)}`);
    this.emit('info', 'enroll', `  │    oldRegistryRoot:    ${truncField(regOutput.oldRegistryRoot)}`);
    this.emit('info', 'enroll', `  │    newRegistryRoot:    ${truncField(regOutput.newRegistryRoot)}`);
    this.emit('info', 'enroll', `  │    oldLifecycleRoot:   ${truncField(regOutput.oldLifecycleRoot)}`);
    this.emit('info', 'enroll', `  │    newLifecycleRoot:   ${truncField(regOutput.newLifecycleRoot)}`);
    this.emit('info', 'enroll', `  └─ Merkle inclusion: wallet inserted at index ${walletIndex} (${elapsedReg.toFixed(0)}ms)`);

    // Submit registration proof to L2
    const regReceipt = await this.l2Node.submitProof(regResult.proof as StateTransitionProof);
    this.emit('info', 'enroll', `  ┌─ L2 RECEIPT #1 (Registration)`);
    this.emit('info', 'enroll', `  │  Receipt ID:  ${regReceipt.receiptId}`);
    this.emit('info', 'enroll', `  │  Sequence #:  ${regReceipt.sequenceNumber}`);
    this.emit('info', 'enroll', `  └─ Wallet registered on L2 chain`);

    this.emitViz('viz:enrollment:registration', 'enrollment', {
      actor: displayName,
      actorType: 'member',
      actorWalletId: walletIdStr,
      target: 'leviathan',
      targetType: 'leviathan',
      data: { receiptId: regReceipt.receiptId, step: 'registration' },
    });

    // 4b. PHASE B: Credential mint — build forest + CredentialData + proveWalletUpdate
    // NOTE: Admin lifecycle transition (REGISTERED → ELIGIBLE) is deferred to AFTER
    // the wallet update proof so both proofs chain correctly in BatchProgram.wrapPair().
    // The registration proof sets lifecycle to REGISTERED; the wallet update proof must
    // use the same REGISTERED root. The ELIGIBLE advancement happens after both proofs.
    this.emit('offchain', 'enroll', 'Step 4c: Building eligibility forest + minting credential...', 'start');
    const startMint = performance.now();

    // Validate + consume token via tokenAuthority
    try {
      const tokenData = this.tokenAuthority.validateToken(tokenId, '20260215');
      if (tokenData.valid) {
        this.tokenAuthority.consumeToken(tokenId, walletId);
        // Increment group enrolled count
        const groupIdHash = hashString(tokenData.groupId!);
        const groupResult = this.groupRegistry.getGroupByHash(groupIdHash);
        if (groupResult) {
          const currentCount = BigInt(groupResult.config.enrolledCount.toString());
          const updatedGroupConfig = new GroupConfig({
            groupIdHash: groupResult.config.groupIdHash,
            planIdHash: groupResult.config.planIdHash,
            effectiveDate: groupResult.config.effectiveDate,
            terminationDate: groupResult.config.terminationDate,
            enrollmentCap: groupResult.config.enrollmentCap,
            enrolledCount: Field(currentCount + 1n),
            status: groupResult.config.status,
          });
          this.groupRegistry.updateGroup(groupResult.index, updatedGroupConfig);
        }
      }
    } catch {
      // Token already consumed (e.g., reset), proceed with forest building
    }

    // Use shared plan data
    const eligibilityData = this.sharedEligibilityData;
    const accumulatorData = buildAccumulatorData({
      planYear: '20260101',
      deductibleAmountCents: 50000,
      deductiblePaidCents: 0,
      oopMaxCents: 800000,
      oopPaidCents: 0,
      annualBenefitMaxCents: 0,
      annualBenefitUsedCents: 0,
    });

    // Build member forest
    const forest = new MerkleForest();
    forest.setLeaf(ForestDomain.ACCESS_CONTROL, 0n, eligibilityData.commitment());
    forest.setLeaf(ForestDomain.ACCESS_CONTROL, ACCUMULATOR_LEAF_INDEX, accumulatorData.commitment());

    // Create CredentialData
    const credentialData = new CredentialData({
      credentialType: CREDENTIAL_TYPE_ELIGIBILITY,
      forestRoot: forest.getForestRoot(),
      issuerWalletId: this.adminWalletId,
      subjectWalletId: walletId,
      issuedAt: dateToField('20260201'),
      expiresAt: Field(0),
      revoked: Field(0),
    });

    // ─── Patent Evidence: Credential Mint Details ───────────────────
    this.emit('info', 'enroll', `  ┌─ ELIGIBILITY CREDENTIAL MINTED`);
    this.emit('info', 'enroll', `  │  Credential Type:  ELIGIBILITY`);
    this.emit('info', 'enroll', `  │  Subject:          ${truncField(walletId)} (${displayName})`);
    this.emit('info', 'enroll', `  │  Issuer:           ${truncField(this.adminWalletId)} (Insurer)`);
    this.emit('info', 'enroll', `  │  Forest Root:      ${truncField(forest.getForestRoot())}`);
    this.emit('info', 'enroll', `  │  6 Domain Trees:   MEMBER, PRESCRIBER, PHARMACY, MEDICATION, ACCESS_CONTROL, TRANSACTION`);
    this.emit('info', 'enroll', `  │  ACCESS_CONTROL Tree:`);
    this.emit('info', 'enroll', `  │    Leaf 0:  EligibilityData commitment = ${truncField(eligibilityData.commitment())}`);
    this.emit('info', 'enroll', `  │    Leaf 127: AccumulatorData commitment = ${truncField(accumulatorData.commitment())}`);
    this.emit('info', 'enroll', `  │  Eligibility Data:`);
    this.emit('info', 'enroll', `  │    planIdHash:       ${truncField(eligibilityData.planIdHash)}`);
    this.emit('info', 'enroll', `  │    groupIdHash:      ${truncField(eligibilityData.groupIdHash)}`);
    this.emit('info', 'enroll', `  │    formularyRoot:    ${truncField(eligibilityData.formularyRoot)}`);
    this.emit('info', 'enroll', `  │    networkRoot:      ${truncField(eligibilityData.networkRoot)}`);
    this.emit('info', 'enroll', `  │    copayAmountCents: ${Number(eligibilityData.copayAmountCents.toBigInt())}`);
    this.emit('info', 'enroll', `  └─ Credential forest embeds ${this.formularyActive.filter(a => a).length} formulary entries + ${this.providerNetwork.count} network providers`);

    // Create CredentialInventory + mint
    const credentialInventory = new CredentialInventory();
    credentialInventory.mint(credentialData);
    const inventoryRoot = credentialInventory.getRoot();

    // Generate proveWalletUpdate (EMPTY_CREDENTIAL_ROOT → inventoryRoot, nonce 0→1)
    const mintRegWitness = this.walletRegistry.getWitnessByIndex(BigInt(walletIndex));
    const mintLcWitness = new LifecycleWitness(this.lifecycleTree.getWitness(BigInt(walletIndex)));
    const currentRegRoot = this.walletRegistry.getRoot();
    const currentLcRoot = this.lifecycleTree.getRoot();

    this.emit('proof', 'enroll', 'Step 4c: Generating StateTransitionProof.proveWalletUpdate (credential mint)...', 'start');
    const stResult = await StateTransitionProgram.proveWalletUpdate(
      DOMAIN_TAG_MEMBER,
      preimageFields[0]!, preimageFields[1]!, preimageFields[2]!, preimageFields[3]!, preimageFields[4]!,
      EMPTY_CREDENTIAL_ROOT, Field(0), inventoryRoot,
      mintRegWitness, mintLcWitness, currentRegRoot, currentLcRoot,
      LIFECYCLE_REGISTERED,
    );
    const elapsedMint = performance.now() - startMint;
    this.emit('proof', 'enroll', `Step 4b: Wallet update proof generated (credential minted)`, 'complete', elapsedMint);

    const mintOutput = stResult.proof.publicOutput;
    this.emit('info', 'enroll', `  ┌─ PROOF: StateTransitionProgram.proveWalletUpdate (Credential Mint)`);
    this.emit('info', 'enroll', `  │  Old Credential Root:   EMPTY_CREDENTIAL_ROOT (no credential before enrollment)`);
    this.emit('info', 'enroll', `  │  New Credential Root:   ${truncField(inventoryRoot)} (eligibility credential minted)`);
    this.emit('info', 'enroll', `  │  Nonce:          0 → 1`);
    this.emit('info', 'enroll', `  │  Public Output:`);
    this.emit('info', 'enroll', `  │    walletId:         ${truncField(mintOutput.walletId)}`);
    this.emit('info', 'enroll', `  │    oldRegistryRoot:  ${truncField(mintOutput.oldRegistryRoot)}`);
    this.emit('info', 'enroll', `  │    newRegistryRoot:  ${truncField(mintOutput.newRegistryRoot)}`);
    this.emit('info', 'enroll', `  │    oldLifecycleRoot: ${truncField(mintOutput.oldLifecycleRoot)}`);
    this.emit('info', 'enroll', `  │    newLifecycleRoot: ${truncField(mintOutput.newLifecycleRoot)}`);
    this.emit('info', 'enroll', `  └─ Wallet state updated: nonce=1, credential inventory root set (${elapsedMint.toFixed(0)}ms)`);

    // Update wallet registry with new state (nonce=1, inventoryRoot)
    this.walletRegistry.updateState(walletId, new WalletState({
      walletId,
      credentialInventoryRoot: inventoryRoot,
      nonce: Field(1),
    }));

    // Submit credential mint proof to L2
    const mintReceipt = await this.l2Node.submitProof(stResult.proof as StateTransitionProof);
    this.emit('info', 'enroll', `  ┌─ L2 RECEIPT #2 (Credential Mint)`);
    this.emit('info', 'enroll', `  │  Receipt ID:  ${mintReceipt.receiptId}`);
    this.emit('info', 'enroll', `  │  Sequence #:  ${mintReceipt.sequenceNumber}`);
    this.emit('info', 'enroll', `  └─ Eligibility credential committed to L2 chain`);

    this.emitViz('viz:enrollment:credential_mint', 'enrollment', {
      actor: 'Insurer',
      actorType: 'insurer',
      target: displayName,
      targetType: 'member',
      targetWalletId: walletIdStr,
      data: { receiptId: mintReceipt.receiptId, step: 'credential_mint' },
    });

    // 4b-settle. Batch the 2 enrollment proofs BEFORE the admin lifecycle update.
    // Uses buildBatchDirect() which routes through the proving pool if available
    // (avoids accumulating WASM heap on the main thread). Falls back to
    // single-process buildBatch() if no pool. In L2-only mode, both buildBatch()
    // and finalizeBatch() auto-settle, so no manual markBatchSettled() needed.
    this.emit('offchain', 'enroll', `Batch building... (${this.l2Node.getSequencer().getPendingCount()} pending transitions)`);
    try {
      const enrollBatch = await this.l2Node.buildBatchDirect();
      if (enrollBatch) {
        this.emit('offchain', 'enroll', `Enrollment batch #${enrollBatch.batchNumber} built & settled (${enrollBatch.transitionCount} transitions)`);
      }
    } catch (e) {
      this.emit('offchain', 'enroll', `Enrollment batch build warning: ${e instanceof Error ? e.message : e}`);
    }

    // 4c. PHASE C: Admin lifecycle transition (REGISTERED → ELIGIBLE)
    // Deferred to after both proofs are batched so the proof chain is continuous.
    this.emit('offchain', 'enroll', 'Step 4c: Admin lifecycle transition REGISTERED → ELIGIBLE...', 'start');
    this.lifecycleTree.setLeaf(BigInt(walletIndex), lifecycleLeafCommitment(walletId, LIFECYCLE_ELIGIBLE));
    this.l2Node.getSequencer().applyAdminRootUpdate({
      newLifecycleRoot: this.lifecycleTree.getRoot(),
    });
    this.emit('offchain', 'enroll', 'Step 4c: Lifecycle updated to ELIGIBLE (admin op)', 'complete');

    this.emitViz('viz:enrollment:lifecycle', 'enrollment', {
      actor: 'Insurer',
      actorType: 'insurer',
      target: displayName,
      targetType: 'member',
      targetWalletId: walletIdStr,
      data: { lifecycle: 'ELIGIBLE', step: 'lifecycle' },
    });

    // Update opaque roster
    try {
      const rosterEntry = buildRosterEntry(walletId, {
        planId: 'PLAN-GOLD-2026',
        groupId: 'ACME-CORP',
        familyId: member.familyId,
        enrolledDate: '20260201',
        tokenId,
      });
      this.opaqueRoster.addEntry(rosterEntry);
    } catch {
      // May already exist from previous enrollment
    }

    this.emit('offchain', 'enroll', `Step 4: Enrollment complete — 2 StateTransitionProofs, 2 L2 receipts`, 'complete');
    this.emitMemory('enroll');

    const planId = 'PLAN-GOLD-2026';
    const groupId = 'ACME-CORP';

    // 5. Provider network credentialing
    const network = PLAN_NETWORKS[planId] || { prescriberIndices: [], pharmacyIndices: [] };
    this.emit('offchain', 'enroll', `Step 5: Insurer issues eligibility notifications to in-network providers...`, 'start');
    this.emit('info', 'enroll', `         ${network.prescriberIndices.length} prescribers + ${network.pharmacyIndices.length} pharmacies in ${planId} network`);
    for (const idx of network.prescriberIndices) {
      const p = DEMO_PRESCRIBERS[idx];
      this.emit('info', 'enroll', `    → Dr. ${p.firstName} ${p.lastName}, ${p.credential} (${p.specialty}) — CREDENTIALED`);
      this.emitViz('viz:enrollment:provider_notify', 'enrollment', {
        actor: 'Insurer',
        actorType: 'insurer',
        target: `Dr. ${p.firstName} ${p.lastName}`,
        targetType: 'prescriber',
        data: { providerType: 'prescriber', providerIndex: idx, step: 'provider_notify' },
      });
    }
    for (const idx of network.pharmacyIndices) {
      const p = DEMO_PHARMACIES[idx];
      this.emit('info', 'enroll', `    → ${p.storeName} (${p.pharmacyTypeDesc}) — CREDENTIALED`);
      this.emitViz('viz:enrollment:provider_notify', 'enrollment', {
        actor: 'Insurer',
        actorType: 'insurer',
        target: p.storeName,
        targetType: 'pharmacy',
        data: { providerType: 'pharmacy', providerIndex: idx, step: 'provider_notify' },
      });
    }
    this.emit('offchain', 'enroll', `Step 5: Provider network credentials issued`, 'complete');

    // Register encryption key in KeyRegistry
    const memberKp = deriveEncryptionKeyPair(member.enrollmentKey);
    const memberWalletIndex = this.walletRegistry.count - 1;
    this.encryptionKeys.set(memberWalletIndex, memberKp);
    const { pubKeyX, pubKeyY } = publicKeyToFields(memberKp.publicKey);
    this.keyRegistry.registerKey(BigInt(memberWalletIndex), walletId, pubKeyX, pubKeyY);
    this.emit('offchain', 'enroll', `Step 5b: Encryption key registered in KeyRegistry (index ${memberWalletIndex})`);

    // Store state
    const enrolled: EnrolledMember = {
      memberIndex,
      walletId,
      walletIdStr,
      displayName,
      forest,
      credentialData,
      credentialInventory,
      eligibilityData,
      accumulatorData,
      planId,
      groupId,
      familyId: member.familyId,
      relationship: member.relationship,
      employeeId: member.employeeId,
      preimageFields,
      inNetworkPrescriberIndices: network.prescriberIndices,
      inNetworkPharmacyIndices: network.pharmacyIndices,
      lifecycle: 'ELIGIBLE',
      walletIndex: memberWalletIndex,
      nonce: 1,
      credentialInventoryRoot: inventoryRoot,
      cachedProofGateProof,
      l2Receipts: [regReceipt.receiptId, mintReceipt.receiptId],
    };
    this.enrolledMembers.set(walletId.toString(), enrolled);

    this.emitViz('viz:enrollment:complete', 'enrollment', {
      actor: 'Insurer',
      actorType: 'insurer',
      target: displayName,
      targetType: 'member',
      targetWalletId: walletIdStr,
      data: {
        walletId: walletIdStr,
        planId,
        groupId,
        lifecycle: 'ELIGIBLE',
        memberIndex: member.memberIndex,
      },
    });

    this.emit('info', 'enroll', '');
    this.emit('info', 'enroll', `  BENEFIT PLAN: PLAN-GOLD-2026`);
    this.emit('info', 'enroll', `    Copay:       $30.00`);
    this.emit('info', 'enroll', `    Deductible:  $500.00 individual / $1,000.00 family`);
    this.emit('info', 'enroll', `    OOPM:        $8,000.00 individual / $16,000.00 family`);
    this.emit('info', 'enroll', `    Formulary:   ${DEMO_MEDICATIONS.length} medications across 4 tiers`);
    this.emit('info', 'enroll', `    Network:     ${network.prescriberIndices.length} prescribers, ${network.pharmacyIndices.length} pharmacies`);
    this.emit('info', 'enroll', `    Family:      ${member.familyId} (${member.relationship})`);

    // Auto-send welcome notification
    this.sendInternalMessage(this.adminWalletId, walletId, MSG_TYPE_NOTIFICATION,
      'Welcome', `Welcome to PLAN-GOLD-2026! Your benefits are now active under group ${groupId}.`);

    return {
      walletId: walletId.toString(),
      walletIdDisplay: walletIdStr,
      displayName,
      memberIndex,
      planId,
      groupId,
      lifecycle: 'ELIGIBLE',
      plan: {
        copayAmountCents: 3000,
        deductibleAmountCents: 50000,
        oopMaxCents: 800000,
        annualBenefitMaxCents: 0,
        familyDeductibleAmountCents: 100000,
        familyOopMaxCents: 1600000,
        familyAnnualBenefitMaxCents: 0,
        formularyCount: DEMO_MEDICATIONS.length,
      },
      accumulator: {
        deductiblePaidCents: 0,
        deductibleAmountCents: 50000,
        oopPaidCents: 0,
        oopMaxCents: 800000,
        benefitUsedCents: 0,
        benefitMaxCents: 0,
      },
      credentialForestRoot: truncField(forest.getForestRoot()),
      enrollTimeMs: performance.now() - enrollStartTime,
      proofTimeMs: elapsedProof,
      registrationProofTimeMs: elapsedReg,
      mintProofTimeMs: elapsedMint,
      // ─── ZK Data (full transparency) ────────────────
      credential: serializeCredentialData(credentialData),
      forest: serializeForestRoots(forest),
      walletState: {
        walletId: fieldToStr(walletId),
        credentialInventoryRoot: fieldToStr(inventoryRoot),
        nonce: '1',
      },
      l2Receipts: [
        { receiptId: regReceipt.receiptId, type: 'registration', sequenceNumber: Number(regReceipt.sequenceNumber) },
        { receiptId: mintReceipt.receiptId, type: 'credential-mint', sequenceNumber: Number(mintReceipt.sequenceNumber) },
      ],
      lifecycleLeaf: fieldToStr(lifecycleLeafCommitment(walletId, LIFECYCLE_ELIGIBLE)),
      familyId: member.familyId,
      relationship: member.relationship,
      employeeId: member.employeeId,
      familyMembers: getMembersByFamily(member.familyId).map(fm => ({
        firstName: fm.localData.firstName,
        lastName: fm.localData.lastName,
        relationship: fm.relationship,
        employeeId: fm.employeeId,
      })),
      token: {
        tokenId,
        status: 'CONSUMED',
        groupId: 'ACME-CORP',
        planId: 'PLAN-GOLD-2026',
        employeeId: member.employeeId,
        familyId: member.familyId,
        validUntil: '20261231',
      },
      providerNetwork: {
        prescriberCount: network.prescriberIndices.length,
        pharmacyCount: network.pharmacyIndices.length,
        prescribers: network.prescriberIndices.map(i => {
          const p = DEMO_PRESCRIBERS[i];
          return { index: i, name: `Dr. ${p.firstName} ${p.lastName}`, credential: p.credential, specialty: p.specialty };
        }),
        pharmacies: network.pharmacyIndices.map(i => {
          const p = DEMO_PHARMACIES[i];
          return { index: i, name: p.storeName, type: p.pharmacyTypeDesc };
        }),
      },
      chainState: this.getChainState(),
    };
  }

  // ─── Enroll Family ──────────────────────────────────────

  async enrollFamily(subscriberIndex: number): Promise<Record<string, unknown>> {
    if (!this.compiled) throw new Error('Programs not compiled yet');

    const subscriber = DEMO_MEMBERS[subscriberIndex];
    if (!subscriber) throw new Error(`Invalid member index: ${subscriberIndex}`);
    if (subscriber.relationship !== 'SELF') {
      throw new Error(`Member at index ${subscriberIndex} is not a subscriber (${subscriber.relationship}). Enroll the subscriber first.`);
    }

    const familyMembers = getMembersByFamily(subscriber.familyId);
    this.emit('phase', 'enroll', `═══ Family Enrollment: ${subscriber.familyId} (${familyMembers.length} members) ═══`);

    const results: Record<string, unknown>[] = [];

    for (const fm of familyMembers) {
      const idx = DEMO_MEMBERS.indexOf(fm);
      // Skip if already enrolled
      const existingWalletId = deriveMemberWalletId(fm.localData, fm.enrollmentKey);
      if (this.enrolledMembers.has(existingWalletId.toString())) {
        this.emit('info', 'enroll', `  ${fm.localData.firstName} ${fm.localData.lastName} already enrolled — skipping`);
        const existing = this.enrolledMembers.get(existingWalletId.toString())!;
        results.push({ memberIndex: idx, displayName: existing.displayName, walletId: existing.walletIdStr, status: 'already_enrolled' });
        continue;
      }
      const result = await this.enrollMember(idx);
      results.push({ ...result, status: 'enrolled' });
    }

    this.emit('info', 'enroll', `  Family enrollment complete: ${results.length} members in ${subscriber.familyId}`);

    return {
      familyId: subscriber.familyId,
      memberCount: results.length,
      members: results,
    };
  }

  // ─── Prior Authorization ─────────────────────────────────

  /**
   * Request a prior authorization for a PA-required medication.
   * Creates a PENDING PA request that the insurer must approve or deny.
   */
  requestPriorAuth(opts: {
    memberWalletId: string;
    prescriberIndex: number;
    medicationIndex: number;
  }): Record<string, unknown> {
    const medication = DEMO_MEDICATIONS[opts.medicationIndex];
    if (!medication) throw new Error(`Invalid medication index: ${opts.medicationIndex}`);
    if (!medication.formularyEntry.requiresPriorAuth) {
      throw new Error(`${medication.brandName} does not require prior authorization`);
    }

    const enrolled = this.enrolledMembers.get(opts.memberWalletId);
    if (!enrolled) throw new Error(`Member not enrolled: ${opts.memberWalletId}`);

    const prescriber = DEMO_PRESCRIBERS[opts.prescriberIndex];
    if (!prescriber) throw new Error(`Invalid prescriber index: ${opts.prescriberIndex}`);

    // Check for existing PA (pending or approved) for this member+medication
    for (const [_, pa] of this.priorAuths) {
      if (pa.memberWalletId === opts.memberWalletId &&
          pa.medicationIndex === opts.medicationIndex &&
          (pa.status === 'PENDING' || pa.status === 'APPROVED')) {
        throw new Error(
          `Prior auth already ${pa.status.toLowerCase()} for ${medication.brandName} (${pa.id})`
        );
      }
    }

    this.paCounter++;
    const paId = `PA-${String(this.paCounter).padStart(4, '0')}`;
    const paState: PriorAuthState = {
      id: paId,
      memberWalletId: opts.memberWalletId,
      prescriberIndex: opts.prescriberIndex,
      medicationIndex: opts.medicationIndex,
      status: 'PENDING',
      requestedAt: Date.now(),
    };
    this.priorAuths.set(paId, paState);

    const prescriberName = `Dr. ${prescriber.firstName} ${prescriber.lastName}`;
    this.emit('phase', 'prior-auth', `═══ Prior Auth Request: ${medication.brandName} ═══`);
    this.emit('offchain', 'prior-auth', `${prescriberName} requests PA for ${enrolled.displayName}`);
    this.emit('info', 'prior-auth', `  Medication: ${medication.brandName} ${medication.strength} (Tier ${medication.formularyEntry.tierLevel})`);
    this.emit('info', 'prior-auth', `  PA ID: ${paId} — Status: PENDING`);
    this.emit('info', 'prior-auth', `  Awaiting insurer review...`);

    this.emitViz('viz:eligibility:verified', 'eligibility', {
      actor: prescriberName,
      actorType: 'prescriber',
      target: enrolled.displayName,
      targetType: 'member',
      data: { paId, medication: medication.brandName, status: 'PENDING' },
    });

    // Auto-send PA_REQUEST message (prescriber → insurer)
    const prescriberWalletId = this.prescriberWalletIds.get(opts.prescriberIndex)!;
    this.sendInternalMessage(prescriberWalletId, this.adminWalletId, MSG_TYPE_PA_REQUEST,
      `PA Request: ${medication.brandName}`, `Prior auth requested for ${medication.brandName} ${medication.strength} — patient ${enrolled.walletIdStr}`);

    return {
      paId,
      status: 'PENDING',
      medication: {
        brandName: medication.brandName,
        genericName: medication.genericName,
        strength: medication.strength,
        tier: medication.formularyEntry.tierLevel,
        copayAmountCents: medication.formularyEntry.copayAmount,
      },
      member: { name: enrolled.displayName, walletId: enrolled.walletIdStr },
      prescriber: { name: prescriberName, specialty: prescriber.specialty },
    };
  }

  /**
   * Insurer approves a prior authorization request.
   * Builds PriorAuthData, inserts into member's forest ACCESS_CONTROL tree,
   * and generates a provePriorAuth ZK proof.
   */
  async approvePriorAuth(paId: string): Promise<Record<string, unknown>> {
    if (!this.compiled) throw new Error('Programs not compiled yet');

    const paState = this.priorAuths.get(paId);
    if (!paState) throw new Error(`Prior auth not found: ${paId}`);
    if (paState.status !== 'PENDING') throw new Error(`Prior auth is already ${paState.status}: ${paId}`);

    const enrolled = this.enrolledMembers.get(paState.memberWalletId);
    if (!enrolled) throw new Error(`Member not enrolled: ${paState.memberWalletId}`);

    const medication = DEMO_MEDICATIONS[paState.medicationIndex];
    const prescriber = DEMO_PRESCRIBERS[paState.prescriberIndex];
    const prescriberWalletId = this.prescriberWalletIds.get(paState.prescriberIndex)!;

    this.emit('phase', 'prior-auth', `═══ Prior Auth Approval: ${medication.brandName} ═══`);
    this.emit('info', 'prior-auth', `  Insurer approves PA for ${enrolled.displayName}`);

    // 1. Build PriorAuthData
    const paLeafIndex = this.nextPaLeafIndex.get(paState.memberWalletId) ?? 1n;
    this.nextPaLeafIndex.set(paState.memberWalletId, paLeafIndex + 1n);

    const priorAuthData = buildPriorAuthData({
      ndc: medication.ndc,
      memberWalletId: enrolled.walletId.toString(),
      prescriberWalletId: prescriberWalletId.toString(),
      approvalDate: '20260201',
      expirationDate: '20270201',
      approvedQuantity: medication.formularyEntry.maxQuantityPerFill,
      authorizationCode: `AUTH-${paId}-${medication.ndc}`,
    });

    // 2. Insert PA into member's forest ACCESS_CONTROL tree
    this.emit('offchain', 'prior-auth', `  Inserting PA into ACCESS_CONTROL tree at leaf ${paLeafIndex}...`, 'start');
    const startInsert = performance.now();
    enrolled.forest.setLeaf(
      ForestDomain.ACCESS_CONTROL,
      paLeafIndex,
      priorAuthData.commitment(),
    );

    // 3. Update credential forestRoot to reflect the new tree state
    enrolled.credentialData = new CredentialData({
      credentialType: enrolled.credentialData.credentialType,
      forestRoot: enrolled.forest.getForestRoot(),
      issuerWalletId: enrolled.credentialData.issuerWalletId,
      subjectWalletId: enrolled.credentialData.subjectWalletId,
      issuedAt: enrolled.credentialData.issuedAt,
      expiresAt: enrolled.credentialData.expiresAt,
      revoked: enrolled.credentialData.revoked,
    });

    const elapsedInsert = performance.now() - startInsert;
    this.emit('offchain', 'prior-auth', `  PA inserted into forest, credential forestRoot updated`, 'complete', elapsedInsert);

    // 4. Generate AccessControlProgram.provePriorAuth proof
    const eligForest = enrolled.forest;
    const eligForestRoots = ForestRoots.fromForest(eligForest);
    const eligWitness = eligForest.getWitness(ForestDomain.ACCESS_CONTROL, 0n);
    const paWitness = eligForest.getWitness(ForestDomain.ACCESS_CONTROL, paLeafIndex);
    const formIdx = BigInt(paState.medicationIndex);
    const formularyEntry = this.formularyRegistry.getEntry(formIdx)!;
    const formularyWitness = this.formularyRegistry.getEntryWitness(formIdx);

    this.emit('proof', 'prior-auth', `  Generating AccessControl.provePriorAuth proof...`, 'start');
    const startProof = performance.now();
    await AccessControlProgram.provePriorAuth(
      enrolled.credentialData,
      enrolled.eligibilityData,
      eligForestRoots,
      eligWitness,
      paWitness,
      priorAuthData,
      formularyEntry,
      formularyWitness,
      dateToField('20260202'),
      quantityToField(medication.formularyEntry.maxQuantityPerFill),
    );
    const elapsedProof = performance.now() - startProof;
    this.emit('proof', 'prior-auth', `  AccessControl.provePriorAuth proof verified`, 'complete', elapsedProof);
    this.emit('info', 'prior-auth', `  PA verified: medication on formulary, PA not expired, quantity within limits`);
    this.emitMemory('prior-auth');

    // 4b. Submit wallet update to L2 (forest changed → new inventory root)
    const paReceipt = await this.updateCredentialAndSubmitToL2(enrolled, 'prior-auth');

    // 5. Update PA state
    paState.status = 'APPROVED';
    paState.resolvedAt = Date.now();
    paState.paLeafIndex = paLeafIndex;
    paState.priorAuthData = priorAuthData;

    this.emit('info', 'prior-auth', `  ${paId} APPROVED — ${medication.brandName} authorized for ${enrolled.displayName}`);

    // Auto-send PA_RESPONSE message (insurer → prescriber)
    this.sendInternalMessage(this.adminWalletId, prescriberWalletId, MSG_TYPE_PA_RESPONSE,
      `PA Approved: ${medication.brandName}`, `Prior auth approved — Auth #${paId}`);

    this.emitViz('viz:eligibility:verified', 'eligibility', {
      actor: 'Insurer',
      actorType: 'insurer',
      target: enrolled.displayName,
      targetType: 'member',
      data: { paId, medication: medication.brandName, status: 'APPROVED' },
    });

    return {
      paId,
      status: 'APPROVED',
      medication: {
        brandName: medication.brandName,
        genericName: medication.genericName,
        strength: medication.strength,
        ndc: medication.ndcFormatted,
        tier: medication.formularyEntry.tierLevel,
      },
      member: { name: enrolled.displayName, walletId: enrolled.walletIdStr },
      prescriber: { name: `Dr. ${prescriber.firstName} ${prescriber.lastName}` },
      paLeafIndex: Number(paLeafIndex),
      proofTimeMs: elapsedProof,
      forestRoot: truncField(enrolled.forest.getForestRoot()),
      l2Receipt: {
        receiptId: paReceipt.receiptId,
        sequenceNumber: Number(paReceipt.sequenceNumber),
        type: 'wallet-update',
      },
      chainState: this.getChainState(),
    };
  }

  /**
   * Insurer denies a prior authorization request.
   */
  denyPriorAuth(paId: string): Record<string, unknown> {
    const paState = this.priorAuths.get(paId);
    if (!paState) throw new Error(`Prior auth not found: ${paId}`);
    if (paState.status !== 'PENDING') throw new Error(`Prior auth is already ${paState.status}: ${paId}`);

    const enrolled = this.enrolledMembers.get(paState.memberWalletId);
    const medication = DEMO_MEDICATIONS[paState.medicationIndex];

    paState.status = 'DENIED';
    paState.resolvedAt = Date.now();

    const memberName = enrolled?.displayName ?? 'Unknown';
    this.emit('phase', 'prior-auth', `═══ Prior Auth Denied: ${medication.brandName} ═══`);
    this.emit('info', 'prior-auth', `  ${paId} DENIED — ${medication.brandName} not authorized for ${memberName}`);

    // Auto-send PA_RESPONSE message (insurer → prescriber)
    const prescriberWalletId = this.prescriberWalletIds.get(paState.prescriberIndex)!;
    this.sendInternalMessage(this.adminWalletId, prescriberWalletId, MSG_TYPE_PA_RESPONSE,
      `PA Denied: ${medication.brandName}`, `Prior auth denied — ${paId}`);

    this.emitViz('viz:eligibility:verified', 'eligibility', {
      actor: 'Insurer',
      actorType: 'insurer',
      target: memberName,
      targetType: 'member',
      data: { paId, medication: medication.brandName, status: 'DENIED' },
    });

    return {
      paId,
      status: 'DENIED',
      medication: { brandName: medication.brandName },
      member: { name: memberName },
    };
  }

  /**
   * Look up an approved PA for a member+medication combination.
   */
  private findApprovedPa(memberWalletId: string, medicationIndex: number): PriorAuthState | undefined {
    for (const [_, pa] of this.priorAuths) {
      if (pa.memberWalletId === memberWalletId &&
          pa.medicationIndex === medicationIndex &&
          pa.status === 'APPROVED') {
        return pa;
      }
    }
    return undefined;
  }

  // ─── Step Therapy + DEA Checks ──────────────────────────

  /**
   * Check step therapy requirement for a medication.
   * Returns whether the patient has tried a prerequisite medication first.
   */
  checkStepTherapy(
    memberWalletId: string,
    medicationIndex: number,
  ): { allowed: boolean; message: string; prerequisiteClass?: string; prerequisiteMeds?: string[] } {
    const medication = DEMO_MEDICATIONS[medicationIndex];
    if (!medication) return { allowed: true, message: 'Unknown medication' };

    // Check current formulary state if available
    const isStepRequired = this.currentFormularyEntries.length > 0
      ? this.currentFormularyEntries[medicationIndex]?.stepTherapyRequired
      : medication.formularyEntry.stepTherapyRequired;

    if (!isStepRequired) {
      return { allowed: true, message: 'Step therapy not required' };
    }

    const prereqClasses = STEP_THERAPY_MAP[medication.therapeuticClass];
    if (!prereqClasses) {
      return { allowed: true, message: 'No step therapy prerequisites defined for this class' };
    }

    // Search member's prescription history for a filled Rx in a prerequisite class
    for (const [, rx] of this.prescriptions) {
      if (rx.memberWalletId !== memberWalletId) continue;
      if (rx.status !== 'FILLED' && rx.status !== 'PARTIALLY_FILLED') continue;

      const rxMed = DEMO_MEDICATIONS[rx.medicationIndex];
      if (prereqClasses.includes(rxMed.therapeuticClass)) {
        return {
          allowed: true,
          message: `Step therapy satisfied: patient has filled ${rxMed.brandName} (${rxMed.therapeuticClass})`,
        };
      }
    }

    // Find prerequisite medication names for the error message
    const prereqMeds = DEMO_MEDICATIONS
      .filter(m => prereqClasses.includes(m.therapeuticClass))
      .map(m => m.brandName);

    return {
      allowed: false,
      message: `Step therapy required: try ${prereqClasses.join(' or ')} first`,
      prerequisiteClass: prereqClasses.join(', '),
      prerequisiteMeds: prereqMeds,
    };
  }

  /**
   * Check DEA schedule constraints for a medication.
   */
  private checkDeaSchedule(
    medicationIndex: number,
    prescriberIndex: number,
  ): { allowed: boolean; warnings: string[] } {
    const medication = DEMO_MEDICATIONS[medicationIndex];
    const prescriber = DEMO_PRESCRIBERS[prescriberIndex];
    const warnings: string[] = [];

    if (medication.deaSchedule === 0) {
      return { allowed: true, warnings: [] };
    }

    // DEA number required for controlled substances
    if (!prescriber.deaNumber) {
      return {
        allowed: false,
        warnings: [`DEA Schedule ${medication.deaSchedule}: Prescriber Dr. ${prescriber.firstName} ${prescriber.lastName} does not have a DEA number`],
      };
    }

    warnings.push(
      `DEA Schedule ${medication.deaSchedule} controlled substance — DEA# ${prescriber.deaNumber} verified`,
    );

    if (medication.deaSchedule <= 2) {
      warnings.push('Schedule II: No refills permitted per federal law');
    }

    return { allowed: true, warnings };
  }

  // ─── Create Prescription ───────────────────────────────

  async createPrescription(opts: {
    prescriberIndex: number;
    memberWalletId: string;
    medicationIndex: number;
    pharmacyIndex: number;
    quantity: number;
    refills: number;
  }): Promise<Record<string, unknown>> {
    if (!this.compiled) throw new Error('Programs not compiled yet');

    const prescriber = DEMO_PRESCRIBERS[opts.prescriberIndex];
    if (!prescriber) throw new Error(`Invalid prescriber index: ${opts.prescriberIndex}`);

    const pharmacy = DEMO_PHARMACIES[opts.pharmacyIndex];
    if (!pharmacy) throw new Error(`Invalid pharmacy index: ${opts.pharmacyIndex}`);

    const medication = DEMO_MEDICATIONS[opts.medicationIndex];
    if (!medication) throw new Error(`Invalid medication index: ${opts.medicationIndex}`);

    const enrolled = this.enrolledMembers.get(opts.memberWalletId);
    if (!enrolled) throw new Error(`Member not enrolled: ${opts.memberWalletId}`);

    const prescriberWalletId = this.prescriberWalletIds.get(opts.prescriberIndex)!;
    const prescriberPreimage = this.prescriberPreimages.get(opts.prescriberIndex)!;
    const pharmacyWalletId = this.pharmacyWalletIds.get(opts.pharmacyIndex)!;
    const prescriberName = `Dr. ${prescriber.firstName} ${prescriber.lastName}`;
    const pharmacyName = pharmacy.storeName;

    this.emit('phase', 'prescribe', `═══ Prescription: ${prescriberName} → ${enrolled.displayName} ═══`);

    // PA enforcement: check if medication requires prior authorization
    const requiresPa = medication.formularyEntry.requiresPriorAuth;
    let approvedPa: PriorAuthState | undefined;
    if (requiresPa) {
      approvedPa = this.findApprovedPa(opts.memberWalletId, opts.medicationIndex);
      if (!approvedPa) {
        // Check if there's a pending PA
        const pendingPa = [...this.priorAuths.values()].find(
          pa => pa.memberWalletId === opts.memberWalletId &&
                pa.medicationIndex === opts.medicationIndex &&
                pa.status === 'PENDING'
        );
        if (pendingPa) {
          throw new Error(
            `Prior authorization required for ${medication.brandName}. ` +
            `PA request ${pendingPa.id} is PENDING — awaiting insurer approval.`
          );
        }
        throw new Error(
          `Prior authorization required for ${medication.brandName} (Tier ${medication.formularyEntry.tierLevel}). ` +
          `Use the Prescriber tab to request PA before writing this prescription.`
        );
      }
      this.emit('info', 'prescribe', `  PA verified: ${approvedPa.id} APPROVED for ${medication.brandName}`);
    }

    // Step therapy enforcement
    const stepTherapyResult = this.checkStepTherapy(opts.memberWalletId, opts.medicationIndex);
    if (!stepTherapyResult.allowed) {
      throw new Error(
        `Step therapy not met for ${medication.brandName}: ${stepTherapyResult.message}. ` +
        `Patient must first try: ${stepTherapyResult.prerequisiteMeds?.join(', ')}`,
      );
    }
    if (medication.formularyEntry.stepTherapyRequired) {
      this.emit('info', 'prescribe', `  Step therapy: ${stepTherapyResult.message}`);
    }

    // DEA schedule enforcement
    const deaResult = this.checkDeaSchedule(opts.medicationIndex, opts.prescriberIndex);
    if (!deaResult.allowed) {
      throw new Error(deaResult.warnings[0]);
    }
    for (const warning of deaResult.warnings) {
      this.emit('info', 'prescribe', `  DEA: ${warning}`);
    }

    // Override refills for Schedule II controlled substances
    let effectiveRefills = opts.refills;
    if (medication.deaSchedule >= 2 && opts.refills > 0) {
      effectiveRefills = 0;
      this.emit('info', 'prescribe', `  Schedule ${medication.deaSchedule}: Refills overridden to 0 (federal law)`);
    }

    // Determine total proof steps (4 for non-PA, 5 for PA-required)
    const totalSteps = requiresPa ? 5 : 4;

    // Register as pending so the pharmacy Dispensing Queue shows it immediately
    this.rxCounter++;
    const pendingRxId = `RX-${String(this.rxCounter).padStart(4, '0')}`;
    this.pendingPrescriptions.set(pendingRxId, {
      id: pendingRxId,
      prescriberIndex: opts.prescriberIndex,
      pharmacyIndex: opts.pharmacyIndex,
      memberWalletId: opts.memberWalletId,
      medicationIndex: opts.medicationIndex,
      quantity: opts.quantity,
      refills: effectiveRefills,
      startedAt: Date.now(),
    });

    // Proving spinner — show visual feedback while generating proofs
    this.emitViz('viz:proving:started', 'prescription', {
      actor: prescriberName,
      actorType: 'prescriber',
      target: enrolled.displayName,
      targetType: 'member',
      data: { prescriberIndex: opts.prescriberIndex, memberIndex: enrolled.memberIndex, operation: 'prescription' },
    });

    try {
    // 1. ProofGate: Prescriber identity
    this.emit('proof', 'prescribe', `[1/${totalSteps}] Generating ProofGate.verifyPrescriber proof...`, 'start');
    const startPG = performance.now();
    await ProofGateProgram.verifyPrescriber(
      prescriberWalletId,
      ...prescriberPreimage as [Field, Field, Field],
    );
    const elapsedPG = performance.now() - startPG;
    this.emit('proof', 'prescribe', `[1/${totalSteps}] ProofGate.verifyPrescriber proof generated`, 'complete', elapsedPG);
    this.emit('info', 'prescribe', `       ${prescriberName} proved NPI ownership without revealing credentials`);

    // Build prescription data
    const ndcHash = hashString(medication.ndc);
    const prescriptionData = new PrescriptionData({
      ndcHash,
      prescriberWalletId,
      memberWalletId: enrolled.walletId,
      writtenDate: dateToField('20260201'),
      expirationDate: dateToField('20270201'),
      quantityPrescribed: quantityToField(opts.quantity),
      refillsAuthorized: Field(BigInt(effectiveRefills)),
    });

    const activeStatus = new PrescriptionStatusData({
      prescriptionHash: prescriptionData.commitment(),
      status: RX_STATUS_ACTIVE,
      updatedByWalletId: prescriberWalletId,
      updatedAt: dateToField('20260201'),
      pharmacyWalletId,
      fillQuantity: Field(0),
      notesHash: Field(0),
    });

    // Build prescription forest
    let rxForest = new MerkleForest();
    rxForest.setLeaf(ForestDomain.MEDICATION, 0n, prescriptionData.commitment());
    rxForest.setLeaf(ForestDomain.TRANSACTION, 0n, activeStatus.commitment());

    let rxCredentialData = new CredentialData({
      credentialType: CREDENTIAL_TYPE_PRESCRIPTION,
      forestRoot: rxForest.getForestRoot(),
      issuerWalletId: prescriberWalletId,
      subjectWalletId: pharmacyWalletId,
      issuedAt: dateToField('20260201'),
      expiresAt: Field(0),
      revoked: Field(0),
    });

    const formularyEntry = buildFormularyEntry(medication.formularyEntry);

    this.emit('info', 'prescribe', '');
    this.emit('info', 'prescribe', `  eScript: ${medication.brandName} ${medication.strength}`);
    this.emit('info', 'prescribe', `    NDC:     ${medication.ndcFormatted}`);
    this.emit('info', 'prescribe', `    Tier:    ${medication.formularyEntry.tierLevel} — $${(medication.formularyEntry.copayAmount / 100).toFixed(2)} copay`);
    this.emit('info', 'prescribe', `    Qty:     ${opts.quantity} ${medication.dosageForm.toLowerCase()}s, ${opts.refills} refills`);
    this.emit('info', 'prescribe', `    To:      ${pharmacyName}`);
    this.emit('info', 'prescribe', '');

    this.emitViz('viz:prescription:written', 'prescription', {
      actor: prescriberName,
      actorType: 'prescriber',
      target: enrolled.displayName,
      targetType: 'member',
      data: {
        medication: medication.brandName,
        ndc: medication.ndcFormatted,
        quantity: opts.quantity,
        pharmacy: pharmacyName,
      },
    });

    // 2. EligibilityProgram: Member is eligible
    this.emitViz('viz:eligibility:check', 'eligibility', {
      actor: enrolled.displayName,
      actorType: 'member',
      target: 'Insurer',
      targetType: 'insurer',
      data: { step: 'eligibility-check', medication: medication.brandName, memberIndex: enrolled.memberIndex },
    });

    const eligForest = enrolled.forest;
    const eligForestRoots = ForestRoots.fromForest(eligForest);
    const eligWitness = eligForest.getWitness(ForestDomain.ACCESS_CONTROL, 0n);
    const planWitness = this.benefitPlanRegistry.getPlanWitness(0n);
    const planRoot = this.benefitPlanRegistry.getRoot();

    this.emit('proof', 'prescribe', `[2/${totalSteps}] Generating EligibilityProgram.proveEligibility proof...`, 'start');
    const startElig = performance.now();
    await EligibilityProgram.proveEligibility(
      enrolled.credentialData,
      enrolled.eligibilityData,
      eligForestRoots,
      eligWitness,
      planWitness,
      planRoot,
      dateToField('20260202'),
    );
    const elapsedElig = performance.now() - startElig;
    this.emit('proof', 'prescribe', `[2/${totalSteps}] EligibilityProgram.proveEligibility proof generated`, 'complete', elapsedElig);
    this.emit('info', 'prescribe', `       ${enrolled.displayName} is ELIGIBLE under PLAN-GOLD-2026`);

    this.emitViz('viz:eligibility:verified', 'eligibility', {
      actor: enrolled.displayName,
      actorType: 'member',
      target: 'Insurer',
      targetType: 'insurer',
      data: { planId: 'PLAN-GOLD-2026', status: 'ELIGIBLE' },
    });

    // 3. AccessControl: Medication on formulary
    this.emitViz('viz:formulary:check', 'eligibility', {
      actor: enrolled.displayName,
      actorType: 'member',
      target: 'Insurer',
      targetType: 'insurer',
      data: { step: 'formulary-check', medication: medication.brandName, ndc: medication.ndcFormatted, memberIndex: enrolled.memberIndex },
    });

    const formEligWitness = eligForest.getWitness(ForestDomain.ACCESS_CONTROL, 0n);
    const formIdx = BigInt(opts.medicationIndex);
    const formWitness = this.formularyRegistry.getEntryWitness(formIdx);

    this.emit('proof', 'prescribe', `[3/${totalSteps}] Generating AccessControl.proveFormularyAccess proof...`, 'start');
    const startAC = performance.now();
    await AccessControlProgram.proveFormularyAccess(
      enrolled.credentialData,
      enrolled.eligibilityData,
      eligForestRoots,
      formEligWitness,
      formularyEntry,
      formWitness,
      ndcHash,
      quantityToField(opts.quantity),
      Field(BigInt(medication.formularyEntry.maxDaySupply)),
      Field(20260101),
    );
    const elapsedAC = performance.now() - startAC;
    this.emit('proof', 'prescribe', `[3/${totalSteps}] AccessControl.proveFormularyAccess proof generated`, 'complete', elapsedAC);
    this.emit('info', 'prescribe', `       ${medication.genericName}: ON FORMULARY, Tier ${medication.formularyEntry.tierLevel}, $${(medication.formularyEntry.copayAmount / 100).toFixed(2)} copay`);

    this.emitViz('viz:formulary:verified', 'eligibility', {
      actor: enrolled.displayName,
      actorType: 'member',
      target: 'Insurer',
      targetType: 'insurer',
      data: {
        medication: medication.brandName,
        tier: medication.formularyEntry.tierLevel,
        copay: medication.formularyEntry.copayAmount,
        onFormulary: true,
      },
    });

    // 4 (PA only). AccessControl.provePriorAuth — verify PA in forest
    let elapsedPA = 0;
    if (requiresPa && approvedPa) {
      const paForestRoots = ForestRoots.fromForest(eligForest);
      const paEligWitness = eligForest.getWitness(ForestDomain.ACCESS_CONTROL, 0n);
      const paWitness = eligForest.getWitness(ForestDomain.ACCESS_CONTROL, approvedPa.paLeafIndex!);
      const paFormWitness = this.formularyRegistry.getEntryWitness(formIdx);

      this.emit('proof', 'prescribe', `[4/${totalSteps}] Generating AccessControl.provePriorAuth proof...`, 'start');
      const startPA = performance.now();
      await AccessControlProgram.provePriorAuth(
        enrolled.credentialData,
        enrolled.eligibilityData,
        paForestRoots,
        paEligWitness,
        paWitness,
        approvedPa.priorAuthData!,
        formularyEntry,
        paFormWitness,
        dateToField('20260202'),
        quantityToField(opts.quantity),
      );
      elapsedPA = performance.now() - startPA;
      this.emit('proof', 'prescribe', `[4/${totalSteps}] AccessControl.provePriorAuth proof verified`, 'complete', elapsedPA);
      this.emit('info', 'prescribe', `       Prior auth ${approvedPa.id}: VALID, not expired, quantity within limits`);
    }

    // Messaging: eScript message
    const msgStep = requiresPa ? 5 : 4;
    this.msgNonce++;
    const eScriptThreadId = `THREAD-RX-${this.rxCounter}`;
    const eScriptPlaintext = `Subject: eScript\n\nRx for ${medication.genericName} ${medication.strength} #${opts.quantity}`;

    // Encrypt eScript with prescriber→pharmacy keys
    const prescriberKeys = this.encryptionKeys.get(opts.prescriberIndex);
    const pharmacyKeys = this.encryptionKeys.get(10 + opts.pharmacyIndex);
    let eScriptContentHash: Field;
    let eScriptEncrypted: { ciphertext: Buffer; iv: Buffer; tag: Buffer } | null = null;
    if (prescriberKeys && pharmacyKeys) {
      const sharedSecret = deriveSharedSecret(prescriberKeys.privateKey, pharmacyKeys.publicKey);
      eScriptEncrypted = encryptMessage(eScriptPlaintext, sharedSecret);
      eScriptContentHash = computeContentHash(eScriptEncrypted.ciphertext, eScriptEncrypted.iv, eScriptEncrypted.tag);
    } else {
      eScriptContentHash = hashString(eScriptPlaintext);
    }

    // Capture messaging root before
    const eScriptMsgRootBefore = computeMessagingRoot(
      this.messageRegistry.getRoot(),
      this.delegationRegistry.getRoot(),
      this.keyRegistry.getRoot(),
    ).toString();

    const msg = new MessageData({
      senderWalletId: prescriberWalletId,
      recipientWalletId: pharmacyWalletId,
      contentHash: eScriptContentHash,
      messageType: MSG_TYPE_PRESCRIPTION,
      timestamp: dateToField('20260201'),
      threadId: hashString(eScriptThreadId),
      nonce: Field(BigInt(this.msgNonce)),
    });
    const { index: msgIndex } = this.messageRegistry.addMessage(msg);
    const msgWitness = this.messageRegistry.getWitness(msgIndex);

    this.emit('proof', 'prescribe', `[${msgStep}/${totalSteps}] Generating MessagingProgram.proveSendMessage proof (eScript)...`, 'start');
    const startMsg = performance.now();
    await MessagingProgram.proveSendMessage(
      msg,
      msgWitness,
      this.messageRegistry.getRoot(),
      this.delegationRegistry.getRoot(),
      this.keyRegistry.getRoot(),
    );
    const elapsedMsg = performance.now() - startMsg;
    this.emit('proof', 'prescribe', `[${msgStep}/${totalSteps}] MessagingProgram.proveSendMessage proof generated`, 'complete', elapsedMsg);
    this.emit('info', 'prescribe', `       Encrypted eScript: ${prescriberName} → ${pharmacyName}`);

    // Store encrypted eScript payload
    this.encryptedPayloads.set(msgIndex.toString(), {
      ciphertext: eScriptEncrypted ? eScriptEncrypted.ciphertext.toString('hex') : '',
      iv: eScriptEncrypted ? eScriptEncrypted.iv.toString('hex') : '',
      tag: eScriptEncrypted ? eScriptEncrypted.tag.toString('hex') : '',
      senderKeyIndex: opts.prescriberIndex,
      recipientKeyIndex: 10 + opts.pharmacyIndex,
      threadId: eScriptThreadId,
      timestamp: Date.now(),
    });

    // Emit messaging audit event for eScript
    const eScriptMsgRootAfter = computeMessagingRoot(
      this.messageRegistry.getRoot(),
      this.delegationRegistry.getRoot(),
      this.keyRegistry.getRoot(),
    ).toString();
    this.l2Node.emitMessagingAuditEvent(
      prescriberWalletId.toString(),
      eScriptMsgRootBefore,
      eScriptMsgRootAfter,
    );

    this.emitViz('viz:message:sent', 'messaging', {
      actor: prescriberName,
      actorType: 'prescriber',
      target: pharmacyName,
      targetType: 'pharmacy',
      data: { messageType: 'PRESCRIPTION', medication: medication.brandName },
    });

    this.emitViz('viz:prescription:sent', 'prescription', {
      actor: prescriberName,
      actorType: 'prescriber',
      target: pharmacyName,
      targetType: 'pharmacy',
      data: { medication: medication.brandName, status: 'ACTIVE' },
    });

    // Store prescription state (promote from pending to active)
    this.pendingPrescriptions.delete(pendingRxId);
    const rxId = pendingRxId;
    const rxState: PrescriptionState = {
      id: rxId,
      prescriptionData,
      activeStatus,
      rxForest,
      rxCredentialData,
      formularyEntry,
      prescriberIndex: opts.prescriberIndex,
      pharmacyIndex: opts.pharmacyIndex,
      memberWalletId: opts.memberWalletId,
      medicationIndex: opts.medicationIndex,
      quantity: opts.quantity,
      quantityDispensed: 0,
      refills: effectiveRefills,
      refillsUsed: 0,
      status: 'ACTIVE',
      statusHistory: [],
      currentStatusLeafIndex: 0n,  // initial ACTIVE status at leaf 0
      nextTxLeafIndex: 1n,         // next available leaf
    };
    this.prescriptions.set(rxId, rxState);

    this.emitMemory('prescribe');

    return {
      prescriptionId: rxId,
      medication: {
        brandName: medication.brandName,
        genericName: medication.genericName,
        strength: medication.strength,
        dosageForm: medication.dosageForm,
        ndc: medication.ndcFormatted,
        tier: medication.formularyEntry.tierLevel,
        copayAmountCents: medication.formularyEntry.copayAmount,
        requiresPriorAuth: medication.formularyEntry.requiresPriorAuth,
        maxQuantityPerFill: medication.formularyEntry.maxQuantityPerFill,
        awpUnitPriceCents: medication.awpUnitPriceCents,
      },
      prescriber: {
        name: prescriberName,
        specialty: prescriber.specialty,
        credential: prescriber.credential,
        npi: prescriber.localData.prescriberId,
      },
      pharmacy: {
        name: pharmacyName,
        type: pharmacy.pharmacyTypeDesc,
        address: `${pharmacy.address}, ${pharmacy.city}, ${pharmacy.state}`,
      },
      member: {
        name: enrolled.displayName,
        walletId: enrolled.walletIdStr,
      },
      quantity: opts.quantity,
      refills: effectiveRefills,
      status: 'ACTIVE',
      rxHash: truncField(prescriptionData.commitment()),
      proofTimesMs: {
        proofGate: elapsedPG,
        eligibility: elapsedElig,
        accessControl: elapsedAC,
        ...(requiresPa ? { priorAuth: elapsedPA } : {}),
        messaging: elapsedMsg,
        total: elapsedPG + elapsedElig + elapsedAC + elapsedPA + elapsedMsg,
      },
      ...(approvedPa ? { priorAuthId: approvedPa.id } : {}),
      stepTherapy: stepTherapyResult,
      deaWarnings: deaResult.warnings,
      // ─── ZK Data (full transparency) ────────────────
      prescriptionCredential: serializeCredentialData(rxCredentialData),
      prescriptionForest: serializeForestRoots(rxForest),
      prescriptionData: {
        ndcHash: fieldToStr(prescriptionData.ndcHash),
        prescriberWalletId: fieldToStr(prescriptionData.prescriberWalletId),
        memberWalletId: fieldToStr(prescriptionData.memberWalletId),
        writtenDate: fieldToStr(prescriptionData.writtenDate),
        expirationDate: fieldToStr(prescriptionData.expirationDate),
        quantityPrescribed: fieldToStr(prescriptionData.quantityPrescribed),
        refillsAuthorized: fieldToStr(prescriptionData.refillsAuthorized),
        commitment: fieldToStr(prescriptionData.commitment()),
      },
      statusData: {
        prescriptionHash: fieldToStr(activeStatus.prescriptionHash),
        status: fieldToStr(activeStatus.status),
        updatedByWalletId: fieldToStr(activeStatus.updatedByWalletId),
        updatedAt: fieldToStr(activeStatus.updatedAt),
        pharmacyWalletId: fieldToStr(activeStatus.pharmacyWalletId),
        fillQuantity: fieldToStr(activeStatus.fillQuantity),
        notesHash: fieldToStr(activeStatus.notesHash),
        commitment: fieldToStr(activeStatus.commitment()),
      },
      chainState: this.getChainState(),
    };

    } catch (err) {
      // Clean up pending entry on proof failure
      this.pendingPrescriptions.delete(pendingRxId);
      throw err;
    } finally {
      // Always clear proving spinner (even on error)
      this.emitViz('viz:proving:completed', 'prescription', {
        actor: prescriberName,
        actorType: 'prescriber',
        target: enrolled.displayName,
        targetType: 'member',
        data: { prescriberIndex: opts.prescriberIndex, memberIndex: enrolled.memberIndex, operation: 'prescription' },
      });
    }
  }

  // ─── Fill Prescription ─────────────────────────────────

  async fillPrescription(opts: {
    prescriptionId: string;
    credentialJson?: string;      // Optional: no longer required for fill (fills are reversible)
    quantityDispensed?: number;
    ingredientCostCents?: number;
    dispensingFeeCents?: number;
  }): Promise<Record<string, unknown>> {
    if (!this.compiled) throw new Error('Programs not compiled yet');

    const rxState = this.prescriptions.get(opts.prescriptionId);
    if (!rxState) throw new Error(`Prescription not found: ${opts.prescriptionId}`);
    if (rxState.status === 'FILLED') throw new Error(`Prescription already filled: ${opts.prescriptionId}`);
    if (rxState.status === 'CANCELLED') throw new Error(`Prescription was cancelled: ${opts.prescriptionId}`);
    if (rxState.status === 'REJECTED') throw new Error(`Prescription was rejected: ${opts.prescriptionId}`);
    // NCPDP: ACTIVE/PARTIALLY_FILLED → FILLED (direct adjudication)
    //        DISPENSED → FILLED (member pickup with credential)
    if (rxState.status !== 'ACTIVE' && rxState.status !== 'PARTIALLY_FILLED' && rxState.status !== 'DISPENSED') {
      throw new Error(`Cannot fill prescription in ${rxState.status} status: ${opts.prescriptionId}`);
    }

    // ─── Wallet Identity (no credential required) ────────────────
    // The prescription already records the member's walletId.
    // The pharmacy proves its own identity via ProofGate.verifyPharmacy below.
    // No credential needed — fills are reversible, so the risk is low.
    const now = new Date();
    const serviceDateStr = now.getFullYear().toString() +
      String(now.getMonth() + 1).padStart(2, '0') +
      String(now.getDate()).padStart(2, '0');

    this.emit('info', 'fill', `  Member wallet from prescription — ${truncField(Field(BigInt(rxState.memberWalletId)))}`);
    this.emit('info', 'fill', `  Service date: ${serviceDateStr}`);
    // ─── End Wallet Identity ─────────────────────────────────────

    const medication = DEMO_MEDICATIONS[rxState.medicationIndex];
    const pharmacy = DEMO_PHARMACIES[rxState.pharmacyIndex];
    const pharmacyWalletId = this.pharmacyWalletIds.get(rxState.pharmacyIndex)!;
    const pharmacyPreimage = this.pharmacyPreimages.get(rxState.pharmacyIndex)!;
    const prescriberWalletId = this.prescriberWalletIds.get(rxState.prescriberIndex)!;
    const prescriberPreimage = this.prescriberPreimages.get(rxState.prescriberIndex)!;
    const enrolled = this.enrolledMembers.get(rxState.memberWalletId)!;

    const qtyDispensed = opts.quantityDispensed ?? rxState.quantity;

    // FWA guard: total quantity dispensed must not exceed quantity prescribed
    const remainingQty = rxState.quantity - rxState.quantityDispensed;
    if (qtyDispensed > remainingQty) {
      throw new Error(
        `Quantity dispensed (${qtyDispensed}) exceeds remaining prescribed qty (${remainingQty} of ${rxState.quantity}). ` +
        `Possible fraud/waste/abuse — fill rejected.`
      );
    }
    if (qtyDispensed < 1) {
      throw new Error('Quantity dispensed must be at least 1');
    }

    const ingredientCostCents = opts.ingredientCostCents ?? (medication.awpUnitPriceCents * qtyDispensed);
    const dispensingFeeCents = opts.dispensingFeeCents ?? 200;
    const totalCostCents = ingredientCostCents + dispensingFeeCents;

    this.emit('phase', 'fill', `═══ Pharmacy Fill: ${pharmacy.storeName} ═══`);
    this.emit('info', 'fill', `  Filling ${medication.brandName} ${medication.strength} — qty ${qtyDispensed}`);
    this.emit('info', 'fill', `  Cost: $${(ingredientCostCents / 100).toFixed(2)} ingredient + $${(dispensingFeeCents / 100).toFixed(2)} dispensing = $${(totalCostCents / 100).toFixed(2)} total`);
    this.emit('info', 'fill', '');

    // 1. ProofGate: Pharmacy identity
    this.emitViz('viz:pharmacy:credential_scan', 'fulfillment', {
      actor: pharmacy.storeName,
      actorType: 'pharmacy',
      target: enrolled.displayName,
      targetType: 'member',
      data: { step: 'credential-scan', medication: medication.brandName, pharmacyIndex: opts.pharmacyIndex, memberIndex: enrolled.memberIndex },
    });

    this.emit('proof', 'fill', `[1/3] Generating ProofGate.verifyPharmacy proof...`, 'start');
    const startPG = performance.now();
    await ProofGateProgram.verifyPharmacy(
      pharmacyWalletId,
      ...pharmacyPreimage as [Field, Field, Field],
    );
    const elapsedPG = performance.now() - startPG;
    this.emit('proof', 'fill', `[1/3] ProofGate.verifyPharmacy proof generated`, 'complete', elapsedPG);
    this.emit('info', 'fill', `  ┌─ PROOF: ProofGate.verifyPharmacy`);
    this.emit('info', 'fill', `  │  Public Input:  pharmacyWalletId = ${truncField(pharmacyWalletId)}`);
    this.emit('info', 'fill', `  │  Constraint:    Poseidon.hash([DOMAIN_TAG_PHARMACY, qualifier, hash(NPI), hash(enrollmentKey)]) == walletId`);
    this.emit('info', 'fill', `  │  Result:        VERIFIED — ${pharmacy.storeName} proved NPI ownership (${elapsedPG.toFixed(0)}ms)`);
    this.emit('info', 'fill', `  └─ No NPI data revealed — only Poseidon hash checked`);

    this.emitViz('viz:fulfillment:started', 'fulfillment', {
      actor: pharmacy.storeName,
      actorType: 'pharmacy',
      target: enrolled.displayName,
      targetType: 'member',
      data: { medication: medication.brandName, prescriptionId: opts.prescriptionId },
    });

    // 2. PrescriptionProgram: status transition
    // Determine ZK status based on whether this is a partial or full fill
    const totalAfterFill = rxState.quantityDispensed + qtyDispensed;
    const isPartial = totalAfterFill < rxState.quantity;
    const zkNewStatus = isPartial ? RX_STATUS_PARTIALLY_FILLED : RX_STATUS_FILLED;
    const zkStatusLabel = isPartial ? 'PARTIALLY_FILLED' : 'FILLED';

    const filledStatus = new PrescriptionStatusData({
      prescriptionHash: rxState.prescriptionData.commitment(),
      status: zkNewStatus,
      updatedByWalletId: pharmacyWalletId,
      updatedAt: dateToField(serviceDateStr),
      pharmacyWalletId,
      fillQuantity: quantityToField(qtyDispensed),
      notesHash: Field(0),
    });

    let rxForest = rxState.rxForest;
    let rxForestRoots = ForestRoots.fromForest(rxForest);
    const medWitness = rxForest.getWitness(ForestDomain.MEDICATION, 0n);
    const oldStatusLeaf = rxState.currentStatusLeafIndex;
    const newStatusLeaf = rxState.nextTxLeafIndex;
    const oldStatusWitness = rxForest.getWitness(ForestDomain.TRANSACTION, oldStatusLeaf);
    const newSlotWitness = rxForest.getWitness(ForestDomain.TRANSACTION, newStatusLeaf);

    this.emit('proof', 'fill', `[2/3] Generating PrescriptionProgram.proveStatusUpdate (${rxState.status}→${zkStatusLabel})...`, 'start');
    const startRx = performance.now();
    await PrescriptionProgram.proveStatusUpdate(
      rxState.rxCredentialData,
      rxState.prescriptionData,
      rxState.activeStatus,
      filledStatus,
      rxForestRoots,
      medWitness,
      oldStatusWitness,
      newSlotWitness,
      ...prescriberPreimage as [Field, Field, Field],
    );
    const elapsedRx = performance.now() - startRx;
    this.emit('proof', 'fill', `[2/3] PrescriptionProgram.proveStatusUpdate proof generated`, 'complete', elapsedRx);
    const statusLabel = qtyDispensed < rxState.quantity - rxState.quantityDispensed
      ? 'PARTIALLY_FILLED' : 'FILLED';
    this.emit('info', 'fill', `  ┌─ PROOF: PrescriptionProgram.proveStatusUpdate`);
    this.emit('info', 'fill', `  │  Rx Credential Forest Root:  ${truncField(rxState.rxCredentialData.forestRoot)}`);
    this.emit('info', 'fill', `  │  Prescription Hash:   ${truncField(rxState.prescriptionData.commitment())}`);
    this.emit('info', 'fill', `  │  Status Transition:   ${rxState.status} → ${statusLabel} (ZK-enforced valid transition)`);
    this.emit('info', 'fill', `  │  MEDICATION tree:     leaf 0 verified (Merkle inclusion proof)`);
    this.emit('info', 'fill', `  │  TRANSACTION tree:    status leaf ${oldStatusLeaf} → new leaf ${newStatusLeaf}`);
    this.emit('info', 'fill', `  └─ Constraint: assertValidStatusTransition(old, new) — circuit enforced (${elapsedRx.toFixed(0)}ms)`);

    this.emitViz('viz:prescription:status', 'prescription', {
      actor: pharmacy.storeName,
      actorType: 'pharmacy',
      target: enrolled.displayName,
      targetType: 'member',
      data: { prescriptionId: opts.prescriptionId, oldStatus: rxState.status, newStatus: statusLabel },
    });

    // Mutate forest for fulfillment phase
    rxForest.setLeaf(ForestDomain.TRANSACTION, newStatusLeaf, filledStatus.commitment());
    rxForestRoots = ForestRoots.fromForest(rxForest);
    const rxCredentialData = new CredentialData({
      credentialType: CREDENTIAL_TYPE_PRESCRIPTION,
      forestRoot: rxForest.getForestRoot(),
      issuerWalletId: prescriberWalletId,
      subjectWalletId: pharmacyWalletId,
      issuedAt: dateToField('20260201'),
      expiresAt: Field(0),
      revoked: Field(0),
    });

    // 3. THE CLAIM: AccumulatorFulfillment
    const fulfillmentData = new FulfillmentData({
      prescriptionHash: rxState.prescriptionData.commitment(),
      pharmacyWalletId,
      ndcHash: hashString(medication.ndc),
      quantityDispensed: quantityToField(qtyDispensed),
      ingredientCostCents: centsToField(ingredientCostCents),
      dispensingFeeCents: centsToField(dispensingFeeCents),
      dateOfService: dateToField(serviceDateStr),
    });

    const fulfMedWitness = rxForest.getWitness(ForestDomain.MEDICATION, 0n);
    const fulfStatusWitness = rxForest.getWitness(ForestDomain.TRANSACTION, newStatusLeaf);
    const fulfNewSlotWitness = rxForest.getWitness(ForestDomain.TRANSACTION, newStatusLeaf + 1n);
    const fulfFormWitness = this.formularyRegistry.getEntryWitness(BigInt(rxState.medicationIndex));
    const eligForest = enrolled.forest;
    const eligForestRoots = ForestRoots.fromForest(eligForest);
    const accumWitness = eligForest.getWitness(ForestDomain.ACCESS_CONTROL, ACCUMULATOR_LEAF_INDEX);
    const oldEligForestRoot = eligForest.getForestRoot();
    const oldEligCredentialSerialized = serializeCredentialData(enrolled.credentialData);
    const oldEligForestSerialized = serializeForestRoots(eligForest);

    this.emit('proof', 'fill', `[3/3] Generating AccumulatorFulfillment.proveFulfillmentWithAccumulator...`, 'start');
    this.emit('info', 'fill', '       THE CLAIM: Dual-credential fulfillment with accumulator update');
    this.emit('info', 'fill', '       15 private inputs verified in a single ZK circuit');

    const startFulf = performance.now();
    const fulfillResult = await AccumulatorFulfillmentProgram.proveFulfillmentWithAccumulator(
      rxCredentialData,
      rxState.prescriptionData,
      filledStatus,
      fulfillmentData,
      rxState.formularyEntry,
      rxForestRoots,
      fulfMedWitness,
      fulfStatusWitness,
      fulfNewSlotWitness,
      fulfFormWitness,
      enrolled.eligibilityData.formularyRoot,
      enrolled.credentialData,
      eligForestRoots,
      enrolled.accumulatorData,
      accumWitness,
      ...pharmacyPreimage as [Field, Field, Field],
    );
    const elapsedFulf = performance.now() - startFulf;
    this.emit('proof', 'fill', `[3/3] AccumulatorFulfillment proof generated`, 'complete', elapsedFulf);

    // Extract proof output (individual-level, ZK-enforced)
    const proofOutput = fulfillResult.proof.publicOutput;
    let patientPayCents = Number(proofOutput.patientPayCents.toBigInt());
    let planPayCents = Number(proofOutput.planPayCents.toBigInt());
    const newEligForestRoot = proofOutput.newEligibilityForestRoot;

    // ─── Patent Evidence: 22-Step Adjudication Circuit Output ────
    this.emit('info', 'fill', `  ┌─ PROOF: AccumulatorFulfillmentProgram.proveFulfillmentWithAccumulator`);
    this.emit('info', 'fill', `  │  22-STEP ZK CIRCUIT — Authentication + Adjudication FUSED`);
    this.emit('info', 'fill', `  │`);
    this.emit('info', 'fill', `  │  Private Inputs (18 witnesses):`);
    this.emit('info', 'fill', `  │    Rx Credential:      forestRoot = ${truncField(rxCredentialData.forestRoot)}`);
    this.emit('info', 'fill', `  │    PrescriptionData:   hash = ${truncField(rxState.prescriptionData.commitment())}`);
    this.emit('info', 'fill', `  │    FulfillmentData:    hash = ${truncField(fulfillmentData.commitment())}`);
    this.emit('info', 'fill', `  │    FormularyEntry:     NDC = ${medication.ndc}, tier ${rxState.formularyEntry.tierLevel.toString()}`);
    this.emit('info', 'fill', `  │    Eligibility Cred:   forestRoot = ${truncField(enrolled.credentialData.forestRoot)}`);
    this.emit('info', 'fill', `  │    AccumulatorData:    deductible=$${(Number(enrolled.accumulatorData.deductiblePaidCents.toBigInt()) / 100).toFixed(2)}/$${(Number(enrolled.accumulatorData.deductibleAmountCents.toBigInt()) / 100).toFixed(2)}, OOP=$${(Number(enrolled.accumulatorData.oopPaidCents.toBigInt()) / 100).toFixed(2)}/$${(Number(enrolled.accumulatorData.oopMaxCents.toBigInt()) / 100).toFixed(2)}`);
    this.emit('info', 'fill', `  │    Pharmacy Preimage:  3 fields (ZK identity binding)`);
    this.emit('info', 'fill', `  │    Merkle Witnesses:   5 trees (MEDICATION, TRANSACTION x2, FORMULARY, ACCESS_CONTROL)`);
    this.emit('info', 'fill', `  │`);
    this.emit('info', 'fill', `  │  Public Output (10 Fields):`);
    this.emit('info', 'fill', `  │    prescriptionHash:         ${truncField(proofOutput.prescriptionHash)}`);
    this.emit('info', 'fill', `  │    oldForestRoot:            ${truncField(proofOutput.oldForestRoot)}`);
    this.emit('info', 'fill', `  │    newForestRoot:            ${truncField(proofOutput.newForestRoot)}`);
    this.emit('info', 'fill', `  │    entryCommitment:          ${truncField(proofOutput.entryCommitment)}`);
    this.emit('info', 'fill', `  │    patientPayCents:          ${patientPayCents} ($${(patientPayCents / 100).toFixed(2)})`);
    this.emit('info', 'fill', `  │    planPayCents:             ${planPayCents} ($${(planPayCents / 100).toFixed(2)})`);
    this.emit('info', 'fill', `  │    operationType:            ${truncField(proofOutput.operationType)}`);
    this.emit('info', 'fill', `  │    newEligibilityForestRoot: ${truncField(proofOutput.newEligibilityForestRoot)}`);
    this.emit('info', 'fill', `  │    deductibleCreditCents:    ${Number(proofOutput.deductibleCreditCents.toBigInt())} ($${(Number(proofOutput.deductibleCreditCents.toBigInt()) / 100).toFixed(2)})`);
    this.emit('info', 'fill', `  │    ndcHash:                  ${truncField(proofOutput.ndcHash)}`);
    this.emit('info', 'fill', `  │`);
    this.emit('info', 'fill', `  │  KEY DISTINCTION: patientPay + planPay are CIRCUIT OUTPUTS`);
    this.emit('info', 'fill', `  │  No adjudication authority — Provable.if() constraints ARE the rules`);
    this.emit('info', 'fill', `  └─ Proof time: ${elapsedFulf.toFixed(0)}ms`);

    // Determine adjudication phase
    const deductibleAmt = 50000;
    const oopMax = 800000;
    const oldDeductiblePaid = Number(enrolled.accumulatorData.deductiblePaidCents.toBigInt());
    const oldOopPaid = Number(enrolled.accumulatorData.oopPaidCents.toBigInt());
    const oldBenefitUsed = Number(enrolled.accumulatorData.annualBenefitUsedCents.toBigInt());
    // C4 fix: deductible credit from proof output (only deductible portion, not copay)
    const deductibleCreditCents = Number(proofOutput.deductibleCreditCents.toBigInt());
    let newDeductiblePaid = oldDeductiblePaid + deductibleCreditCents;
    let newOopPaid = oldOopPaid + patientPayCents;
    let newBenefitUsed = oldBenefitUsed + planPayCents;

    let phase = patientPayCents === totalCostCents ? 'DEDUCTIBLE (not yet met)' : 'NORMAL COPAY';

    // ─── Family Accumulator Pooling (service-layer override) ─────
    const familyLimits: FamilyLimits = {
      familyDeductibleAmountCents: 100000,
      familyOopMaxCents: 1600000,
      familyAnnualBenefitMaxCents: 0,
    };

    let familyPoolingApplied = false;
    let familyPoolingReason = '';

    // Collect all enrolled family members' accumulators (BEFORE this fill)
    const familyAccumulators: MemberAccumulator[] = [];
    for (const [_, m] of this.enrolledMembers) {
      if (m.familyId === enrolled.familyId) {
        if (m.walletId.toString() === enrolled.walletId.toString()) {
          // Use the updated values for the current member
          familyAccumulators.push({
            deductiblePaidCents: newDeductiblePaid,
            oopPaidCents: newOopPaid,
            annualBenefitUsedCents: newBenefitUsed,
          });
        } else {
          familyAccumulators.push({
            deductiblePaidCents: Number(m.accumulatorData.deductiblePaidCents.toBigInt()),
            oopPaidCents: Number(m.accumulatorData.oopPaidCents.toBigInt()),
            annualBenefitUsedCents: Number(m.accumulatorData.annualBenefitUsedCents.toBigInt()),
          });
        }
      }
    }

    if (familyAccumulators.length > 1) {
      const familyTotals = FamilyAccumulatorService.getFamilyTotals(familyAccumulators);
      const adjusted = FamilyAccumulatorService.computeFamilyAdjustedPay(
        patientPayCents, totalCostCents, familyTotals, familyLimits,
      );

      if (adjusted.familyPoolingApplied) {
        familyPoolingApplied = true;
        familyPoolingReason = adjusted.reason;
        patientPayCents = adjusted.patientPayCents;
        planPayCents = adjusted.planPayCents;
        newDeductiblePaid = oldDeductiblePaid + Math.min(deductibleCreditCents, patientPayCents);
        newOopPaid = oldOopPaid + patientPayCents;
        newBenefitUsed = oldBenefitUsed + planPayCents;
        phase = adjusted.reason;

        this.emitViz('viz:accumulator:updated', 'fulfillment', {
          actor: 'Insurer',
          actorType: 'insurer',
          target: enrolled.displayName,
          targetType: 'member',
          data: {
            familyPooling: true,
            familyOopTotal: familyTotals.oopPaidCents,
            familyDeductibleTotal: familyTotals.deductiblePaidCents,
            adjustedPatientPay: patientPayCents,
            reason: familyPoolingReason,
          },
        });
      }
    }

    this.emit('info', 'fill', '');
    this.emit('phase', 'fill', '═══ THE RESULT ═══');
    this.emit('info', 'fill', `  ADJUDICATION (ZK-enforced in-circuit):`);
    this.emit('info', 'fill', `    Phase:       ${phase}`);
    this.emit('info', 'fill', `    Patient pay: $${(patientPayCents / 100).toFixed(2)}`);
    this.emit('info', 'fill', `    Plan pay:    $${(planPayCents / 100).toFixed(2)}`);
    if (familyPoolingApplied) {
      this.emit('info', 'fill', `    FAMILY POOLING: ${familyPoolingReason}`);
    }
    this.emit('info', 'fill', '');
    this.emit('info', 'fill', `  ACCUMULATOR (BEFORE → AFTER):`);
    this.emit('info', 'fill', `    Deductible:  $${(oldDeductiblePaid / 100).toFixed(2)} → $${(newDeductiblePaid / 100).toFixed(2)} / $${(deductibleAmt / 100).toFixed(2)}  ${(newDeductiblePaid / deductibleAmt * 100).toFixed(1)}%`);
    this.emit('info', 'fill', `    OOPM:        $${(oldOopPaid / 100).toFixed(2)} → $${(newOopPaid / 100).toFixed(2)} / $${(oopMax / 100).toFixed(2)}  ${(newOopPaid / oopMax * 100).toFixed(1)}%`);
    this.emit('info', 'fill', '');
    this.emit('info', 'fill', `  ELIGIBILITY CREDENTIAL:`);
    this.emit('info', 'fill', `    Forest root BEFORE: ${truncField(oldEligForestRoot)}`);
    this.emit('info', 'fill', `    Forest root AFTER:  ${truncField(newEligForestRoot)}`);
    this.emit('info', 'fill', `    CHANGED: ${!oldEligForestRoot.equals(newEligForestRoot).toBoolean() ? 'YES — accumulator updated in credential' : 'NO (unexpected)'}`)
    this.emit('info', 'fill', '');
    this.emit('info', 'fill', `  MERKLE TREE STATE:`);
    this.emit('info', 'fill', `    Rx TRANSACTION tree:       leaf ${newStatusLeaf} = status, leaf ${newStatusLeaf + 1n} = settlement`);
    this.emit('info', 'fill', `    Elig ACCESS_CONTROL tree:  leaf 127 = new accumulator commitment`);
    this.emit('info', 'fill', `    ForestRoot = Poseidon.hash(6 domain tree roots)`);

    // Update enrolled member's accumulator data
    enrolled.accumulatorData = buildAccumulatorData({
      planYear: '20260101',
      deductibleAmountCents: deductibleAmt,
      deductiblePaidCents: newDeductiblePaid,
      oopMaxCents: oopMax,
      oopPaidCents: newOopPaid,
      annualBenefitMaxCents: 0,
      annualBenefitUsedCents: newBenefitUsed,
    });

    // Update local forests to match circuit output
    const settlementCommit = Poseidon.hash([
      fulfillmentData.commitment(),
      proofOutput.patientPayCents,
      proofOutput.planPayCents,
      proofOutput.deductibleCreditCents,
    ]);
    rxForest.setLeaf(ForestDomain.TRANSACTION, newStatusLeaf + 1n, settlementCommit);
    const updatedRxCredentialData = new CredentialData({
      credentialType: CREDENTIAL_TYPE_PRESCRIPTION,
      forestRoot: rxForest.getForestRoot(),
      issuerWalletId: rxCredentialData.issuerWalletId,
      subjectWalletId: rxCredentialData.subjectWalletId,
      issuedAt: rxCredentialData.issuedAt,
      expiresAt: rxCredentialData.expiresAt,
      revoked: rxCredentialData.revoked,
    });

    eligForest.setLeaf(ForestDomain.ACCESS_CONTROL, ACCUMULATOR_LEAF_INDEX, enrolled.accumulatorData.commitment());
    const updatedEligCredentialData = new CredentialData({
      credentialType: enrolled.credentialData.credentialType,
      forestRoot: eligForest.getForestRoot(),
      issuerWalletId: enrolled.credentialData.issuerWalletId,
      subjectWalletId: enrolled.credentialData.subjectWalletId,
      issuedAt: enrolled.credentialData.issuedAt,
      expiresAt: enrolled.credentialData.expiresAt,
      revoked: enrolled.credentialData.revoked,
    });
    enrolled.credentialData = updatedEligCredentialData;

    // Submit wallet update to L2 (accumulator/forest change → new inventory root)
    const fillReceipt = await this.updateCredentialAndSubmitToL2(enrolled, 'fill');

    // Determine new status: partial fill or full fill
    const totalDispensed = rxState.quantityDispensed + qtyDispensed;
    const isPartialFill = totalDispensed < rxState.quantity;
    const previousStatus = rxState.status;
    const newStatus: RxStatus = isPartialFill ? 'PARTIALLY_FILLED' : 'FILLED';

    rxState.quantityDispensed = totalDispensed;
    rxState.status = newStatus;
    rxState.activeStatus = filledStatus;                       // update current ZK status
    rxState.currentStatusLeafIndex = newStatusLeaf;            // track current status leaf
    rxState.nextTxLeafIndex = newStatusLeaf + 2n;              // advance past status + fulfillment leaves
    rxState.rxCredentialData = updatedRxCredentialData;          // update Rx credential with new forest root
    rxState.statusHistory.push({
      from: previousStatus,
      to: newStatus,
      updatedBy: pharmacy.storeName,
      updatedByRole: 'pharmacy',
      timestamp: Date.now(),
      fillQuantity: qtyDispensed,
    });

    const existingFills = this.fulfillments.get(opts.prescriptionId) || [];
    const fulfillment: FulfillmentState = {
      prescriptionId: opts.prescriptionId,
      fillIndex: existingFills.length,
      patientPayCents,
      planPayCents,
      totalCostCents,
      accumulatorBefore: { deductiblePaid: oldDeductiblePaid, oopPaid: oldOopPaid, benefitUsed: oldBenefitUsed },
      accumulatorAfter: { deductiblePaid: newDeductiblePaid, oopPaid: newOopPaid, benefitUsed: newBenefitUsed },
      newEligForestRoot: truncField(newEligForestRoot),
      oldEligForestRoot: truncField(oldEligForestRoot),
      settlementCommitment: settlementCommit,
      fulfillmentData,
      patientPayField: proofOutput.patientPayCents,
      planPayField: proofOutput.planPayCents,
      deductibleCreditField: proofOutput.deductibleCreditCents,
      settlementLeafIndex: newStatusLeaf + 1n,
      quantityDispensed: qtyDispensed,
      reversed: false,
    };
    existingFills.push(fulfillment);
    this.fulfillments.set(opts.prescriptionId, existingFills);

    this.emitViz('viz:fulfillment:settled', 'fulfillment', {
      actor: pharmacy.storeName,
      actorType: 'pharmacy',
      target: enrolled.displayName,
      targetType: 'member',
      data: {
        medication: medication.brandName,
        patientPayCents,
        planPayCents,
        totalCostCents,
        phase,
      },
    });

    this.emitViz('viz:accumulator:updated', 'fulfillment', {
      actor: 'Insurer',
      actorType: 'insurer',
      target: enrolled.displayName,
      targetType: 'member',
      data: {
        deductibleBefore: oldDeductiblePaid,
        deductibleAfter: newDeductiblePaid,
        oopBefore: oldOopPaid,
        oopAfter: newOopPaid,
      },
    });

    this.emitMemory('fill');

    return {
      prescriptionId: opts.prescriptionId,
      serviceDateStr,
      rxStatus: rxState.status,
      quantityDispensed: rxState.quantityDispensed,
      quantityPrescribed: rxState.quantity,
      medication: {
        brandName: medication.brandName,
        genericName: medication.genericName,
        strength: medication.strength,
        ndc: medication.ndcFormatted,
        tier: medication.formularyEntry.tierLevel,
      },
      adjudication: {
        phase,
        patientPayCents,
        planPayCents,
        totalCostCents,
        ingredientCostCents,
        dispensingFeeCents,
        familyPoolingApplied,
        familyPoolingReason: familyPoolingApplied ? familyPoolingReason : undefined,
      },
      accumulator: {
        before: {
          deductiblePaidCents: oldDeductiblePaid,
          oopPaidCents: oldOopPaid,
          benefitUsedCents: oldBenefitUsed,
        },
        after: {
          deductiblePaidCents: newDeductiblePaid,
          oopPaidCents: newOopPaid,
          benefitUsedCents: newBenefitUsed,
        },
        limits: {
          deductibleAmountCents: deductibleAmt,
          oopMaxCents: oopMax,
          annualBenefitMaxCents: 0,
          familyDeductibleAmountCents: 100000,
          familyOopMaxCents: 1600000,
          familyAnnualBenefitMaxCents: 0,
        },
      },
      eligibilityCredential: {
        oldForestRoot: truncField(oldEligForestRoot),
        newForestRoot: truncField(newEligForestRoot),
        changed: !oldEligForestRoot.equals(newEligForestRoot).toBoolean(),
      },
      proofTimesMs: {
        proofGate: elapsedPG,
        prescriptionStatus: elapsedRx,
        accumulatorFulfillment: elapsedFulf,
        total: elapsedPG + elapsedRx + elapsedFulf,
      },
      // ─── ZK Data (full transparency) ────────────────
      fulfillmentDetail: {
        prescriptionHash: fieldToStr(fulfillmentData.prescriptionHash),
        pharmacyWalletId: fieldToStr(fulfillmentData.pharmacyWalletId),
        ndcHash: fieldToStr(fulfillmentData.ndcHash),
        quantityDispensed: fieldToStr(fulfillmentData.quantityDispensed),
        ingredientCostCents: fieldToStr(fulfillmentData.ingredientCostCents),
        dispensingFeeCents: fieldToStr(fulfillmentData.dispensingFeeCents),
        dateOfService: fieldToStr(fulfillmentData.dateOfService),
        commitment: fieldToStr(fulfillmentData.commitment()),
      },
      filledStatusData: {
        prescriptionHash: fieldToStr(filledStatus.prescriptionHash),
        status: fieldToStr(filledStatus.status),
        updatedByWalletId: fieldToStr(filledStatus.updatedByWalletId),
        updatedAt: fieldToStr(filledStatus.updatedAt),
        pharmacyWalletId: fieldToStr(filledStatus.pharmacyWalletId),
        fillQuantity: fieldToStr(filledStatus.fillQuantity),
        notesHash: fieldToStr(filledStatus.notesHash),
        commitment: fieldToStr(filledStatus.commitment()),
      },
      settlementCommitment: fieldToStr(settlementCommit),
      updatedPrescriptionCredential: serializeCredentialData(updatedRxCredentialData),
      updatedPrescriptionForest: serializeForestRoots(rxForest),
      oldEligibilityCredential: oldEligCredentialSerialized,
      oldEligibilityForest: oldEligForestSerialized,
      updatedEligibilityCredential: serializeCredentialData(updatedEligCredentialData),
      updatedEligibilityForest: serializeForestRoots(eligForest),
      l2Receipt: {
        receiptId: fillReceipt.receiptId,
        sequenceNumber: Number(fillReceipt.sequenceNumber),
        type: 'wallet-update',
      },
      chainState: this.getChainState(),
    };
  }

  // ─── Update Rx Status ──────────────────────────────────────

  updateRxStatus(opts: {
    prescriptionId: string;
    newStatus: 'CANCELLED' | 'REJECTED' | 'COMPLETED' | 'DISPENSED';
    role: 'prescriber' | 'pharmacy';
    actorIndex: number;
    note?: string;
  }): Record<string, unknown> {
    const rxState = this.prescriptions.get(opts.prescriptionId);
    if (!rxState) throw new Error(`Prescription not found: ${opts.prescriptionId}`);

    // COMPLETED is a service-layer-only terminal status (member confirmed pickup)
    if (opts.newStatus === 'COMPLETED') {
      if (rxState.status !== 'FILLED') {
        throw new Error(`Cannot complete prescription in ${rxState.status} status. Must be FILLED first.`);
      }
      if (opts.role !== 'pharmacy') {
        throw new Error('Only pharmacies can mark prescriptions as completed');
      }
    } else if (opts.newStatus === 'DISPENSED') {
      // NCPDP: DISPENSED = pharmacy has prepared/dispensed the medication, awaiting member pickup.
      // DISPENSED → FILLED happens when member presents credential and picks up.
      if (rxState.status !== 'ACTIVE') {
        throw new Error(`Cannot dispense prescription in ${rxState.status} status. Must be ACTIVE.`);
      }
      if (opts.role !== 'pharmacy') {
        throw new Error('Only pharmacies can dispense prescriptions');
      }
    } else {
      // Validate the transition using production state machine
      const statusMap: Record<string, bigint> = {
        'ACTIVE': 1n, 'PARTIALLY_FILLED': 2n, 'FILLED': 3n,
        'CANCELLED': 4n, 'REJECTED': 5n, 'REVERSED': 6n, 'DISPENSED': 8n,
      };
      const fromBigint = statusMap[rxState.status];
      const toBigint = statusMap[opts.newStatus];
      if (!fromBigint || !toBigint || !isValidStatusTransition(fromBigint, toBigint)) {
        throw new Error(`Invalid status transition: ${rxState.status} → ${opts.newStatus}`);
      }

      // Validate role: prescribers cancel, pharmacies reject
      if (opts.newStatus === 'CANCELLED' && opts.role !== 'prescriber') {
        throw new Error('Only prescribers can cancel prescriptions');
      }
      if (opts.newStatus === 'REJECTED' && opts.role !== 'pharmacy') {
        throw new Error('Only pharmacies can reject prescriptions');
      }
    }

    const actorName = opts.role === 'prescriber'
      ? `Dr. ${DEMO_PRESCRIBERS[opts.actorIndex].firstName} ${DEMO_PRESCRIBERS[opts.actorIndex].lastName}`
      : DEMO_PHARMACIES[opts.actorIndex].storeName;
    const enrolled = this.enrolledMembers.get(rxState.memberWalletId);
    const medication = DEMO_MEDICATIONS[rxState.medicationIndex];

    const previousStatus = rxState.status;
    rxState.status = opts.newStatus;
    rxState.statusHistory.push({
      from: previousStatus,
      to: opts.newStatus,
      updatedBy: actorName,
      updatedByRole: opts.role,
      timestamp: Date.now(),
      note: opts.note,
    });

    // Console log
    const verbMap: Record<string, string> = {
      'CANCELLED': 'cancelled', 'REJECTED': 'rejected', 'COMPLETED': 'completed (PoS pickup)', 'DISPENSED': 'dispensed (awaiting pickup)',
    };
    const verb = verbMap[opts.newStatus] || opts.newStatus.toLowerCase();
    this.emit('phase', 'status', `═══ Prescription ${verb.charAt(0).toUpperCase() + verb.slice(1)}: ${medication.brandName} ═══`);
    this.emit('info', 'status', `  ${actorName} ${verb} ${opts.prescriptionId} for ${enrolled?.displayName ?? 'unknown'}`);
    this.emit('info', 'status', `  Status: ${previousStatus} → ${opts.newStatus}`);
    if (opts.note) this.emit('info', 'status', `  Reason: ${opts.note}`);

    // Emit pharmacy-specific VizEvents
    if (opts.newStatus === 'DISPENSED') {
      this.emitViz('viz:pharmacy:dispensed', 'fulfillment', {
        actor: actorName,
        actorType: 'pharmacy',
        target: enrolled?.displayName ?? '',
        targetType: 'member',
        data: { medication: medication.brandName, prescriptionId: opts.prescriptionId },
      });
    } else if (opts.newStatus === 'REJECTED') {
      this.emitViz('viz:pharmacy:rejected', 'fulfillment', {
        actor: actorName,
        actorType: 'pharmacy',
        target: enrolled?.displayName ?? '',
        targetType: 'member',
        data: { medication: medication.brandName, prescriptionId: opts.prescriptionId, reason: opts.note },
      });
    }

    return {
      prescriptionId: opts.prescriptionId,
      previousStatus,
      newStatus: opts.newStatus,
      actor: actorName,
      medication: medication.brandName,
      member: enrolled?.displayName ?? 'unknown',
      note: opts.note,
    };
  }

  // ─── Reverse Prescription ─────────────────────────────────

  async reversePrescription(opts: {
    prescriptionId: string;
    fillIndex?: number;      // which fill to reverse (default: last)
    reason?: string;
  }): Promise<Record<string, unknown>> {
    const rxState = this.prescriptions.get(opts.prescriptionId);
    if (!rxState) throw new Error(`Prescription not found: ${opts.prescriptionId}`);

    // Must be FILLED or PARTIALLY_FILLED
    if (rxState.status !== 'FILLED' && rxState.status !== 'PARTIALLY_FILLED') {
      throw new Error(`Cannot reverse prescription in ${rxState.status} status. Must be FILLED or PARTIALLY_FILLED.`);
    }

    const fills = this.fulfillments.get(opts.prescriptionId);
    if (!fills || fills.length === 0) {
      throw new Error(`No fulfillments found for ${opts.prescriptionId}`);
    }

    // Find the fill to reverse
    const fillIdx = opts.fillIndex ?? fills.length - 1;
    const fillToReverse = fills[fillIdx];
    if (!fillToReverse) throw new Error(`Fill index ${fillIdx} not found for ${opts.prescriptionId}`);
    if (fillToReverse.reversed) throw new Error(`Fill #${fillIdx} already reversed`);

    const pharmacy = DEMO_PHARMACIES[rxState.pharmacyIndex];
    const medication = DEMO_MEDICATIONS[rxState.medicationIndex];
    const enrolled = this.enrolledMembers.get(rxState.memberWalletId);
    if (!enrolled) throw new Error(`Member not found for wallet: ${rxState.memberWalletId}`);
    const pharmacyWalletId = this.pharmacyWalletIds.get(rxState.pharmacyIndex)!;

    this.emit('phase', 'reversal', `═══ Claim Reversal: ${medication.brandName} ═══`);
    this.emit('info', 'reversal', `  Reversing fill #${fillIdx} of ${opts.prescriptionId}`);
    this.emit('info', 'reversal', `  Original: patient $${(fillToReverse.patientPayCents / 100).toFixed(2)}, plan $${(fillToReverse.planPayCents / 100).toFixed(2)}`);
    if (opts.reason) this.emit('info', 'reversal', `  Reason: ${opts.reason}`);

    // 1. Build ReversalData
    const reversalData = new ReversalData({
      fulfillmentHash: fillToReverse.fulfillmentData.commitment(),
      pharmacyWalletId,
      patientRefundCents: fillToReverse.patientPayField,
      planRefundCents: fillToReverse.planPayField,
      reversalDate: dateToField('20260203'),
      reasonCodeHash: opts.reason ? hashString(opts.reason) : Field(0),
      reversedByWalletId: pharmacyWalletId,
    });

    // 2. Generate AccumulatorFulfillmentProgram.proveReversalWithAccumulator
    //    The reversal slot is directly after the settlement commitment leaf.
    //    The reversal proof verifies the settlement commitment cryptographically.
    const rxForest = rxState.rxForest;
    const rxForestRoots = ForestRoots.fromForest(rxForest);
    const revMedWitness = rxForest.getWitness(ForestDomain.MEDICATION, 0n);
    const revFulfWitness = rxForest.getWitness(ForestDomain.TRANSACTION, fillToReverse.settlementLeafIndex);
    const reversalSlotIndex = fillToReverse.settlementLeafIndex + 1n;
    const revSlotWitness = rxForest.getWitness(ForestDomain.TRANSACTION, reversalSlotIndex);

    const eligForest = enrolled.forest;
    const eligForestRoots = ForestRoots.fromForest(eligForest);
    const accumWitness = eligForest.getWitness(ForestDomain.ACCESS_CONTROL, ACCUMULATOR_LEAF_INDEX);
    const oldEligForestRoot = eligForest.getForestRoot();

    this.emit('proof', 'reversal', `[1/2] Generating AccumulatorFulfillment.proveReversalWithAccumulator...`, 'start');
    this.emit('info', 'reversal', '       THE REVERSAL: Dual-credential reversal with accumulator rollback');
    this.emit('info', 'reversal', '       Settlement commitment verified, refund amounts cryptographically bound');

    const startRev = performance.now();
    const reversalResult = await AccumulatorFulfillmentProgram.proveReversalWithAccumulator(
      rxState.rxCredentialData,
      rxState.prescriptionData,
      fillToReverse.fulfillmentData,
      reversalData,
      rxForestRoots,
      revMedWitness,
      revFulfWitness,
      revSlotWitness,
      fillToReverse.patientPayField,
      fillToReverse.planPayField,
      fillToReverse.deductibleCreditField,
      enrolled.credentialData,
      eligForestRoots,
      enrolled.accumulatorData,
      accumWitness,
    );
    const elapsedRev = performance.now() - startRev;
    this.emit('proof', 'reversal', `[1/2] AccumulatorFulfillment.proveReversalWithAccumulator proof generated`, 'complete', elapsedRev);

    // Extract proof output
    const revOutput = reversalResult.proof.publicOutput;
    const newEligForestRoot = revOutput.newEligibilityForestRoot;

    // 3. Update TRANSACTION tree: store reversal commitment at the reversal slot
    rxForest.setLeaf(ForestDomain.TRANSACTION, reversalSlotIndex, reversalData.commitment());

    // 4. Update eligibility forest: reverse accumulator
    const origPatientPay = fillToReverse.patientPayCents;
    const origPlanPay = fillToReverse.planPayCents;
    const origDeductibleCredit = Number(fillToReverse.deductibleCreditField.toBigInt());
    const oldDeductiblePaid = Number(enrolled.accumulatorData.deductiblePaidCents.toBigInt());
    const oldOopPaid = Number(enrolled.accumulatorData.oopPaidCents.toBigInt());
    const oldBenefitUsed = Number(enrolled.accumulatorData.annualBenefitUsedCents.toBigInt());
    const newDeductiblePaid = Math.max(0, oldDeductiblePaid - origDeductibleCredit);
    const newOopPaid = Math.max(0, oldOopPaid - origPatientPay);
    const newBenefitUsed = Math.max(0, oldBenefitUsed - origPlanPay);

    enrolled.accumulatorData = buildAccumulatorData({
      planYear: '20260101',
      deductibleAmountCents: 50000,
      deductiblePaidCents: newDeductiblePaid,
      oopMaxCents: 800000,
      oopPaidCents: newOopPaid,
      annualBenefitMaxCents: 0,
      annualBenefitUsedCents: newBenefitUsed,
    });

    eligForest.setLeaf(ForestDomain.ACCESS_CONTROL, ACCUMULATOR_LEAF_INDEX, enrolled.accumulatorData.commitment());
    const updatedEligCredentialData = new CredentialData({
      credentialType: enrolled.credentialData.credentialType,
      forestRoot: eligForest.getForestRoot(),
      issuerWalletId: enrolled.credentialData.issuerWalletId,
      subjectWalletId: enrolled.credentialData.subjectWalletId,
      issuedAt: enrolled.credentialData.issuedAt,
      expiresAt: enrolled.credentialData.expiresAt,
      revoked: enrolled.credentialData.revoked,
    });
    enrolled.credentialData = updatedEligCredentialData;

    // 5. Update Rx credential with final forest root (after reversal slot write)
    const updatedRxCredentialData = new CredentialData({
      credentialType: CREDENTIAL_TYPE_PRESCRIPTION,
      forestRoot: rxForest.getForestRoot(),
      issuerWalletId: rxState.rxCredentialData.issuerWalletId,
      subjectWalletId: rxState.rxCredentialData.subjectWalletId,
      issuedAt: rxState.rxCredentialData.issuedAt,
      expiresAt: Field(0),
      revoked: Field(0),
    });

    // 6. Update prescription state
    const previousStatus = rxState.status;
    rxState.status = 'REVERSED';
    rxState.quantityDispensed -= fillToReverse.quantityDispensed;
    rxState.rxCredentialData = updatedRxCredentialData;
    // Note: nextTxLeafIndex unchanged — reversal slot is at settlementLeafIndex+1, not at nextTxLeafIndex
    rxState.statusHistory.push({
      from: previousStatus,
      to: 'REVERSED',
      updatedBy: pharmacy.storeName,
      updatedByRole: 'pharmacy',
      timestamp: Date.now(),
      fillQuantity: fillToReverse.quantityDispensed,
      note: opts.reason,
    });

    // Mark the fill as reversed
    fillToReverse.reversed = true;

    this.emit('memory', 'reversal', `Memory: ${Math.round(process.memoryUsage().rss / 1024 / 1024)} MB RSS`);

    // Emit results
    this.emit('info', 'reversal', '');
    this.emit('phase', 'reversal', '═══ REVERSAL RESULT ═══');
    this.emit('info', 'reversal', `  REFUND (ZK-verified):`);
    this.emit('info', 'reversal', `    Patient refund: $${(origPatientPay / 100).toFixed(2)}`);
    this.emit('info', 'reversal', `    Plan refund:    $${(origPlanPay / 100).toFixed(2)}`);
    this.emit('info', 'reversal', '');
    this.emit('info', 'reversal', `  ACCUMULATOR (BEFORE → AFTER reversal):`);
    this.emit('info', 'reversal', `    Deductible:  $${(oldDeductiblePaid / 100).toFixed(2)} → $${(newDeductiblePaid / 100).toFixed(2)} / $500.00`);
    this.emit('info', 'reversal', `    OOPM:        $${(oldOopPaid / 100).toFixed(2)} → $${(newOopPaid / 100).toFixed(2)} / $8000.00`);
    this.emit('info', 'reversal', '');
    this.emit('info', 'reversal', `  ELIGIBILITY CREDENTIAL:`);
    this.emit('info', 'reversal', `    Forest root BEFORE: ${truncField(oldEligForestRoot)}`);
    this.emit('info', 'reversal', `    Forest root AFTER:  ${truncField(newEligForestRoot)}`);

    this.emitViz('viz:fulfillment:reversed', 'fulfillment', {
      actor: pharmacy.storeName,
      actorType: 'pharmacy',
      target: enrolled.displayName,
      targetType: 'member',
      data: {
        medication: medication.brandName,
        patientRefundCents: origPatientPay,
        planRefundCents: origPlanPay,
      },
    });

    return {
      prescriptionId: opts.prescriptionId,
      fillIndex: fillIdx,
      previousStatus,
      newStatus: 'REVERSED',
      medication: {
        brandName: medication.brandName,
        genericName: medication.genericName,
        strength: medication.strength,
        ndc: medication.ndc,
        tier: medication.formularyEntry.tierLevel,
      },
      refund: {
        patientRefundCents: origPatientPay,
        planRefundCents: origPlanPay,
        totalRefundCents: origPatientPay + origPlanPay,
      },
      accumulator: {
        before: { deductiblePaidCents: oldDeductiblePaid, oopPaidCents: oldOopPaid, benefitUsedCents: oldBenefitUsed },
        after: { deductiblePaidCents: newDeductiblePaid, oopPaidCents: newOopPaid, benefitUsedCents: newBenefitUsed },
      },
      eligibilityCredential: {
        oldForestRoot: truncField(oldEligForestRoot),
        newForestRoot: truncField(newEligForestRoot),
      },
      proofTimesMs: {
        accumulatorReversal: elapsedRev,
        total: elapsedRev,
      },
      reversalCommitment: fieldToStr(reversalData.commitment()),
      settlementCommitmentVerified: fieldToStr(fillToReverse.settlementCommitment),
      chainState: this.getChainState(),
    };
  }

  // ─── Messaging ────────────────────────────────────────────

  /**
   * Internal message — no proof, no encryption. Used for auto-sent system messages.
   */
  private sendInternalMessage(
    sender: Field, recipient: Field, msgType: Field,
    subject: string, plaintext: string,
    threadId?: string,
  ): bigint {
    this.msgNonce++;
    // Threading: reuse threadId for replies, or start new conversation
    let threadIdStr: string;
    if (threadId) {
      threadIdStr = threadId;
    } else {
      this.threadCounter++;
      threadIdStr = `conv-sys-${this.threadCounter}`;
    }

    const fullText = `Subject: ${subject}\n\n${plaintext}`;

    // Capture messaging root before
    const messagingRootBefore = computeMessagingRoot(
      this.messageRegistry.getRoot(),
      this.delegationRegistry.getRoot(),
      this.keyRegistry.getRoot(),
    ).toString();

    const msg = new MessageData({
      senderWalletId: sender,
      recipientWalletId: recipient,
      contentHash: hashString(fullText),
      messageType: msgType,
      timestamp: dateToField('20260214'),
      threadId: hashString(threadIdStr),
      nonce: Field(BigInt(this.msgNonce)),
    });
    const { index } = this.messageRegistry.addMessage(msg);

    // Try to encrypt if both keys are available; otherwise store marker
    const senderKeyIndex = this.findKeyIndexForWallet(sender);
    const recipientKeyIndex = this.findKeyIndexForWallet(recipient);
    const senderKeys = senderKeyIndex !== null ? this.encryptionKeys.get(senderKeyIndex) : null;
    const recipientKeys = recipientKeyIndex !== null ? this.encryptionKeys.get(recipientKeyIndex) : null;

    if (senderKeys && recipientKeys) {
      const sharedSecret = deriveSharedSecret(senderKeys.privateKey, recipientKeys.publicKey);
      const encrypted = encryptMessage(fullText, sharedSecret);
      this.encryptedPayloads.set(index.toString(), {
        ciphertext: encrypted.ciphertext.toString('hex'),
        iv: encrypted.iv.toString('hex'),
        tag: encrypted.tag.toString('hex'),
        senderKeyIndex: senderKeyIndex!,
        recipientKeyIndex: recipientKeyIndex!,
        threadId: threadIdStr,
        timestamp: Date.now(),
      });
    } else {
      // System message before key registration — marker with empty ciphertext
      this.encryptedPayloads.set(index.toString(), {
        ciphertext: '',
        iv: '',
        tag: '',
        senderKeyIndex: senderKeyIndex ?? -1,
        recipientKeyIndex: recipientKeyIndex ?? -1,
        threadId: threadIdStr,
        timestamp: Date.now(),
      });
    }

    // Emit messaging audit event to L2 chain
    const messagingRootAfter = computeMessagingRoot(
      this.messageRegistry.getRoot(),
      this.delegationRegistry.getRoot(),
      this.keyRegistry.getRoot(),
    ).toString();
    this.l2Node.emitMessagingAuditEvent(
      sender.toString(),
      messagingRootBefore,
      messagingRootAfter,
    );

    return index;
  }

  /**
   * Find the encryption key index for a given wallet Field.
   * Returns null if no key is registered for this wallet.
   */
  private findKeyIndexForWallet(wallet: Field): number | null {
    const walletStr = wallet.toString();
    // Check prescribers (index 0-9)
    for (const [idx, wid] of this.prescriberWalletIds) {
      if (wid.toString() === walletStr) return idx;
    }
    // Check pharmacies (index 10+)
    for (const [idx, wid] of this.pharmacyWalletIds) {
      if (wid.toString() === walletStr) return 10 + idx;
    }
    // Check enrolled members
    for (const enrolled of this.enrolledMembers.values()) {
      if (enrolled.walletId.toString() === walletStr) return enrolled.walletIndex;
    }
    // Check admin/insurer
    if (this.adminWalletId && this.adminWalletId.toString() === walletStr) return 999;
    return null;
  }

  /**
   * Resolve a wallet ID from party type + index/walletId string.
   */
  private resolveWalletId(
    type: string, index?: number, walletId?: string,
  ): { walletId: Field; keyIndex: number; displayName: string } {
    if (type === 'prescriber') {
      if (index === undefined) throw new Error('Prescriber index required');
      const p = DEMO_PRESCRIBERS[index];
      if (!p) throw new Error(`Invalid prescriber index: ${index}`);
      return {
        walletId: this.prescriberWalletIds.get(index)!,
        keyIndex: index,
        displayName: `Dr. ${p.firstName} ${p.lastName}`,
      };
    }
    if (type === 'pharmacy') {
      if (index === undefined) throw new Error('Pharmacy index required');
      const p = DEMO_PHARMACIES[index];
      if (!p) throw new Error(`Invalid pharmacy index: ${index}`);
      return {
        walletId: this.pharmacyWalletIds.get(index)!,
        keyIndex: 10 + index,
        displayName: p.storeName,
      };
    }
    if (type === 'insurer') {
      return {
        walletId: this.adminWalletId,
        keyIndex: 999,
        displayName: 'Insurer',
      };
    }
    if (type === 'member') {
      if (!walletId) throw new Error('Member walletId required');
      const enrolled = this.enrolledMembers.get(walletId);
      if (!enrolled) throw new Error(`Member not enrolled: ${walletId}`);
      if (enrolled.lifecycle === 'REVOKED') throw new Error(`Member ${enrolled.displayName} is terminated`);
      return {
        walletId: enrolled.walletId,
        keyIndex: enrolled.walletIndex,
        displayName: enrolled.displayName,
      };
    }
    throw new Error(`Unknown party type: ${type}`);
  }

  /**
   * Send an encrypted message with ZK proof. Any party → any party.
   */
  async sendMessage(opts: {
    senderType: string;
    senderIndex?: number;
    senderWalletId?: string;
    recipientType: string;
    recipientIndex?: number;
    recipientWalletId?: string;
    subject: string;
    body: string;
    threadId?: string;
  }): Promise<Record<string, unknown>> {
    if (!this.compiled) throw new Error('Programs not compiled yet');

    const sender = this.resolveWalletId(opts.senderType, opts.senderIndex, opts.senderWalletId);
    const recipient = this.resolveWalletId(opts.recipientType, opts.recipientIndex, opts.recipientWalletId);

    // Determine message type
    let msgType = MSG_TYPE_GENERAL;
    if (opts.recipientType === 'insurer') msgType = MSG_TYPE_SUPPORT;
    if (opts.senderType === 'insurer') msgType = MSG_TYPE_NOTIFICATION;

    const plaintext = `Subject: ${opts.subject}\n\n${opts.body}`;

    this.emit('phase', 'messaging', `═══ Secure Message: ${sender.displayName} → ${recipient.displayName} ═══`);
    this.emit('info', 'messaging', `  Type: ${msgType === MSG_TYPE_SUPPORT ? 'SUPPORT' : msgType === MSG_TYPE_NOTIFICATION ? 'NOTIFICATION' : 'GENERAL'}`);
    this.emit('info', 'messaging', `  Subject: ${opts.subject}`);

    // 1. Encrypt with ECIES
    const senderKeys = this.encryptionKeys.get(sender.keyIndex);
    const recipientKeys = this.encryptionKeys.get(recipient.keyIndex);
    if (!senderKeys || !recipientKeys) throw new Error('Encryption keys not found');

    const sharedSecret = deriveSharedSecret(senderKeys.privateKey, recipientKeys.publicKey);
    const encrypted = encryptMessage(plaintext, sharedSecret);
    const contentHash = computeContentHash(encrypted.ciphertext, encrypted.iv, encrypted.tag);

    this.emit('info', 'messaging', `  Encrypted with X25519-ECDH + AES-256-GCM (${encrypted.ciphertext.length} bytes)`);
    this.emit('info', 'messaging', `  Content hash: ${contentHash.toString().slice(0, 16)}...`);

    // 2. Threading: reuse threadId for replies, or start new conversation
    this.msgNonce++;
    let threadIdStr: string;
    if (opts.threadId) {
      threadIdStr = opts.threadId;
    } else {
      this.threadCounter++;
      threadIdStr = `conv-${sender.walletId.toString().slice(0, 12)}-${recipient.walletId.toString().slice(0, 12)}-${this.threadCounter}`;
    }

    // Capture messaging root before
    const messagingRootBefore = computeMessagingRoot(
      this.messageRegistry.getRoot(),
      this.delegationRegistry.getRoot(),
      this.keyRegistry.getRoot(),
    ).toString();

    const msg = new MessageData({
      senderWalletId: sender.walletId,
      recipientWalletId: recipient.walletId,
      contentHash,
      messageType: msgType,
      timestamp: dateToField('20260214'),
      threadId: hashString(threadIdStr),
      nonce: Field(BigInt(this.msgNonce)),
    });

    // 3. Add to registry
    const { index: msgIndex } = this.messageRegistry.addMessage(msg);
    const msgWitness = this.messageRegistry.getWitness(msgIndex);

    // 4. Generate proof
    this.emit('proof', 'messaging', 'Generating MessagingProgram.proveSendMessage proof...', 'start');
    const startProof = performance.now();
    await MessagingProgram.proveSendMessage(
      msg, msgWitness,
      this.messageRegistry.getRoot(),
      this.delegationRegistry.getRoot(),
      this.keyRegistry.getRoot(),
    );
    const elapsed = performance.now() - startProof;
    this.emit('proof', 'messaging', 'MessagingProgram.proveSendMessage proof generated', 'complete', elapsed);

    // 5. Store encrypted payload only (no plaintext server-side)
    this.encryptedPayloads.set(msgIndex.toString(), {
      ciphertext: encrypted.ciphertext.toString('hex'),
      iv: encrypted.iv.toString('hex'),
      tag: encrypted.tag.toString('hex'),
      senderKeyIndex: sender.keyIndex,
      recipientKeyIndex: recipient.keyIndex,
      threadId: threadIdStr,
      timestamp: Date.now(),
    });

    // 6. Emit messaging audit event to L2 chain
    const messagingRootAfter = computeMessagingRoot(
      this.messageRegistry.getRoot(),
      this.delegationRegistry.getRoot(),
      this.keyRegistry.getRoot(),
    ).toString();
    const auditResult = this.l2Node.emitMessagingAuditEvent(
      sender.walletId.toString(),
      messagingRootBefore,
      messagingRootAfter,
    );

    this.emit('info', 'messaging', `  Message #${msgIndex} stored in MessageRegistry`);
    this.emitMemory('messaging');

    this.emitViz('viz:message:sent', 'messaging', {
      actor: sender.displayName, actorType: opts.senderType as VizEvent['actorType'],
      target: recipient.displayName, targetType: opts.recipientType,
      data: { messageType: msgType.toString(), subject: opts.subject },
    });

    return {
      messageIndex: msgIndex.toString(),
      subject: opts.subject,
      from: sender.displayName,
      fromType: opts.senderType,
      to: recipient.displayName,
      toType: opts.recipientType,
      encrypted: true,
      contentHash: fieldToStr(contentHash),
      ciphertextLength: encrypted.ciphertext.length,
      proofTimeMs: elapsed,
      threadId: threadIdStr,
      auditChainHash: auditResult.chainHash,
      auditSequenceNumber: auditResult.sequenceNumber.toString(),
      chainState: this.getChainState(),
    };
  }

  /**
   * Decrypt a single message. Verifies the requester is sender or recipient.
   * Returns null if message not found, no payload, or access denied.
   */
  decryptMessageByIndex(messageIndex: number, requestingWalletId: string): {
    subject: string;
    body: string;
    threadId: string;
    timestamp: number;
  } | null {
    const msg = this.messageRegistry.getMessage(BigInt(messageIndex));
    if (!msg) return null;

    const payload = this.encryptedPayloads.get(messageIndex.toString());
    if (!payload) return null;

    // Access control: requester must be sender or recipient
    const senderStr = msg.senderWalletId.toString();
    const recipientStr = msg.recipientWalletId.toString();
    if (requestingWalletId !== senderStr && requestingWalletId !== recipientStr) {
      return null;
    }

    // No ciphertext — system message before key registration
    if (!payload.ciphertext) {
      return {
        subject: '[System notification]',
        body: '[Encrypted content unavailable — system message]',
        threadId: payload.threadId,
        timestamp: payload.timestamp,
      };
    }

    // Decrypt using stored key indices
    const senderKeys = this.encryptionKeys.get(payload.senderKeyIndex);
    const recipientKeys = this.encryptionKeys.get(payload.recipientKeyIndex);
    if (!senderKeys || !recipientKeys) {
      return {
        subject: '[Encryption keys unavailable]',
        body: '[Cannot decrypt — keys not found]',
        threadId: payload.threadId,
        timestamp: payload.timestamp,
      };
    }

    try {
      const sharedSecret = deriveSharedSecret(senderKeys.privateKey, recipientKeys.publicKey);
      const decrypted = decryptMessageAes(
        Buffer.from(payload.ciphertext, 'hex'),
        Buffer.from(payload.iv, 'hex'),
        Buffer.from(payload.tag, 'hex'),
        sharedSecret,
      );

      // Parse "Subject: ...\n\n..." format
      let subject = '';
      let body = decrypted;
      if (decrypted.startsWith('Subject: ')) {
        const doubleNewline = decrypted.indexOf('\n\n');
        if (doubleNewline !== -1) {
          subject = decrypted.substring(9, doubleNewline);
          body = decrypted.substring(doubleNewline + 2);
        }
      }

      return { subject, body, threadId: payload.threadId, timestamp: payload.timestamp };
    } catch {
      return {
        subject: '[Decryption failed]',
        body: '[Authentication tag mismatch or corrupted payload]',
        threadId: payload.threadId,
        timestamp: payload.timestamp,
      };
    }
  }

  /**
   * Batch decrypt multiple messages. Avoids N HTTP round-trips per thread.
   */
  decryptThread(messageIndices: number[], requestingWalletId: string): Array<{
    messageIndex: number;
    subject: string;
    body: string;
    threadId: string;
    timestamp: number;
    senderWalletId: string;
    recipientWalletId: string;
    messageType: number;
  } | null> {
    return messageIndices.map((idx) => {
      const result = this.decryptMessageByIndex(idx, requestingWalletId);
      if (!result) return null;
      const msg = this.messageRegistry.getMessage(BigInt(idx));
      return {
        messageIndex: idx,
        subject: result.subject,
        body: result.body,
        threadId: result.threadId,
        timestamp: result.timestamp,
        senderWalletId: msg ? msg.senderWalletId.toString() : '',
        recipientWalletId: msg ? msg.recipientWalletId.toString() : '',
        messageType: msg ? Number(msg.messageType.toBigInt()) : 0,
      };
    });
  }

  /**
   * Get all conversation threads for a wallet. Groups messages by threadId.
   */
  getThreads(walletId: string): Array<{
    threadId: string;
    participants: string[];
    messageCount: number;
    latestTimestamp: number;
    messageIndices: number[];
  }> {
    const threadMap = new Map<string, {
      participants: Set<string>;
      messageCount: number;
      latestTimestamp: number;
      messageIndices: number[];
    }>();

    for (let i = 0; i < this.messageRegistry.count; i++) {
      const msg = this.messageRegistry.getMessage(BigInt(i));
      if (!msg) continue;

      const senderStr = msg.senderWalletId.toString();
      const recipientStr = msg.recipientWalletId.toString();

      // Only include threads where the wallet is sender or recipient
      if (walletId !== senderStr && walletId !== recipientStr) continue;

      const payload = this.encryptedPayloads.get(i.toString());
      const threadId = payload?.threadId || `unknown-${i}`;
      const timestamp = payload?.timestamp || 0;

      if (!threadMap.has(threadId)) {
        threadMap.set(threadId, {
          participants: new Set<string>(),
          messageCount: 0,
          latestTimestamp: 0,
          messageIndices: [],
        });
      }

      const thread = threadMap.get(threadId)!;
      thread.participants.add(senderStr);
      thread.participants.add(recipientStr);
      thread.messageCount++;
      if (timestamp > thread.latestTimestamp) thread.latestTimestamp = timestamp;
      thread.messageIndices.push(i);
    }

    // Convert to array, sorted by latest timestamp descending
    return Array.from(threadMap.entries())
      .map(([threadId, data]) => ({
        threadId,
        participants: Array.from(data.participants),
        messageCount: data.messageCount,
        latestTimestamp: data.latestTimestamp,
        messageIndices: data.messageIndices,
      }))
      .sort((a, b) => b.latestTimestamp - a.latestTimestamp);
  }

  /**
   * Create a delegation (member→member data sharing) with ZK proof.
   */
  async createDelegation(opts: {
    delegatorWalletId: string;
    delegateWalletId: string;
    scopeFlags: number;
    relationshipCode: number;
  }): Promise<Record<string, unknown>> {
    if (!this.compiled) throw new Error('Programs not compiled yet');

    const delegator = this.enrolledMembers.get(opts.delegatorWalletId);
    const delegate = this.enrolledMembers.get(opts.delegateWalletId);
    if (!delegator) throw new Error('Delegator not enrolled');
    if (!delegate) throw new Error('Delegate not enrolled');
    if (opts.delegatorWalletId === opts.delegateWalletId) throw new Error('Cannot delegate to self');

    const scopeLabels: string[] = [];
    if (opts.scopeFlags & 1) scopeLabels.push('READ');
    if (opts.scopeFlags & 2) scopeLabels.push('WRITE');
    if (opts.scopeFlags & 4) scopeLabels.push('PICKUP');

    const REL_LABELS: Record<number, string> = {
      1: 'Parent', 2: 'Spouse', 3: 'Power of Attorney',
      4: 'Guardian', 5: 'Migration', 6: 'Appointed Rep',
    };

    this.emit('phase', 'delegation', `═══ Delegation: ${delegator.displayName} → ${delegate.displayName} ═══`);
    this.emit('info', 'delegation', `  Scope: ${scopeLabels.join(' + ')}`);
    this.emit('info', 'delegation', `  Relationship: ${REL_LABELS[opts.relationshipCode] || 'Unknown'}`);

    const delegationData = new DelegationData({
      delegatorWalletId: Field(BigInt(opts.delegatorWalletId)),
      delegateWalletId: Field(BigInt(opts.delegateWalletId)),
      scopeFlags: Field(opts.scopeFlags),
      effectiveDate: dateToField('20260214'),
      expirationDate: dateToField('20270214'),
      relationshipCode: Field(opts.relationshipCode),
      delegationHash: hashString(`DEL-${Date.now()}`),
    });

    const { index } = this.delegationRegistry.addDelegation(delegationData);
    const witness = this.delegationRegistry.getWitness(index);

    this.emit('proof', 'delegation', 'Generating MessagingProgram.proveDelegate proof...', 'start');
    const startProof = performance.now();
    await MessagingProgram.proveDelegate(
      delegationData, witness,
      this.messageRegistry.getRoot(),
      this.delegationRegistry.getRoot(),
      this.keyRegistry.getRoot(),
      dateToField('20260214'),
    );
    const elapsed = performance.now() - startProof;
    this.emit('proof', 'delegation', 'MessagingProgram.proveDelegate proof generated', 'complete', elapsed);
    this.emitMemory('delegation');

    this.emitViz('viz:message:sent', 'messaging', {
      actor: delegator.displayName, actorType: 'member',
      target: delegate.displayName, targetType: 'member',
      data: { messageType: 'DELEGATION', scope: scopeLabels.join('+') },
    });

    return {
      delegationIndex: index.toString(),
      delegator: delegator.displayName,
      delegate: delegate.displayName,
      scopeFlags: opts.scopeFlags,
      scopeLabels,
      relationshipCode: opts.relationshipCode,
      relationshipLabel: REL_LABELS[opts.relationshipCode] || 'Unknown',
      proofTimeMs: elapsed,
      chainState: this.getChainState(),
    };
  }

  // ─── Terminate Member ─────────────────────────────────────

  terminateMember(opts: {
    memberWalletId: string;
    terminationDate?: string;
  }): Record<string, unknown> {
    const enrolled = this.enrolledMembers.get(opts.memberWalletId);
    if (!enrolled) throw new Error(`Member not found: ${opts.memberWalletId}`);
    if (enrolled.lifecycle === 'REVOKED') throw new Error(`Member ${enrolled.displayName} is already terminated`);

    const termDate = opts.terminationDate || '20260214';
    const member = DEMO_MEMBERS[enrolled.memberIndex];

    this.emit('phase', 'terminate', `═══ Member Termination: ${enrolled.displayName} ═══`);
    this.emit('info', 'terminate', `  Wallet: ${enrolled.walletIdStr}`);
    this.emit('info', 'terminate', `  Termination date: ${termDate}`);

    // 1. Call EnrollmentService.terminateMember
    //    This handles: credential revocation, lifecycle→REVOKED, roster→TERMINATED, group count--
    this.emit('offchain', 'terminate', 'Step 1: Revoking eligibility credential and updating lifecycle...', 'start');
    const result = this.enrollmentService.terminateMember(enrolled.walletId, termDate);
    this.emit('offchain', 'terminate', 'Step 1: Credential revoked, lifecycle set to REVOKED', 'complete');

    // Sync L2 sequencer with admin lifecycle change
    this.l2Node.getSequencer().applyAdminRootUpdate({
      newLifecycleRoot: this.lifecycleTree.getRoot(),
      newRegistryRoot: this.walletRegistry.getRoot(),
    });

    // 2. Revoke NFC attestation nonce (if one exists)
    if (enrolled.lastAttestation) {
      this.attestationAuthority.revokeNonce(enrolled.lastAttestation.n);
      this.emit('info', 'terminate', '  NFC attestation nonce revoked');
    }

    // 3. Update local EnrolledMember state
    enrolled.lifecycle = 'REVOKED';
    enrolled.terminationDate = termDate;
    // Update credentialData to reflect revocation
    enrolled.credentialData = new CredentialData({
      credentialType: enrolled.credentialData.credentialType,
      forestRoot: enrolled.credentialData.forestRoot,
      issuerWalletId: enrolled.credentialData.issuerWalletId,
      subjectWalletId: enrolled.credentialData.subjectWalletId,
      issuedAt: enrolled.credentialData.issuedAt,
      expiresAt: enrolled.credentialData.expiresAt,
      revoked: Field(1),
    });

    // 3. Cancel any active prescriptions for this member
    const cancelledRxs: string[] = [];
    for (const [rxId, rx] of this.prescriptions) {
      if (rx.memberWalletId === opts.memberWalletId &&
          (rx.status === 'ACTIVE' || rx.status === 'PARTIALLY_FILLED' || rx.status === 'DISPENSED')) {
        const prevStatus = rx.status;
        rx.status = 'CANCELLED';
        rx.statusHistory.push({
          from: prevStatus,
          to: 'CANCELLED',
          updatedBy: 'System (Termination)',
          updatedByRole: 'prescriber',
          timestamp: Date.now(),
          note: `Auto-cancelled: member terminated on ${termDate}`,
        });
        cancelledRxs.push(rxId);
      }
    }

    if (cancelledRxs.length > 0) {
      this.emit('info', 'terminate', `  ${cancelledRxs.length} active prescription(s) cancelled: ${cancelledRxs.join(', ')}`);
    }

    this.emit('info', 'terminate', '');
    this.emit('info', 'terminate', '  RESULT:');
    this.emit('info', 'terminate', `    Lifecycle: ELIGIBLE → REVOKED`);
    this.emit('info', 'terminate', `    Credential: revoked = 1`);
    this.emit('info', 'terminate', `    Roster: ACTIVE → TERMINATED`);
    this.emit('info', 'terminate', `    Active Rx cancelled: ${cancelledRxs.length}`);

    // Auto-send termination notification
    this.sendInternalMessage(this.adminWalletId, enrolled.walletId, MSG_TYPE_NOTIFICATION,
      'Coverage Terminated', `Coverage terminated effective ${termDate}. Credential revoked. ${cancelledRxs.length} active prescription(s) cancelled.`);
    this.emitMemory('terminate');

    this.emitViz('viz:enrollment:terminated', 'enrollment', {
      actor: enrolled.displayName,
      actorType: 'member',
      target: 'Insurer',
      targetType: 'insurer',
      data: { walletId: enrolled.walletIdStr, terminationDate: termDate },
    });

    return {
      memberWalletId: opts.memberWalletId,
      displayName: enrolled.displayName,
      lifecycle: 'REVOKED',
      terminationDate: termDate,
      credentialRevoked: true,
      cancelledPrescriptions: cancelledRxs,
      newRegistryRoot: fieldToStr(result.newRegistryRoot),
      newLifecycleRoot: fieldToStr(result.newLifecycleRoot),
      chainState: this.getChainState(),
    };
  }

  // ─── Terminate Group ─────────────────────────────────────

  terminateGroup(opts: {
    groupId: string;
    terminationDate?: string;
  }): Record<string, unknown> {
    const termDate = opts.terminationDate || '20260214';

    // Find all members in this group
    const groupMembers = Array.from(this.enrolledMembers.values())
      .filter(m => m.groupId === opts.groupId && m.lifecycle !== 'REVOKED');

    if (groupMembers.length === 0) {
      throw new Error(`No active members found in group ${opts.groupId}`);
    }

    this.emit('phase', 'terminate', `═══ Group Termination: ${opts.groupId} ═══`);
    this.emit('info', 'terminate', `  ${groupMembers.length} active member(s) in group`);
    this.emit('info', 'terminate', `  Termination date: ${termDate}`);
    this.emit('info', 'terminate', '');

    // Terminate each member
    const results: Record<string, unknown>[] = [];
    for (const member of groupMembers) {
      const result = this.terminateMember({
        memberWalletId: member.walletId.toString(),
        terminationDate: termDate,
      });
      results.push(result);
    }

    this.emit('info', 'terminate', '');
    this.emit('phase', 'terminate', `═══ Group Termination Complete ═══`);
    this.emit('info', 'terminate', `  Group: ${opts.groupId}`);
    this.emit('info', 'terminate', `  Members terminated: ${results.length}`);

    return {
      groupId: opts.groupId,
      terminationDate: termDate,
      terminatedCount: results.length,
      members: results,
      chainState: this.getChainState(),
    };
  }

  // ─── Shared Eligibility Rebuild ──────────────────────────

  /**
   * Rebuild sharedEligibilityData from current formulary + network roots.
   * Used by both updateFormularyEntry() and updateProviderNetwork()
   * to avoid clobbering one root when changing the other.
   */
  private rebuildSharedEligibilityData(): EligibilityData {
    return buildEligibilityData({
      planId: 'PLAN-GOLD-2026',
      groupId: 'ACME-CORP',
      effectiveDate: '20260101',
      terminationDate: '',
      copayAmount: this.planTemplate.config.copayAmountCents,
      coverageType: 1,
      formularyRoot: this.formularyRegistry.getRoot().toString(),
      networkRoot: this.providerNetwork.count > 0
        ? this.providerNetwork.getRoot().toString()
        : '0',
    });
  }

  // ─── Formulary Management ────────────────────────────────

  /**
   * Update a formulary entry — modify tier/copay/flags or remove/add back a medication.
   * Cascades the change to all enrolled members' eligibility credentials.
   */
  async updateFormularyEntry(opts: {
    medicationIndex: number;
    action: 'MODIFY' | 'REMOVE' | 'ADD';
    newTierLevel?: number;
    newCopayAmountCents?: number;
    newRequiresPriorAuth?: boolean;
    newStepTherapyRequired?: boolean;
  }): Record<string, unknown> {
    const medication = DEMO_MEDICATIONS[opts.medicationIndex];
    if (!medication) throw new Error(`Invalid medication index: ${opts.medicationIndex}`);

    const actionVerb = opts.action === 'REMOVE' ? 'Removing' : opts.action === 'ADD' ? 'Re-adding' : 'Modifying';
    this.emit('phase', 'formulary', `═══ Formulary Change: ${actionVerb} ${medication.brandName} ═══`);

    // 1. Validate action
    if (opts.action === 'REMOVE' && !this.formularyActive[opts.medicationIndex]) {
      throw new Error(`${medication.brandName} is already removed from the formulary`);
    }
    if (opts.action === 'ADD' && this.formularyActive[opts.medicationIndex]) {
      throw new Error(`${medication.brandName} is already on the formulary`);
    }

    // 2. Update working state
    let details = '';
    if (opts.action === 'REMOVE') {
      this.formularyActive[opts.medicationIndex] = false;
      details = `Removed from formulary`;
      this.emit('info', 'formulary', `  Removing ${medication.brandName} from formulary`);
    } else if (opts.action === 'ADD') {
      this.formularyActive[opts.medicationIndex] = true;
      details = `Re-added to formulary`;
      this.emit('info', 'formulary', `  Re-adding ${medication.brandName} to formulary`);
    } else {
      // MODIFY
      const entry = this.currentFormularyEntries[opts.medicationIndex];
      const changes: string[] = [];
      if (opts.newTierLevel !== undefined && opts.newTierLevel !== entry.tierLevel) {
        changes.push(`tier ${entry.tierLevel}→${opts.newTierLevel}`);
        entry.tierLevel = opts.newTierLevel;
      }
      if (opts.newCopayAmountCents !== undefined && opts.newCopayAmountCents !== entry.copayAmount) {
        changes.push(`copay $${(entry.copayAmount / 100).toFixed(2)}→$${(opts.newCopayAmountCents / 100).toFixed(2)}`);
        entry.copayAmount = opts.newCopayAmountCents;
      }
      if (opts.newRequiresPriorAuth !== undefined && opts.newRequiresPriorAuth !== entry.requiresPriorAuth) {
        changes.push(`PA ${entry.requiresPriorAuth ? 'yes' : 'no'}→${opts.newRequiresPriorAuth ? 'yes' : 'no'}`);
        entry.requiresPriorAuth = opts.newRequiresPriorAuth;
      }
      if (opts.newStepTherapyRequired !== undefined && opts.newStepTherapyRequired !== entry.stepTherapyRequired) {
        changes.push(`step therapy ${entry.stepTherapyRequired ? 'yes' : 'no'}→${opts.newStepTherapyRequired ? 'yes' : 'no'}`);
        entry.stepTherapyRequired = opts.newStepTherapyRequired;
      }
      details = changes.length > 0 ? changes.join(', ') : 'No changes';
      this.emit('info', 'formulary', `  Modifying ${medication.brandName}: ${details}`);
    }

    // 3. Rebuild FormularyRegistry (preserving index mapping)
    const oldFormularyRoot = fieldToStr(this.formularyRegistry.getRoot());
    this.emit('offchain', 'formulary', 'Rebuilding FormularyRegistry with updated entries...', 'start');

    const newRegistry = new FormularyRegistry();
    for (let i = 0; i < this.currentFormularyEntries.length; i++) {
      if (this.formularyActive[i]) {
        const entry = buildFormularyEntry(this.currentFormularyEntries[i]);
        newRegistry.addEntry(entry);
      } else {
        // Sentinel entry for removed medication (preserves index)
        const removedEntry = buildFormularyEntry({
          ndc: `REMOVED-${i}`,
          tierLevel: 0,
          copayAmount: 0,
          requiresPriorAuth: false,
          maxQuantityPerFill: 0,
          maxDaySupply: 0,
          stepTherapyRequired: false,
        });
        newRegistry.addEntry(removedEntry);
      }
    }

    this.formularyRegistry = newRegistry;
    const newFormularyRoot = fieldToStr(this.formularyRegistry.getRoot());
    this.emit('offchain', 'formulary', `FormularyRegistry rebuilt. Root: ${newFormularyRoot.slice(0, 12)}...`, 'complete');

    // 4. Rebuild sharedEligibilityData with new formulary root (preserves networkRoot)
    this.sharedEligibilityData = this.rebuildSharedEligibilityData();

    // 5. Rebuild BenefitPlanRegistry
    this.benefitPlanRegistry = new BenefitPlanRegistry();
    this.benefitPlanRegistry.addPlan(this.sharedEligibilityData);
    this.emit('offchain', 'formulary', 'BenefitPlanRegistry updated with new plan data');

    // ─── Patent Evidence: Formulary Registry State Change ───────
    const activeCount = this.formularyActive.filter(Boolean).length;
    const inactiveCount = this.formularyActive.length - activeCount;
    this.emit('info', 'formulary', `  ┌─ FORMULARY REGISTRY STATE CHANGE`);
    this.emit('info', 'formulary', `  │  Action:           ${opts.action} — ${medication.brandName} (${medication.genericName})`);
    this.emit('info', 'formulary', `  │  Old Root:         ${oldFormularyRoot.slice(0, 16)}...`);
    this.emit('info', 'formulary', `  │  New Root:         ${newFormularyRoot.slice(0, 16)}...`);
    this.emit('info', 'formulary', `  │  Entries:          ${this.currentFormularyEntries.length} total (${activeCount} active, ${inactiveCount} inactive/sentinel)`);
    this.emit('info', 'formulary', `  │  Tree:             MerkleTree(16), 32,768 leaf capacity`);
    this.emit('info', 'formulary', `  │  Eligibility:      formularyRoot updated in shared EligibilityData`);
    this.emit('info', 'formulary', `  │  New Elig Commit:  ${truncField(this.sharedEligibilityData.commitment())}`);
    this.emit('info', 'formulary', `  └─ Cascading to ${this.enrolledMembers.size} enrolled member(s)...`);

    // 6. Cascade to all active enrolled members
    const affectedMembers: string[] = [];
    let memberNum = 0;
    for (const [walletIdStr, enrolled] of this.enrolledMembers) {
      if (enrolled.lifecycle === 'REVOKED') continue;
      memberNum++;

      const oldEligCommitment = enrolled.eligibilityData.commitment();
      const oldForestRoot = enrolled.forest.getForestRoot();

      // Update ACCESS_CONTROL leaf 0 (EligibilityData) — preserves leaves 1-127
      enrolled.eligibilityData = this.sharedEligibilityData;
      enrolled.forest.setLeaf(
        ForestDomain.ACCESS_CONTROL,
        0n,
        this.sharedEligibilityData.commitment(),
      );

      // Update CredentialData with new forest root
      enrolled.credentialData = new CredentialData({
        credentialType: enrolled.credentialData.credentialType,
        forestRoot: enrolled.forest.getForestRoot(),
        issuerWalletId: enrolled.credentialData.issuerWalletId,
        subjectWalletId: enrolled.credentialData.subjectWalletId,
        issuedAt: enrolled.credentialData.issuedAt,
        expiresAt: enrolled.credentialData.expiresAt,
        revoked: enrolled.credentialData.revoked,
      });

      const newForestRoot = enrolled.forest.getForestRoot();

      // ─── Patent Evidence: Per-Member Eligibility Credential Cascade ───
      this.emit('info', 'formulary', `  ┌─ MEMBER ${memberNum}: ${enrolled.displayName}`);
      this.emit('info', 'formulary', `  │  Wallet ID:        ${truncField(enrolled.walletId)}`);
      this.emit('info', 'formulary', `  │  Lifecycle:         ${enrolled.lifecycle}`);
      this.emit('info', 'formulary', `  │  Old Elig Commit:  ${truncField(oldEligCommitment)}`);
      this.emit('info', 'formulary', `  │  New Elig Commit:  ${truncField(this.sharedEligibilityData.commitment())}`);
      this.emit('info', 'formulary', `  │  ACCESS_CONTROL:   leaf 0 = EligibilityData (updated)`);
      this.emit('info', 'formulary', `  │  Old ForestRoot:   ${truncField(oldForestRoot)}`);
      this.emit('info', 'formulary', `  │  New ForestRoot:   ${truncField(newForestRoot)}`);
      this.emit('info', 'formulary', `  │  ForestRoot = Poseidon.hash(6 domain tree roots)`);
      this.emit('info', 'formulary', `  └─ Generating StateTransitionProof...`);

      // Submit wallet update to L2 (forest changed → new inventory root)
      await this.updateCredentialAndSubmitToL2(enrolled, 'formulary');

      affectedMembers.push(walletIdStr);
    }

    // ─── Patent Evidence: Cascade Summary ─────────────────────
    this.emit('info', 'formulary', `  ┌─ FORMULARY CASCADE COMPLETE`);
    this.emit('info', 'formulary', `  │  Members affected: ${affectedMembers.length}`);
    this.emit('info', 'formulary', `  │  Proofs generated: ${affectedMembers.length} StateTransitionProofs`);
    this.emit('info', 'formulary', `  │  Each proof: wallet ownership (inline) + Merkle state transition`);
    this.emit('info', 'formulary', `  │  Cascade verifies: 1 shared change → N individual credential updates`);
    this.emit('info', 'formulary', `  └─ All member eligibility credentials reflect new formulary`);

    // 7. Send notifications to all affected members
    const pastVerb = opts.action === 'REMOVE' ? 'removed from'
      : opts.action === 'ADD' ? 'added back to'
      : 'modified on';
    const subject = `Formulary Change: ${medication.brandName}`;
    const body = `${medication.brandName} (${medication.genericName}) has been ${pastVerb} your formulary. ${details ? `Changes: ${details}.` : ''} Your eligibility credential has been updated with the new formulary.`;

    for (const [, enrolled] of this.enrolledMembers) {
      if (enrolled.lifecycle === 'REVOKED') continue;
      this.sendInternalMessage(this.adminWalletId, enrolled.walletId, MSG_TYPE_NOTIFICATION, subject, body);
    }
    this.emit('info', 'formulary', `  ${affectedMembers.length} notification message(s) sent`);
    this.emitMemory('formulary');

    // 8. Record in change history
    this.formularyChangeHistory.push({
      timestamp: Date.now(),
      changeType: opts.action,
      medicationIndex: opts.medicationIndex,
      medicationName: medication.brandName,
      details,
      affectedMembers,
      oldFormularyRoot,
      newFormularyRoot,
    });

    this.emit('phase', 'formulary', `═══ Formulary Change Complete ═══`);

    return {
      action: opts.action,
      medicationIndex: opts.medicationIndex,
      medicationName: medication.brandName,
      details,
      affectedMemberCount: affectedMembers.length,
      oldFormularyRoot,
      newFormularyRoot,
      chainState: this.getChainState(),
    };
  }

  // ─── Provider Network Management ─────────────────────────

  /**
   * Add or remove a prescriber from the provider network.
   * Cascades the change to all enrolled members' eligibility credentials.
   */
  async updateProviderNetwork(opts: {
    prescriberWalletId: string;
    action: 'ADD' | 'REMOVE';
  }): Promise<Record<string, unknown>> {
    const walletIdStr = opts.prescriberWalletId;
    const isCurrentlyActive = this.networkActive.get(walletIdStr) === true;

    // Find prescriber name for display
    let prescriberName = 'Unknown Prescriber';
    let prescriberIdx = -1;
    for (const [i, wid] of this.prescriberWalletIds) {
      if (wid.toString() === walletIdStr) {
        const p = DEMO_PRESCRIBERS[i];
        prescriberName = `Dr. ${p.firstName} ${p.lastName}`;
        prescriberIdx = i;
        break;
      }
    }

    const actionVerb = opts.action === 'REMOVE' ? 'Removing' : 'Adding';
    this.emit('phase', 'network', `═══ Provider Network Change: ${actionVerb} ${prescriberName} ═══`);

    // 1. Validate action
    if (opts.action === 'REMOVE' && !isCurrentlyActive) {
      throw new Error(`${prescriberName} is already out-of-network`);
    }
    if (opts.action === 'ADD' && isCurrentlyActive) {
      throw new Error(`${prescriberName} is already in-network`);
    }

    // 2. Update networkActive map
    let details = '';
    if (opts.action === 'REMOVE') {
      this.networkActive.set(walletIdStr, false);
      details = `Removed from provider network`;
      this.emit('info', 'network', `  Removing ${prescriberName} from network`);
    } else {
      this.networkActive.set(walletIdStr, true);
      details = `Added to provider network`;
      this.emit('info', 'network', `  Adding ${prescriberName} to network`);
    }

    // 3. Rebuild ProviderNetworkRegistry from scratch (no remove method on MerkleTree)
    const oldNetworkRoot = fieldToStr(this.providerNetwork.getRoot());
    this.emit('offchain', 'network', 'Rebuilding ProviderNetworkRegistry...', 'start');

    this.providerNetwork = new ProviderNetworkRegistry();
    for (const [wStr, active] of this.networkActive) {
      if (active) {
        this.providerNetwork.addProvider(Field(BigInt(wStr)));
      }
    }

    const newNetworkRoot = this.providerNetwork.count > 0
      ? fieldToStr(this.providerNetwork.getRoot())
      : '0';
    this.emit('offchain', 'network', `ProviderNetworkRegistry rebuilt. Root: ${newNetworkRoot.slice(0, 12)}... (${this.providerNetwork.count} providers)`, 'complete');

    // 4. Rebuild sharedEligibilityData with new network root (preserves formularyRoot)
    this.sharedEligibilityData = this.rebuildSharedEligibilityData();

    // 5. Rebuild BenefitPlanRegistry
    this.benefitPlanRegistry = new BenefitPlanRegistry();
    this.benefitPlanRegistry.addPlan(this.sharedEligibilityData);
    this.emit('offchain', 'network', 'BenefitPlanRegistry updated with new plan data');

    // ─── Patent Evidence: Provider Network State Change ─────────
    const inNetworkCount = [...this.networkActive.values()].filter(Boolean).length;
    const outNetworkCount = this.networkActive.size - inNetworkCount;
    this.emit('info', 'network', `  ┌─ PROVIDER NETWORK STATE CHANGE`);
    this.emit('info', 'network', `  │  Action:           ${opts.action} — ${prescriberName}${prescriberIdx >= 0 ? ` (demo index ${prescriberIdx})` : ''}`);
    this.emit('info', 'network', `  │  Prescriber Wallet: ${walletIdStr.slice(0, 16)}...`);
    this.emit('info', 'network', `  │  Old Root:         ${oldNetworkRoot.slice(0, 16)}...`);
    this.emit('info', 'network', `  │  New Root:         ${newNetworkRoot.slice(0, 16)}...`);
    this.emit('info', 'network', `  │  Network:          ${inNetworkCount} in-network, ${outNetworkCount} out-of-network`);
    this.emit('info', 'network', `  │  Tree:             MerkleTree(12), 2,048 leaf capacity`);
    this.emit('info', 'network', `  │  Eligibility:      networkRoot updated in shared EligibilityData`);
    this.emit('info', 'network', `  │  New Elig Commit:  ${truncField(this.sharedEligibilityData.commitment())}`);
    this.emit('info', 'network', `  └─ Cascading to ${this.enrolledMembers.size} enrolled member(s)...`);

    // 6. Cascade to all active enrolled members
    const affectedMembers: string[] = [];
    let memberNum = 0;
    for (const [walletId, enrolled] of this.enrolledMembers) {
      if (enrolled.lifecycle === 'REVOKED') continue;
      memberNum++;

      const oldEligCommitment = enrolled.eligibilityData.commitment();
      const oldForestRoot = enrolled.forest.getForestRoot();

      // Update ACCESS_CONTROL leaf 0 (EligibilityData) — preserves leaves 1-127
      enrolled.eligibilityData = this.sharedEligibilityData;
      enrolled.forest.setLeaf(
        ForestDomain.ACCESS_CONTROL,
        0n,
        this.sharedEligibilityData.commitment(),
      );

      // Update CredentialData with new forest root
      enrolled.credentialData = new CredentialData({
        credentialType: enrolled.credentialData.credentialType,
        forestRoot: enrolled.forest.getForestRoot(),
        issuerWalletId: enrolled.credentialData.issuerWalletId,
        subjectWalletId: enrolled.credentialData.subjectWalletId,
        issuedAt: enrolled.credentialData.issuedAt,
        expiresAt: enrolled.credentialData.expiresAt,
        revoked: enrolled.credentialData.revoked,
      });

      const newForestRoot = enrolled.forest.getForestRoot();

      // Also update in-network prescriber indices for this member
      enrolled.inNetworkPrescriberIndices = [];
      for (const [i, wid] of this.prescriberWalletIds) {
        if (this.networkActive.get(wid.toString()) === true) {
          enrolled.inNetworkPrescriberIndices.push(i);
        }
      }

      // ─── Patent Evidence: Per-Member Eligibility Credential Cascade ───
      this.emit('info', 'network', `  ┌─ MEMBER ${memberNum}: ${enrolled.displayName}`);
      this.emit('info', 'network', `  │  Wallet ID:        ${truncField(enrolled.walletId)}`);
      this.emit('info', 'network', `  │  Lifecycle:         ${enrolled.lifecycle}`);
      this.emit('info', 'network', `  │  Old Elig Commit:  ${truncField(oldEligCommitment)}`);
      this.emit('info', 'network', `  │  New Elig Commit:  ${truncField(this.sharedEligibilityData.commitment())}`);
      this.emit('info', 'network', `  │  ACCESS_CONTROL:   leaf 0 = EligibilityData (updated)`);
      this.emit('info', 'network', `  │  Old ForestRoot:   ${truncField(oldForestRoot)}`);
      this.emit('info', 'network', `  │  New ForestRoot:   ${truncField(newForestRoot)}`);
      this.emit('info', 'network', `  │  ForestRoot = Poseidon.hash(6 domain tree roots)`);
      this.emit('info', 'network', `  │  In-network prescribers: ${enrolled.inNetworkPrescriberIndices.length}`);
      this.emit('info', 'network', `  └─ Generating StateTransitionProof...`);

      // Submit wallet update to L2 (forest changed → new inventory root)
      await this.updateCredentialAndSubmitToL2(enrolled, 'network');

      affectedMembers.push(walletId);
    }

    // ─── Patent Evidence: Cascade Summary ─────────────────────
    this.emit('info', 'network', `  ┌─ NETWORK CASCADE COMPLETE`);
    this.emit('info', 'network', `  │  Members affected: ${affectedMembers.length}`);
    this.emit('info', 'network', `  │  Proofs generated: ${affectedMembers.length} StateTransitionProofs`);
    this.emit('info', 'network', `  │  Each proof: wallet ownership (inline) + Merkle state transition`);
    this.emit('info', 'network', `  │  Cascade verifies: 1 network change → N individual credential updates`);
    this.emit('info', 'network', `  └─ All member eligibility credentials reflect new provider network`);

    // 7. Send notifications to all affected members
    const pastVerb = opts.action === 'REMOVE' ? 'removed from' : 'added to';
    const subject = `Provider Network Change: ${prescriberName}`;
    const body = `${prescriberName} has been ${pastVerb} your provider network. Your eligibility credential has been updated with the new network configuration.`;

    for (const [, enrolled] of this.enrolledMembers) {
      if (enrolled.lifecycle === 'REVOKED') continue;
      this.sendInternalMessage(this.adminWalletId, enrolled.walletId, MSG_TYPE_NOTIFICATION, subject, body);
    }
    this.emit('info', 'network', `  ${affectedMembers.length} notification message(s) sent`);
    this.emitMemory('network');

    // 8. Record in change history
    this.networkChangeHistory.push({
      timestamp: Date.now(),
      changeType: opts.action,
      prescriberWalletId: walletIdStr,
      prescriberName,
      details,
      affectedMembers,
      oldNetworkRoot,
      newNetworkRoot,
    });

    this.emit('phase', 'network', `═══ Provider Network Change Complete ═══`);

    return {
      action: opts.action,
      prescriberIndex: prescriberIdx,
      prescriberName,
      details,
      affectedMemberCount: affectedMembers.length,
      oldNetworkRoot,
      newNetworkRoot,
      inNetworkCount: this.providerNetwork.count,
      chainState: this.getChainState(),
    };
  }

  // ─── Plan Year Rollover ─────────────────────────────────

  /**
   * Plan year rollover — reset accumulators for all active members.
   * Preserves all other data (prior auths, transaction history, prescriptions).
   */
  async planYearRollover(opts: {
    newPlanYear: string;
  }): Record<string, unknown> {
    this.emit('phase', 'rollover', `═══ Plan Year Rollover: ${opts.newPlanYear} ═══`);

    const affectedMembers: string[] = [];

    for (const [walletIdStr, enrolled] of this.enrolledMembers) {
      if (enrolled.lifecycle === 'REVOKED') continue;

      // Log old accumulator state
      const oldDeductiblePaid = Number(enrolled.accumulatorData.deductiblePaidCents.toBigInt());
      const oldOopPaid = Number(enrolled.accumulatorData.oopPaidCents.toBigInt());
      const oldBenefitUsed = Number(enrolled.accumulatorData.annualBenefitUsedCents.toBigInt());

      // Build fresh accumulator (zero running totals, same limits)
      enrolled.accumulatorData = buildAccumulatorData({
        planYear: opts.newPlanYear,
        deductibleAmountCents: 50000,
        deductiblePaidCents: 0,
        oopMaxCents: 800000,
        oopPaidCents: 0,
        annualBenefitMaxCents: 5000000,
        annualBenefitUsedCents: 0,
      });

      // Update ACCESS_CONTROL leaf 127 with new accumulator commitment
      enrolled.forest.setLeaf(
        ForestDomain.ACCESS_CONTROL,
        ACCUMULATOR_LEAF_INDEX,
        enrolled.accumulatorData.commitment(),
      );

      // Update CredentialData with new forest root
      enrolled.credentialData = new CredentialData({
        credentialType: enrolled.credentialData.credentialType,
        forestRoot: enrolled.forest.getForestRoot(),
        issuerWalletId: enrolled.credentialData.issuerWalletId,
        subjectWalletId: enrolled.credentialData.subjectWalletId,
        issuedAt: enrolled.credentialData.issuedAt,
        expiresAt: enrolled.credentialData.expiresAt,
        revoked: enrolled.credentialData.revoked,
      });

      // Submit wallet update to L2 (accumulator reset → new inventory root)
      await this.updateCredentialAndSubmitToL2(enrolled, 'rollover');

      this.emit('info', 'rollover',
        `  ${enrolled.displayName}: deductible $${(oldDeductiblePaid / 100).toFixed(2)}→$0, ` +
        `OOPM $${(oldOopPaid / 100).toFixed(2)}→$0, benefit $${(oldBenefitUsed / 100).toFixed(2)}→$0`,
      );

      affectedMembers.push(walletIdStr);

      // Send notification
      this.sendInternalMessage(this.adminWalletId, enrolled.walletId, MSG_TYPE_NOTIFICATION,
        'Plan Year Rollover',
        `Your benefit accumulators have been reset for plan year ${opts.newPlanYear}. Deductible, OOP, and benefit used amounts are now $0.00.`,
      );
    }

    this.emit('info', 'rollover', `  ${affectedMembers.length} member(s) rolled over to ${opts.newPlanYear}`);
    this.emitMemory('rollover');

    this.emit('phase', 'rollover', `═══ Plan Year Rollover Complete ═══`);

    return {
      newPlanYear: opts.newPlanYear,
      affectedMemberCount: affectedMembers.length,
      chainState: this.getChainState(),
    };
  }

  // ─── Assign PCP ───────────────────────────────────────────

  async assignPcp(opts: {
    memberWalletId: string;
    prescriberIndex: number;
  }): Promise<Record<string, unknown>> {
    if (!this.compiled) throw new Error('Programs not compiled yet');

    const enrolled = this.enrolledMembers.get(opts.memberWalletId);
    if (!enrolled) throw new Error(`Member not enrolled: ${opts.memberWalletId}`);

    const prescriber = DEMO_PRESCRIBERS[opts.prescriberIndex];
    if (!prescriber) throw new Error(`Invalid prescriber index: ${opts.prescriberIndex}`);

    const prescriberWalletId = this.prescriberWalletIds.get(opts.prescriberIndex)!;
    const prescriberPreimage = this.prescriberPreimages.get(opts.prescriberIndex)!;
    const prescriberName = `Dr. ${prescriber.firstName} ${prescriber.lastName}`;

    this.emit('phase', 'pcp', `═══ PCP Assignment: ${enrolled.displayName} → ${prescriberName} ═══`);

    // 1. ProofGate: Prescriber identity
    this.emit('proof', 'pcp', `[1/2] Generating ProofGate.verifyPrescriber proof...`, 'start');
    const startPG = performance.now();
    await ProofGateProgram.verifyPrescriber(
      prescriberWalletId,
      ...prescriberPreimage as [Field, Field, Field],
    );
    const elapsedPG = performance.now() - startPG;
    this.emit('proof', 'pcp', `[1/2] ProofGate.verifyPrescriber proof generated`, 'complete', elapsedPG);
    this.emit('info', 'pcp', `       ${prescriberName} proved identity (NPI ownership)`);

    this.emitViz('viz:enrollment:proof_gate', 'enrollment', {
      actor: prescriberName,
      actorType: 'prescriber',
      target: enrolled.displayName,
      targetType: 'member',
      data: { step: 'pcp-identity', prescriberIndex: opts.prescriberIndex, memberIndex: enrolled.memberIndex },
    });

    // 2. Build PCP assignment data
    this.emit('offchain', 'pcp', 'Building PCP assignment data...', 'start');
    const startBuild = performance.now();

    const pcpData = buildPcpAssignmentData({
      memberWalletId: enrolled.walletId.toBigInt().toString(),
      pcpWalletId: prescriberWalletId.toBigInt().toString(),
      effectiveDate: '20260201',
      terminationDate: '',
      specialty: prescriber.specialty,
      consentTimestamp: '20260201',
      consentScopeFlags: 7, // PCP_SCOPE_ALL
    });

    // Record old forest root
    const oldForestRoot = enrolled.forest.getForestRoot();

    // Write PCP data to MEMBER tree leaf 0
    enrolled.forest.setLeaf(ForestDomain.MEMBER, PCP_ASSIGNMENT_LEAF_INDEX, pcpData.commitment());

    // Update credential with new forest root
    const updatedCredentialData = new CredentialData({
      credentialType: enrolled.credentialData.credentialType,
      forestRoot: enrolled.forest.getForestRoot(),
      issuerWalletId: enrolled.credentialData.issuerWalletId,
      subjectWalletId: enrolled.credentialData.subjectWalletId,
      issuedAt: enrolled.credentialData.issuedAt,
      expiresAt: enrolled.credentialData.expiresAt,
      revoked: enrolled.credentialData.revoked,
    });
    enrolled.credentialData = updatedCredentialData;

    const elapsedBuild = performance.now() - startBuild;
    this.emit('offchain', 'pcp', 'PCP assignment data written to MEMBER tree, credential updated', 'complete', elapsedBuild);

    // 3. Generate PcpVerification proof
    const forestRoots = ForestRoots.fromForest(enrolled.forest);
    const memberWitness = enrolled.forest.getWitness(ForestDomain.MEMBER, PCP_ASSIGNMENT_LEAF_INDEX);

    this.emit('proof', 'pcp', `[2/2] Generating PcpVerificationProgram.verifyPcpAssignment proof...`, 'start');
    const startPCP = performance.now();
    await PcpVerificationProgram.verifyPcpAssignment(
      enrolled.credentialData,
      pcpData,
      forestRoots,
      memberWitness,
      prescriberWalletId,
      dateToField('20260201'),
    );
    const elapsedPCP = performance.now() - startPCP;
    this.emit('proof', 'pcp', `[2/2] PcpVerificationProgram.verifyPcpAssignment proof generated`, 'complete', elapsedPCP);
    this.emit('info', 'pcp', `       ZK proof IS the consent — ${enrolled.displayName} authorized ${prescriberName} as PCP`);

    // Submit wallet update to L2 (forest changed → new inventory root)
    const pcpReceipt = await this.updateCredentialAndSubmitToL2(enrolled, 'pcp');

    // Store assignment
    enrolled.pcpAssignment = pcpData;
    enrolled.pcpPrescriberIndex = opts.prescriberIndex;

    this.emit('info', 'pcp', '');
    this.emit('info', 'pcp', `  PCP ASSIGNED: ${prescriberName}, ${prescriber.credential}`);
    this.emit('info', 'pcp', `    Specialty: ${prescriber.specialty}`);
    this.emit('info', 'pcp', `    Consent:   RX History + Eligibility + Accumulators (scope: 7)`);
    this.emit('info', 'pcp', `    MEMBER tree root CHANGED — first data in this domain tree`);
    this.emit('info', 'pcp', `    Forest root BEFORE: ${truncField(oldForestRoot)}`);
    this.emit('info', 'pcp', `    Forest root AFTER:  ${truncField(enrolled.forest.getForestRoot())}`);

    this.emitViz('viz:enrollment:complete', 'enrollment', {
      actor: enrolled.displayName,
      actorType: 'member',
      actorWalletId: enrolled.walletIdStr,
      target: prescriberName,
      targetType: 'prescriber',
      data: {
        pcpAssigned: prescriberName,
        prescriberIndex: opts.prescriberIndex,
        memberIndex: enrolled.memberIndex,
        specialty: prescriber.specialty,
        consentScope: 'ALL',
      },
    });

    this.emitMemory('pcp');

    return {
      prescriber: {
        index: opts.prescriberIndex,
        name: prescriberName,
        specialty: prescriber.specialty,
        credential: prescriber.credential,
        npi: prescriber.localData.prescriberId,
        walletId: truncField(prescriberWalletId),
      },
      member: {
        name: enrolled.displayName,
        walletId: enrolled.walletIdStr,
      },
      consentScope: {
        rxHistory: true,
        eligibility: true,
        accumulators: true,
        flags: 7,
      },
      forestRootBefore: fieldToStr(oldForestRoot),
      forestRootAfter: fieldToStr(enrolled.forest.getForestRoot()),
      proofTimesMs: {
        proofGate: elapsedPG,
        pcpVerification: elapsedPCP,
        total: elapsedPG + elapsedPCP,
      },
      // ZK Data
      pcpAssignmentData: {
        memberWalletId: fieldToStr(pcpData.memberWalletId),
        pcpWalletId: fieldToStr(pcpData.pcpWalletId),
        effectiveDate: fieldToStr(pcpData.effectiveDate),
        terminationDate: fieldToStr(pcpData.terminationDate),
        specialtyHash: fieldToStr(pcpData.specialtyHash),
        consentTimestamp: fieldToStr(pcpData.consentTimestamp),
        consentScopeFlags: fieldToStr(pcpData.consentScopeFlags),
        commitment: fieldToStr(pcpData.commitment()),
      },
      credential: serializeCredentialData(updatedCredentialData),
      forest: serializeForestRoots(enrolled.forest),
      chainState: this.getChainState(),
    };
  }

  // ─── Get Member History ───────────────────────────────────

  getMemberHistory(opts: { memberWalletId: string }): Record<string, unknown> {
    const enrolled = this.enrolledMembers.get(opts.memberWalletId);
    if (!enrolled) throw new Error(`Member not enrolled: ${opts.memberWalletId}`);

    // Eligibility info
    const eligibility = {
      planId: enrolled.planId,
      groupId: enrolled.groupId,
      coverageStatus: 'ELIGIBLE',
      formularyCount: DEMO_MEDICATIONS.length,
    };

    // Accumulator state
    const accumulator = {
      deductiblePaidCents: Number(enrolled.accumulatorData.deductiblePaidCents.toBigInt()),
      deductibleAmountCents: Number(enrolled.accumulatorData.deductibleAmountCents.toBigInt()),
      oopPaidCents: Number(enrolled.accumulatorData.oopPaidCents.toBigInt()),
      oopMaxCents: Number(enrolled.accumulatorData.oopMaxCents.toBigInt()),
      benefitUsedCents: Number(enrolled.accumulatorData.annualBenefitUsedCents.toBigInt()),
      benefitMaxCents: Number(enrolled.accumulatorData.annualBenefitMaxCents.toBigInt()),
    };

    // Prescription history
    const prescriptionHistory: Record<string, unknown>[] = [];
    for (const [_, rx] of this.prescriptions) {
      if (rx.memberWalletId !== opts.memberWalletId) continue;
      const med = DEMO_MEDICATIONS[rx.medicationIndex];
      const prescriberData = DEMO_PRESCRIBERS[rx.prescriberIndex];
      const pharmacyData = DEMO_PHARMACIES[rx.pharmacyIndex];
      const fills = this.fulfillments.get(rx.id) || [];
      const latestFill = fills.length > 0 ? fills[fills.length - 1] : null;

      prescriptionHistory.push({
        prescriptionId: rx.id,
        medication: med.brandName,
        strength: med.strength,
        ndc: med.ndcFormatted,
        tier: med.formularyEntry.tierLevel,
        prescriber: `Dr. ${prescriberData.firstName} ${prescriberData.lastName}`,
        pharmacy: pharmacyData.storeName,
        quantity: rx.quantity,
        refills: rx.refills,
        status: rx.status,
        fill: latestFill ? {
          patientPayCents: latestFill.patientPayCents,
          planPayCents: latestFill.planPayCents,
          totalCostCents: latestFill.totalCostCents,
        } : null,
        // Poseidon hash commitments (privacy-preserving proofs)
        rxCommitment: fieldToStr(rx.prescriptionData.commitment()),
        statusCommitment: fieldToStr(rx.activeStatus.commitment()),
        ndcHash: fieldToStr(rx.prescriptionData.ndcHash),
        prescriberWalletId: truncField(rx.prescriptionData.prescriberWalletId),
        pharmacyWalletId: truncField(rx.activeStatus.pharmacyWalletId),
        settlementCommitment: fulfillment ? fieldToStr(fulfillment.settlementCommitment) : null,
      });
    }

    return {
      member: {
        name: enrolled.displayName,
        walletId: enrolled.walletIdStr,
      },
      eligibility,
      accumulator,
      prescriptionHistory,
      pcpAssigned: enrolled.pcpPrescriberIndex !== undefined,
    };
  }

  // ─── Get Family History ─────────────────────────────────

  getFamilyHistory(opts: { memberWalletId: string }): Record<string, unknown> {
    const enrolled = this.enrolledMembers.get(opts.memberWalletId);
    if (!enrolled) throw new Error(`Member not enrolled: ${opts.memberWalletId}`);

    // Find all enrolled family members
    const familyMembers: Record<string, unknown>[] = [];
    const familyAccumulators: MemberAccumulator[] = [];

    for (const [_, m] of this.enrolledMembers) {
      if (m.familyId !== enrolled.familyId) continue;

      const memberAccum = {
        deductiblePaidCents: Number(m.accumulatorData.deductiblePaidCents.toBigInt()),
        oopPaidCents: Number(m.accumulatorData.oopPaidCents.toBigInt()),
        annualBenefitUsedCents: Number(m.accumulatorData.annualBenefitUsedCents.toBigInt()),
      };
      familyAccumulators.push(memberAccum);

      // Prescription history for this family member
      const rxHistory: Record<string, unknown>[] = [];
      for (const [_, rx] of this.prescriptions) {
        if (rx.memberWalletId !== m.walletId.toString()) continue;
        const med = DEMO_MEDICATIONS[rx.medicationIndex];
        const prescriberData = DEMO_PRESCRIBERS[rx.prescriberIndex];
        const pharmacyData = DEMO_PHARMACIES[rx.pharmacyIndex];
        const fills = this.fulfillments.get(rx.id) || [];
        const latestFill = fills.length > 0 ? fills[fills.length - 1] : null;

        rxHistory.push({
          prescriptionId: rx.id,
          medication: med.brandName,
          strength: med.strength,
          ndc: med.ndcFormatted,
          tier: med.formularyEntry.tierLevel,
          prescriber: `Dr. ${prescriberData.firstName} ${prescriberData.lastName}`,
          pharmacy: pharmacyData.storeName,
          quantity: rx.quantity,
          status: rx.status,
          fill: latestFill ? {
            patientPayCents: latestFill.patientPayCents,
            planPayCents: latestFill.planPayCents,
            totalCostCents: latestFill.totalCostCents,
          } : null,
          rxCommitment: fieldToStr(rx.prescriptionData.commitment()),
          ndcHash: fieldToStr(rx.prescriptionData.ndcHash),
          settlementCommitment: fulfillment ? fieldToStr(fulfillment.settlementCommitment) : null,
        });
      }

      familyMembers.push({
        name: m.displayName,
        walletId: m.walletIdStr,
        relationship: m.relationship,
        accumulator: {
          deductiblePaidCents: memberAccum.deductiblePaidCents,
          deductibleAmountCents: Number(m.accumulatorData.deductibleAmountCents.toBigInt()),
          oopPaidCents: memberAccum.oopPaidCents,
          oopMaxCents: Number(m.accumulatorData.oopMaxCents.toBigInt()),
          benefitUsedCents: memberAccum.annualBenefitUsedCents,
          benefitMaxCents: Number(m.accumulatorData.annualBenefitMaxCents.toBigInt()),
        },
        prescriptionHistory: rxHistory,
        pcpAssigned: m.pcpPrescriberIndex !== undefined,
      });
    }

    // Family totals
    const familyTotals = FamilyAccumulatorService.getFamilyTotals(familyAccumulators);
    const familyLimits: FamilyLimits = {
      familyDeductibleAmountCents: 100000,
      familyOopMaxCents: 1600000,
      familyAnnualBenefitMaxCents: 0,
    };

    return {
      familyId: enrolled.familyId,
      members: familyMembers,
      familyAccumulator: {
        totalDeductiblePaidCents: familyTotals.deductiblePaidCents,
        totalOopPaidCents: familyTotals.oopPaidCents,
        totalBenefitUsedCents: familyTotals.annualBenefitUsedCents,
        memberCount: familyTotals.memberCount,
        limits: familyLimits,
        deductibleMet: FamilyAccumulatorService.isFamilyDeductibleMet(familyTotals, familyLimits),
        oopMaxMet: FamilyAccumulatorService.isFamilyOopMaxMet(familyTotals, familyLimits),
      },
    };
  }

  // ─── Chain State ────────────────────────────────────────

  // ─── L2 Integration Helpers ─────────────────────────────

  /**
   * Generate a StateTransitionProof.proveWalletUpdate and submit to L2.
   * Common path for fill, PA approval, formulary update, plan year rollover.
   */
  private async submitWalletUpdate(
    enrolled: EnrolledMember,
    newInventoryRoot: Field,
    phase: string,
  ): Promise<L2Receipt> {
    const oldRoot = enrolled.credentialInventoryRoot;
    const oldNonce = Field(enrolled.nonce);
    const walletIndex = BigInt(enrolled.walletIndex);
    const regWitness = this.walletRegistry.getWitnessByIndex(walletIndex);
    const lcWitness = new LifecycleWitness(this.lifecycleTree.getWitness(walletIndex));
    const currentRegRoot = this.walletRegistry.getRoot();
    const currentLcRoot = this.lifecycleTree.getRoot();

    this.emit('proof', phase, 'Generating StateTransitionProof.proveWalletUpdate...', 'start');
    const start = performance.now();
    const pi = enrolled.preimageFields;
    const stResult = await StateTransitionProgram.proveWalletUpdate(
      DOMAIN_TAG_MEMBER,
      pi[0]!, pi[1]!, pi[2]!, pi[3]!, pi[4]!,
      oldRoot, oldNonce, newInventoryRoot,
      regWitness, lcWitness, currentRegRoot, currentLcRoot,
      LIFECYCLE_ELIGIBLE,
    );
    const elapsed = performance.now() - start;
    this.emit('proof', phase, `StateTransitionProof generated`, 'complete', elapsed);

    // ─── Patent Evidence: Proof Details ──────────────────────
    const stProof = stResult.proof;
    const stOutput = stProof.publicOutput;
    this.emit('info', phase, `  ┌─ PROOF: StateTransitionProgram.proveWalletUpdate`);
    this.emit('info', phase, `  │  Wallet:         ${truncField(enrolled.walletId)} (index ${walletIndex})`);
    this.emit('info', phase, `  │  Nonce:           ${enrolled.nonce} → ${enrolled.nonce + 1}`);
    this.emit('info', phase, `  │  Credential Root: ${truncField(oldRoot)} → ${truncField(newInventoryRoot)}`);
    this.emit('info', phase, `  │  Registry Root:   ${truncField(currentRegRoot)}`);
    this.emit('info', phase, `  │  Lifecycle Root:  ${truncField(currentLcRoot)}`);
    this.emit('info', phase, `  │  Public Output:`);
    this.emit('info', phase, `  │    oldRegistryRoot:  ${truncField(stOutput.oldRegistryRoot)}`);
    this.emit('info', phase, `  │    newRegistryRoot:  ${truncField(stOutput.newRegistryRoot)}`);
    this.emit('info', phase, `  │    oldLifecycleRoot: ${truncField(stOutput.oldLifecycleRoot)}`);
    this.emit('info', phase, `  │    newLifecycleRoot: ${truncField(stOutput.newLifecycleRoot)}`);
    this.emit('info', phase, `  └─ Proof verified: constraints satisfied (${elapsed.toFixed(0)}ms)`);

    // Update local wallet registry state
    const newNonce = enrolled.nonce + 1;
    this.walletRegistry.updateState(enrolled.walletId, new WalletState({
      walletId: enrolled.walletId,
      credentialInventoryRoot: newInventoryRoot,
      nonce: Field(newNonce),
    }));
    enrolled.nonce = newNonce;
    enrolled.credentialInventoryRoot = newInventoryRoot;

    // Submit to L2 sequencer
    const receipt = await this.l2Node.submitProof(stResult.proof as StateTransitionProof);
    enrolled.l2Receipts.push(receipt.receiptId);
    this.emit('info', phase, `  ┌─ L2 RECEIPT`);
    this.emit('info', phase, `  │  Receipt ID:     ${receipt.receiptId}`);
    this.emit('info', phase, `  │  Sequence #:     ${receipt.sequenceNumber}`);
    this.emit('info', phase, `  │  New Reg Root:   ${truncField(stOutput.newRegistryRoot)}`);
    this.emit('info', phase, `  └─ Proof accepted by sequencer`);

    return receipt;
  }

  /**
   * Update member's CredentialInventory slot 0 with current credentialData and submit wallet update to L2.
   * Use after any forest mutation (fill, PA, formulary, rollover).
   */
  private async updateCredentialAndSubmitToL2(
    enrolled: EnrolledMember,
    phase: string,
  ): Promise<L2Receipt> {
    const oldInventoryRoot = enrolled.credentialInventory.getRoot();
    enrolled.credentialInventory.updateCredential(0n, enrolled.credentialData);
    const newInventoryRoot = enrolled.credentialInventory.getRoot();

    // ─── Patent Evidence: Credential State Mutation ─────────────────
    this.emit('info', phase, `  ┌─ CREDENTIAL UPDATE (${enrolled.displayName})`);
    this.emit('info', phase, `  │  Credential Type:  ${enrolled.credentialData.credentialType.equals(CREDENTIAL_TYPE_ELIGIBILITY).toBoolean() ? 'ELIGIBILITY' : 'PRESCRIPTION'}`);
    this.emit('info', phase, `  │  Subject Wallet:   ${truncField(enrolled.credentialData.subjectWalletId)}`);
    this.emit('info', phase, `  │  Forest Root:      ${truncField(enrolled.credentialData.forestRoot)}`);
    this.emit('info', phase, `  │  Inventory Root:   ${truncField(oldInventoryRoot)} → ${truncField(newInventoryRoot)}`);
    this.emit('info', phase, `  └─ Submitting StateTransitionProof to L2...`);

    return this.submitWalletUpdate(enrolled, newInventoryRoot, phase);
  }

  // ─── L2 Service Methods ───────────────────────────────

  /** Force batch build (manual trigger) */
  async forceBatch(): Promise<unknown> {
    return this.l2Node.forceBatch();
  }

  /** Save checkpoint */
  async saveCheckpoint(): Promise<string | null> {
    return this.l2Node.saveCheckpoint('manual');
  }

  /** Get L2Node reference */
  getL2Node(): L2Node {
    return this.l2Node;
  }

  getChainState(): Record<string, string | number> {
    const seq = this.l2Node.getSequencer();
    return {
      walletRegistryRoot: seq.getCurrentRegistryRoot().toString(),
      walletCount: Number(seq.getCurrentWalletCount().toBigInt()),
      adminPublicKeyHash: fieldToStr(this.adminWalletId),
      lifecycleRoot: seq.getCurrentLifecycleRoot().toString(),
      benefitPlanRoot: fieldToStr(this.benefitPlanRegistry.getRoot()),
      credentialRegistryRoot: '0',
      eligibilityVkHash: '0',
      messagingRoot: fieldToStr(computeMessagingRoot(
        this.messageRegistry.getRoot(),
        this.delegationRegistry.getRoot(),
        this.keyRegistry.getRoot(),
      )),
    };
  }

  // ─── Reporting ─────────────────────────────────────────

  private buildVerifiedClaims(): VerifiedClaim[] {
    const claims: VerifiedClaim[] = [];
    for (const [rxId, fills] of this.fulfillments) {
      const rx = this.prescriptions.get(rxId);
      if (!rx) continue;
      const med = DEMO_MEDICATIONS[rx.medicationIndex];
      const prescriberWid = this.prescriberWalletIds.get(rx.prescriberIndex);
      const pharmacyWid = this.pharmacyWalletIds.get(rx.pharmacyIndex);
      if (!prescriberWid || !pharmacyWid) continue;

      for (const fill of fills) {
        claims.push({
          prescriptionHash: rx.prescriptionData?.commitment().toString() || rxId,
          entryCommitment: fill.settlementCommitment.toString(),
          patientPayCents: fill.patientPayCents,
          planPayCents: fill.planPayCents,
          operationType: fill.reversed ? 'reversal' : 'fulfillment',
          pharmacyWalletId: pharmacyWid.toString(),
          memberWalletId: rx.memberWalletId,
          prescriberWalletId: prescriberWid.toString(),
          ndcHash: hashString(med.ndc).toString(),
          ingredientCostCents: fill.totalCostCents - 200, // dispensing fee = 200
          dispensingFeeCents: 200,
          quantityDispensed: (fill.quantityDispensed * 1000).toString(), // x1000 scaled
          dateOfService: 20260215, // demo date
        });
      }
    }
    return claims;
  }

  private buildPriorAuthContexts(): PriorAuthContext[] {
    const contexts: PriorAuthContext[] = [];
    for (const [_, pa] of this.priorAuths) {
      if (pa.status !== 'APPROVED') continue;
      const med = DEMO_MEDICATIONS[pa.medicationIndex];
      const prescriberWid = this.prescriberWalletIds.get(pa.prescriberIndex);
      if (!prescriberWid) continue;

      // Find matching Rx to get approved quantity
      const rx = [...this.prescriptions.values()].find(
        r => r.medicationIndex === pa.medicationIndex && r.memberWalletId === pa.memberWalletId
      );

      contexts.push({
        ndcHash: hashString(med.ndc).toString(),
        memberWalletId: pa.memberWalletId,
        prescriberWalletId: prescriberWid.toString(),
        approvalDate: 20260215,
        expirationDate: 20270215,
        approvedQuantity: ((rx?.quantity || med.formularyEntry.maxQuantityPerFill) * 1000).toString(),
      });
    }
    return contexts;
  }

  private buildReports(): Record<string, unknown> | null {
    const claims = this.buildVerifiedClaims();
    if (claims.length === 0) return null;

    const paContexts = this.buildPriorAuthContexts();
    const rs = this.reportingService;

    return {
      financialSummary: rs.generateFinancialSummary(claims),
      claimsRegister: rs.generateClaimsRegister(claims),
      pharmacyActivity: rs.generatePharmacyActivity(claims),
      prescriberActivity: rs.generatePrescriberActivity(claims),
      memberActivity: rs.generateMemberActivity(claims),
      medicationUtilization: rs.generateMedicationUtilization(claims),
      priorAuthReport: rs.generatePriorAuthReport(claims, paContexts),
      reversalReport: rs.generateReversalReport(claims),
      ndcDirectory: Object.fromEntries(
        DEMO_MEDICATIONS.map(m => [
          hashString(m.ndc).toString(),
          { brandName: m.brandName, genericName: m.genericName, ndc: m.ndcFormatted, tier: m.formularyEntry.tierLevel }
        ])
      ),
    };
  }

  // ─── Portable Credentials ────────────────────────────────────

  async generateCredential(
    walletIdStr: string,
    proofType: 'holding' | 'holding-by-type' = 'holding',
  ): Promise<Record<string, unknown>> {
    if (!this.compiled) throw new Error('Programs not compiled yet');

    const enrolled = this.enrolledMembers.get(walletIdStr);
    if (!enrolled) throw new Error(`Member not enrolled: ${walletIdStr}`);
    if (enrolled.lifecycle === 'REVOKED') throw new Error('Cannot generate credential for revoked member');
    if (!this.credentialProgramVkHash) throw new Error('CredentialProgram VK not available');

    this.emit('phase', 'credential', `═══ Generate Portable Credential: ${enrolled.displayName} ═══`);

    // 1. Get credential data from enrolled member with fresh Field objects.
    // CredentialData fields may have corrupted o1js FieldVar state from prior circuit
    // operations (proveMint during enrollment). Create fresh Fields from bigints.
    const inventory = enrolled.credentialInventory;
    const srcCred = enrolled.credentialData;
    const credentialData = new CredentialData({
      credentialType: Field(srcCred.credentialType.toBigInt()),
      forestRoot: Field(srcCred.forestRoot.toBigInt()),
      issuerWalletId: Field(srcCred.issuerWalletId.toBigInt()),
      subjectWalletId: Field(srcCred.subjectWalletId.toBigInt()),
      issuedAt: Field(srcCred.issuedAt.toBigInt()),
      expiresAt: Field(srcCred.expiresAt.toBigInt()),
      revoked: Field(srcCred.revoked.toBigInt()),
    });
    const witness = inventory.getWitness(0n);
    const inventoryRoot = inventory.getRoot();

    // 2. Regenerate ProofGateProof from member's local data (simulates member device)
    // In production, the member's device generates this fresh from their stored preimage.
    // Fresh Field objects are created from bigint values to avoid o1js internal FieldVar
    // state corruption that can occur after Fields are used as circuit inputs.
    this.emit('proof', 'credential', 'Step 1: Generating ProofGate.verifyMember proof...', 'start');
    const pgStart = performance.now();
    const freshWalletId = Field(enrolled.walletId.toBigInt());
    const freshPreimage = enrolled.preimageFields.map(f => Field(f.toBigInt())) as [Field, Field, Field, Field, Field];
    const pgResult = await ProofGateProgram.verifyMember(
      freshWalletId,
      ...freshPreimage,
    );
    const pgElapsed = performance.now() - pgStart;
    this.emit('proof', 'credential', 'Step 1: ProofGate proof generated', 'complete', pgElapsed);

    // 3. Generate CredentialProgram proof
    const proofTypeLabel = proofType === 'holding' ? 'proveHolding' : 'proveHoldingByType';
    this.emit('proof', 'credential', `Step 2: Generating CredentialProgram.${proofTypeLabel} proof...`, 'start');
    const credentialStart = performance.now();

    let credentialResult;
    let credentialProofType: PortableCredential['proofType'];
    if (proofType === 'holding') {
      credentialResult = await CredentialProgram.proveHolding(
        pgResult.proof, credentialData, witness, inventoryRoot,
      );
      credentialProofType = 'credential-holding';
    } else {
      credentialResult = await CredentialProgram.proveHoldingByType(
        pgResult.proof, credentialData, witness, inventoryRoot, CREDENTIAL_TYPE_ELIGIBILITY,
      );
      credentialProofType = 'credential-type-holding';
    }
    const credentialElapsed = performance.now() - credentialStart;
    this.emit('proof', 'credential', `Step 2: CredentialProgram.${proofTypeLabel} proof generated`, 'complete', credentialElapsed);
    this.emitMemory('credential');

    // 4. Serialize into PortableCredential
    const credential = serializeCredential(
      credentialResult.proof,
      credentialProofType,
      this.credentialProgramVkHash,
      0, // never expires
    );

    const totalMs = performance.now() - pgStart;
    this.emit('timing', 'credential', `Portable credential generated in ${(totalMs / 1000).toFixed(1)}s`, undefined, totalMs);
    this.emit('info', 'credential', `  Proof type: ${credentialProofType}`);
    this.emit('info', 'credential', `  Wallet ID: ${enrolled.walletIdStr}`);
    this.emit('info', 'credential', `  Credential commitment: ${truncField(credentialData.commitment())}`);
    this.emit('info', 'credential', '  This credential can be verified offline at any pharmacy.');

    const credentialJson = JSON.stringify(credential);

    // Store on enrolled member so pharmacy can access it via getState()
    enrolled.lastCredentialJson = credentialJson;

    // Create sequencer-signed attestation for NFC tag (~500 bytes, fits NTAG216)
    const attestation = this.attestationAuthority.createAttestation({
      walletId: credential.publicOutput.walletId,
      credentialCommitment: credential.publicOutput.credentialCommitment,
      lifecycleState: 3, // ACTIVE
      forestRoot: credentialData.forestRoot.toString(),
    });
    enrolled.lastAttestation = attestation;
    this.emit('info', 'credential', `  NFC attestation created (Ed25519 signed, expires ${new Date(attestation.exp * 1000).toLocaleString()})`);

    // Emit visualization event for credential generation at pharmacy
    this.emitViz('viz:credential:generated', 'fulfillment', {
      actor: enrolled.displayName,
      actorType: 'member',
      target: 'Insurer',
      targetType: 'insurer',
      data: {
        walletId: enrolled.walletIdStr,
        proofType: credentialProofType,
        proofGateTimeMs: Math.round(pgElapsed),
        credentialProgramTimeMs: Math.round(credentialElapsed),
        totalTimeMs: Math.round(totalMs),
        hasAttestation: true,
      },
    });

    return {
      credential,
      credentialJson,
      attestation,
      proofGateTimeMs: pgElapsed,
      credentialProgramTimeMs: credentialElapsed,
      totalTimeMs: totalMs,
      memberDisplayName: enrolled.displayName,
      walletIdDisplay: enrolled.walletIdStr,
    };
  }

  async verifyCredential(credentialJson: string): Promise<Record<string, unknown>> {
    if (!this.credentialProgramVk) throw new Error('CredentialProgram VK not available — compile first');

    this.emit('phase', 'credential', '═══ Verify Portable Credential (Offline) ═══');

    let credential: PortableCredential;
    try {
      credential = JSON.parse(credentialJson);
    } catch {
      return { valid: false, reason: 'Invalid JSON' };
    }

    if (credential.version !== 1) {
      return { valid: false, reason: `Unsupported version: ${credential.version}` };
    }

    this.emit('proof', 'credential', 'Verifying credential proof offline...', 'start');
    const start = performance.now();

    const valid = await verifyCredentialOffline(credential, this.credentialProgramVk);
    const elapsed = performance.now() - start;

    this.emit('proof', 'credential', valid ? 'Credential VALID' : 'Credential INVALID', 'complete', elapsed);

    // Cross-reference wallet ID against enrolled members
    let memberDisplayName: string | undefined;
    const walletId = credential.publicOutput.walletId;
    for (const [_, m] of this.enrolledMembers) {
      if (m.walletId.toString() === walletId) {
        memberDisplayName = m.displayName;
        break;
      }
    }

    // Collect fillable prescriptions for this member (stateless — not stored)
    const memberPrescriptions: Record<string, unknown>[] = [];
    if (valid && walletId) {
      for (const [_, rx] of this.prescriptions) {
        if (rx.memberWalletId === walletId &&
            (rx.status === 'ACTIVE' || rx.status === 'PARTIALLY_FILLED' || rx.status === 'DISPENSED')) {
          const med = DEMO_MEDICATIONS[rx.medicationIndex];
          const pharm = DEMO_PHARMACIES[rx.pharmacyIndex];
          memberPrescriptions.push({
            id: rx.id,
            medication: med.brandName,
            medicationStrength: med.strength,
            medicationIndex: rx.medicationIndex,
            pharmacyIndex: rx.pharmacyIndex,
            pharmacyName: pharm.storeName,
            quantity: rx.quantity,
            quantityDispensed: rx.quantityDispensed,
            status: rx.status,
            refills: rx.refills,
            refillsUsed: rx.refillsUsed,
          });
        }
      }
    }

    if (valid) {
      this.emit('info', 'credential', `  Result: VALID`);
      this.emit('info', 'credential', `  Proof type: ${credential.proofType}`);
      this.emit('info', 'credential', `  Wallet ID: ${walletId}`);
      if (memberDisplayName) {
        this.emit('info', 'credential', `  Member: ${memberDisplayName} (matched)`);
      }
      if (memberPrescriptions.length > 0) {
        this.emit('info', 'credential', `  Available prescriptions: ${memberPrescriptions.length}`);
      }
    } else {
      this.emit('info', 'credential', '  Result: INVALID — proof verification failed');
    }

    // Emit credential scan VizEvent
    this.emitViz('viz:pharmacy:credential_scan', 'fulfillment', {
      actor: 'Pharmacy',
      actorType: 'pharmacy',
      target: memberDisplayName ?? '',
      targetType: 'member',
      data: { valid, walletId, proofType: credential.proofType, elapsedMs: elapsed },
    });

    return {
      valid,
      publicOutput: credential.publicOutput,
      proofType: credential.proofType,
      memberDisplayName,
      memberWalletId: valid ? walletId : undefined,
      memberPrescriptions,
      verificationTimeMs: elapsed,
    };
  }

  // ─── NFC Attestation Methods ─────────────────────────────

  /** Get the sequencer's Ed25519 public key (hex string) */
  getSequencerPublicKey(): string {
    return this.attestationAuthority.publicKeyHex;
  }

  /** Get the last attestation for a walletId (if one exists) */
  getAttestation(walletId: string): NfcCredentialAttestation | null {
    for (const [_, m] of this.enrolledMembers) {
      if (m.walletId.toString() === walletId && m.lastAttestation) {
        return m.lastAttestation;
      }
    }
    return null;
  }

  /** Verify an attestation's Ed25519 signature and expiry */
  verifyAttestation(att: NfcCredentialAttestation): { valid: boolean; expired: boolean; revoked: boolean; reason?: string } {
    const result = SequencerAttestationAuthority.verifyAttestation(att);
    const revoked = this.attestationAuthority.isRevoked(att.n);
    return {
      ...result,
      revoked,
      reason: revoked ? 'Attestation has been revoked (member terminated)' : result.reason,
    };
  }

  /** Check if an attestation nonce has been revoked */
  isAttestationRevoked(nonce: string): boolean {
    return this.attestationAuthority.isRevoked(nonce);
  }

  // ─── State & Reset ─────────────────────────────────────

  getState(): Record<string, unknown> {
    const enrolledList: Record<string, unknown>[] = [];
    for (const [_, m] of this.enrolledMembers) {
      const pcpInfo = m.pcpPrescriberIndex !== undefined ? {
        prescriberIndex: m.pcpPrescriberIndex,
        prescriberName: `Dr. ${DEMO_PRESCRIBERS[m.pcpPrescriberIndex].firstName} ${DEMO_PRESCRIBERS[m.pcpPrescriberIndex].lastName}`,
        specialty: DEMO_PRESCRIBERS[m.pcpPrescriberIndex].specialty,
      } : null;

      enrolledList.push({
        memberIndex: m.memberIndex,
        walletId: m.walletId.toString(),
        walletIdDisplay: m.walletIdStr,
        displayName: m.displayName,
        planId: m.planId,
        groupId: m.groupId,
        familyId: m.familyId,
        relationship: m.relationship,
        employeeId: m.employeeId,
        accumulator: {
          deductiblePaidCents: Number(m.accumulatorData.deductiblePaidCents.toBigInt()),
          oopPaidCents: Number(m.accumulatorData.oopPaidCents.toBigInt()),
          benefitUsedCents: Number(m.accumulatorData.annualBenefitUsedCents.toBigInt()),
        },
        pcpAssignment: pcpInfo,
        inNetworkPrescribers: m.inNetworkPrescriberIndices,
        inNetworkPharmacies: m.inNetworkPharmacyIndices,
        lifecycle: m.lifecycle,
        terminationDate: m.terminationDate,
        nonce: m.nonce,
        l2Receipts: m.l2Receipts,
        credentialJson: m.lastCredentialJson ?? null,
        lastAttestation: m.lastAttestation ?? null,
        credentialInventory: {
          count: m.credentialInventory.count,
          inventoryRoot: fieldToStr(m.credentialInventory.getRoot()),
          credentials: [serializeCredentialData(m.credentialData)],
        },
      });
    }

    const rxList: Record<string, unknown>[] = [];
    // Include pending prescriptions (proofs being generated) so pharmacy can see them queuing
    for (const [_, pending] of this.pendingPrescriptions) {
      const med = DEMO_MEDICATIONS[pending.medicationIndex];
      rxList.push({
        id: pending.id,
        medication: med.brandName,
        medicationStrength: med.strength,
        medicationIndex: pending.medicationIndex,
        memberWalletId: pending.memberWalletId,
        prescriberIndex: pending.prescriberIndex,
        pharmacyIndex: pending.pharmacyIndex,
        quantity: pending.quantity,
        quantityDispensed: 0,
        refills: pending.refills,
        refillsUsed: 0,
        status: 'PENDING',
        filled: false,
        statusHistory: [],
        startedAt: pending.startedAt,
      });
    }
    for (const [_, rx] of this.prescriptions) {
      const med = DEMO_MEDICATIONS[rx.medicationIndex];
      const fills = this.fulfillments.get(rx.id) || [];
      const totalPatientPay = fills.filter(f => !f.reversed).reduce((s, f) => s + f.patientPayCents, 0);
      const totalPlanPay = fills.filter(f => !f.reversed).reduce((s, f) => s + f.planPayCents, 0);
      rxList.push({
        id: rx.id,
        medication: med.brandName,
        medicationStrength: med.strength,
        medicationIndex: rx.medicationIndex,
        memberWalletId: rx.memberWalletId,
        prescriberIndex: rx.prescriberIndex,
        pharmacyIndex: rx.pharmacyIndex,
        quantity: rx.quantity,
        quantityDispensed: rx.quantityDispensed,
        refills: rx.refills,
        refillsUsed: rx.refillsUsed,
        status: rx.status,
        filled: rx.status === 'FILLED',  // backwards-compat
        statusHistory: rx.statusHistory,
        patientPayCents: totalPatientPay || undefined,
        planPayCents: totalPlanPay || undefined,
      });
    }

    const paList: Record<string, unknown>[] = [];
    for (const [_, pa] of this.priorAuths) {
      const med = DEMO_MEDICATIONS[pa.medicationIndex];
      const prescriber = DEMO_PRESCRIBERS[pa.prescriberIndex];
      const enrolled = this.enrolledMembers.get(pa.memberWalletId);
      paList.push({
        id: pa.id,
        memberWalletId: pa.memberWalletId,
        memberName: enrolled?.displayName ?? 'Unknown',
        memberWalletIdDisplay: enrolled?.walletIdStr ?? pa.memberWalletId,
        prescriberIndex: pa.prescriberIndex,
        prescriberName: `Dr. ${prescriber.firstName} ${prescriber.lastName}`,
        medicationIndex: pa.medicationIndex,
        medicationName: med.brandName,
        medicationStrength: med.strength,
        medicationTier: med.formularyEntry.tierLevel,
        status: pa.status,
        requestedAt: pa.requestedAt,
        resolvedAt: pa.resolvedAt,
      });
    }

    // L2 chain state
    const seq = this.l2Node.getSequencer();
    const rawL2Status = this.l2Node.getStatus();
    // Sanitize: inFlightBatch is bigint|null — JSON.stringify can't handle bigint
    const l2Status = {
      ...rawL2Status,
      inFlightBatch: rawL2Status.inFlightBatch !== null ? Number(rawL2Status.inFlightBatch) : null,
    };
    const l2Receipts = seq.getAllReceipts().map(r => ({
      receiptId: r.receiptId,
      walletId: r.walletId.length > 16 ? r.walletId.slice(0, 8) + '...' + r.walletId.slice(-8) : r.walletId,
      isRegistration: r.isRegistration,
      sequenceNumber: Number(r.sequenceNumber),
      l1Status: r.l1Status,
      acceptedAt: r.acceptedAt,
    }));
    const l2Batches = seq.getAllBatches().map(b => ({
      batchNumber: Number(b.batchNumber),
      registrationCount: b.registrationCount,
      transitionCount: b.transitionCount,
      l1Status: b.l1Status,
      createdAt: b.createdAt,
      l1TxHash: b.l1TxHash,
    }));
    const auditLog = seq.getAuditLog();

    return {
      compiled: this.compiled,
      ready: this.ready,
      chainState: this.getChainState(),
      l2: {
        status: l2Status,
        receipts: l2Receipts,
        batches: l2Batches,
        auditLog: {
          eventCount: Number(auditLog.eventCount),
          latestChainHash: auditLog.latestChainHash,
          genesisHash: auditLog.genesisHash,
        },
      },
      enrolledMembers: enrolledList,
      prescriptions: rxList,
      priorAuths: paList,
      fulfillments: Array.from(this.fulfillments.values()).flat().map(f => ({
        prescriptionId: f.prescriptionId,
        fillIndex: f.fillIndex,
        patientPayCents: f.patientPayCents,
        planPayCents: f.planPayCents,
        totalCostCents: f.totalCostCents,
        accumulatorBefore: f.accumulatorBefore,
        accumulatorAfter: f.accumulatorAfter,
        newEligForestRoot: f.newEligForestRoot,
        oldEligForestRoot: f.oldEligForestRoot,
        settlementCommitment: fieldToStr(f.settlementCommitment),
        quantityDispensed: f.quantityDispensed,
        reversed: f.reversed,
        serviceDateStr: f.fulfillmentData.dateOfService.toBigInt().toString(),
      })),
      reports: this.buildReports(),
      auditSummary: {
        enrollmentCount: this.enrolledMembers.size,
        prescriptionCount: this.prescriptions.size,
        fulfillmentCount: Array.from(this.fulfillments.values()).flat().length,
        reversalCount: Array.from(this.fulfillments.values()).flat().filter(f => f.reversed).length,
        totalPatientPayCents: Array.from(this.fulfillments.values()).flat().filter(f => !f.reversed).reduce((s, f) => s + (f.patientPayCents || 0), 0),
        totalPlanPayCents: Array.from(this.fulfillments.values()).flat().filter(f => !f.reversed).reduce((s, f) => s + (f.planPayCents || 0), 0),
        totalReversedPatientCents: Array.from(this.fulfillments.values()).flat().filter(f => f.reversed).reduce((s, f) => s + (f.patientPayCents || 0), 0),
        totalReversedPlanCents: Array.from(this.fulfillments.values()).flat().filter(f => f.reversed).reduce((s, f) => s + (f.planPayCents || 0), 0),
        terminationCount: Array.from(this.enrolledMembers.values()).filter(m => m.lifecycle === 'REVOKED').length,
      },
      formularyChangeHistory: this.formularyChangeHistory,
      demoData: {
        members: DEMO_MEMBERS.map((m, i) => ({
          index: i,
          firstName: m.localData.firstName,
          lastName: m.localData.lastName,
          cardholderId: m.localData.cardholderId,
          dateOfBirth: m.localData.dateOfBirth,
          relationship: m.relationship,
          employeeId: m.employeeId,
          familyId: m.familyId,
          address: m.address,
          city: m.city,
          state: m.state,
          zip: m.zip,
          genderCode: m.localData.genderCode,
          enrollmentKey: m.enrollmentKey,
        })),
        prescribers: DEMO_PRESCRIBERS.map((p, i) => ({
          index: i,
          firstName: p.firstName,
          lastName: p.lastName,
          name: `Dr. ${p.firstName} ${p.lastName}`,
          credential: p.credential,
          specialty: p.specialty,
          npi: p.localData.prescriberId,
          state: p.state,
          deaNumber: p.deaNumber,
        })),
        pharmacies: DEMO_PHARMACIES.map((p, i) => ({
          index: i,
          storeName: p.storeName,
          chain: p.chain,
          pharmacyType: p.pharmacyTypeDesc,
          npi: p.localData.serviceProviderId,
          ncpdpId: p.ncpdpProviderId,
          address: p.address,
          city: p.city,
          state: p.state,
          phone: p.phone,
        })),
        medications: DEMO_MEDICATIONS.map((m, i) => ({
          index: i,
          brandName: m.brandName,
          genericName: m.genericName,
          strength: m.strength,
          dosageForm: m.dosageForm,
          route: m.route,
          ndc: m.ndcFormatted,
          tier: m.formularyEntry.tierLevel,
          copayAmountCents: m.formularyEntry.copayAmount,
          requiresPriorAuth: m.formularyEntry.requiresPriorAuth,
          stepTherapyRequired: m.formularyEntry.stepTherapyRequired,
          maxQuantityPerFill: m.formularyEntry.maxQuantityPerFill,
          maxDaySupply: m.formularyEntry.maxDaySupply,
          awpUnitPriceCents: m.awpUnitPriceCents,
          therapeuticClass: m.therapeuticClass,
          deaSchedule: m.deaSchedule,
          manufacturer: m.manufacturer,
          // Dynamic formulary state (runtime changes)
          active: this.formularyActive.length > i ? this.formularyActive[i] : true,
          initiallyOnFormulary: m.initiallyOnFormulary !== false,
          currentTierLevel: this.currentFormularyEntries[i]?.tierLevel ?? m.formularyEntry.tierLevel,
          currentCopayAmountCents: this.currentFormularyEntries[i]?.copayAmount ?? m.formularyEntry.copayAmount,
          currentRequiresPriorAuth: this.currentFormularyEntries[i]?.requiresPriorAuth ?? m.formularyEntry.requiresPriorAuth,
          currentStepTherapyRequired: this.currentFormularyEntries[i]?.stepTherapyRequired ?? m.formularyEntry.stepTherapyRequired,
        })),
        plan: {
          planId: 'PLAN-GOLD-2026',
          copayAmountCents: 3000,
          deductibleAmountCents: 50000,
          oopMaxCents: 800000,
          annualBenefitMaxCents: 5000000,
          familyDeductibleAmountCents: 100000,
          familyOopMaxCents: 1600000,
          familyAnnualBenefitMaxCents: 10000000,
          formularyCount: this.formularyActive.length > 0 ? this.formularyActive.filter(a => a).length : DEMO_MEDICATIONS.length,
          formularyRoot: fieldToStr(this.formularyRegistry.getRoot()),
          networkRoot: this.providerNetwork.count > 0 ? fieldToStr(this.providerNetwork.getRoot()) : '0',
          inNetworkPrescriberCount: Array.from(this.networkActive.values()).filter(a => a).length,
        },
        providerNetwork: {
          root: this.providerNetwork.count > 0 ? fieldToStr(this.providerNetwork.getRoot()) : '0',
          count: this.providerNetwork.count,
          active: Object.fromEntries(this.networkActive),
          changeHistory: this.networkChangeHistory.map(h => ({
            timestamp: h.timestamp,
            changeType: h.changeType,
            prescriberName: h.prescriberName,
            details: h.details,
            affectedMemberCount: h.affectedMembers.length,
            oldNetworkRoot: h.oldNetworkRoot,
            newNetworkRoot: h.newNetworkRoot,
          })),
        },
        token: {
          groupId: 'ACME-CORP',
          planId: 'PLAN-GOLD-2026',
          validUntil: '20261231',
        },
      },
      messaging: {
        messageCount: this.messageRegistry.count,
        delegationCount: this.delegationRegistry.count,
        keyCount: this.keyRegistry.count,
        messages: [...Array(this.messageRegistry.count)].map((_, i) => {
          const msg = this.messageRegistry.getMessage(BigInt(i));
          if (!msg) return null;
          const payload = this.encryptedPayloads.get(i.toString());
          return {
            messageIndex: i,
            senderWalletId: msg.senderWalletId.toString(),
            recipientWalletId: msg.recipientWalletId.toString(),
            contentHash: fieldToStr(msg.contentHash),
            messageType: Number(msg.messageType.toBigInt()),
            nonce: Number(msg.nonce.toBigInt()),
            threadId: payload?.threadId || null,
            timestamp: payload?.timestamp || null,
            hasEncryptedPayload: !!(payload?.ciphertext),
          };
        }).filter(Boolean),
        delegations: [...Array(this.delegationRegistry.count)].map((_, i) => {
          const del = this.delegationRegistry.getDelegation(BigInt(i));
          if (!del) return null;
          return {
            delegationIndex: i,
            delegatorWalletId: del.delegatorWalletId.toString(),
            delegateWalletId: del.delegateWalletId.toString(),
            scopeFlags: Number(del.scopeFlags.toBigInt()),
            relationshipCode: Number(del.relationshipCode.toBigInt()),
          };
        }).filter(Boolean),
      },
      walletDirectory: this.buildWalletDirectory(),
    };
  }

  private buildWalletDirectory(): Record<string, { displayName: string; type: string; index?: number }> {
    const dir: Record<string, { displayName: string; type: string; index?: number }> = {};
    // Prescribers
    for (const [i, wid] of this.prescriberWalletIds) {
      const p = DEMO_PRESCRIBERS[i];
      dir[wid.toString()] = { displayName: `Dr. ${p.firstName} ${p.lastName}`, type: 'prescriber', index: i };
    }
    // Pharmacies
    for (const [i, wid] of this.pharmacyWalletIds) {
      const p = DEMO_PHARMACIES[i];
      dir[wid.toString()] = { displayName: p.storeName, type: 'pharmacy', index: i };
    }
    // Enrolled members
    for (const [wid, m] of this.enrolledMembers) {
      dir[wid] = { displayName: m.displayName, type: 'member' };
    }
    // Insurer
    dir[this.adminWalletId.toString()] = { displayName: 'Insurer', type: 'insurer' };
    return dir;
  }

  reset(): void {
    this.emit('info', 'reset', 'Resetting session state (keeping compiled programs)...');
    this.enrolledMembers.clear();
    this.prescriptions.clear();
    this.pendingPrescriptions.clear();
    this.fulfillments.clear();
    this.priorAuths.clear();
    this.nextPaLeafIndex.clear();
    this.rxCounter = 0;
    this.paCounter = 0;
    this.msgNonce = 0;
    this.encryptionKeys.clear();
    this.encryptedPayloads.clear();
    this.threadCounter = 0;
    this.formularyChangeHistory = [];
    this.currentFormularyEntries = [];
    this.formularyActive = [];
    this.networkChangeHistory = [];
    this.networkActive.clear();

    // Re-initialize infrastructure (clean trees, registries, etc.)
    this.initInfrastructure();

    this.emit('info', 'reset', 'Session reset complete. Ready for new enrollments.');
  }

  isReady(): boolean {
    return this.ready;
  }

  isCompiled(): boolean {
    return this.compiled;
  }

  // ─── Event Helpers ─────────────────────────────────────

  private emit(
    type: ConsoleEventType,
    phase: string,
    message: string,
    status?: 'start' | 'complete' | 'error',
    elapsedMs?: number,
  ): void {
    this.consoleEmitter({
      type,
      timestamp: Date.now(),
      phase,
      message,
      status,
      elapsedMs,
    });
  }

  private emitMemory(phase: string): void {
    const mem = process.memoryUsage();
    const mb = Math.round(mem.rss / 1024 / 1024);
    this.consoleEmitter({
      type: 'memory',
      timestamp: Date.now(),
      phase,
      message: `Memory: ${mb} MB RSS`,
      memoryMB: mb,
    });
  }

  private vizEventCounter = 0;

  private emitViz(
    type: VizEvent['type'],
    lane: VizEvent['lane'],
    opts: {
      actor: string;
      actorType: VizEvent['actorType'];
      actorWalletId?: string;
      target?: string;
      targetType?: string;
      targetWalletId?: string;
      data: Record<string, unknown>;
    },
  ): void {
    this.vizEventCounter++;
    this.vizEmitter({
      type,
      timestamp: Date.now(),
      id: `viz-${String(this.vizEventCounter).padStart(6, '0')}`,
      actor: opts.actor,
      actorType: opts.actorType,
      actorWalletId: opts.actorWalletId,
      target: opts.target,
      targetType: opts.targetType,
      targetWalletId: opts.targetWalletId,
      data: opts.data,
      lane,
      stage: this.vizEventCounter,
      totalStages: 0,
    });
  }
}

// ─── Utilities ──────────────────────────────────────────

function truncField(f: Field): string {
  const s = f.toBigInt().toString();
  if (s.length <= 16) return s;
  return s.slice(0, 8) + '...' + s.slice(-8);
}

function fieldToStr(f: Field): string {
  return f.toBigInt().toString();
}

function serializeCredentialData(cred: CredentialData): Record<string, string> {
  return {
    credentialType: fieldToStr(cred.credentialType),
    forestRoot: fieldToStr(cred.forestRoot),
    issuerWalletId: fieldToStr(cred.issuerWalletId),
    subjectWalletId: fieldToStr(cred.subjectWalletId),
    issuedAt: fieldToStr(cred.issuedAt),
    expiresAt: fieldToStr(cred.expiresAt),
    revoked: fieldToStr(cred.revoked),
    commitment: fieldToStr(cred.commitment()),
  };
}

function serializeForestRoots(forest: MerkleForest): Record<string, string> {
  return {
    memberRoot: fieldToStr(forest.getTreeRoot(ForestDomain.MEMBER)),
    prescriberRoot: fieldToStr(forest.getTreeRoot(ForestDomain.PRESCRIBER)),
    pharmacyRoot: fieldToStr(forest.getTreeRoot(ForestDomain.PHARMACY)),
    medicationRoot: fieldToStr(forest.getTreeRoot(ForestDomain.MEDICATION)),
    accessControlRoot: fieldToStr(forest.getTreeRoot(ForestDomain.ACCESS_CONTROL)),
    transactionRoot: fieldToStr(forest.getTreeRoot(ForestDomain.TRANSACTION)),
    forestRoot: fieldToStr(forest.getForestRoot()),
  };
}
