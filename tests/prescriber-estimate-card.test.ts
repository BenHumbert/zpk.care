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
 * The prescriber's estimate card shows the selected patient's own price and the drug's availability on her plan, and
 * starts the prior authorization her plan requires (owner decision 2026-10-19).
 *
 * What was wrong: the card showed the member's share only with her tapped attestation, and otherwise the ingredient and
 * "Needs the member's tap"; it said nothing about prior authorization, step therapy or the limit per fill, so a drug
 * that needs a prior authorization was found out at prescribing; and the page sent no credential, so once the node's
 * /estimate-cost asks for its admin token the card could show no patient's price at all.
 *
 * Now the page holds this node's admin token in memory only, typed on the Onboarding tab and sent as a bearer on the
 * calls that need it (tests/pa-review-screens.test.ts: never in browser storage), the card shows what she pays and
 * what the plan pays, the phase, NADAC x quantity
 * with the unit and the fee, and a coverage line, with "Request prior authorization" and then the status when her plan
 * requires one. A missing token and a refused consent each say so.
 *
 * The dashboard is a plain browser script: functions are lifted out of app.js and run with stubs, and rpc.js is run
 * with a stand-in fetch and localStorage, as in tests/insurer-cost-estimator.test.ts.
 */
import fs from 'fs';

const NL = '\n';
const read = (file: string): string => fs.readFileSync(file, 'utf8').replace(/\r\n/g, NL);
const APP = read('dashboard-prescriber/app.js');
const HTML = read('dashboard-prescriber/index.html');
const RPC = read('dashboard-prescriber/rpc.js');

function lift(src: string, name: string): string {
  let at = src.indexOf(NL + '  function ' + name + '(');
  if (at < 0) at = src.indexOf(NL + '  async function ' + name + '(');
  if (at < 0) throw new Error('no function ' + name);
  const end = src.indexOf(NL + '  }' + NL, at);
  return src.slice(at + 1, end + 4);
}
/** A top-level `var NAME = ...;` of the page, one line or an object literal closed by `  };`. */
function liftVar(src: string, name: string): string {
  const at = src.indexOf(NL + '  var ' + name + ' = ');
  if (at < 0) throw new Error('no var ' + name);
  const lineEnd = src.indexOf(NL, at + 1);
  const firstLine = src.slice(at + 1, lineEnd);
  if (firstLine.trimEnd().endsWith(';')) return firstLine;
  const end = src.indexOf(NL + '  };' + NL, at);
  return src.slice(at + 1, end + 5);
}
const escHtml = (s: unknown): string => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const CARD_FUNCTIONS = ['parseQuantity', 'memberPaysLabel', 'coverageLine', 'priorAuthBlock', 'estimateCardHtml', 'updateCostEstimate',
  'bindPriorAuthControls', 'showPriorAuthStatus', 'requestPriorAuthFromCard', 'refreshPriorAuthStatus'];
const CARD_VARS = ['QUANTITY_RULE', 'PHASE_LABELS', 'PA_LABELS', 'estimateContext', 'estimateSeq'];

/** The card's code with a stand-in page: the form's fields, the card element, the API and the toasts. */
function page(fields: Record<string, string>, api: Record<string, (...a: any[]) => Promise<unknown>>) {
  const els: Record<string, any> = {};
  const el = (id: string) => (els[id] = els[id] ?? { id, value: fields[id] ?? '', innerHTML: '', dataset: {}, outerHTML: '', listeners: {} as Record<string, () => unknown>,
    addEventListener(type: string, fn: () => unknown) { this.listeners[type] = fn; }, trim() { return this.value; } });
  for (const id of Object.keys(fields)) el(id);
  el('rx-cost-estimate');
  const document = {
    getElementById: (id: string) => (id in els ? els[id] : null),
    createElement: () => el('created'),
  };
  const toasts: Array<[string, string]> = [];
  const units: string[] = [];
  const code = [...CARD_VARS.map((n) => liftVar(APP, n)), ...CARD_FUNCTIONS.map((n) => lift(APP, n))].join(NL);
  const names = ['document', '$', 'esc', 'errMsg', 'toast', 'API', 'selectedPricingUnit', 'showQuantityUnit'];
  const scope = [
    document, (sel: string) => (sel.startsWith('#') && sel.slice(1) in els ? els[sel.slice(1)] : null), escHtml,
    (e: any) => (e && e.message) || String(e), (m: string, t: string) => { toasts.push([m, t]); }, api,
    () => '', (u: string) => { units.push(u); },
  ];
  const fns = new Function(...names, `'use strict';\n${code}\nreturn { ${CARD_FUNCTIONS.join(', ')}, context: () => estimateContext };`)(...scope);
  return { fns, els, toasts, units, card: els['rx-cost-estimate'] };
}

const WALLET = '79000000000000000001';
const ALLOPURINOL_HASH = '1111';
const PA_HASH = '2222';
// l2_estimateCost for the walkthrough's member, through the prescriber node: Standard Rx 2026 ($10 copay, $13.00 fee,
// $500 deductible not yet met), ALLOPURINOL 100 MG x 30 EA at NADAC $0.0394/EA
const VIDEO_QUOTE = {
  covered: true, drugName: 'ALLOPURINOL', ndcHash: ALLOPURINOL_HASH, classification: 'G', nadacPerUnit: 0.0394, pricingUnit: 'EA', quantity: 30,
  tierLevel: 1, ingredientCostCents: 118, dispensingFeeCents: 1300, dispensingFeeSource: 'plan', totalCostCents: 1418,
  copayAmountCents: 1000, copayBasis: 'plan', phase: 'deductible', memberPayCents: 1418, employerPayCents: 0,
  priorAuthRequired: false, stepTherapyRequired: false, maxQuantityPerFill: 90,
};
const PA_QUOTE = {
  ...VIDEO_QUOTE, drugName: 'ABILIFY MAINTENA ER', ndcHash: PA_HASH, nadacPerUnit: 2386.15, ingredientCostCents: 7158450, totalCostCents: 7159750,
  tierLevel: 4, memberPayCents: 49000, employerPayCents: 7110750, priorAuthRequired: true, stepTherapyRequired: true, maxQuantityPerFill: 30,
  priorAuth: { status: 'none' },
};
const LIST_PRICE = { ...VIDEO_QUOTE, copayBasis: 'tier', dispensingFeeCents: 1000, dispensingFeeSource: 'network-default', totalCostCents: 1118, priorAuthRequired: undefined, stepTherapyRequired: undefined, maxQuantityPerFill: undefined };
const fields = (ndc: string, patient = WALLET, qty = '30') => ({ 'rx-med-select': ndc, 'rx-ndc-manual': '', 'rx-patient-select': patient, 'rx-quantity': qty });
const refusal = (status: number, message: string) => Object.assign(new Error(message), { status });

describe('the estimate card for a patient whose plan covers the drug with no prior authorization, in her deductible', () => {
  test('shows what she pays and what the plan pays, the phase, NADAC x quantity with the unit, the fee and the coverage line', async () => {
    const asked: any[] = [];
    const p = page(fields(ALLOPURINOL_HASH), { estimateCost: async (q: any) => { asked.push(q); return VIDEO_QUOTE; } });
    await p.fns.updateCostEstimate();
    expect(asked).toEqual([{ ndcHash: ALLOPURINOL_HASH, walletId: WALLET, quantity: 30 }]);
    expect(p.card.dataset.state).toBe('member');
    const html = String(p.card.innerHTML);
    expect(html).toContain('Cost Estimate — ALLOPURINOL');
    expect(html).toContain('id="rx-est-member-pays" data-cents="1418"');
    expect(html).toMatch(/id="rx-est-member-pays"[^>]*>\$14\.18</);
    expect(html).toMatch(/id="rx-est-phase" data-phase="deductible"[^>]*>Deductible phase</);
    expect(html).toMatch(/id="rx-est-plan-pays" data-cents="0"[^>]*>\$0\.00</);
    expect(html).toContain('Ingredient (NADAC)');
    expect(html).toMatch(/id="rx-est-ingredient"[^>]*>\$1\.18</);
    expect(html).toContain('$0.03940/EA x 30 EA');
    expect(html).toContain('Total: $14.18 (ingredient $1.18 + dispensing fee <span id="rx-est-fee" data-cents="1300">$13.00</span>, the plan\'s)');
    expect(html).toContain('id="rx-est-coverage" class="rx-coverage" data-covered="true" data-prior-auth="not-required" data-step-therapy="not-required"');
    for (const item of ['Covered on the patient\'s plan', 'No prior authorization', 'No step therapy', 'Limit 90 EA per fill']) expect(html).toContain(item);
    expect(html).not.toContain('id="rx-pa"');             // no prior-authorization row for a drug that needs none
    expect(html).not.toContain('Needs the member\'s tap'); // before: the card asked for the tap
    expect(p.fns.context()).toEqual({ walletId: WALLET, ndcHash: ALLOPURINOL_HASH, quantity: 30 });
  });

  test('a quantity over the plan\'s limit per fill is flagged on the coverage line', () => {
    const p = page({}, {});
    const html = p.fns.coverageLine({ ...VIDEO_QUOTE }, 120);
    expect(html).toContain('class="rx-coverage-item bad" id="rx-est-limit">Limit 90 EA per fill: 120 EA is over it');
  });

  test('a quote that does not report the plan\'s rules is shown as covered and never as needing no prior authorization', () => {
    const p = page({}, {});
    const html = p.fns.coverageLine({ covered: true, pricingUnit: 'EA' }, 30);
    expect(html).toContain('data-prior-auth="unknown" data-step-therapy="unknown"');
    expect(html).toContain('Covered on the patient\'s plan');
    expect(html).not.toContain('No prior authorization');
    expect(html).not.toContain('No step therapy');
  });
});

describe('a drug her plan requires prior authorization for', () => {
  test('says so before the script is written, with a button to request it; then pending, approved through its date, or denied with the button again', () => {
    const p = page({}, {});
    const none = p.fns.estimateCardHtml(PA_QUOTE, WALLET, null, 30).html;
    expect(none).toContain('data-prior-auth="required" data-step-therapy="required"');
    expect(none).toContain('Prior authorization required');
    expect(none).toContain('Step therapy required');
    expect(none).toContain('Limit 30 EA per fill');
    expect(none).toContain('<div id="rx-pa" class="rx-pa" data-pa-status="none">');
    expect(none).toContain('<button class="btn btn-sm btn-primary" id="rx-pa-request-btn">Request prior authorization</button>');
    const pending = p.fns.priorAuthBlock({ status: 'pending', requestedAt: 1 });
    expect(pending).toContain('data-pa-status="pending"');
    expect(pending).toContain('>Pending with the insurer<');
    expect(pending).not.toContain('rx-pa-request-btn');
    expect(pending).toContain('id="rx-pa-refresh-btn"');
    expect(p.fns.priorAuthBlock({ status: 'approved', expiresOn: '2027-02-01' })).toContain('>Approved through 2027-02-01<');
    expect(p.fns.priorAuthBlock({ status: 'denied' })).toContain('id="rx-pa-request-btn"');
  });

  test('the button asks this node for the patient and drug the card shows, with the reason typed, and the row turns pending', async () => {
    const sent: any[] = [];
    const p = page({ ...fields(PA_HASH), 'rx-pa-reason': '  Oral therapy failed  ' }, {
      estimateCost: async () => PA_QUOTE,
      requestPriorAuth: async (b: any) => { sent.push(b); return { status: 'pending', requestedAt: 5 }; },
    });
    await p.fns.updateCostEstimate();
    expect(p.card.dataset.state).toBe('member');
    p.els['rx-pa'] = { outerHTML: '' };
    p.els['rx-pa-request-btn'] = { disabled: false, textContent: '', addEventListener() {} };
    await p.fns.requestPriorAuthFromCard();
    expect(sent).toEqual([{ walletId: WALLET, ndcHash: PA_HASH, quantity: 30, reason: 'Oral therapy failed' }]);
    expect(p.els['rx-pa'].outerHTML).toContain('data-pa-status="pending"');
    expect(p.toasts[0]).toEqual(['Prior authorization requested: pending with the insurer', 'success']);
  });

  test('a refused request says why and leaves the button usable', async () => {
    const p = page(fields(PA_HASH), {
      estimateCost: async () => PA_QUOTE,
      requestPriorAuth: async () => { throw refusal(409, 'A prior authorization for ABILIFY MAINTENA ER is already pending for this member'); },
    });
    await p.fns.updateCostEstimate();
    p.els['rx-pa-request-btn'] = { disabled: false, textContent: '', addEventListener() {} };
    await p.fns.requestPriorAuthFromCard();
    expect(p.toasts[0]).toEqual(['Prior authorization not requested: A prior authorization for ABILIFY MAINTENA ER is already pending for this member', 'error']);
    expect(p.els['rx-pa-request-btn']).toMatchObject({ disabled: false, textContent: 'Request prior authorization' });
  });
});

describe('when the patient\'s price is not given', () => {
  test('a drug not on her plan says so before the script is written', async () => {
    const p = page(fields('3333'), { estimateCost: async () => ({ covered: false, drugName: 'ABACAVIR-LAMIVUDINE', pricingUnit: 'EA', quantity: 30, phase: 'not-covered', reason: "Not on the formulary of the member's plan" }) });
    await p.fns.updateCostEstimate();
    expect(p.card.dataset.state).toBe('not-covered');
    expect(p.card.innerHTML).toContain('data-covered="false"');
    expect(p.card.innerHTML).toContain("Not covered on the patient's plan: Not on the formulary of the member's plan");
  });

  test('no admin token: the ingredient with no patient, and the card says the node\'s token is needed', async () => {
    const asked: any[] = [];
    const p = page(fields(ALLOPURINOL_HASH), {
      estimateCost: async (q: any) => { asked.push(q); if (q.walletId) throw refusal(401, "A patient's own price answers this node's administrator: send this node's admin token"); return LIST_PRICE; },
    });
    await p.fns.updateCostEstimate();
    expect(asked).toEqual([{ ndcHash: ALLOPURINOL_HASH, walletId: WALLET, quantity: 30 }, { ndcHash: ALLOPURINOL_HASH, quantity: 30 }]);
    expect(p.card.dataset.state).toBe('token-needed');
    expect(p.card.innerHTML).toContain('Needs this node\'s admin token');
    expect(p.card.innerHTML).not.toContain('rx-est-member-pays');
    expect(p.fns.context()).toBeNull();
  });

  test('a prescriber she has not consented to: the ingredient, and the card says her consent is needed', async () => {
    const p = page(fields(ALLOPURINOL_HASH), {
      estimateCost: async (q: any) => { if (q.walletId) throw refusal(403, 'Forbidden'); return LIST_PRICE; },
    });
    await p.fns.updateCostEstimate();
    expect(p.card.dataset.state).toBe('consent-needed');
    expect(p.card.innerHTML).toContain('Needs the patient\'s consent');
    expect(p.card.innerHTML).toContain('$0.03940/EA x 30 EA');
  });

  test('an answer to an older selection never replaces a newer one', async () => {
    let releaseFirst: (v: unknown) => void = () => {};
    const first = new Promise((r) => { releaseFirst = r; });
    let n = 0;
    const p = page(fields(ALLOPURINOL_HASH), { estimateCost: async () => (n++ === 0 ? first : { ...VIDEO_QUOTE, drugName: 'SECOND' }) });
    const older = p.fns.updateCostEstimate();
    await p.fns.updateCostEstimate();
    releaseFirst({ ...VIDEO_QUOTE, drugName: 'FIRST' });
    await older;
    expect(p.card.innerHTML).toContain('Cost Estimate — SECOND');
  });
});

describe('the page sends this node\'s admin token, held in memory, with the calls that need it', () => {
  function rpcWith() {
    const sent: Array<{ url: string; init: any }> = [];
    const storage: Record<string, string> = {};
    const API = new Function('location', 'localStorage', 'fetch', 'EventSource', `${RPC}\nreturn API;`)(
      { origin: 'http://127.0.0.1:4002' },
      { getItem: (k: string) => (k in storage ? storage[k] : null), setItem: (k: string, v: string) => { storage[k] = v; } },
      async (url: string, init: any) => {
        sent.push({ url, init });
        if (url.includes('/estimate-cost') && !(init.headers || {}).Authorization && JSON.parse(init.body).walletId) {
          return { ok: false, status: 401, json: async () => ({ ok: false, error: "A patient's own price answers this node's administrator" }) };
        }
        return { ok: true, status: 200, json: async () => ({ ok: true, data: { covered: true } }) };
      },
      undefined,
    );
    return { API, sent, storage };
  }

  test('a quote, a prior-authorization request and a status read carry the token as a bearer', async () => {
    const { API, sent } = rpcWith();
    API.setAdminToken('node-admin-token');
    await API.estimateCost({ ndcHash: '1', walletId: WALLET, quantity: 30 });
    await API.requestPriorAuth({ walletId: WALLET, ndcHash: '1', quantity: 30 });
    await API.getPriorAuthStatus(WALLET, '1');
    expect(sent.map((s) => [s.init.method, s.url.replace('http://127.0.0.1:4002', '')])).toEqual([
      ['POST', '/estimate-cost'], ['POST', '/prior-auth/request'], ['GET', `/prior-auth/status?walletId=${WALLET}&ndcHash=1`],
    ]);
    for (const s of sent) expect(s.init.headers.Authorization).toBe('Bearer node-admin-token');
  });

  test('with no token, a patient\'s quote is refused with its status; a token set is sent and stored nowhere', async () => {
    const { API, sent, storage } = rpcWith();
    await expect(API.estimateCost({ ndcHash: '1', walletId: WALLET, quantity: 30 })).rejects.toMatchObject({ status: 401 });
    expect(sent[0].init.headers.Authorization).toBeUndefined();
    API.setAdminToken('typed-token');
    expect(storage).toEqual({});
    expect(API.getAdminToken()).toBe('typed-token');
    await API.estimateCost({ ndcHash: '1', walletId: WALLET, quantity: 30 });
    expect(sent[1].init.headers.Authorization).toBe('Bearer typed-token');
  });

  test('the token is typed on the Onboarding tab into a password field, as on the insurer\'s page, and nothing stores it', () => {
    expect(HTML).toContain('<input type="password" autocomplete="off" class="form-input" id="admin-token-input"');
    expect(HTML).toContain('<button class="btn btn-sm" id="admin-set-token">Set</button>');
    const onboarding = HTML.indexOf('id="page-onboarding"');
    expect(HTML.indexOf('id="admin-token-input"')).toBeGreaterThan(onboarding);
    expect(APP).not.toContain('zkt_prescriber_admin_token');
    expect(RPC).not.toContain('localStorage');
  });
});
