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

import { Field, Struct, Poseidon, CircuitString } from 'o1js';

/**
 * Member — maps to NCPDP Patient + Insurance segments (minimum fields).
 *
 * All string data is stored locally on the user's device.
 * Only Poseidon hashes/commitments go on-chain via Merkle trees.
 *
 * NCPDP Source Fields:
 *   302-C2  Cardholder ID Number
 *   304-C4  Date of Birth (CCYYMMDD)
 *   305-C5  Gender Code
 *   310-CA  Patient First Name
 *   311-CB  Patient Last Name
 */
export class MemberData extends Struct({
  /** Poseidon hash of the cardholder ID (302-C2) */
  cardholderIdHash: Field,
  /** Date of birth encoded as numeric CCYYMMDD then converted to Field */
  dateOfBirth: Field,
  /** Gender code (1=Male, 2=Female, 0=Not Specified) */
  genderCode: Field,
  /** Poseidon hash of first name (310-CA) */
  firstNameHash: Field,
  /** Poseidon hash of last name (311-CB) */
  lastNameHash: Field,
}) {
  /**
   * Produces a single commitment representing this member.
   * This is the value stored as a Merkle tree leaf.
   */
  commitment(): Field {
    return Poseidon.hash([
      this.cardholderIdHash,
      this.dateOfBirth,
      this.genderCode,
      this.firstNameHash,
      this.lastNameHash,
    ]);
  }
}

/**
 * Raw member data that lives locally on the user's device.
 * Never transmitted on-chain. Used to generate MemberData commitments.
 */
export interface MemberLocalData {
  cardholderId: string;    // 302-C2
  dateOfBirth: string;     // 304-C4 (CCYYMMDD)
  genderCode: number;      // 305-C5
  firstName: string;       // 310-CA
  lastName: string;        // 311-CB
}
