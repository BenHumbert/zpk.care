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
 * EmployerNode — Entity node for employers (5th role).
 *
 * Capabilities:
 *   - Token generation, revocation, and lifecycle management
 *   - Group creation and termination
 *   - Opaque roster management (add entry, list, query by employee hash)
 *   - Token submission to insurer Nautilus (HTTP POST)
 *   - Read-only sequencer queries (enrollment status, chain state)
 *
 * No wallet ID. No ZkProgram compilation. No ZK proving.
 * Pattern: follows InsurerNode (admin-style, no crypto).
 * Runs on: employer HR backend server.
 */
import { Field, Poseidon } from 'o1js';
import { hashString } from '../zkp/hash-utils.js';
import { TokenAuthority } from '../onboarding/token-authority.js';
import type { TokenRecord, TokenValidationResult } from '../onboarding/token-authority.js';
import type { GroupEnrollmentToken } from '../onboarding/group-enrollment-token.js';
import { EntityNodeBase } from './entity-node-base.js';
import type { EmployerNodeConfig } from './entity-node-types.js';
import type { L2ChainState } from '../l2/l2-types.js';
import type { MessageStoreEntry } from '../l2/message-store-types.js';

// ─── Internal Types ──────────────────────────────────────────

/** Group record managed by the employer */
export interface EmployerGroupRecord {
  groupId: string;
  groupIdHash: string;
  planId: string;
  planIdHash: string;
  effectiveDate: string;
  terminationDate: string | null;
  enrollmentCap: number;
  enrolledCount: number;
  status: 'active' | 'terminated';
  createdAt: number;
}

/** Phase F1: Computed stats for a group — used by HR Tool to gate imports. */
export interface EmployerGroupStats {
  groupId: string;
  planId: string;
  effectiveDate: string;
  status: 'active' | 'terminated';
  /** Cap from the group record. 0 means unlimited (check isUnlimited first). */
  enrollmentCap: number;
  /** True if enrollmentCap is 0 (unlimited). When true, remainingSlots is 0. */
  isUnlimited: boolean;
  enrolledCount: number;
  pendingTokens: number;
  terminatedCount: number;
  totalTokens: number;
  /** Slots remaining before the cap blocks new tokens. Always 0 if isUnlimited. */
  remainingSlots: number;
}

/** Roster entry managed by the employer (pre-enrollment tracking).
 * Contains ONLY opaque hashes — no plaintext PII.
 * The HR Tool on the admin's machine holds the plaintext correlation table. */
export interface EmployerRosterEntry {
  employeeIdHash: string;
  groupIdHash: string;
  familyIdHash: string;
  tokenId: string | null;
  walletId: string | null;
  status: 'pending' | 'enrolled' | 'terminated';
  createdAt: number;
}

// ─── EmployerNode ────────────────────────────────────────────

export class EmployerNode extends EntityNodeBase {
  private tokenAuthority: TokenAuthority;
  private groups: Map<string, EmployerGroupRecord> = new Map();
  private roster: Map<string, EmployerRosterEntry> = new Map();
  private insurerUrl: string | null;
  private employerId: string;
  private sequencerUrl: string;

  /** Pseudo-walletId derived from employerId for messaging */
  private employerWalletId: string;

  /** Employer attestation (loaded from sequencer on startup if available) */
  private attestation: import('../l2/l2-types.js').EmployerAttestation | null = null;

  constructor(config: EmployerNodeConfig) {
    super({ ...config, role: 'employer' });
    this.tokenAuthority = new TokenAuthority(config.employerId);
    this.insurerUrl = config.insurerUrl ?? null;
    this.employerId = config.employerId;
    this.sequencerUrl = config.sequencerUrl;
    this.employerWalletId = Poseidon.hash([hashString(config.employerId)]).toString();
  }

  /** Refresh attestation from sequencer — returns true if a valid attestation was loaded.
   *  Used by POST /attestation/refresh to let the employer force-sync after marketplace activation. */
  async refreshAttestationFromSequencer(): Promise<{ loaded: boolean; authorizedPlanIds: string[]; reason?: string }> {
    try {
      const seqUrl = this.sequencerUrl.replace(/\/+$/, '');
      const attResp = await fetch(`${seqUrl}/rpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'l2_verifyEmployer', params: { employerId: this.employerId } }),
      });
      const attJson = await attResp.json() as any;
      if (attJson.result?.valid && attJson.result?.attestation) {
        this.setAttestation(attJson.result.attestation);
        return { loaded: true, authorizedPlanIds: attJson.result.attestation.authorizedPlanIds || [] };
      }
      return { loaded: false, authorizedPlanIds: [], reason: 'No attestation found on sequencer' };
    } catch (e: any) {
      return { loaded: false, authorizedPlanIds: [], reason: e?.message || 'Sequencer unreachable' };
    }
  }

  /** Set the employer attestation (loaded from sequencer) */
  setAttestation(att: import('../l2/l2-types.js').EmployerAttestation): void {
    this.attestation = att;
  }

  /** Get the employer attestation */
  getAttestation(): import('../l2/l2-types.js').EmployerAttestation | null {
    return this.attestation;
  }

  /** Whether attestation is required for plan authorization (set via config) */
  private requireAttestation = false;

  /** Set whether attestation is required (fail-closed vs fail-open) */
  setRequireAttestation(required: boolean): void {
    this.requireAttestation = required;
  }

  /** Check if a plan is authorized by the attestation */
  isPlanAuthorized(planId: string): boolean {
    if (!this.attestation) {
      // Fail-closed: in production mode we refuse everything without an attestation.
      // The only path that reaches here without an attestation is legacy fail-open mode.
      return !this.requireAttestation;
    }
    return this.attestation.authorizedPlanIds.includes(planId);
  }

  // ─── Group Management ──────────────────────────────────────

  /** Create a new employer group */
  createGroup(
    groupId: string,
    planId: string,
    effectiveDate: string,
    enrollmentCap: number = 0,
  ): EmployerGroupRecord {
    if (this.groups.has(groupId)) {
      throw new Error(`Group ${groupId} already exists`);
    }

    // Attestation enforcement (Phase A): ALWAYS require attestation in fail-closed mode.
    if (this.requireAttestation && !this.attestation) {
      throw new Error(
        `Employer node is in fail-closed mode but has no attestation loaded. ` +
        `createGroup refused. Complete the marketplace ceremony first.`,
      );
    }
    if (this.attestation && !this.attestation.authorizedPlanIds.includes(planId)) {
      throw new Error(
        `Plan "${planId}" is not authorized for this employer. ` +
        `Authorized plans: [${this.attestation.authorizedPlanIds.join(', ')}]`,
      );
    }

    const record: EmployerGroupRecord = {
      groupId,
      groupIdHash: Poseidon.hash([hashString(groupId)]).toString(),
      planId,
      planIdHash: Poseidon.hash([hashString(planId)]).toString(),
      effectiveDate,
      terminationDate: null,
      enrollmentCap,
      enrolledCount: 0,
      status: 'active',
      createdAt: Date.now(),
    };

    this.groups.set(groupId, record);
    return record;
  }

  /** Terminate a group */
  terminateGroup(groupId: string, terminationDate: string): void {
    const group = this.groups.get(groupId);
    if (!group) throw new Error(`Group ${groupId} not found`);
    if (group.status === 'terminated') throw new Error(`Group ${groupId} already terminated`);

    group.status = 'terminated';
    group.terminationDate = terminationDate;
  }

  /** List all groups */
  listGroups(): EmployerGroupRecord[] {
    return [...this.groups.values()];
  }

  /** Get a specific group */
  getGroup(groupId: string): EmployerGroupRecord | undefined {
    return this.groups.get(groupId);
  }

  /** Phase F1: Compute utilization stats for a group by counting roster entries.
   *  Returns null if the group does not exist. Counts are derived from the
   *  in-memory roster map — no persistence required.
   *
   *  Callers (HR Tool capacity check) should branch on `isUnlimited`:
   *    if (!stats.isUnlimited && csvRowCount > stats.remainingSlots) { reject }
   *
   *  When `isUnlimited` is true, `remainingSlots` is 0 (not a real bound) — the
   *  caller MUST check `isUnlimited` first before comparing remainingSlots. */
  getGroupStats(groupId: string): EmployerGroupStats | null {
    const group = this.groups.get(groupId);
    if (!group) return null;

    let enrolledCount = 0;
    let pendingTokens = 0;
    let terminatedCount = 0;
    for (const entry of this.roster.values()) {
      if (entry.groupIdHash !== group.groupIdHash) continue;
      if (entry.status === 'enrolled') enrolledCount++;
      else if (entry.status === 'pending') pendingTokens++;
      else if (entry.status === 'terminated') terminatedCount++;
    }
    const totalTokens = enrolledCount + pendingTokens + terminatedCount;
    // enrollmentCap === 0 means unlimited
    const isUnlimited = group.enrollmentCap === 0;
    const remainingSlots = isUnlimited
      ? 0
      : Math.max(0, group.enrollmentCap - enrolledCount - pendingTokens);

    return {
      groupId: group.groupId,
      planId: group.planId,
      effectiveDate: group.effectiveDate,
      status: group.status,
      enrollmentCap: group.enrollmentCap,
      isUnlimited,
      enrolledCount,
      pendingTokens,
      terminatedCount,
      totalTokens,
      remainingSlots,
    };
  }

  /** Phase F1: Return all groups with their utilization stats inlined so
   *  the HR Tool can populate the Group Selection Screen in one call. */
  listGroupsWithStats(): EmployerGroupStats[] {
    const out: EmployerGroupStats[] = [];
    for (const gid of this.groups.keys()) {
      const stats = this.getGroupStats(gid);
      if (stats) out.push(stats);
    }
    return out;
  }

  // ─── Token Management ──────────────────────────────────────

  /**
   * Generate an enrollment token for an employee.
   *
   * Accepts pre-hashed identifiers only — the HR Tool on the admin's machine
   * hashes plaintext PII with a groupSeed before calling this method.
   * The employer node never sees plaintext employee IDs or family IDs.
   */
  generateToken(
    groupId: string,
    employeeIdHash: string,
    familyIdHash: string,
    validUntil: string,
    tokenId?: string,
  ): { token: GroupEnrollmentToken; tokenId: string } {
    const group = this.groups.get(groupId);
    if (!group) throw new Error(`Group ${groupId} not found`);
    if (group.status === 'terminated') throw new Error(`Group ${groupId} is terminated`);

    if (group.enrollmentCap > 0 && group.enrolledCount >= group.enrollmentCap) {
      throw new Error(`Group ${groupId} has reached enrollment cap (${group.enrollmentCap})`);
    }

    const result = this.tokenAuthority.generateToken(
      groupId,
      group.planId,
      employeeIdHash,
      familyIdHash,
      validUntil,
      tokenId,
    );

    // Track on roster — hash-only, no plaintext PII
    this.roster.set(employeeIdHash, {
      employeeIdHash,
      groupIdHash: group.groupIdHash,
      familyIdHash,
      tokenId: result.tokenId,
      walletId: null,
      status: 'pending',
      createdAt: Date.now(),
    });

    return result;
  }

  /** Revoke an unused token */
  revokeToken(tokenId: string): void {
    this.tokenAuthority.revokeToken(tokenId);
  }

  /** Set the PIN hash on a token (called by HR Tool after token generation) */
  setTokenPinHash(tokenId: string, tokenPinHash: string): void {
    this.tokenAuthority.setTokenPinHash(tokenId, tokenPinHash);
  }

  /** Get token status */
  getTokenRecord(tokenId: string): TokenRecord | undefined {
    return this.tokenAuthority.getTokenRecord(tokenId);
  }

  /** Validate a token (without PIN) */
  validateToken(tokenId: string, currentDate: string): TokenValidationResult {
    return this.tokenAuthority.validateToken(tokenId, currentDate);
  }

  /** Validate a token with PIN (enrollment 2FA) */
  validateTokenWithPin(tokenId: string, currentDate: string, tokenPinHash?: string): TokenValidationResult {
    return this.tokenAuthority.validateTokenWithPin(tokenId, currentDate, tokenPinHash);
  }

  /**
   * Redeem a token at validation — phase A item A6. The employer learns that one of its codes was
   * used, and when; no wallet ID crosses this boundary (rule I6). The roster and enrollment-cap
   * bookkeeping that `confirmEnrollment` used to do on the member's say-so now happens here, on
   * the oracle's own verdict, which is the only place it can be trusted.
   */
  redeemTokenWithPin(
    tokenId: string,
    currentDate: string,
    tokenPinHash: string | undefined,
  ): TokenValidationResult & { consumed?: boolean } {
    const result = this.tokenAuthority.redeemTokenWithPin(tokenId, currentDate, tokenPinHash);
    if (result.valid && result.consumed) this.markRosterEnrolled(tokenId);
    return result;
  }

  /** Mark the roster entry that carries `tokenId` enrolled and count it against its group once. */
  private markRosterEnrolled(tokenId: string): void {
    for (const entry of this.roster.values()) {
      if (entry.tokenId !== tokenId) continue;
      if (entry.status !== 'enrolled') {
        entry.status = 'enrolled';
        for (const group of this.groups.values()) {
          if (group.groupIdHash === entry.groupIdHash) {
            group.enrolledCount++;
            break;
          }
        }
      }
      return;
    }
  }

  /**
   * The insurer public key this employer trusts: the one inside its own attestation, which the
   * sequencer only stored after verifying the insurer's counter-signature against the key it pins
   * (item A9). Null when no attestation is loaded, and every caller treats null as "refuse".
   */
  getInsurerPublicKeyHex(): string | null {
    const key = this.attestation?.insurerPublicKeyHex;
    return typeof key === 'string' && /^[0-9a-f]{64}$/i.test(key) ? key.toLowerCase() : null;
  }

  /** Get total tokens managed */
  get tokenCount(): number {
    return this.tokenAuthority.count;
  }

  // ─── Roster Management ─────────────────────────────────────

  /** List all roster entries */
  listRoster(): EmployerRosterEntry[] {
    return [...this.roster.values()];
  }

  /** Get roster entry by employee ID hash */
  getRosterEntry(employeeIdHash: string): EmployerRosterEntry | undefined {
    return this.roster.get(employeeIdHash);
  }

  /** Terminate a roster entry */
  terminateRosterEntry(employeeIdHash: string): void {
    const entry = this.roster.get(employeeIdHash);
    if (!entry) throw new Error('Roster entry not found');
    entry.status = 'terminated';
  }

  /** Get active roster count */
  get activeRosterCount(): number {
    let count = 0;
    for (const entry of this.roster.values()) {
      if (entry.status !== 'terminated') count++;
    }
    return count;
  }

  // ─── Messaging ────────────────────────────────────────────

  /** Get the employer's pseudo-walletId used for messaging */
  getEmployerWalletId(): string {
    return this.employerWalletId;
  }

  /**
   * Send a message via the sequencer message store.
   * Uses the employer's pseudo-walletId as sender.
   * Encrypts with recipient's X25519 public key if available (E2E).
   * Falls back to hex encoding for recipients without registered encryption keys.
   */
  async sendMessage(
    recipientWalletId: string,
    subject: string,
    body: string,
  ): Promise<MessageStoreEntry> {
    const plaintext = JSON.stringify({ subject, body });
    const threadIdHash = Poseidon.hash([
      Field(BigInt(this.employerWalletId)),
      hashString(recipientWalletId + ':' + subject),
    ]).toString();

    // Try E2E encryption: look up recipient's encryption key via direct fetch to sequencer
    let ciphertextHex: string;
    let ivHex = '00000000000000000000000000000000';
    let tagHex = '00000000000000000000000000000000';
    let ephemeralPublicKeyHex: string | undefined;

    try {
      // Fetch recipient's X25519 public key from sequencer (direct fetch — L2Client has no generic call())
      const seqUrl = (this.client as any).options.sequencerUrl.replace(/\/+$/, '');
      const keyResp = await fetch(`${seqUrl}/rpc`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'l2_getEncryptionKey', params: { walletId: recipientWalletId } }),
      });
      const keyJson = await keyResp.json() as any;

      if (keyJson.result?.encryptionPublicKeyHex) {
        // Employer has no enrollment key — use ephemeral X25519 keypair per message
        const { generateKeyPairSync } = await import('crypto');
        const { deriveSharedSecret, encryptMessage } = await import('../messaging/encryption.js');
        const ephKp = generateKeyPairSync('x25519');
        const ephPrivRaw = Buffer.from(ephKp.privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(16));
        const ephPubRaw = Buffer.from(ephKp.publicKey.export({ type: 'spki', format: 'der' }).subarray(12));
        ephemeralPublicKeyHex = ephPubRaw.toString('hex');
        const recipientPub = Buffer.from(keyJson.result.encryptionPublicKeyHex, 'hex');
        const shared = deriveSharedSecret(ephPrivRaw, recipientPub);
        const encrypted = encryptMessage(plaintext, shared);
        ciphertextHex = encrypted.ciphertext.toString('hex');
        ivHex = encrypted.iv.toString('hex');
        tagHex = encrypted.tag.toString('hex');
      } else {
        // Recipient has no encryption key — admin messages are not ePHI, hex fallback is acceptable
        ciphertextHex = Buffer.from(plaintext, 'utf8').toString('hex');
      }
    } catch {
      ciphertextHex = Buffer.from(plaintext, 'utf8').toString('hex');
    }

    const messageCommitment = Poseidon.hash([
      hashString(ciphertextHex.slice(0, 64)),
    ]).toString();

    return this.client.storeMessage(
      {
        messageCommitment,
        senderWalletId: this.employerWalletId,
        recipientWalletId,
        messageType: '2', // admin message type
        threadIdHash,
      },
      {
        ciphertext: ciphertextHex,
        iv: ivHex,
        tag: tagHex,
        // Include ephemeral public key so recipient can compute ECDH shared secret
        ephemeralPublicKeyHex: ephemeralPublicKeyHex ?? undefined,
        timestamp: Date.now(),
      } as any,
    );
  }

  /** Get messages received by this employer */
  async getInbox(): Promise<MessageStoreEntry[]> {
    return this.client.getMessagesByRecipient(this.employerWalletId);
  }

  /** Get messages sent by this employer */
  async getSent(): Promise<MessageStoreEntry[]> {
    return this.client.getMessagesBySender(this.employerWalletId);
  }

  /** Get all messages in a thread */
  async getThread(threadIdHash: string): Promise<MessageStoreEntry[]> {
    return this.client.getMessagesByThread(threadIdHash);
  }

  // ─── Sequencer Queries (Read-Only) ─────────────────────────

  /** Get current chain state from the sequencer */
  async getChainState(): Promise<L2ChainState> {
    return this.client.getChainState();
  }

  /** Get sequencer status */
  async getSequencerStatus() {
    return this.client.getStatus();
  }
}
