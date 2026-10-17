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
 * formulary-loader.ts — Lightweight NADAC formulary data loader.
 *
 * Exports raw FormularyJson records for loading into FormularyService.
 * Separate from index.ts to avoid pulling in all seed data (prescribers, pharmacies, members)
 * when only the formulary is needed (e.g., Leviathan startup).
 */

import * as fs from 'fs';
import * as path from 'path';

const _dataDir = path.resolve(
  process.env.ZKP_DATA_DIR ||
  path.join(process.cwd(), 'src', 'data'),
);

export interface FormularyJson {
  ndc: string;
  ndcFormatted: string;
  description: string;
  classification: string;
  nadacPerUnit: number;
  pricingUnit: string;
  otc: boolean;
  effectiveDate: string;
  tierLevel: number;
  copayAmount: number;
  requiresPriorAuth: boolean;
  maxQuantityPerFill: number;
  maxDaySupply: number;
  stepTherapyRequired: boolean;
}

/**
 * `ZKTRIDENT_FORMULARY_LIMIT` was documented and passed by three npm scripts, and this loader
 * ignored it, so every sequencer boot loaded all 32,768 NADAC drugs no matter what was asked
 * for. That is not mainly a parse cost: `FormularyService.loadFromNadac` inserts each drug into
 * a height-16 MerkleTree one leaf at a time, and every `setLeaf` rehashes the path to the root,
 * so the full set is about 491,000 Poseidon hashes on the main thread before the RPC server
 * can open its port.
 *
 * `src/data/index.ts` already had this and already shipped `formulary-100.json`; only this file,
 * the one the sequencer actually imports, was missing it. Same convention: a limit at or below
 * the prepared subset's size reads the subset, and any other positive limit slices the full set.
 * Unset, nothing changes and the whole formulary loads.
 */
const limit = parseInt(process.env.ZKTRIDENT_FORMULARY_LIMIT || '0', 10);
const SUBSET_SIZE = 100;

function load(name: string): FormularyJson[] {
  return JSON.parse(fs.readFileSync(path.join(_dataDir, name), 'utf-8')) as FormularyJson[];
}

export const formularyRaw: FormularyJson[] =
  limit > 0 && limit <= SUBSET_SIZE
    ? load('formulary-100.json').slice(0, limit)
    : limit > 0
      ? load('formulary.json').slice(0, limit)
      : load('formulary.json');
