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
 * The proof pool worker keeps its own table of circuit methods and their argument types, and the engine
 * dispatches by it. When a circuit gains an input, the table must follow, or every live fill fails with
 * "Arg count mismatch" while the unit suites, which call the circuit directly, stay green — which is what
 * B8 did for one live run. This reads both sources and holds the table to the circuits' private inputs.
 */
import fs from 'fs';

const WORKER = 'src/adjudication/proof-pool-worker.ts';
const PROGRAMS: Array<{ program: string; file: string; methods: string[] }> = [
  { program: 'AccumulatorFulfillment', file: 'src/fulfillment/accumulator-fulfillment-program.ts', methods: ['proveFulfillmentWithAccumulator', 'proveReversalWithAccumulator'] },
  { program: 'StateTransition', file: 'src/engine/state-transition.ts', methods: ['proveRegistration', 'proveWalletUpdate'] },
];

/** The number of private inputs a ZkProgram method declares: the entries of its `privateInputs: [...]` array. */
function privateInputCount(src: string, method: string): number {
  const at = src.indexOf(`${method}: {`);
  if (at < 0) throw new Error(`${method} not found`);
  const start = src.indexOf('privateInputs: [', at);
  const end = src.indexOf('],', start);
  const body = src.slice(start + 'privateInputs: ['.length, end).replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  return body.split(',').map((s) => s.trim()).filter(Boolean).length;
}

/** The number of argument types the worker's table lists for a program method. */
function tableArgCount(src: string, program: string, method: string): number {
  const p = src.indexOf(`  ${program}: {`);
  if (p < 0) throw new Error(`${program} not in the worker's table`);
  const m = src.indexOf(`    ${method}: {`, p);
  if (m < 0) throw new Error(`${program}.${method} not in the worker's table`);
  const start = src.indexOf('argTypes: [', m);
  const end = src.indexOf('],', start);
  const body = src.slice(start + 'argTypes: ['.length, end).replace(/\/\/[^\n]*/g, '');
  return (body.match(/'[A-Za-z]+'/g) ?? []).length;
}

describe('the proof pool worker\'s method table', () => {
  const worker = fs.readFileSync(WORKER, 'utf8');
  for (const { program, file, methods } of PROGRAMS) {
    const src = fs.readFileSync(file, 'utf8');
    for (const method of methods) {
      test(`${program}.${method}: the table lists exactly as many argument types as the circuit has private inputs`, () => {
        expect(tableArgCount(worker, program, method)).toBe(privateInputCount(src, method));
      });
    }
  }
});
