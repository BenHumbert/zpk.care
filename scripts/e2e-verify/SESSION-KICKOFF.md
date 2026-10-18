# zpk.care: review and hardening kickoff

Paste this after the persona prompt at the start of each new session. It sets the goals, the rules for keeping token use low, and what is already done, so nothing gets re-derived.

## Cost rules (follow every session)

1. **Map once, reuse.** Session 1 writes `docs/CODEMAP.md`. Every later session reads the map first and opens source files only to check or change a specific thing. When code changes, update the map in the same session.
2. **Read narrowly.** Use Grep/Glob first, then read line ranges, not whole files. Don't open `node_modules/`, `l2-data/` checkpoints, or `tests/`, unless a test is the subject. Open patent files only in the patent session.
3. **Fan out only for the audit.** Multi-agent fan-out (ultracode/workflows) is for sessions 1–2. Fix phases use one agent, one phase per session.
4. **Split the models.** Fable (max effort) for understanding, the audit, the patent comparison and design. Sonnet for mechanical edits and test fixes once a design is approved.
5. **Long jobs in the background.** Run the network, the e2e harness and jest suites in the background, and read only the summary or the last lines of their logs.
6. **Findings go in files, not chat.** Keep chat replies short and put details in the docs named below.
7. **End every session the same way.** Update the plan file and CODEMAP and add a "State of work" note, then stop. Don't let a session run long, because every step re-sends the whole conversation.
8. **Trust the docs.** Re-check only the claim you are about to act on.
9. **Trim memory early.** The auto-memory index (`MEMORY.md`) is over 200 lines, so its tail isn't loaded. Move detail into topic files and keep one line per entry.

## The project in brief

Claims adjudication for pharmacy benefits using zero-knowledge proofs (o1js 2.13, TypeScript ES modules, Jest via `npx jest` on Windows). Members' identities stay on their phones. The network sees wallet IDs (Poseidon hashes) and proofs. Parts:
- a Leviathan sequencer (`:3030`, JSON-RPC at `/rpc` and `/interactive/*`) with batch and chain proofs;
- Nautilus nodes: member `:4001`, prescriber `:4002`, pharmacy `:4003`, insurer and marketplace `:4004`;
- per-employer nodes and an HR Tool, started at activation;
- the adjudication engine in `src/adjudication/` (the console's drivers stay in `visualizer/engine/`).

## Owner's rules (non-negotiable)

- I1: Raw PHI/PII exists only inside the member app on the phone, only until the hash is made. It is never written to disk, logs, or browser storage.
- I2: Only the wallet ID and ZK proofs leave the phone.
- I3: The enrollment key lives only in the phone's secure storage and on the member's offline NFC card, encrypted under a PIN the member typed on the phone.
- I4: Nothing outside the app (other apps, web pages, the local network) can reach the app's functions or data. This is enterprise-level isolation.
- I5: The employer node and HR Tool meet the same standard. Employee names and IDs stay on the employer's machine. What leaves is a salted commitment and a random single-use enrollment code.
- I6: Only the member can link employee to wallet. The employer never learns the wallet ID.
- I7: Every route that changes state or returns member data authenticates its caller. Proofs are verified when submitted.
- Member approval is needed only for enrollment and PCP choice. A prescriber who is the member's consented PCP needs no further member approval to prescribe.
- Test against the real running network, not simulations. Use fictional test identities only.

## Already done (don't redo)

- **Registry fix (Phase 1), uncommitted in the working tree.** The sequencer's trees are the single source of truth, so concurrent enrollments across employers work. The plan and proof are in `scripts/e2e-verify/PLAN-registry-fix.md`, with tests in `tests/registry-consistency.test.ts` (10 passing). The live e2e run with two employers and four members passed **119 of 127** checks (corrected 2026-10-16 from the `241/254` figure, which came from an earlier attempt). All eight failures are itemized in `docs/audit/containment-and-binding.md` §5: a duplicate claim paid but dropped from the ledger, two accumulator rebuilds disagreeing with the engine, portable-credential generation failing in the proof pool, and `hash(enrollmentKey)` on the sequencer's disk for all four members.
- **Route map of the current system,** with one swimlane per stage and each route's checks: https://claude.ai/artifact/MVVzf7osD2sJQg1GKtYisx
- **PHI containment check,** `scripts/e2e-verify/check-phi-containment.ts`: the plaintext stays on the phone, but the per-field hashes reach the sequencer's disk.
- **Partial hardening plan,** `scripts/e2e-verify/PLAN-security-hardening.md`. It has the rules and the findings tables. The steps, order and tests are not written yet.
- **Million-member cost simulation:** https://claude.ai/artifact/Y8cDEDkhx74WXE472sGr2y

Known problem areas (details in the partial plan and the route map):
- identity hashes leave the phone;
- the backup card flow doesn't work;
- the phone app's local surface is open;
- employer enrollment codes aren't random or single-use;
- several state-changing routes lack auth;
- most proofs are checked only at batch time;
- claims history is readable by wallet ID;
- duplicate claims are paid but dropped from the ledger;
- portable credential generation fails in the proof pool;
- messaging isn't end-to-end encrypted.

## Session sequence

| # | Session | Model | Output |
|---|---|---|---|
| 1 | **Code map.** Components, processes and ports, every route, data flows, where PHI, hashes and keys live, each ZK program and where it is verified. Skip `tests/`. | Fable max, fan-out OK | `docs/CODEMAP.md` |
| 2 | **Defect and PHI/PII audit.** Every weak point with severity, file:line, and whether it was confirmed on the running network. Extend the containment check to cover each data store and API. | Fable max, fan-out OK | `docs/AUDIT.md` |
| 3 | **Intended vs. as-built.** Read the patent abstracts, claims and figures (`USPTO Document Submission/`, `Final Submission Version/`, `patent_figures/`). Diff the intended swimlanes against the route map. | Fable max | `docs/INTENDED-VS-ASBUILT.md`, plus an updated swimlane artifact |
| 4 | **Finish the hardening plan:** phases, order, acceptance tests for I1–I7, and impact on the pill pipeline. | Fable max | `PLAN-security-hardening.md` completed |
| 5 | **Fix phase A:** lock down the phone app's surface, fix the backup card, make employer codes random and single-use, lock down the employer node and HR Tool. | Sonnet (Fable for review) | code, tests |
| 6 | **Fix phase B:** keep hashes on the phone (the phone proves its own wallet updates), move the accumulator to a plan-side account, enforce PCP consent at prescribing, stop sending the wallet ID to the employer, delete the stored hashes. | Fable max (design), Sonnet (edits) | code, tests |
| 7 | **Fix phase C:** salt the identity fields (salt on the phone and the card), and update the wallet migration proof. | Fable max | code, tests |
| 8 | **Fix phase D:** access control on claims history, proof verification at submit, auth on open routes, end-to-end encrypted messaging, the duplicate-claim fix, and the proof-pool credential fix. | Sonnet + Fable review | code, tests |

Every fix phase ends with: the unit tests for the touched code, `check-phi-containment.ts`, and a live `run-multi.ts` e2e run on a fresh network. Paste the summary lines into the plan file.

## Running things

- **Tests:** `npx jest tests/<file>.test.ts`
- **Network,** started in the background and logged to a file: create a secrets file holding a random 32-byte hex admin token and gossip secret, then set:
  - `ZKTRIDENT_ADMIN_TOKEN`, `ZKTRIDENT_GOSSIP_SECRET`
  - `ZKTRIDENT_FORMULARY_LIMIT=100`, `ZKTRIDENT_POOL_SIZE=2`, `ZKTRIDENT_PROOF_POOL_SIZE=4`, `ZKTRIDENT_OPEN_BROWSERS=0`
  - and leave `ZKTRIDENT_UNSECURE` unset.

  Then run `npx tsx src/nodes/start-leviathan.ts`. Proving is slow (registration about 20–120 s), so poll instead of waiting on HTTP timeouts.
- **Harness** in `scripts/e2e-verify/`, with each script's options at its top:
  - `run.ts`: one employer;
  - `run-multi.ts`: two employers and four members (set `E2E_RESUME_DIR` to reuse members from an earlier run);
  - `check-registry.ts`, `check-identity-exposure.ts`, `check-phi-containment.ts <run-dir> <network-log>`.
- **Data on disk:**
  - `l2-data/`: sequencer and engine state;
  - `nautilus-data/`: member device state for `:4001`, plus the insurer marketplace files;
  - `hr-tool-data/`: the employer workspaces.

  Reset these between clean runs.

## Start points in the code

- Sequencer: `src/l2/l2-sequencer-service.ts`, `l2-rpc-server.ts`, `l2-client.ts`, `batch-program.ts`, `chain-program.ts`
- Engine: `src/adjudication/interactive-service.ts`, `interactive-routes.ts`
- Nodes: `src/nodes/nautilus-app-server.ts`, `src/nodes/routes/*-routes.ts`, `src/nodes/start-*.ts`, the employer orchestrator, the HR Tool server
- Identity and keys: `src/wallets/wallet-derivation.ts`, `src/wallets/wallet-migration-*.ts`, `src/security/*`, `src/nodes/nautilus-local-state.ts`
- Member app: `dashboard-member/app.js`
