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
 * The key ceremony — owner, 2026-11-04: "The secrets are created using multisig like how we create DNS private key
 * ceremonites to ensure nothing is leaked or hackable or infiltrated."
 *
 * Modeled on the DNS root zone's key ceremony (KSK-2024: any 3 of 7 crypto officers activate the key; the key is made
 * and used only at scripted, witnessed, recorded ceremonies; resolvers pin it as their trust anchor). Here:
 *
 *  - The program runs on an offline machine in front of the key holders. For each node it makes a 32-byte master,
 *    splits it among the holders (any `threshold` rebuild it, fewer learn nothing), seals each share to its holder's
 *    X25519 key and wipes the master. No person sees a master and none is written down.
 *  - It writes a record: the holders, the threshold, a check value of each master and the public keys derived from it
 *    (the insurer's attestation key). A secret cannot be multisigned into existence, so it is split; decisions about
 *    it are multisigned: the record is valid with `threshold` holder signatures, the first one is the trust anchor the
 *    network pins, and a later one (a rotation, a change of holders) must be signed by the holders of the one before.
 *  - A holder provisions a node by sealing their share again to that node's one-time key and signing the release. The
 *    node takes a release only from a holder in the record, for its own key, its own name and the holder's own slot,
 *    and checks what it rebuilds against the record before it seals the master to its machine (machine-seal.ts).
 *    After that a restart needs no one (owner, 2026-11-05); the holders are needed again only for a replaced machine,
 *    a rotation or a change of holders.
 */
import { createHash, randomBytes, type KeyObject } from 'crypto';
import { splitSecret, type SecretShare } from './shamir.js';
import { sealTo, openSealed, isSealedEnvelope, type SealedEnvelope } from './seal.js';
import { masterCheckHex, insurerSigningSeedFrom } from './subkeys.js';
import { isHolderCard, verifyHolderSignature, type HolderCard, type UnlockedHolder } from './holder-key.js';
import { insurerPublicKeyFromSeed } from '../onboarding/employer-attestation.js';

export const CEREMONY_PROGRAM = { name: 'zpk.care key ceremony', version: '1' } as const;
export const MAX_HOLDERS = 15;
const CEREMONY_ID = /^\d{4}-\d{2}-\d{2}-[0-9a-f]{8}$/;
const NODE_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const HEX32 = /^[0-9a-f]{64}$/;

export type CeremonyNodeRole = 'insurer';

export interface CeremonyNodeSpec {
  nodeId: string;
  role: CeremonyNodeRole;
}

export interface CeremonyNodeEntry extends CeremonyNodeSpec {
  /** deriveSubkey(master, 'check'): a rebuilt master must reproduce it. */
  masterCheckHex: string;
  /** Public keys derived from the master, for the network to pin. */
  publicKeys: { insurerSigningPublicKeyHex?: string };
}

export interface CeremonyRecordBody {
  v: 1;
  kind: 'zpk.care key ceremony record';
  ceremonyId: string;
  createdAt: string;
  /** The record this one replaces, or null for the first: the trust anchor. */
  previous: { ceremonyId: string; recordHash: string } | null;
  program: { name: string; version: string; sourceSha256: string };
  threshold: number;
  holders: HolderCard[];
  nodes: CeremonyNodeEntry[];
}

export interface RecordSignature {
  /** The signing holder's Ed25519 public key. */
  holder: string;
  signatureHex: string;
}

export interface CeremonyRecord extends CeremonyRecordBody {
  signatures: RecordSignature[];
}

/** One holder's share of one node's master, sealed to that holder. It goes to that holder only. */
export interface ShareFile {
  v: 1;
  kind: 'zpk.care key share';
  ceremonyId: string;
  nodeId: string;
  /** The holder's Ed25519 public key. */
  holder: string;
  index: number;
  threshold: number;
  envelope: SealedEnvelope;
}

/** A share a holder releases to one start of one node: sealed to that start's one-time key and signed by the holder. */
export interface ShareRelease {
  v: 1;
  kind: 'zpk.care share release';
  ceremonyId: string;
  nodeId: string;
  holder: string;
  index: number;
  bootPublicKeyHex: string;
  envelope: SealedEnvelope;
  signatureHex: string;
}

export class CeremonyRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CeremonyRecordError';
  }
}

// ─── Canonical form and hashes ────────────────────────────────────────────────

/** JSON with object keys sorted at every level, so a record hashes the same however it was written. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('canonicalJson: not a finite number');
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function bodyOf(record: CeremonyRecordBody & { signatures?: unknown }): CeremonyRecordBody {
  const { signatures: _signatures, ...body } = record;
  return body;
}

/** The SHA-256 of a record's canonical body: what holders sign and what the network pins. */
export function recordHashOf(record: CeremonyRecordBody & { signatures?: unknown }): string {
  return sha256Hex(canonicalJson(bodyOf(record)));
}

function recordMessage(recordHash: string): Buffer {
  return Buffer.from(`zpk.care/ceremony-record/v1\n${recordHash}`, 'utf8');
}

function shareContext(ceremonyId: string, nodeId: string, index: number): string {
  return `zpk.care/ceremony/v1/share/${ceremonyId}/${nodeId}/${index}`;
}

function releaseContext(ceremonyId: string, nodeId: string, bootPublicKeyHex: string, index: number): string {
  return `zpk.care/ceremony/v1/release/${ceremonyId}/${nodeId}/${bootPublicKeyHex}/${index}`;
}

function releaseMessage(release: Omit<ShareRelease, 'signatureHex'>): Buffer {
  return Buffer.from(`zpk.care/share-release/v1\n${sha256Hex(canonicalJson(release))}`, 'utf8');
}

// ─── Checks shared by the ceremony and every verifier ─────────────────────────

function checkHolderSet(holders: unknown, threshold: unknown): asserts holders is HolderCard[] {
  if (!Array.isArray(holders) || holders.length < 2 || holders.length > MAX_HOLDERS) {
    throw new CeremonyRecordError(`a ceremony has 2 to ${MAX_HOLDERS} key holders`);
  }
  if (!Number.isInteger(threshold) || (threshold as number) < 2 || (threshold as number) > holders.length) {
    throw new CeremonyRecordError(`the threshold must be at least 2 and at most the number of holders (${holders.length})`);
  }
  const signKeys = new Set<string>();
  const boxKeys = new Set<string>();
  const labels = new Set<string>();
  const perGroup = new Map<string, number>();
  for (const card of holders) {
    if (!isHolderCard(card)) throw new CeremonyRecordError('a holder card is not valid');
    if (signKeys.has(card.signPublicKeyHex) || boxKeys.has(card.boxPublicKeyHex) || labels.has(card.label)) {
      throw new CeremonyRecordError(`holder ${card.label} is listed twice`);
    }
    signKeys.add(card.signPublicKeyHex);
    boxKeys.add(card.boxPublicKeyHex);
    labels.add(card.label);
    if (card.group) perGroup.set(card.group, (perGroup.get(card.group) ?? 0) + 1);
  }
  for (const [group, count] of perGroup) {
    if (count >= (threshold as number)) {
      throw new CeremonyRecordError(`no one group may hold enough shares to rebuild a key alone: ${group} has ${count} of the ${threshold} needed`);
    }
  }
}

function checkNodes(nodes: unknown, requireKeys: boolean): asserts nodes is CeremonyNodeEntry[] {
  if (!Array.isArray(nodes) || nodes.length === 0) throw new CeremonyRecordError('a ceremony keys at least one node');
  const ids = new Set<string>();
  for (const node of nodes as CeremonyNodeEntry[]) {
    if (!node || typeof node.nodeId !== 'string' || !NODE_ID.test(node.nodeId)) throw new CeremonyRecordError('a node ID is 1 to 63 lower-case letters, digits or dashes');
    if (ids.has(node.nodeId)) throw new CeremonyRecordError(`node ${node.nodeId} is listed twice`);
    ids.add(node.nodeId);
    if (node.role !== 'insurer') throw new CeremonyRecordError(`node ${node.nodeId} has a role the ceremony does not key: ${String(node.role)}`);
    if (!requireKeys) continue;
    if (typeof node.masterCheckHex !== 'string' || !HEX32.test(node.masterCheckHex)) throw new CeremonyRecordError(`node ${node.nodeId} has no check value`);
    const key = node.publicKeys?.insurerSigningPublicKeyHex;
    if (typeof key !== 'string' || !HEX32.test(key)) throw new CeremonyRecordError(`node ${node.nodeId} has no insurer signing key`);
  }
}

function checkBody(record: CeremonyRecord): void {
  if (!record || record.v !== 1 || record.kind !== 'zpk.care key ceremony record') throw new CeremonyRecordError('this is not a key ceremony record');
  if (typeof record.ceremonyId !== 'string' || !CEREMONY_ID.test(record.ceremonyId)) throw new CeremonyRecordError('the ceremony ID is not valid');
  if (typeof record.createdAt !== 'string' || Number.isNaN(Date.parse(record.createdAt))) throw new CeremonyRecordError('the record has no valid date');
  if (record.previous !== null) {
    const p = record.previous;
    if (!p || typeof p.ceremonyId !== 'string' || !CEREMONY_ID.test(p.ceremonyId) || typeof p.recordHash !== 'string' || !HEX32.test(p.recordHash)) {
      throw new CeremonyRecordError('the record names its predecessor wrongly');
    }
  }
  const program = record.program;
  if (!program || program.name !== CEREMONY_PROGRAM.name || typeof program.version !== 'string' || typeof program.sourceSha256 !== 'string' || !HEX32.test(program.sourceSha256)) {
    throw new CeremonyRecordError('the record does not name the program that made it');
  }
  checkHolderSet(record.holders, record.threshold);
  checkNodes(record.nodes, true);
  if (!Array.isArray(record.signatures)) throw new CeremonyRecordError('the record carries no signature list');
}

/** The distinct holders of `holders` whose signatures on `record` verify. */
function validSigners(record: CeremonyRecord, holders: HolderCard[]): string[] {
  const message = recordMessage(recordHashOf(record));
  const allowed = new Set(holders.map((h) => h.signPublicKeyHex));
  const signed = new Set<string>();
  for (const sig of record.signatures) {
    if (!sig || typeof sig.holder !== 'string' || !allowed.has(sig.holder) || signed.has(sig.holder)) continue;
    if (verifyHolderSignature(sig.holder, message, sig.signatureHex)) signed.add(sig.holder);
  }
  return [...signed];
}

// ─── The ceremony ─────────────────────────────────────────────────────────────

export interface RunCeremonyOptions {
  holders: HolderCard[];
  threshold: number;
  nodes: CeremonyNodeSpec[];
  /** The SHA-256 of the program's source, for the holders to compare with the release they reviewed. */
  programSourceSha256: string;
  /** The record this ceremony replaces; its holders must sign the new one. */
  previous?: CeremonyRecord | null;
  ceremonyId?: string;
  now?: Date;
}

/** Make each node's master, split it among the holders, and return the unsigned record and the holders' sealed shares. */
export function runCeremony(opts: RunCeremonyOptions): { record: CeremonyRecord; shares: ShareFile[] } {
  checkHolderSet(opts.holders, opts.threshold);
  checkNodes(opts.nodes, false);
  if (typeof opts.programSourceSha256 !== 'string' || !HEX32.test(opts.programSourceSha256)) {
    throw new CeremonyRecordError('runCeremony: the program source hash is 32 bytes of hex');
  }
  const now = opts.now ?? new Date();
  const ceremonyId = opts.ceremonyId ?? `${now.toISOString().slice(0, 10)}-${randomBytes(4).toString('hex')}`;
  if (!CEREMONY_ID.test(ceremonyId)) throw new CeremonyRecordError('runCeremony: the ceremony ID is not valid');
  const holders = opts.holders.map((h) => ({ label: h.label, ...(h.group ? { group: h.group } : {}), signPublicKeyHex: h.signPublicKeyHex, boxPublicKeyHex: h.boxPublicKeyHex }));
  const shares: ShareFile[] = [];
  const nodes: CeremonyNodeEntry[] = [];
  for (const spec of opts.nodes) {
    const master = randomBytes(32);
    try {
      nodes.push({
        nodeId: spec.nodeId,
        role: spec.role,
        masterCheckHex: masterCheckHex(master),
        publicKeys: { insurerSigningPublicKeyHex: insurerPublicKeyFromSeed(insurerSigningSeedFrom(master)) },
      });
      const parts = splitSecret(master, opts.threshold, holders.length);
      parts.forEach((part, i) => {
        shares.push({
          v: 1,
          kind: 'zpk.care key share',
          ceremonyId,
          nodeId: spec.nodeId,
          holder: holders[i].signPublicKeyHex,
          index: part.index,
          threshold: opts.threshold,
          envelope: sealTo(holders[i].boxPublicKeyHex, part.value, shareContext(ceremonyId, spec.nodeId, part.index)),
        });
        part.value.fill(0);
      });
    } finally {
      master.fill(0);
    }
  }
  const record: CeremonyRecord = {
    v: 1,
    kind: 'zpk.care key ceremony record',
    ceremonyId,
    createdAt: now.toISOString(),
    previous: opts.previous ? { ceremonyId: opts.previous.ceremonyId, recordHash: recordHashOf(opts.previous) } : null,
    program: { ...CEREMONY_PROGRAM, sourceSha256: opts.programSourceSha256 },
    threshold: opts.threshold,
    holders,
    nodes,
    signatures: [],
  };
  return { record, shares };
}

/** A holder's signature on a record, after they have checked it. */
export function signCeremonyRecord(record: CeremonyRecord, holder: UnlockedHolder): RecordSignature {
  return { holder: holder.card.signPublicKeyHex, signatureHex: holder.sign(recordMessage(recordHashOf(record))) };
}

/** The record with `signature` added, replacing any earlier signature by the same holder. */
export function addRecordSignature(record: CeremonyRecord, signature: RecordSignature): CeremonyRecord {
  return { ...record, signatures: [...record.signatures.filter((s) => s.holder !== signature.holder), signature] };
}

/**
 * Check a record on its own: well formed, and signed by `threshold` of its own holders. For the first record (the
 * trust anchor) that is all there is; a later one must also pass verifyRecordSuccession against the one before.
 */
export function verifyCeremonyRecord(record: CeremonyRecord): { recordHash: string; signedBy: string[] } {
  checkBody(record);
  const signedBy = validSigners(record, record.holders);
  if (signedBy.length < record.threshold) {
    throw new CeremonyRecordError(`the record is signed by ${signedBy.length} of the ${record.threshold} holders it needs`);
  }
  return { recordHash: recordHashOf(record), signedBy };
}

/** Check that `next` replaces `previous`: it names it, and `previous`'s holders signed it as well as its own. */
export function verifyRecordSuccession(previous: CeremonyRecord, next: CeremonyRecord): { recordHash: string; signedBy: string[] } {
  verifyCeremonyRecord(previous);
  checkBody(next);
  if (!next.previous || next.previous.ceremonyId !== previous.ceremonyId || next.previous.recordHash !== recordHashOf(previous)) {
    throw new CeremonyRecordError('the record does not follow the one before it');
  }
  const result = verifyCeremonyRecord(next);
  const byPrevious = validSigners(next, previous.holders);
  if (byPrevious.length < previous.threshold) {
    throw new CeremonyRecordError(`the record is signed by ${byPrevious.length} of the ${previous.threshold} previous holders it needs`);
  }
  return result;
}

// ─── Shares ───────────────────────────────────────────────────────────────────

function checkShareFile(file: ShareFile): void {
  if (!file || file.v !== 1 || file.kind !== 'zpk.care key share' || !CEREMONY_ID.test(String(file.ceremonyId))
    || !NODE_ID.test(String(file.nodeId)) || !HEX32.test(String(file.holder)) || !Number.isInteger(file.index)
    || !isSealedEnvelope(file.envelope)) {
    throw new CeremonyRecordError('this is not a key share');
  }
}

/** A holder opens their own share. */
export function openHolderShare(file: ShareFile, holder: UnlockedHolder): SecretShare {
  checkShareFile(file);
  if (file.holder !== holder.card.signPublicKeyHex) throw new CeremonyRecordError("this share is not this holder's");
  return { index: file.index, value: openSealed(holder.boxPrivateKey, file.envelope, shareContext(file.ceremonyId, file.nodeId, file.index)) };
}

/** A holder releases their share to one start of one node: sealed to its one-time key, and signed. */
export function releaseShare(
  file: ShareFile,
  holder: UnlockedHolder,
  target: { ceremonyId: string; nodeId: string; bootPublicKeyHex: string },
): ShareRelease {
  if (file.ceremonyId !== target.ceremonyId || file.nodeId !== target.nodeId) {
    throw new CeremonyRecordError(`this share is for ${file.nodeId} of ceremony ${file.ceremonyId}, not ${target.nodeId} of ${target.ceremonyId}`);
  }
  const share = openHolderShare(file, holder);
  try {
    const body: Omit<ShareRelease, 'signatureHex'> = {
      v: 1,
      kind: 'zpk.care share release',
      ceremonyId: file.ceremonyId,
      nodeId: file.nodeId,
      holder: holder.card.signPublicKeyHex,
      index: share.index,
      bootPublicKeyHex: target.bootPublicKeyHex,
      envelope: sealTo(target.bootPublicKeyHex, share.value, releaseContext(file.ceremonyId, file.nodeId, target.bootPublicKeyHex, share.index)),
    };
    return { ...body, signatureHex: holder.sign(releaseMessage(body)) };
  } finally {
    share.value.fill(0);
  }
}

/**
 * The node's side: take a release only from a holder in `record`, for this node, this start's one-time key and the
 * holder's own slot, and open it. The caller combines `threshold` of them and checks the result against the record.
 */
export function acceptShareRelease(
  release: ShareRelease,
  record: CeremonyRecord,
  boot: { privateKey: KeyObject; publicKeyHex: string },
  nodeId: string,
): SecretShare {
  if (!release || release.v !== 1 || release.kind !== 'zpk.care share release' || !isSealedEnvelope(release.envelope)) {
    throw new CeremonyRecordError('this is not a share release');
  }
  if (release.nodeId !== nodeId || !record.nodes.some((n) => n.nodeId === nodeId)) throw new CeremonyRecordError('this release is for another node');
  if (release.ceremonyId !== record.ceremonyId) throw new CeremonyRecordError('this release is for another ceremony');
  if (release.bootPublicKeyHex !== boot.publicKeyHex) throw new CeremonyRecordError('this release is for another start of this node');
  const position = record.holders.findIndex((h) => h.signPublicKeyHex === release.holder);
  if (position < 0) throw new CeremonyRecordError('this release is not from a holder in the record');
  const { signatureHex, ...body } = release;
  if (!verifyHolderSignature(release.holder, releaseMessage(body), signatureHex)) {
    throw new CeremonyRecordError("the release signature is not the holder's");
  }
  if (release.index !== position + 1) throw new CeremonyRecordError("this release is not for the holder's slot");
  return {
    index: release.index,
    value: openSealed(boot.privateKey, release.envelope, releaseContext(release.ceremonyId, release.nodeId, release.bootPublicKeyHex, release.index)),
  };
}
