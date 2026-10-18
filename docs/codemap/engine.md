# Code map — adjudication engine (src/adjudication/, moved from visualizer/engine/ on 2026-10-17)

Working tree as read on 2026-10-16; paths updated 2026-10-17 when B1 step one moved the engine to `src/adjudication/` (line numbers are from the 2026-10-16 tree). Abbreviations: S = src/adjudication/interactive-service.ts (6789 lines), R = interactive-routes.ts, L = src/nodes/start-leviathan.ts, SI = start-interactive.ts, SS = start-sequencer.ts, PP = proof-pool.ts, PW = proof-pool-worker.ts, PT = proof-pool-types.ts, SEQ = src/l2/l2-sequencer-service.ts, N = src/l2/l2-node.ts, RPC = src/l2/l2-rpc-server.ts, WD = src/wallets/wallet-derivation.ts.

## 1. Construction and mounting

| Step | Fact | Source |
|---|---|---|
| Launcher | `npm run start:leviathan` → start-leviathan.ts | package.json:10 |
| Node | `L2Node` (not L2Leviathan) restored from the latest checkpoint in `ZKTRIDENT_CHECKPOINT_DIR` (default `./l2-data`) or genesis; checkpoint store attached | L:85, 142-163 |
| Admin token | `ZKTRIDENT_ADMIN_TOKEN`; `admin123` default only when `ZKTRIDENT_UNSECURE=true`; passed to L2Node/L2RpcServer options and to spawned Nautilus children's env — never to the engine | L:80-81, 99-110, 118-127, 604-606 |
| Formulary | leviathan loads 32K NADAC into the sequencer's FormularyService; the engine separately builds its own FormularyRegistry from src/data MEDICATIONS + `formularyRaw` | L:197-208; S:625-716 |
| Node attestation authority | `node.enableAttestations(gossipSecret)` — L2Node's own Ed25519 key, distinct from the engine's | L:284-289; N:348 |
| Engine import | dynamic `import()` of interactive-service.ts / interactive-routes.ts by file URL (tsx) | L:301-304 |
| Emitters | console → stdout; viz → loopback `POST http://127.0.0.1:<port>/viz/emit` with no Authorization header, while RPC:455-462 admin-gates `/viz/emit` | L:307-326 |
| Construct | `new AdjudicationService(consoleEmitter, vizEmitter, node)`; the constructor takes only these three — no admin token, attestation authority, formulary or pool is injected | L:328; S:557-567 |
| Routes | `registerInteractiveRoutes(rpcServer, interactiveService)` without an NfcBridge, so NFC routes are absent in this path | L:329; R:61-65 |
| Persistence | restore `<checkpointDir>/adjudication-state.json` if present; `saveAdjudicationState` = exportState → `.tmp` → rename, on `batch:settled`/`batch:built` and every 60 s; no save-on-shutdown in this block | L:333-368 |
| Proof pool | `new ProofPool(ZKTRIDENT_PROOF_POOL_SIZE ?? 4, {recycleAfterJobs: 50})` with worker proof-pool-worker.ts; on ready → `service.setProofPool(pool)` and status exposed to RPC; failure → inline proving | L:375-410; S:869-871 |
| Compile | `compileAllPrograms()` in background (10 ZkPrograms); `vkCommitment = Poseidon(all VK hashes)` set on RPC server + peer network; then 6 dashboards opened | L:414-446; S:956-1004 (996) |
| initInfrastructure (ctor) | adminWalletId = hashString('ADMIN-INSURER-2026') (S:573); seed provider wallet IDs + preimages (S:578-587); `adminMutate('provision seed providers')` → all seed prescribers/pharmacies ELIGIBLE in the sequencer's trees (S:588-591); provider badges under DEV_BADGE_PIN (S:594-616); TokenAuthority 'ACME-CORP-HR' (S:618); PlanTemplate PLAN-GOLD-2026 — copay 3000, deductible 50000, OOP 800000, benefit max 5000000, family 100000/1600000 (S:625-636); ndcHash maps incl. 32K backfill (S:639-692); sentinel registry for off-formulary (S:693-716); ProviderNetworkRegistry from PLAN_NETWORKS (S:179-186, 718-731); GroupConfig ACME-CORP (S:738-752); EnrollmentService bound to the sequencer's trees (S:755-758); messaging registries (S:765-767); X25519 keypairs from seed provider enrollment keys + admin constant (S:774-787) | S:570-797 |

Other launchers and drivers (none imported by src/nodes/*; grep over src/nodes for scenario / auto-mode / flowchart / nfc-bridge finds nothing):

- start-interactive.ts — standalone L2Node + L2RpcServer on :3030 (`allowedOrigins ['*']`, no adminToken option → admin routes default-deny), deletes `.l2-checkpoints`, constructs `NfcBridge` and passes it to registerInteractiveRoutes (the only place NFC routes exist), pool size default 2, awaits compile. SI:57-71, 104-130, 163-178. Invoked by visualizer/package.json:11 (`sequencer` script).
- start-sequencer.ts — L2Node + L2RpcServer only; no engine, no routes. SS:40-60.
- scenario.ts — HTTP client "simulation engine" that drives the engine over `/interactive/*` against a running sequencer (default config MegaCorp / PLAN-PLATINUM-2026); `runScenario()` at scenario.ts:614. Not in the start:leviathan path.
- scenario-runner.ts — CLI wrapper: waits for `/health`, then `runScenario` with env MEMBERS/SCRIPTS/PA_MEMBERS/PA_DRUGS/PACE/MEMBER_INTERVAL. scenario-runner.ts:27-101. Not in the start:leviathan path.
- auto-mode-controller.ts — in-process `AutoModeController` (class at :230) that calls AdjudicationService methods directly in a weighted random loop (enroll, PCP, messaging, Rx, PA, dispense, credential, reject/cancel, reversal, delegation, formulary updates). Imported only by flowchart-orchestrator.ts:43. Not in the start:leviathan path.
- flowchart-orchestrator.ts — alternative boot (`npm run start:flowchart`, package.json:25): own L2Node + RPC :3030 + AdjudicationService + L2 ProvingPool + AutoModeController + FlowchartDashboardServer :8080. flowchart-orchestrator.ts:36-47. Not in the start:leviathan path.
- nfc-bridge.ts (summary) — `NfcBridge extends EventEmitter` (nfc-bridge.ts:543) drives an NXP PN7150 behind a MIKROE-2540 USB HID dongle (VID 0x1FC9 / PID 0x0088) via LPCUSBSIO I2C tunnelling and NCI; polls for tags, reads/writes NDEF (member-id text record or credential-attestation external record), emits status / tag:detected / tag:read / tag:written / tag:removed / tag:error; depends on `node-hid`. Used only by start-interactive.ts:39, 119-124 and the NFC routes R:1724-1915.

## 2. Engine state

Collections live on `AdjudicationService` (S:441-556). "Persist" = written to adjudication-state.json by `exportState` (S:5640-5839) through L:349-362.

| Field | Key → value | Persist | Source |
|---|---|---|---|
| walletRegistry / lifecycleTree (getters) | the sequencer's trees via `getSequencer().getStateTrees()` — not engine-owned | sequencer checkpoint | S:446-449; SEQ:1353 |
| enrolledMembers | walletId decimal string → EnrolledMember {memberIndex, walletId, walletIdStr, displayName, forest (MerkleForest), credentialData, credentialInventory, eligibilityData, accumulatorData, planId, groupId, familyId, relationship, employeeId, preimageFields?[6] (fixture members only — recomputed at restore; a member with a device has none, B2), pcpAssignment?, pcpPrescriberIndex?, inNetworkPrescriber/PharmacyIndices, lifecycle, terminationDate?, walletIndex, nonce, credentialInventoryRoot, cachedProofGateProof, l2Receipts[], lastCredentialJson?, lastAttestation?} | yes (see below) | S:202-236, 484 |
| prescriptions | rxId → PrescriptionState {prescriptionData, activeStatus, rxForest, rxCredentialData, formularyEntry, prescriber/pharmacy index, memberWalletId, ndcHash, formularyLeafIndex, quantity, quantityDispensed, refills, refillsUsed, status, statusHistory[], currentStatusLeafIndex, nextTxLeafIndex} | yes (txLeaves + medicationLeaf0) | S:250-272, 485; 5715-5753 |
| fulfillments | rxId → FulfillmentState[] {pay cents, totals, accumulator before/after, truncated roots, settlementCommitment, fulfillmentData, pay Fields, deductibleCreditField, settlementLeafIndex, quantityDispensed, reversed} | yes | S:274-295, 486; 5755-5777 |
| priorAuths | paId → {memberWalletId, prescriberIndex, ndcHash, status, requestedAt, resolvedAt?, paLeafIndex?, priorAuthData?} | yes | S:297-309, 487; 5779-5795 |
| pendingPrescriptions | rxId → {indices, memberWalletId, ndcHash, quantity, refills, startedAt} | yes | S:491-500; 5797-5810 |
| nextPaLeafIndex | walletId → next ACCESS_CONTROL leaf (bigint) | yes | S:502; 5812-5816 |
| rxCounter, paCounter, msgNonce, threadCounter | counters | yes | S:488-489, 464, 476; 5818-5830 |
| messageRegistry, delegationRegistry, keyRegistry | o1js MerkleTree-backed registries | NO | S:461-463 |
| encryptionKeys | key index → {publicKey, privateKey}: seed prescribers 0-9, pharmacies 10-17, admin 999, members by walletIndex (device members: privateKey empty) | NO | S:465, 774-787, 1372-1376, 1622-1632 |
| encryptedPayloads | message index → {ciphertext, iv, tag, senderKeyIndex, recipientKeyIndex, threadId, timestamp} | NO | S:466-474 |
| prescriberWalletIds/Preimages, pharmacyWalletIds/Preimages | seed index → Field / Field[3] | NO (recomputed each init) | S:478-481, 578-587 |
| providerBadges | 'prescriber-i' / 'pharmacy-i' → ProviderBadge (ek = AES-256-GCM(enrollmentKey) under scrypt(DEV PIN)) | NO | S:516, 594-616 |
| formularyChangeHistory, currentFormularyEntries, formularyActive, medIndexByNdcHash, medByNdcHash, formularyRegistry | formulary working state | NO | S:519-536, 452 |
| providerNetwork, networkActive, networkChangeHistory | network state | NO | S:537-549 |
| benefitPlanRegistry, sharedEligibilityData, planTemplate, tokenAuthority, groupRegistry, opaqueRoster, enrollmentService | plan/enrollment infrastructure | NO | S:450-458 |
| attestationAuthority (incl. revoked nonces) | Ed25519 authority | NO (key deterministic; revocations lost on restart) | S:511-513; src/credentials/nfc-attestation.ts:288-295 |
| compiled, ready, credentialProgramVk/VkHash, vkCommitment, reportingService | runtime | NO | S:503-508 |

Persisted enrolledMembers entry (S:5683-5711): memberIndex, walletId, walletIdStr, displayName, credentialData, eligibilityData, accumulatorData, planId, groupId, familyId, relationship, employeeId (S:5695), ownershipProofJson (the device's ProofGate.verifyMember proof, B2 — no preimage is written), pcpAssignment, pcpPrescriberIndex, inNetwork*, lifecycle, terminationDate, walletIndex, nonce, credentialInventoryRoot, l2Receipts, lastCredentialJson, forestLeaves (eligibility leaf 0, accumulator leaf 127, PA leaves, PCP MEMBER leaf 0), paLeafIndices. NOT persisted: publicKeyHex / encryption keys, enrollmentKey (never held in EnrolledMember; the seed path reads MEMBERS[i].enrollmentKey transiently at S:1017, 1053-1061, 1372), cachedProofGateProof, lastAttestation.
CLOSED 2026-10-18 (B2): no identity preimage is written. A member with a device never sends one; a fixture member's is recomputed from the fixture file at restore; an older checkpoint's copy is dropped on restore and said so.

Load/restore (S:5841-6029, called at L:341 before pool/compile): version must be 1; counters, nextPaLeafIndex, priorAuths, members (forest rebuilt from forestLeaves; credentialInventory re-minted from credentialData; cachedProofGateProof = null), prescriptions (rxForest from medicationLeaf0 + txLeaves), fulfillments, pending. Not restored: message/delegation/key registries, encryption keys (so sendMessage fails at S:3708 for every party after a restart), formulary/network changes, attestation revocations. `reset` (S:6368-6400) clears session maps, keeps compiled programs, re-runs initInfrastructure (provision is idempotent).

## 3. Keys and identities the engine holds

| Material | Origin / location | Used for | Source and flags |
|---|---|---|---|
| Seed prescriber/pharmacy raw enrollment keys + NPI | `PRESCRIBERS` / `PHARMACIES` from src/data (SeedPrescriber.enrollmentKey, src/data/index.ts:55-66), loaded into the sequencer process | preimages hash(NPI), hash(enrollmentKey) (S:578-587; WD:166-172, 192-198); badges (S:598, 609); X25519 keypairs (S:774-784); badge-tap preimage (S:6536-6540); engine proves provider identity on their behalf (S:2178-2183, 2685-2691, 4722-4727) | GAP: I3-adjacent — provider enrollment keys live in the sequencer |
| Seed member PII + enrollment keys | `MEMBERS` (src/data/index.ts:112-124, 421): cardholderId, dateOfBirth, names, enrollmentKey, address | enrollMember derives wallet + preimage (S:1017, 1053-1054); X25519 key from enrollmentKey (S:1372); served in getState demoData (S:6213-6227) | GAP: I1/I3 (seed/demo path) |
| Dashboard members' ownership proof (B2) | POST /interactive/register-member from the member node sends walletId, ownershipProofJson (ProofGate.verifyMember made on the device), displayName, publicKeyHex — never the preimage (400 if present) | verified with o1js verify() against the compiled key; kept as cachedProofGateProof for the portable credential; every later change is a pending wallet update the device proves (queueWalletUpdate → /interactive/wallet-updates → /proof/wallet-updates) | CLOSED: I2 — the hashed identity never leaves the phone; the engine cannot prove as the member |
| Member X25519 public key | publicKeyHex → keyRegistry; privateKey stored as empty Buffer | message routing only; engine cannot encrypt/decrypt for device members (S:3709, 3850) | S:1622-1632 |
| Insurer identity | adminWalletId = hashString('ADMIN-INSURER-2026'); X25519 from constant 'ADMIN-INSURER-ENCRYPTION-KEY-2026' | credential issuer; sender of notifications; message decryption | S:573, 787. GAP: insurer private key derivable from source |
| Insurer admin token | not held by the engine; L2RpcServer only | admin route gate | RPC:2661-2666 |
| Attestation authority (engine) | `new SequencerAttestationAuthority(Buffer.from('zkpcare-attestation-authority-seed'))` → deterministic Ed25519 (nfc-attestation.ts:183-191) | member credential attestations (S:5469-5474; 24 h default, nfc-attestation.ts:213), provider badge sessions (S:6605-6611; 8 h), revocation (S:4080-4083), pubkey route | S:511-513. GAP: key derivable from a public constant; anyone can sign attestations/sessions |
| Attestation authority (node) | L2Node.enableAttestations(gossipSecret) | separate key; not used by the engine | L:288; N:348 |
| Provider badges | createProviderBadge(enrollmentKey, DEV_BADGE_PIN='000000', …) (src/credentials/provider-badge-service.ts:55, 102-140) | badge list / tap simulation | S:594-616 |
| Badge sessions | attestation objects returned inside BadgeTapEvent; not stored; never checked | — | S:6605-6624 |
| Seed providers' and seed members' X25519 private keys | encryptionKeys | eScript encryption (S:2355-2360); sendMessage (S:3710-3711); sequencer-side decrypt (S:3815-3888) | GAP: the sequencer can read seed-party messages |
| VK commitment | Poseidon of the 10 VK hashes | software identity on RPC/peer network | S:996; L:419-423 |

## 4. Proof inventory per operation

All proofs go through `dispatchProof(program, method, argTypes, args, inlineFn)` (S:900-953): pool worker when `proofPool.isRunning()` (args serialized S:877-898 → PP:203 → PW:325), else inline in the main process (S:910-932). Fates: SUBMITTED = `l2Node.submitProof` (N:494 → SEQ:291; SEQ:293 `proof.verify()`, fingerprint dedup, old-root match, planned tree update, nonce/newCredentialInventoryRoot check SEQ:1467-1479); accepted StateTransitionProofs are later wrapped into BatchProgram at batch build (N:567, 580). DISCARDED = awaited, result unused (proving enforces the constraints, but no verifier ever sees the proof). VERIFIED(x) = checked by x.

| Operation | Program.method | Asserts (one clause) | Fate | Source |
|---|---|---|---|---|
| enrollMember (seed) | ProofGate.verifyMember | Poseidon([tag,…6]) == walletId | STORED as JSON (cachedProofGateProof), never re-verified | S:1073-1081, 1402 |
| | StateTransition.proveRegistration | wallet inserted at next slot, lifecycle REGISTERED | SUBMITTED | S:1115-1142 |
| | StateTransition.proveWalletUpdate | EMPTY_CREDENTIAL_ROOT → inventoryRoot, nonce 0→1 | SUBMITTED (metadata newCredentialInventoryRoot) | S:1242-1277 |
| | (admin) REGISTERED → ELIGIBLE | — | adminMutate, no proof | S:1309-1311 |
| registerMemberFromEnrollment | (admin) provision ELIGIBLE | — | adminMutate | S:1595-1597 |
| | pending wallet update: credential mint (B2) | live root → inventoryRoot, queued (queueWalletUpdate) | PROVED BY THE DEVICE (/proof/wallet-updates), reported to /interactive/wallet-update-applied; a fixture member is still proved by the engine | registerMemberFromEnrollment |
| | ProofGate.verifyMember | identity | STORED (cachedProofGateProof), unused afterwards | S:1608-1613, 1658 |
| requestPriorAuth / denyPriorAuth | none | — | — | S:1720-1797, 1925-1962 |
| approvePriorAuth | AccessControl.provePriorAuth | PA leaf in forest, formulary entry, not expired, qty ≤ approved (requested qty = approved qty) | DISCARDED | S:1864-1870 |
| | StateTransition.proveWalletUpdate | new inventory root | SUBMITTED | S:1876 → 5132-5151 |
| createPrescription | ProofGate.verifyPrescriber | seed prescriber preimage | DISCARDED | S:2178-2183 |
| | Eligibility.proveEligibility | credential + plan witness, date 20260202 | DISCARDED | S:2265-2270 |
| | AccessControl.proveFormularyAccess | entry under formulary root, ndc match, qty ≤ maxQuantityPerFill, daySupply ≤ maxDaySupply, date 20260101 | DISCARDED; requestedDaySupply is passed as `Field(entry.maxDaySupply)` (S:2301-2302) so the day-supply assertion (src/access-control/access-control-program.ts:93, 157-159) cannot fail | S:2298-2303 |
| | AccessControl.provePriorAuth (PA drugs) | PA leaf valid for requested qty | DISCARDED | S:2331-2337 |
| | Messaging.proveSendMessage (eScript) | message in registry | DISCARDED; audit event emitted | S:2382-2388, 2409 |
| markFilled | none | — | — | S:2552-2607 |
| dispensePrescription | ProofGate.verifyPharmacy | seed pharmacy preimage | DISCARDED | S:2685-2691 |
| | Prescription.proveStatusUpdate | FILLED/PARTIAL → PARTIAL/DISPENSED valid; prescriber preimage | DISCARDED | S:2734-2740 |
| | AccumulatorFulfillment.proveFulfillmentWithAccumulator | 22-step adjudication; outputs patientPay / planPay / deductibleCredit / newEligForestRoot | proof DISCARDED; publicOutput READ (S:2822-2824) then pay REWRITTEN by family pooling (S:2901-2920); claim metadata carries the rewritten pay (S:3008-3009) while the settlement leaf uses the proof's fields (S:2972-2977) | S:2805-2811 |
| | pending wallet update: fill (B2) | new inventory root; the claim committed on the sequencer (commitPendingClaim) | PROVED BY THE DEVICE; the sequencer attaches the claim when the proof for that root lands; a fixture member is still proved by the engine with the claim metadata | updateCredentialAndSubmitToL2 → queueWalletUpdate |
| reversePrescription | AccumulatorFulfillment.proveReversalWithAccumulator | settlement leaf matches; refunds bound | DISCARDED (new root read S:3364) | S:3353-3359 |
| | StateTransition.proveWalletUpdate | new inventory root | SUBMITTED (failure logged, local state kept) | S:3449-3453 |
| updateRxStatus | none | — | — | S:3188-3284 |
| sendMessage | Messaging.proveSendMessage | message in registry | DISCARDED; audit event | S:3752-3758, 3778 |
| createDelegation | Messaging.proveDelegate | delegation in registry | DISCARDED | S:4023-4029 |
| terminateMember | none | EnrollmentService.terminateMember inside adminMutate → REVOKED | — | S:4073-4075 |
| updateFormularyEntry / updateProviderNetwork / planYearRollover | StateTransition.proveWalletUpdate per active member | new inventory root | SUBMITTED | S:4376, 4568, 4671 |
| assignPcp | ProofGate.verifyPrescriber | seed preimage | DISCARDED | S:4722-4727 |
| | PcpVerification.verifyPcpAssignment | PCP leaf in MEMBER tree; pcpWalletId matches | DISCARDED | S:4781-4786 |
| | StateTransition.proveWalletUpdate | new inventory root | SUBMITTED | S:4792 |
| generateCredential | ProofGate.verifyMember | member identity (engine-held inputs) | fed into the next proof | S:5405-5415 |
| | Credential.proveHolding / proveHoldingByType | member holds credential in inventory (recursive over ProofGate) | serialized PortableCredential RETURNED + STORED (lastCredentialJson); not submitted | S:5427-5449, 5466 |
| | (Ed25519) attestation | signed {w, cc, ls=3, fr}, 24 h | RETURNED + STORED (lastAttestation) | S:5469-5475 |
| verifyCredential | — | — | VERIFIED(`verifyCredentialOffline`, src/credentials/portable-credential.ts) against the compiled CredentialProgram VK | S:5525 |
| simulateBadgeTap | ProofGate.verifyPrescriber / verifyPharmacy | seed preimage from badge + raw enrollmentKey | DISCARDED; event `verified: true` hard-coded | S:6546-6569 |
| | (Ed25519) session attestation | ls=2, 8 h | RETURNED only; never checked | S:6605-6624 |

## 5. Plain-TypeScript rule checks (outside circuits)

| Area | Checked | NOT checked | Source |
|---|---|---|---|
| Enrollment (register-member) | ownershipProofJson present and readable; its public input is the wallet; verify() against ProofGate's key; insurer approval (403); REGISTERED on the ledger (409); publicKeyHex shape; duplicate wallet | preimageFields in the body → 400 (B2); plan and group from the approval, never the body (Step 2) | registerMemberFromEnrollment, verifyOwnershipProof |
| Enrollment (seed) | token generate / validate / consume (errors swallowed) | — | S:1035-1040, 1170-1194 |
| PCP | member enrolled; seed prescriber exists | GAP: no member consent, no network membership, no lifecycle | S:4705-4711 |
| Prescribe | member enrolled; drug known (32K map); PA approved/pending; step therapy (runtime `currentFormularyEntries` flag + STEP_THERAPY_MAP S:190 + member's FILLED/PARTIALLY_FILLED history); DEA number present; Schedule ≥2 refills → 0 | GAP: no PCP check, no prescriber/pharmacy in-network check, no member lifecycle (REVOKED) check; no quantity/day-supply check in TS (circuit receives daySupply = maxDaySupply); `formularyActive` (REMOVE) not consulted; PA flag read from the static seed entry (S:2095) not the runtime-modified one; no refill/expiry or duplicate-Rx checks | S:2073-2145 |
| Prior auth | drug requiresPriorAuth (static entry); member enrolled; prescriber exists; no existing PENDING/APPROVED | approval has no clinical criteria; approvedQuantity = maxQuantityPerFill | S:1725-1745, 1820-1828 |
| markFilled | status == ADJUDICATED | GAP: caller is not checked to be the Rx pharmacy | S:2553-2558 |
| Dispense | status FILLED/PARTIALLY_FILLED; qty ≥ 1 and ≤ remaining (FWA guard) | GAP: costs — ingredient default AWP×qty, fee default 200, caller-supplied cents accepted with no bounds (S:2665-2667); member lifecycle not checked; `credentialJson` param accepted but unused (S:2613); family pooling overrides circuit pay (S:2901-2920); daysSupply hard-coded 30 in claim metadata (S:3014) | S:2620-2667 |
| Reverse | status; fill exists; not already reversed | GAP: no caller identity; free-text reason hashed | S:3291-3308 |
| Rx status | transition table (`isValidStatusTransition`); role per status | GAP: role/actorIndex caller-asserted | S:3197-3225 |
| Terminate | enrolled; not REVOKED | — | S:4058-4060 |
| Messaging | parties resolvable; member not REVOKED; keys present | GAP: sender identity caller-asserted | S:3631-3675, 3706-3709 |
| Credential | enrolled; not REVOKED; VK present | GAP: caller identity | S:5375-5378 |
| Lifecycle generally | `lifecycle === 'REVOKED'` guards only at S:3665, 4060, 4336, 4397, 4519, 4587, 4634, 5377 (messaging, terminate, cascades, credential) | prescribe / dispense / reverse / PA do not check lifecycle | — |

## 6. Sequencer coupling

Engine → L2Node / L2SequencerService is all in-process. No outbound HTTP exists in S or R (grep for http.request / fetch finds none); the only outbound HTTP is the viz loopback in the launchers (L:313-326; SI:90-102).

| Call | Purpose | Engine lines | Target |
|---|---|---|---|
| `getSequencer().getStateTrees()` | read the sequencer's WalletRegistry / lifecycle MerkleTree (witnesses, getState, getIndex, count, getNextSlotWitness) | S:446-449; uses at 1106-1109, 1240-1243, 1373, 1603-1605, 5047 | SEQ:1353 |
| `adminMutate(reason, fn)` | provision seed providers; enroll REGISTERED → ELIGIBLE; register-member provision ELIGIBLE; terminateMember (EnrollmentService mutates the trees inside fn) | S:588, 1309, 1595, 4073 | SEQ:1365-1405 (roots re-derived from the trees; fn must be synchronous) |
| `applyAdminRootUpdate` | not called by the engine; kept for compatibility and refuses roots the tree does not produce | — | SEQ:1324-1347 |
| `l2Node.submitProof(proof, metadata?)` | registration, mint, every wallet update (with newCredentialInventoryRoot and optional claim metadata) | S:1142, 1274, 5112 | N:494 → SEQ:291 |
| `l2Node.buildBatchDirect()` / `getPendingCount()` | batch the two enrollment proofs before the admin lifecycle change | S:1296-1298 | N:580; SEQ:1998 |
| `l2Node.forceBatch()` | after prescribe / approve / fill / reverse and the two force-batch routes | S:5156; R:292-315, 377-415, 417-468, 544-634, 678-705, 1200-1217, 1673-1690 | N:567 |
| `l2Node.saveCheckpoint('manual')` | save-checkpoint route | S:5161 | N:1579 |
| `l2Node.emitMessagingAuditEvent(sender, rootBefore, rootAfter)` | eScript, internal messages, sendMessage | S:2409, 3596, 3778 | N:618 |
| `seq.getWalletStateForRpc` / `getWalletWitnesses` / `getCurrentRegistryRoot` / `getCurrentLifecycleRoot` | live nonce, credential root, witnesses for wallet-update proofs; re-prove up to 4 times on root contention | S:5071-5078, 5113-5124 | SEQ:1944, 1917, 1868, 1873 |
| `seq.getCurrentWalletCount`, `getAllReceipts`, `getAllBatches`, `getAuditLog`; `l2Node.getStatus` | chainState / getState | S:5267-5273, 6142-6166 | SEQ:1878, 2038, 2058, 2414; N:765 |
| `l2Node.withProvingLock(fn)` | routes serialize proving operations | R:202, 302, 390, 442, 591, 688, 717, 767, 865, 935, 979, 1049, 1073, 1097, 1120 | N:1531 |
| `seq.retryBatch` / `markBatchFailed` / `getClaimsBy*` / `getReceiptsByWallet` / `getClaimWithProof` / `getFormulary` / chain getters | routes only | R:1234-1287, 1351-1555, 1618-1671, 1692-1721 | SEQ:1255, 1106, 2043-2127, 1676, 2063-2102 |
| Not used by the engine | recordFill, storeMessage, registerPcpAssignment, message store, quorum, WAL — no references in S or R | — | — |

Inbound from other processes: the member node POSTs `/interactive/register-member` (src/nodes/routes/member-routes.ts:555-563); the other Nautilus nodes call `/interactive/*` and `/node/*` over HTTP (outside this scope).

## 7. Proof pool (proof-pool*.ts)

| Topic | Fact | Source |
|---|---|---|
| Jobs | `ProofJobRequest {program, method, args[]}` → `ProofJobResult {proofJson, publicOutput, proveTimeMs, workerId}`; IPC messages compile / prove / shutdown ↔ ready / result / error | PT:43-125 |
| Registry | 10 programs, 17 methods: ProofGate(3), Eligibility(1), AccessControl(2), Messaging(2), StateTransition(2), Prescription(1), AccumulatorFulfillment(2), Credential(2), PcpVerification(1); BatchProgram compiled only so StateTransitionProof deserializes | PW:145-259, 265-315 |
| What crosses IPC | JSON only (`serialization: 'json'`): Field decimal strings, Struct JSON, witness JSON, proof JSON. Member preimage fields (hashed identity incl. hash(enrollmentKey)) and seed provider preimages cross as decimal strings (e.g. S:1076-1078, 2179-2183, 5083-5088); no raw enrollment keys or raw PHI cross; public outputs return as strings | PP:261-265; S:877-898; PW:319-323, 381-403 |
| Worker lifecycle | fork with `--import tsx`, piped stdio, stderr relayed; sequential compile per worker with 20-min timeout; prove timeout 3 min (job rejected, worker marked idle, not killed); crash → in-flight job rejected, restart ≤ 3; recycle after N jobs deferred until queue empty and no active jobs; shutdown → 'shutdown' message then SIGTERM after grace | PP:94-106, 124-151, 260-314, 335-344, 423-467, 469-496, 153-195 |
| Leviathan settings | pool size `ZKTRIDENT_PROOF_POOL_SIZE ?? 4`, recycleAfterJobs 50; status exposed via `setEntityProofPoolStatus` | L:375-380, 402-405; PP:227-256 |
| Argument typing | the worker ignores the caller's type tags and deserializes by its own `methodDef.argTypes` | PW:341-354 |
| Located failure: portable credential in the pool | the service dispatches `Credential.proveHolding(ByType)` with the first arg tagged `'ProofGateProof'` and a ProofGate proof (S:5428-5441); the worker registry declares that arg `'StateTransitionProof'` (PW:243, 248) and `TYPE_REGISTRY` has no `ProofGateProof` entry (PW:103-134), so the pool path parses the ProofGate proof with `StateTransitionProof.fromJSON` (PW:133) and the CredentialProgram call fails; the inline path (no pool) uses the right classes (S:5431, 5439). Static reading, not executed | PW:133, 240-251; S:5427-5441 |

## 8. Open questions

- SEQ:293 calls `proof.verify()`; no `verify(proof, vk)`-style call appears in submitProof (grep over SEQ:291-331). Whether that call cryptographically verifies a StateTransitionProof outside a circuit, or whether verification is intended to happen only when BatchProgram wraps it at batch build, needs confirming — if the latter, sequencer state is updated before any cryptographic check.
- Answered 2026-10-18 (B2): register-member accepts no preimage at all; the device proves ownership and every wallet update; the proof delegate on :4040 was never part of member proving.
- The engine's attestation seed (S:512) and insurer encryption seed (S:787) are string constants — should they come from env like the node's authority (L:288)?
- Seed provider enrollment keys in src/data/*.json are loaded into the sequencer; is the Nautilus prescriber/pharmacy path (on-device proving) meant to make the engine's seed preimages unnecessary?
- Family pooling (S:2901-2920) overrides circuit outputs; the claim leaf (S:3008-3009) and the settlement commitment (S:2972-2977) then disagree. Intended?
- adjudication-state.json has no save-on-shutdown hook in L:349-368 (batch events + 60 s timer only) — is one present in the shutdown handler further down start-leviathan.ts?
- Which process is the intended verifier for the DISCARDED proofs (prescriber identity, eligibility, formulary, PA, status update, fulfillment, reversal)? Nothing in scope consumes them.
- After a restart, encryption keys and registries are not restored (S:5841-6029) while `msgNonce` is; are messaging flows expected to survive a restart?
