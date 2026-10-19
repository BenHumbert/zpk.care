# Code map — `/interactive/*` and `/node/*` routes

Working tree as read on 2026-10-16; paths updated 2026-10-17 when B1 step one moved the engine to `src/adjudication/` (line numbers are from the 2026-10-16 tree). Abbreviations: R = src/adjudication/interactive-routes.ts, S = src/adjudication/interactive-service.ts, RPC = src/l2/l2-rpc-server.ts, SEQ = src/l2/l2-sequencer-service.ts, N = src/l2/l2-node.ts, L = src/nodes/start-leviathan.ts, SI = visualizer/engine/start-interactive.ts.

## Mounting and auth model

| Fact | Source |
|---|---|
| `registerInteractiveRoutes(server, service, nfcBridge?)`. Leviathan calls it without an NfcBridge, so the 5 `/interactive/nfc/*` routes are NOT registered in the normal `start:leviathan` path (only by start-interactive.ts) | R:61-65; L:329; SI:119-130 |
| `reg()` registers `METHOD:path`; `adminOnly` for the paths in `ADMIN_ROUTES` and, since D2 (2026-10-18), for every other POST route except `register-member`, `verify-credential` and the wallet-signed routes, for the member-data GET routes (`GATED_READS`: member-history, family-history, threads, prescriptions-by-pharmacy, fill-status, step-therapy-check, enroll-status) and for every `/node/*` route except chain-state, chain-proof, all-batches and formulary (`OPEN_NODE_READS`); the credential is the operator's token or a node key whose role may call the route (`ROUTES_BY_ROLE`) | R:67-82; RPC:386-396 |
| Dispatch = exact `METHOD:pathname` map lookup; admin-gated keys need `checkAdminAuth`, else 401 | RPC:498-507 |
| ADMIN = unsecure mode or no admin keys registered → `Authorization: Bearer <adminToken>` (default-deny when no token configured); otherwise Ed25519 `X-Admin-Signature` | RPC:2661-2671, 2624-2625 |
| adminToken = `ZKTRIDENT_ADMIN_TOKEN`, or `admin123` only when `ZKTRIDENT_UNSECURE=true` | L:80-81, 118-127 |
| No SESSION class exists: badge sessions (S:6605-6611) are returned to the caller and never checked by any route. No per-route RATE limit: the only limiter is `l2_submitProof` on `/rpc` | RPC:717-723, 2742-2754 |
| In-process guards only: `enrollmentJobs` (R:142), `fillJobs` + 5-min TTL (R:413-415), `credentialJobs` (R:950), `badgeTapInProgress` → 429 (R:145, 1939-1942) | R |
| ~~Every handler writes `Access-Control-Allow-Origin: *` itself, overriding the server CORS policy~~ **Fixed by A2 (2026-10-17): all 77 removed. No handler sets the header; `L2RpcServer.handleRequest` applies the deployment allowlist once.** | R:top-of-file note; RPC:420-424 |
| `GET /interactive/badge/:key` is registered as the literal key `GET:/interactive/badge/`; exact-match dispatch means `/interactive/badge/prescriber-0` never reaches it (falls through to dashboard static files) — dead route | R:2013-2043; RPC:392, 500 |
| Helpers: `readBody` (no size limit), `sendError`, BigInt-safe `safeJsonStringify`; console emitter stashed on the server object | R:2061-2093, 2045-2053 |
| Server-side 30 s request timeout except SSE paths | RPC:408-418 Since D1 every POST route the engine registers carries a 180 s budget (`registerRoute` `timeoutMs`, `ENGINE_ROUTE_BUDGET_MS`): prescribing makes four proofs in about 35 s. |

Counts: 49 distinct `/interactive/*` paths (44 registered in the leviathan path + 5 NFC-only) + 16 `/node/*` paths. ADMIN = 9. OPEN = 35 interactive + 16 node = 51 in the leviathan path. **D2 (2026-10-18):** OPEN is now register-member, verify-credential, console, l2-status, the wallet-signed routes, badge/list, badge/:key and the four chain reads under `/node/`; everything else needs a credential.

## Route table

Columns: Auth = OPEN (no check in handler or server) or ADMIN (above). Checks = plain-TypeScript checks, handler then service, in order. Proofs = `Program.method` and fate: SUBMITTED (`l2Node.submitProof`, N:494 → SEQ:291), RETURNED (to HTTP caller), STORED (engine memory/disk), DISCARDED (awaited, result unused), VERIFIED(by). Writes: mem = engine maps; disk = `<checkpointDir>/adjudication-state.json` (exportState on `batch:built`/`batch:settled` and every 60 s, L:349-368); seq = sequencer trees/pool.

### Enrollment

| Method | Path | Auth | Checks in order | Service method | Proofs made and fate | Writes | Source |
|---|---|---|---|---|---|---|---|
| POST | /interactive/register-member | OPEN; B2: a body with preimageFields is 400; takes the device's ownership proof | walletId + ownershipProofJson → compiled → not already registered → insurer approval (403) → REGISTERED on the ledger (409) → proof reads, names the wallet, verify() passes → publicKeyHex is 64 hex (else key skipped) | registerMemberFromEnrollment | credential mint queued as a pending wallet update the device proves; the ownership proof kept for the portable credential Since B8 (A-34) a body naming `familyId` or `employeeId` is 400; the family is bound from the approval. |
| POST | /interactive/enroll | credential (D2: the operator or a node key whose role may call it), was OPEN | memberIndex number → job dedupe → compiled → seed MEMBERS[idx] exists → not already enrolled | enrollMember (seed member; 202 + poll; withProvingLock) | ProofGate.verifyMember STORED; StateTransition.proveRegistration SUBMITTED; StateTransition.proveWalletUpdate (mint) SUBMITTED; then `buildBatchDirect` | seq: 2 proofs + batch + adminMutate setLifecycle ELIGIBLE (S:1309-1311); mem+disk: enrolledMembers. GAP: I1/I3 seed path reads raw member PII + enrollmentKey in the sequencer process (S:1017-1061, 1372) | R:177-223; S:1007-1510 (PG 1073-1081; reg 1115-1142; mint 1242-1277; batch 1298; store 1375-1405) |
| GET | /interactive/enroll-status | credential (D2), was OPEN | memberIndex param | job map | — | mem: finished job deleted | R:225-261 |
| POST | /interactive/enroll-family | credential (D2: the operator or a node key whose role may call it), was OPEN | subscriberIndex number → compiled → seed member is SELF → loop family | enrollFamily → enrollMember | as enroll, per member | as enroll | R:756-778; S:1677-1718 |

### PCP

| Method | Path | Auth | Checks in order | Service method | Proofs made and fate | Writes | Source |
|---|---|---|---|---|---|---|---|
| POST | /interactive/assign-pcp | credential (D2: the operator or a node key whose role may call it), was OPEN. GAP: I7 no member consent or caller auth | memberWalletId string + prescriberIndex number → compiled → member enrolled → seed prescriber exists | assignPcp | ProofGate.verifyPrescriber (seed preimage) DISCARDED; PcpVerification.verifyPcpAssignment DISCARDED; StateTransition.proveWalletUpdate (member's inputs) SUBMITTED | mem+disk: forest MEMBER leaf 0, credentialData, pcpAssignment; seq: wallet update | R:707-731; S:4701-4866 (PG 4722-4727; PCP 4781-4786; submit 4792) |
| POST | /interactive/pcp-assignment | wallet-signed (the member's own key, A10b); the operator token is refused | walletId, pcpWalletId, effectiveDate strings (specialty defaults 'General Practice', consentScopeFlags 7) → compiled (503) → member with a device (fixture 409) → not REVOKED (409) → prescriber credentialed and ACTIVE (404/409) | assignPcpForDevice | none here: the wallet update is queued and the device proves it (B1 step two, commit three) | mem: forest MEMBER leaf 0, credentialData, pcpAssignment, pending wallet update | interactive-routes.ts; interactive-service.ts assignPcpForDevice |
| POST | /interactive/prescriber-authorization | wallet-signed (the member's own key); the operator token is refused | walletId, prescriberWalletId strings (ndcHash optional, hours 1-72 default 24) → member with a device (fixture 409) → not REVOKED (409) → prescriber credentialed and ACTIVE (404/409) | authorizePrescriber | none: the wallet signature is the consent (B5) | mem + checkpoint: prescriberAuthorizations | interactive-routes.ts; interactive-service.ts authorizePrescriber |
| GET | /interactive/member-history | credential (D2), was OPEN. GAP: I7/I4 member data by walletId, no auth; header comment says "PCP-gated" (R:26) but no gate exists | walletId param → enrolled | getMemberHistory | — | — | R:733-754; S:4868-4938. Note: `fulfillment` at S:4922 is not declared in this method (only S:3044 in dispensePrescription) → ReferenceError once the member has ≥1 Rx |
| GET | /interactive/family-history | credential (D2), was OPEN. GAP: I7 | walletId → enrolled | getFamilyHistory | — | — | R:780-801; S:4940-5035 (same undefined `fulfillment` S:4985) |

### Prescribing

| Method | Path | Auth | Checks in order | Service method | Proofs made and fate | Writes | Source |
|---|---|---|---|---|---|---|---|
| POST | /interactive/resolve-indices | credential (D2: the operator or a node key whose role may call it), was OPEN | optional prescriberWalletId / pharmacyWalletId | getPrescriberWalletId / getPharmacyWalletId — loops over seed PRESCRIBERS/PHARMACIES only | — | — | R:341-375; S:5170-5177 |
| POST | /interactive/prescribe | credential (D2: the operator or a node key whose role may call it), was OPEN. GAP: I7 prescriberIndex is caller-chosen; engine proves with the seed prescriber's preimage | 4 typed fields → compiled → seed prescriber, seed pharmacy, drug in 32K map, member enrolled → PA approved if drug requires PA (pending → error) → step therapy → DEA number present → Schedule ≥2 forces refills 0 | createPrescription (withProvingLock; forceBatch after) | ProofGate.verifyPrescriber DISCARDED; Eligibility.proveEligibility DISCARDED; AccessControl.proveFormularyAccess DISCARDED; AccessControl.provePriorAuth (PA drugs) DISCARDED; Messaging.proveSendMessage (eScript) DISCARDED; nothing submitted | mem+disk: pendingPrescriptions → prescriptions; mem: messageRegistry + encryptedPayloads (eScript); seq: emitMessagingAuditEvent | R:377-415; S:2064-2543 (checks 2073-2145; proofs 2178-2183, 2265-2270, 2298-2303, 2331-2337, 2382-2388; audit 2409; store 2434-2455) B5: a REVOKED member → 409; a member with a device → the prescriber must be the named PCP or hold a device-granted authorization, else 403 before any record; refusals now pass through with their status. |
| GET | /interactive/step-therapy-check | credential (D2), was OPEN | memberWalletId + ndcHash | checkStepTherapy → getFormularyLeafIndex. Side effect on a GET: may append a formulary leaf, rewrite every member's eligibilityData/credentialData/forest leaf 0 and `benefitPlanRegistry.updatePlan(0n)`; no wallet update is submitted | — | mem: formulary + all members | R:1133-1157; S:1981-2029, 809-866 |

### Prior auth

| Method | Path | Auth | Checks in order | Service method | Proofs made and fate | Writes | Source |
|---|---|---|---|---|---|---|---|
| POST | /interactive/request-prior-auth | credential (D2: the operator or a node key whose role may call it), was OPEN. GAP: I7 | 3 typed fields → drug requiresPriorAuth (static seed entry) → member enrolled → seed prescriber → no PENDING/APPROVED PA for member+drug | requestPriorAuth | none (sendInternalMessage prescriber→insurer, no proof) | mem+disk: priorAuths; mem: messages; seq: audit event | R:263-290; S:1720-1797 |
| POST | /interactive/approve-prior-auth | ADMIN | priorAuthId string → compiled → PA exists and PENDING → member enrolled | approvePriorAuth (withProvingLock; forceBatch after) | AccessControl.provePriorAuth DISCARDED (requested qty = approved qty, S:1867-1868); StateTransition.proveWalletUpdate SUBMITTED | mem+disk: forest ACCESS_CONTROL leaf n, PA APPROVED; seq: wallet update | R:292-315; S:1799-1923 (PA data 1820; proof 1864-1870; submit 1876) |
| POST | /interactive/deny-prior-auth | ADMIN | priorAuthId → exists and PENDING | denyPriorAuth | none | mem+disk: PA DENIED | R:317-339; S:1925-1962 |

### Fill / dispense / reverse

| Method | Path | Auth | Checks in order | Service method | Proofs made and fate | Writes | Source |
|---|---|---|---|---|---|---|---|
| GET | /interactive/prescriptions-by-pharmacy | credential (D2), was OPEN. GAP: I7 any caller reads any pharmacy's queue incl. member wallet IDs | pharmacyIndex (default 0) | getPrescriptionsByPharmacy | — | — | R:512-523; S:5183-5264 |
| POST | /interactive/mark-filled | credential (D2: the operator or a node key whose role may call it), was OPEN. GAP: I7 any caller; pharmacy identity taken from the Rx record | prescriptionId → exists → status ADJUDICATED | markFilled | none | mem+disk: rxForest TRANSACTION leaf, status FILLED | R:525-542; S:2552-2607 |
| POST | /interactive/fill | credential (D2: the operator or a node key whose role may call it), was OPEN. GAP: I7. D4: a job is shared only while it runs; a finished job no longer answers the next request; `dispensePrescription` refuses a duplicate of another prescription's same-day fill with 409 before any proof | prescriptionId string → job dedupe → compiled → Rx exists → not DISPENSED/CANCELLED/REJECTED → status FILLED or PARTIALLY_FILLED → qty ≤ remaining and ≥ 1 → costs: ingredient default AWP×qty, fee default 200; caller-supplied cents accepted without bounds | dispensePrescription (withProvingLock; 202 + poll; forceBatch after) | ProofGate.verifyPharmacy DISCARDED; Prescription.proveStatusUpdate DISCARDED; AccumulatorFulfillment.proveFulfillmentWithAccumulator: proof DISCARDED, publicOutput READ (pay, deductible credit, new root) then pay REWRITTEN by family pooling; StateTransition.proveWalletUpdate SUBMITTED with ClaimSubmissionMetadata | mem+disk: accumulatorData, both forests, fulfillments, Rx status; seq: wallet update + claim leaf | R:417-468; S:2611-3186 (status 2620-2628; qty 2652-2661; cost 2665-2667; proofs 2685-2691, 2734-2740, 2805-2811; output read 2822-2824; pooling rewrite 2901-2920; settlement leaf 2972-2977; claimMeta 3002-3017; submit 3020) |
| GET | /interactive/fill-status | credential (D2), was OPEN | prescriptionId | job map | — | mem: TTL prune | R:470-510 |
| POST | /interactive/prescribe-and-fill | credential (D2: the operator or a node key whose role may call it), was OPEN | memberWalletId + ndcHash → prescriberIndex default 0 (or seed wallet lookup) → createPrescription → dispensePrescription | createPrescription + dispensePrescription (202 + poll) | as prescribe + fill | as both | R:544-634. Never calls markFilled: prescribe leaves ADJUDICATED (S:2450, 2490) and dispense requires FILLED/PARTIALLY_FILLED (S:2626) → step 2 throws (static reading) |
| POST | /interactive/update-rx-status | credential (D2: the operator or a node key whose role may call it), was OPEN. GAP: I7 role/actorIndex are caller-asserted | 4 typed fields → newStatus ∈ {CANCELLED, REJECTED, COMPLETED, DISPENSED} → role ∈ {prescriber, pharmacy} → Rx exists → COMPLETED needs DISPENSED + pharmacy; else `isValidStatusTransition`; CANCELLED needs prescriber; REJECTED needs pharmacy | updateRxStatus | none | mem+disk: Rx status/history | R:636-676; S:3188-3284 (3214) |
| POST | /interactive/reverse | credential (D2: the operator or a node key whose role may call it), was OPEN. GAP: I7 | prescriptionId → Rx exists → status DISPENSED or PARTIALLY_FILLED → fills exist → fillIndex valid, not reversed → member exists | reversePrescription (withProvingLock; forceBatch after) | AccumulatorFulfillment.proveReversalWithAccumulator DISCARDED (new root read S:3364); StateTransition.proveWalletUpdate SUBMITTED (failure logged, local state kept) | mem+disk: reversal leaf, accumulator rollback, fill.reversed, status REVERSED; seq: wallet update + claim leaf (operationType 2) | R:678-705; S:3286-3522 (checks 3291-3308; proof 3353-3359; submit 3449-3453) |

### Status / queries

| Method | Path | Auth | Checks in order | Service method | Proofs made and fate | Writes | Source |
|---|---|---|---|---|---|---|---|
| GET | /interactive/state | OPEN. GAP: I1/I5/I6 — see field list below | — | getState | — | — | R:121-139; S:6031-6345 |
| GET | /interactive/console | OPEN | — | SSE of ConsoleEvent (also printed to stdout) | — | — | R:85-119 |
| GET | /interactive/l2-status | OPEN | — | seq.getAllReceipts / getAllBatches / getAuditLog; node.getStatus | — | — | R:1159-1198 |
| GET | /node/state | credential (D2), was OPEN | — | getState + seed prescriber (NPI, DEA), pharmacy (NPI, NCPDP, address, phone), medication arrays | — | — | R:1303-1349 |
| GET | /node/claims-by-member | credential (D2), was OPEN. GAP: I7 member claim history by walletId | walletId | seq.getClaimsByMember | — | — | R:1351-1374; SEQ:2107 |
| GET | /node/claims-by-prescriber | credential (D2), was OPEN | walletId | seq.getClaimsByPrescriber | — | — | R:1376-1399; SEQ:2117 |
| GET | /node/claims-by-pharmacy | credential (D2), was OPEN | walletId | seq.getClaimsByPharmacy | — | — | R:1401-1424; SEQ:2112 |
| GET | /node/claims-by-ndc | credential (D2), was OPEN | ndcHash | seq.getClaimsByNdc | — | — | R:1426-1449; SEQ:2122 |
| GET | /node/receipts-by-wallet | credential (D2), was OPEN | walletId | seq.getReceiptsByWallet | — | — | R:1451-1474; SEQ:2043 |
| GET | /node/dur | credential (D2), was OPEN. GAP: I7 | memberWalletId | seq.getClaimsByMember | — | — | R:1476-1504 |
| GET | /node/claim-proof | credential (D2), was OPEN | leafIndex | seq.getClaimWithProof | — | — | R:1506-1530; SEQ:2127 |
| GET | /node/formulary | OPEN | planIdHash | seq.getFormulary | — | — | R:1532-1555; SEQ:1676 |
| GET | /node/all-receipts | credential (D2), was OPEN | — | seq.getAllReceipts | — | — | R:1557-1572; SEQ:2038 |
| GET | /node/all-batches | OPEN | — | seq.getAllBatches | — | — | R:1574-1589; SEQ:2058 |
| GET | /node/audit-log | credential (D2), was OPEN | — | seq.getAuditLog | — | — | R:1591-1616; SEQ:2414 |
| GET | /node/chain-proof | OPEN | — | seq.getLatestChainProofJson / getCurrentGlobalStateRoot / getCurrentBlockHeight | — | — | R:1618-1640; SEQ:2073, 2063, 2068 |
| GET | /node/chain-state | OPEN | — | 13 sequencer getters (roots, counts, claim accumulator root) | — | — | R:1642-1671 |

### Batch / admin

| Method | Path | Auth | Checks in order | Service method | Proofs made and fate | Writes | Source |
|---|---|---|---|---|---|---|---|
| POST | /interactive/force-batch | OPEN. GAP: I7 state-changing, unauthenticated | — | forceBatch → node.forceBatch | batch proof built by the L2 side (BatchProgram) | seq: batch | R:1200-1217; S:5155-5157; N:567 |
| POST | /node/force-batch | credential (D2), was OPEN. GAP: I7 | — | same | same | same | R:1673-1690 |
| POST | /interactive/save-checkpoint | OPEN. GAP: I7 | — | saveCheckpoint → node.saveCheckpoint('manual') | — | disk: L2 checkpoint | R:1219-1232; S:5160-5162; N:1579 |
| POST | /interactive/retry-batch | OPEN. GAP: I7 | optional batchNumber, else first failed batch | seq.retryBatch | — | seq | R:1234-1259; SEQ:1255 |
| POST | /interactive/simulate-batch-failure | OPEN. GAP: I7 | optional batchNumber, else last settled | seq.markBatchFailed | — | seq | R:1261-1287; SEQ:1106 |
| POST | /interactive/reset | ADMIN | — | reset (clears session maps, re-runs initInfrastructure) + clears job maps | — | mem (disk overwritten at next save) | R:1289-1299; S:6368-6400 |
| POST | /interactive/terminate-member | ADMIN | memberWalletId → enrolled → not REVOKED | terminateMember | none | seq: adminMutate(EnrollmentService.terminateMember) → REVOKED; mem+disk: lifecycle, credential revoked, active Rx cancelled; attestation nonce revoked | R:803-827; S:4054-4154 (4073-4075, 4080-4083) |
| POST | /interactive/terminate-group | ADMIN | groupId → ≥1 active member | terminateGroup → terminateMember | none | as above | R:829-853; S:4156-4196 |
| POST | /interactive/update-formulary | ADMIN | ndcHash + action ∈ {MODIFY, REMOVE, ADD} → consistent with formularyActive | updateFormularyEntry | per active member: StateTransition.proveWalletUpdate SUBMITTED | mem: formularyRegistry rebuilt, sharedEligibilityData, benefitPlanRegistry, all members' forests; seq: N wallet updates | R:1062-1084; S:4227-4432 (cascade 4336-4379) |
| POST | /interactive/update-provider-network | OPEN. GAP: I7 — not in ADMIN_ROUTES although it runs the same cascade as update-formulary | prescriberWalletId + action ∈ {ADD, REMOVE} → consistent with networkActive | updateProviderNetwork | per active member: StateTransition.proveWalletUpdate SUBMITTED | as formulary + networkActive | R:1086-1108; S:4435-4624 (cascade 4519-4571) |
| POST | /interactive/plan-year-rollover | ADMIN | newPlanYear string | planYearRollover | per active member: StateTransition.proveWalletUpdate SUBMITTED | mem+disk: accumulators zeroed; seq: N wallet updates | R:1110-1131; S:4626-4699 |
| POST | /node/publish-formulary | credential (D2), was OPEN | planIdHash, formularyRoot, entriesJson strings | `seq.getFormulary(planIdHash)` only — formularyRoot/entriesJson are ignored (no-op) | — | — | R:1692-1721; SEQ:1676 |

### Badge / NFC

| Method | Path | Auth | Checks in order | Service method | Proofs made and fate | Writes | Source |
|---|---|---|---|---|---|---|---|
| GET | /interactive/badge/list | OPEN | — | getAllProviderBadges (walletId truncated) | — | — | R:1919-1935; S:6422-6428 |
| POST | /interactive/badge/tap | credential (D2: the operator or a node key whose role may call it), was OPEN. GAP: I7 issues an 8 h provider session to any caller; PIN is the engine's DEV_BADGE_PIN | not in progress (429) → providerType ∈ {prescriber, pharmacy}; providerIndex default 0 → badge exists → `authenticateFromBadge(badge, DEV_BADGE_PIN)` | simulateBadgeTap | ProofGate.verifyPrescriber/verifyPharmacy (seed preimage) DISCARDED; event `verified: true` hard-coded; registry check hard-coded ACTIVE; Ed25519 session attestation RETURNED | — | R:1937-1973; S:6440-6638 (PIN 6479; proof 6546-6553; verified 6569; registry stub 6594-6599; session 6605-6611) |
| POST | /interactive/badge/auto-tap | credential (D2: the operator or a node key whose role may call it), was OPEN | not in progress → includePharmacies / maxProviders | autoTapSimulation → simulateBadgeTap loop | as tap, per provider | — | R:1975-2011; S:6640-6683 |
| GET | /interactive/badge/:key | OPEN | regex key → badge exists | getProviderBadge (ek redacted) | — | — | R:2013-2043 (unreachable, see above) |
| GET | /interactive/nfc/events | OPEN (NFC launcher only) | — | SSE of bridge events; `tag:read` → verifyAttestation (Ed25519 + revocation) or legacy verifyCredential | verifyCredential: VERIFIED(verifyCredentialOffline) | — | R:1724-1823, 1826-1842 |
| POST | /interactive/nfc/write | credential (D2: the operator or a node key whose role may call it), was OPEN (NFC only) | walletId → bridge connected | getAttestation → nfcBridge.queueWrite (attestation, else bare member-id record) | — | NFC tag | R:1844-1886 |
| POST | /interactive/nfc/cancel | credential (D2: the operator or a node key whose role may call it), was OPEN (NFC only) | — | nfcBridge.cancelWrite | — | — | R:1888-1896 |
| GET | /interactive/nfc/status | OPEN (NFC only) | — | nfcBridge.getStatus | — | — | R:1898-1905 |
| GET | /interactive/nfc/sequencer-pubkey | OPEN (NFC only) | — | getSequencerPublicKey (engine's attestation key, not the node's) | — | — | R:1907-1915; S:5602-5604 |

### Messaging

| Method | Path | Auth | Checks in order | Service method | Proofs made and fate | Writes | Source |
|---|---|---|---|---|---|---|---|
| POST | /interactive/send-message | credential (D2: the operator or a node key whose role may call it), was OPEN. GAP: I7 sender identity is caller-asserted (type/index/walletId) | senderType, recipientType, subject, body present → compiled → resolve both parties (member must be enrolled and not REVOKED) → both encryption keys known → sender private key held by engine (device members rejected) | sendMessage (withProvingLock) | Messaging.proveSendMessage DISCARDED | mem: messageRegistry, encryptedPayloads; seq: emitMessagingAuditEvent | R:855-876; S:3678-3813 (3706-3709; proof 3752-3758; audit 3778) |
| POST | /interactive/decrypt-thread | ADMIN | messageIndices array + walletId → requester is sender or recipient → both private keys held by engine | decryptThread → decryptMessageByIndex (decrypts on the sequencer) | — | — | R:878-899; S:3890-3918, 3815-3888 |
| GET | /interactive/threads | credential (D2), was OPEN. GAP: I7 any wallet's thread list | walletId | getThreads | — | — | R:901-922; S:3920-3978 |
| POST | /interactive/create-delegation | ADMIN | 4 fields → compiled → both enrolled → not self | createDelegation | Messaging.proveDelegate DISCARDED | mem: delegationRegistry | R:924-948; S:3980-4052 (proof 4023-4029) |

### Credential

| Method | Path | Auth | Checks in order | Service method | Proofs made and fate | Writes | Source |
|---|---|---|---|---|---|---|---|
| POST | /interactive/generate-credential | OPEN. GAP: I7/I4 anyone can mint a member's portable credential + attestation from the engine's stored inputs | walletId → job dedupe → compiled → enrolled → not REVOKED → CredentialProgram VK present | generateCredential (withProvingLock; 202 + poll) | ProofGate.verifyMember (member's stored 6 inputs) → input to Credential.proveHolding / proveHoldingByType → serialized PortableCredential RETURNED + STORED (lastCredentialJson, also in getState); Ed25519 attestation (24 h) RETURNED + STORED (lastAttestation); nothing submitted | mem+disk: lastCredentialJson; mem: lastAttestation | R:953-998; S:5369-5504 (PG 5405-5415; credential 5427-5441; serialize 5449; store 5466; attestation 5469-5475) B1 step two, commit two: refuses a member with a device (409); fixture members only. A member's credential comes from the member node's `POST /credential/generate`. |
| GET | /interactive/credential-status | OPEN | walletId (+ proofType) | job map | — | mem: finished job deleted | R:1000-1039 |
| POST | /interactive/verify-credential | OPEN | credentialJson → VK compiled → JSON parses → version 1 | verifyCredential | VERIFIED by `verifyCredentialOffline(credential, credentialProgramVk)` (src/credentials/portable-credential.ts); response adds member display name and the member's fillable Rx list | — | R:1041-1060; S:5506-5600 (5525) |

## GET /interactive/state — top-level fields (S:6167-6344)

| Field | Content | Identity-linked? | Source |
|---|---|---|---|
| compiled, ready | booleans | no | S:6168-6169 |
| chainState | registry/lifecycle roots, walletCount, adminPublicKeyHash, benefitPlanRoot, messagingRoot; credentialRegistryRoot and eligibilityVkHash hard-coded `'0'` | no | S:6170, 5266-5284 |
| l2 | node status, receipts (walletId truncated), batches, auditLog summary | truncated wallet IDs | S:6142-6180 |
| enrolledMembers[] | memberIndex, walletId (full), walletIdDisplay, displayName, planId, groupId, familyId, relationship, employeeId, accumulator, pcpAssignment {prescriberIndex, name, specialty}, inNetworkPrescribers/Pharmacies, lifecycle, terminationDate, nonce, l2Receipts, credentialJson (full portable credential), lastAttestation, credentialInventory | YES. GAP: I5/I6 full wallet ID beside displayName/employeeId/familyId served to anyone; GAP: I4 anyone can take a member's portable credential and attestation | S:6040-6067 (employeeId 6049; credentialJson 6062; lastAttestation 6063) |
| prescriptions[] | pending + adjudicated Rx: id, drug, ndcHash, memberWalletId (full), prescriber/pharmacy index, qty, refills, status, statusHistory, pay totals | wallet ID ↔ drug history. GAP: I7 unauthenticated | S:6069-6116 (pending 6074; rx 6094) |
| priorAuths[] | id, memberWalletId, memberName, prescriberName, drug, status, timestamps | YES (name ↔ wallet ↔ drug) | S:6119-6139 |
| fulfillments[] | per-fill pay, accumulator before/after, roots, settlementCommitment, service date | via prescriptionId | S:6184-6198 |
| reports | 8 ReportingService reports + ndcDirectory (null until a fill exists) | wallet IDs | S:6199, 5342-5367 |
| auditSummary | counts and cent totals | no | S:6200-6210 |
| formularyChangeHistory | change log incl. affectedMembers wallet IDs | wallet IDs | S:6211 |
| demoData | members[] = seed PII (firstName, lastName, cardholderId, dateOfBirth, relationship, employeeId, familyId, address, city, state, zip, genderCode) — GAP: I1 raw identity fields served from the sequencer (fixtures, but PII-shaped); prescribers[] (npi, deaNumber); pharmacies[] (npi, ncpdpId, address, phone); medications[] with live formulary flags; plan; providerNetwork (active map keyed by wallet ID, change history); token | YES (seed members) | S:6212-6310 (members 6213-6227; cardholderId 6217; dateOfBirth 6218; employeeId 6220) |
| messaging | counts; messages[] (sender/recipient wallet IDs, contentHash, type, nonce, threadId, timestamp, hasEncryptedPayload); delegations[] (wallet IDs, scope, relationship) | wallet-ID social graph served openly | S:6311-6342 |
| walletDirectory | every known wallet ID → {displayName, type, index} for prescribers, pharmacies, members, insurer | YES. GAP: I2/I6 wallet-ID → name directory | S:6343, 6347-6365 |

Not present in getState: enrollmentKey (all `enrollmentKey` uses are S:580-609, 774-781, 1017-1086, 1372, 1694, 2695, 6536-6540, none inside S:6031-6345), preimageFields, publicKeyHex, encryption keys.

## Open questions

- The engine's viz loopback (`POST /viz/emit`, L:313-326; SI:90-102) sends no Authorization header while RPC:455-462 admin-gates that path — are viz events from the engine being dropped with 401? (static reading)
- `member-history` / `family-history` reference an undeclared `fulfillment` (S:4922, 4985; declared only at S:3044 inside dispensePrescription) — do these routes work once a member has a prescription?
- `prescribe-and-fill` (R:544-634) never calls markFilled while dispense requires FILLED (S:2626). Is this route still used?
- Is `update-provider-network` intentionally outside `ADMIN_ROUTES` (R:67-77) while `update-formulary` is inside?
- `GET /interactive/step-therapy-check` can mutate the formulary and every member's eligibility data (S:809-866) without submitting wallet updates — intended?
- Which process is meant to enforce member consent for assign-pcp and to check badge sessions, given no route reads a session token?
- Should `/interactive/badge/:key` be matched by prefix (R:2013-2043 vs RPC:500)?

## Approval and the register-member gate (Step 2, commit two, 2026-10-18)

`POST /interactive/approve-member {walletId, groupIdHash, planIdHash, planId, employerId?, familyIdHash?}` — admin-gated; `ROUTES_BY_ROLE.insurer` lists it, so the insurer node's signature or the operator's bearer opens it. Records `MemberApproval` (idempotent for the same binding; 409 for a different plan, group or family; since B8 (A-34) a `familyIdHash` that is not a decimal string is 400). Posted by the insurer's `/enrollment/complete`.

`POST /interactive/register-member {walletId, ownershipProofJson, displayName, relationship?, publicKeyHex?}` (since B8, A-34: `familyId` or `employeeId` in the body is 400) — open, but it provisions nothing unless the engine holds an approval for the wallet (403 "no insurer approval") and the sequencer's lifecycle tree shows the wallet REGISTERED by the member's own proof (409 "not registered on the ledger yet"); the ownership proof (`ProofGate.verifyMember`, made on the device) must name the wallet and verify. A body carrying `preimageFields` is refused with 400 (B2). `groupId`/`planId` in the body are ignored: the member is bound from the approval through `bindPlan`. The credential mint is queued as the member's first pending wallet update.

## The device proves its wallet updates (B1 step two with B2, 2026-10-18)

`GET /interactive/wallet-updates?walletId=` — wallet-signed (only the named wallet's signature opens it). Returns `{pending: PendingWalletUpdate[], applied: […last 20]}`, oldest first: each pending update carries the credential's fields, the forest's non-empty leaves, the slot, the root to start from and the root to reach (`src/credentials/wallet-update.ts`).

`POST /interactive/wallet-update-applied {walletId, updateId, receiptId}` — wallet-signed. The engine checks the receipt is the wallet's and that the ledger now holds the update's root, then marks it applied and advances the member's nonce and root; an older update still pending is 409.
