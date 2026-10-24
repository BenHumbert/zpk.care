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
 * A provider node serves this machine only, until provider sign-in (B4).
 *
 * What was wrong: the pharmacy node's GET /prescriptions/list and GET /dispensing* routes, and the prescriber node's
 * GET /prescriptions*, GET /pcp/patients and GET /messaging/* routes, take no credential. Each reads the sequencer or
 * the engine signed as the provider's own wallet or node key, which the read gate (D1) and the engine admit, and hands
 * the answer to whoever asked: the provider's whole book of member wallet IDs, drugs, quantities, dates, copays and
 * message metadata. The fill, reversal, prescribing and message routes write in the provider's name the same way. The
 * nodes bind to loopback by default, but ZKTRIDENT_HOST=0.0.0.0 or :: drew only a warning, an empty value not even
 * that, and the node served every interface. The Host check (A-82) does not close that: it turns away a rebound browser
 * page, not a client on another machine that names a loopback Host. A loopback node also answered the names in
 * ZKTRIDENT_PUBLIC_HOSTS, which is how RUNNING.md puts a node behind a reverse proxy, and a proxy brings other machines
 * to the same routes.
 *
 * How it was found: the confused-deputy sweep of the review of round eight of the security fixes, 2026-10-24.
 *
 * What is true now: start-pharmacy-nautilus.ts and start-prescriber-nautilus.ts exit at boot, before they listen, when
 * ZKTRIDENT_HOST is anything but a loopback address (127.0.0.0/8, ::1 or localhost), with a message that says why (the
 * routes answer anyone, so the node must not be reachable beyond this machine until B4) and what to do instead. They
 * answer no public name: a request that names one gets 421, and the boot log says why. A public name does not stop
 * them, since on a loopback bind it exposes nothing by itself and the whole-network launcher passes its own environment
 * to every node it starts. With the default loopback bind each starts and serves as before.
 *
 * The real launchers run as child processes, unseeded, so they start without a sequencer to reach.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import net from 'net';
import { spawn, type ChildProcess } from 'child_process';

jest.setTimeout(120_000);

const REPO = path.resolve(__dirname, '..');
const ROLES = ['pharmacy', 'prescriber'] as const;

/** What a launcher did: exited with a code, or came up and served on a port. */
interface Launch {
  exitCode: number | null;
  port: number | null;
  output: string;
  child: ChildProcess;
  /** Settles once the process has exited and everything it wrote has been read. */
  closed: Promise<void>;
}

const launched: Launch[] = [];
const stateDirs: string[] = [];
/** A port nothing listens on, for the sequencer an unseeded node does not call at boot. */
let noSequencerPort = 0;

beforeAll(async () => {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()));
  noSequencerPort = (probe.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
});

afterAll(async () => {
  for (const run of launched) await stop(run);
  for (const dir of stateDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

/** Start a provider launcher with these settings, and wait until it exits or serves. */
async function launch(role: string, settings: Record<string, string>): Promise<Launch> {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), `provider-loopback-${role}-`));
  stateDirs.push(stateDir);
  // Only what Node needs to run, so a ZKTRIDENT_ setting in the developer's own shell cannot reach the launcher.
  const env: NodeJS.ProcessEnv = {};
  for (const k of ['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA']) {
    if (process.env[k] !== undefined) env[k] = process.env[k];
  }
  Object.assign(env, {
    ZKTRIDENT_PORT: '0', ZKTRIDENT_STATE_DIR: stateDir, ZKTRIDENT_SEQUENCER_URL: `http://127.0.0.1:${noSequencerPort}`,
    ZKTRIDENT_SSE: 'false',
  }, settings);
  const script = path.join(REPO, 'src', 'nodes', `start-${role}-nautilus.ts`);
  const child = spawn(process.execPath, ['--import', 'tsx', script], {
    cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  const run: Launch = { exitCode: null, port: null, output: '', child, closed };
  launched.push(run);
  child.stdout?.on('data', (d: Buffer) => { run.output += d.toString(); });
  child.stderr?.on('data', (d: Buffer) => { run.output += d.toString(); });
  const deadline = Date.now() + 90_000;
  for (;;) {
    const api = /API: +https?:\/\/\S*:(\d+)/.exec(run.output);
    if (api && run.output.includes('Nautilus App is running')) {
      run.port = Number(api[1]);
      return run;
    }
    if (child.exitCode !== null) {
      await run.closed;   // everything it wrote has been read
      run.exitCode = child.exitCode;
      return run;
    }
    if (Date.now() > deadline) throw new Error(`the ${role} launcher neither exited nor served:\n${run.output}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function stop(run: Launch): Promise<void> {
  if (run.child.exitCode === null && run.child.signalCode === null) run.child.kill();
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([run.closed, new Promise<void>((resolve) => { timer = setTimeout(resolve, 5000); })]);
  clearTimeout(timer);
}

/** The status a GET /health on 127.0.0.1:port answers with this Host header. */
function healthStatus(port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const options = { host: '127.0.0.1', port, path: '/health', headers: { Host: host }, agent: false };
    const req = http.request(options, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

describe('the whole-network launcher', () => {
  // Found by the review of this round: start-leviathan passed its own ZKTRIDENT_HOST to the provider children, so a
  // network launched with a wider bind came up with both of them refusing it and exiting.
  test('starts its prescriber and pharmacy children on loopback, with none of its own public names or proxies', () => {
    const boot = fs.readFileSync(path.join(REPO, 'src', 'nodes', 'start-leviathan.ts'), 'utf8').replace(/\r\n/g, '\n');
    expect(boot).toContain("const PROVIDER_LISTENER = { ZKTRIDENT_HOST: '127.0.0.1', ZKTRIDENT_PUBLIC_HOSTS: '', ZKTRIDENT_TRUSTED_PROXIES: '' };");
    for (const role of ROLES) {
      const at = boot.indexOf(`spawnEntity('${role}'`);
      expect([role, at > 0]).toEqual([role, true]);
      const call = boot.slice(at, boot.indexOf('});', at));
      expect([role, call.includes('...PROVIDER_LISTENER')]).toEqual([role, true]);   // before: the child inherited the launcher's bind
    }
  });
});

describe.each(ROLES)('the %s launcher', (role) => {
  const refusal = (host: string): string => `[FATAL] ${role} node: ZKTRIDENT_HOST is "${host}", not a loopback address.`;

  /** The refusal says why the node may not be reached from elsewhere, and what to do instead. */
  const expectReasonAndRemedy = (output: string): void => {
    expect(output).toContain('Until provider sign-in (B4) its routes answer anyone who reaches its port');   // before: no such line
    expect(output).toContain('so it must not be reachable beyond this machine');                             // before: no such line
    expect(output).toContain('Unset ZKTRIDENT_HOST or set it to 127.0.0.1, ::1 or localhost, and use the dashboard on this machine');   // before: no such line
    expect(output).toContain('Do not put a reverse proxy in front of it either: until then the node answers no public name');   // before: no such line
  };

  test.each(['0.0.0.0', '::'])('bound to the wildcard %s it exits before it listens, and says why and what to do instead', async (host) => {
    const run = await launch(role, { ZKTRIDENT_HOST: host });
    try {
      expect(run.port).toBeNull();                                    // before: it served on every interface
      expect(run.exitCode).toBe(1);                                   // before: it served, and did not exit
      expect(run.output).toContain(refusal(host));                    // before: a warning, and it went on
      expectReasonAndRemedy(run.output);
      // The refusal does not come with the general advice to name the host other machines reach it by.
      expect(run.output).not.toContain('name the host they reach it by in ZKTRIDENT_PUBLIC_HOSTS');   // before: the warning said so
    } finally {
      await stop(run);
    }
  });

  test('an empty ZKTRIDENT_HOST, which Node binds to every interface, is refused the same way', async () => {
    const run = await launch(role, { ZKTRIDENT_HOST: '' });
    try {
      expect(run.port).toBeNull();                                    // before: it served on every interface, without a word
      expect(run.exitCode).toBe(1);                                   // before: it served, and did not exit
      expect(run.output).toContain(refusal(''));                      // before: no such line
      expectReasonAndRemedy(run.output);
    } finally {
      await stop(run);
    }
  });

  test('a single address that is not loopback is refused too, before the node tries to bind it', async () => {
    const run = await launch(role, { ZKTRIDENT_HOST: '192.0.2.10' });
    try {
      expect(run.port).toBeNull();
      expect(run.exitCode).toBe(1);
      expect(run.output).toContain(refusal('192.0.2.10'));            // before: it tried to bind the address (EADDRNOTAVAIL on a machine without it)
      expect(run.output).not.toContain('EADDRNOTAVAIL');              // before: listen EADDRNOTAVAIL
      expectReasonAndRemedy(run.output);
    } finally {
      await stop(run);
    }
  });

  test('with the default loopback bind it starts and serves', async () => {
    const run = await launch(role, {});
    try {
      expect(run.exitCode).toBeNull();
      expect(run.port).not.toBeNull();
      expect(run.output).not.toContain('[FATAL]');
      expect(await healthStatus(run.port!, `127.0.0.1:${run.port}`)).toBe(200);
      expect(await healthStatus(run.port!, `localhost:${run.port}`)).toBe(200);
    } finally {
      await stop(run);
    }
  });

  test('it answers no public name: a request naming one gets 421, and the boot log says why', async () => {
    const run = await launch(role, { ZKTRIDENT_PUBLIC_HOSTS: 'pharmacy.example,proxy.example:8443' });
    try {
      expect(run.port).not.toBeNull();                                 // a public name alone does not stop the node
      const port = run.port!;
      expect(await healthStatus(port, 'pharmacy.example')).toBe(421);              // before: 200, the Host a proxy passes on from its client
      expect(await healthStatus(port, `pharmacy.example:${port}`)).toBe(421);      // before: 200
      expect(await healthStatus(port, 'proxy.example:8443')).toBe(421);            // before: 200
      expect(await healthStatus(port, `localhost:${port}`)).toBe(200);
      expect(run.output).toContain(
        `[net] ${role} node: ZKTRIDENT_PUBLIC_HOSTS lists pharmacy.example, proxy.example:8443, and this node answers none of them.`,
      );                                                                           // before: no such line
      expect(run.output).toContain('so no reverse proxy may bring other machines to it');   // before: no such line
      // Nor does the boot log ask for the proxy to be trusted, as it does on a node that answers a public name.
      expect(run.output).not.toContain('so those requests come through a reverse proxy on this host');   // before: it asked for ZKTRIDENT_TRUSTED_PROXIES
    } finally {
      await stop(run);
    }
  });
});
