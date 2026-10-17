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
export * from './network-policy.js';
