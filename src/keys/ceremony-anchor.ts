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
 * The sequencer's trust anchor for the key ceremony — owner, 2026-11-04.
 *
 * As DNS resolvers pin the root key, the sequencer pins the first ceremony record it is given (ZKTRIDENT_CEREMONY_RECORD)
 * in its data directory. After that it starts only with that record, or with one that follows it: naming it as its
 * predecessor and signed by its holders as well as its own (a rotation or a change of holders), which then becomes the
 * anchor. A record that is neither is refused, and so is the boot: a swapped record would swap the insurer key the
 * sequencer pins.
 */
import fs from 'fs';
import path from 'path';
import { verifyCeremonyRecord, verifyRecordSuccession, recordHashOf, CeremonyRecordError, type CeremonyRecord } from './ceremony.js';

interface AnchorFile {
  v: 1;
  recordHash: string;
  record: CeremonyRecord;
  pinnedAt: string;
}

export function pinCeremonyRecord(
  recordPath: string,
  anchorDir: string,
): { record: CeremonyRecord; recordHash: string; anchored: 'new' | 'same' | 'succeeded' } {
  let record: CeremonyRecord;
  try {
    record = JSON.parse(fs.readFileSync(recordPath, 'utf8')) as CeremonyRecord;
  } catch (err) {
    throw new CeremonyRecordError(`the ceremony record at ${recordPath} could not be read: ${err instanceof Error ? err.message : String(err)}`);
  }
  const anchorFile = path.join(anchorDir, 'ceremony-anchor.json');
  const write = (hash: string) => {
    fs.mkdirSync(anchorDir, { recursive: true });
    const tmp = `${anchorFile}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, recordHash: hash, record, pinnedAt: new Date().toISOString() } satisfies AnchorFile, null, 2));
    fs.renameSync(tmp, anchorFile);
  };
  if (!fs.existsSync(anchorFile)) {
    const { recordHash } = verifyCeremonyRecord(record);
    write(recordHash);
    return { record, recordHash, anchored: 'new' };
  }
  let anchor: AnchorFile;
  try {
    anchor = JSON.parse(fs.readFileSync(anchorFile, 'utf8')) as AnchorFile;
  } catch {
    throw new CeremonyRecordError(`the pinned ceremony anchor at ${anchorFile} could not be read`);
  }
  if (anchor.recordHash === recordHashOf(record)) {
    return { record, recordHash: verifyCeremonyRecord(record).recordHash, anchored: 'same' };
  }
  let recordHash: string;
  try {
    recordHash = verifyRecordSuccession(anchor.record, record).recordHash;
  } catch (err) {
    throw new CeremonyRecordError(
      `the ceremony record ${record.ceremonyId} neither is nor follows the one this sequencer pinned (${anchor.record?.ceremonyId}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  write(recordHash);
  return { record, recordHash, anchored: 'succeeded' };
}
