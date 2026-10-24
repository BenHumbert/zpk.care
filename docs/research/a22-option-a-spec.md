<!-- Design record. Option A for the money half of A-22, chosen by the owner on 2026-10-24 with all of section 9's defaults accepted. Line numbers are at 74bda4e. -->

# Option A: verified fill proofs, implementation specification

Repository `Z:\zpk_care`, branch `dev`, HEAD `74bda4e`. All line numbers are at that commit. I checked the three maps against the source. Corrections are listed at the end.

Path aliases, following `docs/CODEMAP.md`:

| Alias | File |
|---|---|
| `S` | `src/adjudication/interactive-service.ts` |
| `R` | `src/adjudication/interactive-routes.ts` |
| `seq` | `src/l2/l2-sequencer-service.ts` |
| `rpc` | `src/l2/l2-rpc-server.ts` |
| `node` | `src/l2/l2-node.ts` |
| `start` | `src/nodes/start-leviathan.ts` |
| `MR` | `src/nodes/routes/member-routes.ts` |
| `PW` | `src/adjudication/proof-pool-worker.ts` |
| `AFP` | `src/fulfillment/accumulator-fulfillment-program.ts` |
| `WU` | `src/credentials/wallet-update.ts` |
| `VP` | `src/l2/l2-verify-pool.ts` |
| `VW` | `src/l2/l2-verify-worker.ts` |

## What was already written down

**Option A itself** is in `docs/research/owner-decisions-review.md:131-165` (B3-5). It says:
- keep the engine's fill proof;
- add the member's starting credential state to the proof's output;
- have the sequencer verify the proof using A1's pattern (a child process and a pinned key);
- attach the claim only when the member's wallet update reaches the proof's new root;
- have the phone check the proof, the numbers and the roots before it proves its update.

The review estimated 1.5 to 2 sessions.

**Related notes in the same file:**
- `:335` — the phone needs a rule for engine updates that carry no fill proof (for example, accept a reset only on the renewal date and only to zero), and the estimate is too low.
- `:341` — stored fill proofs belong on the sequencer's pending claims, not in the engine's state file.
- `:298` — B4 has to split this circuit.
- `:305` — one refused update blocks every later one.
- `:308` — nobody can check the family totals.
- `:316` — pay the pharmacy on the finalized pickup, and flag phones that stay silent for 30 days.

**In `docs/research/engine-review.md`:**
- `:89` — the claim-proof verifier needs its own pinned key, and production should require it.
- `:111` — once the engine runs in its own process, the commit-claim call becomes the RPC that verifies the proof.
- `:119` — a restore that lost data becomes the ledger's truth at the next admin change.

**Owner decisions** are recorded in `scripts/e2e-verify/PLAN-security-hardening.md:2886-2893`. Defects still to be entered as findings, including pending claims that never expire, are at `:2880-2884`.

This spec builds option A and closes the gaps those notes leave open.

## 0. The design on one page

1. **Circuit.** The fill circuit adds six outputs:
   - the member's wallet;
   - the old and new credential-inventory roots, which are exactly the roots the member's wallet update moves between;
   - the old and new accumulator commitments;
   - the formulary root.

   It also asserts three things:
   - the accumulator is leaf 127;
   - the credential is inventory slot 0;
   - the formulary is the one the member's own credential names.

2. **Engine.** The engine keeps the proof JSON only long enough to hand it to the sequencer. It never stores it.

3. **Commit.** `commitPendingClaim` becomes asynchronous.
   - The sequencer checks the claim against the proof's outputs: amounts, drug, pharmacy, quantity, costs, date, wallet and roots.
   - It then verifies the proof in a child process against a pinned key.
   - Only after both pass does it park the claim, the fulfillment preimage, the proof and the outputs under the key `walletId:expectedNonce`.

4. **Attach.** When the member's wallet proof lands, `submitProof` attaches the parked claim only if the proof moves that wallet from the park's old root to its new root at that nonce. The ledger leaf and the audit event both commit to Poseidon(outputs), and the proof moves to an archive.

5. **Phone.** The phone:
   - fetches the park from the sequencer;
   - verifies the proof against the key pinned in its own build;
   - checks that the "before" and "after" totals are its own leaf 127 and differ by exactly the proof's amounts;
   - only then proves its update.

   Updates that carry no fill proof (mint, plan binding, rollover, prior authorization, primary-care choice, console formulary or network) get explicit rules.

6. **Failure.** Every failure is refused before anything is written. A refusal is reported and freezes the member's money operations until the operator resolves it.

## 1. The circuit change (AFP)

### 1.1 Public output: 12 fields become 18

The existing positions stay where they are. New fields are appended after `familyRule` (AFP:42-67). Position matters only in the `publicOutput` array of the proof JSON. The engine reads outputs by name (S:1578-1587 inline, PW:413-434 from the pool).

| # | Field | Fill | Reversal | Read by |
|---|---|---|---|---|
| 0–9 | prescriptionHash … ndcHash | unchanged | unchanged | engine, sequencer, phone |
| 10 | familyCommitment | **Poseidon(the 6 family inputs, familySalt)**; today it hashes only the 6 inputs (AFP:447-454) | 0 | an auditor who holds the salt |
| 11 | familyRule | unchanged | 0 | engine, phone (display only) |
| 12 | memberWalletId | `eligCredentialData.subjectWalletId` | same | sequencer, phone |
| 13 | oldCredentialInventoryRoot | `inventoryWitness.calculateRoot(eligCredentialData.commitment())` | same | engine, sequencer, phone |
| 14 | newCredentialInventoryRoot | the same witness applied to the credential with `forestRoot = newEligForestRoot` | same | engine, sequencer, phone |
| 15 | oldAccumulatorCommitment | `accumulator.commitment()` | same | phone, auditor |
| 16 | newAccumulatorCommitment | the value computed at AFP:478-486 | the value computed at AFP:710-718 | phone, auditor |
| 17 | formularyRoot | `eligibilityData.formularyRoot` | 0 | sequencer |

**Why inventory roots rather than the old forest root.** For each wallet, the sequencer stores only `credentialInventoryRoot` and the nonce (`src/wallets/wallet-state.ts:35-48`; seq:1625-1626). The member's update moves exactly between these two roots, so with them in the output every check becomes a plain equality and needs no preimage. A member's inventory always holds one credential, in slot 0 (WU:110-139). The circuit now enforces that slot instead of verifiers assuming it.

### 1.2 New private inputs

New inputs are appended at the end. That way every existing caller, and every test that slices arguments by position, keeps its indices.

**Fill: 24 inputs become 28** (AFP:105-130 for the list, :131-156 for the method parameters):
- [24] `CredentialInventoryWitness` (`src/wallets/wallet-state.ts:26`): `enrolled.credentialInventory.getWitness(0n)`
- [25] `EligibilityData`: `enrolled.eligibilityData`
- [26] `ForestMerkleWitness`: `eligForest.getWitness(ForestDomain.ACCESS_CONTROL, 0n)`
- [27] `Field` familySalt: `Field.random()`. The engine stores it in FulfillmentState and never sends it anywhere.

**Reversal: 18 inputs become 19** (AFP:543-562):
- [18] `CredentialInventoryWitness`

### 1.3 New constraints

Add to the fill method, after step 15 (AFP:278-284):

```ts
inventoryWitness.calculateIndex().assertEquals(Field(0), 'Eligibility credential is not inventory slot 0');
eligibilityWitness.calculateIndex().assertEquals(Field(0), 'EligibilityData witness is not leaf 0');
eligibilityWitness.calculateRoot(eligibilityData.commitment())
  .assertEquals(eligForestRoots.accessControlRoot, 'EligibilityData not in ACCESS_CONTROL leaf 0');
eligibilityData.formularyRoot.assertEquals(formularyRoot, "Formulary root is not the member credential's");
accumulatorWitness.calculateIndex().assertEquals(Field(ACCUMULATOR_LEAF_INDEX), 'Accumulator witness is not leaf 127');
```

Then, after `newEligForestRoot` is computed (AFP:493-500), compute:

```ts
newCredentialInventoryRoot = inventoryWitness.calculateRoot(Poseidon.hash([credentialType, newEligForestRoot,
  issuerWalletId, subjectWalletId, issuedAt, expiresAt, revoked]))
```

These are the fields of `eligCredentialData`, in the order of `CredentialData.commitment()` (`src/credentials/credential-data.ts:62-72`). The family commitment (AFP:447-454) gains `familySalt` as a seventh input.

**Reversal:** add the slot-0 and leaf-127 index assertions after its step 11 (AFP:683-689), and compute the two inventory roots after AFP:725-732.

**Why these are needed:**
- Today the accumulator witness index is not constrained anywhere (AFP:278-284, 683-689; `calculateIndex` appears nowhere in `src`), although o1js 2.13 provides it (`node_modules/o1js/dist/node/lib/provable/merkle-tree.js:184-193`).
- The formulary root is a bare input (AFP:116 and 142), checked only at AFP:241-247. The engine's own comment admits this (S:3929-3932).

### 1.4 Two plan-year rules in the same key change

These are on by default. The owner decides (D5).

- **Fill:** `planYear ≤ fulfillmentData.dateOfService < planYear + 10000`, with dates as CCYYMMDD. Adding 10000 gives the same date one year later.
- **Reversal:** let `sameYear` mean the original fill's date falls inside the accumulator's plan year. The three new paid totals (AFP:694-708) become `Provable.if(sameYear, clamped subtraction, unchanged)`. A reversal of a prior-year fill still records the refund on the ledger, but it no longer subtracts last year's money from this year's totals.

The engine mirrors these rules: the reversal arithmetic at S:4627-4648, plus a 409 before proving when the service date falls outside the plan year. The phone mirrors them in §4.3, check F7. Each later key change needs a coordinated restart of every node and app, which is why both rules belong in this one.

### 1.5 Module split

Create `src/fulfillment/accumulator-fulfillment-output.ts`, which imports only `Field`, `Struct` and `Poseidon`, and move the Struct into it. AFP re-exports the Struct, so existing imports still work. Add three helpers:

- `FILL_OUTPUT_FIELDS`: the 18 field names, in order.
- `decodeFillOutput(publicOutput: string[]): FillOutput`: runs `AccumulatorFulfillmentOutput.fromFields(publicOutput.map(s => Field(BigInt(s))))` and returns decimal strings. It throws unless there are exactly 18 entries.
- `fillOutputCommitment(publicOutput: string[]): string`: Poseidon over all 18 fields.

None of these calls into Pickles, so they are safe inside the sequencer process. The A1 constraint (PLAN:111-126) covers only compile and verify, which stall there after the engine compiles.

### 1.6 What the key change means

**Scope of the change.** The AccumulatorFulfillment verification key changes. No other key changes. StateTransition's key, which A1's `ZKTRIDENT_TRANSITION_VK_HASH` pins (start:261), stays the same.

**Engine fingerprint.** The engine's `vkCommitment`, a Poseidon hash of ten key hashes (S:1621-1661), changes. It is published by `l2_getStatus` (rpc:1302-1309) and compared by peers on reconnection (`src/l2/l2-peer-network.ts:163-166`). Every node must run the same build.

**Genesis.** No fill proof has ever been stored, and the park, claim-leaf and audit formats all change (§2.6, §6). The change therefore ships with a clean boot (`npm run clean:state`, package.json:31), with no migration:
- `CHECKPOINT_VERSION` (`src/l2/l2-checkpoint.ts:268`) becomes 2.
- `L2Node.fromCheckpoint` refuses a version-1 checkpoint and tells the operator to finish or clear it.

**The pinned key.** There is one source of truth, generated and committed like a lockfile:
- `src/zkp/circuit-pins.ts` holds `export const FULFILLMENT_VK_HASH = '<decimal>'` and imports nothing.
- `src/zkp/keys/accumulator-fulfillment.vk.json` holds `{ program, o1js: '2.13.0', hash, data }`.
  - o1js `verify` takes the base64 key data directly (`zkprogram.d.ts:40`).
  - `VerificationKey.checkValidity` proves that the data matches the hash without a compile (`verification-key.js:28-40`).
  - `verify` itself does not check that the data and the hash match (`zkprogram.js:56-60`), so loaders must call `checkValidity`.

**Optional environment check.** `ZKTRIDENT_FULFILLMENT_VK_HASH` is an optional assertion by the operator. When it is set, it must equal the constant; otherwise the sequencer refuses to boot and the member node refuses to verify. It is not a secret and must never be added to `SECRET_ENV_KEYS` (`src/security/node-roles.ts:179-189`). `childEnvironment` already forwards it to child processes (:192-202).

**How the pin is produced.** A new script, `scripts/dev/pin-circuit-keys.ts`, does four things:
1. Compiles the program in a clean process.
2. Writes the two files above.
3. Proves one fill from `scripts/dev/fill-fixture-inputs.ts`. Those inputs are extracted from `tests/accumulator.test.ts:166-252`, with EligibilityData added at leaf 0.
4. Writes `scripts/e2e-verify/fixtures/accumulator-fulfillment-proof.json` beside A1's fixture, then prints the proof size and its output commitment. The size is expected to be about 30 KB (A1's fixture is 30,311 bytes) and should be recorded.

With `--check`, the script compiles and exits with status 1 if anything drifted. Run it whenever the circuit or o1js changes.

**Engine check.** Keep the engine's compiled fill-key hash (set at S:1634). After compilation finishes (start:572-582), compare it with the pin. If they differ, log loudly and turn claims off (§5.10).

### 1.7 Callers to update

- Pool table PW:228-257: four more types for the fill, one for the reversal.
- Engine dispatches S:4084-4089 (fill) and S:4613-4618 (reversal): types, arguments and the inline function.
- `src/fulfillment/accumulator-fulfillment-service.ts:163-190` and `:356-377`: add `eligibilityData` and `familySalt` parameters. The inventory witness is `memberInventory.getWitness(eligibilityCredentialSlot)`, and that slot must be 0.
- `src/seed/run-full-cycle.ts:594-614`.
- Tests (§7.2).
- The console text "24 private inputs", "18 witnesses" and "Public Output (10 Fields)" (S:4071, 4109, 4119) now reads 28 and 18.

## 2. Data formats at each boundary

All amounts and field values are decimal strings unless stated otherwise.

### 2.1 Engine to sequencer: committing a claim

The call is in-process today. After R3 it becomes the engine-role RPC `l2_commitPendingClaim`, with the same shape. The types go in a new file, `src/l2/pending-claims.ts`.

```ts
interface FulfillmentFields {     // the FulfillmentData preimage, exactly as proven (src/fulfillment/fulfillment-data.ts:33-58)
  prescriptionHash; pharmacyWalletId; ndcHash;
  quantityDispensed;              // quantityToField(qty), in thousandths, as the circuit takes it
  ingredientCostCents; dispensingFeeCents; dateOfService;
}
interface PendingClaimCommit {
  walletId: string;               // the member
  updateId: string;               // the engine's wu-… id, or fx-… for a fixture member
  expectedNonce: string;          // the nonce the member's proof reaches: the old nonce + 1
  oldInventoryRoot: string;       // where the update starts (chained as today, S:2273)
  newInventoryRoot: string;       // where it ends
  claim: ClaimSubmissionMetadata; // src/l2/l2-types.ts:241-288; the type is unchanged
  fulfillment: FulfillmentFields; // for a reversal, the original fill's preimage
  fill: { proofJson: string };    // as dispatchProof returns it (S:1589, PW:406)
}
L2Node.commitPendingClaim(c): Promise<{ key: string; outputCommitment: string; committedAt: number }>
```

The proof never goes into `ClaimSubmissionMetadata`. That type flows into the WAL entry (seq:398), the claim metadata and the gossip message (node:566-577).

### 2.2 The park record

This replaces `Map<string, ClaimSubmissionMetadata>` (seq:1442) and the matching checkpoint type (`src/l2/l2-checkpoint.ts:116-120`).

```ts
interface PendingClaimRecord extends Omit<PendingClaimCommit, 'fill'> {
  key: string;   // `${walletId}:${expectedNonce}`
  fill: { proofJson: string; publicOutput: string[]; outputCommitment: string; vkHash: string; verifiedAt: number };
  committedAt: number;
  state: 'parked' | 'invalid';
  restored?: boolean;   // set by restoreState, cleared once the proof is verified again
}
```

**Why key by nonce.** A wallet's nonce rises by exactly one per accepted update (`src/engine/state-transition.ts:293-296`; seq:1626), so `walletId:expectedNonce` names exactly one step.

**Why today's key collides.** Today's key is `walletId:newInventoryRoot`. Consider a fill from root A to B, its reversal back to A, then an identical refill from A to B, which is allowed after a reversal (S:3919). The fill and the refill both park under `w:B`, and `Map.set` silently drops one of them (seq:1444-1446).

### 2.3 Sequencer to phone

A new read, `l2_getPendingClaims { walletId }`, returns `{ walletId, claims: PendingClaimRecord[] }` without the `restored` flag.
- Add it to `MEMBER_DATA_METHODS` (`src/l2/member-data-methods.ts:62-83`) as `{ subject: 'wallet', param: 'walletId', readers: ['self'] }`. The plan and the operator always pass the read gate.
- Add `L2Client.getPendingClaims(walletId, signer)` beside `getWalletState` (`src/l2/l2-client.ts:343-349`).

### 2.4 Engine to phone: the pending update payload

`WalletUpdatePayload` (WU:52-68) gains these fields:

```ts
expectedNonce: string;                                           // every update
accumulator: { before?: AccumulatorValues; after: AccumulatorValues };   // every update; `before` is absent only on a mint
eligibility: { before?: EligibilityValues; after: EligibilityValues };   // same
planTerms?: { planId: string; publishedAt: number };             // mint and plan binding
fill?: { operationType: '1' | '2'; parkKey: string; outputCommitment: string };
```

- `AccumulatorValues` is `AccumulatorData.toJSON` (7 strings) and `EligibilityValues` is `EligibilityData.toJSON` (8 strings).
- Before queuing, the engine asserts that Poseidon(after) equals the payload's leaf (4,127) and leaf (4,0), and that `before` equals the previous update's `after`.
- `GET /interactive/wallet-updates` (R:379-393) also returns `lastApplied` (§4.6).
- `PendingWalletUpdate.status` (S:544-549) becomes `'pending' | 'applied' | 'refused' | 'cancelled'`, plus `refusal?: { check, detail, at }`.
- The payload never carries a proof, so the engine's state file (S:7204, 7226) never holds one.

### 2.5 Phone to engine, and phone to sequencer

- **New route.** `POST /interactive/wallet-update-refused { walletId, updateId, check, detail }`. It is signed by the wallet; add it to `WALLET_ROUTES` (R:161-167) with the walletId taken from the body. It answers `{ updateId, status: 'refused' }`.
- **Unchanged.** `l2_submitProof { proofJson, newCredentialInventoryRoot }` (MR:166) and `POST /interactive/wallet-update-applied` (R:395-408).

### 2.6 Ledger formats (these require the genesis boot)

- **`ClaimLeaf`** (`src/l2/claim-accumulator-types.ts:47-66`) gains `fillOutputCommitment` as a tenth hashed field, included in `computeClaimLeafHash` (:79-93).
- **`ClaimMetadata`** (:102-146) gains `entryCommitment` and `fillOutputCommitment`.
- **The audit event commitment** (`src/audit/audit-service.ts:64-78`) gains `fillOutputCommitment` as its twelfth field, 0 for anything that is not a claim.

Replicas recompute leaf hashes from the leaf data (seq:2710-2713), so the field travels inside the gossiped claim entry.

### 2.7 Device state

These fields are added to `src/nodes/nautilus-local-state.ts:122-177`.

```ts
credentialParts += { nonce; accumulator: AccumulatorValues; eligibility: EligibilityValues; planTermsPublishedAt? }
appliedFills?: Array<{ entryCommitment; outputCommitment; operationType; patientPayCents; planPayCents;
                       deductibleCreditCents; ndcHash; dateOfService; receiptId; reversedBy? }>;
historyFrom?: string;   // the first nonce from which appliedFills is complete (a recovered device starts later)
refusedUpdates?: Array<{ updateId; check; detail; at; reported: boolean }>;
```

`WalletUpdateRun` (MR:64-69) gains two lists:
- `verified`: entries of `{ updateId, kind, operationType?, amounts?, accumulatorBefore?, accumulatorAfter? }`;
- `refusals`: entries of `{ updateId, check, detail }`.

`refused: string[]` stays for compatibility.

## 3. Sequencer checks

### 3.1 At commit: `L2SequencerService.commitPendingClaim` (replaces seq:1444-1446)

Nothing is stored unless every check passes.
- A proof failure throws `ProofRejected` (`src/l2/l2-proof-verifier.ts:56-61`).
- Every other refusal throws a new `ClaimRefused extends RequestRefused` (`src/l2/request-refused.ts:27`). It carries a `reason`, and its message reads `Claim refused (<reason>): <detail>`.

| # | Check | Refusal reason |
|---|---|---|
| 1 | A fill verifier is installed, and all restored parks have been verified again | `fill-verifier-unavailable` |
| 2 | `treesAuthoritative` is true (seq:185, 3242) | `trees-not-authoritative` |
| 3 | Shape: all values are decimal strings; `claim.memberWalletId == walletId`; the operation type is '1' or '2'; the proof JSON parses, with `publicInput []`, `publicOutput` length 18 and `maxProofsVerified 0` | `malformed` |
| 4 | The wallet is registered, and `lifecycleStateOf` (seq:1460) says eligible or active. A revoked wallet can never prove (`state-transition.ts:280-282`) | `wallet-not-billable` |
| 5 | `expectedNonce ≥ ledger nonce + 1`; when it is exactly the next nonce, `oldInventoryRoot` must equal the ledger root (seq:2127-2138) | `stale-step` |
| 6 | No park already uses this key | `park-exists` |
| 7 | The output commitment is not already used by a park, a landed claim or a cancelled park | `replay` |
| 8 | Decode the outputs (§1.5) and compare. `memberWalletId` equals the wallet. The old and new inventory roots equal the commit's. The operation type, patient pay, plan pay, deductible credit (default '0') and ndcHash equal the claim's. `hashString(claim.ndc)` equals ndcHash when an NDC is given. `prescriptionHash` equals the fulfillment's | `output-mismatch:<field>` |
| 9 | Poseidon over the 7 fulfillment fields equals `entryCommitment`. The claim agrees with the fulfillment on pharmacy, ndcHash, `dateToField(dateOfService)`, `quantityToField(quantityDispensed)`, and, for a fill, `centsToField` of both costs (`src/zkp/hash-utils.ts:49-95`) | `entry-commitment-mismatch` |
| 10 | Fill only: the plan with `hashString(planId) == claim.planIdHash` exists, and its `publishedTerms.formularyRoot` equals the output's `formularyRoot`. The console plan PLAN-GOLD-2026, which has no plan record, is exempt and logged, until F1 removes fixtures | `formulary-mismatch` / `unknown-plan` |
| 11 | Fill only: no active fill with the same duplicate-check key is on the ledger (`claim-accumulator-service.ts:105-110`), and no parked fill has the same key without a later parked reversal of it | `duplicate-fill` |
| 12 | `await fulfillmentVerifier(parsed proof JSON)` (§3.4) | `ProofRejected`: `undecodable`, `invalid` or `timeout` |
| 13 | After that wait, run checks 1, 2, 5, 6 and 7 again | the same reasons |
| 14 | Store the park with state `parked`, record its output commitment, and return the receipt | — |

The cheap checks run first, so a mismatched claim never costs a verification.

**Durability.** `L2Node.commitPendingClaim` then writes a checkpoint under a new trigger, `claim_commit` (`l2-checkpoint.ts:213`; node:1642-1655). If that write fails, it calls `cancelPendingClaim(key, 'checkpoint failed')` and rethrows.

**Cancelling a park.** `cancelPendingClaim(key, reason)` removes the park and keeps `{ key, outputCommitment, reason, at }` in a bounded `cancelledPendingClaims` list that is written to the checkpoint. Three engine paths call it: the rebuild route, termination and a failed fixture submission (§5).

### 3.2 At attach: inside `submitProof` (seq:302-552)

The lookup leaves the RPC handler. In rpc:1019-1028 the handler now forwards only `{ newCredentialInventoryRoot }`. As a result, the RPC path and the in-process fixture path go through the same gate.

| # | Where | Check | Refusal reason | Park |
|---|---|---|---|---|
| A0 | seq:315-321 | The transition proof verifies (A1, unchanged) | `ProofRejected` | unchanged |
| A1 | right after A0 | The caller's metadata holds only `newCredentialInventoryRoot`. A test can lift this with `allowCallerClaimsForTests(calledBy)`, which is loud and test-only, like the accept-all verifier factory (`l2-proof-verifier.ts:170-182`) | `caller-claim` | — |
| A2 | before the duplicate check (seq:326) | For a wallet update (registry root changed, lifecycle root unchanged), look up the park at `wid:(nonce + 1)`, taking the nonce from `walletRegistry.getState` (seq:1625) | — | — |
| A3 | | The park exists, its state is `parked`, and it is not marked `restored` | `park-invalid` / `fill-verifier-unavailable` | unchanged |
| A4 | | `newCredentialInventoryRoot` equals the park's `newInventoryRoot` | `park-mismatch` | unchanged |
| A5 | | The wallet's current root on the ledger equals the park's `oldInventoryRoot` | `start-mismatch` | unchanged |
| A6 | | Reversal only: `hasActiveFill(member, ndc, pharmacy, date, fillNumber)` finds an entry whose `metadata.entryCommitment` and three amounts equal the outputs | `reversal-unmatched` | unchanged |
| A7 | | Build the metadata: the park's claim, plus `newCredentialInventoryRoot`, `entryCommitment` and `fillOutputCommitment` | — | — |
| A8 | seq:326-333 | The duplicate check, unchanged, now on the merged metadata | `DuplicateFillError` | unchanged |
| A9 | seq:340-420 | Fingerprint, partition, roots and `planTreeUpdate`, all unchanged | unchanged | unchanged |
| A10 | before the apply step (seq:414) | Write the proof to the archive (§6). If the write fails, nothing is applied | — | unchanged |
| A11 | seq:498-536 | Append the leaf with `fillOutputCommitment`. In the same synchronous section, delete the park and record its commitment as used | — | removed |

If no park exists for that step, the update lands as an ordinary update with no claim, as it does today.

**Release the proving lease on refusal.** A refusal at A1 through A6 calls `provingLease.release(wid)` before it throws. Today only a landed proof releases the lease (seq:550), so a refused wallet holds it for up to 120 s (`src/l2/proving-lease.ts:80`).

**Message wording.** Refusal messages must not match the phone's retry pattern, `root mismatch|does not match the sequencer tree|state changed while` (MR:170). If they do, the phone retries a final refusal four times.

### 3.3 Error mapping and status

- `ClaimRefused` reaches RPC callers through the existing `RequestRefused` branch (rpc:977-979, code -32004).
- `ProofRejected` reaches them through rpc:980-981 (code -32001).
- `l2_getStatus` adds `verifierKeys: { transition: { vkHash, pinned }, fulfillment: { vkHash, ready, envAsserted } }` and `pendingClaims: { count, oldestCommittedAt }`. Neither contains a wallet ID.

### 3.4 Installing the fill verifier

**Worker (VW).** The compile message gains a program: `{ type: 'compile'; program: 'StateTransition' | 'AccumulatorFulfillment'; expectedVkHash? }` (VW:39-49).
- For AccumulatorFulfillment the worker does not compile. It reads the committed key file and requires `hash === expectedVkHash` and `await VerificationKey.checkValidity(...)`. It then keeps the key data and answers `ready`.
- Verification stays `verify(proofJson, data)` (VW:80-98).
- StateTransition keeps compiling, as today (VW:57-77).

**Pool (VP).** The pool gains a `program` option and `asJsonVerifier()`, beside `asVerifier` (VP:145-155).

**Verifier helpers.** `l2-proof-verifier.ts` gains the type `FulfillmentProofVerifier = (proofJson: unknown) => Promise<void>` and `createAcceptAllFulfillmentVerifierForTests(calledBy)`.

**Sequencer.** The sequencer gains `setFulfillmentVerifier`, `hasFulfillmentVerifier` and `reverifyRestoredParks()`. The last one marks any park that fails `invalid` and logs it.

**Launcher.** Add a block after A1's block (start:247-306). In order:
1. Refuse if the environment pin differs from the constant.
2. Create `new VerifyPool({ program: 'AccumulatorFulfillment', size: ZKTRIDENT_FILL_VERIFY_POOL_SIZE ?? 1, expectedVkHash: FULFILLMENT_VK_HASH, recycleAfterJobs: 0 })`.
3. Await `start()`.
4. Self-test against the fixture. A missing fixture refuses the boot (A1 only warns, at start:291).
5. Call `setFulfillmentVerifier`, then await `reverifyRestoredParks()`.
6. Print `[verify:fill] verification key matches the pinned hash …`.

Any failure refuses the boot. Loading a key takes seconds, against the 2-3 minute compile (`tests/plan-republish-limits-proof.test.ts:18-19`), so blocking the boot costs nothing.

**A prerequisite fix in VP, which A1 also needs.**
- Planned recycles count as restarts. `maybeRecycle` (VP:293-300) leads to the exit handler (VP:272), which calls `replaceWorker` (VP:302-325), which increments `restarts` at :318 and never resets it.
- With the defaults (recycle after 50 jobs, at most 5 restarts; VP:101-103), today's transition verifier stops after about 300 verifications. Every submission after that is refused until the sequencer restarts.
- A queued job that times out calls `replaceWorker(-1)` (VP:169, 173), which spawns an extra worker.

The fix: mark a worker as `recycling` and replace it without counting it as a restart, and skip `replaceWorker` when `workerId < 0`.

## 4. Phone checks

### 4.1 Key, pin and verifier

**Pin.** The pin is `FULFILLMENT_VK_HASH`, built into the member app. The key data comes from the committed file, and the optional environment assertion works as in §1.6. The pin never comes from the engine, the sequencer or enrollment, because the operator who makes the proof must not also choose the key that checks it.

**Where verification runs.** The member node verifies in a child process using the same VP and VW code, with size 1 and no recycling. Verifying inside the node's own process, after its three compiles (`src/nodes/member-node.ts:75-100`), has never been measured, and A1 hit permanent stalls in an o1js context that had already been used.

**New file.** `src/nodes/member-fill-verifier.ts` starts that verifier at the end of `/onboarding/compile` (MR:883-919), or lazily after a restart, and self-tests the fixture with a 20 s timeout (`l2-proof-verifier.ts:54`). Until the self-test passes, money updates are deferred as errors, not refused.

### 4.2 Order of checks for each update

All of these run inside `runWalletUpdates`, before the proving lease is taken (MR:149). They live in a new pure function, `checkWalletUpdate(prev, update, ctx)`, in `src/credentials/wallet-update-check.ts`, which imports only Field, Poseidon, MerkleTree and the output module. The engine runs the same function before it queues anything (§5.3).

| # | Check | On failure |
|---|---|---|
| P1 | The parts rebuild `newInventoryRoot` (today's check, MR:122-135) | refuse `parts-mismatch` |
| P2 | If the live nonce already equals `expectedNonce` and the live root equals the new root, the update has already landed. Take the newest receipt from `l2_getReceiptsByWallet`, report it and save the parts | — |
| P3 | The live nonce + 1 equals `expectedNonce`, and the live root equals `oldInventoryRoot` (MR:144-147). If the live nonce is lower, retry later; if it is higher or the root differs, refuse | refuse `step-mismatch` |
| P4 | Chain: the previous inventory root equals `oldInventoryRoot`. For the first update, there is no previous state, `oldInventoryRoot` is the empty height-7 root (`wallet-state.ts:23, 66-74`) and `expectedNonce` is '1' | refuse `chain-break` |
| P5 | Compute the difference between the previous and new leaves (by domain and index) and credential fields | — |
| P6 | Poseidon of `accumulator.after` equals the new leaf (4,127); Poseidon of `eligibility.after` equals the new leaf (4,0); `before` equals the device's stored `after` and hashes to the previous leaves | refuse `preimage-mismatch` |
| P7 | Classify the update by what changed (§4.3, §4.4). Anything else, such as two kinds at once, a removed leaf or an unexplained credential field change, is refused | refuse `unclassified-change` |
| P8 | Apply the rule for that kind | refuse with the rule's code |
| P9 | Prove, submit and report, as today (MR:136-197) | |
| P10 | Save the parts, accumulator, eligibility and nonce; add to `appliedFills`; add a `verified` entry | |

### 4.3 Fill and reversal updates

These are updates where leaf (4,127) changed and only its three paid totals moved.

| # | Check | Code |
|---|---|---|
| F1 | `update.fill` is present and `claimCommitted` is true | `fill-missing` |
| F2 | Find the park whose key equals `fill.parkKey`. Its wallet, nonce and roots equal the update's, and its output commitment equals `fill.outputCommitment` and `fillOutputCommitment(publicOutput)` | `park-missing` / `park-mismatch` |
| F3 | The proof JSON has `publicInput []`, `maxProofsVerified 0` and the park's 18 outputs; the park's `vkHash` equals the pin | `fill-malformed` |
| F4 | The proof verifies in the child process against the pinned key. A timeout is an error and is retried | `fill-proof-invalid` |
| F5 | The decoded wallet is this device's own. The old inventory root equals the previous root and `oldInventoryRoot`. The new inventory root equals `newInventoryRoot`. `newEligibilityForestRoot` equals the rebuilt forest root (WU:146-157) | `fill-roots` |
| F6 | The old and new accumulator commitments equal Poseidon(before) and Poseidon(after), and equal the previous and new leaf (4,127) | `fill-accumulator` |
| F7 | **The totals check** (see below) | `fill-totals` |
| F8 | The money agrees. The park's claim amounts, operation type and ndcHash equal the outputs. Poseidon of the park's fulfillment equals `entryCommitment`. The claim agrees with the fulfillment as in §3.1 check 9. For a fill, patient pay + plan pay = ingredient + fee. The deductible credit is no more than patient pay | `fill-money` |
| F9 | Only leaf (4,127) changed, and the credential fields are unchanged | `fill-scope` |
| F10 | Reversal only: the entry commitment matches an `appliedFills` entry that has not been reversed and has the same three amounts. For fills before `historyFrom`, match the member's own landed fill claim instead (`l2_getClaimsByMember`, a self-read) | `reversal-unknown` |
| F11 | `familyRule` is between 0 and 4 and is shown to the member. Family totals are not checked (D4) | `fill-malformed` |

**The totals check (F7)** uses BigInt arithmetic, independently of the circuit:
- The plan year and all three limits are unchanged.
- For a fill:
  - deductible paid after = before + deductible credit;
  - out-of-pocket paid after = before + patient pay;
  - benefit used after = before + plan pay.
- For a reversal: each total becomes max(0, before − amount). If the original fill falls outside the current plan year, the totals stay unchanged (§1.4).

### 4.4 Updates without a fill proof

Money means a change to leaf (4,127), the accumulator, or leaf (4,0), which holds the copay, formulary and network. Every other kind of update keeps today's root check (P1-P6) and must leave those two leaves and the credential fields untouched.

| Kind (by what changed) | Rule | Code |
|---|---|---|
| **Mint** (no previous state) | The update has the first-update form from P4. Credential type '1'. Subject is this device's wallet. Issuer is `INSURER_ISSUER_WALLET_ID`, a new shared constant (today `hashString('ADMIN-INSURER-2026')`, S:813). Revoked '0'. Exactly two leaves, (4,0) and (4,127). Eligibility: `planIdHash` equals the enrollment's and equals `hashString(planTerms.planId)`; `groupIdHash` equals the enrollment's; copay, coverage type, formulary root and network root equal the published version named by `planTerms` (`l2_getPublishedTerms`). Accumulator: paid totals 0, limits as published, plan year = `currentPlanYearStart(today, planYearStart ?? '0101')` | `mint-*` |
| **Plan binding** ((4,0) and/or (4,127), limits only) | Leaf 127: the plan year and paid totals are unchanged, and the limits equal the published version named by `planTerms`. Leaf 0: `planIdHash`, `groupIdHash` and the effective and termination dates are unchanged, and the four terms equal the published ones. `planTerms.publishedAt` is not older than the version the device already holds | `binding-*` |
| **Rollover** ((4,127) with the plan year changed) | New plan year = old plan year + 10000. Paid totals are 0. Limits are unchanged. Nothing else changed. Today (device clock, CCYYMMDD) is on or after the new plan year. Up to 2 days early is deferred as an error; earlier than that is refused | `rollover-*` |
| **Prior authorization** | Exactly one ACCESS_CONTROL leaf is added, at an index from 1 to 126 that was empty before | `pa-*` |
| **Primary-care choice** | Only MEMBER leaf 0 changed, and it equals the commitment the device saved when the member chose (MR:1323-1338) | `pcp-*` |
| **Console formulary or network** ((4,0) only, plan not on the sequencer) | Root check only, logged as "unchecked: console formulary"; this disappears with F1. A plan that is on the sequencer goes through the plan-binding rule instead | — |
| **Termination** | Can never be proved, because the wallet is REVOKED; no rule is needed | — |

**Published plan versions.** `l2_getPublishedTerms { planId, publishedAt }` is an open read that returns that exact version, either the current `publishedTerms` or an entry in `publishedHistory`. The sequencer's `storePlan` (seq:1857-1859) maintains that history itself: when `publishedAt` changes it saves the previous version, ignores any history the client sends, and keeps 32 versions. Without this, an insurer republishing between queueing and checking would turn into a refusal.

### 4.5 What the phone does when a check fails

- **Refusal** (a check failed):
  - do not take the lease, prove or submit;
  - save the refusal to `refusedUpdates`;
  - report it with `POST /interactive/wallet-update-refused`;
  - stop the pass, because later updates are chained on this one (S:2273). Later passes skip the queue while the same update is at its head.
  - A sequencer answer starting `Claim refused (` is handled the same way, with the check `sequencer:<reason>`.
- **Error** (transient): network failures, a verifier that is not ready or timed out, a park that is not visible yet, or a rollover at most 2 days early. These go into today's `errors` list and are retried on the next 20 s pass (`src/nodes/start-member-nautilus.ts:123-129`).

### 4.6 A recovered device

`/onboarding/recover` saves only the wallet, the identity fields and the enrollment (MR:819-828). With no saved parts, the device adopts `lastApplied` as its starting point only if two things hold:
- its parts rebuild the ledger's current root;
- its preimages hash to leaves (4,0) and (4,127).

It then sets `historyFrom` to the current ledger nonce. The device cannot re-check fills from before that point, and the app should say so.

## 5. Engine changes (S unless noted)

### 5.1 Dispense (3844-4443)

1. Add the new arguments from §1.2 to the dispatch at 4084-4089, and store the family salt in FulfillmentState.
2. Keep `fillProofJson = fulfillDispatch.proofJson` (4094). If there is no proof, fail with nothing changed.
3. Before any change, beside the existing A-35 check (4148-4153), refuse with 409 when:
   - the output's `memberWalletId` is not the member;
   - the old inventory root differs from `chainHead(wallet).root` (the last pending update's new root, or `enrolled.credentialInventoryRoot`) or from `enrolled.credentialInventory.getRoot()`;
   - either accumulator commitment differs from `enrolled.accumulatorData` before the fill, or from `newAccumulator` after it;
   - the service date is outside the plan year (§1.4).

   Remove the fallbacks that substitute engine values for missing outputs, at 4247 and 4260.
4. Wrap 4210-4274 the way the reversal is wrapped (4649-4652 and 4690-4699). Save the accumulator, leaf 127, the credential, inventory slot 0, and the two prescription TRANSACTION leaves written at 4030 and 4222. If the ledger step fails, restore all of them and rethrow. Today a failed ledger step leaves the engine's record one fill ahead of the ledger.
5. Pass `{ proofJson, output, fulfillment }` through `updateCredentialAndSubmitToL2` (6436-6459) to `queueClaimWalletUpdate` (§5.3). The fulfillment preimage comes from `fulfillmentData` (4048-4056).
6. Update the console text at 4071, 4109 and 4119.

### 5.2 Reversal (4546-4720)

Apply the same items 1, 2, 3 and 5 to the reversal dispatch (4613-4618) and its output (4623). The save-and-restore around the ledger step already exists (4649-4652 and 4690-4699). In addition:
- The commit's fulfillment is `fillToReverse.fulfillmentData`, converted with `toJSON`.
- `reversalDate` becomes today's service date. It is hard-coded to '20260203' at 4588.
- The new accumulator follows the plan-year rule in §1.4.

### 5.3 Queueing (2270-2295)

- **`buildWalletUpdatePayload`** builds today's payload, plus:
  - `expectedNonce`: the last pending update's nonce + 1, or the live ledger nonce + 1 when nothing is pending;
  - the `before` and `after` preimages;
  - `planTerms`.

  It then runs today's rebuild check (2286-2289) and `checkWalletUpdate(prev, payload, engineCtx)`, with the engine's own context: the published terms it used, today's date, the member's hashes, the primary-care commitment it wrote, and its own fill output marked as made by the engine. The engine therefore never queues an update the phone would refuse.
- **`queueWalletUpdate`** stays synchronous and is used for updates without a claim. Its call sites are unchanged: 1338, 2606, 3000, 2369, 5970, 5678, 5873, and 6458.
- **`queueClaimWalletUpdate`** is new and asynchronous, used for fills and reversals. In order, it:
  1. builds the payload;
  2. checks that `newCredentialInventoryRoot` equals the output's;
  3. awaits `this.l2Node.commitPendingClaim(...)`;
  4. inserts the pending update with `fill: { operationType, parkKey, outputCommitment }`;
  5. saves the engine state through the existing hook (start:507-530).

  If the commit is refused, nothing is inserted.

### 5.4 Marking an update applied (2302-2326)

For an update whose claim was committed, two things must hold:
- the receipt carries `claimLeafIndex` (set at seq:535);
- the claim entry's `fillOutputCommitment` equals `update.fill.outputCommitment`.

Otherwise the engine blocks the member with the reason `claim-not-landed` (§5.8) and answers 409.

### 5.5 Fixture members (6336-6429)

When a fixture member's update carries a claim, `submitWalletUpdate`:
1. commits the park first, with `expectedNonce` = ledger nonce + 1, `oldInventoryRoot` = the ledger root and an update ID of the form `fx-<uuid>`;
2. proves and submits with only `newCredentialInventoryRoot` (6406-6416).

If the submission fails for any reason other than contention, it cancels the park and rethrows. Retries after contention keep the same nonce and the same park.

### 5.6 Updates that carry no fill proof

- **Plan binding** (1303-1339): add `planTerms = { planId, publishedAt: publishedTermsOf(plan).publishedAt }`.
- **Mint** (2450-2619):
  - the plan year becomes `currentPlanYearStart(today, planYearStart)` instead of the hard-coded '20260101' (2509);
  - add `planTerms`;
  - the issuer comes from the shared constant.

  `currentPlanYearStart` is a new plain-TypeScript helper in `src/l2/plan-terms.ts`.
- **Rollover** (5932-5996, route R:1543-1554):
  - The input becomes `{ newPlanYear, planId? }`.
  - Answer 400 unless the date is CCYYMMDD, and 409 if the date is in the future.
  - For each member that is not revoked or blocked, and is on the named plan if one is given, skip the member unless the new year is its plan year + 10000 and the date matches the plan's renewal day.
  - Return the list of members rolled over and the list skipped, with reasons.
- **New plan field:** `planYearStart?: string` (MMDD, default '0101') on `BenefitPlanConfig` and `PublishedPlanTerms` (`src/l2/l2-types.ts:344-404`). `publishedTermsFrom` (`src/l2/plan-terms.ts:40-60`) copies it, and `planStoreError` refuses 0229.
- **Prior authorization** (2919-3000): refuse with 409 when the next PA leaf index would reach 127 (2935-2936). Today the 127th approved prior authorization overwrites the accumulator.
- **Console formulary add path** (1161-1176): queue one 'formulary' update for each affected member who has a device. Today this path changes their credential without queuing anything.
- **Termination** (5343-5420): before the admin change, cancel every pending update of the member, cancelling the parks of those that carry claims. Mark the fills whose claims were cancelled as `settlement: 'cancelled-at-termination'`; FulfillmentState gains `walletUpdateId` and `settlement` for this. Return those fills in the result (D7).

### 5.7 Locks and races

Run three routes under `withProvingLock`:
- `/interactive/pcp-assignment` (R:413-432);
- `/interactive/terminate-member` (R:1249-1271);
- `/interactive/terminate-group`.

Today these routes do not take the lock. A primary-care choice made during a fill's 25-45 s proof (S:4084) puts a leaf the proof never saw into the queued update. A termination during that window flips `revoked` (5388-5396) into the fill's credential (4241). With check 3 of §5.1, such a fill would be refused; the lock stops the race from happening at all.

### 5.8 Refusal, block and rebuild

- **Marking a refusal.** `markWalletUpdateRefused` marks the update refused and sets `enrolled.walletUpdateBlock = { updateId, check, detail, at }`, which is saved with the engine state. While a member is blocked:
  - prescribing, filling, reversing, approving a prior authorization and choosing a primary-care prescriber answer 409 and name the block;
  - the yearly rollover skips the member.
- **Rebuild route.** `POST /interactive/wallet-updates/rebuild { walletId }` needs admin rights and runs under the proving lock. It:
  1. cancels the wallet's pending updates, newest first, cancelling the parks of those that carry claims;
  2. restores the forest, the credential, inventory slot 0, the accumulator and the eligibility data from the last applied update's preimages;
  3. recomputes the next prior-authorization leaf index from the leaves;
  4. marks fills whose claims were cancelled `settlement: 'cancelled'`;
  5. clears the block;
  6. returns the list for the claims team.

### 5.9 Checking the queue against the parks at boot

After the engine state is restored (start:494-503), check both directions:
- every pending update with a committed claim has a park with the same key and roots;
- every park has its pending update.

Any mismatch blocks the member with `park-missing` or `update-missing` and is logged.

### 5.10 Readiness

`isClaimReady()` is true only when all three hold:
- `isProvingReady()` (1514-1516) is true;
- the sequencer has a fill verifier;
- the engine's compiled fill key equals the pin.

Until it is true, `/interactive/fill`, `/interactive/reverse` and `/interactive/prescribe-and-fill` answer 503, using the existing pattern (R:218-228).

## 6. Persistence and replication

| What | Where it lives | How long |
|---|---|---|
| Fill proof JSON (about 30 KB) | In the park record, in memory and in every checkpoint. Checkpoints are written after each batch (node:1409-1410, 1539-1540; 10 are kept) and at each commit, and are included in `l2_requestSnapshot` (rpc:2552) | from commit until attach |
| Archived proof | `<checkpointDir>/fill-proofs/<outputCommitment>.json`, written atomically at step A10. Read it with the new `l2_getFillProof { leafIndex }`, gated like the claim read: `{ subject: 'leaf', param: 'leafIndex', readers: ['self'] }`. `clean:state` removes it | kept for good (D6) |
| Link from the ledger to the proof | `fillOutputCommitment` in the claim leaf and in the audit commitment | permanent |
| Used-proof set | Parks, plus landed leaves (rebuilt from the claim entries on restore), plus cancelled parks | permanent |
| Wallet states | A new `walletStates: Array<{ walletId, index, credentialInventoryRoot, nonce }>` in the checkpoint, taken from the registry (`WalletRegistry` gains `entries()`). Restore (seq:3216-3245) registers wallets in index order, applies their states, and requires the trees to match the published roots | permanent |
| Engine side | Pending updates with their preimages and output commitment; FulfillmentState with the family salt and settlement status. Never a proof | the engine's state file |

**Wallet states must be saved first.** Today `exportState` saves only registrations and lifecycle states (seq:3011-3027), and restore rebuilds every wallet as empty (seq:3216-3240). After any restart:
- `treesAuthoritative` is false (seq:3242-3245);
- the start-root checks (§3.1 check 5 and step A5) cannot work;
- the phone is told the empty root.

Saving wallet states closes the wallet-state half of A-25. While the trees are not authoritative, both commit and attach refuse.

**Restore.** Restore marks every park `restored`. The launcher verifies them again before accepting claims (§3.4). Parks in the old format refuse the boot (§1.6).

**Gossip.**
- Parks are not gossiped, so a leader failover loses them until phase E (D9).
- The claim entry sent with `proof:accepted` must be the receipt's own leaf. Today node:566-568 sends the member's latest claim whenever metadata is present. Every device update carries metadata (rpc:1016-1018), so a primary-care, prior-authorization or rollover update resends the previous claim. A replica then appends a reversal twice and its claim root drifts; for a fill, the `DuplicateFillError` is swallowed at node:976.
- The fix is to send `receipt.claimLeafIndex !== undefined ? seq.getClaimEntry(receipt.claimLeafIndex) : undefined`.

**WAL.** The write-ahead log is off today (seq:252). When phase E3 turns it on, add entry types `claim_commit` and `claim_cancel`. A proof entry's claim data (seq:398) already carries the commitment. Replay must refuse a claim whose archive file is missing.

## 7. Tests

### 7.1 Acceptance tests that must fail on today's code

**Slow tests.** Each goes in its own file, outside the regression batch, and never beside a LocalBlockchain test.

1. **`tests/fill-proof-outputs.test.ts`** compiles and proves real fills and reversals.
   - Outputs 12-17 equal values computed outside the circuit.
   - The family commitment includes the salt.
   - Proving throws in four cases: an accumulator planted at leaf 126 with its witness, an inventory witness for slot 1, EligibilityData with a different formulary root, and a service date outside the plan year.
   - For a reversal, the outputs and index assertions hold, and a reversal of a prior-year fill leaves the totals unchanged.

   *Fails today because* none of these fields exist and every one of those proofs succeeds.
2. **`tests/fulfillment-vk-pin.test.ts`** compiles and checks that the hash equals the constant and the data equals the committed file. *Fails today because* there is no pin.
3. **`tests/fulfillment-vk-verify.test.ts`** verifies only, with no compile. It runs `checkValidity`, verifies the fixture with the key data, and checks that a copy with patient pay + 1 fails. *Fails today because* there is no fixture and no key file.

**Fast tests:**

4. **`tests/verify-pool-restarts.test.ts`**, using a stub worker script.
   - 400 verifications with `recycleAfterJobs: 2` and `maxRestarts: 1` all succeed.
   - A queued job that times out spawns no worker.
   - A key file whose hash differs is refused.

   *Fails today because* the pool dies after (maxRestarts + 1) × recycle jobs.
5. **`tests/pending-claim-commit.test.ts`**, using the `Reference` model and mock proofs of `tests/registry-consistency.test.ts:44-73` with a stub fill verifier. Each refusal in §3.1, taken one at a time, leaves the park count and the exported state unchanged, and an honest commit parks. *Fails today because* commit is a synchronous `Map.set` that takes no proof.
6. **`tests/pending-claim-attach.test.ts`:**
   - An honest fill attaches: the leaf and the audit commitment carry the commitment, the park is gone and the proof is archived.
   - A proof reaching a different root gives `park-mismatch`, changes nothing (roots, receipts, audit length, claim count and fingerprints are compared) and releases the lease.
   - `start-mismatch` and `caller-claim` are refused.
   - A fill, its reversal and an identical refill all land with their own amounts.
   - A reversal with no matching fill is refused (`reversal-unmatched`).
   - A park restored from a checkpoint attaches only after `reverifyRestoredParks`.
   - Wallet states survive export and restore, and `treesAuthoritative` stays true.

   *Fails today on* every case.
7. **`tests/claim-entry-gossip.test.ts`**, or an extension of `tests/claim09-gossip-propagation.test.ts`. After a fill, a reversal and a primary-care update, the gossiped entry is the receipt's own leaf and the replica's claim root equals the leader's. *Fails today because* the primary-care update resends the previous claim.
8. **`tests/engine-fill-proof-kept.test.ts`.** An honest stand-in proof is built with `rawMethods` and wrapped by a test helper, `fakeFillProofJson(publicOutput)`.
   - `commitPendingClaim` receives the proof JSON and the fulfillment preimage.
   - `JSON.stringify(exportState())` contains no proof.
   - Each mismatch in §5.1 check 3 gives 409 with nothing changed.
   - A refused commit restores the full record and queues nothing.
   - A plan binding followed by a fill get consecutive nonces.
   - The payload's before and after totals equal the fill result's.
   - The same holds for a reversal.

   *Fails today because* the proof is discarded.
9. **`tests/engine-wallet-locks.test.ts`.**
   - A primary-care choice and a termination wait for a fill that holds the lock.
   - A prior authorization at leaf 127 is refused with 409.
   - A rollover that is in the future or not the member's next year is refused or skipped.

   *Fails today because* none of these rules exist.
10. **`tests/wallet-update-check.test.ts`**, a pure test. The honest version of each update is accepted, and every rule in §4.2-4.4 refuses when broken on its own. *Fails today because* the function does not exist.
11. **`tests/member-wallet-update-loop.test.ts`** runs `runWalletUpdates` against a fake engine and a fake L2Client.
    - A refused update is not proved or submitted; it is reported and saved, and later updates are untouched.
    - An update that landed but was never reported is reported again.
    - A sequencer `Claim refused` answer is treated as a refusal, not retried.

    *Fails today because* there is no behavioral test of this loop: `tests/pcp-via-queue.test.ts:125-136` and `tests/proving-budget.test.ts:96` only read source text.
12. **`tests/wallet-update-refused-route.test.ts`.** Only the wallet's own signature opens the route. It blocks fill, prescribing and prior authorization with 409, and the rebuild route cancels the parks and restores the record. *Fails today because* neither route exists.

### 7.2 Existing tests to update

- **`tests/accumulator.test.ts`:**
  - the 10-field Struct test (314-332) becomes an 18-field test;
  - the family formula check (830) adds the salt;
  - `setupDualCredentialScenario` (166-252) puts EligibilityData at leaf 0, with the formulary root equal to the registry root;
  - every circuit call (535-1010) gets the new arguments.
- **Other direct circuit callers** need the new arguments: `tests/plan-republish-limits-proof.test.ts` (88-125), `tests/benchmark.test.ts` (566-567), `tests/production-showcase.test.ts` (704) and `tests/pricing-claim-split.test.ts` (168). The first also asserts that the output inventory roots equal the engine's payload roots.
- **`tests/proof-pool-table.test.ts`:** the counts follow automatically; add a check of the appended type names.
- **`tests/pending-claims.test.ts`:** rewrite for the record API.
- **`tests/reversal-ledger.test.ts`:** the stand-in returns proof JSON and all outputs, and the mock at 160-169 becomes asynchronous.
- **Stubs that return `proofJson: null`** must return `fakeFillProofJson(...)`, and their sequencers get the accept-all fill verifier. These are `tests/plan-republish-limits.test.ts:131-137`, `member-cost-quote.test.ts:131-139`, `quantity-units.test.ts:94-101`, and the other `dispatchProof` stubs (15 files at HEAD match `dispatchProof`).
- **Suites that pass claim metadata straight to `submitProof`** call `seq.allowCallerClaimsForTests(<file>)`: claim-accumulator-integration, money-agrees, production-showcase, wallet-migration and claim09.
- **`tests/engine-plan-formulary.test.ts:275-281`** checks only the start of the type list, so appending keeps it passing.
- **Other suites:**
  - `tests/l2-checkpoint.test.ts`: wallet states and park records round-trip, and version 1 is refused;
  - `tests/wallet-update-payload.test.ts`: new payload fields;
  - `tests/engine-preimage-free.test.ts` (114-146): the refused route;
  - `tests/engine-ready-route.test.ts`: claim readiness.
- **`scripts/dev/regression-suites.txt`:** add tests 4 to 12.

### 7.3 Live harness

- **`run.ts` section 8** (640-757). After each device finalizes (740-750), assert:
  - `fin.verified` holds the fill, with amounts equal to `r.adjudication` and totals after equal to `r.accumulator.after`;
  - the leaf's commitment matches;
  - the archived proof verifies locally against the committed key;
  - the entry commitment recomputes from the claim metadata.

  Then add three new steps:
  - a reversal through the device, with floored totals; neither `run.ts` nor `run-multi.ts` reverses anything today;
  - a plan republish that triggers a binding;
  - as the last step, a rollover to next year, which the device must refuse as too early while the ledger stays unchanged.
- **`run-multi.ts`** (270-372): the same checks for each member, plus one family fill that shows its family rule.
- **New `scripts/e2e-verify/check-fill-proofs.ts`**, safe to run on a live network with the operator token. For every claim leaf it checks that:
  - the archived proof verifies;
  - Poseidon(outputs) equals the leaf's commitment;
  - the outputs equal the leaf's amounts;
  - a tampered copy fails.

  A live test of commit refusals needs the RPC that R3 will add.
- **`scripts/e2e-verify/measure-verify.ts`:** time fill verification from key data, cold and warm, and time `checkValidity`.

## 8. Order of work

Each step is one review. It keeps the regression batch green and leaves a network that boots and passes the harness.

| Step | What it contains | Why the system still works | How to verify |
|---|---|---|---|
| **1. Prerequisites** (about 0.5 session) | The VP restart fix; wallet states in checkpoints; gossip sending the receipt's own claim entry; locks on the primary-care and termination routes; the prior-authorization cap; the console add path queuing; the fill rollback | No format or behavior change for honest flows | Tests 4 and 7, parts of 6, 8 and 9, and the harness |
| **2. Circuit and pins** (about 0.75) | §1.1-1.7; the engine reads the new outputs and runs §5.1 check 3; the engine compares its key | Claims are still committed the old way; needs a clean boot | Tests 1-3, the accumulator suites, and the harness from a clean state |
| **3. Sequencer fill verifier** (about 0.25) | §3.4; the new status fields | The verifier is installed but not yet used | Boot log, status, test 4 |
| **4a. Verified commit** (about 0.5) | §2.1, §2.2, §3.1; the checkpoint at commit; `queueClaimWalletUpdate`; nonces and preimages in the payload; the applied-update check; claim readiness; the RPC handler looks parks up by wallet and nonce, with the root checks | Phones ignore the new payload fields | Tests 5 and 8, and the harness |
| **4b. One gate at attach** (about 0.5) | §3.2 moves into `submitProof`; caller claims refused; fixture members commit first; the lease is released on refusal | Fixture members and devices both go through parks | Test 6, the suites with the test-only opt-in, and the harness |
| **5. Ledger links** (about 0.5) | §2.6; reversal matching; rebuilding the used-proof set; the archive and `l2_getFillProof`; `l2_getPendingClaims`; `l2_getPublishedTerms` with history | Needs a clean boot for the new leaf format | The rest of test 6; `check-fill-proofs` |
| **6. Phone** (about 1) | §4.1-4.6; the refusal route and block; `lastApplied`; the engine runs the same check before queuing; the mint plan-year helper; the issuer constant; the engine's rollover date checks | Honest updates pass both copies of the check | Tests 10-12; the harness with device verification |
| **7. Kinds and operations** (about 0.5) | `planYearStart`; per-plan rollover; the termination policy; the rebuild route; the boot cross-check | Every refusal now has an operator path | Tests 9 and 12; the harness's rollover refusal |
| **8. Harness and documents** (about 0.5) | §7.3, plus the documents listed below | — | The full regression batch, plus single-member and multi-member runs |

**Documents for step 8:**
- `docs/CODEMAP.md`, plus `docs/codemap/zk-programs.md` (:99, :132), `engine.md` and `sequencer-core.md`.
- `docs/AUDIT.md`: the money half of A-22 is closed. New findings to enter after A-77:
  - the verify pool stops after about 300 verifications;
  - gossip resends the previous claim;
  - a 127th prior authorization overwrites the accumulator;
  - the primary-care and termination routes are unlocked;
  - the pending-claim key collides;
  - a failed fill ledger step is not rolled back;
  - the console add path queues nothing;
  - a prior-year reversal subtracts from this year's totals;
  - the reversal date is hard-coded.
- `scripts/dev/live-env.example.sh` and `scripts/dev/README.md`: the two pin variables.
- `tools/demo/lib/equations.mjs`: the A-22 note and the "12 outputs" text.

**Total: about 5 sessions.** The review's 1.5 to 2 sessions left out steps 1, 4b and 7, and the rules for updates without a fill proof.

## 9. Risks and decisions for the owner

### Risks

1. **A refusal stalls the member's queue.** One refused or unproved update blocks every later update and claim for that member, including the yearly reset (owner-decisions-review.md:305). The engine running the same check before queuing makes honest refusals rare, and the block plus the rebuild route (§5.8) are the way out. Both depend on D2.
2. **False refusals freeze a member's benefit.** Three sources, each with a partial mitigation:
   - clock skew, softened by the 2-day deferral window;
   - a republish race, softened by keeping published versions;
   - a bug in either copy of the check.
3. **Family pooling is still unchecked.** Neither the sequencer nor the phone can check the family totals or family limits (owner-decisions-review.md:308). "Caught twice" holds for the member's own totals, the copay and formulary, the drug, quantity and price inputs, and the roots. It does not hold for family pooling, and the trust claims must say so.
4. **The prescriber and pharmacy halves of A-22 remain with B4.**
   - The prescriber is not bound to the claim (S:4250).
   - The pharmacy's identity is proved from fixture preimages held by the engine (AFP:166-176; S:3881).
   - B4 must split this circuit (owner-decisions-review.md:298), which changes the key again.
5. **Parks can be lost.** A park is lost on leader failover, and it relies on the checkpoint written at commit, while the engine saves its own file separately (start:507-530). The boot cross-check detects the gap; phase E3 closes it.
6. **A wallet nonce that moves outside the queue breaks the parks for that wallet.** For example, a device can prove a root of its own making, which `planTreeUpdate` accepts today (seq:1616-1631). This shows up as `park-mismatch` or `claim-not-landed` and blocks only that member.
7. **Storage.** Each park adds about 30 KB to every checkpoint (10 are kept) and every snapshot. Each archived claim adds about 30 KB: about 30 GB per million claims.
8. **Memory.** There is one more verifier child process on the sequencer and on each member node. The RAM sizing in start:308-340 counts neither.
9. **2027.** The mint's hard-coded plan year '20260101' (S:2509) fails the phone's mint rule from 2027 onward unless step 6's helper ships with the phone rules.
10. **Plans are stored unsigned** (rpc:1539-1551). The phone therefore checks the engine against the operator's own sequencer, not against the insurer.

### Decisions for the owner

The default is what this spec builds if no other answer comes.

| # | Question | Default |
|---|---|---|
| D1 | When does a park expire, and when is the pharmacy paid? (B3; owner-decisions-review.md:316) | No automatic expiry; parks older than 30 days show in `l2_getStatus` |
| D2 | What follows a phone's refusal? | The member's money operations freeze, the operator runs the rebuild, and fills whose claims were cancelled go to the claims team |
| D3 | Is a key built into the app the only key source? | Yes. Never supplied by the engine or the sequencer |
| D4 | Send family totals to each member's phone? | No, because it discloses family spending, for example to an adult dependent. The family commitment is blinded with a salt |
| D5 | Add the two plan-year rules (§1.4) to the circuit? | Yes, in this key change |
| D6 | Keep proofs after their claims land? | Archive them forever |
| D7 | What happens to a terminated member's pending claims? | Cancel them at termination and list the fills. The alternative is to refuse termination until they land |
| D8 | How is the start of the plan year defined? | `planYearStart` as MMDD, set by the insurer, default 0101; rollover runs per plan |
| D9 | Gossip parks to replicas now (about 30 KB per message)? | No, wait for phase E |
| D10 | Should the sequencer also check the price: the fee against the published fee, and the ingredient cost against NADAC × quantity? | No, leave it to B3 |
| D11 | Publish the three family limits in the clear so the sequencer can check them? | No |
| D12 | Have the insurer sign published plan terms? | Later |
| D13 | Do B4's circuit split before the production genesis, so the production key changes only once? | Recommended |
| D14 | Should fixture members go through the same gate until F1? | Yes |
| D15 | Exempt the console plan from the sequencer's formulary check until F1? | Yes |
| D16 | Require `ZKTRIDENT_TRANSITION_VK_HASH` in production (engine-review.md:89)? | Unchanged (warn only), but add it to `live-env.example.sh` |
| D17 | Remove the member's year-to-date totals from the pharmacy's fill result (S:4377-4397)? | Later, because the harness reads them |

## Corrections to the maps

- Neither `run.ts` nor `run-multi.ts` reverses a fill, rolls over a plan year or republishes a plan. One map says `run.ts` covers reversals at 724-856; it does not.
- `dispatchProof` appears in 15 test files, not 12. Not all of them stub fill proofs.
- The VK self-test fixture has no generating script today. The state-transition fixture was made by hand; `pin-circuit-keys.ts` could regenerate it too.