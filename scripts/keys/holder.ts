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
 * A key holder's program — the key ceremony (owner, 2026-11-04). Run on the holder's own device.
 *
 *   keygen --label <label> [--group <team>] --out <file>
 *       Make this holder's keys, kept in <file> under a passphrase, and write the public card to <file>.card.json for
 *       the ceremony. Read the fingerprint it prints aloud at the ceremony.
 *   card --key <file>
 *       Print this holder's public card.
 *   sign-record --key <file> --record <record.json> [--yes]
 *       Check a ceremony record and add this holder's signature to it. Without --yes it asks for the first 8
 *       characters of the record hash, which the ceremony program printed, so a holder signs only what was shown.
 *   release --key <file> --share <file> --node <url> [--boot-fingerprint XXXX-XXXX-XXXX-XXXX] [--yes]
 *       Provision a node: seal this holder's share to the one-time key of the node's current start and send it. The
 *       fingerprint of that key is computed here, from the key the share is sealed to, and must match the one the
 *       node prints on its own console: given with --boot-fingerprint, or typed back when asked. A key swapped on
 *       the way is caught that way. Needed once per machine; a restarted node unlocks by itself.
 *
 * The passphrase is asked without echo, or read from ZPK_HOLDER_PASSPHRASE when automation plays the holder.
 */
import {
  createHolderKey, unlockHolderKey, holderFingerprint, type HolderKeyFile, type HolderCard,
} from '../../src/keys/holder-key.js';
import {
  addRecordSignature, recordHashOf, signCeremonyRecord, releaseShare, bootFingerprint, type CeremonyRecord, type ShareFile,
} from '../../src/keys/ceremony.js';
import { parseArgs, required, holderPassphrase, readJson, writeJson, confirm, fail } from './cli-util.js';

function cardOf(file: HolderKeyFile): HolderCard {
  return { label: file.label, ...(file.group ? { group: file.group } : {}), signPublicKeyHex: file.signPublicKeyHex, boxPublicKeyHex: file.boxPublicKeyHex };
}

async function main(): Promise<void> {
  const { command, options, flags } = parseArgs(process.argv.slice(2));
  if (command === 'keygen') {
    const out = required(options, 'out');
    const { file, card } = createHolderKey(required(options, 'label'), await holderPassphrase(true), { group: options.get('group') });
    writeJson(out, file);
    writeJson(`${out}.card.json`, card);
    console.log(`Holder key written to ${out} (keep it on this device only)`);
    console.log(`Public card written to ${out}.card.json (hand it to the ceremony)`);
    console.log(`Fingerprint: ${holderFingerprint(card)}`);
    return;
  }
  if (command === 'card') {
    const card = cardOf(readJson<HolderKeyFile>(required(options, 'key')));
    console.log(JSON.stringify(card, null, 2));
    console.log(`Fingerprint: ${holderFingerprint(card)}`);
    return;
  }
  if (command === 'sign-record') {
    const recordFile = required(options, 'record');
    const record = readJson<CeremonyRecord>(recordFile);
    const file = readJson<HolderKeyFile>(required(options, 'key'));
    const hash = recordHashOf(record);
    console.log(`Ceremony ${record.ceremonyId}, threshold ${record.threshold} of ${record.holders.length}`);
    for (const h of record.holders) console.log(`  holder ${h.label}${h.group ? ` (${h.group})` : ''}: ${holderFingerprint(h)}`);
    for (const n of record.nodes) console.log(`  node ${n.nodeId} (${n.role}): insurer key ${n.publicKeys.insurerSigningPublicKeyHex}`);
    console.log(`Record hash: ${hash}`);
    if (!record.holders.some((h) => h.signPublicKeyHex === file.signPublicKeyHex)) {
      console.log('Note: this holder is not in the record (signing for a predecessor\'s holder set)');
    }
    if (!flags.has('yes') && !(await confirm('Type the first 8 characters of the record hash to sign: ', hash.slice(0, 8)))) {
      throw new Error('not signed');
    }
    const holder = unlockHolderKey(file, await holderPassphrase());
    writeJson(recordFile, addRecordSignature(record, signCeremonyRecord(record, holder)), { replace: true });
    console.log(`Signed by ${holder.card.label}`);
    return;
  }
  if (command === 'release') {
    const share = readJson<ShareFile>(required(options, 'share'));
    const file = readJson<HolderKeyFile>(required(options, 'key'));
    const node = required(options, 'node').replace(/\/+$/, '');
    const statusResp = await fetch(`${node}/keys/status`);
    const status = (await statusResp.json() as { data?: { state: string; ceremonyId: string; nodeId: string; threshold: number; received: number; bootPublicKeyHex?: string } }).data;
    if (!status) throw new Error(`${node} answered ${statusResp.status} and no key status`);
    if (status.state !== 'awaiting-shares' || !status.bootPublicKeyHex) throw new Error(`${status.nodeId} is not waiting for shares (${status.state})`);
    if (status.ceremonyId !== share.ceremonyId || status.nodeId !== share.nodeId) {
      throw new Error(`this share is for ${share.nodeId} of ceremony ${share.ceremonyId}; the node is ${status.nodeId} of ${status.ceremonyId}`);
    }
    const fingerprint = bootFingerprint(status.bootPublicKeyHex);
    console.log(`${status.nodeId} (ceremony ${status.ceremonyId}) is waiting for ${status.threshold} holders; ${status.received} have released.`);
    console.log(`Its one-time key, as this program computes it: ${fingerprint}`);
    const expected = options.get('boot-fingerprint');
    if (expected) {
      if (expected.trim().toUpperCase() !== fingerprint) throw new Error("that is not the fingerprint you were given from the node's console: nothing was released");
    } else if (!flags.has('yes')) {
      if (!(await confirm("Type its first 4 characters as the node's console shows them, to release: ", fingerprint.slice(0, 4)))) throw new Error('not released');
    }
    const holder = unlockHolderKey(file, await holderPassphrase());
    const release = releaseShare(share, holder, { ceremonyId: share.ceremonyId, nodeId: share.nodeId, bootPublicKeyHex: status.bootPublicKeyHex });
    const sent = await fetch(`${node}/keys/release`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(release) });
    const answer = await sent.json() as { ok: boolean; data?: { state: string; received: number; threshold: number }; error?: string };
    if (!answer.ok || !answer.data) throw new Error(`the node refused the release: ${answer.error ?? sent.status}`);
    console.log(answer.data.state === 'unlocked'
      ? `${share.nodeId} is unlocked and has sealed its master to its machine.`
      : `Released: ${answer.data.received} of ${answer.data.threshold}.`);
    return;
  }
  throw new Error('usage: holder.ts keygen|card|sign-record|release (see the header of scripts/keys/holder.ts)');
}

main().catch(fail);
