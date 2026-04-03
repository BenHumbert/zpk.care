# Injection Analysis Report (SQLi & Command Injection)

## 1. Executive Summary

- **Analysis Status:** Complete
- **Key Outcome:** No high-severity SQL injection or command injection vulnerabilities were identified. The application uses no SQL database (confirmed: in-memory Merkle trees only) and all `child_process` invocations use hardcoded, non-user-controllable arguments. A structural path traversal weakness was identified on Nautilus entity node static file servers (ports 4001–4005), but it is **not externally exploitable via port 3030** (the in-scope target) and is functionally mitigated by a string-based `..` filter on current Node.js. No LFI, RFI, SSTI, or insecure deserialization vectors were found. The exploitation queue (`deliverables/injection_exploitation_queue.json`) contains zero actionable findings.
- **Purpose of this Document:** This report provides the complete source-to-sink trace, sanitization inventory, and negative result documentation for all injection vectors identified in the reconnaissance deliverable. It is intended to be read alongside the JSON deliverable and establishes the baseline for the exploitation phase.

---

## 2. Dominant Vulnerability Patterns

### Pattern A — Absent SQL/Command Attack Surface
- **Description:** The application is architecturally immune to SQL injection and command injection via network-controlled inputs. There is no SQL database anywhere in the codebase (storage is entirely in-memory Merkle trees, flat JSON checkpoints, and WAL files). The only `child_process` usage (`fork` in `l2-proving-pool.ts`, `exec`/`spawn` in `start-leviathan.ts`) uses hardcoded internal paths and integer-parsed environment variables. No network-supplied value reaches any shell invocation.
- **Implication:** The red team should not allocate resources to SQLi or OS command injection from the network. The application's threat model for these classes has zero exploitable surface.
- **Representative:** N/A — no vulnerability entries.

### Pattern B — Inconsistent Static File Serving Defense Depth (Structural Weakness)
- **Description:** The codebase has two distinct static file server patterns. The `l2-rpc-server.ts` (port 3030, in-scope) applies a three-layer defense: regex allowlist, `..` substring block, and `path.resolve() + startsWith()` canonicalization guard. The `nautilus-app-server.ts` (ports 4001–4005) and `start-explorer.ts` (port 8000) apply only the first two layers, missing the canonicalization-based safety net. This creates an inconsistency where the same `..` traversal defenses are not uniformly applied across all file servers.
- **Implication:** While the `!includes('..')` check blocks the known traversal sequences on current Node.js (including percent-encoded variants decoded by WHATWG URL parser before the check), the absence of a `path.resolve() + startsWith()` guard leaves no safety net against symlink attacks (if an adversary can plant a symlink in `dashboardDir` via another vulnerability) or future URL-parser behavior changes. The L2 sequencer (in-scope port 3030) is properly hardened; the weaker pattern affects only entity node ports outside the declared scope.
- **Representative:** INJ-STRUCT-01 (documented below, verdict: vulnerable, externally_exploitable: false).

### Pattern C — Safe JSON Deserialization Patterns
- **Description:** All attacker-supplied JSON bodies are parsed via `JSON.parse()` and then accessed only through hard-coded named property reads (e.g., `body.walletId`, `filter.classification`). There is no `for...in` iteration over user-supplied objects, no `Object.assign(target, userObject)` spread, no dynamic property access with user-supplied keys, and no use of `eval()`, `new Function()`, or `vm.runInNewContext()` anywhere in `src/l2/` or `src/nodes/`.
- **Implication:** Prototype pollution and insecure deserialization are not viable attack vectors. These classes can be deprioritized entirely.
- **Representative:** N/A — no vulnerability entries.

---

## 3. Strategic Intelligence for Exploitation

- **Confirmed Database Technology:**
  - **No SQL database.** The application uses custom in-memory Merkle tree forests, flat `Map`/`Array` state, and JSON file checkpoints. There is no PostgreSQL, MySQL, SQLite, or any ORM in the dependency tree. SQL injection is architecturally impossible.
  - All "database" queries are JavaScript array `.filter()`, `.find()`, and `.map()` operations over in-memory structures.

- **Confirmed Absence of Server-Side Template Engines:**
  - No Pug, EJS, Handlebars, Nunjucks, Mustache, or equivalent library is present. All HTML is static files (pre-built dashboards) or client-side rendered JavaScript. SSTI is architecturally impossible.

- **Confirmed Absence of Network-Reachable Command Injection:**
  - Three `child_process` usages confirmed in codebase:
    1. `fork()` in `l2-proving-pool.ts` — spawns ZK proving worker, path is `path.resolve(__filename, '..', 'l2-proving-worker.ts')` (internal constant, not user-controlled).
    2. `exec()` in `start-leviathan.ts:418-422` — opens browser with hardcoded `http://localhost:*` URLs at startup, guarded by `ZKTRIDENT_OPEN_BROWSERS` env var.
    3. `spawn('npx', [...], {shell:true})` in `start-leviathan.ts:509-548` — starts auxiliary services with hardcoded script paths from `path.resolve(thisDir, ...)`.
  - None of the three touch any network-supplied value.

- **Prototype Pollution Resistance:**
  - `l2_getFormularyPage` (`l2-rpc-server.ts:1260`) passes the raw `params.filter` object directly to `FormularyService.getPage()` without shape validation. However, the implementation accesses only hard-coded named properties (`filter.classification`, `filter.tierLevel`, `filter.route`, `filter.namePrefix`, `filter.planIdHash`, `filter.excludeNonCovered`). No `for...in` loop, no `Object.keys()` iteration, and no `Object.assign()` spread occurs. Prototype pollution through `{"__proto__":{...}}` in the filter object is not achievable.

- **Path Traversal — Port 3030 (In-Scope):**
  - The L2 sequencer's static file handler (`l2-rpc-server.ts:457-486`) applies the full three-layer defense: character allowlist regex + `..` string check + `path.resolve() + startsWith(dashboardDir)` canonicalization guard. An HTTP path traversal via port 3030 is not achievable.

- **Path Traversal — Ports 4001–4005 (Out-of-Scope per declared scope):**
  - Nautilus node servers use only two defense layers (regex + `..` string check), missing the `path.resolve + startsWith` guard. The `..` string check blocks all known traversal sequences including percent-encoded variants (`%2e%2e` decoded to `..` by WHATWG URL parser before the check). In practice, exploitation requires either (a) a symlink already planted inside the dashboard directory via a separate vulnerability, or (b) a future change in Node.js URL decoding behavior. Not currently exploitable via direct URL manipulation.

---

## 4. Vectors Analyzed and Confirmed Secure

The following input vectors were fully traced from source to sink and confirmed to have robust, context-appropriate defenses. They are **low-priority** for further testing.

| **Source (Parameter/Key)** | **Endpoint/File Location** | **Defense Mechanism Implemented** | **Verdict** |
|---|---|---|---|
| `req.url` pathname (GET static files) | `l2-rpc-server.ts:457-486` (port 3030) | Three-layer: regex allowlist + `!includes('..')` + `path.resolve().startsWith(dashboardDir)` | SAFE |
| `params.filter` (object) | `POST /rpc → l2_getFormularyPage` (`l2-rpc-server.ts:1260`) | Named property access only; no `for...in`; no Object.assign; JSON.parse does not mutate prototype | SAFE |
| HTTP body (any POST/PUT/DELETE) | `nautilus-app-server.ts:316-318` | `JSON.parse()` with named-property access only in all handlers; no dynamic property spread | SAFE |
| `req.url` pathname (GET static) | `start-explorer.ts:172-185` (port 8000) | Regex allowlist + `!includes('..')` blocks all `..`-based traversal (same pattern as nautilus) | SAFE (functionally) |
| `walletId` query param | `GET /interactive/member-history`, `/node/claims-by-member` etc. | Used as a Map key lookup or passed to Merkle tree queries — no SQL, no shell, no file ops | SAFE |
| `ndcHash` query param | `GET /interactive/step-therapy-check?ndcHash=Y` etc. | Used as hash key for in-memory lookups only | SAFE |
| `planIdHash` query param | `GET /node/formulary?planIdHash=X` etc. | Map key lookup in in-memory formulary store | SAFE |
| `leafIndex` query param | `GET /node/claim-proof?leafIndex=N` | Passed to `BigInt(leafIndex)` — throws on non-numeric, used for array index in Merkle tree | SAFE |
| `batchNumber` body field | `POST /interactive/retry-batch`, `/simulate-batch-failure` | Passed to `BigInt(batchNumber)` — numeric cast, used for in-memory batch map key | SAFE |
| `memberWalletId`, `ndcHash`, `pharmacyWalletId`, `prescriberWalletId` | `POST /rpc → l2_recordFill` | Used as hash/key identifiers in Merkle tree insertions; no SQL, no shell | SAFE |
| `proofJson` object | `POST /rpc → l2_submitProof` | Validated by ZK proof verifier (`ProofGateProgram.verify()`); structural integrity enforced by cryptographic constraint system | SAFE |
| `entityMetadata.displayName` | `POST /rpc → l2_registerEntity` | Stored in viz registry and served to dashboards — XSS risk for client-side, but not a server-side injection concern | SAFE (server-side) |
| `type`, `actor`, `data`, `lane` | `POST /viz/emit` | Stored as VizEvent and broadcast via SSE — XSS risk for client-side, but not a server-side injection concern | SAFE (server-side) |
| `body.walletId`, `body.preimageFields[]` etc. | `POST /interactive/register-member` | Passed to `AdjudicationSessionService` for in-memory session creation; no file/shell/SQL sinks | SAFE |
| `body.prescriptionId`, `body.quantityDispensed` etc. | `POST /interactive/fill` | Used for in-memory Merkle tree operations; numeric fields validated on use | SAFE |
| `senderType`, `recipientType`, `subject`, `body` | `POST /interactive/send-message` | Passed to encryption service for ZK message construction; no shell/SQL/file operations | SAFE |
| `body.formularyEntries` | `POST /interactive/update-formulary` | In-memory formulary map operations; no file/shell/SQL | SAFE |
| `body.walletId`, `body.tokenId`, `body.role` etc. | `POST /enrollment/process` (port 4004) | Used for roster membership map operations; no shell/SQL/file | SAFE |
| `filter`, `claims[]`, `timeBucket`, `groupBy` | `POST /reports/*` (port 4004) | Array filter/map/reduce operations on in-memory claim store | SAFE |
| `req.url` pathname (GET static) | `nautilus-app-server.ts:338-354` (ports 4001-4005) | Regex allowlist + `!includes('..')` blocks `..`-based traversal; **missing** `path.resolve + startsWith` (structural weakness, NOT currently exploitable) | SAFE (functionally) |
| All `child_process` arguments | `start-leviathan.ts`, `l2-proving-pool.ts` | All arguments are internal constants or `path.resolve(__dirname, ...)` values; no network input reaches shell | SAFE |

---

## 5. Structural Weakness — Not Currently Exploitable

### INJ-STRUCT-01: Path Traversal Defense Gap on Nautilus Static File Servers (Ports 4001–4005)

| Field | Detail |
|---|---|
| **Vulnerability Type** | PathTraversal |
| **Externally Exploitable** | false (outside port 3030 scope; functionally mitigated on current Node.js) |
| **Source** | `req.url` via WHATWG `url.pathname` — `nautilus-app-server.ts:237` |
| **Path** | `req.url` → `url.pathname` → `safePath` (line 340) → `path.join(dashboardDir, safePath)` (line 341) → `fs.readFileSync(filePath)` (line 343) |
| **Sink** | `nautilus-app-server.ts:343` — `fs.readFileSync(filePath)` |
| **Slot Type** | FILE-path |
| **Sanitization Observed** | 1) Regex `/^[/a-zA-Z0-9._-]+$/` at line 340; 2) `!safePath.includes('..')` at line 340 |
| **Missing Defense** | `path.resolve() + startsWith(dashboardDir)` canonicalization guard — present in `l2-rpc-server.ts:465-471` but absent in `nautilus-app-server.ts` |
| **Verdict** | Structurally weak (single-layer defense instead of three layers), NOT currently exploitable via direct URL manipulation |
| **Mismatch Reason** | The `!includes('..')` check blocks known `..`-based traversal sequences (including `%2e%2e` which WHATWG URL parser decodes before the check), but there is no canonicalization-based safety net. A symlink planted inside the dashboard directory would be followed silently by `fs.readFileSync`. |
| **Witness Payload** | Direct: blocked (`../../../../etc/passwd` contains `..`). Symlink: `GET /symlink_to_root HTTP/1.1 Host: host.docker.internal:4002` (requires prior filesystem write access). |
| **Confidence** | LOW — regex check is functionally blocking; symlink attack requires separate filesystem write primitive |
| **Affected Ports** | 4001 (member), 4002 (prescriber), 4003 (pharmacy), 4004 (insurer), 4005 (employer) — all outside port 3030 scope |
| **Ports NOT Affected** | 3030 (l2-rpc-server.ts applies full three-layer defense) |

**Remediation:** Apply the same three-layer pattern used in `l2-rpc-server.ts:461-471` to `nautilus-app-server.ts:340-342`:
```typescript
const relativePath = safePath.replace(/^\/+/, '');
const resolved = path.resolve(this.config.dashboardDir, relativePath);
if (!resolved.startsWith(this.config.dashboardDir)) {
  res.writeHead(403); res.end('Forbidden'); return;
}
```

---

## 6. Analysis Constraints and Blind Spots

- **SSRF Vectors Excluded from This Report:** Section 9.1 of the recon documents four SSRF vectors (`insurerUrl` in prescriber/pharmacy/member/employer enrollment routes, gossip relay `knownPeers`, explorer `/viz/*` proxy). SSRF is not within the injection analysis scope (SQLi / CommandInjection / LFI / RFI / SSTI / PathTraversal / InsecureDeserialization). These vectors should be analyzed by an SSRF specialist.

- **XSS Vectors Excluded from This Report:** Section 9.2 documents multiple stored XSS vectors in legacy dashboards (`dashboard/app.js`, `explorer/app.js`). These are client-side injection concerns outside this specialist's scope.

- **ZK Proof Inputs Not Fully Analyzable:** The `proofJson` submitted to `l2_submitProof` passes through the o1js ZK proof verifier (`ProofGateProgram.verify()`). The cryptographic constraint system enforces structural integrity, but the internal serialization format of o1js proof objects was not fully audited for insecure deserialization. The risk is assessed as low given the mathematical verification, but the o1js library version (2.13.0) and its `fromJSON` implementation were not statically analyzed.

- **`l2_getFormularyPage` Filter Robustness:** While prototype pollution is not achievable via the filter object, passing non-string/non-number values to filter fields (e.g., `filter.classification = {}`) would cause a `TypeError` in `formulary-service.ts:409` where `.toUpperCase()` is called. This is a robustness issue (denial of service for that request) but not a security injection vulnerability.

- **Checkpoint Filename Parameter:** `l2-checkpoint.ts:328` has a `load(filename)` method that constructs a path as `path.join(this.dataDir, filename)`. All callers use filenames sourced from `fs.readdir()` filtered by prefix/suffix (internal, not user-controlled). This is not an exploitable path, but the method itself is not hardened with a `startsWith` guard — a future caller passing user input here would create a path traversal.
