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

import { Field, Poseidon, Encoding } from 'o1js';

/**
 * ZK Hashing Utilities
 *
 * All PHI/PII strings are converted to Poseidon hashes before
 * entering any on-chain data structure. These utilities bridge
 * the gap between raw local data and ZK-compatible Field elements.
 */

/**
 * Hash a string into a single Field using Poseidon.
 * Used for names, IDs, and any string PHI/PII.
 */
export function hashString(value: string): Field {
  const fields = Encoding.stringToFields(value);
  return Poseidon.hash(fields);
}

/**
 * Hash multiple strings into a single commitment.
 * Each string is individually hashed, then the hashes are combined.
 */
export function hashStrings(...values: string[]): Field {
  const hashes = values.map((v) => hashString(v));
  return Poseidon.hash(hashes);
}

/**
 * Convert a numeric date string (CCYYMMDD) to a Field.
 * The date is treated as a plain integer.
 */
export function dateToField(dateStr: string): Field {
  const numeric = BigInt(dateStr);
  return Field(numeric);
}

/**
 * H4 fix: Hash a numeric date string (CCYYMMDD) through Poseidon.
 *
 * Unlike dateToField() which stores dates as plain integers (reversible
 * via ~36,500 brute-force attempts), hashDate() produces a Poseidon hash
 * that is computationally irreversible. Used for sensitive dates like DOB
 * in wallet derivation where the date must not be recoverable from on-chain data.
 */
export function hashDate(dateStr: string): Field {
  return Poseidon.hash([Field(BigInt(dateStr))]);
}

/**
 * Convert a dollar amount (as number in cents) to a Field.
 * All monetary values are stored as integer cents to avoid decimals.
 */
export function centsToField(cents: number): Field {
  // M11 fix: Reject negative values. Negative cents would wrap modularly
  // in the finite field, producing an astronomically large value instead
  // of an error. All monetary values must be non-negative.
  if (cents < 0) {
    throw new Error(`centsToField: negative value not allowed (${cents})`);
  }
  return Field(BigInt(cents));
}

/**
 * Convert a small integer code to a Field.
 * Used for gender codes, qualifier codes, compound codes, etc.
 */
export function codeToField(code: number): Field {
  return Field(BigInt(code));
}

/**
 * Convert a quantity with decimals to a Field.
 * Scaled by 1000 to preserve 3 decimal places as an integer.
 */
export function quantityToField(qty: number): Field {
  const scaled = Math.round(qty * 1000);
  return Field(BigInt(scaled));
}
