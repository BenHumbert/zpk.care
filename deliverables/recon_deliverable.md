# Reconnaissance Deliverable: zkTrident Care — Attack Surface Map

## 0) HOW TO READ THIS

This reconnaissance report provides a comprehensive map of the application's attack surface for the zkTrident Care decentralized healthcare claim adjudication system. Special emphasis is placed on the authorization architecture for the Authorization Analysis Specialist.

**Key Sections for Authorization Analysis:**
- **Section 4 (API Endpoint Inventory):** Contains authorization details for each endpoint — focus on "Required Role" and "Object ID Parameters" columns to identify IDOR candidates. Pay special attention to the 40+ unauthenticated `/interactive/*` endpoints and the L2 RPC admin bypass.
- **Section 6.4 (Guards Directory):** Catalog of authorization controls — note that most guards are absent or trivially bypassed.
- **Section 7 (Role & Privilege Architecture):** Complete role hierarchy — note there are no per-request role checks; roles are static to node process.
- **Section 8 (Authorization Vulnerability Candidates):** Pre-prioritized lists for horizontal, vertical, and context-based authorization testing.

**How to Use the Network Mapping (Section 6):** The entity/flow mapping shows 7 independent HTTP services. Most flows carry no auth guards. The most critical boundary is the L2 RPC server where admin auth is completely bypassed in the current deployment.

**Priority Order for Testing:** Start with Section 8's admin auth bypass (unauthenticated admin RPC + viz endpoints), then the SSRF in enrollment routes (credential theft), then the 40+ unauthenticated interactive adjudication endpoints, then XSS sinks in the legacy dashboard.

---

## 1. Executive Summary

**zkTrident Care** (zkpCare) is a privacy-first decentralized healthcare claim adjudication system built on Zero Knowledge Proofs using the MINA Protocol's o1js library. It processes Protected Health Information (PHI) and Personally Identifiable Information (PII) for pharmacy benefit claims, routing prescriptions through a custom Layer 2 blockchain (the "Leviathan Sequencer").

**Core Technology Stack:** TypeScript 5.9 on Node.js 22, raw `http.createServer` (no framework), o1js 2.13 ZKP library, no SQL database (in-memory Merkle trees + JSON checkpoints), deployed on Render.com via Docker.

**Primary Attack Surface:** 7 network services on 6 ports expose 150+ HTTP endpoints and 75+ JSON-RPC methods. The most critical findings are: (1) **Complete admin auth bypass** — the L2 RPC server returns `true` for all admin auth checks when no admin token is configured, granting unauthenticated access to all 13+ admin methods; (2) **40+ unauthenticated interactive adjudication routes** including enrollment, prescription creation, batch forcing, and state mutation; (3) **SSRF with credential theft** in enrollment routes where user-controlled `insurerUrl` is used in server-side `fetch()` calls that forward the admin Bearer token; (4) **Stored XSS** in legacy dashboard with zero HTML escaping of all API-sourced data.

---

## 2. Technology & Service Map

- **Frontend:** Static HTML/CSS/JS SPAs served from each node's process. Multiple dashboards: `dashboard/` (legacy, no XSS escaping), `dashboard-leviathan/`, `dashboard-member/`, `dashboard-employer/`, `dashboard-insurer/`, `dashboard-pharmacy/`, `dashboard-prescriber/`, `dashboard-shared/` (with `esc()` helper), `explorer/`. Client-side rendering only — no server-side template engines.
- **Backend:** TypeScript 5.9.3 on Node.js 20 LTS (runtime: v22.22.2), `tsx` 4.19.0 runtime, raw `http`/`https` Node.js modules (no Express/Fastify), o1js 2.13.0 ZKP library, custom JSON-RPC 2.0 implementation.
- **Infrastructure:** Docker containers on Render.com. No traditional database — in-memory Merkle trees, `Map`/`Array` state, JSON file checkpoints (`0o600` permissions). WAL with HMAC-SHA256 integrity. Wildcard CORS (`*`) as default. No TLS on the Leviathan sequencer (HTTP only). Optional TLS on entity nodes.
- **Identified Subdomains:** No external subdomains discovered (single-host deployment via `host.docker.internal`).
- **Open Ports & Services:**
  - **3030** — Leviathan Sequencer (L2 RPC server, JSON-RPC 2.0 + REST + SSE + interactive routes)
  - **4001** — Member Nautilus Node (HTTP, phase: `awaiting_token`)
  - **4002** — Prescriber Nautilus Node (HTTP, phase: `ready`)
  - **4003** — Pharmacy Nautilus Node (HTTP, phase: `ready`)
  - **4004** — Insurer Nautilus Node (HTTP, phase: `ready`)
  - **4005** — Employer Nautilus Node (HTTP, phase: `ready`)
  - **8000** — Explorer (static dashboard + proxy to sequencer on port 3030)

---

## 3. Authentication & Session Management Flow

- **Entry Points:** There are no traditional login/register forms or credential-based authentication. Authentication is split into two mechanisms:
  1. **ZK-Proof Wallet Identity** — for entity operations (proofs submitted via `POST /rpc` → `l2_submitProof`)
  2. **Bearer Token** — for admin operations on all services

- **Mechanism:**
  - Admin operations on the L2 RPC server require an `Authorization: Bearer <token>` header (unsecure mode) or an Ed25519 signature in `X-Admin-Signature` header (secure mode). **CRITICAL:** When no admin token is configured (`ZKTRIDENT_ADMIN_TOKEN` env var unset) and the admin key registry is empty, `checkAdminAuth()` in `src/l2/l2-rpc-server.ts:2474` returns `true` unconditionally — all admin methods are open.
  - Admin operations on entity nodes (Nautilus) require `Authorization: Bearer <token>`. When no token is configured, the server returns HTTP 403 (inverse of L2 behavior).
  - Entity proof submission involves generating a ZK proof on the client device and posting it to the sequencer — no server-side credential is checked.
  - Enrollment uses a token-based flow: employer generates a `GroupEnrollmentToken`, distributes the `tokenId` to a member, who presents it during `POST /onboarding/accept-token`.

- **Code Pointers:**
  - Admin auth bypass: `src/l2/l2-rpc-server.ts:2470–2481` (`checkAdminAuth`)
  - Bearer token comparison (timing-safe): `src/l2/l2-rpc-server.ts:2419–2425` (`safeEquals`)
  - Nautilus admin check (NOT timing-safe): `src/nodes/nautilus-app-server.ts:295–303`
  - RPC auth dispatch: `src/l2/l2-rpc-server.ts:635–659`
  - Admin method list: `src/l2/l2-rpc-server.ts:182–197` (`ADMIN_METHODS`)

### 3.1 Role Assignment Process

- **Role Determination:** Role is statically assigned at node startup via `ZKTRIDENT_ROLE` environment variable. Each Nautilus node has one role. The Leviathan sequencer has no user roles — only admin vs. public distinction.
- **Default Role:** No concept of a default role; each service is a single-role microservice (member node = member role, etc.)
- **Role Upgrade Path:** Not applicable in the traditional sense. An entity node moves through onboarding phases (`awaiting_token → token_received → key_generated → wallet_derived → enrolled → compiling → ready`), but these are lifecycle states, not privilege levels.
- **Code Implementation:** `src/nodes/nautilus-app-types.ts` (OnboardingPhase type), phase state stored in `NautilusAppServer` instance and `NautilusLocalState`.

### 3.2 Privilege Storage & Validation

- **Storage Location:** Admin tokens are environment variables (`ZKTRIDENT_ADMIN_TOKEN`). No JWTs, no session cookies. ZK wallet identity is cryptographically bound — `walletId = Poseidon.hash([domainTag, ...preimage])`.
- **Validation Points:** L2 RPC: `checkAdminAuth()` at `src/l2/l2-rpc-server.ts:2470`. Nautilus: inline in `NautilusAppServer.handleRequest()` at `src/nodes/nautilus-app-server.ts:295`. Interactive routes: **NO VALIDATION** — `visualizer/engine/interactive-routes.ts` has zero auth checks.
- **Cache/Session Persistence:** Stateless. Bearer tokens are validated per-request against the configured environment variable. No caching.
- **Code Pointers:** `src/l2/l2-rpc-server.ts:2419–2481`, `src/nodes/nautilus-app-server.ts:295–303`

### 3.3 Role Switching & Impersonation

- **Impersonation Features:** None implemented.
- **Role Switching:** None. Fixed per-process role.
- **Audit Trail:** The audit service (`src/audit/audit-service.ts`) logs proof submissions, credential operations, and formulary updates in a Merkle chain. Admin RPC methods in secure mode log `_verifiedNodeId`. No audit of Bearer token usage.
- **Code Implementation:** N/A

---

## 4. API Endpoint Inventory

**Network Surface Focus:** All endpoints below are accessible via HTTP to any client that can reach the respective port.

### 4.1 L2 RPC Server REST Endpoints (Port 3030)

| Method | Endpoint Path | Required Role | Object ID Parameters | Authorization Mechanism | Description & Code Pointer |
|--------|--------------|---------------|---------------------|------------------------|---------------------------|
| GET | `/health` | anon | None | None | Node health, memory, proving pool stats. `l2-rpc-server.ts:393` |
| GET | `/events` | anon | None | None | SSE stream of L2 chain events. `l2-rpc-server.ts:397` |
| POST | `/rpc` | anon/admin | Varies per method | None (public) or Bearer/Ed25519 (admin) | JSON-RPC 2.0 dispatch. `l2-rpc-server.ts:401` |
| POST | `/viz/emit` | admin* | None | `checkAdminAuth()` — **BYPASSED** (no token configured) | Push viz event to SSE stream. `l2-rpc-server.ts:407` |
| GET | `/viz/events` | anon | None | None | SSE stream of viz events. `l2-rpc-server.ts:416` |
| POST | `/viz/entities` | admin* | None | `checkAdminAuth()` — **BYPASSED** | Register entity in viz. `l2-rpc-server.ts:420` |
| GET | `/viz/entities` | anon | None | None | List viz entities. `l2-rpc-server.ts:429` |
| GET | `/viz/state` | anon | None | None | Viz state snapshot. `l2-rpc-server.ts:433` |
| GET | `/viz/history` | anon | None | None | Full viz event history. `l2-rpc-server.ts:437` |
| POST | `/viz/clear` | admin* | None | `checkAdminAuth()` — **BYPASSED** | Clear all viz events. `l2-rpc-server.ts:441` |
| GET | `/*` (static) | anon | None | None | Dashboard static files. `l2-rpc-server.ts:458` |

*Admin check bypassed in current deployment — confirmed via live testing.

### 4.2 L2 RPC Methods (POST /rpc, Port 3030)

#### Public RPC Methods (no auth)

| Method | Endpoint Path | Required Role | Object ID Parameters | Authorization Mechanism | Description & Code Pointer |
|--------|--------------|---------------|---------------------|------------------------|---------------------------|
| `l2_submitProof` | POST /rpc | anon | proofJson (walletId inside) | None — ZK proof validity only | Submit ZK state transition proof. `l2-rpc-server.ts` |
| `l2_syncWalletState` | POST /rpc | anon | walletId | None | Sync wallet state after update. `l2-rpc-server.ts` |
| `l2_requestAdmission` | POST /rpc | anon | nodeId, publicKeyHex | None | Request admin quorum admission. `l2-rpc-server.ts` |
| `l2_registerAdminKey` | POST /rpc | anon (genesis only) | nodeId, publicKeyHex | None when registry empty | Register first admin key (genesis). `l2-rpc-server.ts:637` |
| `l2_getStatus` | POST /rpc | anon | None | None | Chain/node status. `l2-rpc-server.ts` |
| `l2_getHealth` | POST /rpc | anon | None | None | Memory, workers. `l2-rpc-server.ts` |
| `l2_getChainState` | POST /rpc | anon | None | None | Registry roots, wallet count. `l2-rpc-server.ts` |
| `l2_getReceipt` | POST /rpc | anon | receiptId | None | Single receipt by ID. `l2-rpc-server.ts` |
| `l2_getReceiptsByWallet` | POST /rpc | anon | walletId | None | All receipts for a wallet. `l2-rpc-server.ts` |
| `l2_getAllReceipts` | POST /rpc | anon | None | None | Paginated all receipts. `l2-rpc-server.ts` |
| `l2_getAllBatches` | POST /rpc | anon | None | None | Paginated batches. `l2-rpc-server.ts` |
| `l2_getBlock` | POST /rpc | anon | blockNumber | None | Block by number. `l2-rpc-server.ts` |
| `l2_getBatch` | POST /rpc | anon | batchNumber | None | Batch by number. `l2-rpc-server.ts` |
| `l2_getAuditLog` | POST /rpc | anon | None | None | Audit event log. `l2-rpc-server.ts` |
| `l2_verifyChainIntegrity` | POST /rpc | anon | None | None | Chain integrity check. `l2-rpc-server.ts` |
| `l2_verifyFinancialBalance` | POST /rpc | anon | None | None | Financial balance verification. `l2-rpc-server.ts` |
| `l2_detectDuplicateClaims` | POST /rpc | anon | None | None | Duplicate claim detection. `l2-rpc-server.ts` |
| `l2_getFormulary` | POST /rpc | anon | planIdHash | None | Formulary for a plan. `l2-rpc-server.ts` |
| `l2_getPlan` | POST /rpc | anon | planId | None | Single benefit plan. `l2-rpc-server.ts` |
| `l2_getPlans` | POST /rpc | anon | None | None | All benefit plans. `l2-rpc-server.ts` |
| `l2_getPlanLimits` | POST /rpc | anon | planId | None | Plan deductible/OOP limits. `l2-rpc-server.ts` |
| `l2_getFormularyCategories` | POST /rpc | anon | None | None | Drug classification categories. `l2-rpc-server.ts` |
| `l2_getFormularyPage` | POST /rpc | anon | filter (object) | None | Paginated formulary search. `l2-rpc-server.ts` |
| `l2_getDrugDetail` | POST /rpc | anon | ndcHash | None | Drug detail by NDC hash. `l2-rpc-server.ts` |
| `l2_checkCoverage` | POST /rpc | anon | planIdHash, ndcHash | None | Check drug coverage under plan. `l2-rpc-server.ts` |
| `l2_estimateCost` | POST /rpc | anon | ndcHash, planId, walletId | None | Estimate member/plan cost. `l2-rpc-server.ts` |
| `l2_getFormularyRoutes` | POST /rpc | anon | None | None | Drug administration routes. `l2-rpc-server.ts` |
| `l2_getFormularyDrugCount` | POST /rpc | anon | None | None | Total formulary drug count. `l2-rpc-server.ts` |
| `l2_getFormularyRoot` | POST /rpc | anon | None | None | Formulary Merkle root. `l2-rpc-server.ts` |
| `l2_getFormularyWitness` | POST /rpc | anon | ndcHash | None | Merkle inclusion proof for drug. `l2-rpc-server.ts` |
| `l2_getClaimsByMember` | POST /rpc | anon | walletId | None | Claims by member wallet. `l2-rpc-server.ts` |
| `l2_getClaimsByPharmacy` | POST /rpc | anon | walletId | None | Claims by pharmacy wallet. `l2-rpc-server.ts` |
| `l2_getClaimsByPrescriber` | POST /rpc | anon | walletId | None | Claims by prescriber wallet. `l2-rpc-server.ts` |
| `l2_getClaimsByNdc` | POST /rpc | anon | ndcHash | None | Claims by drug NDC. `l2-rpc-server.ts` |
| `l2_getClaimWithProof` | POST /rpc | anon | leafIndex | None | Claim + Merkle proof. `l2-rpc-server.ts` |
| `l2_getClaimAccumulatorRoot` | POST /rpc | anon | None | None | Claim accumulator root + count. `l2-rpc-server.ts` |
| `l2_getRegistrationWitnesses` | POST /rpc | anon | None | None | Registry witnesses for proofs. `l2-rpc-server.ts` |
| `l2_getWalletWitnesses` | POST /rpc | anon | walletId | None | Per-wallet witnesses. `l2-rpc-server.ts` |
| `l2_getWalletState` | POST /rpc | anon | walletId | None | Wallet nonce + credential root. `l2-rpc-server.ts` |
| `l2_getMessagesByWallet` | POST /rpc | anon | walletId | None | All messages for wallet. `l2-rpc-server.ts` |
| `l2_getMessagesBySender` | POST /rpc | anon | walletId | None | Messages by sender. `l2-rpc-server.ts` |
| `l2_getMessagesByRecipient` | POST /rpc | anon | walletId | None | Messages by recipient. `l2-rpc-server.ts` |
| `l2_getMessagesByThread` | POST /rpc | anon | threadIdHash | None | Thread messages. `l2-rpc-server.ts` |
| `l2_getMessageStoreRoot` | POST /rpc | anon | None | None | Message store root + count. `l2-rpc-server.ts` |
| `l2_storeMessage` | POST /rpc | anon | walletId (in message) | None | Store encrypted message on-chain. `l2-rpc-server.ts` |
| `l2_getEntity` | POST /rpc | anon | walletId | None | Entity metadata by wallet. `l2-rpc-server.ts` |
| `l2_getProvider` | POST /rpc | anon | walletId | None | Provider record by wallet. `l2-rpc-server.ts` |
| `l2_getProviderByNpi` | POST /rpc | anon | npiHash | None | Provider by NPI hash. `l2-rpc-server.ts` |
| `l2_getNetworkProviders` | POST /rpc | anon | None | None | All credentialed providers. `l2-rpc-server.ts` |
| `l2_getPcpAssignments` | POST /rpc | anon | prescriberWalletId | None | PCP assignments for prescriber. `l2-rpc-server.ts` |
| `l2_getPendingAdmissions` | POST /rpc | anon | None | None | Pending quorum admissions. `l2-rpc-server.ts` |
| `l2_getAdminKeys` | POST /rpc | anon | None | None | List admitted admin keys. `l2-rpc-server.ts` |

#### Admin RPC Methods (auth required — BUT BYPASSED in current deployment)

| Method | Endpoint Path | Required Role | Object ID Parameters | Authorization Mechanism | Description & Code Pointer |
|--------|--------------|---------------|---------------------|------------------------|---------------------------|
| `l2_forceBatch` | POST /rpc | admin* | partitionIndex | `checkAdminAuth()` — **BYPASSED** | Force batch settlement. `l2-rpc-server.ts:182` |
| `l2_storeFormulary` | POST /rpc | admin* | planIdHash | `checkAdminAuth()` — **BYPASSED** | Store/replace formulary. `l2-rpc-server.ts:183` |
| `l2_storePlan` | POST /rpc | admin* | plan.planId | `checkAdminAuth()` — **BYPASSED** | Create/replace benefit plan. `l2-rpc-server.ts:184` |
| `l2_deletePlan` | POST /rpc | admin* | planId | `checkAdminAuth()` — **BYPASSED** | Delete benefit plan. `l2-rpc-server.ts:185` |
| `l2_registerEntity` | POST /rpc | admin* | walletId | `checkAdminAuth()` — **BYPASSED** | Register entity in viz+registry. `l2-rpc-server.ts:186` |
| `l2_credentialProvider` | POST /rpc | admin* | walletId | `checkAdminAuth()` — **BYPASSED** | Credential prescriber/pharmacy. `l2-rpc-server.ts:187` |
| `l2_updateProviderStatus` | POST /rpc | admin* | walletId | `checkAdminAuth()` — **BYPASSED** | Change provider lifecycle state. `l2-rpc-server.ts:188` |
| `l2_requestSnapshot` | POST /rpc | admin* | None | `checkAdminAuth()` — **BYPASSED** | Request state snapshot. `l2-rpc-server.ts:189` |
| `l2_gossipRelay` | POST /rpc | admin* | None | `checkAdminAuth()` — **BYPASSED** | Relay gossip to peer network. `l2-rpc-server.ts:190` |
| `l2_recordFill` | POST /rpc | admin* | memberWalletId, ndcHash | `checkAdminAuth()` — **BYPASSED** | Record pharmacy fill in chain. `l2-rpc-server.ts:191` |
| `l2_publishPlanOverlay` | POST /rpc | admin* | planIdHash | `checkAdminAuth()` — **BYPASSED** | Publish plan formulary overlay. `l2-rpc-server.ts:192` |
| `l2_revokeAdminKey` | POST /rpc | admin* | nodeId | `checkAdminAuth()` — **BYPASSED** | Revoke admin key. `l2-rpc-server.ts:193` |
| `l2_approveAdmission` | POST /rpc | admin* | nodeId | `checkAdminAuth()` — **BYPASSED** | Approve quorum admission. `l2-rpc-server.ts:194` |

### 4.3 Interactive Adjudication Routes (Port 3030, /interactive/* and /node/*)

**ALL routes completely unauthenticated.** Source: `visualizer/engine/interactive-routes.ts`

| Method | Endpoint Path | Required Role | Object ID Parameters | Authorization Mechanism | Description & Code Pointer |
|--------|--------------|---------------|---------------------|------------------------|---------------------------|
| GET | `/interactive/state` | anon | None | None | Full session state dump. `interactive-routes.ts:87` |
| GET | `/interactive/console` | anon | None | None | SSE stream of console events. `interactive-routes.ts:70` |
| POST | `/interactive/register-member` | anon | walletId | None | Register wallet proving context. `interactive-routes.ts:113` |
| POST | `/interactive/enroll` | anon | memberIndex | None | Execute member ZK enrollment. `interactive-routes.ts:143` |
| GET | `/interactive/enroll-status` | anon | memberIndex (query) | None | Poll enrollment job. `interactive-routes.ts:191` |
| POST | `/interactive/enroll-family` | anon | subscriberIndex | None | Enroll subscriber + dependents. `interactive-routes.ts:722` |
| POST | `/interactive/request-prior-auth` | anon | memberWalletId, ndcHash | None | Request prior authorization. `interactive-routes.ts:229` |
| POST | `/interactive/approve-prior-auth` | anon | priorAuthId | None | Approve prior auth (insurer). `interactive-routes.ts:258` |
| POST | `/interactive/deny-prior-auth` | anon | priorAuthId | None | Deny prior auth. `interactive-routes.ts:283` |
| POST | `/interactive/resolve-indices` | anon | prescriberWalletId, pharmacyWalletId | None | Resolve wallet IDs to seed indices. `interactive-routes.ts:307` |
| POST | `/interactive/prescribe` | anon | prescriberIndex, memberWalletId, ndcHash | None | Create prescription + ZK proof. `interactive-routes.ts:343` |
| POST | `/interactive/fill` | anon | prescriptionId | None | Dispense prescription (async). `interactive-routes.ts:383` |
| GET | `/interactive/fill-status` | anon | prescriptionId (query) | None | Poll dispense job. `interactive-routes.ts:436` |
| GET | `/interactive/prescriptions-by-pharmacy` | anon | pharmacyIndex (query) | None | Get prescriptions for pharmacy. `interactive-routes.ts:478` |
| POST | `/interactive/mark-filled` | anon | prescriptionId | None | Mark Rx physically prepared. `interactive-routes.ts:491` |
| POST | `/interactive/prescribe-and-fill` | anon | memberWalletId, ndcHash | None | Combined prescribe+fill. `interactive-routes.ts:510` |
| POST | `/interactive/update-rx-status` | anon | prescriptionId | None | Cancel/reject Rx. `interactive-routes.ts:602` |
| POST | `/interactive/reverse` | anon | prescriptionId, fillIndex | None | Reverse filled Rx + ZK rollback. `interactive-routes.ts:644` |
| POST | `/interactive/assign-pcp` | anon | memberWalletId, prescriberIndex | None | Assign PCP with consent proof. `interactive-routes.ts:673` |
| GET | `/interactive/member-history` | anon | walletId (query) | None | Member Rx history. `interactive-routes.ts:699` |
| GET | `/interactive/family-history` | anon | walletId (query) | None | Family-level history. `interactive-routes.ts:746` |
| POST | `/interactive/terminate-member` | anon | memberWalletId | None | Terminate member + revoke creds. `interactive-routes.ts:769` |
| POST | `/interactive/terminate-group` | anon | groupId | None | Terminate all group members. `interactive-routes.ts:795` |
| POST | `/interactive/send-message` | anon | senderType, body | None | Send encrypted message. `interactive-routes.ts:821` |
| POST | `/interactive/decrypt-thread` | anon | messageIndices[], walletId | None | Batch-decrypt thread messages. `interactive-routes.ts:844` |
| GET | `/interactive/threads` | anon | walletId (query) | None | Get conversation threads. `interactive-routes.ts:867` |
| POST | `/interactive/create-delegation` | anon | delegatorWalletId, delegateWalletId | None | Create ZK delegation proof. `interactive-routes.ts:890` |
| POST | `/interactive/generate-credential` | anon | walletId | None | Generate portable ZK credential (async). `interactive-routes.ts:919` |
| GET | `/interactive/credential-status` | anon | walletId, proofType (query) | None | Poll credential job. `interactive-routes.ts:966` |
| POST | `/interactive/verify-credential` | anon | None (credential in body) | None | Offline verify credential. `interactive-routes.ts:1007` |
| POST | `/interactive/update-formulary` | anon | None | None | Modify/remove/add formulary entries. `interactive-routes.ts:1028` |
| POST | `/interactive/update-provider-network` | anon | None | None | Add/remove prescribers from network. `interactive-routes.ts:1052` |
| POST | `/interactive/plan-year-rollover` | anon | None | None | Reset all accumulators (plan year). `interactive-routes.ts:1076` |
| GET | `/interactive/step-therapy-check` | anon | memberWalletId, ndcHash (query) | None | Step therapy eligibility check. `interactive-routes.ts:1099` |
| GET | `/interactive/l2-status` | anon | None | None | Full L2 chain state dump. `interactive-routes.ts:1125` |
| POST | `/interactive/force-batch` | anon | None | None | Force batch settlement (no auth!). `interactive-routes.ts:1166` |
| POST | `/interactive/save-checkpoint` | anon | None | None | Save state checkpoint to disk. `interactive-routes.ts:1185` |
| POST | `/interactive/retry-batch` | anon | batchNumber | None | Retry failed batch. `interactive-routes.ts:1200` |
| POST | `/interactive/simulate-batch-failure` | anon | batchNumber | None | Simulate batch failure (testing). `interactive-routes.ts:1227` |
| POST | `/interactive/reset` | anon | None | None | Full session reset. `interactive-routes.ts:1255` |
| GET | `/interactive/badge/list` | anon | None | None | List provider NFC badges. `interactive-routes.ts` |
| POST | `/interactive/badge/tap` | anon | None | None | Simulate badge tap + ZK proof. `interactive-routes.ts` |
| POST | `/interactive/badge/auto-tap` | anon | None | None | Auto-tap all providers. `interactive-routes.ts` |
| GET | `/interactive/badge/:key` | anon | key (path) | None | Get specific badge payload. `interactive-routes.ts` |
| GET | `/node/state` | anon | None | None | Session state + full seed data. `interactive-routes.ts:1269` |
| GET | `/node/claims-by-member` | anon | walletId (query) | None | Member claim data. `interactive-routes.ts:1317` |
| GET | `/node/claims-by-prescriber` | anon | walletId (query) | None | Prescriber claim data. `interactive-routes.ts:1342` |
| GET | `/node/claims-by-pharmacy` | anon | walletId (query) | None | Pharmacy claim data. `interactive-routes.ts:1367` |
| GET | `/node/claims-by-ndc` | anon | ndcHash (query) | None | Drug claim data. `interactive-routes.ts:1392` |
| GET | `/node/receipts-by-wallet` | anon | walletId (query) | None | Receipts for a wallet. `interactive-routes.ts:1417` |
| GET | `/node/dur` | anon | memberWalletId (query) | None | Cross-pharmacy DUR view. `interactive-routes.ts:1442` |
| GET | `/node/claim-proof` | anon | leafIndex (query) | None | Claim + Merkle proof. `interactive-routes.ts:1472` |
| GET | `/node/formulary` | anon | planIdHash (query) | None | Formulary for plan. `interactive-routes.ts:1498` |
| GET | `/node/all-receipts` | anon | None | None | All receipts (insurer view). `interactive-routes.ts:1523` |
| GET | `/node/all-batches` | anon | None | None | All batches (insurer view). `interactive-routes.ts:1540` |
| GET | `/node/audit-log` | anon | None | None | Audit log (insurer view). `interactive-routes.ts:1557` |
| GET | `/node/chain-proof` | anon | None | None | Latest chain proof. `interactive-routes.ts:1584` |

### 4.4 Nautilus Entity Node Endpoints

#### Member Node (Port 4001) — `src/nodes/routes/member-routes.ts`

| Method | Endpoint Path | Required Role | Object ID Parameters | Authorization Mechanism | Description |
|--------|--------------|---------------|---------------------|------------------------|-------------|
| GET | `/health` | anon | None | None | Node health |
| GET | `/onboarding/status` | anon | None | None | Current onboarding phase |
| POST | `/onboarding/unlock` | anon | None | None (phase-gated) | Unlock encrypted local state with PIN |
| POST | `/onboarding/accept-token` | anon | None | None (phase: awaiting_token) | Accept employer enrollment token |
| POST | `/onboarding/generate-key` | anon | None | None (phase: token_received) | Generate enrollment key |
| POST | `/onboarding/derive-wallet` | anon | None | None (phase: key_generated) | **PHI endpoint** — derive wallet from cardholderId+DOB+name |
| POST | `/onboarding/enroll` | anon | insurerUrl (SSRF) | None (phase: wallet_derived) | **SSRF** — calls `fetch(insurerUrl + '/enrollment/process')`. `member-routes.ts:244` |
| POST | `/onboarding/compile` | anon | None | None (phase: enrolled) | Compile ZK circuits |
| POST | `/onboarding/backup-key` | anon | None | None | Export encrypted key backup |
| POST | `/onboarding/restore-key` | anon | None | None | Restore key from backup |
| POST | `/proof/registration` | anon | None | None | Generate ZK registration proof |
| POST | `/proof/pcp-assignment` | anon | None | None | Generate PCP ZK proof |
| GET | `/drugs` | anon | None | None | Full drug history from chain |
| GET | `/drugs/summary` | anon | None | None | Activity summary |
| GET | `/drugs/range` | anon | start, end (query) | None | Drug history by date range |
| GET | `/drugs/medication/:ndcHash` | anon | ndcHash | None | Claims for a medication |
| GET | `/drugs/claim/:leafIndex` | anon | leafIndex | None | Single claim + Merkle proof |
| GET | `/drugs/tree-status` | anon | None | None | Claim accumulator tree status |
| GET | `/receipts` | anon | None | None | All sequencer receipts |
| GET | `/formulary/:planIdHash` | anon | planIdHash | None | Formulary for plan |
| GET | `/formulary-page` | anon | None | None | Paginated formulary search |
| GET | `/formulary-drug-count` | anon | None | None | Total formulary drug count |
| POST | `/pcp/assign` | anon | None | None | Save PCP to local state |
| GET | `/pcp/current` | anon | None | None | Current PCP |
| DELETE | `/pcp/current` | anon | None | None | Remove PCP |
| GET | `/nfc/id-payload` | anon | None | None | NFC NDEF record |
| GET | `/nfc/id-qr` | anon | None | None | QR payload for pharmacy scan |
| POST | `/messaging/send` | anon | None | None | Send encrypted message |
| GET | `/messaging/inbox` | anon | None | None | Inbox messages |
| GET | `/messaging/sent` | anon | None | None | Sent messages |
| GET | `/messaging/thread/:threadIdHash` | anon | threadIdHash | None | Thread messages |
| GET | `/events` | anon | None | None | SSE event stream |
| POST | `/rpc` | anon | None | None | Proxy to sequencer |

#### Prescriber Node (Port 4002) — `src/nodes/routes/prescriber-routes.ts`

| Method | Endpoint Path | Required Role | Object ID Parameters | Authorization Mechanism | Description |
|--------|--------------|---------------|---------------------|------------------------|-------------|
| POST | `/onboarding/enroll` | anon | insurerUrl (SSRF) | None (phase: wallet_derived) | **SSRF + Admin token leak** — forwards `Authorization: Bearer adminToken` to insurerUrl. `prescriber-routes.ts:224` |
| POST | `/prescriptions/write` | anon | None | None | Write e-Script via messages |
| POST | `/prescriptions/prescribe` | anon | None | None | Write e-Script + ZK proof (async) |
| GET | `/prescriptions/prescribe-status` | anon | jobKey (query) | None | Poll ZK proof job |
| GET | `/prescriptions` | anon | None | None | Full prescribing history |
| GET | `/prescriptions/summary` | anon | None | None | Activity summary |
| GET | `/prescriptions/range` | anon | start, end (query) | None | History by date range |
| GET | `/prescriptions/patient/:memberWalletId` | anon | memberWalletId | None | Claims for a patient |
| GET | `/prescriptions/medication/:ndcHash` | anon | ndcHash | None | Claims for a drug |
| GET | `/prescriptions/pharmacy/:pharmacyWalletId` | anon | pharmacyWalletId | None | Claims to a pharmacy |
| GET | `/prescriptions/patients/count` | anon | None | None | Unique patient count |
| GET | `/network/check/:walletId` | anon | walletId | None | Check if wallet is in-network |
| GET | `/formulary/:planIdHash` | anon | planIdHash | None | Formulary for plan |
| GET | `/pcp/patients` | anon | None | None | Patients assigned to this PCP |

#### Pharmacy Node (Port 4003) — `src/nodes/routes/pharmacy-routes.ts`

| Method | Endpoint Path | Required Role | Object ID Parameters | Authorization Mechanism | Description |
|--------|--------------|---------------|---------------------|------------------------|-------------|
| POST | `/onboarding/enroll` | anon | insurerUrl (SSRF) | None (phase: wallet_derived) | **SSRF + Admin token leak** — same as prescriber. `pharmacy-routes.ts:145` |
| POST | `/dispensing/mark-filled` | anon | prescriptionId | None | Mark Rx physically filled |
| POST | `/dispensing/dispense` | anon | None | None | Dispense Rx with ZK proofs (async) |
| GET | `/dispensing/fill-status` | anon | jobKey (query) | None | Poll dispense job |
| POST | `/dispensing/fill` | anon | None | None | Legacy prescribe+fill |
| POST | `/dispensing/reverse` | anon | None | None | Reverse fill with ZK proof (async) |
| GET | `/dispensing` | anon | None | None | Full dispensing history |
| GET | `/dispensing/patient/:memberWalletId` | anon | memberWalletId | None | Claims for a patient |
| GET | `/dispensing/prescriber/:prescriberWalletId` | anon | prescriberWalletId | None | Claims from a prescriber |
| GET | `/dispensing/medication/:ndcHash` | anon | ndcHash | None | Claims for a drug |
| GET | `/prescriptions/list` | anon | None | None | All prescriptions for pharmacy |
| GET | `/dur/patient/:memberWalletId/full-history` | anon | memberWalletId | None | Cross-pharmacy claim history |
| GET | `/dur/patient/:memberWalletId/active-medications` | anon | memberWalletId | None | Active medications |
| GET | `/dur/patient/:memberWalletId/check/:ndcHash` | anon | memberWalletId, ndcHash | None | Active claim check for drug |
| GET | `/dur/claim/:leafIndex` | anon | leafIndex | None | Claim + Merkle proof |
| POST | `/nfc/scan` | anon | None | None | Accept member identity via NFC/QR |

#### Insurer Node (Port 4004) — `src/nodes/routes/insurer-routes.ts`

| Method | Endpoint Path | Required Role | Object ID Parameters | Authorization Mechanism | Description |
|--------|--------------|---------------|---------------------|------------------------|-------------|
| POST | `/onboarding/configure` | anon | None | None | Configure insurer node |
| POST | `/enrollment/process` | anon | walletId, tokenId | None | **Open enrollment** — accepts any walletId existing on sequencer. `insurer-routes.ts:107` |
| GET | `/roster` | anon | groupId, role (query) | None | Live member roster |
| POST | `/roster/register` | admin | walletId | Bearer token | Register enrollment |
| GET | `/receipts/all` | anon | None | None | All receipts paginated |
| GET | `/batches/all` | anon | None | None | All batches paginated |
| GET | `/audit/log` | anon | None | None | Audit log |
| GET | `/chain-proof` | anon | None | None | Latest chain proof |
| GET | `/claims/member/:walletId` | anon | walletId | None | Claims for member |
| GET | `/claims/prescriber/:walletId` | anon | walletId | None | Claims by prescriber |
| GET | `/claims/pharmacy/:walletId` | anon | walletId | None | Claims at pharmacy |
| GET | `/claims/drug/:ndcHash` | anon | ndcHash | None | Claims for drug |
| GET | `/audit/chain-integrity` | anon | None | None | Chain integrity check |
| GET | `/audit/financial-balance` | anon | None | None | Financial balance check |
| GET | `/audit/duplicate-claims` | anon | None | None | Duplicate claim detection |
| POST | `/audit/full` | admin | None | Bearer token | Full audit suite |
| POST | `/reports/claims-register` | anon | None | None | Full claims register |
| POST | `/reports/pharmacy-activity` | anon | None | None | Per-pharmacy activity |
| POST | `/reports/prescriber-activity` | anon | None | None | Per-prescriber activity |
| POST | `/reports/member-activity` | anon | None | None | Per-member activity |
| POST | `/reports/medication-utilization` | anon | None | None | Drug utilization |
| POST | `/reports/financial-summary` | anon | None | None | Financial summary |
| POST | `/reports/prior-auth` | anon | None | None | PA requests/outcomes |
| POST | `/reports/reversals` | anon | None | None | Reversed claims |
| POST | `/reports/tier-analysis` | anon | None | None | Formulary tier usage |
| POST | `/reports/therapeutic-class` | anon | None | None | Drug class analysis |
| POST | `/reports/time-series` | anon | None | None | Time-bucketed claim volume |
| POST | `/reports/cross-tab` | anon | None | None | Pivot table reports |
| POST | `/admin/formulary/publish` | admin | None | Bearer token | Publish formulary to sequencer |
| POST | `/admin/batch/force` | admin | None | Bearer token | Force batch settlement |
| POST | `/credentialing/apply` | anon | None | None | Provider credentialing application |
| POST | `/credentialing/verify/:id` | admin | id (path) | Bearer token | Mark application verified |
| POST | `/credentialing/approve/:id` | admin | id (path) | Bearer token | Approve + credential on sequencer |
| POST | `/credentialing/deny/:id` | admin | id (path) | Bearer token | Deny application |
| GET | `/credentialing/applications` | anon | None | None | List applications |
| GET | `/credentialing/status/:walletId` | anon | walletId | None | Provider registry status |
| POST | `/credentialing/suspend/:walletId` | admin | walletId | Bearer token | Suspend provider |
| POST | `/credentialing/terminate/:walletId` | admin | walletId | Bearer token | Terminate provider |
| GET | `/credentialing/registry` | anon | None | None | Full provider registry |
| GET | `/plans` | anon | None | None | List all plans |
| GET | `/plans/:planId` | anon | planId | None | Get specific plan |
| POST | `/plans` | admin | None | Bearer token | Create plan + publish overlay |
| PUT | `/plans/:planId` | admin | planId | Bearer token | Update plan |
| DELETE | `/plans/:planId` | admin | planId | Bearer token | Delete plan |
| POST | `/plans/:planId/publish` | admin | planId | Bearer token | Publish formulary overlay |

#### Employer Node (Port 4005) — `src/nodes/routes/employer-routes.ts`

| Method | Endpoint Path | Required Role | Object ID Parameters | Authorization Mechanism | Description |
|--------|--------------|---------------|---------------------|------------------------|-------------|
| POST | `/onboarding/configure` | anon | insurerUrl (SSRF stored) | None | **SSRF storage** — stores insurerUrl for later use. `employer-routes.ts:36` |
| GET | `/groups` | anon | None | None | List groups |
| GET | `/groups/:groupId` | anon | groupId | None | Get specific group |
| POST | `/groups` | admin | None | Bearer token | Create group |
| DELETE | `/groups/:groupId` | admin | groupId | Bearer token | Delete group |
| POST | `/tokens/generate` | admin | None | Bearer token | Generate enrollment token |
| GET | `/tokens/:tokenId` | admin | tokenId | Bearer token | Get token details |
| POST | `/tokens/:tokenId/revoke` | admin | tokenId | Bearer token | Revoke token |
| POST | `/tokens/:tokenId/submit` | admin | tokenId | Bearer token | Submit token to insurer (triggers SSRF) |
| POST | `/tokens/:tokenId/validate` | anon | tokenId | None | Validate token status |
| POST | `/enrollment/confirm` | anon | None | None | Confirm enrollment notification |
| GET | `/roster` | anon | None | None | Full employee roster |
| GET | `/roster/:employeeIdHash` | anon | employeeIdHash | None | Get roster entry |
| DELETE | `/roster/:employeeIdHash` | admin | employeeIdHash | Bearer token | Remove from roster |
| GET | `/sequencer/chain-state` | anon | None | None | Chain state proxy |
| GET | `/plans/available` | anon | None | None | Available plans |

#### Explorer (Port 8000) — `src/nodes/start-explorer.ts`

| Method | Endpoint Path | Required Role | Object ID Parameters | Authorization Mechanism | Description |
|--------|--------------|---------------|---------------------|------------------------|-------------|
| GET | `/health` | anon | None | None | Health check (proxied from seq) |
| GET | `/events` | anon | None | None | SSE proxy to sequencer |
| POST | `/rpc` | anon | None | None | Transparent RPC proxy to sequencer |
| GET | `/viz/*` | anon | pathname + query (partial SSRF) | None | **Wildcard proxy** — concatenates user-controlled path+query to sequencer URL. `start-explorer.ts:130` |
| GET | `/*` | anon | None | None | Static explorer dashboard files |

---

## 5. Potential Input Vectors for Vulnerability Analysis

### URL Parameters (Query Strings)

- `GET /interactive/enroll-status?memberIndex=N` — integer, passed to job map lookup (`interactive-routes.ts:191`)
- `GET /interactive/fill-status?prescriptionId=X` — string, job map key (`interactive-routes.ts:436`)
- `GET /interactive/prescriptions-by-pharmacy?pharmacyIndex=N` — integer (`interactive-routes.ts:478`)
- `GET /interactive/member-history?walletId=X` — string, passed to chain queries (`interactive-routes.ts:699`)
- `GET /interactive/family-history?walletId=X` — string (`interactive-routes.ts:746`)
- `GET /interactive/threads?walletId=X` — string (`interactive-routes.ts:867`)
- `GET /interactive/credential-status?walletId=X&proofType=Y` — strings (`interactive-routes.ts:966`)
- `GET /interactive/step-therapy-check?memberWalletId=X&ndcHash=Y` — strings (`interactive-routes.ts:1099`)
- `GET /node/claims-by-member?walletId=X` — string (`interactive-routes.ts:1317`)
- `GET /node/dur?memberWalletId=X` — string (`interactive-routes.ts:1442`)
- `GET /node/claim-proof?leafIndex=N` — integer, `BigInt()` conversion (`interactive-routes.ts:1472`)
- `GET /node/formulary?planIdHash=X` — string (`interactive-routes.ts:1498`)
- `GET /viz/*` (explorer port 8000) — entire path after `/viz/` is user-controlled and concatenated to sequencer URL (`start-explorer.ts:130`)
- `GET /drugs/range?start=X&end=Y` — date strings (member node, `member-routes.ts`)
- `GET /dispensing/range?start=X&end=Y` — date strings (pharmacy node)
- `GET /prescriptions/range?start=X&end=Y` — date strings (prescriber node)
- `GET /roster?groupId=X&role=Y` — strings used in `===` filter (insurer node, `insurer-routes.ts`)

### POST Body Fields (JSON)

- `POST /onboarding/enroll` (ports 4001, 4002, 4003): `insurerUrl` (string, full SSRF — `member-routes.ts:256`, `prescriber-routes.ts:228`, `pharmacy-routes.ts:149`)
- `POST /onboarding/configure` (port 4005): `insurerUrl` (string, stored SSRF — `employer-routes.ts:36`)
- `POST /interactive/register-member`: `walletId`, `preimageFields[]`, `displayName`, `groupId`, `planId`, `familyId`, `relationship`, `employeeId`, `publicKeyHex` — passed to `AdjudicationSessionService` (`interactive-routes.ts:113`)
- `POST /interactive/prescribe`: `prescriberIndex`, `memberWalletId`, `ndcHash`, `pharmacyIndex`, `quantity`, `refills`, `rxId` (`interactive-routes.ts:343`)
- `POST /interactive/fill`: `prescriptionId`, `quantityDispensed`, `ingredientCostCents`, `dispensingFeeCents` (`interactive-routes.ts:383`)
- `POST /interactive/send-message`: `senderType`, `recipientType`, `subject`, `body` — entire params forwarded to encryption service (`interactive-routes.ts:821`)
- `POST /interactive/retry-batch`: `batchNumber` — passed to `BigInt()` (`interactive-routes.ts:1200`)
- `POST /interactive/simulate-batch-failure`: `batchNumber` — passed to `BigInt()` (`interactive-routes.ts:1227`)
- `POST /interactive/update-formulary`: formulary entries (`interactive-routes.ts:1028`)
- `POST /rpc` → `l2_submitProof`: `proofJson` (object), `entityMetadata.displayName` (stored in viz registry)
- `POST /rpc` → `l2_storeFormulary`: `planIdHash`, `formularyRoot`, `entriesJson` — formulary data stored and served back via dashboards
- `POST /rpc` → `l2_recordFill`: `memberWalletId`, `ndcHash`, `pharmacyWalletId`, `prescriberWalletId`, `patientPayCents`, `planPayCents` — inserted into claim accumulator
- `POST /rpc` → `l2_storeMessage`: full message + payload objects
- `POST /rpc` → `l2_getFormularyPage`: `filter` object passed directly to search function (`l2-rpc-server.ts:~1260`)
- `POST /rpc` → `l2_gossipRelay`: full `GossipMessage` object including `knownPeers` URL array (SSRF via gossip)
- `POST /enrollment/process` (port 4004): `walletId`, `tokenId`, `role`, `groupId`, `planId`, `employerId` (`insurer-routes.ts:107`)
- `POST /reports/*` (port 4004): `filter`, `claims[]`, `timeBucket`, `groupBy`
- `POST /credentialing/apply` (port 4004): provider application fields
- `POST /plans` (port 4004): full `BenefitPlanConfig` object
- `POST /viz/emit` (port 3030): `type`, `actor`, `data`, `lane` — **stored in history buffer and served back via SSE to all dashboard clients** (XSS vector)

### HTTP Headers

- `Authorization: Bearer <token>` — used by all admin-auth endpoints on both server types
- `X-Admin-Signature: <nodeId>:<timestamp>:<signatureHex>` — Ed25519 admin auth in secure mode (`l2-rpc-server.ts:2434`)
- `Last-Event-ID` — SSE reconnect header, used in ring buffer replay on `/events` and `/viz/events`

### Cookie Values

**No cookies used.** Confirmed by code analysis and live testing — zero `Set-Cookie` headers anywhere in the codebase.

---

## 6. Network & Interaction Map

### 6.1 Entities

| Title | Type | Zone | Tech | Data | Notes |
|-------|------|------|------|------|-------|
| Leviathan-Sequencer | Service | App | Node.js 22, raw HTTP, JSON-RPC 2.0 | PII, Tokens, PHI-hashes | Central L2 blockchain node, port 3030. Admin auth bypassed. |
| Member-Node | Service | App | Node.js 22, raw HTTP | PII, PHI | Entity node for patients, port 4001. Phase: awaiting_token. |
| Prescriber-Node | Service | App | Node.js 22, raw HTTP | PII | Entity node for prescribers, port 4002. Phase: ready. |
| Pharmacy-Node | Service | App | Node.js 22, raw HTTP | PII | Entity node for pharmacies, port 4003. Phase: ready. |
| Insurer-Node | Service | App | Node.js 22, raw HTTP | PII, Tokens, Financial | Entity node for insurer, port 4004. Phase: ready. |
| Employer-Node | Service | App | Node.js 22, raw HTTP | PII, Tokens | Entity node for employer, port 4005. Phase: ready. |
| Explorer | Service | App | Node.js 22, raw HTTP | Public | Block explorer + sequencer proxy, port 8000. |
| L2-InMemoryState | DataStore | Data | Custom Merkle trees, JSON checkpoints | PII-hashes, Tokens, Financial | No encryption on checkpoints. WAL HMAC-protected. |
| Nautilus-LocalState | DataStore | Data | AES-256-GCM + scrypt, JSON files | PII, Tokens, Secrets | Encrypted entity state per node. |
| InteractiveEngine | Service | App | AdjudicationSessionService | PII, Financial | 40+ unauthenticated endpoints on same process as Leviathan. |
| ExternalInsurer | ThirdParty | Internet | Any HTTP server | Tokens, Secrets | User-controlled URL; receives admin token via Authorization header. |
| ProofDelegate | Service | App | Node.js, HTTP, ZK workers | Public | ZK proof compilation workers, optional API key auth. |

### 6.2 Entity Metadata

| Title | Metadata Key: Value |
|-------|---------------------|
| Leviathan-Sequencer | Host: `http://host.docker.internal:3030`; Endpoints: `/rpc`, `/health`, `/events`, `/viz/*`, `/interactive/*`, `/node/*`, static files; Auth: Bearer token (bypassed) or Ed25519 (not configured); CORS: `*`; TLS: None |
| Member-Node | Host: `http://host.docker.internal:4001`; Endpoints: `/onboarding/*`, `/drugs/*`, `/receipts`, `/formulary/*`, `/pcp/*`, `/nfc/*`, `/messaging/*`, `/proof/*`; Auth: None (no admin routes active); TLS: None; Phase: awaiting_token |
| Prescriber-Node | Host: `http://host.docker.internal:4002`; Endpoints: `/onboarding/*`, `/prescriptions/*`, `/network/*`, `/formulary/*`, `/messaging/*`; Auth: None on all current routes; TLS: None; Phase: ready |
| Pharmacy-Node | Host: `http://host.docker.internal:4003`; Endpoints: `/onboarding/*`, `/dispensing/*`, `/dur/*`, `/prescriptions/*`, `/nfc/*`; Auth: None; TLS: None; Phase: ready |
| Insurer-Node | Host: `http://host.docker.internal:4004`; Endpoints: `/onboarding/*`, `/enrollment/*`, `/roster/*`, `/receipts/*`, `/claims/*`, `/audit/*`, `/reports/*`, `/admin/*`, `/credentialing/*`, `/plans/*`; Auth: Bearer token required for admin routes; TLS: None; Admin token: configured |
| Employer-Node | Host: `http://host.docker.internal:4005`; Endpoints: `/onboarding/*`, `/groups/*`, `/tokens/*`, `/roster/*`, `/enrollment/*`, `/sequencer/*`; Auth: Bearer token for admin routes; TLS: None |
| Explorer | Host: `http://host.docker.internal:8000`; Endpoints: `/rpc`, `/health`, `/events`, `/viz/*` (proxy), static files; Auth: None; Proxy target: Leviathan-Sequencer |
| L2-InMemoryState | Engine: Custom Merkle forest; Exposure: Process memory + file system; Consumers: Leviathan-Sequencer, InteractiveEngine; Checkpoints: JSON at `dataDir/`, `0o600` permissions, NOT encrypted |
| ProofDelegate | Host: configurable proverUrl; Auth: `X-Api-Key` (default: `dev-key`); Consumers: Leviathan-Sequencer worker pool |

### 6.3 Flows (Connections)

| FROM → TO | Channel | Path/Port | Guards | Touches |
|-----------|---------|-----------|--------|---------|
| User Browser → Leviathan-Sequencer | HTTP | `:3030 /health` | None | Public |
| User Browser → Leviathan-Sequencer | HTTP | `:3030 /rpc (public methods)` | None | PII-hashes, Tokens |
| User Browser → Leviathan-Sequencer | HTTP | `:3030 /rpc (admin methods)` | auth:admin (BYPASSED) | PII, Financial, Secrets |
| User Browser → Leviathan-Sequencer | HTTP | `:3030 /viz/emit, /viz/entities, /viz/clear` | auth:admin (BYPASSED) | Public |
| User Browser → Leviathan-Sequencer | HTTP | `:3030 /interactive/*` | None | PII, Financial |
| User Browser → Leviathan-Sequencer | HTTP | `:3030 /node/*` | None | PII, Financial |
| User Browser → Leviathan-Sequencer | HTTP | `:3030 /events` | None | Public |
| User Browser → Leviathan-Sequencer | HTTP | `:3030 static files` | None | Public |
| User Browser → Member-Node | HTTP | `:4001 /onboarding/*` | phase-check:in-memory | PHI |
| User Browser → Member-Node | HTTP | `:4001 /onboarding/enroll` | phase-check:wallet_derived | PHI + SSRF:user-url |
| User Browser → Prescriber-Node | HTTP | `:4002 /onboarding/enroll` | phase-check | PII + SSRF:user-url + admin-token-leak |
| User Browser → Pharmacy-Node | HTTP | `:4003 /onboarding/enroll` | phase-check | PII + SSRF:user-url + admin-token-leak |
| User Browser → Insurer-Node | HTTP | `:4004 /enrollment/process` | None | PII, Tokens |
| User Browser → Insurer-Node | HTTP | `:4004 /reports/*` | None | Financial, PII |
| User Browser → Insurer-Node | HTTP | `:4004 /credentialing/*` (admin) | auth:admin (token configured) | PII |
| User Browser → Employer-Node | HTTP | `:4005 /onboarding/configure` | None | Tokens |
| User Browser → Employer-Node | HTTP | `:4005 /tokens/*` (admin) | auth:admin (token configured) | Tokens |
| User Browser → Explorer | HTTP | `:8000 /viz/*` | None | path:user-controlled proxy |
| Explorer → Leviathan-Sequencer | HTTP | `:3030 /viz/*, /rpc, /events` | None | Public |
| Member-Node → ExternalInsurer | HTTP | user-controlled URL | None | Tokens (SSRF-1) |
| Prescriber-Node → ExternalInsurer | HTTP | user-controlled URL | None | Tokens + Secrets:adminToken (SSRF-2) |
| Pharmacy-Node → ExternalInsurer | HTTP | user-controlled URL | None | Tokens + Secrets:adminToken (SSRF-3) |
| Employer-Node → ExternalInsurer | HTTP | user-controlled URL (stored) | auth:admin (at submit step) | Tokens (SSRF-4) |
| Entity-Nodes → Leviathan-Sequencer | HTTP | `:3030 /rpc (proxy)` | None | PII-hashes, Tokens |
| Leviathan-Sequencer → ProofDelegate | HTTP | configurable proverUrl | api-key:dev-key | Public |
| Leviathan-Sequencer ↔ Peers | HTTP (gossip) | configurable peer URLs | hmac:optional (not configured) | Public |
| Leviathan-Sequencer → L2-InMemoryState | File | dataDir/*.json | os:0o600 | PII-hashes, Financial |

### 6.4 Guards Directory

| Guard Name | Category | Statement |
|-----------|----------|-----------|
| auth:admin:L2RPC | Auth | Requires Bearer token in `Authorization` header matching `ZKTRIDENT_ADMIN_TOKEN` env var, OR valid Ed25519 signature. **CRITICAL: When `adminToken` is undefined and admin key registry is empty, returns true unconditionally.** Implemented: `l2-rpc-server.ts:2470–2481` |
| auth:admin:Nautilus | Auth | Requires Bearer token matching `ZKTRIDENT_ADMIN_TOKEN`. When token is NOT configured, returns HTTP 403 (different from L2 behavior). NOT timing-safe (plain `!==`). Implemented: `nautilus-app-server.ts:295–303` |
| auth:ed25519 | Auth | Ed25519 signature verification for admin operations in secure mode. 30-second replay window, no per-nonce protection. `l2-rpc-server.ts:2427–2468` |
| phase:awaiting_token | Authorization | Requires `server.getOnboardingPhase() === 'awaiting_token'`. In-memory only — resets on process restart. `member-routes.ts`, `prescriber-routes.ts`, etc. |
| phase:token_received | Authorization | Requires phase = `token_received`. `member-routes.ts` |
| phase:key_generated | Authorization | Requires phase = `key_generated`. `member-routes.ts` |
| phase:wallet_derived | Authorization | Requires phase = `wallet_derived`. Controls access to SSRF-vulnerable `/onboarding/enroll`. `member-routes.ts:244` |
| phase:enrolled | Authorization | Requires phase = `enrolled`. `member-routes.ts` |
| zkproof:wallet | Protocol | ZK proof-of-wallet-ownership via `ProofGateProgram`. Proves knowledge of PHI preimage without revealing it. Only checked at `l2_submitProof` — REST layer does not re-verify. `proof-gate.ts` |
| cors:wildcard | Protocol | `Access-Control-Allow-Origin: *` set on all responses by all services. No `Access-Control-Allow-Credentials`. Allows unauthenticated cross-origin requests from any origin. |
| body:size:20MB | RateLimit | Maximum body size 20MB on L2 RPC server. `l2-rpc-server.ts:128` |
| body:size:5MB | RateLimit | Maximum body size 5MB on Nautilus nodes. `nautilus-app-server.ts:43` |
| body:size:none | RateLimit | **No body size limit** on `/interactive/*` routes. `interactive-routes.ts:2026` — DoS vector. |
| ratelimit:proofs | RateLimit | 60 proof submissions per IP per minute, sliding window. Only applies to `l2_submitProof`. `l2-rpc-server.ts` |
| gossip:hmac | Protocol | HMAC-SHA256 gossip authentication. **Not configured by default** — when `gossipSecret` is undefined, all gossip messages are accepted unconditionally. `l2-peer-network.ts:654` |
| timeout:30s | Protocol | 30-second request timeout on all non-SSE requests (both server types). |
| path:regex:alphanumeric | Protocol | Static file paths validated against `/^[/a-zA-Z0-9._-]+$/` regex and `!includes('..')`. Nautilus server lacks secondary `path.resolve().startsWith()` check. |

---

## 7. Role & Privilege Architecture

### 7.1 Discovered Roles

| Role Name | Privilege Level | Scope/Domain | Code Implementation |
|-----------|----------------|--------------|---------------------|
| anon | 0 | Global | No authentication. All public RPC methods and unauthenticated routes. |
| member | 1 | Member node only | Static role of port 4001 node. Onboarding phases enforce lifecycle. |
| prescriber | 2 | Prescriber node only | Static role of port 4002 node. |
| pharmacy | 3 | Pharmacy node only | Static role of port 4003 node. |
| insurer | 4 | Insurer node only | Static role of port 4004 node. Has admin-protected operations. |
| employer | 5 | Employer node only | Static role of port 4005 node. Has admin-protected operations. |
| admin:L2 | 9 | L2 Sequencer global | Bearer token or Ed25519 signature. **BYPASSED** when no token configured. Controls all 13 admin RPC methods and 3 viz REST endpoints. |
| admin:Nautilus | 8 | Per entity node | Bearer token per node. Controls token management, group management, credentialing approval. |

### 7.2 Privilege Lattice

```
Privilege Ordering (→ means "can access resources of"):
anon → member → admin:Nautilus(insurer) → admin:L2

Parallel Isolation (|| means "not ordered relative to each other"):
member || prescriber || pharmacy (all peer entities, no cross-service auth)
insurer:admin || employer:admin (both admin, isolated to their own node)

Special Cases:
- admin:L2 IS EFFECTIVELY anon (auth bypass in current deployment)
- interactive routes: effectively anon for ALL operations on those endpoints
- All nodes share no session state — there is no single "logged in" user
```

### 7.3 Role Entry Points

| Role | Default Landing Page | Accessible Route Patterns | Authentication Method |
|------|---------------------|--------------------------|----------------------|
| anon | `http://host.docker.internal:3030/` | All `/rpc` public methods, `/health`, `/events`, `/viz/events`, `/viz/state`, `/viz/history`, `/viz/entities`, `/interactive/*`, `/node/*` | None |
| anon (admin bypass) | Same | All admin RPC methods (`/rpc`), `/viz/emit`, `/viz/entities` (POST), `/viz/clear` | None (bypass) |
| member | `http://host.docker.internal:4001/` | `/onboarding/*`, `/drugs/*`, `/receipts`, `/formulary/*`, `/pcp/*`, `/nfc/*`, `/messaging/*`, `/proof/*` | None (phase-gated) |
| prescriber | `http://host.docker.internal:4002/` | `/onboarding/*`, `/prescriptions/*`, `/network/*`, `/formulary/*` | None |
| pharmacy | `http://host.docker.internal:4003/` | `/onboarding/*`, `/dispensing/*`, `/dur/*`, `/nfc/*` | None |
| insurer | `http://host.docker.internal:4004/` | `/enrollment/*`, `/roster`, `/receipts/*`, `/claims/*`, `/audit/*`, `/reports/*`, `/credentialing/*`, `/plans/*` | None (open) + Bearer for admin |
| employer | `http://host.docker.internal:4005/` | `/onboarding/*`, `/groups/*`, `/tokens/*`, `/roster/*`, `/enrollment/*` | None (open) + Bearer for admin |
| admin:L2 | N/A (RPC only) | All `/rpc` methods, `/viz/emit`, `/viz/entities`, `/viz/clear` | Bearer token or Ed25519 (bypassed) |

### 7.4 Role-to-Code Mapping

| Role | Middleware/Guards | Permission Checks | Storage Location |
|------|------------------|-------------------|-----------------|
| anon | None | None | N/A |
| admin:L2 | `ADMIN_METHODS` Set check in `handleRpc()` | `checkAdminAuth()` — returns true if no token configured | `ZKTRIDENT_ADMIN_TOKEN` env var |
| admin:Nautilus | `adminOnly: true` flag on `RouteRegistration` | `authHeader !== \`Bearer ${adminToken}\`` — NOT timing-safe | `ZKTRIDENT_ADMIN_TOKEN` env var per node |
| member (phase) | Phase check in each handler | `server.getOnboardingPhase() !== expectedPhase` | In-memory `NautilusAppServer` state + encrypted `NautilusLocalState` |
| ZK wallet identity | None at REST layer | `ProofGateProgram.verify()` at `l2_submitProof` only | Poseidon hash in Merkle tree |

---

## 8. Authorization Vulnerability Candidates

### 8.1 Horizontal Privilege Escalation Candidates

| Priority | Endpoint Pattern | Object ID Parameter | Data Type | Sensitivity |
|----------|-----------------|---------------------|-----------|-------------|
| High | `GET /node/claims-by-member?walletId=X` | walletId | healthcare-claims | Any caller can query any member's complete drug claim history |
| High | `GET /node/dur?memberWalletId=X` | memberWalletId | PHI (drug history) | Cross-pharmacy DUR — sensitive medication history |
| High | `GET /interactive/member-history?walletId=X` | walletId | healthcare-claims | Full Rx history for any member |
| High | `GET /interactive/family-history?walletId=X` | walletId | healthcare-claims | Family-level Rx history + pooled accumulators |
| High | `POST /rpc → l2_getClaimsByMember` | walletId | healthcare-claims | All claims for any member wallet |
| High | `POST /rpc → l2_getReceiptsByWallet` | walletId | PII | All transaction receipts for any wallet |
| High | `POST /rpc → l2_getMessagesByWallet` | walletId | PII (encrypted messages) | All stored messages for any wallet |
| High | `POST /rpc → l2_getWalletState` | walletId | Tokens | Wallet nonce + credential inventory root |
| High | `GET /claims/member/:walletId` (insurer port 4004) | walletId | healthcare-claims | All member claims via insurer node |
| High | `GET /claims/prescriber/:walletId` (insurer port 4004) | walletId | healthcare-claims | All prescriber claims |
| High | `GET /claims/pharmacy/:walletId` (insurer port 4004) | walletId | healthcare-claims | All pharmacy claims |
| High | `GET /dur/patient/:memberWalletId/full-history` (pharmacy port 4003) | memberWalletId | PHI | Full cross-pharmacy drug history |
| High | `GET /dur/patient/:memberWalletId/active-medications` (pharmacy port 4003) | memberWalletId | PHI | Active medications list |
| High | `GET /dur/claim/:leafIndex` (pharmacy port 4003) | leafIndex | healthcare-claims | Any claim by leaf index |
| High | `GET /node/receipts-by-wallet?walletId=X` | walletId | Financial | All receipts for any wallet |
| High | `GET /node/claim-proof?leafIndex=N` | leafIndex | healthcare-claims | Any claim by index |
| Medium | `GET /prescriptions/patient/:memberWalletId` (prescriber port 4002) | memberWalletId | PHI | Claims for specific patient |
| Medium | `GET /dispensing/patient/:memberWalletId` (pharmacy port 4003) | memberWalletId | PHI | Dispensing for specific patient |
| Medium | `GET /credentialing/status/:walletId` (insurer port 4004) | walletId | PII | Provider registry status |
| Medium | `GET /plans/:planId` (insurer port 4004) | planId | Financial | Benefit plan configuration |
| Low | `GET /drugs/medication/:ndcHash` (member port 4001) | ndcHash | Public | Drug-specific claims |

### 8.2 Vertical Privilege Escalation Candidates

| Target Role | Endpoint Pattern | Functionality | Risk Level |
|-------------|-----------------|---------------|------------|
| admin:L2 (BYPASSED) | `POST /rpc → l2_forceBatch` | Force L2 chain batch settlement | Critical |
| admin:L2 (BYPASSED) | `POST /rpc → l2_storeFormulary` | Replace formulary data — potential for stored XSS injection | Critical |
| admin:L2 (BYPASSED) | `POST /rpc → l2_storePlan` | Create/replace benefit plans | Critical |
| admin:L2 (BYPASSED) | `POST /rpc → l2_deletePlan` | Delete benefit plans | Critical |
| admin:L2 (BYPASSED) | `POST /rpc → l2_credentialProvider` | Credential or de-credential providers | Critical |
| admin:L2 (BYPASSED) | `POST /rpc → l2_updateProviderStatus` | Change provider lifecycle state (suspend/terminate) | Critical |
| admin:L2 (BYPASSED) | `POST /rpc → l2_recordFill` | Inject fraudulent pharmacy fills into claim chain | Critical |
| admin:L2 (BYPASSED) | `POST /rpc → l2_gossipRelay` | Relay gossip messages containing arbitrary peer URLs (SSRF) | High |
| admin:L2 (BYPASSED) | `POST /rpc → l2_revokeAdminKey` | Revoke admin keys | High |
| admin:L2 (BYPASSED) | `POST /rpc → l2_approveAdmission` | Approve quorum admission | High |
| admin:L2 (BYPASSED) | `POST /rpc → l2_registerAdminKey` | Register new admin key (non-genesis) | High |
| admin:L2 (BYPASSED) | `POST /viz/emit` | Inject arbitrary events into SSE stream (XSS via dashboard) | High |
| admin:L2 (BYPASSED) | `POST /viz/entities` | Register entities in viz | Medium |
| admin:L2 (BYPASSED) | `POST /viz/clear` | Clear all visualization history | Medium |
| anon→admin:interactve | `POST /interactive/force-batch` | Force batch (no auth at all on interactive routes) | Critical |
| anon→admin:interactive | `POST /interactive/update-formulary` | Modify formulary entries | Critical |
| anon→admin:interactive | `POST /interactive/update-provider-network` | Add/remove providers from network | High |
| anon→admin:interactive | `POST /interactive/plan-year-rollover` | Reset all member accumulators | High |
| anon→admin:interactive | `POST /interactive/terminate-member` | Terminate any member | High |
| anon→admin:interactive | `POST /interactive/terminate-group` | Terminate all members in a group | Critical |
| anon→admin:interactive | `POST /interactive/save-checkpoint` | Save state checkpoint | Medium |
| anon→admin:interactive | `POST /interactive/reset` | Full session state reset | Critical |
| admin:Insurer | `POST /credentialing/approve/:id` | Approve provider credentialing | High |
| admin:Insurer | `POST /credentialing/suspend/:walletId` | Suspend any provider | High |
| admin:Insurer | `POST /credentialing/terminate/:walletId` | Terminate any provider | High |
| admin:Insurer | `POST /admin/batch/force` | Force batch via insurer node | High |
| admin:Employer | `POST /tokens/generate` | Generate enrollment tokens | Medium |
| admin:Employer | `POST /tokens/:tokenId/revoke` | Revoke enrollment tokens | Medium |

### 8.3 Context-Based Authorization Candidates

| Workflow | Endpoint | Expected Prior State | Bypass Potential |
|----------|----------|---------------------|-----------------|
| Member Enrollment | `POST /onboarding/enroll` | Phase = `wallet_derived` (requires prior derive-wallet step) | Phase is in-memory only; process restart bypasses |
| Enrollment Token Use | `POST /onboarding/accept-token` | Phase = `awaiting_token`, valid token from employer | No cryptographic binding between tokenId and employer; insurer accepts any sequencer-registered walletId |
| Prescription Fill | `POST /interactive/fill` | Prior `prescribe` call created prescription | Direct fill with crafted `prescriptionId`? |
| Prior Auth Approval | `POST /interactive/approve-prior-auth` | Prior auth request submitted | Direct approval with crafted `priorAuthId`? |
| Proof Replay | `POST /rpc → l2_submitProof` | Unique proof fingerprint | After server restart, fingerprint Set cleared; settled proofs in L2-only mode have no L1 protection |
| Admin Key Genesis | `POST /rpc → l2_registerAdminKey` | Admin key registry empty | If registry is emptied (e.g., `l2_revokeAdminKey`), genesis window reopens |
| Enrollment via Insurer | `POST /enrollment/process` | walletId registered on sequencer | No token validation — any sequencer-registered walletId can be enrolled without a valid employer token |
| Token Validation | `POST /tokens/:tokenId/validate` | Valid, unused, unexpired token | Caller supplies `currentDate` — no server clock enforcement (`token-authority.ts:128`) |

---

## 9. Injection Sources

### 9.1 Server-Side Request Forgery (SSRF)

| Severity | File:Line | Source (User Input) | Sink | Validation | Notes |
|----------|-----------|---------------------|------|------------|-------|
| Critical | `src/nodes/routes/prescriber-routes.ts:224–242` | `body.insurerUrl` (POST /onboarding/enroll) | `fetch(insurerUrl + '/enrollment/process')` with `Authorization: Bearer adminToken` | None | **Leaks admin Bearer token** to attacker-controlled server. Prescriber node is `ready` phase = immediately exploitable. |
| Critical | `src/nodes/routes/pharmacy-routes.ts:145–163` | `body.insurerUrl` (POST /onboarding/enroll) | `fetch(insurerUrl + '/enrollment/process')` with `Authorization: Bearer adminToken` | None | Same as prescriber — admin token forwarded. Pharmacy node is `ready` phase = immediately exploitable. |
| High | `src/nodes/routes/member-routes.ts:244–300` | `body.insurerUrl` (POST /onboarding/enroll) | `fetch(iUrl + '/enrollment/process')` | None | No admin token forwarded. Member node phase = `awaiting_token` — requires prior enrollment steps. |
| High | `src/nodes/routes/employer-routes.ts:36–46` | `body.insurerUrl` (POST /onboarding/configure) | Stored → `fetch(insurerUrl + ...)` in `employer-node.ts:206` via POST `/tokens/:tokenId/submit` | None | Two-step: store URL at configure (no auth), trigger SSRF at submit (admin-only). |
| Medium | `src/nodes/start-explorer.ts:130–169` | URL path + query string after `/viz/` | `fetch(sequencerUrl + pathname + url.search)` | Fixed host only | Path+query user-controlled; can access any `/viz/*` path on sequencer with arbitrary query params. |
| Medium | `src/l2/l2-rpc-network.ts:122` via `l2_gossipRelay` | `params.message.knownPeers[]` (URL array in gossip) | `L2Client(peerUrl)` HTTP connection | Optional HMAC (not configured) | Admin-bypassed `l2_gossipRelay` allows injecting arbitrary peer URLs; sequencer makes server-side connections to them. |

**Data flow for SSRF-2 (Prescriber — Critical):**
```
POST http://host.docker.internal:4002/onboarding/enroll
Body: {"insurerUrl": "http://attacker.com"}
  → prescriber-routes.ts:228: const insurerUrl = b.insurerUrl
  → prescriber-routes.ts:237–241: fetch(`${insurerUrl}/enrollment/process`, {
      headers: { "Authorization": `Bearer ${adminToken}`, "Content-Type": "application/json" }
    })
  → Attacker receives: Authorization: Bearer <ZKTRIDENT_ADMIN_TOKEN value>
```

### 9.2 Cross-Site Scripting Injection Sources

| Severity | File:Lines | Source | Sink | Escaping | Notes |
|----------|-----------|--------|------|----------|-------|
| High | `dashboard/app.js:55–615` | All RPC API response data | `innerHTML` template literal interpolation throughout | **None** | Legacy dashboard with zero HTML escaping. walletId, receiptId, failureReason, error messages, SSE event data all rendered raw. |
| High | `dashboard/app.js:55–58` | Hash values (walletId, receiptId) | `href="#/receipt/${hash}"` and `title="${hash}"` attributes | None | Attribute injection — value containing `" onmouseover=` executes JS. |
| High | `POST /viz/emit → GET /viz/history/events` | `type`, `actor`, `data` fields in viz events | SSE stream → `dashboard/app.js:611–614` innerHTML | None | Admin-bypassed `viz/emit` lets attacker inject XSS payload into SSE stream, delivered to all dashboard clients. |
| Medium | `explorer/app.js:22–26` | walletId, ndcHash from RPC responses | `innerHTML` via `shortHash()` (no escaping) | Partial (`esc()` exists but not applied to `shortHash`) | Lines 251, 484–487, 541–544. |
| Medium | `explorer/app.js:315, 686` | receiptId in `onclick` attribute | `onclick="window._showReceipt('${rid}')"` | `esc()` applied but doesn't escape quotes | Single-quote injection in JS context: `')},alert(1),{('` |
| Low | All dashboards serving `entityMetadata.displayName` | `l2_registerEntity` / `l2_submitProof` params | Dashboards rendering entity names | `esc()` in most dashboards | Legacy `dashboard/app.js` has no `esc()` — display names from admin-bypassed `registerEntity` are XSS vectors |

### 9.3 Path Traversal Sources

| Severity | File:Line | Source | Sink | Validation |
|----------|-----------|--------|------|------------|
| Low-Medium | `src/nodes/nautilus-app-server.ts:338–355` | `req.url` pathname | `path.join(dashboardDir, safePath)` → `fs.readFileSync()` | Regex `/^[/a-zA-Z0-9._-]+$/` + `!includes('..')` only. **Missing `path.resolve().startsWith()` canonicalization** present in `l2-rpc-server.ts:458`. |
| Low (mitigated) | `src/l2/l2-rpc-server.ts:458–484` | `req.url` pathname | `path.resolve(dashboardDir, relativePath)` → `fs.readFileSync()` | Full double check: regex + `..` block + `resolve()` + `startsWith()`. Properly mitigated. |

### 9.4 Deserialization / Prototype Pollution

| Severity | File | Source | Sink | Notes |
|----------|------|--------|------|-------|
| Low | `src/l2/l2-rpc-server.ts` ~line 1260 | `params.filter` (object from RPC body) | `getFormularyPage(filter, ...)` | Filter object passed directly without sanitization. Downstream iteration without `Object.hasOwn()` checks could be prototype-polluted. |
| Low | `src/nodes/nautilus-app-server.ts:503` | Request body | `JSON.parse(raw)` | Standard V8 JSON.parse — not itself prototype-pollutable, but parsed objects used without `Object.create(null)` patterns. |

### 9.5 Command Injection (None via Network)

No command injection sources found that are controllable via network requests. `exec()` at `src/nodes/start-leviathan.ts:421` uses hardcoded URLs constructed from integer-parsed environment variables only — not network user-controllable.

### 9.6 No SQL Injection

The application uses no SQL database. All state is in-memory Merkle trees and flat JSON. No SQL injection vectors exist.

### 9.7 No Server-Side Template Injection

No server-side template engines used. All HTML is static files or client-side JS rendering. No SSTI vectors.

---

*End of Reconnaissance Deliverable*
