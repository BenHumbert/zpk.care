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
 * The pharmacy workstation fills a script only once it is adjudicated, and moves it to Filled only when the
 * engine says so (screen audit, pharmacy item 3).
 *
 * What was wrong: dashboard-pharmacy/app.js mapped a PENDING script (the prescriber's proofs still running) to
 * "adjudicated" and offered Fill; fillScript moved the card to Filled even when mark-filled failed, so a refused
 * fill looked done; and the node's /dispensing/mark-filled passed the engine's refusal on with no error, so the
 * screen could only say "HTTP 400". Now PENDING is its own status with no Fill, a refused fill stays in
 * Adjudicated and the toast gives the engine's reason, which the node now forwards as the error.
 *
 * The real functions are lifted out of app.js (one browser IIFE) and run in a vm with stubs for the page; the
 * node route runs with a fake node server whose engine answers are canned. No compile, no proof.
 */
import fs from 'fs';
import vm from 'vm';
import { buildPharmacyRoutes } from '../src/nodes/routes/pharmacy-routes.js';

const NL = String.fromCharCode(10);
const app = fs.readFileSync('dashboard-pharmacy/app.js', 'utf8').split(String.fromCharCode(13) + NL).join(NL);
const REFUSAL = 'Cannot fill prescription in FILLED status. Must be ADJUDICATED.';

/** A top-level function of the IIFE: from its declaration to the first line that is exactly two spaces and "}". */
function lift(name: string): string {
  let at = app.indexOf(NL + '  function ' + name + '(');
  if (at < 0) at = app.indexOf(NL + '  async function ' + name + '(');
  if (at < 0) throw new Error('app.js has no function ' + name);
  return app.slice(at + 1, app.indexOf(NL + '  }' + NL, at) + 4);
}

/** The lifted functions in a vm whose globals are the page stubs. */
function page(stubs: Record<string, unknown>, names: string[]) {
  const ctx: Record<string, any> = { console: { warn() {} }, scriptWorkflow: {}, renderWorkstationColumns: () => {}, toast: () => {}, ...stubs };
  vm.createContext(ctx);
  vm.runInContext(names.map(lift).join(NL), ctx);
  return ctx;
}

test('only the engine moves a script: a refused fill stays in Adjudicated and says why, an accepted one moves to Filled', async () => {
  const toasts: Array<[string, string]> = [];
  const refused = { prescriptionId: 'RX-1', status: 'ADJUDICATED' };
  const r = page({
    scriptKey: () => 'k',
    findClaimByKey: () => refused,
    toast: (m: string, t: string) => toasts.push([m, t]),
    API: { dispensing: { markFilled: () => Promise.reject(new Error(REFUSAL)) } },
  }, ['getScriptStatus', 'setScriptStatus', 'fillScript']);
  await r.fillScript('k');
  expect(r.getScriptStatus(refused)).toBe('adjudicated');
  expect(r.scriptWorkflow.k?._transientStatus).toBeUndefined(); // not left greyed out as "filling"
  expect(toasts).toEqual([['Fill failed: ' + REFUSAL, 'error']]);

  const accepted = { prescriptionId: 'RX-2', status: 'ADJUDICATED' };
  const a = page({
    scriptKey: () => 'k',
    findClaimByKey: () => accepted,
    API: { dispensing: { markFilled: async () => ({ status: 'FILLED' }) } },
  }, ['getScriptStatus', 'setScriptStatus', 'fillScript']);
  await a.fillScript('k');
  expect(a.getScriptStatus(accepted)).toBe('filled');
});

test('a PENDING script offers no Fill and cannot be filled; an ADJUDICATED one beside it can', async () => {
  const pending = { prescriptionId: 'RX-2', status: 'PENDING' };
  const ready = { prescriptionId: 'RX-3', status: 'ADJUDICATED' };
  const markFilled = jest.fn(async () => ({}));
  const p = page({
    scriptKey: (c: { prescriptionId: string }) => c.prescriptionId,
    findClaimByKey: (k: string) => [pending, ready].find((c) => c.prescriptionId === k),
    getScriptIssue: () => null, isScriptVerified: () => false, $: () => null,
    truncate: String, formatDate: String, formatCents: String, escapeHtml: String,
    API: { dispensing: { markFilled } },
  }, ['getScriptStatus', 'setScriptStatus', 'renderColumn', 'fillScript']);
  expect(p.getScriptStatus(pending)).toBe('pending');
  const column = { innerHTML: '' };
  p.renderColumn(column, [pending, ready], 'adjudicated');
  // One chunk per card: from its data-key to the next card's.
  const card = (key: string) => column.innerHTML.split('data-key="').find((h) => h.startsWith(key + '"')) ?? '';
  expect(card('RX-2')).not.toBe('');
  expect(card('RX-2')).not.toContain('App.fillScript');
  expect(card('RX-3')).toContain("App.fillScript('RX-3')");
  await p.fillScript('RX-2');
  expect(markFilled).not.toHaveBeenCalled();
  await p.fillScript('RX-3');
  expect(markFilled).toHaveBeenCalledTimes(1);
});

test('the node forwards the engine\'s refusal of a fill as the error, so the screen can say why', async () => {
  const sent: Array<{ status: number; ok: boolean; data?: unknown; error?: string }> = [];
  let engine = { status: 400, body: { error: REFUSAL } as Record<string, unknown> };
  const server = {
    getEntityNode: () => ({ getWalletId: () => '5002' }),
    getConfig: () => ({ sequencerUrl: 'http://seq.test' }),
    getLocalState: () => ({ hasEnrollmentKey: () => false }),
    signedFetch: async (u: string) => {
      if (!u.endsWith('/interactive/mark-filled')) throw new Error('unexpected engine call ' + u);
      return new Response(JSON.stringify(engine.body), { status: engine.status, headers: { 'Content-Type': 'application/json' } });
    },
    sendResponse(_res: unknown, status: number, ok: boolean, data?: unknown, error?: string) { sent.push({ status, ok, data, error }); },
  };
  const route = buildPharmacyRoutes(server as any).find((x) => x.method === 'POST' && x.path === '/dispensing/mark-filled')!;
  await route.handler({} as any, {} as any, {}, new URLSearchParams(), { prescriptionId: 'RX-1' });
  expect(sent[0]).toMatchObject({ status: 400, ok: false, error: REFUSAL });

  engine = { status: 200, body: { prescriptionId: 'RX-1', status: 'FILLED' } };
  await route.handler({} as any, {} as any, {}, new URLSearchParams(), { prescriptionId: 'RX-1' });
  expect(sent[1]).toMatchObject({ status: 200, ok: true, data: { status: 'FILLED' } });
  expect(sent[1].error).toBeUndefined();
});
