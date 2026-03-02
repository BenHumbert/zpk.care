/**
 * L2 Proving Worker — Child process entry point for parallel batch proving.
 *
 * Spawned by ProvingPool via child_process.fork(). Each worker gets its own
 * o1js Pickles/Kimchi proving context, enabling true CPU-parallel proving
 * across multiple workers.
 *
 * Lifecycle:
 *   1. Receives 'compile' → compiles BatchProgram + ChainProgram → sends 'ready'
 *   2. Receives 'prove'   → runs proving pipeline → sends 'result' or 'error'
 *   3. Receives 'shutdown' → process.exit(0)
 *
 * This file imports only batch-program, chain-program, and o1js types.
 * It never imports L2SequencerService or any state-management code.
 */
import { Field } from 'o1js';
import {
  BatchProgram,
  BatchProof,
} from './batch-program.js';
import type { BatchOutput } from './batch-program.js';
import {
  ChainProgram,
  ChainProof,
} from './chain-program.js';
import type { ChainOutput } from './global-state.js';
import {
  StateTransitionProof,
} from '../engine/state-transition.js';
import type {
  CoordinatorMessage,
  WorkerMessage,
  ProvingJobRequest,
  ProvingJobResult,
} from './l2-proving-pool-types.js';

// ─── IPC Send Helper ──────────────────────────────────────

function send(msg: WorkerMessage): void {
  if (process.send) {
    process.send(msg);
  }
}

// ─── Compilation ──────────────────────────────────────────

let compiled = false;

async function handleCompile(): Promise<void> {
  const start = Date.now();
  await BatchProgram.compile();
  await ChainProgram.compile();
  compiled = true;
  send({ type: 'ready', compileTimeMs: Date.now() - start });
}

// ─── Proving ──────────────────────────────────────────────

async function handleProve(
  jobId: string,
  request: ProvingJobRequest,
): Promise<void> {
  if (!compiled) {
    send({ type: 'error', jobId, message: 'Worker not compiled — call compile first' });
    return;
  }

  const start = Date.now();

  try {
    // 1. Deserialize StateTransitionProofs
    const proofs: InstanceType<typeof StateTransitionProof>[] = [];
    for (const json of request.transitionProofJsons) {
      const proof = await StateTransitionProof.fromJSON(
        json as Parameters<typeof StateTransitionProof.fromJSON>[0],
      );
      proofs.push(proof);
    }

    // 2. Build BatchProof (wrapSingle/wrapPair + tree-merge)
    let finalProof: BatchProof;

    if (proofs.length === 1) {
      // Single transition — wrapSingle (same proof passed twice for uniform arity)
      const wrapped = await BatchProgram.wrapSingle(proofs[0], proofs[0]);
      finalProof = wrapped.proof as BatchProof;
    } else {
      // Pair transitions and wrap each pair
      const wrappedProofs: BatchProof[] = [];
      for (let i = 0; i < proofs.length; i += 2) {
        const wrapped = await BatchProgram.wrapPair(proofs[i], proofs[i + 1]);
        wrappedProofs.push(wrapped.proof as BatchProof);
      }

      // Tree-merge: pair-wise merge until single proof remains
      let currentLevel = wrappedProofs;
      while (currentLevel.length > 1) {
        const nextLevel: BatchProof[] = [];
        for (let i = 0; i < currentLevel.length; i += 2) {
          if (i + 1 < currentLevel.length) {
            const merged = await BatchProgram.mergeBatches(
              currentLevel[i],
              currentLevel[i + 1],
            );
            nextLevel.push(merged.proof as BatchProof);
          } else {
            nextLevel.push(currentLevel[i]);
          }
        }
        currentLevel = nextLevel;
      }

      finalProof = currentLevel[0];
    }

    const batchOutput = finalProof.publicOutput as unknown as BatchOutput;

    // 3. Optionally produce ChainProof
    let chainProofJson: string | undefined;
    let chainOutput: ProvingJobResult['chainOutput'];

    if (request.adminState) {
      const admin = request.adminState;
      const adminPublicKeyHash = Field(BigInt(admin.adminPublicKeyHash));
      const benefitPlanRoot = Field(BigInt(admin.benefitPlanRoot));
      const credentialRegistryRoot = Field(BigInt(admin.credentialRegistryRoot));
      const eligibilityVkHash = Field(BigInt(admin.eligibilityVkHash));
      const messagingRoot = Field(BigInt(admin.messagingRoot));
      const auditChainHash = Field(BigInt(request.latestChainHash));

      let chainResult: { proof: unknown };

      if (request.latestChainProofJson) {
        // Advance — reconstruct previous ChainProof and advance
        const prevProofJson = JSON.parse(request.latestChainProofJson);
        const prevChainProof = (await ChainProof.fromJSON(prevProofJson)) as ChainProof;
        chainResult = await ChainProgram.advance(
          prevChainProof,
          finalProof,
          adminPublicKeyHash,
          benefitPlanRoot,
          credentialRegistryRoot,
          eligibilityVkHash,
          messagingRoot,
          auditChainHash,
        );
      } else {
        // Genesis — first block
        chainResult = await ChainProgram.genesis(
          finalProof,
          adminPublicKeyHash,
          benefitPlanRoot,
          credentialRegistryRoot,
          eligibilityVkHash,
          messagingRoot,
          auditChainHash,
        );
      }

      const chainProof = chainResult.proof as ChainProof;
      const co = chainProof.publicOutput as unknown as ChainOutput;
      chainProofJson = JSON.stringify(chainProof.toJSON());
      chainOutput = {
        globalStateRoot: co.globalStateRoot.toString(),
        blockHeight: co.blockHeight.toBigInt().toString(),
      };
    }

    // 4. Send result
    const result: ProvingJobResult = {
      batchProofJson: JSON.stringify(finalProof.toJSON()),
      batchOutput: {
        oldRegistryRoot: batchOutput.oldRegistryRoot.toString(),
        newRegistryRoot: batchOutput.newRegistryRoot.toString(),
        oldLifecycleRoot: batchOutput.oldLifecycleRoot.toString(),
        newLifecycleRoot: batchOutput.newLifecycleRoot.toString(),
        registrationCount: batchOutput.registrationCount.toBigInt().toString(),
        transitionCount: batchOutput.transitionCount.toBigInt().toString(),
      },
      chainProofJson,
      chainOutput,
      proveTimeMs: Date.now() - start,
    };

    send({ type: 'result', jobId, result });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    send({ type: 'error', jobId, message });
  }
}

// ─── Message Handler ──────────────────────────────────────

process.on('message', (msg: CoordinatorMessage) => {
  switch (msg.type) {
    case 'compile':
      handleCompile().catch((err) => {
        send({
          type: 'error',
          jobId: '__compile__',
          message: err instanceof Error ? err.message : String(err),
        });
      });
      break;

    case 'prove':
      handleProve(msg.jobId, msg.request).catch((err) => {
        send({
          type: 'error',
          jobId: msg.jobId,
          message: err instanceof Error ? err.message : String(err),
        });
      });
      break;

    case 'shutdown':
      process.exit(0);
      break;
  }
});

// Graceful exit on disconnect (parent killed)
process.on('disconnect', () => {
  process.exit(0);
});
