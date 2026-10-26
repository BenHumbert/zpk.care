# FIG. 14A — Portable Credential: Architecture and Formats (Sheet 17 of 22)

```
Replacement Sheet

FIG. 14A — PORTABLE ZERO-KNOWLEDGE CREDENTIAL — ARCHITECTURE & FORMATS        Sheet 17 of 22
=================================================================================================

SECTION A: TWO-TIER CREDENTIAL ARCHITECTURE                                                1400
-------------------------------------------------------------------------------------------------
Member submits ZK credential proof (mint/holding/holdingByType) --> Sequencer verifies via
CredentialProgram.verify() (Pickles recursive verification) --> issues credential tier(s):

+========================+ +========================+ +========================+
|| TIER 1: Full ZK      || || TIER 2: Ed25519      || || TIER 3: Delegation   ||
|| PortableCredential   || || NfcCredentialAttest. || || PortableDelegation   ||
||                      || ||                      || || Credential           ||
|| Size: 10-22 KB       || || Size: ~500 bytes     || || Size: ~2 KB          ||
|| Transport: QR/network|| || Transport: NTAG216   || || Transport: QR / NFC  ||
|| Trust: Mathematical  || || Trust: Ed25519 sig   || || Trust: ZK + TTL      ||
|| (ZK proof)           || || (sequencer receipt)  || || tiers                ||
+========================+ +========================+ +========================+

SECTION B: PORTABLECREDENTIAL FORMAT (FULL ZK PROOF)                                       1402
-------------------------------------------------------------------------------------------------
+============================================================================================+
|| PortableCredential — 10-22 KB                                                            ||
|| version: 1                         | publicOutput: {                                     ||
|| proofType: 'credential-holding'    |   walletId: "48291637..."                           ||
|| proofJson: {                       |   operationType: "2" (holding)                      ||
||   publicInput: [...]               |   credentialCommitment: "73829164..."               ||
||   publicOutput: [...]              |   oldInventoryRoot: "55182736..."                   ||
||   maxProofsVerified: 1             |   newInventoryRoot: "55182736..."                   ||
||   proof: "KChp...base64" (10-22KB) | }                                                   ||
|| }                                  | verificationKeyHash: "91638274..."                  ||
||                                    | createdAt / expiresAt (24h default)                 ||
+============================================================================================+

THREE CREDENTIALPROGRAM METHODS (ZkProgram):
+--------------------------------------+--------------------------------------+------------------+
| METHOD 1: mint                       | METHOD 2: holding                    | METHOD 3:        |
| Proves correct credential insertion  | Proves wallet holds SPECIFIC         | holdingByType    |
|   into wallet inventory Merkle tree  |   credential via Merkle inclusion    | Proves wallet    |
| Input: Credential + old inv root     | Input: Credential + Merkle witness   |   holds cred of  |
| Output: walletId, credCommitment,    | Output: walletId, credCommitment     |   SPECIFIED TYPE |
|   oldInvRoot -> newInvRoot           | In-circuit: inclusion + recursive    |   without which  |
| In-circuit: recursive wallet verify  |   wallet proof                       | SELECTIVE        |
+--------------------------------------+--------------------------------------+ DISCLOSURE       |
                                                                              +------------------+

SECTION C: NFCCREDENTIALATTESTATION FORMAT (COMPACT)                                       1404
-------------------------------------------------------------------------------------------------
+============================================================================================+
|| NfcCredentialAttestation — ~500 bytes                                                    ||
||                                                                                          ||
|| v:   2  (format version)              | ts:  1709312000  (Unix seconds)                  ||
|| t:   'credential-attestation'         | exp: 1709398400  (+24h default)                  ||
|| w:   "48291637..."  (wallet ID)       | n:   "a1b2c3d4..." (revocation nonce, 32 hex)    ||
|| cc:  "73829164..."  (cred commitment) |                                                  ||
|| ls:  3  (lifecycle = ACTIVE)          | pk:  "7f8e9d0c..." (Ed25519 pubkey, 64 hex)      ||
|| fr:  "91827364..."  (forest root)     | sig: "3a4b5c6d..." (Ed25519 signature, 128 hex)  ||
+============================================================================================+

Canonical sign message (pipe-delimited, deterministic):
  "zkpcare-attestation-v2|{w}|{cc}|{ls}|{fr}|{ts}|{exp}|{n}"
  SIGN: sig = Ed25519.sign(canonicalMessage, privateKey)
  VERIFY: ok = Ed25519.verify(canonicalMessage, publicKey, sig) — no JSON ambiguity

SequencerAttestationAuthority:
  Construction: random keypair OR deterministic from seed (SHA-256 -> PKCS8 DER -> Ed25519)
  Methods: createAttestation(params), verifyAttestation(att) [STATIC], revokeNonce(n), isRevoked(n)
```
