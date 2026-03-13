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
import { hashString, dateToField } from '../zkp/hash-utils.js';
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

/** Roster entry managed by the employer (pre-enrollment tracking) */
export interface EmployerRosterEntry {
  employeeId: string;
  employeeIdHash: string;
  groupId: string;
  familyId: string;
  familyIdHash: string;
  tokenId: string | null;
  status: 'pending' | 'enrolled' | 'terminated';
  createdAt: number;
}

// ─── EmployerNode ────────────────────────────────────────────

export class EmployerNode extends EntityNodeBase {
  private tokenAuthority: TokenAuthority;
  private groups: Map<string, EmployerGroupRecord> = new Map();
  private roster: Map<string, EmployerRosterEntry> = new Map();
  private insurerUrl: string | null;

  /** Pseudo-walletId derived from employerId for messaging */
  private employerWalletId: string;

  constructor(config: EmployerNodeConfig) {
    super({ ...config, role: 'employer' });
    this.tokenAuthority = new TokenAuthority(config.employerId);
    this.insurerUrl = config.insurerUrl ?? null;
    // Derive a stable pseudo-walletId from employerId for messaging queries
    this.employerWalletId = Poseidon.hash([hashString(config.employerId)]).toString();
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

  // ─── Token Management ──────────────────────────────────────

  /** Generate an enrollment token for an employee */
  generateToken(
    groupId: string,
    employeeId: string,
    familyId: string,
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
      employeeId,
      familyId,
      validUntil,
      tokenId,
    );

    // Track on roster
    const employeeIdHash = Poseidon.hash([hashString(employeeId)]).toString();
    const familyIdHash = Poseidon.hash([hashString(familyId)]).toString();
    this.roster.set(employeeIdHash, {
      employeeId,
      employeeIdHash,
      groupId,
      familyId,
      familyIdHash,
      tokenId: result.tokenId,
      status: 'pending',
      createdAt: Date.now(),
    });

    return result;
  }

  /** Revoke an unused token */
  revokeToken(tokenId: string): void {
    this.tokenAuthority.revokeToken(tokenId);
  }

  /** Get token status */
  getTokenRecord(tokenId: string): TokenRecord | undefined {
    return this.tokenAuthority.getTokenRecord(tokenId);
  }

  /** Validate a token */
  validateToken(tokenId: string, currentDate: string): TokenValidationResult {
    return this.tokenAuthority.validateToken(tokenId, currentDate);
  }

  /** Get total tokens managed */
  get tokenCount(): number {
    return this.tokenAuthority.count;
  }

  /**
   * Submit a token to the insurer Nautilus for enrollment processing.
   * HTTP POST to the insurer's /enrollment/process endpoint.
   */
  async submitTokenToInsurer(
    tokenId: string,
    walletId: string,
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.insurerUrl) {
      return { success: false, error: 'No insurer URL configured' };
    }

    const record = this.tokenAuthority.getTokenRecord(tokenId);
    if (!record) {
      return { success: false, error: 'Token not found' };
    }

    try {
      const resp = await fetch(`${this.insurerUrl}/enrollment/process`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          walletId,
          tokenId,
          role: 'member',
        }),
      });

      if (!resp.ok) {
        return { success: false, error: `Insurer returned ${resp.status}` };
      }

      // Mark enrolled on roster
      for (const entry of this.roster.values()) {
        if (entry.tokenId === tokenId) {
          entry.status = 'enrolled';
          break;
        }
      }

      // Increment group enrolled count
      const group = this.groups.get(record.localData.groupId);
      if (group) {
        group.enrolledCount++;
      }

      return { success: true };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: msg };
    }
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
   * Payload is stored as hex-encoded plaintext (employer has no encryption keys).
   */
  async sendMessage(
    recipientWalletId: string,
    subject: string,
    body: string,
  ): Promise<MessageStoreEntry> {
    const plaintext = JSON.stringify({ subject, body });
    const ciphertextHex = Buffer.from(plaintext, 'utf8').toString('hex');
    const threadIdHash = Poseidon.hash([
      Field(BigInt(this.employerWalletId)),
      hashString(recipientWalletId + ':' + subject),
    ]).toString();
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
        iv: '00000000000000000000000000000000',
        tag: '00000000000000000000000000000000',
        timestamp: Date.now(),
      },
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
