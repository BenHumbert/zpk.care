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
 * A node's key routes — the key ceremony (owner, 2026-11-04).
 *
 *   GET  /keys/status   what the node's keys are doing: unlocked, or waiting for `threshold` key holders, with this
 *                       start's one-time key and its fingerprint. Nothing in it is secret.
 *   POST /keys/release  one holder's share, sealed to this start's one-time key and signed (scripts/keys/holder.ts
 *                       release). Open, like the door a holder walks up to: every release is checked before it is kept
 *                       (a holder in the record, signed, for this node, this start and the holder's slot), and refusals
 *                       from one address are limited.
 *
 * Provisioning happens once per machine; after it every restart opens the node's sealed master by itself (owner,
 * 2026-11-05), so a restarted node is unlocked before it answers these routes at all.
 */
import type { NautilusAppServer } from '../nautilus-app-server.js';
import type { RouteRegistration } from '../nautilus-app-types.js';
import type { NodeKeyring } from '../../keys/node-keyring.js';
import type { ShareRelease } from '../../keys/ceremony.js';
import { insurerPublicKeyFromSeed } from '../../onboarding/employer-attestation.js';
import { SlidingWindowLimiter } from '../../security/rate-limit.js';

const REFUSED_RELEASES_PER_SOURCE_PER_MINUTE = 20;

/**
 * Put a node's ceremony keys to work once it is unlocked. On the insurer that is its attestation signing seed: made from
 * the master, checked against the key the ceremony record publishes (and the sequencer pins), and never taken from the
 * operator's environment.
 */
export function attachNodeKeyring(server: NautilusAppServer, keyring: NodeKeyring): void {
  server.setKeyring(keyring);
  keyring.onUnlocked((k) => {
    if (server.getConfig().role !== 'insurer') return;
    const seed = k.insurerSigningSeed();
    const expected = k.publicKeys().insurerSigningPublicKeyHex;
    const derived = insurerPublicKeyFromSeed(seed);
    if (derived !== expected) {
      // cannot happen for a master that passed the record's check, since the record's signatures cover both; if it
      // does, the node signs nothing rather than sign as an insurer the sequencer does not pin
      console.error(`  [keys] REFUSED: the insurer key made from the master (${derived}) is not the one ceremony ${k.status().ceremonyId} names (${expected}); attestations stay unsigned`);
      return;
    }
    server.getConfig().insurerSigningSeed = seed;
  });
}

export function buildKeyRoutes(server: NautilusAppServer): RouteRegistration[] {
  const refusedPerSource = new SlidingWindowLimiter(REFUSED_RELEASES_PER_SOURCE_PER_MINUTE, 60_000);
  return [
    {
      method: 'GET',
      path: '/keys/status',
      handler: async (_req, res) => {
        const keyring = server.getKeyring();
        if (!keyring) return server.sendResponse(res, 404, false, undefined, 'This node has no key ceremony record.');
        server.sendResponse(res, 200, true, keyring.status());
      },
    },
    {
      method: 'POST',
      path: '/keys/release',
      handler: async (req, res, _params, _query, body) => {
        const keyring = server.getKeyring();
        if (!keyring) return server.sendResponse(res, 404, false, undefined, 'This node has no key ceremony record.');
        const source = server.callerKey(req);
        if (refusedPerSource.count(source) >= REFUSED_RELEASES_PER_SOURCE_PER_MINUTE) {
          res.setHeader('Retry-After', '60');
          return server.sendResponse(res, 429, false, undefined, 'Too many refused releases from this address in the last minute. Try again in a minute.');
        }
        const result = await keyring.acceptRelease(body as ShareRelease);
        if (!result.accepted) {
          const unavailable = result.status.state !== 'awaiting-shares';
          if (!unavailable) refusedPerSource.allow(source);
          return server.sendResponse(res, unavailable ? 409 : 400, false, undefined, result.reason ?? 'The release was refused.');
        }
        server.sendResponse(res, 200, true, result.status);
      },
    },
  ];
}
