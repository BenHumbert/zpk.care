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
 * Pharmacy — maps to NCPDP Transaction Header / Pharmacy Provider segment.
 *
 * NCPDP Source Fields:
 *   201-B1  Service Provider ID Qualifier
 *   202-B2  Service Provider ID (NPI)
 */
export class PharmacyData extends Struct({
  /** Service provider ID qualifier (201-B1) */
  serviceProviderIdQualifier: Field,
  /** Poseidon hash of pharmacy NPI (202-B2) */
  serviceProviderIdHash: Field,
}) {
  commitment(): Field {
    return Poseidon.hash([
      this.serviceProviderIdQualifier,
      this.serviceProviderIdHash,
    ]);
  }
}

/**
 * Raw pharmacy data — lives locally, never on-chain.
 */
export interface PharmacyLocalData {
  serviceProviderIdQualifier: number;  // 201-B1
  serviceProviderId: string;           // 202-B2 (NPI)
}
