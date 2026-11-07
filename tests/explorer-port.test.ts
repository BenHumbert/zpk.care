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
 * The explorer serves on the port ZKTRIDENT_EXPLORER_PORT names, so the network starts where 8000 is taken (A-133).
 *
 * What was wrong: start-explorer.ts read ZKTRIDENT_EXPLORER_PORT, but start-leviathan.ts started it with the variable
 * set to 8000 whatever the operator's environment said, then opened the browser at 8000 and reported 8000. The CORS
 * list granted http://localhost:8000 and http://127.0.0.1:8000 whether or not the explorer was there, so a page that
 * another program served on 8000 could call every node. The live harness, the PHI containment check, the network
 * surface check and the bootstrap script all called http://localhost:8000. On a machine where another program held
 * 8000 the explorer died at boot with a bare EADDRINUSE stack, and the harness read the other program.
 *
 * How it was found: the live run of 2026-11-02 on the A-126 fix, where a web server another project runs held 8000 and
 * three of 246 checks failed.
 *
 * What is true now: one function, resolveExplorerPort, reads the variable (8000 when it is unset) and refuses anything
 * but a port number. The launcher starts the explorer on that port, opens the browser there and reports it; the CORS
 * list grants the explorer's origin on that port and stops granting 8000 once the explorer has moved off it; the
 * scripts call it there. An explorer that finds its port taken says so and names the variable.
 */
import fs from 'fs';
import path from 'path';
import net from 'net';
import http from 'http';
import { spawn, type ChildProcess } from 'child_process';
import { resolveExplorerPort, resolveAllowedOrigins, DEFAULT_EXPLORER_PORT } from '../src/security/network-policy.js';

jest.setTimeout(120_000);

const REPO = path.resolve(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(REPO, rel), 'utf8').replace(/\r\n/g, '\n');
const REFUSAL = 'ZKTRIDENT_EXPLORER_PORT must be a port number from 1 to 65535';

describe('resolveExplorerPort', () => {
  test('is 8000 when the variable is unset or blank', () => {
    expect(DEFAULT_EXPLORER_PORT).toBe(8000);
    expect(resolveExplorerPort({})).toBe(8000);
    expect(resolveExplorerPort({ ZKTRIDENT_EXPLORER_PORT: '' })).toBe(8000);
    expect(resolveExplorerPort({ ZKTRIDENT_EXPLORER_PORT: '  ' })).toBe(8000);
  });

  test('reads the port the operator names', () => {
    expect(resolveExplorerPort({ ZKTRIDENT_EXPLORER_PORT: '8010' })).toBe(8010);
    expect(resolveExplorerPort({ ZKTRIDENT_EXPLORER_PORT: ' 8010 ' })).toBe(8010);
    expect(resolveExplorerPort({ ZKTRIDENT_EXPLORER_PORT: '1' })).toBe(1);
    expect(resolveExplorerPort({ ZKTRIDENT_EXPLORER_PORT: '65535' })).toBe(65535);
  });

  // parseInt, which the explorer used, read '80x' as 80 and '8e3' as 8, and turned 'abc' into NaN for listen() to reject.
  test.each(['abc', '80x', '8e3', '8000.5', '0x1f40', '+8000', '-1', '0', '65536'])('refuses %s, naming the variable', (value) => {
    expect(() => resolveExplorerPort({ ZKTRIDENT_EXPLORER_PORT: value })).toThrow(`${REFUSAL}, not "${value}"`);
  });
});

describe('the CORS list', () => {
  const at = (port: number): string[] => [`http://localhost:${port}`, `http://127.0.0.1:${port}`];

  test('is unchanged by default, the explorer on 8000 included', () => {
    const ports = [3030, 3031, 3032, 4001, 4002, 4003, 4004, 4040, 8000];
    expect(resolveAllowedOrigins({}, { role: 'test' })).toEqual([
      ...ports.map((p) => `http://localhost:${p}`),
      ...ports.map((p) => `http://127.0.0.1:${p}`),
    ]);
  });

  test('grants the explorer where it moved to, and stops granting 8000', () => {
    const origins = resolveAllowedOrigins({ ZKTRIDENT_EXPLORER_PORT: '8010' }, { role: 'test' });
    for (const origin of at(8010)) expect([origin, origins.includes(origin)]).toEqual([origin, true]); // before: refused
    for (const origin of at(8000)) expect([origin, origins.includes(origin)]).toEqual([origin, false]); // before: granted
    expect(origins).toContain('http://localhost:4001');
  });

  test("leaves an operator's own list as it is", () => {
    const env = { ZKTRIDENT_CORS_ORIGINS: 'http://a.example', ZKTRIDENT_EXPLORER_PORT: '8010' };
    expect(resolveAllowedOrigins(env, { role: 'test' })).toEqual(['http://a.example']);
  });

  test('refuses a port that is not one, like the explorer does', () => {
    expect(() => resolveAllowedOrigins({ ZKTRIDENT_EXPLORER_PORT: 'abc' }, { role: 'test' })).toThrow(REFUSAL);
  });
});

describe('the whole-network launcher', () => {
  const boot = read('src/nodes/start-leviathan.ts');

  test('reads the explorer port once, at boot, through resolveExplorerPort', () => {
    expect(boot).toContain('const explorerPort = resolveExplorerPort(env);'); // before: no such line
  });

  test('starts the explorer, opens the browser and reports on that port, never on a fixed 8000', () => {
    expect(boot).toContain('ZKTRIDENT_EXPLORER_PORT: String(explorerPort)'); // before: ZKTRIDENT_EXPLORER_PORT: '8000'
    expect(boot).toContain('`http://localhost:${explorerPort}/`'); // before: `http://localhost:8000/`
    expect(boot).toContain("{ name: 'explorer', child, port: explorerPort }"); // before: port: 8000
    expect(boot).not.toContain("ZKTRIDENT_EXPLORER_PORT: '8000'");
    expect(boot).not.toContain('localhost:8000');
    expect(boot).not.toContain('port: 8000');
    expect(boot).not.toContain('(port 8000)');
  });

  test('documents the variable with its default', () => {
    expect(boot).toMatch(/ZKTRIDENT_EXPLORER_PORT +— .*\(default: 8000\)/);
  });
});

describe('the scripts that call the explorer', () => {
  test.each([
    'scripts/e2e-verify/run.ts',
    'scripts/e2e-verify/check-phi-containment.ts',
    'scripts/e2e-verify/check-network-surface.ts',
    'scripts/bootstrap-system.ts',
  ])('%s calls it on ZKTRIDENT_EXPLORER_PORT', (rel) => {
    const src = read(rel);
    expect(src).toContain('ZKTRIDENT_EXPLORER_PORT'); // before: absent
    expect(src).not.toContain('localhost:8000');
    expect(src).not.toMatch(/port === 8000|explorer: 8000|,8000'/);
  });

  test('the dev stop script counts the explorer where it is', () => {
    const ps1 = read('scripts/dev/kill-zpk.ps1');
    expect(ps1).toContain('$env:ZKTRIDENT_EXPLORER_PORT'); // before: a fixed 8000 in its port list
  });
});

describe('the explorer launcher', () => {
  interface Run {
    child: ChildProcess;
    output: string;
    closed: Promise<void>;
    exitCode: number | null;
    listening: boolean;
  }
  const runs: Run[] = [];

  afterAll(async () => {
    for (const run of runs) {
      if (run.child.exitCode === null && run.child.signalCode === null) run.child.kill();
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        run.closed,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 5000);
        }),
      ]);
      clearTimeout(timer);
    }
  });

  /** A port nothing listens on, taken and released by the OS. */
  async function freePort(): Promise<number> {
    const probe = net.createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()));
    const { port } = probe.address() as net.AddressInfo;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    return port;
  }

  /** Start start-explorer.ts with this port setting, and wait until it serves or exits. */
  async function launch(portSetting: string): Promise<Run> {
    // Only what Node needs to run, so a ZKTRIDENT_ setting in the developer's own shell cannot reach the launcher.
    const env: NodeJS.ProcessEnv = {};
    for (const k of ['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA']) {
      if (process.env[k] !== undefined) env[k] = process.env[k];
    }
    env.ZKTRIDENT_EXPLORER_PORT = portSetting;
    env.ZKTRIDENT_SEQUENCER_URL = `http://127.0.0.1:${await freePort()}`;
    const child = spawn(process.execPath, ['--import', 'tsx', path.join(REPO, 'src', 'nodes', 'start-explorer.ts')], {
      cwd: REPO,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
    const run: Run = { child, output: '', closed, exitCode: null, listening: false };
    runs.push(run);
    child.stdout?.on('data', (d: Buffer) => {
      run.output += d.toString();
    });
    child.stderr?.on('data', (d: Buffer) => {
      run.output += d.toString();
    });
    const deadline = Date.now() + 90_000;
    for (;;) {
      if (run.output.includes('Explorer:      http://localhost:')) {
        run.listening = true;
        return run;
      }
      if (child.exitCode !== null) {
        await run.closed;
        run.exitCode = child.exitCode;
        return run;
      }
      if (Date.now() > deadline) throw new Error(`the explorer neither exited nor served:\n${run.output}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  function getStatus(port: number, urlPath: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: urlPath, headers: { Host: `localhost:${port}` }, agent: false }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });
  }

  test('serves its page on the port the variable names', async () => {
    const port = await freePort();
    const run = await launch(String(port));
    expect(run.listening).toBe(true);
    expect(run.output).toContain(`Explorer:      http://localhost:${port}`);
    expect(await getStatus(port, '/')).toBe(200);
  });

  test('exits at boot on a port setting that is not a port, and names the variable', async () => {
    const run = await launch('80x');
    expect(run.listening).toBe(false); // before: parseInt read '80x' as 80 and tried to serve there
    expect(run.exitCode).toBe(1);
    expect(run.output).toContain(`${REFUSAL}, not "80x"`);
  });

  test('says its port is taken and how to move it, instead of a bare EADDRINUSE stack', async () => {
    const holder = net.createServer();
    await new Promise<void>((resolve) => holder.listen(0, '127.0.0.1', () => resolve()));
    const { port } = holder.address() as net.AddressInfo;
    try {
      const run = await launch(String(port));
      expect(run.listening).toBe(false);
      expect(run.exitCode).toBe(1);
      expect(run.output).toContain(`[FATAL] explorer: port ${port} is already in use by another program.`); // before: an unhandled 'error' event
      expect(run.output).toContain('Set ZKTRIDENT_EXPLORER_PORT to a free port');
    } finally {
      await new Promise<void>((resolve) => holder.close(() => resolve()));
    }
  });
});
