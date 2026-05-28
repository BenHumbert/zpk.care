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

export {
  hashString,
  hashStrings,
  dateToField,
  hashDate,
  centsToField,
  codeToField,
  quantityToField,
} from './hash-utils.js';

export {
  TREE_HEIGHT,
  ForestMerkleWitness,
  ForestDomain,
  MerkleForest,
} from './merkle-forest.js';

export {
  buildMemberData,
  buildPrescriberData,
  buildPharmacyData,
  buildMedicationData,
  buildMedicationPricingData,
  buildTransactionHeaderData,
  generateMemberIdentifier,
} from './commitment.js';
