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
 * The insurer's plan screens and the employer's agreement screen after plan-bound formularies (pricing review F5, F9,
 * F11 and F12).
 *
 * What was wrong:
 *  F9.  The create-plan form turned a typed 0 into the default for the deductible, OOP max, annual max and family
 *       limits (`Number(x) || 100000`), so "no deductible" was stored and published as $1,000. No field said what 0 means.
 *  F11. The plan table read the old published flag: a plan published before the published terms were kept showed as
 *       Published with its Publish button disabled, while the engine refused its members.
 *  F5.  A publish that a newer draft overtook was reported as a plain success.
 *  F12. The marketplace agreement showed no dispensing fee and no formulary, and an employer whose signed terms no
 *       longer match what members are billed was not told; nor was the insurer.
 *
 * The dashboards are plain browser scripts: single functions are lifted out of app.js and run with stubs, as in
 * tests/screens-insurer-employer-marketplace.test.ts.
 */
import fs from 'fs';

const NL = '\n';
const read = (file: string): string => fs.readFileSync(file, 'utf8').replace(/\r\n/g, NL);
const INSURER = read('dashboard-insurer/app.js');
const INSURER_HTML = read('dashboard-insurer/index.html');
const MARKETPLACE = read('dashboard-marketplace/app.js');

const has = (src: string, name: string): boolean =>
  src.includes(NL + '  function ' + name + '(') || src.includes(NL + '  async function ' + name + '(');

/** A top-level function of an IIFE dashboard: from its declaration to the first line that is exactly "  }". */
function lift(src: string, name: string): string {
  let at = src.indexOf(NL + '  function ' + name + '(');
  if (at < 0) at = src.indexOf(NL + '  async function ' + name + '(');
  if (at < 0) throw new Error('no function ' + name);
  const end = src.indexOf(NL + '  }' + NL, at);
  return src.slice(at + 1, end + 4);
}
/** The named functions this version of the page has (a helper added by a fix is absent from the code before it). */
const liftAll = (src: string, names: string[]): string[] => names.filter((n) => has(src, n)).map((n) => lift(src, n));

/** Runs pieces of page code in strict mode with `scope` as their free variables and returns the value of `ret`. */
function run(pieces: string[], scope: Record<string, unknown>, ret: string): any {
  const names = Object.keys(scope);
  return new Function(...names, `'use strict';\n${pieces.join(NL)}\nreturn ${ret};`)(...names.map((n) => scope[n]));
}

const escHtml = (s: unknown): string => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A page element stub with what the lifted code touches. */
function element(id: string, value = ''): Record<string, any> {
  return {
    id, value, innerHTML: '', textContent: '', checked: false, disabled: false, style: {},
    scrollTop: 0, scrollHeight: 0, clientHeight: 0,
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {}, querySelectorAll: () => [],
  };
}

// ─── F9: the create-plan form ───────────────────────────────────────────────

describe('F9: the create-plan form keeps a typed 0', () => {
  async function created(values: Record<string, string>): Promise<Record<string, unknown>> {
    const sent: Array<Record<string, unknown>> = [];
    const els: Record<string, any> = {};
    const $ = (id: string) => (els[id] = els[id] ?? element(id, values[id] ?? ''));
    const createPlan = run(liftAll(INSURER, ['feeFromInput', 'centsFromInput', 'createPlan']), {
      $, API: { createPlan: async (b: Record<string, unknown>) => { sent.push(b); return b; } },
      toast: () => undefined, showResult: () => undefined, fetchPlans: async () => undefined, renderPlanList: () => undefined,
    }, 'createPlan');
    await createPlan();
    expect(sent).toHaveLength(1);
    return sent[0];
  }
  const ids = { 'plan-name': 'No Limits', 'plan-id': 'PLAN-NO-LIMITS', 'plan-coverage': 'pharmacy' };
  const FIELDS: Array<[string, string, number]> = [
    ['plan-copay', 'copayAmountCents', 2000],
    ['plan-deductible', 'deductibleAmountCents', 100000],
    ['plan-oop', 'oopMaxCents', 500000],
    ['plan-annual', 'annualBenefitMaxCents', 10000000],
    ['plan-fam-ded', 'familyDeductibleAmountCents', 200000],
    ['plan-fam-oop', 'familyOopMaxCents', 1000000],
    ['plan-fam-annual', 'familyAnnualBenefitMaxCents', 20000000],
  ];

  test('every amount typed as 0 is sent as 0: none or no limit, not the default', async () => {
    const zeros = Object.fromEntries([...FIELDS.map(([id]) => [id, '0']), ['plan-dispensing-fee', '0']]);
    const body = await created({ ...ids, ...zeros });
    for (const [, field] of FIELDS) expect([field, body[field]]).toEqual([field, 0]);
    expect(body.dispensingFeeCents).toBe(0);
  });

  test('a blank field takes the default, and the fee is left to the network default', async () => {
    const body = await created({ ...ids });
    for (const [, field, dflt] of FIELDS) expect([field, body[field]]).toEqual([field, dflt]);
    expect(body.dispensingFeeCents).toBeUndefined();
  });

  test('what was typed is sent as typed, so the insurer node can refuse a negative or fractional amount', async () => {
    const body = await created({ ...ids, 'plan-deductible': '-5', 'plan-oop': '12.5' });
    expect(body.deductibleAmountCents).toBe(-5);
    expect(body.oopMaxCents).toBe(12.5);
  });

  test('each numeric field of the form and of the detail panel says what 0 means', () => {
    for (const id of [...FIELDS.map(([fid]) => fid), 'plan-dispensing-fee', 'plan-detail-dispensing-fee']) {
      const at = INSURER_HTML.indexOf(`id="${id}"`);
      expect([id, at > 0]).toEqual([id, true]);
      const after = INSURER_HTML.slice(at, INSURER_HTML.indexOf('</div>', at));
      expect([id, /<span class="form-hint">0 = [^<]+<\/span>/.test(after)]).toEqual([id, true]);
    }
  });
});

// ─── F11 and F5: the plan table and the detail panel ────────────────────────

const PUBLISHED_TERMS = { copayAmountCents: 1500, formularyRoot: '1234567890', networkRoot: '0', publishedAt: 1_760_000_000_000 };
const PLANS = [
  { planId: 'PLAN-LIVE', name: 'Live', published: true, publishedTerms: PUBLISHED_TERMS, copayAmountCents: 1500, oopMaxCents: 0, annualBenefitMaxCents: 0 },
  { planId: 'PLAN-EDITING', name: 'Editing', published: false, publishedTerms: PUBLISHED_TERMS, copayAmountCents: 500 },
  // published before the terms were kept: the overlay version as its formularyRoot, no published terms
  { planId: 'PLAN-LEGACY', name: 'Legacy', published: true, formularyRoot: '1', copayAmountCents: 1000 },
  { planId: 'PLAN-NEW', name: 'New', published: false, copayAmountCents: 1000 },
];

function planTable(plans: unknown[], publishPlan?: (id: string) => Promise<unknown>) {
  const container = element('plan-list-container');
  const buttons = (plans as Array<{ planId: string }>).map((p) => ({ dataset: { planId: p.planId }, disabled: false, textContent: 'Publish' } as Record<string, any>));
  container.querySelectorAll = (sel: string) => (sel === '.plan-publish-btn' ? buttons : []);
  const toasts: Array<[string, string]> = [];
  const render = run(liftAll(INSURER, ['fmtCents', 'fmtLimit', 'coverageLabel', 'planPublishedTerms', 'planPublishState', 'planStatusBadge', 'publishOutcome', 'renderPlanList']), {
    $: (id: string) => (id === 'plan-list-container' ? container : element(id)),
    esc: escHtml, planData: plans, API: { publishPlan: publishPlan ?? (async () => ({})) },
    toast: (m: string, t: string) => { toasts.push([m, t]); }, fetchPlans: async () => undefined,
    confirm: () => false, openPlanDetail: () => undefined,
  }, 'renderPlanList');
  render();
  return { html: String(container.innerHTML), buttons, toasts };
}
const publishButton = (html: string, planId: string): string =>
  html.match(new RegExp(`<button class="btn btn-sm btn-primary plan-publish-btn" data-plan-id="${planId}"([^>]*)>`))?.[1] ?? 'missing';
const rowOf = (html: string, planId: string): string => html.split('<tr>').find((r) => r.includes(`data-plan-id="${planId}"`)) ?? '';

describe('F11: a plan counts as published only if it has published terms', () => {
  test('a plan published before the terms were kept shows "Republish needed" and its Publish button is enabled', () => {
    const { html } = planTable(PLANS);
    expect(rowOf(html, 'PLAN-LEGACY')).toContain('Republish needed');
    expect(rowOf(html, 'PLAN-LEGACY')).not.toContain('>Published<');
    expect(publishButton(html, 'PLAN-LEGACY')).not.toContain('disabled');
  });

  test('a published plan is Published with Publish disabled; a draft over published terms and a new plan can be published', () => {
    const { html } = planTable(PLANS);
    expect(rowOf(html, 'PLAN-LIVE')).toContain('>Published<');
    expect(publishButton(html, 'PLAN-LIVE')).toContain('disabled');
    expect(rowOf(html, 'PLAN-EDITING')).toContain('published version in force');
    expect(publishButton(html, 'PLAN-EDITING')).not.toContain('disabled');
    expect(rowOf(html, 'PLAN-NEW')).toContain('>Draft<');
    expect(publishButton(html, 'PLAN-NEW')).not.toContain('disabled');
  });

  test('a limit of 0 reads "No limit", not $0.00', () => {
    const row = rowOf(planTable(PLANS).html, 'PLAN-LIVE');
    expect(row).toContain('No limit');
  });

  test('the detail panel shows the same state and says how to publish the plan again', async () => {
    const els: Record<string, any> = {};
    const $ = (id: string) => (els[id] = els[id] ?? element(id));
    const open = run(liftAll(INSURER, ['planPublishedTerms', 'planPublishState', 'planStatusBadge', 'planDetailStatus', 'openPlanDetail']), {
      $, planData: PLANS, toast: () => undefined, editingPlanId: null, selectedFormularyNdcs: null, selectedNetworkWalletIds: null,
      allFormularyEntries: [], allNetworkProviders: [],
      API: { getFormulary: async () => ({ entries: [] }), getProviderRegistry: async () => ({ providers: [] }) },
      renderFormularySelection: () => undefined, renderNetworkSelection: () => undefined, initPlanDetailEvents: () => undefined,
    }, 'openPlanDetail');
    await open('PLAN-LEGACY');
    expect(String(els['plan-detail-status']?.innerHTML ?? '')).toContain('Republish needed');
    expect(String(els['plan-detail-status']?.innerHTML ?? '')).toContain('Save &amp; Publish');
    await open('PLAN-EDITING');
    expect(String(els['plan-detail-status']?.innerHTML ?? '')).toContain('Members are billed the published terms');
    expect(INSURER_HTML).toContain('id="plan-detail-status"');
  });
});

describe('F5: a publish overtaken by a newer draft says so', () => {
  test('the Publish button reports the route\'s message, not "Plan published"', async () => {
    const message = 'Published the plan as it was when publishing began. A newer draft was saved meanwhile and is not published; publish again to publish it.';
    const { buttons, toasts } = planTable([PLANS[3]], async () => ({ published: false, draftPending: true, message }));
    await buttons[0].onclick();
    expect(toasts).toEqual([[message, 'info']]);
  });

  test('an ordinary publish is still reported as published', async () => {
    const { buttons, toasts } = planTable([PLANS[3]], async () => ({ published: true, draftPending: false, formularyEntryCount: 3 }));
    await buttons[0].onclick();
    expect(toasts).toEqual([['Plan published: PLAN-NEW (3 formulary entries)', 'success']]);
  });
});

// ─── F12: the agreement screens ─────────────────────────────────────────────

describe('F12: the insurer sees when an employer\'s signed terms no longer match', () => {
  const actions = (a: Record<string, unknown>): string => run(liftAll(INSURER, ['renderAppActions']), { esc: escHtml }, 'renderAppActions')(a);

  test('a signed or active employer whose terms changed is flagged; one whose terms match is not', () => {
    expect(actions({ applicationId: 'EMPAPP-1', status: 'active', termsChanged: true })).toContain('Terms changed since signed');
    expect(actions({ applicationId: 'EMPAPP-2', status: 'signed', termsChanged: true })).toContain('Terms changed since signed');
    expect(actions({ applicationId: 'EMPAPP-3', status: 'active', termsChanged: false })).not.toContain('Terms changed');
    expect(actions({ applicationId: 'EMPAPP-4', status: 'active', termsChanged: null })).not.toContain('Terms changed');
  });

  test('an employer that signed before agreements covered every published term is told apart from a terms change', () => {
    // review of the pricing fixes (round 2): every attestation signed before 2026.2 showed "Terms changed since signed"
    const legacy = actions({ applicationId: 'EMPAPP-5', status: 'active', termsChanged: false, signedBeforeFullTerms: true });
    expect(legacy).toContain('Signed before full terms');
    expect(legacy).not.toContain('Terms changed');
    expect(actions({ applicationId: 'EMPAPP-6', status: 'active', termsChanged: false, signedBeforeFullTerms: false })).not.toContain('Signed before');
  });
});

describe('F12: the marketplace agreement describes what members are billed', () => {
  const PLAN_TERMS = {
    planId: 'PLAN-A', planName: 'Plan A', copayAmountCents: 1500, deductibleAmountCents: 50000, oopMaxCents: 780000,
    annualBenefitMaxCents: 0, dispensingFeeCents: 10000, dispensingFeeSource: 'plan', formularyRoot: '98765432109876543210',
    coverageType: 1, familyDeductibleAmountCents: 100000, familyOopMaxCents: 1600000, familyAnnualBenefitMaxCents: 2500000, networkRoot: '55555555555555555555',
  };
  const agreement = (signedAttestation: unknown) => ({
    terms: {
      agreementId: 'AGR-EMPAPP-1', applicationId: 'EMPAPP-1', employerId: 'FERNHILL', companyName: 'Fernhill Test Works LLC',
      selectedPlans: [PLAN_TERMS], unavailablePlanIds: ['PLAN-DRAFT'], effectiveDate: '20270101', enrollmentCap: 10,
      insurerName: 'zkpCare Network', termsVersion: '2026.1', generatedAt: 1,
    },
    commitment: '111', documentHash: 'abc', ts: 1, attestationSeq: 1, canonicalMessage: 'zkpcare-employer-v2|...', signedAttestation,
  });

  /** The Agreement screen for an application in `status`, the agreement route answering `data`. */
  async function agreementScreen(status: string, data: unknown, keypair: unknown = { publicKeyHex: 'b'.repeat(64) }): Promise<string> {
    const els: Record<string, any> = {};
    const document = { getElementById: (id: string) => (els[id] = els[id] ?? element(id)) };
    let agreementData: unknown = null;
    const pieces = liftAll(MARKETPLACE, ['fmtCents', 'fmtLimit', 'fmtFee', 'nextAttestationReason', 'termsChangedNotice', 'agreementPlansSection', 'renderAgreement', 'renderSign']);
    const renderSign = run(pieces, {
      document, app: { innerHTML: '' }, applicationId: 'EMPAPP-1', applicationStatus: '', agreementData, keypair,
      stepBar: () => '', loading: () => '', activationCodeCard: () => '', wireActivationCodeCard: () => undefined,
      api: async (_m: string, p: string) => (p.includes('/status/') ? { status, companyName: 'Fernhill' } : data),
      persistState: () => undefined, esc: escHtml, toast: () => undefined, errMsg: String, navigate: () => undefined,
      doSign: async () => undefined, regenerateKeypair: async () => keypair, claimSecret: '', prompt: () => null,
    }, 'renderSign');
    await renderSign();
    return String(els['sign-content']?.innerHTML ?? '');
  }

  test('an active employer whose terms changed is shown the new terms to sign, with the fee and the formulary', async () => {
    const html = await agreementScreen('active', agreement({ attestationSeq: 0, signedAt: 1, termsChanged: true }));
    expect(html).toContain('Terms changed since signed');
    expect(html).toContain('Sign New Terms');
    expect(html).toContain('Dispensing Fee');
    expect(html).toContain('$100.00');
    expect(html).toContain('98765432109876543210');                    // the published formulary root
    expect(html).toContain('PLAN-DRAFT');                              // a selected plan that is not published
    expect(html).toContain('No limit');                                // annual max 0
    expect(html).not.toContain('Agreement already signed');
  });

  test('an active employer whose terms still match is told the agreement is signed', async () => {
    const html = await agreementScreen('active', agreement({ attestationSeq: 0, signedAt: 1, termsChanged: false }));
    expect(html).toContain('Agreement already signed');
    expect(html).not.toContain('Terms changed since signed');
  });

  test('without the key that signed, the screen says the insurer must rekey rather than offer a key the route refuses', async () => {
    const html = await agreementScreen('active', agreement({ attestationSeq: 0, signedAt: 1, termsChanged: true }), null);
    expect(html).toContain('Ask the insurer to rekey');
    expect(html).not.toContain('btn-regen-key');
  });

  test('the agreement states the family limits and the network roots, and that a plan published later needs a new signature', async () => {
    const html = await agreementScreen('approved', agreement(null));
    expect(html).toContain('Family OOP Max');
    expect(html).toContain('$16000.00');                              // the family OOP max
    expect(html).toContain('$25000.00');                              // the family annual max
    expect(html).toContain('55555555555555555555');                    // the published network root
    expect(html).toContain('A plan published later is covered only once you sign an agreement that includes it');
    expect(html).not.toContain('until the insurer publishes them');
  });

  test('an active employer that signed before full terms is offered the full terms, without being told its terms changed', async () => {
    const html = await agreementScreen('active', agreement({ attestationSeq: 0, signedAt: 1, termsChanged: false, signedBeforeFullTerms: true, plansToAdd: [] }));
    expect(html).toContain('Signed before full terms');
    expect(html).toContain('Sign New Terms');
    expect(html).not.toContain('Terms changed since signed');
    expect(html).not.toContain('Agreement already signed');
  });

  test('an active employer with a selected plan published after it signed is offered it to add, as its next attestation', async () => {
    const html = await agreementScreen('active', agreement({ attestationSeq: 0, signedAt: 1, termsChanged: false, signedBeforeFullTerms: false, plansToAdd: ['PLAN-A'] }));
    expect(html).toContain('Plans to add');
    expect(html).toContain('PLAN-A is published now');
    expect(html).toContain('Sign New Terms');
    expect(html).not.toContain('Agreement already signed');
  });

  test('a first agreement shows the fee column too and keeps the first-signing wording', async () => {
    const html = await agreementScreen('approved', agreement(null));
    expect(html).toContain('Dispensing Fee');
    expect(html).toContain('Sign Agreement');
    expect(html).not.toContain('Terms changed since signed');
  });
});
