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
 *
 * The passphrase is asked without echo, or read from ZPK_HOLDER_PASSPHRASE when automation plays the holder.
 */
import {
  createHolderKey, unlockHolderKey, holderFingerprint, type HolderKeyFile, type HolderCard,
} from '../../src/keys/holder-key.js';
import { addRecordSignature, recordHashOf, signCeremonyRecord, type CeremonyRecord } from '../../src/keys/ceremony.js';
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
  throw new Error('usage: holder.ts keygen|card|sign-record (see the header of scripts/keys/holder.ts)');
}

main().catch(fail);
