# Code map — dashboards, scripts, seed/data/storage/reporting, strays

Scope: dashboard-*/, dashboard-shared/, scripts/**, src/seed, src/data, src/storage, src/reporting, src/poc, src/index.ts, visualizer/src + dist (reachability only), root stray files. Working tree mapped as-is (uncommitted edits in 10 dashboard files: `git diff --stat -- dashboard-*/`). All lines verified by reading. "GAP:" = plain mismatch against owner rules I1–I7; not an audit.

Conventions: "node" = the Nautilus process that serves the page (same origin). Every Nautilus node forwards `POST /rpc` verbatim to the sequencer, adding no auth (src/nodes/nautilus-app-server.ts:380, 517-521). Static pages served from `dashboardDir` (nautilus-app-server.ts:454-457); marketplace under `/marketplace/` (nautilus-app-server.ts:433-434); Leviathan dashboard via L2RpcServer (src/l2/l2-rpc-server.ts:512, src/nodes/start-leviathan.ts:115,126).

## 1. Dashboard table

| Dashboard | Served by | Talks to | Browser storage keys | Secrets / identity in page JS |
|---|---|---|---|---|
| dashboard-member ("phone app") | member node :4001 `/` (src/nodes/start-member-nautilus.ts:94) | Node REST: /onboarding/{status,unlock,accept-token,generate-key,derive-wallet,enroll,compile,eject}, /proof/{registration,pcp-assignment}, /pcp/{assign,current}, /messaging/send, /health, /events (app.js:188,343,373,490,499,539,549,563,271,1185,1122; rpc.js:147,197,204,89,222). RPC via node `/rpc` proxy: l2_getStatus, l2_getChainState, l2_getReceiptsByWallet, l2_getReceipt, l2_getClaimsBy{Member,Pharmacy,Prescriber,Ndc}, l2_getClaimAccumulatorRoot, l2_reconstructAccumulator, l2_getPlanLimits, l2_estimateCost, l2_getFormulary, l2_getFormularyPage, l2_getFormularyDrugCount, l2_getFormularyRoutes, l2_getFormularyRoot, l2_getNetworkProviders, l2_getMessagesBy{Wallet,Thread,Sender,Recipient}, l2_storeMessage, l2_getMessageStoreRoot, l2_requestAttestation, l2_getAttestation, l2_getAttestationPublicKey, l2_submitProof, l2_getRegistrationWitnesses (rpc.js:94-164,209-215). **Direct to sequencer :3030**: POST /interactive/nfc/write (app.js:1491-1497). Optional prover `/status`,`/prove` (rpc.js:181,187; never called from app.js) | localStorage `zkt_walletId` → wallet ID (app.js:26; set 469,633); `zkt_enrollmentKey` → literal `'server-managed'` after enrollment (470) or the **real decrypted key** after Restore (634); `zkt_seqUrl`,`zkt_insurerUrl`,`zkt_proverUrl` → URLs (28-30; 246,254,1599-1601); `zkt_granted` declared, never used (31). Cleared en bloc at 282. No sessionStorage/IndexedDB/cookies | Device PIN, enrollment code, 8-digit SMS PIN, cardholderId, firstName, lastName, DOB in `onboardState` (307-311); PHI wiped at 520-524 after derive succeeds; PIN/enrollPIN kept until eject (289-293). `enrollmentKey` var in memory for session (173, 634). Backup PIN (1384). Attestation JSON (1462). |
| dashboard-insurer | insurer node :4004 `/` (start-insurer-nautilus.ts:73-75) | Node REST (rpc.js): /onboarding/status 93, /health 96, /enrollment/process 100*, /receipts/all 106, /batches/all 112, /audit/log 118, /chain-proof 121, /audit/{chain-integrity,financial-balance,duplicate-claims} 123-125, /claims/{member,prescriber,pharmacy,drug}/:id 128-131, /admin/batch/force 134*, /roster 142, /roster/register 146*, /credentialing/{applications,apply,verify*,approve*,deny*,status,suspend*,terminate*,registry} 152-185, /admin/formulary/publish 201*, /plans CRUD+publish 205-210*, /messaging/{wallet,thread,status} 213-215, /employer-applications{,/approve*,/deny*,/request-documents*} 259-268, /events 222; app.js POST /reports/:type with manual Bearer (1570-1576). Via `/rpc` proxy: l2_getFormulary (rpc.js:190-193). (* = Bearer admin) | localStorage `zkt_insurer_admin_token` → insurer admin bearer token (rpc.js:33 write, 37 read) | Admin token: typed in `#admin-token-input` (type=text, index.html:677), persisted (rpc.js:31-34), prefilled on Admin tab (app.js:1927-1928). Wallet IDs typed for enrollment/roster/credentialing (1371, 2002, 2144). |
| dashboard-marketplace | insurer node :4004 `/marketplace/` (start-insurer-nautilus.ts:79-82; index.html:35 loads `/marketplace/app.js`) | /marketplace/api/{plans 195, check-employer-id/:id 316, apply 380, status/:id 453, upload-document/:id 488, agreement/:id 518/659, sign/:id 667, activate/:id 716, activate-status/:key 724, docx/:id 811}; no auth headers (78-85) | localStorage `zkmp_applicationId`, `zkmp_applicationStatus` (app.js:34-35, 39-49) | Ed25519 keypair generated in browser (`crypto.subtle.generateKey('Ed25519', true, …)` 402 — extractable=true; only public key exported 406-409); private CryptoKey in memory var `keypair` (36), regenerated on refresh (413-416, 629); application form: company, employerId, contact name/email/phone, EIN, state (356-371). Employer node admin token shown once (746, 762), clipboard (798), not stored. |
| dashboard-employer | per-employer node spawned at activation (start-employer-nautilus.ts:75) | rpc.js: /onboarding/configure 113, /onboarding/status 117, /health 122, /groups POST* 127 /GET 131 /:id 135 /DELETE* 139, /roster 150, /roster/:hash 154, DELETE /roster/:hash* 158, /sequencer/{chain-state,status} 163-167, /plans/available 171, /attestation 174, /attestation/refresh* 175, /messaging/send* 179, /messaging/{inbox,sent,thread/:id} 183-191, /events 199 | localStorage `zkt_employer_admin_token` → employer admin bearer token (rpc.js:36, 43) | Admin token input (type=password app.js:629; set 644; restored on load rpc.js:43). Roster table renders `employeeIdHash` **and** `consumedByWalletId`/`walletId` per row (app.js:448-453) — GAP I6: employer UI shows member wallet IDs next to employee hashes. Message bodies plaintext to node (528-546). |
| dashboard-hr-tool | HR Tool server spawned at activation (src/tools/hr-tool-server.ts:82) | /api/{unlock 81, lock 82, session 83, groups 86, group/select 88, group/deselect 89, stats 90, csv/preview 91, import 93, employees 96-103, reconcile 104, export/tokens 105, employer/health 106, employer/plans 107}; no auth header; 401 → lock screen (73) | none (grep: no storage calls) | Passphrase (type=password index.html:52) POSTed to /api/unlock (app.js:220), not stored. Raw roster CSV read in browser (FileReader 570-580) and POSTed to HR server (574, 634). Names/IDs/DOB rendered (473-474, 592-596, 721-725, 749-752); enrollment codes + PINs rendered (789-820) and exported as CSV files to disk (822-850). |
| dashboard-prescriber | prescriber node :4002 (start-prescriber-nautilus.ts:78) | rpc.js (no auth, 60-68): /onboarding/{status 145,accept-token 147,generate-key 155,derive-wallet 161,enroll 168,compile 174} — backup-key and restore-key wrappers **removed by A3**, /proof/registration 181, /proof-timings 182, /prescriptions/* 186-208, /network/* 212-214, /formulary* 217-239, /providers 243, /pcp/patients 250, /messaging/{send,inbox,sent,thread} 254-257, /estimate-cost 260, /health 134. app.js: GET /prescribers/list 1736; POST /interactive/badge/tap on the node (1512; served by src/nodes/routes/prescriber-routes.ts:1213) | localStorage `zkp_prescriber_selected` → selected NPI (app.js:26, 29, 38) | NPI typed in wizard (1289-1291); ~~backup PIN sent to node (1716)~~ removed by A3; messages base64 (1152, 1177); walletId shown after badge tap (1572). |
| dashboard-pharmacy | pharmacy node :4003 (start-pharmacy-nautilus.ts:78) | rpc.js (Content-Type only, 37): /health 155, /onboarding/{status,accept-token,generate-key,derive-wallet,enroll,compile} 161-188 — backup-key and restore-key wrappers **removed by A3**; generate-key no longer forwards an enrollmentKey, /proof/registration 195, /proof-timings 198, /prescriptions/list 204, /dispensing/* 210-256, /dur/* 263-272, /nfc/scan 296, /messaging/{send,inbox,sent,thread} 304-313; `/rpc` proxy: l2_getFormulary (279-283). app.js: POST /interactive/badge/tap on node {walletId} (2039-2043; pharmacy-routes.ts:1034); GET /pharmacies/list 2111 | localStorage `zkp_pharmacy_selected` → NPI (26, 29, 38); sessionStorage `zkt_pharmacy_verified` → {pharmacyNpi: memberWalletId} (57, 65); sessionStorage `zkt_pharmacy_payments` → {scriptKey:{receivedAt}} (366, 847-849) | Pasted/scanned member attestation JSON (968-982; raw wallet IDs rejected 983-985) → /nfc/scan (987); verified member wallet IDs persisted per tab (65); messages base64 (778, 1582, 1610). |
| dashboard-leviathan | sequencer :3030 `/` (start-leviathan.ts:115,126; l2-rpc-server.ts:512) | rpc.js: POST /rpc (72) — l2_getLeviathanStatus, l2_getStatus, l2_getHealth, l2_getPartitionLeaders, l2_getPartitionStatus, l2_getQuorumStatus, l2_getStateCertificate, l2_verifyStateCertificate, l2_getAllReceipts, l2_getAllBatches, l2_getAuditLog, l2_getChainProof, l2_verifyChainIntegrity, l2_verifyFinancialBalance, l2_detectDuplicateClaims, l2_getClaimsBy*, l2_getPeerInfo, l2_getPeerList, l2_getStateDigest (98-209), l2_forceBatch admin (212-215), l2_getBatch (app.js:539); GET /health 91, /viz/state 220, /viz/entities 226, SSE /events 236, /viz/events 272. app.js probes :3030/:4001-4004/:3031/:3032 `/health` (66-72, 93). Setup wizard calls an **employer node** (Bearer) and `/viz/entities` (1861, 1914, 1925, 1939) | none (adminToken memory only, rpc.js:23, 36) | Admin token input type=password (index.html:427) → memory (app.js:1772). Wizard inputs: employer URL, member URL, employer admin token, group ID, **employee ID** (index.html:466-470; app.js:1856-1859); employee ID POSTed to employer `/tokens/generate` (1939-1941) — GAP I5: an employee ID is typed into the sequencer's dashboard. Token displayed (1945). |

## 2. Member app (dashboard-member/app.js) in depth

Boot: `boot()` 162-178 loads URLs, and if `zkt_walletId` exists reads `zkt_enrollmentKey` into memory (172-173) → `enterApp()` 180-212 (GET /onboarding/status 188 for planIdHash 192-193; SSE 203; poll /health every 10 s 1711-1722).

Enrollment UI (7 steps, 305; state 307-311; `renderOnboardStep` 313-484):

| Step | Inputs typed | POST to :4001 (same origin) | Body fields | Shown back |
|---|---|---|---|---|
| 0 Device PIN (327-351) | ob-pin, ob-pin-confirm (≥4) | /onboarding/unlock (343) | `{pin}` | — ; PIN kept in `onboardState.pin` (338) |
| 1 Credentials (353-381) | ob-token, ob-enroll-pin (8-digit SMS) | /onboarding/accept-token (373) | `{tokenId}` only (375) — no groupId/planId | — ; PIN kept in `onboardState.enrollPIN` (371) |
| 2 PHI 1 (383-404) | ob-cid, ob-fn | none | — | — |
| 3 PHI 2 (406-428) | ob-ln, ob-dob (CCYYMMDD regex 419) | none | — | — |
| 4 Keygen (430-436 → 486-532) | — | /onboarding/generate-key (490) then /onboarding/derive-wallet (499) | `{}`; then `{cardholderId, dateOfBirth, firstName, lastName, consentRecord{phiDescription,…}}` (501-513) | walletId short (526) |
| 5 Enrolling (438-455 → 534-585) | — | /onboarding/enroll (539), /onboarding/compile (549), /proof/registration (563) | `{tokenPIN}` (541); `{}`; `{}` | status text; receiptId to console (572) |
| 6 Complete (457-476) | — | — | — | full walletId (463); Enter App writes `zkt_walletId`, `zkt_enrollmentKey='server-managed'` (469-470) |

Raw identity lifetime: cardholderId/firstName/lastName/dob live in `onboardState` from steps 2-3 until wiped at 520-524 (only on derive success; on failure 527-530 they remain and re-render into inputs 387-389/410-412). Only destination is :4001 /onboarding/derive-wallet (499-514). Eject resets all (289-293). GAP I1 (minor): PHI persists in page memory across a failed derive until retry/eject.

Backup tab (1382-1448): PIN ≥6 (1386); WebCrypto PBKDF2-SHA256 100 000 iter (1393-1402) → AES-GCM encrypt of `enrollmentKey` (1405) → card `{version:2, walletId, salt, iv, encryptedKey, createdAt}` (1410-1417) → textarea, clipboard (1430), file download `adjudagator-recovery-*.json` (1433-1440). Because `enrollmentKey` is `'server-managed'` after a normal enrollment (470→173), the card encrypts that literal; only after a Restore (634) does it hold a real key. Never called node /onboarding/backup-key or /restore-key, which is why A3 deleting those routes left this tab working; it decrypts in the browser with Web Crypto. Server formats differ: src/security/enrollment-backup.ts uses scrypt N=2^15 + AES-256-GCM, `version:1`, has `domainTag`, `encryptedKey`=ciphertext‖tag (28, 51, 66-78, 107-128); recovery-card.ts `version:2` scrypt (70, 137). Browser card (PBKDF2, no domainTag) is not importable by either (`importEnrollmentBackup` rejects version≠1 at 153; scrypt vs PBKDF2). GAP I3: backup flow does not produce an NFC-card-compatible encrypted key.

Restore (589-642): paste JSON (index.html:59) + PIN ≥6 (62, 599); requires walletId/encryptedKey/salt/iv (602), version ≤2 (605); PBKDF2 100 000 (614-620) → AES-GCM decrypt (624-628) → `zkt_walletId`, `zkt_enrollmentKey=<real key>` in localStorage (633-634). GAP I3: real enrollment key written to plaintext localStorage.

PCP (1082-1206): l2_getNetworkProviders (1086); GET /pcp/current (rpc.js:203-206); Set PCP → POST /pcp/assign `{pcpWalletId, effectiveDate}` (rpc.js:195-201) then POST /proof/pcp-assignment `{}` (1185-1188); Remove → DELETE /pcp/current (1122).

Drugs/receipts: dashboard 660-820 and Drug History 823-900 use l2_getClaimsByMember (1 call per view 745, 858), dedupe by leafIndex (823-843); cards render `metadata.brandName/pharmacyName/therapeuticClass/tier/deaSchedule` + NADAC breakdown returned by the sequencer (787-820). Spend hero: l2_reconstructAccumulator + l2_getPlanLimits (682, 696). Formulary: l2_getFormularyDrugCount/l2_getFormularyPage with `namePrefix` (914, 930, 992-996). Plan tab 1001-1078. Receipts: l2_getReceiptsByWallet for status bar (1677).

Messaging (1218-1378): l2_getMessagesByWallet (1224), l2_getMessagesByThread (1297); bodies via `decodePayload` 94-106 — base64 when `iv` is `'0'`/`''` (98-100), hex → "(encrypted — N bytes)" (103-105); send = POST /messaging/send `{recipientWalletId, body}` plaintext to node (1341, 1363; rpc.js:146-154); a SHA-256 threadIdHash is computed (1334-1338) but unused. GAP I2/I4 adjacent: message plaintext leaves the page to the node (node encrypts; encryption of peer dashboards is base64 — see §3).

NFC/attestation (1454-1562): `POST /attestation/request` on the member node (A10b; the node signs as the wallet — formerly `l2_requestAttestation` via proxy); "Write to NFC" POSTs `{walletId}` straight to `<seqUrl with port→3030>/interactive/nfc/write` (1491-1497) — the only call bypassing the node; sequencer route requires only walletId (src/adjudication/interactive-routes.ts:1844-1850). Download/copy credential JSON `{type:'credential-attestation', version:2, walletId, attestation}` (1519-1562).

System log: `logSystem()` 143-146 pushes to in-memory `systemLog` (cap 100); comment "not persisted" (142); no renderer in app.js (only lines 44, 144-145 reference it). Settings (1576-1612): shows full walletId (1584) and `enrollmentKey.slice(0,16)+'…(hidden)'` (1588); saves URLs (1599-1601); Logout = eject (1610).

rpc.js: base `location.origin` (22), `headers()` = Content-Type only, no auth ever (36); JSON-RPC to `/rpc` (69); SSE `/events` (222); unused helpers: enrollWithInsurer (167-176), getProverStatus/delegateProof (179-192), submitProof (209-213), getRegistrationWitnesses (215), storeMessage (144).

## 3. Provider / insurer / employer / HR dashboards

### dashboard-insurer

| UI action | Route/RPC | Fields sent | Source |
|---|---|---|---|
| Set admin token | — (localStorage) | token | app.js:1922-1933; rpc.js:31-37 |
| Process enrollment (Admin) | POST /enrollment/process (Bearer) | walletId, tokenId?, role | app.js:1992-2012; rpc.js:99-101 |
| Eligibility register/revoke | POST /roster/register / POST /credentialing/terminate/:wid | walletId, role:'member' | app.js:1358-1385; rpc.js:146,180 |
| Formulary CSV upload / manual add → publish | POST /admin/formulary/publish (Bearer) | planIdHash, formularyRoot:'0', entriesJson | app.js:384-410, 476-488; rpc.js:201 |
| Load formulary | POST /rpc l2_getFormulary | planIdHash | rpc.js:190-193; app.js:118 |
| Create/update/publish/delete plan | /plans POST/PUT/:id/publish/DELETE (Bearer) | planId, name, coverageType, copay/deductible/oop/annual cents, family limits, formularyNdcs[], networkProviderWalletIds[] | app.js:818-845, 1028-1053; rpc.js:207-210 |
| Employer applications approve/deny/request docs | POST /employer-applications/:id/{approve,deny,request-documents} (Bearer) | reason | app.js:1156-1180; rpc.js:259-268 |
| Credentialing verify/approve/deny/suspend/terminate | POST /credentialing/* (Bearer) | walletId (prompt) / reason | app.js:2130-2160; rpc.js:160-180 |
| Reports | POST /reports/:type with manual Bearer | `{claims:[...]}` fetched from /claims/* | app.js:1536-1576 |
| Force batch | POST /admin/batch/force (Bearer) | — | app.js:1974-1990; rpc.js:134 |
| Audit/claims/messages lookups | GET /audit/*, /claims/*, /messaging/* | id | rpc.js:118-131, 213-215 |

### dashboard-marketplace

| UI action | Route | Fields sent | Source |
|---|---|---|---|
| Browse plans | GET /marketplace/api/plans | — | app.js:195 |
| Employer ID availability | GET /marketplace/api/check-employer-id/:id | — | 316 |
| Submit application | POST /marketplace/api/apply | companyName, employerId, contactName, contactEmail, contactPhone, ein, state, industry, planType, selectedPlanIds, effectiveDate, enrollmentCap, publicKeyHex | 352-380 (keygen 400-410) |
| Upload CP 575 | POST /marketplace/api/upload-document/:id (application/pdf bytes) | file bytes | 488-490 |
| Sign agreement | GET agreement/:id → sign canonicalMessage‖signerName‖signerTitle with in-browser Ed25519 → POST /marketplace/api/sign/:id | employerSignature(hex), ts, signerName, signerTitle, reviewedAt | 659-673 (signMessage 418-423) |
| Activate | POST activate/:id, poll activate-status/:key | — | 716-724 |
| Show credentials | — | shows hrToolUrl, employerNodeUrl, adminToken once | 744-762, 798 |
| Download DOCX | GET /marketplace/api/docx/:id | — | 811 |

Key storage: private key only in memory (36); comment says CryptoKey non-exportable but `generateKey` passes extractable=true (402). Lost on refresh → `regenerateKeypair()` (413-416, 629) produces a new key.

### dashboard-employer

| UI action | Route | Fields sent | Source |
|---|---|---|---|
| Set admin token | localStorage `zkt_employer_admin_token` | token | app.js:644; rpc.js:34-37 |
| Create group | POST /groups (Bearer) | groupId, planId, effectiveDate, enrollmentCap | app.js:326-355; rpc.js:127 |
| Delete group | DELETE /groups/:id (Bearer) | terminationDate | app.js:402; rpc.js:139 |
| Roster list / terminate | GET /roster?status=, DELETE /roster/:employeeIdHash (Bearer) | — | app.js:432-477; rpc.js:150,158 |
| Send message | POST /messaging/send (Bearer) | recipientWalletId, subject, body (plaintext) | app.js:528-546; rpc.js:179 |
| Inbox/sent/thread | GET /messaging/* | — | rpc.js:183-191 |
| Configure onboarding | POST /onboarding/configure (no admin flag) | employerId, insurerUrl | app.js:690-705; rpc.js:113 |
| Attestation | GET /attestation, POST /attestation/refresh (Bearer) | — | rpc.js:174-175 |
| No token generation UI (HR Tool does it) | — | — | app.js:414-416 |

### dashboard-hr-tool

| UI action | Route | Fields sent | Source |
|---|---|---|---|
| Unlock / lock / session | POST /api/unlock, /api/lock, GET /api/session | passphrase (≥8) | app.js:211-233, 81-83 |
| Group select | GET /api/groups, POST /api/group/select | groupId | 86-89 |
| CSV preview / import | POST /api/csv/preview, POST /api/import | csvContent (raw employee_id, family_id, first_name, last_name, dob, email), validUntil, dryRun | 568-581, 624-634 (columns 542) |
| Employees | GET /api/employees?status&search, /api/employees/:id | — | 96-103, 704-752 |
| Enrollment codes | GET /api/export/tokens → tables + CSV download (names+codes / names+PINs) | — | 789-850 |
| Reconcile | POST /api/reconcile | — | 866-925 |
| Employer node health/plans | GET /api/employer/{health,plans} | — | 106-107 |

### dashboard-prescriber

| UI action | Route | Fields sent | Source |
|---|---|---|---|
| Select prescriber | localStorage NPI; GET /prescribers/list | — | app.js:26-38, 1736 |
| Onboarding wizard | POST /onboarding/accept-token, generate-key, derive-wallet, enroll, compile; POST /proof/registration | tokenId, groupId, planId; —; prescriberIdQualifier, prescriberId (NPI); insurerUrl | app.js:1283-1297; rpc.js:147-181 |
| ~~Backup key~~ | ~~POST /onboarding/backup-key~~ | ~~pin~~ | **Removed by A3**: the button rendered the AES-GCM blob into the page. Was app.js:1716; rpc.js:176 |
| Badge tap login | POST /interactive/badge/tap (node) | providerType:'prescriber', providerIndex | app.js:1512-1516; prescriber-routes.ts:1213 |
| Prescribe | POST /prescriptions/prescribe, GET prescribe-status | memberWalletId, pharmacyWalletId, ndcHash, … | rpc.js:207-208 |
| Messaging send | POST /messaging/send | `message{messageCommitment:'0', recipientWalletId, senderWalletId, messageType:'1', threadIdHash}`, `payload{ciphertext: btoa(body), iv:'0', tag:'0', timestamp}` | app.js:1150-1153, 1175-1178; rpc.js:254 |
| Read messages | GET /messaging/{inbox,sent,thread}; `decodePayload` = atob when iv '0' | — | app.js:97-110, 1070, 1127 |

Message "encryption": base64 only (`btoa`) — GAP: messaging not E2E encrypted.

### dashboard-pharmacy

| UI action | Route | Fields sent | Source |
|---|---|---|---|
| Select pharmacy | localStorage NPI; GET /pharmacies/list | — | app.js:26-38, 2111 |
| Onboarding wizard | /onboarding/{accept-token,generate-key,derive-wallet,enroll}, /proof/registration | serviceProviderIdQualifier, serviceProviderId | app.js:1699-1717; rpc.js:161-195 |
| Badge tap login | POST /interactive/badge/tap (node) | walletId (from onboarding status) | app.js:2037-2043; pharmacy-routes.ts:1034 |
| Verify member | POST /nfc/scan | `{attestation}` (pasted JSON) or `{payloadObject}`; raw wallet ID rejected | app.js:960-1012; rpc.js:296 |
| Fill / dispense / reverse | POST /dispensing/{mark-filled,fill,dispense,reverse}, GET fill-status/reverse-status | prescriptionId, quantityDispensed, ingredientCostCents, dispensingFeeCents | rpc.js:216-238 |
| DUR | GET /dur/patient/:wid/{full-history,active-medications,check/:ndc}, /dur/claim/:leaf | — | rpc.js:263-272 |
| Transfer script | POST /messaging/send | messageType '4', `ciphertext: btoa('SCRIPT_TRANSFER:ndc:member:leaf')`, iv '0' | app.js:776-779 |
| Messaging send | POST /messaging/send | `ciphertext: btoa(text), iv:'0', tag:'0'` | app.js:1580-1583, 1608-1611; rpc.js:304 |
| Formulary | POST /rpc l2_getFormulary | planIdHash | rpc.js:279-283 |

### dashboard-leviathan (admin actions)

| UI action | Route/RPC | Fields | Source |
|---|---|---|---|
| Set admin token (memory) | — | token | app.js:1771-1774; rpc.js:36 |
| Force batch | l2_forceBatch with Bearer | partitionIndex? | app.js:1776-1792; rpc.js:212-215 |
| Setup wizard: pre-flight | GET :3030/:4001/:4004 /health | — | 1866-1880, 93 |
| Setup wizard: create group | POST `<employerUrl>/groups` (Bearer = typed employer token) | groupId, planId:'standard-plan', effectiveDate:'20260101', enrollmentCap:100 | 1914-1917 |
| Setup wizard: token | POST `<employerUrl>/tokens/generate` | groupId, employeeId, validUntil:'20271231' | 1939-1941 |
| Setup wizard: wait for phone | l2_getStatus poll (wallet count / proofs) | — | 1962-2005 |
| Setup wizard: force batch | `RPC.call('l2_forceBatch', {})` **without** admin flag ("bypass admin token requirement") | — | 2025-2028 — GAP I7 if the sequencer accepts it |
| Viz | GET /viz/entities, /viz/state (token, D1), SSE /viz/events with `?token=` (D2) | — | 843, 1925; rpc.js:220-226, 272 |

`memReq` (member-node request helper) defined (1862) but never called.

## 4. dashboard-shared/utils.js

Helpers: `esc` 25, `truncHash` 33, `fmtCents` 41, `fmtDate` 47, `toast` 53, `createSSE` (EventSource with backoff) 74-127; exported as `window.ZkpUtils` / CommonJS (130-132). No crypto. Not loaded by any dashboard index.html (every page loads only its own rpc.js + app.js: member 341-342, insurer 753-754, employer 39-40, hr-tool 69, prescriber 562-563, pharmacy 563-564, leviathan 515-516, marketplace 35) → dead code.

## 5. E2E harness (scripts/e2e-verify)

Env/args — run.ts: `ZKTRIDENT_ADMIN_TOKEN` (51, required 116), `argv[2]` outDir default `./e2e-out` (52), `argv[3]` network log (53), `ZKTRIDENT_STATE_DIR` default `nautilus-data` (55), `E2E_PRIOR_TRACE` (82-91). run-multi.ts: `ZKTRIDENT_ADMIN_TOKEN` (46), outDir default `./e2e-multi-out` (47), devicesDir default `./e2e-devices` (48), network log (49), `E2E_RESUME_DIR` (262, 423). Output: `trace.json` per Trace dir (trace.ts:74), polls in `<out>/polls` or `<out>/_polls` (run.ts:59; run-multi.ts:62), `results.json` (run.ts:586; run-multi.ts:415); run-multi lanes: `main`, `employer-A/B`, `member-<key>`, `claim-<key>-n` (57-63, 93, 141, 195). Secrets are deliberately printed/recorded (trace.ts:60, run.ts:33).

run.ts steps (one member, fictional "Avery Quillfeather" 64-68):

| # | Step (trace.begin) | Calls | Asserts | Lines |
|---|---|---|---|---|
| 1 | harness readiness | GET :3030/interactive/state until compiled; l2_getStatus; /health ×4 | compiled, phase present; records prescriber/pharmacy walletIds | 119-132 |
| 2 | attacker probes | POST :4004/plans no token; l2_recordFill (removed in D2: method not found); l2_forceBatch Bearer admin123 | 401/403; error; error | 135-141 |
| 3 | insurer plan | insAdmin POST /plans; GET /marketplace/api/plans | 201; listed | 144-151 |
| 4 | employer apply→approve→sign→activate→group | Ed25519 keygen (Node crypto); /marketplace/api/apply, upload-document, approve (insAdmin), agreement, sign, activate(+poll); POST `<employerNode>/groups` Bearer empAdmin | applicationId; 2xx; complete; 2xx | 154-196 |
| 5 | HR Tool codes | /api/unlock, /api/group/select, /api/import (2-row CSV), /api/export/tokens | success===2; 2 tokens; tokens contain no last name | 199-218 |
| 6 | member enrol | eject if needed; unlock{pin}; accept-token{tokenId}; generate-key; derive-wallet{PHI+consent}; enroll{tokenPIN}; compile; /proof/registration; poll l2_getReceiptsByWallet; /proof-timings | 2xx each; key not in response (regex 233); walletId; insurerNotified; ≥1 receipt | 221-267 |
| 7 | verifier wallet recompute | NautilusLocalState.unlock(PIN).load() | device walletId matches; 6 preimage fields recompute (hash cardholder/dob/first/last/enrollmentKey/group); Poseidon(0,…)==walletId; group-bound variant (fails if pre[5]=0 → finding `group-binding` 295); different key ⇒ different wallet | 270-298 |
| 8 | 3 claims | /interactive/state med pick; prescriber dashboard path POST :4002/prescriptions/prescribe (+status poll) else POST :3030/interactive/prescribe as the operator (D2; the `open-prescribe` finding is retired); :4003/dispensing/mark-filled, dispense over-quantity (ci 0), dispense | split re-derived via `expectedAdjudication`; total; patient/plan; deductible credit; OOP delta; fulfillment & settlement Poseidon recompute; ndc/pharmacy match | 301-410 |
| 8b | out-of-network prescriber | POST /interactive/prescribe with non-network index | refused (finding `network-not-enforced` 427 if not) | 413-428 |
| 9 | claim inclusion | /interactive/force-batch; l2_getClaimsByMember; l2_getClaimAccumulatorRoot; l2_getClaimWithProof per leaf | leaf hash + witness path == root; member matches; amounts match | 431-456 |
| 10 | audits | l2_verifyChainIntegrity/FinancialBalance/detectDuplicateClaims; l2_reconstructAccumulator | pass; sums equal claims | 459-472 |
| 11 | proof verification | compile StateTransitionProgram+BatchProgram locally; l2_getAllBatches, l2_getBatch | verify(batchProofJson, vk) true; tampered publicOutput false | 475-508 |
| 12 | portable credential | /interactive/generate-credential + credential-status; CredentialProgram.compile; verifyCredentialOffline | true; tampered false | 511-529 |
| 13 | attacker probes 2 | GET :4003/dur/patient/:wid/full-history; l2_requestAttestation; POST /interactive/force-batch | all expected 401/403/error | 532-538 |
| 14 | secret scan | /interactive/state, RPC claims/receipts/messages/audit, insurer /claims/member, /roster, files under l2-data, .l2-checkpoints, nautilus-data, hr-tool-data/<employerId>, network log | each of firstName,lastName,dob,cardholderId,email,enrollmentKey,enrollmentPIN,devicePIN,hash(enrollmentKey),preimage[i] "does not reach the network" (device/employer disk excluded) | 541-580 |

Insurer-auth fallback: if the insurer's own Bearer is refused (401) the harness records finding `insurer-lockout` and retries with a prior employer's Ed25519 key via `X-Admin-Signature` (93-113; finding `employer-as-insurer` if accepted).

run-multi.ts steps (two employers A/B, four members A1/A2/B1/B2 on :4001/:4011/:4012/:4013, 255-260): wait compiled + invariant at boot (246-248) → insurer POST /plans with Bearer (252) → `onboardEmployer('A')` ∥ `onboardEmployer('B')` (265-268; each: apply, upload, approve with insurer token, sign, activate, group, HR unlock/select/import/export, match tokens by displayName 92-135) → attacker: insurer token still works; employer A key refused on /employer-applications (270-276) → A1,A2,B1 `enrollMember` concurrently (282-287; per member 140-190: unlock, accept-token{tokenId}, generate-key, derive-wallet, enroll{tokenPIN}, compile, /proof/registration, wait for receipt + engine registration, decrypt device, recompute inputs 1-5 and walletId) → `checkInvariant` (73-89: l2_getRegistrationWitnesses next-slot root + per-wallet l2_getWalletWitnesses/l2_getWalletState leaf root == published root) → B2 enrols while A1 claim 1 files (298-306) → 5 more claims with invariant after each (309-320) → `verifyAll` (325-418: force-batch, per-member ledger listing + leaf inclusion vs root, l2_reconstructAccumulator vs engine accumulator, 3 audits, local compile + verify/tamper every batch, A2 portable credential, secret scan of /interactive/state + l2-data + network log for first/last/dob/cardholderId/enrollmentKey/hash(enrollmentKey)). Resume (`E2E_RESUME_DIR`, 421-489): re-reads each `member-<key>/trace.json`, recovers PHI typed + walletId from the recorded derive-wallet exchange (427-432), re-opens device state with the fixed PINs, re-registers with /interactive/register-member if missing (finding `adjudication-registration-*` 444-449), files 5 more claims with rotating drugs (465-478), one deliberate same-day duplicate for B1 (480-487), then `verifyAll`. Summary = total/passed/failed names (412-417); the script has no "known failure" labels.

Pass/fail count claim: scripts/e2e-verify/SESSION-KICKOFF.md:39 states "241 of 254 checks, and the 13 failures have known causes" without listing them; the nearest list is its "Known problem areas" (45-55). Checks coded to fail while those gaps hold: group binding (run.ts:294), open prescribe (351-353), out-of-network (425), /dur unauthenticated (534), attestation issued without ownership (536), /interactive/force-batch open (538), hash secrets on network (579 / run-multi 408), credential generation (run-multi:387), duplicate rule (run-multi:486), engine registration race (run-multi:444).

check-*.ts: `check-identity-exposure.ts` — args `<diskStateFile> [...]`; fetches /interactive/state; for 4 fixed fictional people tests presence of hashString(first/last)/hashDate(dob) in disk text and public state; 10-name dictionary and 1930-2010 DOB brute force against the disk text (7-31). `check-phi-containment.ts` — args `<run-dir> <network-log>`, `E2E_SEQ` (33-34); needles per member = plaintext first/last/dob/cardholderId from the recorded derive-wallet body + their hashString/hashDate hashes (59-74) + enrollment-key hash = `preimageFields[4]` from the decrypted device (79-87); places = `l2-data` files (not .enc/.pdf), live /interactive/state, network log, `nautilus-data`, `hr-tool-data` (90-96) and each device's decrypted state (104-106); token-boundary regex count (49-53); prints per place plaintext vs hash hits per field (108-122). `check-registry.ts` — l2_getRegistrationWitnesses + l2_getChainState; recomputes root from the empty-slot witness; prints match (4-14). `time-formulary.ts` — times FormularyService.loadFromNadac on first N rows of formulary.json and extrapolates (2-9). `reference.ts` — `expectedAdjudication` plain-bigint restatement of the fulfillment circuit split (53-94), `leaves`, `findSecrets` substring scanner (110-122). `trace.ts` — Trace recorder (steps/exchanges/checks/secrets → trace.json 40-80), `makeHttp` fetch wrapper (90-111), `poll`, `sleep` (113-126).

## 6. Other scripts

| Script | One line | Source |
|---|---|---|
| scripts/bootstrap-system.ts | DEPRECATED: kills ports, starts Leviathan, waits for health, creates ACME group + tokens on a :4005 employer node that no longer exists | 19-30, 161-315 |
| scripts/fetch-nadac.ts | Fetches ~500 NADAC rows from data.medicaid.gov API and writes src/seed/nadac-formulary.ts | 19-31, 39, 267-268 |
| scripts/extract-poseidon-constants.ts | Prints Poseidon test vectors and hunts o1js internals for MDS/round constants (Kotlin port) | 19-25, 37-91 |
| scripts/poseidon-test-vectors.ts | Prints member wallet derivation vectors for a fixed test identity + primitive Poseidon vectors | 17-49 |
| scripts/verify-vectors.ts | Recomputes a walletId with domain tag 0 for 'Alice Johnson' CH-10001 and two Poseidon vectors | 17-36 |

## 7. Seed data, importers, storage, reporting

Seed (src/seed): `index.ts` re-exports PRESCRIBERS/PHARMACIES/MEMBERS (27-44). `members.ts`: 8 fictional members (71-225) each with a **committed static enrollmentKey** (80, 99, 118, 137, 156, 175, 194, 213; comment "crypto.randomBytes(32)" 68-69). `prescribers.ts`: 10 with enrollmentKey + deaNumber (66-188). `pharmacies.ts`: 8 with enrollmentKey (79-188). `nadac-formulary.ts` exports NADAC_MEDICATIONS, NADAC_MEDICATION_BY_NDC, NADAC_MEDICATION_BY_GPI (28, 12532, 12537). Runtime importers of src/seed: none (grep over src/nodes, src/adjudication, visualizer/engine, src/l2, scripts); only src/seed/run-full-cycle.ts:91 and scripts/fetch-nadac.ts (writer). `run-full-cycle.ts` (CLI, header 17-27) and `run-l2-node.ts` (CLI, 17-31): standalone demos, no npm script, referenced only by deliverables/code_analysis_deliverable.md → unused by any node.

src/data (what nodes actually load): `index.ts` builds PRESCRIBERS/PHARMACIES from prescribers.json/pharmacies.json **including their committed enrollmentKey** (278-300; e.g. row 0's `enrollmentKey` in prescribers.json), MEDICATIONS from formulary.json or formulary-100.json when `ZKTRIDENT_FORMULARY_LIMIT≤100` (271-274, 358), and 8 hard-coded MEMBERS with the same enrollment keys as src/seed (421-575; 430 == seed 80). Imported by src/adjudication/interactive-service.ts:136, interactive-routes.ts:59, auto-mode-controller.ts:53, flowchart-orchestrator.ts:46, src/poc/*. interactive-service derives provider wallets from these keys (578-586) → provider identities are deterministic from repo files. `formulary-loader.ts` reads `src/data/formulary.json` (or `ZKP_DATA_DIR`) (28-31, 50-51); used by start-leviathan.ts:204, interactive-service.ts:139, time-formulary.ts. `import-nadac.ts`: downloads CMS CSV (44), writes formulary.json / compact / lookup JSON (302, 316, 331); not imported anywhere. `import-nppes.ts`: queries NPPES API (140), mints provider enrollmentKey = sha256(`zkpcare-<role>-<npi>`)[:32] (157-160, 206, 265), writes prescribers.json/pharmacies.json (302-303); not imported anywhere. GAP I3-analogue for providers: enrollment keys are derivable from public NPIs.

src/storage: `local-store.ts` — `ILocalStore` interface (68-82) for wallet records, Merkle state, proof blobs (hash-only invariant 18-40); `InMemoryStore` Maps, no encryption/persistence (85-125). Used by start-leviathan.ts:61, start-nautilus.ts:53, l2-node/l2-leviathan/l2-sequencer (type), poc-orchestrator, run-l2-node. `index.ts` re-exports (17-18).

src/reporting: `ReportingService` (reporting-service.ts:65) methods extractVerifiedClaim 73, verifyNdc 116, verifyContext 131, isAlreadySettled 163, generate{ClaimsRegister 175, PharmacyActivity 196, PrescriberActivity 225, MemberActivity 253, MedicationUtilization 291, FinancialSummary 330, PriorAuthReport 367, ReversalReport 413, TierAnalysis 449, TherapeuticClassReport 484, TimeSeries 516, CrossTab 549}. Callers: src/nodes/insurer-node.ts:54,69 (insurer /reports/*), src/adjudication/interactive-service.ts:146; types only in audit-types.ts:26, l2-sequencer-service.ts:38, insurer-routes.ts:41.

## 8. Reachability verdicts

src/poc: 8 files. `poc-orchestrator.ts` boots 3 leviathans + insurer/members/prescribers/pharmacies with mock receipts (header 17-29; ports poc-types.ts:24-31 — insurer :4000, members :4001-4005, dashboard :8080, overlapping production ports) via `npm run start:poc` (package.json:24). `flowchart-dashboard-server.ts` is imported by visualizer/engine/flowchart-orchestrator.ts:44 (`npm run start:flowchart`, package.json:25,27). `poc-dashboard-server.ts` serves visualizer/dist/poc-dashboard.* (50, 106-110). `patent-evidence-runner.ts` standalone (17-38). None reached by start-leviathan or any Nautilus node.

src/index.ts: barrel of 30 export statements (sections 19-458: models, zkp, storage, security, engine, credentials, eligibility, access-control, messaging, prescription, fulfillment, reporting, onboarding, L2, audit, data). package.json `main: build/index.js` (6) but no build/ dir exists and nothing under src/, visualizer/, scripts/ imports it → unused at runtime.

visualizer/src and visualizer/dist/flowchart: not served by any running process in src/nodes (since B1 step one, 2026-10-17, no file under src/ mentions visualizer; `tests/engine-location.test.ts` asserts it). visualizer/src/*.html is served only by the Parcel dev server on :1234 (visualizer/package.json `dev`); dist/flowchart only by FlowchartDashboardServer (src/poc/flowchart-dashboard-server.ts:52-54) under `npm run start:flowchart`; dist root (poc-dashboard.*) only by poc-dashboard-server.ts:50. Verdict: legacy UIs, dead for the :3030/:4001-4004 topology.

Root strays: `_dashfix.mjs` — rewrites em/en dashes to hyphens in README/ARCHITECTURE/RUNNING/SECURITY/MISSION/NOTICE (3, 10); untracked, unreferenced. `_monitor.sh` — curl loop printing l2_getStatus counters and /interactive/state totals (7-8, 24); gitignored (.gitignore:35), unreferenced. `_fix_patents.py` — edits word/document.xml inside patent .docx files (1-4); gitignored (34), unreferenced. `nul` — 0-byte Windows `NUL` redirection artifact (also visualizer/nul); gitignored (20).

## 9. Prior-claim cross-check (summary)

(a) wipe at 520-524 holds; PHI goes only to :4001 /onboarding/derive-wallet (499-514), but survives a failed derive. (b) holds: Backup encrypts `enrollmentKey` (1405) which is `'server-managed'` (470) unless restored; version:2 at 1411. (c) holds: Restore PBKDF2 614-620 vs scrypt (enrollment-backup.ts:28,107; recovery-card.ts:137); raw key to localStorage at 634. (d) keys: zkt_walletId, zkt_enrollmentKey, zkt_seqUrl, zkt_insurerUrl, zkt_proverUrl, zkt_granted (unused); PCP and system log are NOT in storage (45, 142-146). (e) holds: accept-token body `{tokenId}` (375); node defaults groupId '' (member-routes.ts:108-120) → groupIdHash Field(0) (235-236). (f) holds for prescriber (1152, 1177) and pharmacy (778, 1582, 1610); member sends plaintext to its node (1341, 1363) and decodes base64/hex (94-106). (g) holds: localStorage `zkt_insurer_admin_token` (rpc.js:33, 37). (h) holds: 2 employers (265-268), 4 members (255-260), summary passed/checks (413-416); 13 failures not named by script; SESSION-KICKOFF.md:39 states count only. (i) holds: see §5 check-phi-containment description (needles 59-87, places 90-96, report 108-122).

## Open questions

- Does the sequencer accept `l2_forceBatch` without Bearer (dashboard-leviathan/app.js:2025-2028 assumes so)? Sequencer auth is outside this map.
- Is `/interactive/nfc/write` (interactive-routes.ts:1844) reachable from a phone browser in production, and should the member app ever call :3030 directly (app.js:1492)?
- Marketplace: after a refresh `regenerateKeypair()` (app.js:629) creates a key different from the one in `/apply` — does the insurer accept the new public key at `/sign`? (server-side, unmapped here)
- `zkt_enrollmentKey='server-managed'` (app.js:470): is the member node's encrypted state the only place the real key lives after a fresh enrollment, and is the browser Restore path (634) therefore the only way a raw key reaches localStorage?
- Who serves the HR Tool port and does src/tools/hr-tool-server.ts authenticate `/api/*` beyond the passphrase session (dashboard sends no header, app.js:66-77)?
- Employer dashboard roster shows `consumedByWalletId` (app.js:453): is that field actually populated by the employer node (I6)?
- Pharmacy `INTERACTIVE_BASE` (app.js:1931) is unused by the badge tap (2039 uses location.origin); prescriber's `window.INTERACTIVE_BASE` is never set anywhere (only app.js:1414) — intended override?
- Which checks make up the 13 known failures of the 241/254 run (SESSION-KICKOFF.md:39) — no file enumerates them.
