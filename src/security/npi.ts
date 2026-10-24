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
 * What a National Provider Identifier looks like — finding A-89, from the review of its fix.
 *
 * An NPI is ten digits, the last a check digit: the Luhn check over the prefix 80840 followed by the first nine digits,
 * the rule CMS publishes for the NPI. The sequencer keys a provider's credential by its NPI's hash and the insurer keys
 * its credentialing applications by the NPI itself, so an NPI is held to that one form where it enters. A value with a
 * space, an invisible character or a wrong check digit is a different string that reads the same on a screen, and it
 * would get past both.
 *
 * No imports, so a node or a tool can check an NPI without loading anything else.
 */

/** Why `npi` is not an NPI, naming the field as `what`; null when it is one. */
export function npiError(npi: unknown, what = 'npi'): string | null {
  if (typeof npi !== 'string' || !/^[0-9]{10}$/.test(npi)) return `${what} must be a National Provider Identifier: ten digits`;
  const digits = '80840' + npi;
  let sum = 0;
  for (let i = digits.length - 1, doubled = false; i >= 0; i--, doubled = !doubled) {
    let d = digits.charCodeAt(i) - 48;
    if (doubled) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0 ? null : `${what} has the wrong check digit for a National Provider Identifier`;
}
