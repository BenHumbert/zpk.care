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
 * The engine routes that change what a fill reads and writes, or that prove beside it, wait for a fill that holds the
 * proving lock.
 *
 * What was wrong, found by the option A specification (docs/research/a22-option-a-spec.md, 2026-10-24, section 5.7):
 * POST /interactive/pcp-assignment, /interactive/terminate-member and /interactive/terminate-group changed a member's
 * forest or credential without the proving lock every fill holds. A fill reads the member's forest and credential before
 * its 25-45 s proof and writes them after it, so a primary-care choice made in between put a leaf the proof never saw
 * into the update the fill queued, and a termination made in between flipped revoked into the fill's credential, while
 * the fill overwrote the termination's cancellation of its prescription. The sweep of the engine's other routes for the
 * same gap found one more: POST /interactive/reset cleared the records a fill in flight goes on to write, so the fill
 * committed its claim and queued its wallet update for a member the engine no longer held.
 *
 * Now each of the four runs its engine call under the proving lock (option A, step 1): it waits for the fill, runs once
 * the fill's proof has finished, and answers as it did before, refusals included. A request refused for its body is still
 * answered at once. The engine calls taken under the lock take no lock themselves and start no batch, since the lock is
 * not re-entrant, which is checked against the code.
 *
 * The review of option A step 1 (2026-10-24) found four more by the same sweep. POST /interactive/update-rx-status wrote
 * a prescription's status without the lock: a fill reads the status before its proofs and writes its own after them
 * without reading it again, so a prescriber's cancellation recorded while the fill proved was overwritten with DISPENSED
 * or PARTIALLY_FILLED when the fill ended, and nobody was told. POST /interactive/badge/tap and /interactive/badge/auto-tap
 * made their ProofGate proofs without the lock, kept only from each other by a flag, and the NFC reader's handler
 * verified a tag's credential without it, though the verify-credential route takes it: an engine that proves inline ran
 * those beside a fill's proof in o1js's one context, which the lock exists to prevent.
 *
 * Now the status change waits for the fill and applies to the prescription as the fill left it, the engine's state rules
 * deciding: a cancellation of the prescription the fill dispensed is refused, and one of the prescription it left partly
 * filled stands. A badge tap and the reader's verification take the lock for their proof or verification, and an
 * auto-tap round takes it for each tap and lets it go before the next, so a fill waits for one tap at most, never the
 * whole round; the flag still answers a second badge request 429 at once. None of the engine calls made under the lock
 * takes it again, and the round proves only through the tap the route locks, both checked against the code.
 *
 * A real sequencer server and chain node, whose proving lock the routes take, with a stand-in engine whose dispense and
 * badge taps are proofs that last until the test ends them, and a stand-in NFC reader. No compile, no proof.
 */
import fs from 'fs';
import { EventEmitter } from 'events';
import type { IncomingMessage, ServerResponse } from 'http';
import { Field, MerkleTree } from 'o1js';
import { InMemoryStore } from '../src/storage/local-store.js';
import { WALLET_TREE_HEIGHT } from '../src/wallets/wallet-state.js';
import { L2Node } from '../src/l2/l2-node.js';
import { L2RpcServer } from '../src/l2/l2-rpc-server.js';
import { registerInteractiveRoutes } from '../src/adjudication/interactive-routes.js';
import { RegistrationRefused } from '../src/adjudication/interactive-service.js';
import type { NfcBridgeStatus, NfcTagEvent } from '../src/adjudication/nfc-port.js';
import type { BadgeTapEvent } from '../src/credentials/provider-badge-types.js';
import { isValidStatusTransition, RX_STATUS_CANCELLED, RX_STATUS_DISPENSED, RX_STATUS_FILLED, RX_STATUS_PARTIALLY_FILLED } from '../src/prescription/prescription-data.js';
import { generateNodeKey } from '../src/security/node-roles.js';
import { signRequest, privateKeyFromSeedHex } from '../src/security/signed-request.js';
import { deriveWalletSigningKey, walletSigner } from '../src/security/wallet-key.js';

jest.setTimeout(60_000);

const OPERATOR = 'operator-token-for-wallet-locks';
const bearer = { Authorization: `Bearer ${OPERATOR}` };
const emptyRoot = new MerkleTree(WALLET_TREE_HEIGHT).getRoot();
const memberNode = generateNodeKey('member-node');
/** Alice's device: her wallet and the enrollment key her wallet's signing key derives from. */
const ALICE = '1001';
const ALICE_EK = 'ek-alice-' + 'a'.repeat(32);
const DR_PRIMARY = '2001';
/** A wallet the stand-in engine refuses as a primary-care prescriber, and a member it does not know. */
const NOT_A_PRESCRIBER = '9999';
const UNKNOWN_MEMBER = '4040';
/** Alice's portable credential as the engine's state holds it, which the NFC reader's handler verifies for her tag. */
const ALICE_CREDENTIAL = JSON.stringify({ version: 1, proofType: 'holding' });
/** The engine's prescription status codes, in which its state rules (prescription-data's transitions) are written. */
const STATUS_CODE: Record<string, bigint> = {
  PARTIALLY_FILLED: RX_STATUS_PARTIALLY_FILLED.toBigInt(),
  FILLED: RX_STATUS_FILLED.toBigInt(),
  CANCELLED: RX_STATUS_CANCELLED.toBigInt(),
  DISPENSED: RX_STATUS_DISPENSED.toBigInt(),
};

const PCP = '/interactive/pcp-assignment';
const TERMINATE_MEMBER = '/interactive/terminate-member';
const TERMINATE_GROUP = '/interactive/terminate-group';
const RESET = '/interactive/reset';
const UPDATE_RX_STATUS = '/interactive/update-rx-status';
const BADGE_TAP = '/interactive/badge/tap';
const AUTO_TAP = '/interactive/badge/auto-tap';

let node: L2Node;
let server: L2RpcServer;
let url: string;

/** What the stand-in engine did, in order: the fill's proof starting and ending, and each engine call a route made. */
const events: string[] = [];
/** How many times a route asked the chain node for its proving lock. */
let lockRequests = 0;
/** Ends the stand-in fill's proof; until then the fill holds the proving lock. */
let endProof: (() => void) | null = null;
/** The replies a test sent for, so that no request outlives the test that sent it. */
const replies: Array<Promise<unknown>> = [];
/** Each prescription's status as the stand-in engine holds it: FILLED, ready to dispense, until something changes it. */
const rxStatus = new Map<string, string>();
/** Ends the stand-in proof of a badge tap, by provider ('prescriber-0'); until then the tap holds any lock it took. */
const tapProofs = new Map<string, () => void>();
/** Set as a test ends: from then on no stand-in proof waits, so nothing a failed test left running holds the lock. */
let ending = false;

/** What the stand-in engine answers for a badge tap that proves and is issued a session. */
function badgeEvents(providerType: 'prescriber' | 'pharmacy', providerIndex: number): BadgeTapEvent[] {
  const tap = { providerType, providerIndex, displayName: `${providerType}-${providerIndex}`, timestamp: 0 };
  return [{ type: 'badge:proof', ...tap, data: { verified: true } }, { type: 'badge:session', ...tap }];
}

/** Only what the routes under test call; anything else throws, so a wider dependency shows up. */
function standInEngine() {
  const own: Record<string, unknown> = {
    isProvingReady: () => true,
    getState: () => ({ compiled: true, enrolledMembers: [], members: [{ enrolled: { walletId: ALICE, lastCredentialJson: ALICE_CREDENTIAL } }] }),
    // the sequencer's own chain node, as the engine's is, so the routes take its real proving lock
    getL2Node: () => ({ withProvingLock: <T>(fn: () => Promise<T>) => { lockRequests++; return node.withProvingLock(fn); } }),
    dispensePrescription: async (opts: { prescriptionId: string; quantityDispensed?: number }) => {
      events.push('fill proof starts');
      await new Promise<void>((resolve) => { endProof = () => resolve(); if (ending) resolve(); });
      events.push('fill proof ends');
      // as the engine's dispense does, the status is written after the proof without being read again: a fill that names
      // a quantity dispenses part of the prescription, one that names none dispenses the rest
      rxStatus.set(opts.prescriptionId, opts.quantityDispensed === undefined ? 'DISPENSED' : 'PARTIALLY_FILLED');
      return { prescriptionId: opts.prescriptionId };
    },
    forceBatch: async () => null,
    assignPcpForDevice: async (opts: { walletId: string; pcpWalletId: string; effectiveDate: string }) => {
      events.push('assignPcpForDevice');
      if (opts.pcpWalletId === NOT_A_PRESCRIBER) throw new RegistrationRefused(404, 'The named wallet is not a credentialed prescriber');
      return { walletId: opts.walletId, pcpWalletId: opts.pcpWalletId, effectiveDate: opts.effectiveDate, commitment: '55', walletUpdate: { status: 'pending', updateId: 'wu-pcp', newInventoryRoot: '66' } };
    },
    terminateMember: (opts: { memberWalletId: string; terminationDate: string }) => {
      events.push('terminateMember');
      if (opts.memberWalletId === UNKNOWN_MEMBER) throw new Error(`Member not found: ${opts.memberWalletId}`);
      return { memberWalletId: opts.memberWalletId, lifecycle: 'REVOKED', terminationDate: opts.terminationDate, credentialRevoked: true, cancelledPrescriptions: [] };
    },
    terminateGroup: (opts: { groupId: string; terminationDate: string }) => {
      events.push('terminateGroup');
      return { groupId: opts.groupId, terminationDate: opts.terminationDate, terminatedCount: 1, members: [] };
    },
    reset: () => { events.push('reset'); },
    updateRxStatus: (opts: { prescriptionId: string; newStatus: string }) => {
      events.push('updateRxStatus');
      const from = rxStatus.get(opts.prescriptionId) ?? 'FILLED';
      // the engine's state rule, as its updateRxStatus applies it, and its refusal: a plain error, which the route answers 500
      if (!isValidStatusTransition(STATUS_CODE[from], STATUS_CODE[opts.newStatus])) throw new Error(`Invalid status transition: ${from} → ${opts.newStatus}`);
      rxStatus.set(opts.prescriptionId, opts.newStatus);
      return { prescriptionId: opts.prescriptionId, previousStatus: from, newStatus: opts.newStatus };
    },
    simulateBadgeTap: async (providerType: 'prescriber' | 'pharmacy', providerIndex: number): Promise<BadgeTapEvent[]> => {
      const tap = `${providerType}-${providerIndex}`;
      events.push(`${tap} badge proof starts`);
      await new Promise<void>((resolve) => { tapProofs.set(tap, resolve); if (ending) resolve(); });
      events.push(`${tap} badge proof ends`);
      return badgeEvents(providerType, providerIndex);
    },
    // the engine's round as its autoTapSimulation runs it: each provider in turn, through this.simulateBadgeTap
    async autoTapSimulation(this: { simulateBadgeTap(type: 'prescriber', index: number): Promise<BadgeTapEvent[]> }, opts: { maxProviders?: number }) {
      const all: BadgeTapEvent[] = [];
      for (let i = 0; i < (opts.maxProviders ?? 1); i++) all.push(...await this.simulateBadgeTap('prescriber', i));
      return all;
    },
    verifyCredential: async (credentialJson: string) => {
      events.push('verifyCredential');
      return { valid: true, walletId: ALICE, proofType: (JSON.parse(credentialJson) as { proofType: string }).proofType };
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

/** A stand-in NFC reader: the test raises its tag events, and it writes nothing. */
class StandInReader extends EventEmitter {
  getStatus(): NfcBridgeStatus { return { state: 'polling', devicePath: null, tagUid: null, pendingWrite: null, error: null }; }
  async queueWrite(): Promise<void> { /* no tag is written here */ }
  cancelWrite(): void { /* nothing is queued to cancel */ }
}

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

/**
 * The engine's routes registered with a stand-in NFC reader, as the console registers them with its USB one, and the
 * reader's event stream held open as a browser holds it: each event it sends, in order. The stream's handler is taken
 * from the registration itself, so no stream stays open on the sequencer; the reader's handler takes the same chain
 * node's proving lock as the server's routes.
 */
async function readerAndStream(): Promise<{ reader: StandInReader; sent: Array<{ event: string; data: any }> }> {
  const reader = new StandInReader();
  const routes = new Map<string, Handler>();
  const capture = { registerRoute: (method: string, p: string, handler: Handler) => { routes.set(`${method}:${p}`, handler); }, setMemberCostQuoteProvider: () => undefined };
  registerInteractiveRoutes(capture as any, standInEngine() as any, reader);
  const sent: Array<{ event: string; data: any }> = [];
  const stream = {
    writeHead: () => stream,
    write: (frame: string) => {
      const [, event, data] = /^event: (.*)\ndata: (.*)\n\n$/.exec(frame) ?? [];
      sent.push({ event, data: data === undefined ? frame : JSON.parse(data) });
      return true;
    },
    on: () => stream,
  };
  await routes.get('GET:/interactive/nfc/events')!({} as IncomingMessage, stream as unknown as ServerResponse);
  return { reader, sent };
}

type Reply = { status: number; json: any };

async function post(p: string, body: unknown, headers: Record<string, string>): Promise<Reply> {
  const r = await fetch(url + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const text = await r.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: r.status, json };
}

/** The headers of a request signed as Alice's wallet, the one signature pcp-assignment takes. */
const asAlice = (body: unknown) => signRequest({ ...walletSigner(ALICE_EK, ALICE), method: 'POST', path: PCP, body: JSON.stringify(body) });

/** Wait until done() holds, five seconds at most, letting the server and the stand-in engine run meanwhile. */
async function until(done: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!done() && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
}

/** Start a fill through its route and wait until its proof is under way: from then on the fill holds the proving lock. */
async function fillProving(prescriptionId: string, extra: Record<string, unknown> = {}): Promise<void> {
  const started = await post('/interactive/fill', { prescriptionId, ...extra }, bearer);
  expect(started.status).toBe(202);
  await until(() => events.includes('fill proof starts'));
  expect(events).toEqual(['fill proof starts']);
}

/**
 * Send a request while the fill proves. Returns once the route has asked for the proving lock, or has answered: a route
 * that takes no lock makes its engine call before it answers. A route whose engine call holds open until the test ends
 * it (a badge tap's proof) says when that call has started, which is how such a route is seen if it takes no lock.
 */
async function sendWhileProving(p: string, body: unknown, headers: Record<string, string>, started: () => boolean = () => false): Promise<{ answered: () => boolean; reply: Promise<Reply> }> {
  let answered = false;
  const asked = lockRequests;
  const reply = post(p, body, headers).then((r) => { answered = true; return r; });
  replies.push(reply);
  await until(() => lockRequests > asked || answered || started());
  return { answered: () => answered, reply };
}

/** End the stand-in proof of one badge tap, named by its provider ('prescriber-0'). */
function endTap(tap: string): void {
  const end = tapProofs.get(tap);
  expect([tap, end !== undefined]).toEqual([tap, true]);
  tapProofs.delete(tap);
  end!();
}

beforeAll(async () => {
  node = new L2Node({ batchIntervalMs: 999_999, autoSettle: false, nodeId: 'seq-wallet-locks' }, new InMemoryStore(), emptyRoot, emptyRoot, Field(0));
  server = new L2RpcServer(node, { port: 0, host: '127.0.0.1', adminToken: OPERATOR, enableSSE: false });
  server.registerNodeKey(memberNode.nodeId, memberNode.publicKeyHex, 'member');
  registerInteractiveRoutes(server, standInEngine() as any);
  await server.start();
  url = `http://127.0.0.1:${server.getPort()}`;
  // Alice's wallet signing key, registered as her member node registers it, so her device can sign pcp-assignment
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'l2_registerEntity', params: { walletId: ALICE, displayName: 'alice', type: 'member', signingPublicKeyHex: deriveWalletSigningKey(ALICE_EK).publicKeyHex } });
  const headers = signRequest({ signerId: memberNode.nodeId, privateKey: privateKeyFromSeedHex(memberNode.seedHex), method: 'POST', path: '/rpc', body });
  const registered = await (await fetch(`${url}/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body })).json() as { error?: { message: string } };
  if (registered.error) throw new Error(`fixture registration failed: ${registered.error.message}`);
});

afterAll(async () => { await server.stop(); });

beforeEach(() => {
  events.length = 0;
  lockRequests = 0;
  endProof = null;
  ending = false;
  rxStatus.clear();
  tapProofs.clear();
});

afterEach(async () => {
  // a test that failed part way leaves proofs running and its requests open: end every proof, let none that starts from
  // now on wait, and let every request finish before the next test starts
  ending = true;
  endProof?.();
  for (const end of tapProofs.values()) end();
  await node.withProvingLock(async () => undefined);
  await Promise.allSettled(replies.splice(0));
});

describe('while a fill holds the proving lock', () => {
  test('a primary-care choice waits for the fill, then runs and answers as before', async () => {
    const choice = { walletId: ALICE, pcpWalletId: DR_PRIMARY, effectiveDate: '20261024', specialty: 'Internal Medicine', consentScopeFlags: 7 };
    await fillProving('RX-LOCK-PCP');
    const sent = await sendWhileProving(PCP, choice, asAlice(choice));
    expect(events).toEqual(['fill proof starts']);   // before: ['fill proof starts', 'assignPcpForDevice']: the choice was written while the fill proved
    expect(sent.answered()).toBe(false);             // before: answered 200 while the fill was still proving
    endProof!();
    const r = await sent.reply;
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ walletId: ALICE, pcpWalletId: DR_PRIMARY, effectiveDate: '20261024', commitment: '55', walletUpdate: { status: 'pending', updateId: 'wu-pcp', newInventoryRoot: '66' } });
    expect(events).toEqual(['fill proof starts', 'fill proof ends', 'assignPcpForDevice']); // before: the choice came between the proof's start and its end
  });

  test('a termination waits for the fill, then runs and answers as before', async () => {
    await fillProving('RX-LOCK-TERMINATE');
    const sent = await sendWhileProving(TERMINATE_MEMBER, { memberWalletId: ALICE, terminationDate: '20261031' }, bearer);
    expect(events).toEqual(['fill proof starts']);   // before: ['fill proof starts', 'terminateMember']: the credential was revoked while the fill proved
    expect(sent.answered()).toBe(false);             // before: answered 200 while the fill was still proving
    endProof!();
    const r = await sent.reply;
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ memberWalletId: ALICE, lifecycle: 'REVOKED', terminationDate: '20261031', credentialRevoked: true, cancelledPrescriptions: [] });
    expect(events).toEqual(['fill proof starts', 'fill proof ends', 'terminateMember']); // before: the termination came between the proof's start and its end
  });

  test('a group termination waits for the fill, then runs and answers as before', async () => {
    await fillProving('RX-LOCK-GROUP');
    const sent = await sendWhileProving(TERMINATE_GROUP, { groupId: 'ACME-CORP', terminationDate: '20261031' }, bearer);
    expect(events).toEqual(['fill proof starts']);   // before: ['fill proof starts', 'terminateGroup']
    expect(sent.answered()).toBe(false);             // before: answered 200 while the fill was still proving
    endProof!();
    const r = await sent.reply;
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ groupId: 'ACME-CORP', terminationDate: '20261031', terminatedCount: 1, members: [] });
    expect(events).toEqual(['fill proof starts', 'fill proof ends', 'terminateGroup']); // before: the group termination came between the proof's start and its end
  });

  test('a session reset waits for the fill, then runs and answers as before', async () => {
    await fillProving('RX-LOCK-RESET');
    const sent = await sendWhileProving(RESET, {}, bearer);
    expect(events).toEqual(['fill proof starts']);   // before: ['fill proof starts', 'reset']: the records the fill goes on to write were cleared while it proved
    expect(sent.answered()).toBe(false);             // before: answered 200 while the fill was still proving
    endProof!();
    const r = await sent.reply;
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, message: 'Session reset. Ready for new enrollments.' });
    expect(events).toEqual(['fill proof starts', 'fill proof ends', 'reset']); // before: the reset came between the proof's start and its end
  });

  test('the engine\'s refusals wait for the fill too, and answer as before: a wallet that is no prescriber 404, an unknown member 500', async () => {
    const notADoctor = { walletId: ALICE, pcpWalletId: NOT_A_PRESCRIBER, effectiveDate: '20261025' };
    await fillProving('RX-LOCK-REFUSALS');
    const refusedChoice = await sendWhileProving(PCP, notADoctor, asAlice(notADoctor));
    const refusedTermination = await sendWhileProving(TERMINATE_MEMBER, { memberWalletId: UNKNOWN_MEMBER, terminationDate: '20261031' }, bearer);
    expect(events).toEqual(['fill proof starts']);   // before: ['fill proof starts', 'assignPcpForDevice', 'terminateMember']: each refusal ran at once, while the fill proved
    endProof!();
    const choice = await refusedChoice.reply;
    expect(choice.status).toBe(404);
    expect(choice.json).toEqual({ error: 'The named wallet is not a credentialed prescriber' });
    const termination = await refusedTermination.reply;
    expect(termination.status).toBe(500);
    expect(termination.json).toEqual({ error: `Member not found: ${UNKNOWN_MEMBER}` });
    expect(events).toEqual(['fill proof starts', 'fill proof ends', 'assignPcpForDevice', 'terminateMember']); // before: both ran while the fill proved
  });

  test('a request refused for its body is answered at once, and reaches neither the engine nor the lock', async () => {
    const noDate = { walletId: ALICE, pcpWalletId: DR_PRIMARY };
    await fillProving('RX-LOCK-BODY');
    for (const [p, body, headers, error] of [
      [PCP, noDate, asAlice(noDate), 'Missing effectiveDate'],
      [TERMINATE_MEMBER, {}, bearer, 'Missing required field: memberWalletId'],
      [TERMINATE_GROUP, {}, bearer, 'Missing required field: groupId'],
      [UPDATE_RX_STATUS, { prescriptionId: 'RX-LOCK-BODY', newStatus: 'CANCELLED', role: 'prescriber' }, bearer, 'Missing required fields: prescriptionId, newStatus, role, actorIndex'],
      [BADGE_TAP, { providerType: 'nurse', providerIndex: 0 }, bearer, 'providerType must be "prescriber" or "pharmacy"'],
    ] as Array<[string, unknown, Record<string, string>, string]>) {
      const r = await post(p, body, headers);
      expect([p, r.status, r.json]).toEqual([p, 400, { error }]);
    }
    expect(events).toEqual(['fill proof starts']);
    expect(lockRequests).toBe(1); // the fill's own
  });

  test('a cancellation waits for the fill, then the engine\'s state rules refuse it for the prescription the fill dispensed, where before it was taken and then overwritten', async () => {
    await fillProving('RX-LOCK-CANCEL');
    const cancel = { prescriptionId: 'RX-LOCK-CANCEL', newStatus: 'CANCELLED', role: 'prescriber', actorIndex: 0, note: 'Treatment changed' };
    const sent = await sendWhileProving(UPDATE_RX_STATUS, cancel, bearer);
    expect(events).toEqual(['fill proof starts']);   // before: ['fill proof starts', 'updateRxStatus']: the cancellation was written while the fill proved
    expect(sent.answered()).toBe(false);             // before: answered 200 while the fill was still proving
    endProof!();
    const r = await sent.reply;
    expect(r.status).toBe(500);                      // before: 200: the cancellation was taken from FILLED, then overwritten with DISPENSED when the fill ended
    expect(r.json).toEqual({ error: 'Invalid status transition: DISPENSED → CANCELLED' }); // before: { prescriptionId: 'RX-LOCK-CANCEL', previousStatus: 'FILLED', newStatus: 'CANCELLED' }, which the fill then made untrue
    expect(events).toEqual(['fill proof starts', 'fill proof ends', 'updateRxStatus']); // before: the cancellation came between the proof's start and its end
    expect(rxStatus.get('RX-LOCK-CANCEL')).toBe('DISPENSED');
  });

  test('a cancellation of a prescription the fill leaves partly filled waits for the fill, then stands: the fill no longer overwrites it', async () => {
    await fillProving('RX-LOCK-PARTIAL', { quantityDispensed: 10 });
    const cancel = { prescriptionId: 'RX-LOCK-PARTIAL', newStatus: 'CANCELLED', role: 'prescriber', actorIndex: 0 };
    const sent = await sendWhileProving(UPDATE_RX_STATUS, cancel, bearer);
    expect(events).toEqual(['fill proof starts']);   // before: ['fill proof starts', 'updateRxStatus']: the cancellation was written while the fill proved
    expect(sent.answered()).toBe(false);             // before: answered 200 while the fill was still proving
    endProof!();
    const r = await sent.reply;
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ prescriptionId: 'RX-LOCK-PARTIAL', previousStatus: 'PARTIALLY_FILLED', newStatus: 'CANCELLED' }); // before: previousStatus FILLED, the status the fill had not yet replaced
    expect(rxStatus.get('RX-LOCK-PARTIAL')).toBe('CANCELLED'); // before: PARTIALLY_FILLED: the fill overwrote the cancellation when its proof ended, and nobody was told
  });

  test('a badge tap waits for the fill, then proves and answers as before; another badge request meanwhile is answered 429 at once, as before', async () => {
    await fillProving('RX-LOCK-BADGE');
    const tap = await sendWhileProving(BADGE_TAP, { providerType: 'pharmacy', providerIndex: 2 }, bearer, () => events.includes('pharmacy-2 badge proof starts'));
    expect(events).toEqual(['fill proof starts']);   // before: ['fill proof starts', 'pharmacy-2 badge proof starts']: the badge's proof ran beside the fill's
    const another = await post(BADGE_TAP, { providerType: 'prescriber', providerIndex: 0 }, bearer);
    expect(another).toEqual({ status: 429, json: { error: 'Badge tap already in progress — please wait' } });
    endProof!();
    await until(() => events.includes('pharmacy-2 badge proof starts'));
    endTap('pharmacy-2');
    const r = await tap.reply;
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ authenticated: true, events: badgeEvents('pharmacy', 2) });
    expect(events).toEqual(['fill proof starts', 'fill proof ends', 'pharmacy-2 badge proof starts', 'pharmacy-2 badge proof ends']); // before: the badge's proof started before the fill's ended
    expect(lockRequests).toBe(2); // the fill's and the tap's   // before: 1, the fill's alone
  });

  test('an auto-tap round takes the lock for each tap and lets it go before the next: a fill sent during a tap runs before the next tap', async () => {
    await fillProving('RX-LOCK-ROUND');
    const round = await sendWhileProving(AUTO_TAP, { maxProviders: 2 }, bearer, () => events.includes('prescriber-0 badge proof starts'));
    expect(events).toEqual(['fill proof starts']);   // before: ['fill proof starts', 'prescriber-0 badge proof starts']: the round's first proof ran beside the fill's
    endProof!();
    await until(() => events.includes('prescriber-0 badge proof starts'));
    // a second fill, sent while the first tap proves, asks for the lock before the round asks for it again
    expect((await post('/interactive/fill', { prescriptionId: 'RX-LOCK-ROUND-2' }, bearer)).status).toBe(202);
    endTap('prescriber-0');
    await until(() => events.filter((e) => e === 'fill proof starts').length === 2);
    expect(events).toEqual(['fill proof starts', 'fill proof ends', 'prescriber-0 badge proof starts', 'prescriber-0 badge proof ends', 'fill proof starts']); // before: the first tap proved beside both fills: [fill starts, tap starts, fill ends, fill starts, tap ends]
    endProof!();
    await until(() => events.includes('prescriber-1 badge proof starts'));
    endTap('prescriber-1');
    const r = await round.reply;
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ summary: { totalProviders: 2, authenticated: 2, errors: 0, proofsGenerated: 2 }, events: [...badgeEvents('prescriber', 0), ...badgeEvents('prescriber', 1)] });
    const inTurn = ['fill proof starts', 'fill proof ends', 'prescriber-0 badge proof starts', 'prescriber-0 badge proof ends', 'fill proof starts', 'fill proof ends', 'prescriber-1 badge proof starts', 'prescriber-1 badge proof ends'];
    expect(events).toEqual(inTurn);                  // before: each tap's proof overlapped a fill's
    expect(lockRequests).toBe(4); // each fill's, and one for each tap   // before: 2, the fills' alone
  });

  test('a credential checked at the NFC reader is verified once the fill has finished, and reported on the reader\'s stream as before', async () => {
    const { reader, sent } = await readerAndStream();
    expect(sent.map((s) => s.event)).toEqual(['nfc:status']);
    await fillProving('RX-LOCK-NFC');
    const asked = lockRequests;
    const tag: NfcTagEvent = { type: 'tag:read', uid: '04A1B2C3', walletId: ALICE, timestamp: 1_000 };
    reader.emit('tag:read', tag);
    expect(lockRequests).toBe(asked + 1);            // before: unchanged: the reader's handler verified without asking for the lock
    expect(events).toEqual(['fill proof starts']);   // before: ['fill proof starts', 'verifyCredential']: the credential was verified while the fill proved
    endProof!();
    await until(() => sent.length === 2);
    expect(events).toEqual(['fill proof starts', 'fill proof ends', 'verifyCredential']); // before: the verification came between the proof's start and its end
    expect(sent[1]).toEqual({ event: 'nfc:tag_read', data: { ...tag, verified: true, verificationMethod: 'zk-proof', verification: { valid: true, walletId: ALICE, proofType: 'holding' } } });
  });
});

describe('the engine calls these routes make under the lock', () => {
  const lines = fs.readFileSync('src/adjudication/interactive-service.ts', 'utf-8').replace(/\r\n/g, '\n').split('\n');
  const decl = /^ {2}(?:private |public |protected )?(?:static )?(?:async )?([A-Za-z_]\w*)\s*(?:<[^>]*>)?\(/;
  const enclosing = (i: number): string | null => {
    for (let j = i; j >= 0; j--) {
      const m = lines[j].match(decl);
      if (m && !/^(if|for|while|switch|return|catch)$/.test(m[1])) return m[1];
    }
    return null;
  };

  /**
   * The engine methods with a line that matches the pattern, and every engine method that calls one of them, read from the
   * engine's code as the readiness suite finds the methods that prove.
   */
  function methodsReaching(pattern: RegExp): Set<string> {
    const reach = new Set<string>();
    lines.forEach((line, i) => {
      if (!pattern.test(line)) return;
      const method = enclosing(i);
      if (method) reach.add(method);
    });
    for (let grew = true; grew;) {
      grew = false;
      lines.forEach((line, i) => {
        for (const m of [...reach]) {
          if (!line.includes(`this.${m}(`)) continue;
          const caller = enclosing(i);
          if (caller && !reach.has(caller)) { reach.add(caller); grew = true; }
        }
      });
    }
    return reach;
  }

  /**
   * The engine methods that take the proving lock or wait on something that does: the lock itself, and a batch, which the
   * chain node proves under the same lock when it proves in process (L2Node.executeBatchCycle).
   */
  const lockTakingMethods = () => methodsReaching(/withProvingLock\(|acquireProvingLock\(|\.forceBatch\(|executeBatchCycle\(/);

  /** The body of one engine method: its lines up to the next method's declaration. */
  function methodBody(name: string): string {
    const start = lines.findIndex((line) => line.match(decl)?.[1] === name);
    expect([name, start >= 0]).toEqual([name, true]);
    let end = start + 1;
    while (end < lines.length && !decl.test(lines[end])) end++;
    return lines.slice(start, end).join('\n');
  }

  test('take no lock and start no batch themselves: the lock is not re-entrant, so a route would wait on itself', () => {
    const reach = lockTakingMethods();
    expect(reach.has('forceBatch')).toBe(true); // the search finds the engine's own batch trigger
    for (const m of ['assignPcpForDevice', 'terminateMember', 'terminateGroup', 'reset', 'updateRxStatus', 'simulateBadgeTap', 'autoTapSimulation', 'verifyCredential']) {
      expect([m, reach.has(m)]).toEqual([m, false]);
    }
  });

  test('the auto-tap round proves only through this.simulateBadgeTap, the call the route runs under the lock for each tap', () => {
    const proving = methodsReaching(/this\.dispatchProof\(/);
    expect(proving.has('simulateBadgeTap')).toBe(true); // the search finds the badge's proof
    const calls = [...methodBody('autoTapSimulation').matchAll(/this\.(\w+)\(/g)].map((m) => m[1]).filter((m) => proving.has(m));
    expect([...new Set(calls)]).toEqual(['simulateBadgeTap']);
  });
});
