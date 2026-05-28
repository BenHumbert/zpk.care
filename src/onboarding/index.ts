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

// Onboarding — Three-Party Enrollment Ceremony

// Group Enrollment Token (employer → member → insurer)
export {
  TOKEN_STATUS_UNUSED,
  TOKEN_STATUS_CONSUMED,
  TOKEN_STATUS_EXPIRED,
  TOKEN_STATUS_REVOKED,
  GroupEnrollmentToken,
  buildGroupEnrollmentToken,
} from './group-enrollment-token.js';
export type { GroupEnrollmentTokenLocalData } from './group-enrollment-token.js';

// Plan Template (reusable benefit plan factory)
export { PlanTemplate } from './plan-template.js';
export type { PlanTemplateConfig } from './plan-template.js';

// Group Registry (employer group management)
export {
  GROUP_TREE_HEIGHT,
  GroupRegistryWitness,
  GROUP_STATUS_ACTIVE,
  GROUP_STATUS_TERMINATED,
  GroupConfig,
  buildGroupConfig,
  GroupRegistry,
} from './group-registry.js';
export type { GroupConfigLocalData } from './group-registry.js';

// Opaque Roster (walletId → plan/group mapping, zero PHI)
export {
  ROSTER_TREE_HEIGHT,
  RosterMerkleWitness,
  ENROLLMENT_STATUS_ACTIVE,
  ENROLLMENT_STATUS_TERMINATED,
  RosterEntry,
  buildRosterEntry,
  OpaqueRoster,
} from './opaque-roster.js';
export type { RosterEntryLocalData } from './opaque-roster.js';

// Token Authority (employer-side token management)
export { TokenAuthority } from './token-authority.js';
export type { TokenRecord, TokenValidationResult } from './token-authority.js';

// Representative Enrollment Token (insurer → representative)
export {
  RepEnrollmentToken,
  buildRepEnrollmentToken,
} from './rep-enrollment-token.js';
export type { RepEnrollmentTokenLocalData } from './rep-enrollment-token.js';

// Family Accumulator Service (family-level pooling)
export { FamilyAccumulatorService } from './family-accumulator-service.js';
export type {
  FamilyLimits,
  FamilyTotals,
  FamilyAdjustedPay,
  MemberAccumulator,
} from './family-accumulator-service.js';

// Enrollment Service (insurer-side ceremony orchestration)
export { EnrollmentService } from './enrollment-service.js';
export type {
  EnrollmentResult,
  TerminationResult,
  GroupTerminationResult,
} from './enrollment-service.js';
