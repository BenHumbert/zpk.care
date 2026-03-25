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
