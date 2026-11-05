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
 * A node's keys at start — the key ceremony (owner, 2026-11-04) and the restart rule (owner, 2026-11-05).
 *
 * Provisioning, once per machine: a node the ceremony keyed starts with no master. It makes a one-time X25519 key for
 * this start, prints its fingerprint, and waits; `threshold` key holders release their shares to that key
 * (ceremony.ts), the node rebuilds the master, checks it against the record, seals it to this machine
 * (machine-seal.ts) and only then uses it.
 *
 * Every start after that: "if it shuts down and restarts we dont need keys to have it come back online". The node opens
 * its sealed master by itself, checks it against the record, and is unlocked: no holder, no network, no wait. Claims
 * never waited on any of this (the plan's server is not on the claim path).
 *
 * On another machine the sealed master opens nothing; the holders provision that machine as they did the first. A
 * share that does not belong (a lying holder) cannot unlock the node: every set of `threshold` shares received is tried
 * against the record's check value, so one more good share is enough to find the ones that agree. A node holding a
 * master from another ceremony refuses this one: moving its stores to a new master (a rotation) is not built yet, and a
 * new master would leave them unreadable.
 */
import fs from 'fs';
import path from 'path';
import { combineShares, type SecretShare } from './shamir.js';
import { generateBoxKeyPair, type BoxKeyPair } from './seal.js';
import { masterCheckHex, deriveSubkey, insurerSigningSeedFrom } from './subkeys.js';
import { acceptShareRelease, bootFingerprint, type CeremonyRecord, type CeremonyNodeEntry, type ShareRelease } from './ceremony.js';
import type { MachineSeal, MachineSealKind } from './machine-seal.js';

export type KeyringState = 'locked' | 'awaiting-shares' | 'unlocked' | 'refused';

export interface KeyringStatus {
  state: KeyringState;
  ceremonyId: string;
  nodeId: string;
  threshold: number;
  /** Shares received for this start, while it waits. */
  received: number;
  /** This start's one-time key and its fingerprint, while it waits. */
  bootPublicKeyHex?: string;
  bootFingerprint?: string;
  /** Why it is waiting or refused. */
  reason?: string;
  seal: MachineSealKind;
}

export interface NodeKeyringOptions {
  /** Verified by the caller (verifyCeremonyRecord). */
  record: CeremonyRecord;
  nodeId: string;
  stateDir: string;
  seal: MachineSeal;
  log?: (message: string) => void;
}

interface SealedMasterFile {
  v: 1;
  kind: 'zpk.care sealed node master';
  ceremonyId: string;
  nodeId: string;
  seal: MachineSealKind;
  sealedAt: string;
  blob: string;
}

function* subsetsOf<T>(items: T[], size: number, start = 0, picked: T[] = []): Generator<T[]> {
  if (picked.length === size) {
    yield picked;
    return;
  }
  for (let i = start; i <= items.length - (size - picked.length); i++) yield* subsetsOf(items, size, i + 1, [...picked, items[i]]);
}

export class NodeKeyring {
  private readonly record: CeremonyRecord;
  private readonly entry: CeremonyNodeEntry;
  private readonly nodeId: string;
  private readonly dir: string;
  private readonly seal: MachineSeal;
  private readonly log: (message: string) => void;
  private state: KeyringState = 'locked';
  private reason: string | undefined;
  private master: Buffer | null = null;
  private boot: BoxKeyPair | null = null;
  private readonly received = new Map<number, SecretShare>();
  private readonly listeners: Array<(keyring: NodeKeyring) => void> = [];

  constructor(opts: NodeKeyringOptions) {
    const entry = opts.record.nodes.find((n) => n.nodeId === opts.nodeId);
    if (!entry) throw new Error(`the ceremony record ${opts.record.ceremonyId} does not key node ${opts.nodeId}`);
    this.record = opts.record;
    this.entry = entry;
    this.nodeId = opts.nodeId;
    this.dir = path.join(opts.stateDir, 'node-keys');
    this.seal = opts.seal;
    this.log = opts.log ?? ((m) => console.log(`  [keys] ${m}`));
  }

  private get sealedFile(): string {
    return path.join(this.dir, `${this.record.ceremonyId}.${this.nodeId}.sealed.json`);
  }

  private get sealContext(): string {
    return `zpk.care/node-master/${this.record.ceremonyId}/${this.nodeId}`;
  }

  /** Open the sealed master, or wait for the holders. */
  async start(): Promise<KeyringStatus> {
    if (fs.existsSync(this.sealedFile)) {
      let master: Buffer;
      try {
        const file = JSON.parse(fs.readFileSync(this.sealedFile, 'utf8')) as SealedMasterFile;
        master = await this.seal.open(Buffer.from(String(file.blob), 'base64'), this.sealContext);
      } catch {
        this.awaitShares('the sealed master could not be opened on this machine (a replaced machine, or another account): the key holders provision it again');
        return this.status();
      }
      if (master.length !== 32 || masterCheckHex(master) !== this.entry.masterCheckHex) {
        master.fill(0);
        this.awaitShares('the sealed master is not the one the ceremony record names: the key holders provision this node again');
        return this.status();
      }
      this.unlock(master, `unlocked by this machine's seal (${this.seal.description}); no key holder was needed`);
      return this.status();
    }
    const others = fs.existsSync(this.dir)
      ? fs.readdirSync(this.dir).filter((f) => f.endsWith(`.${this.nodeId}.sealed.json`))
      : [];
    if (others.length > 0) {
      const held = others.map((f) => f.slice(0, -`.${this.nodeId}.sealed.json`.length)).join(', ');
      this.state = 'refused';
      this.reason = `this node holds a master from ceremony ${held}; moving its stores to the master of ceremony ${this.record.ceremonyId} (a rotation) is not built yet`;
      this.log(`REFUSED: ${this.reason}`);
      return this.status();
    }
    this.awaitShares('provisioning: this machine has no master yet');
    return this.status();
  }

  private awaitShares(reason: string): void {
    this.boot = generateBoxKeyPair();
    this.state = 'awaiting-shares';
    this.reason = reason;
    this.log(`${reason}`);
    this.log(`waiting for ${this.record.threshold} of the ${this.record.holders.length} key holders of ceremony ${this.record.ceremonyId}`);
    this.log(`this start's one-time key: ${bootFingerprint(this.boot.publicKeyHex)} (a holder checks it before releasing a share)`);
  }

  /** Take one holder's release. When enough agree, the master is rebuilt, checked, sealed to this machine and used. */
  async acceptRelease(release: ShareRelease): Promise<{ accepted: boolean; status: KeyringStatus; reason?: string }> {
    if (this.state !== 'awaiting-shares' || !this.boot) {
      const reason = this.state === 'unlocked' ? 'this node is already unlocked' : `this node is not taking shares (${this.state})`;
      return { accepted: false, status: this.status(), reason };
    }
    let share: SecretShare;
    try {
      share = acceptShareRelease(release, this.record, this.boot, this.nodeId);
    } catch (err) {
      return { accepted: false, status: this.status(), reason: err instanceof Error ? err.message : String(err) };
    }
    this.received.get(share.index)?.value.fill(0);
    this.received.set(share.index, share);
    const holder = this.record.holders[share.index - 1];
    this.log(`share ${this.received.size} of ${this.record.threshold} received, from ${holder?.label ?? 'a holder'}`);
    if (this.received.size >= this.record.threshold) await this.tryCombine();
    return { accepted: true, status: this.status() };
  }

  private async tryCombine(): Promise<void> {
    for (const subset of subsetsOf([...this.received.values()], this.record.threshold)) {
      const candidate = combineShares(subset);
      if (masterCheckHex(candidate) !== this.entry.masterCheckHex) {
        candidate.fill(0);
        continue;
      }
      // sealed to this machine before it is used, so a crash from here on still restarts by itself
      const blob = await this.seal.seal(candidate, this.sealContext);
      const file: SealedMasterFile = {
        v: 1,
        kind: 'zpk.care sealed node master',
        ceremonyId: this.record.ceremonyId,
        nodeId: this.nodeId,
        seal: this.seal.kind,
        sealedAt: new Date().toISOString(),
        blob: blob.toString('base64'),
      };
      const used = new Set(subset.map((share) => share.index));
      for (const index of this.received.keys()) {
        if (!used.has(index)) this.log(`the share from ${this.record.holders[index - 1]?.label ?? `slot ${index}`} did not agree with the others`);
      }
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const tmp = `${this.sealedFile}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(file), { mode: 0o600 });
      fs.renameSync(tmp, this.sealedFile);
      this.unlock(candidate, `provisioned by the key holders and sealed to this machine (${this.seal.description})`);
      return;
    }
    this.reason = `the ${this.received.size} shares received do not rebuild this node's master: at least one is wrong; one more holder's share can find the ones that agree`;
    this.log(this.reason);
  }

  private unlock(master: Buffer, how: string): void {
    for (const share of this.received.values()) share.value.fill(0);
    this.received.clear();
    this.boot = null;
    this.master = master;
    this.state = 'unlocked';
    this.reason = undefined;
    this.log(`${this.nodeId}: ${how}`);
    for (const listener of this.listeners.splice(0)) listener(this);
  }

  /** Called once the node is unlocked (at once if it already is). */
  onUnlocked(listener: (keyring: NodeKeyring) => void): void {
    if (this.state === 'unlocked') listener(this);
    else this.listeners.push(listener);
  }

  isUnlocked(): boolean {
    return this.state === 'unlocked' && this.master !== null;
  }

  private requireMaster(): Buffer {
    if (!this.isUnlocked() || !this.master) throw new Error(`the keys of ${this.nodeId} are locked (${this.state})`);
    return this.master;
  }

  /** A key for one purpose (SUBKEYS), derived from the master. */
  subkey(label: string): Buffer {
    return deriveSubkey(this.requireMaster(), label);
  }

  /** The public keys the ceremony record publishes for this node, which what the master derives must match. */
  publicKeys(): CeremonyNodeEntry['publicKeys'] {
    return { ...this.entry.publicKeys };
  }

  /** The insurer's attestation signing seed; its public half is in the ceremony record. */
  insurerSigningSeed(): string {
    return insurerSigningSeedFrom(this.requireMaster());
  }

  status(): KeyringStatus {
    return {
      state: this.state,
      ceremonyId: this.record.ceremonyId,
      nodeId: this.nodeId,
      threshold: this.record.threshold,
      received: this.received.size,
      ...(this.boot ? { bootPublicKeyHex: this.boot.publicKeyHex, bootFingerprint: bootFingerprint(this.boot.publicKeyHex) } : {}),
      ...(this.reason ? { reason: this.reason } : {}),
      seal: this.seal.kind,
    };
  }

  /** Wipe the master and any shares; the node is locked until it starts again. */
  close(): void {
    this.master?.fill(0);
    this.master = null;
    for (const share of this.received.values()) share.value.fill(0);
    this.received.clear();
    this.boot = null;
    if (this.state === 'unlocked') this.state = 'locked';
  }
}
