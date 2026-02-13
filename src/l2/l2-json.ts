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
    return BigInt(value.slice(BIGINT_PREFIX.length));
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
