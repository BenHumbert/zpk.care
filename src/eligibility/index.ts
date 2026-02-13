// Eligibility Flow — Use Cases A + C (L5)

export {
  COVERAGE_PHARMACY,
  COVERAGE_MEDICAL,
  COVERAGE_DENTAL,
  EligibilityData,
  buildEligibilityData,
} from './eligibility-data.js';
export type { EligibilityLocalData } from './eligibility-data.js';

export { ForestRoots } from './forest-roots.js';

export {
  BENEFIT_PLAN_TREE_HEIGHT,
  BenefitPlanWitness,
  BenefitPlanRegistry,
} from './benefit-plan-registry.js';

export {
  EligibilityOutput,
  EligibilityProgram,
  EligibilityProof,
  InNetworkOutput,
  InNetworkProgram,
  InNetworkProof,
} from './eligibility-program.js';

export { EligibilityService } from './eligibility-service.js';
export type { EligibilityEntityType, EligibilityMintResult } from './eligibility-service.js';

export { VerificationService } from './verification-service.js';
export type { VerificationResult, FullVerificationResult } from './verification-service.js';
