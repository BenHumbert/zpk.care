/**
 * AOR (Appointment of Representative) — Fast Tests
 *
 * Tests the full AOR lifecycle:
 *   - Representative wallet derivation (domain tag 3)
 *   - AOR document validation (CMS-1696 compliance)
 *   - AOR commitment construction
 *   - AOR confirmation hash (member→rep binding)
 *   - AorService workflow (initiation, delegation, cooldown, TTL, rate limit)
 *   - RepEnrollmentToken
 *   - PortableDelegationCredential serialization
 *   - secureRepresentativeDerivation
 *
 * All tests are fast (no ZkProgram compilation).
 */

import { Field, Poseidon } from 'o1js';
import {
  DOMAIN_TAG_REPRESENTATIVE,
  DOMAIN_TAG_MEMBER,
  deriveRepresentativeWalletId,
  representativeWalletPreimage,
  validateEnrollmentKey,
  generateEnrollmentKey,
} from '../src/wallets/wallet-derivation.js';
import type { RepresentativeLocalData } from '../src/wallets/wallet-derivation.js';
import {
  REL_APPOINTED_REPRESENTATIVE,
  REL_SPOUSE,
  SCOPE_READ,
  SCOPE_WRITE,
  SCOPE_PICKUP,
  SCOPE_ALL,
  DelegationData,
} from '../src/messaging/delegation-data.js';
import {
  MSG_TYPE_AOR_INITIATE,
  MSG_TYPE_AOR_CONFIRMED,
  MSG_TYPE_AOR_REVOKE,
  PICKUP_COOLDOWN_MS,
  AOR_DEFAULT_VALIDITY_DAYS,
  AOR_RATE_LIMIT_MS,
  OFFLINE_TTL_MS,
  validateAorDocument,
  buildAorCommitment,
  buildAorConfirmationHash,
} from '../src/messaging/aor-data.js';
import type { AorLocalData } from '../src/messaging/aor-data.js';
import { AorService } from '../src/messaging/aor-service.js';
import {
  RepEnrollmentToken,
  buildRepEnrollmentToken,
} from '../src/onboarding/rep-enrollment-token.js';
import {
  MessageRegistry,
  DelegationRegistry,
  KeyRegistry,
  computeMessagingRoot,
} from '../src/messaging/message-registry.js';
import { MessageData } from '../src/messaging/message-data.js';
import { MessagingService } from '../src/messaging/messaging-service.js';
import { InMemoryStore } from '../src/storage/local-store.js';
import {
  secureRepresentativeDerivation,
} from '../src/security/secure-context.js';
import { isScrubbed } from '../src/security/secure-scrub.js';
import { hashString, dateToField, codeToField } from '../src/zkp/hash-utils.js';
import {
  serializeDelegationCredential,
  deserializeDelegationCredential,
} from '../src/nft/portable-credential.js';

// ─── Test Data ───────────────────────────────────────────────

const ENROLLMENT_KEY = generateEnrollmentKey();
const ALT_ENROLLMENT_KEY = generateEnrollmentKey();

const REP_LOCAL: RepresentativeLocalData = {
  representativeIdQualifier: 1, // Driver's License
  representativeId: 'DL-123456789',
};

const REP_LOCAL_2: RepresentativeLocalData = {
  representativeIdQualifier: 3, // Bar Number
  representativeId: 'BAR-98765',
};

function makeAorSection1(): Partial<AorLocalData> {
  return {
    partyFullName: 'John A. Doe',
    partyIdentifier: 'MBR-001',
    partyAddress: '123 Main St, Springfield, IL 62701',
    partyPhone: '555-0100',
    partySignature: Buffer.from('party-sig-data').toString('base64'),
    partySignedDate: '20260101',
    feeWaived: false,
    liabilityWaiverApplicable: false,
  };
}

function makeFullAor(): AorLocalData {
  return {
    ...makeAorSection1() as AorLocalData,
    repFullName: 'Jane B. Smith, Esq.',
    repProfessionalStatus: 'Attorney',
    repPhone: '555-0200',
    repAddress: '456 Oak Ave, Springfield, IL 62702',
    repSignature: Buffer.from('rep-sig-data').toString('base64'),
    repSignedDate: '20260102',
    feeWaived: true,
    feeWaiverSignature: Buffer.from('fee-waiver-sig').toString('base64'),
    feeWaiverDate: '20260102',
    liabilityWaiverApplicable: false,
  };
}

const MEMBER_WALLET_ID = Field(12345678901234n);
const REP_WALLET_ID = Field(98765432109876n);
const ADMIN_WALLET_ID = Field(55555555555555n);

// ─── Representative Wallet Derivation ────────────────────────

describe('Representative Wallet Derivation', () => {
  test('derives deterministic wallet ID', () => {
    const id1 = deriveRepresentativeWalletId(REP_LOCAL, ENROLLMENT_KEY);
    const id2 = deriveRepresentativeWalletId(REP_LOCAL, ENROLLMENT_KEY);
    expect(id1.toString()).toBe(id2.toString());
  });

  test('different data produces different wallet ID', () => {
    const id1 = deriveRepresentativeWalletId(REP_LOCAL, ENROLLMENT_KEY);
    const id2 = deriveRepresentativeWalletId(REP_LOCAL_2, ENROLLMENT_KEY);
    expect(id1.toString()).not.toBe(id2.toString());
  });

  test('different enrollment key produces different wallet ID', () => {
    const id1 = deriveRepresentativeWalletId(REP_LOCAL, ENROLLMENT_KEY);
    const id2 = deriveRepresentativeWalletId(REP_LOCAL, ALT_ENROLLMENT_KEY);
    expect(id1.toString()).not.toBe(id2.toString());
  });

  test('domain tag 3 prevents collision with member domain tag 0', () => {
    // Even if qualifier and id hash are the same, domain tag differs
    const repId = Poseidon.hash([
      DOMAIN_TAG_REPRESENTATIVE,
      codeToField(1),
      hashString('TEST-ID'),
      hashString(ENROLLMENT_KEY),
    ]);
    const memberId = Poseidon.hash([
      DOMAIN_TAG_MEMBER,
      codeToField(1),
      hashString('TEST-ID'),
      hashString(ENROLLMENT_KEY),
    ]);
    expect(repId.toString()).not.toBe(memberId.toString());
  });

  test('preimage has 3 fields', () => {
    const preimage = representativeWalletPreimage(REP_LOCAL, ENROLLMENT_KEY);
    expect(preimage).toHaveLength(3);
  });

  test('preimage reconstructs wallet ID when hashed with domain tag', () => {
    const preimage = representativeWalletPreimage(REP_LOCAL, ENROLLMENT_KEY);
    const reconstructed = Poseidon.hash([DOMAIN_TAG_REPRESENTATIVE, ...preimage]);
    const expected = deriveRepresentativeWalletId(REP_LOCAL, ENROLLMENT_KEY);
    expect(reconstructed.toString()).toBe(expected.toString());
  });

  test('rejects weak enrollment key', () => {
    expect(() => deriveRepresentativeWalletId(REP_LOCAL, 'short')).toThrow(
      'at least 16 characters',
    );
  });
});

// ─── AOR Document Validation (CMS-1696) ─────────────────────

describe('AOR Document Validation', () => {
  test('validates complete AOR document', () => {
    const result = validateAorDocument(makeFullAor());
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test('rejects missing Section 1 fields', () => {
    const aor = makeFullAor();
    aor.partyFullName = '';
    aor.partyPhone = '';
    const result = validateAorDocument(aor);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
    expect(result.errors.some(e => e.includes('Party full name'))).toBe(true);
    expect(result.errors.some(e => e.includes('Party phone'))).toBe(true);
  });

  test('rejects missing Section 2 fields', () => {
    const aor = makeFullAor();
    aor.repFullName = '';
    aor.repSignature = '';
    const result = validateAorDocument(aor);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('Representative name'))).toBe(true);
    expect(result.errors.some(e => e.includes('Representative signature'))).toBe(true);
  });

  test('requires fee waiver signature when fees are waived', () => {
    const aor = makeFullAor();
    aor.feeWaived = true;
    aor.feeWaiverSignature = undefined;
    const result = validateAorDocument(aor);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('Fee waiver signature'))).toBe(true);
  });

  test('requires liability waiver signature when applicable', () => {
    const aor = makeFullAor();
    aor.liabilityWaiverApplicable = true;
    aor.liabilityWaiverSignature = undefined;
    const result = validateAorDocument(aor);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('Liability waiver'))).toBe(true);
  });

  test('accepts liability waiver when not applicable', () => {
    const aor = makeFullAor();
    aor.liabilityWaiverApplicable = false;
    aor.liabilityWaiverSignature = undefined;
    const result = validateAorDocument(aor);
    expect(result.valid).toBe(true);
  });
});

// ─── AOR Commitment ──────────────────────────────────────────

describe('AOR Commitment', () => {
  test('produces deterministic commitment', () => {
    const aor = makeFullAor();
    const c1 = buildAorCommitment(aor);
    const c2 = buildAorCommitment(aor);
    expect(c1.toString()).toBe(c2.toString());
  });

  test('different AOR data produces different commitment', () => {
    const aor1 = makeFullAor();
    const aor2 = makeFullAor();
    aor2.repFullName = 'Different Name';
    expect(buildAorCommitment(aor1).toString()).not.toBe(
      buildAorCommitment(aor2).toString(),
    );
  });

  test('confirmation hash binds member to specific rep', () => {
    const aorCommitment = buildAorCommitment(makeFullAor());
    const hash = buildAorConfirmationHash(
      MEMBER_WALLET_ID,
      REP_WALLET_ID,
      aorCommitment,
      SCOPE_ALL,
    );
    // Different rep produces different hash
    const otherRepWallet = Field(11111111111111n);
    const hash2 = buildAorConfirmationHash(
      MEMBER_WALLET_ID,
      otherRepWallet,
      aorCommitment,
      SCOPE_ALL,
    );
    expect(hash.toString()).not.toBe(hash2.toString());
  });

  test('confirmation hash includes scope', () => {
    const aorCommitment = buildAorCommitment(makeFullAor());
    const hashAll = buildAorConfirmationHash(
      MEMBER_WALLET_ID,
      REP_WALLET_ID,
      aorCommitment,
      SCOPE_ALL,
    );
    const hashRead = buildAorConfirmationHash(
      MEMBER_WALLET_ID,
      REP_WALLET_ID,
      aorCommitment,
      SCOPE_READ,
    );
    expect(hashAll.toString()).not.toBe(hashRead.toString());
  });
});

// ─── AorService — Initiation & Rate Limiting ────────────────

describe('AorService — Initiation', () => {
  test('prepareInitiation validates Section 1 and returns commitment', () => {
    const registry = new MessageRegistry();
    const aor = makeFullAor();
    const result = AorService.prepareInitiation(
      aor,
      MEMBER_WALLET_ID,
      registry,
      Date.now(),
    );
    expect(result.validation.valid).toBe(true);
    expect(result.rateLimited).toBe(false);
    expect(result.aorCommitment.toString().length).toBeGreaterThan(0);
  });

  test('detects rate limit when recent AOR_INITIATE exists', () => {
    const registry = new MessageRegistry();
    const now = Date.now();
    // Add a recent AOR_INITIATE message
    registry.addMessage(new MessageData({
      senderWalletId: MEMBER_WALLET_ID,
      recipientWalletId: Field(0),
      contentHash: Field(0),
      messageType: MSG_TYPE_AOR_INITIATE,
      timestamp: Field(BigInt(now - 1000)), // 1 second ago
      threadId: Field(0),
      nonce: Field(1),
    }));

    const result = AorService.prepareInitiation(
      makeFullAor(),
      MEMBER_WALLET_ID,
      registry,
      now,
    );
    expect(result.rateLimited).toBe(true);
  });

  test('allows initiation when AOR_INITIATE is older than 24h', () => {
    const registry = new MessageRegistry();
    const now = Date.now();
    registry.addMessage(new MessageData({
      senderWalletId: MEMBER_WALLET_ID,
      recipientWalletId: Field(0),
      contentHash: Field(0),
      messageType: MSG_TYPE_AOR_INITIATE,
      timestamp: Field(BigInt(now - AOR_RATE_LIMIT_MS - 1000)),
      threadId: Field(0),
      nonce: Field(1),
    }));

    const result = AorService.prepareInitiation(
      makeFullAor(),
      MEMBER_WALLET_ID,
      registry,
      now,
    );
    expect(result.rateLimited).toBe(false);
  });

  test('rate limit only applies to same member', () => {
    const registry = new MessageRegistry();
    const now = Date.now();
    const otherMember = Field(99999n);
    registry.addMessage(new MessageData({
      senderWalletId: otherMember,
      recipientWalletId: Field(0),
      contentHash: Field(0),
      messageType: MSG_TYPE_AOR_INITIATE,
      timestamp: Field(BigInt(now - 1000)),
      threadId: Field(0),
      nonce: Field(1),
    }));

    const result = AorService.prepareInitiation(
      makeFullAor(),
      MEMBER_WALLET_ID,
      registry,
      now,
    );
    expect(result.rateLimited).toBe(false);
  });
});

// ─── AorService — Delegation Building ───────────────────────

describe('AorService — Delegation', () => {
  test('buildDelegation creates correct DelegationData', () => {
    const aorCommitment = buildAorCommitment(makeFullAor());
    const result = AorService.buildDelegation(
      MEMBER_WALLET_ID,
      REP_WALLET_ID,
      SCOPE_ALL,
      '20260115',
      aorCommitment,
    );

    expect(result.delegationData.delegatorWalletId.toString()).toBe(MEMBER_WALLET_ID.toString());
    expect(result.delegationData.delegateWalletId.toString()).toBe(REP_WALLET_ID.toString());
    expect(result.delegationData.scopeFlags.toString()).toBe(SCOPE_ALL.toString());
    expect(result.delegationData.relationshipCode.toString()).toBe(
      REL_APPOINTED_REPRESENTATIVE.toString(),
    );
    expect(result.delegationData.delegationHash.toString()).toBe(aorCommitment.toString());
  });

  test('default validity is 365 days', () => {
    const aorCommitment = buildAorCommitment(makeFullAor());
    const result = AorService.buildDelegation(
      MEMBER_WALLET_ID,
      REP_WALLET_ID,
      SCOPE_ALL,
      '20260115',
      aorCommitment,
    );
    // 20260115 + 365 days = 20270115
    expect(result.expirationDate).toBe('20270115');
  });

  test('custom validity period works', () => {
    const aorCommitment = buildAorCommitment(makeFullAor());
    const result = AorService.buildDelegation(
      MEMBER_WALLET_ID,
      REP_WALLET_ID,
      SCOPE_READ,
      '20260115',
      aorCommitment,
      30, // 30 days
    );
    // 20260115 + 30 days = 20260214
    expect(result.expirationDate).toBe('20260214');
  });

  test('delegation commitment is non-zero', () => {
    const aorCommitment = buildAorCommitment(makeFullAor());
    const { delegationData } = AorService.buildDelegation(
      MEMBER_WALLET_ID,
      REP_WALLET_ID,
      SCOPE_ALL,
      '20260115',
      aorCommitment,
    );
    expect(delegationData.commitment().toString()).not.toBe('0');
  });
});

// ─── AorService — Pickup Cool-Down ──────────────────────────

describe('AorService — Pickup Cool-Down', () => {
  function makeDelegation(scope: Field, effectiveDateStr: string): DelegationData {
    return new DelegationData({
      delegatorWalletId: MEMBER_WALLET_ID,
      delegateWalletId: REP_WALLET_ID,
      scopeFlags: scope,
      effectiveDate: dateToField(effectiveDateStr),
      expirationDate: dateToField('20271231'),
      relationshipCode: REL_APPOINTED_REPRESENTATIVE,
      delegationHash: Field(123n),
    });
  }

  test('PICKUP is blocked during 48h cool-down', () => {
    const delegation = makeDelegation(SCOPE_PICKUP, '20260115');
    // 20260115 00:00:00 + 1 hour
    const effectiveMs = new Date(2026, 0, 15).getTime();
    const oneHourLater = effectiveMs + 3600000;

    const result = AorService.isPickupEligible(delegation, oneHourLater);
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain('cool-down');
    expect(result.cooldownRemainingMs).toBeGreaterThan(0);
  });

  test('PICKUP is allowed after 48h cool-down', () => {
    const delegation = makeDelegation(SCOPE_PICKUP, '20260115');
    const effectiveMs = new Date(2026, 0, 15).getTime();
    const after48h = effectiveMs + PICKUP_COOLDOWN_MS + 1000;

    const result = AorService.isPickupEligible(delegation, after48h);
    expect(result.eligible).toBe(true);
    expect(result.cooldownRemainingMs).toBe(0);
  });

  test('reports ineligible if no PICKUP scope', () => {
    const delegation = makeDelegation(SCOPE_READ, '20260115');
    const result = AorService.isPickupEligible(delegation, Date.now());
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain('does not include PICKUP');
  });

  test('reports ineligible if delegation expired', () => {
    const delegation = new DelegationData({
      delegatorWalletId: MEMBER_WALLET_ID,
      delegateWalletId: REP_WALLET_ID,
      scopeFlags: SCOPE_PICKUP,
      effectiveDate: dateToField('20240101'),
      expirationDate: dateToField('20250101'), // expired
      relationshipCode: REL_APPOINTED_REPRESENTATIVE,
      delegationHash: Field(123n),
    });

    const result = AorService.isPickupEligible(delegation, Date.now());
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain('expired');
  });
});

// ─── AorService — Offline TTL ────────────────────────────────

describe('AorService — Offline TTL', () => {
  const now = Date.now();

  test('READ scope allows 72h staleness', () => {
    const stale = now - 70 * 3600000; // 70h ago
    const result = AorService.isOfflineCredentialValid(stale, 1, now); // SCOPE_READ=1
    expect(result.valid).toBe(true);
    expect(result.ttlMs).toBe(OFFLINE_TTL_MS.READ);
  });

  test('READ scope rejects >72h staleness', () => {
    const stale = now - 73 * 3600000; // 73h ago
    const result = AorService.isOfflineCredentialValid(stale, 1, now);
    expect(result.valid).toBe(false);
  });

  test('WRITE scope allows 24h staleness', () => {
    const stale = now - 23 * 3600000;
    const result = AorService.isOfflineCredentialValid(stale, 2, now); // SCOPE_WRITE=2
    expect(result.valid).toBe(true);
    expect(result.ttlMs).toBe(OFFLINE_TTL_MS.WRITE);
  });

  test('WRITE scope rejects >24h staleness', () => {
    const stale = now - 25 * 3600000;
    const result = AorService.isOfflineCredentialValid(stale, 2, now);
    expect(result.valid).toBe(false);
  });

  test('PICKUP scope allows 4h staleness', () => {
    const stale = now - 3 * 3600000;
    const result = AorService.isOfflineCredentialValid(stale, 4, now); // SCOPE_PICKUP=4
    expect(result.valid).toBe(true);
    expect(result.ttlMs).toBe(OFFLINE_TTL_MS.PICKUP);
  });

  test('PICKUP scope rejects >4h staleness', () => {
    const stale = now - 5 * 3600000;
    const result = AorService.isOfflineCredentialValid(stale, 4, now);
    expect(result.valid).toBe(false);
  });

  test('combined scope uses strictest TTL', () => {
    // SCOPE_ALL = 7 (READ + WRITE + PICKUP)
    const stale = now - 5 * 3600000;
    const result = AorService.isOfflineCredentialValid(stale, 7, now);
    expect(result.valid).toBe(false); // PICKUP TTL (4h) applies
    expect(result.ttlMs).toBe(OFFLINE_TTL_MS.PICKUP);
  });
});

// ─── AorService — Date Helpers ───────────────────────────────

describe('AorService — Date Helpers', () => {
  test('computeExpirationDate adds days correctly', () => {
    expect(AorService.computeExpirationDate('20260115', 365)).toBe('20270115');
    expect(AorService.computeExpirationDate('20260228', 1)).toBe('20260301'); // leap year 2026? No, 2026 is not leap
    expect(AorService.computeExpirationDate('20260115', 30)).toBe('20260214');
  });

  test('timestampToDateNum converts correctly', () => {
    const jan15 = new Date(2026, 0, 15).getTime();
    expect(AorService.timestampToDateNum(jan15)).toBe(20260115);
  });

  test('dateNumToTimestamp round-trips', () => {
    const dateNum = 20260315;
    const ts = AorService.dateNumToTimestamp(dateNum);
    expect(AorService.timestampToDateNum(ts)).toBe(dateNum);
  });
});

// ─── RepEnrollmentToken ──────────────────────────────────────

describe('RepEnrollmentToken', () => {
  test('builds from local data', () => {
    const token = buildRepEnrollmentToken({
      tokenId: 'tok-001',
      memberWalletId: MEMBER_WALLET_ID.toBigInt().toString(),
      scopeFlags: 7,
      validUntil: '20260116',
      issuer: 'ACME Insurance',
      nonce: 1,
    });
    expect(token.memberWalletId.toString()).toBe(MEMBER_WALLET_ID.toString());
    expect(token.scopeFlags.toString()).toBe('7');
  });

  test('commitment is deterministic', () => {
    const local = {
      tokenId: 'tok-002',
      memberWalletId: '12345',
      scopeFlags: 5,
      validUntil: '20260116',
      issuer: 'ACME Insurance',
      nonce: 2,
    };
    const t1 = buildRepEnrollmentToken(local);
    const t2 = buildRepEnrollmentToken(local);
    expect(t1.commitment().toString()).toBe(t2.commitment().toString());
  });

  test('different tokenId produces different commitment', () => {
    const t1 = buildRepEnrollmentToken({
      tokenId: 'tok-A',
      memberWalletId: '12345',
      scopeFlags: 7,
      validUntil: '20260116',
      issuer: 'ACME',
      nonce: 1,
    });
    const t2 = buildRepEnrollmentToken({
      tokenId: 'tok-B',
      memberWalletId: '12345',
      scopeFlags: 7,
      validUntil: '20260116',
      issuer: 'ACME',
      nonce: 1,
    });
    expect(t1.commitment().toString()).not.toBe(t2.commitment().toString());
  });
});

// ─── PortableDelegationCredential ────────────────────────────

describe('PortableDelegationCredential', () => {
  test('serializes and deserializes', () => {
    const delegation = new DelegationData({
      delegatorWalletId: MEMBER_WALLET_ID,
      delegateWalletId: REP_WALLET_ID,
      scopeFlags: SCOPE_ALL,
      effectiveDate: dateToField('20260115'),
      expirationDate: dateToField('20270115'),
      relationshipCode: REL_APPOINTED_REPRESENTATIVE,
      delegationHash: Field(999n),
    });

    const credential = serializeDelegationCredential(
      delegation,
      0n,
      [Field(1), Field(2), Field(3)],
      [true, false, true],
      Field(111n),
      Field(222n),
      Date.now() - 1000,
    );

    expect(credential.version).toBe(1);
    expect(credential.credentialType).toBe('delegation');
    expect(credential.delegation.delegatorWalletId).toBe(MEMBER_WALLET_ID.toString());
    expect(credential.delegation.delegateWalletId).toBe(REP_WALLET_ID.toString());

    // Round-trip
    const json = JSON.stringify(credential);
    const restored = deserializeDelegationCredential(json);
    expect(restored.delegation.scopeFlags).toBe(SCOPE_ALL.toString());
    expect(restored.witnessIsLefts).toEqual([true, false, true]);
  });
});

// ─── secureRepresentativeDerivation ──────────────────────────

describe('secureRepresentativeDerivation', () => {
  test('derives wallet ID and scrubs input', () => {
    const localData: RepresentativeLocalData = {
      representativeIdQualifier: 1,
      representativeId: 'DL-SCRUB-TEST',
    };
    const key = generateEnrollmentKey();

    const result = secureRepresentativeDerivation(localData, key);

    // Wallet ID should be non-zero
    expect(result.walletId.toString()).not.toBe('0');

    // Preimage should have 3 fields
    expect(result.preimage).toHaveLength(3);

    // Input should be scrubbed
    expect(isScrubbed(localData as unknown as Record<string, unknown>)).toBe(true);

    // Dispose clears preimage
    result.dispose();
    expect(result.preimage).toHaveLength(0);
  });

  test('produces same wallet ID as direct derivation', () => {
    const localData: RepresentativeLocalData = {
      representativeIdQualifier: 2,
      representativeId: 'STATE-ID-777',
    };
    const key = generateEnrollmentKey();

    // Direct derivation first (for comparison)
    const directId = deriveRepresentativeWalletId(
      { ...localData },
      key,
    );

    // Secure derivation
    const result = secureRepresentativeDerivation(localData, key);
    expect(result.walletId.toString()).toBe(directId.toString());
    result.dispose();
  });
});

// ─── AorService — Full Workflow Integration ──────────────────

describe('AorService — Full Workflow', () => {
  test('end-to-end: initiate → validate → confirm → build delegation', () => {
    const registry = new MessageRegistry();
    const now = Date.now();

    // Step 1: Member initiates
    const aor = makeFullAor();
    const initResult = AorService.prepareInitiation(
      aor,
      MEMBER_WALLET_ID,
      registry,
      now,
    );
    expect(initResult.validation.valid).toBe(true);
    expect(initResult.rateLimited).toBe(false);

    // Step 2: Rep completes (full validation)
    const validationResult = AorService.validateCompletion(aor);
    expect(validationResult.valid).toBe(true);

    // Step 3: Member confirms
    const aorCommitment = buildAorCommitment(aor);
    const confirmHash = AorService.buildConfirmationHash(
      MEMBER_WALLET_ID,
      REP_WALLET_ID,
      aorCommitment,
      SCOPE_ALL,
    );
    expect(confirmHash.toString().length).toBeGreaterThan(0);

    // Step 4: Insurer builds delegation
    const delResult = AorService.buildDelegation(
      MEMBER_WALLET_ID,
      REP_WALLET_ID,
      SCOPE_ALL,
      '20260115',
      aorCommitment,
    );
    expect(delResult.delegationData.delegatorWalletId.toString()).toBe(
      MEMBER_WALLET_ID.toString(),
    );
    expect(delResult.delegationData.delegateWalletId.toString()).toBe(
      REP_WALLET_ID.toString(),
    );
    expect(delResult.expirationDate).toBe('20270115');

    // Step 5: Verify pickup not yet eligible (cool-down)
    const pickupResult = AorService.isPickupEligible(
      delResult.delegationData,
      new Date(2026, 0, 15, 12, 0, 0).getTime(), // 12h after effective
    );
    expect(pickupResult.eligible).toBe(false);
    expect(pickupResult.reason).toContain('cool-down');

    // Step 6: Verify pickup eligible after 48h
    const pickupLater = AorService.isPickupEligible(
      delResult.delegationData,
      new Date(2026, 0, 17, 12, 0, 0).getTime(), // 60h after effective
    );
    expect(pickupLater.eligible).toBe(true);
  });
});

// ─── DelegationRegistry — revokeDelegation + findByWallets ──

describe('DelegationRegistry — Revocation', () => {
  function makeAorDelegation(): DelegationData {
    return new DelegationData({
      delegatorWalletId: MEMBER_WALLET_ID,
      delegateWalletId: REP_WALLET_ID,
      scopeFlags: SCOPE_ALL,
      effectiveDate: dateToField('20260115'),
      expirationDate: dateToField('20270115'),
      relationshipCode: REL_APPOINTED_REPRESENTATIVE,
      delegationHash: Field(999n),
    });
  }

  test('revokeDelegation zeros the leaf and changes root', () => {
    const registry = new DelegationRegistry();
    const delegation = makeAorDelegation();
    const { index, newRoot: rootAfterAdd } = registry.addDelegation(delegation);

    const { newRoot: rootAfterRevoke } = registry.revokeDelegation(index);

    // Root changed
    expect(rootAfterRevoke.toString()).not.toBe(rootAfterAdd.toString());
    // Delegation is gone
    expect(registry.getDelegation(index)).toBeUndefined();
  });

  test('revokeDelegation throws for empty slot', () => {
    const registry = new DelegationRegistry();
    expect(() => registry.revokeDelegation(0n)).toThrow('empty or already revoked');
  });

  test('revokeDelegation throws for already-revoked slot', () => {
    const registry = new DelegationRegistry();
    const { index } = registry.addDelegation(makeAorDelegation());
    registry.revokeDelegation(index);
    // Second revoke throws
    expect(() => registry.revokeDelegation(index)).toThrow('empty or already revoked');
  });

  test('count decreases after revocation', () => {
    const registry = new DelegationRegistry();
    registry.addDelegation(makeAorDelegation());
    expect(registry.count).toBe(1);
    registry.revokeDelegation(0n);
    expect(registry.count).toBe(0);
  });

  test('findByWallets locates existing delegation', () => {
    const registry = new DelegationRegistry();
    const delegation = makeAorDelegation();
    const { index } = registry.addDelegation(delegation);

    const found = registry.findByWallets(MEMBER_WALLET_ID, REP_WALLET_ID);
    expect(found).toBeDefined();
    expect(found!.index).toBe(index);
    expect(found!.delegation.relationshipCode.toString()).toBe(
      REL_APPOINTED_REPRESENTATIVE.toString(),
    );
  });

  test('findByWallets returns undefined for unknown pair', () => {
    const registry = new DelegationRegistry();
    registry.addDelegation(makeAorDelegation());

    const found = registry.findByWallets(Field(999n), Field(888n));
    expect(found).toBeUndefined();
  });

  test('findByWallets returns undefined after revocation', () => {
    const registry = new DelegationRegistry();
    const { index } = registry.addDelegation(makeAorDelegation());
    registry.revokeDelegation(index);

    const found = registry.findByWallets(MEMBER_WALLET_ID, REP_WALLET_ID);
    expect(found).toBeUndefined();
  });
});

// ─── AorService — Revocation ────────────────────────────────

describe('AorService — Revocation', () => {
  function buildRegistryWithAor(): {
    delegationRegistry: DelegationRegistry;
    delegationIndex: bigint;
  } {
    const delegationRegistry = new DelegationRegistry();
    const aorCommitment = buildAorCommitment(makeFullAor());
    const { delegationData } = AorService.buildDelegation(
      MEMBER_WALLET_ID,
      REP_WALLET_ID,
      SCOPE_ALL,
      '20260115',
      aorCommitment,
    );
    const { index } = delegationRegistry.addDelegation(delegationData);
    return { delegationRegistry, delegationIndex: index };
  }

  test('member can revoke their own AOR', () => {
    const { delegationRegistry, delegationIndex } = buildRegistryWithAor();

    const result = AorService.revokeAor(
      MEMBER_WALLET_ID,
      REP_WALLET_ID,
      MEMBER_WALLET_ID, // revoker = member
      ADMIN_WALLET_ID,
      delegationRegistry,
    );

    expect(result.valid).toBe(true);
    expect(result.reason).toBe('Revoked by member');
    expect(result.delegationIndex).toBe(delegationIndex);
    expect(result.newDelegationRoot).toBeDefined();
  });

  test('admin can revoke an AOR', () => {
    const { delegationRegistry } = buildRegistryWithAor();

    const result = AorService.revokeAor(
      MEMBER_WALLET_ID,
      REP_WALLET_ID,
      ADMIN_WALLET_ID, // revoker = admin
      ADMIN_WALLET_ID,
      delegationRegistry,
    );

    expect(result.valid).toBe(true);
    expect(result.reason).toBe('Revoked by insurer admin');
  });

  test('representative cannot revoke', () => {
    const { delegationRegistry } = buildRegistryWithAor();

    const result = AorService.revokeAor(
      MEMBER_WALLET_ID,
      REP_WALLET_ID,
      REP_WALLET_ID, // revoker = rep (unauthorized)
      ADMIN_WALLET_ID,
      delegationRegistry,
    );

    expect(result.valid).toBe(false);
    expect(result.reason).toContain('Only the member or insurer admin');
  });

  test('random wallet cannot revoke', () => {
    const { delegationRegistry } = buildRegistryWithAor();

    const result = AorService.revokeAor(
      MEMBER_WALLET_ID,
      REP_WALLET_ID,
      Field(777n), // random wallet
      ADMIN_WALLET_ID,
      delegationRegistry,
    );

    expect(result.valid).toBe(false);
  });

  test('revocation fails for non-existent delegation', () => {
    const delegationRegistry = new DelegationRegistry();

    const result = AorService.revokeAor(
      MEMBER_WALLET_ID,
      REP_WALLET_ID,
      MEMBER_WALLET_ID,
      ADMIN_WALLET_ID,
      delegationRegistry,
    );

    expect(result.valid).toBe(false);
    expect(result.reason).toContain('No active delegation');
  });

  test('revocation fails for non-AOR delegation (e.g. spouse)', () => {
    const delegationRegistry = new DelegationRegistry();
    // Add a spouse delegation (not an AOR)
    const spouseDelegation = new DelegationData({
      delegatorWalletId: MEMBER_WALLET_ID,
      delegateWalletId: REP_WALLET_ID,
      scopeFlags: SCOPE_ALL,
      effectiveDate: dateToField('20260115'),
      expirationDate: dateToField('20270115'),
      relationshipCode: REL_SPOUSE,
      delegationHash: Field(0),
    });
    delegationRegistry.addDelegation(spouseDelegation);

    const result = AorService.revokeAor(
      MEMBER_WALLET_ID,
      REP_WALLET_ID,
      MEMBER_WALLET_ID,
      ADMIN_WALLET_ID,
      delegationRegistry,
    );

    expect(result.valid).toBe(false);
    expect(result.reason).toContain('not an AOR');
  });

  test('double revocation fails', () => {
    const { delegationRegistry } = buildRegistryWithAor();

    // First revocation succeeds
    const result1 = AorService.revokeAor(
      MEMBER_WALLET_ID,
      REP_WALLET_ID,
      MEMBER_WALLET_ID,
      ADMIN_WALLET_ID,
      delegationRegistry,
    );
    expect(result1.valid).toBe(true);

    // Second revocation fails (delegation no longer found)
    const result2 = AorService.revokeAor(
      MEMBER_WALLET_ID,
      REP_WALLET_ID,
      MEMBER_WALLET_ID,
      ADMIN_WALLET_ID,
      delegationRegistry,
    );
    expect(result2.valid).toBe(false);
    expect(result2.reason).toContain('No active delegation');
  });

  test('isDelegationActive reflects revocation', () => {
    const { delegationRegistry, delegationIndex } = buildRegistryWithAor();

    // Active before revocation
    expect(AorService.isDelegationActive(delegationIndex, delegationRegistry)).toBe(true);

    // Revoke
    AorService.revokeAor(
      MEMBER_WALLET_ID,
      REP_WALLET_ID,
      MEMBER_WALLET_ID,
      ADMIN_WALLET_ID,
      delegationRegistry,
    );

    // Inactive after revocation
    expect(AorService.isDelegationActive(delegationIndex, delegationRegistry)).toBe(false);
  });
});

// ─── AorService — Full Workflow with Revocation ──────────────

describe('AorService — Full Workflow with Revocation', () => {
  test('end-to-end: initiate → delegate → pickup cool-down → revoke', () => {
    const messageRegistry = new MessageRegistry();
    const delegationRegistry = new DelegationRegistry();
    const now = Date.now();

    // Step 1-4: Create AOR delegation (same as before)
    const aor = makeFullAor();
    const initResult = AorService.prepareInitiation(aor, MEMBER_WALLET_ID, messageRegistry, now);
    expect(initResult.validation.valid).toBe(true);

    const aorCommitment = buildAorCommitment(aor);
    const { delegationData } = AorService.buildDelegation(
      MEMBER_WALLET_ID, REP_WALLET_ID, SCOPE_ALL, '20260115', aorCommitment,
    );
    const { index: delIndex } = delegationRegistry.addDelegation(delegationData);

    // Delegation is active
    expect(AorService.isDelegationActive(delIndex, delegationRegistry)).toBe(true);

    // Step 5: Member revokes
    const revokeResult = AorService.revokeAor(
      MEMBER_WALLET_ID, REP_WALLET_ID,
      MEMBER_WALLET_ID, ADMIN_WALLET_ID,
      delegationRegistry,
    );
    expect(revokeResult.valid).toBe(true);
    expect(revokeResult.newDelegationRoot).toBeDefined();

    // Delegation is now inactive
    expect(AorService.isDelegationActive(delIndex, delegationRegistry)).toBe(false);

    // findByWallets returns nothing
    expect(delegationRegistry.findByWallets(MEMBER_WALLET_ID, REP_WALLET_ID)).toBeUndefined();
  });
});

// ─── MessagingService — Revocation Notification ──────────────

describe('MessagingService — sendRevocationNotification', () => {
  function buildServiceWithAor() {
    const store = new InMemoryStore();
    const msgReg = new MessageRegistry();
    const delReg = new DelegationRegistry();
    const keyReg = new KeyRegistry();
    const service = new MessagingService(store, msgReg, delReg, keyReg);

    // Add an AOR delegation
    const aorCommitment = buildAorCommitment(makeFullAor());
    const { delegationData } = AorService.buildDelegation(
      MEMBER_WALLET_ID, REP_WALLET_ID, SCOPE_ALL, '20260115', aorCommitment,
    );
    const { index } = delReg.addDelegation(delegationData);
    const delegationCommitment = delegationData.commitment();

    return { service, store, msgReg, delReg, keyReg, index, delegationCommitment, delegationData };
  }

  test('sends revocation notification and returns updated messagingRoot', () => {
    const { service, delReg, keyReg, msgReg, index, delegationCommitment } = buildServiceWithAor();

    // Revoke the delegation first (as AorService would)
    delReg.revokeDelegation(index);

    const result = service.sendRevocationNotification(
      MEMBER_WALLET_ID, // revoker
      MEMBER_WALLET_ID,
      REP_WALLET_ID,
      delegationCommitment,
    );

    // Returns valid messagingRoot (reflects zeroed delegation + new message)
    const expectedRoot = computeMessagingRoot(
      msgReg.getRoot(),
      delReg.getRoot(),
      keyReg.getRoot(),
    );
    expect(result.newMessagingRoot.toString()).toBe(expectedRoot.toString());
  });

  test('message has MSG_TYPE_AOR_REVOKE', () => {
    const { service, delReg, index, delegationCommitment } = buildServiceWithAor();
    delReg.revokeDelegation(index);

    const result = service.sendRevocationNotification(
      MEMBER_WALLET_ID, MEMBER_WALLET_ID, REP_WALLET_ID, delegationCommitment,
    );

    expect(result.messageData.messageType.toString()).toBe(MSG_TYPE_AOR_REVOKE.toString());
  });

  test('contentHash stores the revoked delegation commitment', () => {
    const { service, delReg, index, delegationCommitment } = buildServiceWithAor();
    delReg.revokeDelegation(index);

    const result = service.sendRevocationNotification(
      MEMBER_WALLET_ID, MEMBER_WALLET_ID, REP_WALLET_ID, delegationCommitment,
    );

    expect(result.messageData.contentHash.toString()).toBe(delegationCommitment.toString());
  });

  test('threadId stores the rep wallet ID', () => {
    const { service, delReg, index, delegationCommitment } = buildServiceWithAor();
    delReg.revokeDelegation(index);

    const result = service.sendRevocationNotification(
      MEMBER_WALLET_ID, MEMBER_WALLET_ID, REP_WALLET_ID, delegationCommitment,
    );

    expect(result.messageData.threadId.toString()).toBe(REP_WALLET_ID.toString());
  });

  test('recipient is the member wallet', () => {
    const { service, delReg, index, delegationCommitment } = buildServiceWithAor();
    delReg.revokeDelegation(index);

    const result = service.sendRevocationNotification(
      ADMIN_WALLET_ID, // admin is revoking
      MEMBER_WALLET_ID,
      REP_WALLET_ID,
      delegationCommitment,
    );

    expect(result.messageData.senderWalletId.toString()).toBe(ADMIN_WALLET_ID.toString());
    expect(result.messageData.recipientWalletId.toString()).toBe(MEMBER_WALLET_ID.toString());
  });

  test('nonce increments for same sender', () => {
    const { service, delReg, index, delegationCommitment, delegationData } = buildServiceWithAor();
    delReg.revokeDelegation(index);

    const result1 = service.sendRevocationNotification(
      MEMBER_WALLET_ID, MEMBER_WALLET_ID, REP_WALLET_ID, delegationCommitment,
    );
    expect(result1.messageData.nonce.toString()).toBe('1');

    // Add and revoke another AOR to send a second notification
    const { delegationData: del2 } = AorService.buildDelegation(
      MEMBER_WALLET_ID, Field(77777n), SCOPE_READ, '20260201', Field(42n),
    );
    const { index: idx2 } = delReg.addDelegation(del2);
    delReg.revokeDelegation(idx2);

    const result2 = service.sendRevocationNotification(
      MEMBER_WALLET_ID, MEMBER_WALLET_ID, Field(77777n), del2.commitment(),
    );
    expect(result2.messageData.nonce.toString()).toBe('2');
  });

  test('messagingRoot differs from pre-revocation root', () => {
    const { service, msgReg, delReg, keyReg, index, delegationCommitment } = buildServiceWithAor();

    // Capture root before revocation
    const rootBefore = computeMessagingRoot(
      msgReg.getRoot(), delReg.getRoot(), keyReg.getRoot(),
    );

    // Revoke + notify
    delReg.revokeDelegation(index);
    const result = service.sendRevocationNotification(
      MEMBER_WALLET_ID, MEMBER_WALLET_ID, REP_WALLET_ID, delegationCommitment,
    );

    // Root must differ (both delegation tree AND message tree changed)
    expect(result.newMessagingRoot.toString()).not.toBe(rootBefore.toString());
  });
});

// ─── Multi-Delegation Isolation ──────────────────────────────

describe('Revocation — Multi-Delegation Isolation', () => {
  test('revoking one AOR does not affect a different AOR for the same member', () => {
    const delegationRegistry = new DelegationRegistry();
    const repA = Field(11111n);
    const repB = Field(22222n);

    // Create two AOR delegations for the same member
    const aorCommitment = buildAorCommitment(makeFullAor());
    const { delegationData: delA } = AorService.buildDelegation(
      MEMBER_WALLET_ID, repA, SCOPE_ALL, '20260115', aorCommitment,
    );
    const { delegationData: delB } = AorService.buildDelegation(
      MEMBER_WALLET_ID, repB, SCOPE_READ, '20260115', aorCommitment,
    );

    const { index: idxA } = delegationRegistry.addDelegation(delA);
    const { index: idxB } = delegationRegistry.addDelegation(delB);

    // Revoke repA
    const result = AorService.revokeAor(
      MEMBER_WALLET_ID, repA, MEMBER_WALLET_ID, ADMIN_WALLET_ID, delegationRegistry,
    );
    expect(result.valid).toBe(true);

    // repA is gone
    expect(AorService.isDelegationActive(idxA, delegationRegistry)).toBe(false);
    expect(delegationRegistry.findByWallets(MEMBER_WALLET_ID, repA)).toBeUndefined();

    // repB is still active and findable
    expect(AorService.isDelegationActive(idxB, delegationRegistry)).toBe(true);
    const foundB = delegationRegistry.findByWallets(MEMBER_WALLET_ID, repB);
    expect(foundB).toBeDefined();
    expect(foundB!.delegation.scopeFlags.toString()).toBe(SCOPE_READ.toString());
  });

  test('revoking member→repA does not affect otherMember→repA', () => {
    const delegationRegistry = new DelegationRegistry();
    const otherMember = Field(77777n);
    const rep = Field(88888n);

    const aorCommitment = buildAorCommitment(makeFullAor());
    const { delegationData: del1 } = AorService.buildDelegation(
      MEMBER_WALLET_ID, rep, SCOPE_ALL, '20260115', aorCommitment,
    );
    const { delegationData: del2 } = AorService.buildDelegation(
      otherMember, rep, SCOPE_ALL, '20260115', aorCommitment,
    );

    const { index: idx1 } = delegationRegistry.addDelegation(del1);
    const { index: idx2 } = delegationRegistry.addDelegation(del2);

    // Revoke MEMBER_WALLET_ID → rep
    AorService.revokeAor(
      MEMBER_WALLET_ID, rep, MEMBER_WALLET_ID, ADMIN_WALLET_ID, delegationRegistry,
    );

    // MEMBER_WALLET_ID's delegation is gone
    expect(AorService.isDelegationActive(idx1, delegationRegistry)).toBe(false);

    // otherMember's delegation with same rep is untouched
    expect(AorService.isDelegationActive(idx2, delegationRegistry)).toBe(true);
    expect(delegationRegistry.findByWallets(otherMember, rep)).toBeDefined();
  });
});

// ─── Root-Freshness / Stale-Proof Detection ──────────────────

describe('Revocation — Stale Root Detection', () => {
  test('messagingRoot changes after revocation, detecting stale proofs', () => {
    const msgReg = new MessageRegistry();
    const delReg = new DelegationRegistry();
    const keyReg = new KeyRegistry();

    // Set up a delegation
    const aorCommitment = buildAorCommitment(makeFullAor());
    const { delegationData } = AorService.buildDelegation(
      MEMBER_WALLET_ID, REP_WALLET_ID, SCOPE_ALL, '20260115', aorCommitment,
    );
    delReg.addDelegation(delegationData);

    // Capture root at "proof generation time" (before revocation)
    const rootAtProofTime = computeMessagingRoot(
      msgReg.getRoot(), delReg.getRoot(), keyReg.getRoot(),
    );

    // Revoke the delegation
    const revokeResult = AorService.revokeAor(
      MEMBER_WALLET_ID, REP_WALLET_ID, MEMBER_WALLET_ID, ADMIN_WALLET_ID, delReg,
    );
    expect(revokeResult.valid).toBe(true);

    // Compute root AFTER revocation (what's now on-chain)
    const rootAfterRevocation = computeMessagingRoot(
      msgReg.getRoot(), delReg.getRoot(), keyReg.getRoot(),
    );

    // The roots differ — a proof with the old root is stale
    expect(rootAtProofTime.toString()).not.toBe(rootAfterRevocation.toString());
  });

  test('root is stable when no changes occur', () => {
    const msgReg = new MessageRegistry();
    const delReg = new DelegationRegistry();
    const keyReg = new KeyRegistry();

    const aorCommitment = buildAorCommitment(makeFullAor());
    const { delegationData } = AorService.buildDelegation(
      MEMBER_WALLET_ID, REP_WALLET_ID, SCOPE_ALL, '20260115', aorCommitment,
    );
    delReg.addDelegation(delegationData);

    const root1 = computeMessagingRoot(
      msgReg.getRoot(), delReg.getRoot(), keyReg.getRoot(),
    );
    const root2 = computeMessagingRoot(
      msgReg.getRoot(), delReg.getRoot(), keyReg.getRoot(),
    );

    // Same root when nothing changed — proof stays fresh
    expect(root1.toString()).toBe(root2.toString());
  });
});
