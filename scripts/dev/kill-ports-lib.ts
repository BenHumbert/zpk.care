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
 * Which programs `npm run kill:ports` and the bootstrap script may stop: this checkout's own, and nothing else (A-133).
 *
 * Both used to force-kill whatever listened on each project port, so starting the network closed any other program
 * that happened to use 8000 or 8080. Now each listener is identified first, by its program and command line. Only node
 * running from this checkout is stopped; anything else is named, with its process ID, and left running.
 *
 * The functions that decide are pure, for the tests; freeProjectPorts runs them against this machine. Windows only, as
 * kill:ports always was: elsewhere it says so and stops nothing.
 */
import { execFileSync } from 'child_process';
import { resolveExplorerPort } from '../../src/security/network-policy.js';

/** The ports this project's servers and tools listen on, besides the explorer's. */
export const PROJECT_PORTS: readonly number[] = [3030, 3031, 3032, 4001, 4002, 4003, 4004, 4005, 4040, 5050, 8080];

/** Every port to free: the project ports and the explorer's, which ZKTRIDENT_EXPLORER_PORT may move off 8000. */
export function portsToFree(env: NodeJS.ProcessEnv): number[] {
  const explorer = resolveExplorerPort(env);
  return PROJECT_PORTS.includes(explorer) ? [...PROJECT_PORTS] : [...PROJECT_PORTS, explorer];
}

/** A process listening on a port. */
export interface Listener {
  port: number;
  pid: number;
}

/**
 * The TCP listeners on `ports` in `netstat -ano` output, one per port and process.
 *
 * A listening socket is told by its remote end, 0.0.0.0:0 or [::]:0, as well as by the state word, because Windows
 * prints the state in its display language. The process ID is the last column for the same reason: a state word may
 * hold a space.
 */
export function parseNetstatListeners(output: string, ports: readonly number[]): Listener[] {
  const wanted = new Set(ports);
  const seen = new Set<string>();
  const found: Listener[] = [];
  for (const line of output.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5 || !/^TCP/i.test(cols[0])) continue;
    const [, local, remote] = cols;
    const state = cols.slice(3, -1).join(' ');
    if (state !== 'LISTENING' && !/:0$/.test(remote)) continue;
    const port = Number(local.slice(local.lastIndexOf(':') + 1));
    const pid = Number(cols[cols.length - 1]);
    if (!wanted.has(port) || !Number.isInteger(pid) || pid <= 0) continue;
    const key = `${port}:${pid}`;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({ port, pid });
  }
  return found;
}

/** A running program, as Windows describes it. */
export interface ProcessInfo {
  /** The program's file name, such as node.exe. */
  name: string;
  /** Its command line; empty when Windows will not show it, as for another user's or an elevated process. */
  commandLine: string;
}

/** Lines of `process ID <TAB> program <TAB> command line`, as freeProjectPorts asks PowerShell for them. */
export function parseProcessList(output: string): Map<number, ProcessInfo> {
  const processes = new Map<number, ProcessInfo>();
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [pidText, name = '', ...commandLine] = line.split('\t');
    const pid = Number(pidText.trim());
    if (!Number.isInteger(pid) || pid <= 0) continue;
    processes.set(pid, { name: name.trim(), commandLine: commandLine.join('\t').trim() });
  }
  return processes;
}

/** A path the way Windows compares it: either slash, any case. A file: URL writes the same path with forward slashes. */
function comparable(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase();
}

/**
 * Whether a process is node running something from the checkout at `repoRoot`.
 *
 * The network's processes name the checkout on their command line either way they start: `npx tsx` loads its loader
 * from the checkout's node_modules, and the launchers start their children by absolute script path. The trailing
 * separator keeps a sibling checkout whose folder name starts the same (zpk_care_old) out.
 */
export function isThisCheckout(proc: ProcessInfo | undefined, repoRoot: string): boolean {
  if (!proc || !/^node(\.exe)?$/i.test(proc.name)) return false;
  const root = comparable(repoRoot).replace(/\/+$/, '') + '/';
  return comparable(proc.commandLine).includes(root);
}

/** A listener and the program behind it. */
export interface PortHolder extends Listener {
  name: string;
}

/** Which listeners to stop, and which to leave running. */
export interface KillPlan {
  stop: PortHolder[];
  leave: PortHolder[];
}

/** Stop this checkout's listeners; leave every other one, including any whose process cannot be read. */
export function planKills(listeners: readonly Listener[], processes: ReadonlyMap<number, ProcessInfo>, repoRoot: string): KillPlan {
  const plan: KillPlan = { stop: [], leave: [] };
  for (const listener of listeners) {
    const proc = processes.get(listener.pid);
    const holder: PortHolder = { ...listener, name: proc?.name || 'an unknown program' };
    (isThisCheckout(proc, repoRoot) ? plan.stop : plan.leave).push(holder);
  }
  return plan;
}

/** What freeProjectPorts asks of the machine. The tests pass their own, so they never touch a real process. */
export interface PortSystem {
  /** What `netstat -ano` prints. */
  netstat(): string;
  /** `process ID <TAB> program <TAB> command line` for each of these processes still running. */
  processList(pids: readonly number[]): string;
  /** Force-stop one process. Throws when it cannot. */
  stop(pid: number): void;
  /** Whether a process is still running. */
  isRunning(pid: number): boolean;
}

/** Windows, through netstat, PowerShell and taskkill. */
export const WINDOWS_PORT_SYSTEM: PortSystem = {
  netstat: () => execFileSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true }),
  processList: (pids) => {
    const filter = pids.map((pid) => `ProcessId=${pid}`).join(' OR ');
    const query = `Get-CimInstance Win32_Process -Filter '${filter}' | ForEach-Object { [string]$_.ProcessId + [char]9 + $_.Name + [char]9 + $_.CommandLine }`;
    return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', query], { encoding: 'utf8', windowsHide: true });
  },
  stop: (pid) => {
    execFileSync('taskkill', ['/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
  },
  isRunning: (pid) => {
    try {
      process.kill(pid, 0); // signal 0 tests for the process without touching it
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'EPERM'; // running, but not ours to signal
    }
  },
};

/**
 * Free the project ports on this machine: stop this checkout's listeners, and name every other listener and leave it
 * running. `print` gets one line per port. Stops nothing when netstat or the process list cannot be read, and nothing
 * where there is no `system` for the platform (anywhere but Windows).
 */
export function freeProjectPorts(
  env: NodeJS.ProcessEnv,
  repoRoot: string,
  print: (line: string) => void,
  system: PortSystem | null = process.platform === 'win32' ? WINDOWS_PORT_SYSTEM : null,
): void {
  if (!system) {
    print('Freeing the ports reads Windows netstat. Here, stop the network with Ctrl+C in the terminal that runs it.');
    return;
  }
  const explorerPort = resolveExplorerPort(env);
  let listeners: Listener[];
  try {
    listeners = parseNetstatListeners(system.netstat(), portsToFree(env));
  } catch (err) {
    print(`Could not run netstat (${(err as Error).message}); nothing was stopped.`);
    return;
  }
  if (listeners.length === 0) {
    print("No program is listening on this project's ports.");
    return;
  }

  let processes: Map<number, ProcessInfo>;
  try {
    processes = parseProcessList(system.processList([...new Set(listeners.map((l) => l.pid))]));
  } catch (err) {
    print(`Could not read which programs hold the ports (${(err as Error).message}); nothing was stopped.`);
    return;
  }
  const plan = planKills(listeners, processes, repoRoot);

  // A process can be gone before its turn: the network's children watch their launcher and exit when it is stopped.
  const outcomes = new Map<number, 'stopped' | 'exited' | 'failed'>();
  for (const holder of plan.stop) {
    if (!outcomes.has(holder.pid)) {
      try {
        system.stop(holder.pid);
        outcomes.set(holder.pid, 'stopped');
      } catch {
        outcomes.set(holder.pid, system.isRunning(holder.pid) ? 'failed' : 'exited');
      }
    }
    const outcome = outcomes.get(holder.pid);
    print(
      outcome === 'stopped'
        ? `port ${holder.port}: stopped ${holder.name} (PID ${holder.pid}), which ran from this checkout`
        : outcome === 'exited'
          ? `port ${holder.port}: ${holder.name} (PID ${holder.pid}) had already exited`
          : `port ${holder.port}: could not stop ${holder.name} (PID ${holder.pid}), which runs from this checkout`,
    );
  }
  for (const holder of plan.leave) {
    const hint = holder.port === explorerPort ? ' To run the explorer elsewhere, set ZKTRIDENT_EXPLORER_PORT to a free port.' : '';
    print(`port ${holder.port}: left ${holder.name} (PID ${holder.pid}) running; it is not part of this checkout.${hint}`);
  }
}
