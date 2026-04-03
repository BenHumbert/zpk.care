# Authorization Analysis Report

## 1. Executive Summary

- **Analysis Status:** Complete
- **Key Outcome:** Seventeen (17) high-confidence authorization vulnerabilities were identified spanning horizontal privilege escalation (IDOR), vertical privilege escalation (admin bypass, unauthenticated privileged operations), and context/workflow bypass. The application's authorization model is fundamentally broken: the L2 sequencer grants unconditional admin access when no token is configured, 40+ interactive routes have zero authentication, and every PHI-bearing endpoint lacks ownership checks. All critical findings have been passed to the exploitation phase via the machine-readable queue.
- **Purpose of this Document:** This report provides the strategic context, dominant vulnerability patterns, and architectural intelligence necessary to effectively exploit the vulnerabilities listed in the queue. It is intended to be read alongside the JSON deliverable.

---

## 2. Dominant Vulnerability Patterns

### Pattern 1: Unconditional Admin Auth Bypass (Vertical)
- **Description:** `checkAdminAuth()` in `l2-rpc-server.ts:2474` returns `true` unconditionally when `adminToken` is `undefined` AND `adminKeyRegistry` is empty. This single logic flaw opens every one of the 13 admin RPC methods and 3 viz REST endpoints to any unauthenticated caller.
- **Implication:** Any internet-accessible attacker can call admin methods — force batch settlement, replace formulary data, credential/terminate providers, inject fraudulent pharmacy fills, revoke admin keys — without any credentials.
- **Representative:** AUTHZ-VULN-01, AUTHZ-VULN-02

### Pattern 2: Interactive Routes — Zero Authentication (Vertical)
- **Description:** All 40+ routes in `visualizer/engine/interactive-routes.ts` are registered via `server.registerRoute()` and dispatched at `l2-rpc-server.ts:451-454` without any authentication or role check. The dispatch code calls `customHandler(req, res)` directly.
- **Implication:** Any attacker can force batch settlement, wipe all enrollment data, terminate any member's coverage, reset all benefit accumulators, modify formulary entries, and add/remove providers from the network — all without credentials.
- **Representative:** AUTHZ-VULN-03, AUTHZ-VULN-04

### Pattern 3: Missing Ownership Validation — PHI/PII Exposure (Horizontal)
- **Description:** Every claims, prescriptions, DUR, receipts, and message endpoint accepts a `walletId` or `leafIndex` parameter and queries the L2 state directly without verifying that the requesting party owns or has authorization to view that wallet's data. There is no session context, no JWT, no user identity binding of any kind.
- **Implication:** Any attacker who can enumerate or guess wallet IDs (which are deterministic Poseidon hashes) can read any member's complete Protected Health Information: full prescription history, drug utilization review records, financial accumulators, and messaging content.
- **Representative:** AUTHZ-VULN-05 through AUTHZ-VULN-11

### Pattern 4: Context Workflow Bypass (Context)
- **Description:** Two workflow guard failures exist: (1) The insurer's `POST /enrollment/process` never validates the `tokenId` against the token authority — any caller with a known sequencer-registered walletId can enroll without a legitimate employer token. (2) `POST /tokens/:tokenId/validate` passes the caller-supplied `currentDate` directly to the expiration check, enabling expired tokens to be validated as current.
- **Implication:** Attackers can enroll arbitrary wallets into insurance plans without employer authorization, and can revive expired enrollment tokens.
- **Representative:** AUTHZ-VULN-12, AUTHZ-VULN-13

### Pattern 5: Admin Key Genesis Takeover (Vertical/Context)
- **Description:** `l2_registerAdminKey` allows registering the first admin key (genesis) without any authentication when `adminKeyRegistry` is empty AND `ZKTRIDENT_GENESIS_ADMIN_KEY` env var is not set (unsecure mode). An attacker can register their own Ed25519 key as genesis admin, permanently elevating themselves to `admin:L2` with cryptographic signing authority.
- **Implication:** After genesis registration, the attacker's key becomes the permanent admin authority. They can sign all future admin operations, approve their own quorum admissions, and lock out legitimate operators.
- **Representative:** AUTHZ-VULN-14

---

## 3. Strategic Intelligence for Exploitation

### Session Management Architecture
- **No sessions exist.** The application uses no cookies, no JWT tokens, no session state for regular users. There is no concept of "current user identity" at the REST layer.
- **Admin auth mechanism:** Bearer token comparison (`Authorization: Bearer <token>`) on L2 RPC and Nautilus admin routes, OR Ed25519 signature in secure mode. L2 RPC bearer check uses timing-safe `crypto.timingSafeEqual()`. Nautilus admin check uses plain `!==` (not timing-safe).
- **Critical Finding:** When `ZKTRIDENT_ADMIN_TOKEN` env var is unset AND `adminKeyRegistry` is empty, `checkAdminAuth()` returns `true` unconditionally (`l2-rpc-server.ts:2474`). Confirmed behavior in current deployment.

### Role/Permission Model
- **Two tiers of roles:** `anon` (all public methods + all interactive routes) and `admin:L2` (13 admin RPC methods + 3 viz endpoints).
- **Nautilus nodes** have their own `admin:Nautilus` role enforced by `adminOnly: true` flag in route registration, checked at `nautilus-app-server.ts:295-304`.
- **Critical Finding:** The Nautilus admin check uses a non-timing-safe string comparison (`authHeader !== \`Bearer ${this.config.adminToken}\``). Admin tokens can potentially be brute-forced via timing side-channels.
- **Critical Finding:** The admin auth bypass (`l2-rpc-server.ts:2474`) and the complete absence of any auth on all `/interactive/*` and `/node/*` routes means the effective privilege lattice collapses to: `anon = admin:L2` for all operations.

### Resource Access Patterns
- **Wallet-ID-based access:** PHI and financial data is keyed by `walletId` (Poseidon hash of member PHI preimage). All data-access endpoints accept `walletId` as a query param or path param with no ownership enforcement.
- **Index-based access:** Some endpoints use `leafIndex` (integer) to access claims — fully enumerable from 0 upward.
- **Critical Finding:** ID parameters are passed directly to in-memory Merkle tree lookups with no ownership check. Sequencing: `GET /node/claims-by-member?walletId=<any>` → `seq.getClaimsByMember(walletId)` (no intermediate guard).

### Admin Bypass Technical Details
- **Root cause:** `l2-rpc-server.ts:2474`: `if (!this.options.adminToken) return true;` inside `checkAdminAuth()` when registry is empty.
- **RPC dispatch bypass:** `l2-rpc-server.ts:640-647`: When `!this.adminKeyRegistry.size`, the inner `if (this.options.adminToken)` block is NOT entered when adminToken is undefined — no error is returned, execution falls through to the admin method handler.
- **Affected admin methods (ADMIN_METHODS set at lines 183-197):** `l2_forceBatch`, `l2_storeFormulary`, `l2_storePlan`, `l2_deletePlan`, `l2_registerEntity`, `l2_credentialProvider`, `l2_updateProviderStatus`, `l2_requestSnapshot`, `l2_gossipRelay`, `l2_recordFill`, `l2_publishPlanOverlay`, `l2_revokeAdminKey`, `l2_approveAdmission`.
- **Affected REST endpoints:** `POST /viz/emit`, `POST /viz/entities`, `POST /viz/clear` (lines 407-447 call `checkAdminAuth()` which is bypassed).

### Workflow Implementation
- **Enrollment workflow:** Employer generates `GroupEnrollmentToken` → distributes `tokenId` to member → member presents at `POST /onboarding/accept-token` (member node) → member node calls `POST /enrollment/process` (insurer node).
- **Critical Finding:** `POST /enrollment/process` (`insurer-routes.ts:107-191`) never calls `validateToken()`. The `tokenId` field is stored as metadata but never checked against the token authority. Any caller with a known sequencer-registered `walletId` can complete enrollment without a valid token.
- **Token expiry:** `token-authority.ts:127-154` `validateToken(tokenId, currentDate)` — `currentDate` is a caller-supplied string converted to `BigInt` for comparison. `employer-routes.ts:234-235` passes `b?.currentDate ?? new Date()...` to this function, meaning user can supply a future date to bypass expiration.

---

## 4. Vectors Analyzed and Confirmed Secure

These authorization checks were traced and confirmed to have robust, properly-placed guards. They are **low-priority** for further testing.

| **Endpoint** | **Guard Location** | **Defense Mechanism** | **Verdict** |
|--------------|-------------------|----------------------|-------------|
| `POST /credentialing/approve/:id` (insurer:4004) | insurer-routes.ts:878 | `adminOnly: true` → nautilus-app-server.ts:295-304 enforces Bearer token | SAFE |
| `POST /credentialing/suspend/:walletId` (insurer:4004) | insurer-routes.ts:1030 | `adminOnly: true` → Bearer token enforced | SAFE |
| `POST /credentialing/terminate/:walletId` (insurer:4004) | insurer-routes.ts:1063 | `adminOnly: true` → Bearer token enforced | SAFE |
| `POST /admin/batch/force` (insurer:4004) | insurer-routes.ts:745 | `adminOnly: true` → Bearer token enforced | SAFE |
| `POST /admin/formulary/publish` (insurer:4004) | insurer-routes.ts:729 | `adminOnly: true` → Bearer token enforced | SAFE |
| `POST /plans` (insurer:4004) | insurer-routes.ts:1161 | `adminOnly: true` → Bearer token enforced | SAFE |
| `PUT /plans/:planId` (insurer:4004) | insurer-routes.ts:1246 | `adminOnly: true` → Bearer token enforced | SAFE |
| `DELETE /plans/:planId` (insurer:4004) | insurer-routes.ts:1265 | `adminOnly: true` → Bearer token enforced | SAFE |
| `POST /tokens/generate` (employer:4005) | employer-routes.ts:153 | `adminOnly: true` → Bearer token enforced | SAFE |
| `POST /tokens/:tokenId/revoke` (employer:4005) | employer-routes.ts:214 | `adminOnly: true` → Bearer token enforced | SAFE |
| `POST /interactive/fill` | interactive-routes.ts:383 + interactive-service.ts:2638-2646 | State check: prescription must exist in local map and be in FILLED/PARTIALLY_FILLED status | SAFE (workflow state enforced) |
| `POST /interactive/approve-prior-auth` | interactive-routes.ts:258 + interactive-service.ts:1820-1822 | State check: prior auth must exist and be in PENDING status | SAFE (workflow state enforced) |
| `POST /interactive/deny-prior-auth` | interactive-routes.ts:283 + interactive-service.ts:1943-1946 | State check: prior auth must exist and be in PENDING status | SAFE (workflow state enforced) |
| `POST /interactive/prescribe` | interactive-routes.ts:343 + interactive-service.ts:2093-2157 | Validates prescriber index, member enrollment, PA enforcement, step therapy, DEA schedule | SAFE (business logic enforced) |
| Static file serving (`GET /*`) | l2-rpc-server.ts:458-484 | Path validated with regex + `..` check + `path.resolve().startsWith()` double-check | SAFE (path traversal mitigated) |

---

## 5. Vulnerability Details

### AUTHZ-VULN-01: Complete Admin RPC Auth Bypass
- **Type:** Vertical
- **File:** `src/l2/l2-rpc-server.ts:2474` (root cause), `src/l2/l2-rpc-server.ts:640-647` (dispatch bypass)
- **Root Cause Code:**
  ```typescript
  // l2-rpc-server.ts:2474
  if (!this.options.adminToken) return true; // Dev mode — no token = open access
  ```
  ```typescript
  // l2-rpc-server.ts:640-647
  if (this.options.unsecureMode || !this.adminKeyRegistry.size) {
    if (this.options.adminToken) {  // only checks if adminToken EXISTS; if undefined → skip, no error
      const authHeader = req.headers['authorization'] ?? '';
      if (!L2RpcServer.safeEquals(authHeader, `Bearer ${this.options.adminToken}`)) {
        return this.sendRpcError(res, rpcReq.id, RPC_UNAUTHORIZED, 'Unauthorized');
      }
    }
    // Falls through when adminToken is undefined — no 401 returned
  }
  ```
- **Side Effect:** All 13 admin RPC methods execute without authentication.
- **Confidence:** HIGH

### AUTHZ-VULN-02: Viz Endpoint Auth Bypass (Same Root Cause)
- **Type:** Vertical
- **File:** `src/l2/l2-rpc-server.ts:407-447` (dispatch), `src/l2/l2-rpc-server.ts:2474` (bypass)
- **Endpoints:** `POST /viz/emit`, `POST /viz/entities`, `POST /viz/clear`
- **Root Cause:** Same `checkAdminAuth()` bypass as VULN-01. The viz handlers do call `!this.checkAdminAuth(req)` but the function returns `true` unconditionally when no adminToken and no registry entries.
- **Side Effect:** Inject arbitrary events into SSE stream (stored XSS vector), register fake entities, clear all visualization history.
- **Confidence:** HIGH

### AUTHZ-VULN-03: Interactive Force-Batch / Plan-Year-Rollover — Unauthenticated Privileged Write
- **Type:** Vertical
- **File:** `visualizer/engine/interactive-routes.ts:1166` (force-batch), `interactive-routes.ts:1076` (plan-year-rollover)
- **Root Cause:** `server.registerRoute()` handlers dispatched at `l2-rpc-server.ts:451-454` without any auth check. Zero guards in handlers.
- **Side Effect:** Force batch settlement at will; reset all member benefit accumulators (deductible, OOP max) for any plan year.
- **Confidence:** HIGH

### AUTHZ-VULN-04: Interactive Formulary / Provider-Network Mutation — Unauthenticated
- **Type:** Vertical
- **File:** `visualizer/engine/interactive-routes.ts:1028` (update-formulary), `interactive-routes.ts:1052` (update-provider-network)
- **Root Cause:** Same as VULN-03 — zero auth on all interactive routes.
- **Side Effect:** ADD/REMOVE/MODIFY drug formulary entries; ADD/REMOVE prescribers from provider network without authentication.
- **Confidence:** HIGH

### AUTHZ-VULN-05: Interactive Member/Group Termination — Unauthenticated
- **Type:** Vertical
- **File:** `visualizer/engine/interactive-routes.ts:769` (terminate-member), `interactive-routes.ts:795` (terminate-group)
- **Root Cause:** Same as VULN-03.
- **Side Effect:** Terminate any member's insurance coverage, or terminate all coverage for an entire employer group (mass revocation).
- **Confidence:** HIGH

### AUTHZ-VULN-06: Interactive Session Reset — Unauthenticated
- **Type:** Vertical
- **File:** `visualizer/engine/interactive-routes.ts:1255` (reset)
- **Root Cause:** Same as VULN-03.
- **Side Effect:** Wipe all in-memory enrollment data, claims, prescriptions, and credentials — complete denial of service.
- **Confidence:** HIGH

### AUTHZ-VULN-07: Horizontal PHI Exposure — Interactive Member/Family History (Port 3030)
- **Type:** Horizontal
- **File:** `visualizer/engine/interactive-routes.ts:699` (member-history), `interactive-routes.ts:746` (family-history), `interactive-routes.ts:1317` (claims-by-member), `interactive-routes.ts:1442` (dur)
- **Root Cause:** No authentication, no ownership check. walletId parameter accepted from any caller and passed directly to service methods.
- **Side Effect:** Full prescription history, financial accumulators, family-level PHI for any wallet ID.
- **Confidence:** HIGH

### AUTHZ-VULN-08: Horizontal PHI Exposure — RPC Wallet Data Methods (Port 3030)
- **Type:** Horizontal
- **File:** `src/l2/l2-rpc-server.ts:1447` (l2_getClaimsByMember), `l2-rpc-server.ts:1127` (l2_getReceiptsByWallet), `l2-rpc-server.ts:1558` (l2_getMessagesByWallet), `l2-rpc-server.ts:1550` (l2_getWalletState)
- **Root Cause:** Public RPC methods (not in ADMIN_METHODS set). No ownership validation.
- **Side Effect:** All claims, all financial receipts, all encrypted messages, wallet credential state for any wallet ID.
- **Confidence:** HIGH

### AUTHZ-VULN-09: Horizontal PHI Exposure — Receipts / Claim-Proof (Port 3030)
- **Type:** Horizontal
- **File:** `visualizer/engine/interactive-routes.ts:1417` (receipts-by-wallet), `interactive-routes.ts:1472` (claim-proof)
- **Root Cause:** No authentication, no ownership check. walletId / leafIndex from query string passed directly to sequencer.
- **Side Effect:** All receipts for any wallet; any claim (with Merkle proof) by sequential index enumeration.
- **Confidence:** HIGH

### AUTHZ-VULN-10: Horizontal PHI Exposure — Insurer Claims Endpoints (Port 4004)
- **Type:** Horizontal
- **File:** `src/nodes/routes/insurer-routes.ts:379` (member), `insurer-routes.ts:393` (prescriber), `insurer-routes.ts:407` (pharmacy)
- **Root Cause:** No `adminOnly` flag, no auth check. walletId path param passed directly to node methods.
- **Side Effect:** All claims for any member, prescriber, or pharmacy wallet ID on the insurer node.
- **Confidence:** HIGH

### AUTHZ-VULN-11: Horizontal PHI Exposure — Pharmacy DUR Endpoints (Port 4003)
- **Type:** Horizontal
- **File:** `src/nodes/routes/pharmacy-routes.ts:776` (full-history), `pharmacy-routes.ts:786` (active-medications), `pharmacy-routes.ts:811` (dur/claim/:leafIndex)
- **Root Cause:** No authentication, no ownership check. Direct pass-through of memberWalletId / leafIndex.
- **Side Effect:** Complete cross-pharmacy drug utilization history, active medications list, and claim proofs for any patient.
- **Confidence:** HIGH

### AUTHZ-VULN-12: Horizontal PHI Exposure — Prescriber/Pharmacy Patient Endpoints (Ports 4002/4003)
- **Type:** Horizontal
- **File:** `src/nodes/routes/prescriber-routes.ts:703` (prescriber), `pharmacy-routes.ts:343` (pharmacy)
- **Root Cause:** No auth check. memberWalletId path param passed directly to node methods.
- **Side Effect:** Full prescription and dispensing history for any patient wallet ID.
- **Confidence:** HIGH

### AUTHZ-VULN-13: Context — Insurer Enrollment Without Token Validation
- **Type:** Context_Workflow
- **File:** `src/nodes/routes/insurer-routes.ts:107-191`
- **Root Cause:** `POST /enrollment/process` stores `tokenId: b.tokenId ?? null` (line 158) without calling `validateToken()` or `consumeToken()`. No cryptographic binding. Token can be null, wrong, or already used.
- **Side Effect:** Enroll any sequencer-registered walletId into the insurer's roster without a valid employer token.
- **Confidence:** HIGH

### AUTHZ-VULN-14: Context — Token Expiration Bypass via User-Supplied Date
- **Type:** Context_Workflow
- **File:** `src/nodes/routes/employer-routes.ts:234-235`, `src/onboarding/token-authority.ts:141-146`
- **Root Cause:** `currentDate` accepted from request body. `BigInt(currentDate) > BigInt(record.localData.validUntil)` — supply far-future date to bypass.
- **Side Effect:** Validate expired enrollment tokens as currently valid.
- **Confidence:** HIGH

### AUTHZ-VULN-15: Vertical — Admin Key Genesis Registration (Permanent Privilege Escalation)
- **Type:** Vertical
- **File:** `src/l2/l2-rpc-server.ts:772-787`
- **Root Cause:** Genesis registration requires no auth when `adminKeyRegistry.size === 0` AND `ZKTRIDENT_GENESIS_ADMIN_KEY` is not set (unsecure mode). Attacker registers their own Ed25519 key as genesis admin.
- **Side Effect:** Permanent `admin:L2` privilege escalation via attacker-controlled Ed25519 signing key.
- **Confidence:** HIGH

---

## 6. Analysis Constraints and Blind Spots

- **In-Memory State:** The application uses no database. All state lives in process memory + JSON checkpoint files. Authorization analysis was based on code paths; runtime state (adminToken set/unset, adminKeyRegistry empty/populated) confirmed via recon live-testing.
- **Onboarding Phase Gate:** The member node's `POST /onboarding/enroll` is gated by in-memory phase check (correctly enforced). This protects member-node SSRF but does not protect interactive routes which bypass the member node entirely.
- **ZK Proof Validation:** The only cryptographically enforced identity check is at `l2_submitProof` — ZK proof validity proves wallet ownership at proof submission. This does NOT protect any GET/read endpoints.
- **Gossip HMAC:** Not configured by default — gossip messages accepted unconditionally. SSRF via `l2_gossipRelay` is a secondary concern under VULN-01 admin bypass.
- **Port Scope Note:** Several findings apply to nodes on ports 4002-4005. These are all directly internet-accessible HTTP services requiring no VPN or internal network access. All are marked `externally_exploitable: true`.
