export {
  scrubObject,
  scrubArray,
  scrubFieldArray,
  isScrubbed,
} from './secure-scrub.js';

export {
  secureMemberDerivation,
  securePrescriberDerivation,
  securePharmacyDerivation,
  secureRepresentativeDerivation,
} from './secure-context.js';

export type { SecureWalletResult } from './secure-context.js';

export {
  MIN_PIN_LENGTH,
  exportEnrollmentBackup,
  importEnrollmentBackup,
} from './enrollment-backup.js';

export type { EnrollmentBackup } from './enrollment-backup.js';

export { ObfuscatedKey } from './obfuscated-key.js';

export {
  NFC_CAPACITY_BYTES,
  exportRecoveryCard,
  importRecoveryCard,
  isRecoveryCard,
  estimateRecoveryCardSize,
} from './recovery-card.js';

export type { RecoveryCard } from './recovery-card.js';
