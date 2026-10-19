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
 * The live harnesses and the director wait for the claims engine to be ready to prove before their first proving step.
 *
 * What was wrong: the harnesses waited only until the engine's programs were compiled, then started; the engine's proof
 * pool was still compiling, so in the single-member run of 2026-10-19 the first prescription waited for it inside the
 * request and the check "Prescriber dashboard path completed" failed. Now run.ts and run-multi.ts read the sequencer's
 * /health and then poll GET /interactive/ready, up to 15 minutes, and record "Claims engine ready to prove" with the time
 * the wait took; the director waits for the same read in its pre-roll (through lib/reads.mjs, read-only) and a take does
 * not start if the engine is not ready within 15 minutes.
 *
 * The waits against a scripted local server; the director's module in a child process (it is an ES module the test
 * runner does not load); where the waits sit, read from the scripts.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { execFile } from 'child_process';
import { pathToFileURL } from 'url';
import { Trace, makeHttp } from '../scripts/e2e-verify/trace.js';
import { waitForEngineReady, ENGINE_READY_TIMEOUT_MS } from '../scripts/e2e-verify/engine-ready.js';

jest.setTimeout(60_000);

/** A sequencer that answers /health, and /interactive/ready with 503 `notReadyFor` times, then 200 (never when -1). */
function scriptedSequencer() {
  const seen: Array<{ path: string; authorization: string | undefined }> = [];
  let readyAsks = 0;
  let notReadyFor = 2;
  const server = http.createServer((req, res) => {
    const p = new URL(req.url ?? '/', 'http://localhost').pathname;
    seen.push({ path: p, authorization: req.headers.authorization });
    if (p === '/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, running: true })); return; }
    if (p === '/interactive/ready') {
      readyAsks++;
      const ready = notReadyFor >= 0 && readyAsks > notReadyFor;
      res.writeHead(ready ? 200 : 503, ready ? { 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json', 'Retry-After': '10' });
      // the extra field stands in for anything a broken engine might add; the readers keep only the summary
      res.end(JSON.stringify(ready ? { ready: true, compiled: true, prover: 'pool', walletId: '424242' } : { ready: false, compiled: true, prover: 'starting', walletId: '424242' }));
      return;
    }
    res.writeHead(404); res.end();
  });
  return {
    seen,
    reset(times: number) { seen.length = 0; readyAsks = 0; notReadyFor = times; },
    start: () => new Promise<string>((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as any).port}`))),
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const seq = scriptedSequencer();
let seqUrl: string;
let outDir: string;

beforeAll(async () => {
  seqUrl = await seq.start();
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-ready-harness-'));
});
afterAll(async () => {
  await seq.stop();
  fs.rmSync(outDir, { recursive: true, force: true });
});

describe("the harnesses' wait (scripts/e2e-verify/engine-ready.ts)", () => {
  test('reads /health, then polls GET /interactive/ready until the engine can prove, and says how long it took', async () => {
    seq.reset(2);
    const t0 = Date.now();
    const r = await waitForEngineReady(makeHttp(new Trace(outDir)), seqUrl, { everyMs: 20 });
    expect(r.ready).toBe(true);
    expect(r.readiness).toEqual({ ready: true, compiled: true, prover: 'pool' });
    expect(r.ms).toBeGreaterThanOrEqual(0);
    expect(r.ms).toBeLessThanOrEqual(Date.now() - t0);
    expect(seq.seen.map((s) => s.path)).toEqual(['/health', '/interactive/ready', '/interactive/ready', '/interactive/ready']);
    expect(seq.seen.every((s) => s.authorization === undefined)).toBe(true); // an open read: no credential is sent
  });

  test('gives up after its timeout and reports the engine as not ready, with its last answer', async () => {
    seq.reset(-1);
    const r = await waitForEngineReady(makeHttp(new Trace(outDir)), seqUrl, { timeoutMs: 300, everyMs: 50 });
    expect(r.ready).toBe(false);
    expect(r.readiness).toEqual({ ready: false, compiled: true, prover: 'starting' });
    expect(r.ms).toBeGreaterThanOrEqual(300);
  });

  test('waits up to 15 minutes by default', () => {
    expect(ENGINE_READY_TIMEOUT_MS).toBe(15 * 60_000);
  });
});

describe('where the harnesses wait', () => {
  const read = (f: string) => fs.readFileSync(f, 'utf-8').replace(/\r\n/g, '\n');

  test.each([
    ['scripts/e2e-verify/run.ts', 'trace', "trace.check('Adjudication service compiled all 10 circuits'", '── 2. Security probes before anything is set up'],
    ['scripts/e2e-verify/run-multi.ts', 't', "t.check('All circuits compiled'", "t.begin('insurer', 'Create the plan');"],
  ])('%s waits for the engine in its readiness step, before anything else, and records the check with the time', (file, tr, compiledCheck, nextStep) => {
    const src = read(file);
    expect(src).toContain("import { waitForEngineReady } from './engine-ready.js';");
    const wait = src.indexOf('const provers = await waitForEngineReady(quiet, SEQ);');
    const check = src.indexOf(`${tr}.check('Claims engine ready to prove', provers.ready, 'ready within 15 min', provers.readiness, \`waited \${(provers.ms / 1000).toFixed(1)} s\`);`);
    expect(wait).toBeGreaterThan(src.indexOf(compiledCheck));
    expect(src.indexOf(compiledCheck)).toBeGreaterThan(0);
    expect(check).toBeGreaterThan(wait);
    expect(src.indexOf(nextStep)).toBeGreaterThan(check);
    expect(src).toContain('results.engineReadyWaitMs = provers.ms;');
  });
});

/** Runs tools/demo/lib/reads.mjs in a child process against the scripted sequencer; prints what the script returns. */
function runReads(script: string, env: Record<string, string>): Promise<any> {
  const readsUrl = pathToFileURL(path.resolve('tools/demo/lib/reads.mjs')).href;
  const code = `const m = await import(process.env.READS_URL);\nconst out = await (async () => { ${script} })();\nprocess.stdout.write(JSON.stringify(out));`;
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, READS_URL: readsUrl, SEQ_URL: seqUrl, ...env }, timeout: 30_000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`${err.message}\n${stderr}`));
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error(`not JSON: ${stdout}\n${stderr}`)); }
    });
  });
}

describe("the director's wait (tools/demo/lib/reads.mjs)", () => {
  const script = `
    const reads = m.makeReads({ seqUrl: process.env.SEQ_URL, operatorToken: 'operator-token-never-sent-here' });
    const first = await reads.engineReady();
    const logs = [];
    const waited = await m.waitForEngineReady(reads, { everyMs: 20, timeoutMs: Number(process.env.TIMEOUT_MS), log: (s) => logs.push(s) })
      .catch((e) => ({ refused: e.message }));
    return { first, waited, logs };`;

  test('reads GET /interactive/ready without the operator token, keeps only the summary, and waits until the engine can prove', async () => {
    seq.reset(2);
    const out = await runReads(script, { TIMEOUT_MS: '10000' });
    expect(out.first).toEqual({ ready: false, compiled: true, prover: 'starting' }); // a 503 is read, not thrown
    expect(out.waited).toMatchObject({ ready: true, compiled: true, prover: 'pool' });
    expect(Object.keys(out.waited).sort()).toEqual(['compiled', 'prover', 'ready', 'waitedMs']);
    expect(typeof out.waited.waitedMs).toBe('number');
    expect(out.logs).toEqual(['the claims engine is not ready to prove yet (compiled yes, prover starting)']); // said once, not per read
    expect(seq.seen.every((s) => s.path === '/interactive/ready' && s.authorization === undefined)).toBe(true);
  });

  test('throws once the timeout passes, so a take does not start on an engine that would refuse its proofs', async () => {
    seq.reset(-1);
    const out = await runReads(script, { TIMEOUT_MS: '1000' });
    expect(out.waited.refused).toMatch(/^the claims engine did not become ready to prove within 1 s \(compiled yes, prover starting\): a take does not start/);
  });

  test('the director waits for it in its pre-roll, after the circuits compile and before the first scene, for 15 minutes', () => {
    const src = read('tools/demo/director.mjs');
    expect(src).toContain("import { makeReads, insurerAdminToken, prescriberAdminToken, waitForEngineReady } from './lib/reads.mjs';");
    const compiled = src.indexOf("await timed('network-ready', () => until('the network compiling its circuits'");
    const logged = src.indexOf("log('network: waiting until the claims engine is ready to prove');");
    const wait = src.indexOf("\nconst provers = await timed('engine-ready', () => waitForEngineReady(reads, { timeoutMs: 15 * 60000, log: (m) => log(`network: ${m}`) }));");
    const done = src.indexOf('log(`network: the claims engine is ready to prove (prover: ${provers.prover}; waited ${(provers.waitedMs / 1000).toFixed(1)} s)`);');
    expect(compiled).toBeGreaterThan(0);
    expect(logged).toBeGreaterThan(compiled);
    expect(wait).toBeGreaterThan(logged);
    expect(done).toBeGreaterThan(wait);
    expect(src.indexOf('pre-roll 3: the browser, the cameras')).toBeGreaterThan(done);
    expect(src.indexOf("log('T0: the film starts');")).toBeGreaterThan(done);
  });
});

function read(f: string): string {
  return fs.readFileSync(f, 'utf-8').replace(/\r\n/g, '\n');
}
