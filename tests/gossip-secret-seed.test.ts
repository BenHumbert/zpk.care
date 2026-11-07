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
 * The gossip secret seeds the NFC attestation key only when it is 32 bytes of hex (finding A-149).
 *
 * What was wrong: the sequencer seeds its NFC attestation key with ZKTRIDENT_GOSSIP_SECRET, hex-decoded.
 * Buffer.from(x, 'hex') stops at the first character that is not hex, and an empty Buffer is still a seed, so any
 * secret that is not hex (the example file's placeholder, a base64 or text secret) seeded the key with nothing, and
 * every such network signed with one key anyone could recompute: SHA-256 of no bytes. An attestation made with it
 * passes for any member's, and an attestation is one of the read gate's ways into that member's claims and receipts.
 * The secret is otherwise only the gossip HMAC's key, which uses the whole string, so nothing looked wrong.
 *
 * What is true now: a gossip secret must be 64 hex characters. The node refuses any other seed, and the launcher
 * refuses to start with one, before anything starts. An empty or unset secret still means a random key per boot.
 */
import { spawnSync } from 'child_process';
import path from 'path';
import { Field, MerkleTree } from 'o1js';
import { L2Node, attestationSeedError } from '../src/l2/l2-node.js';
import { InMemoryStore } from '../src/storage/local-store.js';
import { WALLET_TREE_HEIGHT } from '../src/wallets/wallet-state.js';

jest.setTimeout(120_000);

const EMPTY_ROOT = new MerkleTree(WALLET_TREE_HEIGHT).getRoot();
const node = (): L2Node =>
  new L2Node(
    { batchIntervalMs: 999_999, autoSettle: false, settlementDelayMs: 0, maxBatchRetries: 0, l2Only: true },
    new InMemoryStore(),
    EMPTY_ROOT,
    EMPTY_ROOT,
    Field(0),
  );

const HEX_A = 'a1'.repeat(32);
const HEX_B = 'B2'.repeat(32);

describe('the gossip secret as the attestation seed', () => {
  test('takes 32 bytes of hex, and nothing else', () => {
    expect(attestationSeedError(HEX_A)).toBeNull();
    expect(attestationSeedError(HEX_B)).toBeNull();
    for (const bad of [
      'replace-with-64-hex',
      'c2VjcmV0LXNlY3JldC1zZWNyZXQtc2VjcmV0LXNlY3JldC0xMjM0NQ==',
      'a1'.repeat(31),
      'a1'.repeat(33),
      'a1'.repeat(31) + 'zz',
      '',
    ]) {
      expect(attestationSeedError(bad)).toMatch(/64 hex characters/);
    }
  });

  test('a hex secret gives its own key, the same at every boot', async () => {
    const [a, a2, b] = [node(), node(), node()];
    await a.enableAttestations(HEX_A);
    await a2.enableAttestations(HEX_A);
    await b.enableAttestations(HEX_B);
    expect(a.getAttestationPublicKey()).toBe(a2.getAttestationPublicKey());
    expect(a.getAttestationPublicKey()).not.toBe(b.getAttestationPublicKey());
  });

  test('a secret that is not hex is refused, where two of them used to give one public key', async () => {
    for (const bad of ['replace-with-64-hex', 'a different secret, not hex at all']) {
      await expect(node().enableAttestations(bad)).rejects.toThrow(/64 hex characters/);
    }
  });

  test('no secret still means a random key', async () => {
    const [a, b] = [node(), node()];
    await a.enableAttestations();
    await b.enableAttestations();
    expect(a.getAttestationPublicKey()).not.toBeNull();
    expect(a.getAttestationPublicKey()).not.toBe(b.getAttestationPublicKey());
  });

  test('the launcher refuses to start with a secret that is not hex, before it starts anything', () => {
    const root = path.resolve(__dirname, '..');
    const run = spawnSync(process.execPath, ['--import', 'tsx', path.join(root, 'src', 'nodes', 'start-leviathan.ts')], {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        ZKTRIDENT_GOSSIP_SECRET: 'replace-with-64-hex',
        ZKTRIDENT_OPEN_BROWSERS: '0',
      },
      encoding: 'utf8',
      timeout: 100_000,
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/\[FATAL\] ZKTRIDENT_GOSSIP_SECRET must be 32 bytes written as 64 hex characters/);
  });
});
