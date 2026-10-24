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
 * An employer tenant starts with an environment of its own, not the insurer's, and its admin token carries 128 random bits.
 *
 * What was wrong:
 *  1. The insurer process starts every employer tenant (src/nodes/employer-orchestrator.ts), and it started each one
 *     with a copy of its own environment, only ZKTRIDENT_UNSECURE taken out. The launcher gives the insurer its
 *     attestation signing seed (ZKTRIDENT_INSURER_SIGNING_SEED) and its sequencer node key and node ID, and nothing
 *     removed them, so the least trusted process on the insurer's host, one per self-service employer, held what it
 *     takes to act as the plan: one environment read or code-execution bug in a tenant and the insurer's authority was
 *     gone. The launcher has scrubbed its own children's environments since A9; the orchestrator had not been moved over.
 *     The insurer's TLS certificate and key settings came through as well, so with TLS configured a tenant loaded the
 *     insurer's private key and served HTTPS where the orchestrator polls and registers plain HTTP.
 *  2. The tenant's admin token kept the first 16 of the 32 hex characters it drew, 64 random bits, under a comment that
 *     said 128.
 *  3. The insurer's listener settings came through as well: the public names it answers (ZKTRIDENT_PUBLIC_HOSTS) and
 *     the reverse proxies it trusts (ZKTRIDENT_TRUSTED_PROXIES). Only the insurer reaches a tenant, at 127.0.0.1, and
 *     no proxy stands in front of one, yet every tenant answered the insurer's names and trusted its proxies, and each,
 *     bound to loopback with a public name and no proxy of its own, warned at every boot that a reverse proxy in front
 *     of it made every caller one source, even where the insurer served its name itself.
 *
 * The first two were found by the security posture check of 2026-10-24 (A-78 and A-84), the third by the review of the
 * trusted-proxy fix.
 *
 * Now the tenant's environment is the launcher's scrubbed one (childEnvironment), without the insurer's node ID or TLS
 * certificate and key, the prover's key, the development flag or the insurer's listener settings either, plus exactly
 * what the employer node needs, by name: its port, the loopback host, its employer ID and public key, the sequencer and
 * insurer URLs, its own admin token, and the insurer's PID to watch. The host's environment and the operator's network
 * settings still reach it, and a tenant of an insurer that answers a public name warns of no reverse proxy. The token
 * keeps all 128 bits, in the same `<employer id>-admin-<hex>` form the activation screen hands over.
 *
 * The real spawnEmployerTenant runs in a child process whose environment stands for the insurer's, with spawn and the
 * sequencer stood in for (tests/helpers/spawn-employer-tenant.ts). The employer launcher is then started for real with
 * the command and environment that spawn was given, against a stand-in sequencer that holds the employer's attestation.
 */
import fs from 'fs';
import os from 'os';
import net from 'net';
import path from 'path';
import http from 'http';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { createHash, randomBytes } from 'crypto';
import type { AddressInfo } from 'net';
import { SECRET_ENV_KEYS } from '../src/security/node-roles.js';

jest.setTimeout(120_000);

const REPO = path.resolve(__dirname, '..');
const RESULT_MARKER = '@@tenant-spawn ';
const hex = (bytes: number): string => randomBytes(bytes).toString('hex');

/** Secrets an insurer process may hold: what the launcher gives it, and what an operator's shell may add. */
const INSURER_SECRETS: Record<string, string> = {
  ZKTRIDENT_INSURER_SIGNING_SEED: hex(32),
  ZKTRIDENT_NODE_KEY_SEED: hex(32),
  ZKTRIDENT_ADMIN_TOKEN: `insurer-own-admin-${hex(16)}`,
  ZKTRIDENT_INSURER_ADMIN_TOKEN: `insurer-admin-${hex(16)}`,
  ZKTRIDENT_PRESCRIBER_ADMIN_TOKEN: `prescriber-admin-${hex(16)}`,
  ZKTRIDENT_GOSSIP_SECRET: `gossip-${hex(16)}`,
  ZKTRIDENT_GENESIS_ADMIN_KEY: hex(32),
  ZKTRIDENT_PIN: '482913',
  ZKTRIDENT_MEMBER_PIN: '771204',
  ZKTRIDENT_PROVER_API_KEY: `prover-${hex(16)}`,
  ZKTRIDENT_TLS_KEY: path.join(REPO, `insurer-tls-${hex(8)}.key`),
};
/**
 * The insurer's own identity and place on the network, which are not the tenant's. It serves its public name itself, on
 * every interface, with no reverse proxy in front of it.
 */
const INSURER_OWN = {
  ZKTRIDENT_NODE_ID: 'insurer',
  ZKTRIDENT_TLS_CERT: path.join(REPO, 'insurer-tls.crt'),
  ZKTRIDENT_UNSECURE: 'true',
  ZKTRIDENT_PORT: '4004',
  ZKTRIDENT_HOST: '0.0.0.0',
  ZKTRIDENT_PUBLIC_HOSTS: 'insurer.example',
  ZKTRIDENT_SEQUENCER_URL: 'http://localhost:3030',
  ZKTRIDENT_PARENT_PID: '1',
};
/** An insurer behind a reverse proxy on its own host, as RUNNING.md sets one up: its listener settings. */
const INSURER_BEHIND_PROXY = {
  ZKTRIDENT_HOST: '127.0.0.1',
  ZKTRIDENT_PUBLIC_HOSTS: 'insurer.example',
  ZKTRIDENT_TRUSTED_PROXIES: '127.0.0.1',
};
/** The insurer's listener settings: the public names it answers and the reverse proxies it trusts. */
const LISTENER_SETTINGS = ['ZKTRIDENT_PUBLIC_HOSTS', 'ZKTRIDENT_TRUSTED_PROXIES'];
/** Network-wide settings from the operator, which the tenant applies as well. */
const OPERATOR_SETTINGS = { ZKTRIDENT_RPC_PROXY: '0', ZKTRIDENT_MAX_SSE: '7' };

interface TenantRequest { employerId: string; employerPubKeyHex: string; sequencerUrl: string; insurerUrl: string }
interface Outcome {
  pid: number;
  results: Array<{ employerId: string; employerNodeUrl: string; adminToken: string }>;
  spawned: Array<{ command: string; args: string[]; env: Record<string, string | undefined> }>;
  registrations: Array<{ employerId: string; adminTokenFingerprint: string }>;
}

/** A sequencer that holds each requested employer's attestation, for the tenant that is booted for real. */
let sequencer: http.Server;
let requests: TenantRequest[] = [];
let outcome: Outcome;
let tenantChild: ChildProcess | null = null;
let stateDir = '';

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const port = (s.address() as AddressInfo).port; s.close(() => resolve(port)); });
  });
}

/**
 * What the insurer stand-in (tests/helpers/spawn-employer-tenant.ts) printed after starting a tenant for each of
 * `tenantRequests`, with the host's environment and `insurerEnv` as the insurer's.
 */
function runInsurer(insurerEnv: Record<string, string>, tenantRequests: TenantRequest[]): Outcome {
  const env: NodeJS.ProcessEnv = {};
  for (const k of ['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA']) {
    if (process.env[k] !== undefined) env[k] = process.env[k];
  }
  Object.assign(env, insurerEnv);
  const run = spawnSync(process.execPath, ['--import', 'tsx', path.join(REPO, 'tests', 'helpers', 'spawn-employer-tenant.ts'), JSON.stringify(tenantRequests)], {
    cwd: REPO, env, encoding: 'utf8', timeout: 90_000, windowsHide: true,
  });
  const line = (run.stdout ?? '').split(/\r?\n/).find((l) => l.startsWith(RESULT_MARKER));
  if (!line) throw new Error(`the insurer stand-in printed no result (exit ${run.status}):\n${run.stdout}\n${run.stderr}`);
  return JSON.parse(line.slice(RESULT_MARKER.length)) as Outcome;
}

beforeAll(async () => {
  sequencer = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let call: { id?: number; method?: string; params?: { employerId?: string } } = {};
      try { call = JSON.parse(raw || '{}'); } catch { /* answered as unknown below */ }
      const request = requests.find((r) => r.employerId === call.params?.employerId);
      const result = call.method === 'l2_verifyEmployer' && request
        ? { valid: true, attestation: { employerId: request.employerId, publicKeyHex: request.employerPubKeyHex, authorizedPlanIds: ['PLAN-1'] } }
        : null;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: call.id ?? 1, result }));
    });
  });
  await new Promise<void>((resolve) => sequencer.listen(0, '127.0.0.1', () => resolve()));
  const sequencerUrl = `http://127.0.0.1:${(sequencer.address() as AddressInfo).port}`;
  requests = [
    { employerId: 'ACME-001', employerPubKeyHex: hex(32), sequencerUrl, insurerUrl: 'http://localhost:4004' },
    { employerId: 'Globex-002', employerPubKeyHex: hex(32), sequencerUrl, insurerUrl: 'http://localhost:4004' },
  ];
  outcome = runInsurer({ ...INSURER_SECRETS, ...INSURER_OWN, ...OPERATOR_SETTINGS }, requests);
});

afterAll(async () => {
  if (tenantChild && tenantChild.exitCode === null) {
    const exited = new Promise<void>((resolve) => tenantChild!.once('exit', () => resolve()));
    tenantChild.kill();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([exited, new Promise<void>((resolve) => { timer = setTimeout(resolve, 5000); })]);
    clearTimeout(timer);
  }
  await new Promise<void>((resolve) => sequencer.close(() => resolve()));
  if (stateDir) { try { fs.rmSync(stateDir, { recursive: true, force: true }); } catch { /* best effort */ } }
});

/** Each tenant's request, what spawnEmployerTenant returned for it, and the environment its spawn was given. */
function tenants(): Array<{ request: TenantRequest; result: Outcome['results'][number]; env: Record<string, string | undefined> }> {
  expect(outcome.spawned).toHaveLength(requests.length);
  return requests.map((request, i) => ({ request, result: outcome.results[i], env: outcome.spawned[i].env }));
}

describe('0. a secret named in another case stays behind too', () => {
  // Windows reads environment names case-insensitively: an insurer configured by hand with lower-case names still
  // reads its secrets, and a tenant given zktrident_tls_key reads it back as ZKTRIDENT_TLS_KEY.
  test('lower- and mixed-case secret names reach no tenant', () => {
    const LOWER: Record<string, string> = {
      zktrident_insurer_signing_seed: hex(32), Zktrident_Node_Key_Seed: hex(32), zktrident_gossip_secret: `gossip-${hex(16)}`,
      zktrident_tls_key: path.join(REPO, `lower-tls-${hex(8)}.key`), zktrident_node_id: 'insurer-lower',
    };
    const lowerOutcome = runInsurer(LOWER, requests.slice(0, 1));
    const values = Object.values(lowerOutcome.spawned[0].env).map(String);
    for (const [key, secret] of Object.entries(LOWER)) {
      expect([key, values.filter((v) => v === secret || (secret.length >= 16 && v.includes(secret)))]).toEqual([key, []]);   // before: all five came through
    }
  });
});

describe('1. a tenant starts with none of the insurer\'s secrets, and with what the employer node needs', () => {
  test('the insurer\'s signing seed, node key and every other secret stay behind; the only admin token is the tenant\'s own', () => {
    for (const { result, env } of tenants()) {
      // before: every one of them came through, the insurer's signing seed and node key among them
      expect(SECRET_ENV_KEYS.filter((k) => k !== 'ZKTRIDENT_ADMIN_TOKEN' && env[k] !== undefined)).toEqual([]);
      expect(env.ZKTRIDENT_ADMIN_TOKEN).toBe(result.adminToken);
      // under no other name either (the PINs are too short to look for by value; their names are checked above)
      const values = Object.values(env).map(String);
      for (const [key, secret] of Object.entries(INSURER_SECRETS).filter(([, s]) => s.length >= 16)) {
        expect([key, values.filter((v) => v.includes(secret))]).toEqual([key, []]);
      }
    }
  });

  test('the insurer\'s node ID, TLS certificate and key, the prover key and the development flag stay behind too', () => {
    for (const { env } of tenants()) {
      const insurers = ['ZKTRIDENT_NODE_ID', 'ZKTRIDENT_TLS_CERT', 'ZKTRIDENT_TLS_KEY', 'ZKTRIDENT_PROVER_API_KEY', 'ZKTRIDENT_UNSECURE'];
      expect(insurers.filter((k) => env[k] !== undefined)).toEqual([]);   // before: all but ZKTRIDENT_UNSECURE came through
    }
  });

  test('the insurer\'s listener settings, its public names and the proxies it trusts, stay behind: only the insurer reaches a tenant', () => {
    // The insurer above serves its name itself; this one is behind a reverse proxy on its own host.
    const behindProxy = runInsurer(INSURER_BEHIND_PROXY, requests.slice(0, 1));
    for (const env of [...tenants().map((t) => t.env), behindProxy.spawned[0].env]) {
      expect(Object.keys(env).filter((k) => LISTENER_SETTINGS.includes(k.toUpperCase()))).toEqual([]);   // before: the insurer's came through
    }
  });

  test('it is given, by name, its own port on loopback, its identity, the URLs it calls, its own token and its parent', () => {
    for (const { request, result, env } of tenants()) {
      expect(env.ZKTRIDENT_PORT).toBe(new URL(result.employerNodeUrl).port);
      expect(env.ZKTRIDENT_HOST).toBe('127.0.0.1');
      expect(env.ZKTRIDENT_EMPLOYER_ID).toBe(request.employerId);
      expect(env.ZKTRIDENT_EMPLOYER_PUBKEY_HEX).toBe(request.employerPubKeyHex);
      expect(env.ZKTRIDENT_SEQUENCER_URL).toBe(request.sequencerUrl);
      expect(env.ZKTRIDENT_INSURER_URL).toBe(request.insurerUrl);
      expect(env.ZKTRIDENT_PARENT_PID).toBe(String(outcome.pid));
    }
    for (const s of outcome.spawned) {
      expect(s.command).toBe(process.execPath);
      expect(s.args.slice(0, 2)).toEqual(['--import', 'tsx']);
      expect(s.args[2].endsWith(path.join('src', 'nodes', 'start-employer-nautilus.ts'))).toBe(true);
    }
  });

  test('the host\'s environment and the operator\'s network settings still reach it', () => {
    for (const { env } of tenants()) {
      const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH');
      expect(pathKey && env[pathKey]).toBe(process.env.PATH);
      expect(env.ZKTRIDENT_RPC_PROXY).toBe('0');
      expect(env.ZKTRIDENT_MAX_SSE).toBe('7');
    }
  });

  test('the employer launcher reads no node key, and the only secret it reads is its own admin token', () => {
    const starter = fs.readFileSync(path.join(REPO, 'src', 'nodes', 'start-employer-nautilus.ts'), 'utf8');
    expect(starter).not.toMatch(/nodeKeyFromEnv|NODE_KEY_SEED|ZKTRIDENT_NODE_ID/);
    const reads = Array.from(new Set(starter.match(/ZKTRIDENT_[A-Z0-9_]+/g) ?? []));
    expect(reads).toEqual(expect.arrayContaining(['ZKTRIDENT_EMPLOYER_ID', 'ZKTRIDENT_EMPLOYER_PUBKEY_HEX', 'ZKTRIDENT_ADMIN_TOKEN']));
    expect(reads.filter((k) => SECRET_ENV_KEYS.includes(k))).toEqual(['ZKTRIDENT_ADMIN_TOKEN']);
  });

  test('started as the orchestrator starts it, with that environment, the employer node reaches phase=ready, answers its own token and warns of no reverse proxy', async () => {
    const [{ result }] = tenants();
    const { command, args, env } = outcome.spawned[0];
    const port = await freePort();
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-boot-'));
    // Only what cannot carry over from the stand-in run: a port free now, a parent still alive, and
    // a state directory outside the repository.
    tenantChild = spawn(command, args, {
      cwd: REPO,
      env: { ...env, ZKTRIDENT_PORT: String(port), ZKTRIDENT_PARENT_PID: String(process.pid), ZKTRIDENT_STATE_DIR: stateDir },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let output = '';
    tenantChild.stdout?.on('data', (d: Buffer) => { output += d.toString(); });
    tenantChild.stderr?.on('data', (d: Buffer) => { output += d.toString(); });
    const base = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 90_000;
    let phase = '';
    while (phase !== 'ready') {
      if (tenantChild.exitCode !== null) throw new Error(`the employer node exited (code ${tenantChild.exitCode}):\n${output}`);
      if (Date.now() > deadline) throw new Error(`the employer node did not reach phase=ready:\n${output}`);
      try {
        const health = await (await fetch(`${base}/health`)).json() as { data?: { phase?: string } };
        phase = health?.data?.phase ?? '';
      } catch { /* not listening yet */ }
      if (phase !== 'ready') await new Promise((r) => setTimeout(r, 250));
    }
    expect((await fetch(`${base}/groups`, { headers: { Authorization: `Bearer ${result.adminToken}` } })).status).toBe(200);
    expect((await fetch(`${base}/groups`, { headers: { Authorization: `Bearer ${INSURER_SECRETS.ZKTRIDENT_ADMIN_TOKEN}` } })).status).toBe(401);
    // The insurer answers insurer.example. The tenant, reached only by the insurer on loopback, answers no public name,
    // so it has no reverse proxy to warn of; a node warns as it starts, before it answers /health.
    const proxyWarnings = output.split(/\r?\n/).filter((line) => line.includes('ZKTRIDENT_TRUSTED_PROXIES'));
    expect(proxyWarnings).toEqual([]);   // before: the proxy warning, at every tenant's boot
  });
});

describe('2. the tenant admin token carries 128 random bits', () => {
  test('the employer ID in lower case, "-admin-", then 32 hex characters, where 16 (64 bits) were kept', () => {
    const randomParts = tenants().map(({ request, result }) => {
      const prefix = `${request.employerId.toLowerCase()}-admin-`;
      expect(result.adminToken.startsWith(prefix)).toBe(true);
      const randomPart = result.adminToken.slice(prefix.length);
      expect(randomPart).toMatch(/^[0-9a-f]{32}$/);   // before: 16 hex characters
      return randomPart;
    });
    expect(new Set(randomParts).size).toBe(randomParts.length);
  });

  test('the sequencer is sent the same 16-character fingerprint form, taken over the whole token', () => {
    expect(outcome.registrations.map((r) => r.employerId)).toEqual(requests.map((r) => r.employerId));
    outcome.registrations.forEach((registration, i) => {
      expect(registration.adminTokenFingerprint).toBe(createHash('sha256').update(outcome.results[i].adminToken).digest('hex').slice(0, 16));
      expect(registration.adminTokenFingerprint).toMatch(/^[0-9a-f]{16}$/);
    });
  });
});
