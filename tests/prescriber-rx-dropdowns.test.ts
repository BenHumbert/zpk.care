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
 * The prescriber's Write Rx form keeps the patient, pharmacy and drug once they are picked.
 *
 * What was wrong: the form refetches its patient, pharmacy and drug lists each time the Write Rx tab or the form opens,
 * and each refetch replaced the selects' options, which selects the placeholder and fires no change event. A refetch
 * that answered after the prescriber had picked put all three back to "-- Select ... --" while the cost card kept the
 * quote for the patient and drug no longer selected, and Send Prescription said "Select a patient". Collapsing and
 * reopening the form, or leaving the tab and coming back, did it every time. A tab click also entered the tab twice:
 * navigate() sets the hash, and the hashchange listener entered the tab the hash names again, so the click on Write Rx
 * and the opening of the form started three refetches, each about fourteen sequential calls from the node to the
 * network (GET /pcp/patients reads every prescriber's list). Found by the scene audit of the walkthrough, 2026-10-19:
 * the prescribe scene picks the patient, the pharmacy and the drug while those refetches can still be answering.
 *
 * Now the options are replaced keeping the choice already made while the new list still offers it (the choice is read
 * as the options are replaced, so a refetch that started before the pick keeps it too), and the hashchange listener
 * skips the tab navigate() has just opened, so a click enters a tab once. Back and Forward still change tabs.
 *
 * The router, the form's toggle and populateRxDropdowns are lifted out of app.js and run against a stand-in browser:
 * selects that, like a browser's, select their first option when the options are replaced and fire no change event; a
 * location that queues hashchange only when the fragment changes; and a patient list that answers when the test says.
 */
import fs from 'fs';

const NL = '\n';
const read = (file: string): string => fs.readFileSync(file, 'utf8').replace(/\r\n/g, NL);
const APP = read('dashboard-prescriber/app.js');
const HTML = read('dashboard-prescriber/index.html');

/** A top-level function of the IIFE: from its declaration to the first line that is exactly "  }". */
function lift(name: string): string {
  let at = APP.indexOf(NL + '  function ' + name + '(');
  if (at < 0) at = APP.indexOf(NL + '  async function ' + name + '(');
  if (at < 0) throw new Error('no function ' + name);
  const end = APP.indexOf(NL + '  }' + NL, at);
  return APP.slice(at + 1, end + 4);
}
/** A statement of bindEvents: from the line that starts with `first` to the first line after it that is exactly `last`. */
function liftBinding(first: string, last: string): string {
  const at = APP.indexOf(NL + first, APP.indexOf(NL + '  function bindEvents('));
  if (at < 0) throw new Error('no binding ' + first.trim());
  const end = APP.indexOf(NL + last + NL, at);
  return APP.slice(at + 1, end + 1 + last.length);
}
const TABS = APP.split(NL).find((line) => line.startsWith('  var TABS = ')) as string;
// setSelectOptions came with the fix. The old populateRxDropdowns replaced the options itself and runs without it, so on
// the old code these tests fail on what the form does, not on a missing function.
const KEEP_CHOICE = APP.includes(NL + '  function setSelectOptions(') ? ['setSelectOptions'] : [];

const flush = () => new Promise<void>((r) => setImmediate(r));
const escHtml = (s: unknown): string => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const unescHtml = (s: string): string => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
/** The options a select of index.html starts with. */
const initialOptions = (id: string): string => (HTML.match(new RegExp(`<select[^>]*id="${id}"[^>]*>([\\s\\S]*?)</select>`)) || [])[1] || '';

/** A one-choice select as a browser keeps it. */
class Select {
  options: Array<{ value: string; text: string }> = [];
  selectedIndex = -1;
  constructor(html: string) { this.innerHTML = html; }
  /** New options select the first one and fire no change event. */
  set innerHTML(html: string) {
    this.options = [...html.matchAll(/<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g)].map((m) => ({ value: unescHtml(m[1]), text: unescHtml(m[2]).trim() }));
    this.selectedIndex = this.options.length ? 0 : -1;
  }
  get value(): string { return this.selectedIndex < 0 ? '' : this.options[this.selectedIndex].value; }
  /** The first option with this value, or none (a blank select) when no option has it. */
  set value(v: string) { this.selectedIndex = this.options.findIndex((o) => o.value === v); }
  /** What the select shows. */
  get shown(): string { return this.selectedIndex < 0 ? '' : this.options[this.selectedIndex].text; }
}

// The walkthrough's member as her prescriber sees her, a wallet ID, and the pharmacy and drug of its prescribe scene.
const AVERY = '79000000000000000001';
const OTHER_PATIENT = '79000000000000000002';
const KETTLEBY = { walletId: '81000000000000000001', displayName: 'Kettleby Pharmacy', role: 'pharmacy' };
const WEXLEY = { walletId: '81000000000000000002', displayName: 'Wexley Road Pharmacy', role: 'pharmacy' };
const ALLOPURINOL = { ndcHash: '1111', brandName: 'ALLOPURINOL', genericName: 'ALLOPURINOL', ndc: '00378-0137-01', strength: '100 MG', dosageForm: 'TABLET', pricingUnit: 'EA', tierLevel: 1, copayAmount: 1000 };
const LISINOPRIL = { ndcHash: '2222', brandName: 'LISINOPRIL', genericName: 'LISINOPRIL', ndc: '68180-0513-01', strength: '10 MG', dosageForm: 'TABLET', pricingUnit: 'EA', tierLevel: 1, copayAmount: 1000 };
const PICKED = [AVERY, KETTLEBY.walletId, ALLOPURINOL.ndcHash];

/** The prescriber page's router, Write Rx loader and form toggle, lifted out of app.js, in a stand-in browser. */
function page() {
  // The address bar: a new fragment queues one hashchange; the fragment already there queues none.
  let fragment = '';
  let queued = 0;
  const hashListeners: Array<() => void> = [];
  const location = {
    get hash(): string { return fragment ? '#' + fragment : ''; },
    set hash(v: string) {
      const next = String(v).replace(/^#/, '');
      if (next === fragment) return;
      fragment = next;
      queued++;
      setImmediate(() => { queued--; hashListeners.forEach((fn) => fn()); });
    },
  };
  const window: Record<string, unknown> = {
    addEventListener: (type: string, fn: () => void) => { if (type === 'hashchange') hashListeners.push(fn); },
  };
  const tabClicks: Record<string, () => void> = {};
  const tabs = ['overview', 'prescriptions', 'formulary'].map((tab) => ({
    dataset: { tab }, classList: { toggle: () => true },
    addEventListener: (_type: string, fn: () => void) => { tabClicks[tab] = fn; },
  }));
  const pages = ['overview', 'prescriptions', 'formulary'].map((tab) => ({ id: 'page-' + tab, classList: { toggle: () => true } }));

  // The form, collapsed as index.html has it
  const formClasses = new Set(['panel-body', 'hidden']);
  let toggleClick: () => void = () => { throw new Error('the form toggle is not bound'); };
  const els: Record<string, unknown> = {
    '#rx-patient-select': new Select(initialOptions('rx-patient-select')),
    '#rx-pharmacy-select': new Select(initialOptions('rx-pharmacy-select')),
    '#rx-med-select': new Select(initialOptions('rx-med-select')),
    '#rx-write-toggle': { addEventListener: (_type: string, fn: () => void) => { toggleClick = fn; } },
    '#rx-write-body': { classList: { contains: (c: string) => formClasses.has(c), add: (c: string) => { formClasses.add(c); }, remove: (c: string) => { formClasses.delete(c); } } },
    '#rx-write-arrow': { innerHTML: '' },
  };

  // The node: each refetch's patient list (GET /pcp/patients) answers when the test says; the other lists at once.
  const waiting: Array<(walletIds: string[]) => void> = [];
  let answered = 0;
  const API = {
    getPcpPatients: () => new Promise((resolve) => {
      waiting.push((walletIds) => resolve({ patients: walletIds.map((id) => ({ memberWalletId: id, effectiveDate: '2026-10-19', specialty: 'Primary Care' })) }));
    }),
    getProviders: async () => [KETTLEBY, WEXLEY],
    getFormularyPage: async () => ({ drugs: [ALLOPURINOL, LISINOPRIL], total: 2 }),
    getMedicationBreakdown: async () => [],
  };

  // The tabs' loaders record each tab entered; Write Rx's own loader is lifted, since it refetches the lists.
  const entered: string[] = [];
  const enter = (tab: string) => () => { entered.push(tab); };
  const scope: Record<string, unknown> = {
    location, window, API, esc: escHtml,
    $: (sel: string) => els[sel] ?? null,
    $$: (sel: string) => (sel === '.nav-tab' ? tabs : sel === '.page' ? pages : []),
    loadOverview: enter('overview'), loadPrescriptionStats: enter('prescriptions'), loadPrescriptionHistory: () => undefined,
    loadPatients: enter('patients'), autoLoadFormulary: enter('formulary'), loadProviders: enter('providers'),
    loadMessaging: enter('messaging'), loadOnboarding: enter('onboarding'), loadProofs: enter('proofs'),
  };
  const code = [
    "var currentTab = 'overview';", "var onboardingPhase = 'ready';",
    'var cachedMembers = [];', 'var cachedPharmacies = [];', 'var cachedMedications = [];', TABS,
    ...['truncHash', 'navigate', 'onTabEnter', 'loadPrescriptions', ...KEEP_CHOICE, 'populateRxDropdowns'].map(lift),
    liftBinding("    $$('.nav-tab').forEach(function (btn) {", '    });'),
    liftBinding("    window.addEventListener('hashchange', function () {", '    });'),
    liftBinding("    var rxToggle = $('#rx-write-toggle');", '    }'),
  ].join(NL);
  const names = Object.keys(scope);
  const app = new Function(...names, `'use strict';\n${code}\nreturn { navigate: navigate, currentTab: function () { return currentTab; } };`)(
    ...names.map((n) => scope[n])) as { navigate: (tab: string) => void; currentTab: () => string };

  /** Until every hashchange queued has fired and the work it started has run as far as it can. */
  const settle = async () => { do { await flush(); } while (queued > 0); };
  const patient = els['#rx-patient-select'] as Select;
  const pharmacy = els['#rx-pharmacy-select'] as Select;
  const drug = els['#rx-med-select'] as Select;
  return {
    patient, pharmacy, drug, entered, location, currentTab: app.currentTab,
    values: () => [patient.value, pharmacy.value, drug.value],
    /** How many times the lists have been fetched. */
    refetches: () => waiting.length,
    /** The page opens as init() opens it: on the tab the address bar names, or Overview. */
    open: async () => { app.navigate(location.hash.replace('#', '') || 'overview'); await settle(); },
    click: async (tab: string) => { tabClicks[tab](); await settle(); },
    /** A click on "Write Prescription", which opens the form or collapses it. */
    toggle: async () => { toggleClick(); await settle(); },
    /** The browser's Back or Forward to this tab's entry, or a hash typed into the address bar. */
    history: async (tab: string) => { location.hash = '#' + tab; await settle(); },
    /** The oldest refetch still waiting gets its patient list. */
    answerNext: async (walletIds: string[]) => { waiting[answered++](walletIds); await settle(); },
    /** Every refetch still waiting gets its patient list, oldest first. */
    answerRest: async (walletIds: string[]) => { while (answered < waiting.length) waiting[answered++](walletIds); await settle(); },
    /** The prescriber picks an option the select offers. */
    pick: (sel: Select, value: string) => { expect(sel.options.map((o) => o.value)).toContain(value); sel.value = value; },
  };
}
type Page = ReturnType<typeof page>;

/** Opens Write Rx and the form, fills the lists and picks the walkthrough's patient, pharmacy and drug. */
async function picked(patients: string[] = [AVERY, OTHER_PATIENT], patient = AVERY): Promise<Page> {
  const t = page();
  await t.open();
  await t.click('prescriptions');
  await t.toggle();
  await t.answerRest(patients);
  t.pick(t.patient, patient);
  t.pick(t.pharmacy, KETTLEBY.walletId);
  t.pick(t.drug, ALLOPURINOL.ndcHash);
  return t;
}

describe('the Write Rx form keeps the patient, pharmacy and drug once picked', () => {
  test('the prescribe scene: refetches that started before the picks and answer after them keep the picks', async () => {
    const t = page();
    await t.open();
    await t.click('prescriptions');                    // Write Rx
    await t.toggle();                                  // opening the form refetches the lists too
    expect(t.refetches()).toBeGreaterThanOrEqual(2);

    await t.answerNext([AVERY]);                       // the first answers: the list shows her
    expect(t.patient.options.map((o) => o.value)).toEqual(['', AVERY]);
    expect(t.patient.shown).toBe('-- Select Patient --');
    t.pick(t.patient, AVERY);
    t.pick(t.pharmacy, KETTLEBY.walletId);
    t.pick(t.drug, ALLOPURINOL.ndcHash);

    await t.answerRest([AVERY]);                       // the others answer after the picks
    expect(t.values()).toEqual(PICKED);                // before: ['', '', '']
    expect([t.pharmacy.shown, t.drug.shown]).toEqual(['Kettleby Pharmacy', 'ALLOPURINOL 100 MG TABLET']);
  });

  test('a refetch answering between two picks keeps the pick already made', async () => {
    const t = page();
    await t.open();
    await t.click('prescriptions');
    await t.toggle();
    await t.answerNext([AVERY]);
    t.pick(t.patient, AVERY);
    await t.answerRest([AVERY]);                       // lands during "Kettleby's. Her usual."
    expect(t.patient.value).toBe(AVERY);               // before: ''
    t.pick(t.pharmacy, KETTLEBY.walletId);
    t.pick(t.drug, ALLOPURINOL.ndcHash);
    expect(t.values()).toEqual(PICKED);
  });

  test('collapsing and reopening the form keeps the picks', async () => {
    const t = await picked();
    const fetched = t.refetches();
    await t.toggle();                                  // collapse
    expect(t.refetches()).toBe(fetched);
    await t.toggle();                                  // reopen: the lists are fetched again
    expect(t.refetches()).toBe(fetched + 1);
    await t.answerRest([AVERY, OTHER_PATIENT]);
    expect(t.values()).toEqual(PICKED);                // before: ['', '', '']
  });

  test('leaving Write Rx for another tab and coming back keeps the picks', async () => {
    const t = await picked();
    await t.click('formulary');
    await t.click('prescriptions');                    // the lists are fetched again
    await t.answerRest([AVERY, OTHER_PATIENT]);
    expect(t.values()).toEqual(PICKED);                // before: ['', '', '']
  });

  test('a list that no longer offers the chosen patient shows "-- Select Patient --", never a blank select; the other picks stay', async () => {
    const t = await picked([AVERY, OTHER_PATIENT], OTHER_PATIENT);
    await t.toggle();
    await t.toggle();
    await t.answerRest([AVERY]);
    expect(t.patient.selectedIndex).toBe(0);
    expect(t.patient.shown).toBe('-- Select Patient --');
    expect(t.patient.value).toBe('');
    expect([t.pharmacy.value, t.drug.value]).toEqual([KETTLEBY.walletId, ALLOPURINOL.ndcHash]);   // before: ['', '']
  });
});

describe('a click enters a tab once', () => {
  test('opening the page enters Overview once; a click on Write Rx enters it once and fetches the lists once', async () => {
    const t = page();
    await t.open();
    expect(t.location.hash).toBe('#overview');
    expect(t.entered).toEqual(['overview']);           // before: ['overview', 'overview']
    await t.click('prescriptions');
    expect(t.location.hash).toBe('#prescriptions');
    expect(t.entered).toEqual(['overview', 'prescriptions']);   // before: Write Rx entered twice
    expect(t.refetches()).toBe(1);                     // before: 2
    await t.toggle();
    expect(t.refetches()).toBe(2);                     // before: 3
  });

  test('Back and Forward still change tabs, and a hash naming no tab opens Overview once', async () => {
    const t = page();
    await t.open();
    await t.click('prescriptions');
    const before = t.entered.length;
    await t.history('overview');                       // Back
    expect([t.currentTab(), t.entered.slice(before)]).toEqual(['overview', ['overview']]);
    await t.history('prescriptions');                  // Forward
    expect([t.currentTab(), t.entered.slice(before)]).toEqual(['prescriptions', ['overview', 'prescriptions']]);
    await t.history('nonesuch');                       // typed into the address bar
    expect([t.currentTab(), t.location.hash, t.entered.slice(before)]).toEqual(['overview', '#overview', ['overview', 'prescriptions', 'overview']]);
  });
});

describe('the prescriber escapes what it puts into attribute values', () => {
  test('esc() escapes quotes as well as markup, since the Write Rx options carry it in quoted values', () => {
    // a stand-in element whose innerHTML escapes its text as a browser's does (&, < and >; never quotes)
    const document = { createElement: () => { let t = ''; return { set textContent(v: string) { t = v; }, get innerHTML() { return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); } }; } };
    const esc = new Function('document', `'use strict';\n${lift('esc')}\nreturn esc;`)(document) as (s: unknown) => string;
    expect(esc('1" onmouseover="steal()')).toBe('1&quot; onmouseover=&quot;steal()');      // before: the quote ended value="..."
    expect(esc("CROHN'S <b>")).toBe('CROHN&#39;S &lt;b&gt;');
    expect(esc(null)).toBe('');
    // where that matters: the drug select writes a formulary name into data-name="..."
    expect(lift('populateRxDropdowns')).toContain(`data-name="' + esc(m.brandName || m.genericName || '') + '"`);
  });
});
