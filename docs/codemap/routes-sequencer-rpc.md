# Code map — Sequencer RPC surface and clients

Scope: `src/l2/l2-rpc-server.ts` (2779 lines), `src/l2/l2-client.ts` (706), `src/nodes/start-explorer.ts` (220), `src/nodes/proof-delegate.ts` (410), `src/nodes/start-prover.ts` (107). Working tree as of 2026-10-16 (uncommitted "registry fix" included). Every citation is `file:line` read in this session. `GAP:` marks a plain mismatch with owner rules I1–I7; nothing else is judged.

Abbreviations: RPC = `src/l2/l2-rpc-server.ts`; CLI = `src/l2/l2-client.ts`; SEQ = `src/l2/l2-sequencer-service.ts`; NODE = `src/l2/l2-node.ts`; LEV = `src/nodes/start-leviathan.ts`; EXP = `src/nodes/start-explorer.ts`; PD = `src/nodes/proof-delegate.ts`.

## 1. Transport and auth model (L2RpcServer)

### 1.1 Bind, TLS, options
| Item | Fact | Source |
|---|---|---|
| Options | `L2RpcServerOptions`: port, host, maxBodyBytes, enableSSE, adminToken, adminKeys, unsecureMode, allowedOrigins, maxSseConnections, proofRateLimitPerMinute, tlsCert, tlsKey, dashboardDir | RPC:119-147 |
| Defaults | port 3030, host `127.0.0.1`, maxBodyBytes 20 MB (doc comment at 125 still says 10 MB), enableSSE true | RPC:149-154 |
| Live config (sequencer :3030) | host default `0.0.0.0` (`ZKTRIDENT_HOST`); unsecureMode = `ZKTRIDENT_UNSECURE==='true'`; adminToken = unsecure ? (`ZKTRIDENT_ADMIN_TOKEN` ?? `'admin123'`) : `ZKTRIDENT_ADMIN_TOKEN`; allowedOrigins = `ZKTRIDENT_CORS_ORIGINS` split, else unsecure ? `['*']` : `['http://localhost','http://127.0.0.1']`; dashboardDir = `dashboard-leviathan/` if it has index.html; no adminKeys, no TLS passed. **Changed by A2 (2026-10-17):** host defaults to `127.0.0.1`; allowedOrigins comes from `resolveAllowedOrigins` (local dashboard origins with ports), `*` honoured only in unsecure mode and only when asked for; TLS now passed from `ZKTRIDENT_TLS_CERT`/`_KEY` | LEV:72,80-81,87-90,115-127,270 |
| Live config (replicas :3031/:3032) | `{port, host, enableSSE:false, allowedOrigins}` — no adminToken, so the operator's token opens nothing on a replica; the leader's key is registered under the `sequencer` role (gossip only) and the sibling replicas' under `replica`; the server is wired to the replica's peer network (A13) | start-leviathan.ts, replica loop |
| HTTP vs HTTPS | https only when both tlsCert and tlsKey set; else plain http | RPC:281-288 |
| Unhandled error | `handleRequest().catch` → 500 `Internal Server Error` | RPC:271-277 |
| Request timeout | 30 s timer on every non-SSE request (`/events`, `/viz/events`, `/interactive/console` exempt by prefix); writes 504 JSON if not yet ended; does not abort the handler | RPC:410-418 |
| Dynamic routes | `registerRoute(method, path, handler, {adminOnly, walletSigned, providerSigned, timeoutMs})` keyed `METHOD:PATH`; adminOnly routes gated by `checkAdminAuth` (since A9 `authorizeRoute`). A walletSigned route (B2) takes only the signature of the wallet it names. A providerSigned route (since 2026-10-19; the type is 'prescriber' or 'pharmacy') takes the operator's bearer, a node key whose role allows the route (the ordinary route gate), or the signature of a wallet registered in the entity directory as that provider type, verified against that wallet's own signing key over method, path and body (30 s window, replay cache); a registered wallet of another type gets 403 (`authorizeProviderRoute`). Each gate keeps who it admitted, and a handler reads it with `principalOf(req)` (null for an ungated route), never from the body | RPC:386-399,498-508; RPC `registerRoute`, `authorizeProviderRoute`, `principalOf` |
| Engine hooks | `setEntityProofPoolStatus`, `setPeerNetwork`, `setVkCommitment`, `getAdminRegistryState`/`restoreAdminRegistryState` (admin registry persisted via node checkpoint) | RPC:201-203,292-296,401-403,2731-2733,2688-2726; LEV:274-276,402,420 |

### 1.2 CORS and response headers
| Item | Fact | Source |
|---|---|---|
| Policy | `allowed = options.allowedOrigins ?? ['http://localhost','http://127.0.0.1']`; ACAO = `'*'` if list contains `'*'`, else the request Origin if listed verbatim, else `'null'`. Default entries carry no port, so an Origin like `http://localhost:4001` is not matched | RPC:422-425 |
| Headers on every response | `Access-Control-Allow-Methods: GET, POST, OPTIONS`; `Access-Control-Allow-Headers: Content-Type, Authorization, X-Admin-Signature`; CSP (`default-src 'self'… connect-src 'self' http://localhost:* http://127.0.0.1:*`); `X-Content-Type-Options: nosniff`; `X-Frame-Options: DENY`; `OPTIONS` → 204 | RPC:426-436 |
| Exception | `GET /viz/history` passes `'Access-Control-Allow-Origin': '*'` in `writeHead`, overriding the policy header for that endpoint only | RPC:2454-2458 |
| Which endpoints get which | All `/rpc`, `/health`, `/events`, `/viz/*` (except `/viz/history`), dynamic routes, static files: policy at 423. `/viz/history`: always `*` | RPC:423,2457 |

### 1.3 Rate limiter
| Item | Fact | Source |
|---|---|---|
| Scope | Only `l2_submitProof` | RPC:718-723 |
| Key | `req.socket.remoteAddress` (no X-Forwarded-For) — all explorer-proxied traffic shares one bucket | RPC:719; EXP:82-86 |
| Limit | `proofRateLimitPerMinute ?? 60` per sliding 60 s window; `<=0` disables | RPC:2742-2754 |
| Sweep | every 300 s drops IPs with no hits in the last 60 s; map cleared on `stop()` | RPC:305-316,341-345 |
| Rejection | JSON-RPC error `-32602 'Rate limit exceeded'` (HTTP 200) | RPC:721 |

### 1.4 ADMIN_METHODS (18)
`l2_forceBatch, l2_storeFormulary, l2_storePlan, l2_deletePlan, l2_registerEntity, l2_credentialProvider, l2_updateProviderStatus, l2_requestSnapshot, l2_gossipRelay, l2_getPendingAdmissions, l2_getAdminKeys, l2_publishPlanOverlay, l2_revokeAdminKey, l2_approveAdmission, l2_registerEmployer, l2_revokeEmployerAttestation, l2_registerEmployerNode, l2_deregisterEmployerNode` — RPC:207-225. Plus conditional: `l2_registerAdminKey` needs auth only once `adminKeyRegistry.size > 0` (RPC:691-692).

### 1.5 Admin auth gate (`handleRpc`)
| Step | Fact | Source |
|---|---|---|
| needsAuth | `ADMIN_METHODS.has(method) || (method==='l2_registerAdminKey' && an operator key exists)`; node keys registered for this boot do not count as operator keys (A9) | RPC `handleRpc` |
| Principals (A9) | `authorize(req, scope, body)`: a Bearer header is compared to the operator token (constant time) and nothing else; otherwise the signer named in `X-Admin-Signature` is looked up in the registry and the request verified with `src/security/signed-request.ts` (method, path, body hash recomputed, 30 s, replay cache), then `roleMayCall(role, scope)`. Bearer and signature are alternatives, not modes. | RPC `authorize` |
| Bearer | no `adminToken` configured → `-32003 'Unauthorized — no admin token configured'` (default-deny); wrong token `-32003`; the token is the network operator's and is held by no node | RPC `authorize` |
| Signature | one wire format for RPC and routes: `X-Admin-Signature: <nodeId>:<ts>:<sigHex>` + `X-Content-Hash` over `${METHOD}:${path}|${ts}|${sha256(body)}`; for RPC the path is `/rpc` and the body the JSON-RPC envelope. Unknown signer, expired, tampered body, replayed → `-32003`; valid key with a role that does not list the method → `-32004 RPC_FORBIDDEN`. Roles: `src/security/node-roles.ts`. | RPC `authorize`; `signed-request.ts` |
| Post-verify | for a node principal `params._verifiedNodeId = nodeId` and `console.log('[admin] <method> by <nodeId> (<role>)')`; a bearer principal injects nothing | RPC `handleRpc` |
| Non-RPC admin routes | `authorizeRoute(req, pathname)`: same `authorize`, scope `{route, METHOD, path}`; for a signed request the body is read at the gate (`request-body.ts`) so the signature covers it and the handler reads the same bytes. The constant-message variant is gone. | RPC `authorizeRoute`, `denyRoute` |
| Key registry | `adminKeyRegistry` Map(nodeId→`AdminKeyEntry` {publicKeyHex, admittedBy, reason, timestamp, role?, ephemeral?}); operator keys (genesis, admitted) have no role or `operator`; node keys come from `registerNodeKey(nodeId, publicKeyHex, role)` (launcher, in-process, before each spawn), are `ephemeral` and are excluded from `getAdminRegistryState`; `pendingAdmissions`; blacklists as before | RPC registry |
| Genesis | `l2_registerAdminKey` while registry empty: secure mode requires env `ZKTRIDENT_GENESIS_ADMIN_KEY` and the key must equal it; unsecure mode accepts any 64-hex key (GAP I7: unauthenticated first-admin registration in unsecure mode); post-genesis unsecure = direct registration; post-genesis secure = must use admission | RPC:820-866 |
| Admission | `l2_requestAdmission` OPEN (cap 100 pending, 24 h TTL, blacklist check) → `l2_approveAdmission` ADMIN records approver `_verifiedNodeId ?? 'admin'` (in Bearer mode every approval is the same `'admin'` key), prunes approvals from revoked admins, admits at threshold `n<=1 ? 1 : floor(2n/3)+1` | RPC:868-992,2681-2685 |
| Callers | No file outside RPC references `ZKTRIDENT_GENESIS_ADMIN_KEY`, `l2_registerAdminKey`, `l2_requestAdmission`, or `l2_approveAdmission` (grep over src, scripts, visualizer, dashboards, docs) | — |

### 1.6 Body, parsing, errors
| Item | Fact | Source |
|---|---|---|
| Body limit | `readBody` enforces `maxBodyBytes` (20 MB) for `/rpc` and `/viz/emit`; destroys socket on overflow; the overflow message is echoed to the client as `-32700` | RPC:667-672,2757-2777 |
| Parse | `l2Parse` (BigInt-safe); invalid → `-32700 'Invalid JSON'`; structural check `jsonrpc==='2.0' && method && id!==undefined` → `-32600` | RPC:675-686 |
| Error classes | substring routing: `not found`/`Unknown method`→-32601; `verification failed`/`mismatch`/`REJECTED`→-32001; `not running`→-32002; `Missing or invalid`/`not configured`/`Duplicate proof`/`Wrong partition`/`Not leader`/`Not a leviathan`/`already registered`/`registry full`/`unavailable`/`not known`→-32602; else `console.error(err)` + `-32603 'Internal error'` | RPC:729-745 |
| Leak/quirk notes | `l2_syncWalletState` returns the raw sequencer error string inside a success result (RPC:811-814); `Drug not found: <ndcHash>` is classified as method-not-found (RPC:732-733,1460); thrown messages echo caller-supplied ids (employerId, nodeId); all RPC responses are HTTP 200 (RPC:2366-2381) | — |

### 1.7 SSE streams
| Stream | Auth | Behaviour | Payload | Source |
|---|---|---|---|---|
| `GET /events` | D2: a node key (member, prescriber, pharmacy, insurer; not the employer, I6), the operator's bearer, or `?token=` for a browser; 401 otherwise | 404 if `enableSSE` false; 503 at `maxSseConnections` (100); sends `{type:'connected',timestamp}`; `?lastEventId=N` replays ring buffer (256) entries with id>N; frames `id: N\ndata: <L2ChainEvent>` | `L2ChainEvent {type, timestamp, data}`; types: node:started/stopped/tick, proof:accepted, proof:rejected, batch:building/built/empty/settling/settled/failed/rejected, audit:event, formulary:updated, plan:updated/deleted, network:updated, pool:worker:* (8), leader:promoted/demoted, employer:registered/revoked/node-registered/node-deregistered, node:error. `proof:accepted.data` = {receiptId, walletId,…}; messaging `audit:event.data` = {type:'messaging', senderWalletId, messagingRootBefore/After, chainHash, sequenceNumber} | RPC:230,595-660; NODE:143-182,500-504,629-640 |
| `GET /viz/events` | D2: the operator (bearer or `?token=`) or the plan's node key; 401/403 otherwise | 503 at 100 clients; sends only the connected ack (no replay); frames `data: <VizEvent>` | `VizEvent {type, timestamp, id, actor, actorType, actorWalletId?, target?, targetType?, targetWalletId?, data, lane, stage, totalStages}` | RPC:87-101,2426-2451,2525-2535 |
| Viz buffer | 10 000 events, FIFO; written by `POST /viz/emit` and by `emitVizEvent` from `l2_storeMessage`, `l2_registerEntity`, `l2_credentialProvider`, `l2_updateProviderStatus` | — | RPC:2405-2418,2541-2567 |

### 1.8 Auth-class counts
94 `case 'l2_…'` handlers (grep -c; no non-`l2_` cases). ADMIN 17 · RATE-only 1 (`l2_submitProof`) · conditional 1 (`l2_registerAdminKey`) · OPEN 75 (74 functional; `l2_syncFromL1` always throws). Dispatch switch RPC:750-2357.

## 2. RPC method table

Auth: ADMIN = in ADMIN_METHODS; OPEN = no check; RATE = per-IP limit only; COND = see 1.5. "Member" = returns wallet-linked data (which). Lines are RPC.

### Proof submission / wallet sync
| Method | Auth | Params | Reads/writes | Member | Line |
|---|---|---|---|---|---|
| l2_submitProof | RATE (proof verified in `node.submitProof`) | proofJson, newCredentialInventoryRoot? (`entityMetadata` refused, RPC-04) | `StateTransitionProof.fromJSON` → `node.submitProof(proof, meta)`; only `newCredentialInventoryRoot` (decimal string) is forwarded as metadata, plus the claim the engine committed for that wallet and root (`pendingClaimFor`, B2), cleared once the proof is accepted; if result `isRegistration`, unverified `entityMetadata{displayName,type,specialty,pharmacyType,group}` is written to `entityRegistry` | yes: L2Receipt (walletId, roots, claimLeafIndex) | 755-790 |
| l2_syncWalletState | OPEN (verify-only) | walletId, newCredentialInventoryRoot, newNonce | `seq.syncWalletState`: refuses unless wallet registered and state reproduces current registry root; else no-op/update; errors returned as `{synced:false,error}` | no | 792-818; SEQ:1963-1975 No caller since B1 step two, commit three; remove with the fixtures (F). |

### Admin keys / admission
| Method | Auth | Params | Reads/writes | Member | Line |
|---|---|---|---|---|---|
| l2_registerAdminKey | COND (OPEN at genesis; GAP I7 in unsecure mode) | nodeId, publicKeyHex(64 hex), reason, admittedBy? | writes `adminKeyRegistry` (genesis or unsecure direct); secure post-genesis throws | no | 820-866 |
| l2_requestAdmission | OPEN (GAP I7: unauthenticated write) | nodeId, publicKeyHex | writes `pendingAdmissions` (cap 100, 24 h TTL); blacklist check | no | 868-916 |
| l2_approveAdmission | ADMIN | nodeId, reason | records approval by `_verifiedNodeId ?? 'admin'`; admits at BFT threshold → `adminKeyRegistry` | no | 918-992 |
| l2_getPendingAdmissions | ADMIN (D2) | — | reads `pendingAdmissions` (incl. publicKeyHex, approvals) | no | 994-1008 |
| l2_getAdminKeys | ADMIN (D2) | — | reads `adminKeyRegistry` (publicKeyHex, admittedBy, reason, timestamp) | no | 1010-1016 |
| l2_revokeAdminKey | ADMIN | nodeId, reason, blacklist? | deletes key + pending; optional blacklist of nodeId and pubkey | no | 1018-1038 |

### Status / health / chain
| Method | Auth | Params | Reads/writes | Member | Line |
|---|---|---|---|---|---|
| l2_getStatus | OPEN | — | `node.getStatus()` + `vkCommitment` | no | 1040-1043 |
| l2_getHealth | OPEN | — | process memory, proving pool + worker statuses, entity proof pool | no | 1045-1067 |
| l2_getReceipt | D1: the receipt’s wallet, the plan or operator; an unknown id stays open and answers null | receiptId | receipt lookup (Leviathan: all partitions) | yes: L2Receipt.walletId | 1069-1079 |
| l2_getBlock | OPEN | blockNumber | block lookup | no (receiptIds only) | 1081-1091 |
| l2_getBatch | OPEN | batchNumber | batch lookup | no | 1093-1103 |
| l2_forceBatch | ADMIN | partitionIndex? | `node.forceBatch()` | no | 1105-1112 |
| l2_getChainState | OPEN | — | roots, walletCount, globalStateRoot, blockHeight, auditChainHash, pending count, latest batch | no | 1171-1187 |
| l2_getReceiptsByWallet | D1: the wallet itself, the plan or operator, its named PCP, or a signed caller with the member’s attestation | walletId | `getReceiptsByWallet` | yes: receipts for wallet | 1189-1199; SEQ:2043 |
| l2_getAllReceipts | D1: the plan or the operator only | limit?(≤1000), offset? | all receipts, paginated | yes: every receipt walletId | 1201-1209 |
| l2_getAllBatches | OPEN | limit?, offset? | all batches | no | 1211-1219 |
| l2_getChainProof | OPEN | — | latest ChainProof JSON + globalStateRoot + blockHeight | no | 1221-1229 |
| l2_getPartitionInfo | OPEN | — | partition config/router, l2Only | no | 2272-2281 |

### Audit
| Method | Auth | Params | Reads/writes | Member | Line |
|---|---|---|---|---|---|
| l2_getAuditLog | D1: the plan or the operator only | limit?(≤1000), offset? | audit log, events paginated | yes: AuditEvent.walletId (`src/audit/audit-types.ts:37-43`) | 1114-1125 |
| l2_verifyChainIntegrity | OPEN | — | `AuditService.verifyReceiptChain` | no | 1127-1139 |
| l2_verifyFinancialBalance | D1 enumeration: the plan and the operator (A-102) | — | `AuditService.verifyFinancialBalance` totals; D5: fills counted, reversals netted, every fill's split checked against its costs, and the chain's totals reconciled with the ledger's (`reconciled`, `ledger`); `valid` only when both hold | no (aggregates) | 1141-1157 |
| l2_detectDuplicateClaims | D1 enumeration: the plan and the operator (A-102) | — | `AuditService.detectDuplicateClaims` → duplicateGroups; D5: fills only, keyed with the fill number | audit-derived groups (fields not verified here) | 1159-1169 |

### Formulary / plans / coverage
| Method | Auth | Params | Reads/writes | Member | Line |
|---|---|---|---|---|---|
| l2_getFormulary | OPEN | planIdHash | published formulary blob for plan | no | 1231-1237 |
| l2_storeFormulary | ADMIN | planIdHash, formularyRoot, entriesJson | `storeFormularyWithGossip` + emit `formulary:updated` | no | 1239-1264 |
| l2_storePlan | ADMIN | plan{planId,name,…} | `planStoreError` refuses a malformed copay, drug list, provider list or fee, or incomplete published terms (-32602; the six live limit fields are not checked, open); then `node.storePlan` + emit `plan:updated` | no | 1459-1471 |
| l2_getPlan | OPEN | planId | plan config | no | 1276-1280 |
| l2_getPlans | OPEN | — | all plans as stored, drafts included; readers that bill or offer a plan take `planAsPublished` | no | 1479-1481 |
| l2_getPlanLimits | OPEN | planId | the plan as published (`planAsPublished`; a draft is not shown, a plan never published with terms is shown as stored): name, coverage type, copay, deductible, OOP max, annual benefit max, the three family limits, and the dispensing fee with its source (`dispensingFeeOf`) | no | 1483-1505 |
| l2_deletePlan | ADMIN | planId | `node.deletePlan` + emit `plan:deleted` | no | 1305-1315 |
| l2_getFormularyCategories | OPEN | — | formulary service categories | no | 1444-1446 |
| l2_getFormularyPage | OPEN | filter?, offset?, limit?(≤500, default 100) | paginated drug page | no | 1448-1453 |
| l2_getDrugDetail | OPEN | ndcHash | drug record | no | 1455-1461 |
| l2_checkCoverage | OPEN | planIdHash, ndcHash | plan coverage for drug | no | 1463-1471 |
| l2_estimateCost | D1 when walletId is given: the wallet, the plan or operator, or the member’s attestation; without walletId open. Since 2026-10-19 also a prescriber the engine's consent record admits (reader `prescriber`: the member's current PCP or a live B5 grant, ACTIVE prescribers only, asked through `mayPrescribe`), and not `pcp`. Through a node's `/rpc` proxy a call with a walletId needed that node's admin credential (A-49); since 2026-10-19 only the member node and the explorer forward the method (`PROXY_QUOTE`) | ndcHash, quantity? (30; thousandths of the drug's NADAC pricing unit, else -32602 from `quantityError`), walletId? or planId? (a planId sent with a walletId is not used; fee and limit params are not used) | with walletId: the engine's quote through `setMemberCostQuoteProvider` → `AdjudicationService.quoteMemberCost` (the member's plan as published; `quoteFill` + `priceDispense`; `splitClaimCost` over the accumulator the next fill is proven against and the family's inputs); no engine beside the sequencer (a replica) or an unenrolled wallet → -32602. Without: a planId's published list, copay and fee (`publishedListCovers`), copay phase; a plan never published is not covered; no plan → tier copay and network default fee. Answers drug, nadacPerUnit, pricingUnit, quantity, ingredient, fee and its source, total, copay and `copayBasis`, `phase`, member and employer pay; a drug off the plan answers `covered: false`, phase `not-covered`, with a reason that names no plan. Since 2026-10-19 a member's quote adds `priorAuthRequired`, `stepTherapyRequired`, `maxQuantityPerFill` (pricing unit) and, for a PA drug, `priorAuth` {status none, pending, approved or denied; requestedAt, resolvedAt, expiresOn} | yes: the member's share and phase, the drug's availability and her own PA status; no balances, no request ID | 1690-1779 |
| l2_publishPlanOverlay | ADMIN | planIdHash, planName?, overrides?, defaults | `formularyService.publishOverlay` + emit | no | 1578-1593 |
| l2_getFormularyRoutes | OPEN | — | routes list | no | 1595-1597 |
| l2_getFormularyDrugCount | OPEN | — | count | no | 1599-1601 |
| l2_getFormularyRoot | OPEN | — | Merkle root + count | no | 1603-1606 |
| l2_getFormularyWitness | OPEN | ndcHash | witness path/isLeft + leafIndex + drug summary | no | 1608-1627 |
| l2_syncFromL1 | OPEN (always throws: L2-only) | — | none | no | 1629-1632 |

### Employer attestation / employer nodes
| Method | Auth | Params | Reads/writes | Member | Line |
|---|---|---|---|---|---|
| l2_registerEmployer | ADMIN | attestation (EmployerAttestation v2) | requires `v===2`, integer `attestationSeq` (first =0, then existing+1); `verifyEmployerSignature(att)` (key = `att.publicKeyHex`) and `verifyInsurerSignature(att)` (key = `att.insurerPublicKeyHex`, i.e. taken from the submitted attestation, not a configured insurer key); `storeEmployerAttestation`; emit `employer:registered` | no (stores signerName/signerTitle of the signing officer) | 1317-1349; `src/onboarding/employer-attestation.ts:142-147`; `src/l2/l2-types.ts:432-456` |
| l2_getEmployerAttestation | OPEN | employerId | attestation incl. publicKeyHex, insurerPublicKeyHex, signerName | no | 1351-1355 |
| l2_getEmployerAttestations | OPEN | — | all attestations | no | 1357-1359 |
| l2_revokeEmployerAttestation | ADMIN | employerId | deletes via private `(seq as any).employerAttestationStore`; emit `employer:revoked` | no | 1361-1370 |
| l2_verifyEmployer | OPEN | employerId | re-verifies both signatures against keys inside the stored attestation | no | 1372-1383 |
| l2_registerEmployerNode | ADMIN | employerId, employerNodeUrl, hrToolUrl, pid, adminTokenFingerprint? | requires existing attestation; `seq.registerEmployerNode`; emit | no | 1385-1410 |
| l2_getEmployerNode | OPEN | employerId | node record (urls, pid, fingerprint) | no | 1412-1416 |
| l2_listEmployerNodes | OPEN | — | all employer node records | no | 1418-1420 |
| l2_deregisterEmployerNode | ADMIN | employerId | `deregisterEmployerNode`; emit | no | 1422-1430 |

### Claims (accumulator) / fills
| Method | Auth | Params | Reads/writes | Member | Line |
|---|---|---|---|---|---|
| l2_getClaimsByMember | D1: the wallet itself, the plan or operator, its named PCP, or a signed caller with the member’s attestation | walletId | `node.getClaimsByMember` | yes: ClaimLeaf (member/pharmacy/prescriber wallet IDs, ndcHash, dateOfService, pay cents) + metadata (ndc, brandName, daysSupply, costs, planIdHash) | 1636-1642; `claim-accumulator-types.ts:47-66,147-156` |
| l2_getClaimsByPharmacy | D1: that pharmacy’s wallet, the plan or operator | walletId | by pharmacy index | yes: same leaves | 1644-1650 |
| l2_getClaimsByPrescriber | D1: that prescriber’s wallet, the plan or operator | walletId | by prescriber index | yes | 1652-1658 |
| l2_getClaimsByNdc | D1: the plan or the operator only | ndcHash | by NDC index | yes: all members on a drug | 1660-1666 |
| l2_getClaimWithProof | D1: the leaf’s member, pharmacy or prescriber wallet, the plan or operator; an unknown leaf stays open | leafIndex | entry + Merkle witness + root | yes | 1668-1675 |
| l2_getClaimAccumulatorRoot | OPEN | — | root + leafCount | no | 1677-1682 |
| l2_recordFill | ADMIN | memberWalletId, ndcHash, pharmacyWalletId, prescriberWalletId?, dateOfService?, patientPayCents?, planPayCents?, operationType?, deductibleCreditCents?, ndc?, brandName?, daysSupply?, fillNumber?, ingredientCostCents?, dispensingFeeCents?, quantityDispensed?, planIdHash? | `seq.recordFill(leaf, metadata)` appends a ClaimLeaf without any proof; duplicate detected by unchanged leaf count; emits `viz:pharmacy:dispensed` with memberWalletId/ndcHash | yes (writes) | 1684-1727; SEQ:2140 |

### Witnesses / wallet state
| Method | Auth | Params | Reads/writes | Member | Line |
|---|---|---|---|---|---|
| l2_getRegistrationWitnesses | OPEN | holder? | next-slot registry/lifecycle witnesses + roots; D7: with `holder`, only when that caller is the one prover in line, else `{busy, position, retryAfterMs, expiresAt}` | no | l2-rpc-server.ts; SEQ getRegistrationWitnesses |
| l2_getWalletWitnesses | D1: the wallet itself, the plan or operator, or a signed caller with the member’s attestation | walletId (or params[0]) | witnesses, slotIndex, currentLifecycleState for the wallet | yes: wallet slot + lifecycle state | 1733-1737; SEQ:1917 D7: `holder` as for the registration witnesses. |
| l2_getProvingLease | OPEN | — | `{held, queueLength, expiresInMs}` — no holder id (holders are wallets) | no | l2-rpc-server.ts |
| l2_getWalletState | D1: the wallet itself, the plan or operator, or a signed caller with the member’s attestation | walletId (or params[0]) | credentialInventoryRoot + nonce | yes | 1739-1743; SEQ:1944 |

### Messages
| Method | Auth | Params | Reads/writes | Member | Line |
|---|---|---|---|---|---|
| l2_getMessagesByWallet | D1: the wallet itself, the plan or operator | walletId | union index | yes: sender/recipient wallet IDs, type, threadIdHash, ciphertext/iv/tag | 1747-1753; `message-store-types.ts:52-63,109-118` |
| l2_getMessagesBySender | D1: the wallet itself, the plan or operator | walletId | sender index | yes | 1755-1761 |
| l2_getMessagesByRecipient | D1: the wallet itself, the plan or operator | walletId | recipient index | yes | 1763-1769 |
| l2_getMessagesByThread | D1: any signed caller; a wallet gets only its own messages | threadIdHash | thread index | yes | 1771-1777 |
| l2_getMessageStoreRoot | OPEN | — | root + count | no | 1779-1784 |
| l2_storeMessage | WALLET-SIGNED (A10b: only a request signed by `message.senderWalletId` with its registered key; see `authorizeWallet`) | message{messageCommitment, senderWalletId, recipientWalletId, messageType, threadIdHash}, payload{ciphertext, iv, tag, timestamp?, receiptId?} | maps type names→codes; `node.storeMessage` appends to message store under any claimed sender; emits `viz:message:sent` | yes (writes) | 1786-1841; NODE:653 |

### Entities / providers
| Method | Auth | Params | Reads/writes | Member | Line |
|---|---|---|---|---|---|
| l2_registerEntity | ADMIN | walletId, displayName, type, specialty?, pharmacyType?, group?, encryptionPublicKeyHex?, npi? | refuses (A-74) a wallet ID not in canonical decimal, a name, specialty, pharmacy type or group that is not a short line of plain text, a kind outside `ENTITY_KINDS`, an encryption key that is not 64 hex, and an NPI that is not ten digits with the NPI check digit (`npiError`); writes `entityRegistry`; if prescriber/pharmacy also `seq.credentialProvider` ACTIVE (duplicates ignored); `node.registerKnownWallet` (attestation eligibility); emits `viz:enrollment:started` with walletId | yes (writes wallet→displayName) | 1843-1902 |
| l2_getEntity | D1: a member’s entry answers the wallet, the plan or operator, its named PCP or the member’s attestation; a provider’s entry is public | walletId | `entityRegistry` → displayName, type, group, specialty, pharmacyType | yes: wallet→display identity (member entries included) | 1904-1917 |
| l2_getEncryptionKey | D1: any signed caller | walletId | `entityRegistry[walletId].encryptionPublicKeyHex` | yes: wallet's X25519 key | 1434-1440 |
| l2_credentialProvider | ADMIN | walletId, displayName, providerType, npi?, specialty?, pharmacyType?, deaNumber?, stateOfLicense?, verificationMethod?, initialState?, credentialedByHash?, applicationId? | refuses (A-74, A-89) a wallet ID not in canonical decimal, an NPI that is not ten digits with the NPI check digit (`npiError`), and a name, specialty, pharmacy type, DEA number or state of license that is not a short line of plain text; `seq.credentialProvider` (npiHash = hash(npi) or walletId); mirrors into `entityRegistry`; emits `viz:credential:generated` incl. npi | provider only | 1921-1981; SEQ:2275 |
| l2_updateProviderStatus | ADMIN | walletId, newState(0-4) | `seq.updateProviderStatus`; emits lifecycle viz | provider only | 1983-2010; SEQ:2280 |
| l2_getProvider | OPEN | walletId | provider leaf+metadata (npi, state) | provider only | 2012-2029 |
| l2_getProviderByNpi | OPEN | npiHash | provider by NPI hash | provider only | 2031-2045 |
| l2_getProviderRegistryRoot | OPEN | — | root + count | no | 2047-2052 |
| l2_getProviderWithProof | OPEN | walletId | provider + witnessJson + root | provider only | 2054-2070; SEQ:2329 |
| l2_getNetworkProviders | OPEN | role? | ACTIVE providers from registry (walletId, npi, specialty, stateOfLicense…); falls back to `entityRegistry` prescriber/pharmacy entries | provider only | 2072-2115 |

### PCP
| Method | Auth | Params | Reads/writes | Member | Line |
|---|---|---|---|---|---|
| l2_registerPcpAssignment | WALLET-SIGNED (A10b: only a request signed by `memberWalletId`) | memberWalletId, prescriberWalletId, effectiveDate? | appends to in-memory `pcpAssignments[prescriber]` unless memberWalletId already present (dedupe per prescriber); nothing removes a link or checks the provider's status, and the D1 `pcp` reader reads these links, so a former or suspended PCP still passes it (A-59, open) | yes (writes member→prescriber link) | 2117-2131; map at 239 |
| l2_getPcpAssignments | D1: that prescriber’s wallet, the plan or operator | prescriberWalletId | list of {memberWalletId, effectiveDate, timestamp} | yes | 2133-2141 |

### Accumulator / attestation
| Method | Auth | Params | Reads/writes | Member | Line |
|---|---|---|---|---|---|
| l2_reconstructAccumulator | D1: the wallet itself, the plan or operator, its named PCP, or a signed caller with the member’s attestation | walletId, planIdHash? | `seq.reconstructAccumulator` sums claim leaves | yes: deductiblePaid/oopPaid/benefitUsed cents, claim counts | 2143-2151; SEQ:2167 |
| l2_requestAttestation | WALLET-SIGNED (A10b: only a request signed by `walletId`; lifecycle from `lifecycleStateOf`, revoked refused, unregistered null) | walletId, expirySeconds? | if wallet in `entityRegistry` → `registerKnownWallet`; `node.requestAttestation` signs {w, cc, ls=3, fr, ts, exp, n, pk, sig} when wallet has receipts/provider/messages/known flag, and writes `attestationCache[walletId]` | yes: signed attestation for wallet | 2155-2174; NODE:356-381; `src/credentials/nfc-attestation.ts:55-78` |
| l2_getAttestation | WALLET-SIGNED: the wallet itself only (A10b gate, A-96) | walletId | reads `attestationCache` | yes | 2176-2189; NODE:383-385 |
| l2_getAttestationPublicKey | OPEN | — | authority Ed25519 pubkey | no | 2191-2198 |

### Peers / gossip
| Method | Auth | Params | Reads/writes | Member | Line |
|---|---|---|---|---|---|
| l2_gossipRelay | ADMIN (roles `sequencer` on a replica, `replica` on the leader — A13) | message{messageId,type,…}, fromPeerId? | `peerNetwork.handleIncomingAndRelay` | depends on gossip payload | 2202-2216 |
| l2_getPeerInfo | OPEN | — | PeerInfo (nodeId, role, latest seq/batch, vkCommitment) | no | 2218-2238 |
| l2_getPeerList | OPEN | — | peers as {nodeId,id,url,role,status,lastSeen} | no | 2240-2252 |
| l2_requestSnapshot | ADMIN (role `replica` may, since A13) | — | `seq.exportState()`: roots, counters, receipts, blocks, batches, auditLog, adminQueue, chain-proof state, audit index, claim accumulator (and further store states) | yes: entire member-linked state | 2254-2256; SEQ:2738-2775 |
| l2_getStateDigest | OPEN | — | seq/batch numbers, auditChainHash, claim root, registry/lifecycle roots, walletCount | no | 2258-2270 |

### Leviathan / quorum (throw `Not a leviathan node` on plain L2Node)
| Method | Auth | Params | Reads/writes | Member | Line |
|---|---|---|---|---|---|
| l2_getLeviathanStatus | OPEN | — | `leviathan.getStatus()` | no | 2285-2290 |
| l2_getPartitionLeaders | OPEN | — | leader map + active leader partitions | no | 2292-2304 |
| l2_getPartitionStatus | OPEN | partitionIndex | per-partition status | no | 2306-2317 |
| l2_getQuorumStatus | OPEN | — | quorum service status | no | 2319-2324 |
| l2_getStateCertificate | OPEN | partitionIndex | latest state certificate | no | 2326-2335 |
| l2_verifyStateCertificate | OPEN | certificate | `quorumSvc.verifyStateCertificate` | no | 2337-2353 |

## 3. Non-RPC HTTP endpoints on the sequencer server
| Method | Path | Auth | Checks | Returns/Writes | Source |
|---|---|---|---|---|---|
| OPTIONS | * | OPEN | — | 204 + CORS headers | RPC:432-436 |
| GET | /health | OPEN | — | ok, running, sseClients, memory MB, chain counters, provingPool/workers, entityProofPool/entityWorkers | RPC:441,548-592 |
| GET | /events | D2: credential (node key, bearer, or `?token=`) | enableSSE; ≤100 clients | L2ChainEvent stream with 256-event replay via `?lastEventId` | RPC:445,595-642 |
| POST | /rpc | per-method (see 1.5) | body ≤20 MB; JSON-RPC 2.0 shape | JSON-RPC result/error (always HTTP 200) | RPC:449,665-747 |
| POST | /viz/emit | ADMIN (`checkAdminAuth`) | body ≤20 MB; any JSON accepted as VizEvent; id/timestamp filled | pushes to viz buffer (10k) + broadcast | RPC:455-462,2387-2423 |
| GET | /viz/events | D2: operator or plan (bearer, `?token=`, or insurer node key) | ≤100 clients | VizEvent stream (no replay) | RPC:464,2426-2451 |
| GET | /viz/entities | ADMIN read (D1) | — | full `VizEntity[]` incl. walletId, displayName, type, group, encryptionPublicKeyHex | RPC:477,2502-2509 |
| GET | /viz/state | OPEN (GAP I7) | — | {events (whole buffer), entities, nodeRunning, client counts} | RPC:481,2512-2522 |
| GET | /viz/history | operator or plan (bearer or insurer node key). Was OPEN | — | whole viz buffer (the events /viz/state also returns) | RPC:582-586,2629-2636 |
| POST | /viz/clear | ADMIN | — | clears viz buffer, resets counter, **clears `entityRegistry`** | RPC:489-496,2463-2470 |
| any | registered `METHOD:PATH` (engine `/interactive/*` etc.) | ADMIN if registered with `adminOnly`; wallet-signed with `walletSigned` (B2); provider-signed with `providerSigned` (since 2026-10-19) | `authorizeRoute`, `authorizeWalletRoute` or `authorizeProviderRoute`; the admitted principal is kept for `principalOf` | handler-defined (mapped in the engine code map) | RPC:386-399,498-508 |
| GET | /<static> | OPEN | `dashboardDir` set; path matches `^[/a-zA-Z0-9._-]+$`, no `..`, resolved path startsWith dashboardDir; `/`→`index.html`; mime by extension | file bytes (dashboard-leviathan/) | RPC:512-540; LEV:115-116 |
| * | anything else | — | — | 404 `{error:'Not found'}` | RPC:542-543 |

## 4. L2Client (`src/l2/l2-client.ts`)

Transport: `rpcCall` POSTs `/rpc` with `id=Date.now()` (CLI:621-663); `httpRequest` uses `timeoutMs` (default 30 s) and rejects non-2xx as `HTTP <status>: <body>` (CLI:66-70,666-704). `maxRetries`/`retryBaseDelayMs` exist in options but `rpcCall` performs no retries; only SSE uses the base delay (CLI:56-62). Auth header on **every** request when configured: `X-Admin-Signature: <adminNodeId>:<ts>:<hex>` over `method|sha256(JSON.stringify(params ?? {}))|ts` if `adminPrivateKeyHex && adminNodeId` (CLI:635-647); else `Authorization: Bearer <adminToken>` (CLI:648-650); else none. SSE `connectEvents`: GET `/events`; non-200 → reconnect; parses only `data:` lines (ignores `id:` so never resends `lastEventId`); reconnect delay `min(retryBaseDelayMs·2^retryCount, 30 000)`, counter reset on success, unlimited until the returned disconnect() (CLI:545-619).

Callers = files in `src/nodes` matching `client.<method>(` (grep); "—" = none found. `src/adjudication` (the engine) does not import L2Client. Nautilus nodes build the client from `config.clientOptions` (`src/nodes/entity-node-base.ts:62-67,93-99`), which carries `{adminToken}` when the Nautilus config has one (`routes/member-routes.ts:351`, `routes/employer-routes.ts:64`, `routes/insurer-routes.ts:85`) → Bearer; no node passes `adminPrivateKeyHex`.

| Client method (CLI line) | RPC | Header | Callers (src/nodes) |
|---|---|---|---|
| submitProof(proof,{newCredentialInventoryRoot?}) (89) | l2_submitProof | as configured | member-node, pharmacy-node, prescriber-node |
| getStatus (98) | l2_getStatus | " | employer-node, entity-node-base |
| getReceipt (103) | l2_getReceipt | " | entity-node-base |
| getBlock (108) / getBatch (115) | l2_getBlock / l2_getBatch | " | — |
| getAuditLog (122) — no pagination params | l2_getAuditLog | " | insurer-node |
| forceBatch (127) | l2_forceBatch (ADMIN) | " | insurer-node |
| getChainState (134) | l2_getChainState | " | employer-node, entity-node-base |
| getReceiptsByWallet (139) | l2_getReceiptsByWallet | " | member/pharmacy/prescriber-node |
| getAllReceipts (144) / getAllBatches (149) | l2_getAllReceipts / l2_getAllBatches | " | insurer-node |
| getChainProof (154) | l2_getChainProof | " | insurer-node |
| getFormulary (159) | l2_getFormulary | " | member/pharmacy/prescriber-node |
| storeFormulary (169) | l2_storeFormulary (ADMIN) | " | insurer-node |
| storePlan (180) / getPlan (185) / getPlans (190) / deletePlan (195) | l2_storePlan (ADMIN) / l2_getPlan / l2_getPlans / l2_deletePlan (ADMIN) | " | insurer-node; getPlans also routes/employer-routes |
| getPlanLimits (200) | l2_getPlanLimits | " | — |
| estimateCost (231): its params are the ones the RPC reads (ndcHash, quantity, walletId, memberAttestation, planId) and its return type has every field the RPC answers, the availability fields and `priorAuth` included (closed 2026-10-19; the fee and limit params it ignored are gone) | l2_estimateCost | " | routes/prescriber-routes (ndcHash, quantity, and walletId signed as the prescriber's wallet, with the member's attestation when sent; or planId); insurer-node `estimateCost` (node key; walletId or planId) |
| getClaimsByMember (247) | l2_getClaimsByMember | " | insurer-node, member-node, pharmacy-node |
| getClaimsByPharmacy (252) / getClaimsByPrescriber (257) / getClaimsByNdc (262) | matching l2_* | " | insurer-node (+pharmacy-node / prescriber-node) |
| getClaimWithProof (267) | l2_getClaimWithProof | " | member-node, pharmacy-node |
| getClaimAccumulatorRoot (276) | l2_getClaimAccumulatorRoot | " | member-node |
| getRegistrationWitnesses (281) | l2_getRegistrationWitnesses | " | routes/member-, pharmacy-, prescriber-routes |
| getWalletWitnesses (292) / getWalletState (304) | l2_getWalletWitnesses / l2_getWalletState | " | routes/member-routes |
| reconstructAccumulator (318) | l2_reconstructAccumulator | " | — |
| registerPcpAssignment (333) | l2_registerPcpAssignment | " | routes/member-routes |
| getPcpAssignments (338) | l2_getPcpAssignments | " | — (prescriber-routes calls RPC directly) |
| ~~recordFill~~ | ~~l2_recordFill~~ removed in D2 (A-27): no no-proof claim path remains in the client, the node, the service or the server | — | — |
| getMessagesByWallet (372) | l2_getMessagesByWallet | " | entity-node-base, insurer-node |
| getMessagesBySender (377) / ByRecipient (382) / ByThread (387) | matching l2_* | " | employer-node, entity-node-base |
| getMessageStoreRoot (392) | l2_getMessageStoreRoot | " | entity-node-base |
| storeMessage (397) | l2_storeMessage | " | employer-node, entity-node-base |
| credentialProvider (407) / updateProviderStatus (423) | l2_credentialProvider / l2_updateProviderStatus (ADMIN) | " | — (insurer-routes uses raw RPC + Bearer) |
| getProvider (428) / getProviderRegistryRoot (441) / getProviderWithProof (446) | matching l2_* | " | — |
| gossipRelay (460) | l2_gossipRelay (ADMIN) | " | — |
| getPeerInfo (471) / getPeerList (476, typed `string[]` but server returns objects) / requestSnapshot (481, ADMIN) / getStateDigest (486) | matching l2_* | " | — |
| getPartitionInfo (491) | l2_getPartitionInfo | " | entity-node-base |
| getQuorumStatus (503) / getStateCertificate (515) / verifyStateCertificate (520) | matching l2_* | " | — |
| isHealthy (527) | GET /health | none | entity-node-base |
| connectEvents (545) | GET /events (SSE) | none | entity-node-base |

Raw (non-L2Client) RPC callers worth knowing (grep of `l2_*` literals): `routes/member-routes.ts` → l2_registerEntity (displayName `'Member'`/config displayName, 378-381,561), l2_syncWalletState (removed in B1 step two, commit three), with `Authorization: Bearer <config.adminToken>` when set (290-292); `routes/insurer-routes.ts` → l2_credentialProvider, l2_updateProviderStatus, l2_publishPlanOverlay, l2_getEntity, l2_getProvider, l2_listEmployerNodes (Bearer at 1090-1091,1220-1221,1253-1254); `routes/marketplace-routes.ts` → l2_registerEmployer, l2_revokeEmployerAttestation, l2_getPlan(s); `employer-orchestrator.ts` → l2_registerEmployerNode / l2_deregisterEmployerNode with `Bearer insurerAdminToken` (83,248,363,408); browsers: `dashboard-leviathan/rpc.js:22-41` and `explorer/rpc.js:22-35` POST `baseUrl+'/rpc'` and hold an admin token in a JS variable for admin calls (`dashboard-leviathan/app.js:1822,1856`); `dashboard-member/rpc.js:22-36,69` POSTs `location.origin+'/rpc'` with no auth header.

## 5. Explorer (:8000), proof delegate (:4040), start-prover

### Explorer — `src/nodes/start-explorer.ts`
| Method | Path | Auth | Behaviour | Source |
|---|---|---|---|---|
| OPTIONS | * | OPEN | 204 + CORS (`ZKTRIDENT_CORS_ORIGINS`, default `*`) — **A2: default is now the local dashboard origins, and an off-list origin gets no header** | EXP:41,56-62,69-73 |
| POST | /rpc | OPEN (strips caller headers) | forwards raw body to `<sequencer>/rpc` with only `Content-Type` → Authorization/X-Admin-Signature never reach the sequencer; no body cap on the proxy; all proxied `l2_submitProof` share the explorer's IP for the rate limiter; 502 on failure | EXP:76-95 |
| GET | /health | OPEN | proxied | EXP:98-109 |
| GET | /events | relays the page's token (header or `?token=`) and the upstream status (D2) | SSE pump from sequencer `/events` | EXP:112-143 |
| GET | /viz/* | relays the page's token (D1/D2) | `/viz/events` pumped as SSE with the upstream status relayed; any other `/viz/<x>?q` fetched and relayed with upstream status/content-type | EXP:146-186 |
| GET | /<static> | OPEN | files from `explorer/` (app.js, index.html, logo.png, rpc.js, style.css); regex + `..` guard; `path.join` without canonical-prefix check | EXP:43-44,188-201 |
| * | other | — | 404 text | EXP:203-204 |

Binds `127.0.0.1` since A2 (was `0.0.0.0`) on `ZKTRIDENT_EXPLORER_PORT` (8000); sequencer `ZKTRIDENT_SEQUENCER_URL` (http://localhost:3030) (EXP:39-40,207). Spawned by LEV:662 with those env vars. Explorer browser code calls read-only `l2_*` (status, chain, audit, claims, messages, receipts, reconstructAccumulator, peers, quorum) directly through this proxy (`explorer/rpc.js`).

### Proof delegate — `src/nodes/proof-delegate.ts`
| Method | Path | Auth | Behaviour | Source |
|---|---|---|---|---|
| GET | /status | OPEN | {available, compiled, queueDepth, avgProofTimeMs} | PD:262-275 |
| POST | /prove | `X-Api-Key` must `===` configured apiKey; **no auth when apiKey unset** (non-constant-time compare) | body ≤10 MB; `{method:'proveRegistration'|'proveWalletUpdate', params:{preimage[7 Field strings], registryWitnessJson, lifecycleWitnessJson, currentRegistryRoot, currentLifecycleRoot, oldCredentialRoot?, oldNonce?, newCredentialRoot?, currentLifecycle?}}` → `StateTransitionProgram.proveRegistration/proveWalletUpdate` → `{success, proofJson, proofTimeMs}` or raw error text | PD:52-67,277-293,331-389,394-410 |
| * | other | — | 404; handler exceptions → 500 with raw message | PD:295-301 |

Server: only `StateTransitionProgram` compiled (PD:249-252); binds `127.0.0.1` since A2, was `0.0.0.0` (PD:305); no CORS headers, no rate limit, no TLS. Who it proves for: any caller presenting a wallet preimage — registration and wallet-update proofs. GAP I2: the 7-Field preimage (domain tag + hashed identity fields + enrollment-key hash) leaves the device to :4040 when delegation is used; the file's own comment says only hashes cross (PD:23-28). Interface comment says a 6-element preimage (PD:55) but the code consumes indices 0-6 (PD:349-351,364-366). Client `ProofDelegateClient` (PD:84-220) sends `X-Api-Key` when given (PD:194-197); it is only re-exported (`src/nodes/index.ts:31`) — no Nautilus node instantiates it. The member dashboard can POST `proverUrl+'/prove'` from the browser with no API key (`dashboard-member/rpc.js:24,34,36,179-191`).

### start-prover — `src/nodes/start-prover.ts`
`ZKTRIDENT_PROVER_PORT` (4040), `ZKTRIDENT_PROVER_API_KEY` (default none → banner prints `NONE (unauthenticated)`) (48-49,84); compiles then starts `ProofDelegateServer` (60-75); SIGINT/SIGTERM graceful stop (89-101).

## Open questions
1. Is Ed25519 admin mode ever reachable in the shipped topology? Nothing registers a genesis key or calls the admission RPCs, and LEV never passes `adminKeys`, so the gate stays on the Bearer branch (RPC:694; LEV:118-127).
2. With the default origin list lacking ports (RPC:423), how do the :4001–:4004 dashboards reach :3030 in secure mode — only via their Nautilus proxies (`dashboard-member/rpc.js:22` uses `location.origin`)?
3. The explorer proxies any `/rpc` method and collapses all browser callers onto one source IP for the proof rate limiter (EXP:82-86; RPC:719) — intended?
4. `checkAdminAuth` for non-RPC routes signs the constant `admin-endpoint|{}` (RPC:2669) — is a path/body-bound message intended for `/viz/*` and adminOnly engine routes?
5. `l2_approveAdmission` records every Bearer-mode approval as `'admin'` (RPC:945), so a threshold >1 cannot be met without Ed25519 identities — intended bootstrap limitation?
6. `pcpAssignments` (RPC:239) and `entityRegistry` (RPC:236) live only in the RPC server process and are not part of `getAdminRegistryState` (RPC:2688-2699); is any checkpoint path persisting them, or are PCP links and wallet display names lost on restart?
7. `l2_revokeEmployerAttestation` deletes through the private `employerAttestationStore` (RPC:1367) — is a sequencer method intended?
8. `l2_recordFill` appends claim leaves with no proof (RPC:1684-1727); only `scripts/e2e-verify/run.ts` references it — fixture-only, or a production path? **Answered by D2 (2026-10-18): neither — removed.**
9. Who is meant to call `POST /prove`? No node uses `ProofDelegateClient`; the browser path has no API key and the server emits no CORS headers (PD:260-302; `dashboard-member/rpc.js:179-191`).
10. ~~`l2_submitProof` accepts unverified `entityMetadata` and writes it to `entityRegistry` for registrations~~ Answered 2026-10-24: no. It is refused, and the write is gone (RPC-04, under A-74).
