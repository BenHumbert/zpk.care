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
 * The member app's step 4 (generate the key, redeem the code, derive the wallet) and its Start over, dashboard-member.
 *
 * What was wrong: step 4 ran generate-key, redeem and derive once, with no Retry. When the redeem failed (the insurer
 * could not reach the employer, say, which the device now answers 502 with "try again later"), the step showed the
 * error and stopped. Its key was made by then, so the device sat in phase key_generated, where accept-token answers 409,
 * and after a reload enrollment starts again at accept-token. The only way on was Start over, which erases the device,
 * and whose confirm said a new enrollment token was needed from the employer, which is false while the code was never
 * redeemed: the employer still holds it unused, and the same code and PIN enroll again.
 *
 * How it was found: the review of the enrollment relay fix (A-93), 2026-10-24.
 *
 * What is true now: step 4 runs what is left from the device's phase, as step 5 does: from token_received all three
 * parts, from key_generated the redeem and the derivation, from code_redeemed the derivation alone. A failure it can
 * resume from shows the error with a Retry, which starts one run from the phase the device is then in, so a redeem the
 * insurer could not answer is asked again without a second key. The insurer's refusal gets no Retry, since the same PIN
 * again would only spend one of the five wrong PINs the employer allows a code, and neither does a phase step 4 cannot
 * continue from. Start over's confirm says what erasing costs the code by the device's phase: nothing before the code
 * is redeemed, a new code once a wallet is enrolled with it, and possibly a new code in between, when the insurer still
 * answers the same code and PIN only while no wallet is enrolled with them.
 *
 * The app is plain browser JS in one IIFE, so these tests cut single functions out of app.js by name and run them with
 * the few things they touch stubbed: what each one sends, and what each one shows.
 *
 * The security review of the sweep fixes, 2026-10-24, found Start over's note still wrong in one case. It told a member
 * on a device in phase key_generated that the code had not been redeemed and the same code and PIN still work. But
 * key_generated is also where the device stays when the insurer refuses the code and PIN (a wrong PIN, a code locked
 * after five wrong ones, expired, revoked, already used, or one no employer recognizes), and that refusal is exactly
 * when step 4 offers no Retry and leaves Start over as the only way on. So a member whose code was refused was told it
 * still works.
 * What is true now: step 4 keeps the insurer's refusal, which it knows from the device's 403 to the redeem, as
 * onboardState.codeRefused, and Start over's note then says the insurer refused the code and PIN and a new code from HR
 * may be needed. With no refusal seen it still says the same code and PIN work, and a redeem the insurer could not check
 * (the device's 429 or 502) keeps its Retry and leaves the note as it was. The page knows that the insurer refused, not
 * why: the device answers every refusal 403 with the same words. In those tests step 4 runs against the stand-in device
 * below, whose phase stays key_generated after a 403 as the member node's does, and Start over's confirm is then raised
 * on that phase with the onboarding state step 4 left.
 *
 * The review of round ten of the security fixes, 2026-10-24, found the note promising the same code where round ten had
 * made that false. Round ten (A-108) has the device keep a secret from its first redemption of the code until the
 * insurer completes the code, and the insurer answer a repeat of the redemption only for that secret's commitment;
 * erasing the device destroys the secret. So when the insurer recorded a redemption whose answer never reached the
 * device (the reviewer's run had real nodes, and a proxy between the device and the insurer that dropped the answer),
 * the device answered 502 and stayed in key_generated, the page saw no 403, and Start over said the code had not been
 * redeemed and the same code and PIN would work. Retry would have finished with the code. After Start over the insurer
 * refuses the same code and PIN as already used, and the member must ask HR for a new code.
 * What is true now: step 4 notes that it sent a redeem (onboardState.redeemSent) as it sends one. With that note and no
 * refusal, Start over on a device in key_generated says the device sent the code without learning whether the insurer
 * recorded it, that only this device can then finish enrolling with it, so Retry is the way on, and that starting over
 * may mean asking HR for a new code. It says so whatever the device answered short of a 403 (its 502 for an answer that
 * never came, the insurer's 5xx or either of its 429s passed on, its own 5xx), when no answer came back to the page,
 * and while the redeem is still on its way. After a 403 it says what it said before, whatever step 4 sent first. A page
 * that sent no redeem cannot tell whether a device in key_generated sent one (after a reload, or from another tab), and
 * step 4 sends one as soon as the key is made, so the note then says one may have been sent and a new code may be
 * needed; it says the same in awaiting_token or token_received on a page whose redeem went to a device since erased.
 * The same code and PIN are promised only in those two phases, on a page that sent no redeem. Step 4's Retry is as it
 * was.
 */
import fs from 'fs';

const APP = fs.readFileSync('dashboard-member/app.js', 'utf8').replace(/\r\n/g, '\n');
const ORIGIN = 'http://device.test';
const WALLET = '42';
/** What the device answers when the insurer answered 5xx, when its per-network limit refused the device, and when it refused the code and PIN. */
const COULD_NOT_CHECK = 'The insurer could not check this enrollment code now. Try again later.';
const TOO_MANY_ATTEMPTS = 'Too many enrollment attempts came from this network. Try again in a minute.';
const REFUSED = 'The insurer did not accept this enrollment code and PIN.';
/**
 * What the device answers when the insurer's answer never reached it, when the insurer's limit on wrong attempts with the
 * code refused it, and when it failed itself after the insurer answered (its state could not be saved, say).
 */
const UNREACHABLE = 'Cannot reach the insurer to redeem the enrollment code. Try again later.';
const CODE_BLOCKED = 'This enrollment code has had too many wrong attempts in the last hour. Try again in an hour, or ask HR for a new code.';
const SAVE_FAILED = 'ENOSPC: no space left on device, write';

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

const HELPERS = ['errMsg', 'shortHash', 'esc'].map(fn);
const immediately = (f: () => void): void => f();
const quiet = { log() {}, warn() {}, error() {} };
type Call = { path: string; init: any };

type Reply = { status?: number; body: unknown };

/** A fetch that answers by path and records each call; a route that throws stands for a device that did not answer. */
function fakeFetch(routes: Record<string, (init: any) => Reply | Promise<Reply>>, calls: Call[]) {
  return async (url: string, init: any = {}) => {
    const path = new URL(url).pathname;
    calls.push({ path, init });
    const answer = routes[path] ? await routes[path](init) : { status: 404, body: { ok: false, error: 'Not found' } };
    const status = answer.status ?? 200;
    return { status, ok: status < 400, json: async () => answer.body };
  };
}

// ── Step 4 ──────────────────────────────────────────────────

/**
 * A device as step 4 drives it: its phase moves as each route answers, as the member node's does, and its redeem answers
 * as `redeem` says until the test changes it. A redeem `unanswered` is one the page sent and no answer came back to; while
 * `held` is set, the redeem is on its way and answers once it settles.
 */
function device(phase: string, redeem: { status: number; error?: string; unanswered?: boolean }) {
  const d = {
    phase,
    redeem,
    held: null as Promise<void> | null,
    calls: [] as Call[],
    fetch: null as unknown as ReturnType<typeof fakeFetch>,
  };
  d.fetch = fakeFetch({
    '/onboarding/status': () => ({ body: { ok: true, data: { phase: d.phase } } }),
    '/onboarding/generate-key': () => {
      if (d.phase !== 'token_received') return { status: 409, body: { ok: false, error: `Cannot generate key in phase: ${d.phase}` } };
      d.phase = 'key_generated';
      return { body: { ok: true, data: { phase: d.phase } } };
    },
    '/onboarding/redeem': async () => {
      if (d.held) await d.held;
      if (d.redeem.unanswered) throw new TypeError('Failed to fetch');
      if (d.redeem.status !== 200) return { status: d.redeem.status, body: { ok: false, error: d.redeem.error } };
      d.phase = 'code_redeemed';
      return { body: { ok: true, data: { phase: d.phase, groupIdHash: '11', planIdHash: '22' } } };
    },
    '/onboarding/derive-wallet': () => {
      d.phase = 'wallet_derived';
      return { body: { ok: true, data: { phase: d.phase, walletId: WALLET } } };
    },
  }, d.calls);
  return d;
}

/** Step 4's run, generateKeyAndWallet as app.js writes it, against `dev`, with the member's typed details. */
function stepFour(dev: ReturnType<typeof device>) {
  const onboardState = { enrollPIN: '48213970', cardholderId: 'CH-1', firstName: 'Ada', lastName: 'Lovelace', dob: '19900115', walletId: '', keyError: '', codeRefused: false, redeemSent: false };
  const seen = { renders: 0, toasts: [] as string[] };
  const app = load([...HELPERS, fn('devicePhase'), fn('keyStepsFrom'), fn('generateKeyAndWallet')], {
    fetch: dev.fetch, location: { origin: ORIGIN }, setTimeout: immediately, console: quiet,
    RPC: { deviceHeaders: () => ({ 'X-Device-Session': 's' }) },
    $: () => null, toast: (m: string) => { seen.toasts.push(m); },
    onboardState, onboardStep: 4, renderOnboardStep: () => { seen.renders++; },
  }, '{ run: generateKeyAndWallet, step: function () { return onboardStep; } }');
  /** The paths one run sent, from the first call after the runs before it. */
  const run = async (): Promise<string[]> => {
    const from = dev.calls.length;
    await app.run();
    return dev.calls.slice(from).map((c) => c.path);
  };
  return { run, step: () => app.step() as number, onboardState, seen };
}

describe('step 4 resumes from the device phase, and offers Retry when it can', () => {
  test('each phase maps to the parts of step 4 still to run', () => {
    const steps = load([fn('keyStepsFrom')], {}, 'keyStepsFrom');
    expect(steps('token_received')).toEqual(['generate-key', 'redeem', 'derive']);
    expect(steps('key_generated')).toEqual(['redeem', 'derive']);   // before: no such function; every run began with generate-key
    expect(steps('code_redeemed')).toEqual(['derive']);
    expect(steps('wallet_derived')).toEqual([]);
    expect(steps('awaiting_token')).toEqual([]);
  });

  test('a redeem the insurer could not check shows the error with a Retry, and Retry asks the insurer again and derives, without generating a second key', async () => {
    const dev = device('token_received', { status: 502, error: COULD_NOT_CHECK });
    const s = stepFour(dev);
    expect(await s.run()).toEqual(['/onboarding/status', '/onboarding/generate-key', '/onboarding/redeem']);   // before: no phase asked, ['/onboarding/generate-key', '/onboarding/redeem']
    expect(dev.phase).toBe('key_generated');
    expect(s.onboardState.keyError).toBe(COULD_NOT_CHECK);   // before: '', no Retry: the step showed the error and stopped
    expect(s.seen.renders).toBe(1);                           // before: 0
    expect(s.onboardState.codeRefused).toBe(false);           // the insurer could not check the code, which is no refusal of it
    // The insurer can check the code again. Retry clears the error, and the re-render starts the run.
    dev.redeem = { status: 200 };
    s.onboardState.keyError = '';
    expect(await s.run()).toEqual(['/onboarding/status', '/onboarding/redeem', '/onboarding/derive-wallet']);   // before: generate-key first, answered 409 in phase key_generated
    expect(s.onboardState.walletId).toBe(WALLET);
    expect(s.step()).toBe(5);
    // The details typed before the first run reached the derivation, and the app dropped them once it answered.
    expect(JSON.parse(dev.calls[dev.calls.length - 1].init.body)).toMatchObject({ cardholderId: 'CH-1', firstName: 'Ada', lastName: 'Lovelace', dateOfBirth: '19900115' });
    expect([s.onboardState.cardholderId, s.onboardState.dob]).toEqual(['', '']);
  });

  test('the insurer\'s refusal gets no Retry: the same PIN again would only spend one of the five wrong PINs the employer allows', async () => {
    const dev = device('token_received', { status: 403, error: REFUSED });
    const s = stepFour(dev);
    expect(await s.run()).toEqual(['/onboarding/status', '/onboarding/generate-key', '/onboarding/redeem']);   // before: no phase asked, ['/onboarding/generate-key', '/onboarding/redeem']
    expect([s.onboardState.keyError, s.seen.renders]).toEqual(['', 0]);
    expect(s.seen.toasts).toEqual([`Key/wallet derivation failed: ${REFUSED}`]);
    // The refusal is kept for Start over, and the device stays in key_generated, as it is when no redeem was ever sent.
    expect(s.onboardState.codeRefused).toBe(true);   // before: false, nothing kept the refusal
    expect(dev.phase).toBe('key_generated');
  });

  test('a device whose code is already redeemed runs the derivation alone, and the insurer is not asked again', async () => {
    const dev = device('code_redeemed', { status: 502, error: COULD_NOT_CHECK });
    const s = stepFour(dev);
    expect(await s.run()).toEqual(['/onboarding/status', '/onboarding/derive-wallet']);   // before: ['/onboarding/generate-key'], answered 409
    expect([s.onboardState.walletId, s.step()]).toEqual([WALLET, 5]);
  });

  test('a phase step 4 cannot continue from gets no Retry, and says to start over', async () => {
    const dev = device('awaiting_token', { status: 200 });
    const s = stepFour(dev);
    expect(await s.run()).toEqual(['/onboarding/status']);   // before: ['/onboarding/generate-key'], answered 409
    expect([s.onboardState.keyError, s.seen.renders]).toEqual(['', 0]);
    expect(s.seen.toasts).toEqual(['Key/wallet derivation failed: This device cannot continue enrollment from its current phase. Start over below.']);
  });

  test('step 4 drawn with an error shows it with a Retry and starts no run; Retry clears it and starts exactly one', () => {
    const byId: Record<string, any> = {};
    const $ = (id: string) => (byId[id] ??= {
      style: {}, textContent: '', innerHTML: '', listeners: {} as Record<string, () => void>,
      addEventListener(type: string, f: () => void) { this.listeners[type] = f; },
      insertAdjacentHTML(_where: string, html: string) { this.innerHTML += html; },
    });
    let runs = 0;
    const onboardState = { keyError: COULD_NOT_CHECK };
    const render = load([...HELPERS, fn('renderOnboardStep')], {
      $, setTimeout: immediately, onboardState, onboardStep: 4, ONBOARD_TOTAL_STEPS: 7,
      generateKeyAndWallet: () => { runs++; }, ejectLink: () => '', wireEjectLink: () => undefined,
    }, 'renderOnboardStep');
    render();
    const drawn = byId['onboard-body'].innerHTML as string;
    expect(drawn).toContain(`<div id="ob-keygen-msg">Error: ${COULD_NOT_CHECK}</div>`);   // before: "Generating cryptographic key...", the error gone with the redraw
    expect(drawn).toContain('id="ob-keygen-retry"');                                     // before: no Retry
    expect(runs).toBe(0);                                                                 // before: 1, every draw of step 4 started a run
    byId['ob-keygen-retry'].listeners.click();
    expect(onboardState.keyError).toBe('');
    expect(byId['onboard-body'].innerHTML).not.toContain('ob-keygen-retry');
    expect(runs).toBe(1);
  });
});

// ── Start over ──────────────────────────────────────────────

/**
 * The confirm Start over raises on a device in `phase` (or one that does not answer), declined; and what it sent. The
 * page's onboarding state is `onboardState`, as step 4 left it, and by default that of a page that has sent no redeem and
 * seen no refusal, as after a reload.
 */
async function startOverConfirm(
  phase: string | null,
  onboardState: { codeRefused: boolean; redeemSent: boolean } = { codeRefused: false, redeemSent: false },
): Promise<{ text: string; paths: string[] }> {
  const calls: Call[] = [];
  let text = '';
  const app = load([...HELPERS, fn('devicePhase'), fn('startOverCodeNote'), fn('ejectMember')], {
    fetch: phase === null
      ? async (url: string) => { calls.push({ path: new URL(url).pathname, init: {} }); throw new TypeError('Failed to fetch'); }
      : fakeFetch({ '/onboarding/status': () => ({ body: { ok: true, data: { phase } } }) }, calls),
    onboardState,
    location: { origin: ORIGIN }, console: quiet,
    RPC: { deviceHeaders: () => ({ 'X-Device-Session': 's' }) },
    confirm: (message: string) => { text = message; return false; },
    prompt: () => { throw new Error('the PIN is asked only once the member confirms'); },
  }, 'ejectMember');
  await app();
  return { text, paths: calls.map((c) => c.path) };
}

describe('Start over says what erasing costs the enrollment code, by the device phase', () => {
  const NOT_REDEEMED = 'Your enrollment code has not been redeemed, so you can start over with the same code and its PIN.';
  const MAY_NEED = 'This device already redeemed your enrollment code, so you may need a NEW one from your employer to start over.';
  const SPENT = 'You will need a NEW enrollment code from your employer to start over.';
  const REFUSED_NOTE = 'The insurer refused your enrollment code and PIN, so you may need a NEW code from HR to start over.';
  const UNANSWERED_NOTE = 'If this device already redeemed your enrollment code, you may need a NEW one from your employer to start over.';
  /** After a redeem step 4 sent whose outcome it cannot know, and on a page that cannot know whether the device sent one. */
  const SENT_NOTE = 'This device sent your enrollment code to the insurer without learning whether it was recorded. If it was, ' +
    'only this device can finish enrolling with it, so Retry is the way on: starting over may mean asking HR for a NEW code.';
  const MAY_HAVE_SENT = 'This device may already have sent your enrollment code to the insurer, so you may need a NEW code from HR to start over.';

  test('in awaiting_token and token_received, before the device makes its secret, on a page that sent no redeem and saw no refusal, it says the same code and PIN still work, and asks for no new code', async () => {
    for (const phase of ['awaiting_token', 'token_received']) {
      const { text } = await startOverConfirm(phase);
      expect([phase, text.includes(NOT_REDEEMED)]).toEqual([phase, true]);   // before: false, it said "You will need a NEW enrollment token from your employer to start over."
      expect([phase, /NEW/.test(text)]).toEqual([phase, false]);              // before: true
    }
  });

  test('a page that sent no redeem cannot tell whether a device in key_generated sent one, as after a reload or from another tab: the note says one may have been sent and a new code may be needed, not that the same code still works', async () => {
    const { text } = await startOverConfirm('key_generated');
    expect(text).toContain(MAY_HAVE_SENT);      // before: absent
    expect(text).not.toContain(NOT_REDEEMED);   // before: the same code and its PIN promised, which Start over makes false when the insurer recorded a redemption the device never heard answered
  });

  test('once the code is redeemed it may need a new one, and once a wallet is enrolled with it a new one is needed', async () => {
    for (const phase of ['code_redeemed', 'wallet_derived']) {
      expect([phase, (await startOverConfirm(phase)).text.includes(MAY_NEED)]).toEqual([phase, true]);   // before: false
    }
    for (const phase of ['enrolled', 'compiling', 'ready']) {
      expect([phase, (await startOverConfirm(phase)).text.includes(SPENT)]).toEqual([phase, true]);      // before: false, the same warning named a "token"
    }
  });

  test('a device that does not answer is still asked about, in words that say what the answer depends on', async () => {
    const { text } = await startOverConfirm(null);
    expect(text).toContain('If this device already redeemed your enrollment code, you may need a NEW one from your employer to start over.');   // before: the unconditional "You will need a NEW enrollment token..."
    expect(text).toContain('This will permanently erase all enrollment data on this device');
  });

  test('the confirm asks the device its phase and nothing else, and declining it erases nothing', async () => {
    expect((await startOverConfirm('key_generated')).paths).toEqual(['/onboarding/status']);   // before: [], the confirm asked nothing
  });

  test('after step 4 saw the insurer refuse the code and PIN, it says so and that a new code from HR may be needed, not that the same code still works', async () => {
    const dev = device('token_received', { status: 403, error: REFUSED });
    const s = stepFour(dev);
    await s.run();
    expect(dev.phase).toBe('key_generated');
    const { text } = await startOverConfirm(dev.phase, s.onboardState);
    expect(text).toContain(REFUSED_NOTE);       // before: absent, the note did not know of the refusal
    expect(text).not.toContain(NOT_REDEEMED);   // before: the same reassurance after a 403, that the same code and its PIN still work
  });

  test('a redeem whose outcome step 4 cannot know is no refusal: step 4 keeps its Retry, and Start over says the insurer may have recorded the code, that Retry is the way on and that starting over may mean a new code from HR, not that the same code still works', async () => {
    const outcomes: Array<[string, { status: number; error?: string; unanswered?: boolean }, string]> = [
      ['the insurer\'s answer never reached the device', { status: 502, error: UNREACHABLE }, UNREACHABLE],
      ['the insurer answered 5xx', { status: 502, error: COULD_NOT_CHECK }, COULD_NOT_CHECK],
      ['the insurer\'s limit on one network', { status: 429, error: TOO_MANY_ATTEMPTS }, TOO_MANY_ATTEMPTS],
      ['the insurer\'s limit on wrong attempts with the code', { status: 429, error: CODE_BLOCKED }, CODE_BLOCKED],
      ['the device failed after the insurer answered', { status: 500, error: SAVE_FAILED }, SAVE_FAILED],
      ['no answer came back to the page', { status: 0, unanswered: true }, 'Failed to fetch'],
    ];
    for (const [what, redeem, shown] of outcomes) {
      const dev = device('token_received', redeem);
      const s = stepFour(dev);
      await s.run();
      expect([what, dev.phase, s.onboardState.keyError, s.seen.renders, s.onboardState.codeRefused]).toEqual([what, 'key_generated', shown, 1, false]);
      expect([what, s.onboardState.redeemSent]).toEqual([what, true]);   // before: false, nothing kept that a redeem was sent
      const { text } = await startOverConfirm(dev.phase, s.onboardState);
      expect([what, text.includes(SENT_NOTE)]).toEqual([what, true]);       // before: false
      expect([what, text.includes(NOT_REDEEMED)]).toEqual([what, false]);   // before: true, the same code and its PIN promised, which erasing the device makes false once the insurer has recorded the redemption
      expect([what, text.includes(REFUSED_NOTE)]).toEqual([what, false]);
    }
  });

  test('a redeem still on its way counts as sent: Start over raised meanwhile says the insurer may have recorded the code, not that the same code still works', async () => {
    const dev = device('token_received', { status: 200 });
    let settle!: () => void;
    dev.held = new Promise<void>((resolve) => { settle = resolve; });
    const s = stepFour(dev);
    const running = s.run();
    for (let i = 0; i < 100 && !dev.calls.some((c) => c.path === '/onboarding/redeem'); i++) await new Promise((r) => setImmediate(r));
    expect(dev.phase).toBe('key_generated');
    const { text } = await startOverConfirm(dev.phase, s.onboardState);
    expect(text).toContain(SENT_NOTE);          // before: absent
    expect(text).not.toContain(NOT_REDEEMED);   // before: the same code and its PIN promised while the redeem was on its way
    settle();
    await running;
    expect([dev.phase, s.step()]).toEqual(['wallet_derived', 5]);
  });

  test('after a 403 it keeps the refusal\'s words, though an earlier redeem\'s answer never came', async () => {
    const dev = device('token_received', { status: 502, error: UNREACHABLE });
    const s = stepFour(dev);
    await s.run();
    // Retry, and this time the insurer refuses the code and PIN (revoked meanwhile, say).
    dev.redeem = { status: 403, error: REFUSED };
    s.onboardState.keyError = '';
    await s.run();
    expect([s.onboardState.codeRefused, s.onboardState.redeemSent]).toEqual([true, true]);   // before: [true, false]
    const { text } = await startOverConfirm(dev.phase, s.onboardState);
    expect(text).toContain(REFUSED_NOTE);
    expect(text).not.toContain(SENT_NOTE);
    expect(text).not.toContain(NOT_REDEEMED);
  });

  test('a refusal changes only the note for a code not yet redeemed; the notes for a redeemed or spent code stay as they were', () => {
    const note = load([fn('startOverCodeNote')], {}, 'startOverCodeNote');
    for (const phase of ['awaiting_token', 'token_received', 'key_generated']) {
      for (const sent of [false, true]) {
        expect([phase, sent, note(phase, true, sent)]).toEqual([phase, sent, REFUSED_NOTE]);   // before: NOT_REDEEMED, whatever step 4 saw
      }
    }
    for (const phase of ['awaiting_token', 'token_received']) {
      expect([phase, note(phase, false, false)]).toEqual([phase, NOT_REDEEMED]);
    }
    for (const [phase, said] of [['code_redeemed', MAY_NEED], ['wallet_derived', MAY_NEED], ['enrolled', SPENT], ['compiling', SPENT], ['ready', SPENT]]) {
      expect([phase, note(phase, true, false)]).toEqual([phase, said]);
    }
  });

  test('a redeem sent changes the note only before the code is redeemed: Retry\'s note in key_generated, and no promise of the same code wherever a redeem may have gone', () => {
    const note = load([fn('startOverCodeNote')], {}, 'startOverCodeNote');
    expect(note('key_generated', false, true)).toBe(SENT_NOTE);        // before: NOT_REDEEMED
    expect(note('key_generated', false, false)).toBe(MAY_HAVE_SENT);   // before: NOT_REDEEMED, though a page that sent no redeem cannot tell whether the device did
    for (const phase of ['awaiting_token', 'token_received']) {
      // A redeem this page sent to a device since erased from another tab: the insurer may hold that redemption, and the
      // secret that would have finished it is gone with the erase.
      expect([phase, note(phase, false, true)]).toEqual([phase, MAY_HAVE_SENT]);   // before: NOT_REDEEMED
    }
    for (const [phase, said] of [['code_redeemed', MAY_NEED], ['wallet_derived', MAY_NEED], ['enrolled', SPENT], ['compiling', SPENT], ['ready', SPENT], ['', UNANSWERED_NOTE]]) {
      expect([phase, note(phase, false, true)]).toEqual([phase, said]);
    }
  });
});
