import { Field, ZkProgram, SelfProof } from 'o1js';
import { BatchProof } from './batch-program.js';
import { computeGlobalStateRoot, ChainOutput } from './global-state.js';

// Re-export ChainOutput so consumers can import from chain-program.ts
export { ChainOutput } from './global-state.js';

/**
 * ChainProgram — recursive ZkProgram for the zkpCare L2 chain.
 *
 * "Picture of a picture": each block produces a proof that recursively
 * validates all previous blocks. A node holding just the latest
 * ChainProof can verify the entire chain history.
 *
 * Two methods:
 *   1. genesis  — base case: first block (block 0)
 *   2. advance  — recursive: block N proves block N-1 + new batch
 *
 * Proof chain:
 *   StateTransitionProof → BatchProof → ChainProof
 *                                          ↑ recursive
 *                                    (prev ChainProof)
 *
 * Note: StateTransitionProgram inlines wallet verification — no ProofGateProof needed.
 *
 * Admin state fields (benefitPlanRoot, credentialRegistryRoot, eligibilityVkHash,
 * messagingRoot, adminPublicKeyHash, auditChainHash) are passed as private
 * inputs. They're committed into the globalStateRoot, so any tampering
 * would produce a different root that doesn't match the chain.
 */
export const ChainProgram = ZkProgram({
  name: 'ChainProof',
  publicOutput: ChainOutput,

  methods: {
    /**
     * Genesis — base case: create block 0 from the first batch.
     *
     * Takes a BatchProof (first batch of transitions) plus the 6
     * admin state fields that aren't in BatchOutput.
     *
     * blockHeight = 0, walletCount = batch.registrationCount
     */
    genesis: {
      privateInputs: [
        BatchProof,
        Field, // adminPublicKeyHash
        Field, // benefitPlanRoot
        Field, // credentialRegistryRoot
        Field, // eligibilityVkHash
        Field, // messagingRoot
        Field, // auditChainHash
      ],
      async method(
        batchProof: InstanceType<typeof BatchProof>,
        adminPublicKeyHash: Field,
        benefitPlanRoot: Field,
        credentialRegistryRoot: Field,
        eligibilityVkHash: Field,
        messagingRoot: Field,
        auditChainHash: Field,
      ) {
        // 1. Verify the batch proof
        batchProof.verify();

        const batch = batchProof.publicOutput;
        const blockHeight = Field(0);
        const walletCount = batch.registrationCount;

        // 2. Compute the global state root from all 10 fields
        const globalStateRoot = computeGlobalStateRoot(
          batch.newRegistryRoot,
          walletCount,
          adminPublicKeyHash,
          batch.newLifecycleRoot,
          benefitPlanRoot,
          credentialRegistryRoot,
          eligibilityVkHash,
          messagingRoot,
          auditChainHash,
          blockHeight,
        );

        return {
          publicOutput: new ChainOutput({
            globalStateRoot,
            blockHeight,
            registryRoot: batch.newRegistryRoot,
            lifecycleRoot: batch.newLifecycleRoot,
            walletCount,
          }),
        };
      },
    },

    /**
     * Advance — recursive case: produce block N from block N-1 + new batch.
     *
     * Enforces chain continuity:
     *   - batch.oldRegistryRoot  == prev.registryRoot
     *   - batch.oldLifecycleRoot == prev.lifecycleRoot
     *
     * Increments blockHeight, accumulates walletCount.
     */
    advance: {
      privateInputs: [
        SelfProof,  // previous ChainProof
        BatchProof, // new batch
        Field, // adminPublicKeyHash
        Field, // benefitPlanRoot
        Field, // credentialRegistryRoot
        Field, // eligibilityVkHash
        Field, // messagingRoot
        Field, // auditChainHash
      ],
      async method(
        prevProof: SelfProof<undefined, ChainOutput>,
        batchProof: InstanceType<typeof BatchProof>,
        adminPublicKeyHash: Field,
        benefitPlanRoot: Field,
        credentialRegistryRoot: Field,
        eligibilityVkHash: Field,
        messagingRoot: Field,
        auditChainHash: Field,
      ) {
        // 1. Verify both proofs — recursive composition
        prevProof.verify();
        batchProof.verify();

        const prev = prevProof.publicOutput;
        const batch = batchProof.publicOutput;

        // 2. Chain continuity: batch must start where previous block ended
        batch.oldRegistryRoot.assertEquals(
          prev.registryRoot,
          'Chain break: batch.oldRegistryRoot != prev.registryRoot',
        );
        batch.oldLifecycleRoot.assertEquals(
          prev.lifecycleRoot,
          'Chain break: batch.oldLifecycleRoot != prev.lifecycleRoot',
        );

        // 3. Advance block height and accumulate wallet count
        const blockHeight = prev.blockHeight.add(1);
        const walletCount = prev.walletCount.add(batch.registrationCount);

        // 4. Compute the global state root
        const globalStateRoot = computeGlobalStateRoot(
          batch.newRegistryRoot,
          walletCount,
          adminPublicKeyHash,
          batch.newLifecycleRoot,
          benefitPlanRoot,
          credentialRegistryRoot,
          eligibilityVkHash,
          messagingRoot,
          auditChainHash,
          blockHeight,
        );

        return {
          publicOutput: new ChainOutput({
            globalStateRoot,
            blockHeight,
            registryRoot: batch.newRegistryRoot,
            lifecycleRoot: batch.newLifecycleRoot,
            walletCount,
          }),
        };
      },
    },
  },
});

/** Named proof class for ChainProgram — required for recursive composition */
export class ChainProof extends ZkProgram.Proof(ChainProgram) {}
