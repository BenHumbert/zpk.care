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
 * Trace recorder for the end-to-end verifier.
 *
 * Every HTTP exchange and every independent check is recorded in order, with
 * full request and response bodies (secrets included — this tool is for local
 * verification runs with fictional people only). Large proof blobs are kept in
 * full in the JSON trace and abbreviated in the console.
 */
import fs from 'fs';
import path from 'path';

export interface Check { name: string; pass: boolean; expected?: unknown; actual?: unknown; note?: string }
export interface Exchange {
  method: string; url: string; headers: Record<string, string>; body?: unknown;
  status: number; response: unknown; ms: number;
}
export interface Step {
  n: number; actor: string; title: string; startedAt: string; ms: number;
  exchanges: Exchange[]; checks: Check[]; notes: string[]; secretsShown: Record<string, string>;
}

const bigintSafe = (_k: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v);

export class Trace {
  steps: Step[] = [];
  private current: Step | null = null;
  private t0 = 0;
  constructor(public outDir: string) { fs.mkdirSync(outDir, { recursive: true }); }

  begin(actor: string, title: string) {
    this.end();
    this.current = { n: this.steps.length + 1, actor, title, startedAt: new Date().toISOString(), ms: 0, exchanges: [], checks: [], notes: [], secretsShown: {} };
    this.t0 = Date.now();
    console.log(`\n── ${String(this.current.n).padStart(2, '0')} [${actor}] ${title}`);
  }
  end() {
    if (!this.current) return;
    this.current.ms = Date.now() - this.t0;
    this.steps.push(this.current);
    this.current = null;
    this.save();
  }
  note(msg: string) { this.cur().notes.push(msg); console.log(`   · ${msg}`); }
  secret(name: string, value: string) { this.cur().secretsShown[name] = value; console.log(`   🔑 ${name} = ${abbrev(value, 90)}`); }
  check(name: string, pass: boolean, expected?: unknown, actual?: unknown, note?: string) {
    this.cur().checks.push({ name, pass, expected: jsonable(expected), actual: jsonable(actual), note });
    console.log(`   ${pass ? 'PASS' : 'FAIL'}  ${name}${pass ? '' : `  expected=${abbrev(JSON.stringify(jsonable(expected)), 120)} actual=${abbrev(JSON.stringify(jsonable(actual)), 120)}`}${note ? `  (${note})` : ''}`);
    return pass;
  }
  record(x: Exchange) {
    this.cur().exchanges.push(x);
    const flag = x.status >= 400 ? '!!' : '->';
    console.log(`   ${flag} ${x.method} ${x.url} ${x.status} (${x.ms} ms)`);
  }
  private cur() { if (!this.current) this.begin('harness', 'unnamed'); return this.current!; }

  save() {
    fs.writeFileSync(path.join(this.outDir, 'trace.json'), JSON.stringify({ steps: this.steps }, bigintSafe, 2));
  }
  summary() {
    const checks = this.steps.flatMap(s => s.checks.map(c => ({ step: s.n, actor: s.actor, ...c })));
    return { steps: this.steps.length, checks: checks.length, passed: checks.filter(c => c.pass).length, failed: checks.filter(c => !c.pass) };
  }
}

export function abbrev(s: string, n: number) { return s.length > n ? s.slice(0, n - 12) + `…(+${s.length - n + 12})` : s; }
function jsonable(v: unknown): unknown {
  // Deep-convert bigints (and o1js Fields) so nested values can be stringified.
  return JSON.parse(JSON.stringify(v ?? null, (_k, x) => (typeof x === 'bigint' ? x.toString()
    : x && typeof x === 'object' && (x as any).constructor?.name === 'Field' ? (x as any).toString() : x)));
}

/** fetch wrapper that records the exchange in the trace. */
export function makeHttp(trace: Trace, defaults: { headers?: Record<string, string>; timeoutMs?: number } = {}) {
  return async function http(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any; text: string }> {
    const h: Record<string, string> = { ...(defaults.headers || {}), ...headers };
    if (body !== undefined) h['Content-Type'] = 'application/json';
    const t = Date.now();
    let status = 0, text = '';
    try {
      const res = await fetch(url, {
        method, headers: h, body: body === undefined ? undefined : JSON.stringify(body, bigintSafe),
        signal: AbortSignal.timeout(defaults.timeoutMs ?? 600_000),
      });
      status = res.status;
      text = await res.text();
    } catch (e: any) {
      text = `NETWORK ERROR: ${e?.message || e}`;
    }
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    trace.record({ method, url, headers: h, body, status, response: json ?? text, ms: Date.now() - t });
    return { status, json, text };
  };
}

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Poll until `done(json)` is truthy or the timeout passes. Only the final poll is recorded in full. */
export async function poll(http: ReturnType<typeof makeHttp>, url: string, done: (j: any) => boolean, timeoutMs = 900_000, everyMs = 3000) {
  const t = Date.now();
  let last: any = null;
  while (Date.now() - t < timeoutMs) {
    const r = await http('GET', url);
    last = r.json;
    if (done(last)) return { json: last, ms: Date.now() - t };
    await sleep(everyMs);
  }
  return { json: last, ms: Date.now() - t, timedOut: true };
}
