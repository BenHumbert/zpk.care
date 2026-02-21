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
  NETWORK_TREE_HEIGHT,
  NetworkMerkleWitness,
  ProviderNetworkRegistry,
} from './provider-network-registry.js';

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

export { FormularyUpdateService } from './formulary-update-service.js';
export type { FormularyRebuildResult, PublishedFormulary } from './formulary-update-service.js';

export { VerificationService } from './verification-service.js';
export type { VerificationResult, FullVerificationResult } from './verification-service.js';

export {
  PCP_SCOPE_RX_HISTORY,
  PCP_SCOPE_ELIGIBILITY,
  PCP_SCOPE_ACCUMULATORS,
  PCP_SCOPE_ALL,
  PCP_ASSIGNMENT_LEAF_INDEX,
  PcpAssignmentData,
  buildPcpAssignmentData,
} from './pcp-assignment-data.js';
export type { PcpAssignmentLocalData } from './pcp-assignment-data.js';

export {
  PcpVerificationOutput,
  PcpVerificationProgram,
  PcpVerificationProof,
} from './pcp-verification-program.js';
