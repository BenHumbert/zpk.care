export {
  DOMAIN_TAG_MEMBER,
  DOMAIN_TAG_PRESCRIBER,
  DOMAIN_TAG_PHARMACY,
  DOMAIN_TAG_REPRESENTATIVE,
  MIN_ENROLLMENT_KEY_LENGTH,
  generateEnrollmentKey,
  validateEnrollmentKey,
  deriveMemberWalletId,
  derivePrescriberWalletId,
  derivePharmacyWalletId,
  deriveRepresentativeWalletId,
  memberWalletPreimage,
  prescriberWalletPreimage,
  pharmacyWalletPreimage,
  representativeWalletPreimage,
} from './wallet-derivation.js';
export type { RepresentativeLocalData } from './wallet-derivation.js';

export {
  ProofGateProgram,
  ProofGateProof,
} from './proof-gate.js';

export {
  WALLET_TREE_HEIGHT,
  CREDENTIAL_INVENTORY_HEIGHT,
  WalletRegistryWitness,
  CredentialInventoryWitness,
  WalletState,
  WalletRegistry,
} from './wallet-state.js';
