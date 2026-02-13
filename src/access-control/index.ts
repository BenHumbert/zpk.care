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
