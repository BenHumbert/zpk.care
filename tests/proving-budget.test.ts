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
 * Routes that prove in-request declare a proving budget — plan item B1 step two, commit three.
 *
 * The Nautilus server answers 504 when a request outruns its budget. The budget is the server's
 * default unless the matched route declares its own; a device's registration proof takes 25 s on a
 * workstation and a credential proof 25-31 s, and the live run of this commit saw one answered 504
 * by the old fixed 30 s timer. Every route that proves declares `PROVING_BUDGET_MS`.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { NautilusAppServer } from '../src/nodes/nautilus-app-server.js';
import { PROVING_BUDGET_MS, type NautilusAppConfig, type RouteRegistration } from '../src/nodes/nautilus-app-types.js';

jest.setTimeout(30_000);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let server: NautilusAppServer;
let dir: string;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proving-budget-'));
  const config: NautilusAppConfig = {
    role: 'member', port: 0, host: '127.0.0.1', sequencerUrl: 'http://127.0.0.1:1',
    stateDir: dir, enableSSE: false, maxSseConnections: 0, allowedOrigins: [],
    requestTimeoutMs: 400,
  };
  server = new NautilusAppServer(config);
  const slow = (ms: number) => async (_req: unknown, res: import('http').ServerResponse) => { await sleep(ms); server.sendResponse(res, 200, true, { slept: ms }); };
  const routes: RouteRegistration[] = [
    { method: 'GET', path: '/quick', handler: slow(10) },
    { method: 'GET', path: '/slow', handler: slow(1200) },
    { method: 'GET', path: '/slow-with-budget', handler: slow(1200), timeoutMs: 5000 },
  ];
  server.registerRoutes(routes);
  await server.start();
});

afterAll(async () => {
  await server.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function get(p: string) {
  const r = await fetch(`http://127.0.0.1:${server.getPort()}${p}`);
  return { status: r.status, json: await r.json().catch(() => null) as any };
}

describe('the request budget', () => {
  test('a route within the default budget answers normally', async () => {
    const r = await get('/quick');
    expect(r.status).toBe(200);
    expect(r.json?.data?.slept).toBe(10);
  });

  test('a route that outruns the default budget is answered 504, and says so', async () => {
    const r = await get('/slow');
    expect(r.status).toBe(504);
    expect(r.json?.error).toBe('Request timeout');
  });

  test('a route that declares its own budget may run past the default', async () => {
    const r = await get('/slow-with-budget');
    expect(r.status).toBe(200);
    expect(r.json?.data?.slept).toBe(1200);
  });
});

describe('every route that proves in-request declares the proving budget', () => {
  const routeDeclares = (file: string, routePath: string): boolean => {
    const src = fs.readFileSync(file, 'utf8');
    const at = src.indexOf(`path: '${routePath}',`);
    if (at < 0) return false;
    const header = src.slice(at, at + 200);
    return /timeoutMs: PROVING_BUDGET_MS,/.test(header);
  };

  test.each([
    ['src/nodes/routes/member-routes.ts', '/proof/registration'],
    ['src/nodes/routes/member-routes.ts', '/proof/wallet-updates'],
    ['src/nodes/routes/member-routes.ts', '/proof/pcp-assignment'],
    ['src/nodes/routes/member-routes.ts', '/credential/generate'],
    ['src/nodes/routes/prescriber-routes.ts', '/proof/registration'],
    ['src/nodes/routes/pharmacy-routes.ts', '/proof/registration'],
  ])('%s %s', (file, routePath) => {
    expect(routeDeclares(file, routePath)).toBe(true);
  });

  test('the budget is minutes, not seconds', () => {
    expect(PROVING_BUDGET_MS).toBeGreaterThanOrEqual(120_000);
  });
});
