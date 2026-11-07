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
 * Making this machine ready to run the whole network on its own (the local profile, profile.ts): what `npm run setup`
 * does, and what `npm start` does by itself the first time.
 *
 * It checks Node, memory, disk and the network's ports. A port another program holds is named and left alone; the
 * explorer moves to the first free port from 8010 when 8000 is taken. It writes `.zpk/local.env` (new secrets) and the
 * sample files when they are missing, or new secrets with `--new-secrets`, and prints the dashboards and their tokens.
 */
import { chmodSync, mkdirSync, statfsSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { DEFAULT_EXPLORER_PORT, firstFreePort, networkPorts, newLocalEnv, portIsFree, readLocalEnv } from './profile.js';
import { ENV_FILE, LOCAL_DIR, ROOT, SAMPLES_DIR } from './paths.js';
import { writeSamples } from './samples.js';
import { guideText } from './guide.js';

const MIN_NODE_MAJOR = 22;
const GB = 1024 ** 3;

/** One line per check; false when the machine cannot run the network at all. */
export async function checkMachine(explorerPort: number, print: (line: string) => void): Promise<boolean> {
  let ok = true;
  const major = Number(process.versions.node.split('.')[0]);
  if (major < MIN_NODE_MAJOR) {
    print(`  ✗ Node ${process.versions.node}: the network needs Node ${MIN_NODE_MAJOR} or newer (https://nodejs.org).`);
    ok = false;
  } else {
    print(`  ✓ Node ${process.versions.node}`);
  }
  const memory = os.totalmem() / GB;
  print(
    memory < 16
      ? `  ! ${memory.toFixed(0)} GB of memory: the network compiles its circuits in several processes at once and may not fit in less than 16 GB.`
      : `  ✓ ${memory.toFixed(0)} GB of memory`,
  );
  try {
    const disk = statfsSync(ROOT);
    const free = (disk.bavail * disk.bsize) / GB;
    print(
      free < 5
        ? `  ! ${free.toFixed(1)} GB free on this disk: the circuits' compile cache and the network's state need about 5 GB.`
        : `  ✓ ${free.toFixed(0)} GB free on this disk`,
    );
  } catch {
    print('  ? could not read the free disk space');
  }
  const taken: string[] = [];
  for (const { port, serves } of networkPorts(explorerPort)) if (!(await portIsFree(port))) taken.push(`${port} (${serves})`);
  print(
    taken.length === 0
      ? "  ✓ the network's ports are free"
      : `  ! in use: ${taken.join(', ')}. If this network is still running, \`npm stop\` stops it; another program is left alone.`,
  );
  return ok;
}

export async function setup(args: string[], print: (line: string) => void = (l) => console.log(l)): Promise<boolean> {
  const newSecrets = args.includes('--new-secrets');
  const existing = readLocalEnv(ENV_FILE);
  print('');
  print('  zpk.care: setting up this machine (the local profile; .zpk/ is ignored by git)');
  print('');
  let explorerPort = Number(existing?.ZKTRIDENT_EXPLORER_PORT) || DEFAULT_EXPLORER_PORT;
  if (!existing || newSecrets) {
    if (!(await portIsFree(DEFAULT_EXPLORER_PORT))) {
      explorerPort = (await firstFreePort(8010, 8099)) ?? DEFAULT_EXPLORER_PORT;
      print(`  · another program holds ${DEFAULT_EXPLORER_PORT}; the explorer will serve on ${explorerPort}`);
    }
  }
  if (!(await checkMachine(explorerPort, print))) return false;

  mkdirSync(LOCAL_DIR, { recursive: true });
  const envName = path.relative(ROOT, ENV_FILE).replace(/\\/g, '/');
  if (!existing || newSecrets) {
    writeFileSync(ENV_FILE, newLocalEnv(explorerPort), { encoding: 'utf8', mode: 0o600 });
    try {
      chmodSync(ENV_FILE, 0o600);
    } catch {
      /* Windows keeps the folder's own access list */
    }
    print(`  ✓ wrote ${envName} with new secrets${existing ? ' (the old ones are gone: sign in to each dashboard again)' : ''}`);
  } else {
    print(`  ✓ ${envName} is there (\`npm run setup -- --new-secrets\` makes new ones)`);
  }
  writeSamples(SAMPLES_DIR);
  print('  ✓ sample roster and EIN letter in .zpk/samples/');
  const env = readLocalEnv(ENV_FILE) ?? {};
  print(guideText(env, !existing || newSecrets));
  print('  Next: `npm start`.');
  print('');
  return true;
}
