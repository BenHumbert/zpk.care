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

// Access Control — Medication Access (L6)

export {
  TIER_GENERIC,
  TIER_PREFERRED,
  TIER_NON_PREFERRED,
  TIER_SPECIALTY,
  FormularyEntry,
  buildFormularyEntry,
} from './formulary-entry.js';
export type { FormularyEntryLocalData } from './formulary-entry.js';

export {
  PriorAuthData,
  buildPriorAuthData,
} from './prior-auth-data.js';
export type { PriorAuthLocalData } from './prior-auth-data.js';

export {
  FORMULARY_TREE_HEIGHT,
  FormularyMerkleWitness,
  FormularyRegistry,
} from './formulary-registry.js';

export {
  AccessControlOutput,
  AccessControlProgram,
  AccessControlProof,
} from './access-control-program.js';

export { AccessControlService } from './access-control-service.js';

export { AccessVerificationService } from './access-verification-service.js';
export type {
  AccessVerificationResult,
  FullAccessCheckResult,
} from './access-verification-service.js';

export {
  ACCUMULATOR_LEAF_INDEX,
  AccumulatorData,
  buildAccumulatorData,
} from './accumulator-data.js';
export type { AccumulatorLocalData } from './accumulator-data.js';

export { AccumulatorQueryService } from './accumulator-query-service.js';
export type { AccumulatorStatus } from './accumulator-query-service.js';

export { BenefitCheckService } from './benefit-check-service.js';
export type {
  FormularyCheckResult,
  CostPhase,
  BenefitCheckResult,
} from './benefit-check-service.js';
