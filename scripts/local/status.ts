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
 * `npm run status`: whether each part of a local network answers, and whether the engine's provers are ready.
 */
import { HR_TOOL_PORT, networkPorts, readLocalEnv } from './profile.js';
import { ENV_FILE } from './paths.js';

async function answers(url: string): Promise<number | null> {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(3_000) })).status;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const env = { ...(readLocalEnv(ENV_FILE) ?? {}), ...process.env };
  const explorerPort = Number(env.ZKTRIDENT_EXPLORER_PORT) || 8000;
  console.log('');
  for (const { port, serves } of networkPorts(explorerPort)) {
    const url = port === HR_TOOL_PORT ? `http://127.0.0.1:${port}/api/workspaces` : `http://127.0.0.1:${port}/health`;
    const status = await answers(url);
    console.log(`  ${status === null ? '·  down' : '✓  up  '}  ${String(port).padEnd(5)} ${serves}`);
  }
  const engine = await answers('http://127.0.0.1:3030/interactive/ready');
  console.log(`\n  engine provers: ${engine === 200 ? 'ready' : engine === null ? 'not answering' : 'still compiling'}\n`);
}

main();
