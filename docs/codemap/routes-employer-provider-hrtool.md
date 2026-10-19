# Code map — employer orchestrator, employer node, HR Tool, prescriber node, pharmacy node, onboarding tokens

Scope: `src/nodes/employer-orchestrator.ts`, `employer-node.ts`, `start-employer-nautilus.ts`, `routes/employer-routes.ts`; `src/tools/hr-tool-server.ts`, `hr-tool-core.ts`, `hr-tool.ts`; `src/nodes/prescriber-node.ts`, `start-prescriber-nautilus.ts`, `routes/prescriber-routes.ts`; `pharmacy-node.ts`, `start-pharmacy-nautilus.ts`, `routes/pharmacy-routes.ts`; `src/onboarding/token-authority.ts`, `group-enrollment-token.ts`, `employer-attestation.ts`, `group-registry.ts`, `opaque-roster.ts`, `plan-template.ts`, `rep-enrollment-token.ts`. Mapped 2026-10-16 against the working tree; `git status` shows none of these files modified by the uncommitted "registry fix".

Conventions. **ADMIN** = route registered with `adminOnly: true`; the shared server gates it at nautilus-app-server.ts:392-396 via `checkNautilusAdminAuth` (165-206): Ed25519 `X-Admin-Signature` only when `config.authorizedClientKeys` is non-empty (167) — `registerClientKey` (212) has no callers anywhere in `src/`, so in practice the gate is `Authorization: Bearer <node adminToken>` compared timing-safe (198-205), default-deny when no token configured (199). **OPEN** = no gate. `ZKTRIDENT_UNSECURE` is read only by start-leviathan.ts:80; the employer/provider starters never read it. Built-in routes `/health`, `/onboarding/status`, `/events`, `POST /rpc` (nautilus-app-server.ts:364-381) are mapped by the shared-server agent.

## 1. Employer orchestrator (`src/nodes/employer-orchestrator.ts`)

Entry `spawnEmployerTenant({employerId, employerPubKeyHex, sequencerUrl, insurerUrl, insurerAdminToken})` (170-188). Sole caller: marketplace-routes.ts:756-763 from `POST /marketplace/api/activate/:applicationId` (703-706, not adminOnly), with `insurerUrl = http://localhost:<insurer port||4004>` (715) and `insurerAdminToken = insurer node's config.adminToken` (716).

| Step | Fact | Source |
|---|---|---|
| Idempotency | In-memory `liveTenants: Map<employerId, LiveTenant>` (51-62); if both children alive, returns the stored URLs **and adminToken** (194-202) | 62, 194-202 |
| Registry cross-check | `l2_getEmployerNode` (no auth) (209-216); if registered and `GET <employerNodeUrl>/health` ok → throw "already running… token not recoverable" (230-242); if dead → `l2_deregisterEmployerNode` with insurer Bearer (246-254) | 206-258 |
| Attestation pin | `l2_getEmployerAttestation` (262-270); requires `result.employerId === employerId` (272) and `result.publicKeyHex` == `employerPubKeyHex` case-insensitive (275) | 260-280 |
| Ports | `allocateEphemeralPort`: bind `127.0.0.1:0`, read assigned port, close (112-125); one for employer, one for HR Tool (283-284) | 112-126, 283-284 |
| Admin token | `${employerId.toLowerCase()}-admin-${randomBytes(16).hex.slice(0,16)}` = 64 random bits (158-162); fingerprint = sha256 hex[0:16] (164-166) | 154-166 |
| Employer child | `spawn('npx', ['tsx', start-employer-nautilus.ts], {shell:true, stdio:['ignore','pipe','pipe']})` (289-304); env = `...process.env` (parent insurer env inherited, 291) + `ZKTRIDENT_PORT`, `ZKTRIDENT_HOST='127.0.0.1'`, `ZKTRIDENT_EMPLOYER_ID`, `ZKTRIDENT_EMPLOYER_PUBKEY_HEX`, `ZKTRIDENT_SEQUENCER_URL`, `ZKTRIDENT_INSURER_URL`, `ZKTRIDENT_ADMIN_TOKEN=<token>`, `ZKTRIDENT_UNSECURE='true'` (inert for this script), ~~`ZKTRIDENT_CORS_ORIGINS='*'`~~ **removed by A2: the spawned node resolves the local dashboard origins itself** (292-300); child stdout/stderr relayed with `[tenant id]` prefix (305-306); no `cwd` set | 287-308 |
| Employer health wait | poll `GET /health` until `body.ok && body.data.phase==='ready'`, 60 s budget, 500 ms interval, 2 s per request (130-152, 312-317); failure → SIGTERM employer (319) | 310-321 |
| HR Tool child | **Not spawned since A7.** The HR Tool runs on the employer's machine (`npm run start:hr-tool`); activation returns `hrToolSetup` steps instead of a URL. The employer child is now spawned from `process.execPath` with `--import tsx` (no npx, no shell), given `ZKTRIDENT_PARENT_PID`, and exits on its own when that process is gone (`parent-watchdog.ts`); `ZKTRIDENT_UNSECURE` is stripped from the inherited environment | employer-orchestrator.ts (Step 4) |
| HR Tool wait | poll `GET /api/session` for any JSON, 30 s (345-350); failure → SIGTERM both (352-353) | 344-355 |
| Register tenant | `l2_registerEmployerNode {employerId, employerNodeUrl, hrToolUrl, pid, adminTokenFingerprint}` with `Authorization: Bearer <insurerAdminToken>` (359-376); JSON-RPC error → SIGTERM both, throw (378-384) | 357-385 |
| Track / keepalive | `liveTenants.set` (388-399); keepalive every 60 s re-sends `l2_registerEmployerNode` for live tenants (69-101, timer `unref`'d 103-105) | 387-400, 64-106 |
| Child exit | `exit` handler: best-effort `l2_deregisterEmployerNode`, `liveTenants.delete` (403-418). **No restart** of a dead child | 402-418 |
| Return / storage of token | Returned `{employerId, employerNodeUrl, hrToolUrl, adminToken}` (422-427) → marketplace `activationJobs` Map in memory (marketplace-routes.ts:63, 765-769) → sent as JSON to the browser by `POST …/activate/:id` (737) and `GET …/activate-status/:jobKey` (828; route 790-793 not adminOnly). Also kept in `liveTenants.adminToken` (57, 394). Orchestrator logs URLs only (420), never writes the token to disk | 422-427; marketplace-routes.ts:63,737,765-769,828 |
| Shutdown | `shutdownAllTenants()` SIGTERMs all children, clears map (431-442); called from start-insurer-nautilus.ts:256-257 on SIGINT/SIGTERM. `listLiveTenants` (445-452) has no callers | 430-452 |

GAP: I7 — the per-tenant admin token is delivered by two ungated marketplace routes and replayed from an in-memory job map (marketplace-routes.ts:737, 828).

## 2. Employer node

### 2.1 Startup (`src/nodes/start-employer-nautilus.ts`)

| Item | Fact | Source |
|---|---|---|
| Env defaults | `ZKTRIDENT_PORT` 4005 (58); `ZKTRIDENT_HOST` **127.0.0.1** since A2, was `0.0.0.0` (59); `ZKTRIDENT_SEQUENCER_URL` http://localhost:3030 (60); `ZKTRIDENT_STATE_DIR` ./nautilus-data (61); TLS cert/key optional (62-63); SSE on, max 50 (64-65); `ZKTRIDENT_CORS_ORIGINS` default `['*']` (66-68); `ZKTRIDENT_ADMIN_TOKEN` optional (70; without it admin routes default-deny, banner 229) | 54-71 |
| Required | `ZKTRIDENT_EMPLOYER_ID` (80-84); `ZKTRIDENT_EMPLOYER_PUBKEY_HEX` 64 hex (89-99); `ZKTRIDENT_INSURER_URL` optional, must be http(s) (100-104) | 80-104 |
| Node | `new EmployerNode({employerId, insurerUrl, sequencerUrl, clientOptions:{adminToken}})` (122-129); `setRequireAttestation(true)` (135) | 120-135 |
| Attestation load | `l2_verifyEmployer` unauthenticated (152-157); needs `result.valid && result.attestation` (159); `att.publicKeyHex` must equal the pinned env key (165) → mismatch `process.exit(1)` (198-201); retries at 0/500/1000/2000/4000/8000/16000 ms (189); not loaded after 7 tries → `exit(1)` (205-210). **Fail-closed by construction** | 145-210 |
| Ready | `setOnboardingPhase('ready')` before `server.start()` (212, 216) — so `/onboarding/configure` is always 409 | 212-216 |

### 2.2 State held (`src/nodes/employer-node.ts`) — memory only, nothing persisted

| Field | Content | Source |
|---|---|---|
| `tokenAuthority` | `new TokenAuthority(employerId)` (106) → `Map<tokenId, TokenRecord>` (token-authority.ts:89, 94) | 91, 106 |
| `groups` | `Map<groupId, EmployerGroupRecord>`: groupId, groupIdHash=`Poseidon([hashString(groupId)])`, planId, planIdHash, effectiveDate, terminationDate, enrollmentCap, enrolledCount, status, createdAt (44-55, 189-200). Note: group.groupIdHash ≠ token.groupIdHash=`hashString(groupId)` (group-enrollment-token.ts:118) | 92, 44-55, 191 |
| `roster` | `Map<employeeIdHash, {employeeIdHash, groupIdHash, familyIdHash, tokenId, walletId, status, createdAt}>` (78-86); `generateToken` overwrites the entry for a repeated hash (315-323) | 93, 78-86 |
| `insurerUrl`, `employerId`, `sequencerUrl`, `employerWalletId`=`Poseidon([hashString(employerId)])`, `attestation`, `requireAttestation` | — | 94-102, 110, 145 |
| Disk | No `save()` in this file; the local state is never unlocked by the starter, so `state.getState()` is null at employer-routes.ts:68-70. Groups/tokens/roster are lost on restart | — |

Checks inside the node: `createGroup` dup (171), fail-closed without attestation (176-181), plan in `authorizedPlanIds` (182-187). `generateToken` group exists (298), not terminated (299), cap `enrollmentCap>0 && enrolledCount>=enrollmentCap` (301-303; pending tokens not counted). `isPlanAuthorized` without attestation returns `!requireAttestation` (153-160). `submitTokenToInsurer` POSTs `{walletId, tokenId, role:'member'}` to `<insurerUrl>/enrollment/process` **without any auth header** (376-384) and on 2xx stores `walletId` on the roster (391-404). `confirmEnrollment` stores `walletId` (429-450). `refreshAttestationFromSequencer` replaces the attestation **without** the pubkey pin check done at startup (115-132 vs start-employer-nautilus.ts:165). `sendMessage`: ephemeral X25519 + AES-GCM when the recipient has an `l2_getEncryptionKey` entry, otherwise **hex-encoded plaintext** (501-527); `messageCommitment = Poseidon([hashString(ciphertext[0:64])])` (529-531); message type `'2'` (538).

### 2.3 Routes (`src/nodes/routes/employer-routes.ts`) — 25 routes: 12 ADMIN, 13 OPEN

| Method | Path | Auth | Checks in order (GAP:) | Calls out | Writes | Source |
|---|---|---|---|---|---|---|
| POST | /onboarding/configure | OPEN | phase==='ready' → 409 (47-50; always true after startup); `employerId` required (52-55). GAP: I7 — unauthenticated route that would replace the entity node (58-66) if the phase check ever passed | — | new EmployerNode; state.save if state loaded (68-75) | 43-84 |
| POST | /groups | ADMIN | node (97-98); groupId/planId/effectiveDate (100-108); createGroup dup/attestation/plan (employer-node.ts:171-187) → 409 on error | — | groups | 92-118 |
| GET | /groups | ADMIN (A7) | node | — | — (returns groupId, planId, counts, remainingSlots via listGroupsWithStats 129) | 120-131 |
| GET | /groups/:groupId | ADMIN (A7) | node; 404 | — | — | 133-143 |
| GET | /groups/:groupId/stats | ADMIN (A7) | node; 404 | — | — | 147-157 |
| DELETE | /groups/:groupId | ADMIN | node; terminationDate default today (168); not found / already terminated → 409 (employer-node.ts:209-210) | — | group.status='terminated' (212-213) | 159-178 |
| POST | /tokens/generate | ADMIN | node; groupId, employeeIdHash, validUntil required (199-201); familyIdHash defaults to employeeIdHash (202); ISO→CCYYMMDD (205-207); **caller may supply tokenId** (197, 210); node checks group/terminated/cap (employer-node.ts:298-303) | — | TokenRecord status 'unused' (token-authority.ts:152-161); roster entry 'pending' (employer-node.ts:315-323) | 184-222 |
| GET | /tokens/:tokenId | ADMIN | node; 404 | — | — (status, groupIdHash, planIdHash, validUntil, consumedByWalletId, consumedAt 233-241) | 224-243 |
| POST | /tokens/:tokenId/revoke | ADMIN | node; not found / consumed → 409 (token-authority.ts:228-232) | — | status 'revoked' (234) | 245-260 |
| POST | /tokens/:tokenId/set-pin-hash | ADMIN | node; tokenPinHash required (270-273); exists (token-authority.ts:245), status unused (246), not already set (247) | — | record.tokenPinHash (248) | 263-282 |
| POST | /tokens/:tokenId/validate | **INSURER-SIGNED** (since A6) | node; per-caller 60/min and overall 600/min → 429; no attestation loaded → 503; `X-Admin-Signature` by `insurer` verified against `attestation.insurerPublicKeyHex` over method + path + timestamp + sha256(body received), 30 s window, replay cache → else 401; `tokenPinHash` required → 400; orphan (unused, no PIN hash) → 409; then `redeemTokenWithPin`, which validates and consumes in one step | — | on success: token status 'consumed' + consumedAt; roster entry status 'enrolled'; group enrolledCount++ once. No wallet ID is received or stored (I6) | employer-routes.ts `/tokens/:tokenId/validate`; token-authority.ts `redeemTokenWithPin`; security/signed-request.ts Since B8 (A-34) a valid answer also names the code's opaque `familyIdHash`, which the insurer passes to the engine in its approval. |
| ~~POST~~ | ~~/tokens/:tokenId/submit~~ | — | **Removed 2026-10-17 (A6).** It carried the member wallet ID to the employer (I6). | — | — | — |
| ~~POST~~ | ~~/enrollment/confirm~~ | — | **Removed 2026-10-17 (A6).** The validate oracle marks the roster entry enrolled when the PIN verifies; the member node no longer calls the employer at all. | — | — | — |
| GET | /roster | ADMIN | node; `?status` filter | — | — (entries: employeeIdHash, groupIdHash, familyIdHash, tokenId, status, createdAt — no wallet column since B6) | employer-routes.ts |
| GET | /roster/:employeeIdHash | ADMIN | node; 404 | — | — | 386-397 |
| DELETE | /roster/:employeeIdHash | ADMIN | node; not found → 404 | — | roster.status='terminated' (employer-node.ts:456); token untouched | 399-414 |
| GET | /sequencer/chain-state | OPEN | node | L2Client.getChainState | — | 420-428 |
| GET | /sequencer/status | OPEN | node | L2Client.getStatus | — | 430-438 |
| POST | /messaging/send | OPEN | node; recipientWalletId+body (450-453). GAP: I7 — unauthenticated send as the employer pseudo-wallet; plaintext-hex fallback (employer-node.ts:523, 526) | `l2_getEncryptionKey`, `l2_storeMessage` (employer-node.ts:501-549) | message store | 444-461 A10b: the sequencer now refuses this send — the employer pseudo-wallet has no signing key, and under I6 the employer must not know a member wallet to send to; listed for removal in the cleanup pass. |
| GET | /messaging/inbox | OPEN | node | `getMessagesByRecipient(employerWalletId)` | — | 463-476 |
| GET | /messaging/sent | OPEN | node | `getMessagesBySender` | — | 478-491 |
| GET | /messaging/thread/:threadIdHash | OPEN | node | `getMessagesByThread` | — | 493-506 |
| GET | /attestation | OPEN | node | `l2_getPlans` at most every 30 s (`EmployerNode.attestationTermsStatus`, `TERMS_STATUS_TTL_MS`; since 2026-10-19, A-48) | — (loaded, authorizedPlanIds, enrollmentCap, effectiveDate, employerId, attestationSeq, and `termsChanged`, `signedBeforeFullTerms`, `unavailablePlanIds`; null when the plans cannot be read; since 2026-10-19 also `plansToAdd`, the selected plans published now that the attestation does not cover, from the insurer's `GET /employer-agreements/:applicationId/plans-to-add` (`EmployerNode.attestationPlansToAdd`: 5 s timeout, reused for `TERMS_STATUS_TTL_MS`, null when it cannot ask), and `marketplaceUrl`, where the employer signs new terms) | 538-563 |
| POST | /attestation/refresh | ADMIN | node | `l2_verifyEmployer` (employer-node.ts:118-122) | node.attestation replaced, no pubkey pin check (125) | 537-551 |
| GET | /plans/available | OPEN | node | `getPlans` → only plans with published terms, at those terms (`planAsPublished`; since 2026-10-19, A-48) | — | 584-602 |

### 2.4 Enrollment-code lifecycle

Token ID: `tokenId ?? \`TOKEN-${Date.now()}-${this.nonceCounter}\`` (token-authority.ts:130); `nonce = nonceCounter++` (131), counter starts at 0 per `TokenAuthority` instance (95-96), one instance per employer node (employer-node.ts:106) → IDs can collide across employers (same ms + counter) and across restarts; the ADMIN caller may also choose the ID (employer-routes.ts:197, 210). `tokenIdHash = hashString(tokenId) = Poseidon(Encoding.stringToFields(tokenId))` (group-enrollment-token.ts:117; hash-utils.ts:31-34).

`GroupEnrollmentToken` (group-enrollment-token.ts:50-67): `tokenIdHash, groupIdHash, planIdHash, employeeIdHash, familyIdHash, validUntil(Field CCYYMMDD), issuerHash, nonce`; `commitment()` = Poseidon of all 8 (72-83). `buildGroupEnrollmentToken` re-hashes the HR Tool's hashes (120-121; intent stated token-authority.ts:133-137). `TokenRecord` (token-authority.ts:31-52): `token, tokenId, validUntil, groupIdHash, planIdHash, tokenPinHash?, pinAttempts?, status 'unused'|'consumed'|'expired'|'revoked', consumedByWalletId?, consumedAt?`.

| Transition | Preconditions | Effect | Who | Source |
|---|---|---|---|---|
| generate | group exists, not terminated, under cap (employer-node.ts:298-303) | record `status:'unused'`, no pin hash (token-authority.ts:152-161); roster 'pending' | HR Tool `/api/import` (hr-tool-server.ts:676-681) or CLI (hr-tool.ts:255-260) via ADMIN route | employer-routes.ts:184-222 |
| set-pin-hash | status unused (246), hash not already set (247) | `tokenPinHash = Poseidon([...stringToFields(tokenId), Field(0), ...stringToFields(pin)])` computed by HR Tool (hr-tool-core.ts:307-313); PIN = 8 digits, rejection-sampled (285-293) | HR Tool (hr-tool-server.ts:705-709); failure → revoke (712) | token-authority.ts:243-249; employer-routes.ts:263-282 |
| validate (no PIN path) | record exists, status unused, today ≤ validUntil | returns `{valid, groupIdHash, planIdHash}`. **Since A6 the oracle never takes this path**: a token with no PIN hash is an orphan (409 at the route, refused again inside `redeemTokenWithPin`); `validateToken` remains for the in-process `EnrollmentService` | insurer-routes.ts `redeemWithEmployers`: one signed probe to the employer the code's prefix names, never a fan-out | token-authority.ts `validateToken` / `redeemTokenWithPin` |
| validate (PIN path) | base valid; `pinAttempts < 5` (252, 279-282) | missing pin → attempts+1 (284-287); `timingSafeEqual` after length check (290-295); mismatch → attempts+1, returns remaining (297-301); match → attempts=0 (304). Lock does not change `status`; the no-PIN path ignores `pinAttempts`. **Since A6 the oracle calls `redeemTokenWithPin`: this check, then status 'consumed'** | same | token-authority.ts:266-308 |
| consume | status unused (214-216) | `status:'consumed'`, `consumedByWalletId`, `consumedAt` (218-220) | only caller enrollment-service.ts:378 (insurer-side TokenAuthority instance). **Never invoked on the employer node** → a validated code stays 'unused' and re-validates until expiry/revoke | token-authority.ts:211-221 |
| expire | today > validUntil during validate | `status:'expired'` lazily (194) | any validate | token-authority.ts:190-196 |
| revoke | not consumed (230-232) | `status:'revoked'` (234) | ADMIN route; HR Tool on pin-hash failure | token-authority.ts:227-235; employer-routes.ts:245-260 |
| terminate | roster entry exists | roster `status:'terminated'` (employer-node.ts:456); token unchanged; group termination (212-213) blocks new tokens (299) but not validation of existing ones | ADMIN routes | employer-routes.ts:399-414, 159-178 |

## 3. HR Tool (`src/tools/hr-tool-server.ts`, `hr-tool-core.ts`, `hr-tool.ts`)

### 3.1 Process model

| Item | Fact | Source |
|---|---|---|
| Instance | One per employer, run by the employer on the HR admin's own machine (`npm run start:hr-tool`, default `PORT` 5050). Not forked by the orchestrator since A7 | hr-tool-server.ts |
| Bind | `server.listen(PORT, '127.0.0.1')` | 967 |
| Config | `HR_TOOL_DATA_DIR` default ./hr-tool-data; `EMPLOYER_NODE_URL` is only the default offered on the setup screen. The employer node URL and the admin token are entered once at `POST /api/setup` and stored encrypted under the passphrase (`admin.token.enc`, mode 0600); `EMPLOYER_ADMIN_TOKEN` is not read (A7) | hr-tool-server.ts |
| Auth to employer | Bearer with the token decrypted from the open workspace and held in memory while unlocked (A7); else Ed25519 `X-Admin-Signature`/`X-Content-Hash` with the workspace client key, for a node whose key registry was populated out of band (A9's remainder wires this up). 10 s fetch timeout | hr-tool-server.ts proxyToEmployer |
| Browser-side auth | none per request; one global session (214-230); `requireWorkspace` = unlocked (256-263), `requireGroup` = unlocked + group selected (267-274); 15-min inactivity lock (85, 236-242, 965); no CORS headers, CSP/X-Frame headers (914-918); 10 MB body cap (84, 116-134) | 206-274, 909-960 |
| Passphrase in memory | `activePassphrase` retained for re-encryption (218, 339, 370), cleared on lock/timeout (247, 240) — header comment at 29 says "discarded"; code keeps it | 218, 244-252 |
| Audit log | plaintext TSV `ts\taction group=…\tdetail` to the group or workspace `audit.log` (187-204); details include `employeeId=<plaintext>` (792) and search strings (773) | 187-204 |

### 3.2 First run / unlock (`POST /api/unlock`, 309-392)

Passphrase: string, length ≥ 8, no other rule (312-315); no confirmation on first run; no attempt limiter on wrong passphrase (403 at 388-391). Workspace dir = `DATA_DIR/workspace-<sha256(lowercased url)[0:16]>` (hr-tool-core.ts:566-585). New workspace (metaFile absent, 321): mkdir `wsDir` + `groups/` (323-324); write `workspace.meta.enc` (325-331); generate Ed25519 client key `hr-tool-<wsDirName>` and write `client.key.enc` (333-335; core 622-637); session set (337-344); returns `authMode:'ed25519', clientId, publicKeyHex` (347-356). Existing: decrypt meta (361), load client key if present else Bearer fallback (363-366).

Key derivation (hr-tool-core.ts): scrypt `N=2^17, r=8, p=1, keylen 32, maxmem 512 MB` (40-44, 143-150); per-file random 32-byte salt and 12-byte IV, 16-byte tag, layout `salt||iv||tag||ct`, AES-256-GCM (153-162, 175-184). Atomic write temp→fsync→rename (199-206).

### 3.3 Workspace files on disk (`hr-tool-core.ts:576-601`)

| File | Contents | Encryption | Writer |
|---|---|---|---|
| `workspace.meta.enc` | `{version:1, employerNodeUrl, createdAt, label}` (102-108) | AES-256-GCM, key = scrypt(passphrase) (236-239) | hr-tool-server.ts:331 |
| `client.key.enc` | `{clientId, privateKeyHex, publicKeyHex, createdAt}` Ed25519 (611-616) | same (633-637) | 335, 894 |
| `audit.log` (workspace) | plaintext | none | 200-201 |
| `groups/<gid>/group.seed.enc` | 32 random bytes as hex (211-213) | same (216-219) | 503 |
| `groups/<gid>/correlation.table.enc` | `{groupId, planId, createdAt, entries[]}` (92-97); entry: `employeeIdHash, familyIdHash, employeeId, familyId, firstName, lastName, dob, email?, tokenId?, tokenIdHash?, tokenPIN? (plaintext 8 digits), tokenPinHash?, status, createdAt` (72-89) | same (408-416) | 489, 496, 510, 738 via `saveTable` (276-280) |
| `groups/<gid>/token-distribution.enc` | path defined (598) | — | never written by the server; CLI only (hr-tool.ts:294-298) |
| `groups/<gid>/audit.log` | plaintext | none | 196-198 |

`groupId` must match `^[a-zA-Z0-9_\-]+$`, ≤ 64 (core 50, 229-231).

### 3.4 CSV import pipeline

| Stage | Fact | Source |
|---|---|---|
| Parse | required columns `employee_id, family_id, first_name, last_name, dob`; optional `email`; others → `extra`; required cells non-empty | hr-tool-core.ts:325-377 |
| Hash | `employeeIdHash = hashWithSeed(employeeId, seed, tag 1)`, `familyIdHash = hashWithSeed(familyId, seed, tag 2)` (455-456); `hashWithSeed`: `seedField = Poseidon([3, ...stringToFields(seed.hex)])`, `idField = Poseidon([tag, ...stringToFields(id)])`, out = `Poseidon([tag, seedField, idField])` (259-263; tags 53-55). No per-record salt; seed is per {workspace, group} (hr-tool-server.ts:499-503). Names/DOB/email are never hashed or sent | hr-tool-core.ts:446-480 |
| Dedupe | by `employeeIdHash` against the table (607-617); dry run returns plaintext employeeId/familyId/name preview (619-632) | hr-tool-server.ts:597-632 |
| Capacity | `GET /groups/:id/stats` fail-closed 503 (643-654); `!isUnlimited && toProcess > remainingSlots` → 409 (656-660) | 634-660 |
| Per row | `pin = generateTokenPIN()` (670) → `POST /tokens/generate {groupId, employeeIdHash, familyIdHash, validUntil}` (676-681); on 409 recover tokenId from `GET /roster/:employeeIdHash` (686-696); `pinHash = hashTokenPIN(tokenId, pin)` (705) → `POST /tokens/:id/set-pin-hash {tokenPinHash}` (707-709); failure → `POST /tokens/:id/revoke` (712); success entry gets `tokenId, tokenIdHash, tokenPIN, tokenPinHash, status 'token_generated'` (719-723) | 662-731 |
| Persist | only successes appended (734-736); `saveTable()` (738); audit (743) | 733-748 |

Wire to employer node per row, by name: `groupId` (plaintext), `employeeIdHash`, `familyIdHash`, `validUntil`, then `tokenPinHash`. Never: names, dob, email, employeeId, PIN.

### 3.5 Export routes

`GET /api/export/tokens` (840-854): for entries with `tokenId && status==='token_generated'` returns `{employeeIdHash, tokenId, tokenIdHash, tokenPIN (plaintext), validUntil:'' (849), displayName "First L."}` — **code and plaintext PIN together** in one response to the browser. `GET /api/employees` (755-775) returns full plaintext entries incl. `tokenPIN`. `GET /api/employees/:id` (778-794) resolves by employeeId, by `hashWithSeed(id)`, or by hash, returns the full entry.

### 3.6 Routes (`hr-tool-server.ts`) — 18 API routes + static. Auth: NONE / WS (`requireWorkspace`) / GROUP (`requireGroup`)

| Method | Path | Auth | Checks in order (GAP:) | Calls out | Writes | Source |
|---|---|---|---|---|---|---|
| GET | /api/workspaces | NONE | lists `workspace-*` dir count | — | ensureDataDir | 289-304 |
| POST | /api/unlock | NONE | passphrase required; opens the one existing workspace or the one named by `employerNodeUrl`; wrong passphrase → 403 and counted, throttled → 429 with Retry-After (three free, then 2 s doubling to 15 min, `attempts.json`); no workspace → 409 pointing at setup (A7) | — | session; token decrypted into memory | hr-tool-server.ts |
| POST | /api/setup | NONE | `employerNodeUrl` http(s), `adminToken` ≥ 16 chars, passphrase ≥ 12 and equal to its confirmation; 409 if the workspace exists (A7) | — | workspace.meta.enc, client.key.enc, admin.token.enc (0600) | hr-tool-server.ts |
| POST | /api/workspace/admin-token | WS | passphrase again (re-auth, counted on the unlock limiter); stores or rotates the token (A7) | — | admin.token.enc | hr-tool-server.ts |
| GET | /api/groups | WS | proxy `GET /groups` (400); annotate local seed/table (405-423) | employer | — | 397-428 |
| POST | /api/group/select | WS | groupId required + regex (440-441); employer `GET /groups/:id` 404/502 (446-452); load seed (460-465) or create seed+table (498-511); corrupt table → 500 (469-480); planId reconcile (493-497) | employer | group.seed.enc, correlation.table.enc | 436-531 |
| POST | /api/group/deselect | WS | — | — | session | 534-541 |
| POST | /api/lock | NONE | — | — | clears session (244-252) | 544-548 |
| GET | /api/session | NONE | — | — | — (workspaceActive, employerNodeUrl, groupId, planId, entryCount, authMode) | 551-561 |
| GET | /api/stats | GROUP | status counts; employer `/health` (574) | employer | — | 564-579 |
| POST | /api/csv/preview | GROUP | csvContent required; parseCsv; returns first 10 raw PII rows (590) | — | audit | 582-594 |
| POST | /api/import | GROUP | §3.4 | employer stats/generate/roster/set-pin-hash/revoke | table | 597-752 |
| GET | /api/employees | GROUP | `?status`, `?search`; entries without `tokenPIN`/`tokenPinHash` (A7) | — | audit: filter and whether a search happened, never the term | hr-tool-server.ts |
| GET | /api/employees/:id | GROUP | id has no '/'; entry without PIN fields (A7) | — | audit with an `employeeIdHash` prefix, not the ID | hr-tool-server.ts |
| POST | /api/employees/:employeeIdHash/pin | GROUP | passphrase again (re-auth, counted on the unlock limiter); 404 when no PIN is on file (A7) | — | audit `pin:reveal employeeIdHash=…` | hr-tool-server.ts |
| POST | /api/reconcile | GROUP | employer `GET /roster` (800); hash-set reconcile (804; core 492-535); sync 'enrolled' (808-815) | employer | table if synced | 797-837 |
| GET | /api/export/tokens | GROUP | §3.5; codes only, no `tokenPIN` since A7 | — | audit | hr-tool-server.ts |
| GET | /api/employer/health | NONE | proxy `/health` (Bearer attached, 155-156) | employer | — | 857-864 |
| GET | /api/employer/plans | NONE | proxy `/plans/available` | employer | — | 867-874 |
| GET | /api/identity | WS | — | — | — | 877-885 |
| POST | /api/identity/generate | WS | no existing key (890) | — | client.key.enc | 888-902 |
| GET | /* | NONE | traversal guard (935-941); SPA fallback (943-951) | — | — | 933-959 |

### 3.7 `hr-tool.ts` (CLI)

Commands `init/import/lookup/reconcile/export/status` (25-39, 562-583). Uses the **legacy flat layout** `hr-tool-data/<groupId>/` via `groupPaths` (hr-tool.ts:165, 211; hr-tool-core.ts:546-561), not the server's workspace layout, so CLI and server share no state. `import` calls only `/tokens/generate` (255-260) — no PIN, no `set-pin-hash` → CLI-issued codes validate with no PIN (employer-routes.ts:307-309); writes `token-distribution.enc` (294-298). `export` prints/writes plaintext `name\ttokenId\tvalidUntil` (453-473). Passphrase from `HR_TOOL_PASSPHRASE` or a readline prompt that echoes (96-105). Admin token from `EMPLOYER_ADMIN_TOKEN` (140-143). Referenced only by package.json:31 (`"hr-tool"` script); not by the orchestrator or dashboards. Status: runnable but out of sync with the server.

## 4. Prescriber node (:4002)

### 4.1 Startup (`src/nodes/start-prescriber-nautilus.ts`)

Env: `ZKTRIDENT_PORT` 4002 (59), `ZKTRIDENT_HOST` 127.0.0.1 since A2 (60), sequencer (61), stateDir ./nautilus-data (62), CORS `['*']` (67-69), prover URL/key (71-72), `ZKTRIDENT_ADMIN_TOKEN` (73; the launcher passed none from A9 until 2026-10-19, and now passes the node's own token, `ZKTRIDENT_PRESCRIBER_ADMIN_TOKEN` or derived from the operator's), `ZKTRIDENT_PIN` (83), dashboard-prescriber (78-81). Seed mode `ZKTRIDENT_SEED_PRESCRIBER` (102-167): picks `PRESCRIBERS[idx|name]` (107-113) whose `enrollmentKey` comes from `src/data/prescribers.json` (data/index.ts:278-289; 16 `enrollmentKey` entries, e.g. prescribers.json:7); `walletId = derivePrescriberWalletId(localData, enrollmentKey)` (122); node built with walletId only (129-134) — **no enrollment key is placed in local state**; phase `awaiting_credentialing`, `server.start()` (138-139); polls `l2_getProvider` ≤ 60×1 s for `credentialState===2` (144-158); `ready` either way (160-166). Recovery mode (171-202): state+PIN → unlock/load walletId (172-187); PIN only → create encrypted state phase `awaiting_token` (188-197); no PIN → fresh onboarding (198-201). Shutdown locks state (234).

### 4.2 State held

| Item | Where | Source |
|---|---|---|
| walletId, sequencerUrl, displayName, L2Client, partition clients | `PrescriberNode`/`EntityNodeBase` memory | prescriber-node.ts:54-59; entity-node-base.ts:49-52 |
| compiled flag, proofTimings | memory | prescriber-node.ts:51-52 |
| Identity preimage `[codeToField(qualifier), hashString(prescriberId=NPI), hashString(enrollmentKey)]` | `state.preimageFields` → `{stateDir}/nautilus-state.enc`, AES-256-GCM, key scrypt(PIN) N=2^15 | wallet-derivation.ts:166-172; prescriber-routes.ts:252-261; nautilus-local-state.ts:28, 34, 60, 66-76, 252 |
| Enrollment key | source: request body or `generateEnrollmentKey()` = 32 random bytes base64url (prescriber-routes.ts:214; wallet-derivation.ts:63-65) or `restore-key`; memory `ObfuscatedKey` (nautilus-local-state.ts:311-316); persisted inside nautilus-state.enc (72, 233-246). Seed mode: repo JSON, never loaded into state | — |
| PCP cache `pcpPatients`, `prescribeJobs` | route-closure memory | prescriber-routes.ts:96, 547-553 |
| Badge sessions | none; only a `badge:session` event in the response | prescriber-routes.ts:1319-1322 |

### 4.3 Routes (`src/nodes/routes/prescriber-routes.ts`) — 42 routes, all OPEN (no `adminOnly` in file) at Session 1; since 2026-10-19 `/prior-auth/request` and `/prior-auth/status` are adminOnly, and `/estimate-cost` checks the node's admin bearer itself for a patient's price

| Method | Path | Auth | Checks in order (GAP:) | Calls out | Writes | Source |
|---|---|---|---|---|---|---|
| POST | /onboarding/accept-token | OPEN | phase awaiting_token (183); tokenId (187) | — | state.onboarding tokenId/tokenData (193-200) | 179-205 |
| POST | /onboarding/generate-key | OPEN | phase token_received (211). GAP: I3 — accepts a caller-supplied `enrollmentKey` (214) | — | setEnrollmentKey + save (219-220) | 207-225 |
| POST | /onboarding/derive-wallet | OPEN | phase key_generated (232); prescriberIdQualifier+prescriberId (235-238); key present (240-242) | — | walletId, preimageFields, domainTag=1 (254-261) | 228-266 |
| POST | /onboarding/enroll | OPEN | phase wallet_derived (272); walletId (277) | insurer `/enrollment/process {walletId, tokenId, role}` + Bearer adminToken only if `config.insurerUrl` (293-305) — the starter sets none (57-74) | node created (282-289); phase enrolled (312-315) | 268-320 |
| POST | /onboarding/compile | OPEN | phase enrolled (326); node (329) | `StateTransitionProgram.compile` (prescriber-node.ts:63-74) | phase ready | 322-346 |
| POST | /proof/registration | OPEN | phase ready (354); node (357); preimageFields+walletId (364) | `getRegistrationWitnesses` (369); `proveRegistration` → `submitProof` with partition retry (382-383; prescriber-node.ts:133-138) | — | 350-396 |
| POST | /onboarding/backup-key | OPEN | phase past token_received (402-405); pin (406-409); key present (411). GAP: I3 — PIN-encrypted key exported over HTTP to any caller | — | — (returns `{version, walletId, domainTag, salt, iv, encryptedKey, createdAt}`; scrypt N=2^15 + AES-256-GCM, enrollment-backup.ts:52-56, 107-130) | 398-422 |
| POST | /onboarding/restore-key | OPEN | backup+pin (428-431). GAP: I3/I7 | — | setEnrollmentKey + save (438-442) | 424-448 |
| POST | /prescriptions/write | OPEN | node (458-461); memberWalletId, pharmacyWalletId, ndcHash (475-477); since 2026-10-19 the quantity is thousandths of the drug's pricing unit (`quantityError`, else 400; :452). GAP: I7 | `l2_getEncryptionKey` ×2; `l2_storeMessage` ×2 (503-526) | message store | 454-540 |
| POST | /prescriptions/prescribe | OPEN | node; same 3 fields (576-578); since 2026-10-19 the quantity as for write (`quantityError`, :557). GAP: I7 — unauthenticated write + engine proving under this node's identity | §4.4 | message store; `prescribeJobs` | 555-687 |
| GET | /prescriptions/prescribe-status | OPEN | `?jobKey` (694-695); 404 (698) | — | deletes finished job (709-711) | 690-713 |
| GET | /prescriptions | OPEN | node | `l2_getClaimsByPrescriber(own)` (prescriber-node.ts:151-156) | — | 719-727 |
| GET | /prescriptions/summary | OPEN | node | same + aggregate (159-169) | — | 729-737 |
| GET | /prescriptions/range | OPEN | node; start+end (745-747) | same, date filter | — | 739-750 |
| GET | /prescriptions/patient/:memberWalletId | OPEN | node | own claims filtered by member (181-184) — authority: none beyond holding this node's walletId | — | 752-760 |
| GET | /prescriptions/medication/:ndcHash | OPEN | node | own claims filtered | — | 762-770 |
| GET | /prescriptions/pharmacy/:pharmacyWalletId | OPEN | node | own claims filtered | — | 772-780 |
| GET | /prescriptions/patients/count | OPEN | node | own claims | — | 782-790 |
| GET | /prescriptions/pharmacies/count | OPEN | node | own claims | — | 792-800 |
| GET | /prescriptions/medications/breakdown | OPEN | node | own claims | — | 802-810 |
| GET | /network/prescribers | OPEN | 404 unless `networkRegistry` passed (820-822) — starter passes none (start-prescriber-nautilus.ts:98) | — | — | 816-828 |
| GET | /network/check/:walletId | OPEN | same 404 | — | — | 830-840 |
| GET | /network/count | OPEN | same 404 | — | — | 842-851 |
| GET | /formulary/:planIdHash | OPEN | node; 404 | `l2 getFormulary` (prescriber-node.ts:224-231) | — | 857-867 |
| GET | /formulary/:planIdHash/check/:ndcHash | OPEN | node; 404 | same, parses entriesJson (879-886) | — | 869-891 |
| GET | /formulary-categories | OPEN | — | `l2_getFormularyCategories` | — | 895-913 |
| GET | /formulary-page | OPEN | query filters, offset, limit 100 (921-928) | `l2_getFormularyPage` | — | 915-941 |
| GET | /formulary-drug/:ndcHash | OPEN | — | `l2_getDrugDetail` | — | 943-961 |
| GET | /formulary-routes | OPEN | — | `l2_getFormularyRoutes` | — | 963-981 |
| GET | /formulary-drug-count | OPEN | — | `l2_getFormularyDrugCount` | — | 983-1001 |
| GET | /formulary-root | OPEN | — | `l2_getFormularyRoot` | — | 1003-1021 |
| GET | /formulary-witness/:ndcHash | OPEN | — | `l2_getFormularyWitness` | — | 1023-1041 |
| GET | /providers | OPEN | node; `?role` | `l2_getNetworkProviders` (1056-1065), result returned verbatim | — | 1047-1075 |
| GET | /pcp/patients | OPEN | — | `syncPcpFromSequencer` (99-169): `l2_getNetworkProviders role=prescriber` to collect **all** prescriber wallets (113-123), `l2_getPcpAssignments` per wallet (131-136), inbox type '6' (152-167) → union, not limited to this prescriber. GAP: I7 — member wallet IDs + dates for every PCP assignment, no auth | — | `pcpPatients` | 1081-1089 |
| GET | /proof-timings | OPEN | node | — | — | 1093-1101 |
| POST | /messaging/send | OPEN | node; message+payload (1112-1114); senderWalletId defaulted only if empty (1117-1119). GAP: I7 — caller may set any `senderWalletId` | `l2_storeMessage` | message store | 1105-1123 |
| GET | /messaging/inbox | OPEN | node | `getMessagesByRecipient(own)` (entity-node-base.ts:222) | — | 1125-1133 |
| GET | /messaging/sent | OPEN | node | `getMessagesBySender(own)` (229) | — | 1135-1143 |
| GET | /messaging/thread/:threadIdHash | OPEN | node | `getMessagesByThread` (236-237) | — | 1145-1153 |
| POST | /estimate-cost | OPEN for a price with no patient; with a walletId, since 2026-10-19, the node's admin bearer (401 without it; `carriesNodeAdminCredential`, timing-safe, and nobody passes when the node has no token) | node; ndcHash (400 if missing); quantity checked with `quantityError` (400) | `l2_estimateCost` with only ndcHash, quantity, and either walletId plus `memberAttestation` from the `X-Member-Attestation` header (base64 JSON) or planId. With a walletId the call is signed as the prescriber's wallet (`walletSigner`), so the read gate can admit the prescriber the engine's consent record names. A read-gate refusal → 403 naming who may read the price, -32602 → 400, else 502 (A-47, then 2026-10-19) | nothing | 1181 |
| POST | /prior-auth/request | ADMIN (since 2026-10-19) | node; a body that names prescriberIndex or prescriberWalletId → 400; walletId and ndcHash decimal; `quantityError`; reason optional, at most 500 characters, plain text (`plainTextError`) | `POST /interactive/request-prior-auth {memberWalletId, ndcHash, quantity, reason?}` through `walletSignedFetch`, signed as the prescriber's wallet. The engine's 401 or 403 → 403; its 400, 404 and 409 are kept; anything else → 502; 503 when the node cannot sign as its wallet | nothing (the engine records the request) | 1251 |
| GET | /prior-auth/status?walletId&ndcHash | ADMIN (since 2026-10-19) | node; walletId and ndcHash decimal (400) | `GET /interactive/prior-auth-status` through `walletSignedFetch`; refusals as `/prior-auth/request` | nothing | 1282 |
| GET | /prescribers/list | OPEN | — | reads `src/data/prescribers.json` (1186-1187) | — (returns NPI, names, credential, specialty, state, city) | 1176-1205 |
| POST | /interactive/badge/tap | OPEN | providerType==='prescriber' (1219); index range (1231) | `l2_getProvider` (1267-1271); if absent `l2_registerEntity {walletId, displayName, type, npi, specialty, encryptionPublicKeyHex}` with Bearer node adminToken (1280-1301; `require()` inside ESM at 1295, swallowed by try/catch) | — | 1211-1344 |

### 4.4 Prescribe flow (`/prescriptions/prescribe`, 555-687)

1. Build `prescription = {rxId:'RX-<ms>-<4 rand>', prescriberWalletId, memberWalletId, pharmacyWalletId, ndcHash, brandName, quantity (30), daysSupply (30), refills (0), directions, diagnosis, dateWritten, status:'pending'}` (580-598); `threadIdHash = hashString('rx-'+rxId)` (601); `messageCommitment = Poseidon([walletId, Date.now()])` — not bound to the content (602).
2. `encryptEScript` (58-93): requires local enrollment key (60-62) → `l2_getEncryptionKey(recipient)` (69-74), fail-closed (77-79), X25519 from `deriveEncryptionKeyPair(enrollmentKey)` + `encryptMessage` (83-92). Two `l2_storeMessage` calls (`node.storeMessage` → l2-client.ts:397-398): `{messageCommitment, senderWalletId, recipientWalletId: pharmacy|member, messageType:'3', threadIdHash}` + `{ciphertext, iv, tag, timestamp}` (605-614); failure → 500 (615-618). In seed mode no enrollment key is loaded (start-prescriber-nautilus.ts:129-135), so this step throws.
3. Async: `POST <seq>/interactive/resolve-indices {prescriberWalletId, pharmacyWalletId, ndcHash}` (627-635), fallback indices 0/0 (644-648); `POST <seq>/interactive/prescribe {prescriberIndex, memberWalletId, ndcHash, pharmacyIndex, quantity, refills, rxId}` (650-662). No auth header; neither path is in the engine's `ADMIN_ROUTES` (src/adjudication/interactive-routes.ts:67-77). Result → `prescribeJobs` (664-671).
4. Reply 202 `{jobKey, rxId, prescription, eScriptDelivered:true, proofStatus:'pending'}` (679-685); poll `GET /prescriptions/prescribe-status?jobKey=` (690-713).

`/prescriptions/write` (454-540) is the same two encrypted stores without step 3.

### 4.5 Badge tap (`/interactive/badge/tap`, 1211-1344)

Body `{providerType, providerIndex}` (1215-1217) → seed `PRESCRIBERS[providerIndex]` (1235); "decrypt" is reading `prescriber.enrollmentKey` from repo JSON (1244); derive walletId (1249); proof skipped (1256-1259); sequencer check/register (1264-1312); `badge:session` event `sessionDuration:'8h'` with no session artifact (1319-1322); response `Access-Control-Allow-Origin: *` (1324). GAP: I7 — anyone can "tap" any seed badge by index; the badge secret is in the repository.

## 5. Pharmacy node (:4003)

### 5.1 Startup (`src/nodes/start-pharmacy-nautilus.ts`)

Same shape: port 4003 (59), host 127.0.0.1 since A2 (60), CORS the local allowlist since A2 (67-69), adminToken (73), PIN (83). Seed `ZKTRIDENT_SEED_PHARMACY` (102-166): `PHARMACIES[idx|storeName|ncpdp]` (107-113), `enrollmentKey` from `src/data/pharmacies.json` (data/index.ts:297-299; 15 entries); walletId derived (122); node with walletId only (128-133) — no enrollment key in state; credential poll (143-157); recovery branch (170-201).

### 5.2 State held

`PharmacyNode` compiled/proofTimings (pharmacy-node.ts:59-60); base client/config (entity-node-base.ts:49-52); local state as in §4.2 with `domainTag=2` and preimage `[codeToField(qualifier), hashString(serviceProviderId), hashString(enrollmentKey)]` (wallet-derivation.ts:192-198; pharmacy-routes.ts:133-142); route-closure `dispensingJobs`, `reversalJobs` with 5-min TTL (pharmacy-routes.ts:419-441). No badge sessions.

### 5.3 Routes (`src/nodes/routes/pharmacy-routes.ts`) — 35 routes, all OPEN

| Method | Path | Auth | Checks in order (GAP:) | Calls out | Writes | Source |
|---|---|---|---|---|---|---|
| POST | /onboarding/accept-token | OPEN | phase awaiting_token (64); tokenId (68) | — | state (74-81) | 60-86 |
| POST | /onboarding/generate-key | OPEN | phase token_received (92). GAP: I3 — body `enrollmentKey` accepted (95) | — | setEnrollmentKey + save | 88-106 |
| POST | /onboarding/derive-wallet | OPEN | phase key_generated (113); serviceProviderIdQualifier+serviceProviderId (116-119); key (121) | — | walletId, preimageFields, domainTag=2 (135-142) | 109-147 |
| POST | /onboarding/enroll | OPEN | phase wallet_derived (153); walletId (158). GAP: I7 — `insurerUrl` taken from the **request body** (161, 174) and the node's admin token is sent to it as Bearer (176-179) | `POST <body.insurerUrl>/enrollment/process {walletId, tokenId, role:'pharmacy'}` | node; phase enrolled | 149-198 |
| POST | /onboarding/compile | OPEN | phase enrolled (204); node | compile (pharmacy-node.ts:71-82) | phase ready | 200-222 |
| POST | /proof/registration | OPEN | phase ready (230); node; preimage (240) | `getRegistrationWitnesses`; `proveRegistration`; `submitProof` (258-259) | — | 226-272 |
| POST | /onboarding/backup-key | OPEN | phase (278-281); pin (283); key (285). GAP: I3 | — | — (PIN-encrypted backup returned, 289-292) | 274-294 |
| POST | /onboarding/restore-key | OPEN | backup+pin (301). GAP: I3/I7 | — | setEnrollmentKey + save (308-312) | 296-318 |
| GET | /dispensing | OPEN | node | `l2_getClaimsByPharmacy(own)` (pharmacy-node.ts:168-173) | — | 324-332 |
| GET | /dispensing/summary | OPEN | node | same (176-186) | — | 334-342 |
| GET | /dispensing/range | OPEN | node; start+end | same | — | 344-355 |
| GET | /dispensing/patient/:memberWalletId | OPEN | node | own claims filtered (198-203) | — | 357-365 |
| GET | /dispensing/prescriber/:prescriberWalletId | OPEN | node | own claims filtered (276-281) | — | 367-375 |
| GET | /dispensing/medication/:ndcHash | OPEN | node | own claims filtered | — | 377-385 |
| GET | /dispensing/medications/breakdown | OPEN | node | own claims | — | 387-395 |
| GET | /dispensing/prescribers/breakdown | OPEN | node | own claims (308-348) | — | 397-405 |
| GET | /prescriptions/list | OPEN | node; `?pharmacyIndex` default 0 (453) — not bound to own wallet | `GET <seq>/interactive/prescriptions-by-pharmacy?pharmacyIndex=N` (455), result verbatim (since 2026-10-19 each row carries `pricingUnit`, every amount summed over the standing fills and each fill listed, A-47) | — | 479-538 |
| POST | /dispensing/mark-filled | OPEN | node; prescriptionId (472-475); no ownership check. GAP: I7 | `POST <seq>/interactive/mark-filled {prescriptionId}` (479-483) | — | 465-490 |
| POST | /dispensing/dispense | OPEN | node; prescriptionId (507-509). GAP: I7 | `POST <seq>/interactive/fill {prescriptionId, quantityDispensed, ingredientCostCents, dispensingFeeCents}` (since 2026-10-19 the quantity is optional, thousandths of the pricing unit and checked with `quantityError` (400); left out, the engine dispenses the quantity prescribed (was 30); costs are passed on only so the engine can refuse a request that states other costs, 409); poll `/interactive/fill-status?prescriptionId=` every 5 s ≤ 120× (547-563) | `dispensingJobs`; 202 `{jobKey}` (573) | 493-575 |
| POST | /dispensing/fill | OPEN | node; own walletId (584-585); memberWalletId+ndcHash (601-603); prescriberWalletId default '0' (618, 637). GAP: I7 | `POST /interactive/resolve-indices {prescriberWalletId, pharmacyWalletId(own), ndcHash}` (614-622); `POST /interactive/prescribe-and-fill {memberWalletId, ndcHash, prescriberWalletId, pharmacyIndex, quantity (quantity ?? quantityDispensed ?? 30, checked with `quantityError` since 2026-10-19), ingredientCostCents, dispensingFeeCents}` (631-643); poll fill-status 3 s ≤ 10 min (655-674) | `dispensingJobs`; 202 | 578-686 |
| GET | /dispensing/fill-status | OPEN | `?jobKey` (693-694); prune (696); 404 (698) | — | — | 689-707 |
| POST | /dispensing/reverse | OPEN | node; prescriptionId (725-727); reason default 'Pharmacy reversal'. GAP: I7 | `POST <seq>/interactive/reverse {prescriptionId, reason}` (737-744) | `reversalJobs`; 202 | 713-763 |
| GET | /dispensing/reverse-status | OPEN | `?jobKey`; prune; 404 | — | — | 766-784 |
| GET | /dur/patient/:memberWalletId/full-history | X-Member-Attestation: the member’s tap, forwarded signed as the pharmacy; 403 without it (D1) | node. Was: any wallet ID, no consent/credential check | `l2_getClaimsByMember(member)` = every claim across all pharmacies (pharmacy-node.ts:216-221) | — | 790-798 |
| GET | /dur/patient/:memberWalletId/active-medications | X-Member-Attestation (D1) | node | same, fills−reversals per NDC (242-271) | — | 800-808 |
| GET | /dur/patient/:memberWalletId/check/:ndcHash | X-Member-Attestation (D1) | node | same (227-236) | — | 810-823 |
| GET | /dur/claim/:leafIndex | OPEN | node; 404 | `l2_getClaimWithProof` (366-379) | — | 825-835 |
| POST | /nfc/scan | OPEN | §5.4 | `getPatientActiveMedications` + `getPatientFullDrugHistory` (943-946) | — | 841-963 |
| GET | /proof-timings | OPEN | node | — | — | 967-975 |
| POST | /messaging/send | OPEN | node; message+payload (986-988); senderWalletId defaulted only if empty (990-992). GAP: I7 | `l2_storeMessage` | message store | 979-996 |
| GET | /messaging/inbox | OPEN | node | own | — | 998-1006 |
| GET | /messaging/sent | OPEN | node | own | — | 1008-1016 |
| GET | /messaging/thread/:threadIdHash | OPEN | node | thread | — | 1018-1026 |
| POST | /interactive/badge/tap | OPEN | providerType==='pharmacy' (1040); index range (1051) | `l2_getProvider` (1079-1083); no registration path | — | 1032-1111 |
| GET | /pharmacies/list | OPEN | — | reads `src/data/pharmacies.json` (1126-1127) | — (NPI, NCPDP, name, chain, address, city, state, zip, phone) | 1117-1145 |

### 5.4 NFC scan (`/nfc/scan`, 841-963)

Accepted inputs in priority order: (0) body itself is `{type:'credential-attestation', attestation}` (866-873); (1) `body.attestation` (875-881); (2) `payloadObject` as attestation wrapper, else member-id object (883-897); (3) `payload` JSON string: wrapper, bare attestation, or member-id (899-920); (4) **plain `walletId`** string passing `isValidWalletId` = decimal digits, ≤ 78, no leading zero (922-924; nfc-identity.ts:180-187); (5) `payloadBase64` → member-id (926-928). Member-id format `{v, t:'member-id', w, ts}` (nfc-identity.ts:144-150).

Attestation verification = `SequencerAttestationAuthority.verifyAttestation` (nfc-attestation.ts:246-285): shape `v===2 && t==='credential-attestation' && w && sig` (114-118); expiry `exp>0 && now>exp` (254); Ed25519 verify of `zkpcare-attestation-v2|w|cc|ls|fr|ts|exp|n` (107) **using `att.pk` carried inside the attestation** (258, 268-270) — no comparison with a known sequencer key; revocation nonce not checked here (`revokeNonce` 288 unused by this route). Invalid → 403 (931-935). Then returns `{walletId, activeMedications, activeMedicationCount, totalClaims, fullHistory, attestationVerified?, attestationExpiry?, attestationLifecycleState?, attestationExpired?}` (948-961). GAP: I7 — a bare wallet ID yields the member's complete cross-pharmacy history; the signature trust anchor is inside the tag.

### 5.5 Badge tap (`/interactive/badge/tap`, 1032-1111)

Seed `PHARMACIES[providerIndex]` (1055); key from repo JSON (1061); derive walletId (1065); proof skipped (1071-1074); `l2_getProvider` (1079-1083); `badge:session` 8 h with no artifact (1095-1098); ~~CORS `*`~~ removed by A2 (1100). GAP: I7 as in §4.5.

## 6. Where things live (this scope)

| Item | Process | Memory / disk / wire | Source |
|---|---|---|---|
| Employee names, IDs, DOB, email | HR Tool (runs on the employer's machine since A7; the gap that it ran on the insurer host is closed) | memory `activeTable` (hr-tool-server.ts:227); disk `groups/<gid>/correlation.table.enc` AES-256-GCM/scrypt (hr-tool-core.ts:408-416, 596-597); audit.log carries hashes and counts, not IDs (A7); wire only browser↔127.0.0.1 (`/api/employees` 774, `/api/export/tokens` 853, `/api/csv/preview` 590, dry-run 625-631); never to the employer node (676-681, 707-709) | hr-tool-server.ts |
| Employee hashes | HR Tool; employer node | HR table; employer `roster` Map (employer-node.ts:93, 315-323) and `TokenRecord.token.employeeIdHash` (re-hashed, token-authority.ts:142; group-enrollment-token.ts:120), memory only; wire HR→employer `POST /tokens/generate` over http://127.0.0.1 with Bearer (hr-tool-server.ts:149-156, 676-681) | — |
| Enrollment codes (tokenId) | employer node; HR Tool; insurer | employer `TokenAuthority.tokens` memory (token-authority.ts:89, 161); HR table + disk (hr-tool-server.ts:719, 738); wire employer→HR 201 body (employer-routes.ts:211-216), HR→browser (853, 774), insurer→employer URL path (insurer-routes.ts:236, 289) | — |
| PINs (plaintext) | HR Tool only | generated hr-tool-server.ts:670 (core 285-293); stored `entry.tokenPIN` in correlation.table.enc (721; core 83-84); returned to browser (848, 774); never sent to the employer node | — |
| PIN hashes | employer node; HR Tool; insurer→employer | `TokenRecord.tokenPinHash` memory (token-authority.ts:43, 248); HR table (722); wire `set-pin-hash` (707-709) and validate body (insurer-routes.ts:239, 292) | — |
| Group seed | HR Tool | memory `activeSeed` (hr-tool-server.ts:225, 502, 514); disk `group.seed.enc` encrypted (core 216-219, 596); never on the wire | — |
| Employer signing key | not in this scope | only the **public** key here: env `ZKTRIDENT_EMPLOYER_PUBKEY_HEX` (start-employer-nautilus.ts:89), orchestrator opts/env (employer-orchestrator.ts:172, 295), `attestation.publicKeyHex` from the sequencer (l2-types.ts:435). HR Tool client Ed25519 key: `client.key.enc` (core 633-637), unused for auth in orchestrator mode (hr-tool-server.ts:155-157) | — |
| Employer node admin token | orchestrator → employer node → HR Tool → browser | generated in orchestrator memory (158-162); env `ZKTRIDENT_ADMIN_TOKEN` (298) → `config.adminToken` (start-employer-nautilus.ts:70); env `EMPLOYER_ADMIN_TOKEN` (331) → const (hr-tool-server.ts:79); `liveTenants` (394); marketplace `activationJobs` memory (marketplace-routes.ts:63, 765-769); wire: JSON to the activating browser (737, 828), `Authorization` HR→employer (156); sha256[0:16] fingerprint to the sequencer (373). No disk write in this scope | — |
| HR Tool passphrase / derived keys | HR Tool | memory `activePassphrase` (218, 339, 370) cleared on lock (247); wire browser→HR `POST /api/unlock` body (310-311) on 127.0.0.1; derived per file via scrypt (core 143-150); never on disk | — |
| Provider identity preimages (NPI fields + hash(enrollmentKey)) | prescriber/pharmacy nodes | `preimageFields` → nautilus-state.enc (prescriber-routes.ts:252-261; pharmacy-routes.ts:133-142; nautilus-local-state.ts:74, 252); seed mode: plaintext `src/data/prescribers.json` / `pharmacies.json` in the repo, loaded by data/index.ts:278-289, 297-299; wire: NPI in `l2_registerEntity` (prescriber-routes.ts:1288-1292), `/prescribers/list`, `/pharmacies/list` (1190-1203; 1130-1143), derive-wallet bodies (235-247; 116-128) | — |
| Provider enrollment keys | prescriber/pharmacy nodes | memory `ObfuscatedKey` (nautilus-local-state.ts:311-316); disk nautilus-state.enc field (72, 233-246); repo JSON for seeds; wire: generate-key body (prescriber-routes.ts:214; pharmacy-routes.ts:95), backup-key response PIN-encrypted (417-420; 289-292), restore-key body (428-436; 300-306) | — |
| Badge sessions | — | nothing stored; `badge:session` event only (prescriber-routes.ts:1319-1322; pharmacy-routes.ts:1095-1098) | — |
| Orchestrator job status | insurer process | `activationJobs` (marketplace-routes.ts:63); `liveTenants` (employer-orchestrator.ts:62); sequencer tenant registry via `l2_registerEmployerNode` (359-376, keepalive 73-96) | — |

## 7. Onboarding library notes (files in scope not covered above)

- `employer-attestation.ts`: commitment = Poseidon over `[agreementId, employerId, sorted plan financials, enrollmentCap, effectiveDate, termsVersion (+signerName, signerTitle)]` (44-67); document hash = sha256 of key-sorted JSON minus `generatedAt` (73-86); canonical message `zkpcare-employer-v2|employerId|pubKey|plans|cap|commitment|docHash|date|ts|seq[|signer|title]` (103-122); Ed25519 verify with SPKI prefix (127-140); `verifyEmployerSignature`/`verifyInsurerSignature` (142-148); verification-cert message (156-159); DOCX generation incl. `companyName`, signer name/title (235-355). `EmployerAttestation` fields: l2-types.ts:432-456.
- `group-registry.ts`: `GroupConfig` 7 Fields (44-59), MerkleTree height 8 = 128 groups (24-27), `GroupRegistry` keeps `groupLocalData` plaintext groupId/planId in memory (122, 166).
- `opaque-roster.ts`: `RosterEntry` 8 Fields incl. `walletId`, `familyIdHash`, `tokenIdHash` (52-69), height 11 = 1024 (24-27); indexes by wallet/group/family (144-146).
- `plan-template.ts`: builds formulary + provider-network registries from config (77-101); `buildEligibilityData` (109-124), `buildAccumulatorData` (133-143).
- `rep-enrollment-token.ts`: 6-Field token incl. `memberWalletId`, `scopeFlags` (40-53).

## Open questions

1. Seed-mode prescriber (:4002): `encryptEScript` requires an enrollment key in local state (prescriber-routes.ts:60-62) but the seed path never sets one (start-prescriber-nautilus.ts:129-135). Is `/prescriptions/prescribe` expected to work on :4002, and if so through which call (`restore-key`? `generate-key` needs phase `token_received`)?
2. Is the insurer node's `adminToken` (used as Bearer to the sequencer for `l2_registerEmployerNode`, employer-orchestrator.ts:363) the same secret as the sequencer admin token (start-leviathan.ts:81 default `admin123` in unsecure mode)?
3. `TokenAuthority.consumeToken` (token-authority.ts:211-221) is only called by enrollment-service.ts:378 on the insurer's instance. Is the employer node's token ever meant to be marked consumed? Today it re-validates until expiry.
4. `registerClientKey` (nautilus-app-server.ts:212) has no callers; the HR Tool's Ed25519 client key (hr-tool-server.ts:333-335, 888-902) is therefore never usable. Intended removal or missing registration route?
5. ~~member-routes.ts posts `/enrollment/confirm` without `Authorization` while the route is ADMIN. Is the employer-side enrollment confirmation (and I6) intended at all?~~ **Answered 2026-10-17 (A6):** it is not. The callback and the route are removed; a code is consumed at validation and the employer learns no wallet ID.
6. Two different "groupIdHash" values exist for one group: `Poseidon([hashString(groupId)])` on the group record/roster (employer-node.ts:191, 316) vs `hashString(groupId)` on the token (group-enrollment-token.ts:118). Which does the insurer match against?
7. `require('../../messaging/encryption.js')` inside an ES module at prescriber-routes.ts:1295 — does `encryptionPublicKeyHex` ever reach `l2_registerEntity` via badge tap?
8. `EMPLOYER_ID` / `EMPLOYER_PUBKEY_HEX` are passed to the HR Tool (employer-orchestrator.ts:333-334) but never read. Planned pinning?
9. `token-distribution.enc` (hr-tool-core.ts:598) is never written by the server; is the CLI (hr-tool.ts) still a supported path given it skips the PIN step?
10. After an insurer restart `liveTenants` is empty; the orchestrator then refuses respawn while the old tenant answers `/health` (employer-orchestrator.ts:236-242) and the admin token is unrecoverable. Is a deregister-and-respawn operator flow documented?
11. `GET /prescriptions/list` (pharmacy-routes.ts:453) and `/interactive/badge/tap` select identities by seed index, not by the node's own wallet. Is the pharmacy node meant to be bound to one identity in non-demo deployments?

## Client keys and the HR Tool's credential (A9 remainder, 2026-10-17)

Employer node, all admin-gated: `POST /admin/client-keys {clientId, publicKeyHex}` registers an Ed25519 client key (clientId `[A-Za-z0-9_.-]{1,64}`, key 64 hex) → 201; `GET /admin/client-keys` lists them; `DELETE /admin/client-keys/:clientId` revokes (404 when unknown). Keys live in memory; a tenant dies with its parent, so a restart forgets them.

HR Tool (`src/tools/hr-tool-server.ts` `proxyToEmployer`): the workspace's client key (generated at setup, stored under the passphrase since A7) is registered at setup with the tenant admin token presented once, and every request after that is signed in the `signed-request.ts` format. A 401 to a signed request means the employer node restarted: the tool registers once more with the stored token and retries. A workspace with a token and no key falls back to the bearer. `/api/setup` and `/api/unlock` report `authMode: 'ed25519'` when a key is on file. Node side, `checkNautilusAdminAuth` accepts the node's own bearer or a registered key's signature, verified over the body received (AUTH-14 closed).

D2 (2026-10-18): every call a provider node makes to the engine's `/interactive/*` routes goes through `server.signedFetch`, so it carries the node's key; the engine answers the pharmacy role (fill, mark-filled, prescribe-and-fill, update-rx-status, reverse, resolve-indices, fill-status, prescriptions-by-pharmacy) and the prescriber role (prescribe, resolve-indices, step-therapy-check, and request-prior-auth until 2026-10-19), and refuses the rest with 403. Since 2026-10-19 the prescriber node signs request-prior-auth and prior-auth-status as the prescriber's own wallet (`walletSignedFetch`), which the engine's provider-signed routes take. The dashboards' badge taps are served inline by the nodes and do not reach the engine.
