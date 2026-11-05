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
 * Where the insurer's attestation key comes from at boot — the key ceremony (owner, 2026-11-04), A9.
 *
 * With a ceremony record (ZKTRIDENT_CEREMONY_RECORD), the sequencer pins the record as its trust anchor
 * (ceremony-anchor.ts) and pins the insurer key the record publishes; the insurer node is given the record's path,
 * not a seed, and makes its seed from the master the key holders provisioned and its machine keeps sealed. No seed
 * passes through this process or the environment, and it is the same after every restart, so the employer
 * attestations it signed stay valid.
 *
 * Without one (development, and every deployment before its ceremony), the old way: a seed from
 * ZKTRIDENT_INSURER_SIGNING_SEED or a random one per boot, handed to the insurer node, which invalidates the
 * attestations of a previous run.
 */
import path from 'path';
import { randomBytes } from 'crypto';
import { pinCeremonyRecord } from './ceremony-anchor.js';
import { insurerPublicKeyFromSeed } from '../onboarding/employer-attestation.js';

export interface InsurerKeyPlan {
  /** The key the sequencer pins when it verifies employer attestations. */
  insurerAttestationPublicKeyHex: string;
  /** What the insurer node is started with for its key. */
  insurerChildEnv: Record<string, string>;
  /** The pinned ceremony, when there is one. */
  ceremony: { ceremonyId: string; recordHash: string; anchored: 'new' | 'same' | 'succeeded' } | null;
  /** Lines for the boot log. */
  notes: string[];
}

export function planInsurerKeys(env: NodeJS.ProcessEnv, checkpointDir: string): InsurerKeyPlan {
  const recordPath = env.ZKTRIDENT_CEREMONY_RECORD?.trim();
  if (recordPath) {
    const absolute = path.resolve(recordPath);
    const { record, recordHash, anchored } = pinCeremonyRecord(absolute, checkpointDir);
    const insurer = record.nodes.find((n) => n.role === 'insurer');
    const key = insurer?.publicKeys.insurerSigningPublicKeyHex;
    if (!insurer || !key) throw new Error(`the ceremony record ${record.ceremonyId} keys no insurer node`);
    const notes = [
      `key ceremony ${record.ceremonyId} ${anchored === 'new' ? 'pinned as this sequencer\'s trust anchor' : anchored === 'same' ? 'matches the pinned trust anchor' : 'follows the pinned one and is the anchor now'} (record ${recordHash.slice(0, 16)}…, ${record.threshold} of ${record.holders.length} holders)`,
      `insurer attestation key from the ceremony: ${key.slice(0, 16)}…`,
    ];
    if (env.ZKTRIDENT_INSURER_SIGNING_SEED) notes.push('ZKTRIDENT_INSURER_SIGNING_SEED is ignored: the insurer\'s key comes from the ceremony');
    return {
      insurerAttestationPublicKeyHex: key,
      insurerChildEnv: { ZKTRIDENT_CEREMONY_RECORD: absolute, ZKTRIDENT_CEREMONY_NODE_ID: insurer.nodeId },
      ceremony: { ceremonyId: record.ceremonyId, recordHash, anchored },
      notes,
    };
  }
  const seed = env.ZKTRIDENT_INSURER_SIGNING_SEED ?? randomBytes(32).toString('base64url');
  return {
    insurerAttestationPublicKeyHex: insurerPublicKeyFromSeed(seed),
    insurerChildEnv: { ZKTRIDENT_INSURER_SIGNING_SEED: seed },
    ceremony: null,
    notes: [
      'no key ceremony record (ZKTRIDENT_CEREMONY_RECORD): the insurer signs with '
        + (env.ZKTRIDENT_INSURER_SIGNING_SEED ? 'ZKTRIDENT_INSURER_SIGNING_SEED' : 'a seed made at random for this boot, which voids the attestations of a previous run'),
    ],
  };
}
