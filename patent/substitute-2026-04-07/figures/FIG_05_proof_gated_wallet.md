# FIG. 5 — Proof-Gated Wallet Derivation

```
Replacement Sheet

FIG. 5 — PROOF-GATED WALLET DERIVATION                          Sheet 5 of 22

+=====================================================================+
|| NO PRIVATE KEY. NO MNEMONIC. NO SEED PHRASE. NO SIGNING KEY.      ||
|| walletId IS the address. Access gated EXCLUSIVELY by ZK proof.    ||
+=====================================================================+

== SECTION A: WALLET DERIVATION BY ENTITY TYPE ==

  MEMBER 500 (tag=0, 6-field)           PRESCRIBER 502 (tag=1, 4-field)
  +-------------------------------+     +-------------------------------+
  | [0] domainTag = Field(0)      |     | [0] domainTag = Field(1)      |
  | [1] hashString(cardholderId)  |     | [1] codeToField(idQualifier)  |
  | [2] hashDate(dateOfBirth)     |     | [2] hashString(prescriberId)  |
  | [3] hashString(firstName)     |     | [3] hashString(enrollmentKey) |
  | [4] hashString(lastName)      |     |     NEVER TRANSMITTED         |
  | [5] hashString(enrollmentKey) |     +---------------+---------------+
  |     NEVER TRANSMITTED         |                     |
  +---------------+---------------+                     v
                  |                     +-------------------------------+
                  v                     | Poseidon.hash([4]) -> walletId|
  +-------------------------------+     +-------------------------------+
  | Poseidon.hash([6]) -> walletId|
  +-------------------------------+     PHARMACY 504 (tag=2, 4-field)
                                        +-------------------------------+
  REPRESENTATIVE 506 (tag=3, 4-field)   | [0] domainTag = Field(2)      |
  +-------------------------------+     | [1] codeToField(svcProvIdQual)|
  | [0] domainTag = Field(3)      |     | [2] hashString(serviceProvId) |
  | [1] codeToField(repIdQual)    |     | [3] hashString(enrollmentKey) |
  | [2] hashString(representId)   |     |     NEVER TRANSMITTED         |
  | [3] hashString(enrollmentKey) |     +---------------+---------------+
  |     NEVER TRANSMITTED         |                     |
  +---------------+---------------+                     v
                  |                     +-------------------------------+
                  v                     | Poseidon.hash([4]) -> walletId|
  +-------------------------------+     +-------------------------------+
  | Poseidon.hash([4]) -> walletId|
  +-------------------------------+
  Domain tag prevents cross-entity collision. Enrollment key in ALL types = crypto 2FA.

== SECTION B: ProofGateProgram 121 (ZK Proof of Wallet Ownership) ==

  +==========================================================================+
  || ProofGateProgram 121 -- 4 methods, each: public=walletId               ||
  ||                                                                        ||
  || verifyMember:         private=[cardIdH, dob, firstH, lastH, enrollH]   ||
  ||                       assert: Poseidon.hash([0, ...5 fields])==walletId||
  || verifyPrescriber:     private=[qualCode, prescriberIdH, enrollH]       ||
  ||                       assert: Poseidon.hash([1, ...3 fields])==walletId||
  || verifyPharmacy:       private=[qualCode, svcProvIdH, enrollH]          ||
  ||                       assert: Poseidon.hash([2, ...3 fields])==walletId||
  || verifyRepresentative: private=[qualCode, representIdH, enrollH]        ||
  ||                       assert: Poseidon.hash([3, ...3 fields])==walletId||
  ||                                                                        ||
  || Private inputs NEVER leave prover's device. Verifier learns ONLY that  ||
  || a valid preimage exists.                                               ||
  +=================================+========================================+
                                    |
                                    v
                          +-------------------+
                          | ProofGateProof =  |
                          | sole authorization|
                          | for wallet ops    |
                          +-------------------+

== SECTION C: INLINED VERIFICATION -- StateTransitionProgram 122 ==

  +==========================================================================+
  || Private inputs 508: [domainTag, f0, f1, f2, f3, f4] (pad f3=f4=0)      ||
  ||                                                                        ||
  || 3 hash variants computed SIMULTANEOUSLY in-circuit:                    ||
  ||   memberHash     = Poseidon.hash([Field(0), f0, f1, f2, f3, f4])       ||
  ||   prescriberHash = Poseidon.hash([Field(1), f0, f1, f2])               ||
  ||   pharmacyHash   = Poseidon.hash([Field(2), f0, f1, f2])               ||
  ||                         |         |         |                          ||
  ||                         v         v         v                          ||
  ||   Provable.switch([tag==0, tag==1, tag==2], Field,                     ||
  ||     [memberHash, prescriberHash, pharmacyHash]) --> walletId (verified)||
  ||                                                                        ||
  || KEY: Wallet verification INLINED (not recursive). Keeps proof chain    ||
  || to 3 levels: StateTransition(0) -> Batch(1) -> Chain(2). Within        ||
  || Pickles maxProofsVerified=2 constraint.                                ||
  +==========================================================================+

== SECTION D: WALLET LIFECYCLE STATE MACHINE ==

  +-------+ proveReg +------------+ credential +----------+ 1st claim +--------+ terminate +--------+
  | EMPTY |--------->| REGISTERED |----------->| ELIGIBLE |---------->| ACTIVE |---------->| REVOKED|
  |  (0)  |          |    (1)     |  issuance  |   (2)    |           |  (3)   |           |  (4)   |
  +-------+          +------+-----+            +----+-----+           +--------+           +---^----+
                            |                       |                                          |
                            |    admin revocation   |           admin revocation               |
                            +-----------------------+------------------------------------------+

  Lifecycle leaf = Poseidon.hash([walletId, lcState]) -- committed in lifecycle Merkle tree.
```
