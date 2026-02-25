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
 * Three methods (all take exactly 2 proofs — uniform pair pattern):
 *   1. wrapSingle — base case: wraps ONE StateTransitionProof (padded to 2 inputs)
 *   2. wrapPair — base case: wraps TWO sequential StateTransitionProofs
 *   3. mergeBatches — recursive case: merges two BatchProofs with root chain enforcement
 *
 * Uniform pair design:
 *   All methods have maxProofsVerified=2, avoiding the o1js Pickles dummy-proof
 *   bug (issue #1939) that crashes at recursion depth 2+ when methods have
 *   heterogeneous proof counts. See tests/minimal-recursion.test.ts for proof.
 *   wrapSingle accepts 2 proof inputs for uniformity — the second is verified
 *   but its output is ignored. Callers pass the same proof as both arguments.
 *
 * Tree-merge strategy:
 *   N transitions → pair-wrap (N/2 wrapPair calls) → merge pairs (log2(N/2) rounds)
 *   For 4 transitions: 2 wrapPair + 1 merge = 3 ops (vs old: 4 wrap + 3 merge = 7).
 *   For 1 transition: 1 wrapSingle call.
 *
 * Proof chain:
 *   StateTransitionProof → BatchProof → ChainProof → CareContract.settleBatch
 *
 * Note: StateTransitionProgram inlines wallet verification — no ProofGateProof needed.
 */
export const BatchProgram = ZkProgram({
  name: 'BatchSettlement',
  publicOutput: BatchOutput,

  methods: {
    /**
     * Base case: wrap a SINGLE StateTransitionProof into a BatchProof.
     *
     * Takes 2 proof inputs to maintain uniform maxProofsVerified=2, but only
     * the first proof's output is used. The second is verified (satisfying
     * the Pickles constraint system) but its output is discarded.
     *
     * Usage: pass the same proof as both arguments.
     * This allows batching when only 1 transition is pending.
     */
    wrapSingle: {
      privateInputs: [StateTransitionProof, StateTransitionProof],
      async method(
        proof: StateTransitionProof,
        _padding: StateTransitionProof,
      ) {
        proof.verify();
        _padding.verify();

        const out = proof.publicOutput as unknown as TransitionOutput;

        const regChanged = out.oldRegistryRoot
          .equals(out.newRegistryRoot)
          .not();
        const lcChanged = out.oldLifecycleRoot
          .equals(out.newLifecycleRoot)
          .not();
        const isRegistration = regChanged.and(lcChanged);

        return {
          publicOutput: new BatchOutput({
            oldRegistryRoot: out.oldRegistryRoot,
            newRegistryRoot: out.newRegistryRoot,
            oldLifecycleRoot: out.oldLifecycleRoot,
            newLifecycleRoot: out.newLifecycleRoot,
            registrationCount: isRegistration.toField(),
            transitionCount: Field(1),
          }),
        };
      },
    },

    /**
     * Base case: wrap a PAIR of sequential StateTransitionProofs into a BatchProof.
     *
     * Enforces root chaining between the two proofs (left.new == right.old).
     * Detects registration independently for each proof (both roots changed).
     *
     * Takes 2 proofs — matches mergeBatches arity for uniform maxProofsVerified=2.
     */
    wrapPair: {
      privateInputs: [StateTransitionProof, StateTransitionProof],
      async method(
        leftProof: StateTransitionProof,
        rightProof: StateTransitionProof,
      ) {
        leftProof.verify();
        rightProof.verify();

        const left = leftProof.publicOutput as unknown as TransitionOutput;
        const right = rightProof.publicOutput as unknown as TransitionOutput;

        // Chain enforcement: left's new state must equal right's old state
        left.newRegistryRoot.assertEquals(
          right.oldRegistryRoot,
          'Pair registry root chain broken: left.new != right.old',
        );
        left.newLifecycleRoot.assertEquals(
          right.oldLifecycleRoot,
          'Pair lifecycle root chain broken: left.new != right.old',
        );

        // Detect registration for each proof independently
        const leftRegChanged = left.oldRegistryRoot
          .equals(left.newRegistryRoot)
          .not();
        const leftLcChanged = left.oldLifecycleRoot
          .equals(left.newLifecycleRoot)
          .not();
        const leftIsRegistration = leftRegChanged.and(leftLcChanged);

        const rightRegChanged = right.oldRegistryRoot
          .equals(right.newRegistryRoot)
          .not();
        const rightLcChanged = right.oldLifecycleRoot
          .equals(right.newLifecycleRoot)
          .not();
        const rightIsRegistration = rightRegChanged.and(rightLcChanged);

        return {
          publicOutput: new BatchOutput({
            oldRegistryRoot: left.oldRegistryRoot,
            newRegistryRoot: right.newRegistryRoot,
            oldLifecycleRoot: left.oldLifecycleRoot,
            newLifecycleRoot: right.newLifecycleRoot,
            registrationCount: leftIsRegistration
              .toField()
              .add(rightIsRegistration.toField()),
            transitionCount: Field(2),
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
