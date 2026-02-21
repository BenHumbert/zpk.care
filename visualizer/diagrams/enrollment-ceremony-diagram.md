# Diagram: Three-Party Enrollment Ceremony — Member Wallet Creation & Eligibility NFT Minting

## Instructions for Diagram Generation

Create a detailed **swim-lane sequence diagram** showing the complete enrollment flow for a healthcare member in a zero-knowledge proof system on the MINA blockchain. This is a three-party enrollment ceremony between an Employer, a Member, and an Insurer (who also operates the L2 sequencer).

The diagram should use a clean, professional style with:
- Three swim lanes (vertical columns): **Employer (ACME Corp HR)**, **Member (Emma Williams' Device)**, **Insurer (zkpCare L2 Sequencer)**
- Time flows top to bottom
- Color coding: Employer = blue, Member = green, Insurer/Sequencer = purple
- Each step is numbered to match the system's actual log output
- ZK proof generation steps should be visually distinct (highlighted boxes or special borders)
- Data structures should show their field contents
- Arrows show data flow direction; dashed arrows show data that is NOT transmitted (stays local)
- Include a legend for: ZK Proof (circuit execution), Off-chain computation, On-chain state change, Data that NEVER leaves the device

---

## Diagram Content — Exact Sequence

### Title
**"Three-Party Enrollment Ceremony — Zero-Knowledge Member Wallet Creation"**

### Subtitle
"No private keys. No PHI transmitted. Identity proven through Poseidon hash preimage knowledge."

---

### STEP 1: Employer Generates Enrollment Token

**Actor: Employer (ACME Corp HR)**

The employer's HR system generates a `GroupEnrollmentToken` for each eligible employee. This token contains NO PHI — only hashed identifiers.

**Action box in Employer lane:**
```
TokenAuthority.generateToken()
```

**Token data structure (show as a card/box):**
```
GroupEnrollmentToken (8 Fields, all Poseidon hashes):
┌──────────────────────────────────────┐
│ tokenIdHash:    hash("TOKEN-005")    │
│ groupIdHash:    hash("ACME-CORP")    │
│ planIdHash:     hash("PLAN-GOLD-2026")│
│ employeeIdHash: hash("EMP-005")      │
│ familyIdHash:   hash("FAM-003")      │
│ validUntil:     20261231             │
│ issuerHash:     hash("ACME-CORP-HR") │
│ nonce:          unique random        │
└──────────────────────────────────────┘
```

**Two arrows leaving the Employer:**
1. Arrow → to Member: "Token delivered (QR code / email / HR portal)"
2. Arrow → to Insurer: "Token metadata (tokenId, groupId, planId — NO PHI)"

**Key callout (annotation):**
> "The employer knows the employee's identity but the insurer only sees opaque hashed IDs. The token binds an employee to a group/plan without revealing who they are."

---

### STEP 2: Member Derives Wallet ID (On-Device)

**Actor: Member (Emma Williams' Device)**

The member's device computes a wallet identity from their personal data PLUS a locally-generated enrollment key. This computation happens entirely on the member's device.

**Action box in Member lane:**
```
deriveMemberWalletId(localData, enrollmentKey)
```

**Show the wallet derivation formula:**
```
walletId = Poseidon.hash([
    DOMAIN_TAG_MEMBER,        ← Field(0) — prevents cross-entity collisions
    hash(cardholderId),       ← hash("CID-Emma-005")
    dateToField(dateOfBirth), ← 19920715
    hash(firstName),          ← hash("Emma")
    hash(lastName),           ← hash("Williams")
    hash(enrollmentKey)       ← hash("device-generated-256-bit-secret")
])
```

**Result:**
```
walletId = 22933566...56270809 (a single Field — 254-bit Poseidon hash)
```

**Critical annotation with a "NEVER LEAVES DEVICE" icon/badge:**
> "The enrollment key is a 256-bit secret generated from the OS entropy pool (crypto.randomBytes). It is stored ONLY on the member's device and is NEVER transmitted to anyone — not the employer, not the insurer, not the blockchain. Even if all PHI is breached, the wallet cannot be impersonated without this key."

**Show a dashed line (NOT an arrow) from the device staying local:**
```
enrollmentKey: "a8Kx9m...Qz7w" ← STAYS ON DEVICE
```

**Also show the preimage fields being prepared (these are the private inputs for the ZK proof):**
```
preimageFields = [
    hash("CID-Emma-005"),             ← cardholderIdHash
    19920715,                          ← dateOfBirth
    hash("Emma"),                      ← firstNameHash
    hash("Williams"),                  ← lastNameHash
    hash("a8Kx9m...Qz7w")            ← enrollmentKeyHash
]
```

**Arrow → to Insurer:** "walletId ONLY (a single opaque hash — no PHI, no preimage)"

---

### STEP 3: Member Generates ProofGate Proof (On-Device)

**Actor: Member (Emma Williams' Device)**

This is the first ZK proof. The member proves they know the 5 preimage fields that hash to their walletId WITHOUT revealing any of them.

**ZK Proof box (highlighted, distinct style):**
```
╔══════════════════════════════════════════╗
║  ZK PROOF #1: ProofGateProgram           ║
║  Method: verifyMember                    ║
║                                          ║
║  Public input:  walletId                 ║
║                 (22933566...56270809)     ║
║                                          ║
║  Private inputs (NEVER revealed):        ║
║    [0] cardholderIdHash                  ║
║    [1] dateOfBirth                       ║
║    [2] firstNameHash                     ║
║    [3] lastNameHash                      ║
║    [4] enrollmentKeyHash                 ║
║                                          ║
║  Circuit logic:                          ║
║    computed = Poseidon.hash([            ║
║      DOMAIN_TAG_MEMBER,                  ║
║      f0, f1, f2, f3, f4                 ║
║    ])                                    ║
║    assert(computed == walletId)           ║
║                                          ║
║  Proves: "I know 5 fields that hash to   ║
║  this walletId" without revealing them.   ║
║                                          ║
║  Time: ~11.5 seconds                     ║
╚══════════════════════════════════════════╝
```

**Output annotation:**
> "The proof is a succinct SNARK (~1KB). Anyone can verify it in milliseconds, but extracting the private inputs is computationally infeasible. The insurer learns NOTHING about Emma's identity — only that someone can prove ownership of walletId 22933566...56270809."

**Arrow → to Insurer:** "ProofGate proof (succinct, ~1KB) + walletId"

---

### STEP 4a: Insurer Registers Wallet on L2 Chain

**Actor: Insurer (zkpCare L2 Sequencer)**

The insurer validates the token, then generates a StateTransitionProof proving the wallet was correctly inserted into the registry and lifecycle trees.

**Pre-state (show two Merkle trees side by side):**
```
BEFORE:
┌─ Wallet Registry (MerkleTree) ─┐    ┌─ Lifecycle Tree (MerkleTree) ─┐
│ Slot N: EMPTY (Field(0))       │    │ Slot N: EMPTY (Field(0))      │
│ Root: abc123...                 │    │ Root: def456...                │
└────────────────────────────────┘    └────────────────────────────────┘
```

**ZK Proof box (highlighted):**
```
╔══════════════════════════════════════════╗
║  ZK PROOF #2: StateTransitionProgram     ║
║  Method: proveRegistration               ║
║                                          ║
║  Private inputs:                         ║
║    domainTag:     Field(0) [MEMBER]      ║
║    f0-f4:         preimage fields        ║
║    registryWitness: Merkle path to slot  ║
║    lifecycleWitness: Merkle path to slot ║
║    currentRegistryRoot                   ║
║    currentLifecycleRoot                  ║
║                                          ║
║  Circuit logic:                          ║
║    1. Compute walletId from preimage     ║
║       (same Poseidon hash as ProofGate)  ║
║    2. Verify registry slot is EMPTY      ║
║    3. Insert WalletState commitment:     ║
║       Poseidon.hash([walletId,           ║
║         EMPTY_NFT_ROOT, nonce=0])        ║
║    4. Verify lifecycle slot is EMPTY     ║
║    5. Set lifecycle to REGISTERED (1)    ║
║       leaf = Poseidon.hash([walletId,    ║
║         LIFECYCLE_REGISTERED])           ║
║                                          ║
║  Public output (TransitionOutput):       ║
║    walletId                              ║
║    oldRegistryRoot → newRegistryRoot     ║
║    oldLifecycleRoot → newLifecycleRoot   ║
║                                          ║
║  Time: ~11.4 seconds                     ║
╚══════════════════════════════════════════╝
```

**Post-state:**
```
AFTER:
┌─ Wallet Registry (MerkleTree) ─┐    ┌─ Lifecycle Tree (MerkleTree) ─┐
│ Slot N: Poseidon.hash([        │    │ Slot N: Poseidon.hash([       │
│   walletId, EMPTY_ROOT, 0])    │    │   walletId, REGISTERED])      │
│ Root: ghi789...                │    │ Root: jkl012...               │
└────────────────────────────────┘    └────────────────────────────────┘
```

**Arrow → to L2 Sequencer (internal):**
```
L2 Receipt #1: l2-00000000
Type: Registration
Sequence Number: 0
```

---

### STEP 4b: Insurer Promotes Lifecycle (Admin Operation)

**Actor: Insurer (zkpCare L2 Sequencer)**

This is an off-chain admin operation — the insurer updates the lifecycle tree directly (no ZK proof needed for admin ops).

**Simple action box:**
```
Admin Operation (no ZK proof):
  Lifecycle slot N:
    REGISTERED (1) → ELIGIBLE (2)

  lifecycleTree.setLeaf(N,
    Poseidon.hash([walletId, LIFECYCLE_ELIGIBLE]))
```

**Lifecycle state machine (show as a small state diagram):**
```
EMPTY(0) → REGISTERED(1) → ELIGIBLE(2) → ACTIVE(3)
                                              ↓
                                         REVOKED(4)
```

**Annotation:**
> "The insurer is the attestation authority — they approve the member's eligibility after validating the employer's token. This is the ONLY step where the insurer exercises discretion."

---

### STEP 4c: Insurer Builds Eligibility Forest & Mints NFT

**Actor: Insurer (zkpCare L2 Sequencer)**

The insurer constructs the member's eligibility data, builds a MerkleForest, creates an NftData object, mints it into an NftInventory, and generates a StateTransitionProof for the wallet update.

**Show the MerkleForest construction:**
```
MerkleForest (6 domain trees, height 8):
┌─────────────────────────────────────────────────┐
│ MEMBER tree:         empty (root = 0)            │
│ PRESCRIBER tree:     empty (root = 0)            │
│ PHARMACY tree:       empty (root = 0)            │
│ MEDICATION tree:     empty (root = 0)            │
│ ACCESS_CONTROL tree:                              │
│   Leaf 0:   EligibilityData.commitment()         │
│   Leaf 127: AccumulatorData.commitment()         │
│ TRANSACTION tree:    empty (root = 0)            │
│                                                   │
│ ForestRoot = Poseidon.hash(all 6 tree roots)     │
└─────────────────────────────────────────────────┘
```

**Show the EligibilityData card:**
```
EligibilityData (8 Fields):
┌──────────────────────────────────────┐
│ planIdHash:      hash("PLAN-GOLD")   │
│ groupIdHash:     hash("ACME-CORP")   │
│ effectiveDate:   20260201            │
│ terminationDate: 0 (no end)         │
│ copayAmountCents: [per plan]         │
│ coverageType:    PHARMACY            │
│ formularyRoot:   [32K meds tree]     │
│ providerNetworkRoot: [providers]     │
└──────────────────────────────────────┘
```

**Show the AccumulatorData card:**
```
AccumulatorData (initialized to zero):
┌──────────────────────────────────────┐
│ planYear:              20260101      │
│ deductibleAmountCents: 50000 ($500)  │
│ deductiblePaidCents:   0             │
│ oopMaxCents:           800000 ($8K)  │
│ oopPaidCents:          0             │
│ annualBenefitMaxCents: 0 (unlimited) │
│ annualBenefitUsedCents: 0            │
└──────────────────────────────────────┘
```

**Show the NftData card:**
```
Eligibility NFT (NftData — 7 Fields):
┌──────────────────────────────────────┐
│ nftType:         ELIGIBILITY (1)     │
│ forestRoot:      [MerkleForest root] │
│ issuerWalletId:  [admin wallet]      │
│ subjectWalletId: [Emma's walletId]   │
│ issuedAt:        20260201            │
│ expiresAt:       0 (never)           │
│ revoked:         0 (active)          │
└──────────────────────────────────────┘
```

**Show the NftInventory minting:**
```
NftInventory (MerkleTree, height 4):
  BEFORE: empty tree (root = EMPTY_NFT_ROOT)

  mint(nftData) → inserts at slot 0

  AFTER:
    Slot 0: Poseidon.hash(nftData fields)
    Root: inventoryRoot (new Merkle root)
```

**ZK Proof box (highlighted):**
```
╔══════════════════════════════════════════╗
║  ZK PROOF #3: StateTransitionProgram     ║
║  Method: proveWalletUpdate               ║
║                                          ║
║  Private inputs:                         ║
║    domainTag:     Field(0) [MEMBER]      ║
║    f0-f4:         preimage fields        ║
║    oldNftRoot:    EMPTY_NFT_ROOT         ║
║    oldNonce:      0                      ║
║    newNftRoot:    inventoryRoot           ║
║    registryWitness: Merkle path          ║
║    lifecycleWitness: Merkle path         ║
║    currentRegistryRoot                   ║
║    currentLifecycleRoot                  ║
║    currentLifecycle: ELIGIBLE (2)        ║
║                                          ║
║  Circuit logic:                          ║
║    1. Compute walletId from preimage     ║
║    2. Verify wallet NOT revoked          ║
║       (lifecycle != REVOKED)             ║
║    3. Verify old state in registry:      ║
║       Poseidon.hash([walletId,           ║
║         EMPTY_NFT_ROOT, nonce=0])        ║
║    4. Compute new state:                 ║
║       Poseidon.hash([walletId,           ║
║         inventoryRoot, nonce=1])         ║
║    5. Return new registry root           ║
║                                          ║
║  Public output (TransitionOutput):       ║
║    walletId                              ║
║    oldRegistryRoot → newRegistryRoot     ║
║    oldLifecycleRoot (unchanged)          ║
║                                          ║
║  Time: ~11.5 seconds                     ║
╚══════════════════════════════════════════╝
```

**Arrow → to L2 Sequencer (internal):**
```
L2 Receipt #2: l2-00000001
Type: NFT Mint (wallet update)
Sequence Number: 1
```

---

### STEP 5: Insurer Notifies Provider Network

**Actor: Insurer (zkpCare L2 Sequencer)**

After enrollment is complete, the insurer sends eligibility notifications to in-network providers. These notifications contain ONLY the opaque walletId — no PHI.

**Show notification arrows going out to multiple providers:**
```
Notifications (walletId ONLY — no PHI):
  → Dr. Sarah Chen, MD (Internal Medicine) — CREDENTIALED
  → Dr. James Park, DO (Family Medicine) — CREDENTIALED
  → Dr. Rachel Green, MD (Pediatrics) — CREDENTIALED
  → HealthFirst Pharmacy (Retail) — CREDENTIALED
  → MedCenter Pharmacy (Hospital) — CREDENTIALED
```

**Also show encryption key registration:**
```
KeyRegistry:
  Slot M: {
    walletId: 22933566...56270809,
    publicKeyX: [derived from enrollmentKey],
    publicKeyY: [derived from enrollmentKey]
  }
```

---

### FINAL STATE — Enrollment Complete

**Show three summary boxes, one per actor:**

**Employer knows:**
```
✓ Employee "Emma Williams" (EMP-005) is enrolled
✓ Token TOKEN-005 consumed
✗ Does NOT know Emma's walletId
✗ Does NOT know any on-chain state
```

**Member's device holds:**
```
✓ walletId: 22933566...56270809
✓ enrollmentKey: "a8Kx9m...Qz7w" (NEVER leaves device)
✓ preimageFields: [5 hashed identity fields]
✓ ProofGate proof (cached for reuse)
✓ L2 Receipt IDs: [l2-00000000, l2-00000001]
✗ No private key exists — access is through ZK proofs only
```

**Insurer (L2 Sequencer) holds:**
```
✓ walletId: 22933566...56270809 (opaque hash)
✓ Wallet Registry: slot N committed with nonce=1, inventoryRoot
✓ Lifecycle Tree: slot N = ELIGIBLE
✓ NFT Inventory: slot 0 = Eligibility NFT (forestRoot with eligibility + accumulator)
✓ 2 L2 Receipts (registration + NFT mint)
✓ Opaque Roster: walletId → group/plan mapping (no names)
✗ Does NOT know Emma's name, DOB, cardholderId, or enrollmentKey
✗ CANNOT derive the walletId from any data it holds
✗ CANNOT impersonate Emma (missing enrollmentKey)
```

---

### L2 Settlement Path (show as a small footer diagram)

```
StateTransitionProof (registration)  ─┐
                                       ├─→ BatchProgram.wrapTransition()
StateTransitionProof (NFT mint)      ─┘         │
                                          BatchProgram.mergeBatches()
                                                 │
                                          ChainProgram.advance()
                                                 │
                                          CareContract.settle() → MINA L1
                                          (every ~3 minutes)
```

---

## Visual Style Notes

1. **Swim lanes**: Three vertical columns. Employer on left (blue), Member in center (green), Insurer on right (purple).
2. **ZK Proof boxes**: Use a distinctive double-border or golden/highlighted background to make them stand out from regular actions.
3. **Data structures**: Show as rounded-corner cards with field names on the left and values on the right.
4. **"NEVER LEAVES DEVICE" annotations**: Use a red lock icon or shield badge next to the enrollment key and preimage fields.
5. **Arrows**: Solid arrows = data transmitted. Dashed arrows with X = data that stays local.
6. **Time indicators**: Show approximate elapsed time next to each ZK proof (~11.5s each).
7. **State changes**: Show "BEFORE → AFTER" for Merkle tree root changes.
8. **The overall flow should read top-to-bottom as a timeline**, with clear separation between the 5 main steps.

## Key Privacy Properties to Highlight

Add these as callout boxes or annotations:

1. **Zero PHI on chain**: Only Poseidon hash commitments are stored. The insurer sees walletId (an irreversible hash) — never names, DOB, or cardholderId.
2. **No private keys**: Unlike traditional blockchains, there is no private key. The wallet "secret" is the combination of 5 identity fields + the enrollment key, proven via ZK circuits.
3. **Enrollment key = 2FA**: Even if ALL PHI is breached (names, DOB, cardholderId), the wallet is safe because the attacker doesn't have the enrollment key from the member's device.
4. **Three-party separation**: The employer knows WHO (identity), the member knows HOW (enrollment key), and the insurer knows WHAT (on-chain state) — but no single party has all three.
5. **Proof reuse**: The ProofGate proof generated in Step 3 is cached on the member's device and reused for all future interactions (prescriptions, fills, credential generation).
