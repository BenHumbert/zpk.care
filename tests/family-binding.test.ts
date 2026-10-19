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
 * Who pools with whom: B8, with finding A-34.
 *
 * The family is the one the employer's enrollment code carries, as an opaque per-group hash. The
 * employer's validation answer names it, the insurer keeps it with the redeemed code and names it in its
 * approval, and the engine binds the member's family from that approval, never from a request. Pooling
 * stays inside one family, one group and one plan, and a member with no bound family pools with no one.
 * Before this, every member enrolled from a device had an empty family ID, and the engine pooled all of
 * them as one family, first in its post-proof rewrite and then, in B8's first cut, in the proof's inputs.
 */
import fs from 'fs';
import { familyMembersOf, familyLimitsFor } from '../src/adjudication/interactive-service.js';
import { TokenAuthority } from '../src/onboarding/token-authority.js';
import { hashTokenPIN } from '../src/tools/hr-tool-core.js';

type M = { key: string; familyId: string; groupId: string; planId: string };
const m = (key: string, familyId: string, groupId = 'G1', planId = 'PLAN-1'): M => ({ key, familyId, groupId, planId });
const keys = (ms: M[]) => ms.map((x) => x.key).sort();

describe('who pools with whom', () => {
  test('a member with no bound family pools with no one, however many others have none (A-34)', () => {
    const a = m('a', ''), b = m('b', ''), c = m('c', '');
    expect(keys(familyMembersOf(a, [a, b, c]))).toEqual(['a']);
  });

  test('members who share a bound family in one group and plan pool together, and no one else does', () => {
    const parent = m('parent', '111'), child = m('child', '111'), other = m('other', '222'), loner = m('loner', '');
    const all = [parent, child, other, loner];
    expect(keys(familyMembersOf(child, all))).toEqual(['child', 'parent']);
    expect(keys(familyMembersOf(other, all))).toEqual(['other']);
    expect(keys(familyMembersOf(loner, all))).toEqual(['loner']);
  });

  test('the same family hash under another group or another plan does not pool', () => {
    const a = m('a', '111'), otherGroup = m('g', '111', 'G2'), otherPlan = m('p', '111', 'G1', 'PLAN-2');
    expect(keys(familyMembersOf(a, [a, otherGroup, otherPlan]))).toEqual(['a']);
  });

  test('the member is always in its own family, even when the list does not hold it', () => {
    const a = m('a', '111');
    expect(keys(familyMembersOf(a, [m('b', '111')]))).toEqual(['a', 'b']);
  });
});

describe('the family limits', () => {
  const plan = { familyDeductibleAmountCents: 100000, familyOopMaxCents: 1600000, familyAnnualBenefitMaxCents: 0 };
  const none = { familyDeductibleAmountCents: 0, familyOopMaxCents: 0, familyAnnualBenefitMaxCents: 0 };

  test('a member with a bound family gets the plan\'s', () => {
    expect(familyLimitsFor({ familyId: '111' }, plan)).toEqual(plan);
  });

  test('a member with no family gets none, and so does a plan that sets none', () => {
    expect(familyLimitsFor({ familyId: '' }, plan)).toEqual(none);
    expect(familyLimitsFor({ familyId: '111' }, {})).toEqual(none);
    expect(familyLimitsFor({ familyId: '111' }, undefined)).toEqual(none);
  });
});

describe('the employer\'s code carries the family', () => {
  const DATE = '20261018';
  const PIN = '135790';
  function redeem(authority: TokenAuthority, familyIdHash: string, employeeIdHash: string) {
    const { tokenId } = authority.generateToken('G1', 'PLAN-1', employeeIdHash, familyIdHash, '20271231');
    authority.setTokenPinHash(tokenId, hashTokenPIN(tokenId, PIN));
    return authority.redeemTokenWithPin(tokenId, DATE, hashTokenPIN(tokenId, PIN));
  }

  test('a valid redemption answers an opaque family hash: one for a family, another for another family', () => {
    const authority = new TokenAuthority('ACME');
    const parent = redeem(authority, 'fam-hash-1', 'emp-hash-1');
    const child = redeem(authority, 'fam-hash-1', 'emp-hash-2');
    const other = redeem(authority, 'fam-hash-2', 'emp-hash-3');
    expect(parent.valid && child.valid && other.valid).toBe(true);
    expect(parent.familyIdHash).toMatch(/^\d+$/);
    expect(child.familyIdHash).toBe(parent.familyIdHash);
    expect(other.familyIdHash).not.toBe(parent.familyIdHash);
  });

  test('a refused redemption answers no family', () => {
    const authority = new TokenAuthority('ACME');
    const { tokenId } = authority.generateToken('G1', 'PLAN-1', 'emp-hash-9', 'fam-hash-9', '20271231');
    authority.setTokenPinHash(tokenId, hashTokenPIN(tokenId, PIN));
    const wrong = authority.redeemTokenWithPin(tokenId, DATE, hashTokenPIN(tokenId, '000000'));
    expect(wrong.valid).toBe(false);
    expect(wrong.familyIdHash).toBeUndefined();
  });
});

describe('the engine in source', () => {
  const engine = fs.readFileSync('src/adjudication/interactive-service.ts', 'utf8');
  const routes = fs.readFileSync('src/adjudication/interactive-routes.ts', 'utf8');
  const start = engine.indexOf('async registerMemberFromEnrollment(');
  const register = engine.slice(start, engine.indexOf('\n  }\n', start));

  test('registration binds the family from the insurer\'s approval and reads none from the request', () => {
    expect(start).toBeGreaterThan(0);
    expect(register).toContain("familyId: approval.familyIdHash ?? '',");
    expect(register).not.toMatch(/opts\.familyId|opts\.employeeId/);
    expect(routes).not.toMatch(/familyId: params\.familyId|employeeId: params\.employeeId/);
  });

  test('the fill proof and the family history both take the family from familyMembersOf, and nothing compares raw family IDs', () => {
    expect(engine.match(/familyMembersOf\(enrolled, this\.enrolledMembers\.values\(\)\)/g)?.length).toBe(2);
    expect(engine).not.toMatch(/m\.familyId (===|!==) enrolled\.familyId/);
  });
});
