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
 * The HR Tool texts each enrollment PIN straight to its employee (A-109, owner decision 2026-11-03), with A-140 and
 * A-141. The parts below the server; tests/hr-tool-lockdown.test.ts drives the server itself.
 *
 * What was wrong:
 * - The HR Tool showed every PIN to HR, for HR to text by hand, and could show any PIN again, so anyone who could
 *   unlock it held both halves of every unused invite.
 * - The reconcile reported every unredeemed invite as a mismatch (A-140).
 * - The command-line import issued codes with no PIN, which the employer node refuses to redeem (A-141).
 *
 * Now:
 * - A text service sends each PIN: a local outbox for a demonstration and the live harness, a real SMS provider once
 *   the operator has one. With none set, the HR Tool issues no invite.
 * - The roster's `mobile` column is the number the PIN goes to; screens show its last four digits.
 * - An unredeemed invite is what the employer node calls pending.
 * - The command-line import refuses, pointing at the HR Tool.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { OutboxTextService, textServiceFromEnv, normalizeMobile, maskMobile, TEXTS } from '../src/tools/text-service.js';
import { parseCsv, reconcile, type CorrelationEntry } from '../src/tools/hr-tool-core.js';

const REPO = path.resolve(__dirname, '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hr-texts-'));
const readOutbox = (file: string) => fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));

describe('the text service', () => {
  test('the outbox writes one JSON line per text, to the number given', async () => {
    const file = path.join(tmp(), 'texts.jsonl');
    const outbox = new OutboxTextService(file);
    await outbox.send({ to: '+15555550101', body: 'first' });
    await outbox.send({ to: '5555550102', body: 'second' });
    const lines = readOutbox(file);
    expect(lines.map((l) => [l.to, l.body])).toEqual([['+15555550101', 'first'], ['5555550102', 'second']]);
    expect(Number.isNaN(Date.parse(lines[0].at))).toBe(false);
    expect(outbox.description).toMatch(/outbox/);
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o077).toBe(0);   // its owner's alone
  });

  test('HR_TOOL_TEXT_SERVICE picks it: unset is none, outbox is the outbox, anything else stops the start', () => {
    const dir = tmp();
    expect(textServiceFromEnv({}, dir)).toBeNull();
    expect(textServiceFromEnv({ HR_TOOL_TEXT_SERVICE: '  ' }, dir)).toBeNull();
    const byDefault = textServiceFromEnv({ HR_TOOL_TEXT_SERVICE: 'outbox' }, dir) as OutboxTextService;
    expect(byDefault.file).toBe(path.join(dir, 'text-outbox.jsonl'));
    const named = textServiceFromEnv({ HR_TOOL_TEXT_SERVICE: 'outbox', HR_TOOL_TEXT_OUTBOX: path.join(dir, 'x.jsonl') }, dir) as OutboxTextService;
    expect(named.file).toBe(path.join(dir, 'x.jsonl'));
    expect(() => textServiceFromEnv({ HR_TOOL_TEXT_SERVICE: 'carrier-pigeon' }, dir)).toThrow(/HR_TOOL_TEXT_SERVICE/);
  });
});

describe('mobile numbers', () => {
  test('a number is digits with an optional leading +, separators dropped', () => {
    expect(normalizeMobile('+1 (555) 555-0101')).toBe('+15555550101');
    expect(normalizeMobile('555.555.0102')).toBe('5555550102');
    expect(normalizeMobile(' +44 20 7946 0958 ')).toBe('+442079460958');
    for (const bad of ['', 'call me', '12345', '+1234567890123456', '555-0101 ext 4', '++15555550101', undefined, null, 5555550101]) {
      expect([bad, normalizeMobile(bad)]).toEqual([bad, null]);
    }
  });

  test('a screen shows the last four digits', () => {
    expect(maskMobile('+15555550101')).toBe('•••0101');
  });

  test('the roster\'s mobile column is read as the employee\'s number, not kept as an extra column', () => {
    const [row] = parseCsv('employee_id,family_id,first_name,last_name,dob,mobile\nE-1,F-1,Avery,Lindqvist,19900101,+1 555 555 0101');
    expect(row.mobile).toBe('+1 555 555 0101');
    expect(row.extra).toEqual({});
    const [none] = parseCsv('employee_id,family_id,first_name,last_name,dob\nE-2,F-2,Rowan,Ashgrove,19921103');
    expect(none.mobile).toBeUndefined();
  });
});

describe('the texts', () => {
  test('the PIN text carries the PIN and the warning that no one will ask for it', () => {
    const body = TEXTS.pin('48213976');
    expect(body).toContain('48213976');
    expect(body).toMatch(/No one from HR or your health plan will ever ask/);
  });

  test('a replacing PIN says the earlier invite no longer works', () => {
    expect(TEXTS.replacedPin('11112222')).toMatch(/11112222[\s\S]*earlier invite no longer works/);
  });

  test('a change of number goes to the old number, naming only the new one\'s last four digits', () => {
    const body = TEXTS.mobileChanged('•••0199');
    expect(body).toContain('•••0199');
    expect(body).toMatch(/If you did not ask for this/);
  });

  test('the notices say what became of the invite, what to do if it was not the employee, and carry no PIN', () => {
    expect(TEXTS.inviteUsed()).toMatch(/was just used[\s\S]*If that was not you/);
    expect(TEXTS.inviteLocked()).toMatch(/locked after five wrong PINs[\s\S]*If that was not you[\s\S]*new invite/);
    for (const body of [TEXTS.inviteUsed(), TEXTS.inviteLocked()]) expect(body).not.toMatch(/\d{8}/);
  });
});

describe('the reconcile (A-140)', () => {
  const entry = (employeeIdHash: string, status: CorrelationEntry['status']) => ({
    employeeIdHash, familyIdHash: 'f', employeeId: 'e', familyId: 'f', firstName: 'A', lastName: 'B', dob: '19900101', status, createdAt: '',
  }) as CorrelationEntry;

  test('an unredeemed invite, pending on the node, is not a mismatch', () => {
    const r = reconcile([entry('h1', 'token_generated'), entry('h2', 'enrolled'), entry('h3', 'terminated')],
      [{ employeeIdHash: 'h1', status: 'pending' }, { employeeIdHash: 'h2', status: 'enrolled' }, { employeeIdHash: 'h3', status: 'terminated' }]);
    expect(r.statusMismatches).toEqual([]);                                // before: h1, token_generated against pending
    expect(r.matched).toBe(3);
  });

  test('a real difference still is', () => {
    const r = reconcile([entry('h1', 'token_generated'), entry('h2', 'enrolled')],
      [{ employeeIdHash: 'h1', status: 'enrolled' }, { employeeIdHash: 'h2', status: 'terminated' }]);
    expect(r.statusMismatches.map((m) => [m.employeeIdHash, m.localStatus, m.nodeStatus]))
      .toEqual([['h1', 'token_generated', 'enrolled'], ['h2', 'enrolled', 'terminated']]);
  });
});

describe('the command-line import (A-141)', () => {
  test('refuses, since it cannot text a PIN, and points at the HR Tool', () => {
    const run = spawnSync(process.execPath, ['--import', 'tsx', path.join(REPO, 'src', 'tools', 'hr-tool.ts'), 'import', '--group', 'G1', '--csv', 'roster.csv', '--valid-until', '2026-11-10'], {
      cwd: REPO, encoding: 'utf8', timeout: 60_000, env: { ...process.env, HR_TOOL_DATA_DIR: tmp() },
    });
    expect(run.status).toBe(1);                                            // before: it read the roster and issued PIN-less codes
    expect(run.stdout + run.stderr).toMatch(/cannot issue a working invite/);
    expect(run.stdout + run.stderr).toMatch(/npm run start:hr-tool/);
  }, 90_000);
});
