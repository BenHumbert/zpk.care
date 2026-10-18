# Plan: one source of truth for wallet state

Goal: many members, across several employers enrolling at the same time, enroll and file
claims correctly, with every step checked on the real running network.

## Root cause

The wallet registry and lifecycle tree had two writable copies: the sequencer's and the
adjudication engine's (`src/adjudication/interactive-service.ts`). The engine edited wallet
leaves in its copy without a proof (credential mint at registration), then pushed its own
root over the sequencer's with `applyAdminRootUpdate`, which copied roots without checking
them against the sequencer's tree. Separately, the sequencer never updated its own tree for
wallet updates: `l2-sequencer-service.ts` used `new WalletState(...)` without importing it,
inside a `try { } catch { /* may drift */ }`. Once the tree no longer hashed to the published
root, every later registration and fill failed ("Registry slot is not empty", root mismatch).

## Fixes (Phase 1)

| # | Change | Files |
|---|---|---|
| F1 | The sequencer's trees are the only copy. The engine and the `EnrollmentService` it builds read them through `getStateTrees()`. | `l2-sequencer-service.ts`, `interactive-service.ts` |
| F2 | Insurer-side changes (seed providers, ELIGIBLE, termination) go through `adminMutate(reason, fn)`, which applies them to the trees and takes the roots from the trees. `applyAdminRootUpdate` refuses a root its tree does not produce. | same |
| F3 | Invariant tree root = published root, checked before and after every accepted proof. Each transition's tree change is computed and checked against the proof's new root before anything is mutated. Wallet updates must carry `newCredentialInventoryRoot`. The "admin-settled" purge of pending transitions is removed. `syncWalletState` is verify-only. Batch-failure snapshots include wallet state. | `l2-sequencer-service.ts`, `l2-rpc-server.ts`, `l2-client.ts`, `member-node.ts` |
| F4 | Contention retry: member registration and engine wallet updates re-read witnesses and re-prove on a root mismatch. | `member-routes.ts`, `interactive-service.ts` |
| F5 | Employer signing keys are stored as partner keys on the insurer; they no longer replace the insurer's admin token or authorize insurer admin routes. | `nautilus-app-server.ts`, `marketplace-routes.ts` |
| F6 | The formulary loads before the proving pool starts, so the pool's compile timeout can't expire while the main thread is busy. | `start-leviathan.ts` |

Found and fixed while testing: the engine's fill path built witnesses with
`new WalletRegistryWitness(JSON.parse(json))`, which always threw and silently fell back to
the private trees (now `fromJSON`); credential-only metadata was treated as a claim.

Deferred (Phase 2): wallet-to-group binding and plan/group pass-through; per-wallet proving
locks; tree insertion inside the batch circuit; network enforcement; open routes; trees in
checkpoints; member devices holding the network admin token.

## Validation

1. Baseline the related unit suites on the unchanged code.
2. `tests/registry-consistency.test.ts` (mock proofs, no circuits).
3. Re-run the suites; no new failures.
4. Live run (`scripts/e2e-verify/run-multi.ts`) on a fresh secured network: two employers onboard
   at once; four members on four member devices enroll concurrently, one during another
   member's fill; invariant after every step; claims re-derived; inclusion proofs; audits;
   accumulators; batch proofs and a credential verified against locally compiled keys,
   tampered copies rejected; insurer auth probes; secret scan.
