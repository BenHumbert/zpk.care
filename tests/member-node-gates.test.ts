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
 * The member node's routes behind the phone screens (screen audit, member items 1, 2, 5 and 7).
 *
 * What was wrong, and what each block holds:
 * (1) /onboarding/compile ran on the 30 s default request budget, so a compile that took longer answered 504,
 *     and a compile that threw left the device at 'compiling', where every retry got 409. It now declares the
 *     proving budget, and a failed compile hands the device back to 'enrolled'.
 * (2) The Dashboard showed a hard-coded $1,500 deductible and $5,000 out-of-pocket maximum. The new device-only
 *     GET /plan/limits answers the limits of the plan the enrollment code was redeemed into, found by its hash
 *     among the published plans, and says so when it cannot tell.
 * (5) /onboarding/recover, which the Restore screen now calls, asked the sequencer about the recovered wallet
 *     with an unsigned l2_getEntity, which D1 refuses, so every recovery answered 404. It now signs as the wallet
 *     with the recombined key.
 * (7) SECURITY: the /rpc proxy signs what it forwards as the wallet, and it answered anyone who reached the port
 *     while the device's state was unlocked. It now answers only the device's session or the node's own admin.
 *
 * Real member nodes (NautilusAppServer with the member routes) on port 0, with stand-in sequencer and insurer
 * services that record what reaches them. No compile, no proof.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import type { AddressInfo } from 'net';
import { randomBytes } from 'crypto';
import { NautilusLocalState, type NautilusStateData } from '../src/nodes/nautilus-local-state.js';
import { NautilusAppServer } from '../src/nodes/nautilus-app-server.js';
import { buildMemberRoutes } from '../src/nodes/routes/member-routes.js';
import type { NautilusAppConfig } from '../src/nodes/nautilus-app-types.js';
import type { EntityNodeBase } from '../src/nodes/entity-node-base.js';
import { hashString } from '../src/zkp/hash-utils.js';
import { issueRecoveryCards } from '../src/security/recovery-card.js';
import { deriveWalletSigningKey } from '../src/security/wallet-key.js';
import { verifySignedRequest } from '../src/security/signed-request.js';

jest.setTimeout(60_000);

const PIN = '739204';
const WALLET = '12345678901234567890';
const ADMIN = 'member-node-admin-for-tests';
const dirs: string[] = [];
const servers: NautilusAppServer[] = [];
const upstreams: http.Server[] = [];

/** A stand-in HTTP service answering every request with `answer(rawBody, headers)`; returns its URL. */
async function service(answer: (raw: string, headers: http.IncomingHttpHeaders) => { status: number; body: unknown }): Promise<string> {
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const a = answer(raw, req.headers);
      res.writeHead(a.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(a.body));
    });
  });
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()));
  upstreams.push(srv);
  return `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
}

/** A stand-in sequencer: answers every /rpc with `answer(method)` and records the method and who signed it. */
async function fakeSequencer(answer: (method: string) => unknown): Promise<{ url: string; seen: Array<{ method: string; signer: string }> }> {
  const seen: Array<{ method: string; signer: string }> = [];
  const url = await service((raw, headers) => {
    const method = String((JSON.parse(raw || '{}') as { method?: string }).method ?? '');
    seen.push({ method, signer: String(headers['x-admin-signature'] ?? '').split(':')[0] });
    return { status: 200, body: { jsonrpc: '2.0', id: 1, result: answer(method) } };
  });
  return { url, seen };
}

/**
 * A member node whose state is unlocked in-process, as the launcher does with ZKTRIDENT_PIN, and which holds
 * its enrollment key. No device session has been issued: the state the /rpc finding describes.
 */
async function memberNode(sequencerUrl: string, state: Partial<NautilusStateData> = {}, config: Partial<NautilusAppConfig> = {}): Promise<NautilusAppServer> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'member-gates-'));
  dirs.push(dir);
  const seed = new NautilusLocalState(dir);
  await seed.unlock(PIN);
  await seed.save({
    version: 1, role: 'member', walletId: WALLET, enrollmentKey: randomBytes(32).toString('base64url'),
    onboarding: { phase: 'ready' }, lastSavedAt: new Date().toISOString(), ...state,
  });
  seed.lock();
  const server = new NautilusAppServer({
    role: 'member', port: 0, host: '127.0.0.1', sequencerUrl, stateDir: dir,
    enableSSE: false, maxSseConnections: 0, allowedOrigins: [], adminToken: ADMIN, ...config,
  });
  servers.push(server);
  server.registerRoutes(buildMemberRoutes(server));
  await server.getLocalState().unlock(PIN);
  await server.getLocalState().load();
  await server.start();
  return server;
}

async function call(server: NautilusAppServer, method: string, urlPath: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
  const r = await fetch(`http://127.0.0.1:${server.getPort()}${urlPath}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}

/** The session the app gets when the member enters the PIN. */
async function sessionOf(server: NautilusAppServer): Promise<Record<string, string>> {
  const r = await call(server, 'POST', '/onboarding/unlock', { pin: PIN });
  const token = String(r.json?.data?.deviceSession ?? '');
  if (!token) throw new Error('the fixture unlock issued no device session');
  return { 'X-Device-Session': token };
}

const bearer = { Authorization: `Bearer ${ADMIN}` };

/** Just enough of a MemberNode for /onboarding/compile. */
function compilingNode(compile: () => Promise<Array<{ program: string; timeMs: number }>>): EntityNodeBase {
  return { setWalletSignerSource: () => undefined, getWalletId: () => WALLET, compilePrograms: compile } as unknown as EntityNodeBase;
}

afterAll(async () => {
  for (const s of servers) await s.stop().catch(() => undefined);
  for (const u of upstreams) await new Promise<void>((resolve) => u.close(() => resolve()));
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

describe('(1) /onboarding/compile', () => {
  test('runs past the default request budget, because it declares the proving budget', async () => {
    const node = await memberNode('http://127.0.0.1:1', {}, { requestTimeoutMs: 300 });
    node.setEntityNode(compilingNode(async () => {
      await new Promise((resolve) => setTimeout(resolve, 900));
      return [{ program: 'StateTransitionProgram', timeMs: 900 }];
    }));
    node.setOnboardingPhase('enrolled');
    const r = await call(node, 'POST', '/onboarding/compile', {}, bearer);
    expect(r.status).toBe(200); // before: 504 at 300 ms
    expect(r.json?.data?.phase).toBe('ready');
    expect(node.getOnboardingPhase()).toBe('ready');
  });

  test('a failed compile hands the device back to enrolled, so Retry can compile again', async () => {
    const node = await memberNode('http://127.0.0.1:1');
    let attempts = 0;
    node.setEntityNode(compilingNode(async () => {
      attempts++;
      if (attempts === 1) throw new Error('out of memory');
      return [{ program: 'StateTransitionProgram', timeMs: 1 }];
    }));
    node.setOnboardingPhase('enrolled');
    const failed = await call(node, 'POST', '/onboarding/compile', {}, bearer);
    expect(failed.status).toBe(500);
    expect(failed.json?.error).toMatch(/out of memory/);
    expect(node.getOnboardingPhase()).toBe('enrolled'); // before: stuck at 'compiling'
    const retried = await call(node, 'POST', '/onboarding/compile', {}, bearer);
    expect(retried.status).toBe(200); // before: 409, Cannot compile in phase: compiling
    expect(node.getOnboardingPhase()).toBe('ready');
  });
});

describe('(2) GET /plan/limits', () => {
  const PLANS = [
    { planId: 'PLAN-GOLD-2026', name: 'Gold', deductibleAmountCents: 150000, oopMaxCents: 500000, annualBenefitMaxCents: 0 },
    { planId: 'PLAN-E2E-SILVER', name: 'Silver', deductibleAmountCents: 25000, oopMaxCents: 300000, annualBenefitMaxCents: 1000000 },
  ];
  const redeemed = (planId: string): Partial<NautilusStateData> => ({
    enrollment: { groupIdHash: '1', planIdHash: hashString(planId).toString(), employerId: null, redeemedAt: Date.now() },
  });

  test('answers the limits of the plan the code was redeemed into, found by its hash', async () => {
    const seq = await fakeSequencer((m) => (m === 'l2_getPlans' ? PLANS : null));
    const node = await memberNode(seq.url, redeemed('PLAN-E2E-SILVER'));
    const r = await call(node, 'GET', '/plan/limits', undefined, await sessionOf(node));
    expect(r.status).toBe(200); // before: 404, no such route
    expect(r.json.data).toMatchObject({ name: 'Silver', deductibleAmountCents: 25000, oopMaxCents: 300000, annualBenefitMaxCents: 1000000 });
    expect(seq.seen.map((s) => s.method)).toEqual(['l2_getPlans']);
  });

  test('needs the device session', async () => {
    const seq = await fakeSequencer(() => PLANS);
    const node = await memberNode(seq.url, redeemed('PLAN-E2E-SILVER'));
    const r = await call(node, 'GET', '/plan/limits');
    expect(r.status).toBe(401);
    expect(seq.seen).toHaveLength(0);
  });

  test('a device with no redeemed plan, or one whose plan is not published, says so instead of guessing', async () => {
    const seq = await fakeSequencer(() => PLANS);
    const none = await memberNode(seq.url);
    const r = await call(none, 'GET', '/plan/limits', undefined, await sessionOf(none));
    expect(r.status).toBe(404);
    expect(r.json?.error).toMatch(/no redeemed plan/); // not the server's bare 'Not found'
    const unpublished = await memberNode(seq.url, redeemed('PLAN-NOT-PUBLISHED'));
    const u = await call(unpublished, 'GET', '/plan/limits', undefined, await sessionOf(unpublished));
    expect(u.status).toBe(404);
    expect(u.json?.error).toMatch(/not published/);
  });
});

describe('(5) /onboarding/recover, which the Restore screen now calls', () => {
  test('confirms the recovered wallet with its own signature, which the sequencer requires since D1', async () => {
    const enrollmentKey = randomBytes(32).toString('base64url');
    const identitySalt = randomBytes(32).toString('hex');
    const issued = issueRecoveryCards({ enrollmentKey, recoveryPin: '246813', identitySalt, groupIdHash: '7', planIdHash: '9', domainTag: 0 });
    const { publicKeyHex } = deriveWalletSigningKey(enrollmentKey);
    // The insurer releases the deposited share for the card.
    const insurerUrl = await service((raw) => {
      const dep = issued.deposits.find((d) => d.cardId === (JSON.parse(raw || '{}') as { cardId?: string }).cardId);
      return dep
        ? { status: 200, body: { ok: true, data: { share2Hex: dep.share2Hex, identitySalt, groupIdHash: '7', planIdHash: '9', domainTag: 0 } } }
        : { status: 404, body: { ok: false } };
    });
    // The sequencer answers a member's entry only to that wallet's own signature, as D1 does.
    const asked: string[] = [];
    const sequencerUrl = await service((raw, headers) => {
      const walletId = String((JSON.parse(raw || '{}') as { params?: { walletId?: string } }).params?.walletId ?? '');
      const verdict = verifySignedRequest({ method: 'POST', path: '/rpc', headers, expectedSignerId: walletId, publicKeyHex, body: raw });
      asked.push(verdict.ok ? 'signed by the wallet' : verdict.reason);
      return { status: 200, body: verdict.ok
        ? { jsonrpc: '2.0', id: 1, result: { walletId, type: 'member' } }
        : { jsonrpc: '2.0', id: 1, error: { code: -32001, message: 'Unauthorized' } } };
    });
    const node = await memberNode(sequencerUrl, { walletId: undefined, enrollmentKey: undefined, onboarding: { phase: 'awaiting_token' } }, { insurerUrl });
    const r = await call(node, 'POST', '/onboarding/recover', {
      card: issued.cards[0], recoveryPin: '246813',
      cardholderId: 'E2E-1', firstName: 'Avery', lastName: 'Quillfeather', dateOfBirth: '19870412',
    }, await sessionOf(node));
    expect(asked).toEqual(['signed by the wallet']); // before: 'the request is not signed', and the route answered 404
    expect(r.status).toBe(200);
    expect(r.json?.data?.phase).toBe('enrolled');
    expect(node.getOnboardingPhase()).toBe('enrolled');
    expect(node.walletSigner()?.signerId).toBe(r.json?.data?.walletId); // the device holds the recovered wallet
  });
});

describe('(7) the member /rpc proxy answers only the device itself', () => {
  const proxy: Partial<NautilusAppConfig> = { rpcProxy: { enabled: true, allowed: new Set(['l2_getClaimsByMember']) } };
  const claims = { jsonrpc: '2.0', id: 1, method: 'l2_getClaimsByMember', params: { walletId: WALLET } };

  test('a caller with no session is refused and nothing is signed or forwarded; the device itself still reads, as its wallet', async () => {
    const seq = await fakeSequencer(() => []);
    const node = await memberNode(seq.url, {}, proxy);
    expect(node.walletSigner()).not.toBeNull(); // unlocked, so before the fix it signed as the wallet for anyone

    const bare = await call(node, 'POST', '/rpc', claims);
    expect(bare.status).toBe(401); // before: 200, forwarded signed as the wallet
    expect(bare.json?.error?.code).toBe(-32001);
    expect((await call(node, 'POST', '/rpc', claims, { 'X-Device-Session': 'not-this-devices-session' })).status).toBe(401);
    expect((await call(node, 'POST', '/rpc', claims, { Authorization: 'Bearer not-the-admin' })).status).toBe(401);
    expect(seq.seen).toHaveLength(0);

    const own = await call(node, 'POST', '/rpc', claims, await sessionOf(node));
    expect(own.status).toBe(200);
    expect(seq.seen).toEqual([{ method: 'l2_getClaimsByMember', signer: WALLET }]);
    // The node's own admin credential opens it, as it opens every device-only route.
    expect((await call(node, 'POST', '/rpc', claims, bearer)).status).toBe(200);
    expect(seq.seen).toHaveLength(2);
  });
});
