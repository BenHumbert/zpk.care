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
 * The operator's credential for the interactive console — plan item B1, first half.
 *
 * Since item A11 the sequencer's `/interactive/*` routes that read or change member state require
 * the network operator's admin token, and this console sent nothing, so it went blank. This page
 * is the operator's tool, so it carries the operator's token: entered once, kept in this browser's
 * localStorage the way the employer dashboard keeps its own, and attached to every request this
 * page makes to an `/interactive/` path. The sequencer decides which routes need it.
 *
 * This is installed as a scoped wrapper around `fetch`, in one place, rather than edited into the
 * sixty-odd call sites across the console: an interceptor is the ordinary way an app attaches a
 * credential, and one implementation is one thing to review. It touches only requests whose path
 * starts with `/interactive/`, `/node/` or `/viz/` — the engine's console, its mirror of the
 * sequencer's reads, and the entity list behind the pictures, all of which answer a credential since
 * D1 and D2.
 */

const STORAGE_KEY = 'zkt_operator_token';

export function getOperatorToken() {
  try { return localStorage.getItem(STORAGE_KEY) || ''; } catch { return ''; }
}

export function setOperatorToken(token) {
  try {
    if (token) localStorage.setItem(STORAGE_KEY, token);
    else localStorage.removeItem(STORAGE_KEY);
  } catch { /* storage unavailable: the token lives for this page load only */ }
  memoryToken = token || '';
}

export function clearOperatorToken() { setOperatorToken(''); }

let memoryToken = getOperatorToken();
let prompting = null;

/** Ask once, even when several requests fail together. Returns the token or '' if declined. */
function askForToken() {
  if (prompting) return prompting;
  prompting = Promise.resolve().then(() => {
    const entered = window.prompt(
      'This console reads member state as the network operator.\n' +
      'Paste the operator token (ZKTRIDENT_ADMIN_TOKEN of this network). It is kept in this browser only.',
    );
    prompting = null;
    const token = (entered || '').trim();
    if (token) setOperatorToken(token);
    return token;
  });
  return prompting;
}

function isInteractiveRequest(input) {
  try {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const p = new URL(url, location.href).pathname;
    return p.startsWith('/interactive/') || p.startsWith('/node/') || p.startsWith('/viz/');
  } catch {
    return false;
  }
}

function withAuth(init, token) {
  const headers = new Headers((init && init.headers) || {});
  if (token && !headers.has('Authorization')) headers.set('Authorization', 'Bearer ' + token);
  return { ...(init || {}), headers };
}

/** D2: an EventSource cannot carry a header, so a stream URL carries the token as ?token=. */
export function withOperatorToken(url) {
  const token = memoryToken || getOperatorToken();
  if (!token) return url;
  return url + (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token);
}

/** Install the wrapper. Idempotent. */
export function installOperatorAuth() {
  if (window.__zktOperatorAuthInstalled) return;
  window.__zktOperatorAuthInstalled = true;
  const realFetch = window.fetch.bind(window);
  window.fetch = async function operatorFetch(input, init) {
    if (!isInteractiveRequest(input)) return realFetch(input, init);
    const token = memoryToken || getOperatorToken();
    let res = await realFetch(input, withAuth(init, token));
    if (res.status !== 401) return res;
    // Either no token yet or a stale one. Ask once, then retry once.
    const fresh = await askForToken();
    if (!fresh) return res;
    res = await realFetch(input, withAuth(init, fresh));
    return res;
  };
}

installOperatorAuth();
