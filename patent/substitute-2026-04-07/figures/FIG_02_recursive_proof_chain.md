# FIG. 2 — Recursive Proof Composition Chain

```
Replacement Sheet

FIG. 2 — RECURSIVE PROOF CHAIN (3 LEVELS, maxProofsVerified=2)   Sheet 2 of 22
=====================================================================================

DEPTH 2 — CHAIN PROOF (Recursive)                                                       210
---------------------------------------------------------------------------------------------
  +--ChainProgram 212 ---------------------------------------------------------------+
  |  Methods: genesis() | advance(prev: ChainProof, batch: BatchProof)               |
  |  GlobalState 214 (10 Fields):                                                    |
  |    walletRegRoot, walletCount, adminPubKeyHash, lifecycleRoot,                   |
  |    benefitPlanRoot, credentialRegistryRoot, eligibilityVkHash, messagingRoot,    |
  |    auditChainHash, blockHeight                                                   |
  |  Output: GlobalState_new    Verifies: BatchProof.verify() inside circuit         |
  +----------------------------------------------------------------------------------+
       |  advance() consumes BatchProof
       v
DEPTH 1 — BATCH PROOF (Recursive)                                                       220
---------------------------------------------------------------------------------------------
  +--BatchProgram 222 ----------------------------------------------------------------+
  |  Methods: wrapSingle(stp) | wrapPair(stp1, stp2) | mergeBatches(bp1, bp2)         |
  |  BatchOutput 224 (6 Fields):                                                      |
  |    oldRegistryRoot, newRegistryRoot, oldLifecycleRoot, newLifecycleRoot,          |
  |    registrationCount, transitionCount                                             |
  |  Verifies: StateTransitionProof.verify() or BatchProof.verify() inside circuit    |
  +-----------------------------------------------------------------------------------+
       |  wrapSingle/wrapPair consumes StateTransitionProofs
       v
DEPTH 0 — STATE TRANSITION PROOFS (Leaf)                                                 230
---------------------------------------------------------------------------------------------
  +--StateTransitionProof-A 232------+    +--StateTransitionProof-B 234------+
  |  TransitionOutput 236:           |    |  TransitionOutput 236:           |
  |    walletId,                     |    |    walletId,                     |
  |    oldRegistryRoot,              |    |    oldRegistryRoot,              |
  |    newRegistryRoot,              |    |    newRegistryRoot,              |
  |    oldLifecycleRoot,             |    |    oldLifecycleRoot,             |
  |    newLifecycleRoot              |    |    newLifecycleRoot              |
  |  Inline wallet verification      |    |  Inline wallet verification      |
  +----------------------------------+    +----------------------------------+
       |                                    |
       v                                    v
  +--Transaction-A 238--------------+    +--Transaction-B 240--------------+
  |  Eligibility | Prescription     |    |  Fulfillment | Accumulator      |
  |  or Lifecycle proof             |    |  Settlement proof               |
  +---------------------------------+    +---------------------------------+

RECURSIVE MERGE TREE (Binary Reduction)                                                  250
---------------------------------------------------------------------------------------------
              ChainProof 252
                  |
             BatchProof 254
              /        \
        BatchProof    BatchProof
        256-A          256-B
        /    \          /    \
     STP-1  STP-2   STP-3  STP-4          STP = StateTransitionProof
      258    260     262    264

  Batch of N transitions: ceil(log2(N)) merge rounds
  All .verify() calls execute INSIDE ZK circuits (not external checks)
  Pickles constraint: maxProofsVerified=2, max recursion depth=2

PROOF PIPELINE (Sequencer Flow)                                                          270
---------------------------------------------------------------------------------------------
  Entity proves STP  -->  Sequencer queues  -->  prepareBatch() drains queue
       270-A                  270-B                    270-C
                                                         |
  finalizeBatch(result) <--  ProvingPool worker  <--  prove(job) dispatched
       270-F                    270-E                    270-D
```
