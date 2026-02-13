/**
 * Secure Memory Scrubbing
 *
 * Zeroes out and nullifies raw PHI/PII data after cryptographic
 * derivation is complete. Ensures no trace of personal information
 * remains in our application's reachable memory.
 *
 * IMPORTANT — JavaScript limitations:
 *   - Strings are immutable and GC-managed. We cannot overwrite
 *     their bytes in place. We CAN remove all references so the
 *     GC can collect them, and we CAN overwrite the property
 *     slots that pointed to them.
 *   - For Uint8Array / Buffer, we CAN zero bytes directly.
 *   - This is defense-in-depth, not a hardware-level guarantee.
 *     Production deployments on sensitive platforms should use
 *     OS-level secure memory (e.g., mlock + explicit_bzero via
 *     native add-ons) for the brief computation window.
 */

/**
 * Scrub all enumerable properties on an object.
 * Sets strings to '', numbers to 0, and all refs to null.
 * Returns the object (now gutted) for chaining.
 */
export function scrubObject<T extends Record<string, unknown>>(obj: T): T {
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (typeof val === 'string') {
      (obj as Record<string, unknown>)[key] = '';
    } else if (typeof val === 'number') {
      (obj as Record<string, unknown>)[key] = 0;
    } else if (typeof val === 'object' && val !== null) {
      if (ArrayBuffer.isView(val)) {
        // Zero typed arrays (Uint8Array, etc.) in place
        new Uint8Array((val as Uint8Array).buffer).fill(0);
      } else if (Array.isArray(val)) {
        scrubArray(val);
      } else {
        scrubObject(val as Record<string, unknown>);
      }
      (obj as Record<string, unknown>)[key] = null;
    } else {
      (obj as Record<string, unknown>)[key] = null;
    }
  }
  return obj;
}

/**
 * Scrub all elements in an array and clear it.
 */
export function scrubArray(arr: unknown[]): void {
  for (let i = 0; i < arr.length; i++) {
    const val = arr[i];
    if (typeof val === 'object' && val !== null) {
      scrubObject(val as Record<string, unknown>);
    }
    arr[i] = null;
  }
  arr.length = 0;
}

/**
 * Scrub a Field array — overwrite each element with Field(0) equivalent,
 * then clear the array.
 */
export function scrubFieldArray(arr: unknown[]): void {
  for (let i = 0; i < arr.length; i++) {
    arr[i] = null;
  }
  arr.length = 0;
}

/**
 * Deep-freeze check — returns true if all string/number properties
 * on the object have been zeroed. Used in tests to verify scrubbing.
 */
export function isScrubbed(obj: Record<string, unknown>): boolean {
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (typeof val === 'string' && val !== '') return false;
    if (typeof val === 'number' && val !== 0) return false;
    if (typeof val === 'object' && val !== null) return false;
  }
  return true;
}
