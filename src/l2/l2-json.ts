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
 * L2 JSON Utilities — BigInt-Safe Serialization
 *
 * L2Receipt, L2Block, L2Batch, AuditEvent all contain bigint fields
 * (sequenceNumber, blockNumber, batchNumber, eventCount, etc.)
 * that JSON.stringify cannot handle natively.
 *
 * This module provides a replacer/reviver pair that encodes bigint
 * values as prefixed strings for safe transport over HTTP.
 */

// ─── Constants ───────────────────────────────────────────

/** Sentinel prefix for bigint values in JSON transport */
export const BIGINT_PREFIX = '__bigint__:';

// ─── Replacer / Reviver ─────────────────────────────────

/**
 * JSON replacer that encodes bigint values as prefixed strings.
 *
 * Usage: JSON.stringify(obj, bigintReplacer)
 *
 * Example: 42n → "__bigint__:42"
 */
export function bigintReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') {
    return BIGINT_PREFIX + value.toString();
  }
  return value;
}

/**
 * JSON reviver that decodes prefixed strings back to bigint.
 *
 * Usage: JSON.parse(str, bigintReviver)
 *
 * Example: "__bigint__:42" → 42n
 */
export function bigintReviver(_key: string, value: unknown): unknown {
  if (typeof value === 'string' && value.startsWith(BIGINT_PREFIX)) {
    const digits = value.slice(BIGINT_PREFIX.length);
    if (!/^-?\d+$/.test(digits)) {
      throw new Error(`Invalid BigInt format: must be decimal digits, got "${digits.slice(0, 20)}..."`);
    }
    if (digits.replace(/^-/, '').length > 100) {
      throw new Error('BigInt value exceeds maximum length (100 digits)');
    }
    return BigInt(digits);
  }
  return value;
}

// ─── Convenience Wrappers ───────────────────────────────

/**
 * Serialize any object to JSON with bigint support.
 * Drop-in replacement for JSON.stringify.
 */
export function l2Stringify(obj: unknown): string {
  return JSON.stringify(obj, bigintReplacer);
}

/**
 * Parse JSON with bigint support.
 * Drop-in replacement for JSON.parse.
 */
export function l2Parse<T = unknown>(json: string): T {
  return JSON.parse(json, bigintReviver) as T;
}
