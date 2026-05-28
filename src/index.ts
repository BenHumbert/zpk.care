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

// ZKP Care — Zero Knowledge Proof Claim Adjudication on MINA Protocol

// Data Models (NCPDP-derived)
export {
  MemberData,
  PrescriberData,
  PharmacyData,
  MedicationData,
  MedicationPricingData,
  TransactionHeaderData,
} from './models/index.js';

export type {
  MemberLocalData,
  PrescriberLocalData,
  PharmacyLocalData,
  MedicationLocalData,
  MedicationPricingLocalData,
  TransactionHeaderLocalData,
} from './models/index.js';

// ZK Primitives
export {
  hashString,
  hashStrings,
  dateToField,
  centsToField,
  codeToField,
  quantityToField,
  TREE_HEIGHT,
  ForestMerkleWitness,
  ForestDomain,
  MerkleForest,
  buildMemberData,
  buildPrescriberData,
  buildPharmacyData,
  buildMedicationData,
  buildMedicationPricingData,
  buildTransactionHeaderData,
  generateMemberIdentifier,
} from './zkp/index.js';

// Storage (cryptographic state only — NO raw PHI/PII)
export type { ILocalStore, WalletRecord, LocalMerkleState } from './storage/index.js';
export { InMemoryStore } from './storage/index.js';

// Security (secure scrubbing + transient PHI/PII handling)
export {
  scrubObject,
  scrubArray,
  scrubFieldArray,
  isScrubbed,
  secureMemberDerivation,
  securePrescriberDerivation,
  securePharmacyDerivation,
  secureRepresentativeDerivation,
} from './security/index.js';
export type { SecureWalletResult } from './security/index.js';

// Engine — zkApp Core / State Machine (L3)
export {
  LifecycleWitness,
  LIFECYCLE_EMPTY,
  LIFECYCLE_REGISTERED,
  LIFECYCLE_ELIGIBLE,
  LIFECYCLE_ACTIVE,
  LIFECYCLE_REVOKED,
  lifecycleLeafCommitment,
  assertValidTransition,
  isValidTransition,
  EMPTY_CREDENTIAL_ROOT,
  TransitionOutput,
  StateTransitionProgram,
  StateTransitionProof,
  CareContract,
  CredentialRegistryWitness,
} from './engine/index.js';

// Credential System — User Path (L4)
export {
  CREDENTIAL_TYPE_ELIGIBILITY,
  CREDENTIAL_TYPE_PRESCRIPTION,
  CredentialData,
  CredentialInventory,
  CREDENTIAL_OP_MINT,
  CREDENTIAL_OP_VERIFY,
  CredentialOperationOutput,
  CredentialProgram,
  CredentialOperationProof,
  serializeCredential,
  deserializeCredential,
  verifyCredentialOffline,
  serializeDelegationCredential,
  deserializeDelegationCredential,
  UserWalletService,
} from './credentials/index.js';
export type {
  CredentialLocalMetadata,
  PortableCredential,
  PortableDelegationCredential,
  EntityType,
  MintResult,
} from './credentials/index.js';

// Eligibility Flow — Use Cases A + C (L5)
export {
  COVERAGE_PHARMACY,
  COVERAGE_MEDICAL,
  COVERAGE_DENTAL,
  EligibilityData,
  buildEligibilityData,
  ForestRoots,
  BENEFIT_PLAN_TREE_HEIGHT,
  BenefitPlanWitness,
  BenefitPlanRegistry,
  EligibilityOutput,
  EligibilityProgram,
  EligibilityProof,
  InNetworkOutput,
  InNetworkProgram,
  InNetworkProof,
  EligibilityService,
  VerificationService,
} from './eligibility/index.js';
export type {
  EligibilityLocalData,
  EligibilityEntityType,
  EligibilityMintResult,
  VerificationResult,
  FullVerificationResult,
} from './eligibility/index.js';

// Access Control — Medication Access (L6)
export {
  TIER_GENERIC,
  TIER_PREFERRED,
  TIER_NON_PREFERRED,
  TIER_SPECIALTY,
  FormularyEntry,
  buildFormularyEntry,
  PriorAuthData,
  buildPriorAuthData,
  FORMULARY_TREE_HEIGHT,
  FormularyMerkleWitness,
  FormularyRegistry,
  AccessControlOutput,
  AccessControlProgram,
  AccessControlProof,
  AccessControlService,
  AccessVerificationService,
  ACCUMULATOR_LEAF_INDEX,
  AccumulatorData,
  buildAccumulatorData,
  AccumulatorQueryService,
  BenefitCheckService,
} from './access-control/index.js';
export type {
  FormularyEntryLocalData,
  PriorAuthLocalData,
  AccessVerificationResult,
  FullAccessCheckResult,
  AccumulatorLocalData,
  AccumulatorStatus,
  FormularyCheckResult,
  CostPhase,
  BenefitCheckResult,
} from './access-control/index.js';

// Messaging & Delegation — Communication Infrastructure (L7)
export {
  MSG_TYPE_PRESCRIPTION,
  MSG_TYPE_PA_REQUEST,
  MSG_TYPE_PA_RESPONSE,
  MSG_TYPE_NOTIFICATION,
  MSG_TYPE_GENERAL,
  MSG_TYPE_SUPPORT,
  MSG_TYPE_SUPPORT_SUMMARY,
  MessageData,
  buildMessageData,
  SCOPE_READ,
  SCOPE_WRITE,
  SCOPE_PICKUP,
  SCOPE_ALL,
  REL_PARENT,
  REL_SPOUSE,
  REL_POA,
  REL_GUARDIAN,
  REL_MIGRATION,
  REL_APPOINTED_REPRESENTATIVE,
  DelegationData,
  buildDelegationData,
  deriveEncryptionKeyPair,
  deriveSharedSecret,
  encryptMessage,
  decryptMessage,
  computeContentHash,
  publicKeyToFields,
  fieldsToPublicKey,
  MESSAGE_TREE_HEIGHT,
  MessageRegistryWitness,
  MessageRegistry,
  DELEGATION_TREE_HEIGHT,
  DelegationRegistryWitness,
  DelegationRegistry,
  KEY_TREE_HEIGHT,
  KeyRegistryWitness,
  KeyRegistry,
  computeMessagingRoot,
  MessagingOutput,
  MessagingProgram,
  MessagingProof,
  MessagingService,
  MessagingVerificationService,
  MSG_TYPE_AOR_INITIATE,
  MSG_TYPE_AOR_COMPLETE,
  MSG_TYPE_AOR_CONFIRM,
  MSG_TYPE_AOR_CONFIRMED,
  MSG_TYPE_AOR_APPROVED,
  MSG_TYPE_AOR_DENIED,
  MSG_TYPE_AOR_REVOKE,
  MSG_TYPE_AOR_DATA_SHARE,
  PICKUP_COOLDOWN_MS,
  AOR_DEFAULT_VALIDITY_DAYS,
  AOR_RATE_LIMIT_MS,
  REP_TOKEN_EXPIRY_MS,
  OFFLINE_TTL_MS,
  validateAorDocument,
  buildAorCommitment,
  buildAorConfirmationHash,
  AorService,
} from './messaging/index.js';
export type {
  MessageLocalData,
  DelegationLocalData,
  EncryptedPayload,
  MessageVerificationResult,
  DelegationVerificationResult,
  RootFreshnessResult,
  FullMessagingCheckResult,
  AorLocalData,
  AorValidationResult,
  AorInitiationResult,
  AorDelegationResult,
  AorRevocationResult,
  PickupEligibilityResult,
  OfflineValidityResult,
} from './messaging/index.js';

// Prescription Flow — Use Case D (L8)
export {
  RX_STATUS_ACTIVE,
  RX_STATUS_ADJUDICATED,
  RX_STATUS_PARTIALLY_FILLED,
  RX_STATUS_FILLED,
  RX_STATUS_CANCELLED,
  RX_STATUS_REJECTED,
  RX_STATUS_REVERSED,
  RX_STATUS_TRANSFERRED,
  RX_STATUS_DISPENSED,
  EMERGENCY_FILL_HASH,
  PrescriptionData,
  buildPrescriptionData,
  PrescriptionStatusData,
  buildPrescriptionStatusData,
  isValidStatusTransition,
  assertValidStatusTransition,
  PrescriptionOutput,
  PrescriptionProgram,
  PrescriptionProof,
  PrescriptionService,
  PrescriptionVerificationService,
} from './prescription/index.js';
export type {
  PrescriptionLocalData,
  PrescriptionStatusLocalData,
  PrescriptionResult,
  StatusUpdateResult,
  TransferResult,
  PrescriptionHoldingResult,
  PrescriptionDataResult,
  StatusHistoryEntry,
  FullPrescriptionCheckResult,
} from './prescription/index.js';

// Fulfillment Flow — Use Cases E + F (L9)
export {
  FulfillmentData,
  buildFulfillmentData,
  ReversalData,
  buildReversalData,
  FulfillmentOutput,
  FULFILL_OP_CLAIM,
  FULFILL_OP_REVERSAL,
  FulfillmentProgram,
  FulfillmentProof,
  FulfillmentService,
  FulfillmentVerificationService,
  AccumulatorFulfillmentOutput,
  AccumulatorFulfillmentProgram,
  AccumulatorFulfillmentProof,
  AccumulatorFulfillmentService,
} from './fulfillment/index.js';
export type {
  FulfillmentLocalData,
  ReversalLocalData,
  FulfillmentResult,
  ReversalResult,
  FulfillmentVerificationResult,
  ReversalVerificationResult,
  ClaimHistoryEntry,
  FullFulfillmentCheckResult,
  AccumulatorFulfillmentResult,
  AccumulatorReversalResult,
} from './fulfillment/index.js';

// Reporting — On-Chain Reporting (L10)
export { ReportingService } from './reporting/index.js';
export type {
  DateRange,
  CostBreakdown,
  VerifiedClaim,
  ClaimContext,
  PriorAuthContext,
  ClaimsRegisterReport,
  PharmacyActivityEntry,
  PharmacyActivityReport,
  PrescriberActivityEntry,
  PrescriberActivityReport,
  MemberActivityEntry,
  MemberActivityReport,
  MedicationUtilizationEntry,
  MedicationUtilizationReport,
  FinancialSummaryReport,
  PriorAuthUtilizationEntry,
  PriorAuthReport,
  ReversalReport,
} from './reporting/index.js';

// Onboarding — Three-Party Enrollment Ceremony
export {
  TOKEN_STATUS_UNUSED,
  TOKEN_STATUS_CONSUMED,
  TOKEN_STATUS_EXPIRED,
  TOKEN_STATUS_REVOKED,
  GroupEnrollmentToken,
  buildGroupEnrollmentToken,
  PlanTemplate,
  GROUP_TREE_HEIGHT,
  GroupRegistryWitness,
  GROUP_STATUS_ACTIVE,
  GROUP_STATUS_TERMINATED,
  GroupConfig,
  buildGroupConfig,
  GroupRegistry,
  ROSTER_TREE_HEIGHT,
  RosterMerkleWitness,
  ENROLLMENT_STATUS_ACTIVE,
  ENROLLMENT_STATUS_TERMINATED,
  RosterEntry,
  buildRosterEntry,
  OpaqueRoster,
  RepEnrollmentToken,
  buildRepEnrollmentToken,
  TokenAuthority,
  EnrollmentService,
} from './onboarding/index.js';
export type {
  GroupEnrollmentTokenLocalData,
  RepEnrollmentTokenLocalData,
  PlanTemplateConfig,
  GroupConfigLocalData,
  RosterEntryLocalData,
  TokenRecord,
  TokenValidationResult,
  EnrollmentResult,
  TerminationResult,
  GroupTerminationResult,
} from './onboarding/index.js';

// L2 — Batch Settlement (zkpCare Chain)
export {
  BatchOutput,
  BatchProgram,
  BatchProof,
  L2SequencerService,
  DEFAULT_BATCH_INTERVAL_MS,
  MAX_TRANSITIONS_PER_BATCH,
  GLOBAL_STATE_FIELD_COUNT,
  computeGlobalStateRoot,
  GlobalState,
  ChainOutput,
  ChainProgram,
  ChainProof,
} from './l2/index.js';
export type {
  L1Status,
  L2Receipt,
  L2Block,
  L2Batch,
  L2EntityType,
  L2NodeConfig,
  AdminOperationType,
  AdminOpStatus,
  AdminStateDelta,
  AdminStateConfig,
} from './l2/index.js';

// Audit — Data Availability & Audit Trail
export { AuditService, DEFAULT_ORPHAN_THRESHOLD_MS, AuditMerkleIndex, AuditEventWitness, AUDIT_TREE_HEIGHT } from './audit/index.js';
export type {
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
  AuditMerkleState,
  SelectiveWitnessResult,
} from './audit/index.js';

// ── Production Data (NPPES + NADAC) ─────────────────────────
export {
  PRESCRIBERS, PRESCRIBER_BY_NPI,
  PHARMACIES, PHARMACY_BY_NPI, PHARMACY_BY_NCPDP,
  MEDICATIONS, TIER1_GENERICS, TIER2_PREFERRED, TIER3_NON_PREFERRED, TIER4_SPECIALTY,
  MEDICATION_BY_NDC, MEDICATION_BY_GPI,
  getAllFormularyEntries, getFormularyEntriesByTier,
  buildMedicationLocalData, buildMedicationPricingLocalData,
  MEMBERS, MEMBER_BY_CARDHOLDER_ID,
  getMembersByEmployee, getSubscribers, getAcmeMembers, getGlobexMembers,
} from './data/index.js';
export type {
  SeedPrescriber,
  SeedPharmacy,
  SeedMedication,
  SeedMember,
} from './data/index.js';
