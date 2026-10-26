# FIG. 14B — Portable Credential: NFC Encoding, Verification, Delegation (Sheet 18 of 22)

```
Replacement Sheet

FIG. 14B — PORTABLE CREDENTIAL — NFC ENCODING, VERIFICATION & DELEGATION      Sheet 18 of 22
=================================================================================================

SECTION D: NFC TAG NDEF ENCODING                                                          1406
-------------------------------------------------------------------------------------------------
NTAG216 — 888 bytes user memory (pages 4-225, 4 bytes/page)

Page 4+:
+----------------------------------------------------------------------------------------+
| TLV: 0x03 | 0xFF | hi | lo  (NDEF Message, 3-byte length for >255)                     |
|                                                                                        |
| NDEF Message 1 — Member ID (Well-Known Text)        ~120 bytes    (standalone write)   |
|   0xD1 (MB=1,ME=1,SR=1,TNF=0x01) | Type:'T' | Status:0x02 UTF-8 | Lang:"en"            |
|   Payload: walletId string                                                             |
|                                                                                        |
| NDEF Message 2 — Attestation (External Type)         ~500 bytes   (standalone write)   |
|   0xC4 (MB=1,ME=1,SR=0,TNF=0x04) | Type(26):"zktrident.care:attestation"               |
|   Payload: JSON attestation (Long Record, 4-byte length)                               |
|                                                                                        |
| 0xFE  Terminator TLV              Total: ~620 bytes / 888 capacity = 70%               |
+----------------------------------------------------------------------------------------+
  T2T Commands: READ(0x30) 16 bytes/page, WRITE(0xA2) 4 bytes/page

NFC HARDWARE TRANSPORT STACK:
+---------------------------+
| NfcBridge (Node.js)       |  Application — connect(), readTag(), writeTag(), 100ms poll
+---------------------------+
| USB HID Reports (64B)     |  Transport — node-hid
+---------------------------+
| LpcUsbSioTransport        |  LPCUSBSIO protocol (I2C over HID), VID:0x1FC9, PID:0x0088
+---------------------------+
| LPC11U24 (USB-to-I2C)     |  Hardware — MIKROE-2540 Click Board
+---------------------------+
| PN7150 (NCI, I2C@400kHz)  |  NFC Controller — addr 0x28
+---------------------------+
| NTAG216 (ISO 14443, RF)   |  Tag — 13.56 MHz, 888 bytes
+---------------------------+

SECTION E: OFFLINE VERIFICATION FLOWS                                                      1408
-------------------------------------------------------------------------------------------------
PATH A: FULL ZK PROOF (PortableCredential)   |  PATH B: Ed25519 ATTESTATION (NfcCredAttestation)
                                             |
 Receive via QR / network                    |  Patient taps NTAG216 on reader
          |                                  |           |
          v                                  |           v
 Check expiry (expiresAt > now?)             |  Parse NDEF: standalone message (walletId or attestation)
          |                                  |           |
          v                                  |           v
 Deserialize: CredentialOperationProof       |  Check format: v===2, t==='credential-attestation'
   .fromJSON(proofJson)                      |           |
          |                                  |           v
          v                                  |  Check expiry: now > att.exp?
 Verify: CredentialProgram.verify(proof)     |           |
   Uses CACHED verification key              |           v
   No network needed                         |  Rebuild canonical message, Ed25519.verify(msg,pk,sig)
   Pickles recursive verification            |   Time: < 1ms, Network: NONE, pubkey in attestation
          |                                  |           |
          v                                  |           v
 RESULT: mathematically proven               |  (Optional) Online revocation check: isRevoked(att.n)
 TRUST: ZK proof (math certainty)            |  RESULT: VERIFIED — Ed25519 attestation
 NEEDS: Cached verification key              |  TRUST: Cryptographic (Ed25519 signature integrity)
---------------------------------------------|----------------------------------------------
 Size: 10-22 KB | Transport: QR/network      |  Size: ~500B | Transport: NTAG216 NFC (888B)
 Verify: ms     | Offline: YES               |  Verify: <1ms | Offline: YES
 Revocation: expiry only                     |  Revocation: expiry + nonce set
 Proves: ZK credential valid (direct)        |  Proves: sequencer saw valid ZK proof (receipt)
 Privacy: Highest (ZK)                       |  Privacy: High (only hashes)

SECTION F: DELEGATION CREDENTIAL TTL TIERS                                                 1410
-------------------------------------------------------------------------------------------------
CMS-1696 Appointment of Representative — PortableDelegationCredential:

TTL TIERS:
+------------------+---------+------+--------------------------------------------------+
| Scope            | TTL     | Risk | Description                                      |
+------------------+---------+------+--------------------------------------------------+
| READ-ONLY        | 72 hrs  | LOW  | View records only                                |
| WRITE            | 24 hrs  | MED  | Modify data                                      |
| PICKUP           | 4 hrs   | HIGH | Medication dispensing (48h cool-down before use) |
+------------------+---------+------+--------------------------------------------------+
  Cool-down: 48h before PICKUP activates (prevents instant social engineering)
  Rate limit: 24h between new delegations       Domain tag: 3 (AOR delegation)

PortableDelegationCredential fields:
  version, credentialType:'delegation', delegation: {delegatorWalletId, delegateWalletId,
  scopeFlags, effectiveDate, expirationDate, relationshipCode, delegationHash},
  delegationIndex, witnessPath[], witnessIsLefts[], delegationRegistryRoot, messagingRoot,
  chainStateTimestamp, createdAt
```
