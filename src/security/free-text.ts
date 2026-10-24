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
 * Free text one party types and another party's screen shows: a prescriber's reason for a prior-authorization request,
 * which reaches the insurer, and an insurer's reason for a denial, which reaches the prescriber. Both travel in engine
 * messages that the operator console also displays, and the console holds the network's operator token, so the text is
 * held to plain text where it enters: no '<' or '>', which a screen that forgets to escape would read as markup, and no
 * control characters other than a line break, which can rewrite a log line or a terminal. Text that breaks the rule is
 * refused, never rewritten, so the person who typed it sees why and words it again. Screens escape it as well.
 *
 * A display name is held to the same rule and to one short line (A-74, A-61): the name an entity registers on the
 * sequencer (l2_registerEntity) and the name a member's device gives the engine (register-member) are drawn by every
 * screen that lists wallets, the operator console's among them.
 *
 * No imports: the engine and the provider nodes share it.
 */

/** C0 controls other than the line feed, DEL, and the C1 controls. */
const CONTROL_CHARACTERS = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/;

/** Every control character, the line feed included: a display name is one line. */
const ANY_CONTROL_CHARACTER = /[\u0000-\u001F\u007F-\u009F]/;

/** The longest display name an entity may register, in characters: a person's name with credentials, or a store's. */
export const DISPLAY_NAME_MAX_LENGTH = 100;

/** Why `text` may not be kept as plain text, naming the field as `what`; null when it may. */
export function plainTextError(text: string, what = 'reason'): string | null {
  if (/[<>]/.test(text)) return `${what} may not contain < or >: write "less than" or "greater than"`;
  if (CONTROL_CHARACTERS.test(text)) return `${what} may not contain control characters other than a line break`;
  return null;
}

/** Why `name` may not be registered as a display name, naming the field as `what`; null when it may. */
export function displayNameError(name: unknown, what = 'displayName'): string | null {
  if (typeof name !== 'string') return `${what} must be text`;
  if (name.trim() === '') return `${what} may not be blank`;
  if (name.length > DISPLAY_NAME_MAX_LENGTH) return `${what} may be at most ${DISPLAY_NAME_MAX_LENGTH} characters`;
  if (ANY_CONTROL_CHARACTER.test(name)) return `${what} may not contain control characters`;
  if (/[<>]/.test(name)) return `${what} may not contain < or >`;
  return null;
}
