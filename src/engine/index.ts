// Engine — zkApp Core / State Machine (L3)

export {
  LifecycleWitness,
  LIFECYCLE_EMPTY,
  LIFECYCLE_REGISTERED,
  LIFECYCLE_ELIGIBLE,
  LIFECYCLE_ACTIVE,
  LIFECYCLE_REVOKED,
  lifecycleLeafCommitment,
  assertValidTransition,
  isValidTransition,
} from './lifecycle.js';

export {
  EMPTY_CREDENTIAL_ROOT,
  TransitionOutput,
  StateTransitionProgram,
  StateTransitionProof,
} from './state-transition.js';

export { CareContract, CredentialRegistryWitness } from './care-contract.js';
