# zkp.Care — Production Onboarding Guide

**How to go from zero to a fully functioning claim adjudication network with your first client.**

Patent Pending. All PHI/PII stays local on user devices — only Poseidon hash commitments stored on the Leviathan network.

---

## Prerequisites

- Node.js 20+ with `--max-old-space-size=8192` (minimum)
- 16 GB RAM recommended (8 GB minimum for single-partition)
- `npm install` completed in project root

---

## Phase 0 — Start the Network

Everything starts from a single command. The Leviathan sequencer auto-spawns all entity nodes as child processes in a health-gated boot sequence.

```bash
npx tsx src/nodes/start-leviathan.ts
```

### What happens automatically:

| Order | Service | Port | What it does |
|-------|---------|------|-------------|
| 1 | Leviathan Sequencer | 3030 | Genesis or checkpoint recovery, proving pool, RPC server |
| 2 | Replica nodes | 3031-3032 | Gossip replication (data availability) |
| 3 | Insurer Nautilus | 4004 | Credentials 18 demo providers, publishes formulary |
| 4 | Prescriber Nautilus | 4002 | Demo prescriber (Dr. Sarah Chen, MD) |
| 5 | Pharmacy Nautilus | 4003 | Demo pharmacy (Main Street Pharmacy) |
| 6 | Employer Nautilus | 4005 | Token authority for enrollment |
| 7 | Member Nautilus | 4001 | Fresh — awaiting enrollment |
| 8 | Explorer | 8000 | Block explorer dashboard |

Wait until you see all health checks pass in the console (~30-60 seconds). The insurer must finish credentialing providers before other nodes start.

### Optional: Custom admin token

```bash
ZKTRIDENT_ADMIN_TOKEN=your-secret npx tsx src/nodes/start-leviathan.ts
```

---

## Phase 1 — Employer: Create Enrollment Tokens

**Dashboard**: http://localhost:4005

The employer creates enrollment tokens that authorize members to join their benefit plan.

### Steps:

1. Navigate to the **Tokens** tab
2. Click **Generate Token**
3. Fill in:
   - **Group ID**: Your employer group identifier (e.g., `ACME-GRP-001`)
   - **Employee ID**: Unique employee identifier (e.g., `EMP-001`)
   - **Family ID**: Family group identifier (leave blank for individual)
   - **Valid Until**: Expiry date for the token
4. Click **Generate**
5. **Copy the Token ID** — the member needs this to enroll

> The token is cryptographically committed as a `GroupEnrollmentToken` (8 Fields, Poseidon hash). The employer's roster tracks each token with status `pending`.

### What's created:

```
GroupEnrollmentToken:
  tokenId → unique identifier
  tokenIdHash → Poseidon(tokenId) — stored on sequencer
  groupId, planId, employeeId, familyId → hashed, never plaintext
  validUntil → expiry date
  status: 'unused'
```

---

## Phase 2 — Member: Self-Enrollment

**Dashboard**: http://localhost:4001

The member enrolls on their own device. PHI never leaves the device — only Poseidon hash commitments are transmitted.

### Steps:

1. Open the member dashboard (fresh state — onboarding screen)
2. **Step 1 — Enter Token**: Paste the token ID from your employer
3. **Step 2 — Enter Identity**:
   - Cardholder ID
   - First Name, Last Name
   - Date of Birth (CCYYMMDD format, e.g., `19850315`)
4. **Step 3 — Generate Wallet**:
   - An enrollment key is generated on-device (2FA secret, NEVER transmitted)
   - Wallet ID = `Poseidon.hash([domainTag, ...hashedPHI, hash(enrollmentKey)])`
   - PHI is immediately scrubbed from memory after hashing
5. **Step 4 — Enroll**:
   - Wallet ID + Token ID sent to insurer (best-effort notification)
   - Local MemberNode created
   - Connection to sequencer established

> **Security**: The enrollment key exists ONLY on the member's device. The insurer sees only the opaque wallet ID (a Poseidon hash). There is no way to reverse the hash to recover PHI.

### What the member now has:

```
Local Device:
  walletId → Poseidon hash of identity + enrollment key
  enrollmentKey → secret, never leaves device
  preimageFields → hashed identity fields (for proof generation)

Sequencer:
  Wallet registered in WalletRegistry MerkleTree
  Lifecycle state: REGISTERED → ELIGIBLE → ACTIVE
```

---

## Phase 3 — Member: Assign PCP (Primary Care Physician)

**Dashboard**: http://localhost:4001

### Steps:

1. Navigate to the **Settings** tab (or Provider Directory)
2. Browse available prescribers (queried from sequencer's provider registry)
3. Click **Set PCP** next to your chosen prescriber
4. The PCP assignment is:
   - Saved locally on device
   - Registered on the sequencer via `l2_registerPcpAssignment`
   - Visible to the prescriber in their PCP patients list

---

## Phase 4 — Prescriber: Write a Prescription

**Dashboard**: http://localhost:4002

### Steps:

1. Navigate to the **Prescribe** tab
2. Fill in the prescription form:
   - **Patient Wallet ID**: The member's wallet ID (from their dashboard or NFC scan)
   - **Pharmacy Wallet ID**: Destination pharmacy
   - **Medication**: Select from formulary (NDC hash)
   - **Quantity**, **Days Supply**, **Refills**
   - **Directions**, **Diagnosis** (optional)
3. Click **Submit Prescription**

### What happens:

```
Prescriber Node:
  1. Creates prescription object (rxId, NDC, quantities, etc.)
  2. Serializes to JSON → hex encoding
  3. Sends as messageType '3' (eScript) to:
     → Pharmacy (via MessageStore)
     → Member (notification copy)
  4. Thread ID: rx-{rxId} for tracking

Sequencer MessageStore:
  StoredMessage indexed by sender, recipient, thread
  Replicated to all leviathans via gossip
```

---

## Phase 5 — Pharmacy: Receive & Dispense

**Dashboard**: http://localhost:4003

### Steps:

1. Open the **Workstation** tab
2. **Incoming prescriptions** appear in the **Active** column with an **eRx** badge
   - These are eScript messages from prescribers (decoded from MessageStore)
   - Alongside claims from the claim accumulator
3. **DUR Check**: Click a script to see drug utilization review data
   - Cross-pharmacy full drug history (via gossip-replicated claim accumulator)
   - Active medication check for duplicates/interactions
4. Click **Dispense** to fill the prescription:
   - Script moves to **Dispensed** column
   - Fill recorded on sequencer's claim accumulator (`l2_recordFill`)
5. **Member Pickup**: When the member arrives:
   - Scan their NFC credential or paste wallet ID in the Filled column
   - Click **Scan** — verifies identity, shows active medications
   - Dispensed scripts for that member auto-move to **Filled** column

### Claim recorded on sequencer:

```
ClaimLeaf (9 Fields → Poseidon hash):
  memberWalletId, ndcHash, pharmacyWalletId, prescriberWalletId
  dateOfService, patientPayCents, planPayCents
  operationType (1=fulfillment, 2=reversal)
  deductibleCreditCents
```

---

## Phase 6 — Member: Generate Offline Credential

**Dashboard**: http://localhost:4001

### Steps:

1. Navigate to the **Security** tab
2. In the **NFC Credential** panel:
   - Click **Request Attestation**
   - The sequencer generates an Ed25519-signed compact credential (~578 bytes)
   - Valid for 24 hours (configurable)
3. Choose one:
   - **Write to NFC** — queues write to a connected NTAG216 tag via USB HID reader
   - **Download Credential** — saves a portable JSON file for manual transfer

### Attestation format:

```
NfcCredentialAttestation v2:
  walletId — member identity hash
  credentialCommitment — forest root hash
  lifecycleState — ACTIVE(3)
  forestRoot — MerkleForest root
  expiry — 24h from issuance
  nonce — revocation handle
  signature — Ed25519 over canonical message

Canonical message:
  "zkpcare-attestation-v2|{w}|{cc}|{ls}|{fr}|{ts}|{exp}|{n}"
```

### Pharmacy verification (offline):

1. Read NDEF payload from NFC tag
2. Verify Ed25519 signature (< 1ms, no network required)
3. Check expiry timestamp
4. Optional: check revocation nonce online
5. Display verified badge + member's active medications

---

## Phase 7 — Insurer: Monitor & Manage

**Dashboard**: http://localhost:4004

### Available operations:

| Tab | What you can do |
|-----|----------------|
| **Overview** | Live roster, eligibility stats, enrollment counts |
| **Credentialing** | View provider registry, approve/deny applications, suspend/terminate providers |
| **Reports** | Generate 12 report types (enrollment, claims, utilization, etc.) |
| **Formulary** | Upload and publish formulary updates to sequencer |
| **Messaging** | Send/receive messages to providers and members |

---

## Production Configuration

### Environment Variables

```bash
# Required for production
ZKTRIDENT_ADMIN_TOKEN=<strong-random-token>
ZKTRIDENT_GOSSIP_SECRET=<shared-secret-for-gossip-auth>

# Network
ZKTRIDENT_PORT=3030
ZKTRIDENT_HOST=0.0.0.0
ZKTRIDENT_CORS_ORIGINS=https://your-domain.com

# TLS (recommended)
ZKTRIDENT_TLS_CERT=/path/to/cert.pem
ZKTRIDENT_TLS_KEY=/path/to/key.pem

# Performance
ZKTRIDENT_POOL_SIZE=auto          # Auto-detect from RAM
ZKTRIDENT_POOL_RECYCLE=3          # Recycle workers every 3 jobs
ZKTRIDENT_BATCH_INTERVAL_MS=180000  # 3-minute batch timer

# Persistence
ZKTRIDENT_CHECKPOINT_DIR=./l2-data
ZKTRIDENT_MAX_CHECKPOINTS=10

# Multi-partition (scale-out)
ZKTRIDENT_PARTITION_COUNT=1       # Increase for higher throughput
ZKTRIDENT_PARTITION_INDEX=0
ZKTRIDENT_SEED_PEERS=             # Comma-separated peer URLs
```

### Port Summary

| Port | Service | Required |
|------|---------|----------|
| 3030 | Leviathan Sequencer | Yes |
| 4001 | Member Nautilus | Per member device |
| 4002 | Prescriber Nautilus | Per prescriber |
| 4003 | Pharmacy Nautilus | Per pharmacy POS |
| 4004 | Insurer Nautilus | Yes (one per insurer) |
| 4005 | Employer Nautilus | Per employer |

---

## Onboarding Your First Real Client (Non-Demo)

### Step 1: Disable demo data

Start the Leviathan without demo entity auto-spawning:

```bash
ZKTRIDENT_ADMIN_TOKEN=<token> npx tsx src/nodes/start-leviathan.ts
```

Start each entity node individually on their respective machines/containers.

### Step 2: Start the Insurer

```bash
ZKTRIDENT_PORT=4004 \
ZKTRIDENT_SEQUENCER_URL=https://leviathan.your-domain.com \
ZKTRIDENT_ADMIN_TOKEN=<token> \
npx tsx src/nodes/start-insurer-nautilus.ts
```

### Step 3: Credential real providers

In the Insurer dashboard (`:4004`):
1. **Credentialing** tab → submit application for each prescriber/pharmacy
2. Enter real NPI, specialty, name
3. **Verify** → **Approve** with the provider's derived wallet ID
4. Provider appears in the registry with state ACTIVE

### Step 4: Publish your formulary

In the Insurer dashboard:
1. **Formulary** tab → upload your formulary CSV/JSON
2. Click **Publish to Sequencer**
3. Formulary root committed to Leviathan

### Step 5: Start the Employer

```bash
ZKTRIDENT_PORT=4005 \
ZKTRIDENT_SEQUENCER_URL=https://leviathan.your-domain.com \
ZKTRIDENT_EMPLOYER_ID=CLIENT-001 \
ZKTRIDENT_ADMIN_TOKEN=<token> \
npx tsx src/nodes/start-employer-nautilus.ts
```

### Step 6: Generate enrollment tokens

Employer dashboard (`:4005`) → **Tokens** tab → Generate tokens for each employee.

### Step 7: Distribute tokens to members

Members receive their token ID (via secure channel — email, HR portal, etc.).

### Step 8: Members self-enroll

Each member runs their Nautilus on their device:

```bash
ZKTRIDENT_PORT=4001 \
ZKTRIDENT_SEQUENCER_URL=https://leviathan.your-domain.com \
npx tsx src/nodes/start-member-nautilus.ts
```

Open dashboard (`:4001`), enter token, enter identity, generate wallet.

### Step 9: Provider nodes

Each prescriber/pharmacy runs their Nautilus:

```bash
# Prescriber
ZKTRIDENT_PORT=4002 \
ZKTRIDENT_SEQUENCER_URL=https://leviathan.your-domain.com \
npx tsx src/nodes/start-prescriber-nautilus.ts

# Pharmacy
ZKTRIDENT_PORT=4003 \
ZKTRIDENT_SEQUENCER_URL=https://leviathan.your-domain.com \
npx tsx src/nodes/start-pharmacy-nautilus.ts
```

---

## Architecture Summary

```
┌─────────────────────────────────────────────────────┐
│                 LEVIATHAN NETWORK                   │
│                                                     │
│  Sequencer ←──gossip──→ Replica 1                  │
│     ↕                      ↕                        │
│  Replica 2 ←──gossip──→ Partition N                │
│                                                     │
│  State: WalletRegistry, ClaimAccumulator,           │
│         MessageStore, ProviderRegistry,             │
│         AuditChain, Checkpoint/WAL                  │
└──────────────────┬──────────────────────────────────┘
                   │ JSON-RPC 2.0 + SSE
     ┌─────────────┼─────────────────────┐
     ↓             ↓                     ↓
┌─────────┐  ┌──────────┐  ┌─────────────────┐
│ Member  │  │Prescriber│  │    Pharmacy      │
│Nautilus │  │ Nautilus  │  │   Nautilus       │
│         │  │          │  │                   │
│ Wallet  │  │ eRx Send │  │ DUR + Dispense  │
│ Proofs  │  │ PCP List │  │ NFC Verify      │
│ NFC Cred│  │ History  │  │ Claim Record    │
└─────────┘  └──────────┘  └─────────────────┘
     ↑             ↑                     ↑
     │             │                     │
┌─────────┐  ┌──────────┐  ┌─────────────────┐
│ Employer│  │ Insurer  │  │   Explorer      │
│Nautilus │  │ Nautilus  │  │   (Dashboard)   │
│         │  │          │  │                   │
│ Tokens  │  │ Registry │  │ Block/Batch View │
│ Roster  │  │ Formulary│  │ Audit Log       │
│ Groups  │  │ Reports  │  │ Chain Proof     │
└─────────┘  └──────────┘  └─────────────────┘
```

---

## Security Model

| Principle | Implementation |
|-----------|---------------|
| **Zero Knowledge** | All identity data hashed via Poseidon before transmission |
| **PHI stays local** | Member device holds raw identity; only hashes leave device |
| **Enrollment key** | User-generated 2FA secret, mixed into wallet derivation, NEVER transmitted |
| **Proof-gated wallets** | Addresses derived without private keys; access through ZK proofs only |
| **Insurer sees nothing** | Only opaque wallet IDs (Poseidon hashes); holds NO secrets |
| **NFC credentials** | Ed25519-signed attestations; nothing on tag is secret |
| **Gossip replication** | All leviathans hold full state; no single point of failure |
| **WAL + Quorum** | Write-ahead log + Ed25519-signed votes for zero-data-loss durability |
