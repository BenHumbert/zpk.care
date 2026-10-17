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
 * Network surface check — the acceptance test for phase A item A2.
 *
 * Asks four questions of every listener this deployment runs, against the running system
 * rather than against the source:
 *
 *   1. Is it reachable from another machine? Each listener is dialled on this host's own
 *      LAN address as well as on loopback. Loopback must answer; the LAN address must not.
 *      This is the one that matters: rule I4 says nothing outside the member's app can
 *      reach the app, and a listener on 0.0.0.0 hands the whole local network a way in.
 *   2. Does a dashboard still work? A request carrying an allowlisted browser Origin must
 *      come back with that exact Origin in Access-Control-Allow-Origin, or the dashboards
 *      are broken and the fix has traded one failure for another.
 *   3. Is a foreign page refused? A request carrying an Origin that is not on the list must
 *      come back with no Access-Control-Allow-Origin header at all — not a wildcard, and
 *      not the literal 'null', which grants every null-origin context. The prover (:4040)
 *      is the exception: it grants nobody, which is intended, so it is checked the other
 *      way round.
 *   4. Is the /rpc proxy narrow? A node's proxy has to keep working — the member dashboard
 *      and the explorer page reach the sequencer only through it — so this checks the shape
 *      of the allowlist rather than its absence: a method the role's own page calls must be
 *      forwarded, and a method it does not must be refused. An admin method is used as the
 *      probe for the second half, since that is the case that mattered: before A2 any method
 *      at all was relayed.
 *
 * A listener that is not running is reported as skipped, never as a pass: a closed port
 * proves nothing about the policy that port would have applied.
 *
 * Usage:
 *   npx tsx scripts/e2e-verify/check-network-surface.ts [--strict]
 *
 *   --strict         exit 1 if any check fails (for use as an acceptance test)
 *   E2E_LAN_IP       this host's LAN address (default: first non-loopback IPv4 found)
 *   E2E_PORTS        ports to probe (default 3030,3031,3032,4001,4002,4003,4004,4040,8000)
 */
import os from 'os';

const args = process.argv.slice(2);
const STRICT = args.includes('--strict');
const PORTS = (process.env.E2E_PORTS ?? '3030,3031,3032,4001,4002,4003,4004,4040,8000')
  .split(',').map((s) => Number(s.trim())).filter(Boolean);
/**
 * How long to wait for one answer. Generous on purpose: the sequencer compiles ten
 * ZkPrograms on its main thread after boot, so its event loop stalls for seconds at a
 * time and a short timeout reports a working policy as broken.
 */
const PROBE_MS = Number(process.env.E2E_PROBE_MS ?? 20_000);
/** Retries per probe, because one stall should not become a verdict. */
const PROBE_TRIES = Number(process.env.E2E_PROBE_TRIES ?? 3);

/** A browser origin that the default policy allows. */
const ALLOWED_ORIGIN = 'http://localhost:4001';
/** A page the user might have open in another tab. Must never be granted. */
const FOREIGN_ORIGIN = 'http://evil.example.com';
/** The proof delegate. Deliberately has no CORS at all; see the check below. */
const PROVER_PORT = 4040;

function lanIp(): string | null {
  if (process.env.E2E_LAN_IP) return process.env.E2E_LAN_IP;
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return null;
}

type Outcome = 'pass' | 'fail' | 'skip';
interface Result { port: number; check: string; outcome: Outcome; detail: string }

const results: Result[] = [];
function record(port: number, check: string, outcome: Outcome, detail: string): void {
  results.push({ port, check, outcome, detail });
}

type Probe = { status: number; acao: string | null } | { error: string };

async function probeOnce(url: string, init: RequestInit, timeoutMs: number): Promise<Probe> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal });
    // Drain, so the connection is not left half-read.
    await res.text().catch(() => '');
    return { status: res.status, acao: res.headers.get('access-control-allow-origin') };
  } catch (err: unknown) {
    return { error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/** A refused connection is an answer and is returned at once; a stall is retried. */
function isStall(p: Probe): boolean {
  return 'error' in p && /abort|timeout|timed out/i.test(p.error);
}

async function probe(url: string, init: RequestInit = {}, timeoutMs = PROBE_MS): Promise<Probe> {
  let last: Probe = { error: 'not attempted' };
  for (let attempt = 1; attempt <= PROBE_TRIES; attempt++) {
    last = await probeOnce(url, init, timeoutMs);
    if (!isStall(last)) return last;
  }
  return { error: `no answer in ${PROBE_TRIES} tries of ${timeoutMs} ms (event loop busy?)` };
}

async function main(): Promise<void> {
  const lan = lanIp();
  console.log('');
  console.log('  Network surface check  (phase A item A2)');
  console.log('  loopback 127.0.0.1   LAN %s', lan ?? 'not found — reachability check will be skipped');
  console.log('');

  for (const port of PORTS) {
    const base = 'http://127.0.0.1:' + port;

    // Is anything listening at all? Any HTTP status counts, including 404.
    const alive = await probe(base + '/health');
    if ('error' in alive) {
      record(port, 'listening', 'skip', alive.error.slice(0, 60));
      continue;
    }

    // ── 1. loopback only ────────────────────────────────────────────
    if (!lan) {
      record(port, 'loopback only', 'skip', 'no LAN address to dial');
    } else {
      const remote = await probe('http://' + lan + ':' + port + '/health', {}, 3000);
      if ('error' in remote) {
        record(port, 'loopback only', 'pass', 'the LAN address refused the connection');
      } else {
        record(port, 'loopback only', 'fail',
          'answered on ' + lan + ':' + port + ' with ' + remote.status + ' — reachable from the network');
      }
    }

    // ── 2. an allowlisted browser origin is granted ─────────────────
    // Except on the prover. It emits no CORS headers and should not: the member dashboard's
    // helper will POST a wallet preimage to :4040/prove if it can, which is exactly the
    // delegation question rule I2 turns on. Keeping the browser out of :4040 is the intended
    // state here, so a grant would be the failure.
    const good = await probe(base + '/health', { headers: { Origin: ALLOWED_ORIGIN } });
    if (port === PROVER_PORT) {
      if ('error' in good) {
        record(port, 'prover closed to browsers', 'pass', good.error.slice(0, 60));
      } else if (good.acao === null) {
        record(port, 'prover closed to browsers', 'pass',
          'no allow-origin header — a page cannot read a response from the prover');
      } else {
        record(port, 'prover closed to browsers', 'fail',
          'granted ' + good.acao + ' — a page could delegate proving and send a preimage off the device');
      }
    } else if ('error' in good) {
      record(port, 'dashboard origin granted', 'fail', good.error.slice(0, 60));
    } else if (good.acao === ALLOWED_ORIGIN) {
      record(port, 'dashboard origin granted', 'pass', 'echoed ' + ALLOWED_ORIGIN);
    } else if (good.acao === '*') {
      record(port, 'dashboard origin granted', 'fail', 'wildcard — grants every origin');
    } else {
      record(port, 'dashboard origin granted', 'fail',
        'header was ' + (good.acao === null ? 'absent' : good.acao) +
        ' — a dashboard on this origin cannot read the response');
    }

    // ── 3. a foreign origin is refused ──────────────────────────────
    // On the prover this is the same assertion as check 2, so it is not repeated.
    const bad = port === PROVER_PORT
      ? null
      : await probe(base + '/health', { headers: { Origin: FOREIGN_ORIGIN } });
    if (bad === null) {
      // covered by 'prover closed to browsers'
    } else
    if ('error' in bad) {
      record(port, 'foreign origin refused', 'fail', bad.error.slice(0, 60));
    } else if (bad.acao === null) {
      record(port, 'foreign origin refused', 'pass', 'no allow-origin header');
    } else if (bad.acao === 'null') {
      record(port, 'foreign origin refused', 'fail',
        "the literal 'null' — grants file:// pages and sandboxed iframes");
    } else {
      record(port, 'foreign origin refused', 'fail', 'granted ' + bad.acao);
    }

    // ── 4. the /rpc proxy is narrow, not absent ─────────────────────
    // The entity nodes and the explorer carry a proxy; :3030's own /rpc is the real API and
    // is not one, so it is left out here.
    const hasProxy = (port >= 4001 && port <= 4004) || port === 8000;
    if (hasProxy) {
      const rpc = (method: string): Promise<Probe> => probe(base + '/rpc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: [] }),
      });

      // (a) a method this role's page actually calls must still get through
      const allowed = await rpc('l2_getStatus');
      if ('error' in allowed) {
        record(port, 'proxy serves its page', 'fail', allowed.error.slice(0, 60));
      } else if (allowed.status === 200) {
        record(port, 'proxy serves its page', 'pass', 'l2_getStatus forwarded');
      } else if (allowed.status === 404) {
        record(port, 'proxy serves its page', 'skip', 'proxy disabled on this node');
      } else {
        record(port, 'proxy serves its page', 'fail',
          'l2_getStatus answered ' + allowed.status + ' — this role’s dashboard is broken');
      }

      // (b) a method it does not call must be refused by the node, not relayed
      const denied = await rpc('l2_deletePlan');
      if ('error' in denied) {
        record(port, 'proxy refuses the rest', 'pass', denied.error.slice(0, 60));
      } else if (denied.status === 403 || denied.status === 404) {
        record(port, 'proxy refuses the rest', 'pass',
          'l2_deletePlan refused with ' + denied.status);
      } else {
        record(port, 'proxy refuses the rest', 'fail',
          'l2_deletePlan was relayed to the sequencer and answered ' + denied.status);
      }
    }
  }

  // ── Report ──────────────────────────────────────────────────────
  const byPort = new Map<number, Result[]>();
  for (const r of results) {
    if (!byPort.has(r.port)) byPort.set(r.port, []);
    byPort.get(r.port)!.push(r);
  }
  const mark: Record<Outcome, string> = { pass: 'PASS', fail: 'FAIL', skip: 'skip' };
  // Node's console.log has no width specifier, so pad by hand.
  const pad = (t: string, n: number): string => (t.length >= n ? t : t + ' '.repeat(n - t.length));
  for (const [port, rs] of [...byPort].sort((a, b) => a[0] - b[0])) {
    const notRunning = rs.length === 1 && rs[0].check === 'listening';
    console.log('  :%d%s', port, notRunning ? '  not running — no checks applied' : '');
    if (notRunning) continue;
    for (const r of rs) console.log('    %s  %s %s', mark[r.outcome], pad(r.check, 26), r.detail);
  }

  const failed = results.filter((r) => r.outcome === 'fail');
  const passed = results.filter((r) => r.outcome === 'pass');
  const skipped = results.filter((r) => r.outcome === 'skip');
  console.log('');
  console.log('  %d passed, %d failed, %d skipped', passed.length, failed.length, skipped.length);

  if (failed.length === 0 && passed.length === 0) {
    console.log('  INCONCLUSIVE — nothing was listening, so no policy was tested.');
    if (STRICT) process.exit(1);
    return;
  }
  if (failed.length > 0) {
    console.log('');
    console.log('  I4 is NOT met: %s', [...new Set(failed.map((f) => f.check))].join(', '));
    if (STRICT) process.exit(1);
  } else {
    console.log('  I4 holds for every listener that was running.');
  }
}

void main();
