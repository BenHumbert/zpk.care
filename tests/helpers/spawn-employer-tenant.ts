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
 * The insurer process at the moment it starts employer tenants — the fixture for tests/employer-tenant-spawn.test.ts.
 *
 * It runs the real spawnEmployerTenant once for each request in its first argument (JSON), with this process's own
 * environment standing for the insurer's. Two things are replaced before the orchestrator loads: child_process.spawn,
 * which records the command and the environment a tenant would have been started with and returns a child that never
 * runs, and fetch, which answers as the sequencer and as a tenant that has reached phase=ready. It prints one line,
 * RESULT_MARKER and then JSON: this process's PID, what each call returned, what each spawn was given, and the tenant
 * registrations the sequencer was sent.
 */
import { EventEmitter } from 'events';
import { createRequire, syncBuiltinESMExports } from 'module';

const RESULT_MARKER = '@@tenant-spawn ';

interface TenantRequest { employerId: string; employerPubKeyHex: string; sequencerUrl: string; insurerUrl: string }
interface Spawned { command: string; args: string[]; env: Record<string, string | undefined> }
interface Registration { employerId: string; adminTokenFingerprint: string }

const requests = JSON.parse(process.argv[2] ?? '[]') as TenantRequest[];
const spawned: Spawned[] = [];
const registrations: Registration[] = [];

/** Records the spawn; a spawn given no env would inherit this whole process's, so that is what it records then. */
function recordingSpawn(command: string, args: string[], options: { env?: NodeJS.ProcessEnv } = {}): EventEmitter {
  spawned.push({ command, args: [...args], env: { ...(options.env ?? process.env) } });
  const child = Object.assign(new EventEmitter(), {
    pid: 50_000 + spawned.length,
    killed: false,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill(): boolean { child.killed = true; return true; },
  });
  return child;
}
const childProcess = createRequire(import.meta.url)('child_process') as { spawn: unknown };
childProcess.spawn = recordingSpawn;
syncBuiltinESMExports();

function answer(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.pathname === '/health') return answer({ ok: true, data: { phase: 'ready' } });
  const call = JSON.parse(String(init.body ?? '{}')) as { id?: number; method?: string; params?: Record<string, string> };
  const params = call.params ?? {};
  const reply = (result: unknown) => answer({ jsonrpc: '2.0', id: call.id ?? 1, result });
  switch (call.method) {
    case 'l2_getEmployerNode':
      return reply(null);
    case 'l2_getEmployerAttestation': {
      const request = requests.find((r) => r.employerId === params.employerId);
      return reply(request ? { employerId: request.employerId, publicKeyHex: request.employerPubKeyHex } : null);
    }
    case 'l2_registerEmployerNode':
      registrations.push({ employerId: params.employerId, adminTokenFingerprint: params.adminTokenFingerprint });
      return reply({ registered: true });
    default:
      return answer({ jsonrpc: '2.0', id: call.id ?? 1, error: { code: -32601, message: `not answered here: ${call.method}` } });
  }
}) as typeof fetch;

try {
  const orchestrator = await import('../../src/nodes/employer-orchestrator.js');
  const results = [];
  for (const request of requests) {
    results.push(await orchestrator.spawnEmployerTenant({ ...request, signSequencerRequest: () => ({ 'x-admin-signature': 'insurer:stand-in' }) }));
  }
  orchestrator.shutdownAllTenants();
  process.stdout.write(RESULT_MARKER + JSON.stringify({ pid: process.pid, results, spawned, registrations }) + '\n', () => process.exit(0));
} catch (e) {
  console.error('the insurer stand-in failed:', e);
  process.exit(1);
}
