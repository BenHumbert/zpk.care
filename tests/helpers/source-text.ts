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
 * Code as one line, for suites that check what a source file says (a screen escapes a value, a route carries a gate)
 * rather than run it: every run of whitespace is one space, the brackets close up, and the trailing commas a
 * formatter adds go. So a check reads the same whether a call sits on one line or Prettier spreads it over five
 * (cleanup phase 2.2). Flatten both sides: `expect(flat(src)).toContain(flat("fn(a, b)"))`. Never evaluate flattened
 * code: a line comment would swallow the rest of the file.
 */
export function flat(code: string): string {
  return code
    .replace(/\r\n/g, '\n')
    .replace(/\s+/g, ' ')
    .replace(/([([]) /g, '$1')
    .replace(/ ([)\]])/g, '$1')
    .replace(/,([)\]])/g, '$1')
    .replace(/, \}/g, ' }');
}
