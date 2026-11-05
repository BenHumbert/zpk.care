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
 * The key ceremony program (owner, 2026-11-04). Run on an offline machine, in front of the key holders.
 *
 *   hash
 *       Print the SHA-256 of this program's source, to compare with the release the holders reviewed.
 *   run --holders <a.card.json,b.card.json,...> --threshold <n> [--node insurer] --out <dir> [--previous <record.json>]
 *       Make each node's master, split it among the holders and seal each share to its holder. Writes the unsigned
 *       record to <dir>/record.json and one share file per holder to <dir>/shares/. No master is ever written. Each
 *       holder then signs the record (holder.ts sign-record); it is valid once <n> have.
 *   verify --record <record.json> [--previous <record.json>]
 *       Check a record's signatures, and with --previous that it replaces that record.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  runCeremony, verifyCeremonyRecord, verifyRecordSuccession, recordHashOf, type CeremonyRecord,
} from '../../src/keys/ceremony.js';
import { holderFingerprint, isHolderCard, type HolderCard } from '../../src/keys/holder-key.js';
import { parseArgs, required, readJson, writeJson, programSourceSha256, fail } from './cli-util.js';

function slug(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function warnIfOnline(): void {
  const up = Object.entries(os.networkInterfaces())
    .filter(([, addrs]) => (addrs ?? []).some((a) => !a.internal))
    .map(([name]) => name);
  if (up.length > 0) console.log(`WARNING: network interfaces are up (${up.join(', ')}); a real ceremony runs on an offline machine.`);
}

async function main(): Promise<void> {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (command === 'hash') {
    console.log(programSourceSha256());
    return;
  }
  if (command === 'run') {
    warnIfOnline();
    const out = required(options, 'out');
    if (fs.existsSync(out) && fs.readdirSync(out).length > 0) throw new Error(`${out} is not empty`);
    const holders = required(options, 'holders').split(',').map((f) => {
      const card = readJson<HolderCard>(f.trim());
      if (!isHolderCard(card)) throw new Error(`${f} is not a holder card`);
      return card;
    });
    const threshold = Number.parseInt(required(options, 'threshold'), 10);
    const nodeId = options.get('node') ?? 'insurer';
    const previous = options.has('previous') ? readJson<CeremonyRecord>(required(options, 'previous')) : null;
    if (previous) verifyCeremonyRecord(previous);
    const { record, shares } = runCeremony({
      holders,
      threshold,
      nodes: [{ nodeId, role: 'insurer' }],
      programSourceSha256: programSourceSha256(),
      previous,
    });
    writeJson(path.join(out, 'record.json'), record);
    for (const share of shares) {
      const holder = holders.find((h) => h.signPublicKeyHex === share.holder)!;
      writeJson(path.join(out, 'shares', `${slug(holder.label)}.${share.nodeId}.share.json`), share);
    }
    console.log(`Ceremony ${record.ceremonyId}: ${threshold} of ${holders.length} holders rebuild each key`);
    for (const h of holders) console.log(`  ${h.label}${h.group ? ` (${h.group})` : ''}: ${holderFingerprint(h)} -> shares/${slug(h.label)}.${nodeId}.share.json`);
    console.log(`Record: ${path.join(out, 'record.json')} (unsigned)`);
    console.log(`Record hash: ${recordHashOf(record)}`);
    console.log(`Program hash: ${record.program.sourceSha256}`);
    console.log('Give each holder their own share file only. The record is valid once enough holders have signed it.');
    return;
  }
  if (command === 'verify') {
    const record = readJson<CeremonyRecord>(required(options, 'record'));
    const result = options.has('previous')
      ? verifyRecordSuccession(readJson<CeremonyRecord>(required(options, 'previous')), record)
      : verifyCeremonyRecord(record);
    console.log(`Valid: ceremony ${record.ceremonyId}, signed by ${result.signedBy.length} of ${record.holders.length} (needs ${record.threshold})`);
    console.log(`Record hash: ${result.recordHash}`);
    return;
  }
  throw new Error('usage: ceremony.ts hash|run|verify (see the header of scripts/keys/ceremony.ts)');
}

main().catch(fail);
