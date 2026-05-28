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

import { Field, Struct, Poseidon } from 'o1js';

/**
 * Prescriber — maps to NCPDP Prescriber segment (minimum fields).
 *
 * NCPDP Source Fields:
 *   465-EY  Prescriber ID Qualifier (01=NPI)
 *   411-DB  Prescriber ID (NPI Number)
 */
export class PrescriberData extends Struct({
  /** Prescriber ID qualifier (01=NPI, 12=DEA, 16=State License) */
  prescriberIdQualifier: Field,
  /** Poseidon hash of the prescriber NPI (411-DB) */
  prescriberIdHash: Field,
}) {
  commitment(): Field {
    return Poseidon.hash([
      this.prescriberIdQualifier,
      this.prescriberIdHash,
    ]);
  }
}

/**
 * Raw prescriber data — lives locally, never on-chain.
 */
export interface PrescriberLocalData {
  prescriberIdQualifier: number;  // 465-EY
  prescriberId: string;           // 411-DB (NPI)
}
