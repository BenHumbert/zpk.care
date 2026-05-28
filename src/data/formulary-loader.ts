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

const filePath = path.join(_dataDir, 'formulary.json');
export const formularyRaw: FormularyJson[] = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
