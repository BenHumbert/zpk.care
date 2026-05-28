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

// Messaging & Delegation Infrastructure (L7)

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
} from './message-data.js';
export type { MessageLocalData } from './message-data.js';

export {
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
} from './delegation-data.js';
export type { DelegationLocalData } from './delegation-data.js';

export {
  deriveEncryptionKeyPair,
  deriveSharedSecret,
  encryptMessage,
  decryptMessage,
  computeContentHash,
  publicKeyToFields,
  fieldsToPublicKey,
} from './encryption.js';
export type { EncryptedPayload } from './encryption.js';

export {
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
} from './message-registry.js';

export {
  MessagingOutput,
  MessagingProgram,
  MessagingProof,
} from './messaging-program.js';

export { MessagingService } from './messaging-service.js';

export { MessagingVerificationService } from './messaging-verification-service.js';
export type {
  MessageVerificationResult,
  DelegationVerificationResult,
  RootFreshnessResult,
  FullMessagingCheckResult,
} from './messaging-verification-service.js';

// AOR — Appointment of Representative (CMS-1696)
export {
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
} from './aor-data.js';
export type { AorLocalData, AorValidationResult } from './aor-data.js';

export { AorService } from './aor-service.js';
export type {
  AorInitiationResult,
  AorDelegationResult,
  AorRevocationResult,
  PickupEligibilityResult,
  OfflineValidityResult,
} from './aor-service.js';
