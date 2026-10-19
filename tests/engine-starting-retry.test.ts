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
 * A provider node's proving job waits out the engine's start instead of failing.
 *
 * What was wrong: the prescriber node sent its prescription to the engine and failed the job on whatever came back. In
 * the single-member run of 2026-10-19 the engine's proof pool was still compiling, the request outlasted its budget,
 * and the job failed with "Request timeout" although the engine finished the prescription later. The engine now
 * answers a proving request 503 with Retry-After until it is ready to prove; the prescriber node's prescribe job and
 * the pharmacy node's dispense, fill and reversal jobs keep the job pending, wait the Retry-After and send the request
 * again (signed afresh), within an overall window of 10 minutes. Any other answer still fails the job at once.
 *
 * The retry itself with a fake clock; the nodes' route handlers with a fake node server and a scripted engine.
 */
import { jest } from '@jest/globals';
import { sendWhileEngineStarts, retryAfterMs, ENGINE_STARTING_WINDOW_MS, ENGINE_STARTING_DEFAULT_WAIT_MS } from '../src/nodes/sequencer-fetch.js';
import { buildPrescriberRoutes } from '../src/nodes/routes/prescriber-routes.js';
import { buildPharmacyRoutes } from '../src/nodes/routes/pharmacy-routes.js';
import { deriveEncryptionKeyPair } from '../src/messaging/encryption.js';

jest.setTimeout(60_000);

const STARTING = 'The claims engine is still starting its provers; try again shortly.';
const starting = (retryAfter: string | null = '1') =>
  new Response(JSON.stringify({ error: STARTING, retryAfterSeconds: 1 }), { status: 503, headers: { 'Content-Type': 'application/json', ...(retryAfter === null ? {} : { 'Retry-After': retryAfter }) } });
const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** A clock that moves only when the retry sleeps. */
function fakeTime() {
  let t = 1_000_000;
  const waits: number[] = [];
  return { waits, now: () => t, sleep: async (ms: number) => { waits.push(ms); t += ms; } };
}

describe('sendWhileEngineStarts', () => {
  test('waits the Retry-After the engine names and sends again until the engine answers', async () => {
    const time = fakeTime();
    const send = jest.fn<() => Promise<Response>>()
      .mockResolvedValueOnce(starting('10'))
      .mockResolvedValueOnce(starting('10'))
      .mockResolvedValueOnce(answer(200, { prescriptionId: 'RX-1' }));
    const onWait = jest.fn();
    const r = await sendWhileEngineStarts(send, { now: time.now, sleep: time.sleep, onWait });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ prescriptionId: 'RX-1' });
    expect(send).toHaveBeenCalledTimes(3); // a fresh request, signed afresh, each time
    expect(time.waits).toEqual([10_000, 10_000]);
    expect(onWait.mock.calls).toEqual([[10_000, 2], [10_000, 3]]);
  });

  test('any other answer comes back at once: a refusal or a failure still fails the job', async () => {
    for (const status of [400, 403, 409, 500, 502, 504]) {
      const time = fakeTime();
      const send = jest.fn<() => Promise<Response>>().mockResolvedValue(answer(status, { error: 'refused' }));
      const r = await sendWhileEngineStarts(send, { now: time.now, sleep: time.sleep });
      expect([status, r.status, send.mock.calls.length, time.waits]).toEqual([status, status, 1, []]);
    }
  });

  test('a request that cannot reach the engine throws at once', async () => {
    const time = fakeTime();
    const send = jest.fn<() => Promise<Response>>().mockRejectedValue(new Error('fetch failed'));
    await expect(sendWhileEngineStarts(send, { now: time.now, sleep: time.sleep })).rejects.toThrow('fetch failed');
    expect(send).toHaveBeenCalledTimes(1);
  });

  test('gives up when the next try would start after the window, and returns the engine\'s last 503', async () => {
    const time = fakeTime();
    const send = jest.fn<() => Promise<Response>>().mockImplementation(async () => starting('10'));
    const r = await sendWhileEngineStarts(send, { now: time.now, sleep: time.sleep, windowMs: 25_000 });
    expect(r.status).toBe(503);
    expect((await r.json()).error).toBe(STARTING);
    expect(send).toHaveBeenCalledTimes(3); // at 0 s, 10 s and 20 s; a fourth would start at 30 s
    expect(time.waits).toEqual([10_000, 10_000]);
  });

  test('the window is 10 minutes: a 503 that never ends is sent again for that long, and no longer', async () => {
    expect(ENGINE_STARTING_WINDOW_MS).toBe(10 * 60_000);
    const time = fakeTime();
    const send = jest.fn<() => Promise<Response>>().mockImplementation(async () => starting('10'));
    const r = await sendWhileEngineStarts(send, { now: time.now, sleep: time.sleep });
    expect(r.status).toBe(503);
    expect(send).toHaveBeenCalledTimes(61); // at 0, 10, ..., 600 s
    expect(time.waits.reduce((a, b) => a + b, 0)).toBe(600_000);
  });

  test('a 503 without a Retry-After waits the default; a zero waits a second, never a tight loop', async () => {
    const time = fakeTime();
    const send = jest.fn<() => Promise<Response>>()
      .mockResolvedValueOnce(starting(null))
      .mockResolvedValueOnce(starting('0'))
      .mockResolvedValueOnce(answer(202, { status: 'pending' }));
    expect((await sendWhileEngineStarts(send, { now: time.now, sleep: time.sleep })).status).toBe(202);
    expect(time.waits).toEqual([ENGINE_STARTING_DEFAULT_WAIT_MS, 1_000]);
  });

  test('reads a Retry-After as seconds or as an HTTP date', () => {
    expect(retryAfterMs('10')).toBe(10_000);
    expect(retryAfterMs(' 3 ')).toBe(3_000);
    expect(retryAfterMs(null)).toBeNull();
    expect(retryAfterMs('soon')).toBeNull();
    const now = Date.parse('2026-10-19T12:00:00Z');
    expect(retryAfterMs('Mon, 19 Oct 2026 12:00:30 GMT', now)).toBe(30_000);
    expect(retryAfterMs('Mon, 19 Oct 2026 11:59:00 GMT', now)).toBe(0);
  });
});

type Sent = { status: number; ok: boolean; data?: any; error?: string };
type Route = { method: string; path: string; handler: Function };

/** A node server reduced to what these handlers use; `engine` answers each call to the sequencer by its path. */
function fakeNodeServer(walletId: string, engine: (path: string, body: any) => Response | Promise<Response>) {
  const calls: Array<{ path: string; body: any }> = [];
  const sent: Sent[] = [];
  const recipientKey = deriveEncryptionKeyPair('recipient-of-the-escript').publicKey.toString('hex');
  const node = {
    getWalletId: () => walletId,
    storeMessage: jest.fn(async () => ({ index: 0 })),
    getClient: () => ({ getEncryptionKey: async () => ({ encryptionPublicKeyHex: recipientKey }) }),
    walletSigner: () => null,
  };
  const server = {
    getEntityNode: () => node,
    getConfig: () => ({ sequencerUrl: 'http://seq.test' }),
    getLocalState: () => ({ hasEnrollmentKey: () => true, useEnrollmentKey: (fn: (k: string) => unknown) => fn('prescriber-enrollment-key') }),
    signedFetch(u: string, init?: { body?: string }) {
      const path = new URL(u).pathname;
      const body = init?.body ? JSON.parse(init.body) : undefined;
      calls.push({ path, body });
      return Promise.resolve(engine(path, body));
    },
    sendResponse(_res: unknown, status: number, ok: boolean, data?: unknown, error?: string) { sent.push({ status, ok, data, error }); },
  };
  return { server, calls, sent };
}

async function call(routes: Route[], method: string, path: string, body?: unknown, query = new URLSearchParams()) {
  const route = routes.find((r) => r.method === method && r.path === path);
  if (!route) throw new Error(`no route ${method} ${path}`);
  await route.handler({}, {}, {}, query, body);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const callsTo = (calls: Array<{ path: string }>, path: string) => calls.filter((c) => c.path === path);

describe("the prescriber node's prescribe job", () => {
  const rxBody = { memberWalletId: '9001', pharmacyWalletId: '5002', ndcHash: '777', brandName: 'ABACAVIR', quantity: 30 };

  function prescriber(engineAnswers: Array<() => Response>) {
    let n = 0;
    const fake = fakeNodeServer('7001', (path) => {
      if (path === '/interactive/resolve-indices') return answer(200, { prescriberIndex: 0, pharmacyIndex: 0 });
      if (path === '/interactive/prescribe') return engineAnswers[Math.min(n++, engineAnswers.length - 1)]();
      return answer(500, { error: `unexpected ${path}` });
    });
    // the builder starts a PCP sync interval and timeout; fake timers keep them from holding the process open
    jest.useFakeTimers();
    let routes: Route[];
    try { routes = buildPrescriberRoutes(fake.server as any) as unknown as Route[]; } finally { jest.useRealTimers(); }
    return { ...fake, routes };
  }
  async function status(p: ReturnType<typeof prescriber>, jobKey: string) {
    const before = p.sent.length;
    await call(p.routes, 'GET', '/prescriptions/prescribe-status', undefined, new URLSearchParams({ jobKey }));
    return p.sent[before];
  }

  test('stays pending through the engine\'s 503, sends the same prescription again after the Retry-After, and completes', async () => {
    const p = prescriber([() => starting('1'), () => answer(200, { prescriptionId: 'RX-ENGINE' })]);
    await call(p.routes, 'POST', '/prescriptions/prescribe', rxBody);
    const accepted = p.sent[0];
    expect(accepted.status).toBe(202);
    await sleep(200);
    expect(callsTo(p.calls, '/interactive/prescribe')).toHaveLength(1);
    expect((await status(p, accepted.data.jobKey)).data.status).toBe('pending');
    await sleep(1_300);
    const sentToEngine = callsTo(p.calls, '/interactive/prescribe');
    expect(sentToEngine).toHaveLength(2);
    expect(sentToEngine[1].body).toEqual(sentToEngine[0].body);
    expect(sentToEngine[0].body).toMatchObject({ rxId: accepted.data.rxId, memberWalletId: '9001', ndcHash: '777' });
    const done = await status(p, accepted.data.jobKey);
    expect(done.data).toMatchObject({ status: 'complete', result: { prescriptionId: 'RX-ENGINE' } });
  });

  test('any other refusal fails the job at once, with the engine\'s words', async () => {
    const p = prescriber([() => answer(403, { error: 'This prescriber is not the member\'s primary-care prescriber' })]);
    await call(p.routes, 'POST', '/prescriptions/prescribe', rxBody);
    await sleep(200);
    expect(callsTo(p.calls, '/interactive/prescribe')).toHaveLength(1);
    const s = await status(p, p.sent[0].data.jobKey);
    expect(s.data).toMatchObject({ status: 'error', error: 'This prescriber is not the member\'s primary-care prescriber' });
  });
});

describe("the pharmacy node's dispense, fill and reversal jobs", () => {
  function pharmacy(script: Record<string, Array<() => Response>>) {
    const n: Record<string, number> = {};
    const fake = fakeNodeServer('5002', (path) => {
      if (path === '/interactive/resolve-indices') return answer(200, { prescriberIndex: 0, pharmacyIndex: 2 });
      const answers = script[path];
      if (!answers) return answer(500, { error: `unexpected ${path}` });
      const i = n[path] = (n[path] ?? -1) + 1;
      return answers[Math.min(i, answers.length - 1)]();
    });
    return { ...fake, routes: buildPharmacyRoutes(fake.server as any) as unknown as Route[] };
  }
  async function jobStatus(p: ReturnType<typeof pharmacy>, path: string, jobKey: string) {
    const before = p.sent.length;
    await call(p.routes, 'GET', path, undefined, new URLSearchParams({ jobKey }));
    return p.sent[before].data;
  }

  test('a dispense stays pending through the 503 and is sent again after the Retry-After', async () => {
    const p = pharmacy({ '/interactive/fill': [() => starting('1'), () => answer(200, { status: 'complete', adjudication: { patientPayCents: 1500 } })] });
    await call(p.routes, 'POST', '/dispensing/dispense', { prescriptionId: 'RX-1', quantityDispensed: 30 });
    const { jobKey } = p.sent[0].data;
    await sleep(200);
    expect(callsTo(p.calls, '/interactive/fill')).toHaveLength(1);
    expect((await jobStatus(p, '/dispensing/fill-status', jobKey)).status).toBe('pending');
    await sleep(1_300);
    const sentToEngine = callsTo(p.calls, '/interactive/fill');
    expect(sentToEngine).toHaveLength(2);
    expect(sentToEngine[1].body).toEqual(sentToEngine[0].body);
    expect(await jobStatus(p, '/dispensing/fill-status', jobKey)).toMatchObject({ status: 'complete', result: { adjudication: { patientPayCents: 1500 } } });
  });

  test('a fill (prescribe and fill) stays pending through the 503, is sent again, and then follows its job to the end', async () => {
    const p = pharmacy({
      '/interactive/prescribe-and-fill': [() => starting('1'), () => answer(202, { status: 'pending', prescriptionId: 'pf_job' })],
      '/interactive/fill-status': [() => answer(200, { status: 'complete', result: { adjudication: { patientPayCents: 1500 } } })],
    });
    await call(p.routes, 'POST', '/dispensing/fill', { memberWalletId: '9001', ndcHash: '777', prescriberWalletId: '7001', quantity: 30 });
    const { jobKey } = p.sent[0].data;
    await sleep(200);
    expect(callsTo(p.calls, '/interactive/prescribe-and-fill')).toHaveLength(1);
    expect((await jobStatus(p, '/dispensing/fill-status', jobKey)).status).toBe('pending');
    await sleep(1_300);
    expect(callsTo(p.calls, '/interactive/prescribe-and-fill')).toHaveLength(2);
    expect((await jobStatus(p, '/dispensing/fill-status', jobKey)).status).toBe('pending'); // now following the engine's job
    await sleep(3_300);
    expect(await jobStatus(p, '/dispensing/fill-status', jobKey)).toMatchObject({ status: 'complete' });
  });

  test('a reversal proves too, and waits out the 503 the same way', async () => {
    const p = pharmacy({ '/interactive/reverse': [() => starting('1'), () => answer(200, { reversed: true })] });
    await call(p.routes, 'POST', '/dispensing/reverse', { prescriptionId: 'RX-1', reason: 'Entered in error' });
    const { jobKey } = p.sent[0].data;
    await sleep(200);
    expect((await jobStatus(p, '/dispensing/reverse-status', jobKey)).status).toBe('pending');
    await sleep(1_300);
    expect(callsTo(p.calls, '/interactive/reverse')).toHaveLength(2);
    expect(await jobStatus(p, '/dispensing/reverse-status', jobKey)).toMatchObject({ status: 'complete', result: { reversed: true } });
  });

  test('any other answer fails the job at once', async () => {
    const p = pharmacy({
      '/interactive/fill': [() => answer(500, { error: 'Prescription not found: RX-404' })],
      '/interactive/prescribe-and-fill': [() => answer(409, { error: 'The pharmacy does not set the price' })],
    });
    await call(p.routes, 'POST', '/dispensing/dispense', { prescriptionId: 'RX-404' });
    await call(p.routes, 'POST', '/dispensing/fill', { memberWalletId: '9001', ndcHash: '777', prescriberWalletId: '7001' });
    await sleep(200);
    expect(callsTo(p.calls, '/interactive/fill')).toHaveLength(1);
    expect(callsTo(p.calls, '/interactive/prescribe-and-fill')).toHaveLength(1);
    expect(await jobStatus(p, '/dispensing/fill-status', p.sent[0].data.jobKey)).toMatchObject({ status: 'error', error: 'Prescription not found: RX-404' });
    expect(await jobStatus(p, '/dispensing/fill-status', p.sent[1].data.jobKey)).toMatchObject({ status: 'error', error: 'The pharmacy does not set the price' });
  });
});
