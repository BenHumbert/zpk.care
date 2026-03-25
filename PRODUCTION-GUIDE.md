# zkTrident Production Guide — Plan to Member Enrollment

## Quick Start

```bash
npm run start:leviathan
```

This single command boots the entire network:

| Service          | Port | Dashboard URL               |
|------------------|------|-----------------------------|
| Leviathan (seq)  | 3030 | http://localhost:3030        |
| Replica 1        | 3031 | (no dashboard)              |
| Replica 2        | 3032 | (no dashboard)              |
| Proof Delegate   | 4040 | (API only)                  |
| Member           | 4001 | http://localhost:4001        |
| Prescriber       | 4002 | http://localhost:4002        |
| Pharmacy         | 4003 | http://localhost:4003        |
| Insurer          | 4004 | http://localhost:4004        |
| Employer         | 4005 | http://localhost:4005        |
| Explorer         | 8000 | http://localhost:8000        |

Boot order is health-gated:
1. **Leviathan** starts → spawns replicas + proof delegate
2. **Insurer** spawns → credentials all seed providers + publishes formulary
3. Once insurer is healthy → **Prescriber, Pharmacy, Employer, Member, Explorer** spawn

Wait for console output showing all entities spawned before opening dashboards.

---

## Step-by-Step: Plan → Employer → Member Enrollment

### Step 1: Create a Benefit Plan (Insurer Dashboard)

Open **http://localhost:4004** → click the **Plans** tab.

**Option A — Use a pre-built template:**

1. Scroll to the **Plan Templates** section at the bottom
2. Click one or more template cards to select them (e.g., "Cost Plus Basic", "Transparent AWP Minus")
3. Click **Create Selected Plans**
4. The plans appear in the plan list above

**Option B — Create a custom plan:**

1. Click **+ Create Plan** to expand the form
2. Fill in:
   - **Plan ID**: e.g. `GOLD-PPO-2026`
   - **Plan Name**: e.g. `Gold PPO 2026`
   - **Coverage Type**: Pharmacy / Medical / Dental
   - **Copay** (cents): e.g. `2000` ($20)
   - **Deductible** (cents): e.g. `100000` ($1,000)
   - **OOP Max** (cents): e.g. `500000` ($5,000)
   - **Annual Benefit Max** (cents): e.g. `10000000` ($100,000)
3. Click **Create Plan**

### Step 2: Add Formulary Entries (Insurer Dashboard)

Still on **http://localhost:4004** → click the **Formulary** tab.

The insurer auto-publishes the 22 seed medications on startup. To add more:

1. Enter an **NDC** (11-digit), **Brand Name**, and optional pricing fields
2. Click **Add to Formulary**
3. The formulary is auto-published to the sequencer

Or upload a CSV file with NDC, brand name, and pricing columns.

### Step 3: Publish the Plan (Insurer Dashboard)

Back on the **Plans** tab:

1. Find your plan in the list
2. Click the **Publish** button on that plan's row
3. This creates the formulary root hash and marks the plan as live
4. Published plans are now visible to employers

### Step 4: Set Up the Employer (Employer Dashboard)

Open **http://localhost:4005**.

**Create an enrollment group:**

1. Click the **Groups** tab
2. Click **+ Create Group**
3. Fill in:
   - **Group ID**: e.g. `GRP-ACME-2026`
   - **Plan ID**: The plan ID from Step 1 (e.g. `GOLD-PPO-2026`)
   - **Effective Date**: e.g. `2026-04-01`
   - **Enrollment Cap**: e.g. `100`
4. Click **Create Group**

**Generate enrollment tokens:**

1. Click the **Enrollment** tab
2. Click **+ Generate Token**
3. Fill in:
   - **Group ID**: `GRP-ACME-2026` (from above)
   - **Employee ID**: e.g. `EMP-001`
   - **Family ID**: (optional, for family pooling)
   - **Valid Until**: e.g. `2026-12-31`
4. Click **Generate**
5. **Copy the Token ID** — the member needs this to enroll

Repeat for each employee. Each token is single-use.

### Step 5: Enroll the Member (Member Dashboard)

Open **http://localhost:4001**.

The member walks through a 7-step enrollment ceremony:

1. **Create Device PIN** — Choose a PIN (4+ digits) to encrypt local state. This PIN never leaves the device.

2. **Enrollment Token** — Enter the Token ID from Step 4 (e.g. `TOK-ABC-123`).

3. **Personal Information (Part 1)** — Enter Cardholder ID and First Name. This data stays local — only Poseidon hashes are transmitted.

4. **Personal Information (Part 2)** — Enter Last Name and Date of Birth (CCYYMMDD format, e.g. `19900115`).

5. **Key Generation** — The app generates a secure enrollment key and derives the wallet ID. The enrollment key is a 2FA secret created on the device and **never transmitted**.

6. **Registration** — The app:
   - Registers the wallet on the sequencer (via `l2_registerEntity` RPC)
   - Notifies the insurer (via `/enrollment/process`)
   - The insurer mints the credential

7. **Confirmation** — Wallet ID displayed. The member is now enrolled.

After enrollment, the member sees their dashboard with:
- Drug history (claims)
- Formulary lookup
- Plan accumulator balances
- Provider directory
- Encrypted messaging
- Recovery/backup options

---

## What Happens Under the Hood

```
Employer                        Sequencer (Leviathan)
────────                        ─────────────────────
Generate Token ──────────────→  (token stored in employer's local state)

Member                          Sequencer                     Insurer
──────                          ─────────                     ───────
Accept Token ──────────────→    (validates via employer)
Generate Key (on device) ──→    (never transmitted)
Derive Wallet ID ──────────→    l2_registerEntity ─────────→  /enrollment/process
                                 ├── WAL append                 ├── mint credential
                                 ├── wallet registered           ├── lifecycle → ELIGIBLE
                                 └── gossip to replicas         └── respond OK
```

**Key security properties:**
- Enrollment key generated on device, mixed into wallet derivation, never transmitted
- PHI stays local — only Poseidon hash commitments stored on the network
- Insurer sees only opaque wallet IDs (hashes), holds no secrets
- All state changes are WAL-durable and gossip-replicated

---

## Environment Variables (Optional Customization)

Set these before `npm run start:leviathan` if you want to change defaults:

```bash
# Custom admin token (default: admin123)
export ZKTRIDENT_ADMIN_TOKEN=my-secret-token

# Custom employer ID (default: ACME-001)
export ZKTRIDENT_EMPLOYER_ID=MY-COMPANY

# Auto-unlock member state for testing
export ZKTRIDENT_MEMBER_PIN=1234

# Load full 500 NDC NADAC formulary
export ZKTRIDENT_PRODUCTION_FORMULARY=true

# Custom batch interval (default: 180000ms = 3 min)
export ZKTRIDENT_BATCH_INTERVAL_MS=60000

# Checkpoint directory (default: ./l2-data)
export ZKTRIDENT_CHECKPOINT_DIR=./my-data
```

---

## Stopping the Network

```bash
# Graceful: Ctrl+C in the leviathan terminal (sends SIGINT to all children)

# Force kill all ports:
npm run kill:ports
```

---

## Clean Restart

```bash
npm run clean:state    # Deletes checkpoints + nautilus state
npm run start:leviathan
```

---

## After Enrollment — Next Steps

Once a member is enrolled, you can:

1. **Write a prescription** — Prescriber dashboard (`:4002`) → Write Rx tab
2. **Fill the prescription** — Pharmacy dashboard (`:4003`) → Active Scripts
3. **View claims** — Member dashboard (`:4001`) → Drug History
4. **Audit** — Insurer dashboard (`:4004`) → Audit tab
5. **Monitor** — Leviathan dashboard (`:3030`) → Batches & Receipts
