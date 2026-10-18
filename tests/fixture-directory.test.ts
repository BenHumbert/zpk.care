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
 * The fixture directory leaves the gated dump — plan item B1, first half (A-13's residue).
 *
 * `GET /interactive/state` carried the fixture people (names, birth dates, addresses) inside the
 * operator's admin-gated view of enrolled members, and the console sent no credential, so A11's gate
 * blanked it. Now the people are a static file the explorer serves beside the console's own pages,
 * the dump carries no person records other than members, and the console loads state as the
 * operator through one client.
 */
import fs from 'fs';
import path from 'path';
import net from 'net';
import { spawn, type ChildProcess } from 'child_process';
import { fixtureDirectory } from '../src/data/fixture-directory.js';

const REPO = path.resolve(__dirname, '..');

describe('the fixture directory', () => {
  test('carries the fixture people with the fields the console reads, and nothing from the runtime', () => {
    const d = fixtureDirectory();
    expect(d.members.length).toBeGreaterThan(0);
    expect(d.prescribers.length).toBeGreaterThan(0);
    expect(d.pharmacies.length).toBeGreaterThan(0);
    const m = d.members[0];
    for (const k of ['index', 'firstName', 'lastName', 'cardholderId', 'dateOfBirth', 'relationship', 'employeeId', 'familyId', 'address', 'city', 'state', 'zip', 'genderCode']) {
      expect(m).toHaveProperty(k);
    }
    expect(d.prescribers[0].name).toMatch(/^Dr\. /);
    expect(d.pharmacies[0]).toHaveProperty('ncpdpId');
    const json = JSON.stringify(d);
    for (const runtimeKey of ['medications', 'plan', 'active', 'currentTierLevel', 'enrolledMembers', 'walletId']) {
      expect(json).not.toContain(`"${runtimeKey}"`);
    }
  });

  test('the engine no longer embeds the fixture people in the state payload', () => {
    const src = fs.readFileSync(path.join(REPO, 'src/adjudication/interactive-service.ts'), 'utf8');
    const dump = src.slice(src.indexOf('  getState(): Record<string, unknown> {'));
    expect(dump).not.toContain('members: MEMBERS.map(');
    expect(dump).not.toContain('prescribers: PRESCRIBERS.map(');
    expect(dump).not.toContain('pharmacies: PHARMACIES.map(');
    expect(dump).toContain('medications: MEDICATIONS.map(');   // live formulary state stays with the engine
  });

  test('the console loads state through one client, with the operator token, and takes people from /fixtures.json', () => {
    const js = path.join(REPO, 'visualizer/src/js');
    const client = fs.readFileSync(path.join(js, 'interactive/state-client.js'), 'utf8');
    expect(client).toContain("fetch('/fixtures.json')");
    const auth = fs.readFileSync(path.join(js, 'interactive/operator-auth.js'), 'utf8');
    expect(auth).toContain("p.startsWith('/interactive/') || p.startsWith('/node/') || p.startsWith('/viz/')"); // D2 widened the wrapper to the engine's /node/* reads and the viz entity list
    expect(auth).toContain("'Bearer ' + token");
    const app = fs.readFileSync(path.join(js, 'interactive-app.js'), 'utf8');
    expect(app).toContain("import './interactive/operator-auth.js';");
    expect(app).toContain('loadInteractiveState(API_BASE)');
    // No screen fetches the dump directly any more.
    const files = fs.readdirSync(path.join(js, 'interactive')).filter((f) => f.endsWith('.js'));
    for (const f of [...files.map((f) => path.join('interactive', f)), 'interactive-app.js']) {
      const text = fs.readFileSync(path.join(js, f), 'utf8');
      expect({ file: f, direct: text.includes('fetch(`${API_BASE}/interactive/state`)') }).toEqual({ file: f, direct: false });
    }
  });
});

describe('the explorer serves it as a static file', () => {
  let child: ChildProcess | null = null;
  let url = '';

  beforeAll(async () => {
    const port = await new Promise<number>((resolve, reject) => {
      const s = net.createServer();
      s.on('error', reject);
      s.listen(0, '127.0.0.1', () => { const a = s.address(); const p = typeof a === 'object' && a ? a.port : 0; s.close(() => resolve(p)); });
    });
    url = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, ['--import', 'tsx', path.join(REPO, 'src', 'nodes', 'start-explorer.ts')], {
      cwd: REPO,
      env: { ...process.env, ZKTRIDENT_EXPLORER_PORT: String(port), ZKTRIDENT_SEQUENCER_URL: 'http://127.0.0.1:1', ZKTRIDENT_FORMULARY_LIMIT: '100', ZKTRIDENT_OPEN_BROWSERS: '0' },
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    const deadline = Date.now() + 60_000;
    for (;;) {
      try { const r = await fetch(`${url}/health`); if (r.status > 0) break; } catch { /* not yet */ }
      if (Date.now() > deadline) throw new Error('explorer did not start: ' + stderr);
      await new Promise((r) => setTimeout(r, 300));
    }
  }, 90_000);

  afterAll(() => { if (child && !child.killed) { try { child.kill(); } catch { /* best effort */ } } });

  test('GET /fixtures.json returns the directory, cacheable, as JSON', async () => {
    const r = await fetch(`${url}/fixtures.json`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/application\/json/);
    expect(r.headers.get('cache-control')).toMatch(/max-age/);
    const body = await r.json() as { members: unknown[]; prescribers: unknown[]; pharmacies: unknown[] };
    expect(body.members.length).toBeGreaterThan(0);
    expect(body.prescribers.length).toBeGreaterThan(0);
    expect(body.pharmacies.length).toBeGreaterThan(0);
    const again = await fetch(`${url}/fixtures.json`);
    expect(again.status).toBe(200);
  }, 60_000);
});
