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
 * The employer node's invites: a fingerprint of each code, at most 14 days, one per employee, and none for someone
 * who has left (A-109, owner decision 2026-11-03; A-135; A-138).
 *
 * What was wrong:
 * - The node kept every code as issued, beside the hash of its PIN. The code is the PIN hash's other input, so a copy
 *   of the node's records gave up each unused invite's PIN in hours: 100 million tries.
 * - Removing an employee from the roster left the unused invite working. Redeeming it marked the row enrolled again.
 * - A new invite for an employee left the old one live, so one employee could hold two working invites.
 * - An enrolled employee could be issued a second invite, and so enroll a second wallet.
 * - An invite's expiry was whatever the HR Tool sent: the HR Tool's page offered a year.
 *
 * Now:
 * - The node keeps only each code's one-way fingerprint, the Poseidon hash the invite's own struct carries.
 * - An invite is withdrawn when its employee leaves the roster or gets a new invite.
 * - An enrolled employee gets no second invite.
 * - An invite lasts at most 14 days.
 */
import { EmployerNode } from '../src/nodes/employer-node.js';
import { hashString } from '../src/zkp/hash-utils.js';
import { hashTokenPIN } from '../src/tools/hr-tool-core.js';
import { INVITE_MAX_DAYS, inviteExpiryProblem } from '../src/onboarding/token-authority.js';

const PIN = '12345678';
const DAY_MS = 86_400_000;
const compact = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, '');
const inDays = (n: number) => compact(new Date(Date.now() + n * DAY_MS));
const iso = (ccyymmdd: string) => `${ccyymmdd.slice(0, 4)}-${ccyymmdd.slice(4, 6)}-${ccyymmdd.slice(6, 8)}`;

function freshNode(): EmployerNode {
  const node = new EmployerNode({ role: 'employer', sequencerUrl: 'http://127.0.0.1:1', employerId: 'INVITES-TEST' });
  node.createGroup('G1', 'PLAN-1', '20260101', 10);
  return node;
}
/** An invite for the employee, with its PIN bound, as the HR Tool issues one. */
function issue(node: EmployerNode, employeeIdHash: string, days = 7): string {
  const { tokenId } = node.generateToken('G1', employeeIdHash, `fam-${employeeIdHash}`, inDays(days));
  node.setTokenPinHash(tokenId, hashTokenPIN(tokenId, PIN));
  return tokenId;
}
const redeem = (node: EmployerNode, code: string, pin = PIN) => node.redeemTokenWithPin(code, inDays(0), hashTokenPIN(code, pin));

describe('the node keeps a fingerprint of each code, never the code', () => {
  test('the roster and the stored record carry the fingerprint, and the code still redeems', () => {
    const node = freshNode();
    const code = issue(node, 'emp-1');
    const fingerprint = hashString(code).toString();
    const row = node.getRosterEntry('emp-1') as unknown as Record<string, unknown>;
    expect(row.tokenIdHash).toBe(fingerprint);
    expect('tokenId' in row).toBe(false); // before: the code itself
    expect(JSON.stringify(node.listRoster())).not.toContain(code);
    const record = node.getTokenRecord(code) as unknown as Record<string, unknown>;
    expect(record.tokenIdHash).toBe(fingerprint);
    expect('tokenId' in record).toBe(false); // before: the code itself
    expect(JSON.stringify({ ...record, token: undefined })).not.toContain(code);
    expect(redeem(node, code)).toMatchObject({ valid: true, consumed: true });
    expect(node.getRosterEntry('emp-1')!.status).toBe('enrolled');
  });
});

describe('an invite follows its roster entry (A-135)', () => {
  test('removing an employee withdraws the unused invite, and the row stays removed', () => {
    const node = freshNode();
    const code = issue(node, 'emp-2');
    node.terminateRosterEntry('emp-2');
    expect(node.getTokenRecord(code)!.status).toBe('revoked'); // before: 'unused'
    expect(redeem(node, code).valid).toBe(false); // before: redeemed
    expect(node.getRosterEntry('emp-2')!.status).toBe('terminated'); // before: 'enrolled' again
    expect(node.getGroup('G1')!.enrolledCount).toBe(0);
  });

  test('a new invite for an employee withdraws the previous one', () => {
    const node = freshNode();
    const first = issue(node, 'emp-3');
    const second = issue(node, 'emp-3');
    expect(node.getTokenRecord(first)!.status).toBe('revoked'); // before: 'unused', a second working invite
    expect(redeem(node, first).valid).toBe(false);
    expect(redeem(node, second)).toMatchObject({ valid: true, consumed: true });
    expect(node.listRoster().filter((e) => e.employeeIdHash === 'emp-3')).toHaveLength(1);
  });

  test('an employee who has enrolled is not issued a second invite', () => {
    const node = freshNode();
    expect(redeem(node, issue(node, 'emp-4')).valid).toBe(true);
    expect(() => issue(node, 'emp-4')).toThrow(/already enrolled/); // before: a second invite, a second wallet
    expect(node.getRosterEntry('emp-4')!.status).toBe('enrolled');
    expect(node.getGroup('G1')!.enrolledCount).toBe(1);
  });

  test('an employee removed and then taken back on is issued a fresh invite', () => {
    const node = freshNode();
    const old = issue(node, 'emp-5');
    node.terminateRosterEntry('emp-5');
    const fresh = issue(node, 'emp-5');
    expect(redeem(node, old).valid).toBe(false);
    expect(redeem(node, fresh)).toMatchObject({ valid: true, consumed: true });
    expect(node.getRosterEntry('emp-5')!.status).toBe('enrolled');
  });

  test("a redemption that crosses the employee's removal is refused, and the invite withdrawn", () => {
    const node = freshNode();
    const code = issue(node, 'emp-6');
    node.getRosterEntry('emp-6')!.status = 'terminated'; // the removal landed first, as if they crossed
    const verdict = redeem(node, code);
    expect(verdict.valid).toBe(false); // before: redeemed, and the row enrolled again
    expect(verdict.reason).toMatch(/no longer on the employer's roster/);
    expect(node.getTokenRecord(code)!.status).toBe('revoked');
    expect(node.getRosterEntry('emp-6')!.status).toBe('terminated');
    expect(node.getGroup('G1')!.enrolledCount).toBe(0);
  });
});

describe('an invite lasts at most 14 days (A-138)', () => {
  test('the limit is 14 days', () => {
    expect(INVITE_MAX_DAYS).toBe(14);
  });

  test('a calendar date from today to 14 days out is accepted, in either spelling', () => {
    for (const d of [inDays(0), inDays(1), inDays(14)]) expect([d, inviteExpiryProblem(d)]).toEqual([d, null]);
    expect(inviteExpiryProblem(iso(inDays(7)))).toBeNull();
  });

  test('anything else is refused, saying why', () => {
    expect(inviteExpiryProblem(inDays(15))).toMatch(/at most 14 days/);
    expect(inviteExpiryProblem(inDays(365))).toMatch(/at most 14 days/);
    expect(inviteExpiryProblem(inDays(-1))).toMatch(/already past/);
    for (const bad of ['', '2026-13-01', '20260230', 'tomorrow', '2026111', '20261103x', '2026-1-05', undefined, null, 20261110]) {
      expect([bad, inviteExpiryProblem(bad)]).toEqual([bad, expect.stringMatching(/calendar date/)]);
    }
  });

  test('the node issues no invite beyond the limit', () => {
    const node = freshNode();
    expect(() => node.generateToken('G1', 'emp-7', 'fam-7', inDays(15))).toThrow(/at most 14 days/); // before: issued
    expect(() => node.generateToken('G1', 'emp-7', 'fam-7', '20271231')).toThrow(/at most 14 days/);
    expect(node.getRosterEntry('emp-7')).toBeUndefined();
    expect(() => node.generateToken('G1', 'emp-7', 'fam-7', iso(inDays(14)))).not.toThrow();
  });
});

describe("the roster says what became of each invite, for the HR Tool's notices (A-109)", () => {
  const inviteOf = (node: EmployerNode, employeeIdHash: string) =>
    (node.listRoster().find((e) => e.employeeIdHash === employeeIdHash) as unknown as { inviteStatus?: string }).inviteStatus;

  test('unused, then consumed once redeemed', () => {
    const node = freshNode();
    const code = issue(node, 'emp-8');
    expect(inviteOf(node, 'emp-8')).toBe('unused'); // before: no such column
    redeem(node, code);
    expect(inviteOf(node, 'emp-8')).toBe('consumed');
  });

  test('locked after five wrong PINs, before any other answer', () => {
    const node = freshNode();
    const code = issue(node, 'emp-9');
    for (let i = 0; i < 5; i++) expect(redeem(node, code, '00000000').valid).toBe(false);
    expect(inviteOf(node, 'emp-9')).toBe('locked');
    expect(redeem(node, code).valid).toBe(false); // the right PIN no longer opens it
    expect(inviteOf(node, 'emp-9')).toBe('locked');
  });

  test('revoked when the employee leaves, expired once past its date', () => {
    const node = freshNode();
    issue(node, 'emp-10');
    node.terminateRosterEntry('emp-10');
    expect(inviteOf(node, 'emp-10')).toBe('revoked');
    const code = issue(node, 'emp-11');
    node.getTokenRecord(code)!.validUntil = inDays(-1); // as if two weeks went by
    expect(inviteOf(node, 'emp-11')).toBe('expired');
  });

  test('the roster still carries no code and no wallet', () => {
    const node = freshNode();
    const code = issue(node, 'emp-12');
    redeem(node, code);
    const text = JSON.stringify(node.listRoster());
    expect(text).not.toContain(code);
    expect(text).not.toMatch(/wallet/i);
  });
});
