# FIG. 11 — Encrypted Message Store

```
Replacement Sheet

FIG. 11 — ENCRYPTED MESSAGE STORE                               Sheet 13 of 22
=========================================================================================

SECTION A: ENCRYPTION MODEL & KEY DERIVATION 1100
---------------------------------------------------
SENDER DEVICE:                          RECIPIENT DEVICE:
enrollmentKey (256-bit, on device)      enrollmentKey (256-bit, on device)
        |                                       |
        v                                       v
   SHA-256(enrollmentKey)                  SHA-256(enrollmentKey)
        |                                       |
        v                                       v
   X25519 keypair                          X25519 keypair
   {privateKey_S, publicKey_S}             {privateKey_R, publicKey_R}
        |                                       |
        +--------> ECDH(privS, pubR) <----------+
                         |
                         v
                  HKDF-SHA256 (info='zkpcare-msg-aes256gcm', keyLen=32)
                         |
                         v
                  AES-256-GCM encrypt -> ciphertext + iv + tag
                         |
                         v
                  messageCommitment = concat(ciphertext,iv,tag) -> hex -> stringToFields -> Poseidon.hash
                         |
                         v
                  Submit: StoredMessage (5 fields) + MessagePayload (ciphertext+iv+tag)

Key derivation is DETERMINISTIC: same enrollmentKey -> same keypair -> all past messages decryptable

SECTION B: MERKLE TREE(20) STRUCTURE 1102       StoredMessage (5-Field Poseidon Hash):
----------------------------------------------   leafHash = Poseidon.hash([
         [  Root  ]                                F1: messageCommitment (hash of ciphertext),
        /          \                               F2: senderWalletId,
      /              \                             F3: recipientWalletId,
   [H_L]           [H_R]                           F4: messageType (1=clinical,2=admin,3=eScript),
    ...  (20 levels)  ...                          F5: threadIdHash
[lf0][lf1][lf2]...[lf_1M]                       ])
Capacity: 2^20 = 1,048,576 msgs               Integrity in tree. Confidentiality off tree.

SECTION C: IN-TREE vs OFF-TREE SPLIT 1104
-------------------------------------------
+---------------------------+---+-----------------------------+
| IN TREE (Poseidon leaf):  |   | OFF TREE (stored alongside):|
| StoredMessage {           |   | MessagePayload {            |
|   messageCommitment,      |   |   ciphertext (hex),         |
|   senderWalletId,         |   |   iv (hex),                 |
|   recipientWalletId,      |   |   tag (hex),                |
|   messageType,            |   |   timestamp,                |
|   threadIdHash            |   |   receiptId?                |
| } -> Poseidon.hash        |   | } -> NOT hashed             |
| = INTEGRITY               |   | = CONFIDENTIALITY           |
+---------------------------+---+-----------------------------+

SECTION D: FOUR PARALLEL INDEX STRUCTURES 1106
------------------------------------------------
  INDEX 1: senderIndex                     INDEX 2: recipientIndex
  Map<senderWalletId, bigint[]>            Map<recipientWalletId, bigint[]>
  +------------------------------+         +------------------------------+
  | sender_A -> [0, 3, 5]        |         | recip_B -> [0, 2, 5]         |
  | sender_B -> [2, 4]           |         | recip_A -> [1, 3]            |
  +------------------------------+         +------------------------------+
  INDEX 3: walletIndex (UNION)             INDEX 4: threadIndex
  Map<walletId, bigint[]>                  Map<threadIdHash, bigint[]>
  +------------------------------+         +------------------------------+
  | wallet_A -> [0, 1, 3, 5]     |         | thread_T1 -> [0, 2, 5]       |
  | wallet_B -> [0, 2, 4, 5]     |         | thread_T2 -> [1, 3, 4, 6]    |
  +------------------------------+         +------------------------------+

6 RPC: l2_getMessagesByWallet, l2_getMessagesBySender, l2_getMessagesByRecipient,
       l2_getMessagesByThread, l2_getMessageStoreRoot, l2_storeMessage

SECTION E: NFC RECOVERY FLOW 1108          BATCH INTEGRATION 1110:
-------------------------------             L2Batch { messageStoreRoot?: string }
1. Tap NFC Card -> PIN decrypt -> enrollmentKey recovered     Snapshot of tree root at batch
2. enrollmentKey -> SHA-256 -> X25519 keypair (same as before) creation, committed alongside
3. l2_getMessagesByWallet(walletId) -> encrypted entries       claimAccumulatorRoot.
4. AES-256-GCM decrypt locally -> full history restored
Neither NFC card alone nor sequencer alone can read messages. Both needed.
```
