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
 * L2Client JSON-RPC ids are unique per call, so two identical signed calls never share a signature (the root
 * cause the reviewer named behind pharmacy item 1).
 *
 * What was wrong: rpcCall used Date.now() as the request id, the id is part of the signed body, and the signature
 * timestamp is Date.now() too. Ed25519 is deterministic, so two identical calls built in the same millisecond
 * carried byte-identical signatures, and the sequencer's replay cache refused the second one. Now the id is the
 * time in milliseconds times 1000 plus a rolling counter (nextRpcId in src/l2/l2-client.ts).
 *
 * The client talks to a tiny local HTTP server that records each request; the clock is pinned while the two
 * requests are built, so they are built in the same millisecond.
 */
import http from 'http';
import type { AddressInfo } from 'net';
import { L2Client } from '../src/l2/l2-client.js';
import { deriveWalletSigningKey, walletSigner } from '../src/security/wallet-key.js';
import { ReplayCache, verifySignedRequest } from '../src/security/signed-request.js';

const EK = 'ek-rpc-ids-' + 'e'.repeat(32);
const WALLET = '1001';
const NOW = 1_760_000_000_000;

let server: http.Server;
let url: string;
const seen: Array<{ body: string; headers: http.IncomingHttpHeaders }> = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      seen.push({ body: raw, headers: req.headers });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: (JSON.parse(raw) as { id: unknown }).id, result: null }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

test('two identical signed calls built in the same millisecond carry different ids, so the replay cache takes both', async () => {
  const client = new L2Client({ sequencerUrl: url });
  const signer = walletSigner(EK, WALLET);
  // Each call builds its body and signature synchronously, before its first await; both are built at NOW.
  const clock = jest.spyOn(Date, 'now').mockReturnValue(NOW);
  let pending: Array<Promise<unknown>>;
  try {
    pending = [client.getReceipt('r-1', signer), client.getReceipt('r-1', signer)];
  } finally {
    clock.mockRestore();
  }
  await Promise.all(pending);

  expect(seen).toHaveLength(2);
  const [a, b] = seen.map((s) => JSON.parse(s.body) as { id: number; method: string; params: unknown });
  expect([a.method, b.method]).toEqual(['l2_getReceipt', 'l2_getReceipt']);
  expect(a.params).toEqual(b.params);
  expect(a.id).not.toBe(b.id);
  for (const id of [a.id, b.id]) expect(Number.isSafeInteger(id)).toBe(true); // JSON carries it exactly

  // Same signer, same millisecond, different bytes: the signatures differ.
  const sigs = seen.map((s) => String(s.headers['x-admin-signature']));
  expect(sigs.map((s) => s.split(':').slice(0, 2).join(':'))).toEqual([`${WALLET}:${NOW}`, `${WALLET}:${NOW}`]);
  expect(sigs[0]).not.toBe(sigs[1]);

  // What the sequencer does with them: verify each against the wallet's key through one replay cache.
  const replayCache = new ReplayCache();
  const { publicKeyHex } = deriveWalletSigningKey(EK);
  for (const s of seen) {
    expect(verifySignedRequest({
      method: 'POST', path: '/rpc', headers: s.headers, expectedSignerId: WALLET, publicKeyHex, body: s.body, now: NOW, replayCache,
    })).toMatchObject({ ok: true });
  }
});
