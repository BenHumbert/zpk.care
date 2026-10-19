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
 * The pharmacy DUR tab presents the member's tap (screen audit, pharmacy item 2).
 *
 * What was wrong: since D1 the pharmacy node's DUR routes answer only a request that carries the member's
 * attestation in X-Member-Attestation, and dashboard-pharmacy/rpc.js sent none, so the DUR tab got 403 even
 * right after a verified scan. Now rpc.js keeps the attestation of the last scan the node verified, in page
 * memory only, and the three DUR patient reads present it for the wallet it names and for no other. A new scan
 * drops it first, so a scan the node does not verify leaves no tap behind.
 *
 * The real rpc.js runs in a bare vm context with a stub fetch, so the headers checked are the ones the page sends.
 */
import fs from 'fs';
import vm from 'vm';

const RPC_JS = 'dashboard-pharmacy/rpc.js';
const att = {
  v: 2, t: 'credential-attestation', w: '1001', cc: '1', ls: 3, fr: '2', ts: 1, exp: 4102444800,
  n: 'ab'.repeat(16), pk: 'cd'.repeat(32), sig: 'ef'.repeat(64),
};

type Call = { url: string; headers: Record<string, string> };
type Answer = { status?: number; data?: unknown; error?: string };

/** Load the page's rpc.js with a fetch that answers each URL with `answer(url)`, and record every request. */
function loadApi(answer: (url: string) => Answer) {
  const calls: Call[] = [];
  const stored: string[] = [];
  const storage = { setItem: (k: string) => { stored.push(k); }, getItem: () => null, removeItem: () => undefined };
  const context: Record<string, any> = {
    location: { origin: 'http://127.0.0.1:4003' },
    window: {},
    localStorage: storage,
    sessionStorage: storage,
    btoa: (s: string) => Buffer.from(s, 'binary').toString('base64'),
    fetch: async (url: string, init: { headers: Record<string, string> }) => {
      calls.push({ url, headers: init.headers });
      const a = answer(url);
      const status = a.status ?? 200;
      return { ok: status < 400, status, json: async () => (status < 400 ? { ok: true, data: a.data } : { ok: false, error: a.error }) };
    },
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(RPC_JS, 'utf8'), context);
  return { API: context.window.API, calls, stored };
}

/** The attestation a request presents, decoded, or null when it presents none. */
const tapOf = (c: Call | undefined) => {
  const raw = c?.headers['X-Member-Attestation'];
  return raw ? JSON.parse(Buffer.from(raw, 'base64').toString('utf8')) : null;
};
const lastTo = (calls: Call[], fragment: string) => [...calls].reverse().find((c) => c.url.includes(fragment));

test('after a verified scan, every DUR read for that member carries the attestation, and none of it is stored', async () => {
  const { API, calls, stored } = loadApi((u) => ({ data: u.endsWith('/nfc/scan') ? { walletId: '1001', attestationVerified: true } : [] }));
  await API.nfc.scan({ attestation: att });
  await API.dur.activeMedications('1001');
  await API.dur.fullHistory('1001');
  await API.dur.checkDuplicate('1001', '42');
  const dur = calls.filter((c) => c.url.includes('/dur/patient/1001/'));
  expect(dur.map((c) => c.url.split('/dur/patient/1001/')[1])).toEqual(['active-medications', 'full-history', 'check/42']);
  for (const c of dur) expect(tapOf(c)).toEqual(att);
  // Page memory only: nothing goes to browser storage, and the source has no storage call to send it there.
  expect(stored).toEqual([]);
  expect(fs.readFileSync(RPC_JS, 'utf8')).not.toMatch(/localStorage|sessionStorage/);
});

test('the tap goes only with reads for the wallet it names, and a later scan the node does not verify drops it', async () => {
  let scanAnswer: Answer = { data: { walletId: '1001', attestationVerified: true } };
  const { API, calls } = loadApi((u) => (u.endsWith('/nfc/scan') ? scanAnswer : { data: [] }));

  await API.dur.fullHistory('1001');
  expect(tapOf(lastTo(calls, '/dur/patient/1001/'))).toBeNull(); // no scan yet

  await API.nfc.scan({ attestation: att });
  await API.dur.fullHistory('1001');
  expect(tapOf(lastTo(calls, '/dur/patient/1001/'))).toEqual(att);
  await API.dur.fullHistory('2002');
  expect(tapOf(lastTo(calls, '/dur/patient/2002/'))).toBeNull(); // another member's history gets no tap

  scanAnswer = { data: { walletId: '1001' } }; // the node answered without verifying the attestation
  await API.nfc.scan({ attestation: att });
  await API.dur.fullHistory('1001');
  expect(tapOf(lastTo(calls, '/dur/patient/1001/'))).toBeNull();

  scanAnswer = { data: { walletId: '1001', attestationVerified: true } };
  await API.nfc.scan({ attestation: att });
  scanAnswer = { status: 403, error: 'Attestation verification failed: bad signature' }; // the node refused the next scan
  await expect(API.nfc.scan({ attestation: att })).rejects.toThrow(/Attestation verification failed/);
  await API.dur.checkDuplicate('1001', '42');
  expect(tapOf(lastTo(calls, '/dur/patient/1001/'))).toBeNull();
});
