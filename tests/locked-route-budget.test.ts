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
 * An engine route still waiting for the proving lock when its request budget runs out is answered 504 and changes
 * nothing; the NFC reader's event stream outlives the budget.
 *
 * What was wrong, found by the review of option A step 1, round two (docs/research/a22-option-a-spec.md, 2026-10-24):
 * every engine route that answers from a call it makes under the proving lock (terminate-member, update-rx-status,
 * prescribe, reverse, reset and the rest) could wait for the lock past its 180 s budget. The sequencer then answered 504
 * 'Request timeout', and nothing cancelled the handler, so the change was made when the lock came free, however much
 * later: its caller had been told it timed out, sent it again, and the change was made twice. Round two holds the lock
 * until its holder settles, so that wait no longer stops at five minutes. The same review found GET
 * /interactive/nfc/events, the NFC reader's stream the visualizer's engine registers, missing from the sequencer's list
 * of streams: the budget was armed on it, and once it ran out its writeHead(504) threw ERR_HTTP_HEADERS_SENT on the open
 * stream, out of a timer, where nothing caught it.
 *
 * What is true now: a request answered while it waits for the lock, by that 504 or because its caller went away, lets the
 * lock go as soon as it has it and changes nothing; the engine logs one line naming the route, and the 504 says the
 * request was dropped and may be sent again. A request whose work had started when its budget ran out finishes, as
 * before, an auto-tap round's later taps included, and its 504 says so. The NFC stream is one of the server's streams,
 * and the budget writes nothing over a response whose headers are out, whatever its path.
 *
 * A real sequencer server and chain node, whose proving lock the routes take, with a stand-in engine that records each
 * change it is asked to make, and a stand-in NFC reader. The server takes each route's budget from its registration, so
 * the engine's routes are registered here with a budget of BUDGET_MS in place of their 180 s, and the NFC stream, which
 * registers none, with the same, standing in for the 30 s default it met. A second server gives them a second, long
 * enough that a proof has surely begun when the budget runs out, and a third keeps the engine's own budgets, for a caller
 * that goes away long before its budget runs out. No compile, no proof.
 *
 * Run: npx jest tests/locked-route-budget.test.ts
 */
import fs from 'fs';
import http from 'http';
import { EventEmitter } from 'events';
import type { IncomingMessage, ServerResponse } from 'http';
import { Field, MerkleTree } from 'o1js';
import { InMemoryStore } from '../src/storage/local-store.js';
import { WALLET_TREE_HEIGHT } from '../src/wallets/wallet-state.js';
import { L2Node } from '../src/l2/l2-node.js';
import { L2RpcServer } from '../src/l2/l2-rpc-server.js';
import { registerInteractiveRoutes, TIMED_OUT_RUNNING_DETAIL, TIMED_OUT_WAITING_DETAIL } from '../src/adjudication/interactive-routes.js';
import type { NfcBridgeStatus, NfcTagEvent } from '../src/adjudication/nfc-port.js';
import type { BadgeTapEvent } from '../src/credentials/provider-badge-types.js';
import { generateNodeKey } from '../src/security/node-roles.js';
import { signRequest, privateKeyFromSeedHex } from '../src/security/signed-request.js';
import { deriveWalletSigningKey, walletSigner } from '../src/security/wallet-key.js';

jest.setTimeout(60_000);

/** Each engine route's request budget here, in place of the engine's 180 s (ENGINE_ROUTE_BUDGET_MS). */
const BUDGET_MS = 250;
/** The budget of the routes whose work must have begun when it runs out: a proof starts within milliseconds of its request. */
const STARTED_BUDGET_MS = 1_000;
const OPERATOR = 'operator-token-for-locked-route-budget';
const bearer = { Authorization: `Bearer ${OPERATOR}` };
const emptyRoot = new MerkleTree(WALLET_TREE_HEIGHT).getRoot();
const memberNode = generateNodeKey('member-node');
/** Alice's device: her wallet and the enrollment key her wallet's signing key derives from. */
const ALICE = '1001';
const ALICE_EK = 'ek-alice-' + 'c'.repeat(32);

const TERMINATE_MEMBER = '/interactive/terminate-member';
const BADGE_TAP = '/interactive/badge/tap';
const AUTO_TAP = '/interactive/badge/auto-tap';
const NFC_EVENTS = '/interactive/nfc/events';
const termination = { memberWalletId: ALICE, terminationDate: '20261031' };

/**
 * Every route that answers from an engine call it makes under the proving lock, with a body it accepts and who sends it:
 * the operator, Alice's own wallet (pcp-assignment takes only her signature), or anyone (verify-credential is open).
 */
const LOCKED_ROUTES: Array<{ route: string; body: Record<string, unknown>; as: 'operator' | 'alice' | 'anyone' }> = [
  { route: '/interactive/pcp-assignment', body: { walletId: ALICE, pcpWalletId: '2001', effectiveDate: '20261024' }, as: 'alice' },
  { route: '/interactive/approve-prior-auth', body: { priorAuthId: 'PA-BUDGET' }, as: 'operator' },
  { route: '/interactive/prescribe', body: { prescriberIndex: 0, memberWalletId: ALICE, ndcHash: '777', pharmacyIndex: 0 }, as: 'operator' },
  { route: '/interactive/update-rx-status', body: { prescriptionId: 'RX-BUDGET', newStatus: 'CANCELLED', role: 'prescriber', actorIndex: 0 }, as: 'operator' },
  { route: '/interactive/reverse', body: { prescriptionId: 'RX-BUDGET' }, as: 'operator' },
  { route: '/interactive/assign-pcp', body: { memberWalletId: ALICE, prescriberIndex: 0 }, as: 'operator' },
  { route: '/interactive/enroll-family', body: { subscriberIndex: 0 }, as: 'operator' },
  { route: TERMINATE_MEMBER, body: termination, as: 'operator' },
  { route: '/interactive/terminate-group', body: { groupId: 'ACME-CORP', terminationDate: '20261031' }, as: 'operator' },
  { route: '/interactive/send-message', body: { senderType: 'prescriber', recipientType: 'member', subject: 'Refill', body: 'Ready' }, as: 'operator' },
  { route: '/interactive/create-delegation', body: { delegatorWalletId: ALICE, delegateWalletId: '1002', scopeFlags: 1, relationshipCode: 1 }, as: 'operator' },
  { route: '/interactive/verify-credential', body: { credentialJson: '{"version":1}' }, as: 'anyone' },
  { route: '/interactive/update-formulary', body: { ndcHash: '777', action: 'MODIFY' }, as: 'operator' },
  { route: '/interactive/update-provider-network', body: { prescriberWalletId: '2001', action: 'ADD' }, as: 'operator' },
  { route: '/interactive/plan-year-rollover', body: { newPlanYear: '2027' }, as: 'operator' },
  { route: '/interactive/reset', body: {}, as: 'operator' },
  { route: BADGE_TAP, body: { providerType: 'prescriber', providerIndex: 0 }, as: 'operator' },
  { route: AUTO_TAP, body: { maxProviders: 2 }, as: 'operator' },
];

let node: L2Node;
/** The sequencer with the engine's routes under budgets of BUDGET_MS, and the NFC reader's routes. */
let server: L2RpcServer;
/** The sequencer with the engine's routes under budgets of STARTED_BUDGET_MS. */
let unhurried: L2RpcServer;
/** The sequencer with the engine's routes under the engine's own budgets. */
let patient: L2RpcServer;
const reader = new (class StandInReader extends EventEmitter {
  getStatus(): NfcBridgeStatus { return { state: 'polling', devicePath: null, tagUid: null, pendingWrite: null, error: null }; }
  async queueWrite(): Promise<void> { /* no tag is written here */ }
  cancelWrite(): void { /* nothing is queued to cancel */ }
})();

/** What the stand-in engine did, in order: each change a route asked it to make, and each badge proof's start and end. */
const events: string[] = [];
/** How many times a route asked the chain node for its proving lock. */
let lockRequests = 0;
/** While set, a badge tap's proof lasts until the test ends it (endTap); otherwise it ends at once. */
let holdTaps = false;
/** Ends the stand-in proof of a badge tap, by provider ('prescriber-0'). */
const tapProofs = new Map<string, () => void>();
/** Set as a test ends: from then on no stand-in proof waits. */
let ending = false;
/** Lets go of the proving lock the test holds, if it holds it. */
let releaseLock: (() => void) | null = null;
/** The replies a test sent for, so that no request outlives the test that sent it. */
const replies: Array<Promise<unknown>> = [];
/** The response each engine route is answering now, by 'METHOD path': what the sequencer sees of its caller. */
const responses = new Map<string, ServerResponse>();

let warn: jest.SpyInstance;

/** What the stand-in engine answers for a badge tap that proves and is issued a session. */
function badgeEvents(providerType: 'prescriber' | 'pharmacy', providerIndex: number): BadgeTapEvent[] {
  const tap = { providerType, providerIndex, displayName: `${providerType}-${providerIndex}`, timestamp: 0 };
  return [{ type: 'badge:proof', ...tap, data: { verified: true } }, { type: 'badge:session', ...tap }];
}

/** Only what the routes under test call; anything else throws, so a wider dependency shows up. */
function standInEngine() {
  const change = (name: string) => async (): Promise<unknown> => { events.push(name); return { changed: name }; };
  const own: Record<string, unknown> = {
    isProvingReady: () => true,
    // the sequencer's own chain node, as the engine's is, so the routes take its real proving lock
    getL2Node: () => ({ withProvingLock: <T>(fn: () => Promise<T>) => { lockRequests++; return node.withProvingLock(fn); } }),
    forceBatch: async () => null,
    assignPcpForDevice: change('assignPcpForDevice'),
    approvePriorAuth: change('approvePriorAuth'),
    createPrescription: change('createPrescription'),
    updateRxStatus: change('updateRxStatus'),
    reversePrescription: change('reversePrescription'),
    assignPcp: change('assignPcp'),
    enrollFamily: change('enrollFamily'),
    terminateMember: change('terminateMember'),
    terminateGroup: change('terminateGroup'),
    sendMessage: change('sendMessage'),
    createDelegation: change('createDelegation'),
    verifyCredential: change('verifyCredential'),
    updateFormularyEntry: change('updateFormularyEntry'),
    updateProviderNetwork: change('updateProviderNetwork'),
    planYearRollover: change('planYearRollover'),
    reset: () => { events.push('reset'); },
    simulateBadgeTap: async (providerType: 'prescriber' | 'pharmacy', providerIndex: number): Promise<BadgeTapEvent[]> => {
      const tap = `${providerType}-${providerIndex}`;
      events.push(`${tap} badge proof starts`);
      if (holdTaps) await new Promise<void>((resolve) => { tapProofs.set(tap, resolve); if (ending) resolve(); });
      events.push(`${tap} badge proof ends`);
      return badgeEvents(providerType, providerIndex);
    },
    // the engine's round as its autoTapSimulation runs it: each provider in turn, through this.simulateBadgeTap
    async autoTapSimulation(this: { simulateBadgeTap(type: 'prescriber', index: number): Promise<BadgeTapEvent[]> }, opts: { maxProviders?: number }) {
      const all: BadgeTapEvent[] = [];
      for (let i = 0; i < (opts.maxProviders ?? 1); i++) all.push(...await this.simulateBadgeTap('prescriber', i));
      return all;
    },
  };
  return new Proxy(own, {
    get(t, p) {
      if (p in t) return t[p as string];
      if (typeof p === 'string' && p !== 'then') throw new Error(`stand-in engine has no ${p}`);
      return undefined;
    },
  });
}

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;
type RouteOptions = Parameters<L2RpcServer['registerRoute']>[3];

/**
 * The sequencer as the engine registers its routes on it, each route's handler watched (responses). With budgetMs, every
 * route registered with a budget (the engine's write routes, at 180 s) gets budgetMs instead, and so does the NFC reader's
 * stream, which registers none and met the 30 s default.
 */
function registering(target: L2RpcServer, budgetMs?: number): L2RpcServer {
  return new Proxy(target, {
    get(t, p) {
      if (p === 'registerRoute') {
        return (method: string, path: string, handler: Handler, options?: RouteOptions) => {
          const watched: Handler = (req, res) => { responses.set(`${method} ${path}`, res); return handler(req, res); };
          const shortened = budgetMs !== undefined && (options?.timeoutMs || path === NFC_EVENTS) ? { ...options, timeoutMs: budgetMs } : options;
          t.registerRoute(method, path, watched, shortened);
        };
      }
      const v = Reflect.get(t, p);
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
}

type Reply = { status: number; json: any };

async function post(on: L2RpcServer, p: string, body: unknown, headers: Record<string, string>, signal?: AbortSignal): Promise<Reply> {
  const r = await fetch(`http://127.0.0.1:${on.getPort()}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal });
  const text = await r.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: r.status, json };
}

/** The headers of a locked route's request as its sender sends it. */
function headersFor(route: string, body: unknown, as: 'operator' | 'alice' | 'anyone'): Record<string, string> {
  if (as === 'operator') return bearer;
  if (as === 'anyone') return {};
  return signRequest({ ...walletSigner(ALICE_EK, ALICE), method: 'POST', path: route, body: JSON.stringify(body) });
}

/** Wait until done() holds, five seconds at most, letting the server and the stand-in engine run meanwhile. */
async function until(done: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!done() && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Take the proving lock as a fill's proof holds it, until the test lets it go (releaseLock). */
async function holdLock(): Promise<void> {
  let release: (() => void) | undefined;
  void node.withProvingLock(() => new Promise<void>((resolve) => { release = resolve; }));
  await until(() => release !== undefined);
  releaseLock = () => { releaseLock = null; release!(); };
}

/** Resolves once every locked operation queued so far has let go of the lock. */
const lockFree = () => node.withProvingLock(async () => undefined);

/**
 * Send a request to a locked route while the test holds the lock, and wait until the route has asked for the lock or
 * has answered; then wait for its answer.
 */
async function sendWhileLocked(on: L2RpcServer, p: string, body: unknown, headers: Record<string, string>): Promise<Reply> {
  const asked = lockRequests;
  let answered = false;
  const reply = post(on, p, body, headers).then((r) => { answered = true; return r; });
  replies.push(reply);
  await until(() => lockRequests > asked || answered);
  return reply;
}

/** End the stand-in proof of one badge tap, named by its provider ('prescriber-0'). */
function endTap(tap: string): void {
  const end = tapProofs.get(tap);
  expect([tap, end !== undefined]).toEqual([tap, true]);
  tapProofs.delete(tap);
  end!();
}

/** The lines the engine logged for requests it dropped at the lock. */
const drops = (): string[] => warn.mock.calls.map((c) => String(c[0])).filter((line) => line.includes('dropped without running'));

/**
 * Open an event stream on the sequencer as a browser's EventSource holds it: its status, and the event name of each frame
 * it has sent so far, in order.
 */
function openStream(p: string): Promise<{ status: number; frames: string[]; close: () => void }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: server.getPort(), path: p, headers: { Accept: 'text/event-stream' } }, (res) => {
      const frames: string[] = [];
      let buffered = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buffered += chunk;
        for (let end = buffered.indexOf('\n\n'); end >= 0; end = buffered.indexOf('\n\n')) {
          frames.push(/^event: (.*)$/m.exec(buffered.slice(0, end))?.[1] ?? buffered.slice(0, end));
          buffered = buffered.slice(end + 2);
        }
      });
      res.on('error', () => { /* the test closes the stream */ });
      resolve({ status: res.statusCode ?? 0, frames, close: () => req.destroy() });
    });
    req.on('error', reject);
  });
}

/**
 * Each status a response's writeHead is called with from now on; the call goes ahead as before. Called once a stream has
 * written its own head, it records the budget's attempts to write another: the one that threw ERR_HTTP_HEADERS_SENT out
 * of the budget's timer, an error Jest also fails the test for, since nothing caught it.
 */
function headsWrittenOn(res: ServerResponse): number[] {
  const heads: number[] = [];
  const writeHead = res.writeHead.bind(res) as (status: number, ...rest: unknown[]) => ServerResponse;
  res.writeHead = ((status: number, ...rest: unknown[]) => { heads.push(status); return writeHead(status, ...rest); }) as typeof res.writeHead;
  return heads;
}

beforeAll(async () => {
  node = new L2Node({ batchIntervalMs: 999_999, autoSettle: false, nodeId: 'seq-locked-route-budget' }, new InMemoryStore(), emptyRoot, emptyRoot, Field(0));
  server = new L2RpcServer(node, { port: 0, host: '127.0.0.1', adminToken: OPERATOR, enableSSE: false });
  server.registerNodeKey(memberNode.nodeId, memberNode.publicKeyHex, 'member');
  registerInteractiveRoutes(registering(server, BUDGET_MS), standInEngine() as any, reader);
  await server.start();
  unhurried = new L2RpcServer(node, { port: 0, host: '127.0.0.1', adminToken: OPERATOR, enableSSE: false });
  registerInteractiveRoutes(registering(unhurried, STARTED_BUDGET_MS), standInEngine() as any);
  await unhurried.start();
  patient = new L2RpcServer(node, { port: 0, host: '127.0.0.1', adminToken: OPERATOR, enableSSE: false });
  registerInteractiveRoutes(registering(patient), standInEngine() as any);
  await patient.start();
  // Alice's wallet signing key, registered as her member node registers it, so her device can sign pcp-assignment
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'l2_registerEntity', params: { walletId: ALICE, displayName: 'alice', type: 'member', signingPublicKeyHex: deriveWalletSigningKey(ALICE_EK).publicKeyHex } });
  const headers = signRequest({ signerId: memberNode.nodeId, privateKey: privateKeyFromSeedHex(memberNode.seedHex), method: 'POST', path: '/rpc', body });
  const registered = await (await fetch(`http://127.0.0.1:${server.getPort()}/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body })).json() as { error?: { message: string } };
  if (registered.error) throw new Error(`fixture registration failed: ${registered.error.message}`);
});

afterAll(async () => {
  await server.stop();
  await unhurried.stop();
  await patient.stop();
});

beforeEach(() => {
  events.length = 0;
  lockRequests = 0;
  holdTaps = false;
  ending = false;
  tapProofs.clear();
  responses.clear();
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  // a test that failed part way leaves the lock held, proofs running and requests open: let all of them finish
  ending = true;
  releaseLock?.();
  for (const end of tapProofs.values()) end();
  await lockFree();
  await Promise.allSettled(replies.splice(0));
  warn.mockRestore();
});

describe('a locked route still waiting for the proving lock when its budget runs out', () => {
  test('is answered 504, saying it was dropped, and never makes its change, even once the lock is free; the caller\'s retry makes it once', async () => {
    await holdLock();
    const first = await sendWhileLocked(server, TERMINATE_MEMBER, termination, bearer);
    expect(first.status).toBe(504);
    releaseLock!();
    await lockFree();
    expect(events).toEqual([]);                      // before: ['terminateMember']: made once the lock came free, after its caller was told it timed out
    expect(first.json).toStrictEqual({ error: 'Request timeout', detail: TIMED_OUT_WAITING_DETAIL }); // before: { error: 'Request timeout' } alone
    expect(drops()).toEqual([expect.stringContaining(`POST ${TERMINATE_MEMBER} dropped without running`)]); // before: [], nothing said
    const retry = await post(server, TERMINATE_MEMBER, termination, bearer);
    expect(retry).toEqual({ status: 200, json: { changed: 'terminateMember' } });
    expect(events).toEqual(['terminateMember']);     // before: ['terminateMember', 'terminateMember']: the retry made it a second time
  });

  test.each(LOCKED_ROUTES.map((r) => [r.route, r] as const))('%s drops the same way: 504, no change once the lock is free, one line naming it', async (route, r) => {
    await holdLock();
    const reply = await sendWhileLocked(server, route, r.body, headersFor(route, r.body, r.as));
    expect(reply.status).toBe(504);
    releaseLock!();
    await lockFree();
    expect(events).toEqual([]);                      // before: the route's change (a badge route's proof), made once the lock came free
    expect(reply.json).toStrictEqual({ error: 'Request timeout', detail: TIMED_OUT_WAITING_DETAIL }); // before: { error: 'Request timeout' } alone
    expect(drops()).toEqual([expect.stringContaining(`POST ${route} dropped without running`)]); // before: [], nothing said
  });

  test('a request whose caller goes away while it waits changes nothing once the lock is free, long before its budget', async () => {
    await holdLock();
    const asked = lockRequests;
    const caller = new AbortController();
    const reply = post(patient, TERMINATE_MEMBER, termination, bearer, caller.signal).then(() => 'answered', (err: { name?: string }) => err.name);
    replies.push(reply);
    await until(() => lockRequests > asked);
    caller.abort();
    expect(await reply).toBe('AbortError');
    await until(() => responses.get(`POST ${TERMINATE_MEMBER}`)?.destroyed === true);
    expect(responses.get(`POST ${TERMINATE_MEMBER}`)?.writableEnded).toBe(false); // nothing answered it: the engine's own budget is minutes
    releaseLock!();
    await lockFree();
    expect(events).toEqual([]);                      // before: ['terminateMember']: made for a caller that had gone
    expect(drops()).toEqual([expect.stringContaining(`POST ${TERMINATE_MEMBER} dropped without running: its caller went away`)]); // before: []
  });
});

describe('a locked route whose work had started when its budget ran out', () => {
  test('finishes, as before, and its 504 says the work goes on to finish', async () => {
    holdTaps = true;
    const reply = post(unhurried, BADGE_TAP, { providerType: 'pharmacy', providerIndex: 1 }, bearer);
    replies.push(reply);
    await until(() => events.includes('pharmacy-1 badge proof starts'));
    const answer = await reply;
    expect(answer.status).toBe(504);
    expect(answer.json).toStrictEqual({ error: 'Request timeout', detail: TIMED_OUT_RUNNING_DETAIL }); // before: { error: 'Request timeout' } alone
    endTap('pharmacy-1');
    await lockFree();
    expect(events).toEqual(['pharmacy-1 badge proof starts', 'pharmacy-1 badge proof ends']);
    expect(drops()).toEqual([]);
  });

  test('an auto-tap round answered 504 during its first tap still runs its next tap, which waits for the lock again', async () => {
    holdTaps = true;
    const reply = post(unhurried, AUTO_TAP, { maxProviders: 2 }, bearer);
    replies.push(reply);
    await until(() => events.includes('prescriber-0 badge proof starts'));
    const answer = await reply;
    expect(answer.status).toBe(504);
    expect(answer.json).toStrictEqual({ error: 'Request timeout', detail: TIMED_OUT_RUNNING_DETAIL }); // before: { error: 'Request timeout' } alone
    endTap('prescriber-0');
    await until(() => events.includes('prescriber-1 badge proof starts'));
    endTap('prescriber-1');
    await lockFree();
    expect(events).toEqual(['prescriber-0 badge proof starts', 'prescriber-0 badge proof ends', 'prescriber-1 badge proof starts', 'prescriber-1 badge proof ends']);
    expect(drops()).toEqual([]);
  });
});

describe('streams and the request budget', () => {
  test('the NFC reader\'s event stream outlives the budget: still open and sending, and nothing written over it', async () => {
    const stream = await openStream(NFC_EVENTS);
    await until(() => stream.frames.length === 1);
    const heads = headsWrittenOn(responses.get(`GET ${NFC_EVENTS}`)!);
    await sleep(BUDGET_MS * 3);
    const tag: NfcTagEvent = { type: 'tag:detected', uid: '04B1B2C3', timestamp: 2_000 };
    reader.emit('tag:detected', tag);
    await until(() => stream.frames.length === 2);
    stream.close();
    expect(stream.status).toBe(200);
    expect(stream.frames).toEqual(['nfc:status', 'nfc:tag_detected']);
    expect(heads).toEqual([]);                       // before: [504]: the budget wrote its head over the open stream, and writeHead threw ERR_HTTP_HEADERS_SENT out of its timer, uncaught
  });

  test('a stream on a path the server does not list is left to its handler when its budget runs out: nothing written over it', async () => {
    const held: { res?: ServerResponse } = {};
    server.registerRoute('GET', '/test/unlisted-stream', async (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('event: first\ndata: {}\n\n');
      held.res = res;
    }, { timeoutMs: BUDGET_MS });
    const stream = await openStream('/test/unlisted-stream');
    await until(() => stream.frames.length === 1);
    const heads = headsWrittenOn(held.res!);
    await sleep(BUDGET_MS * 3);
    held.res!.write('event: later\ndata: {}\n\n');
    await until(() => stream.frames.length === 2);
    stream.close();
    expect(stream.frames).toEqual(['first', 'later']);
    expect(heads).toEqual([]);                       // before: [504], whose writeHead threw ERR_HTTP_HEADERS_SENT out of the budget's timer, uncaught
  });
});

describe('in the code', () => {
  const lines = fs.readFileSync('src/adjudication/interactive-routes.ts', 'utf-8').replace(/\r\n/g, '\n').split('\n');

  /** Where a line of the routes file sits: the route it registers, the function it is in, or the reader event it handles. */
  function owner(i: number): string {
    for (let j = i; j >= 0; j--) {
      const route = /reg\('([A-Z]+)',\s*'([^']+)'/.exec(lines[j]);
      if (route) return `${route[1]} ${route[2]}`;
      const fn = /^\s*(?:async )?function (\w+)/.exec(lines[j]);
      if (fn) return `function ${fn[1]}`;
      const readerEvent = /nfcBridge\.on\('([^']+)'/.exec(lines[j]);
      if (readerEvent) return `reader ${readerEvent[1]}`;
    }
    return '(top)';
  }

  test('every route that answers from a locked engine call takes the lock through underProvingLock; only the background jobs and the reader take it directly', () => {
    const direct = new Map<string, string>();
    lines.forEach((line, i) => { if (line.includes('.withProvingLock(')) direct.set(owner(i), line); });
    const background = ['POST /interactive/enroll', 'POST /interactive/fill', 'POST /interactive/generate-credential', 'POST /interactive/prescribe-and-fill'];
    expect([...direct.keys()].sort()).toEqual([...background, 'function underProvingLock', 'reader tag:read'].sort()); // before: eighteen routes more, each taking the lock itself
    // a background job answers 202 and takes the lock afterwards: its handler does not wait for the lock
    for (const route of background) expect([route, /\bawait\b/.test(direct.get(route)!)]).toEqual([route, false]);
    const throughHelper = new Set<string>();
    lines.forEach((line, i) => { if (line.includes('underProvingLock(req, res,')) throughHelper.add(owner(i)); });
    expect([...throughHelper].sort()).toEqual(LOCKED_ROUTES.map((r) => `POST ${r.route}`).sort()); // before: [], no such helper
  });
});
