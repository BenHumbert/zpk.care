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
 * L2 Types — Type interfaces for the zkpCare L2 chain.
 *
 * Pure type definitions — no runtime code.
 * These types define the data structures for L2 receipts, blocks,
 * batches, node configuration, and admin state deltas.
 */

import type { QuorumCertificate, StateCertificate } from './l2-quorum-types.js';

// ─── L2 Receipt ─────────────────────────────────────────────

/** Status of an L2 receipt relative to L1 settlement */
export type L1Status = 'pending' | 'batched' | 'settled' | 'failed';

/**
 * L2Receipt — instant confirmation issued by the sequencer.
 *
 * When a node submits a StateTransitionProof, the sequencer verifies it
 * (~5ms) and issues an L2Receipt as instant confirmation. The receipt
 * tracks L1 settlement status as it progresses through batching.
 */
export interface L2Receipt {
  /** Unique receipt identifier */
  receiptId: string;
  /** Wallet involved in this transition */
  walletId: string;
  /** Monotonic sequence number within the L2 chain */
  sequenceNumber: bigint;
  /** Registry root before this transition */
  oldRegistryRoot: string;
  /** Registry root after this transition */
  newRegistryRoot: string;
  /** Lifecycle root before this transition */
  oldLifecycleRoot: string;
  /** Lifecycle root after this transition */
  newLifecycleRoot: string;
  /** Whether this transition was a new wallet registration */
  isRegistration: boolean;
  /** L2 block this receipt belongs to (set after batching) */
  l2BlockNumber?: bigint;
  /** Timestamp when the sequencer accepted the proof */
  acceptedAt: number;
  /** Current L1 settlement status */
  l1Status: L1Status;
  /** L1 batch number (set after batching) */
  l1BatchNumber?: bigint;
  /** Links receipt to AuditEvent chain hash (set by DA emission) */
  auditEventHash?: string;
  /** Leaf index in the Claim Accumulator Tree (set when claim metadata is provided) */
  claimLeafIndex?: bigint;
  /** Quorum certificate proving N/2+1 leviathans durably wrote this proof */
  quorumCertificate?: QuorumCertificate;
}

// ─── L2 Block ───────────────────────────────────────────────

/**
 * L2Block — logical grouping of receipts within a batch window.
 *
 * Created when buildBatch() is called. One block per batch interval.
 */
export interface L2Block {
  /** Block number (monotonic) */
  blockNumber: bigint;
  /** Receipt IDs included in this block */
  receiptIds: string[];
  /** Registry root at start of block */
  startRegistryRoot: string;
  /** Registry root at end of block */
  endRegistryRoot: string;
  /** Lifecycle root at start of block */
  startLifecycleRoot: string;
  /** Lifecycle root at end of block */
  endLifecycleRoot: string;
  /** Number of new wallet registrations in this block */
  registrationCount: number;
  /** Total transitions in this block */
  transitionCount: number;
  /** Timestamp when block was created */
  createdAt: number;
  /** Current L1 settlement status */
  l1Status: L1Status;
  /** L1 transaction hash (set after settlement) */
  l1TxHash?: string;
}

// ─── L2 Batch ───────────────────────────────────────────────

/**
 * L2Batch — settlement metadata for an L1 transaction.
 *
 * Contains the BatchProof JSON needed for CareContract.settleBatch().
 * One batch = one L1 transaction = one 3-minute MINA block.
 */
export interface L2Batch {
  /** Batch number (monotonic) */
  batchNumber: bigint;
  /** Block numbers included in this batch */
  blockNumbers: bigint[];
  /** Total new wallet registrations across all blocks */
  registrationCount: number;
  /** Total transitions across all blocks */
  transitionCount: number;
  /** Registry root at start of batch */
  oldRegistryRoot: string;
  /** Registry root at end of batch */
  newRegistryRoot: string;
  /** Lifecycle root at start of batch */
  oldLifecycleRoot: string;
  /** Lifecycle root at end of batch */
  newLifecycleRoot: string;
  /** Serialized BatchProof JSON for L1 submission */
  batchProofJson: string;
  /** Serialized ChainProof JSON (set when ChainProgram is enabled) */
  chainProofJson?: string;
  /** Global state root after this batch (Poseidon hash of 10 fields) */
  globalStateRoot?: string;
  /** L2 block height after this batch */
  blockHeight?: bigint;
  /** Timestamp when batch was created */
  createdAt: number;
  /** Current L1 settlement status */
  l1Status: L1Status;
  /** L1 transaction hash (set after settlement) */
  l1TxHash?: string;
  /** Reason for failure (set by markBatchFailed) */
  failureReason?: string;
  /** Claim Accumulator Tree root at the time this batch was created */
  claimAccumulatorRoot?: string;
  /** Message Store root at the time this batch was created */
  messageStoreRoot?: string;
  /** Provider Registry root at the time this batch was created */
  providerRegistryRoot?: string;
  /** State certificate proving N/2+1 leviathans agreed on state at this batch */
  stateCertificate?: StateCertificate;
  /** Worker ID that proved this batch (set when ProvingPool is used) */
  workerId?: number;
  /** Wall-clock proving time in ms (set when ProvingPool is used) */
  proveTimeMs?: number;
}

// ─── L2 Node Config ─────────────────────────────────────────

/** Entity type for node classification */
export type L2EntityType = 'member' | 'prescriber' | 'pharmacy' | 'sequencer' | 'validator';

/**
 * L2NodeConfig — configuration for an L2 node.
 *
 * Distributed with node software. Each node type has different
 * capabilities (pharmacies generate proofs, sequencer batches).
 */
export interface L2NodeConfig {
  /** Wallet ID of the node operator */
  walletId: string;
  /** Entity type determines capabilities */
  entityType: L2EntityType;
  /** URL of the L2 sequencer to submit proofs to */
  sequencerUrl: string;
  /** Batch interval in milliseconds (default 180,000 = 3 min) */
  batchIntervalMs: number;
  /** MINA L1 RPC URL for settlement and fallback */
  l1RpcUrl: string;
  /** Whether to fall back to L1 if L2 sequencer is unreachable */
  l1FallbackMode: boolean;
  /** Maximum retries before falling back to L1 */
  maxL2Retries: number;
  /**
   * L2-only mode: no MINA L1 settlement.
   *
   * When true, batches are finalized immediately at L2 (no L1 tx needed).
   * All audit chain, batch building, and proof verification still applies.
   * syncFromL1() is rejected. Settlement strategies are skipped.
   */
  l2Only?: boolean;
}

// ─── Admin State Delta ──────────────────────────────────────

/** Type of admin operation */
export type AdminOperationType =
  | 'updateBenefitPlan'
  | 'registerGlobalCredential'
  | 'initEligibilityState'
  | 'initMessaging'
  | 'submitMessage'
  | 'registerDelegation'
  | 'registerEncryptionKey'
  | 'updateFormulary'
  | 'updateNetwork';

/** Status of a queued admin operation */
export type AdminOpStatus = 'queued' | 'submitted' | 'confirmed' | 'failed';

/**
 * AdminStateDelta — queued admin operation.
 *
 * Admin operations (slots 4-7) are NOT batched — they require
 * admin signatures and go directly to L1. The sequencer queues
 * them and submits individually between batches.
 */
export interface AdminStateDelta {
  /** Type of admin operation */
  operationType: AdminOperationType;
  /** Operation-specific parameters (serialized) */
  params: Record<string, string>;
  /** Timestamp when operation was queued */
  queuedAt: number;
  /** Current status */
  status: AdminOpStatus;
}

// ─── Claim Submission Metadata ────────────────────────────────

/**
 * ClaimSubmissionMetadata — optional drug/claim context submitted alongside a proof.
 *
 * When a pharmacy submits a StateTransitionProof for a fulfillment or reversal,
 * it can include this metadata. The sequencer uses it to:
 *   1. Set ndcHash on the AuditEvent (committed in Poseidon hash chain)
 *   2. Append a ClaimLeaf to the Claim Accumulator Tree
 *   3. Attach display metadata (brand name, tier, etc.) for query results
 */
export interface ClaimSubmissionMetadata {
  /** Poseidon hash of NDC code (from FulfillmentProof.ndcHash) */
  ndcHash: string;
  /** Member wallet ID involved in the claim */
  memberWalletId: string;
  /** Pharmacy wallet ID that dispensed */
  pharmacyWalletId: string;
  /** Prescriber wallet ID that prescribed */
  prescriberWalletId: string;
  /** Date of service as CCYYMMDD numeric string */
  dateOfService: string;
  /** Patient pay in cents (from proof output) */
  patientPayCents: string;
  /** Plan pay in cents (from proof output) */
  planPayCents: string;
  /** Operation type: '1' = fulfillment, '2' = reversal */
  operationType: string;
  /** Plaintext 11-digit NDC code (optional, for display) */
  ndc?: string;
  /** Drug brand or generic name (optional, for display) */
  brandName?: string;
  /** Formulary tier level (optional, for display) */
  tierLevel?: number;
  /** 14-digit GPI code (optional, for display) */
  gpi?: string;
  /** Therapeutic classification (optional, for display) */
  therapeuticClass?: string;
  /** Days supply (optional, for display) */
  daysSupply?: number;
  /** Fill number: 0=original, 1+=refill (optional, for display) */
  fillNumber?: number;
  /** Deductible credit in cents (from AccumulatorFulfillmentProof output) */
  deductibleCreditCents?: string;
  /** DEA schedule (0=non-controlled, 2-5=schedule II-V) */
  deaSchedule?: number;
  /** Benefit plan ID hash (for plan-filtered accumulator reconstruction) */
  planIdHash?: string;
}

// ─── L2 Chain State Query ────────────────────────────────────

/**
 * L2ChainState — compact chain state snapshot for proof building.
 *
 * Contains all roots and metadata a client node needs to construct
 * new StateTransitionProofs. Returned by `l2_getChainState`.
 */
export interface L2ChainState {
  /** Current wallet registry Merkle root */
  registryRoot: string;
  /** Current lifecycle tree Merkle root */
  lifecycleRoot: string;
  /** Total registered wallets */
  walletCount: string;
  /** Poseidon hash of all 10 GlobalState fields (zero if chain proof not enabled) */
  globalStateRoot: string;
  /** L2 block height from ChainProgram (zero if not enabled) */
  blockHeight: string;
  /** Whether ChainProgram integration is active */
  chainProofEnabled: boolean;
  /** Current Poseidon hash chain anchor (audit/DA) */
  auditChainHash: string;
  /** Number of proofs queued for next batch */
  pendingProofs: number;
  /** Most recent batch number (null if no batches yet) */
  latestBatchNumber: string | null;
  /** Most recent batch L1 status (null if no batches yet) */
  latestBatchStatus: L1Status | null;
}

/**
 * L2ChainProofResponse — chain proof data for offline verification.
 *
 * Contains the latest ChainProof JSON (22kb), which certifies the
 * entire chain state. Can be verified offline via NFC/RFID.
 */
export interface L2ChainProofResponse {
  /** Whether ChainProgram is enabled */
  enabled: boolean;
  /** Serialized ChainProof JSON, or null if not yet produced */
  proofJson: string | null;
  /** GlobalState root certified by this proof */
  globalStateRoot: string;
  /** L2 block height certified by this proof */
  blockHeight: string;
}

// ─── Benefit Plan Config ────────────────────────────────────

/**
 * BenefitPlanConfig — stored on the sequencer's plan store.
 * Contains all plan parameters + formulary NDC list + network provider list.
 */
export interface BenefitPlanConfig {
  planId: string;
  name: string;
  coverageType: number;            // 1=pharmacy, 2=medical, 3=dental
  copayAmountCents: number;
  deductibleAmountCents: number;
  oopMaxCents: number;
  annualBenefitMaxCents: number;
  familyDeductibleAmountCents: number;
  familyOopMaxCents: number;
  familyAnnualBenefitMaxCents: number;
  /** NDCs included in this plan's formulary (subset of full NADAC list) */
  formularyNdcs: string[];
  /** Provider wallet IDs in-network for this plan (empty = all accepted) */
  networkProviderWalletIds: string[];
  /** Computed formulary root (after publish) */
  formularyRoot?: string;
  /** Computed network root (after publish) */
  networkRoot?: string;
  /** Whether plan has been published to sequencer */
  published: boolean;
  createdAt: number;
  updatedAt: number;
}

// ─── Employer Attestation ─────────────────────────────────

/** Employer application status lifecycle */
export type EmployerApplicationStatus =
  | 'submitted'         // Employer submitted application
  | 'under_review'      // Insurer is reviewing
  | 'needs_documents'   // CP 575 / verification documents required
  | 'approved'          // Insurer approved, awaiting agreement signing
  | 'signed'            // Both parties signed, attestation registered
  | 'active'            // Employer node is live
  | 'denied'            // Insurer denied
  | 'suspended';        // Insurer suspended active employer

/** EmployerApplication — submitted by employer via marketplace */
export interface EmployerApplication {
  applicationId: string;
  employerId: string;
  companyName: string;
  contactName: string;
  contactEmail: string;
  contactPhone?: string;
  ein?: string;
  state: string;
  industry?: string;
  selectedPlanIds: string[];
  effectiveDate: string;
  enrollmentCap: number;
  publicKeyHex: string;
  submittedAt: number;
  status: EmployerApplicationStatus;
  /**
   * SHA-256 of the one-time activation secret issued when the application was submitted.
   *
   * Phase A item A8, finding A-4. `applicationId` was being used as the bearer secret for
   * collecting the employer's node admin token — a decision the code documented in a comment —
   * but that value is written to a plaintext store, printed to the console, and carried in URL
   * paths, so it is an identifier and cannot also be a secret. The secret is now separate: it is
   * returned once at submission, only this hash is kept, and it never appears in a log or a URL.
   *
   * Absent on applications created before A8; those cannot collect credentials and must rekey.
   */
  claimSecretHash?: string;
  /** When the admin token was collected. Set once; a second attempt is refused. */
  credentialsCollectedAt?: number;
  reviewedAt?: number;
  approvedAt?: number;
  denialReason?: string;
  /** CP 575 document UUID (stored as PDF in stateDir/employer-documents/) */
  cp575DocumentId?: string;
  /** Number of document resubmission attempts (max 3) */
  resubmissionCount?: number;
  /** ERISA plan type */
  planType?: 'erisa' | 'government' | 'church' | 'other';
  /** Timestamp when signer reviewed the agreement (scrolled to bottom) */
  reviewedAgreementAt?: number;
}

/** AgreementTerms — structured data from which the DOCX agreement is generated */
export interface AgreementTerms {
  agreementId: string;
  applicationId: string;
  employerId: string;
  companyName: string;
  selectedPlans: Array<{
    planId: string;
    planName: string;
    copayAmountCents: number;
    deductibleAmountCents: number;
    oopMaxCents: number;
    annualBenefitMaxCents: number;
  }>;
  effectiveDate: string;
  enrollmentCap: number;
  insurerName: string;
  termsVersion: string;
  generatedAt: number;
}

/** EmployerAttestation — registered on sequencer, proves the agreement.
 *
 * Phase D: bumped from v1 to v2 to introduce a monotonic `attestationSeq`.
 * The first attestation for any employerId MUST have seq=0. Each subsequent
 * registration (renewal, plan change, key rotation) MUST have seq exactly one
 * greater than the existing attestation's seq. Both Ed25519 signatures are
 * computed over a canonical message that INCLUDES the seq, so an attacker
 * cannot bump seq without forging both signatures.
 */
export interface EmployerAttestation {
  v: 2;
  employerId: string;
  publicKeyHex: string;
  authorizedPlanIds: string[];
  enrollmentCap: number;
  agreementCommitment: string;
  documentHash: string;
  effectiveDate: string;
  employerSignature: string;
  insurerSignature: string;
  insurerPublicKeyHex: string;
  ts: number;
  applicationId: string;
  /** Monotonic sequence (Phase D). 0 for first registration; +1 per renewal. */
  attestationSeq: number;
  /** Signer's full legal name (included in Ed25519 signed payload) */
  signerName: string;
  /** Signer's corporate title (included in Ed25519 signed payload) */
  signerTitle: string;
  /** Ed25519-signed verification certificate (opaque — no PII) */
  verificationCert?: string;
  /** Re-verification deadline (Unix seconds) */
  verificationExpiry?: number;
}
