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
 * `npm run texts`: the texts the HR Tool sent on this machine. In the local profile its text service is the outbox
 * (src/tools/text-service.ts), so each employee's enrollment PIN is written to `.zpk/hr-tool/text-outbox.jsonl` instead
 * of a phone; this prints them, newest last, so the member dashboard's enrollment can be finished.
 */
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { HR_TOOL_DIR, ROOT } from './paths.js';

const outbox = process.env.HR_TOOL_TEXT_OUTBOX?.trim() || path.join(HR_TOOL_DIR, 'text-outbox.jsonl');
const shown = path.relative(ROOT, outbox).split(path.sep).join('/');
if (!existsSync(outbox)) {
  console.log(`\n  No texts yet (${shown}): the HR Tool texts each employee's PIN when it imports the roster.\n`);
  process.exit(0);
}
console.log('');
for (const line of readFileSync(outbox, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  try {
    // one JSON line per text: { at, to, body } (OutboxTextService)
    const text = JSON.parse(line) as { at?: string; to?: string; body?: string };
    console.log(`  ${text.at ?? ''}  to ${text.to ?? '?'}: ${text.body ?? line}`);
  } catch {
    console.log(`  ${line}`);
  }
}
console.log(`\n  (${shown})\n`);
