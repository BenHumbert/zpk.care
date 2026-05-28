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

export {
  WalletMigrationProgram,
  WalletMigrationProof,
  MigrationOutput,
} from './wallet-migration-program.js';

export {
  WalletMigrationService,
} from './wallet-migration-service.js';

export type {
  RecoveryResult,
  NewWalletResult,
  MigrationRequest,
} from './wallet-migration-service.js';
