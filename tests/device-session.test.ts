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
 * Device sessions on the member node — the acceptance test for phase A item A5, findings A-7
 * (local half) and MEM-H1.
 *
 * The member node had 29 routes and **none of them authenticated anything**. Anything that could
 * reach the port could read the member's drug history and receipts, send messages as them, assign
 * their doctor, or mint their NFC identity payload. `GET /health` additionally handed out the
 * wallet ID, and `/onboarding/status` handed out the wallet ID plus the enrollment token, group
 * and plan — which is the first link in the drive-by chain the audit described: read the wallet
 * ID here, then ask the sequencer for that wallet's claims.
 *
 * What a session means, stated so the test is not read as claiming more than it proves: it is
 * issued by `/onboarding/unlock`, which since item A4 verifies the PIN against the encrypted
 * state. So holding one means somebody proved this device's PIN during this process's life. It
 * does not defend against a person holding the unlocked phone, and it says nothing to the
 * sequencer, whose own reads are still open until item D1.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { NautilusLocalState, type NautilusStateData } from '../src/nodes/nautilus-local-state.js';
import { NautilusAppServer } from '../src/nodes/nautilus-app-server.js';
import { buildMemberRoutes } from '../src/nodes/routes/member-routes.js';
import type { NautilusAppConfig } from '../src/nodes/nautilus-app-types.js';

const PIN = '739204';
const tempDirs: string[] = [];
const servers: NautilusAppServer[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

interface Res { status: number; body: unknown; headers: http.IncomingHttpHeaders }

function request(
  port: number,
  method: string,
  urlPath: string,
  opts: { body?: unknown; session?: string; bearer?: string } = {},
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const headers: Record<string, string> = {};
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(payload));
    }
    if (opts.session) headers['X-Device-Session'] = opts.session;
    if (opts.bearer) headers['Authorization'] = `Bearer ${opts.bearer}`;
    const req = http.request(
      { hostname: '127.0.0.1', port, path: urlPath, method, agent: false, headers },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          let parsed: unknown = data;
          try { parsed = JSON.parse(data); } catch { /* keep raw */ }
          resolve({ status: res.statusCode ?? 0, body: parsed, headers: res.headers });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const dataOf = (res: Res): Record<string, unknown> =>
  ((res.body as { data?: Record<string, unknown> }).data ?? {}) as Record<string, unknown>;

/** A member node with an enrolled-looking state, already saved under PIN. */
async function startMemberNode(adminToken?: string): Promise<{ port: number; dir: string }> {
  const dir = makeTempDir('devsession-');
  const seed = new NautilusLocalState(dir);
  await seed.unlock(PIN);
  const state: NautilusStateData = {
    version: 1, role: 'member',
    walletId: '12345678901234567890',
    onboarding: {
      phase: 'ready',
      tokenData: { tokenId: 'TOKEN-SECRET-001', groupId: 'ACME-CORP', planId: 'PLAN-GOLD-2026' },
    } as NautilusStateData['onboarding'],
    lastSavedAt: new Date().toISOString(),
  };
  await seed.save(state);
  seed.lock();

  const config: NautilusAppConfig = {
    role: 'member', port: 0, host: '127.0.0.1',
    sequencerUrl: 'http://127.0.0.1:1',
    stateDir: dir, enableSSE: false, maxSseConnections: 0,
    allowedOrigins: ['http://localhost:4001'],
    ...(adminToken ? { adminToken } : {}),
  };
  const server = new NautilusAppServer(config);
  servers.push(server);
  server.registerRoutes(buildMemberRoutes(server));
  await server.start();
  return { port: server.getPort(), dir };
}

afterAll(async () => {
  for (const s of servers) {
    try { await s.stop(); } catch { /* not started */ }
  }
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

// ───────────────────────────────────────────────────────────────────────────

describe('member routes refuse a caller with no session', () => {
  let port: number;

  beforeAll(async () => { ({ port } = await startMemberNode()); });

  // One per route family that reads or writes member data.
  test.each([
    ['GET', '/receipts'],
    ['GET', '/drugs'],
    ['GET', '/drugs/summary'],
    ['GET', '/proof-timings'],
    ['GET', '/messaging/inbox'],
    ['GET', '/messaging/sent'],
    ['GET', '/pcp/current'],
    ['GET', '/nfc/id-payload'],
  ])('%s %s is refused', async (method, route) => {
    const res = await request(port, method, route);
    expect(res.status).toBe(401);
  });

  test.each([
    ['POST', '/messaging/send'],
    ['POST', '/pcp/assign'],
    ['POST', '/proof/registration'],
    ['POST', '/onboarding/accept-token'],
    ['POST', '/onboarding/generate-key'],
    ['POST', '/onboarding/compile'],
  ])('%s %s is refused', async (method, route) => {
    const res = await request(port, method, route, { body: {} });
    expect(res.status).toBe(401);
  });

  test('the refusal says what to do, rather than just failing', async () => {
    const res = await request(port, 'GET', '/receipts');
    expect(JSON.stringify(res.body)).toMatch(/locked|PIN/i);
  });
});

describe('unlock issues a session, and the session opens the routes', () => {
  let port: number;
  let session: string;
  let expiresInMs: number;

  beforeAll(async () => {
    ({ port } = await startMemberNode());
    const res = await request(port, 'POST', '/onboarding/unlock', { body: { pin: PIN } });
    expect(res.status).toBe(200);
    session = String(dataOf(res).deviceSession ?? '');
    expiresInMs = Number(dataOf(res).expiresInMs ?? 0);
  });

  test('a session token comes back with a lifetime', async () => {
    expect(session.length).toBeGreaterThanOrEqual(32);
    // Note: unlocking again rotates the session, which is why this test does not do it and
    // the ones below reuse the token captured in beforeAll.
    expect(Number(expiresInMs)).toBeGreaterThan(0);
  });

  test('a route that refused without one now answers', async () => {
    const res = await request(port, 'GET', '/receipts', { session });
    expect(res.status).not.toBe(401);
  });

  test('unlocking again rotates the session, and the old one stops working', async () => {
    const again = await request(port, 'POST', '/onboarding/unlock', { body: { pin: PIN } });
    const fresh = String(dataOf(again).deviceSession ?? '');
    expect(fresh).not.toBe(session);
    expect((await request(port, 'GET', '/receipts', { session })).status).toBe(401);
    expect((await request(port, 'GET', '/receipts', { session: fresh })).status).not.toBe(401);
    session = fresh;
  });

  test('a wrong session is refused', async () => {
    const res = await request(port, 'GET', '/receipts', { session: 'not-the-session' });
    expect(res.status).toBe(401);
  });

  test('a session from one device does not open another', async () => {
    const other = await startMemberNode();
    const res = await request(other.port, 'GET', '/receipts', { session });
    expect(res.status).toBe(401);
  });

  test('unlock itself stays open, or nothing could ever get a session', async () => {
    const res = await request(port, 'POST', '/onboarding/unlock', { body: { pin: PIN } });
    expect(res.status).toBe(200);
  });

  test('a wrong PIN still issues nothing', async () => {
    const res = await request(port, 'POST', '/onboarding/unlock', { body: { pin: '000000' } });
    expect(res.status).toBe(401);
    expect(dataOf(res).deviceSession).toBeUndefined();
  });
});

describe('the open endpoints no longer hand out identity', () => {
  let port: number;
  let session: string;

  beforeAll(async () => {
    ({ port } = await startMemberNode());
    const res = await request(port, 'POST', '/onboarding/unlock', { body: { pin: PIN } });
    session = String(dataOf(res).deviceSession ?? '');
  });

  test('/health stays open, because a readiness probe needs it', async () => {
    const res = await request(port, 'GET', '/health');
    expect(res.status).toBe(200);
    expect(dataOf(res).role).toBe('member');
    expect(dataOf(res).phase).toBeDefined();
  });

  test('/health gives no wallet ID to a caller that proved nothing', async () => {
    const res = await request(port, 'GET', '/health');
    expect(dataOf(res).walletId).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('12345678901234567890');
  });

  test('/health gives it to the device itself', async () => {
    const res = await request(port, 'GET', '/health', { session });
    expect(dataOf(res).walletId).toBe('12345678901234567890');
  });

  test('/onboarding/status gives no wallet ID and no enrollment token', async () => {
    const res = await request(port, 'GET', '/onboarding/status');
    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    expect(dataOf(res).walletId).toBeUndefined();
    // The token, group and plan are the employer linkage rule I6 exists to prevent leaking.
    expect(body).not.toContain('TOKEN-SECRET-001');
    expect(body).not.toContain('ACME-CORP');
    expect(body).not.toContain('PLAN-GOLD-2026');
  });

  test('/onboarding/status still reports the phase, which the app needs before unlocking', async () => {
    const res = await request(port, 'GET', '/onboarding/status');
    expect(dataOf(res).phase).toBeDefined();
  });

  test('/onboarding/status gives the device itself everything', async () => {
    const res = await request(port, 'GET', '/onboarding/status', { session });
    expect(dataOf(res).walletId).toBe('12345678901234567890');
    expect(JSON.stringify(res.body)).toContain('TOKEN-SECRET-001');
  });
});

describe('an operator credential also works, so a node is not locked out of itself', () => {
  let port: number;
  const TOKEN = 'operator-token-for-tests';

  beforeAll(async () => { ({ port } = await startMemberNode(TOKEN)); });

  test('the admin bearer satisfies a device-only route', async () => {
    const res = await request(port, 'GET', '/receipts', { bearer: TOKEN });
    expect(res.status).not.toBe(401);
  });

  test('a wrong bearer does not', async () => {
    const res = await request(port, 'GET', '/receipts', { bearer: 'wrong' });
    expect(res.status).toBe(401);
  });

  test('but on a locked device it discloses nothing, because nothing is decrypted', async () => {
    // Worth asserting rather than assuming: an operator credential opens the routes, and it
    // still cannot produce the wallet ID while the device's state is encrypted. The identity
    // lives behind the PIN, not behind the authorisation check.
    const res = await request(port, 'GET', '/health', { bearer: TOKEN });
    expect(res.status).toBe(200);
    expect(dataOf(res).walletId).toBeUndefined();
  });

  test('once the device is unlocked, the operator credential sees it', async () => {
    await request(port, 'POST', '/onboarding/unlock', { body: { pin: PIN } });
    const res = await request(port, 'GET', '/health', { bearer: TOKEN });
    expect(dataOf(res).walletId).toBe('12345678901234567890');
  });
});

describe('eject authorises on the PIN rather than a session', () => {
  let port: number;
  let dir: string;

  beforeAll(async () => { ({ port, dir } = await startMemberNode()); });

  const stateFile = (): string => path.join(dir, 'nautilus-state.enc');

  test('no session is needed, because the PIN is stronger', async () => {
    // A member who knows their PIN must be able to wipe a device whose session has expired,
    // without unlocking first. The PIN is the authorisation.
    expect(fs.existsSync(stateFile())).toBe(true);
    const wrong = await request(port, 'POST', '/onboarding/eject', { body: { pin: '000000' } });
    expect(wrong.status).toBe(401);
    expect(fs.existsSync(stateFile())).toBe(true);

    const right = await request(port, 'POST', '/onboarding/eject', { body: { pin: PIN } });
    expect(right.status).toBe(200);
    expect(fs.existsSync(stateFile())).toBe(false);
  });
});

describe('the route table itself', () => {
  test('every member route but unlock requires a session', () => {
    // Structural, so a new route added without the flag fails here rather than shipping open.
    const src = fs.readFileSync('src/nodes/routes/member-routes.ts', 'utf-8');
    const blocks = src.split('routes.push({').slice(1);
    const open: string[] = [];
    for (const block of blocks) {
      const head = block.slice(0, block.indexOf('handler:'));
      const pathMatch = /path: '([^']+)'/.exec(head);
      if (!pathMatch) continue;
      if (!head.includes('deviceOnly: true')) open.push(pathMatch[1]);
    }
    // unlock issues the session; eject authorises on the PIN. Nothing else may be open.
    expect(open.sort()).toEqual(['/onboarding/eject', '/onboarding/unlock']);
  });
});
