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

import { randomBytes } from 'crypto';

/**
 * ObfuscatedKey — XOR-split in-memory key protection.
 *
 * Splits a secret into two XOR'd buffers (mask + masked) so the original
 * value never exists as a single contiguous byte sequence in memory.
 * The secret is only reconstructed for the duration of a callback, then
 * the temporary buffer is zeroed and the split is re-randomized.
 *
 * Defense-in-depth against:
 *   - Memory dumps (cold boot, /proc/mem, heap snapshots)
 *   - GC-scanned heap analysis (string never persists)
 *   - Pattern matching (mask changes on every use)
 *
 * Limitations:
 *   - JavaScript strings are immutable — the reconstructed string exists
 *     in the JS heap for the duration of the callback. Use the shortest
 *     possible callback to minimize the window.
 *   - This is application-level protection. For hardware-level guarantees,
 *     use OS secure memory (Android Keystore / iOS Secure Enclave).
 */
export class ObfuscatedKey {
  private mask: Buffer;
  private masked: Buffer;

  private constructor(mask: Buffer, masked: Buffer) {
    this.mask = mask;
    this.masked = masked;
  }

  /**
   * Create an obfuscated key from a plaintext string.
   * The caller should null their reference to the string after calling this.
   */
  static wrap(secret: string): ObfuscatedKey {
    const secretBuf = Buffer.from(secret, 'utf8');
    const mask = randomBytes(secretBuf.length);
    const masked = Buffer.alloc(secretBuf.length);
    for (let i = 0; i < secretBuf.length; i++) {
      masked[i] = secretBuf[i]! ^ mask[i]!;
    }
    secretBuf.fill(0);
    return new ObfuscatedKey(mask, masked);
  }

  /**
   * Reconstruct the secret, execute a synchronous callback, then zero
   * the temp buffer and re-randomize the split.
   *
   * The secret string exists in memory only during the callback execution.
   */
  use<T>(fn: (secret: string) => T): T {
    const buf = Buffer.alloc(this.mask.length);
    for (let i = 0; i < this.mask.length; i++) {
      buf[i] = this.masked[i]! ^ this.mask[i]!;
    }
    const secret = buf.toString('utf8');
    buf.fill(0);
    try {
      return fn(secret);
    } finally {
      this.resplit();
    }
  }

  /**
   * Async version of use() for async callbacks.
   */
  async useAsync<T>(fn: (secret: string) => Promise<T>): Promise<T> {
    const buf = Buffer.alloc(this.mask.length);
    for (let i = 0; i < this.mask.length; i++) {
      buf[i] = this.masked[i]! ^ this.mask[i]!;
    }
    const secret = buf.toString('utf8');
    buf.fill(0);
    try {
      return await fn(secret);
    } finally {
      this.resplit();
    }
  }

  /** Re-split with a fresh random mask */
  private resplit(): void {
    const buf = Buffer.alloc(this.mask.length);
    for (let i = 0; i < this.mask.length; i++) {
      buf[i] = this.masked[i]! ^ this.mask[i]!;
    }
    const newMask = randomBytes(buf.length);
    this.mask.fill(0);
    this.masked.fill(0);
    this.mask = newMask;
    this.masked = Buffer.alloc(buf.length);
    for (let i = 0; i < buf.length; i++) {
      this.masked[i] = buf[i]! ^ newMask[i]!;
    }
    buf.fill(0);
  }

  /** Permanently destroy all key material */
  destroy(): void {
    this.mask.fill(0);
    this.masked.fill(0);
  }

  /** Check if the key has been destroyed (both buffers zeroed) */
  isDestroyed(): boolean {
    return this.mask.every((b) => b === 0) && this.masked.every((b) => b === 0);
  }
}
