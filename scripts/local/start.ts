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
 * `npm start`: the whole network on this machine, secured, with the local profile's secrets (`.zpk/local.env`; the
 * first start runs `npm run setup` by itself).
 *
 *   npm start                     boot, keeping the network's state from the last run
 *   npm start -- --fresh          start from nothing: clear the network's state and the local HR Tool workspace first
 *   npm start -- --full-catalog   load the whole NADAC catalog (about 30,000 drugs; a much slower boot) instead of 100
 *
 * It starts the sequencer and every node (src/nodes/start-leviathan.ts, whose output it shows) and the HR Tool
 * (src/tools/hr-tool-server.ts; in production it runs on the employer's own machine), whose output goes to
 * .zpk/logs/hr-tool.log. When the dashboards answer and the engine's provers are ready it prints where each dashboard
 * is. Ctrl+C stops everything: the network saves its state and shuts down cleanly. A variable set in the shell wins
 * over the file, so `ZKTRIDENT_EXPLORER_PORT=8020 npm start` works as before.
 */
import { spawn, type ChildProcess } from 'child_process';
import { createWriteStream, mkdirSync, rmSync } from 'fs';
import path from 'path';
import { HR_TOOL_PORT, SECRETS, launchArgs, readLocalEnv } from './profile.js';
import { ENV_FILE, HR_TOOL_DIR, LOGS_DIR, ROOT } from './paths.js';
import { setup } from './prepare.js';
import { guideText } from './guide.js';

/** What `npm run clean:state` clears, and the local HR Tool workspace, whose employer node a fresh network no longer has. */
const STATE_DIRS = ['.l2-checkpoints', 'l2-data', 'nautilus-data', 'visualizer/.l2-checkpoints', path.relative(ROOT, HR_TOOL_DIR)];
const READY_POLL_MS = 5_000;
const STOP_GRACE_MS = 30_000;

async function answers(url: string): Promise<number | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3_000) });
    return res.status;
  } catch {
    return null;
  }
}

/** Resolves when every dashboard answers and the engine's provers are ready, reporting progress now and then. */
async function waitUntilReady(explorerPort: number, stopped: () => boolean): Promise<boolean> {
  const pages = [3030, 4001, 4002, 4003, 4004, explorerPort].map((p) => `http://127.0.0.1:${p}/health`);
  const started = Date.now();
  let lastNote = 0;
  while (!stopped()) {
    const statuses = await Promise.all(pages.map(answers));
    const hrTool = await answers(`http://127.0.0.1:${HR_TOOL_PORT}/api/workspaces`);
    const engine = await answers('http://127.0.0.1:3030/interactive/ready');
    if (statuses.every((s) => s !== null) && hrTool !== null && engine === 200) return true;
    if (Date.now() - lastNote > 60_000) {
      lastNote = Date.now();
      const minutes = Math.round((Date.now() - started) / 60_000);
      if (minutes > 0) console.log(`\n  [start] still starting after ${minutes} min: the first boot compiles every circuit, which takes several minutes\n`);
    }
    await new Promise((r) => setTimeout(r, READY_POLL_MS));
  }
  return false;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let fileEnv = readLocalEnv(ENV_FILE);
  if (!fileEnv) {
    if (!(await setup([]))) process.exit(1);
    fileEnv = readLocalEnv(ENV_FILE) ?? {};
  }
  if (args.includes('--fresh')) {
    for (const dir of STATE_DIRS) rmSync(path.join(ROOT, dir), { recursive: true, force: true });
    console.log('  [start] cleared the network\'s state and the local HR Tool workspace');
  }
  const env: NodeJS.ProcessEnv = { ...fileEnv, ...process.env };
  if (args.includes('--full-catalog')) delete env.ZKTRIDENT_FORMULARY_LIMIT;
  delete env.ZKTRIDENT_UNSECURE;   // the local profile is a secured boot
  for (const { name } of SECRETS) {
    if (process.env[name] !== undefined && fileEnv[name] !== undefined && process.env[name] !== fileEnv[name]) {
      console.log(`  [start] ${name} from this shell is used, not the one in .zpk/local.env (\`npm run tokens\` shows the file's)`);
    }
  }
  const explorerPort = Number(env.ZKTRIDENT_EXPLORER_PORT) || 8000;

  mkdirSync(LOGS_DIR, { recursive: true });
  const launch = launchArgs(ROOT);
  const network = spawn(process.execPath, launch.network, { cwd: ROOT, env, stdio: 'inherit' });
  const hrLog = createWriteStream(path.join(LOGS_DIR, 'hr-tool.log'), { flags: 'a' });
  // the HR Tool runs on the employer's machine in production and holds none of the network's secrets here either
  const hrEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const { name } of SECRETS) delete hrEnv[name];
  const hrTool = spawn(process.execPath, launch.hrTool, {
    cwd: ROOT,
    env: {
      ...hrEnv,
      PORT: String(HR_TOOL_PORT),
      HR_TOOL_DATA_DIR: env.HR_TOOL_DATA_DIR ?? HR_TOOL_DIR,
      // on one machine the HR Tool "texts" each PIN to its outbox; `npm run texts` shows them
      HR_TOOL_TEXT_SERVICE: env.HR_TOOL_TEXT_SERVICE ?? 'outbox',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  hrTool.stdout?.pipe(hrLog);
  hrTool.stderr?.pipe(hrLog);

  const children: ChildProcess[] = [network, hrTool];
  let stopping = false;
  const stopAll = (why: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`\n  [start] ${why}: stopping the network and the HR Tool`);
    // Ctrl+C reaches the children through the console as well; this covers a stop from elsewhere
    for (const child of children) if (child.exitCode === null) child.kill('SIGINT');
    setTimeout(() => {
      for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
      process.exit(1);
    }, STOP_GRACE_MS).unref();
  };
  process.on('SIGINT', () => stopAll('Ctrl+C'));
  process.on('SIGTERM', () => stopAll('asked to stop'));
  network.on('exit', (code) => {
    if (!stopping) stopAll(`the network exited (code ${code})`);
    if (hrTool.exitCode !== null || !hrTool.pid) process.exit(code ?? 0);
  });
  hrTool.on('exit', (code) => {
    if (!stopping) console.log(`\n  [start] the HR Tool exited (code ${code}); its output is in .zpk/logs/hr-tool.log`);
    if (network.exitCode !== null) process.exit(code ?? 0);
  });

  if (await waitUntilReady(explorerPort, () => stopping)) {
    console.log(guideText(env, false));
    console.log('  The network is ready. Ctrl+C stops it; `npm run status` checks it from another terminal.\n');
  }
}

main().catch((err) => {
  console.error('  [start] could not start the network:', err instanceof Error ? err.message : err);
  process.exit(1);
});
