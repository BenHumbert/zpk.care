# Cross-Site Scripting (XSS) Analysis Report

## 1. Executive Summary

- **Analysis Status:** Complete
- **Key Outcome:** One high-confidence, live-confirmed Stored XSS vulnerability was identified and execution verified via browser automation. Additional theoretical vulnerabilities exist in the codebase but lack attacker-controllable injection paths in the current deployment configuration. All externally exploitable findings have been passed to the exploitation phase via `deliverables/xss_exploitation_queue.json`.
- **Purpose of this Document:** This report provides the strategic context, dominant vulnerability patterns, and environmental intelligence necessary to effectively exploit the confirmed XSS vulnerability in the zkTrident Care application.

**Target:** `http://host.docker.internal:3030` (Leviathan Sequencer + dashboard-leviathan)
**Application:** zkTrident Care — Decentralized Healthcare Claim Adjudication System
**Technology Stack:** TypeScript 5.9 / Node.js 22, raw `http.createServer`, no framework, client-side SPAs

---

## 2. Dominant Vulnerability Patterns

### Pattern 1: Real-Time Stored XSS via Admin-Bypassed viz/emit → SSE → Gossip Log

**Description:** The `POST /viz/emit` endpoint is protected by `checkAdminAuth()`, but when no admin token is configured (current deployment), this function returns `true` unconditionally. An attacker can inject arbitrary data into the viz event buffer. When the `type` field contains a gossip-related string (`gossip`, `heartbeat`, `leader:`, `quorum:`, or `peer:`), the server routes the SSE event to `addGossipEntry()` in the dashboard. The gossip log renderer (`renderGossipLog()` at `dashboard-leviathan/app.js:1462`) renders the `ev.data` field **without any HTML escaping** at line 1483, writing it directly into `el.innerHTML` at line 1486.

**Implication:** Any browser with the dashboard open receives the malicious event via the `/viz/events` SSE stream and executes the injected JavaScript when the Gossip tab is active. **Live execution confirmed** — `alert('XSS-CONFIRMED')` fired in a headless Chromium browser.

**Representative Finding:** XSS-VULN-01.

### Pattern 2: Legacy Dashboard Zero-Escaping Pattern (`dashboard/app.js`)

**Description:** The legacy dashboard (`dashboard/app.js`) contains zero HTML escaping across all 15+ DOM sinks. Every API response field — wallet IDs, receipt IDs, batch statuses, formulary drug names, SSE event types, worker IDs, failure reasons — is interpolated raw into `innerHTML` template literals. No `esc()` function or `DOMPurify` exists anywhere in this file. However, this dashboard is **not served in the current deployment** (the `start-leviathan.ts` startup script configures `dashboard-leviathan/` instead of `dashboard/`).

**Implication:** Should the deployment configuration change (e.g., accidentally pointing to `dashboard/` instead of `dashboard-leviathan/`), every piece of server-sourced data would become an XSS vector. Additionally, any admin-bypassed method that stores data (formulary entries, plans, entity registrations) would immediately execute in any browser loading this dashboard.

**Representative Finding:** XSS-VULN-02 (not in exploitation queue — not currently deployed).

### Pattern 3: Insufficient `esc()` Function — Missing Quote Escaping in JS Event Handler Context

**Description:** The explorer dashboard (`explorer/app.js`) defines an `esc()` function (lines 53–56) that only escapes `&`, `<`, and `>` — but does **not** escape `'` (single-quote) or `"` (double-quote). This function is used to "protect" receipt IDs embedded inside JavaScript string literals in `onclick` attributes:

```js
// explorer/app.js:315
html += '<tr onclick="window._showReceipt(\'' + esc(rid) + '\')">'
```

A receipt ID containing `');alert(1)//` would break out of the JS string literal despite `esc()` being applied, because single-quotes are not neutralized. The batch table has no escaping at all:

```js
// explorer/app.js:246
html += '<tr onclick="window._showBatch(' + num + ')">'
```

**Implication:** If receipt IDs or batch numbers can be influenced by an attacker (e.g., via chain data injection), this provides a second exploitation path. In the current deployment, receipt IDs are server-generated Poseidon/SHA-256 hashes and batch numbers are sequential integers, limiting direct exploitability.

**Representative Finding:** XSS-VULN-03, XSS-VULN-04 (MED confidence — injection path not fully confirmed).

---

## 3. Strategic Intelligence for Exploitation

### Content Security Policy (CSP) Analysis

- **Current CSP:** **None.** The application sets no `Content-Security-Policy` header on any endpoint. Confirmed via live testing — no CSP header present on either port 3030 or port 8000.
- **Implication:** Any injected script runs with full browser privileges. No CSP bypass required. `document.cookie` access, `XMLHttpRequest`/`fetch` to any origin, `eval()`, `localStorage`, `sessionStorage` — all available to injected code.
- **Recommendation:** Exploitation should use any convenient payload without CSP bypass complexity.

### Cookie Security

- **Observation:** The application does **NOT use HTTP cookies at all** — zero `Set-Cookie` headers are issued anywhere in the codebase. Authentication is either stateless (ZK proofs per-request) or PIN-based local state.
- **Implication:** Traditional session hijacking via `document.cookie` theft is not applicable. The XSS impact is scoped to:
  - **Credential phishing** — injecting a fake login form (admin token, PIN prompt) to capture credentials typed by the user
  - **Admin token exfiltration** — the admin token may be present in memory/localStorage on the client if set via the dashboard's "Set Token" UI at line 1741 of `dashboard-leviathan/app.js`
  - **CSRF-via-XSS** — making authenticated RPC calls (all admin methods) from the victim's browser session
  - **Data exfiltration** — accessing PHI, claims data, and wallet states from the RPC API using the victim's browser as a proxy

### Admin Token in Client Storage

- The leviathan dashboard has an "Admin Token" input field that writes the token to `RPC.setAdminToken()`. If this is persisted to `localStorage`, XSS would allow direct exfiltration of the admin Bearer token.
- The admin Bearer token defaults to `admin123` or is left unconfigured (auth bypassed). In a production deployment with a real token, XSS would be the path to token exfiltration.

### CORS Configuration

- **Observation:** All services set `Access-Control-Allow-Origin: *` (wildcard). No credentials mode.
- **Implication:** XSS payloads can make cross-origin RPC calls to all services (ports 3030, 4001–4005, 8000) from any injected origin. A victim browser executing the XSS payload can enumerate all data from all services without CORS restriction.

### Attack Delivery Window

- The viz/emit gossip log XSS (XSS-VULN-01) is **real-time**: the SSE event is delivered to currently-connected clients only. The server does not replay history to new SSE connections (line 2258: `// no replay of past events`).
- Attack methodology: The attacker calls `POST /viz/emit` with the gossip payload whenever they detect an active victim session, or targets a window when they know administrators are online (e.g., during batch settlement operations which require admin attention).

---

## 4. Vectors Analyzed and Confirmed Secure

These input vectors were traced and confirmed to have robust, context-appropriate defenses.

| Source (Parameter/Key) | Endpoint/File Location | Defense Mechanism Implemented | Render Context | Verdict |
|--------------------------|-------------------------|--------------------------------|----------------|---------|
| `ev.type`, `ev.data` (chain events) | `dashboard-leviathan/app.js:1059–1071` (`renderEventLog`) | `escHtml()` applied to both `ev.type` and `ev.data` | HTML_BODY | SAFE |
| `item.from`, `item.to`, `item.detail` (viz feed) | `dashboard-leviathan/app.js:443–456` (`renderFeedPanel`) | `escHtml()` applied to all fields | HTML_BODY | SAFE |
| `entityMetadata.displayName` (entity feed items) | `dashboard-leviathan/app.js:795–800` | `resolveEntity()` returns `ent.name` → `escHtml()` in `renderFeedPanel` | HTML_BODY | SAFE |
| `adminConfig` / `healthData` fields | `dashboard-leviathan/app.js:1702, 1734` | `detailRow()` calls `escHtml(String(val))` on all key/value pairs | HTML_BODY | SAFE |
| `e.brandName` (formulary entries) | `dashboard-insurer/app.js:271, 349` | `esc(e.brandName)` applied before innerHTML | HTML_BODY | SAFE |
| `error messages` from RPC | `dashboard-leviathan/app.js:1751–1757` | `escHtml(e.message)` | HTML_BODY | SAFE |
| `p.nodeId`, `p.url` (gossip peers) | `dashboard-leviathan/app.js:1422` | `escHtml(p.nodeId)`, `escHtml(p.url)` | HTML_BODY | SAFE |
| `ev.type`, `ev.from`, `ev.to` (gossip log) | `dashboard-leviathan/app.js:1480–1482` | `escHtml()` applied to type, from, to | HTML_BODY | SAFE — only `ev.data` is unescaped |
| `shortHash()` output in `detailRow()` | `explorer/app.js` (various) | `esc()` wraps `shortHash()` output | HTML_BODY | SAFE — esc() is the outer call |
| Admin token comparison | `src/l2/l2-rpc-server.ts:2419–2425` | `timingSafeEqual()` used | N/A (not rendering) | SAFE |

---

## 5. Analysis Constraints and Blind Spots

- **Legacy `dashboard/app.js` Not Deployed:** The highest-risk codebase (`dashboard/`) is not served in the current deployment. If the deployment configuration is changed to serve this directory, all stored API data instantly becomes XSS-injectable with no further attacker action needed (including the formulary XSS payload already stored via `l2_storeFormulary`).
- **Formulary XSS Payload Persisted:** A test payload `{"brandName": "<img src=x onerror=alert(1)>"}` was stored in the server's formulary buffer via `l2_storeFormulary` (admin-bypassed) and confirmed returned by `l2_getFormulary`. This payload would execute immediately if `dashboard/app.js` were served.
- **`l2_recordFill` Failed:** Attempts to inject malicious wallet IDs via `l2_recordFill` returned an internal server error, preventing confirmation of the explorer claims table shortHash XSS path. The server may validate wallet ID format.
- **`l2_registerEntity` Failed:** Attempts to inject entity display names via `l2_registerEntity` returned an internal server error. The server may require existing wallet registration.
- **No Authentication Mechanism to Steal:** The absence of session cookies limits the immediate impact of XSS to in-browser actions and credential phishing rather than session hijacking. This is an unusual but important operational context for the exploitation phase.

---

## 6. Complete Vulnerability List (All Analyzed Paths)

### XSS-VULN-01 — EXTERNALLY EXPLOITABLE — HIGH CONFIDENCE — LIVE CONFIRMED

| Field | Value |
|-------|-------|
| **ID** | XSS-VULN-01 |
| **Type** | Stored (Real-Time SSE Delivery) |
| **Source** | POST body: `data` field in `POST /viz/emit` request |
| **Source Detail** | `body.data` parameter at L2 RPC server line 416 → `handleVizEmit()` → stored in `vizEventBuffer[]` → broadcast via SSE to `/viz/events` subscribers |
| **Path** | `POST /viz/emit (body.data)` → `l2-rpc-server.ts:handleVizEmit()` → `vizEventBuffer.push(event)` → SSE broadcast to all `/viz/events` clients → `dashboard-leviathan/rpc.js:connectVizSSE() callback` → `addGossipEntry(ev)` (when type contains 'gossip','heartbeat','leader:','quorum:','peer:') → `renderGossipLog()` → `ev.data` raw in innerHTML at `app.js:1483` |
| **Sink** | `el.innerHTML` at `dashboard-leviathan/app.js:1486` |
| **Render Context** | HTML_BODY |
| **Encoding** | None. `ev.data` rendered as: `(typeof ev.data === 'string' ? ev.data : JSON.stringify(ev.data)).slice(0,60)` — no escaping |
| **Verdict** | vulnerable |
| **Mismatch Reason** | Data from untrusted `POST /viz/emit` body (admin auth bypassed) flows through SSE delivery to `innerHTML` with zero HTML encoding. The `ev.type`, `ev.from`, `ev.to` fields DO use `escHtml()` but `ev.data` does not. |
| **Witness Payload** | `{"type":"gossip:peer-announce","actor":"attacker","data":"<img src=x onerror=alert('XSS-CONFIRMED')>","lane":"gossip"}` |
| **Confidence** | High — **Live execution confirmed**: alert dialog fired in Chromium browser session |
| **Notes** | No CSP. No HttpOnly cookies. Admin auth bypass confirmed (no admin token configured → `checkAdminAuth()` returns true). Attack delivery requires victim to have dashboard open with Gossip tab active (or navigates to it). SSE history NOT replayed on reconnect. CORS wildcard allows cross-origin RPC calls from payload. |

### XSS-VULN-02 — NOT EXTERNALLY EXPLOITABLE (legacy dashboard not deployed) — HIGH CODE CONFIDENCE

| Field | Value |
|-------|-------|
| **ID** | XSS-VULN-02 |
| **Type** | Stored |
| **Source** | All RPC API response fields + SSE chain events |
| **Source Detail** | `l2_getAllBatches → b.failureReason`, `l2_getAuditLog → e.chainHash` (title attribute), `l2_getFormulary → e.brandName`, SSE `/events → event.type + event.data` |
| **Path** | Any RPC call returning string data → `dashboard/app.js` template literal interpolation → raw `innerHTML` (15+ sinks: lines 124–138, 149–163, 170–177, 191–201, 210–229, 243–253, 262–277, 292–309, 347–357, 391–401, 455–458, 507–520, 553–564, 611–615) |
| **Sink** | `innerHTML` throughout `dashboard/app.js` — zero sanitization in entire file |
| **Render Context** | HTML_BODY (most sinks), HTML_ATTRIBUTE (`title=` in `hashLink()` helper at lines 55–58) |
| **Encoding** | None — no `esc()` function, no DOMPurify, no `textContent` fallback anywhere in `dashboard/app.js` |
| **Verdict** | vulnerable |
| **Mismatch Reason** | Complete absence of any HTML encoding. Every API response string field is raw-interpolated via template literals into `innerHTML`. |
| **Witness Payload** | Formulary: `l2_storeFormulary` with `entriesJson` containing `"brandName":"<script>alert(1)</script>"` → `formularyTableBody.innerHTML` (line 347). SSE: chain event with `type: "<img src=x onerror=alert(1)>"` → `item.innerHTML` (line 611). Attribute: receipt with `receiptId: 'x" onmouseover="alert(1)'` → `title="${hash}"` in `hashLink()` |
| **Confidence** | High (code analysis) — but externally_exploitable=false (dashboard not served) |
| **Notes** | `dashboard/` is present in the codebase but `start-leviathan.ts` configures `dashboard-leviathan/` instead. A formulary XSS payload `<img src=x onerror=alert(1)>` was stored via admin-bypassed `l2_storeFormulary` and confirmed retrievable — ready to execute if dashboard is ever served. |

### XSS-VULN-03 — POTENTIALLY EXPLOITABLE (injection path unclear) — MEDIUM CONFIDENCE

| Field | Value |
|-------|-------|
| **ID** | XSS-VULN-03 |
| **Type** | Stored |
| **Source** | `r.receiptId || r.id` from `l2_getAllReceipts` / `l2_getReceiptsByWallet` |
| **Source Detail** | Receipt ID field returned in RPC responses, rendered at `explorer/app.js:315` inside onclick attribute |
| **Path** | Receipt ID from `l2_getAllReceipts()` → `renderReceiptTable()` → `html += '<tr onclick="window._showReceipt(\'' + esc(rid) + '\')">'` at explorer/app.js:315 |
| **Sink** | `innerHTML` (receipt table body, explorer/app.js ~line 330) |
| **Render Context** | JAVASCRIPT_STRING (inside a JS string within an HTML attribute) |
| **Encoding** | `esc()` applied — but `esc()` only escapes `&`, `<`, `>`, NOT `'` (single-quote) or `"`. Does NOT protect JS string context. |
| **Verdict** | vulnerable |
| **Mismatch Reason** | `esc()` is an HTML entity encoder but is used in a JavaScript string literal context where single-quote escaping (`\'`) is required. A receipt ID containing `');alert(1)//` would produce `onclick="window._showReceipt('');alert(1)//')"` — breaking out of the JS string to inject arbitrary code. |
| **Witness Payload** | `receiptId: "');alert(1)//"` → `onclick="window._showReceipt('');alert(1)//')"` |
| **Confidence** | Med — code pattern confirmed vulnerable; receipt IDs are typically server-generated hashes unlikely to contain `'`. No confirmed injection path for crafting malicious receipt IDs via external API. |
| **Notes** | Port 8000. No CSP. No cookies. Explorer at port 8000 proxies to sequencer. Receipt IDs generated from ZK proof data — if proof submission can influence receipt ID format, this becomes high confidence. |

### XSS-VULN-04 — POTENTIALLY EXPLOITABLE (injection path unclear) — LOW-MEDIUM CONFIDENCE

| Field | Value |
|-------|-------|
| **ID** | XSS-VULN-04 |
| **Type** | Stored |
| **Source** | `b.batchNumber || b.index` from `l2_getAllBatches` |
| **Source Detail** | Batch number field at `explorer/app.js:246` inside onclick attribute — NO escaping at all |
| **Path** | `l2_getAllBatches()` → `renderBatchTable()` → `html += '<tr onclick="window._showBatch(' + num + ')">'` at explorer/app.js:246 |
| **Sink** | `innerHTML` (batch table body, explorer/app.js ~line 256) |
| **Render Context** | JAVASCRIPT_STRING (unquoted numeric parameter in JS function call) |
| **Encoding** | None — `num` used completely raw |
| **Verdict** | vulnerable |
| **Mismatch Reason** | Batch number is treated as a numeric JavaScript expression with zero escaping. A value like `0);alert(1)//` would produce `onclick="window._showBatch(0);alert(1)//')"`. |
| **Witness Payload** | `batchNumber: "0);alert(1)//"` → `onclick="window._showBatch(0);alert(1)//"` |
| **Confidence** | Low — batch numbers are sequential integers generated server-side. No API allows setting a custom batch number string. |
| **Notes** | Port 8000. Same `batchNum` raw value is also used at `explorer/app.js:265`: `'<div class="loading">Loading batch #' + batchNum + '...'` → also direct innerHTML injection if batch number could be controlled. |

### XSS-VULN-05 — NOT EXPLOITABLE (server-controlled values) — LOW CONFIDENCE

| Field | Value |
|-------|-------|
| **ID** | XSS-VULN-05 |
| **Type** | Stored |
| **Source** | `b.status`, `b.workerId`, `batch.globalStateRoot`, `r.id`, `r.status` from `l2_getAllBatches` / `l2_getBatch` / `l2_getAllReceipts` |
| **Source Detail** | Batch and receipt fields rendered in `dashboard-leviathan/app.js` at lines 537, 544, 557, 1570–1574, 1583–1590 without `escHtml()` |
| **Path** | `l2_getAllBatches()` → `b.status` at dashboard-leviathan/app.js:1570 → `'<span class="badge">' + b.status + '</span>'` → `$('batch-table').innerHTML` at line 1577 |
| **Sink** | `$('batch-table').innerHTML`, `$('receipt-table').innerHTML`, `body.innerHTML` (batch detail modal) |
| **Render Context** | HTML_BODY |
| **Encoding** | None |
| **Verdict** | vulnerable (code pattern) — but not externally exploitable with current API |
| **Mismatch Reason** | Server-sourced `b.status` values are interpolated directly into innerHTML. However, batch status is a server state-machine value (pending/settling/settled/failed) and cannot be set to arbitrary HTML by an external attacker via any confirmed API path. |
| **Witness Payload** | Would require `b.status = "<img src=x onerror=alert(1)>"` — not achievable via external API |
| **Confidence** | Low — code sink is unescaped, but no external injection path for batch status values |
| **Notes** | If a future admin API or batch failure mechanism allows attacker-influenced status strings, this sink would immediately become exploitable. |
