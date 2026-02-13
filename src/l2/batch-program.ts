import { Field, Struct, ZkProgram, SelfProof } from 'o1js';
import {
  TransitionOutput,
  StateTransitionProof,
} from '../engine/state-transition.js';

/**
 * BatchOutput — public output of the BatchProgram.
 *
 * Tracks the aggregate state transition for an entire batch of
 * individual StateTransitionProofs. The L1 CareContract verifies
 * a single BatchProof to settle all transitions in one tx.
 *
 * 6 Fields:
 *   - old/new registry roots: wallet registry state before/after batch
 *   - old/new lifecycle roots: lifecycle tree state before/after batch
 *   - registrationCount: number of new wallets in this batch
 *   - transitionCount: total transitions in this batch
 */
export class BatchOutput extends Struct({
  oldRegistryRoot: Field,
  newRegistryRoot: Field,
  oldLifecycleRoot: Field,
  newLifecycleRoot: Field,
  registrationCount: Field,
  transitionCount: Field,
}) {}

/**
 * BatchProgram — recursive ZkProgram for L2 batch settlement.
 *
 * Two methods:
 *   1. wrapTransition — base case: wraps one StateTransitionProof into a BatchProof
 *   2. mergeBatches — recursive case: merges two BatchProofs with root chain enforcement
 *
 * Tree-merge strategy:
 *   N proofs → wrap each (parallel) → merge pairs (log2(N) rounds)
 *   For 16 transitions: 4 sequential rounds instead of 15 sequential appends.
 *
 * Proof chain:
 *   ProofGateProof → StateTransitionProof → BatchProof → CareContract.settleBatch
 */
export const BatchProgram = ZkProgram({
  name: 'BatchSettlement',
  publicOutput: BatchOutput,

  methods: {
    /**
     * Base case: wrap a single StateTransitionProof into a BatchProof.
     *
     * Detects registration (both roots changed) to track walletCount.
     */
    wrapTransition: {
      privateInputs: [StateTransitionProof],
      async method(stProof: StateTransitionProof) {
        stProof.verify();

        const output = stProof.publicOutput as unknown as TransitionOutput;

        // Detect registration: both roots changed means new wallet was registered
        const registryChanged = output.oldRegistryRoot
          .equals(output.newRegistryRoot)
          .not();
        const lifecycleChanged = output.oldLifecycleRoot
          .equals(output.newLifecycleRoot)
          .not();
        const isRegistration = registryChanged.and(lifecycleChanged);

        return {
          publicOutput: new BatchOutput({
            oldRegistryRoot: output.oldRegistryRoot,
            newRegistryRoot: output.newRegistryRoot,
            oldLifecycleRoot: output.oldLifecycleRoot,
            newLifecycleRoot: output.newLifecycleRoot,
            registrationCount: isRegistration.toField(),
            transitionCount: Field(1),
          }),
        };
      },
    },

    /**
     * Recursive case: merge two BatchProofs with root chain enforcement.
     *
     * Enforces that left.new roots == right.old roots (sequential ordering).
     * Sums registration and transition counts.
     */
    mergeBatches: {
      privateInputs: [SelfProof, SelfProof],
      async method(
        left: SelfProof<undefined, BatchOutput>,
        right: SelfProof<undefined, BatchOutput>,
      ) {
        left.verify();
        right.verify();

        // Chain enforcement: left's new state must equal right's old state
        left.publicOutput.newRegistryRoot.assertEquals(
          right.publicOutput.oldRegistryRoot,
          'Registry root chain broken: left.new != right.old',
        );
        left.publicOutput.newLifecycleRoot.assertEquals(
          right.publicOutput.oldLifecycleRoot,
          'Lifecycle root chain broken: left.new != right.old',
        );

        return {
          publicOutput: new BatchOutput({
            oldRegistryRoot: left.publicOutput.oldRegistryRoot,
            newRegistryRoot: right.publicOutput.newRegistryRoot,
            oldLifecycleRoot: left.publicOutput.oldLifecycleRoot,
            newLifecycleRoot: right.publicOutput.newLifecycleRoot,
            registrationCount: left.publicOutput.registrationCount.add(
              right.publicOutput.registrationCount,
            ),
            transitionCount: left.publicOutput.transitionCount.add(
              right.publicOutput.transitionCount,
            ),
          }),
        };
      },
    },
  },
});

/** Named proof class for BatchProgram — required for SmartContract @method params */
export class BatchProof extends ZkProgram.Proof(BatchProgram) {}
