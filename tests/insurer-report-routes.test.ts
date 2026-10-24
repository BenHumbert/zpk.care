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
 * The insurer node's reports take its admin credential, and a report's body is held to limits.
 *
 * What was wrong: the insurer node's twelve POST /reports/* routes took no credential, and each computed over whatever
 * its body held, up to the server's 5 MB body cap. Anything that could reach the port could have the node pivot every
 * distinct value of thousands of claims against every other, parse a quantity a million digits long, or compare a date
 * as long as the body with every claim, holding the node's one thread for as long as it liked; and what the reports
 * summarize is plan-wide claim data. The dashboard sent its token on these calls but read a refusal as a report.
 *
 * How it was found: the security posture check of 2026-10-24 (its guard chart: twelve open /reports/* routes running
 * unbounded computation over 5 MB bodies).
 *
 * What is true now: every report route is adminOnly. Before a report runs, reportBodyError holds its body to
 * REPORT_LIMITS: at most 10,000 claims and 1,000 prior authorizations, filter lists of at most 1,000 values, and text of
 * at most 128 characters wherever a report computes over it; over a limit is 413, the wrong shape is 400, and whatever
 * else a claim carries is passed through untouched. A cross-tab of more than MAX_CROSS_TAB_CELLS (100,000) cells is
 * refused 413 before a cell is built. The dashboard posts reports through API.generateReport with its admin token, and a
 * refusal shows as the failure it is.
 *
 * An insurer node as start-insurer-nautilus serves it; the reports compute locally, so no sequencer is behind it.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import vm from 'vm';

jest.setTimeout(120_000);

const NL = '\n';
const read = (file: string): string => fs.readFileSync(file, 'utf8').replace(/\r\n/g, NL);
const ADMIN = 'insurer-admin-token-for-report-routes';
const AS_ADMIN = { Authorization: `Bearer ${ADMIN}` };

let insurerServer: any;
let insurerNode: any;
let url: string;
const dirs: string[] = [];

/** A claim as a report reads it. */
function claim(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    prescriptionHash: '11', entryCommitment: '12', patientPayCents: 1500, planPayCents: 3500, operationType: 'fulfillment',
    pharmacyWalletId: '21', memberWalletId: '22', prescriberWalletId: '23', ndcHash: '24', ingredientCostCents: 3750,
    dispensingFeeCents: 1250, quantityDispensed: '30000', dateOfService: 20260115, ndc: '00378410591', tierLevel: 1,
    therapeuticClass: 'ANTIVIRAL', ...over,
  };
}

const PRIOR_AUTH = { ndcHash: '24', memberWalletId: '22', prescriberWalletId: '23', approvalDate: 20260101, expirationDate: 20261231, approvedQuantity: '90000' };

/** Every report route with a body it accepts. */
const REPORTS: Array<[string, Record<string, unknown>]> = [
  ['claims-register', { claims: [claim()] }],
  ['pharmacy-activity', { claims: [claim()] }],
  ['prescriber-activity', { claims: [claim()] }],
  ['member-activity', { claims: [claim()] }],
  ['medication-utilization', { claims: [claim()] }],
  ['financial-summary', { claims: [claim()] }],
  ['prior-auth', { claims: [claim()], priorAuths: [PRIOR_AUTH] }],
  ['reversals', { claims: [claim()] }],
  ['tier-analysis', { claims: [claim()] }],
  ['therapeutic-class', { claims: [claim()] }],
  ['time-series', { claims: [claim()], bucket: 'monthly' }],
  ['cross-tab', { claims: [claim()], row: 'pharmacyWalletId', col: 'tierLevel', measure: 'claimCount' }],
];

async function report(name: string, body: unknown, headers: Record<string, string> = AS_ADMIN): Promise<{ status: number; json: any }> {
  const r = await fetch(`${url}/reports/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json() };
}

beforeAll(async () => {
  const { NautilusAppServer } = await import('../src/nodes/nautilus-app-server.js');
  const { InsurerNode } = await import('../src/nodes/insurer-node.js');
  const { buildInsurerRoutes } = await import('../src/nodes/routes/insurer-routes.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'insurer-reports-'));
  dirs.push(dir);
  insurerServer = new NautilusAppServer({
    role: 'insurer', port: 0, host: '127.0.0.1', sequencerUrl: 'http://127.0.0.1:1', stateDir: dir,
    enableSSE: false, maxSseConnections: 0, allowedOrigins: [], adminToken: ADMIN,
  } as any);
  insurerServer.registerRoutes(buildInsurerRoutes(insurerServer));
  insurerNode = new InsurerNode({ role: 'insurer', sequencerUrl: 'http://127.0.0.1:1', displayName: 'Insurer' } as any);
  insurerServer.setEntityNode(insurerNode);
  await insurerServer.start();
  url = `http://127.0.0.1:${insurerServer.getPort()}`;
});

afterAll(async () => {
  await insurerServer?.stop();
  for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
});

afterEach(() => { jest.restoreAllMocks(); });

describe('the credential', () => {
  test.each(REPORTS)('/reports/%s refuses a request without the node\'s admin credential, and computes nothing', async (name, body) => {
    const spies = Object.getOwnPropertyNames(Object.getPrototypeOf(insurerNode))
      .filter((m) => m.startsWith('generate'))
      .map((m) => jest.spyOn(insurerNode, m));
    for (const headers of [{}, { Authorization: 'Bearer not-the-token' }]) {
      const r = await report(name, body, headers);
      expect([name, r.status]).toEqual([name, 401]);                         // before: 200, for anyone
    }
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  test.each(REPORTS)('/reports/%s with the credential computes the report as before', async (name, body) => {
    const r = await report(name, body);
    expect([name, r.status, r.json.ok]).toEqual([name, 200, true]);
  });

  test('the reports read what the service makes of the claims', async () => {
    const r = await report('claims-register', { claims: [claim(), claim({ operationType: 'reversal', prescriptionHash: '13' })] });
    expect(r.json.data).toMatchObject({ totalClaimCount: 1, totalReversalCount: 1 });
    const x = await report('cross-tab', { claims: [claim(), claim({ pharmacyWalletId: '31', tierLevel: 2 })], row: 'pharmacyWalletId', col: 'tierLevel', measure: 'claimCount' });
    expect(x.json.data).toMatchObject({ columnHeaders: ['1', '2'], rows: [{ rowKey: '21', values: [1, 0] }, { rowKey: '31', values: [0, 1] }] });
  });
});

describe('the limits', () => {
  test('the limits are what the routes say', async () => {
    const { REPORT_LIMITS } = await import('../src/nodes/routes/insurer-routes.js') as any;
    const { MAX_CROSS_TAB_CELLS } = await import('../src/reporting/reporting-service.js') as any;
    expect(REPORT_LIMITS).toEqual({ claims: 10_000, priorAuths: 1_000, filterValues: 1_000, textChars: 128 });
    expect(MAX_CROSS_TAB_CELLS).toBe(100_000);
  });

  test('more than 10,000 claims is refused 413 before any report runs; 10,000 is computed', async () => {
    const spy = jest.spyOn(insurerNode, 'generateClaimsRegister');
    const over = await report('claims-register', { claims: Array.from({ length: 10_001 }, () => ({})) });
    expect(over.status).toBe(413);                                             // before: computed
    expect(over.json.error).toBe('A report reads at most 10000 claims; this request has 10001');
    expect(spy).not.toHaveBeenCalled();
    const at = await report('claims-register', { claims: Array.from({ length: 10_000 }, () => claim()) });
    expect(at.status).toBe(200);
    expect(at.json.data.totalClaimCount).toBe(10_000);
  });

  test('text over 128 characters where a report computes over it is refused 413; what a claim merely carries is not read', async () => {
    const long = await report('medication-utilization', { claims: [claim({ quantityDispensed: '9'.repeat(129) })] });
    expect(long.status).toBe(413);                                             // before: a 129-digit BigInt, and a million-digit one as readily
    expect(long.json.error).toBe('claims[0].quantityDispensed is longer than 128 characters');
    const carried = await report('claims-register', { claims: [claim({ metadata: { note: 'n'.repeat(1000) }, leaf: { memberWalletId: '22' } })] });
    expect(carried.status).toBe(200);                                          // a claim accumulator entry's own fields pass through
  });

  test('a field a report computes over must be a number or text', async () => {
    const r = await report('prior-auth', { claims: [claim({ dateOfService: [20260115] })], priorAuths: [PRIOR_AUTH] });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('claims[0].dateOfService must be a number or text');
    for (const [body, error] of [
      [{ claims: 'all of them' }, 'claims must be a list'],
      [{ claims: [7] }, 'claims[0] is not a record'],
      [{ claims: [claim()], filter: [] }, 'filter must be an object'],
      [{ claims: [claim()], filter: { pharmacyWalletIds: '21' } }, 'filter.pharmacyWalletIds must be a list'],
      [{ claims: [claim()], filter: { dateRange: 'all' } }, 'filter.dateRange must be an object'],
    ] as Array<[unknown, string]>) {
      const refused = await report('claims-register', body);
      expect([refused.status, refused.json.error]).toEqual([400, error]);
    }
  });

  test('a filter is held to 1,000 values a list, and its dates to short text', async () => {
    const many = Array.from({ length: 1_001 }, (_, i) => String(i));
    const r = await report('pharmacy-activity', { claims: [claim()], filter: { memberWalletIds: many } });
    expect([r.status, r.json.error]).toEqual([413, 'filter.memberWalletIds holds at most 1000 values; this request has 1001']);
    const date = await report('time-series', { claims: [claim()], bucket: 'daily', filter: { dateRange: { startDate: '2'.repeat(200), endDate: 20261231 } } });
    expect([date.status, date.json.error]).toEqual([413, 'filter.dateRange.startDate is longer than 128 characters']);
    const bare = await report('time-series', { claims: [claim()], bucket: 'daily', filter: { startDate: 20260101, endDate: '3'.repeat(200) } });
    expect([bare.status, bare.json.error]).toEqual([413, 'filter.endDate is longer than 128 characters']);
    const ok = await report('pharmacy-activity', { claims: [claim()], filter: { memberWalletIds: many.slice(0, 1_000), dateRange: { startDate: 20260101, endDate: 20261231 } } });
    expect(ok.status).toBe(200);
  });

  test('more than 1,000 prior authorizations is refused 413', async () => {
    const r = await report('prior-auth', { claims: [claim()], priorAuths: Array.from({ length: 1_001 }, () => PRIOR_AUTH) });
    expect([r.status, r.json.error]).toEqual([413, 'A report reads at most 1000 priorAuths; this request has 1001']);
  });

  test('a cross-tab of more than 100,000 cells is refused 413 before a cell is built; 90,000 is computed', async () => {
    const distinct = (n: number) => Array.from({ length: n }, (_, i) => claim({ pharmacyWalletId: `P${i}`, ndc: `N${i}` }));
    const big = await report('cross-tab', { claims: distinct(400), row: 'pharmacyWalletId', col: 'ndc', measure: 'claimCount' });
    expect(big.status).toBe(413);                                              // before: 160,000 cells, built and sent
    expect(big.json.error).toMatch(/^A cross-tab of 400 rows by 400 columns is over 100000 cells/);
    const fits = await report('cross-tab', { claims: distinct(300), row: 'pharmacyWalletId', col: 'ndc', measure: 'claimCount' });
    expect(fits.status).toBe(200);
    expect(fits.json.data.rows).toHaveLength(300);
  });

  test('the reporting service itself refuses such a cross-tab, for any caller', async () => {
    const { ReportingService, ReportTooLargeError } = await import('../src/reporting/reporting-service.js') as any;
    const claims = Array.from({ length: 317 }, (_, i) => claim({ memberWalletId: `M${i}`, gpi: `G${i}` }));   // 317 x 317 = 100,489 cells
    expect(() => new ReportingService().generateCrossTab(claims, 'memberWalletId', 'gpi', 'claimCount')).toThrow(ReportTooLargeError);
    expect(new ReportingService().generateCrossTab(claims.slice(0, 316), 'memberWalletId', 'gpi', 'claimCount').rows).toHaveLength(316);
  });
});

describe('the insurer dashboard', () => {
  test('API.generateReport posts to the report route with the node\'s admin token, and throws the node\'s refusal', async () => {
    const calls: Array<{ url: string; init: any }> = [];
    let answer = { ok: true, status: 200, body: { ok: true, data: { totalClaimCount: 1 } } as Record<string, unknown> };
    const ctx: Record<string, unknown> = {
      location: { origin: 'http://127.0.0.1:4004' },
      localStorage: { getItem: () => 'insurer-admin-token', setItem() {} },
      fetch: async (u: string, init: any) => {
        calls.push({ url: u, init });
        return { ok: answer.ok, status: answer.status, text: async () => JSON.stringify(answer.body) };
      },
    };
    vm.createContext(ctx);
    vm.runInContext(read('dashboard-insurer/rpc.js') + '\n;globalThis.__API = API;', ctx);
    const API = ctx.__API as any;
    expect(await API.generateReport('claims-register', { claims: [{ ndc: '1' }] })).toEqual({ totalClaimCount: 1 });
    expect([calls[0].init.method, calls[0].url]).toEqual(['POST', 'http://127.0.0.1:4004/reports/claims-register']);
    expect(calls[0].init.headers.Authorization).toBe('Bearer insurer-admin-token');
    expect(JSON.parse(calls[0].init.body)).toEqual({ claims: [{ ndc: '1' }] });
    answer = { ok: false, status: 413, body: { ok: false, error: 'A report reads at most 10000 claims; this request has 10001' } };
    await expect(API.generateReport('claims-register', { claims: [] })).rejects.toThrow('A report reads at most 10000 claims');
  });

  test('the Reports page shows a refusal as a failure, not as a report', async () => {
    const src = read('dashboard-insurer/app.js');
    const at = src.indexOf(NL + '  async function doGenerateReport(');
    const fn = src.slice(at + 1, src.indexOf(NL + '  }' + NL, at) + 4);
    const els: Record<string, any> = {
      'rpt-type': { value: 'claims-register' }, 'rpt-source': { value: 'member' }, 'rpt-source-id': { value: '22' },
      'rpt-results-panel': { classList: { remove() {} } }, 'rpt-results': { innerHTML: '' }, 'rpt-type-badge': { textContent: '' },
    };
    const toasts: Array<[string, string]> = [];
    const asked: unknown[][] = [];
    const API = {
      getMemberClaims: async () => [claim()],
      generateReport: async (...args: unknown[]) => { asked.push(args); throw new Error('Unauthorized'); },
    };
    const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const run = new Function('$', 'API', 'toast', 'esc', 'renderReportData', `'use strict';\n${fn}\nreturn doGenerateReport;`)(
      (id: string) => els[id], API, (m: string, t: string) => { toasts.push([m, t]); }, esc, () => 'a report',
    );
    await run();
    expect(asked).toEqual([['claims-register', { claims: [claim()] }]]);       // before: a bare fetch, its refusal rendered as data
    expect(els['rpt-results'].innerHTML).toBe('<div class="form-result error">Report failed: Unauthorized</div>');
    expect(toasts).toEqual([]);
  });
});
