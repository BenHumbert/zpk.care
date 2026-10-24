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
 * The member app's Dashboard opens on its loading state, not on what it drew the last time it was open.
 *
 * What was wrong: navigate() shows the Dashboard page as it was left and only then asks the device and the network for
 * its data. What was left can be from before the member's latest claim: drawn at enrollment, it read "No claims data
 * yet", Total Fills 0 and You Paid $0.00, and it stayed up until the answers arrived, a flash of zeros against the true
 * claim. Found by the QA of the walkthrough's first voiced take, 2026-10-23: on the return to the Dashboard after the
 * pickup, the empty state showed for about a quarter of a second before "$14.18 of $500.00" deductible.
 *
 * Now opening the tab draws the page's own loading state first, as when the page first loads, and the answers replace
 * it as they arrive. A refresh while the tab is open (a proof accepted, a batch settled) keeps the view until its
 * answers replace it, so the dashboard does not blink at every event.
 *
 * The router, the Dashboard's loaders and the event handler are lifted out of app.js and run against a stand-in device
 * and network whose answers wait until the test releases them.
 */
import fs from 'fs';

const NL = '\n';
const APP = fs.readFileSync('dashboard-member/app.js', 'utf8').replace(/\r\n/g, NL);

/** A top-level function of the IIFE: from its declaration to the first line that is exactly "  }". */
function lift(name: string): string {
  let at = APP.indexOf(NL + '  function ' + name + '(');
  if (at < 0) at = APP.indexOf(NL + '  async function ' + name + '(');
  if (at < 0) throw new Error('app.js has no function ' + name);
  const end = APP.indexOf(NL + '  }' + NL, at);
  return APP.slice(at + 1, end + 4);
}
const flush = async (): Promise<void> => { for (let i = 0; i < 10; i++) await new Promise<void>((r) => setImmediate(r)); };

const WALLET = '10579301147402708999654625';
const LIMITS = { deductibleAmountCents: 50000, oopMaxCents: 780000, annualBenefitMaxCents: 10000000 };
const CLAIM = { leafIndex: 0, leaf: { operationType: '1', patientPayCents: '1418' }, metadata: { brandName: 'ALLOPURINOL (Generic)' } };

function memberApp() {
  const el = (id: string) => ({ id, innerHTML: '', classList: { add() {}, remove() {} } });
  const els: Record<string, any> = Object.fromEntries(['spend-hero', 'dash-stats', 'dash-recent-claims', 'pcp-nudge', 'page-dashboard', 'page-claims'].map((id) => [id, el(id)]));
  const waiting: Array<() => void> = [];
  /** An answer the stand-in sends once the test releases it. */
  const later = <T>(value: T): Promise<T> => new Promise((resolve) => { waiting.push(() => resolve(value)); });
  const scope: Record<string, unknown> = {
    $: (id: string) => els[id] ?? null,
    qs: () => ({ classList: { add() {}, remove() {} } }),
    qsa: () => [els['page-dashboard'], els['page-claims']],
    location: { origin: 'http://device.test' },
    fetch: () => later({ ok: true, json: async () => ({ ok: true, data: LIMITS }) }),        // GET /plan/limits
    RPC: {
      deviceHeaders: () => ({ 'X-Device-Session': 's' }),
      getCurrentPcp: () => later({ pcpWalletId: '22772015471886', effectiveDate: '20261024' }),
      reconstructAccumulator: () => later({ deductiblePaidCents: 1418, oopPaidCents: 1418, benefitUsedCents: 0 }),
      getClaimsByMember: () => later([CLAIM]),
    },
    renderClaimCards: (claims: typeof CLAIM[]) => claims.map((c) => '<div class="claim-card">' + c.metadata.brandName + '</div>').join(''),
    loadClaims: () => undefined, loadFormulary: () => undefined, loadPlan: () => undefined, loadProviders: () => undefined,
    loadMessages: () => undefined, loadSettings: () => undefined,
    setConnDot: () => undefined, showSeqStatus: () => undefined, hideSeqStatus: () => undefined, refreshMyStatus: () => undefined,
    setTimeout: () => 0,
  };
  const body = [
    `var walletId = '${WALLET}';`, "var currentTab = 'claims';", 'var claimsCache = [];', 'var planSpendCache = null;', 'var pcpData = null;',
    ...['esc', 'fmtCents', 'statCard', 'progressClass', 'loadPlanLimits', 'loadSpendHero', 'loadDashStats', 'deduplicateClaims',
      'loadRecentClaims', 'loadDashboard', 'loadTab', 'navigate', 'handleSSE'].map(lift),
  ].join(NL);
  const names = Object.keys(scope);
  const app = new Function(...names, `'use strict';\n${body}\nreturn { navigate, handleSSE, statCard };`)(...names.map((n) => scope[n])) as {
    navigate: (tab: string) => void; handleSSE: (ev: unknown) => void; statCard: (label: string, value: unknown) => string;
  };
  // The Dashboard as it was drawn at enrollment, before any claim; the member is on Drug History now
  els['spend-hero'].innerHTML = '<div class="empty-state">No claims data yet</div>';
  els['dash-stats'].innerHTML = ['Total Fills', 'Reversals'].map((l) => app.statCard(l, 0)).join('') + app.statCard('You Paid', '$0.00') + app.statCard('Claims', 0);
  els['dash-recent-claims'].innerHTML = '<div class="empty-state">No claims yet</div>';
  return {
    ...app,
    /** What the Dashboard's three panels read: the spend, the stats and the recent claims. */
    screen: () => ['spend-hero', 'dash-stats', 'dash-recent-claims'].map((id) => String(els[id].innerHTML).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()),
    /** The stand-in answers everything asked of it, and whatever that leads to. */
    answer: async () => { while (waiting.length) { waiting.splice(0).forEach((send) => send()); await flush(); } },
  };
}

describe('the member Dashboard opens on its loading state', () => {
  test('opening the tab shows "loading" until the answers arrive, never the zeros it drew before the claim', async () => {
    const app = memberApp();
    app.navigate('dashboard');                                         // the click on Dashboard
    const opening = app.screen();
    expect(opening).toEqual(['Loading plan spend...', '', 'Loading...']);  // before: No claims data yet, Total Fills 0 ... You Paid $0.00
    expect(opening.join(' ')).not.toMatch(/No claims data yet|\$0\.00/);
    await app.answer();
    const [spend, stats, recent] = app.screen();
    expect(spend).toContain('$14.18 of $500.00');
    expect(spend).toContain('$14.18 of $7,800.00');
    expect(stats).toBe('Total Fills 1 Reversals 0 You Paid $14.18 Claims 1');
    expect(recent).toBe('ALLOPURINOL (Generic)');
  });

  test('a refresh while the tab is open keeps the view until its answers replace it', async () => {
    const app = memberApp();
    app.navigate('dashboard');
    await app.answer();
    const shown = app.screen();
    app.handleSSE({ type: 'proof:accepted', data: { walletId: WALLET } });   // the member's own proof, accepted
    expect(app.screen()).toEqual(shown);                               // no loading state, no blink
    await app.answer();
    expect(app.screen()).toEqual(shown);
  });
});
