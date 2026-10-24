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
 * A date-only value is shown as its calendar day in every time zone: the employer node's Groups tab and the member app.
 *
 * What was wrong: the employer dashboard's fmtDateShort ran new Date(value).toLocaleDateString(). A group's effective
 * date is date-only (2026-10-24, from the form's date input), and new Date() reads YYYY-MM-DD as midnight UTC, which is
 * the evening before anywhere west of UTC, so the Groups tab listed the group a day early, under a banner that prints
 * the attestation's effective date (20261024) as 2026-10-24. The member app's fmtDate did the same with YYYY-MM-DD, and
 * read YYYYMMDD, the form in which the device keeps a PCP's effective date, as no date at all: the Providers tab, once
 * it read the PCP back from the device, said "Assigned Invalid Date". Found by the QA of the walkthrough's first voiced
 * take, 2026-10-23: on the employer node's Groups tab the banner read "Effective: 2026-10-24" and the new group's row
 * "10/23/2026", while the HR Tool, which prints the stored value, listed the same group as 2026-10-24.
 *
 * Now both read a date-only value, YYYY-MM-DD or YYYYMMDD, as that day at local midnight, so it is the same day in
 * every zone, and a timestamp is still shown as its local day. The other screens were checked for the same pattern:
 * the HR Tool, the prescriber, the pharmacy and the marketplace print date-only values as text, and every date the
 * insurer and network screens format is a timestamp.
 *
 * A time zone belongs to the process, so the formatters, lifted out of app.js, run in a child node process per zone
 * with TZ set: zones west of UTC (where the old code showed the day before), UTC, and east of it out to UTC+14.
 */
import fs from 'fs';
import { execFileSync } from 'child_process';

const NL = '\n';
const read = (file: string): string => fs.readFileSync(file, 'utf8').replace(/\r\n/g, NL);
const EMPLOYER = read('dashboard-employer/app.js');
const MEMBER = read('dashboard-member/app.js');

/** A top-level function of an IIFE dashboard: from its declaration to the first line that is exactly "  }". */
function lift(src: string, name: string): string {
  let at = src.indexOf(NL + '  function ' + name + '(');
  if (at < 0) at = src.indexOf(NL + '  async function ' + name + '(');
  if (at < 0) throw new Error('no function ' + name);
  const end = src.indexOf(NL + '  }' + NL, at);
  return src.slice(at + 1, end + 4);
}
function run(pieces: string[], scope: Record<string, unknown>, ret: string): any {
  const names = Object.keys(scope);
  return new Function(...names, `'use strict';\n${pieces.join(NL)}\nreturn ${ret};`)(...names.map((n) => scope[n]));
}
const ESC = "(s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\"/g, '&quot;')";

/** West of UTC, where midnight UTC is the evening before; UTC; and east of it, out to UTC+14. */
const ZONES = ['America/Chicago', 'America/Los_Angeles', 'Pacific/Pago_Pago', 'UTC', 'Europe/Berlin', 'Asia/Tokyo', 'Pacific/Kiritimati'];
const OPTS = "{ year: 'numeric', month: 'short', day: 'numeric' }";   // the member app's date format

/** Runs `script` (page code, then a statement that prints JSON) in a fresh node process whose time zone is `zone`. */
function inZone(zone: string, script: string): any {
  const out = execFileSync(process.execPath, ['-'], {
    input: `'use strict';\n${script}`, env: { ...process.env, TZ: zone }, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
  });
  return JSON.parse(out);
}

// The group as the employer node lists it: its effective date as the form's date input sent it.
const GROUP = { groupId: 'GRP-FERNHILL-LAB', planId: 'PLAN-STD-RX-2026', effectiveDate: '2026-10-24', enrollmentCap: 25, enrolledCount: 0, pendingTokens: 0, status: 'active' };

describe('the employer node\'s Groups tab shows a group\'s effective date as the day it was stored with', () => {
  /** The Groups table drawn by loadGroupsTable, and fmtDateShort on each kind of value, in `zone`. */
  const groupsTab = (zone: string) => inZone(zone, [
    lift(EMPLOYER, 'fmtDateShort'),
    lift(EMPLOYER, 'loadGroupsTable'),
    `const esc = ${ESC};`,
    "const table = { innerHTML: '', querySelectorAll: () => [] };",
    "const document = { getElementById: (id) => (id === 'groups-table' ? table : null) };",
    `const API = { listGroups: async () => [${JSON.stringify(GROUP)}] };`,
    "function loading() { return ''; }", "function emptyState() { return ''; }", 'function doDeleteGroup() {}',
    'loadGroupsTable().then(() => process.stdout.write(JSON.stringify({',
    '  zone: Intl.DateTimeFormat().resolvedOptions().timeZone,',
    '  day: new Date(2026, 9, 24).toLocaleDateString(),',
    "  row: (table.innerHTML.match(/<td>([^<]*)<\\/td>/) || [])[1],",
    "  dashed: fmtDateShort('2026-10-24'), compact: fmtDateShort('20261024'),",
    "  iso: fmtDateShort('2026-10-24T02:28:00.000Z'), ms: fmtDateShort(Date.UTC(2026, 9, 24, 2, 28)),",
    '  local: new Date(Date.UTC(2026, 9, 24, 2, 28)).toLocaleDateString(),',
    "  none: fmtDateShort(''),",
    '})));',
  ].join(NL));

  test.each(ZONES)('in %s', (zone) => {
    const r = groupsTab(zone);
    expect(r.zone).toBe(zone);                    // the child really runs in that zone
    expect(r.row).toBe(r.day);                    // before, west of UTC: the day before (10/23/2026 under a 2026-10-24 banner)
    expect(r.dashed).toBe(r.day);
    expect(r.compact).toBe(r.day);                // an attestation's form; before: Invalid Date
    expect(r.iso).toBe(r.local);                  // a timestamp is still shown as its local day
    expect(r.ms).toBe(r.local);
    expect(r.none).toBe('--');
  });
});

describe('the member app shows a date-only value as its day', () => {
  test.each(ZONES)('fmtDate in %s', (zone) => {
    const r = inZone(zone, [
      lift(MEMBER, 'fmtDate'),
      'process.stdout.write(JSON.stringify({',
      '  zone: Intl.DateTimeFormat().resolvedOptions().timeZone,',
      `  day: new Date(2026, 9, 24).toLocaleDateString([], ${OPTS}),`,
      "  dashed: fmtDate('2026-10-24'), compact: fmtDate('20261024'),",
      "  iso: fmtDate('2026-10-24T02:28:00.000Z'), ms: fmtDate(Date.UTC(2026, 9, 24, 2, 28)),",
      `  local: new Date(Date.UTC(2026, 9, 24, 2, 28)).toLocaleDateString([], ${OPTS}),`,
      '}));',
    ].join(NL));
    expect(r.zone).toBe(zone);
    expect(r.dashed).toBe(r.day);                 // before, west of UTC: the day before
    expect(r.compact).toBe(r.day);                // before: Invalid Date
    expect(r.iso).toBe(r.local);
    expect(r.ms).toBe(r.local);
  });

  test('the Providers tab reads the PCP back from the device and says the day she was assigned, not "Invalid Date"', () => {
    const body = { innerHTML: '' };
    const renderPcp = run(['shortHash', 'esc', 'fmtDate', 'renderPcp'].map((n) => lift(MEMBER, n)), {
      $: (id: string) => (id === 'pcp-body' ? body : null),
      providersCache: [{ walletId: '22772015471886', displayName: 'Dr. Miriam Fallowmere, MD' }],
    }, 'renderPcp');
    // GET /pcp/current: the assignment as the device keeps it, its effective date as RPC.assignPcp sent it
    renderPcp({ pcpWalletId: '22772015471886', effectiveDate: '20261024', commitment: '1', consentScopeFlags: 7, assignedAt: Date.UTC(2026, 9, 24, 2, 40) });
    const day = new Date(2026, 9, 24).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
    expect(body.innerHTML).toContain('Dr. Miriam Fallowmere, MD');
    expect(body.innerHTML).toContain('Assigned ' + day + '</div>');
    expect(body.innerHTML).not.toContain('Invalid Date');               // before: "Assigned Invalid Date"
  });
});
