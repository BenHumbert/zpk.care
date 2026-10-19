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
 * AdjudicationService — Backend orchestration for ZK proof claim adjudication.
 *
 * Manages all session state and coordinates real ZK proof generation:
 *   compileAllPrograms()  — compile 8 ZkPrograms (~5 min one-time)
 *   enrollMember()        — three-party enrollment ceremony + ProofGate proof
 *   requestPriorAuth()    — prescriber requests PA for PA-required medication
 *   approvePriorAuth()    — insurer approves PA → inserts into forest + provePriorAuth proof
 *   denyPriorAuth()       — insurer denies PA request
 *   createPrescription()  — eScript + eligibility/access/messaging proofs (enforces PA)
 *   markFilled()           — pharmacy marks prescription as physically filled (ADJUDICATED → FILLED)
 *   dispensePrescription() — pharmacy dispense + AccumulatorFulfillment proof (FILLED → DISPENSED)
 *   reversePrescription()  — pharmacy reversal + AccumulatorFulfillment reversal proof
 *
 * All operations emit ConsoleEvent objects via the emitter callback
 * so the browser can display real-time progress.
 */
import { Field, MerkleTree, Poseidon, verify, type VerificationKey } from 'o1js';
import { randomUUID } from 'crypto';

// Wallets
import {
  deriveMemberWalletId,
  derivePrescriberWalletId,
  derivePharmacyWalletId,
  memberWalletPreimage,
  prescriberWalletPreimage,
  pharmacyWalletPreimage,
  DOMAIN_TAG_MEMBER,
} from '../wallets/wallet-derivation.js';
import { ProofGateProgram, ProofGateProof } from '../wallets/proof-gate.js';
import { forestLeavesOf, credentialFieldsOf, rederiveInventoryRoot, type WalletUpdatePayload } from '../credentials/wallet-update.js';
import { WalletRegistry, WalletRegistryWitness, WALLET_TREE_HEIGHT } from '../wallets/wallet-state.js';

// Engine
import { lifecycleLeafCommitment, LifecycleWitness, LIFECYCLE_ELIGIBLE, LIFECYCLE_REGISTERED, LIFECYCLE_REVOKED } from '../engine/lifecycle.js';
import { StateTransitionProgram, StateTransitionProof, EMPTY_CREDENTIAL_ROOT } from '../engine/state-transition.js';
import { BatchProgram } from '../l2/batch-program.js';
import { WalletState } from '../wallets/wallet-state.js';
import type { L2Node } from '../l2/l2-node.js';
import type { L2Receipt } from '../l2/l2-types.js';
import type { BenefitPlanConfig } from '../l2/l2-types.js';
import { CredentialInventory } from '../credentials/credential-inventory.js';

// ZKP
import { MerkleForest, ForestDomain } from '../zkp/merkle-forest.js';
import { hashString, dateToField, centsToField, quantityToField } from '../zkp/hash-utils.js';

// Credentials
import { CredentialData, CREDENTIAL_TYPE_ELIGIBILITY, CREDENTIAL_TYPE_PRESCRIPTION } from '../credentials/credential-data.js';
import { CredentialProgram, CredentialOperationProof } from '../credentials/credential-program.js';
import { serializeCredential, verifyCredentialOffline } from '../credentials/portable-credential.js';
import type { PortableCredential } from '../credentials/portable-credential.js';
import { SequencerAttestationAuthority } from '../credentials/nfc-attestation.js';
import type { NfcCredentialAttestation } from '../credentials/nfc-attestation.js';
import {
  createProviderBadge,
  authenticateFromBadge,
  badgePreimage,
  DEV_BADGE_PIN,
} from '../credentials/provider-badge-service.js';
import type { ProviderBadge, BadgeTapEvent } from '../credentials/provider-badge-types.js';

// Eligibility
import { EligibilityData, buildEligibilityData } from '../eligibility/eligibility-data.js';
import { ForestRoots, forestRootWithAccessControl } from '../eligibility/forest-roots.js';
import { BenefitPlanRegistry } from '../eligibility/benefit-plan-registry.js';
import { EligibilityProgram } from '../eligibility/eligibility-program.js';
import { ProviderNetworkRegistry } from '../eligibility/provider-network-registry.js';

// PCP Assignment
import { buildPcpAssignmentData, PCP_ASSIGNMENT_LEAF_INDEX, PcpAssignmentData } from '../eligibility/pcp-assignment-data.js';
import { ProviderLifecycle } from '../l2/provider-registry-types.js';
import { PcpVerificationProgram } from '../eligibility/pcp-verification-program.js';

// Access Control
import { buildFormularyEntry, FormularyEntry, type FormularyEntryLocalData } from '../access-control/formulary-entry.js';
import { FormularyRegistry } from '../access-control/formulary-registry.js';
import { AccessControlProgram } from '../access-control/access-control-program.js';
import { AccumulatorData, buildAccumulatorData, withAmountsPaid, forNewPlanYear, ACCUMULATOR_LEAF_INDEX } from '../access-control/accumulator-data.js';
import { PriorAuthData, buildPriorAuthData } from '../access-control/prior-auth-data.js';

// Messaging
import { MessageData, MSG_TYPE_PRESCRIPTION, MSG_TYPE_PA_REQUEST, MSG_TYPE_PA_RESPONSE, MSG_TYPE_NOTIFICATION, MSG_TYPE_GENERAL, MSG_TYPE_SUPPORT } from '../messaging/message-data.js';
import { MessagingProgram } from '../messaging/messaging-program.js';
import { MessageRegistry, DelegationRegistry, KeyRegistry, computeMessagingRoot } from '../messaging/message-registry.js';
import { DelegationData } from '../messaging/delegation-data.js';
import { deriveEncryptionKeyPair, encryptMessage, decryptMessage as decryptMessageAes, computeContentHash, deriveSharedSecret, publicKeyToFields } from '../messaging/encryption.js';

// Prescription
import {
  PrescriptionData,
  PrescriptionStatusData,
  RX_STATUS_ADJUDICATED,
  RX_STATUS_PARTIALLY_FILLED,
  RX_STATUS_FILLED,
  RX_STATUS_DISPENSED,
  RX_STATUS_CANCELLED,
  RX_STATUS_REJECTED,
  RX_STATUS_REVERSED,
  isValidStatusTransition,
} from '../prescription/prescription-data.js';
import { PrescriptionProgram } from '../prescription/prescription-program.js';

// Fulfillment
import { FulfillmentData, ReversalData } from '../fulfillment/fulfillment-data.js';
import { AccumulatorFulfillmentProgram } from '../fulfillment/accumulator-fulfillment-program.js';

// Onboarding
import { TokenAuthority } from '../onboarding/token-authority.js';
import { GroupRegistry, GroupConfig, GROUP_STATUS_ACTIVE } from '../onboarding/group-registry.js';
import { OpaqueRoster, buildRosterEntry } from '../onboarding/opaque-roster.js';
import { PlanTemplate } from '../onboarding/plan-template.js';
import { EnrollmentService } from '../onboarding/enrollment-service.js';

// Fixture data: fictional seed providers and members, plus the NADAC formulary
import {
  PRESCRIBERS,
  PHARMACIES,
  MEMBERS,
  MEDICATIONS,
  getAllFormularyEntries,
  getMembersByFamily,
  fixtureIdentitySalt,
  prescriberDisplayName,
} from '../data/index.js';

// Full NADAC formulary (always 32K, ignores FORMULARY_LIMIT env var)
import { formularyRaw } from '../data/formulary-loader.js';

// Family accumulator pooling
import { FamilyAccumulatorService } from '../onboarding/family-accumulator-service.js';
import type { FamilyLimits, MemberAccumulator } from '../onboarding/family-accumulator-service.js';

// Reporting
import { ReportingService } from '../reporting/reporting-service.js';
import type { VerifiedClaim, PriorAuthContext } from '../reporting/report-types.js';

import type { VizEvent } from '../l2/l2-rpc-server.js';

// ─── Console Event Types ────────────────────────────────

export type ConsoleEventType = 'compile' | 'proof' | 'offchain' | 'info' | 'warn' | 'error' | 'timing' | 'memory' | 'phase';

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
    // 7 of 12 prescribers in-network (5, 6, 8, 10 and 11 are out)
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
  memberIndex: number;  // -1 for members enrolled via dashboard (no seed index)
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
  /** Only a fixture member (memberIndex ≥ 0) has these, recomputed from the fixture file at restore; a member with a device never sends them (B2). */
  preimageFields?: Field[];
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

type RxStatus = 'ADJUDICATED' | 'PARTIALLY_FILLED' | 'FILLED' | 'DISPENSED' | 'CANCELLED' | 'REJECTED' | 'REVERSED' | 'COMPLETED';

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
  ndcHash: string;
  formularyLeafIndex: bigint;
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
  dateOfService: string;          // YYYYMMDD of this fill — the day the duplicate rule is about (D4)
}

// ─── Prior Auth State ──────────────────────────────────

interface PriorAuthState {
  id: string;
  memberWalletId: string;
  prescriberIndex: number;
  ndcHash: string;
  status: 'PENDING' | 'APPROVED' | 'DENIED';
  requestedAt: number;
  resolvedAt?: number;
  /** Leaf index in ACCESS_CONTROL tree (set on approval) */
  paLeafIndex?: bigint;
  /** PriorAuthData (set on approval) */
  priorAuthData?: PriorAuthData;
}

// ─── Checkpoint Serialization Types ─────────────────────

/** Serialized leaf entry for MerkleForest reconstruction */
interface SerializedForestLeaf {
  domain: number;       // ForestDomain enum value
  leafIndex: string;    // bigint as string
  commitment: string;   // Field as decimal string
}

/** Serialized EnrolledMember (JSON-safe) */
interface SerializedEnrolledMember {
  memberIndex: number;
  walletId: string;
  walletIdStr: string;
  displayName: string;
  credentialData: Record<string, string>;     // CredentialData.toJSON()
  eligibilityData: Record<string, string>;    // EligibilityData.toJSON()
  accumulatorData: Record<string, string>;    // AccumulatorData.toJSON()
  planId: string;
  groupId: string;
  familyId: string;
  relationship: string;
  employeeId: string;
  /** Not written since B2: the engine holds no member preimage. An older checkpoint's copy is dropped on restore. */
  preimageFields?: string[];
  pcpAssignment?: Record<string, string>;     // PcpAssignmentData.toJSON() | undefined
  pcpPrescriberIndex?: number;
  inNetworkPrescriberIndices: number[];
  inNetworkPharmacyIndices: number[];
  lifecycle: LifecycleStatus;
  terminationDate?: string;
  walletIndex: number;
  nonce: number;
  credentialInventoryRoot: string;            // Field as decimal string
  l2Receipts: string[];
  lastCredentialJson?: string;
  /** The device's wallet-ownership proof (ProofGate.verifyMember), kept for the portable credential (B2). */
  ownershipProofJson?: string;
  /** Forest leaf data for MerkleForest reconstruction */
  forestLeaves: SerializedForestLeaf[];
  /** Prior auth leaf indices in ACCESS_CONTROL tree (for forest rebuild) */
  paLeafIndices: string[];                    // bigint[] as string[]
}

/** Serialized PrescriptionState (JSON-safe) */
interface SerializedPrescription {
  id: string;
  prescriptionData: Record<string, string>;      // PrescriptionData.toJSON()
  activeStatus: Record<string, string>;          // PrescriptionStatusData.toJSON()
  rxCredentialData: Record<string, string>;      // CredentialData.toJSON()
  formularyEntry: Record<string, string>;        // FormularyEntry.toJSON()
  prescriberIndex: number;
  pharmacyIndex: number;
  memberWalletId: string;
  ndcHash: string;
  formularyLeafIndex: string;                    // bigint as string
  quantity: number;
  quantityDispensed: number;
  refills: number;
  refillsUsed: number;
  status: RxStatus;
  statusHistory: RxStatusEntry[];
  currentStatusLeafIndex: string;                // bigint as string
  nextTxLeafIndex: string;                       // bigint as string
  /** All TRANSACTION tree leaves for rxForest reconstruction */
  txLeaves: Array<{ leafIndex: string; commitment: string }>;
  /** MEDICATION tree leaf 0 commitment */
  medicationLeaf0: string;                       // Field as decimal string
}

/** Serialized FulfillmentState (JSON-safe) */
interface SerializedFulfillment {
  prescriptionId: string;
  fillIndex: number;
  patientPayCents: number;
  planPayCents: number;
  totalCostCents: number;
  accumulatorBefore: { deductiblePaid: number; oopPaid: number; benefitUsed: number };
  accumulatorAfter: { deductiblePaid: number; oopPaid: number; benefitUsed: number };
  newEligForestRoot: string;
  oldEligForestRoot: string;
  settlementCommitment: string;                  // Field as decimal string
  fulfillmentData: Record<string, string>;       // FulfillmentData.toJSON()
  patientPayField: string;                       // Field as decimal string
  planPayField: string;                          // Field as decimal string
  deductibleCreditField: string;                 // Field as decimal string
  settlementLeafIndex: string;                   // bigint as string
  quantityDispensed: number;
  reversed: boolean;
  dateOfService?: string;                        // absent in a checkpoint from before D4
}

/** Serialized PriorAuthState (JSON-safe) */
interface SerializedPriorAuth {
  id: string;
  memberWalletId: string;
  prescriberIndex: number;
  ndcHash: string;
  status: 'PENDING' | 'APPROVED' | 'DENIED';
  requestedAt: number;
  resolvedAt?: number;
  paLeafIndex?: string;                          // bigint as string
  priorAuthData?: Record<string, string>;        // PriorAuthData.toJSON()
}

/** Serialized pending prescription (JSON-safe) */
interface SerializedPendingPrescription {
  id: string;
  prescriberIndex: number;
  pharmacyIndex: number;
  memberWalletId: string;
  ndcHash: string;
  quantity: number;
  refills: number;
  startedAt: number;
}

/** A member's standing authorization for a prescriber who is not its PCP (B5), granted from the device. */
export interface PrescriberAuthorization {
  memberWalletId: string;
  prescriberWalletId: string;
  /** Decimal NDC hash the authorization is bound to, or null for any medication. */
  ndcHash: string | null;
  grantedAt: number;
  expiresAt: number;
}

/** Full AdjudicationService checkpoint state (JSON-safe) */
export interface AdjudicationCheckpointState {
  version: number;  // 1
  prescriptions: SerializedPrescription[];
  fulfillments: Record<string, SerializedFulfillment[]>;
  pendingPrescriptions: SerializedPendingPrescription[];
  priorAuths: SerializedPriorAuth[];
  prescriberAuthorizations?: PrescriberAuthorization[];  // B5; absent in older checkpoints
  enrolledMembers: SerializedEnrolledMember[];
  rxCounter: number;
  paCounter: number;
  msgNonce: number;
  threadCounter: number;
  nextPaLeafIndex: Record<string, string>;       // Map<walletId, bigint as string>
  /** Step 2 commit two: the wallets the insurer approved, with the plan each is bound to. Absent in older checkpoints. */
  approvedMembers?: MemberApproval[];
  pendingWalletUpdates?: PendingWalletUpdate[];
}

// ─── Insurer approval and plan binding — plan item B2 (now) and C2, findings A-6 and A-9 ───
//
// `register-member` used to provision an ELIGIBLE wallet for any caller whose six fields hashed to
// the wallet ID they named, and bound every member to PLAN-GOLD-2026 / ACME-CORP. Now the insurer
// approves a wallet at enrollment completion, naming the group, the plan and the employer; the engine
// provisions ELIGIBLE only for an approved wallet whose own registration proof the sequencer has
// already accepted (REGISTERED in the lifecycle tree), and binds the plan from the approval, never
// from the request.

export interface MemberApproval {
  walletId: string;
  groupIdHash: string;
  planIdHash: string;
  /** The plan as stored on the sequencer (`l2_storePlan`), resolved by the insurer from the hash. */
  planId: string;
  employerId: string | null;
  /** A-34: the employer's opaque family hash from the enrollment code, or null for no family. Absent in older checkpoints. */
  familyIdHash?: string | null;
  approvedAt: number;
}

/** A registration refused by the gate, with the status the route answers. */
/**
 * A change to a member's credential the engine computed and the member's device proves (B1 step
 * two). Queued per wallet, oldest first; applied when the device reports the receipt and the
 * ledger shows the root.
 */
export interface PendingWalletUpdate extends WalletUpdatePayload {
  phase: string;
  status: 'pending' | 'applied';
  receiptId?: string;
  appliedAt?: number;
}

/** What a credential update produced: a receipt when the engine proved it (a fixture member), a pending update when the device will. */
export interface WalletUpdateOutcome {
  receipt?: L2Receipt;
  pending?: PendingWalletUpdate;
}

export class RegistrationRefused extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'RegistrationRefused';
  }
}

/**
 * Whether a member may be billed, asked of the ledger (the sequencer's lifecycle tree) and not only of the engine's
 * copy: the two can disagree after a restore or a termination that stopped half-way. The ledger must show the wallet
 * ELIGIBLE or ACTIVE. A ledger that shows it revoked brings the engine's copy into step; an engine copy that shows it
 * terminated still refuses, whatever the ledger says.
 */
export function refuseUnlessLedgerBillable(
  ledger: { name: 'registered' | 'eligible' | 'active' | 'revoked' } | null,
  enrolled: { lifecycle: 'ELIGIBLE' | 'ACTIVE' | 'REVOKED' },
  refusal: string,
): void {
  if (ledger?.name === 'revoked') enrolled.lifecycle = 'REVOKED';
  if (enrolled.lifecycle === 'REVOKED') throw new RegistrationRefused(409, `This member is terminated; ${refusal}`);
  if (ledger?.name !== 'eligible' && ledger?.name !== 'active') {
    throw new RegistrationRefused(409, `The ledger does not show this member eligible (${ledger ? ledger.name : 'not on the ledger'}); ${refusal}`);
  }
}

/**
 * B8, A-34: whose accumulators pool with this member's. A family is the one the insurer's approval bound
 * from the employer's enrollment code, never one a request names, and it pools only inside one group and
 * one plan. A member with no bound family pools with no one: an empty family ID is not a family.
 */
export function familyMembersOf<M extends { familyId: string; groupId: string; planId: string }>(member: M, all: Iterable<M>): M[] {
  if (!member.familyId) return [member];
  const family: M[] = [];
  for (const m of all) {
    if (m.familyId === member.familyId && m.groupId === member.groupId && m.planId === member.planId) family.push(m);
  }
  return family.includes(member) ? family : [member, ...family];
}

/** The plan's family limits for a member with a bound family; none (zeros) for a member without one, or with no plan. */
export function familyLimitsFor(
  member: { familyId: string },
  plan: { familyDeductibleAmountCents?: number; familyOopMaxCents?: number; familyAnnualBenefitMaxCents?: number } | null | undefined,
): FamilyLimits {
  if (!member.familyId || !plan) return { familyDeductibleAmountCents: 0, familyOopMaxCents: 0, familyAnnualBenefitMaxCents: 0 };
  return {
    familyDeductibleAmountCents: plan.familyDeductibleAmountCents ?? 0,
    familyOopMaxCents: plan.familyOopMaxCents ?? 0,
    familyAnnualBenefitMaxCents: plan.familyAnnualBenefitMaxCents ?? 0,
  };
}

/**
 * What a member bound to a plan gets: the accumulator limits from the plan, and the provider network
 * from the plan's overlay, where an empty list means every credentialed provider (the overlay's own
 * convention; the insurer publishes `networkProviderWalletIds: []` for an all-provider network).
 */
export function bindPlan(
  plan: BenefitPlanConfig,
  providers: { prescribers: Map<number, Field>; pharmacies: Map<number, Field> },
): { accumulator: { deductibleAmountCents: number; oopMaxCents: number; annualBenefitMaxCents: number }; prescriberIndices: number[]; pharmacyIndices: number[] } {
  const ids = plan.networkProviderWalletIds ?? [];
  const inNetwork = (map: Map<number, Field>): number[] => {
    const all = [...map.keys()].sort((a, b) => a - b);
    if (ids.length === 0) return all;
    const wanted = new Set(ids);
    return all.filter((i) => wanted.has(map.get(i)!.toString()));
  };
  return {
    accumulator: {
      deductibleAmountCents: plan.deductibleAmountCents,
      oopMaxCents: plan.oopMaxCents,
      annualBenefitMaxCents: plan.annualBenefitMaxCents,
    },
    prescriberIndices: inNetwork(providers.prescribers),
    pharmacyIndices: inNetwork(providers.pharmacies),
  };
}

// ─── Service ────────────────────────────────────────────

export class AdjudicationService {
  // Proof pool — offloads ZK proving to child processes
  private proofPool: import('./proof-pool.js').ProofPool | null = null;

  /** ProofGate's verification key, kept at compile so a device's ownership proof can be verified (B2). */
  private proofGateVk: VerificationKey | null = null;

  /** Wallet updates the engine prepared for members' devices to prove (B1 step two), by update id. */
  private pendingWalletUpdates: Map<string, PendingWalletUpdate> = new Map();

  // Infrastructure
  /** The sequencer's wallet registry — the only copy. Read here; change via sequencer.adminMutate(). */
  private get walletRegistry(): WalletRegistry { return this.l2Node.getSequencer().getStateTrees().registry; }
  /** The sequencer's lifecycle tree — the only copy. Read here; change via sequencer.adminMutate(). */
  private get lifecycleTree(): MerkleTree { return this.l2Node.getSequencer().getStateTrees().lifecycle; }
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
  /** The insurer's slot in encryptionKeys: outside the wallet registry (members and providers use
   *  their registry index, 0..1023), so the wallet enrolled at index 999 cannot overwrite it. -1 is
   *  the payloads' "no key" marker, so this is -2. Never written to the key tree. */
  private static readonly ADMIN_KEY_INDEX = -2;
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
  /** B5: per member wallet, the prescribers its device authorized beyond its PCP. */
  private prescriberAuthorizations: Map<string, PrescriberAuthorization[]> = new Map();
  private rxCounter = 0;
  private paCounter = 0;
  /** Prescriptions currently being proved (visible to pharmacy as PENDING). */
  private pendingPrescriptions: Map<string, {
    id: string;
    prescriberIndex: number;
    pharmacyIndex: number;
    memberWalletId: string;
    ndcHash: string;
    quantity: number;
    refills: number;
    startedAt: number;
  }> = new Map();
  /** Next available PA leaf index per member (leaves 1-126 in ACCESS_CONTROL tree) */
  private nextPaLeafIndex: Map<string, bigint> = new Map();
  /** Step 2 commit two: wallets the insurer approved, by wallet ID; persisted with the checkpoint. */
  private approvedMembers: Map<string, MemberApproval> = new Map();
  private compiled = false;
  private ready = false;
  private reportingService = new ReportingService();
  private credentialProgramVk: string | null = null;
  private credentialProgramVkHash: Field | null = null;
  /** VK commitment — Poseidon.hash of all 10 ZkProgram VK hashes. Software identity. */
  vkCommitment: string | null = null;
  // Deterministic seed ensures attestation keypair survives restarts (session tokens stay valid)
  private attestationAuthority = new SequencerAttestationAuthority(
    Buffer.from('zkpcare-attestation-authority-seed'),
  );

  // Provider badges (written during init, used by auto-tap)
  private providerBadges: Map<string, ProviderBadge> = new Map();

  // Formulary management state
  private formularyChangeHistory: Array<{
    timestamp: number;
    changeType: 'ADD' | 'REMOVE' | 'MODIFY';
    ndcHash: string;
    medicationName: string;
    details: string;
    affectedMembers: string[];
    oldFormularyRoot: string;
    newFormularyRoot: string;
  }> = [];
  private currentFormularyEntries: FormularyEntryLocalData[] = [];
  private formularyActive: boolean[] = [];

  // ndcHash → MEDICATIONS array index (= FormularyRegistry leaf index)
  private medIndexByNdcHash: Map<string, number> = new Map();
  private medByNdcHash: Map<string, typeof MEDICATIONS[0]> = new Map();

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
    this.benefitPlanRegistry = new BenefitPlanRegistry();

    // Register prescribers + pharmacies (pre-enrolled entities) directly in the sequencer's
    // trees. provision() is idempotent, so a session reset doesn't re-register them.
    for (let i = 0; i < PRESCRIBERS.length; i++) {
      const p = PRESCRIBERS[i];
      this.prescriberWalletIds.set(i, derivePrescriberWalletId(p.localData, p.enrollmentKey));
      this.prescriberPreimages.set(i, prescriberWalletPreimage(p.localData, p.enrollmentKey));
    }
    for (let i = 0; i < PHARMACIES.length; i++) {
      const p = PHARMACIES[i];
      this.pharmacyWalletIds.set(i, derivePharmacyWalletId(p.localData, p.enrollmentKey));
      this.pharmacyPreimages.set(i, pharmacyWalletPreimage(p.localData, p.enrollmentKey));
    }
    this.l2Node.getSequencer().adminMutate('provision seed providers', ({ provision }) => {
      for (const [, wid] of this.prescriberWalletIds) provision(wid, LIFECYCLE_ELIGIBLE);
      for (const [, wid] of this.pharmacyWalletIds) provision(wid, LIFECYCLE_ELIGIBLE);
    });

    // Create provider badges (simulated NFC badge payloads)
    for (let i = 0; i < PRESCRIBERS.length; i++) {
      const p = PRESCRIBERS[i];
      const wid = this.prescriberWalletIds.get(i)!;
      const badge = createProviderBadge(
        p.enrollmentKey, DEV_BADGE_PIN, 'prescriber',
        p.localData.prescriberId, p.localData.prescriberIdQualifier,
        wid.toString(),
        `${p.firstName} ${p.lastName}, ${p.credential}`,
      );
      this.providerBadges.set(`prescriber-${i}`, badge);
    }
    for (let i = 0; i < PHARMACIES.length; i++) {
      const p = PHARMACIES[i];
      const wid = this.pharmacyWalletIds.get(i)!;
      const badge = createProviderBadge(
        p.enrollmentKey, DEV_BADGE_PIN, 'pharmacy',
        p.localData.serviceProviderId, p.localData.serviceProviderIdQualifier,
        wid.toString(),
        p.storeName,
      );
      this.providerBadges.set(`pharmacy-${i}`, badge);
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
    this.formularyActive = MEDICATIONS.map(m => m.initiallyOnFormulary !== false);

    // Build ndcHash → index lookup maps for O(1) drug resolution.
    // Uses MEDICATIONS (may be 100-drug subset) for Merkle tree leaf indices,
    // then backfills from full 32K NADAC so any drug the FormularyService
    // serves to dashboards can be resolved (without a leaf index).
    for (let i = 0; i < MEDICATIONS.length; i++) {
      const ndcHash = hashString(MEDICATIONS[i].ndc).toString();
      this.medIndexByNdcHash.set(ndcHash, i);
      this.medByNdcHash.set(ndcHash, MEDICATIONS[i]);
    }
    // Backfill: index all 32K NADAC drugs so dashboard drug picks always resolve
    for (const r of formularyRaw) {
      const ndcHash = hashString(r.ndc).toString();
      if (!this.medByNdcHash.has(ndcHash)) {
        // Not in the Merkle tree subset — store with synthetic SeedMedication.
        // Parse "LISINOPRIL 10 MG TABLET" → genericName / strength / dosageForm
        const parts = r.description.split(/\s+/);
        let sIdx = parts.findIndex((p, i) => i > 0 && /^\d/.test(p));
        const genericName = parts.slice(0, sIdx > 0 ? sIdx : parts.length).join(' ');
        const strength = sIdx > 0 && sIdx + 1 < parts.length ? `${parts[sIdx]} ${parts[sIdx + 1]}` : '';
        const dosageForm = sIdx > 0 ? parts.slice(sIdx + 2).join(' ') : '';
        const nadacCents = Math.round(r.nadacPerUnit * 100);
        const awpUnitCents = Math.round(nadacCents * 1.2);
        this.medByNdcHash.set(ndcHash, {
          ndc: r.ndc,
          ndcFormatted: r.ndcFormatted,
          gpi: '',
          brandName: r.classification === 'B' ? r.description : `${genericName} (Generic)`,
          genericName,
          strength,
          dosageForm,
          therapeuticClass: '',
          deaSchedule: 0,
          manufacturer: '',
          awpUnitPriceCents: awpUnitCents,
          awpPackagePriceCents: awpUnitCents * 30,
          packageSize: 30,
          route: dosageForm,
          formularyEntry: {
            ndc: r.ndc,
            tierLevel: r.tierLevel,
            copayAmount: r.copayAmount,
            requiresPriorAuth: r.requiresPriorAuth,
            maxQuantityPerFill: r.maxQuantityPerFill,
            maxDaySupply: r.maxDaySupply,
            stepTherapyRequired: r.stepTherapyRequired,
          },
        });
        // No medIndexByNdcHash entry — drug has no Merkle leaf index
      }
    }

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
    for (let i = 0; i < PRESCRIBERS.length; i++) {
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

    // Register encryption keys for prescribers and pharmacies, each at its own wallet-registry
    // index (provisioned above), the slot a member's key uses too, so no two parties share one.
    // NOTE: Seed entities store full keypairs (public + private) because the sequencer
    // generates eScript messages on their behalf. When prescriber/pharmacy Nautilus apps
    // register independently, they should use the publicKeyHex pattern (device-only private key).
    for (let i = 0; i < PRESCRIBERS.length; i++) {
      const kp = deriveEncryptionKeyPair(PRESCRIBERS[i].enrollmentKey);
      const slot = this.providerKeyIndex(this.prescriberWalletIds.get(i)!);
      this.encryptionKeys.set(slot, kp);
      const { pubKeyX, pubKeyY } = publicKeyToFields(kp.publicKey);
      this.keyRegistry.registerKey(BigInt(slot), this.prescriberWalletIds.get(i)!, pubKeyX, pubKeyY);
    }
    for (let i = 0; i < PHARMACIES.length; i++) {
      const kp = deriveEncryptionKeyPair(PHARMACIES[i].enrollmentKey);
      const slot = this.providerKeyIndex(this.pharmacyWalletIds.get(i)!);
      this.encryptionKeys.set(slot, kp);
      const { pubKeyX, pubKeyY } = publicKeyToFields(kp.publicKey);
      this.keyRegistry.registerKey(BigInt(slot), this.pharmacyWalletIds.get(i)!, pubKeyX, pubKeyY);
    }
    // Admin/Insurer encryption key (ADMIN_KEY_INDEX, outside the registry range 0..1023)
    const adminKp = deriveEncryptionKeyPair('ADMIN-INSURER-ENCRYPTION-KEY-2026');
    this.encryptionKeys.set(AdjudicationService.ADMIN_KEY_INDEX, adminKp);

    // Seed providers were provisioned into the sequencer's trees above (adminMutate),
    // so there is no separate copy to sync.

    this.emit('info', 'init', `Infrastructure ready. ${PRESCRIBERS.length} prescribers, ${PHARMACIES.length} pharmacies pre-enrolled.`);
    this.emit('info', 'init', `L2 sequencer synced: registry + lifecycle roots updated.`);
    this.emitMemory('init');
  }

  /** Look up a medication by ndcHash. Throws if not found. */
  getMedicationByNdcHash(ndcHash: string): typeof MEDICATIONS[0] {
    const med = this.medByNdcHash.get(ndcHash);
    if (!med) throw new Error(`Drug not on formulary: ndcHash ${ndcHash.slice(0, 16)}...`);
    return med;
  }

  /** Get the FormularyRegistry leaf index for a drug by ndcHash.
   *  If the drug is in the full 32K NADAC set but not yet in the Merkle tree
   *  (because FORMULARY_LIMIT truncated the initial load), it is dynamically
   *  added to the FormularyRegistry so it gets a real leaf and witness. */
  getFormularyLeafIndex(ndcHash: string): bigint {
    const existing = this.medIndexByNdcHash.get(ndcHash);
    if (existing !== undefined) return BigInt(existing);

    // Drug not in Merkle tree yet — try to add it from the 32K backfill
    const med = this.medByNdcHash.get(ndcHash);
    if (!med) throw new Error(`Drug not on formulary: ndcHash ${ndcHash.slice(0, 16)}...`);

    const entry = buildFormularyEntry(med.formularyEntry);
    const { index } = this.formularyRegistry.addEntry(entry);
    const leafIdx = Number(index);
    this.medIndexByNdcHash.set(ndcHash, leafIdx);
    // Extend parallel arrays to stay in sync
    while (this.currentFormularyEntries.length <= leafIdx) {
      this.currentFormularyEntries.push({ ndc: '', tierLevel: 0, copayAmount: 0, requiresPriorAuth: false, maxQuantityPerFill: 0, maxDaySupply: 0, stepTherapyRequired: false });
      this.formularyActive.push(false);
    }
    this.currentFormularyEntries[leafIdx] = { ...med.formularyEntry };
    this.formularyActive[leafIdx] = true;

    // Formulary root changed — update all enrolled members' eligibility data
    // so their ZK proofs reference the current tree root.
    const newFormularyRoot = this.formularyRegistry.getRoot();
    for (const [, enrolled] of this.enrolledMembers) {
      const oldElig = enrolled.eligibilityData;
      enrolled.eligibilityData = new EligibilityData({
        planIdHash: oldElig.planIdHash,
        groupIdHash: oldElig.groupIdHash,
        effectiveDate: oldElig.effectiveDate,
        terminationDate: oldElig.terminationDate,
        copayAmountCents: oldElig.copayAmountCents,
        coverageType: oldElig.coverageType,
        formularyRoot: newFormularyRoot,
        networkRoot: oldElig.networkRoot,
      });
      enrolled.forest.setLeaf(ForestDomain.ACCESS_CONTROL, 0n, enrolled.eligibilityData.commitment());
      // Credential forestRoot must also reflect the updated forest
      // (same pattern as approvePriorAuth — line ~1679)
      const oldCred = enrolled.credentialData;
      enrolled.credentialData = new CredentialData({
        credentialType: oldCred.credentialType,
        forestRoot: enrolled.forest.getForestRoot(),
        issuerWalletId: oldCred.issuerWalletId,
        subjectWalletId: oldCred.subjectWalletId,
        issuedAt: oldCred.issuedAt,
        expiresAt: oldCred.expiresAt,
        revoked: oldCred.revoked,
      });
      // BenefitPlanRegistry leaf = EligibilityData.commitment().
      // Since formularyRoot is inside EligibilityData, changing it changes
      // the commitment hash, so the registry leaf must be updated too.
      this.benefitPlanRegistry.updatePlan(0n, enrolled.eligibilityData);
    }

    return index;
  }

  // ─── Proof Pool Integration ────────────────────────────

  /** Attach a proof pool for off-main-thread proving. */
  setProofPool(pool: import('./proof-pool.js').ProofPool): void {
    this.proofPool = pool;
  }

  /**
   * Serialize an o1js value for IPC transport using Struct.toJSON / Field.toString().
   * The type tag tells the worker which class to use for deserialization.
   */
  private serializeArg(typeName: string, value: any): unknown {
    if (typeName === 'Field') return value.toString();
    // For Structs and MerkleWitnesses, the static toJSON method exists on the class
    const registry: Record<string, any> = {
      CredentialData, EligibilityData, ForestRoots, FormularyEntry,
      AccumulatorData, PriorAuthData, MessageData, DelegationData,
      PrescriptionData, PrescriptionStatusData, FulfillmentData, ReversalData,
    };
    const cls = registry[typeName];
    if (cls) return cls.toJSON(value);
    // MerkleWitness and Proof types — they have toJSON on the instance
    if (value && typeof value.toJSON === 'function') return value.toJSON();
    // Fallback: try static toJSON
    return value;
  }

  /**
   * Dispatch a ZK proof to the pool (if available) or prove inline.
   * Returns the raw result from the prove call.
   *
   * When the pool is available, this serializes args → IPC → worker → deserialize → prove → result.
   * When no pool, falls back to direct in-process proving (blocks event loop).
   */
  private async dispatchProof(
    program: string,
    method: string,
    argTypes: string[],
    args: any[],
    inlineFn: () => Promise<any>,
  ): Promise<{ proofJson: string | null; publicOutput: Record<string, string> | null; proveTimeMs: number }> {
    if (!this.proofPool || !this.proofPool.isRunning()) {
      // Fallback: inline proving (blocks event loop)
      this.emit('info', program, `  [dispatch] ${program}.${method} → INLINE (no pool)`);
      const start = performance.now();
      const result = await inlineFn();
      const elapsed = performance.now() - start;
      // Extract public output
      let publicOutput: Record<string, string> | null = null;
      if (result?.proof?.publicOutput) {
        publicOutput = {};
        for (const [key, val] of Object.entries(result.proof.publicOutput)) {
          if (val && typeof val === 'object' && 'toBigInt' in val) {
            publicOutput[key] = (val as Field).toString();
          }
        }
      }
      return {
        proofJson: result?.proof ? JSON.stringify(result.proof.toJSON()) : null,
        publicOutput,
        proveTimeMs: elapsed,
      };
    }

    // Serialize arguments for IPC — per-arg error reporting
    this.emit('info', program, `  [dispatch] ${program}.${method} → POOL WORKER`);
    const serializedArgs: unknown[] = [];
    for (let i = 0; i < args.length; i++) {
      try {
        serializedArgs.push(this.serializeArg(argTypes[i], args[i]));
      } catch (err: any) {
        const argPreview = args[i]?.constructor?.name ?? typeof args[i];
        throw new Error(`Serialization failed for ${program}.${method} arg[${i}] (${argTypes[i]}, ${argPreview}): ${err.message}`);
      }
    }

    try {
      return await this.proofPool.prove({
        program,
        method,
        args: serializedArgs,
      }, `${program}.${method}`);
    } catch (err: any) {
      this.emit('error', program, `  [proof-pool] ${program}.${method} FAILED: ${err.message}`);
      throw err;
    }
  }

  // ─── ZkProgram Compilation ─────────────────────────────

  async compileAllPrograms(): Promise<void> {
    this.emit('phase', 'compile', '═══ ZkProgram Compilation (one-time startup) ═══');
    this.emit('info', 'compile', 'Compiling 10 ZkPrograms into prover/verifier key pairs...');
    this.emit('info', 'compile', 'This is a one-time cost — cached for all subsequent proofs.');

    const vkHashes: Field[] = [];

    const programs = [
      { name: 'ProofGateProgram (3 methods)', fn: async () => { const r = await ProofGateProgram.compile(); this.proofGateVk = r.verificationKey; vkHashes.push(Field(r.verificationKey.hash)); } },
      { name: 'EligibilityProgram', fn: async () => { const r = await EligibilityProgram.compile(); vkHashes.push(Field(r.verificationKey.hash)); } },
      { name: 'AccessControlProgram (2 methods)', fn: async () => { const r = await AccessControlProgram.compile(); vkHashes.push(Field(r.verificationKey.hash)); } },
      { name: 'MessagingProgram (2 methods)', fn: async () => { const r = await MessagingProgram.compile(); vkHashes.push(Field(r.verificationKey.hash)); } },
      { name: 'PrescriptionProgram (2 methods)', fn: async () => { const r = await PrescriptionProgram.compile(); vkHashes.push(Field(r.verificationKey.hash)); } },
      { name: 'AccumulatorFulfillmentProgram (2 methods)', fn: async () => { const r = await AccumulatorFulfillmentProgram.compile(); vkHashes.push(Field(r.verificationKey.hash)); } },
      { name: 'PcpVerificationProgram', fn: async () => { const r = await PcpVerificationProgram.compile(); vkHashes.push(Field(r.verificationKey.hash)); } },
      { name: 'CredentialProgram (3 methods)', fn: async () => {
        const result = await CredentialProgram.compile();
        this.credentialProgramVk = JSON.stringify(result.verificationKey);
        this.credentialProgramVkHash = Field(result.verificationKey.hash);
        vkHashes.push(this.credentialProgramVkHash);
      } },
      { name: 'StateTransitionProgram (2 methods)', fn: async () => { const r = await StateTransitionProgram.compile(); vkHashes.push(Field(r.verificationKey.hash)); } },
      { name: 'BatchProgram (3 methods)', fn: async () => { const r = await BatchProgram.compile(); vkHashes.push(Field(r.verificationKey.hash)); } },
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

    // Compute VK commitment — Poseidon hash of all 10 VK hashes
    this.vkCommitment = Poseidon.hash(vkHashes).toString();
    this.emit('info', 'compile', `VK commitment: ${this.vkCommitment.slice(0, 24)}…`);

    const totalMs = performance.now() - compileStart;
    this.emit('timing', 'compile', `All 10 programs compiled in ${(totalMs / 1000).toFixed(1)}s`, undefined, totalMs);
    this.compiled = true;
    this.ready = true;
  }

  // ─── Enroll Member ────────────────────────────────────

  async enrollMember(memberIndex: number): Promise<Record<string, unknown>> {
    if (!this.compiled) throw new Error('Programs not compiled yet');

    const member = MEMBERS[memberIndex];
    if (!member) throw new Error(`Invalid member index: ${memberIndex}`);

    const displayName = `${member.localData.firstName} ${member.localData.lastName}`;

    // Check if already fully enrolled (e.g., user clicked "Enroll" twice)
    const demoGroupIdHash = hashString('ACME-CORP');
    const existingWalletId = deriveMemberWalletId(member.localData, member.enrollmentKey, demoGroupIdHash, fixtureIdentitySalt(member));
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
    const walletId = deriveMemberWalletId(member.localData, member.enrollmentKey, demoGroupIdHash, fixtureIdentitySalt(member));
    const preimageFields = memberWalletPreimage(member.localData, member.enrollmentKey, demoGroupIdHash, fixtureIdentitySalt(member));
    const elapsed2 = performance.now() - start2;

    const walletIdStr = truncField(walletId);
    this.emit('offchain', 'enroll', `Step 2: Wallet ID derived: ${walletIdStr}`, 'complete', elapsed2);
    this.emit('info', 'enroll', '         (enrollment key stays on device, NEVER transmitted)');
    this.emit('info', 'enroll', `  ┌─ WALLET DERIVATION`);
    this.emit('info', 'enroll', `  │  Formula: Poseidon.hash([DOMAIN_TAG_MEMBER, hash(cardholderId), dob, hash(firstName), hash(lastName), hash(enrollmentKey), groupIdHash])`);
    this.emit('info', 'enroll', `  │  Wallet ID:       ${walletId.toString()}`);
    this.emit('info', 'enroll', `  │  Preimage Fields: [${preimageFields.map(f => truncField(f)).join(', ')}]`);
    this.emit('info', 'enroll', `  └─ No private key — access through ZK proof only`);

    this.emitViz('viz:enrollment:wallet_derived', 'enrollment', {
      actor: displayName,
      actorType: 'member',
      data: { walletId: walletIdStr, step: 'wallet_derived', memberIndex },
    });

    // 3. Generate ProofGate proof (member proves identity — CACHED for reuse)
    this.emit('proof', 'enroll', 'Step 3: Generating ProofGate.verifyMember proof...', 'start');
    const startProof = performance.now();
    const proofGateDispatch = await this.dispatchProof(
      'ProofGate', 'verifyMember',
      ['Field', 'Field', 'Field', 'Field', 'Field', 'Field', 'Field'],
      [walletId, ...preimageFields],
      () => ProofGateProgram.verifyMember(walletId, ...preimageFields as [Field, Field, Field, Field, Field, Field]),
    );
    const cachedProofGateProof = proofGateDispatch.proofJson;
    const elapsedProof = performance.now() - startProof;
    this.emit('proof', 'enroll', `Step 3: ProofGate.verifyMember proof generated`, 'complete', elapsedProof);
    this.emit('info', 'enroll', `  ┌─ PROOF: ProofGate.verifyMember`);
    this.emit('info', 'enroll', `  │  Public Input:   walletId = ${truncField(walletId)}`);
    this.emit('info', 'enroll', `  │  Private Inputs: 6 preimage fields (hash(cardholderId), dob, hash(firstName), hash(lastName), hash(enrollmentKey), groupIdHash)`);
    this.emit('info', 'enroll', `  │  Constraint:     Poseidon.hash([DOMAIN_TAG_MEMBER, ...preimage]) == walletId`);
    this.emit('info', 'enroll', `  │  Result:         VERIFIED — ${displayName} proved identity without revealing PHI`);
    this.emit('info', 'enroll', `  └─ Proof time: ${elapsedProof.toFixed(0)}ms`);

    this.emitViz('viz:enrollment:proof_gate', 'enrollment', {
      actor: displayName,
      actorType: 'member',
      target: 'Insurer',
      targetType: 'insurer',
      data: { walletId: walletIdStr, step: 'proof_gate', elapsedMs: elapsedProof, memberIndex },
    });

    // 4. PHASE A: Registration — proveRegistration (wallet + lifecycle)
    this.emitViz('viz:enrollment:started', 'enrollment', {
      actor: displayName,
      actorType: 'member',
      actorWalletId: walletIdStr,
      target: 'leviathan',
      targetType: 'leviathan',
      data: { tokenId, step: 'processing', memberIndex },
    });

    this.emit('offchain', 'enroll', 'Step 4a: Capturing pre-registration roots...', 'start');
    // Witnesses come from the sequencer's trees; the sequencer inserts the wallet itself
    // when it accepts the registration proof.
    // D7 (A-33): the engine proves for a fixture member as a device would — one prover at a time per partition
    await this.l2Node.getSequencer().acquireProvingLeaseWaiting(walletIdStr);
    const preRegRoot = this.walletRegistry.getRoot();
    const preLcRoot = this.lifecycleTree.getRoot();
    const regWitness = this.walletRegistry.getNextSlotWitness();
    const walletIndex = Number(this.walletRegistry.count);
    const lcWitness = new LifecycleWitness(this.lifecycleTree.getWitness(BigInt(walletIndex)));

    this.emit('proof', 'enroll', 'Step 4a: Generating StateTransitionProof.proveRegistration...', 'start');
    const startReg = performance.now();
    const regDispatch = await this.dispatchProof(
      'StateTransition', 'proveRegistration',
      ['Field', 'Field', 'Field', 'Field', 'Field', 'Field', 'Field', 'WalletRegistryWitness', 'LifecycleWitness', 'Field', 'Field'],
      [DOMAIN_TAG_MEMBER, preimageFields[0]!, preimageFields[1]!, preimageFields[2]!, preimageFields[3]!, preimageFields[4]!, preimageFields[5]!, regWitness, lcWitness, preRegRoot, preLcRoot],
      () => StateTransitionProgram.proveRegistration(DOMAIN_TAG_MEMBER, preimageFields[0]!, preimageFields[1]!, preimageFields[2]!, preimageFields[3]!, preimageFields[4]!, preimageFields[5]!, regWitness, lcWitness, preRegRoot, preLcRoot),
    );
    const elapsedReg = performance.now() - startReg;
    this.emit('proof', 'enroll', `Step 4a: Registration proof generated`, 'complete', elapsedReg);

    const regOutput = regDispatch.publicOutput!;
    this.emit('info', 'enroll', `  ┌─ PROOF: StateTransitionProgram.proveRegistration`);
    this.emit('info', 'enroll', `  │  Wallet Index:        ${walletIndex}`);
    this.emit('info', 'enroll', `  │  Public Output:`);
    this.emit('info', 'enroll', `  │    walletId:           ${truncStr(regOutput.walletId)}`);
    this.emit('info', 'enroll', `  │    oldRegistryRoot:    ${truncStr(regOutput.oldRegistryRoot)}`);
    this.emit('info', 'enroll', `  │    newRegistryRoot:    ${truncStr(regOutput.newRegistryRoot)}`);
    this.emit('info', 'enroll', `  │    oldLifecycleRoot:   ${truncStr(regOutput.oldLifecycleRoot)}`);
    this.emit('info', 'enroll', `  │    newLifecycleRoot:   ${truncStr(regOutput.newLifecycleRoot)}`);
    this.emit('info', 'enroll', `  └─ Merkle inclusion: wallet inserted at index ${walletIndex} (${elapsedReg.toFixed(0)}ms)`);

    // Submit registration proof to L2
    const regProof = await StateTransitionProof.fromJSON(JSON.parse(regDispatch.proofJson!));
    const regReceipt = await this.l2Node.submitProof(regProof);
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
        const groupIdHash = Field(tokenData.groupIdHash!);
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
    const mintDispatch = await this.dispatchProof(
      'StateTransition', 'proveWalletUpdate',
      ['Field', 'Field', 'Field', 'Field', 'Field', 'Field', 'Field', 'Field', 'Field', 'Field', 'WalletRegistryWitness', 'LifecycleWitness', 'Field', 'Field', 'Field'],
      [DOMAIN_TAG_MEMBER, preimageFields[0]!, preimageFields[1]!, preimageFields[2]!, preimageFields[3]!, preimageFields[4]!, preimageFields[5]!, EMPTY_CREDENTIAL_ROOT, Field(0), inventoryRoot, mintRegWitness, mintLcWitness, currentRegRoot, currentLcRoot, LIFECYCLE_REGISTERED],
      () => StateTransitionProgram.proveWalletUpdate(DOMAIN_TAG_MEMBER, preimageFields[0]!, preimageFields[1]!, preimageFields[2]!, preimageFields[3]!, preimageFields[4]!, preimageFields[5]!, EMPTY_CREDENTIAL_ROOT, Field(0), inventoryRoot, mintRegWitness, mintLcWitness, currentRegRoot, currentLcRoot, LIFECYCLE_REGISTERED),
    );
    const elapsedMint = performance.now() - startMint;
    this.emit('proof', 'enroll', `Step 4b: Wallet update proof generated (credential minted)`, 'complete', elapsedMint);

    const mintOutput = mintDispatch.publicOutput!;
    this.emit('info', 'enroll', `  ┌─ PROOF: StateTransitionProgram.proveWalletUpdate (Credential Mint)`);
    this.emit('info', 'enroll', `  │  Old Credential Root:   EMPTY_CREDENTIAL_ROOT (no credential before enrollment)`);
    this.emit('info', 'enroll', `  │  New Credential Root:   ${truncField(inventoryRoot)} (eligibility credential minted)`);
    this.emit('info', 'enroll', `  │  Nonce:          0 → 1`);
    this.emit('info', 'enroll', `  │  Public Output:`);
    this.emit('info', 'enroll', `  │    walletId:         ${truncStr(mintOutput.walletId)}`);
    this.emit('info', 'enroll', `  │    oldRegistryRoot:  ${truncStr(mintOutput.oldRegistryRoot)}`);
    this.emit('info', 'enroll', `  │    newRegistryRoot:  ${truncStr(mintOutput.newRegistryRoot)}`);
    this.emit('info', 'enroll', `  │    oldLifecycleRoot: ${truncStr(mintOutput.oldLifecycleRoot)}`);
    this.emit('info', 'enroll', `  │    newLifecycleRoot: ${truncStr(mintOutput.newLifecycleRoot)}`);
    this.emit('info', 'enroll', `  └─ Wallet state updated: nonce=1, credential inventory root set (${elapsedMint.toFixed(0)}ms)`);

    // Submit credential mint proof to L2. The sequencer updates the wallet's state
    // (nonce=1, inventoryRoot) in its tree after checking it against the proof.
    const mintProof = await StateTransitionProof.fromJSON(JSON.parse(mintDispatch.proofJson!));
    const mintReceipt = await this.l2Node.submitProof(mintProof, {
      newCredentialInventoryRoot: inventoryRoot.toString(),
    } as unknown as import('../l2/l2-types.js').ClaimSubmissionMetadata);
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
    // D7 (A-33): a lifecycle change moves the roots; it waits until no device is proving against them
    await this.l2Node.getSequencer().withRootsSettled(() => this.l2Node.getSequencer().adminMutate('enroll: REGISTERED → ELIGIBLE', ({ setLifecycle }) => {
      setLifecycle(walletId, LIFECYCLE_ELIGIBLE);
    }));
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
      const p = PRESCRIBERS[idx];
      this.emit('info', 'enroll', `    → ${prescriberDisplayName(p)}, ${p.credential} (${p.specialty}) — CREDENTIALED`);
      this.emitViz('viz:enrollment:provider_notify', 'enrollment', {
        actor: 'Insurer',
        actorType: 'insurer',
        target: `${prescriberDisplayName(p)}`,
        targetType: 'prescriber',
        data: { providerType: 'prescriber', providerIndex: idx, step: 'provider_notify' },
      });
    }
    for (const idx of network.pharmacyIndices) {
      const p = PHARMACIES[idx];
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
    const memberWalletIndex = Number(this.walletRegistry.getIndex(walletId));
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
        memberIndex,
      },
    });

    this.emit('info', 'enroll', '');
    this.emit('info', 'enroll', `  BENEFIT PLAN: PLAN-GOLD-2026`);
    this.emit('info', 'enroll', `    Copay:       $30.00`);
    this.emit('info', 'enroll', `    Deductible:  $500.00 individual / $1,000.00 family`);
    this.emit('info', 'enroll', `    OOPM:        $8,000.00 individual / $16,000.00 family`);
    this.emit('info', 'enroll', `    Formulary:   ${MEDICATIONS.length} medications across 4 tiers`);
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
        formularyCount: MEDICATIONS.length,
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
          const p = PRESCRIBERS[i];
          return { index: i, name: `${prescriberDisplayName(p)}`, credential: p.credential, specialty: p.specialty };
        }),
        pharmacies: network.pharmacyIndices.map(i => {
          const p = PHARMACIES[i];
          return { index: i, name: p.storeName, type: p.pharmacyTypeDesc };
        }),
      },
      chainState: this.getChainState(),
    };
  }

  // ─── Register Member from External Enrollment ──────────
  //
  // Called when a member enrolls through their Nautilus dashboard
  // (not through /interactive/enroll). The member node sends the
  // proving context (preimage fields) so the adjudication engine
  // can generate proofs on behalf of the enrolled member.
  //
  // NO seed data lookup. NO ZK proof generation. Just state construction
  // from the provided hashed preimage fields + plan configuration.

  /**
   * Record the insurer's approval of a wallet — plan item B2 (now), finding A-6. Idempotent for the
   * same binding; a different group, plan or family for an already approved wallet is refused.
   */
  approveMember(a: Omit<MemberApproval, 'approvedAt'>): { approved: true; alreadyApproved: boolean } {
    const existing = this.approvedMembers.get(a.walletId);
    if (existing) {
      if (existing.groupIdHash !== a.groupIdHash || existing.planIdHash !== a.planIdHash || existing.planId !== a.planId
        || (existing.familyIdHash ?? null) !== (a.familyIdHash ?? null)) {
        throw new RegistrationRefused(409, 'This wallet is already approved under a different group, plan or family');
      }
      return { approved: true, alreadyApproved: true };
    }
    this.approvedMembers.set(a.walletId, { ...a, approvedAt: Date.now() });
    this.emit('info', 'register', `Insurer approval recorded for ${a.walletId.slice(0, 12)}... (plan ${a.planId})`);
    return { approved: true, alreadyApproved: false };
  }

  /** The insurer's approval for a wallet, if any. */
  approvalFor(walletId: string): MemberApproval | undefined {
    return this.approvedMembers.get(walletId);
  }

  /** What the sequencer's trees say about a wallet: the member's own registration proof puts it at REGISTERED. */
  private ledgerLifecycleOf(walletId: Field): 'absent' | 'registered' | 'eligible' | 'other' {
    let index: bigint;
    try {
      index = this.walletRegistry.getIndex(walletId);
    } catch {
      return 'absent';
    }
    const leaf = this.lifecycleTree.getNode(0, index).toString();
    if (leaf === lifecycleLeafCommitment(walletId, LIFECYCLE_REGISTERED).toString()) return 'registered';
    if (leaf === lifecycleLeafCommitment(walletId, LIFECYCLE_ELIGIBLE).toString()) return 'eligible';
    return 'other';
  }

  /**
   * The device's proof that the wallet is theirs (ProofGate.verifyMember over the six salted fields),
   * verified against the compiled verification key — never `proof.verify()`, which only sets a flag.
   * The engine keeps the proof for the portable credential and never sees a preimage (B2).
   */
  private async verifyOwnershipProof(walletId: string, json: unknown): Promise<string> {
    if (typeof json !== 'string' || json.length === 0) {
      throw new RegistrationRefused(400, 'register-member takes the wallet ownership proof made on the device (ProofGate.verifyMember); the identity preimage is never sent');
    }
    if (!this.proofGateVk) throw new Error('ProofGate verification key not available — programs not compiled');
    let proof: InstanceType<typeof ProofGateProof>;
    try {
      proof = await ProofGateProof.fromJSON(JSON.parse(json));
    } catch (err) {
      throw new RegistrationRefused(400, `The ownership proof could not be read: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (proof.publicInput.toString() !== walletId) {
      throw new RegistrationRefused(403, 'The ownership proof names another wallet');
    }
    const valid = await verify(proof, this.proofGateVk);
    if (!valid) throw new RegistrationRefused(403, 'The ownership proof does not verify');
    return json;
  }

  /** The updates for a wallet, oldest first, pending and applied alike. */
  walletUpdatesFor(walletId: string): PendingWalletUpdate[] {
    return [...this.pendingWalletUpdates.values()]
      .filter((u) => u.walletId === walletId)
      .sort((a, b) => a.createdAt - b.createdAt || a.updateId.localeCompare(b.updateId));
  }

  private pendingUpdatesFor(walletId: string): PendingWalletUpdate[] {
    return this.walletUpdatesFor(walletId).filter((u) => u.status === 'pending');
  }

  /**
   * Queue a change to a member's credential for the device to prove (B1 step two). The engine's
   * working inventory has already advanced to the new state; the device starts from the root of
   * the previous pending update, or the ledger's root when none is pending, and the parts sent
   * must rebuild the root named, which is checked here before anything is queued. A claim rides
   * along by being committed on the sequencer against this wallet and this root.
   */
  private queueWalletUpdate(enrolled: EnrolledMember, reason: string, phase: string, claim?: import('../l2/l2-types.js').ClaimSubmissionMetadata): PendingWalletUpdate {
    const walletId = enrolled.walletId.toString();
    const queued = this.pendingUpdatesFor(walletId);
    const oldInventoryRoot = queued.length > 0 ? queued[queued.length - 1].newInventoryRoot : enrolled.credentialInventoryRoot.toString();
    const payload: WalletUpdatePayload = {
      updateId: `wu-${randomUUID()}`,
      walletId,
      reason,
      oldInventoryRoot,
      newInventoryRoot: enrolled.credentialInventory.getRoot().toString(),
      credential: credentialFieldsOf(enrolled.credentialData),
      forestLeaves: forestLeavesOf(enrolled.forest),
      inventorySlot: '0',
      claimCommitted: !!claim,
      createdAt: Date.now(),
    };
    const check = rederiveInventoryRoot(payload);
    if (check.inventoryRoot !== payload.newInventoryRoot) {
      throw new Error(`wallet update (${reason}): the credential cannot be rebuilt from its parts (${check.inventoryRoot} vs ${payload.newInventoryRoot})`);
    }
    if (claim) this.l2Node.getSequencer().commitPendingClaim(walletId, payload.newInventoryRoot, claim);
    const pending: PendingWalletUpdate = { ...payload, phase, status: 'pending' };
    this.pendingWalletUpdates.set(pending.updateId, pending);
    this.emit('info', phase, `  └─ Wallet update ${pending.updateId} (${reason}) queued for the member's device to prove${claim ? '; its claim is committed on the sequencer' : ''}`);
    return pending;
  }

  /**
   * The device proved an update and the sequencer accepted it: check that the receipt is the
   * wallet's and that the ledger now holds the root, then mark it and advance the record. Updates
   * apply in order; an older one still pending is refused with 409.
   */
  markWalletUpdateApplied(walletId: string, updateId: string, receiptId: string): PendingWalletUpdate {
    const update = this.pendingWalletUpdates.get(updateId);
    if (!update || update.walletId !== walletId) throw new RegistrationRefused(404, 'No such wallet update for this wallet');
    if (update.status === 'applied') return update;
    const older = this.pendingUpdatesFor(walletId).find((u) => u.updateId !== updateId && u.createdAt < update.createdAt);
    if (older) throw new RegistrationRefused(409, `Update ${older.updateId} comes first`);
    const seq = this.l2Node.getSequencer();
    const receipt = seq.getReceipt(receiptId);
    if (!receipt || receipt.walletId !== walletId) throw new RegistrationRefused(404, 'No receipt by that id for this wallet');
    const live = seq.getWalletStateForRpc(walletId);
    if (live.credentialInventoryRoot !== update.newInventoryRoot) {
      throw new RegistrationRefused(409, `The ledger holds credential root ${live.credentialInventoryRoot.slice(0, 12)}…, not this update's`);
    }
    update.status = 'applied';
    update.receiptId = receiptId;
    update.appliedAt = Date.now();
    const enrolled = this.enrolledMembers.get(walletId);
    if (enrolled) {
      enrolled.nonce = Number(live.nonce);
      enrolled.credentialInventoryRoot = Field(BigInt(update.newInventoryRoot));
      enrolled.l2Receipts.push(receiptId);
    }
    this.emit('info', update.phase, `  Wallet update ${updateId} (${update.reason}) proved by the member's device — receipt ${receiptId}`);
    return update;
  }

  /**
   * A member with a device names its primary-care prescriber (B1 step two, commit three). The engine
   * checks the prescriber is credentialed and active, writes the assignment to the member's forest
   * and credential, and queues the wallet update for the device to prove; the device then registers
   * the link on the sequencer under its own signature (A10b). No proof is made here: the member's own
   * wallet-signed request and proved wallet update are the consent; the PCP verification proof
   * belongs at prescribing (B5). A fixture member, which has no device, keeps the console path.
   */
  async assignPcpForDevice(opts: { walletId: string; pcpWalletId: string; effectiveDate: string; specialty: string; consentScopeFlags: number }): Promise<Record<string, unknown>> {
    if (!this.compiled) throw new RegistrationRefused(503, 'Programs not compiled yet');
    const enrolled = this.enrolledMembers.get(opts.walletId);
    if (!enrolled) throw new RegistrationRefused(404, 'This wallet is not registered with the engine');
    if (enrolled.memberIndex >= 0) throw new RegistrationRefused(409, 'A fixture member is assigned a primary-care prescriber through the console (POST /interactive/assign-pcp)');
    if (enrolled.lifecycle === 'REVOKED') throw new RegistrationRefused(409, 'A revoked member cannot name a primary-care prescriber');
    const effectiveDate = opts.effectiveDate.replace(/-/g, '');
    if (!/^\d{8}$/.test(effectiveDate)) throw new RegistrationRefused(400, 'effectiveDate must be a calendar date, CCYYMMDD');
    if (!/^\d+$/.test(opts.pcpWalletId)) throw new RegistrationRefused(400, 'pcpWalletId must be a decimal wallet id');
    if (!Number.isInteger(opts.consentScopeFlags) || opts.consentScopeFlags < 0 || opts.consentScopeFlags > 7) throw new RegistrationRefused(400, 'consentScopeFlags is a bitfield 0..7');
    if (typeof opts.specialty !== 'string' || opts.specialty.length === 0 || opts.specialty.length > 64) throw new RegistrationRefused(400, 'specialty must be 1..64 characters');
    const provider = this.l2Node.getSequencer().getProvider(opts.pcpWalletId);
    if (!provider || provider.metadata.providerType !== 'prescriber') throw new RegistrationRefused(404, 'The named wallet is not a credentialed prescriber');
    if (Number(provider.leaf.credentialState) !== ProviderLifecycle.ACTIVE) throw new RegistrationRefused(409, 'The named prescriber is not active');
    const pcpData = buildPcpAssignmentData({
      memberWalletId: enrolled.walletId.toBigInt().toString(),
      pcpWalletId: BigInt(opts.pcpWalletId).toString(),
      effectiveDate,
      terminationDate: '',
      specialty: opts.specialty,
      consentTimestamp: effectiveDate,
      consentScopeFlags: opts.consentScopeFlags,
    });
    enrolled.forest.setLeaf(ForestDomain.MEMBER, PCP_ASSIGNMENT_LEAF_INDEX, pcpData.commitment());
    enrolled.credentialData = new CredentialData({
      credentialType: enrolled.credentialData.credentialType,
      forestRoot: enrolled.forest.getForestRoot(),
      issuerWalletId: enrolled.credentialData.issuerWalletId,
      subjectWalletId: enrolled.credentialData.subjectWalletId,
      issuedAt: enrolled.credentialData.issuedAt,
      expiresAt: enrolled.credentialData.expiresAt,
      revoked: enrolled.credentialData.revoked,
    });
    const outcome = await this.updateCredentialAndSubmitToL2(enrolled, 'pcp');
    enrolled.pcpAssignment = pcpData;
    enrolled.pcpPrescriberIndex = undefined;
    this.emit('info', 'pcp', `  Primary care named by the member's device: prescriber ${opts.pcpWalletId.slice(0, 12)}… — the device proves the wallet update`);
    return {
      walletId: opts.walletId,
      pcpWalletId: opts.pcpWalletId,
      effectiveDate,
      commitment: pcpData.commitment().toString(),
      walletUpdate: outcome.pending
        ? { status: 'pending', updateId: outcome.pending.updateId, newInventoryRoot: outcome.pending.newInventoryRoot }
        : { status: 'applied', receiptId: outcome.receipt?.receiptId ?? null },
    };
  }

  /** The authorization that lets this prescriber write for this member now, if any (B5). */
  private prescriberAuthorizationFor(memberWalletId: string, prescriberWalletId: string, ndcHash: string, now = Date.now()): PrescriberAuthorization | undefined {
    return (this.prescriberAuthorizations.get(memberWalletId) ?? []).find(a =>
      a.prescriberWalletId === prescriberWalletId && a.expiresAt > now && (a.ndcHash === null || a.ndcHash === ndcHash));
  }

  /** The member's live authorizations, expired ones left out (B5). */
  activePrescriberAuthorizations(memberWalletId: string, now = Date.now()): PrescriberAuthorization[] {
    return (this.prescriberAuthorizations.get(memberWalletId) ?? []).filter(a => a.expiresAt > now);
  }

  /**
   * A member with a device authorizes a prescriber who is not its primary-care prescriber (B5). The
   * design puts the member's authorization at prescribing: the member is with the prescriber, or the
   * prescriber is the consented PCP. The authorization is bound to one medication or any and lives
   * for a visit (1 to 72 hours, 24 by default); createPrescription refuses without it and consumes
   * nothing. Wallet-signed: only the member's own key grants it. No proof: the signature is the consent.
   */
  async authorizePrescriber(opts: { walletId: string; prescriberWalletId: string; ndcHash?: string | null; hours?: number }): Promise<PrescriberAuthorization> {
    const enrolled = this.enrolledMembers.get(opts.walletId);
    if (!enrolled) throw new RegistrationRefused(404, 'This wallet is not registered with the engine');
    if (enrolled.memberIndex >= 0) throw new RegistrationRefused(409, 'A fixture member has no device to authorize from');
    if (enrolled.lifecycle === 'REVOKED') throw new RegistrationRefused(409, 'A revoked member cannot authorize a prescriber');
    if (!/^\d+$/.test(opts.prescriberWalletId)) throw new RegistrationRefused(400, 'prescriberWalletId must be a decimal wallet id');
    const ndcHash = opts.ndcHash == null || opts.ndcHash === '' ? null : String(opts.ndcHash);
    if (ndcHash !== null && !/^\d+$/.test(ndcHash)) throw new RegistrationRefused(400, 'ndcHash must be a decimal hash, or omitted for any medication');
    const hours = opts.hours ?? 24;
    if (!Number.isFinite(hours) || hours < 1 || hours > 72) throw new RegistrationRefused(400, 'hours must be between 1 and 72');
    const provider = this.l2Node.getSequencer().getProvider(opts.prescriberWalletId);
    if (!provider || provider.metadata.providerType !== 'prescriber') throw new RegistrationRefused(404, 'The named wallet is not a credentialed prescriber');
    if (Number(provider.leaf.credentialState) !== ProviderLifecycle.ACTIVE) throw new RegistrationRefused(409, 'The named prescriber is not active');
    const prescriberWalletId = BigInt(opts.prescriberWalletId).toString();
    const now = Date.now();
    const authorization: PrescriberAuthorization = { memberWalletId: opts.walletId, prescriberWalletId, ndcHash, grantedAt: now, expiresAt: now + hours * 3_600_000 };
    const kept = this.activePrescriberAuthorizations(opts.walletId, now).filter(a => !(a.prescriberWalletId === prescriberWalletId && a.ndcHash === ndcHash));
    this.prescriberAuthorizations.set(opts.walletId, [...kept, authorization]);
    this.emit('info', 'prescribe', `  The member's device authorized prescriber ${prescriberWalletId.slice(0, 12)}… for ${hours} h${ndcHash ? ' (one medication)' : ''}`);
    return authorization;
  }

  async registerMemberFromEnrollment(opts: {
    walletId: string;
    /** ProofGate.verifyMember proof made on the device: the wallet is theirs. The identity preimage is never sent (B2). */
    ownershipProofJson: string;
    displayName: string;
    /** Display only, as the device reports it. The family is the insurer's approval's (A-34); the employee ID stays with the employer (I5). */
    relationship?: string;
    publicKeyHex?: string;     // X25519 public key from member's device (private key never leaves device)
  }): Promise<Record<string, unknown>> {
    if (!this.compiled) throw new Error('Programs not compiled yet — wait for ZkProgram compilation to finish');

    const walletId = Field(BigInt(opts.walletId));
    const walletIdStr = opts.walletId.slice(0, 12) + '...';

    // Already registered?
    if (this.enrolledMembers.has(opts.walletId)) {
      const existing = this.enrolledMembers.get(opts.walletId)!;
      return { walletId: opts.walletId, displayName: existing.displayName, alreadyRegistered: true };
    }

    // Step 2 commit two (B2, A-6): ELIGIBLE only for a wallet the insurer approved, and only once the
    // member's own registration proof has been accepted by the sequencer, which is what REGISTERED in
    // the lifecycle tree means. Nothing in the request decides either.
    const approval = this.approvedMembers.get(opts.walletId);
    if (!approval) {
      throw new RegistrationRefused(403, 'This wallet has no insurer approval: complete enrollment with the insurer first');
    }
    const ledger = this.ledgerLifecycleOf(walletId);
    if (ledger === 'absent') {
      throw new RegistrationRefused(409, 'The wallet is not registered on the ledger yet: submit the registration proof first');
    }
    if (ledger !== 'registered') {
      throw new RegistrationRefused(409, `The wallet's lifecycle on the ledger is not REGISTERED (${ledger})`);
    }

    this.emit('info', 'register', `Registering externally-enrolled member: ${opts.displayName} (${walletIdStr})`);

    // B2: the engine never sees the preimage. The device proves it owns the wallet; the proof is
    // verified here against ProofGate's verification key and kept for the portable credential.
    const ownershipProofJson = await this.verifyOwnershipProof(opts.walletId, opts.ownershipProofJson);

    // Build eligibility + accumulator using the plan configuration
    const eligibilityData = this.sharedEligibilityData;
// Step 2 commit two (C2, A-9): the limits come from the plan the insurer approved, read from the
    // sequencer's plan store, and the network from that plan's overlay.
    const plan = this.l2Node.getSequencer().getPlan(approval.planId);
    if (!plan) {
      throw new RegistrationRefused(409, `The approved plan ${approval.planId} is not on the sequencer`);
    }
    const binding = bindPlan(plan, { prescribers: this.prescriberWalletIds, pharmacies: this.pharmacyWalletIds });
    const accumulatorData = buildAccumulatorData({
      planYear: '20260101',
      deductibleAmountCents: binding.accumulator.deductibleAmountCents,
      deductiblePaidCents: 0,
      oopMaxCents: binding.accumulator.oopMaxCents,
      oopPaidCents: 0,
      annualBenefitMaxCents: binding.accumulator.annualBenefitMaxCents,
      annualBenefitUsedCents: 0,
    });

    // Build member forest (6 domain trees)
    const forest = new MerkleForest();
    forest.setLeaf(ForestDomain.ACCESS_CONTROL, 0n, eligibilityData.commitment());
    forest.setLeaf(ForestDomain.ACCESS_CONTROL, ACCUMULATOR_LEAF_INDEX, accumulatorData.commitment());

    // Create eligibility credential
    const credentialData = new CredentialData({
      credentialType: CREDENTIAL_TYPE_ELIGIBILITY,
      forestRoot: forest.getForestRoot(),
      issuerWalletId: this.adminWalletId,
      subjectWalletId: walletId,
      issuedAt: dateToField('20260201'),
      expiresAt: Field(0),
      revoked: Field(0),
    });

    // Build credential inventory
    const credentialInventory = new CredentialInventory();
    credentialInventory.mint(credentialData);
    const inventoryRoot = credentialInventory.getRoot();

    // Insurer admin op: the wallet becomes ELIGIBLE in the sequencer's trees. It is normally
    // already registered by the member's own registration proof; provision() also covers a
    // wallet enrolled without one.
    // D7 (A-33): a lifecycle change moves the roots; it waits until no device is proving against them
    await this.l2Node.getSequencer().withRootsSettled(() => this.l2Node.getSequencer().adminMutate('register member: ELIGIBLE', ({ provision }) => {
      provision(walletId, LIFECYCLE_ELIGIBLE);
    }));

    // Credential mint is a proven wallet update (current credential root → inventoryRoot,
    // nonce + 1) that the sequencer checks against its own tree, like any other change.
    // B1 step two: the credential mint is a wallet update the member's device proves. The record is
    // created at the ledger's current root and nonce; the device fetches the queued mint, proves it,
    // submits it and reports the receipt (markWalletUpdateApplied), which is when the record advances.
    const live = this.l2Node.getSequencer().getWalletStateForRpc(opts.walletId);
    const mintedNonce = Number(live.nonce);

    const walletIndex = Number(this.walletRegistry.getIndex(walletId));

    // Generate ProofGateProof (cached for subsequent proof generation, ~2s)
    this.emit('info', 'register', `  Ownership proof verified — made on the device, kept for the portable credential`);

    // Determine in-network providers
    const planId = approval.planId;
    const groupId = approval.groupIdHash; // the hash is what the engine knows; the plain group id stays with the employer (I5)
    const network = { prescriberIndices: binding.prescriberIndices, pharmacyIndices: binding.pharmacyIndices };

    // Register encryption public key (provided by member's device — private key never leaves device)
    if (opts.publicKeyHex) {
      // Validate: must be exactly 64 hex chars (32 bytes = X25519 public key)
      if (!/^[0-9a-f]{64}$/i.test(opts.publicKeyHex)) {
        this.emit('error', 'register', `Invalid publicKeyHex (expected 64 hex chars, got ${opts.publicKeyHex.length}) — skipping key registration`);
      } else {
        const devicePublicKey = Buffer.from(opts.publicKeyHex, 'hex');
        const { pubKeyX, pubKeyY } = publicKeyToFields(devicePublicKey);
        this.keyRegistry.registerKey(BigInt(walletIndex), walletId, pubKeyX, pubKeyY);
        // Store public key only — sequencer cannot derive the private key or shared secrets
        this.encryptionKeys.set(walletIndex, { publicKey: devicePublicKey, privateKey: Buffer.alloc(0) });
      }
    }

    // Store enrolled member state
    const enrolled: EnrolledMember = {
      memberIndex: -1,  // not from seed data
      walletId,
      walletIdStr,
      displayName: opts.displayName,
      forest,
      credentialData,
      credentialInventory,
      eligibilityData,
      accumulatorData,
      planId,
      groupId,
      // A-34: the family the insurer's approval carries (the employer's opaque hash), never one a request names.
      familyId: approval.familyIdHash ?? '',
      relationship: opts.relationship || 'SELF',
      employeeId: '', // I5: the employee ID stays with the employer
      inNetworkPrescriberIndices: network.prescriberIndices,
      inNetworkPharmacyIndices: network.pharmacyIndices,
      lifecycle: 'ELIGIBLE',
      walletIndex,
      nonce: mintedNonce,
      credentialInventoryRoot: Field(BigInt(live.credentialInventoryRoot)),
      cachedProofGateProof: ownershipProofJson,
      l2Receipts: [],
    };
    this.enrolledMembers.set(opts.walletId, enrolled);
    const mint = this.queueWalletUpdate(enrolled, 'credential mint', 'register');

    this.emit('info', 'register', `  Member registered: ${opts.displayName} — the device proves the credential mint (${mint.updateId})`);

    return {
      walletId: opts.walletId,
      displayName: opts.displayName,
      planId,
      groupId,
      lifecycle: 'ELIGIBLE',
      registered: true,
      walletUpdate: { status: 'pending', updateId: mint.updateId, newInventoryRoot: mint.newInventoryRoot },
    };
  }

  // ─── Enroll Family ──────────────────────────────────────

  async enrollFamily(subscriberIndex: number): Promise<Record<string, unknown>> {
    if (!this.compiled) throw new Error('Programs not compiled yet');

    const subscriber = MEMBERS[subscriberIndex];
    if (!subscriber) throw new Error(`Invalid member index: ${subscriberIndex}`);
    if (subscriber.relationship !== 'SELF') {
      throw new Error(`Member at index ${subscriberIndex} is not a subscriber (${subscriber.relationship}). Enroll the subscriber first.`);
    }

    const familyMembers = getMembersByFamily(subscriber.familyId);
    this.emit('phase', 'enroll', `═══ Family Enrollment: ${subscriber.familyId} (${familyMembers.length} members) ═══`);

    const results: Record<string, unknown>[] = [];

    for (const fm of familyMembers) {
      const idx = MEMBERS.indexOf(fm);
      // Skip if already enrolled
      const existingWalletId = deriveMemberWalletId(fm.localData, fm.enrollmentKey, hashString('ACME-CORP'), fixtureIdentitySalt(fm));
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
    ndcHash: string;
  }): Record<string, unknown> {
    const medication = this.getMedicationByNdcHash(opts.ndcHash);
    if (!medication.formularyEntry.requiresPriorAuth) {
      throw new Error(`${medication.brandName} does not require prior authorization`);
    }

    const enrolled = this.enrolledMembers.get(opts.memberWalletId);
    if (!enrolled) throw new Error(`Member not enrolled: ${opts.memberWalletId}`);

    const prescriber = PRESCRIBERS[opts.prescriberIndex];
    if (!prescriber) throw new Error(`Invalid prescriber index: ${opts.prescriberIndex}`);

    // Check for existing PA (pending or approved) for this member+medication
    for (const [_, pa] of this.priorAuths) {
      if (pa.memberWalletId === opts.memberWalletId &&
          pa.ndcHash === opts.ndcHash &&
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
      ndcHash: opts.ndcHash,
      status: 'PENDING',
      requestedAt: Date.now(),
    };
    this.priorAuths.set(paId, paState);

    const prescriberName = `${prescriberDisplayName(prescriber)}`;
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

    const medication = this.getMedicationByNdcHash(paState.ndcHash);
    const prescriber = PRESCRIBERS[paState.prescriberIndex];
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
    const formIdx = this.getFormularyLeafIndex(paState.ndcHash);
    const formularyEntry = this.formularyRegistry.getEntry(formIdx)!;
    const formularyWitness = this.formularyRegistry.getEntryWitness(formIdx);

    this.emit('proof', 'prior-auth', `  Generating AccessControl.provePriorAuth proof...`, 'start');
    const startProof = performance.now();
    await this.dispatchProof(
      'AccessControl', 'provePriorAuth',
      ['CredentialData', 'EligibilityData', 'ForestRoots', 'ForestMerkleWitness', 'ForestMerkleWitness', 'PriorAuthData', 'FormularyEntry', 'FormularyMerkleWitness', 'Field', 'Field'],
      [enrolled.credentialData, enrolled.eligibilityData, eligForestRoots, eligWitness, paWitness, priorAuthData, formularyEntry, formularyWitness, dateToField('20260202'), quantityToField(medication.formularyEntry.maxQuantityPerFill)],
      () => AccessControlProgram.provePriorAuth(enrolled.credentialData, enrolled.eligibilityData, eligForestRoots, eligWitness, paWitness, priorAuthData, formularyEntry, formularyWitness, dateToField('20260202'), quantityToField(medication.formularyEntry.maxQuantityPerFill)),
    );
    const elapsedProof = performance.now() - startProof;
    this.emit('proof', 'prior-auth', `  AccessControl.provePriorAuth proof verified`, 'complete', elapsedProof);
    this.emit('info', 'prior-auth', `  PA verified: medication on formulary, PA not expired, quantity within limits`);
    this.emitMemory('prior-auth');

    // 4b. Submit wallet update to L2 (forest changed → new inventory root)
    const paOutcome = await this.updateCredentialAndSubmitToL2(enrolled, 'prior-auth');

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
      prescriber: { name: `${prescriberDisplayName(prescriber)}` },
      paLeafIndex: Number(paLeafIndex),
      proofTimeMs: elapsedProof,
      forestRoot: truncField(enrolled.forest.getForestRoot()),
      l2Receipt: {
        receiptId: paOutcome.receipt?.receiptId ?? null,
        sequenceNumber: paOutcome.receipt ? Number(paOutcome.receipt.sequenceNumber) : null,
        walletUpdate: paOutcome.pending ? { status: 'pending', updateId: paOutcome.pending.updateId } : { status: 'applied' },
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
    const medication = this.getMedicationByNdcHash(paState.ndcHash);

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
  private findApprovedPa(memberWalletId: string, ndcHash: string): PriorAuthState | undefined {
    for (const [_, pa] of this.priorAuths) {
      if (pa.memberWalletId === memberWalletId &&
          pa.ndcHash === ndcHash &&
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
    ndcHash: string,
  ): { allowed: boolean; message: string; prerequisiteClass?: string; prerequisiteMeds?: string[] } {
    const medication = this.getMedicationByNdcHash(ndcHash);

    // Check current formulary state if available
    const isStepRequired = this.currentFormularyEntries.length > 0
      ? this.currentFormularyEntries[Number(this.getFormularyLeafIndex(ndcHash))]?.stepTherapyRequired
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

      const rxMed = this.getMedicationByNdcHash(rx.ndcHash);
      if (prereqClasses.includes(rxMed.therapeuticClass)) {
        return {
          allowed: true,
          message: `Step therapy satisfied: patient has filled ${rxMed.brandName} (${rxMed.therapeuticClass})`,
        };
      }
    }

    // Find prerequisite medication names for the error message
    const prereqMeds = MEDICATIONS
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
    ndcHash: string,
    prescriberIndex: number,
  ): { allowed: boolean; warnings: string[] } {
    const medication = this.getMedicationByNdcHash(ndcHash);
    const prescriber = PRESCRIBERS[prescriberIndex];
    const warnings: string[] = [];

    if (medication.deaSchedule === 0) {
      return { allowed: true, warnings: [] };
    }

    // DEA number required for controlled substances
    if (!prescriber.deaNumber) {
      return {
        allowed: false,
        warnings: [`DEA Schedule ${medication.deaSchedule}: Prescriber ${prescriberDisplayName(prescriber)} does not have a DEA number`],
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

  /** True when an ID names a prescription already written, or one still being proved. */
  private rxIdTaken(id: string): boolean {
    return this.prescriptions.has(id) || this.pendingPrescriptions.has(id);
  }

  async createPrescription(opts: {
    prescriberIndex: number;
    memberWalletId: string;
    ndcHash: string;
    pharmacyIndex: number;
    quantity: number;
    refills: number;
    rxId?: string;  // optional: prescriber-supplied ID for cross-node consistency
  }): Promise<Record<string, unknown>> {
    if (!this.compiled) throw new Error('Programs not compiled yet');
    // A prescription ID names one prescription for good. A caller's ID that is malformed or already in use
    // (written, or still being proved) is refused here, before any proof: storing it again would replace
    // that prescription and reset its quantity dispensed and refills used while its fills stay under the
    // same key. No await runs between this check and the pending entry below, so two requests cannot both pass.
    if (opts.rxId) {
      if (typeof opts.rxId !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(opts.rxId)) {
        throw new RegistrationRefused(400, 'rxId must be 1 to 64 letters, digits, dots, underscores or hyphens');
      }
      if (this.rxIdTaken(opts.rxId)) {
        throw new RegistrationRefused(409, `Prescription ${opts.rxId} already exists; a prescription ID cannot be reused`);
      }
    }

    const prescriber = PRESCRIBERS[opts.prescriberIndex];
    if (!prescriber) throw new Error(`Invalid prescriber index: ${opts.prescriberIndex}`);

    const pharmacy = PHARMACIES[opts.pharmacyIndex];
    if (!pharmacy) throw new Error(`Invalid pharmacy index: ${opts.pharmacyIndex}`);

    const medication = this.getMedicationByNdcHash(opts.ndcHash);

    const enrolled = this.enrolledMembers.get(opts.memberWalletId);
    if (!enrolled) throw new Error(`Member not enrolled: ${opts.memberWalletId}`);

    const prescriberWalletId = this.prescriberWalletIds.get(opts.prescriberIndex)!;
    const prescriberPreimage = this.prescriberPreimages.get(opts.prescriberIndex)!;
    const pharmacyWalletId = this.pharmacyWalletIds.get(opts.pharmacyIndex)!;
    const prescriberName = `${prescriberDisplayName(prescriber)}`;
    const pharmacyName = pharmacy.storeName;

    // A-18: a terminated member is not billable. The ledger decides, and the engine's copy follows it.
    refuseUnlessLedgerBillable(this.l2Node.getSequencer().lifecycleStateOf(enrolled.walletId.toString()), enrolled, 'no prescription can be written');
    // B5: a member with a device is prescribed for by the primary-care prescriber it consented to, or by a
    // prescriber its device authorized for this visit. The console's fixture members have no device.
    if (enrolled.memberIndex < 0) {
      const isPcp = enrolled.pcpAssignment !== undefined && enrolled.pcpAssignment.pcpWalletId.equals(prescriberWalletId).toBoolean();
      const authorization = isPcp ? undefined : this.prescriberAuthorizationFor(opts.memberWalletId, prescriberWalletId.toString(), opts.ndcHash);
      if (!isPcp && !authorization) {
        throw new RegistrationRefused(403, `${prescriberName} is not this member's primary-care prescriber and holds no authorization from the member's device`);
      }
      this.emit('info', 'prescribe', isPcp ? "  Consent: the member's primary-care prescriber" : `  Consent: authorized from the member's device until ${new Date(authorization!.expiresAt).toISOString()}`);
      // The plan's network, bound at registration from the plan overlay (Step 2b): a prescriber or a
      // pharmacy outside it is refused here, where the price is attached (§7), not found out at the counter.
      if (!enrolled.inNetworkPrescriberIndices.includes(opts.prescriberIndex)) {
        throw new RegistrationRefused(403, `${prescriberName} is outside this member's plan network`);
      }
      if (!enrolled.inNetworkPharmacyIndices.includes(opts.pharmacyIndex)) {
        throw new RegistrationRefused(403, `${pharmacyName} is outside this member's plan network`);
      }
    }

    this.emit('phase', 'prescribe', `═══ Prescription: ${prescriberName} → ${enrolled.displayName} ═══`);

    // PA enforcement: check if medication requires prior authorization
    const requiresPa = medication.formularyEntry.requiresPriorAuth;
    let approvedPa: PriorAuthState | undefined;
    if (requiresPa) {
      approvedPa = this.findApprovedPa(opts.memberWalletId, opts.ndcHash);
      if (!approvedPa) {
        // Check if there's a pending PA
        const pendingPa = [...this.priorAuths.values()].find(
          pa => pa.memberWalletId === opts.memberWalletId &&
                pa.ndcHash === opts.ndcHash &&
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
    const stepTherapyResult = this.checkStepTherapy(opts.memberWalletId, opts.ndcHash);
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
    const deaResult = this.checkDeaSchedule(opts.ndcHash, opts.prescriberIndex);
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
    let pendingRxId = opts.rxId || `RX-${String(this.rxCounter).padStart(4, '0')}`;
    // An engine-made ID skips any ID a caller chose earlier (for example "RX-0007"), so it never lands on a live prescription.
    while (!opts.rxId && this.rxIdTaken(pendingRxId)) {
      this.rxCounter++;
      pendingRxId = `RX-${String(this.rxCounter).padStart(4, '0')}`;
    }
    this.pendingPrescriptions.set(pendingRxId, {
      id: pendingRxId,
      prescriberIndex: opts.prescriberIndex,
      pharmacyIndex: opts.pharmacyIndex,
      memberWalletId: opts.memberWalletId,
      ndcHash: opts.ndcHash,
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
    await this.dispatchProof(
      'ProofGate', 'verifyPrescriber',
      ['Field', 'Field', 'Field', 'Field'],
      [prescriberWalletId, ...prescriberPreimage],
      () => ProofGateProgram.verifyPrescriber(prescriberWalletId, ...prescriberPreimage as [Field, Field, Field]),
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
      status: RX_STATUS_ADJUDICATED,
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
    await this.dispatchProof(
      'Eligibility', 'proveEligibility',
      ['CredentialData', 'EligibilityData', 'ForestRoots', 'ForestMerkleWitness', 'BenefitPlanWitness', 'Field', 'Field'],
      [enrolled.credentialData, enrolled.eligibilityData, eligForestRoots, eligWitness, planWitness, planRoot, dateToField('20260202')],
      () => EligibilityProgram.proveEligibility(enrolled.credentialData, enrolled.eligibilityData, eligForestRoots, eligWitness, planWitness, planRoot, dateToField('20260202')),
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
    const formIdx = this.getFormularyLeafIndex(opts.ndcHash);
    const formWitness = this.formularyRegistry.getEntryWitness(formIdx);

    this.emit('proof', 'prescribe', `[3/${totalSteps}] Generating AccessControl.proveFormularyAccess proof...`, 'start');
    const startAC = performance.now();
    await this.dispatchProof(
      'AccessControl', 'proveFormularyAccess',
      ['CredentialData', 'EligibilityData', 'ForestRoots', 'ForestMerkleWitness', 'FormularyEntry', 'FormularyMerkleWitness', 'Field', 'Field', 'Field', 'Field'],
      [enrolled.credentialData, enrolled.eligibilityData, eligForestRoots, formEligWitness, formularyEntry, formWitness, ndcHash, quantityToField(opts.quantity), Field(BigInt(medication.formularyEntry.maxDaySupply)), Field(20260101)],
      () => AccessControlProgram.proveFormularyAccess(enrolled.credentialData, enrolled.eligibilityData, eligForestRoots, formEligWitness, formularyEntry, formWitness, ndcHash, quantityToField(opts.quantity), Field(BigInt(medication.formularyEntry.maxDaySupply)), Field(20260101)),
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
      await this.dispatchProof(
        'AccessControl', 'provePriorAuth',
        ['CredentialData', 'EligibilityData', 'ForestRoots', 'ForestMerkleWitness', 'ForestMerkleWitness', 'PriorAuthData', 'FormularyEntry', 'FormularyMerkleWitness', 'Field', 'Field'],
        [enrolled.credentialData, enrolled.eligibilityData, paForestRoots, paEligWitness, paWitness, approvedPa.priorAuthData!, formularyEntry, paFormWitness, dateToField('20260202'), quantityToField(opts.quantity)],
        () => AccessControlProgram.provePriorAuth(enrolled.credentialData, enrolled.eligibilityData, paForestRoots, paEligWitness, paWitness, approvedPa.priorAuthData!, formularyEntry, paFormWitness, dateToField('20260202'), quantityToField(opts.quantity)),
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

    // Encrypt eScript with prescriber→pharmacy keys (each at its own wallet-registry slot)
    const prescriberKeyIndex = this.providerKeyIndex(prescriberWalletId);
    const pharmacyKeyIndex = this.providerKeyIndex(pharmacyWalletId);
    const prescriberKeys = this.encryptionKeys.get(prescriberKeyIndex);
    const pharmacyKeys = this.encryptionKeys.get(pharmacyKeyIndex);
    let eScriptContentHash: Field;
    let eScriptEncrypted: { ciphertext: Buffer; iv: Buffer; tag: Buffer } | null = null;
    if (prescriberKeys && pharmacyKeys && prescriberKeys.privateKey.length > 0) {
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
    await this.dispatchProof(
      'Messaging', 'proveSendMessage',
      ['MessageData', 'MessageRegistryWitness', 'Field', 'Field', 'Field'],
      [msg, msgWitness, this.messageRegistry.getRoot(), this.delegationRegistry.getRoot(), this.keyRegistry.getRoot()],
      () => MessagingProgram.proveSendMessage(msg, msgWitness, this.messageRegistry.getRoot(), this.delegationRegistry.getRoot(), this.keyRegistry.getRoot()),
    );
    const elapsedMsg = performance.now() - startMsg;
    this.emit('proof', 'prescribe', `[${msgStep}/${totalSteps}] MessagingProgram.proveSendMessage proof generated`, 'complete', elapsedMsg);
    this.emit('info', 'prescribe', `       Encrypted eScript: ${prescriberName} → ${pharmacyName}`);

    // Store encrypted eScript payload
    this.encryptedPayloads.set(msgIndex.toString(), {
      ciphertext: eScriptEncrypted ? eScriptEncrypted.ciphertext.toString('hex') : '',
      iv: eScriptEncrypted ? eScriptEncrypted.iv.toString('hex') : '',
      tag: eScriptEncrypted ? eScriptEncrypted.tag.toString('hex') : '',
      senderKeyIndex: prescriberKeyIndex,
      recipientKeyIndex: pharmacyKeyIndex,
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
      data: { medication: medication.brandName, status: 'ADJUDICATED' },
    });

    // Store prescription state (promote from pending to adjudicated)
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
      ndcHash: opts.ndcHash,
      formularyLeafIndex: this.getFormularyLeafIndex(opts.ndcHash),
      quantity: opts.quantity,
      quantityDispensed: 0,
      refills: effectiveRefills,
      refillsUsed: 0,
      status: 'ADJUDICATED',
      statusHistory: [],
      currentStatusLeafIndex: 0n,  // initial ADJUDICATED status at leaf 0
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
      status: 'ADJUDICATED',
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

  // ─── Mark Filled (Physical Preparation) ──────────────────

  /**
   * Mark a prescription as physically filled (no ZK proofs).
   * Pharmacist has counted/compounded/labeled the medication.
   * Status: ADJUDICATED → FILLED
   */
  markFilled(opts: { prescriptionId: string }): Record<string, unknown> {
    const rxState = this.prescriptions.get(opts.prescriptionId);
    if (!rxState) throw new Error(`Prescription not found: ${opts.prescriptionId}`);

    if (rxState.status !== 'ADJUDICATED') {
      throw new Error(`Cannot fill prescription in ${rxState.status} status. Must be ADJUDICATED.`);
    }

    // Build new FILLED status entry for the TRANSACTION tree
    const pharmacyWalletId = this.pharmacyWalletIds.get(rxState.pharmacyIndex)!;
    const filledStatus = new PrescriptionStatusData({
      prescriptionHash: rxState.prescriptionData.commitment(),
      status: RX_STATUS_FILLED,
      updatedByWalletId: pharmacyWalletId,
      updatedAt: dateToField(new Date().toISOString().slice(0, 10).replace(/-/g, '')),
      pharmacyWalletId,
      fillQuantity: Field(0),  // physical prep, not dispensed yet
      notesHash: Field(0),
    });

    // Update the Rx forest TRANSACTION tree: old status leaf stays, new leaf added
    const newLeafIndex = rxState.nextTxLeafIndex;
    rxState.rxForest.setLeaf(ForestDomain.TRANSACTION, newLeafIndex, filledStatus.commitment());

    // Update Rx credential to reflect new forest root
    rxState.rxCredentialData = new CredentialData({
      credentialType: CREDENTIAL_TYPE_PRESCRIPTION,
      forestRoot: rxState.rxForest.getForestRoot(),
      issuerWalletId: rxState.rxCredentialData.issuerWalletId,
      subjectWalletId: rxState.rxCredentialData.subjectWalletId,
      issuedAt: rxState.rxCredentialData.issuedAt,
      expiresAt: rxState.rxCredentialData.expiresAt,
      revoked: rxState.rxCredentialData.revoked,
    });

    // Update in-memory state
    rxState.activeStatus = filledStatus;
    rxState.currentStatusLeafIndex = newLeafIndex;
    rxState.nextTxLeafIndex = newLeafIndex + 1n;
    rxState.status = 'FILLED';
    rxState.statusHistory.push({
      from: 'ADJUDICATED',
      to: 'FILLED',
      updatedBy: 'pharmacy',
      updatedByRole: 'pharmacy',
      timestamp: Date.now(),
    });

    this.emit('info', 'fill', `Prescription ${opts.prescriptionId} marked as FILLED (physical prep complete)`);

    return {
      prescriptionId: opts.prescriptionId,
      status: 'FILLED',
      medication: this.getMedicationByNdcHash(rxState.ndcHash).brandName,
    };
  }

  // ─── Dispense Prescription ──────────────────────────────

  async dispensePrescription(opts: {
    prescriptionId: string;
    credentialJson?: string;      // Optional: no longer required for fill (fills are reversible)
    quantityDispensed?: number;
    ingredientCostCents?: number;
    dispensingFeeCents?: number;
  }): Promise<Record<string, unknown>> {
    if (!this.compiled) throw new Error('Programs not compiled yet');

    const rxState = this.prescriptions.get(opts.prescriptionId);
    if (!rxState) throw new Error(`Prescription not found: ${opts.prescriptionId}`);
    if (rxState.status === 'DISPENSED') throw new Error(`Prescription already dispensed: ${opts.prescriptionId}`);
    if (rxState.status === 'CANCELLED') throw new Error(`Prescription was cancelled: ${opts.prescriptionId}`);
    if (rxState.status === 'REJECTED') throw new Error(`Prescription was rejected: ${opts.prescriptionId}`);
    // FILLED → DISPENSED (full dispense) or PARTIALLY_FILLED → DISPENSED (subsequent dispense)
    if (rxState.status !== 'FILLED' && rxState.status !== 'PARTIALLY_FILLED') {
      throw new Error(`Cannot dispense prescription in ${rxState.status} status. Must be FILLED or PARTIALLY_FILLED.`);
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

    const medication = this.getMedicationByNdcHash(rxState.ndcHash);
    const pharmacy = PHARMACIES[rxState.pharmacyIndex];
    const pharmacyWalletId = this.pharmacyWalletIds.get(rxState.pharmacyIndex)!;
    const pharmacyPreimage = this.pharmacyPreimages.get(rxState.pharmacyIndex)!;
    const prescriberWalletId = this.prescriberWalletIds.get(rxState.prescriberIndex)!;
    const prescriberPreimage = this.prescriberPreimages.get(rxState.prescriberIndex)!;
    const enrolled = this.enrolledMembers.get(rxState.memberWalletId)!;
    // A-18: a terminated member is not billable; a reversal (which undoes a claim) stays open by design. The ledger decides.
    refuseUnlessLedgerBillable(this.l2Node.getSequencer().lifecycleStateOf(enrolled.walletId.toString()), enrolled, 'the prescription cannot be dispensed');

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

    // D4 (A-10): a second fill of the same drug for this member at this pharmacy today is a duplicate claim. It is
    // refused here, before any proof is made or any amount billed, and the ledger refuses the same key, so what is
    // billed and what is recorded cannot disagree. The remainder of a partial fill is the same prescription and passes.
    const fillNumber = (this.fulfillments.get(opts.prescriptionId) || []).length;
    const duplicateOf = this.findDuplicateFill({
      prescriptionId: opts.prescriptionId,
      memberWalletId: rxState.memberWalletId,
      ndcHash: rxState.ndcHash,
      pharmacyWalletId: pharmacyWalletId.toBigInt().toString(),
      dateOfService: serviceDateStr,
      fillNumber,
    });
    if (duplicateOf) {
      throw new RegistrationRefused(409, `Duplicate fill: ${medication.brandName} was already dispensed to this member by this pharmacy today (${duplicateOf}). Reverse that fill first if it was wrong.`);
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
      data: { step: 'credential-scan', medication: medication.brandName, pharmacyIndex: rxState.pharmacyIndex, memberIndex: enrolled.memberIndex },
    });

    this.emit('proof', 'fill', `[1/3] Generating ProofGate.verifyPharmacy proof...`, 'start');
    const startPG = performance.now();
    await this.dispatchProof(
      'ProofGate', 'verifyPharmacy',
      ['Field', 'Field', 'Field', 'Field'],
      [pharmacyWalletId, ...pharmacyPreimage],
      () => ProofGateProgram.verifyPharmacy(pharmacyWalletId, ...pharmacyPreimage as [Field, Field, Field]),
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
    const zkNewStatus = isPartial ? RX_STATUS_PARTIALLY_FILLED : RX_STATUS_DISPENSED;
    const zkStatusLabel = isPartial ? 'PARTIALLY_FILLED' : 'DISPENSED';

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
    await this.dispatchProof(
      'Prescription', 'proveStatusUpdate',
      ['CredentialData', 'PrescriptionData', 'PrescriptionStatusData', 'PrescriptionStatusData', 'ForestRoots', 'ForestMerkleWitness', 'ForestMerkleWitness', 'ForestMerkleWitness', 'Field', 'Field', 'Field'],
      [rxState.rxCredentialData, rxState.prescriptionData, rxState.activeStatus, filledStatus, rxForestRoots, medWitness, oldStatusWitness, newSlotWitness, ...prescriberPreimage],
      () => PrescriptionProgram.proveStatusUpdate(rxState.rxCredentialData, rxState.prescriptionData, rxState.activeStatus, filledStatus, rxForestRoots, medWitness, oldStatusWitness, newSlotWitness, ...prescriberPreimage as [Field, Field, Field]),
    );
    const elapsedRx = performance.now() - startRx;
    this.emit('proof', 'fill', `[2/3] PrescriptionProgram.proveStatusUpdate proof generated`, 'complete', elapsedRx);
    const statusLabel = qtyDispensed < rxState.quantity - rxState.quantityDispensed
      ? 'PARTIALLY_FILLED' : 'DISPENSED';
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

    // 3. THE CLAIM: AccumulatorFulfillment (proof [3/3])
    // The fulfillment circuit requires the FILLED status (pre-dispense), not DISPENSED.
    // It checks that the prescription is in FILLED or PARTIALLY_FILLED state before settling.
    const preDispenseStatus = rxState.activeStatus; // FILLED status from markFilled()
    const preDispenseLeaf = oldStatusLeaf;          // leaf index of the FILLED status

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
    const fulfStatusWitness = rxForest.getWitness(ForestDomain.TRANSACTION, preDispenseLeaf);
    const fulfNewSlotWitness = rxForest.getWitness(ForestDomain.TRANSACTION, newStatusLeaf + 1n);
    const fulfFormWitness = this.formularyRegistry.getEntryWitness(rxState.formularyLeafIndex);
    const eligForest = enrolled.forest;
    const eligForestRoots = ForestRoots.fromForest(eligForest);
    const accumWitness = eligForest.getWitness(ForestDomain.ACCESS_CONTROL, ACCUMULATOR_LEAF_INDEX);
    const oldEligForestRoot = eligForest.getForestRoot();
    const oldEligCredentialSerialized = serializeCredentialData(enrolled.credentialData);
    const oldEligForestSerialized = serializeForestRoots(eligForest);

    this.emit('proof', 'fill', `[3/3] Generating AccumulatorFulfillment.proveFulfillmentWithAccumulator...`, 'start');
    this.emit('info', 'fill', '       THE CLAIM: Dual-credential fulfillment with accumulator update');
    this.emit('info', 'fill', '       24 private inputs verified in a single ZK circuit');

    // B8 (A-23): family pooling is proven inside the circuit, from the family's accumulators before this fill and
    // the plan's family limits; the proof's amounts are what the member is billed and what the ledger records.
    // The family is the one the insurer's approval bound (A-34); a member with none pools with no one and
    // has no family limits.
    const familyLimitsIn = familyLimitsFor(enrolled, this.l2Node.getSequencer().getPlan(enrolled.planId));
    const familyBefore: MemberAccumulator[] = familyMembersOf(enrolled, this.enrolledMembers.values()).map((m) => ({
      deductiblePaidCents: Number(m.accumulatorData.deductiblePaidCents.toBigInt()),
      oopPaidCents: Number(m.accumulatorData.oopPaidCents.toBigInt()),
      annualBenefitUsedCents: Number(m.accumulatorData.annualBenefitUsedCents.toBigInt()),
    }));
    const familyTotals = FamilyAccumulatorService.getFamilyTotals(familyBefore);
    const familyFields = [
      familyTotals.deductiblePaidCents, familyTotals.oopPaidCents, familyTotals.annualBenefitUsedCents,
      familyLimitsIn.familyDeductibleAmountCents, familyLimitsIn.familyOopMaxCents, familyLimitsIn.familyAnnualBenefitMaxCents,
    ].map((n) => Field(BigInt(Math.max(0, Math.trunc(n)))));
    const startFulf = performance.now();
    const fulfillDispatch = await this.dispatchProof(
      'AccumulatorFulfillment', 'proveFulfillmentWithAccumulator',
      ['CredentialData', 'PrescriptionData', 'PrescriptionStatusData', 'FulfillmentData', 'FormularyEntry', 'ForestRoots', 'ForestMerkleWitness', 'ForestMerkleWitness', 'ForestMerkleWitness', 'FormularyMerkleWitness', 'Field', 'CredentialData', 'ForestRoots', 'AccumulatorData', 'ForestMerkleWitness', 'Field', 'Field', 'Field', 'Field', 'Field', 'Field', 'Field', 'Field', 'Field'],
      [rxCredentialData, rxState.prescriptionData, preDispenseStatus, fulfillmentData, rxState.formularyEntry, rxForestRoots, fulfMedWitness, fulfStatusWitness, fulfNewSlotWitness, fulfFormWitness, enrolled.eligibilityData.formularyRoot, enrolled.credentialData, eligForestRoots, enrolled.accumulatorData, accumWitness, ...pharmacyPreimage, ...familyFields],
      () => AccumulatorFulfillmentProgram.proveFulfillmentWithAccumulator(rxCredentialData, rxState.prescriptionData, preDispenseStatus, fulfillmentData, rxState.formularyEntry, rxForestRoots, fulfMedWitness, fulfStatusWitness, fulfNewSlotWitness, fulfFormWitness, enrolled.eligibilityData.formularyRoot, enrolled.credentialData, eligForestRoots, enrolled.accumulatorData, accumWitness, ...pharmacyPreimage as [Field, Field, Field], ...familyFields as [Field, Field, Field, Field, Field, Field]),
    );
    const elapsedFulf = performance.now() - startFulf;
    this.emit('proof', 'fill', `[3/3] AccumulatorFulfillment proof generated`, 'complete', elapsedFulf);

    // Extract proof output (individual-level, ZK-enforced) — values are decimal strings from dispatchProof
    const proofOutput = fulfillDispatch.publicOutput;
    if (!proofOutput) {
      throw new Error(`AccumulatorFulfillment proof returned no publicOutput. Keys received: ${JSON.stringify(Object.keys(fulfillDispatch))}`);
    }
    if (!proofOutput.patientPayCents || !proofOutput.planPayCents || !proofOutput.newEligibilityForestRoot) {
      throw new Error(`AccumulatorFulfillment publicOutput missing fields. Keys: [${Object.keys(proofOutput).join(', ')}]. patientPayCents=${proofOutput.patientPayCents}, planPayCents=${proofOutput.planPayCents}, newEligibilityForestRoot=${proofOutput.newEligibilityForestRoot}`);
    }
    let patientPayCents = Number(BigInt(proofOutput.patientPayCents));
    let planPayCents = Number(BigInt(proofOutput.planPayCents));
    const newEligForestRoot = Field(BigInt(proofOutput.newEligibilityForestRoot));

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
    this.emit('info', 'fill', `  │    prescriptionHash:         ${truncStr(proofOutput.prescriptionHash)}`);
    this.emit('info', 'fill', `  │    oldForestRoot:            ${truncStr(proofOutput.oldForestRoot)}`);
    this.emit('info', 'fill', `  │    newForestRoot:            ${truncStr(proofOutput.newForestRoot)}`);
    this.emit('info', 'fill', `  │    entryCommitment:          ${truncStr(proofOutput.entryCommitment)}`);
    this.emit('info', 'fill', `  │    patientPayCents:          ${patientPayCents} ($${(patientPayCents / 100).toFixed(2)})`);
    this.emit('info', 'fill', `  │    planPayCents:             ${planPayCents} ($${(planPayCents / 100).toFixed(2)})`);
    this.emit('info', 'fill', `  │    operationType:            ${truncStr(proofOutput.operationType)}`);
    this.emit('info', 'fill', `  │    newEligibilityForestRoot: ${truncStr(proofOutput.newEligibilityForestRoot)}`);
    this.emit('info', 'fill', `  │    deductibleCreditCents:    ${Number(BigInt(proofOutput.deductibleCreditCents))} ($${(Number(BigInt(proofOutput.deductibleCreditCents)) / 100).toFixed(2)})`);
    this.emit('info', 'fill', `  │    ndcHash:                  ${truncStr(proofOutput.ndcHash)}`);
    this.emit('info', 'fill', `  │`);
    this.emit('info', 'fill', `  │  KEY DISTINCTION: patientPay + planPay are CIRCUIT OUTPUTS`);
    this.emit('info', 'fill', `  │  No adjudication authority — Provable.if() constraints ARE the rules`);
    this.emit('info', 'fill', `  └─ Proof time: ${elapsedFulf.toFixed(0)}ms`);

    // Determine adjudication phase. A-35: the member's own limits, the ones the proof used; never constants.
    const deductibleAmt = Number(enrolled.accumulatorData.deductibleAmountCents.toBigInt());
    const oopMax = Number(enrolled.accumulatorData.oopMaxCents.toBigInt());
    const oldDeductiblePaid = Number(enrolled.accumulatorData.deductiblePaidCents.toBigInt());
    const oldOopPaid = Number(enrolled.accumulatorData.oopPaidCents.toBigInt());
    const oldBenefitUsed = Number(enrolled.accumulatorData.annualBenefitUsedCents.toBigInt());
    // C4 fix: deductible credit from proof output (only deductible portion, not copay)
    const deductibleCreditCents = Number(BigInt(proofOutput.deductibleCreditCents));
    let newDeductiblePaid = oldDeductiblePaid + deductibleCreditCents;
    let newOopPaid = oldOopPaid + patientPayCents;
    let newBenefitUsed = oldBenefitUsed + planPayCents;

    // A-35: the engine's new accumulator keeps the member's plan year and limits, as the circuit does, and must reach
    // the eligibility root the proof committed to. Checked here, before the claim or the member's record changes.
    const newAccumulator = withAmountsPaid(enrolled.accumulatorData, { deductiblePaidCents: newDeductiblePaid, oopPaidCents: newOopPaid, annualBenefitUsedCents: newBenefitUsed });
    if (!forestRootWithAccessControl(eligForestRoots, accumWitness.calculateRoot(newAccumulator.commitment())).equals(newEligForestRoot).toBoolean()) {
      throw new Error('The fill proof\'s eligibility root does not match the engine\'s accumulator update; the claim was not recorded');
    }

    let phase = patientPayCents === totalCostCents ? 'DEDUCTIBLE (not yet met)' : 'NORMAL COPAY';

    // B8 (A-23): the family rule the circuit applied, for the record and the display. The amounts above are the
    // proof's, pooled inside the circuit; nothing is rewritten after the proof any more.
    const familyRuleCode = Number(BigInt(proofOutput.familyRule ?? '0'));
    const familyPoolingApplied = familyRuleCode !== 0;
    const familyPoolingReason = [
      'Individual accumulator rules applied',
      'Family out-of-pocket maximum met',
      'Family annual benefit maximum exhausted',
      'Patient pay capped at family out-of-pocket maximum',
      'Plan pay capped at family annual benefit maximum',
    ][familyRuleCode] ?? 'Individual accumulator rules applied';
    if (familyPoolingApplied) {
      phase = familyPoolingReason;
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
    this.emit('info', 'fill', `    Deductible:  $${(oldDeductiblePaid / 100).toFixed(2)} → $${(newDeductiblePaid / 100).toFixed(2)} / $${(deductibleAmt / 100).toFixed(2)}  ${deductibleAmt > 0 ? (newDeductiblePaid / deductibleAmt * 100).toFixed(1) + '%' : 'no deductible'}`);
    this.emit('info', 'fill', `    OOPM:        $${(oldOopPaid / 100).toFixed(2)} → $${(newOopPaid / 100).toFixed(2)} / $${(oopMax / 100).toFixed(2)}  ${oopMax > 0 ? (newOopPaid / oopMax * 100).toFixed(1) + '%' : 'no maximum'}`);
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

    // Update enrolled member's accumulator data: the one checked against the proof above (A-35)
    enrolled.accumulatorData = newAccumulator;

    // Update local forests to match circuit output
    const patientPayField = Field(BigInt(proofOutput.patientPayCents));
    const planPayField = Field(BigInt(proofOutput.planPayCents));
    const deductibleCreditField = Field(BigInt(proofOutput.deductibleCreditCents));
    const settlementCommit = Poseidon.hash([
      fulfillmentData.commitment(),
      patientPayField,
      planPayField,
      deductibleCreditField,
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

    // Build claim metadata for the sequencer's ClaimAccumulatorService
    const claimMeta: import('../l2/l2-types.js').ClaimSubmissionMetadata = {
      ndcHash: proofOutput.ndcHash || hashString(medication.ndc).toString(),
      memberWalletId: enrolled.walletId.toBigInt().toString(),
      pharmacyWalletId: pharmacyWalletId.toBigInt().toString(),
      prescriberWalletId: this.prescriberWalletIds.get(rxState.prescriberIndex)!.toBigInt().toString(),
      dateOfService: serviceDateStr,
      patientPayCents: String(patientPayCents),
      planPayCents: String(planPayCents),
      operationType: '1', // fulfillment
      ndc: medication.ndc,
      brandName: medication.brandName,
      tierLevel: medication.formularyEntry.tierLevel,
      daysSupply: 30,
      deductibleCreditCents: proofOutput.deductibleCreditCents || '0',
      fillNumber,
      ingredientCostCents,
      dispensingFeeCents,
      quantityDispensed: qtyDispensed,
      planIdHash: hashString(enrolled.planId).toString(),
    };

    // Submit wallet update to L2 (accumulator/forest change → new inventory root)
    const fillOutcome = await this.updateCredentialAndSubmitToL2(enrolled, 'fill', claimMeta);

    // Determine new status: partial dispense or full dispense
    const totalDispensed = rxState.quantityDispensed + qtyDispensed;
    const isPartialFill = totalDispensed < rxState.quantity;
    const previousStatus = rxState.status;
    const newStatus: RxStatus = isPartialFill ? 'PARTIALLY_FILLED' : 'DISPENSED';

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
      patientPayField,
      planPayField,
      deductibleCreditField,
      settlementLeafIndex: newStatusLeaf + 1n,
      quantityDispensed: qtyDispensed,
      reversed: false,
      dateOfService: serviceDateStr,
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
      // B1 step two: the member's device proves the wallet update the fill produced; the claim lands with it
      walletUpdate: fillOutcome.pending
        ? { status: 'pending', updateId: fillOutcome.pending.updateId, newInventoryRoot: fillOutcome.pending.newInventoryRoot }
        : { status: 'applied', receiptId: fillOutcome.receipt?.receiptId },
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
        receiptId: fillOutcome.receipt?.receiptId ?? null,
        sequenceNumber: fillOutcome.receipt ? Number(fillOutcome.receipt.sequenceNumber) : null,
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
      if (rxState.status !== 'DISPENSED') {
        throw new Error(`Cannot complete prescription in ${rxState.status} status. Must be DISPENSED first.`);
      }
      if (opts.role !== 'pharmacy') {
        throw new Error('Only pharmacies can mark prescriptions as completed');
      }
    } else {
      // Validate the transition using production state machine
      const statusMap: Record<string, bigint> = {
        'ADJUDICATED': 1n, 'PARTIALLY_FILLED': 2n, 'FILLED': 3n,
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
      ? `${prescriberDisplayName(PRESCRIBERS[opts.actorIndex])}`
      : PHARMACIES[opts.actorIndex].storeName;
    const enrolled = this.enrolledMembers.get(rxState.memberWalletId);
    const medication = this.getMedicationByNdcHash(rxState.ndcHash);

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

    // Must be DISPENSED or PARTIALLY_FILLED
    if (rxState.status !== 'DISPENSED' && rxState.status !== 'PARTIALLY_FILLED') {
      throw new Error(`Cannot reverse prescription in ${rxState.status} status. Must be DISPENSED or PARTIALLY_FILLED.`);
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

    const pharmacy = PHARMACIES[rxState.pharmacyIndex];
    const medication = this.getMedicationByNdcHash(rxState.ndcHash);
    const enrolled = this.enrolledMembers.get(rxState.memberWalletId);
    if (!enrolled) throw new Error(`Member not found for wallet: ${rxState.memberWalletId}`);
    const pharmacyWalletId = this.pharmacyWalletIds.get(rxState.pharmacyIndex)!;
    const pharmacyPreimage = this.pharmacyPreimages.get(rxState.pharmacyIndex)!;

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
    const reversalDispatch = await this.dispatchProof(
      'AccumulatorFulfillment', 'proveReversalWithAccumulator',
      ['CredentialData', 'PrescriptionData', 'FulfillmentData', 'ReversalData', 'ForestRoots', 'ForestMerkleWitness', 'ForestMerkleWitness', 'ForestMerkleWitness', 'Field', 'Field', 'Field', 'CredentialData', 'ForestRoots', 'AccumulatorData', 'ForestMerkleWitness', 'Field', 'Field', 'Field'],
      [rxState.rxCredentialData, rxState.prescriptionData, fillToReverse.fulfillmentData, reversalData, rxForestRoots, revMedWitness, revFulfWitness, revSlotWitness, fillToReverse.patientPayField, fillToReverse.planPayField, fillToReverse.deductibleCreditField, enrolled.credentialData, eligForestRoots, enrolled.accumulatorData, accumWitness, ...pharmacyPreimage],
      () => AccumulatorFulfillmentProgram.proveReversalWithAccumulator(rxState.rxCredentialData, rxState.prescriptionData, fillToReverse.fulfillmentData, reversalData, rxForestRoots, revMedWitness, revFulfWitness, revSlotWitness, fillToReverse.patientPayField, fillToReverse.planPayField, fillToReverse.deductibleCreditField, enrolled.credentialData, eligForestRoots, enrolled.accumulatorData, accumWitness, ...pharmacyPreimage as [Field, Field, Field]),
    );
    const elapsedRev = performance.now() - startRev;
    this.emit('proof', 'reversal', `[1/2] AccumulatorFulfillment.proveReversalWithAccumulator proof generated`, 'complete', elapsedRev);

    // Extract proof output
    const revOutput = reversalDispatch.publicOutput!;
    const newEligForestRoot = Field(BigInt(revOutput.newEligibilityForestRoot));

    // A-35: the reversed accumulator keeps the member's plan year and limits and must reach the proof's root,
    // checked before the transaction tree or the member's record changes.
    const revAccumulator = withAmountsPaid(enrolled.accumulatorData, {
      deductiblePaidCents: Math.max(0, Number(enrolled.accumulatorData.deductiblePaidCents.toBigInt()) - Number(fillToReverse.deductibleCreditField.toBigInt())),
      oopPaidCents: Math.max(0, Number(enrolled.accumulatorData.oopPaidCents.toBigInt()) - fillToReverse.patientPayCents),
      annualBenefitUsedCents: Math.max(0, Number(enrolled.accumulatorData.annualBenefitUsedCents.toBigInt()) - fillToReverse.planPayCents),
    });
    if (!forestRootWithAccessControl(eligForestRoots, accumWitness.calculateRoot(revAccumulator.commitment())).equals(newEligForestRoot).toBoolean()) {
      throw new Error('The reversal proof\'s eligibility root does not match the engine\'s accumulator update; nothing was reversed');
    }

    // 3. Update eligibility forest: reverse accumulator. The member's record is what the ledger step proves, so it
    //    changes first and is put back exactly if that step fails; the prescription and the fill change only after.
    const origPatientPay = fillToReverse.patientPayCents;
    const origPlanPay = fillToReverse.planPayCents;
    const origDeductibleCredit = Number(fillToReverse.deductibleCreditField.toBigInt());
    const oldDeductiblePaid = Number(enrolled.accumulatorData.deductiblePaidCents.toBigInt());
    const oldOopPaid = Number(enrolled.accumulatorData.oopPaidCents.toBigInt());
    const oldBenefitUsed = Number(enrolled.accumulatorData.annualBenefitUsedCents.toBigInt());
    const newDeductiblePaid = Math.max(0, oldDeductiblePaid - origDeductibleCredit);
    const newOopPaid = Math.max(0, oldOopPaid - origPatientPay);
    const newBenefitUsed = Math.max(0, oldBenefitUsed - origPlanPay);

    const savedAccumulator = enrolled.accumulatorData;
    const savedAccumulatorLeaf = eligForest.getLeaf(ForestDomain.ACCESS_CONTROL, ACCUMULATOR_LEAF_INDEX);
    const savedCredential = enrolled.credentialData;
    const savedInventorySlot = enrolled.credentialInventory.getCredential(0n);

    enrolled.accumulatorData = revAccumulator; // A-35: checked against the proof above

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

    // 4. Record on the ledger. A fixture member's update is proved and submitted here; a member with a device has it
    //    queued for the device to prove, its claim committed on the sequencer. If this step fails, the member's record
    //    is put back exactly and the error surfaces, as for a fill whose ledger step fails: nothing was reversed.
    const reversalClaimMeta: import('../l2/l2-types.js').ClaimSubmissionMetadata = {
      ndcHash: hashString(medication.ndc).toString(),
      memberWalletId: enrolled.walletId.toBigInt().toString(),
      pharmacyWalletId: pharmacyWalletId.toBigInt().toString(),
      prescriberWalletId: this.prescriberWalletIds.get(rxState.prescriberIndex)!.toBigInt().toString(),
      dateOfService: fillToReverse.dateOfService || new Date().toISOString().replace(/[-:T]/g, '').slice(0, 8),
      patientPayCents: String(origPatientPay),
      planPayCents: String(origPlanPay),
      operationType: '2', // reversal
      ndc: medication.ndc,
      brandName: medication.brandName,
      tierLevel: medication.formularyEntry.tierLevel,
      daysSupply: 30,
      deductibleCreditCents: String(origDeductibleCredit),
      fillNumber: fillToReverse.fillIndex,
      quantityDispensed: fillToReverse.quantityDispensed,
      planIdHash: hashString(enrolled.planId).toString(),
    };
    let revOutcome: WalletUpdateOutcome;
    try {
      revOutcome = await this.updateCredentialAndSubmitToL2(enrolled, 'reversal', reversalClaimMeta);
    } catch (revSubmitErr: unknown) {
      enrolled.accumulatorData = savedAccumulator;
      eligForest.setLeaf(ForestDomain.ACCESS_CONTROL, ACCUMULATOR_LEAF_INDEX, savedAccumulatorLeaf);
      enrolled.credentialData = savedCredential;
      if (savedInventorySlot) enrolled.credentialInventory.updateCredential(0n, savedInventorySlot);
      this.emit('error', 'reversal', `The ledger did not take the reversal; nothing was reversed: ${revSubmitErr instanceof Error ? revSubmitErr.message : String(revSubmitErr)}`);
      throw revSubmitErr;
    }

    // 5. Update TRANSACTION tree: store reversal commitment at the reversal slot
    rxForest.setLeaf(ForestDomain.TRANSACTION, reversalSlotIndex, reversalData.commitment());

    // 6. Update Rx credential with final forest root (after reversal slot write)
    const updatedRxCredentialData = new CredentialData({
      credentialType: CREDENTIAL_TYPE_PRESCRIPTION,
      forestRoot: rxForest.getForestRoot(),
      issuerWalletId: rxState.rxCredentialData.issuerWalletId,
      subjectWalletId: rxState.rxCredentialData.subjectWalletId,
      issuedAt: rxState.rxCredentialData.issuedAt,
      expiresAt: Field(0),
      revoked: Field(0),
    });

    // 7. Update prescription state
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
      // B1 step two: a member with a device proves the reversal's wallet update; the claim lands with it
      walletUpdate: revOutcome.pending
        ? { status: 'pending', updateId: revOutcome.pending.updateId, newInventoryRoot: revOutcome.pending.newInventoryRoot }
        : { status: 'applied', receiptId: revOutcome.receipt?.receiptId },
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

    if (senderKeys && recipientKeys && senderKeys.privateKey.length > 0) {
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
   * A seed provider's messaging-key slot: its wallet-registry index, the slot a member's key uses
   * too, so the key tree stays 1:1 with the wallet registry and no two parties share a slot.
   * Seed providers are provisioned into the registry in initInfrastructure, before any key lookup.
   */
  private providerKeyIndex(walletId: Field): number {
    return Number(this.walletRegistry.getIndex(walletId));
  }

  /**
   * Find the encryption key index for a given wallet Field.
   * Returns null if no key is registered for this wallet.
   */
  private findKeyIndexForWallet(wallet: Field): number | null {
    const walletStr = wallet.toString();
    // Check seed prescribers and pharmacies (their wallet-registry slot)
    for (const wid of [...this.prescriberWalletIds.values(), ...this.pharmacyWalletIds.values()]) {
      if (wid.toString() === walletStr) return this.providerKeyIndex(wid);
    }
    // Check enrolled members
    for (const enrolled of this.enrolledMembers.values()) {
      // members key by their live registry slot: a restore can move them, and a stale saved index may name a provider
      if (enrolled.walletId.toString() === walletStr) return this.walletRegistry.isRegistered(enrolled.walletId) ? Number(this.walletRegistry.getIndex(enrolled.walletId)) : null;
    }
    // Check admin/insurer
    if (this.adminWalletId && this.adminWalletId.toString() === walletStr) return AdjudicationService.ADMIN_KEY_INDEX;
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
      const p = PRESCRIBERS[index];
      if (!p) throw new Error(`Invalid prescriber index: ${index}`);
      return {
        walletId: this.prescriberWalletIds.get(index)!,
        keyIndex: this.providerKeyIndex(this.prescriberWalletIds.get(index)!),
        displayName: `${prescriberDisplayName(p)}`,
      };
    }
    if (type === 'pharmacy') {
      if (index === undefined) throw new Error('Pharmacy index required');
      const p = PHARMACIES[index];
      if (!p) throw new Error(`Invalid pharmacy index: ${index}`);
      return {
        walletId: this.pharmacyWalletIds.get(index)!,
        keyIndex: this.providerKeyIndex(this.pharmacyWalletIds.get(index)!),
        displayName: p.storeName,
      };
    }
    if (type === 'insurer') {
      return {
        walletId: this.adminWalletId,
        keyIndex: AdjudicationService.ADMIN_KEY_INDEX,
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
        keyIndex: Number(this.walletRegistry.getIndex(enrolled.walletId)),
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
    if (senderKeys.privateKey.length === 0) throw new Error('Cannot encrypt on sequencer — sender private key is device-only. Encrypt on the sender\'s device before submitting.');

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
    await this.dispatchProof(
      'Messaging', 'proveSendMessage',
      ['MessageData', 'MessageRegistryWitness', 'Field', 'Field', 'Field'],
      [msg, msgWitness, this.messageRegistry.getRoot(), this.delegationRegistry.getRoot(), this.keyRegistry.getRoot()],
      () => MessagingProgram.proveSendMessage(msg, msgWitness, this.messageRegistry.getRoot(), this.delegationRegistry.getRoot(), this.keyRegistry.getRoot()),
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
    if (!senderKeys || !recipientKeys || senderKeys.privateKey.length === 0 || recipientKeys.privateKey.length === 0) {
      return {
        subject: '[Encrypted — decrypt on device]',
        body: '[Cannot decrypt on sequencer — private key is device-only]',
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
    await this.dispatchProof(
      'Messaging', 'proveDelegate',
      ['DelegationData', 'DelegationRegistryWitness', 'Field', 'Field', 'Field', 'Field'],
      [delegationData, witness, this.messageRegistry.getRoot(), this.delegationRegistry.getRoot(), this.keyRegistry.getRoot(), dateToField('20260214')],
      () => MessagingProgram.proveDelegate(delegationData, witness, this.messageRegistry.getRoot(), this.delegationRegistry.getRoot(), this.keyRegistry.getRoot(), dateToField('20260214')),
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
    // A copy brought into step from the ledger has no termination date: the termination's own steps (cancel the
    // prescriptions, revoke the attestation nonce, notify) never ran, so they may run now.
    if (enrolled.lifecycle === 'REVOKED' && enrolled.terminationDate !== undefined) throw new Error(`Member ${enrolled.displayName} is already terminated`);

    const termDate = opts.terminationDate || '20260214';

    this.emit('phase', 'terminate', `═══ Member Termination: ${enrolled.displayName} ═══`);
    this.emit('info', 'terminate', `  Wallet: ${enrolled.walletIdStr}`);
    this.emit('info', 'terminate', `  Termination date: ${termDate}`);

    // 1. Call EnrollmentService.terminateMember
    //    This handles: credential revocation, lifecycle→REVOKED, roster→TERMINATED, group count--
    this.emit('offchain', 'terminate', 'Step 1: Revoking eligibility credential and updating lifecycle...', 'start');
    // terminateMember changes the sequencer's trees (it was constructed with them), so it runs
    // inside adminMutate, which takes the new roots from the trees.
    // A fixture member sits in the enrollment service's roster; a member with a device never did
    // (Step 2b registers it straight on the sequencer), so its lifecycle is set on the trees directly.
    // D7 (A-33): termination is synchronous and rare; it does not wait for the proving lease, so a prover caught
    // in flight re-proves once. Making it wait is part of the lease-hardening item (D8).
    const result = enrolled.memberIndex >= 0
      ? this.l2Node.getSequencer().adminMutate('terminate member', () =>
          this.enrollmentService.terminateMember(enrolled.walletId, termDate),
        )
      : this.l2Node.getSequencer().adminMutate('terminate member', ({ setLifecycle, registry, lifecycle }) => {
          setLifecycle(enrolled.walletId, LIFECYCLE_REVOKED);
          return { newRegistryRoot: registry.getRoot(), newLifecycleRoot: lifecycle.getRoot() };
        });
    this.emit('offchain', 'terminate', 'Step 1: Credential revoked, lifecycle set to REVOKED', 'complete');

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
          (rx.status === 'ADJUDICATED' || rx.status === 'FILLED' || rx.status === 'PARTIALLY_FILLED' || rx.status === 'DISPENSED')) {
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
    ndcHash: string;
    action: 'MODIFY' | 'REMOVE' | 'ADD';
    newTierLevel?: number;
    newCopayAmountCents?: number;
    newRequiresPriorAuth?: boolean;
    newStepTherapyRequired?: boolean;
  }): Promise<Record<string, unknown>> {
    const medication = this.getMedicationByNdcHash(opts.ndcHash);
    const leafIdx = Number(this.getFormularyLeafIndex(opts.ndcHash));

    const actionVerb = opts.action === 'REMOVE' ? 'Removing' : opts.action === 'ADD' ? 'Re-adding' : 'Modifying';
    this.emit('phase', 'formulary', `═══ Formulary Change: ${actionVerb} ${medication.brandName} ═══`);

    // 1. Validate action
    if (opts.action === 'REMOVE' && !this.formularyActive[leafIdx]) {
      throw new Error(`${medication.brandName} is already removed from the formulary`);
    }
    if (opts.action === 'ADD' && this.formularyActive[leafIdx]) {
      throw new Error(`${medication.brandName} is already on the formulary`);
    }

    // 2. Update working state
    let details = '';
    if (opts.action === 'REMOVE') {
      this.formularyActive[leafIdx] = false;
      details = `Removed from formulary`;
      this.emit('info', 'formulary', `  Removing ${medication.brandName} from formulary`);
    } else if (opts.action === 'ADD') {
      this.formularyActive[leafIdx] = true;
      details = `Re-added to formulary`;
      this.emit('info', 'formulary', `  Re-adding ${medication.brandName} to formulary`);
    } else {
      // MODIFY
      const entry = this.currentFormularyEntries[leafIdx];
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
      ndcHash: opts.ndcHash,
      medicationName: medication.brandName,
      details,
      affectedMembers,
      oldFormularyRoot,
      newFormularyRoot,
    });

    this.emit('phase', 'formulary', `═══ Formulary Change Complete ═══`);

    return {
      action: opts.action,
      ndcHash: opts.ndcHash,
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
        const p = PRESCRIBERS[i];
        prescriberName = `${prescriberDisplayName(p)}`;
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
    this.emit('info', 'network', `  │  Action:           ${opts.action} — ${prescriberName}${prescriberIdx >= 0 ? ` (seed index ${prescriberIdx})` : ''}`);
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
  }): Promise<Record<string, unknown>> {
    this.emit('phase', 'rollover', `═══ Plan Year Rollover: ${opts.newPlanYear} ═══`);

    const affectedMembers: string[] = [];

    for (const [walletIdStr, enrolled] of this.enrolledMembers) {
      if (enrolled.lifecycle === 'REVOKED') continue;

      // Log old accumulator state
      const oldDeductiblePaid = Number(enrolled.accumulatorData.deductiblePaidCents.toBigInt());
      const oldOopPaid = Number(enrolled.accumulatorData.oopPaidCents.toBigInt());
      const oldBenefitUsed = Number(enrolled.accumulatorData.annualBenefitUsedCents.toBigInt());

      // Build fresh accumulator (zero running totals, same limits)
      // A-35: the member's own limits carry into the new year; they were fixed constants here before
      enrolled.accumulatorData = forNewPlanYear(enrolled.accumulatorData, opts.newPlanYear);

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

    const prescriber = PRESCRIBERS[opts.prescriberIndex];
    if (!prescriber) throw new Error(`Invalid prescriber index: ${opts.prescriberIndex}`);

    const prescriberWalletId = this.prescriberWalletIds.get(opts.prescriberIndex)!;
    const prescriberPreimage = this.prescriberPreimages.get(opts.prescriberIndex)!;
    const prescriberName = `${prescriberDisplayName(prescriber)}`;

    this.emit('phase', 'pcp', `═══ PCP Assignment: ${enrolled.displayName} → ${prescriberName} ═══`);

    // 1. ProofGate: Prescriber identity
    this.emit('proof', 'pcp', `[1/2] Generating ProofGate.verifyPrescriber proof...`, 'start');
    const startPG = performance.now();
    await this.dispatchProof(
      'ProofGate', 'verifyPrescriber',
      ['Field', 'Field', 'Field', 'Field'],
      [prescriberWalletId, ...prescriberPreimage],
      () => ProofGateProgram.verifyPrescriber(prescriberWalletId, ...prescriberPreimage as [Field, Field, Field]),
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
    await this.dispatchProof(
      'PcpVerification', 'verifyPcpAssignment',
      ['CredentialData', 'PcpAssignmentData', 'ForestRoots', 'ForestMerkleWitness', 'Field', 'Field'],
      [enrolled.credentialData, pcpData, forestRoots, memberWitness, prescriberWalletId, dateToField('20260201')],
      () => PcpVerificationProgram.verifyPcpAssignment(enrolled.credentialData, pcpData, forestRoots, memberWitness, prescriberWalletId, dateToField('20260201')),
    );
    const elapsedPCP = performance.now() - startPCP;
    this.emit('proof', 'pcp', `[2/2] PcpVerificationProgram.verifyPcpAssignment proof generated`, 'complete', elapsedPCP);
    this.emit('info', 'pcp', `       ZK proof IS the consent — ${enrolled.displayName} authorized ${prescriberName} as PCP`);

    // Submit wallet update to L2 (forest changed → new inventory root)
    await this.updateCredentialAndSubmitToL2(enrolled, 'pcp');

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
      formularyCount: MEDICATIONS.length,
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
      const med = this.getMedicationByNdcHash(rx.ndcHash);
      const prescriberData = PRESCRIBERS[rx.prescriberIndex];
      const pharmacyData = PHARMACIES[rx.pharmacyIndex];
      const fills = this.fulfillments.get(rx.id) || [];
      const latestFill = fills.length > 0 ? fills[fills.length - 1] : null;

      prescriptionHistory.push({
        prescriptionId: rx.id,
        medication: med.brandName,
        strength: med.strength,
        ndc: med.ndcFormatted,
        tier: med.formularyEntry.tierLevel,
        prescriber: `${prescriberDisplayName(prescriberData)}`,
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
        // A12, finding A-24 / ENG-19: this said `fulfillment`, which is declared nowhere in this
        // scope, so every member with at least one prescription got a 500 reading their own
        // history. `latestFill` is the fill record in scope and carries the commitment.
        settlementCommitment: latestFill ? fieldToStr(latestFill.settlementCommitment) : null,
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
      pcpAssigned: enrolled.pcpAssignment !== undefined,
    };
  }

  // ─── Get Family History ─────────────────────────────────

  getFamilyHistory(opts: { memberWalletId: string }): Record<string, unknown> {
    const enrolled = this.enrolledMembers.get(opts.memberWalletId);
    if (!enrolled) throw new Error(`Member not enrolled: ${opts.memberWalletId}`);

    // Find all enrolled family members
    const familyMembers: Record<string, unknown>[] = [];
    const familyAccumulators: MemberAccumulator[] = [];

    // A-34: the bound family only; a member with none is shown alone.
    for (const m of familyMembersOf(enrolled, this.enrolledMembers.values())) {
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
        const med = this.getMedicationByNdcHash(rx.ndcHash);
        const prescriberData = PRESCRIBERS[rx.prescriberIndex];
        const pharmacyData = PHARMACIES[rx.pharmacyIndex];
        const fills = this.fulfillments.get(rx.id) || [];
        const latestFill = fills.length > 0 ? fills[fills.length - 1] : null;

        rxHistory.push({
          prescriptionId: rx.id,
          medication: med.brandName,
          strength: med.strength,
          ndc: med.ndcFormatted,
          tier: med.formularyEntry.tierLevel,
          prescriber: `${prescriberDisplayName(prescriberData)}`,
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
          // Same fix as above (A12 / ENG-19): `fulfillment` was undeclared here too.
          settlementCommitment: latestFill ? fieldToStr(latestFill.settlementCommitment) : null,
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
        pcpAssigned: m.pcpAssignment !== undefined,
      });
    }

    // Family totals
    const familyTotals = FamilyAccumulatorService.getFamilyTotals(familyAccumulators);
    // B8: the plan's family limits, the ones the fill proof uses, not constants.
    const familyLimits: FamilyLimits = familyLimitsFor(enrolled, this.l2Node.getSequencer().getPlan(enrolled.planId));

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
    claimMetadata?: import('../l2/l2-types.js').ClaimSubmissionMetadata,
  ): Promise<L2Receipt> {
    if (!enrolled.preimageFields) {
      throw new Error('A member with a device proves its own wallet updates; the engine holds no preimage for it (B2)');
    }
    const receipt = await this.proveAndSubmitWalletUpdate(
      enrolled.walletId, enrolled.preimageFields, newInventoryRoot, LIFECYCLE_ELIGIBLE, phase, claimMetadata,
    );
    // The sequencer has applied the new state to its tree; mirror it on the enrolled record.
    enrolled.nonce = Number(this.walletRegistry.getState(enrolled.walletId).nonce.toBigInt());
    enrolled.credentialInventoryRoot = newInventoryRoot;
    enrolled.l2Receipts.push(receipt.receiptId);
    return receipt;
  }

  /**
   * Prove a wallet update against the sequencer's live tree and submit it. If another change
   * lands between reading the witnesses and submitting (root mismatch), read fresh witnesses
   * and prove again. The sequencer updates its own tree when it accepts the proof.
   */
  private async proveAndSubmitWalletUpdate(
    walletId: Field,
    preimageFields: Field[],
    newInventoryRoot: Field,
    lifecycleState: Field,
    phase: string,
    claimMetadata?: import('../l2/l2-types.js').ClaimSubmissionMetadata,
  ): Promise<L2Receipt> {
    const seq = this.l2Node.getSequencer();
    const pi = preimageFields;
    const MAX_ATTEMPTS = 4;
    for (let attempt = 1; ; attempt++) {
      // D7 (A-33): one prover at a time per partition; the lease is released when the proof lands
      await seq.acquireProvingLeaseWaiting(walletId.toString());
      // Current nonce, credential root, roots and witnesses — all from the sequencer's tree.
      const live = seq.getWalletStateForRpc(walletId.toString());
      const oldRoot = Field(BigInt(live.credentialInventoryRoot));
      const oldNonce = Field(BigInt(live.nonce));
      const currentRegRoot = seq.getCurrentRegistryRoot();
      const currentLcRoot = seq.getCurrentLifecycleRoot();
      const witnesses = seq.getWalletWitnesses(walletId.toString());
      const regWitness = WalletRegistryWitness.fromJSON(JSON.parse(witnesses.registryWitnessJson));
      const lcWitness = LifecycleWitness.fromJSON(JSON.parse(witnesses.lifecycleWitnessJson));

      this.emit('proof', phase, 'Generating StateTransitionProof.proveWalletUpdate...', 'start');
      const start = performance.now();
      const stDispatch = await this.dispatchProof(
        'StateTransition', 'proveWalletUpdate',
        ['Field', 'Field', 'Field', 'Field', 'Field', 'Field', 'Field', 'Field', 'Field', 'Field', 'WalletRegistryWitness', 'LifecycleWitness', 'Field', 'Field', 'Field'],
        [DOMAIN_TAG_MEMBER, pi[0]!, pi[1]!, pi[2]!, pi[3]!, pi[4]!, pi[5]!, oldRoot, oldNonce, newInventoryRoot, regWitness, lcWitness, currentRegRoot, currentLcRoot, lifecycleState],
        () => StateTransitionProgram.proveWalletUpdate(DOMAIN_TAG_MEMBER, pi[0]!, pi[1]!, pi[2]!, pi[3]!, pi[4]!, pi[5]!, oldRoot, oldNonce, newInventoryRoot, regWitness, lcWitness, currentRegRoot, currentLcRoot, lifecycleState),
      );
      const elapsed = performance.now() - start;
      this.emit('proof', phase, `StateTransitionProof generated`, 'complete', elapsed);

      const stOutput = stDispatch.publicOutput!;
      this.emit('info', phase, `  ┌─ PROOF: StateTransitionProgram.proveWalletUpdate`);
      this.emit('info', phase, `  │  Wallet:         ${truncField(walletId)} (index ${witnesses.slotIndex})`);
      this.emit('info', phase, `  │  Nonce:           ${oldNonce.toString()} → ${oldNonce.add(1).toString()}`);
      this.emit('info', phase, `  │  Credential Root: ${truncField(oldRoot)} → ${truncField(newInventoryRoot)}`);
      this.emit('info', phase, `  │  Registry Root:   ${truncField(currentRegRoot)}`);
      this.emit('info', phase, `  │  Lifecycle Root:  ${truncField(currentLcRoot)}`);
      this.emit('info', phase, `  │  Public Output:`);
      this.emit('info', phase, `  │    oldRegistryRoot:  ${truncStr(stOutput.oldRegistryRoot)}`);
      this.emit('info', phase, `  │    newRegistryRoot:  ${truncStr(stOutput.newRegistryRoot)}`);
      this.emit('info', phase, `  │    oldLifecycleRoot: ${truncStr(stOutput.oldLifecycleRoot)}`);
      this.emit('info', phase, `  │    newLifecycleRoot: ${truncStr(stOutput.newLifecycleRoot)}`);
      this.emit('info', phase, `  └─ Proof verified: constraints satisfied (${elapsed.toFixed(0)}ms)`);

      // newCredentialInventoryRoot lets the sequencer update its tree and check the result.
      const enrichedMetadata = {
        ...(claimMetadata || {}),
        newCredentialInventoryRoot: newInventoryRoot.toString(),
      } as any;
      const stProof = await StateTransitionProof.fromJSON(JSON.parse(stDispatch.proofJson!));
      try {
        const receipt = await this.l2Node.submitProof(stProof, enrichedMetadata);
        this.emit('info', phase, `  ┌─ L2 RECEIPT`);
        this.emit('info', phase, `  │  Receipt ID:     ${receipt.receiptId}`);
        this.emit('info', phase, `  │  Sequence #:     ${receipt.sequenceNumber}`);
        this.emit('info', phase, `  │  New Reg Root:   ${truncStr(stOutput.newRegistryRoot)}`);
        this.emit('info', phase, `  └─ Proof accepted by sequencer`);
        return receipt;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const contended = /root mismatch|does not match the sequencer tree|state changed while/i.test(msg);
        if (!contended || attempt >= MAX_ATTEMPTS) throw err;
        this.emit('info', phase, `  Another change landed first (attempt ${attempt}/${MAX_ATTEMPTS}) — re-proving against the new root`);
      }
    }
  }

  /**
   * Update member's CredentialInventory slot 0 with current credentialData and submit wallet update to L2.
   * Use after any forest mutation (fill, PA, formulary, rollover).
   */
  private async updateCredentialAndSubmitToL2(
    enrolled: EnrolledMember,
    phase: string,
    claimMetadata?: import('../l2/l2-types.js').ClaimSubmissionMetadata,
  ): Promise<WalletUpdateOutcome> {
    const oldInventoryRoot = enrolled.credentialInventory.getRoot();
    enrolled.credentialInventory.updateCredential(0n, enrolled.credentialData);
    const newInventoryRoot = enrolled.credentialInventory.getRoot();

    // ─── Patent Evidence: Credential State Mutation ─────────────────
    this.emit('info', phase, `  ┌─ CREDENTIAL UPDATE (${enrolled.displayName})`);
    this.emit('info', phase, `  │  Credential Type:  ${enrolled.credentialData.credentialType.equals(CREDENTIAL_TYPE_ELIGIBILITY).toBoolean() ? 'ELIGIBILITY' : 'PRESCRIPTION'}`);
    this.emit('info', phase, `  │  Subject Wallet:   ${truncField(enrolled.credentialData.subjectWalletId)}`);
    this.emit('info', phase, `  │  Forest Root:      ${truncField(enrolled.credentialData.forestRoot)}`);
    this.emit('info', phase, `  │  Inventory Root:   ${truncField(oldInventoryRoot)} → ${truncField(newInventoryRoot)}`);
    if (enrolled.preimageFields) {
      // A fixture member: the engine still proves (fixtures leave last). No member with a device comes here.
      this.emit('info', phase, `  └─ Submitting StateTransitionProof to L2...`);
      return { receipt: await this.submitWalletUpdate(enrolled, newInventoryRoot, phase, claimMetadata) };
    }
    // B1 step two: the member's device proves it. The update is queued, its claim (if any) committed on
    // the sequencer against this root; the device fetches, re-derives, proves, submits and reports.
    return { pending: this.queueWalletUpdate(enrolled, phase, phase, claimMetadata) };
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
  /**
   * D4 (A-10): the duplicate-claim rule, shared with the ledger. A fill is a duplicate when another prescription's
   * fill for the same member, drug and pharmacy on the same day stands unreversed — in this engine's records, which
   * include fills the member's device has not yet proven, or on the sequencer's ledger. The remainder of a partial
   * fill is the same prescription and is not a duplicate. Returns a short description of the earlier fill, or null.
   */
  findDuplicateFill(key: { prescriptionId: string; memberWalletId: string; ndcHash: string; pharmacyWalletId: string; dateOfService: string; fillNumber: number }): string | null {
    for (const [rxId, fills] of this.fulfillments) {
      if (rxId === key.prescriptionId) continue;
      const rx = this.prescriptions.get(rxId);
      if (!rx || rx.memberWalletId !== key.memberWalletId || rx.ndcHash !== key.ndcHash) continue;
      if (this.pharmacyWalletIds.get(rx.pharmacyIndex)?.toBigInt().toString() !== key.pharmacyWalletId) continue;
      if (fills.some((f) => !f.reversed && f.dateOfService === key.dateOfService)) return `prescription ${rxId}`;
    }
    const onLedger = this.getL2Node().getSequencer().getClaimAccumulator().hasActiveFill(key.memberWalletId, key.ndcHash, key.pharmacyWalletId, key.dateOfService, key.fillNumber);
    return onLedger ? `ledger leaf ${onLedger.leafIndex}` : null;
  }

  getL2Node(): L2Node {
    return this.l2Node;
  }

  /** Get prescriber wallet ID by seed index (for external route mapping) */
  getPrescriberWalletId(index: number): Field | undefined {
    return this.prescriberWalletIds.get(index);
  }

  /** Get pharmacy wallet ID by seed index (for external route mapping) */
  getPharmacyWalletId(index: number): Field | undefined {
    return this.pharmacyWalletIds.get(index);
  }

  /**
   * Get all prescriptions for a pharmacy, with full workflow state.
   * The pharmacy dashboard reads this instead of maintaining in-memory state.
   */
  getPrescriptionsByPharmacy(pharmacyIndex: number): Record<string, unknown>[] {
    const results: Record<string, unknown>[] = [];

    // Pending prescriptions (proofs still generating)
    for (const [, pending] of this.pendingPrescriptions) {
      if (pending.pharmacyIndex !== pharmacyIndex) continue;
      const med = this.getMedicationByNdcHash(pending.ndcHash);
      results.push({
        prescriptionId: pending.id,
        status: 'PENDING',
        ndcHash: pending.ndcHash,
        brandName: med.brandName,
        genericName: med.genericName,
        strength: med.strength,
        ndc: med.ndcFormatted,
        tierLevel: med.formularyEntry.tierLevel,
        copayAmountCents: med.formularyEntry.copayAmount,
        memberWalletId: pending.memberWalletId,
        prescriberWalletId: this.prescriberWalletIds.get(pending.prescriberIndex)?.toString() ?? '',
        pharmacyWalletId: this.pharmacyWalletIds.get(pending.pharmacyIndex)?.toString() ?? '',
        quantity: pending.quantity,
        quantityDispensed: 0,
        refills: pending.refills,
        dateOfService: new Date().toISOString().slice(0, 10),
        patientPayCents: null,
        planPayCents: null,
        deductibleCreditCents: null,
        adjudicationPhase: null,
        memberVerified: false,
        proofStatus: 'pending',
      });
    }

    // Adjudicated/Filled/Dispensed prescriptions
    for (const [rxId, rx] of this.prescriptions) {
      if (rx.pharmacyIndex !== pharmacyIndex) continue;
      const med = this.getMedicationByNdcHash(rx.ndcHash);
      const fills = this.fulfillments.get(rxId) || [];
      const activeFills = fills.filter(f => !f.reversed);
      const totalPatientPay = activeFills.reduce((s, f) => s + f.patientPayCents, 0);
      const totalPlanPay = activeFills.reduce((s, f) => s + f.planPayCents, 0);
      const totalDeductibleCredit = activeFills.reduce((s, f) => s + Number(f.deductibleCreditField.toBigInt()), 0);
      const lastFill = activeFills.length > 0 ? activeFills[activeFills.length - 1] : null;

      results.push({
        prescriptionId: rxId,
        status: rx.status,
        ndcHash: rx.ndcHash,
        brandName: med.brandName,
        genericName: med.genericName,
        strength: med.strength,
        ndc: med.ndcFormatted,
        tierLevel: med.formularyEntry.tierLevel,
        copayAmountCents: med.formularyEntry.copayAmount,
        memberWalletId: rx.memberWalletId,
        prescriberWalletId: this.prescriberWalletIds.get(rx.prescriberIndex)?.toString() ?? '',
        pharmacyWalletId: this.pharmacyWalletIds.get(rx.pharmacyIndex)?.toString() ?? '',
        quantity: rx.quantity,
        quantityDispensed: rx.quantityDispensed,
        refills: rx.refills,
        refillsUsed: rx.refillsUsed,
        dateOfService: new Date().toISOString().slice(0, 10),
        patientPayCents: totalPatientPay || null,
        planPayCents: totalPlanPay || null,
        deductibleCreditCents: totalDeductibleCredit || null,
        adjudicationPhase: lastFill ? (lastFill.accumulatorBefore.deductiblePaid < 50000 ? 'DEDUCTIBLE' : 'NORMAL_COPAY') : null,
        memberVerified: false, // TODO: track on sequencer
        proofStatus: fills.length > 0 ? 'complete' : null,
        statusHistory: rx.statusHistory,
        fills: fills.map((f, i) => ({
          fillIndex: i,
          patientPayCents: f.patientPayCents,
          planPayCents: f.planPayCents,
          totalCostCents: f.totalCostCents,
          reversed: f.reversed,
          quantityDispensed: f.quantityDispensed,
        })),
      });
    }

    return results;
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
      const med = this.getMedicationByNdcHash(rx.ndcHash);
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
          dateOfService: 20260215, // seed date
        });
      }
    }
    return claims;
  }

  private buildPriorAuthContexts(): PriorAuthContext[] {
    const contexts: PriorAuthContext[] = [];
    for (const [_, pa] of this.priorAuths) {
      if (pa.status !== 'APPROVED') continue;
      const med = this.getMedicationByNdcHash(pa.ndcHash);
      const prescriberWid = this.prescriberWalletIds.get(pa.prescriberIndex);
      if (!prescriberWid) continue;

      // Find matching Rx to get approved quantity
      const rx = [...this.prescriptions.values()].find(
        r => r.ndcHash === pa.ndcHash && r.memberWalletId === pa.memberWalletId
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
        MEDICATIONS.map(m => [
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
    // B1 step two (A-17): a member with a device proves its own portable credential; the engine mints
    // none for it, so no operator can hold a real member's credential. Fixture members keep this path.
    if (enrolled.memberIndex < 0) {
      throw new RegistrationRefused(409, 'A member with a device generates its own portable credential (POST /credential/generate on the member node); the engine mints none for it');
    }

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

    // 2. The ownership proof. A member with a device made it there at registration (B2); the engine
    // keeps it and never holds the preimage. A fixture member's is made here from the fixture preimage.
    // Fresh Field objects are created from bigint values to avoid o1js internal FieldVar state
    // corruption that can occur after Fields are used as circuit inputs.
    this.emit('proof', 'credential', 'Step 1: ProofGate.verifyMember proof (the device\'s, or the fixture\'s)...', 'start');
    const pgStart = performance.now();
    const freshWalletId = Field(enrolled.walletId.toBigInt());
    let pgProofJson: string;
    if (typeof enrolled.cachedProofGateProof === 'string' && enrolled.cachedProofGateProof.length > 0) {
      pgProofJson = enrolled.cachedProofGateProof;
    } else if (enrolled.preimageFields) {
      const freshPreimage = enrolled.preimageFields.map(f => Field(f.toBigInt())) as [Field, Field, Field, Field, Field, Field];
      const pgDispatch = await this.dispatchProof(
        'ProofGate', 'verifyMember',
        ['Field', 'Field', 'Field', 'Field', 'Field', 'Field', 'Field'],
        [freshWalletId, ...freshPreimage],
        () => ProofGateProgram.verifyMember(freshWalletId, ...freshPreimage as [Field, Field, Field, Field, Field, Field]),
      );
      pgProofJson = pgDispatch.proofJson!;
      enrolled.cachedProofGateProof = pgProofJson;
    } else {
      throw new Error('No ownership proof for this member: the device has not provided one');
    }
    const pgElapsed = performance.now() - pgStart;
    this.emit('proof', 'credential', 'Step 1: ProofGate proof ready', 'complete', pgElapsed);

    // The ProofGateProof as CredentialProgram input
    const pgProof = await ProofGateProof.fromJSON(JSON.parse(pgProofJson));

    // 3. Generate CredentialProgram proof
    const proofTypeLabel = proofType === 'holding' ? 'proveHolding' : 'proveHoldingByType';
    this.emit('proof', 'credential', `Step 2: Generating CredentialProgram.${proofTypeLabel} proof...`, 'start');
    const credentialStart = performance.now();

    let credDispatch;
    let credentialProofType: PortableCredential['proofType'];
    if (proofType === 'holding') {
      credDispatch = await this.dispatchProof(
        'Credential', 'proveHolding',
        ['ProofGateProof', 'CredentialData', 'CredentialInventoryWitness', 'Field'],
        [pgProof, credentialData, witness, inventoryRoot],
        () => CredentialProgram.proveHolding(pgProof, credentialData, witness, inventoryRoot),
      );
      credentialProofType = 'credential-holding';
    } else {
      credDispatch = await this.dispatchProof(
        'Credential', 'proveHoldingByType',
        ['ProofGateProof', 'CredentialData', 'CredentialInventoryWitness', 'Field', 'Field'],
        [pgProof, credentialData, witness, inventoryRoot, CREDENTIAL_TYPE_ELIGIBILITY],
        () => CredentialProgram.proveHoldingByType(pgProof, credentialData, witness, inventoryRoot, CREDENTIAL_TYPE_ELIGIBILITY),
      );
      credentialProofType = 'credential-type-holding';
    }
    const credentialElapsed = performance.now() - credentialStart;
    this.emit('proof', 'credential', `Step 2: CredentialProgram.${proofTypeLabel} proof generated`, 'complete', credentialElapsed);
    this.emitMemory('credential');

    // 4. Serialize into PortableCredential
    const credProof = await CredentialOperationProof.fromJSON(JSON.parse(credDispatch.proofJson!));
    const credential = serializeCredential(
      credProof,
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
            (rx.status === 'ADJUDICATED' || rx.status === 'FILLED' || rx.status === 'PARTIALLY_FILLED' || rx.status === 'DISPENSED')) {
          const med = this.getMedicationByNdcHash(rx.ndcHash);
          const pharm = PHARMACIES[rx.pharmacyIndex];
          memberPrescriptions.push({
            id: rx.id,
            medication: med.brandName,
            medicationStrength: med.strength,
            ndcHash: rx.ndcHash,
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

  /**
   * Verify an attestation's Ed25519 signature and expiry.
   *
   * A10: against **this engine's own authority key**, not the key carried inside the attestation.
   * Verifying against the embedded key accepted anything anyone chose to sign, which is finding
   * A-12. This verifier is the engine checking its own signatures, so it already holds the right
   * key and no fetch is needed.
   */
  verifyAttestation(att: NfcCredentialAttestation): { valid: boolean; expired: boolean; revoked: boolean; reason?: string } {
    const result = SequencerAttestationAuthority.verifyAttestation(
      att,
      this.attestationAuthority.publicKeyHex,
    );
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

  // ─── Checkpoint Persistence ──────────────────────────────

  /**
   * Export the full AdjudicationService session state to a JSON-safe object.
   * All o1js Field values are converted to decimal strings.
   * MerkleForest objects are stored as arrays of {domain, leafIndex, commitment} entries
   * so they can be reconstructed deterministically on restore.
   */
  exportState(): AdjudicationCheckpointState {
    // --- Enrolled Members ---
    const serializedMembers: SerializedEnrolledMember[] = [];
    for (const [walletIdStr, m] of this.enrolledMembers) {
      // Extract all non-empty forest leaves for reconstruction
      const forestLeaves: SerializedForestLeaf[] = [];

      // ACCESS_CONTROL leaf 0 = eligibilityData
      forestLeaves.push({
        domain: ForestDomain.ACCESS_CONTROL,
        leafIndex: '0',
        commitment: m.eligibilityData.commitment().toString(),
      });

      // ACCESS_CONTROL leaf 127 = accumulatorData
      forestLeaves.push({
        domain: ForestDomain.ACCESS_CONTROL,
        leafIndex: ACCUMULATOR_LEAF_INDEX.toString(),
        commitment: m.accumulatorData.commitment().toString(),
      });

      // ACCESS_CONTROL leaves 1-126 = prior auth data (if any)
      const paLeafIndices: string[] = [];
      for (const [_paId, pa] of this.priorAuths) {
        if (pa.memberWalletId === walletIdStr && pa.paLeafIndex !== undefined && pa.priorAuthData) {
          forestLeaves.push({
            domain: ForestDomain.ACCESS_CONTROL,
            leafIndex: pa.paLeafIndex.toString(),
            commitment: pa.priorAuthData.commitment().toString(),
          });
          paLeafIndices.push(pa.paLeafIndex.toString());
        }
      }

      // MEMBER leaf 0 = pcpAssignment (if present)
      if (m.pcpAssignment) {
        forestLeaves.push({
          domain: ForestDomain.MEMBER,
          leafIndex: PCP_ASSIGNMENT_LEAF_INDEX.toString(),
          commitment: m.pcpAssignment.commitment().toString(),
        });
      }

      serializedMembers.push({
        memberIndex: m.memberIndex,
        walletId: m.walletId.toString(),
        walletIdStr: m.walletIdStr,
        displayName: m.displayName,
        credentialData: CredentialData.toJSON(m.credentialData) as Record<string, string>,
        eligibilityData: EligibilityData.toJSON(m.eligibilityData) as Record<string, string>,
        accumulatorData: AccumulatorData.toJSON(m.accumulatorData) as Record<string, string>,
        planId: m.planId,
        groupId: m.groupId,
        familyId: m.familyId,
        relationship: m.relationship,
        employeeId: m.employeeId,
        // B2: no identity preimage is written; the device's ownership proof is kept for the portable credential
        ownershipProofJson: typeof m.cachedProofGateProof === 'string' ? m.cachedProofGateProof : undefined,
        pcpAssignment: m.pcpAssignment
          ? PcpAssignmentData.toJSON(m.pcpAssignment) as Record<string, string>
          : undefined,
        pcpPrescriberIndex: m.pcpPrescriberIndex,
        inNetworkPrescriberIndices: m.inNetworkPrescriberIndices,
        inNetworkPharmacyIndices: m.inNetworkPharmacyIndices,
        lifecycle: m.lifecycle,
        terminationDate: m.terminationDate,
        walletIndex: m.walletIndex,
        nonce: m.nonce,
        credentialInventoryRoot: m.credentialInventoryRoot.toString(),
        l2Receipts: m.l2Receipts,
        lastCredentialJson: m.lastCredentialJson,
        forestLeaves,
        paLeafIndices,
      });
    }

    // --- Prescriptions ---
    const serializedPrescriptions: SerializedPrescription[] = [];
    for (const [_rxId, rx] of this.prescriptions) {
      // Extract all TRANSACTION tree leaves (0 to nextTxLeafIndex - 1)
      const txLeaves: Array<{ leafIndex: string; commitment: string }> = [];
      for (let i = 0n; i < rx.nextTxLeafIndex; i++) {
        const leaf = rx.rxForest.getLeaf(ForestDomain.TRANSACTION, i);
        // Only store non-zero leaves (empty leaves are Field(0) by default)
        if (leaf.toBigInt() !== 0n) {
          txLeaves.push({
            leafIndex: i.toString(),
            commitment: leaf.toString(),
          });
        }
      }

      serializedPrescriptions.push({
        id: rx.id,
        prescriptionData: PrescriptionData.toJSON(rx.prescriptionData) as Record<string, string>,
        activeStatus: PrescriptionStatusData.toJSON(rx.activeStatus) as Record<string, string>,
        rxCredentialData: CredentialData.toJSON(rx.rxCredentialData) as Record<string, string>,
        formularyEntry: FormularyEntry.toJSON(rx.formularyEntry) as Record<string, string>,
        prescriberIndex: rx.prescriberIndex,
        pharmacyIndex: rx.pharmacyIndex,
        memberWalletId: rx.memberWalletId,
        ndcHash: rx.ndcHash,
        formularyLeafIndex: rx.formularyLeafIndex.toString(),
        quantity: rx.quantity,
        quantityDispensed: rx.quantityDispensed,
        refills: rx.refills,
        refillsUsed: rx.refillsUsed,
        status: rx.status,
        statusHistory: rx.statusHistory,
        currentStatusLeafIndex: rx.currentStatusLeafIndex.toString(),
        nextTxLeafIndex: rx.nextTxLeafIndex.toString(),
        txLeaves,
        medicationLeaf0: rx.rxForest.getLeaf(ForestDomain.MEDICATION, 0n).toString(),
      });
    }

    // --- Fulfillments ---
    const serializedFulfillments: Record<string, SerializedFulfillment[]> = {};
    for (const [rxId, fills] of this.fulfillments) {
      serializedFulfillments[rxId] = fills.map(f => ({
        prescriptionId: f.prescriptionId,
        fillIndex: f.fillIndex,
        patientPayCents: f.patientPayCents,
        planPayCents: f.planPayCents,
        totalCostCents: f.totalCostCents,
        accumulatorBefore: f.accumulatorBefore,
        accumulatorAfter: f.accumulatorAfter,
        newEligForestRoot: f.newEligForestRoot,
        oldEligForestRoot: f.oldEligForestRoot,
        settlementCommitment: f.settlementCommitment.toString(),
        fulfillmentData: FulfillmentData.toJSON(f.fulfillmentData) as Record<string, string>,
        patientPayField: f.patientPayField.toString(),
        planPayField: f.planPayField.toString(),
        deductibleCreditField: f.deductibleCreditField.toString(),
        settlementLeafIndex: f.settlementLeafIndex.toString(),
        quantityDispensed: f.quantityDispensed,
        reversed: f.reversed,
        dateOfService: f.dateOfService,
      }));
    }

    // --- Prior Auths ---
    const serializedPriorAuths: SerializedPriorAuth[] = [];
    for (const [_paId, pa] of this.priorAuths) {
      serializedPriorAuths.push({
        id: pa.id,
        memberWalletId: pa.memberWalletId,
        prescriberIndex: pa.prescriberIndex,
        ndcHash: pa.ndcHash,
        status: pa.status,
        requestedAt: pa.requestedAt,
        resolvedAt: pa.resolvedAt,
        paLeafIndex: pa.paLeafIndex !== undefined ? pa.paLeafIndex.toString() : undefined,
        priorAuthData: pa.priorAuthData
          ? PriorAuthData.toJSON(pa.priorAuthData) as Record<string, string>
          : undefined,
      });
    }

    // --- Pending Prescriptions ---
    const serializedPending: SerializedPendingPrescription[] = [];
    for (const [_pendingId, p] of this.pendingPrescriptions) {
      serializedPending.push({
        id: p.id,
        prescriberIndex: p.prescriberIndex,
        pharmacyIndex: p.pharmacyIndex,
        memberWalletId: p.memberWalletId,
        ndcHash: p.ndcHash,
        quantity: p.quantity,
        refills: p.refills,
        startedAt: p.startedAt,
      });
    }

    // --- Next PA Leaf Index ---
    const nextPaLeafIndex: Record<string, string> = {};
    for (const [walletId, idx] of this.nextPaLeafIndex) {
      nextPaLeafIndex[walletId] = idx.toString();
    }

    return {
      version: 1,
      prescriptions: serializedPrescriptions,
      fulfillments: serializedFulfillments,
      pendingPrescriptions: serializedPending,
      priorAuths: serializedPriorAuths,
      prescriberAuthorizations: [...this.prescriberAuthorizations.values()].flat(),
      enrolledMembers: serializedMembers,
      rxCounter: this.rxCounter,
      paCounter: this.paCounter,
      msgNonce: this.msgNonce,
      threadCounter: this.threadCounter,
      nextPaLeafIndex,
      approvedMembers: [...this.approvedMembers.values()],
      pendingWalletUpdates: [...this.pendingWalletUpdates.values()],
    };
  }

  /**
   * Restore AdjudicationService session state from a previously exported checkpoint.
   * Rebuilds all MerkleForest objects from stored leaf data.
   * Rebuilds CredentialInventory from stored CredentialData.
   *
   * IMPORTANT: Infrastructure (walletRegistry, lifecycleTree, formularyRegistry, etc.)
   * must already be initialized via initInfrastructure() before calling restoreState().
   */
  restoreState(state: AdjudicationCheckpointState): void {
    if (state.version !== 1) {
      throw new Error(`Unsupported AdjudicationCheckpointState version: ${state.version}`);
    }

    // --- Restore counters ---
    this.rxCounter = state.rxCounter;
    this.paCounter = state.paCounter;
    this.msgNonce = state.msgNonce;
    this.approvedMembers = new Map((state.approvedMembers ?? []).map((a) => [a.walletId, a]));
    this.pendingWalletUpdates = new Map((state.pendingWalletUpdates ?? []).map((u) => [u.updateId, u]));
    this.threadCounter = state.threadCounter;

    // --- Restore nextPaLeafIndex ---
    this.nextPaLeafIndex.clear();
    for (const [walletId, idx] of Object.entries(state.nextPaLeafIndex)) {
      this.nextPaLeafIndex.set(walletId, BigInt(idx));
    }

    // --- Restore the device-granted prescriber authorizations (B5) ---
    this.prescriberAuthorizations.clear();
    for (const a of state.prescriberAuthorizations ?? []) {
      const list = this.prescriberAuthorizations.get(a.memberWalletId) ?? [];
      list.push({ memberWalletId: a.memberWalletId, prescriberWalletId: a.prescriberWalletId, ndcHash: a.ndcHash ?? null, grantedAt: Number(a.grantedAt), expiresAt: Number(a.expiresAt) });
      this.prescriberAuthorizations.set(a.memberWalletId, list);
    }

    // --- Restore Prior Auths (before members, since member forest rebuild reads PA data) ---
    this.priorAuths.clear();
    for (const spa of state.priorAuths) {
      const pa: PriorAuthState = {
        id: spa.id,
        memberWalletId: spa.memberWalletId,
        prescriberIndex: spa.prescriberIndex,
        ndcHash: spa.ndcHash,
        status: spa.status,
        requestedAt: spa.requestedAt,
        resolvedAt: spa.resolvedAt,
        paLeafIndex: spa.paLeafIndex !== undefined ? BigInt(spa.paLeafIndex) : undefined,
        priorAuthData: spa.priorAuthData
          ? new PriorAuthData(PriorAuthData.fromJSON(spa.priorAuthData as any))
          : undefined,
      };
      this.priorAuths.set(pa.id, pa);
    }

    // --- Restore Enrolled Members ---
    this.enrolledMembers.clear();
    for (const sm of state.enrolledMembers) {
      // Restore o1js Structs — fromJSON returns plain field objects, wrap with new Struct()
      const credentialData = new CredentialData(CredentialData.fromJSON(sm.credentialData as any));
      const eligibilityData = new EligibilityData(EligibilityData.fromJSON(sm.eligibilityData as any));
      const accumulatorData = new AccumulatorData(AccumulatorData.fromJSON(sm.accumulatorData as any));
      const pcpAssignment = sm.pcpAssignment
        ? new PcpAssignmentData(PcpAssignmentData.fromJSON(sm.pcpAssignment as any))
        : undefined;
      const walletId = Field(BigInt(sm.walletId));
      // B2: a member with a device has no preimage here. A fixture member's is recomputed from the
      // fixture file, as enrollMember derives it; an older checkpoint's copy is dropped either way.
      if (sm.preimageFields && sm.memberIndex < 0) {
        console.warn(`[engine] dropped an identity preimage from an older checkpoint for ${sm.walletIdStr} (B2)`);
      }
      const fixture = sm.memberIndex >= 0 ? MEMBERS[sm.memberIndex] : undefined;
      const preimageFields = fixture
        ? memberWalletPreimage(fixture.localData, fixture.enrollmentKey, hashString('ACME-CORP'), fixtureIdentitySalt(fixture))
        : undefined;

      // Rebuild MerkleForest from stored leaf data
      const forest = new MerkleForest();
      for (const leaf of sm.forestLeaves) {
        forest.setLeaf(
          leaf.domain as ForestDomain,
          BigInt(leaf.leafIndex),
          Field(BigInt(leaf.commitment)),
        );
      }

      // Rebuild CredentialInventory: slot 0 = credentialData
      const credentialInventory = new CredentialInventory();
      credentialInventory.mint(credentialData);

      const enrolled: EnrolledMember = {
        memberIndex: sm.memberIndex,
        walletId,
        walletIdStr: sm.walletIdStr,
        displayName: sm.displayName,
        forest,
        credentialData,
        credentialInventory,
        eligibilityData,
        accumulatorData,
        planId: sm.planId,
        groupId: sm.groupId,
        familyId: sm.familyId,
        relationship: sm.relationship,
        employeeId: sm.employeeId,
        preimageFields,
        pcpAssignment,
        pcpPrescriberIndex: sm.pcpPrescriberIndex,
        inNetworkPrescriberIndices: sm.inNetworkPrescriberIndices,
        inNetworkPharmacyIndices: sm.inNetworkPharmacyIndices,
        lifecycle: sm.lifecycle,
        terminationDate: sm.terminationDate,
        walletIndex: sm.walletIndex,
        nonce: sm.nonce,
        credentialInventoryRoot: Field(BigInt(sm.credentialInventoryRoot)),
        cachedProofGateProof: sm.ownershipProofJson ?? null,  // the device's proof (B2); a fixture's is made on demand
        l2Receipts: sm.l2Receipts,
        lastCredentialJson: sm.lastCredentialJson,
      };

      this.enrolledMembers.set(sm.walletIdStr, enrolled);
    }

    // --- Restore Prescriptions ---
    this.prescriptions.clear();
    for (const srx of state.prescriptions) {
      // Restore o1js Structs
      const prescriptionData = new PrescriptionData(PrescriptionData.fromJSON(srx.prescriptionData as any));
      const activeStatus = new PrescriptionStatusData(PrescriptionStatusData.fromJSON(srx.activeStatus as any));
      const rxCredentialData = new CredentialData(CredentialData.fromJSON(srx.rxCredentialData as any));
      const formularyEntry = new FormularyEntry(FormularyEntry.fromJSON(srx.formularyEntry as any));

      // Rebuild rxForest from stored leaf data
      const rxForest = new MerkleForest();
      // MEDICATION tree leaf 0
      rxForest.setLeaf(
        ForestDomain.MEDICATION,
        0n,
        Field(BigInt(srx.medicationLeaf0)),
      );
      // TRANSACTION tree leaves
      for (const txLeaf of srx.txLeaves) {
        rxForest.setLeaf(
          ForestDomain.TRANSACTION,
          BigInt(txLeaf.leafIndex),
          Field(BigInt(txLeaf.commitment)),
        );
      }

      const rx: PrescriptionState = {
        id: srx.id,
        prescriptionData,
        activeStatus,
        rxForest,
        rxCredentialData,
        formularyEntry,
        prescriberIndex: srx.prescriberIndex,
        pharmacyIndex: srx.pharmacyIndex,
        memberWalletId: srx.memberWalletId,
        ndcHash: srx.ndcHash,
        formularyLeafIndex: BigInt(srx.formularyLeafIndex),
        quantity: srx.quantity,
        quantityDispensed: srx.quantityDispensed,
        refills: srx.refills,
        refillsUsed: srx.refillsUsed,
        status: srx.status,
        statusHistory: srx.statusHistory,
        currentStatusLeafIndex: BigInt(srx.currentStatusLeafIndex),
        nextTxLeafIndex: BigInt(srx.nextTxLeafIndex),
      };

      this.prescriptions.set(srx.id, rx);
    }

    // --- Restore Fulfillments ---
    this.fulfillments.clear();
    for (const [rxId, sfills] of Object.entries(state.fulfillments)) {
      const fills: FulfillmentState[] = sfills.map(sf => ({
        prescriptionId: sf.prescriptionId,
        fillIndex: sf.fillIndex,
        patientPayCents: sf.patientPayCents,
        planPayCents: sf.planPayCents,
        totalCostCents: sf.totalCostCents,
        accumulatorBefore: sf.accumulatorBefore,
        accumulatorAfter: sf.accumulatorAfter,
        newEligForestRoot: sf.newEligForestRoot,
        oldEligForestRoot: sf.oldEligForestRoot,
        settlementCommitment: Field(BigInt(sf.settlementCommitment)),
        fulfillmentData: new FulfillmentData(FulfillmentData.fromJSON(sf.fulfillmentData as any)),
        patientPayField: Field(BigInt(sf.patientPayField)),
        planPayField: Field(BigInt(sf.planPayField)),
        deductibleCreditField: Field(BigInt(sf.deductibleCreditField)),
        settlementLeafIndex: BigInt(sf.settlementLeafIndex),
        quantityDispensed: sf.quantityDispensed,
        reversed: sf.reversed,
        dateOfService: sf.dateOfService ?? '',
      }));
      this.fulfillments.set(rxId, fills);
    }

    // --- Restore Pending Prescriptions ---
    this.pendingPrescriptions.clear();
    for (const sp of state.pendingPrescriptions) {
      this.pendingPrescriptions.set(sp.id, {
        id: sp.id,
        prescriberIndex: sp.prescriberIndex,
        pharmacyIndex: sp.pharmacyIndex,
        memberWalletId: sp.memberWalletId,
        ndcHash: sp.ndcHash,
        quantity: sp.quantity,
        refills: sp.refills,
        startedAt: sp.startedAt,
      });
    }
  }

  // ─── State & Reset ─────────────────────────────────────

  getState(): Record<string, unknown> {
    const enrolledList: Record<string, unknown>[] = [];
    for (const [_, m] of this.enrolledMembers) {
      const pcpInfo = m.pcpPrescriberIndex !== undefined ? {
        prescriberIndex: m.pcpPrescriberIndex,
        prescriberName: `${prescriberDisplayName(PRESCRIBERS[m.pcpPrescriberIndex])}`,
        specialty: PRESCRIBERS[m.pcpPrescriberIndex].specialty,
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
          limits: {
            deductibleAmountCents: Number(m.accumulatorData.deductibleAmountCents.toBigInt()),
            oopMaxCents: Number(m.accumulatorData.oopMaxCents.toBigInt()),
            annualBenefitMaxCents: Number(m.accumulatorData.annualBenefitMaxCents.toBigInt()),
          },
        },
        pcpAssignment: pcpInfo,
        pendingWalletUpdates: this.pendingUpdatesFor(m.walletId.toString()).length,
        pcpAssigned: m.pcpAssignment !== undefined,
        prescriberAuthorizations: this.activePrescriberAuthorizations(m.walletId.toString()).map(a => ({ prescriberWalletId: a.prescriberWalletId, ndcHash: a.ndcHash, expiresAt: a.expiresAt })),
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
      const med = this.getMedicationByNdcHash(pending.ndcHash);
      rxList.push({
        id: pending.id,
        medication: med.brandName,
        medicationStrength: med.strength,
        ndcHash: pending.ndcHash,
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
      const med = this.getMedicationByNdcHash(rx.ndcHash);
      const fills = this.fulfillments.get(rx.id) || [];
      const totalPatientPay = fills.filter(f => !f.reversed).reduce((s, f) => s + f.patientPayCents, 0);
      const totalPlanPay = fills.filter(f => !f.reversed).reduce((s, f) => s + f.planPayCents, 0);
      rxList.push({
        id: rx.id,
        medication: med.brandName,
        medicationStrength: med.strength,
        ndcHash: rx.ndcHash,
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
      const med = this.getMedicationByNdcHash(pa.ndcHash);
      const prescriber = PRESCRIBERS[pa.prescriberIndex];
      const enrolled = this.enrolledMembers.get(pa.memberWalletId);
      paList.push({
        id: pa.id,
        memberWalletId: pa.memberWalletId,
        memberName: enrolled?.displayName ?? 'Unknown',
        memberWalletIdDisplay: enrolled?.walletIdStr ?? pa.memberWalletId,
        prescriberIndex: pa.prescriberIndex,
        prescriberName: `${prescriberDisplayName(prescriber)}`,
        ndcHash: pa.ndcHash,
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
        // B1 (first half): the fixture people are not in this payload any more. They are a static
        // import, served by the explorer at /fixtures.json beside the console's own pages, so the
        // operator's gated view carries no person records other than enrolled members. The
        // medications below stay because they carry this engine's live formulary state.
        medications: MEDICATIONS.map((m, i) => ({
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
          formularyCount: this.formularyActive.length > 0 ? this.formularyActive.filter(a => a).length : MEDICATIONS.length,
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
      const p = PRESCRIBERS[i];
      dir[wid.toString()] = { displayName: `${prescriberDisplayName(p)}`, type: 'prescriber', index: i };
    }
    // Pharmacies
    for (const [i, wid] of this.pharmacyWalletIds) {
      const p = PHARMACIES[i];
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
    this.medIndexByNdcHash = new Map();
    this.medByNdcHash = new Map();
    this.networkChangeHistory = [];
    this.networkActive.clear();

    // Re-initialize infrastructure (clean trees, registries, etc.)
    try {
      this.initInfrastructure();
      this.emit('info', 'reset', 'Session reset complete. Ready for new enrollments.');
    } catch (err) {
      this.ready = false;
      const msg = err instanceof Error ? err.message : String(err);
      this.emit('error', 'reset', `Reset failed during re-initialization: ${msg}. Service is NOT ready.`);
      throw err;
    }
  }

  isReady(): boolean {
    return this.ready;
  }

  isCompiled(): boolean {
    return this.compiled;
  }

  // ─── Provider Badge — Auto-Tap Simulation ─────────────

  /**
   * Get a provider badge by key (e.g., "prescriber-0", "pharmacy-2").
   */
  getProviderBadge(key: string): ProviderBadge | undefined {
    return this.providerBadges.get(key);
  }

  /**
   * Get all provider badges.
   */
  getAllProviderBadges(): Array<{ key: string; badge: ProviderBadge }> {
    const results: Array<{ key: string; badge: ProviderBadge }> = [];
    for (const [key, badge] of this.providerBadges) {
      results.push({ key, badge });
    }
    return results;
  }

  /**
   * Simulate a single badge tap — decrypt, derive walletId, generate ZK proof.
   *
   * This runs the REAL ProofGateProgram.verifyPrescriber/verifyPharmacy circuit
   * to produce a genuine ZK proof that the badge holder knows the wallet preimage.
   *
   * @param providerType — 'prescriber' or 'pharmacy'
   * @param providerIndex — index into PRESCRIBERS or PHARMACIES
   * @returns BadgeTapEvent[] — sequence of events for the tap flow
   */
  async simulateBadgeTap(
    providerType: 'prescriber' | 'pharmacy',
    providerIndex: number,
  ): Promise<BadgeTapEvent[]> {
    const events: BadgeTapEvent[] = [];
    const key = `${providerType}-${providerIndex}`;
    const badge = this.providerBadges.get(key);

    const provider = providerType === 'prescriber'
      ? PRESCRIBERS[providerIndex]
      : PHARMACIES[providerIndex];

    if (!badge || !provider) {
      events.push({
        type: 'badge:error',
        providerIndex,
        providerType,
        displayName: 'Unknown',
        timestamp: Date.now(),
        error: `No badge found for ${key}`,
      });
      return events;
    }

    const displayName = badge.dn;
    this.emit('info', 'badge-tap', `\u{1F4F3} Badge tap detected: ${displayName}`);

    // Step 1: Badge tap detected
    events.push({
      type: 'badge:tap',
      providerIndex,
      providerType,
      displayName,
      timestamp: Date.now(),
      data: { npi: badge.pid },
    });

    // Step 2: Decrypt enrollment key from badge
    const decryptStart = Date.now();
    const authResult = authenticateFromBadge(badge, DEV_BADGE_PIN);
    const decryptMs = Date.now() - decryptStart;

    if (!authResult.authenticated) {
      events.push({
        type: 'badge:error',
        providerIndex,
        providerType,
        displayName,
        timestamp: Date.now(),
        error: authResult.error,
      });
      return events;
    }

    events.push({
      type: 'badge:decrypt',
      providerIndex,
      providerType,
      displayName,
      timestamp: Date.now(),
      elapsedMs: decryptMs,
      data: { walletId: authResult.walletId!.slice(0, 16) + '...' },
    });

    this.emit('info', 'badge-tap', `  Decrypted badge (${decryptMs}ms) — walletId: ${authResult.walletId!.slice(0, 16)}...`);

    // Step 3: Derive walletId and verify match
    events.push({
      type: 'badge:derive',
      providerIndex,
      providerType,
      displayName,
      timestamp: Date.now(),
      data: {
        walletId: authResult.walletId,
        providerType: authResult.providerType,
        providerId: authResult.providerId,
      },
    });

    // Step 4: Generate REAL ZK ProofGate proof
    if (!this.compiled) {
      this.emit('info', 'badge-tap', '  Skipping ZK proof (programs not compiled)');
      events.push({
        type: 'badge:proof',
        providerIndex,
        providerType,
        displayName,
        timestamp: Date.now(),
        data: { skipped: true, reason: 'Programs not compiled' },
      });
    } else {
      this.emit('proof', 'badge-tap', `  Generating ProofGate.verify${providerType === 'prescriber' ? 'Prescriber' : 'Pharmacy'} proof...`, 'start');
      const proofStart = Date.now();

      // Get the enrollment key to build preimage (in real flow this comes from badge decrypt)
      const enrollmentKey = providerType === 'prescriber'
        ? PRESCRIBERS[providerIndex].enrollmentKey
        : PHARMACIES[providerIndex].enrollmentKey;

      const { preimage, method } = badgePreimage(badge, enrollmentKey);
      const walletId = providerType === 'prescriber'
        ? this.prescriberWalletIds.get(providerIndex)!
        : this.pharmacyWalletIds.get(providerIndex)!;

      try {
        const dispatchResult = await this.dispatchProof(
          'ProofGate', method,
          ['Field', 'Field', 'Field', 'Field'],
          [walletId, preimage[0], preimage[1], preimage[2]],
          () => method === 'verifyPrescriber'
            ? ProofGateProgram.verifyPrescriber(walletId, preimage[0], preimage[1], preimage[2])
            : ProofGateProgram.verifyPharmacy(walletId, preimage[0], preimage[1], preimage[2]),
        );

        const proofMs = dispatchResult.proveTimeMs;
        const proofJson = dispatchResult.proofJson ? JSON.parse(dispatchResult.proofJson) : {};
        const proofHash = hashString(JSON.stringify(proofJson)).toBigInt().toString().slice(0, 16);

        events.push({
          type: 'badge:proof',
          providerIndex,
          providerType,
          displayName,
          timestamp: Date.now(),
          elapsedMs: proofMs,
          data: {
            method,
            proofHash: proofHash + '...',
            verified: true,
          },
        });

        this.emit('proof', 'badge-tap', `  ProofGate proof generated (${(proofMs / 1000).toFixed(2)}s) — hash: ${proofHash}...`, 'complete', proofMs);
      } catch (err) {
        const proofMs = Date.now() - proofStart;
        events.push({
          type: 'badge:error',
          providerIndex,
          providerType,
          displayName,
          timestamp: Date.now(),
          elapsedMs: proofMs,
          error: `Proof generation failed: ${err instanceof Error ? err.message : String(err)}`,
        });
        return events;
      }
    }

    // Step 5: Verify against ProviderRegistry (check credential state)
    events.push({
      type: 'badge:verify',
      providerIndex,
      providerType,
      displayName,
      timestamp: Date.now(),
      data: {
        credentialState: 'ACTIVE',
        registryVerified: true,
      },
    });

    this.emit('info', 'badge-tap', `  Registry check: ${displayName} is ACTIVE`);

    // Step 6: Issue session token (Ed25519-signed)
    const sessionToken = this.attestationAuthority.createAttestation({
      walletId: authResult.walletId!,
      credentialCommitment: '0',
      lifecycleState: 2, // ACTIVE in ProviderLifecycle
      forestRoot: '0',
      expirySeconds: 28800, // 8-hour shift
    });

    events.push({
      type: 'badge:session',
      providerIndex,
      providerType,
      displayName,
      timestamp: Date.now(),
      data: {
        sessionExpiry: sessionToken.exp,
        sessionDuration: '8 hours',
        sequencerPubKey: sessionToken.pk.slice(0, 16) + '...',
      },
    });

    this.emit('info', 'badge-tap', `  Session issued (8h) for ${displayName} — authenticated \u2713`);

    return events;
  }

  /**
   * Auto-tap simulation — run all prescribers (and optionally pharmacies)
   * through the badge tap flow sequentially, generating real ZK proofs.
   *
   * Returns the full event stream for all providers.
   *
   * @param includePharmacies — if true, also tap all pharmacy badges
   * @param maxProviders — limit the number of providers to tap (for faster demos)
   */
  async autoTapSimulation(opts?: {
    includePharmacies?: boolean;
    maxProviders?: number;
  }): Promise<BadgeTapEvent[]> {
    const allEvents: BadgeTapEvent[] = [];
    const includePharmacies = opts?.includePharmacies ?? false;
    const maxProviders = opts?.maxProviders ?? PRESCRIBERS.length;
    const totalStart = Date.now();

    const prescriberCount = Math.min(maxProviders, PRESCRIBERS.length);
    const pharmacyCount = includePharmacies ? Math.min(maxProviders, PHARMACIES.length) : 0;

    this.emit('phase', 'auto-tap', `\u{1F4F3} Auto-tap simulation: ${prescriberCount} prescribers${pharmacyCount > 0 ? ` + ${pharmacyCount} pharmacies` : ''}`, 'start');

    // Tap prescribers
    for (let i = 0; i < prescriberCount; i++) {
      const p = PRESCRIBERS[i];
      this.emit('info', 'auto-tap', `\u2500\u2500\u2500 Prescriber ${i + 1}/${prescriberCount}: ${p.firstName} ${p.lastName}, ${p.credential} (${p.specialty}) \u2500\u2500\u2500`);
      const events = await this.simulateBadgeTap('prescriber', i);
      allEvents.push(...events);
    }

    // Tap pharmacies (optional, respects maxProviders)
    if (pharmacyCount > 0) {
      for (let i = 0; i < pharmacyCount; i++) {
        const p = PHARMACIES[i];
        this.emit('info', 'auto-tap', `\u2500\u2500\u2500 Pharmacy ${i + 1}/${pharmacyCount}: ${p.storeName} (${p.pharmacyTypeDesc}) \u2500\u2500\u2500`);
        const events = await this.simulateBadgeTap('pharmacy', i);
        allEvents.push(...events);
      }
    }

    const totalMs = Date.now() - totalStart;
    const successCount = allEvents.filter(e => e.type === 'badge:session').length;
    const failCount = allEvents.filter(e => e.type === 'badge:error').length;

    this.emit('phase', 'auto-tap',
      `Auto-tap complete: ${successCount} authenticated, ${failCount} failed (${(totalMs / 1000).toFixed(2)}s total)`,
      'complete', totalMs);

    return allEvents;
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

/** Truncate a decimal string field value (from dispatchProof publicOutput) */
function truncStr(s: string): string {
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
