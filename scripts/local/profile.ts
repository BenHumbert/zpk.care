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
 * The local profile: the whole network on one machine, for evaluation and development. What it keeps lives in
 * `.zpk/` at the repository root, which git ignores:
 *
 *   .zpk/local.env    the secrets and settings `npm start` boots with, written once by `npm run setup`
 *   .zpk/samples/     a fictional employee roster and a sample EIN letter for the walkthrough
 *   .zpk/logs/        the HR Tool's output
 *   .zpk/hr-tool/     the HR Tool's workspace and its text outbox, where the PINs it "texts" are written
 *
 * A production network makes its node secrets at the key ceremony (scripts/keys/) and keeps none in a file.
 */
import { randomBytes } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import net from 'net';
import path from 'path';
import { parseEnv } from 'util';

/** The explorer's usual port; another program often holds 8000, so setup moves it to the first free port from 8010. */
export const DEFAULT_EXPLORER_PORT = 8000;
export const HR_TOOL_PORT = 5050;

/** The secrets a secured boot needs, each made fresh by setup. Values are 32 bytes (hex) or 24 bytes (base64url). */
export const SECRETS: ReadonlyArray<{ name: string; make: () => string; what: string }> = [
  { name: 'ZKTRIDENT_ADMIN_TOKEN', make: () => randomBytes(32).toString('hex'), what: "the network operator's token (the sequencer's dashboard)" },
  { name: 'ZKTRIDENT_INSURER_ADMIN_TOKEN', make: () => randomBytes(24).toString('base64url'), what: "the plan's node token (the insurer dashboard)" },
  { name: 'ZKTRIDENT_PRESCRIBER_ADMIN_TOKEN', make: () => randomBytes(24).toString('base64url'), what: "the prescriber node's token (a patient's own price, prior authorization)" },
  // also the seed of the sequencer's NFC attestation key, read as hex
  { name: 'ZKTRIDENT_GOSSIP_SECRET', make: () => randomBytes(32).toString('hex'), what: 'signs gossip between the sequencer and its replicas' },
  { name: 'ZKTRIDENT_PROVER_API_KEY', make: () => randomBytes(24).toString('base64url'), what: "the proof delegate's API key" },
  // without a key ceremony, the insurer's attestation key; kept, so employers' attestations survive a restart (A-147)
  { name: 'ZKTRIDENT_INSURER_SIGNING_SEED', make: () => randomBytes(32).toString('base64url'), what: "the insurer's attestation signing seed (no ceremony on one machine)" },
];

/** The settings for a quick first boot on one machine; `npm start` takes the explorer port from the file. */
export const SETTINGS: ReadonlyArray<{ name: string; value: string; why: string }> = [
  { name: 'ZKTRIDENT_FORMULARY_LIMIT', value: '100', why: '100 drugs instead of the ~30,000 of the catalog: a boot in minutes (npm start -- --full-catalog loads them all)' },
  { name: 'ZKTRIDENT_POOL_SIZE', value: '2', why: 'batch-proving workers, about 800 MB each' },
  { name: 'ZKTRIDENT_PROOF_POOL_SIZE', value: '4', why: "the engine's proving workers" },
  { name: 'ZKTRIDENT_OPEN_BROWSERS', value: '0', why: 'npm start prints where each dashboard is instead' },
];

/** Reads a local env file (paths.ts ENV_FILE), or null when setup has not written it. */
export function readLocalEnv(file: string): Record<string, string> | null {
  if (!existsSync(file)) return null;
  return parseEnv(readFileSync(file, 'utf8')) as Record<string, string>;
}

/** The text of a new local env file: every secret made fresh, the settings, and the explorer's port. */
export function newLocalEnv(explorerPort: number, today: string = new Date().toISOString().slice(0, 10)): string {
  const lines = [
    `# The local profile's secrets and settings, written by \`npm run setup\` on ${today}. Ignored by git.`,
    '# For this machine only: a production network makes its node secrets at the key ceremony (scripts/keys/).',
    '# `npm run setup -- --new-secrets` replaces them, which signs out every dashboard and voids earlier attestations.',
    '',
  ];
  for (const s of SECRETS) lines.push(`# ${s.what}`, `${s.name}=${s.make()}`);
  lines.push('');
  for (const s of SETTINGS) lines.push(`# ${s.why}`, `${s.name}=${s.value}`);
  lines.push('# the explorer; setup chose the first free port', `ZKTRIDENT_EXPLORER_PORT=${explorerPort}`, '');
  return lines.join('\n');
}

/** Whether nothing listens on the port on the loopback address the network binds by default. */
export function portIsFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, host);
  });
}

/** The first free port from `from` up to `to`, or null. */
export async function firstFreePort(from: number, to: number): Promise<number | null> {
  for (let port = from; port <= to; port++) if (await portIsFree(port)) return port;
  return null;
}

/**
 * The node arguments `npm start` runs the network and the HR Tool with. The script paths are absolute, so each command
 * line names this checkout and `npm stop` (scripts/dev/kill-ports-lib.ts `isThisCheckout`) knows the processes as its
 * own; with relative paths it left the sequencer and the HR Tool running.
 */
export function launchArgs(root: string): { network: string[]; hrTool: string[] } {
  return {
    network: ['--import', 'tsx', path.join(root, 'src', 'nodes', 'start-leviathan.ts')],
    hrTool: ['--import', 'tsx', path.join(root, 'src', 'tools', 'hr-tool-server.ts')],
  };
}

/** The ports a local network listens on, with what serves each. */
export function networkPorts(explorerPort: number): Array<{ port: number; serves: string }> {
  return [
    { port: 3030, serves: 'sequencer and engine' },
    { port: 3031, serves: 'replica 1' },
    { port: 3032, serves: 'replica 2' },
    { port: 4001, serves: 'member node (the phone)' },
    { port: 4002, serves: 'prescriber node' },
    { port: 4003, serves: 'pharmacy node' },
    { port: 4004, serves: 'insurer node and marketplace' },
    { port: 4040, serves: 'proof delegate' },
    { port: explorerPort, serves: 'explorer' },
    { port: HR_TOOL_PORT, serves: 'HR Tool' },
  ];
}
