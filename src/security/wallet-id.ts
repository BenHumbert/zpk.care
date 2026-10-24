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
 * What a wallet ID looks like — finding A-74.
 *
 * Every wallet ID the network issues is a Poseidon hash: an element of the Pallas base field that o1js computes in,
 * written in decimal the one way Field.toString() writes it. A registry that keeps an entity under any other string
 * keeps something no wallet can sign for, and hands every screen that lists wallets a value that may carry quotes or
 * markup. Such a value is refused where it enters, never rewritten; screens escape what they draw as well.
 *
 * No imports, so a node or a tool can check an ID without loading o1js. The modulus is o1js's Field.ORDER, and
 * tests/registry-wallet-id-and-name.test.ts holds the two equal.
 */

/** The order of the Pallas base field (o1js Field.ORDER): every field element, so every wallet ID, is below it. */
export const FIELD_MODULUS = 0x40000000000000000000000000000000224698fc094cf91b992d30ed00000001n;

/** "0", or digits that do not start with 0: how Field.toString() writes a value. */
const CANONICAL_DECIMAL = /^(0|[1-9][0-9]*)$/;

/** The most digits a field element has in decimal: the modulus's 77, since every element is below it. */
const MAX_DIGITS = FIELD_MODULUS.toString().length;

/** Why `walletId` is not a wallet ID as the network writes one, naming the field as `what`; null when it is. */
export function walletIdError(walletId: unknown, what = 'walletId'): string | null {
  if (typeof walletId !== 'string' || !CANONICAL_DECIMAL.test(walletId)) {
    return `${what} must be a field element written in decimal: digits only, with no leading zero`;
  }
  // the length first: BigInt reads every digit it is given, so a longer value is refused without being parsed
  if (walletId.length > MAX_DIGITS || BigInt(walletId) >= FIELD_MODULUS) return `${what} must be less than the field modulus`;
  return null;
}
