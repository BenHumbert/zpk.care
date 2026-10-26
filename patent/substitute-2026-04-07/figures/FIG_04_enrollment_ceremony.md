# FIG. 4 — Three-Party Enrollment Ceremony

```
Replacement Sheet

FIG. 4 — THREE-PARTY ENROLLMENT CEREMONY                        Sheet 4 of 22
=====================================================================================

PARTIES                                                                                  402
---------------------------------------------------------------------------------------------
  EMPLOYER 404                  MEMBER 406                    INSURER 408
  (Token Authority)             (Mobile Device)               (Attestation Authority)
  Has: group config,            Has: PHI/PII (local only),    Has: NO PHI, NO secrets
  roster, plan templates        enrollment key (generated)    Sees only walletId hashes

STEP 1 — EMPLOYER: Generate GroupEnrollmentToken                                         410
---------------------------------------------------------------------------------------------
  +--GroupEnrollmentToken 412 (8 Fields)------------------------------------------+
  |  tokenIdHash, groupIdHash, planIdHash, employeeIdHash,                        |
  |  familyIdHash, validUntil, issuerHash, nonce                                  |
  +-------------------------------------------------------------------------------+
       |  Token transmitted to Member (email/portal/QR)
       v
STEP 2 — MEMBER: On-Device Wallet Derivation                                            420
---------------------------------------------------------------------------------------------
  +--Member Device (PHI never leaves) 422------------------------------------------+
  |  420a: Generate enrollmentKey (random 2FA secret, NEVER transmitted)           |
  |  420b: Hash each PHI field: h(cardholderId), h(dob), h(firstName), h(lastName) |
  |  420c: walletId = Poseidon.hash([domainTag=0, h(cardholderId), h(dob),         |
  |           h(firstName), h(lastName), h(enrollmentKey)])                        |
  |  420d: Submit to insurer: { walletId, tokenHash, groupIdHash } (NO PHI)        |
  +--------------------------------------------------------------------------------+
       |  Only walletId + token reference cross PHI boundary
       v
======= PHI BOUNDARY — NOTHING BELOW CONTAINS PHI/PII, ONLY POSEIDON HASHES ============
       |
       v
STEP 3 — INSURER: Register + Issue Credential                                           430
---------------------------------------------------------------------------------------------
  +--Insurer Processing 432-----------------------------------------------------------+
  |  430a: Verify token signature + check roster (by employeeIdHash, no PHI)          |
  |  430b: Register walletId in WalletRegistry MerkleTree (walletRegRoot updated)     |
  |  430c: Set lifecycle EMPTY(0) -> REGISTERED(1) -> ELIGIBLE(2) -> ACTIVE(3)        |
  |  430d: Mint credential NFT with credentialCommitment (see FIG. 3, ref 302)        |
  |  430e: Initialize ACCESS_CONTROL tree: EligibilityData(leaf 0),                   |
  |         AccumulatorData(leaf 127, all zeros), PriorAuth entries as needed         |
  +-----------------------------------------------------------------------------------+
       |
       v
  +--Issued Credential 434------------------------------------------------------------+
  |  credentialCommitment = H(credentialType, forestRoot, issuerWalletId,             |
  |                           subjectWalletId, issuedAt, expiresAt, revoked)          |
  |  NFC card (optional): RecoveryCard v2 (~400 bytes, AES-256-GCM, NTAG216)          |
  +-----------------------------------------------------------------------------------+

INFORMATION SEPARATION (By Party)                                                        440
---------------------------------------------------------------------------------------------
  Data Element          |  Employer         |  Member           |  Insurer
  ----------------------+-------------------+-------------------+-------------------
  PHI (name,dob,id)     |  Roster (plain)   |  Device (plain)   |  NEVER
  Enrollment Key        |  NEVER            |  Device only      |  NEVER
  walletId (hash)       |  NEVER            |  Derived on device|  Registered
  Group/Plan config     |  Creates          |  Receives token   |  Verifies token
  Credential NFT        |  NEVER            |  Holds            |  Issues

TOKEN LIFECYCLE                                                                          450
---------------------------------------------------------------------------------------------
  GENERATED 452 --[employer creates]--> DISTRIBUTED 454 --[member redeems]--> CONSUMED 456
       |                                      |                                    |
       +---[expires]---> EXPIRED 458          +---[employer revokes]--> REVOKED 460
```
