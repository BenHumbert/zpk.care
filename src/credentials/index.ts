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

// Credential System — User Path (L4)

export {
  CREDENTIAL_TYPE_ELIGIBILITY,
  CREDENTIAL_TYPE_PRESCRIPTION,
  CredentialData,
} from './credential-data.js';
export type { CredentialLocalMetadata } from './credential-data.js';

export { CredentialInventory } from './credential-inventory.js';

export {
  CREDENTIAL_OP_MINT,
  CREDENTIAL_OP_VERIFY,
  CredentialOperationOutput,
  CredentialProgram,
  CredentialOperationProof,
} from './credential-program.js';

export {
  serializeCredential,
  deserializeCredential,
  verifyCredentialOffline,
  serializeDelegationCredential,
  deserializeDelegationCredential,
} from './portable-credential.js';
export type {
  PortableCredential,
  PortableDelegationCredential,
} from './portable-credential.js';

export { UserWalletService } from './user-wallet-service.js';
export type { EntityType, MintResult } from './user-wallet-service.js';

// NFC Attestation
export {
  SequencerAttestationAuthority,
  buildAttestationMessage,
  isAttestation,
} from './nfc-attestation.js';
export type {
  NfcCredentialAttestation,
  AttestationVerifyResult,
} from './nfc-attestation.js';

// Provider Badge — NFC tap-to-login
export {
  createProviderBadge,
  decryptBadge,
  authenticateFromBadge,
  badgePreimage,
  estimateBadgeSize,
  DEV_BADGE_PIN,
  validateBadgePin,
} from './provider-badge-service.js';
export type {
  ProviderBadge,
  BadgeAuthResult,
  BadgeTapEvent,
  ProviderBadgeNdefPayload,
} from './provider-badge-types.js';
export { isProviderBadge } from './provider-badge-types.js';
