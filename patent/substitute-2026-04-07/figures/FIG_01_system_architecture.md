# FIG. 1 — System Architecture Overview

```
Replacement Sheet

FIG. 1 — ZERO-KNOWLEDGE HEALTHCARE CLAIM SYSTEM ARCHITECTURE    Sheet 1 of 22
=====================================================================================

ENTITY NODE LAYER                                                                        110
---------------------------------------------------------------------------------------------
  MEMBER NODE 112 (Domain Tag 0)        |  PRESCRIBER NODE 114 (Domain Tag 1)
  PHI local only, never transmitted     |  PHI local only, never transmitted
  walletId = Poseidon.hash([tag,        |  walletId = Poseidon.hash([tag,
    ...hashedPHI, hash(enrollKey)])     |    ...hashedPHI, hash(enrollKey)])
                                        |
  PHARMACY NODE 116 (Domain Tag 2)      |  INSURER NODE 118 (No PHI)
  PHI local only, never transmitted     |  Sees only opaque walletId hashes
  walletId = Poseidon.hash([tag,        |  Attestation authority only
    ...hashedPHI, hash(enrollKey)])     |  No secrets, no enrollment keys
---------------------------------------------------------------------------------------------
  |  enrollmentKey: user-generated 2FA secret, NEVER leaves device
  |  Wallet derivation: walletId = Poseidon.hash([domainTag, h(f1), h(f2), ..., h(enrollKey)])
  v
========== PHI BOUNDARY — ALL DATA BELOW CONTAINS ONLY POSEIDON HASH COMMITMENTS ===========
  |
  v
ZK PROOF LAYER (14 ZkPrograms)                                                          120
---------------------------------------------------------------------------------------------
  ProofGateProgram    121 | StateTransitionProg 122 | CredentialProgram    123 | EligibilityProg    124
  InNetworkProgram    125 | PcpVerificationProg 126 | AccessControlProgram 127 | PrescriptionProg   128
  FulfillmentProgram  129 | AccumFulfillProg    130 | MessagingProgram     131 | WalletMigrationProg132
  BatchProgram        133 | ChainProgram        134 |                          |
---------------------------------------------------------------------------------------------
  |  Each program: compile() once, prove() per transaction
  |  Proof composition: 123/124 -> 125 -> 126 -> 127 (recursive, max depth 2)
  v
SEQUENCER NETWORK LAYER (Leviathan Multi-Leader)                                         140
---------------------------------------------------------------------------------------------
  LEVIATHAN-A 142-A             |  LEVIATHAN-B 142-B             |  LEVIATHAN-C 142-C
  Partition: [0..85]            |  Partition: [86..170]          |  Partition: [171..255]
  Role: PRIMARY                 |  Role: PRIMARY                 |  Role: PRIMARY
  WAL: append + fsync           |  WAL: append + fsync           |  WAL: append + fsync
  Quorum: Ed25519 votes         |  Quorum: Ed25519 votes         |  Quorum: Ed25519 votes
  ---------------------------------------------------------------------------------------------

         +----------- GOSSIP PROTOCOL (7 core + 3 quorum + 2 control) -----------+
         |  proof:accepted | batch:built | batch:settled | batch:failed           |
         |  state:snapshot | peer:announce | message:stored                       |
         |  quorum:propose | quorum:vote | quorum:certificate                     |
         |  leader:heartbeat | leader:promotion                                   |
         +------------------------------------------------------------------------+
  |
  |  L2-ONLY SETTLEMENT: No MINA L1. Batches finalize on quorum ack (N/2+1 WAL + sign).
  v
DATA LAYER                                                                               150
---------------------------------------------------------------------------------------------
  CLAIM ACCUMULATOR 152  | MESSAGE STORE 154     | CHECKPOINT STORE 156
  MerkleTree(24), 16M    | MerkleTree(20), 1M    | File-based, atomic
  4 indexes: member,     | 4 indexes: sender,    | write (tmp+fsync+rename)
  pharmacy, prescriber,  | recipient, wallet,    | WAL compaction after
  ndc                    | thread                | checkpoint
                         |                       |
  AUDIT CHAIN 158        | EPOCH ACCUMULATOR 160
  Poseidon hash chain    | Monthly MerkleTree
  chainHash = H(prev,    | rotation for 250M
  eventCommitment)       | claims/year scale
---------------------------------------------------------------------------------------------

  18 JSON-RPC 2.0 methods + 6 claim + 5 message + 5 peer + 3 quorum + 3 leviathan = 40 RPCs
```
