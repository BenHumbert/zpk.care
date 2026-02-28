/**
 * L2 Quorum Service Tests — Ed25519 vote collection and certificate verification.
 *
 * Tests the L2QuorumService for proposal/vote/certificate lifecycle,
 * Ed25519 signing/verification, and state certificate creation.
 */

import {
  L2QuorumService,
  QuorumKeyAuthority,
  computeStateDigestHash,
  computePartitionDigestHash,
  computeQuorumThreshold,
} from '../src/l2/l2-quorum-service.js';
import type { QuorumConfig, QuorumProposal, QuorumVote, StateCertificate } from '../src/l2/l2-quorum-types.js';
import { buildQuorumVoteMessage, buildStateCertMessage } from '../src/l2/l2-quorum-types.js';
import type { StateDigest } from '../src/l2/l2-peer-types.js';

// ─── Test Helpers ──────────────────────────────────────────

function makeAuthority(seed?: string): QuorumKeyAuthority {
  return new QuorumKeyAuthority(seed ? Buffer.from(seed) : undefined);
}

function makeConfig(
  nodeId: string,
  authority: QuorumKeyAuthority,
  peerKeys?: Map<string, string>,
  quorumThreshold = 2,
): QuorumConfig {
  const keys = peerKeys ?? new Map();
  keys.set(nodeId, authority.publicKeyHex);
  return {
    quorumThreshold,
    quorumTimeoutMs: 1_000, // Short timeout for tests
    privateKey: authority.getPrivateKey(),
    publicKeyHex: authority.publicKeyHex,
    peerPublicKeys: keys,
  };
}

function makeProposal(proposalId = 'proposal-1', leaderId = 'leader-1'): QuorumProposal {
  return {
    proposalId,
    partitionIndex: 0,
    sequenceNumber: '1',
    walEntryHash: 'abc123def456abc123def456abc12345',
    stateDigestHash: 'xyz789xyz789xyz789xyz789xyz78901',
    leaderId,
    timestamp: Date.now(),
  };
}

function makeDigest(seqNum = 1n): StateDigest {
  return {
    latestSequenceNumber: seqNum,
    latestBatchNumber: null,
    auditChainHash: 'audit-hash-1',
    claimAccumulatorRoot: 'claim-root-1',
    registryRoot: 'reg-root-1',
    lifecycleRoot: 'lc-root-1',
    walletCount: '1',
  };
}

// ─── QuorumKeyAuthority Tests ──────────────────────────────

describe('QuorumKeyAuthority', () => {
  test('generates a keypair', () => {
    const auth = makeAuthority();
    expect(auth.publicKeyHex).toBeTruthy();
    expect(auth.publicKeyHex.length).toBe(64); // 32 bytes hex
  });

  test('deterministic from seed', () => {
    const auth1 = makeAuthority('test-seed');
    const auth2 = makeAuthority('test-seed');
    expect(auth1.publicKeyHex).toBe(auth2.publicKeyHex);
  });

  test('different seeds produce different keys', () => {
    const auth1 = makeAuthority('seed-a');
    const auth2 = makeAuthority('seed-b');
    expect(auth1.publicKeyHex).not.toBe(auth2.publicKeyHex);
  });

  test('sign produces a buffer', () => {
    const auth = makeAuthority('sign-test');
    const sig = auth.sign(Buffer.from('test message'));
    expect(sig).toBeInstanceOf(Buffer);
    expect(sig.length).toBe(64); // Ed25519 signature is 64 bytes
  });
});

// ─── L2QuorumService Tests ─────────────────────────────────

describe('L2QuorumService', () => {
  let leaderAuth: QuorumKeyAuthority;
  let peerAuth: QuorumKeyAuthority;
  let leaderService: L2QuorumService;
  let peerService: L2QuorumService;

  beforeEach(() => {
    leaderAuth = makeAuthority('leader-seed');
    peerAuth = makeAuthority('peer-seed');

    const peerKeys = new Map<string, string>();
    peerKeys.set('leader-1', leaderAuth.publicKeyHex);
    peerKeys.set('peer-1', peerAuth.publicKeyHex);

    leaderService = new L2QuorumService(
      makeConfig('leader-1', leaderAuth, new Map(peerKeys), 2),
    );

    peerService = new L2QuorumService(
      makeConfig('peer-1', peerAuth, new Map(peerKeys), 2),
    );
  });

  afterEach(() => {
    leaderService.destroy();
    peerService.destroy();
  });

  // ─── Vote Creation & Verification ─────────────────────

  test('createVote produces a valid signature', () => {
    const proposal = makeProposal();
    const vote = peerService.createVote(proposal, proposal.walEntryHash);

    expect(vote.proposalId).toBe(proposal.proposalId);
    expect(vote.voterId).toBe('peer-1');
    expect(vote.walEntryHash).toBe(proposal.walEntryHash);
    expect(vote.signature).toBeTruthy();
    expect(vote.signature.length).toBe(128); // 64 bytes hex
  });

  test('verifyVote accepts valid vote', () => {
    const proposal = makeProposal();
    const vote = peerService.createVote(proposal, proposal.walEntryHash);

    expect(leaderService.verifyVote(vote)).toBe(true);
  });

  test('verifyVote rejects tampered vote', () => {
    const proposal = makeProposal();
    const vote = peerService.createVote(proposal, proposal.walEntryHash);
    vote.walEntryHash = 'tampered-hash';

    expect(leaderService.verifyVote(vote)).toBe(false);
  });

  test('verifyVote rejects unknown voter', () => {
    const unknownAuth = makeAuthority('unknown-seed');
    const unknownConfig = makeConfig('unknown-1', unknownAuth, new Map(), 1);
    const unknownService = new L2QuorumService(unknownConfig);

    const proposal = makeProposal();
    const vote = unknownService.createVote(proposal, proposal.walEntryHash);

    // Leader doesn't know unknown-1's public key
    expect(leaderService.verifyVote(vote)).toBe(false);

    unknownService.destroy();
  });

  // ─── Proposal & Quorum Collection ─────────────────────

  test('proposeAndWait resolves when quorum reached', async () => {
    const proposal = makeProposal('proposal-q1', 'leader-1');

    const certPromise = leaderService.proposeAndWait(proposal);

    // Leader auto-votes (self-vote). We need one more vote for quorum of 2.
    const peerVote = peerService.createVote(proposal, proposal.walEntryHash);
    leaderService.handleVote(peerVote);

    const certificate = await certPromise;
    expect(certificate.proposalId).toBe('proposal-q1');
    expect(certificate.votes.length).toBe(2); // self + peer
    expect(certificate.leaderId).toBe('leader-1');
  });

  test('proposeAndWait rejects on timeout', async () => {
    const proposal = makeProposal('proposal-timeout', 'leader-1');

    // Don't send any peer votes — only self-vote (1 < quorum of 2)
    await expect(leaderService.proposeAndWait(proposal))
      .rejects.toThrow(/Quorum timeout/);
  });

  test('duplicate votes from same voter are ignored', async () => {
    const proposal = makeProposal('proposal-dup', 'leader-1');

    const certPromise = leaderService.proposeAndWait(proposal);

    // Send same peer vote twice
    const peerVote = peerService.createVote(proposal, proposal.walEntryHash);
    leaderService.handleVote(peerVote);
    leaderService.handleVote(peerVote); // duplicate

    const certificate = await certPromise;
    expect(certificate.votes.length).toBe(2); // self + 1 peer (not 3)
  });

  test('votes with wrong walEntryHash are rejected', async () => {
    const proposal = makeProposal('proposal-wrong-hash', 'leader-1');

    // Start proposal (self-vote = 1)
    const certPromise = leaderService.proposeAndWait(proposal);

    // Send vote with wrong hash
    const badVote = peerService.createVote(proposal, 'wrong-hash-value');
    leaderService.handleVote(badVote);

    // Should timeout since bad vote doesn't count
    await expect(certPromise).rejects.toThrow(/Quorum timeout/);
  });

  test('handleVote for unknown proposal is a no-op', () => {
    const vote: QuorumVote = {
      proposalId: 'nonexistent',
      voterId: 'peer-1',
      walEntryHash: 'abc',
      signature: 'def',
      timestamp: Date.now(),
    };
    // Should not throw
    leaderService.handleVote(vote);
  });

  // ─── Quorum with threshold=1 (single node) ───────────

  test('single node achieves quorum with self-vote only', async () => {
    const soloAuth = makeAuthority('solo-seed');
    const soloService = new L2QuorumService(
      makeConfig('solo-1', soloAuth, new Map(), 1), // threshold=1
    );

    const proposal = makeProposal('proposal-solo', 'solo-1');
    const certificate = await soloService.proposeAndWait(proposal);

    expect(certificate.votes.length).toBe(1);
    expect(certificate.votes[0].voterId).toContain('solo');

    soloService.destroy();
  });

  // ─── State Certificates ───────────────────────────────

  test('createStateCertificate produces valid certificate', () => {
    const digest = makeDigest();
    const cert = leaderService.createStateCertificate(1n, 0, digest);

    expect(cert.version).toBe(1);
    expect(cert.batchNumber).toBe('1');
    expect(cert.partitionIndex).toBe(0);
    expect(cert.stateDigest).toEqual(digest);
    expect(cert.signatures.length).toBe(1);
  });

  test('signStateCertificate adds a signature', () => {
    const digest = makeDigest();
    const cert = leaderService.createStateCertificate(1n, 0, digest);
    const peerSig = peerService.signStateCertificate(cert);

    expect(peerSig.nodeId).toContain('peer');
    expect(peerSig.signature.length).toBe(128);
    expect(peerSig.publicKeyHex).toBe(peerAuth.publicKeyHex);

    cert.signatures.push(peerSig);
    expect(cert.signatures.length).toBe(2);
  });

  test('verifyStateCertificate validates correct certificate', () => {
    const digest = makeDigest();
    const cert = leaderService.createStateCertificate(1n, 0, digest);
    const peerSig = peerService.signStateCertificate(cert);
    cert.signatures.push(peerSig);

    // Both leader and peer can verify
    expect(leaderService.verifyStateCertificate(cert)).toBe(true);
    expect(peerService.verifyStateCertificate(cert)).toBe(true);
  });

  test('verifyStateCertificate rejects insufficient signatures', () => {
    const digest = makeDigest();
    const cert = leaderService.createStateCertificate(1n, 0, digest);
    // Only 1 signature, quorum threshold is 2
    expect(leaderService.verifyStateCertificate(cert)).toBe(false);
  });

  test('verifyStateCertificate rejects tampered digest', () => {
    const digest = makeDigest();
    const cert = leaderService.createStateCertificate(1n, 0, digest);
    const peerSig = peerService.signStateCertificate(cert);
    cert.signatures.push(peerSig);

    // Tamper with the digest
    cert.stateDigest.registryRoot = 'tampered';
    expect(leaderService.verifyStateCertificate(cert)).toBe(false);
  });

  // ─── Certificate Storage ──────────────────────────────

  test('store and retrieve state certificates', () => {
    const digest = makeDigest();
    const cert = leaderService.createStateCertificate(1n, 0, digest);

    leaderService.storeStateCertificate(cert);
    expect(leaderService.getLatestStateCertificate(0)).toEqual(cert);
    expect(leaderService.getLatestStateCertificate(1)).toBeUndefined();
  });

  test('getAllStateCertificates returns all stored', () => {
    const cert0 = leaderService.createStateCertificate(1n, 0, makeDigest());
    const cert1 = leaderService.createStateCertificate(2n, 1, makeDigest(2n));

    leaderService.storeStateCertificate(cert0);
    leaderService.storeStateCertificate(cert1);

    expect(leaderService.getAllStateCertificates()).toHaveLength(2);
  });

  // ─── Status & Accessors ───────────────────────────────

  test('getStatus returns correct status', () => {
    const status = leaderService.getStatus();
    expect(status.quorumThreshold).toBe(2);
    expect(status.pendingProposals).toBe(0);
    expect(status.knownPeers).toBeGreaterThanOrEqual(1);
    expect(status.stateCertificateCount).toBe(0);
  });

  test('updatePeerPublicKey adds a new peer', () => {
    const newAuth = makeAuthority('new-peer');
    leaderService.updatePeerPublicKey('new-peer-1', newAuth.publicKeyHex);

    const status = leaderService.getStatus();
    expect(status.knownPeers).toBeGreaterThanOrEqual(2);
  });

  test('destroy cleans up pending proposals', () => {
    const proposal = makeProposal('proposal-destroy', 'leader-1');
    const promise = leaderService.proposeAndWait(proposal);

    leaderService.destroy();

    return expect(promise).rejects.toThrow(/destroyed/);
  });
});

// ─── Utility Function Tests ──────────────────────────────

describe('Quorum Utilities', () => {
  test('computeStateDigestHash is deterministic', () => {
    const digest = makeDigest();
    const hash1 = computeStateDigestHash(digest);
    const hash2 = computeStateDigestHash(digest);
    expect(hash1).toBe(hash2);
    expect(hash1.length).toBe(32);
  });

  test('computeStateDigestHash differs for different digests', () => {
    const d1 = makeDigest(1n);
    const d2 = makeDigest(2n);
    expect(computeStateDigestHash(d1)).not.toBe(computeStateDigestHash(d2));
  });

  test('computeQuorumThreshold returns N/2+1', () => {
    expect(computeQuorumThreshold(1)).toBe(1);
    expect(computeQuorumThreshold(2)).toBe(2);
    expect(computeQuorumThreshold(3)).toBe(2);
    expect(computeQuorumThreshold(4)).toBe(3);
    expect(computeQuorumThreshold(5)).toBe(3);
    expect(computeQuorumThreshold(6)).toBe(4);
    expect(computeQuorumThreshold(7)).toBe(4);
  });

  test('buildQuorumVoteMessage is deterministic', () => {
    const params = {
      proposalId: 'p1',
      walEntryHash: 'hash1',
      voterId: 'v1',
      timestamp: 1234567890,
    };
    const msg1 = buildQuorumVoteMessage(params);
    const msg2 = buildQuorumVoteMessage(params);
    expect(msg1).toBe(msg2);
    expect(msg1).toBe('zkpcare-quorum-vote-v1|p1|hash1|v1|1234567890');
  });

  test('buildStateCertMessage is deterministic', () => {
    const params = {
      batchNumber: '42',
      partitionIndex: 0,
      stateDigestHash: 'digest-hash',
      nodeId: 'node-1',
      timestamp: 1234567890,
    };
    const msg = buildStateCertMessage(params);
    expect(msg).toBe('zkpcare-state-cert-v1|42|0|digest-hash|node-1|1234567890');
  });

  test('computePartitionDigestHash includes partition fields', () => {
    const digest1 = {
      partitionIndex: 0,
      walSequenceNumber: 1n,
      latestSequenceNumber: 1n,
      latestBatchNumber: null,
      auditChainHash: 'hash',
      claimAccumulatorRoot: 'root',
      registryRoot: 'reg',
      lifecycleRoot: 'lc',
      walletCount: '1',
    };
    const digest2 = { ...digest1, partitionIndex: 1 };

    expect(computePartitionDigestHash(digest1)).not.toBe(computePartitionDigestHash(digest2));
  });
});
