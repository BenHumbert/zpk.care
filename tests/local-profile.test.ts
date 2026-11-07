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
 * The local profile behind `npm run setup` and `npm start` (cleanup plan, phase 4.1): one machine runs the whole
 * network secured, with secrets made at setup, and a first-time user gets the files and the tokens the walkthrough asks
 * for without writing them by hand.
 *
 * What was wrong: the README's quick start booted the unsecure mode; a secured boot needed a hand-made env file; the
 * walkthrough asked for a roster CSV and an EIN letter nobody had, and for tokens no page named.
 */
import net from 'net';
import { parseEnv } from 'util';
import {
  SECRETS,
  SETTINGS,
  newLocalEnv,
  portIsFree,
  firstFreePort,
  networkPorts,
  readLocalEnv,
  launchArgs,
} from '../scripts/local/profile.js';
import { isThisCheckout } from '../scripts/dev/kill-ports-lib.js';
import { SAMPLE_ROSTER, rosterCsv, sampleLetterPdf, writeSamples } from '../scripts/local/samples.js';
import { guideText } from '../scripts/local/guide.js';
import { parseCsv } from '../src/tools/hr-tool-core.js';
import { normalizeMobile } from '../src/tools/text-service.js';
import fs from 'fs';
import os from 'os';
import path from 'path';

describe('the local env file', () => {
  test('carries every secret, freshly made, and the settings for a quick first boot', () => {
    const env = parseEnv(newLocalEnv(8010)) as Record<string, string>;
    for (const s of SECRETS) expect(env[s.name]).toEqual(expect.any(String));
    for (const s of SETTINGS) expect(env[s.name]).toBe(s.value);
    expect(env.ZKTRIDENT_EXPLORER_PORT).toBe('8010');
    // read as hex by the sequencer (the gossip secret also seeds its NFC attestation key)
    expect(env.ZKTRIDENT_ADMIN_TOKEN).toMatch(/^[0-9a-f]{64}$/);
    expect(env.ZKTRIDENT_GOSSIP_SECRET).toMatch(/^[0-9a-f]{64}$/);
    for (const name of ['ZKTRIDENT_INSURER_ADMIN_TOKEN', 'ZKTRIDENT_PRESCRIBER_ADMIN_TOKEN', 'ZKTRIDENT_PROVER_API_KEY']) {
      expect(env[name]).toMatch(/^[A-Za-z0-9_-]{32}$/);
    }
    expect(env.ZKTRIDENT_INSURER_SIGNING_SEED).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(env.ZKTRIDENT_UNSECURE).toBeUndefined();
  });

  test('two setups never share a secret', () => {
    const a = parseEnv(newLocalEnv(8000)) as Record<string, string>;
    const b = parseEnv(newLocalEnv(8000)) as Record<string, string>;
    for (const s of SECRETS) expect(a[s.name]).not.toBe(b[s.name]);
  });

  test('reads back what it wrote, and says when there is none', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zpk-local-'));
    const file = path.join(dir, 'local.env');
    expect(readLocalEnv(file)).toBeNull();
    const text = newLocalEnv(8000);
    fs.writeFileSync(file, text);
    expect(readLocalEnv(file)).toEqual(parseEnv(text));
  });
});

describe('the ports', () => {
  test('a port someone holds is not free, and the next free one is found', async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const held = (server.address() as net.AddressInfo).port;
    try {
      expect(await portIsFree(held)).toBe(false);
      const next = await firstFreePort(held, held + 20);
      expect(next).not.toBeNull();
      expect(next).not.toBe(held);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
    expect(await portIsFree(held)).toBe(true);
  });

  test("npm start launches the network and the HR Tool so that npm stop knows them as this checkout's", () => {
    // live, 2026-11-07: with relative script paths npm stop left the sequencer and the HR Tool running
    const root = path.resolve(__dirname, '..');
    const { network, hrTool } = launchArgs(root);
    for (const args of [network, hrTool]) {
      expect(isThisCheckout({ name: 'node.exe', commandLine: [process.execPath, ...args].join(' ') }, root)).toBe(true);
    }
  });

  test("the network's ports include the explorer's, wherever setup moved it, and the HR Tool's", () => {
    const ports = networkPorts(8010).map((p) => p.port);
    expect(ports).toEqual(expect.arrayContaining([3030, 3031, 3032, 4001, 4002, 4003, 4004, 4040, 8010, 5050]));
    expect(ports).not.toContain(8000);
  });
});

describe('the sample files', () => {
  test('the roster is what the HR Tool imports, every mobile a fictional number it can text', () => {
    const records = parseCsv(rosterCsv());
    expect(records).toHaveLength(SAMPLE_ROSTER.length);
    expect(records.map((r) => r.employeeId)).toEqual(SAMPLE_ROSTER.map((r) => r.employee_id));
    for (const row of SAMPLE_ROSTER) {
      expect(normalizeMobile(row.mobile)).toMatch(/^\+1608555010\d$/); // 555-0100 to 555-0199: set aside for fiction
      expect(row.dob).toMatch(/^\d{8}$/);
      if (row.email) expect(row.email).toMatch(/@example\.test$/);
    }
  });

  test('the EIN letter is a valid one-page PDF that says it is fictional', () => {
    const pdf = sampleLetterPdf();
    const text = pdf.toString('latin1');
    expect(text.startsWith('%PDF-1.4\n')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(text).toContain('fictional');
    // every object sits at the offset the cross-reference table gives it
    const xrefAt = Number(/startxref\n(\d+)\n/.exec(text)![1]);
    const offsets = text
      .slice(xrefAt)
      .split('\n')
      .filter((l) => / 00000 n $/.test(l))
      .map((l) => Number(l.slice(0, 10)));
    offsets.forEach((offset, i) => expect(text.slice(offset).startsWith(`${i + 1} 0 obj`)).toBe(true));
  });

  test('are written once, and a file already there is kept', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zpk-samples-'));
    const { roster } = writeSamples(dir);
    fs.writeFileSync(roster, 'edited by hand\n');
    writeSamples(dir);
    expect(fs.readFileSync(roster, 'utf8')).toBe('edited by hand\n');
  });
});

describe('the guide', () => {
  const env = parseEnv(newLocalEnv(8010)) as Record<string, string>;

  test('names every dashboard and the tab that takes each token, with the values only when asked', () => {
    const quiet = guideText(env, false);
    for (const url of [
      'http://localhost:4004/',
      'http://localhost:4004/marketplace/',
      'http://localhost:5050/',
      'http://localhost:4001/',
      'http://localhost:4002/',
      'http://localhost:4003/',
      'http://localhost:3030/',
      'http://localhost:8010/',
    ]) {
      expect(quiet).toContain(url);
    }
    expect(quiet).toContain('Admin tab');
    expect(quiet).toContain('Config & Admin tab');
    for (const s of SECRETS) expect(quiet).not.toContain(env[s.name]);

    const loud = guideText(env, true);
    for (const name of ['ZKTRIDENT_INSURER_ADMIN_TOKEN', 'ZKTRIDENT_PRESCRIBER_ADMIN_TOKEN', 'ZKTRIDENT_ADMIN_TOKEN']) {
      expect(loud).toContain(`${name} = ${env[name]}`);
    }
    // the secrets no page asks for stay out of it
    expect(loud).not.toContain(env.ZKTRIDENT_GOSSIP_SECRET);
    expect(loud).not.toContain(env.ZKTRIDENT_INSURER_SIGNING_SEED);
  });
});
