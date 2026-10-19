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
 * The insurer node names, at boot, every plan that must be published again (review of the pricing fixes, F11).
 *
 * What was wrong: InsurerNode.reportPlansNeedingRepublish existed, but nothing called it. A plan marked published
 * before plan-bound formularies kept its terms carries no published terms: the engine refuses its members (409 at
 * prescribe, PA approval and fill) and /enrollment/complete refuses new employees, while the boot log said nothing.
 *
 * Now src/nodes/start-insurer-nautilus.ts runs the report once the sequencer answers, one line per such plan with its
 * plan ID and name and nothing else.
 *
 * The real boot script in a child process, against a stand-in sequencer that answers the boot's calls and holds three
 * plans: one published before the terms were kept, one published with its terms, and one draft.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { spawn, type ChildProcess } from 'child_process';
import type { AddressInfo } from 'net';

jest.setTimeout(240_000);

const REPO = path.resolve(__dirname, '..');
const TERMS = {
  copayAmountCents: 1500, coverageType: 1, deductibleAmountCents: 50000, oopMaxCents: 780000, annualBenefitMaxCents: 0,
  familyDeductibleAmountCents: 100000, familyOopMaxCents: 1600000, familyAnnualBenefitMaxCents: 0, dispensingFeeCents: 1250,
  formularyNdcs: [], networkProviderWalletIds: [], formularyRoot: '12345', networkRoot: '0', publishedAt: 1,
};
const PLANS = [
  // published before the terms were kept: the overlay version as its formularyRoot. Its name tries to forge a log line.
  { planId: 'PLAN-STALE', name: 'Stale plan\r\n[insurer] forged line', published: true, formularyRoot: '1', copayAmountCents: 1500 },
  { planId: 'PLAN-CURRENT', name: 'Current plan', published: true, formularyRoot: '12345', publishedTerms: TERMS, copayAmountCents: 1500 },
  { planId: 'PLAN-DRAFT', name: 'Draft plan', published: false, copayAmountCents: 1500 },
];

let sequencer: http.Server;
let child: ChildProcess | null = null;
let stateDir: string;
let output = '';
const asked: string[] = [];

beforeAll(async () => {
  sequencer = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (req.method === 'GET' && (req.url ?? '').startsWith('/health')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      let method = '';
      try { method = String((JSON.parse(raw || '{}') as { method?: string }).method ?? ''); } catch { method = ''; }
      asked.push(method);
      const result = method === 'l2_getPlans' ? PLANS
        : method === 'l2_getFormularyDrugCount' ? { count: 100 }
          : method === 'l2_publishPlanOverlay' ? { success: true, version: 1 }
            : method === 'l2_credentialProvider' ? { success: true }
              : null;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
    });
  });
  await new Promise<void>((resolve) => sequencer.listen(0, '127.0.0.1', () => resolve()));
  const seqUrl = `http://127.0.0.1:${(sequencer.address() as AddressInfo).port}`;
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'insurer-boot-'));

  const env: NodeJS.ProcessEnv = {};
  for (const k of ['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA']) {
    if (process.env[k] !== undefined) env[k] = process.env[k];
  }
  Object.assign(env, {
    ZKTRIDENT_PORT: '0', ZKTRIDENT_HOST: '127.0.0.1', ZKTRIDENT_SEQUENCER_URL: seqUrl, ZKTRIDENT_STATE_DIR: stateDir,
    ZKTRIDENT_SSE: 'false', ZKTRIDENT_ADMIN_TOKEN: 'insurer-admin-token-for-boot-test', ZKTRIDENT_FORMULARY_LIMIT: '100',
  });
  child = spawn(process.execPath, ['--import', 'tsx', path.join(REPO, 'src', 'nodes', 'start-insurer-nautilus.ts')], {
    cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  child.stdout?.on('data', (d: Buffer) => { output += d.toString(); });
  child.stderr?.on('data', (d: Buffer) => { output += d.toString(); });
  const deadline = Date.now() + 200_000;
  while (!output.includes('Credentialing complete')) {
    if (child.exitCode !== null) throw new Error('the insurer node exited during boot:\n' + output);
    if (Date.now() > deadline) throw new Error('the insurer node did not finish booting:\n' + output);
    await new Promise((r) => setTimeout(r, 250));
  }
}, 230_000);

afterAll(async () => {
  if (child && child.exitCode === null) {
    const exited = new Promise<void>((resolve) => child!.once('exit', () => resolve()));
    child.kill();
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
  }
  await new Promise<void>((resolve) => sequencer.close(() => resolve()));
  try { fs.rmSync(stateDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('the insurer boot names the plans that must be published again', () => {
  test('it reads the plans once the sequencer answers', () => {
    expect(asked).toContain('l2_getPlans');
  });

  test('a plan marked published with no published terms is named, by ID and name', () => {
    expect(output).toContain('[insurer] Plan PLAN-STALE (Stale plan [insurer] forged line) is marked published but has no published terms');
  });

  test('a plan published with its terms, and a draft, are not named', () => {
    expect(output).not.toMatch(/Plan PLAN-CURRENT \(/);
    expect(output).not.toMatch(/Plan PLAN-DRAFT \(/);
  });

  test('a line break in a plan name cannot forge a log line', () => {
    expect(output.split(/\r?\n/).some((line) => line.trimStart().startsWith('[insurer] forged line'))).toBe(false);
  });
});
