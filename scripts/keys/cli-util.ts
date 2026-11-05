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

/** What the key ceremony's two programs share: arguments, a hidden passphrase prompt, files and the program hash. */
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';

export function parseArgs(argv: string[]): { command: string | undefined; options: Map<string, string>; flags: Set<string> } {
  const [command, ...rest] = argv;
  const options = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`);
    const name = arg.slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith('--')) flags.add(name);
    else {
      options.set(name, next);
      i++;
    }
  }
  return { command, options, flags };
}

export function required(options: Map<string, string>, name: string): string {
  const value = options.get(name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

/** Ask without echoing what is typed. */
export function promptHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) return Promise.reject(new Error('there is no terminal to ask on'));
  return new Promise((resolve, reject) => {
    let value = '';
    process.stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    const cleanup = () => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write('\n');
    };
    const onData = (buf: Buffer) => {
      for (const ch of buf.toString('utf8')) {
        if (ch === '\r' || ch === '\n') {
          cleanup();
          resolve(value);
          return;
        }
        if (ch === '\u0003') {
          cleanup();
          reject(new Error('cancelled'));
          return;
        }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

/** Ask a yes/no question on the terminal; anything but the expected answer is no. */
export async function confirm(question: string, expected: string): Promise<boolean> {
  const stdin = process.stdin;
  if (!stdin.isTTY) return false;
  process.stdout.write(question);
  return new Promise((resolve) => {
    stdin.resume();
    stdin.once('data', (buf: Buffer) => {
      stdin.pause();
      resolve(buf.toString('utf8').trim() === expected);
    });
  });
}

/**
 * The holder's passphrase: ZPK_HOLDER_PASSPHRASE when the holder's own automation sets it (the test harness plays the
 * holders that way), otherwise asked on the terminal without echo.
 */
export async function holderPassphrase(twice = false): Promise<string> {
  const fromEnv = process.env.ZPK_HOLDER_PASSPHRASE;
  if (fromEnv) return fromEnv;
  const first = await promptHidden('Holder passphrase: ');
  if (twice && (await promptHidden('Again, to check: ')) !== first) throw new Error('the two passphrases differ');
  return first;
}

export function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

/** Write a file whole or not at all; refuse to replace one unless asked. */
export function writeJson(file: string, value: unknown, opts: { replace?: boolean } = {}): void {
  if (!opts.replace && fs.existsSync(file)) throw new Error(`${file} already exists; it is not replaced`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * The SHA-256 of the ceremony program's source (src/keys and scripts/keys), line endings normalized, so the holders
 * can compare it with the release they reviewed. It goes into the ceremony record.
 */
export function programSourceSha256(): string {
  const files: string[] = [];
  for (const dir of ['src/keys', 'scripts/keys']) {
    for (const name of fs.readdirSync(path.join(repoRoot, dir)).sort()) {
      if (name.endsWith('.ts')) files.push(`${dir}/${name}`);
    }
  }
  const outer = createHash('sha256');
  for (const rel of files) {
    const text = fs.readFileSync(path.join(repoRoot, rel), 'utf8').replace(/\r\n/g, '\n');
    outer.update(`${rel}\n${createHash('sha256').update(text, 'utf8').digest('hex')}\n`);
  }
  return outer.digest('hex');
}

export function fail(err: unknown): never {
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
