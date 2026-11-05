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
 * Shamir secret sharing over GF(2^8) — the key ceremony (owner, 2026-11-04).
 *
 * A node's master secret is made at a ceremony and split among key holders, so no one person ever
 * holds it: any `threshold` shares rebuild it, and fewer give no information about it. A secret is
 * split byte by byte. Each byte is the constant term of a random polynomial of degree threshold - 1,
 * and share i holds every polynomial's value at x = i; Lagrange interpolation at x = 0 gives the bytes
 * back from any `threshold` shares. Two shares of a 3-of-5 split fit every value of the secret equally
 * well, which is what lets two holders together learn nothing.
 *
 * The field is GF(2^8) with the AES polynomial x^8 + x^4 + x^3 + x + 1. Share bytes and polynomial
 * coefficients are secret, so multiplication is written without branches or table lookups on its
 * operands; only the share indices, which are public, go through an inversion.
 *
 * A share carries no check of its own: a wrong or forged share rebuilds a wrong secret without an
 * error. The ceremony record carries a check value of each secret for that (ceremony.ts).
 */
import { randomBytes } from 'crypto';

export interface SecretShare {
  /** The x-coordinate, 1 to 255: public, and distinct within a split. */
  index: number;
  /** The polynomials' values at `index`, one byte for each byte of the secret. */
  value: Buffer;
}

export const MAX_SHARES = 255;
export const MAX_SECRET_BYTES = 1024;

/** a × b in GF(2^8), with no branch or table lookup on either operand. */
export function gfMul(a: number, b: number): number {
  let product = 0;
  for (let i = 0; i < 8; i++) {
    product ^= -(b & 1) & a;
    const carry = -((a >> 7) & 1) & 0x1b;
    a = ((a << 1) & 0xff) ^ carry;
    b >>= 1;
  }
  return product & 0xff;
}

/** a⁻¹ in GF(2^8), computed as a^254. */
export function gfInv(a: number): number {
  if (a === 0) throw new Error('gfInv: 0 has no inverse');
  let result = 1;
  let power = a;
  for (let bit = 1; bit < 8; bit++) {
    power = gfMul(power, power);
    result = gfMul(result, power);
  }
  return result;
}

/**
 * Split `secret` into `count` shares, any `threshold` of which rebuild it. `rng` is injectable for
 * tests only; it must return exactly the bytes asked for.
 */
export function splitSecret(
  secret: Uint8Array,
  threshold: number,
  count: number,
  rng: (n: number) => Buffer = randomBytes,
): SecretShare[] {
  if (!(secret instanceof Uint8Array) || secret.length === 0 || secret.length > MAX_SECRET_BYTES) {
    throw new Error(`splitSecret: the secret must be 1 to ${MAX_SECRET_BYTES} bytes`);
  }
  if (!Number.isInteger(threshold) || threshold < 2) {
    throw new Error('splitSecret: the threshold must be at least 2; one share would be the secret itself');
  }
  if (!Number.isInteger(count) || count < threshold) {
    throw new Error('splitSecret: the number of shares must be at least the threshold');
  }
  if (count > MAX_SHARES) throw new Error(`splitSecret: there can be at most ${MAX_SHARES} shares`);

  const degree = threshold - 1;
  const width = secret.length;
  // coefficients[j * width + b] is byte b's coefficient of x^(j + 1)
  const coefficients = rng(degree * width);
  if (!Buffer.isBuffer(coefficients) || coefficients.length !== degree * width) {
    throw new Error('splitSecret: the rng did not return the random bytes asked for');
  }
  try {
    const shares: SecretShare[] = [];
    for (let x = 1; x <= count; x++) {
      const value = Buffer.alloc(width);
      for (let b = 0; b < width; b++) {
        let y = 0;
        for (let j = degree - 1; j >= 0; j--) y = gfMul(y, x) ^ coefficients[j * width + b];
        value[b] = gfMul(y, x) ^ secret[b];
      }
      shares.push({ index: x, value });
    }
    return shares;
  } finally {
    coefficients.fill(0);
  }
}

/**
 * Rebuild a secret from shares of one split. Given fewer than the split's threshold, or a share from
 * another split, this returns a wrong value rather than failing; check the result against the
 * ceremony record's check value.
 */
export function combineShares(shares: readonly SecretShare[]): Buffer {
  if (!Array.isArray(shares) || shares.length < 2) throw new Error('combineShares: at least 2 shares are needed');
  const width = shares[0]?.value?.length ?? 0;
  const seen = new Set<number>();
  for (const share of shares) {
    if (!Number.isInteger(share.index) || share.index < 1 || share.index > MAX_SHARES) {
      throw new Error('combineShares: a share index must be 1 to 255');
    }
    if (seen.has(share.index)) throw new Error(`combineShares: share ${share.index} was given twice`);
    seen.add(share.index);
    if (!Buffer.isBuffer(share.value) || share.value.length !== width || width === 0) {
      throw new Error('combineShares: every share must be the same length');
    }
  }
  // The Lagrange basis at 0: l_i(0) = Π_{j≠i} x_j / (x_j - x_i), where subtraction is XOR. Indices are public.
  const basis = shares.map((si, i) => {
    let numerator = 1;
    let denominator = 1;
    shares.forEach((sj, j) => {
      if (j === i) return;
      numerator = gfMul(numerator, sj.index);
      denominator = gfMul(denominator, sj.index ^ si.index);
    });
    return gfMul(numerator, gfInv(denominator));
  });
  const secret = Buffer.alloc(width);
  for (let b = 0; b < width; b++) {
    let acc = 0;
    for (let i = 0; i < shares.length; i++) acc ^= gfMul(shares[i].value[b], basis[i]);
    secret[b] = acc;
  }
  return secret;
}
