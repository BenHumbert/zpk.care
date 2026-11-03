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
 * `npm run kill:ports` stops this checkout's own processes and leaves every other program running (A-133).
 *
 * What was wrong: kill:ports looked up whatever was listening on each of twelve ports (3030 to 3032, 4001 to 4005,
 * 4040, 5050, 8000 and 8080) and ran `taskkill /F` on it, whichever program it was. Six package scripts run it first,
 * the quick start in README.md among them (start:leviathan:clean:100:unsecure), and the bootstrap script did the same
 * on its own, so starting the network force-closed a web server another project ran on 8000, or any program on 8080,
 * with only a process ID to say what it had stopped.
 *
 * How it was found: the live run of 2026-11-02 on the A-126 fix, where a web server another project runs held 8000. The
 * run itself used a stop script that matches this project's processes by name, so nothing was stopped; reading the
 * package scripts afterwards showed that the documented start would have closed it.
 *
 * What is true now: scripts/dev/kill-ports.ts lists the listeners on the project's ports, reads each one's program and
 * command line, and stops a listener only when it is node running something from this checkout. Every other listener
 * is named, with its process ID, and left running. The explorer's port is the one ZKTRIDENT_EXPLORER_PORT names.
 */
import fs from 'fs';
import path from 'path';
import {
  PROJECT_PORTS, portsToFree, parseNetstatListeners, parseProcessList, isThisCheckout, planKills, freeProjectPorts,
  type ProcessInfo, type PortSystem,
} from '../scripts/dev/kill-ports-lib.js';

const REPO = path.resolve(__dirname, '..');
const ROOT = 'Z:\\zpk_care';

/** What `netstat -ano` prints, trimmed to the cases that matter. */
const NETSTAT = [
  '',
  'Active Connections',
  '',
  '  Proto  Local Address          Foreign Address        State           PID',
  '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1040',
  '  TCP    127.0.0.1:3030         0.0.0.0:0              LISTENING       4100',
  '  TCP    127.0.0.1:3030         127.0.0.1:51234        ESTABLISHED     4100',
  '  TCP    127.0.0.1:51234        127.0.0.1:3030         ESTABLISHED     7777',
  '  TCP    0.0.0.0:8000           0.0.0.0:0              LISTENING       5200',
  '  TCP    127.0.0.1:18000        0.0.0.0:0              LISTENING       6100',
  '  TCP    127.0.0.1:4001         0.0.0.0:0              ABHÖREN         4200',
  '  TCP    127.0.0.1:8080         127.0.0.1:60000        TIME_WAIT       0',
  '  TCP    [::]:8000              [::]:0                 LISTENING       5200',
  '  TCP    [::1]:4002             [::]:0                 LISTENING       4300',
  '  UDP    0.0.0.0:5050           *:*                                    3300',
].join('\r\n');

const TAB = '\t';
/** What kill-ports.ts asks PowerShell for: process ID, program and command line, tab-separated. */
const PROCESSES = [
  ['4100', 'node.exe', '"C:\\Program Files\\nodejs\\node.exe" --require Z:\\zpk_care\\node_modules\\tsx\\dist\\preflight.cjs --import file:///Z:/zpk_care/node_modules/tsx/dist/loader.mjs src/nodes/start-leviathan.ts'],
  ['4200', 'node.exe', '"C:\\Program Files\\nodejs\\node.exe" --import tsx Z:\\zpk_care\\src\\nodes\\start-member-nautilus.ts'],
  ['4300', 'node.exe', '"C:\\Program Files\\nodejs\\node.exe" Z:\\zpk_care_old\\src\\nodes\\start-prescriber-nautilus.ts'],
  ['5200', 'python.exe', 'python.exe -m http.server 8000'],
].map((cols) => cols.join(TAB)).join('\r\n');

describe('the ports it frees', () => {
  test('are the project ports and the explorer on 8000 by default, as before', () => {
    expect([...PROJECT_PORTS].sort((a, b) => a - b)).toEqual([3030, 3031, 3032, 4001, 4002, 4003, 4004, 4005, 4040, 5050, 8080]);
    expect(portsToFree({})).toEqual([...PROJECT_PORTS, 8000]);
  });

  test('follow the explorer when ZKTRIDENT_EXPLORER_PORT moves it, and leave 8000 alone', () => {
    expect(portsToFree({ ZKTRIDENT_EXPLORER_PORT: '8010' })).toEqual([...PROJECT_PORTS, 8010]);
    expect(portsToFree({ ZKTRIDENT_EXPLORER_PORT: '8080' })).toEqual([...PROJECT_PORTS]);   // already listed, not twice
  });

  test('refuse an explorer port that is not one', () => {
    expect(() => portsToFree({ ZKTRIDENT_EXPLORER_PORT: 'abc' })).toThrow('ZKTRIDENT_EXPLORER_PORT must be a port number');
  });
});

describe('reading netstat', () => {
  test('finds each listener on those ports once, whatever the language of its state word', () => {
    expect(parseNetstatListeners(NETSTAT, portsToFree({}))).toEqual([
      { port: 3030, pid: 4100 },
      { port: 8000, pid: 5200 },   // listed for IPv4 and IPv6, counted once
      { port: 4001, pid: 4200 },   // ABHÖREN is LISTENING on a German Windows; a listener has no remote end
      { port: 4002, pid: 4300 },
    ]);
  });

  test('ignores connections, other ports, UDP and the idle process', () => {
    const found = parseNetstatListeners(NETSTAT, [135, 3030, 8080, 5050, 51234]);
    expect(found).toEqual([{ port: 135, pid: 1040 }, { port: 3030, pid: 4100 }]);   // not the connection from 51234, not a TIME_WAIT under PID 0
  });
});

describe('telling this checkout from every other program', () => {
  const procs = parseProcessList(PROCESSES);

  test('reads the process list PowerShell prints', () => {
    expect(procs.get(5200)).toEqual({ name: 'python.exe', commandLine: 'python.exe -m http.server 8000' });
    expect(procs.size).toBe(4);
  });

  test('takes node running from this checkout, by its loader path or its script path', () => {
    expect(isThisCheckout(procs.get(4100), ROOT)).toBe(true);   // npx tsx: the loader lives in the checkout's node_modules
    expect(isThisCheckout(procs.get(4200), ROOT)).toBe(true);   // a child the network starts with an absolute script path
  });

  test('compares paths the way Windows does: any case, either slash', () => {
    expect(isThisCheckout(procs.get(4200), 'z:/ZPK_CARE/')).toBe(true);
  });

  test.each<[string, ProcessInfo | undefined]>([
    ['another program', { name: 'python.exe', commandLine: 'python.exe -m http.server 8000' }],
    ['node from another checkout whose name starts the same', { name: 'node.exe', commandLine: 'node.exe Z:\\zpk_care_old\\src\\a.ts' }],
    ['node of another product', { name: 'node.exe', commandLine: '"C:\\Program Files\\Other\\node.exe" C:\\Program Files\\Other\\app.js' }],
    ['a program that only names the checkout', { name: 'python.exe', commandLine: 'python.exe Z:\\zpk_care\\tool.py' }],
    ['node whose command line cannot be read', { name: 'node.exe', commandLine: '' }],
    ['a process that has exited', undefined],
  ])('leaves %s alone', (_label, proc) => {
    expect(isThisCheckout(proc, ROOT)).toBe(false);
  });
});

describe('the plan', () => {
  test('stops this checkout and leaves the rest running, each named', () => {
    const listeners = parseNetstatListeners(NETSTAT, portsToFree({}));
    const plan = planKills(listeners, parseProcessList(PROCESSES), ROOT);
    expect(plan.stop).toEqual([
      { port: 3030, pid: 4100, name: 'node.exe' },
      { port: 4001, pid: 4200, name: 'node.exe' },
    ]);
    expect(plan.leave).toEqual([
      { port: 8000, pid: 5200, name: 'python.exe' },   // before: taskkill /F
      { port: 4002, pid: 4300, name: 'node.exe' },     // before: taskkill /F
    ]);
  });

  test('leaves a listener whose process it cannot read', () => {
    const plan = planKills([{ port: 3030, pid: 9999 }], new Map(), ROOT);
    expect(plan).toEqual({ stop: [], leave: [{ port: 3030, pid: 9999, name: 'an unknown program' }] });
  });
});

describe('the package scripts', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')) as { scripts: Record<string, string> };

  test('kill:ports runs the script that checks who holds each port', () => {
    expect(pkg.scripts['kill:ports']).toBe('npx tsx scripts/dev/kill-ports.ts');   // before: an inline taskkill of every holder
  });

  test('none of them force-kills by port any more', () => {
    for (const [name, body] of Object.entries(pkg.scripts)) expect([name, body.includes('taskkill')]).toEqual([name, false]);
  });

  test('the script frees the ports through the shared plan', () => {
    const runner = fs.readFileSync(path.join(REPO, 'scripts', 'dev', 'kill-ports.ts'), 'utf8');
    expect(runner).toContain('freeProjectPorts(process.env, repoRoot,');
  });

  test('the shared code has one way to stop a process', () => {
    const lib = fs.readFileSync(path.join(REPO, 'scripts', 'dev', 'kill-ports-lib.ts'), 'utf8');
    expect(lib.split("execFileSync('taskkill'").length - 1).toBe(1);
  });
});

describe('freeing the ports', () => {
  /** A machine that answers with the lists above and records what it is asked to stop. */
  function fakeSystem(overrides: Partial<PortSystem> = {}): PortSystem & { stopped: number[] } {
    const stopped: number[] = [];
    return {
      stopped,
      netstat: () => NETSTAT,
      processList: () => PROCESSES,
      stop: (pid) => { stopped.push(pid); },
      isRunning: () => true,
      ...overrides,
    };
  }

  function run(system: PortSystem | null, env: NodeJS.ProcessEnv = {}): string[] {
    const lines: string[] = [];
    freeProjectPorts(env, ROOT, (line) => lines.push(line), system);
    return lines;
  }

  test("stops this checkout's listeners and names every other one", () => {
    const system = fakeSystem();
    expect(run(system)).toEqual([
      'port 3030: stopped node.exe (PID 4100), which ran from this checkout',
      'port 4001: stopped node.exe (PID 4200), which ran from this checkout',
      'port 8000: left python.exe (PID 5200) running; it is not part of this checkout. To run the explorer elsewhere, set ZKTRIDENT_EXPLORER_PORT to a free port.',
      'port 4002: left node.exe (PID 4300) running; it is not part of this checkout.',
    ]);
    expect(system.stopped).toEqual([4100, 4200]);
  });

  test('stops a process that holds several ports once', () => {
    const netstat = [3030, 3031, 3032].map((p) => `  TCP    127.0.0.1:${p}         0.0.0.0:0              LISTENING       4100`).join('\r\n');
    const system = fakeSystem({ netstat: () => netstat });
    expect(run(system)).toEqual([3030, 3031, 3032].map((p) => `port ${p}: stopped node.exe (PID 4100), which ran from this checkout`));
    expect(system.stopped).toEqual([4100]);
  });

  // Found by the live run of 2026-11-03: stopping the network's launcher ends its children, which watch it, so when
  // their turn came they were gone, and each was reported as a process that could not be stopped.
  test('reports a process that exited before its turn as gone, not as one it could not stop', () => {
    const system = fakeSystem({
      stop: (pid) => { if (pid === 4200) throw new Error('not found'); },
      isRunning: (pid) => pid !== 4200,
    });
    const lines = run(system);
    expect(lines).toContain('port 4001: node.exe (PID 4200) had already exited');   // before: "could not stop node.exe (PID 4200)"
    expect(lines.some((l) => l.includes('could not stop'))).toBe(false);
  });

  test('reports a process that will not stop', () => {
    const system = fakeSystem({ stop: () => { throw new Error('Access is denied'); } });
    expect(run(system)).toContain('port 3030: could not stop node.exe (PID 4100), which runs from this checkout');
  });

  test('stops nothing when it cannot read which programs hold the ports', () => {
    const system = fakeSystem({ processList: () => { throw new Error('powershell not found'); } });
    expect(run(system)).toEqual(['Could not read which programs hold the ports (powershell not found); nothing was stopped.']);
    expect(system.stopped).toEqual([]);
  });

  test('stops nothing when netstat cannot run', () => {
    const system = fakeSystem({ netstat: () => { throw new Error('netstat not found'); } });
    expect(run(system)).toEqual(['Could not run netstat (netstat not found); nothing was stopped.']);
    expect(system.stopped).toEqual([]);
  });

  test('says so when nothing listens on the ports', () => {
    expect(run(fakeSystem({ netstat: () => '' }))).toEqual(["No program is listening on this project's ports."]);
  });

  test('leaves 8000 to its program once the explorer has moved', () => {
    const lines = run(fakeSystem(), { ZKTRIDENT_EXPLORER_PORT: '8010' });
    expect(lines.some((l) => l.startsWith('port 8000:'))).toBe(false);   // no longer one of this project's ports
    expect(lines).toContain('port 3030: stopped node.exe (PID 4100), which ran from this checkout');
  });

  test('stops nothing where it has no way to read the ports', () => {
    expect(run(null)).toEqual(['Freeing the ports reads Windows netstat. Here, stop the network with Ctrl+C in the terminal that runs it.']);
  });
});

describe('the bootstrap script', () => {
  const src = fs.readFileSync(path.join(REPO, 'scripts', 'bootstrap-system.ts'), 'utf8');

  test('frees the ports the same way, without force-killing by port', () => {
    expect(src).toContain('freeProjectPorts(process.env, projectRoot,');   // before: its own netstat loop
    expect(src).not.toContain('taskkill');                                 // before: taskkill /F on whatever held each port
  });
});
