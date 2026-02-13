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

// Enrollment Service (insurer-side ceremony orchestration)
export { EnrollmentService } from './enrollment-service.js';
export type {
  EnrollmentResult,
  TerminationResult,
  GroupTerminationResult,
} from './enrollment-service.js';
