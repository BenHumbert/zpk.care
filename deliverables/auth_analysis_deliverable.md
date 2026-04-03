# Authentication Analysis Report

## 1. Executive Summary

- **Analysis Status:** Complete
- **Target:** zkTrident Care (zkpCare) — Leviathan Sequencer (port 3030) + Entity Nodes (ports 4001–4005)
- **Key Outcome:** Eight distinct authentication vulnerabilities were identified, including a confirmed zero-authentication admin bypass affecting all 13 admin RPC methods and three viz write endpoints, 45+ unauthenticated interactive adjudication endpoints, and no transport security on the primary sequencer. The combination of no admin token configured in the live deployment and no rate limiting creates immediate, trivially exploitable attack paths requiring no credentials.
- **Purpose of this Document:** This report provides the strategic context on the application's authentication mechanisms, dominant flaw patterns, and key architectural details necessary to effectively exploit the vulnerabilities listed in the exploitation queue.

---

## 2. Dominant Vulnerability Patterns

### Pattern 1: Absent Authentication on Administrative Operations

- **Description:** The single most critical pattern is the complete absence of functioning authentication on all admin-tier operations. The L2 RPC server's `checkAdminAuth()` function (`src/l2/l2-rpc-server.ts:2474`) contains a deliberate short-circuit: `if (!this.options.adminToken) return true;`. In the live deployment, no admin token is configured (`ZKTRIDENT_ADMIN_TOKEN` is unset), causing every admin auth check to unconditionally pass. This is independently compounded by the 45+ endpoints in `visualizer/engine/interactive-routes.ts` that were never wired to any authentication middleware at all — they are publicly registered on the Leviathan server with zero access control.
- **Implication:** Any internet-accessible client can perform privileged operations: force batch settlements, register entities, update the formulary, approve wallet admissions, register new admin keys, and emit visualization events. The `/node/force-batch` interactive route duplicates the authenticated `l2_forceBatch` without any auth.
- **Representative Findings:** `AUTH-VULN-01`, `AUTH-VULN-02`.

### Pattern 2: Absent Abuse Defenses on Authentication Endpoints

- **Description:** The application has no rate limiting, lockout, or CAPTCHA on any endpoint except `l2_submitProof` (60/min per IP). Admin RPC methods, the PIN unlock endpoint, onboarding routes, and the enrollment token validation endpoint are all completely unbounded. This means an attacker can make unlimited attempts without any throttling or account lockout.
- **Implication:** Once the admin auth bypass is addressed, brute force of the admin bearer token (particularly the `admin123` fallback default) and brute force of 6-digit numeric PINs on entity nodes become viable attacks. Token ID enumeration is also possible against the unauthenticated `/tokens/:tokenId/validate` endpoint.
- **Representative Findings:** `AUTH-VULN-04`, `AUTH-VULN-05`.

### Pattern 3: Plaintext Transport for All Authentication Material

- **Description:** The Leviathan Sequencer (`src/l2/l2-rpc-server.ts`) is built exclusively on Node.js `http.createServer()` with no TLS capability. All entity nodes (`src/nodes/nautilus-app-server.ts`) default to plain HTTP unless TLS certificates are explicitly provided. No `Strict-Transport-Security` header is set anywhere. The live deployment confirms HTTP-only on port 3030; HTTPS connection attempts are rejected with a TLS handshake failure. Admin `Authorization: Bearer` tokens and all RPC payloads travel in cleartext.
- **Implication:** An on-path attacker (or anyone on the same network) can intercept admin bearer tokens, wallet IDs, claim data, and all RPC traffic. With wildcard CORS (`Access-Control-Allow-Origin: *`), cross-site scripts can also exfiltrate this data from browser sessions.
- **Representative Findings:** `AUTH-VULN-03`.

---

## 3. Strategic Intelligence for Exploitation

- **Authentication Method:** Two-tier model. (1) ZK proof-based wallet identity for entity operations — cryptographically sound; no known bypass. (2) Bearer token (unsecure mode) or Ed25519 signature (secure mode) for administrative RPC operations. The live deployment uses unsecure mode with **no token configured**, making every admin auth check a pass-through.
- **Session Token Details:** The application has **no cookies and no session management**. Authentication is fully stateless per-request. There are no `Set-Cookie` headers, no `HttpOnly`/`Secure`/`SameSite` flags, and no session identifiers to hijack or fixate. Session fixation, session hijacking via cookie theft, and CSRF via cookies are **not applicable attack surfaces**.
- **Admin Auth Code Path:** `POST /rpc` → `checkAdminAuth(req)` at `l2-rpc-server.ts:2471` → `if (!this.options.adminToken) return true` at line 2474. The live deployment hits this `return true` branch for every admin method call.
- **Admin Methods Protected (all currently bypassed):** `l2_forceBatch`, `l2_storeFormulary`, `l2_storePlan`, `l2_deletePlan`, `l2_registerEntity`, `l2_credentialProvider`, `l2_updateProviderStatus`, `l2_requestSnapshot`, `l2_gossipRelay`, `l2_recordFill`, `l2_publishPlanOverlay`, `l2_revokeAdminKey`, `l2_approveAdmission`.
- **Viz Admin Methods (also bypassed):** `POST /viz/emit`, `POST /viz/entities`, `POST /viz/clear`.
- **Password/PIN Policy:** No password authentication exists. Entity node state is protected by a 6-character minimum PIN (`src/security/enrollment-backup.ts:24`, `src/nodes/nautilus-local-state.ts:34`) via scrypt (N=2^15, r=8, p=1). A numeric 6-digit PIN offers only ~1M permutations. No lockout or rate limiting exists on the unlock endpoint.
- **Enrollment Token Entropy:** Token IDs are generated as `TOKEN-${Date.now()}-${nonceCounter}` (`src/onboarding/token-authority.ts:90`) — timestamp plus an incrementing counter, not cryptographically random. The token validation endpoint `POST /tokens/:tokenId/validate` on the employer node (port 4005) is publicly accessible without authentication.
- **Hardcoded Credentials:** `admin123` is the fallback admin token when `ZKTRIDENT_UNSECURE=true` and `ZKTRIDENT_ADMIN_TOKEN` is unset (`start-leviathan.ts:65`). This default also appears in dashboard JavaScript files (`dashboard-leviathan/app.js:1816`, `dashboard-insurer/rpc.js:21`, `dashboard-employer/rpc.js:27`). `dev-key` is the prover API key fallback.
- **Nautilus Node Auth Flaw:** Entity node admin routes use `authHeader !== 'Bearer ${token}'` (simple string equality at `nautilus-app-server.ts:301`) rather than `timingSafeEqual`. This is a timing side-channel vulnerability in the auth comparison itself.
- **CORS:** Wildcard `Access-Control-Allow-Origin: *` confirmed live, set by every startup script overriding the restrictive default.

---

## 4. Vulnerability Details

### AUTH-VULN-01: Admin RPC Authentication Bypass — No Token Configured

**Severity:** Critical | **Confidence:** High | **Externally Exploitable:** Yes

**Root Cause Code:**
```
// src/l2/l2-rpc-server.ts:2471-2477
private checkAdminAuth(req: IncomingMessage): boolean {
  if (this.options.unsecureMode || !this.adminKeyRegistry.size) {
    if (!this.options.adminToken) return true;  // ← Dev mode: no token = open access
    const authHeader = req.headers['authorization'] ?? '';
    return L2RpcServer.safeEquals(authHeader, `Bearer ${this.options.adminToken}`);
  }
  ...
}
```

**Live Confirmation:** `curl -s -X POST http://host.docker.internal:3030/rpc -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","method":"l2_forceBatch","params":{},"id":1}'` returns `{"jsonrpc":"2.0","id":1,"result":null}` — success with no Authorization header. `l2_getAdminKeys` returns `{"result":[]}` with any or no token.

**Affected Methods:** All 13 ADMIN_METHODS + POST /viz/emit, POST /viz/entities, POST /viz/clear.

---

### AUTH-VULN-02: Unauthenticated Interactive Adjudication Routes

**Severity:** Critical | **Confidence:** High | **Externally Exploitable:** Yes

**Root Cause:** `visualizer/engine/interactive-routes.ts` registers 45+ routes on the Leviathan server with no authentication middleware whatsoever. The `registerInteractiveRoutes()` function adds routes directly to the L2 server's route table without any `adminOnly` flag or auth guard.

**Live Confirmation:** `GET http://host.docker.internal:3030/interactive/state` returns full system state including chain state, wallet counts, member PII data. `POST http://host.docker.internal:3030/node/force-batch` returns `{"ok":true,"batch":null,"message":"No pending proofs to batch"}`.

**Sample Dangerous Unauthenticated Endpoints:**
- `POST /interactive/enroll` — Enroll members
- `POST /interactive/approve-prior-auth` — Approve prior authorization requests
- `POST /interactive/prescribe` — Create prescriptions
- `POST /interactive/fill` — Dispense medications
- `POST /interactive/update-formulary` — Modify drug formulary
- `POST /node/force-batch` — Force L2 batch settlement
- `POST /node/publish-formulary` — Publish formulary to chain
- `POST /interactive/generate-credential` — Generate healthcare credentials
- `POST /interactive/reset` — Reset system state

---

### AUTH-VULN-03: Plaintext HTTP — No Transport Security, No HSTS

**Severity:** High | **Confidence:** High | **Externally Exploitable:** Yes

**Root Cause:** `src/l2/l2-rpc-server.ts` uses `http.createServer()` only (line ~25). No TLS certificate support exists. No `Strict-Transport-Security` header is ever set.

**Live Confirmation:** HTTPS connection to port 3030 fails with `OpenSSL error:0A00010B: wrong version number`. All authentication material (Bearer tokens, wallet IDs, claim data) transmitted in cleartext. Response headers contain no `Strict-Transport-Security`.

---

### AUTH-VULN-04: No Rate Limiting on Admin RPC or Onboarding Endpoints

**Severity:** High | **Confidence:** High | **Externally Exploitable:** Yes

**Root Cause:** Rate limiting at `src/l2/l2-rpc-server.ts:662-668` is scoped exclusively to `l2_submitProof`. All 13 admin methods, all interactive route endpoints, and the `/onboarding/*` routes on entity nodes have no throttling. The `nautilus-app-server.ts` has no rate limiting at all.

---

### AUTH-VULN-05: No Brute Force Protection on PIN Unlock Endpoint

**Severity:** High | **Confidence:** High | **Externally Exploitable:** Yes

**Root Cause:** `src/nodes/routes/member-routes.ts:47-79` — the unlock handler calls `state.unlock(pin)` with no attempt counter, rate limiting, or lockout. The minimum PIN is 6 characters (`nautilus-local-state.ts:34`). Numeric-only 6-digit PINs (common on mobile) provide ~1M combinations, brute-forceable with scrypt (~100ms/attempt on consumer hardware = ~3 hours for full space).

**Live Confirmation:** 5 sequential requests with different PINs on port 4001 all returned immediately with no throttling or lockout (all returned `alreadyUnlocked:true` since node was in pre-state phase, but no rate limit evidence was present).

---

### AUTH-VULN-06: Hardcoded `admin123` Default Admin Token

**Severity:** High | **Confidence:** High | **Externally Exploitable:** Yes

**Root Cause:** `src/nodes/start-leviathan.ts:65` — `const adminToken = unsecureMode ? (env.ZKTRIDENT_ADMIN_TOKEN ?? 'admin123') : ...`. When `ZKTRIDENT_UNSECURE=true` and `ZKTRIDENT_ADMIN_TOKEN` is not set, the admin token is literally `admin123`. The same default appears in dashboard JavaScript: `dashboard-leviathan/app.js:1816`, `dashboard-insurer/rpc.js:21`, `dashboard-employer/rpc.js:27`.

---

### AUTH-VULN-07: Nautilus Admin Token Timing Side-Channel

**Severity:** Medium | **Confidence:** Medium | **Externally Exploitable:** Yes

**Root Cause:** `src/nodes/nautilus-app-server.ts:301` — admin auth check uses `authHeader !== 'Bearer ${this.config.adminToken}'` (JavaScript strict inequality, not constant-time). The L2 RPC server uses `timingSafeEqual` correctly; the Nautilus nodes do not.

---

### AUTH-VULN-08: Predictable Enrollment Token IDs + Unauthenticated Validation Endpoint

**Severity:** Medium | **Confidence:** Medium | **Externally Exploitable:** Yes

**Root Cause:** `src/onboarding/token-authority.ts:90` — token ID generated as `TOKEN-${Date.now()}-${this.nonceCounter}` (timestamp + incrementing counter, no crypto randomness). The employer node's `POST /tokens/:tokenId/validate` endpoint (`src/nodes/routes/employer-routes.ts:228-238`) has no `adminOnly` flag and is publicly callable, enabling token enumeration.

---

## 5. Secure by Design: Validated Components

These components were analyzed and found to have robust defenses. They are low-priority for further testing.

| Component/Flow | Endpoint/File Location | Defense Mechanism Implemented | Verdict |
|---|---|---|---|
| Admin Token Comparison (L2 RPC) | `src/l2/l2-rpc-server.ts:2419-2425` | Uses `crypto.timingSafeEqual()` via `L2RpcServer.safeEquals()` for Bearer token comparison | SAFE |
| Ed25519 Admin Signature Verification | `src/l2/l2-rpc-server.ts:2434-2468` | 30-second replay window; HMAC-SHA256 params hash; Ed25519 signature over `method|paramsHash|timestamp` | SAFE |
| ZK Wallet Identity (ProofGate) | `src/wallets/proof-gate.ts` | Poseidon hash-based wallet ID; enrollment key never leaves device; zero-knowledge proof of ownership | SAFE |
| Entity State Encryption | `src/nodes/nautilus-local-state.ts` | AES-256-GCM + scrypt (N=2^15, r=8, p=1, 64MiB); fresh salt+IV per save; derived key zeroed on lock | SAFE |
| Message Encryption | `src/messaging/encryption.ts` | X25519 ECDH + HKDF-SHA256 + AES-256-GCM; per-message nonces; Poseidon commitment of ciphertext | SAFE |
| PHI Scrubbing | `src/security/secure-scrub.ts`, `src/security/secure-context.ts` | Memory zeroing of PHI after Poseidon hashing; raw PHI never transmitted | SAFE |
| Ed25519 NFC Attestation | `src/credentials/nfc-attestation.ts` | Ed25519 digital signatures on NFC credentials | SAFE |
| Enrollment Token Single-Use | `src/onboarding/token-authority.ts:127-154` | Token status transitions `unused → consumed`; reuse rejected | SAFE |
| WAL Integrity | `src/l2/l2-wal.ts` | HMAC-SHA256 integrity verification on Write-Ahead Log entries | SAFE |
| Session Management (N/A) | N/A | No cookies, no sessions — stateless per-request auth eliminates session fixation, session hijacking, CSRF | SAFE (by design) |
| OAuth/OIDC (N/A) | N/A | No OAuth/OIDC flows implemented | N/A |
| SSO (N/A) | N/A | No SSO implemented | N/A |
| Proof Submission Rate Limiting | `src/l2/l2-rpc-server.ts:2552-2563` | 60 proofs/IP/minute (configurable); sliding window; timer-based cleanup | SAFE |
