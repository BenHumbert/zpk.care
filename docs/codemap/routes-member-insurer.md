# Code map: Nautilus app server, member node, insurer node, marketplace (src/nodes)

Working tree 2026-10-16, uncommitted "registry fix" included. Abbreviations: AS=src/nodes/nautilus-app-server.ts, AT=nautilus-app-types.ts, LS=nautilus-local-state.ts, EB=entity-node-base.ts, MN=member-node.ts, IN=insurer-node.ts, NI=nfc-identity.ts, MR=routes/member-routes.ts, IR=routes/insurer-routes.ts, MK=routes/marketplace-routes.ts, SM=start-member-nautilus.ts, SI=start-insurer-nautilus.ts, SN=start-nautilus.ts, SL=start-leviathan.ts (peeked only for env propagation). "open" = route has no `adminOnly` flag; the server applies no other auth (AS:386-396). "ADMIN" = `adminOnly:true`.

## 1. NautilusAppServer (AS) generic behavior

| Item | Behavior | Source |
|---|---|---|
| Bind | member 4001 / insurer 4004, both `127.0.0.1` since A2 (were `0.0.0.0`); SN (replica) is an L2RpcServer, not a NautilusAppServer: 3031, also `127.0.0.1` | SM:73-74, SI:56-57, SN:59-60 |
| CORS | **A2:** `allowedOrigins` = `resolveAllowedOrigins`, default the local dashboard origins *with ports*; response origin = echo the request origin if listed, else **no header at all** (was the literal `null`, which granted every null-origin context); methods GET,POST,PUT,DELETE,OPTIONS; headers Content-Type, Authorization, X-Admin-Signature, X-Content-Hash; OPTIONS → 204 | SM:81-83, SI:64-66, AS:349-360 |
| adminOnly gate | Mode A (when `authorizedClientKeys` non-empty): header `X-Admin-Signature` = `clientId:timestamp:sigHex`; abs(now−ts) ≤ 30 s; Ed25519 verify over `METHOD:PATH \| timestamp \| contentHash` where contentHash is the caller's own `X-Content-Hash` header, never recomputed from the body (GAP I7: signature not bound to body). Mode B: `Authorization: Bearer <config.adminToken>`; length check then `timingSafeEqual`. Neither configured → always 401 | AS:165-206 |
| Key registries | `registerClientKey` switches gate to Mode A (AS:212-217); `registerPartnerKey/getPartnerKey` = separate in-memory Map, grants nothing (AS:224-230); `revokeClientKey` AS:233-235 | |
| GET /health | open; role, phase, sequencerConnected, **walletId**, displayName, uptime, tls, sequencerUrl | AS:364, 479-493 |
| GET /onboarding/status | open; phase, full `state.onboarding` (tokenId, tokenData.groupId/planId/validUntil, compilationStatus), **walletId**, role, displayName | AS:368, 495-504 |
| GET /events | open SSE when enableSSE (default true); 503 above maxSseConnections (default 50); replays ≤128 buffered events after `?lastEventId=`; source = entity node's sequencer SSE bridge | AS:372, 533-589, 127-131, 62; SM:79-80 |
| POST /rpc | open proxy; raw body forwarded to `${sequencerUrl}/rpc` with header Content-Type only — **no Authorization header of any kind** (not the node's token, not the caller's); all JSON-RPC methods forwarded unfiltered; 502 if no sequencerUrl / unreachable | AS:380, 508-529 |
| Body | 5 MB cap (`req.destroy()`, 400); JSON-parsed for POST/PUT/DELETE unless Content-Type starts with application/pdf, application/octet-stream or multipart/ (handler reads stream); 30 s timeout → 504 (SSE exempt) | AS:60-61, 404-419, 619-640, 337-346 |
| Static | GET only, after route matching: `/marketplace/*` from `marketplaceDashboardDir` (insurer: dashboard-marketplace), then `/*` from `dashboardDir` (dashboard-member / dashboard-insurer); path must match `^[/a-zA-Z0-9._-]+$` and not contain `..`; 7 MIME types, else octet-stream | AS:433-471, SM:94-97, SI:73-82 |
| Errors | envelope `{ok, timestamp, data?, error?}` (AS:594-608); 400 bad JSON (AS:417); 401 (AS:394); 404 (AS:474); 500 echoes handler `err.message` (AS:426) — MR:579 and MR:1119 echo `err.stack`; 502 proxy (AS:511, 527); 503 SSE (AS:540); 504 (AS:342); unhandled → 500 "Internal Server Error" (AS:253-258) |
| TLS | https only if both ZKTRIDENT_TLS_CERT and _KEY set; else http | AS:262-270 |

## 2. Local state on disk

**Member** (LS): one file `{stateDir}/nautilus-state.enc` (LS:60, 141, 268); stateDir default `./nautilus-data` (SM:76; SL does not pass ZKTRIDENT_STATE_DIR). Envelope JSON `{version:1, salt hex(16 B), iv hex(12 B), data hex(ciphertext‖16 B tag)}` (LS:96-101, 259-264). Cipher AES-256-GCM (LS:202, 252). Key = scrypt(PIN, salt, N=2^15, r=8, p=1, 32 B, maxmem 64 MB) (LS:50-58, 150-155). PIN source: POST /onboarding/unlock body (MR:72-78) or env ZKTRIDENT_PIN at boot (SM:100, 122, 137; SL:650 forwards ZKTRIDENT_MEMBER_PIN). PIN itself never persisted; derived key lives in memory until `lock()` zeros it (LS:118, 159-169). No hard-coded key, no hardware binding. Whole file rewritten on every `save()` (LS:266-271); deleted by `destroy()` (LS:285-292).

Fields inside the encrypted blob (NautilusStateData LS:66-93 plus `as any` additions):

| Field | Written by | Content |
|---|---|---|
| version, role, lastSavedAt, lastSequencerUrl | LS:67-68, 90-92; MR:342 | metadata |
| walletId | MR:247 | Poseidon hash, decimal string |
| enrollmentKey | injected only at serialization from ObfuscatedKey then cleared (LS:230-247); in memory XOR-split, never a plain field after load (LS:121, 210-214, 311-316; src/security/obfuscated-key.ts:19-38) | 43-char base64url, 32 random bytes (wallet-derivation.ts:63-65) |
| preimageFields | MR:245-248 | 6 Field decimals: H(cardholderId), hashDate(dob), H(firstName), H(lastName), H(enrollmentKey), groupIdHash (wallet-derivation.ts:135-146) |
| domainTag | MR:249 | 0 |
| onboarding.{phase, tokenId, tokenData{groupId, planId, validUntil}, enrollmentTimestamp, compilationStatus} | MR:116-122, 147, 250, 340-341, 465-466 | enrollment code + body-asserted group/plan |
| consentRecord{phiDescription, disclosingParty, receivingParty, purpose, expiration, signatureDate, recordedAt} | MR:252-255 | caller-supplied free text |
| pcpAssignment{pcpWalletId, effectiveDate, commitment, specialty, consentScopeFlags, assignedAt, proofSubmitted?, receiptId?} | MR:899-907, 1094-1095 | PCP choice |
| not stored | raw cardholderId/dob/names (scrubbed, src/security/secure-context.ts:78), proofs, admin token (env only, SM:89), device PIN, backup PIN, genderCode |

**Insurer**: never calls `unlock()` (SI:86-114 builds InsurerNode directly) so `getState()` is null → `nautilus-state.enc` is never written; the enrollment-registry persistence (IR:353-363) and restore (IR:102-112) are no-ops. Insurer disk artifacts, both **plaintext**, under stateDir default `./nautilus-data` (SI:59):
- `marketplace-applications.json`: every EmployerApplication — employerId, companyName, contactName, contactEmail, contactPhone, ein, state, industry, selectedPlanIds, effectiveDate, enrollmentCap, publicKeyHex, status, cp575DocumentId, resubmissionCount, timestamps (MK:139, 85-96 tmp+rename, 296-312). GAP I1-adjacent: business contact PII and EIN in clear.
- `employer-documents/<32 hex>.pdf`: uploaded CP 575 letters, raw bytes (MK:398-404).

Insurer memory only: `__enrollmentRegistry` Map walletId → {walletId, tokenId, role, groupId, planId, employerId, enrolledAt} (IR:333-350; lost on restart); credentialing `applications` Map with npi, deaNumber, stateOfLicense (IR:955-970); partner keys Map (AS:224; written MK:642, 991; **no reader anywhere in src**); agreementCache, docxCache, activationJobs incl. the spawned employer node's **adminToken** (MK:51-63, 765-769).

**Plaintext in logs** (grep of console.* in src/nodes): no raw PHI, enrollment key, PIN or preimage is logged. Logged: walletId truncated to 12-16 chars (SM:125, IR:365), full tokenId on the insurer console (IR:219, 246, 273, 302), insurer rejection bodies (MR:326), receipt ids (MR:1071). walletId is served in clear by open endpoints /health, /onboarding/status, /nfc/id-qr (AS:484, 500; MR:1167).

## 3. Member node routes (MR, registered SM:115)

31 routes, **0 adminOnly** (grep) — GAP I7: every route is still unauthenticated (A5 fixes that). A2 narrowed the reach: the node binds `127.0.0.1` and CORS is an allowlist, so this is now reachable from the device itself rather than from the LAN or a drive-by page (SM:74, 81-83). Phase machine (AT:30-37; in-memory `onboardingPhase` AS:101, mirrored in the blob): awaiting_token →accept-token→ token_received →generate-key→ key_generated →derive-wallet→ wallet_derived →enroll→ enrolled →compile→ compiling → ready; eject → awaiting_token (MR:1369); boot restores the phase from the blob (SM:133). Phase checks (409) are the only gate on onboarding routes.

| # | Method Path | Auth | Checks in order | Outbound calls (target: route — fields) | Writes | Source |
|---|---|---|---|---|---|---|
| 1 | POST /onboarding/unlock | open | 200 `alreadyUnlocked` if `isUnlocked()`; 400 no pin; LS.unlock: PIN ≥ 6 chars, scrypt; load → 400 on wrong PIN (LS:218). GAP: no attempt limit/lockout. GAP: wrong PIN leaves `derivedKey` set (LS:150) because load throws without clearing (LS:201-219) and the handler does not `lock()` (MR:91-94) → `isUnlocked()` true, which is the only gate on /onboarding/eject (MR:1355) | none | first run: initial blob {phase awaiting_token} | MR:61-96; LS:133-156 |
| 2 | POST /onboarding/accept-token | open | phase==awaiting_token; tokenId required. GAP: groupId/planId/validUntil copied from body, verified with nobody | none | blob: phase token_received, tokenId, tokenData | MR:100-129 |
| 3 | POST /onboarding/generate-key | open | phase==token_received. GAP I3: `body.enrollmentKey` accepted verbatim if present (MR:142), no `validateEnrollmentKey`; else 32 random bytes | none | key → ObfuscatedKey (LS:311-316) → blob; key not in response | MR:133-157 |
| 4 | POST /onboarding/derive-wallet | open | phase==key_generated; consentRecord 6 fields; cardholderId, dateOfBirth, firstName, lastName present; DOB CCYYMMDD calendar-valid; key present (409); genderCode int 0-9 | none. In-process: `secureMemberDerivation(localData, key, groupIdHash)` (secure-context.ts:68-93) = Poseidon over [tag0, H(cardholderId), hashDate(dob), H(firstName), H(lastName), H(key), groupIdHash] (wallet-derivation.ts:118-146); groupIdHash = hashString(tokenData.groupId) or 0 (MR:236); genderCode not hashed; raw copy scrubbed (secure-context.ts:78) | blob: walletId, preimageFields(6), domainTag, consentRecord, phase wallet_derived; response returns walletId | MR:162-263 |
| 5 | POST /onboarding/enroll | open | phase==wallet_derived; walletId in blob; insurerUrl from config only (MR:283); tokenPinHash = Poseidon([…fields(tokenId), 0, …fields(body.tokenPIN)]) if PIN given (MR:295-303); insurer non-OK → 403, unreachable → 502, phase unchanged. GAP I7: with ZKTRIDENT_INSURER_URL unset the token is never validated and registration proceeds (MR:308) | (a) insurer POST /enrollment/process {walletId, tokenId, role:'member', groupId, planId, tokenPinHash}, no auth header (MR:312-323); (b) X25519 pubkey derived in memory from the enrollment key (MR:359-364); (c) sequencer POST /rpc `l2_registerEntity` {walletId, displayName:'Member', type:'member', group, encryptionPublicKeyHex} with `Authorization: Bearer <ZKTRIDENT_ADMIN_TOKEN>` when set (MR:290-292, 373-387) — SL:649-652 does set it to the sequencer admin token (`admin123` in unsecure mode, SL:81) — GAP I4: network admin secret held by the "phone"; (d) only if ZKTRIDENT_EMPLOYER_URL set (not by SL): employer POST /enrollment/confirm {tokenId, walletId}, no auth (MR:407-414); that route is ADMIN (employer-routes.ts:342-343) → 401; GAP I6 when configured | blob: phase enrolled, enrollmentTimestamp, lastSequencerUrl; memory: MemberNode with `clientOptions.adminToken` (MR:346-353) so every later L2Client RPC carries the admin bearer (l2-client.ts:648-649) | MR:267-442 |
| 6 | POST /onboarding/compile | open | phase==enrolled; node | none (StateTransitionProgram.compile in-process, MN:68-79) | blob: phase ready, compilationStatus | MR:446-473 |
| 7 | POST /proof/registration | open | phase==ready; node; preimageFields+walletId; loop ≤ 6 attempts (MR:506): witnesses → prove on device (MN:97-123, 7-Field padded preimage MR:498-501) → submit; retry only on root-contention messages (MR:528) with 250-1750 ms jitter | (a) L2Client getRegistrationWitnesses (MR:509); (b) `submitProof(proof)` partition-routed (MN:167-172) — proof only; (c) after acceptance POST `${sequencerUrl}/interactive/register-member` {walletId, **preimageFields** (all 6 identity hashes incl. H(enrollmentKey)), displayName, groupId, planId, publicKeyHex}, no auth (MR:555-566) — GAP I2: identity preimage leaves the phone to the engine; 200 even if (c) fails | none | MR:477-583 |
| 8 | POST /onboarding/backup-key | open | phase ∉ {awaiting_token, token_received}; pin; key present | none | none. GAP I3: response carries `exportEnrollmentBackup(key, pin, walletId, domainTag)` (src/security/enrollment-backup.ts:97) — the real key encrypted under a caller-chosen PIN, to any network caller; PIN unrelated to the device PIN (MR:613-617) | MR:587-619 |
| 9 | POST /onboarding/restore-key | open | backup+pin present; no phase check | none | memory: key ← importEnrollmentBackup (replaces any existing key silently); blob re-saved if loaded | MR:623-653 |
| 10 | GET /drugs | open | node | RPC l2_getClaimsByMember(own walletId) (MN:190-193) | — | MR:657-672 |
| 11 | GET /drugs/summary | open | node | same + summarize (MN:196-199) | — | MR:674-689 |
| 12 | GET /drugs/range?start&end | open | node; both params | same, filtered (MN:202-208) | — | MR:691-711 |
| 13 | GET /drugs/medication/:ndcHash | open | node | same, filtered (MN:211-214) | — | MR:713-728 |
| 14 | GET /drugs/claim/:leafIndex | open | node; 404 | RPC l2_getClaimWithProof(leafIndex) — any leaf, not limited to own wallet (MN:217-230) | — | MR:730-748 |
| 15 | GET /drugs/tree-status | open | node | RPC l2_getClaimAccumulatorRoot (MN:248-251) | — | MR:750-765 |
| 16 | GET /receipts | open | node | RPC getReceiptsByWallet(own walletId) (MN:233-235) | — | MR:769-784 |
| 17 | GET /formulary/:planIdHash | open | node; 404 | RPC getFormulary (MN:238-245) | — | MR:788-802 |
| 18 | GET /formulary-page?namePrefix,classification,tierLevel,route,planIdHash,offset,limit | open | none | raw fetch sequencer /rpc `l2_getFormularyPage`, no auth | — | MR:806-832 |
| 19 | GET /formulary-drug-count | open | none | raw fetch /rpc `l2_getFormularyDrugCount`, no auth | — | MR:834-852 |
| 20 | POST /pcp/assign | open | node; pcpWalletId+effectiveDate | none (commitment computed locally) | blob: pcpAssignment{…} | MR:856-925 |
| 21 | GET /pcp/current | open | none | none | — | MR:927-936 |
| 22 | DELETE /pcp/current | open | none | none | blob: delete pcpAssignment | MR:938-954 |
| 23 | POST /proof/pcp-assignment | open | phase==ready; node; walletId+preimageFields; pcpAssignment present | (a) L2Client getWalletState(walletId) (MR:988); (b) getWalletWitnesses (MR:1035); (c) proveWalletUpdate on device (MN:128-162); (d) submitProof(proof, {newCredentialInventoryRoot}) (MR:1070); (e) raw /rpc `l2_syncWalletState` {walletId, newCredentialInventoryRoot, newNonce} **no auth** (MR:1076-1088); (f) L2Client registerPcpAssignment(walletId, pcpWalletId, effectiveDate) (MR:1103) | blob: pcpAssignment.proofSubmitted, receiptId | MR:961-1124 |
| 24 | GET /nfc/id-payload | open | walletId in blob | none | — (NDEF `zktrident.care:member-id` {v, t, w: walletId, ts}, NI:107-130) | MR:1128-1152 |
| 25 | GET /nfc/id-qr | open | walletId in blob | none | — (base64url payload + walletId) | MR:1154-1170 |
| 26 | GET /proof-timings | open | node | none | — | MR:1174-1185 |
| 27 | POST /messaging/send | open | node; {recipientWalletId, body} or legacy {message, payload} | new path: raw /rpc `l2_getEncryptionKey` {walletId: recipient}, no auth (MR:1223-1226); encrypt in-process with X25519(enrollment key) + recipient pubkey (MR:1231-1236); **falls back to hex-encoded plaintext** when recipient has no key, on any error, or without an enrollment key (MR:1240-1247) — GAP I1/I2; then L2Client storeMessage({messageCommitment, senderWalletId, recipientWalletId, messageType:'1', threadIdHash}, {ciphertext, iv, tag, timestamp}) (MR:1250-1253, EB:217-219); legacy path forwards caller-built message/payload verbatim (MR:1265-1275) | — | MR:1190-1281 |
| 28 | GET /messaging/inbox | open | node | RPC getMessagesByRecipient(own walletId) (EB:222-226) | — | MR:1283-1297 |
| 29 | GET /messaging/sent | open | node | RPC getMessagesBySender (EB:229-233) | — | MR:1299-1313 |
| 30 | GET /messaging/thread/:threadIdHash | open | node | RPC getMessagesByThread — any thread (EB:236-238) | — | MR:1315-1329 |
| 31 | POST /onboarding/eject | open | 401 unless `isUnlocked()` (see row 1 GAP) | none | disk: unlink nautilus-state.enc; memory: lock(), phase awaiting_token, node null | MR:1343-1386 |

member-node.ts registers no routes; it wraps L2Client: compilePrograms (MN:68-79), proveRegistration / proveWalletUpdate taking the 7-Field padded preimage [domainTag, f0..f5] (MN:97-162), submitProof with partition retry (MN:167-172, EB:121-136), read queries (MN:190-251), `buildPreimage` → memberTransitionPreimage (MN:260-266). No recovery-card routes exist in src/nodes (grep); backup/restore are rows 8-9. NFC in this scope = identity payload only (rows 24-25, NI); sequencer-signed credential attestation is not in src/nodes.

## 4. Insurer node routes (IR, registered SI:96)

48 routes: **13 ADMIN, 35 open**. ADMIN = Bearer ZKTRIDENT_ADMIN_TOKEN (AS:199-205) unless a client key is registered. Boot (SI): no PIN/state; InsurerNode with L2Client adminToken = the same ZKTRIDENT_ADMIN_TOKEN (SI:101-108); then credentials seed PRESCRIBERS/PHARMACIES via `l2_credentialProvider` with Bearer admin, sending npi, deaNumber, display names, specialty, state (SI:152-208) — wallet IDs derived in the insurer process from seed `localData` + seed `enrollmentKey` (SI:157, 187; demo data); publishes default plan overlay (SI:213-222); phase → ready (SI:228).

| # | Method Path | Auth | Checks in order | Outbound | Writes | Source |
|---|---|---|---|---|---|---|
| 1 | POST /onboarding/configure | open | 409 if phase ready (true after boot); `body.adminToken` is read but unused (IR:79) | none | memory: new InsurerNode (token from config); state null → nothing persisted/restored | IR:70-120 |
| 2 | POST /enrollment/process | open — since A6 nothing is enrolled without a code that its issuing employer redeems; binding the wallet to its prover is B2 | node; walletId required. **Since A6 a code is required** (400) and canonicalised. Already redeemed by this wallet → idempotent; by another → 403. Employer = config.employerUrl, else the sequencer's `l2_listEmployerNodes` filtered by the code's routing prefix (never a fan-out; an identifier that is not a code is tried only against the `employerId` hint) → 503 none registered / 403 none match. One signed POST per candidate to `/tokens/:id/validate` {tokenPinHash}, `X-Admin-Signature` by the insurer's A9 key, 5 s each: 401/503/429 from the employer → 502 (a refusal, not a verdict); "not found" → next candidate; any other reason → 403; `valid` → the redemption is recorded against the wallet and persisted before anything else (`__redeemedEnrollmentCodes`, `state.redeemedEnrollmentCodes`; best-effort while the insurer's state is locked). `l2_getEntity(walletId)` informational only (IR:314-330). Dedupe: 409 if walletId already in `__enrollmentRegistry` (IR:346-348). GAP: role/groupId/planId/employerId recorded straight from the body (IR:333-341) | sequencer /rpc l2_getEmployerNode, l2_listEmployerNodes, l2_getEntity (no auth); employer nodes POST /tokens/:id/validate {tokenPinHash} (no auth) | memory record {walletId, tokenId, role, groupId, planId, employerId, enrolledAt}; blob save no-op (state null); console logs full tokenId (IR:219, 246, 273, 302); response echoes the record | IR:124-373 |
| 3 | GET /roster?groupId&role | open | node | L2Client getAllReceipts (Bearer admin); GET `${client.baseUrl}/viz/entities` (IR:392-394) | — | IR:377-447 |
| 4 | POST /roster/register | ADMIN | walletId | none | memory registry record from body | IR:451-481 |
| 5 | GET /receipts/all?limit≤1000&offset | open | node | getAllReceipts | — | IR:487-502 |
| 6 | GET /batches/all | open | node | getAllBatches | — | IR:504-519 |
| 7 | GET /audit/log | open | node | getAuditLog | — | IR:521-539 |
| 8 | GET /chain-proof | open | node | getChainProof | — | IR:541-553 |
| 9 | GET /claims/member/:walletId | open | node | l2_getClaimsByMember(any wallet) (IN:158-161) | — | IR:559-571 |
| 10 | GET /claims/prescriber/:walletId | open | node | l2_getClaimsByPrescriber (IN:164-169) | — | IR:573-585 |
| 11 | GET /claims/pharmacy/:walletId | open | node | l2_getClaimsByPharmacy (IN:172-177) | — | IR:587-599 |
| 12 | GET /claims/drug/:ndcHash | open | node | l2_getClaimsByNdc (IN:180-183) | — | IR:601-613 |
| 13 | GET /audit/chain-integrity | open | node | getAuditLog + AuditService (IN:344-347) | — | IR:619-631 |
| 14 | GET /audit/financial-balance | open | node | IN:350-353 | — | IR:633-645 |
| 15 | GET /audit/duplicate-claims | open | node | IN:356-359 | — | IR:647-659 |
| 16 | POST /audit/full | ADMIN | onChainState + rosterEntries in body | getAuditLog, getAllBatches (IN:362-374) | — | IR:661-692 |
| 17-28 | POST /reports/{claims-register, pharmacy-activity, prescriber-activity, member-activity, medication-utilization, financial-summary, prior-auth, reversals, tier-analysis, therapeutic-class, time-series, cross-tab} | open | node; `claims` in body (prior-auth also `priorAuths`; cross-tab `row, col, measure`) | none — pure computation over caller-supplied claims (IN:227-339); `getVerifiedClaims` stub returns [] (IR:54-64) | — | IR:704-902 |
| 29 | POST /admin/formulary/publish | ADMIN | planIdHash, formularyRoot, entriesJson | L2Client storeFormulary (IN:379-385) | — | IR:908-922 |
| 30 | POST /admin/batch/force | ADMIN | node | L2Client forceBatch (IN:388-390) | — | IR:924-938 |
| 31 | POST /credentialing/apply | open | providerType ∈ {prescriber, pharmacy}; npi; displayName; 409 duplicate non-denied NPI | none | memory `applications` (npi, deaNumber, stateOfLicense, walletId, …) | IR:976-1027 |
| 32 | POST /credentialing/verify/:id | ADMIN | app; status pending/under_review | none (NPPES stubbed) | status verified | IR:1030-1054 |
| 33 | POST /credentialing/approve/:id | ADMIN | app; status not approved/denied; 429 if in flight; walletId from body or app | /rpc `l2_credentialProvider` {walletId, displayName, providerType, npi, specialty, pharmacyType, deaNumber, stateOfLicense, verificationMethod, applicationId}, Bearer admin | status approved, walletId | IR:1057-1134 |
| 34 | POST /credentialing/deny/:id | ADMIN | app; not approved | none | status denied, denialReason | IR:1137-1158 |
| 35 | GET /credentialing/applications?status | open | — | none | — (lists every applicant incl. npi, deaNumber) | IR:1161-1173 |
| 36 | GET /credentialing/status/:walletId | open | node | /rpc `l2_getProvider`, no auth | — | IR:1176-1206 |
| 37 | POST /credentialing/suspend/:walletId | ADMIN | node | /rpc `l2_updateProviderStatus` {walletId, newState:3}, Bearer admin | — | IR:1209-1239 |
| 38 | POST /credentialing/terminate/:walletId | ADMIN | node | /rpc `l2_updateProviderStatus` {walletId, newState:4}, Bearer admin | — | IR:1242-1272 |
| 39 | GET /credentialing/registry?role | open | node | /rpc `l2_getNetworkProviders`, no auth | — | IR:1275-1301 |
| 40 | GET /plans | open | node | L2Client getPlans (IN:111-113) | — | IR:1308-1320 |
| 41 | GET /plans/:planId | open | node | getPlan (IN:106-108) | — | IR:1323-1337 |
| 42 | POST /plans | ADMIN | planId + name; 409 if exists | L2Client storePlan (IN:75-87); auto-publish /rpc `l2_publishPlanOverlay` {planIdHash, planName, overrides:[], defaults tier1-4 copays}, Bearer admin; markPlanPublished (IN:122-131) | sequencer-side only | IR:1340-1422 |
| 43 | PUT /plans/:planId | ADMIN | — | storePlan (IN:90-103) | — | IR:1425-1441 |
| 44 | DELETE /plans/:planId | ADMIN | — | deletePlan (IN:116-119) | — | IR:1444-1459 |
| 45 | POST /plans/:planId/publish | ADMIN | plan exists | /rpc `l2_publishPlanOverlay`, Bearer admin; markPlanPublished | — | IR:1462-1521 |
| 46 | GET /messaging/wallet/:walletId?limit≤500 | open | node | l2_getMessagesByWallet(any wallet) (IN:188-190) — ciphertext envelopes | — | IR:1527-1542 |
| 47 | GET /messaging/thread/:threadIdHash | open | node | getMessagesByThread (EB:236-238) | — | IR:1544-1559 |
| 48 | GET /messaging/status | open | node | getMessageStoreRoot (EB:248-250) | — | IR:1561-1573 |

Not present in IR: member termination routes (only provider suspend/terminate, rows 37-38) and prior-auth workflow routes (only the /reports/prior-auth report over caller-supplied `priorAuths`).

## 5. Marketplace routes (MK, registered SI:97-98)

`buildMarketplaceRoutes` 12 routes + `buildEmployerAdminRoutes` 6 routes = 18: **6 ADMIN, 12 open** (row 12 is explicitly `adminOnly:false`). For open per-application routes the 128-bit random `applicationId` (MK:99-102) is the only credential.

| # | Method Path | Auth | Checks in order | Outbound | Writes | Source |
|---|---|---|---|---|---|---|
| 1 | GET /marketplace/api/plans | open | — | /rpc `l2_getPlans`, no auth; published only | — | MK:157-175 |
| 2 | GET /marketplace/api/plans/:planId | open | — | /rpc `l2_getPlan` | — | MK:177-195 |
| 3 | GET /marketplace/api/check-employer-id/:employerId | open | format `^[A-Za-z0-9_-]{2,64}$` | /rpc `l2_getEmployerAttestation` (non-strict; warning if unreachable) | — | MK:241-261, 205-237 |
| 4 | POST /marketplace/api/apply | open | rate limit 10/min **global** (one array, not per IP; MK:144-151, 267); required companyName, contactName, contactEmail, employerId, selectedPlanIds[], effectiveDate, enrollmentCap, publicKeyHex (64 hex); employerId format; collision check local + sequencer, strict | /rpc `l2_getEmployerAttestation` | memory + disk marketplace-applications.json (plaintext record incl. ein, contact PII, publicKeyHex); status submitted | MK:263-325 |
| 5 | GET /marketplace/api/status/:applicationId | open | app | none | — | MK:331-347 |
| 6 | POST /marketplace/api/upload-document/:applicationId | open | app; status submitted/needs_documents/under_review; > 3 resubmissions → denied (403); raw body ≤ 5 MB via own reader (bypasses JSON parse); `%PDF` magic | none | disk employer-documents/<id>.pdf plaintext; cp575DocumentId, resubmissionCount, status → under_review | MK:353-414 |
| 7 | GET /marketplace/api/document/:applicationId | ADMIN | app has document | none | — | MK:417-439 |
| 8 | POST /employer-applications/:applicationId/request-documents | ADMIN | status submitted/under_review | none | status needs_documents | MK:912-928 |
| 9 | GET /employer-applications | ADMIN | — | none | — (contact PII, ein, cp575DocumentId) | MK:841-866 |
| 10 | POST /employer-applications/:applicationId/approve | ADMIN | status submitted/under_review/needs_documents; cp575DocumentId present | none | status approved, approvedAt; agreementCache cleared | MK:868-890 |
| 11 | POST /employer-applications/:applicationId/deny | ADMIN | not signed/active | none | status denied, denialReason | MK:892-909 |
| 12 | POST /employer-applications/:applicationId/rekey | open (`adminOnly:false`) | status approved; publicKeyHex 64 hex | none | publicKeyHex replaced; agreementCache cleared | MK:932-952 |
| 13 | GET /marketplace/api/agreement/:applicationId | open | status approved/signed/active | /rpc `l2_getPlans`; `l2_getEmployerAttestation` → attestationSeq = existing + 1 (MK:474-488) | memory agreementCache{terms, commitment, documentHash, ts, attestationSeq}; returns canonicalMessage | MK:445-517 |
| 14 | POST /marketplace/api/sign/:applicationId | open | status approved/signed/active (renewal allowed); employerSignature, signerName, signerTitle; agreementCache present (ts/seq from cache; client `ts` ignored, MK:560-565); `verifyAttestationSignature(base, sig, app.publicKeyHex)` (MK:582) → 403 | insurer counter-signs with `insurerSign(message, server.getConfig().adminToken)`: Ed25519 seed = sha256('zkpcare-insurer-signing:' + **adminToken**) (MK:118-128, 588-595; the comment at MK:115 says "NOT the admin token"); /rpc `l2_registerEmployer` {attestation v2: employerId, publicKeyHex, authorizedPlanIds, enrollmentCap, agreementCommitment, documentHash, effectiveDate, ts, attestationSeq, signerName, signerTitle, employerSignature, insurerSignature, insurerPublicKeyHex, applicationId}, Bearer adminToken (MK:611-624); 409 on seq race, 502 otherwise | after sequencer OK: `server.registerPartnerKey(employerId, publicKeyHex)` (MK:642 — partner key, not admin); status signed (first time only); disk save; docxCache | MK:523-670 |
| 15 | GET /marketplace/api/docx/:applicationId | open | status signed/active; docx cached | none | — | MK:676-697 |
| 16 | POST /marketplace/api/activate/:applicationId | open | status signed/active; config.adminToken required (500); completed job → 200 with cached result incl. adminToken (MK:737); pending → 202 | fire-and-forget `spawnEmployerTenant({employerId, employerPubKeyHex, sequencerUrl, insurerUrl: http://localhost:<port>, insurerAdminToken})` — src/nodes/employer-orchestrator.ts:187 (handoff; mapped elsewhere) | memory activationJobs[applicationId] = {employerNodeUrl, hrToolUrl, **adminToken** of the new employer node, created by the orchestrator}; status active on success; disk save | MK:703-787 |
| 17 | GET /marketplace/api/activate-status/:jobKey | open | app + job exist | none | — returns employerNodeUrl, hrToolUrl and the employer node **adminToken** in clear to any holder of the applicationId (MK:817-829) | MK:790-831 |
| 18 | POST /employer-applications/:applicationId/rekey-signed | ADMIN | status signed/active; publicKeyHex | /rpc `l2_revokeEmployerAttestation` {employerId}, Bearer admin (MK:977-980) | publicKeyHex, status approved, caches cleared, disk save, registerPartnerKey | MK:955-999 |

Insurer admin token in MK: Bearer to sequencer (MK:612-614, 971-973), insurer Ed25519 signing seed (MK:588), `insurerAdminToken` given to the orchestrator (MK:716, 762), plus the Nautilus ADMIN bearer (AS:199-205): one secret, four roles. Working-tree "registry fix": signing/rekey call `registerPartnerKey` (MK:642, 991) rather than `registerClientKey`, so an employer signing no longer switches the insurer's admin gate to Ed25519 mode (AS:208-230).

## 6. Where things live (this scope)

| Thing | Process → memory / disk / wire | Source |
|---|---|---|
| Enrollment key | member: memory XOR-split (ObfuscatedKey); disk only inside the AES-GCM blob; wire in: optional generate-key body, restore-key body; wire out: only as PIN-encrypted backup (backup-key response); H(key) leaves as preimageFields[4] to /interactive/register-member | LS:121, 212, 233-247; MR:142, 633-640, 613-617, 560; wallet-derivation.ts:143 |
| Identity hashes (6 preimage Fields) | member memory + encrypted blob; wire → sequencer engine /interactive/register-member; private inputs of on-device proofs | MR:245-248, 555-566; MN:108-120 |
| Raw identity fields | wire browser → member POST /onboarding/derive-wallet; memory until scrubObject; never disk; genderCode unused; consentRecord text kept in blob | MR:170-231; secure-context.ts:74-78; MR:252-255 |
| Wallet ID | member memory/blob; wire → insurer, sequencer (RPC + engine), employer (if configured), NFC/QR payload; open on /health, /onboarding/status, /nfc/id-qr; insurer memory registry | MR:247, 316, 380, 412, 559, 1137, 1167; AS:484, 500; IR:334-350 |
| Network (sequencer) admin token | env ZKTRIDENT_ADMIN_TOKEN → member config.adminToken → l2_registerEntity header + MemberNode L2Client (every RPC); insurer: same env → InsurerNode L2Client, direct RPC headers, boot credentialing; SL gives both nodes the same value (`admin123` in unsecure mode) | SM:89; MR:290-292, 351; l2-client.ts:648-649; SI:68, 105, 129; IR:1091, 1221, 1254, 1375, 1477; MK:614, 973; SL:81, 605, 651 |
| Insurer (Nautilus) admin token | same value: AS Bearer gate; insurer signing seed; orchestrator `insurerAdminToken` | AS:199-205; MK:588, 716, 762 |
| Employer node admin token | insurer memory activationJobs; wire → marketplace browser via activate / activate-status (open) | MK:60-63, 765-769, 737, 828 |
| Partner keys (employer Ed25519 pubkeys) | insurer memory Map (write-only, no reader in src); plaintext `publicKeyHex` in marketplace-applications.json; on sequencer inside the attestation | AS:224-230; MK:642, 991, 309, 89-92, 622 |
| Device PIN | wire browser → member /onboarding/unlock or env ZKTRIDENT_PIN (SL forwards ZKTRIDENT_MEMBER_PIN); memory consumed by scrypt; salt on disk; no PIN hash stored | MR:72-78; SM:100; SL:650; LS:141-155, 261 |
| Backup PIN | wire body of backup-key / restore-key; never stored | MR:596-614, 627-636 |
| Enrollment token PIN | wire body.tokenPIN → member; Poseidon(tokenId‖0‖PIN) → insurer → employer /tokens/:id/validate; not stored here | MR:295-302, 321; IR:239, 292 |
| Enrollment code (tokenId) | wire browser → member accept-token; member blob (encrypted); wire → insurer, employer; insurer memory registry; insurer console logs it in full; open on member /onboarding/status | MR:109-117, 317, 411; IR:335, 219, 246, 273, 302; AS:496-503 |
| Employee names/IDs | not present in this scope (employer node) | — |
| Employer contact PII, EIN, CP 575 PDFs | insurer disk plaintext (JSON + PDFs); ADMIN list route | MK:296-315, 398-404, 841-866 |

## Open questions
- Is the member node meant to hold ZKTRIDENT_ADMIN_TOKEN (SM:89; SL:651 passes it)? With it every member RPC is an admin call; without it, does `l2_registerEntity` (MR:373-387) still succeed?
- What does the engine do with `preimageFields` at /interactive/register-member (src/adjudication/interactive-routes.ts:147)? If it proves on the member's behalf, I2 is violated structurally, not just in transit.
- Sequencer-side auth: `l2_registerEntity` is node-signed (A9) and, since A10b, carries `signingPublicKeyHex`; `l2_registerPcpAssignment` is signed as the member (A10b, `node.walletSigner()`); `l2_syncWalletState` (MR, no header) and `l2_getEmployerNode` / `l2_listEmployerNodes` are still assumed open.
- Employer POST /tokens/:id/validate is called by the insurer with no credentials (IR:236-241, 289-293); is it open on the employer node?
- All node types default stateDir to `./nautilus-data` (SM:76, SI:59) and SL passes no ZKTRIDENT_STATE_DIR; do member and insurer share one directory in the default boot?
- Wrong-PIN-leaves-unlocked (LS:150 vs LS:201-219; MR:91-94): bug or accepted? It satisfies the /onboarding/eject gate (MR:1355) without the correct PIN.
- Partner keys are never read (AS:228 has no callers); where are employer signatures re-verified after signing (MK:582 uses `app.publicKeyHex` from the plaintext JSON)?
- Insurer enrollment registry is memory-only (IR:343; persistence no-op since the insurer never unlocks LS): is the roster expected to survive restarts?
- /messaging/send plaintext fallback (MR:1240-1247): fixture-only?
- /onboarding/derive-wallet accepts genderCode but the preimage omits it (wallet-derivation.ts:137-146): dead input or planned?

## Enrollment order and recovery (Step 2, commit one, 2026-10-18)

Member node (all `deviceOnly`): `POST /onboarding/accept-token {tokenId}` → `POST /onboarding/generate-key` → **`POST /onboarding/redeem {tokenPIN}`** (asks the insurer `/enrollment/process {tokenId, tokenPinHash, role}` with no wallet; stores `enrollment {groupIdHash, planIdHash, employerId}`; phase `code_redeemed`) → `POST /onboarding/derive-wallet {fields, consentRecord}` (refused before redemption when an insurer is configured; derives with the redeemed group and a fresh `identitySalt`; answers `boundToGroup`) → **`POST /onboarding/enroll {recoveryPin}`** (issues two v3 cards, calls the insurer `/enrollment/complete {tokenId, walletId, role, recoveryDeposits}`, keeps the card ids, returns the two card payloads once) → `compile` → `/proof/registration`. Recovery: `POST /onboarding/recover {card, recoveryPin, cardholderId, dateOfBirth, genderCode?, firstName, lastName}` (phase `awaiting_token`): insurer `/recovery/release`, recombine, re-derive, `l2_getEntity` must know the wallet (404 otherwise), then phase `enrolled`. `POST /recovery-card/issue {recoveryPin}` files a fresh pair through the insurer's `/recovery/deposit`.

Insurer node: `POST /enrollment/process {tokenId, tokenPinHash, role?, employerId?}` → `{redeemed, groupIdHash, planIdHash, employerId}` (a repeat with the same PIN hash is answered from the record, `repeated: true`; another PIN hash 403); `POST /enrollment/complete {tokenId, walletId, role?, recoveryDeposits?}` → `{enrolled, …record, recoveryCards: [{cardId, filed}]}` (another wallet for a bound code 403; an unredeemed code 404); `POST /recovery/release {cardId, pinVerifier}` → `{share2Hex, identitySalt, groupIdHash, planIdHash, domainTag}` (403 on a wrong verifier, revoked or unknown card; 429 with Retry-After under the per-card limiter, 30/min per caller; a card locks after ten failures); `POST /recovery/revoke {cardId, pinVerifier}`; `POST /recovery/deposit {walletId, deposits}` → 201 (404 for a wallet the insurer has not enrolled). Persisted in the insurer's local state as `redeemedEnrollmentCodes` (now `{walletId|null, pinHash, employerId, groupIdHash, planIdHash, at, completedAt?}`), `enrollmentRegistry` and `recoveryDeposits`; the per-card attempt counter in `<stateDir>/recovery-attempts.json`.

## The wallet's own signature (A10b, 2026-10-18)

Member node, all `deviceOnly`: `POST /attestation/request {expirySeconds?}` → the node signs `l2_requestAttestation` as the wallet (key derived from the enrollment key inside `useEnrollmentKey`, never stored) and returns the sequencer-signed attestation; 409 while the device is locked. `POST /messaging/send` and the PCP registration after `POST /proof/pcp-assignment` are signed the same way through `EntityNodeBase.walletSigner`. `POST /onboarding/enroll` registers `signingPublicKeyHex` beside `encryptionPublicKeyHex` on `l2_registerEntity`.

Insurer node: unchanged; it never calls `l2_registerEntity` (its path is `l2_credentialProvider`, which now keeps a provider's registered keys).

## The device proves its wallet updates (B1 step two with B2, 2026-10-18)

Member node: `POST /proof/registration` now proves ownership (`MemberNode.proveOwnership`, ProofGate.verifyMember) after the registration receipt and sends `ownershipProofJson` to `register-member` — never the six fields — then runs a pass over the wallet's queue. `POST /proof/wallet-updates` (device session) runs a pass on demand: `applyPendingWalletUpdates` fetches the queue wallet-signed (`NautilusAppServer.walletSignedFetch`), re-derives each root from the parts and refuses what does not add up, proves the update with the device preimage against the live tree (re-proving on root contention), submits it with `newCredentialInventoryRoot`, and reports the receipt. The starter runs a pass every 20 seconds while the device is ready. The node compiles ProofGate beside StateTransition.

## The device's own portable credential (B1 step two, commit two, 2026-10-18)

Member node: `POST /credential/generate` (device session, phase ready, programs compiled) runs a pass over the wallet's queue first, rebuilds the credential and the inventory from the parts the engine last handed it (`credentialParts` in the device state, written after each applied update; `rebuildCredential`), checks the ledger's credential root matches, and proves `Credential.proveHoldingByType` over the ownership proof made at registration (`ownershipProofJson` in the device state). Returns `{credential, proofType: 'credential-type-holding', timeMs}`; the credential verifies offline with `verifyCredentialOffline`. 409 when updates are outstanding, the ledger disagrees, or the device has no credential yet.
