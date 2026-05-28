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

/**
 * Proof Pool Worker — Child process that compiles all ZkPrograms and
 * handles proof requests from the main process.
 *
 * Each worker maintains its own o1js context (WASM + proving keys),
 * allowing the main event loop to remain free for heartbeats, RPC,
 * and gossip during ZK proof generation.
 *
 * IPC protocol:
 *   Coordinator → Worker: compile | prove | shutdown
 *   Worker → Coordinator: ready | result | error
 *
 * Serialization:
 *   - Field values → decimal strings
 *   - Structs → Struct.toJSON() output (object of decimal strings)
 *   - MerkleWitness → WitnessClass.toJSON() output ({path: string[], isLeft: boolean[]})
 *   - Proofs → proof.toJSON() output (object)
 */

import { Field } from 'o1js';
import type {
  ProofCoordinatorMessage,
  ProofJobRequest,
  ProofJobResult,
} from './proof-pool-types.js';

// ─── Program Imports ──────────────────────────────────────

// Wallets
import { ProofGateProgram } from '../../src/wallets/proof-gate.js';

// Engine
import {
  StateTransitionProgram,
  StateTransitionProof,
} from '../../src/engine/state-transition.js';
import { LifecycleWitness } from '../../src/engine/lifecycle.js';

// Eligibility
import { EligibilityData } from '../../src/eligibility/eligibility-data.js';
import { ForestRoots } from '../../src/eligibility/forest-roots.js';
import { EligibilityProgram } from '../../src/eligibility/eligibility-program.js';
import { PcpVerificationProgram } from '../../src/eligibility/pcp-verification-program.js';
import { PcpAssignmentData } from '../../src/eligibility/pcp-assignment-data.js';
import { BenefitPlanWitness } from '../../src/eligibility/benefit-plan-registry.js';

// Access Control
import { FormularyEntry } from '../../src/access-control/formulary-entry.js';
import { FormularyMerkleWitness } from '../../src/access-control/formulary-registry.js';
import { AccessControlProgram } from '../../src/access-control/access-control-program.js';
import { AccumulatorData } from '../../src/access-control/accumulator-data.js';
import { PriorAuthData } from '../../src/access-control/prior-auth-data.js';
import { ForestMerkleWitness } from '../../src/zkp/merkle-forest.js';

// Messaging
import { MessageData } from '../../src/messaging/message-data.js';
import { MessagingProgram } from '../../src/messaging/messaging-program.js';
import {
  MessageRegistryWitness,
  DelegationRegistryWitness,
  KeyRegistryWitness,
} from '../../src/messaging/message-registry.js';
import { DelegationData } from '../../src/messaging/delegation-data.js';

// Prescription
import { PrescriptionData, PrescriptionStatusData } from '../../src/prescription/prescription-data.js';
import { PrescriptionProgram } from '../../src/prescription/prescription-program.js';

// Fulfillment
import { FulfillmentData, ReversalData } from '../../src/fulfillment/fulfillment-data.js';
import { AccumulatorFulfillmentProgram } from '../../src/fulfillment/accumulator-fulfillment-program.js';

// Credentials
import { CredentialData } from '../../src/credentials/credential-data.js';
import { CredentialProgram } from '../../src/credentials/credential-program.js';

// Batch (needed for StateTransitionProof deserialization)
import { BatchProgram } from '../../src/l2/batch-program.js';

// Wallet state
import { WalletRegistryWitness, CredentialInventoryWitness } from '../../src/wallets/wallet-state.js';

// ─── Type Registry ────────────────────────────────────────
// Maps type names → { toJSON, fromJSON } for Struct classes.
// MerkleWitness classes also work with toJSON/fromJSON.

const TYPE_REGISTRY: Record<string, { toJSON: (v: any) => any; fromJSON: (v: any) => any }> = {
  // Structs
  Field: { toJSON: (f: Field) => f.toString(), fromJSON: (s: string) => Field(BigInt(s)) },
  CredentialData: { toJSON: (v: any) => CredentialData.toJSON(v), fromJSON: (v: any) => CredentialData.fromJSON(v) },
  EligibilityData: { toJSON: (v: any) => EligibilityData.toJSON(v), fromJSON: (v: any) => EligibilityData.fromJSON(v) },
  ForestRoots: { toJSON: (v: any) => ForestRoots.toJSON(v), fromJSON: (v: any) => ForestRoots.fromJSON(v) },
  FormularyEntry: { toJSON: (v: any) => FormularyEntry.toJSON(v), fromJSON: (v: any) => FormularyEntry.fromJSON(v) },
  AccumulatorData: { toJSON: (v: any) => AccumulatorData.toJSON(v), fromJSON: (v: any) => AccumulatorData.fromJSON(v) },
  PriorAuthData: { toJSON: (v: any) => PriorAuthData.toJSON(v), fromJSON: (v: any) => PriorAuthData.fromJSON(v) },
  MessageData: { toJSON: (v: any) => MessageData.toJSON(v), fromJSON: (v: any) => MessageData.fromJSON(v) },
  DelegationData: { toJSON: (v: any) => DelegationData.toJSON(v), fromJSON: (v: any) => DelegationData.fromJSON(v) },
  PrescriptionData: { toJSON: (v: any) => PrescriptionData.toJSON(v), fromJSON: (v: any) => PrescriptionData.fromJSON(v) },
  PrescriptionStatusData: { toJSON: (v: any) => PrescriptionStatusData.toJSON(v), fromJSON: (v: any) => PrescriptionStatusData.fromJSON(v) },
  FulfillmentData: { toJSON: (v: any) => FulfillmentData.toJSON(v), fromJSON: (v: any) => FulfillmentData.fromJSON(v) },
  ReversalData: { toJSON: (v: any) => ReversalData.toJSON(v), fromJSON: (v: any) => ReversalData.fromJSON(v) },
  PcpAssignmentData: { toJSON: (v: any) => PcpAssignmentData.toJSON(v), fromJSON: (v: any) => PcpAssignmentData.fromJSON(v) },

  // MerkleWitness classes
  // ForestMerkleWitness covers all forest domain witnesses (ACCESS_CONTROL, MEDICATION, TRANSACTION, etc.)
  ForestMerkleWitness: { toJSON: (v: any) => ForestMerkleWitness.toJSON(v), fromJSON: (v: any) => ForestMerkleWitness.fromJSON(v) },
  FormularyMerkleWitness: { toJSON: (v: any) => FormularyMerkleWitness.toJSON(v), fromJSON: (v: any) => FormularyMerkleWitness.fromJSON(v) },
  BenefitPlanWitness: { toJSON: (v: any) => BenefitPlanWitness.toJSON(v), fromJSON: (v: any) => BenefitPlanWitness.fromJSON(v) },
  WalletRegistryWitness: { toJSON: (v: any) => WalletRegistryWitness.toJSON(v), fromJSON: (v: any) => WalletRegistryWitness.fromJSON(v) },
  LifecycleWitness: { toJSON: (v: any) => LifecycleWitness.toJSON(v), fromJSON: (v: any) => LifecycleWitness.fromJSON(v) },
  MessageRegistryWitness: { toJSON: (v: any) => MessageRegistryWitness.toJSON(v), fromJSON: (v: any) => MessageRegistryWitness.fromJSON(v) },
  DelegationRegistryWitness: { toJSON: (v: any) => DelegationRegistryWitness.toJSON(v), fromJSON: (v: any) => DelegationRegistryWitness.fromJSON(v) },
  KeyRegistryWitness: { toJSON: (v: any) => KeyRegistryWitness.toJSON(v), fromJSON: (v: any) => KeyRegistryWitness.fromJSON(v) },
  CredentialInventoryWitness: { toJSON: (v: any) => CredentialInventoryWitness.toJSON(v), fromJSON: (v: any) => CredentialInventoryWitness.fromJSON(v) },

  // Proofs
  StateTransitionProof: { toJSON: (v: any) => v.toJSON(), fromJSON: (v: any) => StateTransitionProof.fromJSON(v) },
};

// ─── Program Registry ─────────────────────────────────────
// Maps (program, method) → the ZkProgram method function + expected arg types.

interface MethodDef {
  fn: (...args: any[]) => Promise<any>;
  argTypes: string[];  // type names in TYPE_REGISTRY
  hasPublicOutput: boolean;
}

const PROGRAM_REGISTRY: Record<string, Record<string, MethodDef>> = {
  ProofGate: {
    verifyMember: {
      fn: (...args: any[]) => ProofGateProgram.verifyMember(...args),
      argTypes: ['Field', 'Field', 'Field', 'Field', 'Field', 'Field', 'Field'],
      hasPublicOutput: false,
    },
    verifyPrescriber: {
      fn: (...args: any[]) => ProofGateProgram.verifyPrescriber(...args),
      argTypes: ['Field', 'Field', 'Field', 'Field'],
      hasPublicOutput: false,
    },
    verifyPharmacy: {
      fn: (...args: any[]) => ProofGateProgram.verifyPharmacy(...args),
      argTypes: ['Field', 'Field', 'Field', 'Field'],
      hasPublicOutput: false,
    },
  },
  Eligibility: {
    proveEligibility: {
      fn: (...args: any[]) => EligibilityProgram.proveEligibility(...args),
      argTypes: ['CredentialData', 'EligibilityData', 'ForestRoots', 'ForestMerkleWitness', 'BenefitPlanWitness', 'Field', 'Field'],
      hasPublicOutput: false,
    },
  },
  AccessControl: {
    proveFormularyAccess: {
      fn: (...args: any[]) => AccessControlProgram.proveFormularyAccess(...args),
      argTypes: ['CredentialData', 'EligibilityData', 'ForestRoots', 'ForestMerkleWitness', 'FormularyEntry', 'FormularyMerkleWitness', 'Field', 'Field', 'Field', 'Field'],
      hasPublicOutput: false,
    },
    provePriorAuth: {
      fn: (...args: any[]) => AccessControlProgram.provePriorAuth(...args),
      argTypes: ['CredentialData', 'EligibilityData', 'ForestRoots', 'ForestMerkleWitness', 'ForestMerkleWitness', 'PriorAuthData', 'FormularyEntry', 'FormularyMerkleWitness', 'Field', 'Field'],
      hasPublicOutput: false,
    },
  },
  Messaging: {
    proveSendMessage: {
      fn: (...args: any[]) => MessagingProgram.proveSendMessage(...args),
      argTypes: ['MessageData', 'MessageRegistryWitness', 'Field', 'Field', 'Field'],
      hasPublicOutput: false,
    },
    proveDelegate: {
      fn: (...args: any[]) => MessagingProgram.proveDelegate(...args),
      argTypes: ['DelegationData', 'DelegationRegistryWitness', 'Field', 'Field', 'Field', 'Field'],
      hasPublicOutput: false,
    },
  },
  StateTransition: {
    proveRegistration: {
      fn: (...args: any[]) => StateTransitionProgram.proveRegistration(...args),
      argTypes: ['Field', 'Field', 'Field', 'Field', 'Field', 'Field', 'Field', 'WalletRegistryWitness', 'LifecycleWitness', 'Field', 'Field'],
      hasPublicOutput: true,
    },
    proveWalletUpdate: {
      fn: (...args: any[]) => StateTransitionProgram.proveWalletUpdate(...args),
      argTypes: ['Field', 'Field', 'Field', 'Field', 'Field', 'Field', 'Field', 'Field', 'Field', 'Field', 'WalletRegistryWitness', 'LifecycleWitness', 'Field', 'Field', 'Field'],
      hasPublicOutput: true,
    },
  },
  Prescription: {
    proveStatusUpdate: {
      fn: (...args: any[]) => PrescriptionProgram.proveStatusUpdate(...args),
      argTypes: ['CredentialData', 'PrescriptionData', 'PrescriptionStatusData', 'PrescriptionStatusData', 'ForestRoots', 'ForestMerkleWitness', 'ForestMerkleWitness', 'ForestMerkleWitness', 'Field', 'Field', 'Field'],
      hasPublicOutput: false,
    },
  },
  AccumulatorFulfillment: {
    proveFulfillmentWithAccumulator: {
      fn: (...args: any[]) => AccumulatorFulfillmentProgram.proveFulfillmentWithAccumulator(...args),
      argTypes: [
        'CredentialData', 'PrescriptionData', 'PrescriptionStatusData',
        'FulfillmentData', 'FormularyEntry', 'ForestRoots',
        'ForestMerkleWitness', 'ForestMerkleWitness', 'ForestMerkleWitness',
        'FormularyMerkleWitness', 'Field',
        'CredentialData', 'ForestRoots',
        'AccumulatorData', 'ForestMerkleWitness',
        'Field', 'Field', 'Field',
      ],
      hasPublicOutput: true,
    },
    proveReversalWithAccumulator: {
      fn: (...args: any[]) => AccumulatorFulfillmentProgram.proveReversalWithAccumulator(...args),
      argTypes: [
        'CredentialData', 'PrescriptionData',
        'FulfillmentData', 'ReversalData', 'ForestRoots',
        'ForestMerkleWitness', 'ForestMerkleWitness', 'ForestMerkleWitness',
        'Field', 'Field', 'Field',
        'CredentialData', 'ForestRoots',
        'AccumulatorData', 'ForestMerkleWitness',
      ],
      hasPublicOutput: true,
    },
  },
  Credential: {
    proveHolding: {
      fn: (...args: any[]) => CredentialProgram.proveHolding(...args),
      argTypes: ['StateTransitionProof', 'CredentialData', 'CredentialInventoryWitness', 'Field'],
      hasPublicOutput: true,
    },
    proveHoldingByType: {
      fn: (...args: any[]) => CredentialProgram.proveHoldingByType(...args),
      argTypes: ['StateTransitionProof', 'CredentialData', 'CredentialInventoryWitness', 'Field', 'Field'],
      hasPublicOutput: true,
    },
  },
  PcpVerification: {
    verifyPcpAssignment: {
      fn: (...args: any[]) => PcpVerificationProgram.verifyPcpAssignment(...args),
      argTypes: ['CredentialData', 'PcpAssignmentData', 'ForestRoots', 'ForestMerkleWitness', 'Field', 'Field'],
      hasPublicOutput: false,
    },
  },
};

// ─── Compilation ──────────────────────────────────────────

let compiled = false;

async function handleCompile(): Promise<void> {
  const start = Date.now();
  const programs: string[] = [];

  // Compile in dependency order (same as interactive-service compileAllPrograms)
  console.log('[proof-worker] Compiling ProofGateProgram...');
  await ProofGateProgram.compile();
  programs.push('ProofGate');

  console.log('[proof-worker] Compiling EligibilityProgram...');
  await EligibilityProgram.compile();
  programs.push('Eligibility');

  console.log('[proof-worker] Compiling AccessControlProgram...');
  await AccessControlProgram.compile();
  programs.push('AccessControl');

  console.log('[proof-worker] Compiling MessagingProgram...');
  await MessagingProgram.compile();
  programs.push('Messaging');

  console.log('[proof-worker] Compiling PrescriptionProgram...');
  await PrescriptionProgram.compile();
  programs.push('Prescription');

  console.log('[proof-worker] Compiling AccumulatorFulfillmentProgram...');
  await AccumulatorFulfillmentProgram.compile();
  programs.push('AccumulatorFulfillment');

  console.log('[proof-worker] Compiling PcpVerificationProgram...');
  await PcpVerificationProgram.compile();
  programs.push('PcpVerification');

  console.log('[proof-worker] Compiling CredentialProgram...');
  await CredentialProgram.compile();
  programs.push('Credential');

  console.log('[proof-worker] Compiling StateTransitionProgram...');
  await StateTransitionProgram.compile();
  programs.push('StateTransition');

  console.log('[proof-worker] Compiling BatchProgram...');
  await BatchProgram.compile();
  programs.push('Batch');

  compiled = true;
  const elapsed = Date.now() - start;
  console.log(`[proof-worker] All programs compiled in ${(elapsed / 1000).toFixed(1)}s`);

  process.send!({ type: 'ready', compileTimeMs: elapsed, programs });
}

// ─── Proving ──────────────────────────────────────────────

function deserializeArg(typeName: string, serialized: unknown): unknown {
  const entry = TYPE_REGISTRY[typeName];
  if (!entry) throw new Error(`Unknown type in registry: ${typeName}`);
  return entry.fromJSON(serialized);
}

async function handleProve(jobId: string, request: ProofJobRequest): Promise<void> {
  if (!compiled) throw new Error('Programs not compiled yet');

  const memBefore = process.memoryUsage();
  const rssBefore = Math.round(memBefore.rss / 1024 / 1024);
  const heapBefore = Math.round(memBefore.heapUsed / 1024 / 1024);
  console.log(`[proof-worker] ${jobId}: ${request.program}.${request.method} — START (RSS: ${rssBefore}MB, Heap: ${heapBefore}MB, args: ${request.args.length})`);

  const start = Date.now();

  const programDef = PROGRAM_REGISTRY[request.program];
  if (!programDef) throw new Error(`Unknown program: ${request.program}`);

  const methodDef = programDef[request.method];
  if (!methodDef) throw new Error(`Unknown method: ${request.program}.${request.method}`);

  if (request.args.length !== methodDef.argTypes.length) {
    throw new Error(`Arg count mismatch for ${request.program}.${request.method}: expected ${methodDef.argTypes.length}, got ${request.args.length}`);
  }

  // Deserialize arguments — per-arg error reporting
  const args: unknown[] = [];
  for (let i = 0; i < request.args.length; i++) {
    try {
      args.push(deserializeArg(methodDef.argTypes[i], request.args[i]));
    } catch (err: any) {
      const preview = JSON.stringify(request.args[i])?.slice(0, 200) ?? 'null';
      throw new Error(`Deserialization failed for arg[${i}] (${methodDef.argTypes[i]}): ${err.message}\n  Input preview: ${preview}`);
    }
  }

  console.log(`[proof-worker] ${jobId}: deserialized ${args.length} args in ${Date.now() - start}ms — proving...`);

  // Prove
  let proveResult: any;
  try {
    proveResult = await methodDef.fn(...args);
  } catch (err: any) {
    const memAfter = process.memoryUsage();
    const rssAfter = Math.round(memAfter.rss / 1024 / 1024);
    console.error(`[proof-worker] ${jobId}: PROVE FAILED after ${Date.now() - start}ms (RSS: ${rssAfter}MB, delta: +${rssAfter - rssBefore}MB)`);
    throw err;
  }

  const memAfter = process.memoryUsage();
  const rssAfter = Math.round(memAfter.rss / 1024 / 1024);
  console.log(`[proof-worker] ${jobId}: ${request.program}.${request.method} — DONE in ${Date.now() - start}ms (RSS: ${rssAfter}MB, delta: +${rssAfter - rssBefore}MB)`);

  // Build result
  const result: ProofJobResult = {
    proofJson: proveResult?.proof ? JSON.stringify(proveResult.proof.toJSON()) : null,
    publicOutput: null,
    proveTimeMs: Date.now() - start,
    workerId: -1, // stamped by coordinator
  };

  // Extract public output if present
  if (methodDef.hasPublicOutput && proveResult?.proof?.publicOutput) {
    const po = proveResult.proof.publicOutput;
    const out: Record<string, string> = {};
    // Walk all Field properties on the public output Struct
    for (const [key, val] of Object.entries(po)) {
      if (val === undefined || val === null) {
        console.warn(`[proof-worker] ${jobId}: publicOutput.${key} is ${val} — skipping`);
        continue;
      }
      if (typeof val === 'object' && 'toBigInt' in val) {
        out[key] = (val as Field).toString();
      } else if (typeof val === 'bigint') {
        out[key] = val.toString();
      } else if (typeof val === 'string') {
        out[key] = val;
      } else {
        // Fallback: try toString
        try { out[key] = String(val); } catch { console.warn(`[proof-worker] ${jobId}: publicOutput.${key} — cannot serialize (${typeof val})`); }
      }
    }
    console.log(`[proof-worker] ${jobId}: publicOutput keys: [${Object.keys(out).join(', ')}] (${Object.keys(out).length} fields)`);
    result.publicOutput = out;
  } else if (methodDef.hasPublicOutput) {
    console.warn(`[proof-worker] ${jobId}: hasPublicOutput=true but proof.publicOutput is ${proveResult?.proof?.publicOutput === undefined ? 'undefined' : 'null'}`);
  }

  process.send!({ type: 'result', jobId, result });
}

// ─── IPC Message Handler ──────────────────────────────────

process.on('message', async (msg: ProofCoordinatorMessage) => {
  switch (msg.type) {
    case 'compile':
      try {
        await handleCompile();
      } catch (err: any) {
        process.send!({ type: 'error', jobId: '__compile__', message: err.message || String(err) });
      }
      break;

    case 'prove':
      try {
        await handleProve(msg.jobId, msg.request);
      } catch (err: any) {
        process.send!({ type: 'error', jobId: msg.jobId, message: err.message || String(err) });
      }
      break;

    case 'shutdown':
      process.exit(0);
      break;
  }
});

process.on('disconnect', () => process.exit(0));

// ─── Crash Diagnostics ────────────────────────────────────

process.on('uncaughtException', (err) => {
  const mem = process.memoryUsage();
  console.error(`[proof-worker] UNCAUGHT EXCEPTION — RSS: ${Math.round(mem.rss / 1024 / 1024)}MB, Heap: ${Math.round(mem.heapUsed / 1024 / 1024)}/${Math.round(mem.heapTotal / 1024 / 1024)}MB`);
  console.error(`[proof-worker] ${err.stack || err.message || err}`);
  try {
    process.send!({ type: 'error', jobId: '__crash__', message: `Uncaught: ${err.message || err}` });
  } catch { /* IPC may be dead */ }
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  const mem = process.memoryUsage();
  const msg = reason instanceof Error ? reason.stack || reason.message : String(reason);
  console.error(`[proof-worker] UNHANDLED REJECTION — RSS: ${Math.round(mem.rss / 1024 / 1024)}MB, Heap: ${Math.round(mem.heapUsed / 1024 / 1024)}/${Math.round(mem.heapTotal / 1024 / 1024)}MB`);
  console.error(`[proof-worker] ${msg}`);
  try {
    process.send!({ type: 'error', jobId: '__crash__', message: `Unhandled rejection: ${msg}` });
  } catch { /* IPC may be dead */ }
  process.exit(1);
});
