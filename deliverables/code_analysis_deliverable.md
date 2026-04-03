# Code Analysis Deliverable — zkTrident Care

**Application:** zkTrident Care (zkpCare) — Decentralized Healthcare Claim Adjudication System
**Date:** 2026-04-03
**Analyst Role:** Pre-Recon Code Intelligence Gatherer
**Classification:** Security Assessment — Penetration Test Pre-Engagement Intelligence

---

# Penetration Test Scope & Boundaries

**Primary Directive:** This analysis is strictly limited to the **network-accessible attack surface** of the zkTrident Care application. All findings and entry points have been verified against the deployed service architecture.

### In-Scope: Network-Reachable Components
- **Leviathan Sequencer** (L2 RPC Server) — Port 3030, JSON-RPC 2.0 + REST + SSE
- **Entity Nautilus Nodes** — Member (4001), Prescriber (4002), Pharmacy (4003), Insurer (4004), Employer (4005)
- **Explorer** — Port 8000, static dashboard + proxy to sequencer
- **Interactive Adjudication Engine** — Routes dynamically registered on the Leviathan server (`/interactive/*`, `/node/*`, `/viz/*`)
- **Dashboard Web UIs** — Served as static files from Leviathan and Nautilus nodes
- **Android Mobile App** — Network client connecting to entity nodes and sequencer

### Out-of-Scope: Locally Executable Only
- **CLI seed scripts** (`src/seed/run-l2-node.ts`, `src/seed/run-full-cycle.ts`) — Require `npx tsx` execution
- **Data import scripts** (`scripts/fetch-nadac.ts`, `src/data/import-nppes.ts`, `src/data/import-nadac.ts`) — CLI-only CMS data fetchers
- **Bootstrap script** (`scripts/bootstrap-system.ts`) — CLI orchestrator for local dev
- **Patent/legal documents** — Non-code assets (USPTO filings, presentations)
- **Build/test tooling** — Jest tests, TypeScript compilation, CI/CD

---

## 1. Executive Summary

zkTrident Care is a **privacy-first decentralized healthcare claim adjudication system** built on Zero Knowledge Proofs (ZKP) using the MINA Protocol's o1js library. The application processes Protected Health Information (PHI) and Personally Identifiable Information (PII) for pharmacy benefit claims while maintaining patient privacy through cryptographic separation — raw PHI never leaves the member's device; only Poseidon hashes and ZK proofs are transmitted on-chain. The architecture spans a custom Layer 2 blockchain sequencer (Leviathan), role-based entity nodes (Nautilus framework for members, prescribers, pharmacies, insurers, employers), an interactive adjudication engine, and multiple web dashboards.

From a security posture perspective, the application demonstrates **mature cryptographic design** with AES-256-GCM encryption at rest, scrypt-based key derivation, X25519 ECDH message encryption, Ed25519 digital signatures, and comprehensive PHI memory scrubbing. However, **operational security defaults are critically weak**: the production deployment blueprint (render.yaml) ships with wildcard CORS (`*`), hardcoded admin token fallbacks (`admin123`), optional gossip authentication, no TLS on the core sequencer, and all services bound to `0.0.0.0`. These configuration weaknesses create significant attack surface despite the strong cryptographic foundations.

The most critical attack vectors for an external penetration test are: (1) **Server-Side Request Forgery** via user-controlled `insurerUrl` in enrollment routes on all entity nodes, which forwards the admin token in the Authorization header to attacker-controlled servers; (2) **Stored XSS** in the legacy dashboard (`dashboard/app.js`) which has zero HTML escaping and renders all sequencer API data via raw innerHTML; (3) **Unauthenticated admin access** when no admin token is configured (the RPC server returns `true` for all admin auth checks); and (4) **Peer network poisoning** via unauthenticated gossip relay that accepts arbitrary peer URLs for server-side connections. The 150+ HTTP endpoints and 75+ JSON-RPC methods across 7 network services present a substantial attack surface requiring systematic testing.

---

## 2. Architecture & Technology Stack

### Framework & Language

The entire backend is built in **TypeScript 5.9.3** running on **Node.js 20 LTS** with the `tsx` runtime (v4.19.0) for direct TypeScript execution without a compilation step. The ZKP layer uses **o1js 2.13.0** (MINA Protocol's ZK library) which provides Poseidon hashing, Field arithmetic, ZkProgram compilation, and recursive proof composition. The build system uses the TypeScript compiler directly with strict mode enabled (`strict: true` in tsconfig.json), enforcing null/undefined checks and no implicit `any` types. There are no web application frameworks like Express or Fastify — all HTTP servers are built on Node.js's raw `http.createServer` and `https.createServer` APIs, meaning there is no middleware ecosystem (helmet, express-rate-limit, etc.) and all security controls are hand-rolled.

From a security perspective, the raw HTTP server approach means every security control (CORS, rate limiting, body parsing, path validation, authentication) is custom-implemented. This creates risk of inconsistency — for example, the L2 RPC server uses `timingSafeEqual` for admin token comparison while the Nautilus app server uses simple string equality. The lack of a framework also means no built-in CSRF protection, no automatic security headers, and no standardized input validation middleware. The `experimentalDecorators: true` flag in tsconfig.json and `sourceMap: true` are noteworthy — source maps in production could aid attackers in understanding minified code.

### Architectural Pattern

The system follows a **hybrid decentralized microservices architecture** with a custom L2 blockchain at its core. The Leviathan Sequencer acts as the central coordinator — it receives ZK proofs from entity nodes, batches them into blocks, settles on the MINA L1 chain (optional), and serves as the SSE event hub. Entity nodes (Nautilus framework) run independently per role, maintaining encrypted local state and communicating with the sequencer via JSON-RPC 2.0 over HTTP. The peer network uses a gossip protocol for batch/proof propagation and peer discovery. A worker-based proving pool spawns child processes for ZK program compilation (8-12 GB RAM per worker). Trust boundaries exist between: (a) entity nodes and the sequencer, (b) the sequencer and the proof delegate, (c) peers in the gossip network, and (d) the web dashboards and the RPC API.

### Critical Security Components

| Component | Technology | File |
|-----------|-----------|------|
| L2 Sequencer RPC | Raw Node.js HTTP, JSON-RPC 2.0 | `src/l2/l2-rpc-server.ts` |
| Entity Node Framework | Raw Node.js HTTP/HTTPS | `src/nodes/nautilus-app-server.ts` |
| ZKP Engine | o1js 2.13.0, Poseidon hashing | `src/wallets/proof-gate.ts`, `src/engine/state-transition.ts` |
| Encryption at Rest | AES-256-GCM + scrypt | `src/nodes/nautilus-local-state.ts` |
| Message Encryption | X25519 ECDH + AES-256-GCM + HKDF | `src/messaging/encryption.ts` |
| NFC Attestation | Ed25519 signatures | `src/credentials/nfc-attestation.ts` |
| PHI Scrubbing | Custom memory zeroing | `src/security/secure-scrub.ts`, `src/security/secure-context.ts` |
| Gossip Authentication | HMAC-SHA256 (optional) | `src/l2/l2-peer-network.ts` |
| Admin Authentication | Ed25519 signatures or Bearer token | `src/l2/l2-rpc-server.ts` |
| Deployment | Docker containers on Render.com | `Dockerfile`, `render.yaml` |

### Database / Storage

There is **no traditional database** (no SQL, no MongoDB, no Redis). All state is maintained in-memory using custom Merkle trees, maps, and arrays, with periodic file-based checkpoints (plain JSON, `0o600` permissions). Entity nodes persist encrypted state via the Nautilus framework (AES-256-GCM + scrypt-derived key from PIN). The WAL (Write-Ahead Log) provides crash recovery with HMAC integrity verification. This architecture means there are no SQL injection vectors, but also no database-level access controls — all authorization is enforced at the application layer.

---

## 3. Authentication & Authorization Deep Dive

### Authentication Mechanisms

The application implements a **two-tier authentication model**: (1) ZK proof-based wallet identity for all entities (members, prescribers, pharmacies), and (2) Bearer token or Ed25519 signature authentication for administrative operations.

**Wallet Identity (ZK-Based):** Each entity generates a 256-bit enrollment key locally (`crypto.randomBytes(32)` → base64url) in `src/wallets/wallet-derivation.ts`. The wallet ID is derived as `Poseidon.hash([domainTag, ...identityFieldHashes, enrollmentKeyHash, groupIdHash])`. The enrollment key NEVER leaves the device — it serves as a knowledge factor that prevents wallet impersonation even if PHI is breached. The ProofGate circuit (`src/wallets/proof-gate.ts`) allows entities to prove wallet ownership without revealing the enrollment key or raw identity fields.

**Admin Authentication (RPC):** The L2 RPC server (`src/l2/l2-rpc-server.ts`, lines 2420-2481) supports two modes:
- **Unsecure mode** (`ZKTRIDENT_UNSECURE=true`): Bearer token in `Authorization` header, compared using `timingSafeEqual()`. Defaults to `admin123` if no token set.
- **Secure mode**: Ed25519 signature in `X-Admin-Signature` header with format `{nodeId}:{timestamp}:{signature_hex}`. Message is `{method}|{SHA256(params)}|{timestamp}`. 30-second replay window enforced.

**CRITICAL VULNERABILITY:** When no admin token is configured in unsecure mode, the auth check at line 2474 returns `true` unconditionally: `if (!this.options.adminToken) return true;`. This means all 17+ admin methods (forceBatch, storeFormulary, registerEntity, credentialProvider, etc.) are completely unauthenticated.

### Authentication Endpoints (Exhaustive List)

**Leviathan Sequencer (POST /rpc):**
- `l2_registerAdminKey` — Register Ed25519 public key (no auth required during genesis; quorum required post-genesis)
- `l2_getAdminKeys` — List registered admin keys (admin auth required)
- `l2_revokeAdminKey` — Blacklist admin node (admin auth required)
- `l2_requestAdmission` — Request wallet admission to network (no auth)
- `l2_approveAdmission` — Approve wallet admission (admin auth required)

**Entity Nodes (Nautilus):**
- `POST /onboarding/unlock` — Unlock wallet with PIN (member, prescriber, pharmacy)
- `POST /onboarding/accept-token` — Accept enrollment token
- `POST /onboarding/generate-key` — Generate enrollment key
- `POST /onboarding/derive-wallet` — Derive wallet ID from PHI + enrollment key
- `POST /onboarding/enroll` — Complete enrollment (triggers SSRF via `insurerUrl`)
- `POST /onboarding/compile` — Compile ZK programs
- `POST /onboarding/backup-key` — Backup enrollment key to NFC
- `POST /onboarding/restore-key` — Restore key from NFC backup
- `POST /onboarding/configure` — Configure insurer/employer node

### Session Management & Cookie Configuration

The application does **NOT use HTTP sessions or cookies**. Authentication is stateless:
- Admin operations use per-request Bearer tokens or Ed25519 signatures
- Entity identity is proven via ZK proofs submitted with each transaction
- There are no session cookies, no `Set-Cookie` headers, no `HttpOnly`/`Secure`/`SameSite` flags to configure
- The Nautilus local state uses PIN-based encryption for persistence, not session tokens

**Security implication:** The absence of session management eliminates session fixation, session hijacking, and CSRF via cookies. However, the Bearer token model means tokens must be protected in transit (no TLS by default on the sequencer) and in storage (admin tokens are environment variables).

### Authorization Model

**Role-Based Multi-Tenancy:** Five distinct domain tags isolate wallet identities:
- Member (tag 0): Bound to employer group via `groupIdHash`
- Prescriber (tag 1): National identity via NPI number
- Pharmacy (tag 2): Identity via service provider ID
- Representative (tag 3): Delegated authority with scoped bitfield permissions
- Insurer: No wallet, admin token authentication only

**Admin Method Authorization:** 17+ RPC methods require admin auth (`src/l2/l2-rpc-server.ts`, lines 183-197). The admin key admission uses BFT quorum: `threshold = floor(2N/3) + 1` where N = existing admin count.

**Potential Bypass Scenarios:**
1. No admin token configured → all admin methods open (line 2474)
2. Unsecure mode with default `admin123` token → trivially guessable
3. Genesis phase allows first admin key registration without any auth
4. Nautilus admin token comparison is NOT timing-safe (`nautilus-app-server.ts`, line 301)

### SSO/OAuth/OIDC Flows

**Not implemented.** The application does not use SSO, OAuth, or OIDC. Authentication is entirely ZKP-based (wallet identity) and token-based (admin operations). There are no callback endpoints, no `state`/`nonce` parameters to validate.

---

## 4. Data Security & Storage

### Database Security

The application uses **no traditional database**. All state is maintained in custom in-memory data structures (Merkle trees, maps, arrays) with file-based persistence. This eliminates SQL injection entirely but shifts all access control responsibility to the application layer. The L2 chain state lives in the Leviathan process memory and is periodically checkpointed to disk as plain JSON files (`src/l2/l2-checkpoint.ts`). **Checkpoint files are NOT encrypted** — they contain full chain state including all receipts, blocks, batches, audit logs, admin key registry, and wallet lifecycle states. File permissions are set to `0o600` (owner read/write only), which is appropriate but insufficient if filesystem access is compromised.

The Nautilus entity nodes use a properly encrypted local state store (`src/nodes/nautilus-local-state.ts`): AES-256-GCM with scrypt key derivation (N=2^15, r=8, p=1, 64 MiB memory), fresh 16-byte salt per file, fresh 12-byte IV per save operation. The derived key is zeroed on lock. This is a strong implementation, though the 6-digit PIN minimum (`MIN_PIN_LENGTH = 6` in `src/security/enrollment-backup.ts`) provides only ~20 bits of entropy — on a stolen device, brute-force is feasible if there's no rate limiting on unlock attempts (none was found in the code).

The Write-Ahead Log (WAL) in `src/l2/l2-wal.ts` provides crash recovery with HMAC-SHA256 integrity verification. The HMAC secret is stored as raw bytes in `{dataDir}/wal/wal.secret` with `0o600` permissions but no encryption. If an attacker gains filesystem read access, they can forge WAL entries.

### Data Flow Security

**PHI/PII Flow:** Member data (cardholder ID, DOB, first/last name) enters the system only on the member's local device during onboarding. The `SecureContext` pattern (`src/security/secure-context.ts`) processes raw PHI through cryptographic derivation (Poseidon hashing → wallet ID + preimage Fields), then immediately scrubs the raw data via `scrubObject()` / `scrubArray()` in `src/security/secure-scrub.ts`. The scrubbing zeroes strings, numbers, typed arrays, and recursively processes nested objects. Only Poseidon hashes and Field values leave the device. This is a strong privacy-by-design pattern.

**Sensitive Data Exposure Risks:**
1. **Seed data contains hardcoded enrollment keys** (`src/seed/members.ts`, lines 64-197) — 8 static enrollment keys in source code. If seed functions are accidentally invoked in production, these become known-secret wallets.
2. **PHI logged in seed/demo scripts** (`src/seed/run-l2-node.ts`, line 152; `src/seed/run-full-cycle.ts`, lines 177-262) — Console.log outputs first names, last names, cardholder IDs.
3. **Admin token `admin123` logged at startup** (`src/nodes/start-leviathan.ts`, line 680) — The literal fallback credential appears in logs in unsecure mode.
4. **Prover API key defaults to `dev-key`** (`src/nodes/start-leviathan.ts`, line 500) — Another hardcoded credential fallback.

**Message Encryption:** The messaging system (`src/messaging/encryption.ts`) implements X25519 ECDH key exchange + HKDF-SHA256 key derivation + AES-256-GCM encryption. Per-message nonces prevent GCM nonce reuse. The Poseidon hash commitment of encrypted content includes the GCM auth tag to prevent tag substitution attacks. Key material is scrubbed in `finally` blocks.

### Multi-Tenant Data Isolation

Wallet identity isolation is enforced at the cryptographic level through domain tags in Poseidon hash derivation: `walletId = Poseidon.hash([domainTag, ...identityHashes, enrollmentKeyHash, groupIdHash])`. Different domain tags (0=member, 1=prescriber, 2=pharmacy, 3=representative) ensure wallet IDs cannot collide across roles even if identity fields match. Members are further isolated by employer group via `groupIdHash`. The Merkle Forest uses separate domain trees per data type (member, prescriber, pharmacy, medication, access control, transaction), providing structural isolation at the state storage level. ZK circuit verification ensures each entity can only prove knowledge of their own preimage — cross-entity impersonation requires knowledge of the victim's enrollment key.

---

## 5. Attack Surface Analysis

### External Entry Points (In-Scope, Network-Accessible)

The application exposes **7 network services** with a combined **150+ HTTP endpoints and 75+ JSON-RPC methods**. All services bind to `0.0.0.0` by default, making them accessible on all network interfaces.

#### Leviathan Sequencer (Port 3030)
**File:** `src/l2/l2-rpc-server.ts`

The central RPC server handles all chain operations via `POST /rpc` (JSON-RPC 2.0). It exposes:
- **~60 public RPC methods** (no auth): proof submission, state queries, formulary lookups, claim queries, message retrieval, chain verification, partition/quorum status
- **~17 admin RPC methods** (auth required): batch forcing, formulary storage, plan management, entity registration, provider credentialing, gossip relay, admin key management
- **REST endpoints**: `GET /health` (public), `GET /events` (SSE stream, public)
- **Visualization endpoints**: `GET /viz/events` (SSE), `POST /viz/emit` (admin), `GET /viz/entities` (public), `POST /viz/entities` (admin), `GET /viz/state` (public), `GET /viz/history` (public), `POST /viz/clear` (admin)
- **Interactive adjudication routes** (`/interactive/*`): ~45 endpoints for enrollment, prescriptions, dispensing, prior auth, NFC, messaging, credentials, formulary management — **ALL without authentication** (registered from `visualizer/engine/interactive-routes.ts`)
- **Node status routes** (`/node/*`): ~16 endpoints for claims, receipts, audit, chain state queries
- **Static dashboard files**: Served from configurable directory with path traversal protection

#### Entity Nodes (Nautilus Framework)

Each entity node runs an independent HTTP(S) server:

**Member Node (Port 4001)** — `src/nodes/routes/member-routes.ts`: Onboarding (unlock, accept-token, generate-key, derive-wallet, enroll, compile, backup-key, restore-key), drug/formulary queries, PCP management, proof submission, NFC ID, messaging

**Prescriber Node (Port 4002)** — `src/nodes/routes/prescriber-routes.ts`: Onboarding, prescription writing/submission, network provider queries, formulary access, cost estimation, badge tapping

**Pharmacy Node (Port 4003)** — `src/nodes/routes/pharmacy-routes.ts`: Onboarding, dispensing management (mark-filled, dispense, fill, reverse), Drug Utilization Review (DUR), NFC scanning, prescription listing

**Insurer Node (Port 4004)** — `src/nodes/routes/insurer-routes.ts`: Configuration, enrollment processing, member roster, audit/chain integrity verification, 12+ report types (claims register, pharmacy/prescriber/member activity, financial summary, etc.), formulary/plan administration, provider credentialing (apply, verify, approve, deny, suspend, terminate), plan CRUD, messaging

**Employer Node (Port 4005)** — `src/nodes/routes/employer-routes.ts`: Configuration, group management (CRUD), enrollment token generation/revocation/validation, roster management, sequencer queries, messaging, plan viewing

#### Explorer (Port 8000)
**File:** `src/nodes/start-explorer.ts` — Serves static explorer dashboard and proxies `/rpc`, `/health`, `/events`, `/viz/*` to the sequencer.

### Internal Service Communication

Services communicate via **JSON-RPC 2.0 over HTTP** (no TLS by default on the sequencer). Trust relationships:
- Entity nodes → Sequencer: RPC calls for proof submission, state queries. The Nautilus app server proxies `/rpc` requests to the configured `sequencerUrl`.
- Sequencer → Proof Delegate: HTTP requests for ZK program compilation. Optional API key authentication (`X-Api-Key` header).
- Sequencer ↔ Peers: Gossip protocol with optional HMAC-SHA256 authentication via shared secret.
- Explorer → Sequencer: Proxy forwarding of requests.
- **CRITICAL**: The `insurerUrl` in enrollment routes is user-controllable, creating an SSRF vector where entity nodes make server-side requests to attacker-specified URLs.

### Input Validation Patterns

- **JSON-RPC validation**: Checks `jsonrpc === '2.0'`, method present, id defined (`src/l2/l2-rpc-server.ts`, lines 630-633)
- **Body size limits**: 20 MB (L2 RPC), 5 MB (Nautilus nodes)
- **Rate limiting**: Proof submissions only — 60 per IP per minute (configurable), sliding window with 5-minute cleanup
- **Path traversal**: Regex whitelist `/^[/a-zA-Z0-9._-]+$/` + `..` blocking on static file serving. L2 RPC server adds `path.resolve` + `startsWith` containment; Nautilus server lacks this second check.
- **Request timeouts**: 30 seconds (SSE streams exempt)
- **Enrollment key validation**: Minimum 16 chars, 3 of 4 character classes
- **PIN validation**: Minimum 6 characters
- **No general input sanitization middleware**: Each endpoint handles its own validation

### Background Processing

- **Proving Pool** (`src/l2/l2-proving-pool.ts`): Worker processes for ZK proof compilation. Workers are spawned as child processes with `--max-old-space-size` for memory management. Workers are recycled after N jobs to reclaim WASM heap. Crash recovery with timeout-based job recovery.
- **Batch Settlement** (`src/l2/l2-node.ts`): Timer-based batch building (30s-5min intervals). Auto-settlement to MINA L1 (optional). Max 3 retry attempts on failure.
- **SSE Event Broadcasting**: Ring buffer of 256 events for missed event replay. Max 100 concurrent SSE connections (configurable).

### Notable Out-of-Scope Components
- **`scripts/bootstrap-system.ts`**: CLI tool that spawns all services locally with hardcoded `admin123` token — not network-callable
- **`scripts/fetch-nadac.ts`**: CLI script to download NADAC drug pricing data from CMS — not network-callable
- **`src/data/import-nppes.ts`**: CLI importer for NPI prescriber data — not network-callable
- **`src/seed/*`**: Test seed data scripts — not network-callable
- **`src/poc/flowchart-dashboard-server.ts`**: POC visualization server — may be deployed but is a dev tool
- **Android app**: Client-side only, connects to entity nodes; not a server

---

## 6. Infrastructure & Operational Security

### Secrets Management

Secrets are managed exclusively through **environment variables** with no dedicated secrets manager (no Vault, no AWS Secrets Manager). The deployment blueprint (`render.yaml`) uses Render's `generateValue` for admin tokens and gossip secrets, which generates random values at deploy time. However, the application code contains multiple hardcoded credential fallbacks:

| Secret | Default Value | File | Risk |
|--------|--------------|------|------|
| Admin Token | `admin123` | `src/nodes/start-leviathan.ts:65` | Trivially guessable in unsecure mode |
| Admin Token | `admin123` | `scripts/bootstrap-system.ts:57` | Hardcoded in bootstrap |
| Prover API Key | `dev-key` | `src/nodes/start-leviathan.ts:500` | Hardcoded fallback |
| POC Admin Token | `poc-admin-token` | `src/poc/poc-orchestrator.ts:43` | Hardcoded in POC |

The admin token in unsecure mode defaults to `admin123` if `ZKTRIDENT_ADMIN_TOKEN` is not set. When no token is configured at all, admin auth is completely bypassed (line 2474 of `l2-rpc-server.ts`). The gossip secret (`ZKTRIDENT_GOSSIP_SECRET`) is shared across all peers — compromise of one peer reveals the authentication secret for the entire network.

### Configuration Security

**CORS:** The L2 RPC server's internal default is restrictive (`['http://localhost', 'http://127.0.0.1']` at line 376), but **every startup script overrides this to wildcard `*`**: `start-leviathan.ts` line 73, `start-nautilus.ts`, `start-member-nautilus.ts`, `start-insurer-nautilus.ts`, `start-employer-nautilus.ts`, and `render.yaml` lines 39 and 91. This means any website can make cross-origin requests to all services.

**TLS/HTTPS:** The Leviathan L2 RPC server (`src/l2/l2-rpc-server.ts`) uses `http.createServer` only — **no TLS support whatsoever**. Nautilus entity nodes support optional TLS via `ZKTRIDENT_TLS_CERT` / `ZKTRIDENT_TLS_KEY` environment variables, falling back to plain HTTP. The Render.com deployment handles TLS termination at the edge, but inter-service communication (sequencer ↔ entity nodes, gossip, proof delegation) is all plaintext HTTP.

**Infrastructure Security Headers:** No `Strict-Transport-Security` (HSTS), `Content-Security-Policy`, `X-Frame-Options`, or `X-Content-Type-Options` headers are set by the application. There is no Nginx, Kubernetes Ingress, or CDN configuration in the codebase — the Render.com platform may provide some of these, but the application does not enforce them. The static file server sets `Content-Type` based on file extension but does not set `X-Content-Type-Options: nosniff`.

**Network Binding:** All services default to `host: '0.0.0.0'` (all interfaces). Combined with wildcard CORS and no TLS, this maximizes the attack surface.

### External Dependencies

- **o1js 2.13.0** (MINA ZKP library) — Core cryptographic dependency, actively maintained
- **tsx 4.19.0** — TypeScript execution runtime
- **jest 30.2.0 / ts-jest 29.4.6** — Testing framework (dev only)
- No Express, no Fastify, no other HTTP framework dependencies
- No ORM, no database drivers
- Minimal dependency footprint reduces supply chain attack surface

### Monitoring & Logging

- **Audit Service** (`src/audit/audit-service.ts`): Merkle tree-based tamper-proof audit trail for proof submissions, batch construction, access control decisions, credential operations, formulary updates
- **Reporting Service** (`src/reporting/reporting-service.ts`): Claims analytics, formulary compliance, prior auth summary, medication utilization, provider network analytics — all accessible via insurer node endpoints
- **Console Logging**: Extensive `console.log` throughout — startup configuration logged (including security mode and whether secrets are configured), but secret values themselves are generally not logged (exception: `admin123` literal in log message at line 680)
- **No structured logging framework**: No Winston, Bunyan, or Pino — all logs go to stdout/stderr
- **No security event alerting**: No integration with SIEM, no anomaly detection

---

## 7. Overall Codebase Indexing

The zkTrident Care codebase is organized as a monorepo rooted in a single `package.json` with TypeScript as the sole backend language. The `src/` directory contains all backend logic, subdivided into domain-specific modules: `src/l2/` houses the L2 blockchain layer (sequencer, RPC server, peer network, proving pool, checkpoint, WAL, partitioning); `src/nodes/` contains the Nautilus entity node framework and role-specific route handlers in `src/nodes/routes/`; `src/wallets/` holds wallet derivation and the ProofGate ZK circuit; `src/security/` contains encryption, scrubbing, obfuscated key, and secure context utilities; `src/credentials/` has credential programs and NFC attestation; `src/access-control/` implements medication access verification circuits; `src/messaging/` handles encrypted messaging with X25519/AES-256-GCM and Authority-of-Representative delegation; `src/engine/` contains the state transition ZK program; `src/models/` defines data structures for members, prescribers, pharmacies, and formulary entries; `src/data/` provides formulary loading and data import utilities; `src/audit/` and `src/reporting/` handle audit trails and analytics; `src/onboarding/` manages enrollment token lifecycle; and `src/seed/` contains test data generation scripts.

The frontend is distributed across multiple dashboard directories: `dashboard/` (legacy, no escaping), `dashboard-leviathan/` (main sequencer dashboard with `esc()` function), `dashboard-member/`, `dashboard-employer/`, `dashboard-insurer/`, `dashboard-pharmacy/`, `dashboard-prescriber/` (role-specific dashboards), and `dashboard-shared/` (common utilities including `esc()` helper). The `explorer/` directory contains a blockchain explorer SPA. The `visualizer/` directory contains the interactive adjudication engine (`visualizer/engine/interactive-routes.ts` — 1979 lines, dynamically registered on the Leviathan server) and flowchart visualization tools. The `android/` directory contains a Kotlin-based Android app with NFC support. The `schemas/` directory contains NCPDP (National Council for Prescription Drug Programs) field definitions used as the data model basis.

Security-relevant components are discoverable but scattered: authentication logic is in `src/l2/l2-rpc-server.ts` (admin auth) and `src/wallets/` (ZK identity); encryption is in `src/security/` and `src/messaging/`; route definitions are in `src/nodes/routes/` and `visualizer/engine/interactive-routes.ts`. The interactive routes file is particularly noteworthy — it's 1979 lines defining ~45 unauthenticated endpoints that perform sensitive operations (enrollment, prescribing, dispensing, credential generation, formulary updates, batch forcing). The `scripts/` directory contains the bootstrap orchestrator. Deployment configuration is in `render.yaml` at the root. Docker files at the root define three container images: Leviathan, Prover, and Insurer.

---

## 8. Critical File Paths

### Configuration
- `render.yaml` — Render.com deployment blueprint (CORS: *, admin tokens, service definitions)
- `Dockerfile` — Leviathan container (non-root user, Node.js 20)
- `Dockerfile.prover` — Proof delegate container (6GB heap)
- `Dockerfile.insurer` — Insurer Nautilus container
- `package.json` — Dependencies and scripts
- `tsconfig.json` — TypeScript configuration (strict mode, source maps)
- `.dockerignore` — Docker build exclusions
- `.gitignore` — Git exclusions (reveals .env, credentials.json patterns)

### Authentication & Authorization
- `src/l2/l2-rpc-server.ts` — Admin auth (Bearer + Ed25519), rate limiting, CORS, RPC dispatch (~2500+ lines)
- `src/nodes/nautilus-app-server.ts` — Entity node HTTP server, admin token auth (non-timing-safe), TLS support
- `src/wallets/wallet-derivation.ts` — Wallet ID derivation, enrollment key generation/validation
- `src/wallets/proof-gate.ts` — ZK proof-of-wallet-ownership circuit
- `src/security/secure-context.ts` — PHI→hash secure derivation with scrubbing
- `src/security/secure-scrub.ts` — Memory zeroing for PHI/PII
- `src/security/obfuscated-key.ts` — XOR-split in-memory key protection
- `src/security/enrollment-backup.ts` — NFC backup encryption (AES-256-GCM + scrypt)
- `src/security/recovery-card.ts` — Wallet migration NFC card format
- `src/credentials/nfc-attestation.ts` — Ed25519 NFC credential signing
- `src/onboarding/token-authority.ts` — Enrollment token lifecycle management
- `src/nodes/start-leviathan.ts` — Leviathan startup (hardcoded admin123, unsecure mode, CORS override)

### API & Routing
- `src/nodes/routes/member-routes.ts` — Member node API routes (SSRF via insurerUrl)
- `src/nodes/routes/prescriber-routes.ts` — Prescriber node API routes (SSRF via insurerUrl)
- `src/nodes/routes/pharmacy-routes.ts` — Pharmacy node API routes (SSRF via insurerUrl)
- `src/nodes/routes/insurer-routes.ts` — Insurer node API routes (~16KB, reports, credentialing)
- `src/nodes/routes/employer-routes.ts` — Employer node API routes (group/token management, SSRF)
- `visualizer/engine/interactive-routes.ts` — Interactive adjudication (~1979 lines, 45+ unauthenticated endpoints)
- `src/nodes/start-explorer.ts` — Explorer proxy server (viz/* wildcard proxy)

### Data Models & Storage
- `src/models/member.ts` — Member data model (PHI field definitions)
- `src/l2/l2-checkpoint.ts` — Unencrypted chain state checkpoints
- `src/l2/l2-wal.ts` — Write-Ahead Log with HMAC integrity
- `src/nodes/nautilus-local-state.ts` — Encrypted entity state (AES-256-GCM + scrypt)
- `src/data/formulary-loader.ts` — Formulary data loading
- `src/data/formulary-100.json` — Test formulary data
- `src/data/index.ts` — Data loader with hardcoded seed enrollment key
- `src/storage/local-store.ts` — Local store (hashes only, no PHI)

### Dependency Manifests
- `package.json` — Root dependencies (o1js, tsx, jest)
- `package-lock.json` — Locked dependency tree
- `android/app/build.gradle.kts` — Android dependencies

### Sensitive Data & Secrets Handling
- `src/security/secure-context.ts` — PHI scrubbing pattern
- `src/security/secure-scrub.ts` — Memory zeroing implementation
- `src/security/obfuscated-key.ts` — XOR-split key protection
- `src/messaging/encryption.ts` — X25519 + AES-256-GCM message encryption
- `src/messaging/aor-data.ts` — Authority-of-Representative data model
- `src/messaging/aor-service.ts` — AOR delegation service
- `src/seed/members.ts` — Hardcoded test enrollment keys (8 keys)
- `scripts/bootstrap-system.ts` — Hardcoded admin123 token

### Middleware & Input Validation
- `src/l2/l2-rpc-server.ts` — Body size limits (20MB), rate limiting, path validation, CORS
- `src/nodes/nautilus-app-server.ts` — Body size limits (5MB), path validation, timeout handling
- `src/zkp/hash-utils.ts` — Field arithmetic validation, negative cents rejection

### Logging & Monitoring
- `src/audit/audit-service.ts` — Merkle tree audit trail
- `src/reporting/reporting-service.ts` — Claims and compliance reporting
- `src/seed/run-l2-node.ts` — PHI logging in seed scripts
- `src/seed/run-full-cycle.ts` — PHI logging in demo scripts

### Infrastructure & Deployment
- `render.yaml` — Production deployment blueprint (Render.com)
- `Dockerfile` — Leviathan container image
- `Dockerfile.prover` — Proof delegate container image
- `Dockerfile.insurer` — Insurer container image
- `android/app/src/main/AndroidManifest.xml` — Android permissions (NFC, camera, internet)
- `android/app/src/main/res/xml/network_security_config.xml` — Android TLS configuration

### ZKP & Cryptography
- `src/wallets/proof-gate.ts` — ProofGate ZK program (wallet ownership)
- `src/engine/state-transition.ts` — State transition recursive ZK program
- `src/access-control/access-control-program.ts` — Medication access ZK program
- `src/credentials/credential-program.ts` — Credential operation ZK program
- `src/l2/l2-peer-network.ts` — Gossip protocol (HMAC-SHA256 auth)
- `src/l2/l2-proving-pool.ts` — Worker-based proof compilation pool
- `src/l2/l2-partition.ts` — Multi-sequencer sharding

### Schema Files
- `schemas/ncpdp-minimum-fields.ts` — NCPDP minimum field definitions
- `schemas/ncpdp-full-reference.ts` — NCPDP full field reference

### Dashboard & Frontend
- `dashboard/app.js` — Legacy dashboard (NO HTML escaping — XSS vulnerable)
- `dashboard-leviathan/` — Main Leviathan dashboard (has esc() function)
- `dashboard-shared/` — Shared dashboard utilities
- `explorer/app.js` — Block explorer (partial escaping gaps)
- `visualizer/` — Visualization engine

---

## 9. XSS Sinks and Render Contexts

### Overview

The application serves web dashboards as static JavaScript SPAs from the Leviathan sequencer and Nautilus entity nodes. All HTML rendering is client-side via JavaScript DOM manipulation (no server-side template engines). Most dashboards implement an `esc()` function for HTML entity encoding, but the legacy `dashboard/app.js` has **zero HTML escaping** and the `explorer/app.js` has **partial escaping gaps**.

### FINDING 1 [HIGH]: `dashboard/app.js` — No HTML Escaping, All Data Rendered Raw

**File:** `dashboard/app.js`
**Lines:** Throughout (55-58, 124-163, 191-228, 243-277, 292-309, 347-357, 391-401, 405, 455-466, 507-522, 611-615)
**Sink Type:** `innerHTML` with ES6 template literal interpolation
**Render Context:** HTML Body + HTML Attributes
**Escaping:** NONE — this file has NO `esc()` function, unlike every other dashboard

**Dangerous Patterns:**
- **Lines 55-58 (`hashLink()`):** Injects `hash` directly into `href` and `title` attributes without escaping quotes. A wallet ID containing `"><img src=x onerror=alert(1)>` would execute JavaScript.
- **Line 44 (`statusBadge()`):** Inserts `status` string directly into innerHTML without escaping.
- **Lines 243-277 (receipt details):** `${r.receiptId}`, `${r.walletId}`, `${r.oldRegistryRoot}`, etc. rendered raw.
- **Lines 292-309, 405 (error handling):** `${err.message}` inserted raw into innerHTML — attacker-influenced error messages become XSS vectors.
- **Lines 611-614 (SSE event rendering):** `event.type` and `JSON.stringify(event.data)` from server-sent events injected raw into innerHTML. If the sequencer emits events with crafted payloads, this is exploitable.
- **Lines 347-357 (formulary data):** `e.brandName`, `e.genericName`, `e.therapeuticClass`, `e.strength` rendered raw — drug names from the formulary could contain XSS payloads if the formulary is compromised.
- **Line 227 (batch data):** `${b.failureReason || '-'}` rendered raw.

**Attack Vector:** Data flows from the L2 sequencer API responses through RPC calls into the dashboard. If a malicious entity registers with a crafted wallet ID, submits proofs with manipulated metadata, or if an admin stores a formulary with XSS payloads, the dashboard renders them without any sanitization. The SSE event stream is particularly dangerous as it broadcasts events to all connected dashboard clients.

### FINDING 2 [MEDIUM]: `explorer/app.js` — `shortHash()` Does Not Escape HTML

**File:** `explorer/app.js`
**Lines:** 22-26 (shortHash definition), 251, 317, 484-487, 541-544
**Sink Type:** `innerHTML` via render functions
**Render Context:** HTML Body

The `shortHash()` function at line 22 truncates a string without calling `esc()`. It's used in `renderBatchTable()` (line 251: `shortHash(b.globalStateRoot)`), `renderClaimTable()` (lines 484-487: `shortHash(leaf.memberWalletId)`, `shortHash(leaf.ndcHash)`), and `renderMessageTable()` (lines 541-544: `shortHash(msg.senderWalletId)`). While wallet IDs are typically hex Poseidon hashes, a compromised sequencer could return crafted values. The `esc()` function exists in this file but is not applied to `shortHash()` output.

### FINDING 3 [MEDIUM]: `dashboard/app.js` — Attribute Injection via `hashLink()`

**File:** `dashboard/app.js`
**Lines:** 53-59
**Sink Type:** HTML attributes (`title`, `href`)
**Render Context:** HTML Attribute

The `hashLink()` function constructs `<a>` tags with `title="${hash}"` and `href="#/receipt/${hash}"` where `hash` is unescaped. A value containing `" onmouseover="alert(1)` breaks out of the `title` attribute and injects an event handler. This is a classic attribute injection XSS.

### FINDING 4 [LOW]: `explorer/app.js` — `esc()` Function Doesn't Escape Quotes in JS Context

**File:** `explorer/app.js`
**Lines:** 315, 686
**Sink Type:** `onclick` handler attribute
**Render Context:** JavaScript Context

Line 315 uses `esc()` for an onclick attribute value: `'<tr onclick="window._showReceipt(\'' + esc(rid) + '\')">'`. However, the `esc()` function only escapes `&`, `<`, `>` — it does NOT escape single quotes (`'`) or double quotes (`"`). An `rid` containing `')},alert(1),{('` would break out of the onclick handler. Line 686 inserts `String(nid).slice(0, 2).toUpperCase()` without escaping.

### FINDING 5 [INFO]: No Server-Side Template Injection

No server-side template engines (EJS, Handlebars, Pug) are used. All HTML is either static files or client-side JavaScript rendering. Server-side responses are JSON (for RPC), plain text (for errors), or binary (for static files). No SQL injection is possible (no SQL database). No command injection from user input was found — `exec()` in `start-leviathan.ts:421` uses hardcoded URLs only.

### XSS Sink Summary Table

| Severity | File | Lines | Sink | Context | Escaping |
|----------|------|-------|------|---------|----------|
| HIGH | `dashboard/app.js` | 55-58, 124-615 | `innerHTML` (template literals) | HTML Body + Attribute | None |
| MEDIUM | `explorer/app.js` | 22-26, 251, 484-487, 541-544 | `innerHTML` via `shortHash()` | HTML Body | None on shortHash |
| MEDIUM | `dashboard/app.js` | 53-59 | `title`, `href` attributes | HTML Attribute | None |
| LOW | `explorer/app.js` | 315, 686 | `onclick` handler | JavaScript Context | Partial (no quote escaping) |

---

## 10. SSRF Sinks

### Overview

The application makes several types of outbound HTTP requests from server-side components. The most critical finding is a classic SSRF vulnerability in entity node enrollment routes where a user-controlled `insurerUrl` parameter is used directly in `fetch()` calls with no URL validation.

### FINDING 1 [HIGH]: User-Controlled `insurerUrl` in Enrollment Routes — Classic SSRF

**Files:**
- `src/nodes/routes/member-routes.ts` — Lines 244-300 (`POST /onboarding/enroll`)
- `src/nodes/routes/prescriber-routes.ts` — Lines 224-242 (`POST /onboarding/enroll`)
- `src/nodes/routes/pharmacy-routes.ts` — Lines 145-163 (`POST /onboarding/enroll`)
- `src/nodes/routes/employer-routes.ts` — Lines 36-46 (`POST /onboarding/configure`)

**HTTP Client:** `fetch()` (Node.js built-in)

**Vulnerability:** The `POST /onboarding/enroll` route on member, prescriber, pharmacy, and employer Nautilus nodes accepts an `insurerUrl` field from the JSON request body. This URL is used directly in a server-side `fetch()` call with **no validation** of the URL scheme, host, or destination:

```typescript
const b = body as { insurerUrl?: string } | undefined;
const insurerUrl = b?.insurerUrl || server.getConfig().insurerUrl || null;
// ... later ...
const resp = await fetch(`${iUrl}/enrollment/process`, { method: 'POST', ... });
```

**Attack Scenarios:**
1. **Cloud metadata theft:** `{"insurerUrl": "http://169.254.169.254/latest/meta-data/"}` — access AWS/GCP/Azure instance metadata
2. **Internal port scanning:** `{"insurerUrl": "http://internal-service:PORT"}` — enumerate internal services
3. **Credential theft:** In prescriber-routes.ts (line 241) and pharmacy-routes.ts (line 162), the `adminToken` is forwarded in the `Authorization: Bearer {token}` header to the user-supplied URL — this leaks the admin credential to attacker-controlled servers
4. **Internal service interaction:** POST requests with JSON body are sent to the target URL, potentially triggering actions on internal services

**Validation:** None. No URL scheme check, no allowlist, no private IP range blocking.

**Reachability:** Directly accessible via HTTP POST from any client that can reach the entity node port. The route requires onboarding phase `wallet_derived` to be reached, which is a normal precondition (not a security gate).

### FINDING 2 [MEDIUM]: Explorer `/viz/*` Wildcard Proxy

**File:** `src/nodes/start-explorer.ts` — Lines 130-169

**HTTP Client:** `fetch()` (Node.js built-in)

**Vulnerability:** The explorer proxies requests matching `/viz/*` to the sequencer by concatenating the user-controlled path and query string:
```typescript
const upstream = await fetch(sequencerUrl + pathname + url.search);
```

The `sequencerUrl` is fixed from environment configuration, but the `pathname` (after `/viz/`) and `url.search` are fully user-controlled. While `new URL()` normalizes paths (preventing `/../` traversal), the attacker can access any endpoint path on the sequencer that starts with `/viz/`. The query string is passed verbatim, allowing arbitrary parameter injection to the upstream server.

**Reachability:** Direct from any HTTP client on explorer port 8000.

### FINDING 3 [MEDIUM]: Peer Network URL Injection via Unauthenticated Gossip

**Files:**
- `src/l2/l2-peer-network.ts` — Line 122 (`connectToPeer`), Line 538 (`exchangePeerList`)
- `src/l2/l2-rpc-server.ts` — Line 2050 (`l2_getPeerList`, `l2_gossipRelay`)

**HTTP Client:** `L2Client` (wraps `http.request`)

**Vulnerability:** The `connectToPeer(url)` method accepts any URL and creates an HTTP client to that destination. Peer URLs can be injected via:
1. **Peer list exchange** (`exchangePeerList()`): Remote peers share their known peer URLs
2. **Gossip `peer:announce` messages**: Contain `knownPeers` URL arrays

If gossip authentication is not configured (`gossipSecret` not set), any client that can reach the RPC port can submit gossip messages via `l2_gossipRelay` containing arbitrary peer URLs. The sequencer will then attempt HTTP connections to those URLs. **Note:** `l2_gossipRelay` does NOT appear in the admin-only method list in all configurations, though some code paths check for admin auth.

**Validation:** Optional HMAC or Ed25519 gossip authentication. Max peers limit exists. No URL scheme/host validation on the URL itself.

**Reachability:** Via `POST /rpc` with `l2_gossipRelay` method, potentially without admin auth if gossip secret is not configured.

### FINDING 4 [LOW]: Nautilus RPC Proxy to Sequencer

**File:** `src/nodes/nautilus-app-server.ts` — Line 401

**HTTP Client:** `fetch()` (Node.js built-in)

The Nautilus app server proxies `POST /rpc` requests to the configured `sequencerUrl`. The destination host is fixed from server configuration (not user-controllable). The request body from the client is forwarded as-is. This is intentional proxy behavior with a fixed destination — not exploitable as SSRF, but the verbatim body forwarding means any JSON-RPC method available on the sequencer is accessible through the entity node.

### FINDING 5 [LOW]: Proof Delegate Client

**File:** `src/nodes/proof-delegate.ts` — Lines 68-203

**HTTP Client:** `http.get()`, `http.request()`

The `ProofDelegateClient` makes requests to `this.proverUrl` which is set at construction time from server configuration, not from user input. Not exploitable as SSRF.

### FINDING 6 [INFO]: CLI-Only Data Importers (Out of Scope)

**Files:**
- `src/data/import-nppes.ts` line 126 — `https.get()` to `npiregistry.cms.hhs.gov`
- `src/data/import-nadac.ts` line 80 — `https.get()` to `download.medicaid.gov` (follows redirects without Location validation)
- `scripts/fetch-nadac.ts` line 157 — `fetch()` to `data.medicaid.gov`

These are CLI scripts with hardcoded URLs. Not reachable from any network request.

### SSRF Sink Summary Table

| Severity | File | Sink | User Control | Validation |
|----------|------|------|--------------|------------|
| HIGH | `src/nodes/routes/member-routes.ts:244` | `fetch(insurerUrl + ...)` | Full URL from request body | None |
| HIGH | `src/nodes/routes/prescriber-routes.ts:224` | `fetch(insurerUrl + ...)` | Full URL from request body | None |
| HIGH | `src/nodes/routes/pharmacy-routes.ts:145` | `fetch(insurerUrl + ...)` | Full URL from request body | None |
| HIGH | `src/nodes/routes/employer-routes.ts:36` | `fetch(insurerUrl + ...)` | Full URL from request body | None |
| MEDIUM | `src/nodes/start-explorer.ts:130` | `fetch(seqUrl + pathname + search)` | Path + query string | Fixed host |
| MEDIUM | `src/l2/l2-peer-network.ts:122` | `L2Client(peerUrl)` | Via gossip messages | Optional HMAC |
| LOW | `src/nodes/nautilus-app-server.ts:401` | `fetch(seqUrl + '/rpc')` | Request body only | Fixed host |
| LOW | `src/nodes/proof-delegate.ts:68` | `http.request(proverUrl)` | None (config only) | N/A |
