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
 * Sealing a node's master to the machine it runs on — the restart rule (owner, 2026-11-05).
 *
 * "If it shuts down and restarts we dont need keys to have it come back online." The key holders provision a node once,
 * and again only on a replaced machine; the node then seals its master with what its machine offers, and every later
 * start opens it with no person and no network. A copy of the node's disk opened on another machine, or under another
 * account, opens nothing.
 *
 * Windows: DPAPI under the account the node runs as (CurrentUser scope), with the purpose as its entropy. It is reached
 * through Windows PowerShell at its absolute path, so a planted powershell.exe earlier on the PATH is never run, and the
 * secret travels on stdin, never on a command line. DPAPI binds the master to the account's credentials on this
 * machine; a full image of the machine's disk together with the account's password would still open it, which a TPM
 * (later, with packaging) would not. Other platforms have no seal yet: a secured boot there refuses, and an unsecure
 * development boot keeps the master in the clear and says so.
 */
import { spawn } from 'child_process';
import path from 'path';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

export type MachineSealKind = 'dpapi' | 'development' | 'test';

export interface MachineSeal {
  readonly kind: MachineSealKind;
  /** One sentence for the boot log. */
  readonly description: string;
  seal(secret: Uint8Array, context: string): Promise<Buffer>;
  open(blob: Uint8Array, context: string): Promise<Buffer>;
}

const LABEL = 'zpk.care/machine-seal/v1';

function entropyFor(context: string): Buffer {
  if (typeof context !== 'string' || !/^[\x21-\x7e]{1,256}$/.test(context)) {
    throw new Error('machine seal: the context must be 1 to 256 printable characters');
  }
  return Buffer.from(`${LABEL}\n${context}`, 'utf8');
}

// ─── Windows: DPAPI ───────────────────────────────────────────────────────────

const DPAPI_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  'Add-Type -AssemblyName System.Security',
  '$mode = [Console]::In.ReadLine()',
  '$entropy = [Convert]::FromBase64String([Console]::In.ReadLine())',
  '$data = [Convert]::FromBase64String([Console]::In.ReadLine())',
  '$scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser',
  "if ($mode -eq 'protect') { $out = [System.Security.Cryptography.ProtectedData]::Protect($data, $entropy, $scope) }",
  "elseif ($mode -eq 'unprotect') { $out = [System.Security.Cryptography.ProtectedData]::Unprotect($data, $entropy, $scope) }",
  "else { throw 'unknown mode' }",
  '[Console]::Out.Write([Convert]::ToBase64String($out))',
].join('\n');

function powershellPath(): string {
  const root = process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows';
  return path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function runDpapi(mode: 'protect' | 'unprotect', data: Uint8Array, entropy: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(powershellPath(), [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-EncodedCommand', Buffer.from(DPAPI_SCRIPT, 'utf16le').toString('base64'),
    ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const out: Buffer[] = [];
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', () => { /* PowerShell's error text is not passed on: it can quote its input */ });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('machine seal (DPAPI): PowerShell did not answer within 30 s'));
    }, 30_000);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`machine seal (DPAPI): could not start PowerShell: ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const text = Buffer.concat(out).toString('utf8').trim();
      if (code !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(text)) {
        reject(new Error(mode === 'unprotect'
          ? 'machine seal (DPAPI): the sealed key could not be opened (another machine or account, another purpose, or changed)'
          : 'machine seal (DPAPI): the key could not be sealed'));
        return;
      }
      resolve(Buffer.from(text, 'base64'));
    });
    child.stdin.end(`${mode}\n${entropy.toString('base64')}\n${Buffer.from(data).toString('base64')}\n`);
  });
}

export function dpapiSeal(): MachineSeal {
  return {
    kind: 'dpapi',
    description: 'sealed with Windows DPAPI to this machine and the account the node runs as',
    seal: (secret, context) => runDpapi('protect', secret, entropyFor(context)),
    open: (blob, context) => runDpapi('unprotect', blob, entropyFor(context)),
  };
}

// ─── Development: no seal ─────────────────────────────────────────────────────

const DEV_PREFIX = 'zpk.care/development-seal/v1\n';

/** Keeps the master in the clear, beside the stores it opens. For an unsecure development boot only. */
export function developmentSeal(): MachineSeal {
  return {
    kind: 'development',
    description: 'NOT sealed: the master is kept in the clear (unsecure development boot)',
    async seal(secret, context) {
      entropyFor(context);
      return Buffer.from(`${DEV_PREFIX}${context}\n${Buffer.from(secret).toString('base64')}`, 'utf8');
    },
    async open(blob, context) {
      entropyFor(context);
      const text = Buffer.from(blob).toString('utf8');
      if (!text.startsWith(DEV_PREFIX)) throw new Error('development seal: this is not a development-sealed key');
      const [sealedFor, b64] = text.slice(DEV_PREFIX.length).split('\n');
      if (sealedFor !== context) throw new Error('development seal: this key was sealed for another purpose');
      return Buffer.from(b64 ?? '', 'base64');
    },
  };
}

// ─── Tests: one instance stands for one machine ──────────────────────────────

/** For tests: a seal under a random key held by this instance, so another instance plays another machine. */
export function testOnlyMachineSeal(): MachineSeal {
  const key = randomBytes(32);
  return {
    kind: 'test',
    description: 'sealed under a key held in this process (tests only)',
    async seal(secret, context) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(entropyFor(context));
      const body = Buffer.concat([cipher.update(secret), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]);
    },
    async open(blob, context) {
      try {
        const b = Buffer.from(blob);
        const decipher = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
        decipher.setAAD(entropyFor(context));
        decipher.setAuthTag(b.subarray(12, 28));
        return Buffer.concat([decipher.update(b.subarray(28)), decipher.final()]);
      } catch {
        throw new Error('test seal: the sealed key could not be opened (another machine, another purpose, or changed)');
      }
    },
  };
}

// ─── Choosing one ─────────────────────────────────────────────────────────────

/**
 * The seal a node uses: `ZKTRIDENT_KEY_SEAL` when set (dpapi, development), otherwise DPAPI on Windows. A secured boot
 * on a platform with no seal refuses rather than keep its master in the clear.
 */
export function resolveMachineSeal(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): MachineSeal {
  const unsecure = env.ZKTRIDENT_UNSECURE === 'true';
  const chosen = env.ZKTRIDENT_KEY_SEAL?.trim().toLowerCase();
  if (chosen === 'dpapi' || (!chosen && platform === 'win32')) {
    if (platform !== 'win32') throw new Error('ZKTRIDENT_KEY_SEAL=dpapi: DPAPI is a Windows seal; this machine is not Windows');
    return dpapiSeal();
  }
  if (chosen === 'development' || (!chosen && unsecure)) {
    if (!unsecure) {
      throw new Error('ZKTRIDENT_KEY_SEAL=development keeps the node master in the clear; only an unsecure boot (ZKTRIDENT_UNSECURE=true) may use it');
    }
    return developmentSeal();
  }
  if (chosen) throw new Error(`ZKTRIDENT_KEY_SEAL=${chosen}: not a machine seal this node knows (dpapi, development)`);
  throw new Error(`no machine seal for ${platform}: this node cannot keep its master sealed here (a TPM seal comes with packaging); set ZKTRIDENT_UNSECURE=true for a development boot`);
}
