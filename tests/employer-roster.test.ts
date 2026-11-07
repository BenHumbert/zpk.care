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
 * The employer never learns the wallet ID, by construction — plan item B6, rule I6, finding PHI-9.
 *
 * The employer's roster holds the employee hash, the group and family hashes, the fingerprint of the
 * code it issued (A-109: never the code) and whether that code was used. It has no wallet column: A6
 * removed the only call that would have filled one, and B6 removed the column itself, so the employer
 * learns that an enrollment happened and never which wallet it produced.
 */
import fs from 'fs';
import { EmployerNode } from '../src/nodes/employer-node.js';
import { hashString } from '../src/zkp/hash-utils.js';

const inSevenDays = () => new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10).replace(/-/g, '');

describe('the employer roster', () => {
  const node = new EmployerNode({ role: 'employer', sequencerUrl: 'http://127.0.0.1:1', employerId: 'E2E-TEST-EMPLOYER' });

  test('an entry created through the node has exactly the hash, code fingerprint and status columns, and no wallet', () => {
    node.createGroup('G-ROSTER', 'PLAN-ROSTER', '20260101', 10);
    const issued = node.generateToken('G-ROSTER', 'employee-hash-1', 'family-hash-1', inSevenDays());
    const entries = node.listRoster();
    expect(entries).toHaveLength(1);
    const entry = entries[0] as unknown as Record<string, unknown>;
    expect(Object.keys(entry).sort()).toEqual(['createdAt', 'employeeIdHash', 'familyIdHash', 'groupIdHash', 'inviteStatus', 'status', 'tokenIdHash']);
    expect(entry.tokenIdHash).toBe(hashString(issued.tokenId).toString());
    expect(entry.inviteStatus).toBe('unused');                // A-109: what became of the invite, for the HR Tool's notices
    expect(entry.status).toBe('pending');
    expect(JSON.stringify(entry)).not.toMatch(/wallet/i);
  });

  test('the roster route serves those entries unchanged', () => {
    const routes = fs.readFileSync('src/nodes/routes/employer-routes.ts', 'utf8');
    const start = routes.indexOf("path: '/roster',");
    const span = routes.slice(start, routes.indexOf('path: ', start + 10));
    expect(span).toMatch(/adminOnly: true/);
    expect(span).toMatch(/node\.listRoster\(\)/);
    expect(span).not.toMatch(/wallet/i);
  });

  test('the employer node keeps no wallet column for a member', () => {
    const src = fs.readFileSync('src/nodes/employer-node.ts', 'utf8');
    const type = src.slice(src.indexOf('export interface EmployerRosterEntry'), src.indexOf('export class EmployerNode'));
    expect(type).not.toMatch(/walletId/);
    const insertion = src.slice(src.indexOf('this.roster.set(employeeIdHash, {'), src.indexOf('this.roster.set(employeeIdHash, {') + 400);
    expect(insertion).not.toMatch(/walletId/);
    // The only wallet the employer node knows is its own pseudo-wallet for messaging.
    const mentions = src.split('\n').filter((l) => /walletId/i.test(l) && !/^\s*(\/\/|\*|\/\*)/.test(l));
    expect(mentions.every((l) => /employerWalletId|recipientWalletId|senderWalletId/i.test(l))).toBe(true);
  });
});
