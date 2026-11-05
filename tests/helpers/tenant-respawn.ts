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
 * The plan's process across a restart of its own, for tests/employer-tenant-store.test.ts (A-136).
 *
 * The orchestrator reads its own location from import.meta, which the suites (run as CommonJS) cannot load, so this
 * runs under tsx in a process of its own, as tests/helpers/spawn-employer-tenant.ts does. With the plan's keys
 * configured it activates one tenant for real, creates a group and an invite through the tenant's admin routes, marks
 * the token collected, stops the tenant as the plan's restart would, brings it back from the registry, and reads the
 * group and the invite again with the same token. It prints RESULT_MARKER and then JSON.
 *
 * Arguments: the stand-in sequencer's URL, a state directory, the employer ID, its public key, the plan ID.
 */
import path from 'path';
import { createHash, randomBytes } from 'crypto';
import { Poseidon } from 'o1js';
import { hashString } from '../../src/zkp/hash-utils.js';
import {
  spawnEmployerTenant, shutdownAllTenants, configureTenantKeys, respawnRegisteredTenants, markTenantCredentialsCollected,
  tenantRegistration, type TenantRegistration,
} from '../../src/nodes/employer-orchestrator.js';
import { SealedRecordStore } from '../../src/keys/sealed-store.js';

const RESULT_MARKER = '@@tenant-respawn ';
const [sequencerUrl, stateDir, employerId, employerPubKeyHex, planId] = process.argv.slice(2);

async function main(): Promise<void> {
  const master = randomBytes(32);
  const keys = { subkey: (label: string) => createHash('sha256').update(master).update(label).digest() };
  const registry = SealedRecordStore.open<TenantRegistration>({ dir: path.join(stateDir, 'plan-records'), name: 'tenants', key: randomBytes(32) });
  configureTenantKeys({ keys, registry, stateDir });
  const signSequencerRequest = () => ({});
  const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

  const spawned = await spawnEmployerTenant({ employerId, employerPubKeyHex, sequencerUrl, insurerUrl: 'http://127.0.0.1:9', signSequencerRequest });
  const auth = { Authorization: `Bearer ${spawned.adminToken}`, 'Content-Type': 'application/json' };
  const createdGroup = (await fetch(`${spawned.employerNodeUrl}/groups`, {
    method: 'POST', headers: auth, body: JSON.stringify({ groupId: 'G1', planId, effectiveDate: '20260101', enrollmentCap: 5 }),
  })).status;
  const employeeIdHash = Poseidon.hash([hashString('employee-1')]).toString();
  const generated = await (await fetch(`${spawned.employerNodeUrl}/tokens/generate`, {
    method: 'POST', headers: auth, body: JSON.stringify({ groupId: 'G1', employeeIdHash, validUntil: inDays(7) }),
  })).json() as { data?: { tokenId?: string } };
  const tokenId = generated.data?.tokenId ?? '';

  const registered = tenantRegistration(employerId)!;
  const pendingBeforeCollection = registered.pendingAdminToken === spawned.adminToken;
  markTenantCredentialsCollected(employerId);
  const pendingAfterCollection = tenantRegistration(employerId)!.pendingAdminToken ?? null;
  const registryHoldsToken = JSON.stringify([...registry.entries()]).includes(spawned.adminToken);

  // the plan's process stops, its tenants with it, and starts again
  shutdownAllTenants();
  await new Promise((r) => setTimeout(r, 1500));
  const back = await respawnRegisteredTenants({ sequencerUrl, insurerUrl: 'http://127.0.0.1:9', signSequencerRequest });
  const groups = await (await fetch(`${spawned.employerNodeUrl}/groups`, { headers: auth })).json() as { data?: Array<{ groupId: string; pendingTokens: number }> };
  const invite = (await fetch(`${spawned.employerNodeUrl}/tokens/${encodeURIComponent(tokenId)}`, { headers: auth })).status;
  const wrongToken = (await fetch(`${spawned.employerNodeUrl}/groups`, { headers: { Authorization: 'Bearer not-the-token' } })).status;

  shutdownAllTenants();
  await new Promise((r) => setTimeout(r, 1500));
  registry.close();
  console.log(RESULT_MARKER + JSON.stringify({
    employerNodeUrl: spawned.employerNodeUrl,
    createdGroup,
    tokenIssued: tokenId.length > 0,
    adminTokenSha256Matches: registered.adminTokenSha256 === createHash('sha256').update(spawned.adminToken).digest('hex'),
    pendingBeforeCollection,
    pendingAfterCollection,
    registryHoldsToken,
    back,
    groupsAfter: (groups.data ?? []).map((g) => ({ groupId: g.groupId, pendingTokens: g.pendingTokens })),
    inviteAfter: invite,
    wrongToken,
  }));
}

main().then(() => process.exit(0), (err) => {
  console.log(RESULT_MARKER + JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  shutdownAllTenants();
  process.exit(1);
});
