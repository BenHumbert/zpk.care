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
 * Convert a dollar amount (as number in cents) to a Field.
 * All monetary values are stored as integer cents to avoid decimals.
 */
export function centsToField(cents: number): Field {
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
