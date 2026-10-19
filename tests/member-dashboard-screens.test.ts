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
 * The member app's screens, dashboard-member (screen audit, member items 1 to 7, and the labels).
 *
 * What was wrong, and what each block holds:
 * (1) Enrollment's Retry called enroll again (409 forever) and started a second run beside the one the re-render
 *     started. It now resumes from the device's phase: it waits for a compile still running, and does not prove a
 *     registration that already landed.
 * (2) The Dashboard showed a hard-coded $1,500 deductible and $5,000 out-of-pocket maximum. It now reads the plan's
 *     limits from the device's GET /plan/limits, with the session, and shows no maximum when it cannot tell.
 * (3) The attestation card read att.expiry, att.signature and att.nonce; the sequencer signs exp (Unix seconds),
 *     sig and n, so the card showed "--" everywhere.
 * (4) The claim card labelled the recorded ingredient cost "NADAC", whatever it was (the pharmacy's own number, or AWP
 *     x quantity). With NADAC pricing a claim shows NADAC per unit x quantity = ingredient, plus the fee; a claim
 *     recorded before it shows its ingredient cost as "Ingredient".
 * (5) The Backup tab still offered the old PIN-encrypted Recovery Backup panel, and the Restore screen wrote the
 *     real enrollment key to localStorage (rule I3) from the old PBKDF2 format. Restore now recovers through the
 *     device's /onboarding/recover, and boot purges any key an old Restore left behind.
 * (6) Remove PCP sent no device session (401) yet said "PCP removed".
 * (7) Parallel 401s each raised a PIN prompt, and each answer voided the session the last one issued: one relock
 *     prompt at a time now.
 * Labels: the completion screen named an "Adjuda-GATOR network", and the Write to NFC button posted to an
 *     operator-only bridge route the member app cannot call; it is hidden.
 *
 * The app is plain browser JS in one IIFE, so these tests cut single functions out of app.js by name and run them
 * with the few things they touch stubbed: what each one sends, and what each one shows.
 */
import fs from 'fs';
import { SequencerAttestationAuthority } from '../src/credentials/nfc-attestation.js';

const APP = fs.readFileSync('dashboard-member/app.js', 'utf8').replace(/\r\n/g, '\n');
const HTML = fs.readFileSync('dashboard-member/index.html', 'utf8').replace(/\r\n/g, '\n');
const ORIGIN = 'http://device.test';
const WALLET = '42';

/** The source from `start` through the brace that closes the first block opened after it. */
function balanced(start: number): string {
  if (start < 0) throw new Error('not found in app.js');
  let depth = 0;
  for (let i = APP.indexOf('{', start); i < APP.length; i++) {
    if (APP[i] === '{') depth++;
    else if (APP[i] === '}' && --depth === 0) return APP.slice(start, i + 1);
  }
  throw new Error('unbalanced braces in app.js');
}

/** One named function from app.js, with its `async` when it has one. */
function fn(name: string): string {
  const at = APP.indexOf(`function ${name}(`);
  if (at < 0) throw new Error(`app.js has no function ${name}`);
  return balanced(APP.slice(at - 6, at) === 'async ' ? at - 6 : at);
}

/** Runs pieces of app.js with `scope` as their free variables and returns the value of `ret`. */
function load(pieces: string[], scope: Record<string, unknown>, ret: string): any {
  const names = Object.keys(scope);
  return new Function(...names, `'use strict';\n${pieces.join('\n')}\nreturn ${ret};`)(...names.map((n) => scope[n]));
}

const HELPERS = ['errMsg', 'shortHash', 'fmtTime', 'fmtDate', 'fmtCents', 'esc'].map(fn);
const immediately = (f: () => void): void => f();
const quiet = { log() {}, warn() {}, error() {} };
type Call = { path: string; init: any };

/** A fetch that answers by path and records each call. */
function fakeFetch(routes: Record<string, (init: any) => { status?: number; body: unknown }>, calls: Call[]) {
  return async (url: string, init: any = {}) => {
    const path = new URL(url).pathname;
    calls.push({ path, init });
    const answer = routes[path] ? routes[path](init) : { status: 404, body: { ok: false, error: 'Not found' } };
    const status = answer.status ?? 200;
    return { status, ok: status < 400, json: async () => answer.body };
  };
}

describe('(1) enrollment resumes from the device phase instead of enrolling again', () => {
  const run = async (phases: string[], receipts: unknown[], compileStatus: number) => {
    const calls: Call[] = [];
    const queue = [...phases];
    const onboardState = { statusMessage: '', error: '', recoveryPin: '', recoveryCards: [{ id: 'card-a' }], walletId: WALLET };
    const app = load([...HELPERS, fn('devicePhase'), fn('waitUntilCompiled'), fn('enrollmentStepsFrom'), fn('completeEnrollment')], {
      fetch: fakeFetch({
        '/onboarding/status': () => ({ body: { ok: true, data: { phase: queue.length > 1 ? queue.shift() : queue[0] } } }),
        '/onboarding/enroll': () => ({ status: 409, body: { ok: false, error: 'Cannot enroll in phase: enrolled' } }),
        '/onboarding/compile': () => (compileStatus === 504
          ? { status: 504, body: { ok: false, error: 'Request timeout' } }
          : { body: { ok: true, data: { phase: 'ready' } } }),
        '/proof/registration': () => ({ body: { ok: true, data: { receiptId: 'r-1' } } }),
      }, calls),
      location: { origin: ORIGIN }, setTimeout: immediately, console: quiet,
      RPC: { deviceHeaders: () => ({ 'X-Device-Session': 's' }), getReceiptsByWallet: async () => receipts },
      $: () => null, onboardState, onboardStep: 5, renderOnboardStep: () => undefined, onProofSubmitted: () => undefined,
    }, '{ run: completeEnrollment, step: function () { return onboardStep; } }');
    await app.run();
    return { paths: calls.map((c) => c.path), step: app.step(), onboardState };
  };

  test('each phase maps to the steps still to run', () => {
    const steps = load([fn('enrollmentStepsFrom')], {}, 'enrollmentStepsFrom');
    expect(steps('wallet_derived')).toEqual(['enroll', 'compile', 'register']);
    expect(steps('enrolled')).toEqual(['compile', 'register']);
    expect(steps('compiling')).toEqual(['wait-compile', 'register']);
    expect(steps('ready')).toEqual(['check-registered', 'register']);
    expect(steps('awaiting_token')).toEqual([]);
  });

  test('after a compile that answered 504, Retry waits for it and proves, and never calls enroll', async () => {
    const r = await run(['enrolled', 'compiling', 'ready'], [], 504);
    expect(r.paths).toEqual(['/onboarding/status', '/onboarding/compile', '/onboarding/status', '/onboarding/status', '/proof/registration']);
    expect(r.onboardState.error).toBe('');
    expect(r.step).toBe(6);
    expect(r.onboardState.recoveryCards).toEqual([{ id: 'card-a' }]); // the cards from the first attempt survive
  });

  test('at phase ready, a registration that already landed is not proved again', async () => {
    const r = await run(['ready'], [{ receiptId: 'r-0' }], 200);
    expect(r.paths).toEqual(['/onboarding/status']);
    expect(r.step).toBe(6);
  });

  test('the Retry button starts one run, not two', () => {
    const retry = balanced(APP.indexOf("$('ob-retry').addEventListener"));
    expect(retry).toMatch(/renderOnboardStep\(\)/);
    expect(retry).not.toMatch(/completeEnrollment\(/);
  });
});

describe("(2) the Dashboard shows the member's own plan limits", () => {
  const spendHero = async (limits: { status?: number; body: unknown }) => {
    const calls: Call[] = [];
    const container = { innerHTML: '' };
    const loadSpendHero = load([...HELPERS, fn('progressClass'), fn('loadPlanLimits'), fn('loadSpendHero')], {
      fetch: fakeFetch({ '/plan/limits': () => limits }, calls),
      location: { origin: ORIGIN }, walletId: WALLET, planSpendCache: null,
      RPC: {
        deviceHeaders: () => ({ 'X-Device-Session': 's' }),
        reconstructAccumulator: async () => ({ deductiblePaidCents: '5000', oopPaidCents: '5000', benefitUsedCents: '0' }),
      },
    }, 'loadSpendHero');
    await loadSpendHero(container);
    return { html: container.innerHTML, calls };
  };

  test("the maximums are the plan's, read from the device with its session", async () => {
    const { html, calls } = await spendHero({ body: { ok: true, data: { deductibleAmountCents: 25000, oopMaxCents: 300000, annualBenefitMaxCents: 0 } } });
    expect(html).toContain('of $250.00');
    expect(html).toContain('of $3000.00');
    expect(html).not.toMatch(/\$1500\.00|\$5000\.00/);
    expect(calls.map((c) => c.path)).toEqual(['/plan/limits']);
    expect(calls[0].init.headers['X-Device-Session']).toBe('s');
  });

  test('a device that cannot tell shows no maximum rather than an invented one', async () => {
    const { html } = await spendHero({ status: 404, body: { ok: false, error: 'This device holds no redeemed plan' } });
    expect(html).toContain('$50.00');
    expect(html).not.toContain('spend-max');
  });

  test('no hard-coded limits are left in the app', () => {
    expect(APP).not.toMatch(/150000|500000/);
  });
});

describe('(3) the attestation card reads the fields the sequencer signs', () => {
  test('expiry, signature and nonce show their values', () => {
    const att = new SequencerAttestationAuthority().createAttestation({
      walletId: WALLET, credentialCommitment: '1', lifecycleState: 3, forestRoot: '2', expirySeconds: 86400,
    });
    const html: string = load([...HELPERS, fn('attestationCardHtml')], {}, 'attestationCardHtml')(att);
    expect(html).toContain(att.sig.slice(0, 8));
    expect(html).toContain(att.n);
    // exp is Unix seconds: read as milliseconds, the card would show 1970.
    const expires = /Expires: ([^<]*)</.exec(html)?.[1] ?? '';
    expect(expires).toContain(String(new Date(att.exp * 1000).getFullYear()));
    expect(expires).not.toContain('1970');
    expect(html).not.toMatch(/(Expires|Signature|Nonce): --/);
  });
});

describe('(5) no stale backup, and Restore recovers through the device', () => {
  test('the Backup tab has no PIN-encrypted Recovery Backup panel', () => {
    expect(HTML).not.toMatch(/backup-create-btn|Recovery Backup/);
    expect(APP).not.toContain('backup-create-btn');
  });

  test('nothing writes the enrollment key to browser storage, and boot purges an old one', () => {
    expect(APP).not.toMatch(/lsSet\(LS\.ENROLL_KEY/);
    expect(APP).not.toContain('PBKDF2');
    expect(fn('boot')).toContain('lsRemove(LS.ENROLL_KEY)');
  });

  test('Restore unlocks, recovers through /onboarding/recover, compiles, and stores only the wallet ID', async () => {
    const els: Record<string, any> = {};
    const $ = (id: string) => (els[id] = els[id] ?? {
      value: '', innerHTML: '', on: {} as Record<string, () => Promise<void>>,
      addEventListener(type: string, f: () => Promise<void>) { this.on[type] = f; },
    });
    const typed: Record<string, string> = {
      'restore-device-pin': '864209', 'restore-device-pin-confirm': '864209',
      'restore-json': JSON.stringify({ v: 3, id: '0123456789abcdef', s: 'ab'.repeat(16) }),
      'restore-pin': '246813', 'restore-cid': 'E2E-1', 'restore-fn': 'Avery', 'restore-ln': 'Quillfeather', 'restore-dob': '19870412',
    };
    for (const [id, v] of Object.entries(typed)) $(id).value = v;
    const calls: Call[] = [];
    const stored: Array<[string, string]> = [];
    let session = '';
    let entered = false;
    const app = load([...HELPERS, fn('devicePhase'), fn('waitUntilCompiled'), fn('setupRestore')], {
      $, location: { origin: ORIGIN }, setTimeout: immediately,
      fetch: fakeFetch({
        '/onboarding/unlock': () => ({ body: { ok: true, data: { deviceSession: 'sess-1' } } }),
        '/onboarding/recover': () => ({ body: { ok: true, data: { phase: 'enrolled', walletId: '777' } } }),
        '/onboarding/status': () => ({ body: { ok: true, data: { phase: 'enrolled' } } }),
        '/onboarding/compile': () => ({ body: { ok: true, data: { phase: 'ready' } } }),
      }, calls),
      RPC: {
        setDeviceSession: (t: string) => { session = t; },
        deviceHeaders: () => ({ 'Content-Type': 'application/json', 'X-Device-Session': session }),
      },
      LS: { WALLET_ID: 'zkt_walletId', ENROLL_KEY: 'zkt_enrollmentKey' },
      lsSet: (k: string, v: string) => { stored.push([k, v]); },
      toast: () => undefined, logSystem: () => undefined, showScreen: () => undefined,
      enterApp: () => { entered = true; }, walletId: '',
    }, '{ setupRestore: setupRestore }');
    app.setupRestore();
    await els['restore-submit-btn'].on.click();
    expect(calls.map((c) => c.path)).toEqual(['/onboarding/unlock', '/onboarding/recover', '/onboarding/status', '/onboarding/compile']);
    expect(JSON.parse(calls[0].init.body)).toEqual({ pin: '864209' });
    expect(JSON.parse(calls[1].init.body)).toMatchObject({
      card: { v: 3, id: '0123456789abcdef' }, recoveryPin: '246813',
      cardholderId: 'E2E-1', firstName: 'Avery', lastName: 'Quillfeather', dateOfBirth: '19870412',
    });
    expect(calls[1].init.headers['X-Device-Session']).toBe('sess-1');
    expect(stored).toEqual([['zkt_walletId', '777']]);
    expect(entered).toBe(true);
    // The card, both PINs and the identity fields are cleared once recovered.
    for (const id of Object.keys(typed)) expect(els[id].value).toBe('');
  });
});

describe('(6) Remove PCP sends the device session and reports failure honestly', () => {
  const remove = async (status: number, body: unknown) => {
    const calls: Call[] = [];
    const toasts: Array<[string, string]> = [];
    const win: Record<string, () => Promise<void>> = {};
    load([...HELPERS, balanced(APP.indexOf('window._removePcp = ')) + ';'], {
      window: win, location: { origin: ORIGIN }, console: quiet,
      fetch: fakeFetch({ '/pcp/current': () => ({ status, body }) }, calls),
      RPC: { deviceHeaders: () => ({ 'Content-Type': 'application/json', 'X-Device-Session': 's' }) },
      toast: (msg: string, type: string) => { toasts.push([msg, type]); },
      logSystem: () => undefined, loadProviders: () => undefined, pcpData: { walletId: '9' },
    }, 'null');
    await win._removePcp();
    return { calls, toasts };
  };

  test('the DELETE carries the device session', async () => {
    const { calls, toasts } = await remove(200, { ok: true, data: { removed: true } });
    expect(calls[0].path).toBe('/pcp/current');
    expect(calls[0].init.method).toBe('DELETE');
    expect(calls[0].init.headers?.['X-Device-Session']).toBe('s');
    expect(toasts).toEqual([[expect.stringMatching(/removed/i), 'info']]);
  });

  test('a refusal is reported as a failure, never as removed', async () => {
    const { toasts } = await remove(401, { ok: false, error: 'This device is locked. Unlock with your PIN to obtain a device session.' });
    expect(toasts).toEqual([[expect.stringMatching(/failed.*locked/i), 'error']]);
  });
});

describe('(7) one relock prompt at a time', () => {
  test('parallel 401s raise one PIN prompt, and the next expiry after it raises another', async () => {
    let handler: () => void = () => undefined;
    const prompts: string[] = [];
    let answer: (ok: boolean) => void = () => undefined;
    const block = balanced(APP.indexOf('var relockOpen = false;')) + ');';
    load([block], {
      RPC: { setDeviceLockedHandler: (f: () => void) => { handler = f; } },
      unlockThenEnter: (reason: string) => { prompts.push(reason); return new Promise<boolean>((resolve) => { answer = resolve; }); },
    }, 'null');
    handler();
    handler();
    handler();
    expect(prompts).toEqual(['Your device session expired.']);
    answer(true);
    await new Promise((resolve) => setImmediate(resolve));
    handler();
    expect(prompts).toHaveLength(2);
  });
});

describe('(4) the claim card labels the ingredient cost as what it is', () => {
  const render = (claims: unknown[]): string => load([...HELPERS, fn('nadacUnit'), fn('renderClaimCards')], {}, 'renderClaimCards')(claims);

  test('a claim recorded before NADAC pricing reads "Ingredient", not NADAC', () => {
    const html = render([{
      leaf: { operationType: '1', patientPayCents: '1300', planPayCents: '0' },
      metadata: { brandName: 'Lisinopril', ingredientCostCents: 0, dispensingFeeCents: 1300, totalDrugCostCents: 1300 },
    }]);
    expect(html).toContain('Ingredient $0.00');
    expect(html).toContain('Fee $13.00');
    expect(html).not.toMatch(/NADAC/);
  });

  test('a NADAC-priced claim shows NADAC per unit x quantity = ingredient, plus the fee', () => {
    const html = render([{
      leaf: { operationType: '1', patientPayCents: '3051', planPayCents: '0' },
      metadata: {
        brandName: 'Abacavir', ingredientCostCents: 1801, dispensingFeeCents: 1250, totalDrugCostCents: 3051, quantityDispensed: 30,
        pricingBasis: 'NADAC', nadacUnitPriceE5: 60042, pricingUnit: 'EA', dispensingFeeSource: 'plan',
      },
    }]);
    expect(html).toContain('Drug Cost:</span> $30.51');
    expect(html).toContain('(NADAC $0.60042/EA &times; 30 = $18.01 + Fee $12.50)');
  });
});

describe('(8) the drug catalog promises no estimate a prescriber cannot show', () => {
  // Review of the pricing fixes (F1): the catalog said the member's share "your prescriber's estimate shows it", but a
  // prescriber's screen cannot read the member's own quote (the sequencer answers it to the member, the plan, or a
  // caller holding the member's tap, and the prescriber app has no tap), so that estimate never appeared.
  test('the catalog note says what the share depends on, and names no prescriber estimate', () => {
    const containers: Record<string, { innerHTML: string }> = {};
    const $ = (id: string) => (containers[id] = containers[id] ?? { innerHTML: '' });
    const render = load([...HELPERS, fn('tierBadge'), fn('renderFormularyTable')], { $ }, 'renderFormularyTable');
    render([{ brandName: 'ABACAVIR', strength: '300 MG', tierLevel: 1, nadacPerUnit: 0.60042, pricingUnit: 'EA', dosageForm: 'TABLET', maxDaySupply: 90 }], 1, 0, false);
    const html = containers['formulary-table'].innerHTML;
    expect(html).toContain('$18.01 (30 EA)');
    expect(html).toContain('what you pay depends on your plan\'s copay and your deductible');
    expect(html).not.toMatch(/prescriber/i);                          // before: "your prescriber's estimate shows it"
  });
});

describe('labels the demo shows', () => {
  test('the completion screen names no "Adjuda-GATOR network", and says what stayed on the phone', () => {
    expect(APP).not.toContain('registered on the Adjuda-GATOR network');
    expect(APP).toContain('Your wallet is registered on the network. Your name and birth date stayed on this phone.');
  });

  test('the Write to NFC button, which needs the operator\'s bridge route, is hidden', () => {
    const tag = HTML.match(/<button[^>]*id="nfc-write-btn"[^>]*>/)?.[0] ?? '';
    expect(tag).not.toBe('');
    expect(tag).toMatch(/style="display:none"/);
  });
});
