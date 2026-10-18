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

export function signedFetch(sign: SequencerSigner, url: string, init: SignedFetchInit): Promise<Response> {
  const method = (init.method ?? 'GET').toUpperCase();
  const path = new URL(url).pathname;
  const headers = { ...(init.headers ?? {}), ...sign(method, path, init.body) };
  return fetch(url, { method, headers, body: init.body, signal: init.signal });
}
