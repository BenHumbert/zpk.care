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
 * A node's signed call to the sequencer — plan item A9 (remainder), finding A-14.
 *
 * The signer is the node's own key (`NautilusAppServer.sequencerAuthHeaders`); the signature covers
 * the HTTP method, the URL's path and the exact body string sent, which is what the sequencer
 * verifies and then authorises by the node's role. A node that has no key sends no credential and
 * is refused anything privileged, which is the correct answer for a process nobody keyed.
 */

export type SequencerSigner = (method: string, path: string, body?: string) => Record<string, string>;

export interface SignedFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export function signedFetch(sign: SequencerSigner, url: string, init: SignedFetchInit = {}): Promise<Response> {
  const method = (init.method ?? 'GET').toUpperCase();
  const path = new URL(url).pathname;
  const headers = { ...(init.headers ?? {}), ...sign(method, path, init.body) };
  return fetch(url, { method, headers, body: init.body, signal: init.signal });
}

// ─── Proving requests while the engine starts ──────────────────────────────────

/** How long a provider node's job keeps sending a proving request again while the engine starts its provers. */
export const ENGINE_STARTING_WINDOW_MS = 10 * 60_000;

/** The wait before the next try when the engine's 503 names no Retry-After it can read. */
export const ENGINE_STARTING_DEFAULT_WAIT_MS = 10_000;

/** The shortest wait between tries, whatever the Retry-After says, so a zero never turns into a tight loop. */
const ENGINE_STARTING_MIN_WAIT_MS = 1_000;

/** A Retry-After header in milliseconds: delay-seconds, or an HTTP date from `now`; null when absent or unreadable. */
export function retryAfterMs(header: string | null | undefined, now: number = Date.now()): number | null {
  if (header === null || header === undefined) return null;
  const value = header.trim();
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

export interface EngineStartingRetryOptions {
  /** The overall window, from the first try: ENGINE_STARTING_WINDOW_MS. */
  windowMs?: number;
  /** Told of each wait as it starts: its length and the number of the try that follows it. */
  onWait?: (waitMs: number, nextTry: number) => void;
  /** The clock and the timer, for tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * A provider node's request to an engine route that makes proofs, sent again while the engine is still starting its
 * provers. Until its programs are compiled and its proof pool runs (minutes after boot; GET /interactive/ready says
 * when) the engine answers such a request 503 with Retry-After, before it changes anything. Each 503 is waited out for
 * the Retry-After it names and the request is sent again, signed afresh by `send`. The first answer that is not a 503
 * is returned at once, so a refusal or a failure still fails the job; once the next try would start after the window,
 * the last 503 is returned. A request that cannot reach the engine throws, as fetch does.
 */
export async function sendWhileEngineStarts(send: () => Promise<Response>, opts: EngineStartingRetryOptions = {}): Promise<Response> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + (opts.windowMs ?? ENGINE_STARTING_WINDOW_MS);
  for (let tries = 1; ; tries++) {
    const resp = await send();
    if (resp.status !== 503) return resp;
    const named = retryAfterMs(resp.headers.get('Retry-After'), now());
    const waitMs = Math.max(ENGINE_STARTING_MIN_WAIT_MS, named ?? ENGINE_STARTING_DEFAULT_WAIT_MS);
    if (now() + waitMs > deadline) return resp;
    await resp.body?.cancel().catch(() => undefined);
    opts.onWait?.(waitMs, tries + 1);
    await sleep(waitMs);
  }
}
