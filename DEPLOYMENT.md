# zkTrident Network — Production Deployment Guide

Step-by-step instructions for deploying the full zkpCare network: Leviathan sequencer,
ProofDelegateServer, Nautilus entity servers, and Android apps (5 flavors).

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [One-Time Setup](#2-one-time-setup)
3. [Deploy Leviathan Sequencer (Render)](#3-deploy-leviathan-sequencer-render)
4. [Deploy ProofDelegateServer (Render)](#4-deploy-proofdelegateserver-render)
5. [Deploy Nautilus Entity Servers](#5-deploy-nautilus-entity-servers)
6. [Build Android APKs](#6-build-android-apks)
7. [Security Checklist](#7-security-checklist)
8. [Monitoring](#8-monitoring)
9. [Cost Breakdown](#9-cost-breakdown)
10. [Environment Variable Reference](#10-environment-variable-reference)
11. [Troubleshooting](#11-troubleshooting)

---

## 1. Prerequisites

- **Node.js 20+** (glibc required for o1js WASM — use `node:20-slim`, not `node:20-alpine`)
- **Docker** (for building container images)
- **Render.com account** (or any Docker-compatible PaaS)
- **Android Studio Hedgehog+** with JDK 17 (for Android builds)
- **Git** with the repo cloned locally

Verify Node.js:
```bash
node --version   # v20.x or higher
npm --version    # 10.x or higher
```

---

## 2. One-Time Setup

### 2A. Install Dependencies

```bash
cd zpk_care
npm ci
```

### 2B. Generate Production Formulary (500 NDCs)

Fetch real drug data from the FDA NADAC public API and generate a static TypeScript file:

```bash
npx tsx scripts/fetch-nadac.ts
```

This creates `src/seed/nadac-formulary.ts` (~600 lines, 500 unique NDCs). Commit it:

```bash
git add src/seed/nadac-formulary.ts
git commit -m "chore: generate 500 NDC NADAC formulary"
```

The generated file is committed so the Leviathan container doesn't need NADAC API access at runtime.

### 2C. Verify Docker Builds Locally

```bash
# Leviathan sequencer
docker build -t zktrident-leviathan .

# Proof delegate server
docker build -f Dockerfile.prover -t zktrident-prover .
```

Quick smoke test:
```bash
# Leviathan — should start and print banner, then Ctrl+C
docker run --rm -p 3030:3030 zktrident-leviathan

# Prover — compiles ZkPrograms at startup (takes 60-120s), then serves /status
docker run --rm -p 4040:4040 -e NODE_OPTIONS=--max-old-space-size=6000 zktrident-prover
```

Verify health endpoints:
```bash
curl http://localhost:3030/health    # → {"status":"ok",...}
curl http://localhost:4040/status    # → {"available":true,"compiled":true,...}
```

---

## 3. Deploy Leviathan Sequencer (Render)

### 3A. Render Blueprint (Recommended)

The repo includes `render.yaml` — a Render Blueprint that creates both services automatically.

1. Go to **Render Dashboard > New > Blueprint**
2. Connect your Git repo
3. Render detects `render.yaml` and creates:
   - `zktrident-leviathan` (Standard plan, $25/mo)
   - `zktrident-prover` (Pro plan, $85/mo)
4. Review auto-generated env vars (`ZKTRIDENT_ADMIN_TOKEN`, `ZKTRIDENT_GOSSIP_SECRET`, `ZKTRIDENT_PROVER_API_KEY`)
5. Click **Apply**

### 3B. Manual Deployment (Alternative)

If not using the Blueprint:

1. **New Web Service** > Docker > point to repo
2. Settings:
   - **Dockerfile Path:** `./Dockerfile`
   - **Plan:** Standard (2 GB RAM, 1 vCPU — $25/mo)
   - **Region:** Oregon (or closest to your users)
   - **Health Check Path:** `/health`
3. Add a **persistent disk**:
   - **Mount Path:** `/data`
   - **Size:** 10 GB
4. Set env vars (see [Section 10](#10-environment-variable-reference))

### 3C. Verify Leviathan

After deploy (~2-5 min for first build):

```bash
LEVIATHAN_URL=https://zktrident-leviathan.onrender.com

# Health
curl $LEVIATHAN_URL/health

# RPC — get node status
curl -X POST $LEVIATHAN_URL/rpc \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"l2_getStatus","params":{},"id":1}'

# RPC — get chain state
curl -X POST $LEVIATHAN_URL/rpc \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"l2_getChainState","params":{},"id":2}'

# SSE stream (Ctrl+C to stop)
curl -N $LEVIATHAN_URL/events
```

**Note:** First request after a cold start may take 10-30s as Render spins up the container.
Render free-tier services spin down after 15 min of inactivity. Standard plan stays always-on.

---

## 4. Deploy ProofDelegateServer (Render)

If using the Blueprint, this is already created. Otherwise:

1. **New Web Service** > Docker > same repo
2. Settings:
   - **Dockerfile Path:** `./Dockerfile.prover`
   - **Plan:** Pro (4 GB RAM, 2 vCPU — $85/mo)
   - **Health Check Path:** `/status`
3. Env vars:
   - `ZKTRIDENT_PROVER_PORT=4040`
   - `ZKTRIDENT_PROVER_API_KEY=<generate-a-strong-secret>`
   - `NODE_OPTIONS=--max-old-space-size=6000`

### 4A. Verify Prover

The prover compiles `StateTransitionProgram` at startup (~60-120s). Until compilation finishes,
`/status` returns `{"available":false,"compiled":false,...}`.

```bash
PROVER_URL=https://zktrident-prover.onrender.com

# Check readiness
curl $PROVER_URL/status
# Wait for: {"available":true,"compiled":true,"queueDepth":0,"avgProofTimeMs":...}
```

**Important:** The prover only accepts hashed Field values — no PHI/PII is ever sent to it.
This is safe for a shared cloud deployment.

---

## 5. Deploy Nautilus Entity Servers

Nautilus servers are lightweight REST apps for each entity role. They connect to the Leviathan
for queries and to the ProofDelegateServer for proof generation.

### Port Assignments

| Role       | Default Port | Start Script                          |
|------------|-------------|---------------------------------------|
| Member     | 4001        | `npm run start:member`                |
| Pharmacy   | 4002        | `npm run start:pharmacy`              |
| Prescriber | 4003        | `npm run start:prescriber`            |
| Insurer    | 4004        | `npm run start:insurer`               |
| Employer   | 4005        | `npm run start:employer`              |

### 5A. Insurer Nautilus (Cloud — Render Starter, $7/mo)

The insurer is the attestation authority. It should be always-on.

```bash
# Environment
ZKTRIDENT_PORT=4004
ZKTRIDENT_ADMIN_TOKEN=<strong-secret>
ZKTRIDENT_SEQUENCER_URL=https://zktrident-leviathan.onrender.com
```

Deploy as a **Native Environment** web service on Render (Starter plan, $7/mo):
- **Build Command:** `npm ci`
- **Start Command:** `npx tsx src/nodes/start-insurer-nautilus.ts`
- **Health Check Path:** `/health`

### 5B. Pharmacy / Prescriber Nautilus

These run wherever the pharmacy/prescriber operates (on-premises, VPS, or cloud).
They need access to both the Leviathan (reads) and ProofDelegateServer (proof generation).

```bash
# Pharmacy example
ZKTRIDENT_PORT=4002 \
ZKTRIDENT_ADMIN_TOKEN=<secret> \
ZKTRIDENT_SEQUENCER_URL=https://zktrident-leviathan.onrender.com \
ZKTRIDENT_PROVER_URL=https://zktrident-prover.onrender.com \
ZKTRIDENT_PROVER_API_KEY=<prover-api-key> \
npx tsx src/nodes/start-pharmacy-nautilus.ts
```

For production, add TLS:
```bash
ZKTRIDENT_TLS_CERT=/path/to/cert.pem \
ZKTRIDENT_TLS_KEY=/path/to/key.pem \
npx tsx src/nodes/start-pharmacy-nautilus.ts
```

### 5C. Employer Nautilus

The employer manages enrollment tokens and group roster. No wallet, no proofs.

```bash
ZKTRIDENT_PORT=4005 \
ZKTRIDENT_EMPLOYER_ID=ACME-001 \
ZKTRIDENT_ADMIN_TOKEN=<secret> \
ZKTRIDENT_SEQUENCER_URL=https://zktrident-leviathan.onrender.com \
ZKTRIDENT_INSURER_URL=https://insurer-nautilus.example.com \
npx tsx src/nodes/start-employer-nautilus.ts
```

Required env vars: `ZKTRIDENT_EMPLOYER_ID`, `ZKTRIDENT_ADMIN_TOKEN`.

### 5D. Member Nautilus (Optional — Android App Replaces This)

Members typically use the Android app directly (connects to Leviathan RPC + ProofDelegateServer).
The Member Nautilus server is only needed for desktop/web member access:

```bash
ZKTRIDENT_PORT=4001 \
ZKTRIDENT_SEQUENCER_URL=https://zktrident-leviathan.onrender.com \
ZKTRIDENT_PROVER_URL=https://zktrident-prover.onrender.com \
ZKTRIDENT_PROVER_API_KEY=<prover-api-key> \
npx tsx src/nodes/start-member-nautilus.ts
```

---

## 6. Build Android APKs

### 6A. Configure URLs

The default sequencer and prover URLs are set in [android/app/build.gradle.kts](android/app/build.gradle.kts):

```kotlin
buildConfigField("String", "DEFAULT_SEQUENCER_URL", "\"https://zktrident-leviathan.onrender.com\"")
buildConfigField("String", "DEFAULT_PROVER_URL", "\"https://zktrident-prover.onrender.com\"")
```

If your Render service names differ, update these before building.

### 6B. Generate Gradle Wrapper (One-Time)

If the `gradle-wrapper.jar` is missing (not committed as binary), generate it:

```bash
cd android
gradle wrapper --gradle-version 8.5
```

This requires a system-level Gradle installation. Alternatively, open the project in Android Studio — it generates the wrapper automatically.

### 6C. Build All Flavors

```bash
cd android

# Debug builds (all 5 flavors)
./gradlew assembleMemberDebug
./gradlew assemblePharmacyDebug
./gradlew assemblePrescriberDebug
./gradlew assembleInsurerDebug
./gradlew assembleEmployerDebug

# Or build all at once
./gradlew assembleDebug
```

APKs are output to:
```
android/app/build/outputs/apk/<flavor>/debug/app-<flavor>-debug.apk
```

### 6D. Release Builds

1. Create a keystore (one-time):
   ```bash
   keytool -genkey -v -keystore zktrident-release.jks \
     -alias zktrident -keyalg RSA -keysize 2048 -validity 10000
   ```

2. Add to `android/local.properties` (DO NOT commit):
   ```properties
   RELEASE_STORE_FILE=../zktrident-release.jks
   RELEASE_STORE_PASSWORD=<your-password>
   RELEASE_KEY_ALIAS=zktrident
   RELEASE_KEY_PASSWORD=<your-password>
   ```

3. Add signing config to `build.gradle.kts` (release block):
   ```kotlin
   signingConfigs {
       create("release") {
           storeFile = file(localProperties["RELEASE_STORE_FILE"] as String)
           storePassword = localProperties["RELEASE_STORE_PASSWORD"] as String
           keyAlias = localProperties["RELEASE_KEY_ALIAS"] as String
           keyPassword = localProperties["RELEASE_KEY_PASSWORD"] as String
       }
   }
   ```

4. Build:
   ```bash
   ./gradlew assembleMemberRelease
   ./gradlew assemblePharmacyRelease
   # ... etc
   ```

### 6E. Application IDs

| Flavor     | Application ID              |
|------------|-----------------------------|
| Member     | `care.zktrident.member`     |
| Pharmacy   | `care.zktrident.pharmacy`   |
| Prescriber | `care.zktrident.prescriber` |
| Insurer    | `care.zktrident.insurer`    |
| Employer   | `care.zktrident.employer`   |

Each flavor is a separate app on the device with its own icon and name.

---

## 7. Security Checklist

### Authentication

- [ ] `ZKTRIDENT_ADMIN_TOKEN` set on Leviathan (gates admin RPC methods)
- [ ] `ZKTRIDENT_ADMIN_TOKEN` set on each Nautilus server (gates admin endpoints)
- [ ] `ZKTRIDENT_PROVER_API_KEY` set on ProofDelegateServer (gates proof requests)
- [ ] `ZKTRIDENT_PROVER_API_KEY` distributed only to authorized Nautilus servers and Android app configs
- [ ] `ZKTRIDENT_GOSSIP_SECRET` set on all Leviathan nodes in a multi-node deployment

### TLS

- [ ] Render provides HTTPS automatically on `*.onrender.com` domains
- [ ] Self-hosted Nautilus servers: set `ZKTRIDENT_TLS_CERT` and `ZKTRIDENT_TLS_KEY`
- [ ] Android apps enforce HTTPS in production (cleartext blocked by default on API 28+)

### CORS

- [ ] `ZKTRIDENT_CORS_ORIGINS` restricted to known domains in production (default `*` is for dev only)

### Data at Rest

- [ ] Leviathan persistent disk contains checkpoint + WAL files — encrypted at rest by Render
- [ ] Nautilus encrypted local state uses AES-256-GCM with scrypt key derivation
- [ ] Android Keystore hardware-backed key wrapping for enrollment key

### PHI/PII

- [ ] No PHI/PII ever transmitted to Leviathan — only Poseidon hash commitments
- [ ] ProofDelegateServer receives only hashed Field values — cannot reverse Poseidon
- [ ] Member PHI collected only on-device, hashed immediately, wiped from memory
- [ ] `LocalStateData.toString()` redacts walletId (shows first 8 chars only)

### Container Security

- [ ] Both Dockerfiles run as non-root user (`zktrident`)
- [ ] `npm ci --ignore-scripts` prevents post-install script attacks
- [ ] No secrets baked into images — all via env vars

---

## 8. Monitoring

### Health Endpoints

| Service    | Endpoint  | Expected Response |
|------------|-----------|-------------------|
| Leviathan  | `/health` | `{"status":"ok","nodeId":"...","uptime":...}` |
| Prover     | `/status` | `{"available":true,"compiled":true,"queueDepth":0,...}` |
| Nautilus   | `/health` | `{"status":"ok","role":"...","phase":"ready"}` |

### Render Alerts

Configure in Render Dashboard > Service > Settings > Health & Alerts:
- **Health check failure** — restarts service automatically
- **Deploy failure** — notifies via email/Slack
- **Memory usage** — alert at 80% of plan limit

### SSE Dashboard

Connect to the Leviathan SSE stream for real-time events:

```bash
curl -N https://zktrident-leviathan.onrender.com/events
```

Events include: `proof:accepted`, `batch:built`, `batch:settled`, `peer:announce`.

### Key RPC Queries for Monitoring

```bash
BASE=https://zktrident-leviathan.onrender.com/rpc

# Node status (uptime, pending proofs, batch count)
curl -X POST $BASE -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"l2_getStatus","params":{},"id":1}'

# Chain state (registry root, block height, latest batch)
curl -X POST $BASE -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"l2_getChainState","params":{},"id":2}'

# Leviathan status (partitions, leaders — multi-node only)
curl -X POST $BASE -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"l2_getLeviathanStatus","params":{},"id":3}'

# Quorum status (WAL entries, certificates — multi-node only)
curl -X POST $BASE -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"l2_getQuorumStatus","params":{},"id":4}'
```

---

## 9. Cost Breakdown

### Render.com (Monthly)

| Service              | Plan     | RAM  | Cost     |
|---------------------|----------|------|----------|
| Leviathan Sequencer | Standard | 2 GB | $25/mo   |
| ProofDelegateServer | Pro      | 4 GB | $85/mo   |
| Persistent Disk     | 10 GB   | —    | $2.50/mo |
| Insurer Nautilus    | Starter  | 512 MB | $7/mo  |
| **Total base**      |          |      | **$119.50/mo** |

### Optional Add-Ons

| Service                  | Plan     | Cost    |
|--------------------------|----------|---------|
| Pharmacy Nautilus (cloud)| Standard | $25/mo  |
| Prescriber Nautilus      | Standard | $25/mo  |
| Custom domain SSL        | Free     | $0      |
| Additional Leviathan replicas | Standard each | $25/mo each |

### Self-Hosted Alternative

For maximum cost savings, Nautilus entity servers can run on any VPS:
- **DigitalOcean/Hetzner** droplet: $5-10/mo for pharmacy/prescriber/employer
- Only Leviathan + Prover need significant RAM for o1js WASM compilation

---

## 10. Environment Variable Reference

### Leviathan Sequencer (`start-leviathan.ts`)

| Variable | Default | Description |
|----------|---------|-------------|
| `ZKTRIDENT_PORT` | `3030` | RPC server port |
| `ZKTRIDENT_HOST` | `0.0.0.0` | Bind address |
| `ZKTRIDENT_NODE_ID` | auto-generated | Unique node identifier |
| `ZKTRIDENT_BATCH_INTERVAL_MS` | `180000` | Batch timer (ms). Render default: 300000 (5 min) |
| `ZKTRIDENT_PARTITION_COUNT` | `1` | Total partitions (multi-leader) |
| `ZKTRIDENT_PARTITION_INDEX` | `0` | This node's partition |
| `ZKTRIDENT_SEED_PEERS` | none | Comma-separated peer URLs |
| `ZKTRIDENT_ADMIN_TOKEN` | none | Bearer token for admin RPC |
| `ZKTRIDENT_GOSSIP_SECRET` | none | HMAC-SHA256 gossip auth |
| `ZKTRIDENT_CHECKPOINT_DIR` | `./l2-data` | Checkpoint + WAL directory |
| `ZKTRIDENT_MAX_CHECKPOINTS` | `10` | Checkpoint retention count |
| `ZKTRIDENT_L2_ONLY` | `true` | Skip MINA L1 settlement |
| `ZKTRIDENT_SSE` | `true` | Enable SSE streaming |
| `ZKTRIDENT_MAX_SSE` | `100` | Max SSE connections |
| `ZKTRIDENT_CORS_ORIGINS` | `*` | Comma-separated CORS origins |
| `ZKTRIDENT_POOL_SIZE` | `0` | Proving pool workers (`auto` to detect from RAM) |
| `ZKTRIDENT_POOL_RECYCLE` | `3` | Recycle worker every N jobs |
| `ZKTRIDENT_PRODUCTION_FORMULARY` | `false` | Load 500 NDC NADAC formulary |
| `NODE_OPTIONS` | — | Set `--max-old-space-size=1800` for 2GB plan |

### ProofDelegateServer (`start-prover.ts`)

| Variable | Default | Description |
|----------|---------|-------------|
| `ZKTRIDENT_PROVER_PORT` | `4040` | HTTP port |
| `ZKTRIDENT_PROVER_API_KEY` | none | API key for proof requests |
| `NODE_OPTIONS` | — | Set `--max-old-space-size=6000` for 4GB plan |

### Nautilus Entity Servers (All Roles)

| Variable | Default | Description |
|----------|---------|-------------|
| `ZKTRIDENT_PORT` | varies | Server port (4001-4005) |
| `ZKTRIDENT_HOST` | `0.0.0.0` | Bind address |
| `ZKTRIDENT_SEQUENCER_URL` | `http://localhost:3030` | Leviathan URL |
| `ZKTRIDENT_STATE_DIR` | `./nautilus-data` | Encrypted state directory |
| `ZKTRIDENT_TLS_CERT` | none | PEM certificate path |
| `ZKTRIDENT_TLS_KEY` | none | PEM private key path |
| `ZKTRIDENT_SSE` | `true` | SSE streaming |
| `ZKTRIDENT_MAX_SSE` | `50` | Max SSE connections |
| `ZKTRIDENT_CORS_ORIGINS` | `*` | CORS origins |
| `ZKTRIDENT_DISPLAY_NAME` | none | Logging display name |
| `ZKTRIDENT_ADMIN_TOKEN` | none | Admin endpoint auth |

### Role-Specific Variables

| Variable | Roles | Description |
|----------|-------|-------------|
| `ZKTRIDENT_PROVER_URL` | member, pharmacy, prescriber | ProofDelegateServer URL |
| `ZKTRIDENT_PROVER_API_KEY` | member, pharmacy, prescriber | Prover API key |
| `ZKTRIDENT_PIN` | member, pharmacy, prescriber | PIN for encrypted state (CI only) |
| `ZKTRIDENT_EMPLOYER_ID` | employer | **Required.** Employer identifier |
| `ZKTRIDENT_INSURER_URL` | employer | Insurer Nautilus URL for token submission |

---

## 11. Troubleshooting

### OOM (Out of Memory) Crashes

**Symptom:** Service restarts repeatedly, logs show `FATAL ERROR: CALL_AND_RETRY_LAST Allocation failed`.

**Fix:** Increase `NODE_OPTIONS=--max-old-space-size=<MB>`:
- Leviathan (2GB plan): `--max-old-space-size=1800`
- Prover (4GB plan): `--max-old-space-size=6000`
- If still crashing, upgrade to next plan tier

**Root cause:** o1js WASM compilation allocates ~60MB per ZkProgram. The ProvingPool worker
recycling (`ZKTRIDENT_POOL_RECYCLE=3`) mitigates heap growth for batch proving.

### Poseidon Hash Mismatch

**Symptom:** Android wallet derivation produces different walletId than TypeScript.

**Verify:** Run the Kotlin JUnit test:
```bash
cd android
./gradlew :shared:testDebugUnitTest --tests "*.PoseidonHasherTest"
```

**Common causes:**
- Wrong field modulus (must be Pallas: `28948022309329048855892746252171976963363056481941560715954676764349967630337`)
- Wrong S-box order (must be S-box -> MDS -> ARK, NOT ARK -> S-box -> MDS)
- Wrong round count (Kimchi variant: 55 full rounds, 0 partial)
- `stringToFields` packs 31 bytes per field, big-endian

### Checkpoint Recovery Failure

**Symptom:** Leviathan fails to start with checkpoint errors.

**Fix:**
1. Check `/data/l2-data/` for checkpoint files
2. If corrupted, delete the bad checkpoint:
   ```bash
   # List checkpoints (newest first)
   ls -lt /data/l2-data/checkpoint-*.json
   # Delete the latest (corrupted) one
   rm /data/l2-data/checkpoint-<timestamp>.json
   ```
3. The node will recover from the next-oldest checkpoint, or start fresh if none remain
4. WAL replay fills the gap between checkpoint and crash point

### Render Cold Start Delays

**Symptom:** First request after idle takes 10-30s.

**Explanation:** Render Standard plan stays always-on. If you're on Render free tier (for testing),
services spin down after 15 min of inactivity. The first request triggers a cold start.

**Mitigation:** Use Standard plan ($25/mo) or set up an external health check ping every 10 min.

### Android Build Failures

**Common issues:**

1. **JDK version:** Requires JDK 17. Check with `java -version`.
2. **Gradle wrapper:** Ensure `android/gradle/wrapper/gradle-wrapper.properties` points to Gradle 8.5+.
3. **Missing SDK:** Install Android SDK 34 via Android Studio SDK Manager.
4. **KMP shared module:** The `shared` module must compile before `app`. Run `./gradlew :shared:build` first.

### Prover Not Ready

**Symptom:** `POST /prove` returns 503 Service Unavailable.

**Explanation:** The prover compiles `StateTransitionProgram` at startup (60-120s).
During this time, `/status` returns `{"available":false,"compiled":false}`.

**Fix:** Wait for compilation to finish. The health check at `/status` will show
`{"available":true,"compiled":true}` when ready.

### BigInt Serialization Errors

**Symptom:** Android app shows JSON parsing errors when reading RPC responses.

**Explanation:** The Leviathan serializes BigInt values as `"__bigint__:12345"` prefixed strings
(NOT `{"__bigint__":"12345"}` JSON objects). The shared Kotlin `BigIntJson` module handles this.

**Verify:** Check that `LeviathanRpcClient` uses the correct `BigIntJson.unwrapAll()` for
response parsing.

### Multi-Node Gossip Issues

**Symptom:** Replicas not receiving state updates.

**Checklist:**
1. Both nodes have the same `ZKTRIDENT_GOSSIP_SECRET`
2. Sequencer has replica in `ZKTRIDENT_SEED_PEERS`
3. Firewall allows bidirectional HTTP between nodes
4. Check `l2_getPeerInfo` RPC on both nodes

---

## Quick Start (Minimal Production)

For the fastest path to a running network:

```bash
# 1. Generate formulary
npx tsx scripts/fetch-nadac.ts
git add src/seed/nadac-formulary.ts && git commit -m "formulary"

# 2. Push to repo connected to Render
git push origin main

# 3. Render auto-deploys from render.yaml:
#    - zktrident-leviathan (Standard, $25/mo)
#    - zktrident-prover (Pro, $85/mo)

# 4. Wait ~5 min for deploy + prover compilation

# 5. Verify
curl https://zktrident-leviathan.onrender.com/health
curl https://zktrident-prover.onrender.com/status

# 6. Build Android member app
cd android && ./gradlew assembleMemberDebug
adb install app/build/outputs/apk/member/debug/app-member-debug.apk
```

Total time: ~15 minutes. Total cost: ~$112.50/mo (Leviathan + Prover + disk).
