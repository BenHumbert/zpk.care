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
 * Enrollment-key custody — the acceptance test for phase A item A3, rule I3.
 *
 * Rule I3 says the enrollment key lives in the device's secure storage and on an offline card
 * under a PIN, and nowhere else. Three routes broke it on every node type, not just the member
 * node the audit recorded:
 *
 *   - `POST /onboarding/backup-key` took the PIN **from the request body** and returned the
 *     AES-GCM blob in the response, so the caller chose the PIN, received the ciphertext and
 *     decrypted the raw 256-bit key offline. The card-plus-PIN second factor means nothing when
 *     one party does both halves (findings A-5, MEM-C1).
 *   - `POST /onboarding/restore-key` had no authentication and no phase check and overwrote the
 *     stored key, which hijacks or destroys the wallet (MEM-H2).
 *   - `POST /onboarding/generate-key` accepted `body.enrollmentKey` verbatim, so an attacker
 *     could fix the key a wallet would be derived under (MEM-C2).
 *
 * These tests assert the first two are **absent from the route table**, which is stronger than
 * asserting a 404 from a running server: a route cannot be reintroduced without failing here.
 * The third is checked behaviourally, by handing a node a key and proving the wallet it derives
 * is not the wallet that key would produce.
 */
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Field } from 'o1js';
import { NautilusAppServer } from '../src/nodes/nautilus-app-server.js';
import { buildMemberRoutes } from '../src/nodes/routes/member-routes.js';
import { buildPrescriberRoutes } from '../src/nodes/routes/prescriber-routes.js';
import { buildPharmacyRoutes } from '../src/nodes/routes/pharmacy-routes.js';
import type { NautilusAppConfig, RouteRegistration } from '../src/nodes/nautilus-app-types.js';
import { deriveMemberWalletId } from '../src/wallets/wallet-derivation.js';
import { hashString } from '../src/zkp/hash-utils.js';

const TEST_PIN = '902145';
/**
 * A key an attacker would try to inject. Fake, never used for anything real, and deliberately
 * strong enough to pass `validateEnrollmentKey` so that the test fails for the right reason:
 * the point is that the node ignores it, not that it was malformed.
 */
const ATTACKER_KEY = 'Aa1!'.repeat(16);

const tempDirs: string[] = [];
/** Every server made here, so afterAll can close them rather than leave handles open. */
const madeServers: NautilusAppServer[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

interface HttpResult { status: number; body: unknown }

/**
 * A5 made every member route but unlock require a device session, so these tests obtain one the
 * way the app does and carry it. `deviceSession` is set by the describes that need it.
 */
let deviceSession = '';

/** Unlock over HTTP and keep the session, which is what the member app does at startup. */
async function obtainDeviceSession(port: number): Promise<void> {
  const res = await request(port, 'POST', '/onboarding/unlock', { pin: TEST_PIN });
  const data = (res.body as { data?: { deviceSession?: string } }).data;
  deviceSession = data?.deviceSession ?? '';
  expect(deviceSession.length).toBeGreaterThan(0);
}

function request(port: number, method: string, urlPath: string, body?: unknown): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = {};
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(payload));
    }
    if (deviceSession) headers['X-Device-Session'] = deviceSession;
    const req = http.request(
      {
        hostname: '127.0.0.1', port, path: urlPath, method,
        // No keep-alive: a pooled socket on the global agent keeps the event loop open and
        // leaves jest hanging after the assertions have all passed.
        agent: false,
        headers,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          let parsed: unknown = data;
          try { parsed = JSON.parse(data); } catch { /* keep the raw text */ }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const ROUTE_BUILDERS: Array<{
  role: NautilusAppConfig['role'];
  build: (s: NautilusAppServer) => RouteRegistration[];
}> = [
  { role: 'member', build: buildMemberRoutes },
  { role: 'prescriber', build: buildPrescriberRoutes },
  { role: 'pharmacy', build: buildPharmacyRoutes },
];

async function makeServer(role: NautilusAppConfig['role']): Promise<NautilusAppServer> {
  const stateDir = await makeTempDir(`keycustody-${role}-`);
  const config: NautilusAppConfig = {
    role, port: 0, host: '127.0.0.1',
    sequencerUrl: 'http://127.0.0.1:1', // never reached by these tests
    stateDir, enableSSE: false, maxSseConnections: 0,
    allowedOrigins: ['http://localhost:4001'],
  };
  const server = new NautilusAppServer(config);
  madeServers.push(server);
  await server.getLocalState().unlock(TEST_PIN);
  await server.getLocalState().save({
    version: 1, role,
    onboarding: { phase: 'awaiting_token' },
    lastSavedAt: new Date().toISOString(),
  });
  return server;
}

afterAll(async () => {
  for (const server of madeServers) {
    try { await server.stop(); } catch { /* never started, or already stopped */ }
  }
  for (const dir of tempDirs) {
    try { await fs.promises.rm(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe('no node exposes a route that exports or replaces the enrollment key', () => {
  for (const { role, build } of ROUTE_BUILDERS) {
    describe(role, () => {
      let paths: string[];

      beforeAll(async () => {
        const server = await makeServer(role);
        paths = build(server).map((r) => `${r.method} ${r.path}`);
      });

      test('there is no backup-key route', () => {
        expect(paths).not.toContain('POST /onboarding/backup-key');
      });

      test('there is no restore-key route', () => {
        expect(paths).not.toContain('POST /onboarding/restore-key');
      });

      test('no route path mentions a key backup, export or restore at all', () => {
        const suspicious = paths.filter((p) => /backup|restore|export-key|reveal/i.test(p));
        expect(suspicious).toEqual([]);
      });

      test('generate-key is still there, because normal enrollment needs it', () => {
        expect(paths).toContain('POST /onboarding/generate-key');
      });
    });
  }
});

describe('generate-key ignores a key supplied by the caller', () => {
  let server: NautilusAppServer;
  let port: number;

  beforeAll(async () => {
    server = await makeServer('member');
    server.registerRoutes(buildMemberRoutes(server));
    await server.start();
    port = server.getPort();
    // A5: the member routes require a device session; get one the way the app does.
    deviceSession = '';
    await obtainDeviceSession(port);
  });

  afterAll(async () => { await server.stop(); });

  test('the route accepts the request and does not fail on the extra field', async () => {
    const accepted = await request(port, 'POST', '/onboarding/accept-token', {
      tokenId: 'TOKEN-KEYCUSTODY-001', groupId: 'ACME-CORP', planId: 'PLAN-GOLD-2026',
    });
    expect(accepted.status).toBe(200);

    const generated = await request(port, 'POST', '/onboarding/generate-key', {
      enrollmentKey: ATTACKER_KEY,
    });
    expect(generated.status).toBe(200);
  });

  test('the wallet is NOT derived under the supplied key', async () => {
    const local = {
      cardholderId: 'CH-KEYCUSTODY-1',
      dateOfBirth: '19900101',
      genderCode: 0,
      firstName: 'Test',
      lastName: 'Member',
    };
    // The route requires a HIPAA 164.508(b)(1) authorization record before it touches PHI.
    const derived = await request(port, 'POST', '/onboarding/derive-wallet', {
      ...local,
      consentRecord: {
        phiDescription: 'name, date of birth, cardholder id',
        disclosingParty: 'test member',
        receivingParty: 'test member device',
        purpose: 'key custody acceptance test',
        expiration: '20271231',
        signatureDate: '20261017',
      },
    });
    expect(derived.status).toBe(200);

    const walletId = (derived.body as { data?: { walletId?: string } }).data?.walletId;
    expect(typeof walletId).toBe('string');

    // What the wallet would have been if the injected key had been accepted. This is the whole
    // point of MEM-C2: an attacker who fixes the key knows the wallet, and can derive it again.
    const attackerWallet = deriveMemberWalletId(
      local as Parameters<typeof deriveMemberWalletId>[0],
      ATTACKER_KEY,
      hashString('ACME-CORP'),
    ).toString();

    expect(walletId).not.toBe(attackerWallet);
  });

  test('neither the injected key nor the real one comes back in a response', async () => {
    // Read the key the node actually generated, in-process, the way only the device can. If it
    // appears in any response body, rule I3 is broken regardless of which routes exist.
    const realKey = server.getLocalState().useEnrollmentKey((k) => k);
    expect(typeof realKey).toBe('string');
    expect(realKey.length).toBeGreaterThan(16);
    expect(realKey).not.toBe(ATTACKER_KEY);

    for (const probe of ['/onboarding/status', '/health']) {
      const res = await request(port, 'GET', probe);
      const serialized = JSON.stringify(res.body);
      expect(serialized).not.toContain(realKey);
      expect(serialized).not.toContain(ATTACKER_KEY);
    }
  });

  test('a backup cannot be requested, with or without a PIN', async () => {
    for (const body of [{ pin: TEST_PIN }, {}, { pin: '1' }]) {
      const res = await request(port, 'POST', '/onboarding/backup-key', body);
      expect(res.status).toBe(404);
      // And nothing key-shaped comes back in the refusal either.
      const realKey = server.getLocalState().useEnrollmentKey((k) => k);
      expect(JSON.stringify(res.body)).not.toContain(realKey);
    }
  });

  test('a restore cannot be attempted', async () => {
    const res = await request(port, 'POST', '/onboarding/restore-key', {
      backup: { v: 2, ct: 'deadbeef' }, pin: TEST_PIN,
    });
    expect(res.status).toBe(404);
  });
});

describe('the backup crypto itself is still available for the offline card', () => {
  test('exportEnrollmentBackup and importEnrollmentBackup are still exported', async () => {
    // A3 removes the network routes, not the primitives. Item A12b writes the recovery card at
    // the enrollment tap and needs these; tests/security.test.ts covers their behaviour.
    const mod = await import('../src/security/enrollment-backup.js');
    expect(typeof mod.exportEnrollmentBackup).toBe('function');
    expect(typeof mod.importEnrollmentBackup).toBe('function');
  });

  test('Field is importable, so the derivation assertion above is meaningful', () => {
    expect(Field(1).toString()).toBe('1');
  });
});

/**
 * The positive counterpart. A3 removed the network path for setting a known key; the in-process
 * path has to work, because that is how a device does it and how `production-showcase.test.ts`
 * now seeds deterministic keys. If this breaks, every test that depends on a known wallet ID
 * breaks with it, so it is pinned here rather than discovered fifteen minutes into a slow suite.
 */
describe('a device can set its own key in-process, and the wallet follows it', () => {
  let server: NautilusAppServer;
  let port: number;
  /** A fixed, fake key. Strong enough to pass validateEnrollmentKey. */
  const SEED_KEY = 'Zz9#'.repeat(16);

  beforeAll(async () => {
    server = await makeServer('member');
    server.registerRoutes(buildMemberRoutes(server));
    await server.start();
    port = server.getPort();
    // A5: the member routes require a device session; get one the way the app does.
    deviceSession = '';
    await obtainDeviceSession(port);
  });

  afterAll(async () => { await server.stop(); });

  test('the wallet is derived under the key the device set, not the one generate-key made', async () => {
    const accepted = await request(port, 'POST', '/onboarding/accept-token', {
      tokenId: 'TOKEN-SEED-001', groupId: 'ACME-CORP', planId: 'PLAN-GOLD-2026',
    });
    expect(accepted.status).toBe(200);

    // The route advances the phase and generates a key of its own.
    const generated = await request(port, 'POST', '/onboarding/generate-key');
    expect(generated.status).toBe(200);

    // The device then overwrites it, in its own process. This is `seedEnrollmentKey`.
    const state = server.getLocalState();
    state.setEnrollmentKey(SEED_KEY);
    const stored = state.getState();
    if (stored) await state.save(stored);
    expect(state.useEnrollmentKey((k) => k)).toBe(SEED_KEY);

    const local = {
      cardholderId: 'CH-SEED-1',
      dateOfBirth: '19850615',
      genderCode: 0,
      firstName: 'Seeded',
      lastName: 'Member',
    };
    const derived = await request(port, 'POST', '/onboarding/derive-wallet', {
      ...local,
      consentRecord: {
        phiDescription: 'name, date of birth, cardholder id',
        disclosingParty: 'test member',
        receivingParty: 'test member device',
        purpose: 'key custody acceptance test',
        expiration: '20271231',
        signatureDate: '20261017',
      },
    });
    expect(derived.status).toBe(200);

    const walletId = (derived.body as { data?: { walletId?: string } }).data?.walletId;
    const expected = deriveMemberWalletId(
      local as Parameters<typeof deriveMemberWalletId>[0],
      SEED_KEY,
      hashString('ACME-CORP'),
    ).toString();

    expect(walletId).toBe(expected);
  });
});
