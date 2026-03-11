# zkpCare Network — Deployment Guide

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                        LEVIATHAN NODE                               │
│  Sequencer + Prover + Block Explorer Dashboard                      │
│  Port 3030 (RPC + SSE + Dashboard)                                  │
│  Port 4040 (ProofDelegateServer)                                    │
│  Heaviest node: ~4-5GB RAM peak during proof gen                    │
└──────────────────────────┬──────────────────────────────────────────┘
                           │ HTTPS (Cloudflare Tunnel)
          ┌────────────────┼────────────────┐
          │                │                │
    ┌─────▼─────┐   ┌─────▼─────┐   ┌──────▼──────┐
    │  INSURER   │   │ PRESCRIBER│   │  PHARMACY   │
    │  Port 4004 │   │ Port 4002 │   │  Port 4003  │
    │  + EMPLOYER │   │ Dashboard │   │  Dashboard  │
    │  Port 4005 │   │           │   │             │
    │  Dashboard │   └─────▲─────┘   └──────▲──────┘
    └─────▲─────┘         │                │
          │               │                │
          │         ┌─────┴────────────────┘
          │         │
    ┌─────┴─────────▼─────┐
    │   MEMBER (Phone)     │
    │   Android App        │
    │   No server needed   │
    └──────────────────────┘
```

All communication is HTTPS JSON-RPC / REST. No direct node-to-node trust required.
Entity nodes talk to Leviathan only. Phone talks to Leviathan + Prover + Insurer.

---

## Scenario A: All Local (Your Desktop — Debug/Dev)

Run everything on your Windows desktop. Phone connects via local WiFi.

### Prerequisites
- Node.js 20+
- Phone on same WiFi network as desktop

### Step 1: Find your desktop's local IP
```bash
# Windows
ipconfig | findstr IPv4
# Example: 192.168.1.100
```

### Step 2: Start all services (6 terminal windows)

**Terminal 1 — Leviathan (port 3030)**
```bash
cd z:/zpk_care
NODE_OPTIONS="--max-old-space-size=4096" \
  ZKTRIDENT_POOL_SIZE=1 \
  ZKTRIDENT_POOL_RECYCLE=3 \
  ZKTRIDENT_ADMIN_TOKEN=dev-admin \
  npx tsx src/nodes/start-leviathan.ts
```
Dashboard: http://localhost:3030/

**Terminal 2 — Prover (port 4040)**
```bash
cd z:/zpk_care
NODE_OPTIONS="--max-old-space-size=4096" \
  ZKTRIDENT_PROVER_API_KEY=dev-key \
  npx tsx src/nodes/start-prover.ts
```
Status: http://localhost:4040/status

**Terminal 3 — Insurer (port 4004)**
```bash
cd z:/zpk_care
ZKTRIDENT_PORT=4004 \
  ZKTRIDENT_ADMIN_TOKEN=dev-admin \
  ZKTRIDENT_SEQUENCER_URL=http://localhost:3030 \
  ZKTRIDENT_INSURER_ID=BlueCross-Demo \
  npx tsx src/nodes/start-insurer-nautilus.ts
```

**Terminal 4 — Employer (port 4005)**
```bash
cd z:/zpk_care
ZKTRIDENT_PORT=4005 \
  ZKTRIDENT_ADMIN_TOKEN=dev-admin \
  ZKTRIDENT_SEQUENCER_URL=http://localhost:3030 \
  ZKTRIDENT_INSURER_URL=http://localhost:4004 \
  ZKTRIDENT_EMPLOYER_ID=ACME-Corp \
  npx tsx src/nodes/start-employer-nautilus.ts
```
Dashboard: http://localhost:4005/

**Terminal 5 — Prescriber (port 4002)**
```bash
cd z:/zpk_care
ZKTRIDENT_PORT=4002 \
  ZKTRIDENT_ADMIN_TOKEN=dev-admin \
  ZKTRIDENT_SEQUENCER_URL=http://localhost:3030 \
  ZKTRIDENT_PROVER_URL=http://localhost:4040 \
  npx tsx src/nodes/start-prescriber-nautilus.ts
```
Dashboard: http://localhost:4002/

**Terminal 6 — Pharmacy (port 4003)**
```bash
cd z:/zpk_care
ZKTRIDENT_PORT=4003 \
  ZKTRIDENT_ADMIN_TOKEN=dev-admin \
  ZKTRIDENT_SEQUENCER_URL=http://localhost:3030 \
  ZKTRIDENT_PROVER_URL=http://localhost:4040 \
  npx tsx src/nodes/start-pharmacy-nautilus.ts
```
Dashboard: http://localhost:4003/

### Step 3: Update Android app for local URLs

Edit `android/app/build.gradle.kts` — replace the BuildConfig URLs:
```kotlin
buildConfigField("String", "DEFAULT_SEQUENCER_URL", "\"http://192.168.1.100:3030\"")
buildConfigField("String", "DEFAULT_PROVER_URL", "\"http://192.168.1.100:4040\"")
buildConfigField("String", "DEFAULT_INSURER_URL", "\"http://192.168.1.100:4004\"")
buildConfigField("String", "DEFAULT_PROVER_API_KEY", "\"dev-key\"")
```

Rebuild and install:
```bash
cd z:/zpk_care/android
"z:/Android Studio/jbr/bin/java.exe" -cp "gradle/wrapper/gradle-wrapper.jar" \
  org.gradle.wrapper.GradleWrapperMain :app:assembleMemberDebug

# Install on phone
adb install -r app/build/outputs/apk/member/debug/app-member-debug.apk
```

### Step 4: Generate enrollment token
```bash
# Create group
curl -X POST http://localhost:4005/groups \
  -H "Authorization: Bearer dev-admin" \
  -H "Content-Type: application/json" \
  -d '{"groupId":"ACME-GROUP-1","planId":"GOLD-100","effectiveDate":"20260101"}'

# Generate token
curl -X POST http://localhost:4005/tokens/generate \
  -H "Authorization: Bearer dev-admin" \
  -H "Content-Type: application/json" \
  -d '{"groupId":"ACME-GROUP-1","employeeId":"EMP-001","familyId":"FAM-001","validUntil":"20261231"}'
```

### Step 5: Enroll on phone
Enter the token ID from Step 4 into the app and complete enrollment.

### Browser Dashboards (all open simultaneously)
- http://localhost:3030/ — Leviathan block explorer (wallets, batches, proofs)
- http://localhost:4005/ — Employer (tokens, groups, roster)
- http://localhost:4002/ — Prescriber (prescribing history, messaging)
- http://localhost:4003/ — Pharmacy (dispensing, DUR, messaging)

---

## Scenario B: Multi-Device (Investor Demo)

### Device Assignment

| Device | Runs | Ports |
|--------|------|-------|
| MacBook 1 | Leviathan + Prover | 3030, 4040 |
| MacBook 2 | Prescriber + Pharmacy | 4002, 4003 |
| Desktop PC | Insurer + Employer | 4004, 4005 |
| Phone | Member (Android app) | — |

### Prerequisites (all machines)
- Node.js 20+ (`brew install node` on Mac)
- Git clone of the repo + `npm install`
- Cloudflare Tunnel (`brew install cloudflared` on Mac, download on Windows)
  - Free tier, no account needed for quick tunnels
  - Or use ngrok if preferred

### Step 1: Set up Cloudflare Tunnels

Each machine exposes its services via tunnel. Run alongside the Node processes.

**MacBook 1 (Leviathan):**
```bash
# Terminal A: Leviathan
NODE_OPTIONS="--max-old-space-size=4096" \
  ZKTRIDENT_POOL_SIZE=1 \
  ZKTRIDENT_POOL_RECYCLE=3 \
  ZKTRIDENT_ADMIN_TOKEN=prod-admin-secret \
  npx tsx src/nodes/start-leviathan.ts

# Terminal B: Prover
NODE_OPTIONS="--max-old-space-size=4096" \
  ZKTRIDENT_PROVER_API_KEY=your-secret-key \
  npx tsx src/nodes/start-prover.ts

# Terminal C: Tunnel for Leviathan
cloudflared tunnel --url http://localhost:3030
# → Gives you: https://xxxxx-leviathan.trycloudflare.com

# Terminal D: Tunnel for Prover
cloudflared tunnel --url http://localhost:4040
# → Gives you: https://xxxxx-prover.trycloudflare.com
```

**MacBook 2 (Prescriber + Pharmacy):**
```bash
# Set SEQUENCER_URL to MacBook 1's tunnel URL
export LEVIATHAN_URL=https://xxxxx-leviathan.trycloudflare.com
export PROVER_URL=https://xxxxx-prover.trycloudflare.com

# Terminal A: Prescriber
ZKTRIDENT_PORT=4002 \
  ZKTRIDENT_ADMIN_TOKEN=prod-admin-secret \
  ZKTRIDENT_SEQUENCER_URL=$LEVIATHAN_URL \
  ZKTRIDENT_PROVER_URL=$PROVER_URL \
  npx tsx src/nodes/start-prescriber-nautilus.ts

# Terminal B: Pharmacy
ZKTRIDENT_PORT=4003 \
  ZKTRIDENT_ADMIN_TOKEN=prod-admin-secret \
  ZKTRIDENT_SEQUENCER_URL=$LEVIATHAN_URL \
  ZKTRIDENT_PROVER_URL=$PROVER_URL \
  npx tsx src/nodes/start-pharmacy-nautilus.ts

# Terminal C: Tunnel for Prescriber
cloudflared tunnel --url http://localhost:4002

# Terminal D: Tunnel for Pharmacy
cloudflared tunnel --url http://localhost:4003
```

**Desktop PC (Insurer + Employer):**
```bash
export LEVIATHAN_URL=https://xxxxx-leviathan.trycloudflare.com

# Terminal A: Insurer
ZKTRIDENT_PORT=4004 \
  ZKTRIDENT_ADMIN_TOKEN=prod-admin-secret \
  ZKTRIDENT_SEQUENCER_URL=$LEVIATHAN_URL \
  ZKTRIDENT_INSURER_ID=BlueCross-Demo \
  npx tsx src/nodes/start-insurer-nautilus.ts

# Terminal B: Employer
ZKTRIDENT_PORT=4005 \
  ZKTRIDENT_ADMIN_TOKEN=prod-admin-secret \
  ZKTRIDENT_SEQUENCER_URL=$LEVIATHAN_URL \
  ZKTRIDENT_INSURER_URL=http://localhost:4004 \
  ZKTRIDENT_EMPLOYER_ID=ACME-Corp \
  npx tsx src/nodes/start-employer-nautilus.ts

# Terminal C: Tunnel (optional — only needed if phone talks to insurer directly)
cloudflared tunnel --url http://localhost:4004
```

### Step 2: Update Android app URLs

Edit `android/app/build.gradle.kts` with the tunnel URLs:
```kotlin
buildConfigField("String", "DEFAULT_SEQUENCER_URL", "\"https://xxxxx-leviathan.trycloudflare.com\"")
buildConfigField("String", "DEFAULT_PROVER_URL", "\"https://xxxxx-prover.trycloudflare.com\"")
buildConfigField("String", "DEFAULT_INSURER_URL", "\"https://xxxxx-insurer.trycloudflare.com\"")
buildConfigField("String", "DEFAULT_PROVER_API_KEY", "\"your-secret-key\"")
```

Rebuild and install APK on phone.

### Step 3: Demo flow

1. **Employer dashboard** (Desktop browser, :4005) — Create group, generate enrollment token
2. **Phone app** — Enter token, fill PHI, generate wallet, complete enrollment
3. **Leviathan dashboard** (MacBook 1 browser, :3030) — Watch wallet count increment
4. **Prescriber dashboard** (MacBook 2 browser, :4002) — Onboard prescriber, write Rx
5. **Pharmacy dashboard** (MacBook 2 browser, :4003) — Onboard pharmacy, fill Rx, submit proof
6. **Leviathan dashboard** — Watch proof accepted, batch built, chain updated
7. **Phone app** — Check drug history, plan spend, accumulators updated

### Firewalla Visibility
With all traffic going through Cloudflare Tunnels:
- Each device has a distinct tunnel connection visible in Firewalla
- All traffic is HTTPS — encrypted, no PHI visible in packets
- Firewalla shows bandwidth per device, connection timing, DNS queries

---

## Environment Variables Reference

| Variable | Default | Description |
|----------|---------|-------------|
| `ZKTRIDENT_PORT` | varies | Server listen port |
| `ZKTRIDENT_HOST` | 0.0.0.0 | Bind address |
| `ZKTRIDENT_SEQUENCER_URL` | http://localhost:3030 | Leviathan RPC URL |
| `ZKTRIDENT_ADMIN_TOKEN` | (none) | Bearer token for admin endpoints |
| `ZKTRIDENT_PROVER_URL` | (none) | ProofDelegateServer URL |
| `ZKTRIDENT_PROVER_API_KEY` | (none) | API key for prover auth |
| `ZKTRIDENT_INSURER_URL` | (none) | Insurer Nautilus URL |
| `ZKTRIDENT_INSURER_ID` | (none) | Insurer identifier |
| `ZKTRIDENT_EMPLOYER_ID` | (none) | Employer identifier |
| `ZKTRIDENT_POOL_SIZE` | 0 | Proving pool workers (0=disabled) |
| `ZKTRIDENT_POOL_RECYCLE` | 3 | Recycle worker after N jobs |
| `ZKTRIDENT_STATE_DIR` | ./nautilus-data | Local state directory |
| `ZKTRIDENT_TLS_CERT` | (none) | PEM certificate path |
| `ZKTRIDENT_TLS_KEY` | (none) | PEM private key path |
| `ZKTRIDENT_SSE` | true | Enable SSE streaming |
| `ZKTRIDENT_CORS_ORIGINS` | * | Comma-separated CORS origins |
| `NODE_OPTIONS` | (none) | Set --max-old-space-size=4096 for leviathan/prover |

## Default Ports

| Service | Port |
|---------|------|
| Leviathan | 3030 |
| Member Nautilus | 4001 |
| Prescriber Nautilus | 4002 |
| Pharmacy Nautilus | 4003 |
| Insurer Nautilus | 4004 |
| Employer Nautilus | 4005 |
| ProofDelegateServer | 4040 |

## Memory Requirements

| Process | Idle | Peak | Notes |
|---------|------|------|-------|
| Leviathan (main) | ~200MB | ~500MB | State, RPC, SSE, no proving |
| Leviathan (worker) | ~500MB | ~2.5GB | BatchProgram + ChainProgram compile + prove |
| ProofDelegateServer | ~500MB | ~3GB | StateTransitionProgram compile + prove |
| Entity Nautilus | ~100MB | ~200MB | REST server, no ZK compilation |
| **Total (1 machine)** | **~1.5GB** | **~7GB** | All services, peak during first compilation |

Minimum RAM: 8GB (tight). Recommended: 16GB (comfortable).
