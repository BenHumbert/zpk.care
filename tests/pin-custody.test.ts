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
 * PIN custody and the device-wipe chain — the acceptance test for phase A item A4,
 * findings A-20 and MEM-M2.
 *
 * The chain the audit described, start to finish:
 *
 *   1. `unlock(pin)` derived a scrypt key and returned. Deriving a key cannot fail, because it
 *      is a key-derivation function and not a check, so the key was set for any PIN at all.
 *   2. The route handler's catch returned 400 without locking, so the key stayed set.
 *   3. `isUnlocked()` was `derivedKey !== null`, so it was now true.
 *   4. That flag was the only gate on `POST /onboarding/eject`, which deletes the state file.
 *
 * So one request carrying six characters of junk armed the route that erases the device, and
 * with the launcher's environment PIN the flag was already true at boot and eject needed no PIN
 * at all. Each link is tested below, plus the attempt limiting that stops a six-digit PIN being
 * guessable in a day.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import {
  NautilusLocalState,
  PinAttemptThrottled,
  type NautilusStateData,
} from '../src/nodes/nautilus-local-state.js';
import { NautilusAppServer } from '../src/nodes/nautilus-app-server.js';
import { buildMemberRoutes } from '../src/nodes/routes/member-routes.js';
import type { NautilusAppConfig } from '../src/nodes/nautilus-app-types.js';

const RIGHT_PIN = '419286';
const WRONG_PIN = '000000';

const tempDirs: string[] = [];
const servers: NautilusAppServer[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function freshState(role: NautilusStateData['role'] = 'member'): NautilusStateData {
  return {
    version: 1, role,
    onboarding: { phase: 'awaiting_token' },
    lastSavedAt: new Date().toISOString(),
  };
}

/** A state directory that already holds an encrypted state under RIGHT_PIN. */
async function enrolledDir(): Promise<string> {
  const dir = makeTempDir('pincustody-');
  const state = new NautilusLocalState(dir);
  await state.unlock(RIGHT_PIN);
  await state.save(freshState());
  state.lock();
  return dir;
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

describe('a wrong PIN leaves the device locked', () => {
  test('unlock throws on a wrong PIN', async () => {
    const state = new NautilusLocalState(await enrolledDir());
    await expect(state.unlock(WRONG_PIN)).rejects.toThrow(/Incorrect PIN/i);
  });

  test('and isUnlocked stays false, which is the link that broke the chain', async () => {
    const state = new NautilusLocalState(await enrolledDir());
    expect(state.isUnlocked()).toBe(false);
    await state.unlock(WRONG_PIN).catch(() => { /* expected */ });
    expect(state.isUnlocked()).toBe(false);
  });

  test('and load still refuses, because no key was retained', async () => {
    const state = new NautilusLocalState(await enrolledDir());
    await state.unlock(WRONG_PIN).catch(() => { /* expected */ });
    await expect(state.load()).rejects.toThrow(/locked/i);
  });

  test('the right PIN still unlocks and loads', async () => {
    const state = new NautilusLocalState(await enrolledDir());
    await state.unlock(RIGHT_PIN);
    expect(state.isUnlocked()).toBe(true);
    const data = await state.load();
    expect(data?.role).toBe('member');
  });

  test('a first run with no state file is accepted, since there is nothing to protect yet', async () => {
    const state = new NautilusLocalState(makeTempDir('pincustody-fresh-'));
    await state.unlock('135790');
    expect(state.isUnlocked()).toBe(true);
    await state.save(freshState());
    expect((await state.load())?.role).toBe('member');
  });

  test('a short PIN is refused before any work is done', async () => {
    const state = new NautilusLocalState(await enrolledDir());
    await expect(state.unlock('123')).rejects.toThrow(/at least/i);
    expect(state.isUnlocked()).toBe(false);
  });

  test('lock() clears the verified flag as well as the key', async () => {
    const state = new NautilusLocalState(await enrolledDir());
    await state.unlock(RIGHT_PIN);
    expect(state.isUnlocked()).toBe(true);
    state.lock();
    expect(state.isUnlocked()).toBe(false);
  });
});

describe('a damaged state file is not treated as a wrong PIN', () => {
  test('it reports damage, and does not count against the attempt limit', async () => {
    const dir = await enrolledDir();
    const file = path.join(dir, 'nautilus-state.enc');
    const envelope = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
    // Keep the envelope well-formed but make the ciphertext unusable.
    envelope.data = 'zz';
    fs.writeFileSync(file, JSON.stringify(envelope));

    const state = new NautilusLocalState(dir);
    await expect(state.unlock(RIGHT_PIN)).rejects.toThrow(/damaged|could not be read/i);
    // The owner of a corrupted file must not be locked out by the corruption.
    expect((await state.pinAttemptStatus()).failures).toBe(0);
  });
});

describe('attempt limiting, so a six-digit PIN is not guessable in a day', () => {
  test('the first few failures are free, then a delay appears', async () => {
    const dir = await enrolledDir();
    const state = new NautilusLocalState(dir);

    for (let i = 1; i <= 3; i++) {
      await expect(state.unlock(WRONG_PIN)).rejects.toThrow(/Incorrect PIN/i);
      const status = await state.pinAttemptStatus();
      expect(status.failures).toBe(i);
      expect(status.retryAfterMs).toBe(0);
    }

    // The fourth failure starts the backoff.
    await expect(state.unlock(WRONG_PIN)).rejects.toThrow(/Incorrect PIN/i);
    const after = await state.pinAttemptStatus();
    expect(after.failures).toBe(4);
    expect(after.retryAfterMs).toBeGreaterThan(0);
  });

  test('an attempt inside the window is refused without checking the PIN', async () => {
    const dir = await enrolledDir();
    const state = new NautilusLocalState(dir);
    for (let i = 0; i < 4; i++) {
      await state.unlock(WRONG_PIN).catch(() => { /* expected */ });
    }
    // Even the CORRECT PIN is refused while throttled. That is the point: the limit cannot be
    // sidestepped by guessing right, and an attacker learns nothing from the response.
    await expect(state.unlock(RIGHT_PIN)).rejects.toBeInstanceOf(PinAttemptThrottled);
  });

  test('the delay grows with each further failure', async () => {
    const dir = await enrolledDir();
    const state = new NautilusLocalState(dir);
    const delays: number[] = [];
    for (let i = 0; i < 6; i++) {
      await state.unlock(WRONG_PIN).catch(() => { /* expected or throttled */ });
      const { retryAfterMs } = await state.pinAttemptStatus();
      delays.push(retryAfterMs);
      // Clear the window so the next real attempt is allowed through.
      const file = path.join(dir, 'nautilus-pin-attempts.json');
      const rec = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
      rec.lockedUntil = new Date(Date.now() - 1000).toISOString();
      fs.writeFileSync(file, JSON.stringify(rec));
    }
    const positive = delays.filter((d) => d > 0);
    expect(positive.length).toBeGreaterThanOrEqual(2);
    expect(positive[positive.length - 1]).toBeGreaterThan(positive[0]);
  });

  test('a successful unlock clears the record', async () => {
    const dir = await enrolledDir();
    const state = new NautilusLocalState(dir);
    await state.unlock(WRONG_PIN).catch(() => { /* expected */ });
    expect((await state.pinAttemptStatus()).failures).toBe(1);
    await state.unlock(RIGHT_PIN);
    expect((await state.pinAttemptStatus()).failures).toBe(0);
  });

  test('the counter survives a new process, because it is not inside the encrypted file', async () => {
    const dir = await enrolledDir();
    const first = new NautilusLocalState(dir);
    await first.unlock(WRONG_PIN).catch(() => { /* expected */ });
    await first.unlock(WRONG_PIN).catch(() => { /* expected */ });

    // A fresh instance is what a restarted process looks like.
    const second = new NautilusLocalState(dir);
    expect((await second.pinAttemptStatus()).failures).toBe(2);
  });

  test('the counter is never written inside the encrypted state', async () => {
    const dir = await enrolledDir();
    const state = new NautilusLocalState(dir);
    await state.unlock(WRONG_PIN).catch(() => { /* expected */ });
    // It has to be readable without the PIN, or it could not throttle the first guess.
    expect(fs.existsSync(path.join(dir, 'nautilus-pin-attempts.json'))).toBe(true);
  });

  test('a wipe clears the counter, so a fresh enrollment is not born locked out', async () => {
    const dir = await enrolledDir();
    const state = new NautilusLocalState(dir);
    await state.unlock(WRONG_PIN).catch(() => { /* expected */ });
    expect((await state.pinAttemptStatus()).failures).toBe(1);
    await state.destroy();
    expect((await state.pinAttemptStatus()).failures).toBe(0);
  });
});

describe('verifyPin checks without unlocking', () => {
  test('the right PIN verifies, and the state stays locked', async () => {
    const state = new NautilusLocalState(await enrolledDir());
    expect(await state.verifyPin(RIGHT_PIN)).toBe(true);
    expect(state.isUnlocked()).toBe(false);
  });

  test('the wrong PIN does not verify and is counted', async () => {
    const state = new NautilusLocalState(await enrolledDir());
    expect(await state.verifyPin(WRONG_PIN)).toBe(false);
    expect((await state.pinAttemptStatus()).failures).toBe(1);
  });

  test('it shares the backoff with unlock, so it cannot be used to grind PINs', async () => {
    const dir = await enrolledDir();
    const state = new NautilusLocalState(dir);
    for (let i = 0; i < 4; i++) {
      await state.verifyPin(WRONG_PIN);
    }
    await expect(state.verifyPin(RIGHT_PIN)).rejects.toBeInstanceOf(PinAttemptThrottled);
  });

  test('with no state file there is no PIN to verify against', async () => {
    const state = new NautilusLocalState(makeTempDir('pincustody-none-'));
    expect(await state.verifyPin(RIGHT_PIN)).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The route, end to end: the chain the finding actually described.
// ───────────────────────────────────────────────────────────────────────────

interface Res { status: number; body: unknown; headers: http.IncomingHttpHeaders }

function request(port: number, method: string, urlPath: string, body?: unknown): Promise<Res> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        hostname: '127.0.0.1', port, path: urlPath, method, agent: false,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : {},
      },
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

describe('POST /onboarding/eject cannot be reached with a junk PIN', () => {
  let port: number;
  let stateDir: string;

  beforeAll(async () => {
    stateDir = await enrolledDir();
    const config: NautilusAppConfig = {
      role: 'member', port: 0, host: '127.0.0.1',
      sequencerUrl: 'http://127.0.0.1:1',
      stateDir, enableSSE: false, maxSseConnections: 0,
      allowedOrigins: ['http://localhost:4001'],
    };
    const server = new NautilusAppServer(config);
    servers.push(server);
    server.registerRoutes(buildMemberRoutes(server));
    await server.start();
    port = server.getPort();
  });

  const stateFile = (): string => path.join(stateDir, 'nautilus-state.enc');

  test('step 1: an unlock with a junk PIN is refused', async () => {
    const res = await request(port, 'POST', '/onboarding/unlock', { pin: WRONG_PIN });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/Incorrect PIN/i);
  });

  test('step 2: eject with no PIN is refused, and the state file survives', async () => {
    const res = await request(port, 'POST', '/onboarding/eject', {});
    expect(res.status).toBe(400);
    expect(fs.existsSync(stateFile())).toBe(true);
  });

  test('step 3: eject with the wrong PIN is refused, and the state file survives', async () => {
    const res = await request(port, 'POST', '/onboarding/eject', { pin: WRONG_PIN });
    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).toMatch(/Nothing was erased/i);
    expect(fs.existsSync(stateFile())).toBe(true);
  });

  test('step 4: repeated wrong PINs start answering 429 with a Retry-After', async () => {
    let throttled: Res | null = null;
    for (let i = 0; i < 6 && !throttled; i++) {
      const res = await request(port, 'POST', '/onboarding/eject', { pin: WRONG_PIN });
      if (res.status === 429) throttled = res;
    }
    expect(throttled).not.toBeNull();
    expect(throttled!.headers['retry-after']).toBeDefined();
    expect(fs.existsSync(stateFile())).toBe(true);
  });

  test('step 5: the right PIN does erase the device, once the window has passed', async () => {
    // Clear the throttle the previous test created; this is about authorisation, not timing.
    try { fs.rmSync(path.join(stateDir, 'nautilus-pin-attempts.json'), { force: true }); } catch { /* none */ }

    const res = await request(port, 'POST', '/onboarding/eject', { pin: RIGHT_PIN });
    expect(res.status).toBe(200);
    expect(fs.existsSync(stateFile())).toBe(false);
  });
});

/**
 * Found by probing a running node rather than by reading the code, which is why it is here.
 *
 * The unlock route returned `{ unlocked: true, alreadyUnlocked: true }` the moment the state was
 * unlocked, without looking at the PIN at all. The launcher auto-unlocks from the environment, so
 * that is a device's normal state after boot, and the app's PIN screen therefore accepted any PIN
 * for the life of the process. It granted a caller nothing they did not already have, but it made
 * the member-facing PIN gate decorative, and a prompt that accepts anything is worse than no
 * prompt because it implies a check happened.
 */
describe('an already-unlocked device still checks the PIN', () => {
  let port: number;
  let stateDir: string;

  beforeAll(async () => {
    stateDir = await enrolledDir();
    const config: NautilusAppConfig = {
      role: 'member', port: 0, host: '127.0.0.1',
      sequencerUrl: 'http://127.0.0.1:1',
      stateDir, enableSSE: false, maxSseConnections: 0,
      allowedOrigins: ['http://localhost:4001'],
    };
    const server = new NautilusAppServer(config);
    servers.push(server);
    server.registerRoutes(buildMemberRoutes(server));
    // Unlock it the way the launcher does, before any request arrives.
    await server.getLocalState().unlock(RIGHT_PIN);
    await server.start();
    port = server.getPort();
  });

  test('the device really is unlocked to begin with', async () => {
    const res = await request(port, 'POST', '/onboarding/unlock', { pin: RIGHT_PIN });
    expect(res.status).toBe(200);
    expect((res.body as { data?: { alreadyUnlocked?: boolean } }).data?.alreadyUnlocked).toBe(true);
  });

  test('a wrong PIN is refused even though the device is unlocked', async () => {
    const res = await request(port, 'POST', '/onboarding/unlock', { pin: WRONG_PIN });
    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).toMatch(/Incorrect PIN/i);
  });

  test('and the refusal does not lock the device that was legitimately open', async () => {
    const res = await request(port, 'POST', '/onboarding/unlock', { pin: RIGHT_PIN });
    expect(res.status).toBe(200);
  });

  test('a missing PIN is refused rather than shortcut', async () => {
    const res = await request(port, 'POST', '/onboarding/unlock', {});
    expect(res.status).toBe(400);
  });
});
