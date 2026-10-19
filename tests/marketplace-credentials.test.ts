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
 * Employer credential handout — the acceptance test for phase A item A8, finding A-4.
 *
 * `GET /marketplace/api/activate-status/:id` returned the employer node's administrator token in
 * clear to anyone presenting the application ID. The audit retrieved one and replayed it against
 * that tenant's roster for a 200, reading token IDs, wallet IDs and hashes.
 *
 * The code's own comment said the design intent: "applicationId (128-bit random) acts as the
 * bearer secret". The entropy was never the problem. The same value is also an identifier, and
 * this one is printed to the console at submission, written to `marketplace-applications.json`
 * in plaintext, and carried in URL paths where proxies and access logs record it. A secret that
 * is logged, filed in the clear and placed in a URL is not a secret.
 *
 * These tests pin the split: the identifier keeps doing all of that, while a separate secret,
 * returned once and stored only as a hash, is what releases credentials.
 *
 * They talk to the route table directly rather than over HTTP, because what matters is which
 * fields each handler returns, and the store is module-level state shared by the handlers.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { createHash } from 'crypto';
import {
  buildMarketplaceRoutes,
  buildEmployerAdminRoutes,
  getApplicationStore,
} from '../src/nodes/routes/marketplace-routes.js';
import { NautilusAppServer } from '../src/nodes/nautilus-app-server.js';
import type { NautilusAppConfig, RouteRegistration } from '../src/nodes/nautilus-app-types.js';

const tempDirs: string[] = [];

/**
 * A stub sequencer. `POST /apply` checks employer-ID uniqueness against the sequencer and
 * **fails closed when it cannot reach one**, which is correct behaviour and not something to work
 * around by loosening the route. So the test provides one that answers "no such attestation".
 */
let stubSequencer: http.Server;
let stubSequencerUrl: string;

beforeAll(async () => {
  stubSequencer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      // No attestation for any employer ID, so every ID is available.
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: null }));
    });
  });
  await new Promise<void>((resolve) => stubSequencer.listen(0, '127.0.0.1', () => resolve()));
  const addr = stubSequencer.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  stubSequencerUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => stubSequencer.close(() => resolve()));
});

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

/** What a handler wrote, captured without a socket. */
interface Captured { status: number; payload: Record<string, unknown> }

function fakeRes(): { res: unknown; captured: () => Captured } {
  let status = 0;
  let payload: Record<string, unknown> = {};
  const res = {
    writeHead(code: number) { status = code; return this; },
    setHeader() { return this; },
    end(body?: string) {
      if (body) {
        try { payload = JSON.parse(body) as Record<string, unknown>; } catch { payload = { raw: body }; }
      }
      return this;
    },
    get writableEnded() { return status !== 0; },
  };
  return { res, captured: () => ({ status, payload }) };
}

function makeServer(): NautilusAppServer {
  const config: NautilusAppConfig = {
    role: 'insurer', port: 0, host: '127.0.0.1',
    sequencerUrl: stubSequencerUrl,
    stateDir: makeTempDir('mktcred-'),
    enableSSE: false, maxSseConnections: 0,
    allowedOrigins: ['http://localhost:4004'],
    adminToken: 'insurer-admin-token-for-tests',
  };
  return new NautilusAppServer(config);
}

function find(routes: RouteRegistration[], method: string, pathStr: string): RouteRegistration {
  const r = routes.find((x) => x.method === method && x.path === pathStr);
  if (!r) throw new Error(`route not registered: ${method} ${pathStr}`);
  return r;
}

async function call(
  route: RouteRegistration,
  params: Record<string, string>,
  body?: unknown,
): Promise<Captured> {
  const { res, captured } = fakeRes();
  await route.handler(
    {} as never,
    res as never,
    params,
    {} as never,
    body as never,
  );
  return captured();
}

const APPLY_BODY = {
  companyName: 'Fernhill Test Works LLC',
  employerId: 'FERNHILL-TEST',
  contactName: 'Jordan Testcase',
  contactEmail: 'hr@fernhill.example.test',
  ein: '00-0000003',
  state: 'WI',
  selectedPlanIds: ['PLAN-TEST-1'],
  effectiveDate: '2027-01-01',
  enrollmentCap: 10,
  publicKeyHex: 'a'.repeat(64),
};

describe('the activation secret is separate from the application ID', () => {
  let routes: RouteRegistration[];
  let applicationId: string;
  let activationCode: string;

  beforeAll(async () => {
    routes = buildMarketplaceRoutes(makeServer());
    getApplicationStore().clear();
    const out = await call(find(routes, 'POST', '/marketplace/api/apply'), {}, {
      ...APPLY_BODY, employerId: `FERNHILL-${Date.now()}`,
    });
    expect(out.status).toBe(201);
    const data = out.payload.data as Record<string, string>;
    applicationId = data.applicationId;
    activationCode = data.activationCode;
  });

  test('submission returns a one-time activation code', () => {
    expect(typeof activationCode).toBe('string');
    expect(activationCode.startsWith(`${applicationId}.`)).toBe(true);
    // The secret half carries real entropy rather than being a restatement of the identifier.
    const secret = activationCode.slice(applicationId.length + 1);
    expect(secret.length).toBeGreaterThanOrEqual(32);
    expect(secret).not.toContain(applicationId);
  });

  test('only the hash of the secret is stored, never the secret', () => {
    const app = getApplicationStore().get(applicationId);
    expect(app).toBeDefined();
    const secret = activationCode.slice(applicationId.length + 1);
    expect(app!.claimSecretHash).toBe(createHash('sha256').update(secret, 'utf-8').digest('hex'));
    // The stored record must not contain the secret in any field.
    expect(JSON.stringify(app)).not.toContain(secret);
  });

  test('the application ID alone is not the secret', () => {
    const app = getApplicationStore().get(applicationId)!;
    expect(app.claimSecretHash).not.toBe(
      createHash('sha256').update(applicationId, 'utf-8').digest('hex'),
    );
  });
});

describe('no open route hands out the employer admin token', () => {
  let routes: RouteRegistration[];

  beforeAll(() => {
    routes = buildMarketplaceRoutes(makeServer());
  });

  test('the progress poll is registered and is not admin-only, because progress is not a credential', () => {
    const route = find(routes, 'GET', '/marketplace/api/activate-status/:jobKey');
    expect(route.adminOnly).toBeFalsy();
  });

  test('no handler in this file returns adminToken except the one that takes the secret', () => {
    // A structural check over the source, because a future edit could put the token back on a
    // route that no test happens to exercise. This is the regression that actually matters.
    const src = fs.readFileSync('src/nodes/routes/marketplace-routes.ts', 'utf-8');
    const returning = src
      .split('\n')
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter((x) => /^adminToken:\s/.test(x.line));

    // One is the internal job-result assignment; one is the secret-gated collection route.
    expect(returning.length).toBeLessThanOrEqual(2);

    // And the collection route is the only response that carries it.
    const collectIdx = src.indexOf("path: '/marketplace/api/activate-credentials/:applicationId'");
    expect(collectIdx).toBeGreaterThan(0);
    const statusIdx = src.indexOf("path: '/marketplace/api/activate-status/:jobKey'");
    const statusBlock = src.slice(statusIdx, src.indexOf('routes.push', statusIdx + 10));
    expect(statusBlock).not.toContain('adminToken:');
  });
});

describe('collecting credentials', () => {
  let routes: RouteRegistration[];
  let applicationId: string;
  let secret: string;

  beforeEach(async () => {
    routes = buildMarketplaceRoutes(makeServer());
    getApplicationStore().clear();
    const out = await call(find(routes, 'POST', '/marketplace/api/apply'), {}, {
      ...APPLY_BODY, employerId: `FERNHILL-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    });
    const data = out.payload.data as Record<string, string>;
    applicationId = data.applicationId;
    secret = data.activationCode.slice(applicationId.length + 1);
  });

  const collect = async (
    routesIn: RouteRegistration[],
    id: string,
    body: unknown,
  ): Promise<Captured> =>
    call(find(routesIn, 'POST', '/marketplace/api/activate-credentials/:applicationId'),
      { applicationId: id }, body);

  test('without the secret it is refused', async () => {
    const out = await collect(routes, applicationId, {});
    expect(out.status).toBe(401);
  });

  test('with a wrong secret it is refused', async () => {
    const out = await collect(routes, applicationId, { claimSecret: 'not-the-secret' });
    expect(out.status).toBe(401);
  });

  test('with the application ID as the secret it is refused, which was the whole bug', async () => {
    const out = await collect(routes, applicationId, { claimSecret: applicationId });
    expect(out.status).toBe(401);
  });

  test('an unknown application answers exactly as a wrong secret does, so it is not an oracle', async () => {
    const unknown = await collect(routes, 'EMPAPP-does-not-exist', { claimSecret: secret });
    const wrong = await collect(routes, applicationId, { claimSecret: 'wrong' });
    expect(unknown.status).toBe(wrong.status);
    expect(unknown.payload.error).toBe(wrong.payload.error);
  });

  test('with the right secret but no provisioned tenant it is refused, not leaked', async () => {
    // No activation job exists in this test, so there is nothing to hand over.
    const out = await collect(routes, applicationId, { claimSecret: secret });
    expect(out.status).toBe(409);
    expect(JSON.stringify(out.payload)).not.toContain('adminToken');
  });
});

describe('rekey needs the secret too, which the audit did not record', () => {
  // The rekey route is registered by buildEmployerAdminRoutes, while apply is registered by
  // buildMarketplaceRoutes. Both share the module-level application store, which is exactly how
  // they share it in the running insurer node.
  let routes: RouteRegistration[];
  let adminRoutes: RouteRegistration[];
  let applicationId: string;
  let secret: string;

  beforeEach(async () => {
    const server = makeServer();
    routes = buildMarketplaceRoutes(server);
    adminRoutes = buildEmployerAdminRoutes(server);
    getApplicationStore().clear();
    const out = await call(find(routes, 'POST', '/marketplace/api/apply'), {}, {
      ...APPLY_BODY, employerId: `REKEY-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    });
    const data = out.payload.data as Record<string, string>;
    applicationId = data.applicationId;
    secret = data.activationCode.slice(applicationId.length + 1);
    // Rekey only applies to an approved application.
    getApplicationStore().get(applicationId)!.status = 'approved';
  });

  const rekey = async (id: string, body: unknown): Promise<Captured> =>
    call(find(adminRoutes, 'POST', '/employer-applications/:applicationId/rekey'),
      { applicationId: id }, body);

  test('the application ID alone can no longer replace the employer signing key', async () => {
    const out = await rekey(applicationId, { publicKeyHex: 'b'.repeat(64) });
    expect(out.status).toBe(401);
    // The key is unchanged, so no attested identity was substituted.
    expect(getApplicationStore().get(applicationId)!.publicKeyHex).toBe('a'.repeat(64));
  });

  test('with the secret it still works, because a lost key must be recoverable without the insurer', async () => {
    const out = await rekey(applicationId, { publicKeyHex: 'b'.repeat(64), claimSecret: secret });
    expect(out.status).toBe(200);
    expect(getApplicationStore().get(applicationId)!.publicKeyHex).toBe('b'.repeat(64));
  });

  test('a wrong secret is refused and changes nothing', async () => {
    const out = await rekey(applicationId, { publicKeyHex: 'c'.repeat(64), claimSecret: 'nope' });
    expect(out.status).toBe(401);
    expect(getApplicationStore().get(applicationId)!.publicKeyHex).toBe('a'.repeat(64));
  });
});
