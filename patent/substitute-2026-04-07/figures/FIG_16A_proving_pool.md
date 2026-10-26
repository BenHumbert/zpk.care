# FIG. 16A — Proving Pool: Architecture, IPC, Job Dispatch (Sheet 21 of 22)

```
Replacement Sheet

FIG. 16A — PROVING POOL — ARCHITECTURE, IPC PROTOCOL & JOB DISPATCH           Sheet 21 of 22
=================================================================================================

SECTION A: POOL ARCHITECTURE OVERVIEW                                                      1600
-------------------------------------------------------------------------------------------------
MAIN PROCESS (COORDINATOR):
+------------------------------------------------------+
| ProvingPool (poolSize:N, jobQueue:FIFO,              |  State held in main ONLY:
|   workers:Map, pendingJobs:Map)                      |    Merkle trees, receipts,
| L2SequencerService                                   |    batches, audit chain,
|   prepareBatch() / finalizeBatch() / restoreDrained()|    claim accumulator,
| L2Node                                               |    message store
|   executeBatchWithPool() / setProvingPool()          |
+------------------------------------------------------+
         |  IPC (fork)            |  IPC (fork)            |  IPC (fork)
         v                        v                        v
+--------------------+  +--------------------+  +--------------------+
| Worker 0           |  | Worker 1           |  | Worker 2           |
| o1js context       |  | o1js context       |  | o1js context       |
| V8 Isolate         |  | V8 Isolate         |  | V8 Isolate         |
| WASM heap (own)    |  | WASM heap (own)    |  | WASM heap (own)    |
|--------------------+  |--------------------+  |--------------------|
| StateTransitionProg|  | StateTransitionProg|  | StateTransitionProg|
| BatchProgram       |  | BatchProgram       |  | BatchProgram       |
| ChainProgram       |  | ChainProgram       |  | ChainProgram       |
+--------------------+  +--------------------+  +--------------------+
  Workers are STATELESS — only compiled ZkPrograms. TRUE CPU parallelism via child_process.fork()

SECTION B: IPC MESSAGE PROTOCOL                                                           1602
-------------------------------------------------------------------------------------------------
COORDINATOR -> WORKER:                          WORKER -> COORDINATOR:
+------+----------+--------------------------+  +------+---------+---------------------------+
| Dir  | Type     | Payload                  |  | Dir  | Type    | Payload                   |
+------+----------+--------------------------+  +------+---------+---------------------------+
| C->W | compile  | (none)                   |  | W->C | ready   | compileTimeMs             |
| C->W | prove    | jobId, ProvingJobRequest |  | W->C | result  | jobId, ProvingJobResult   |
| C->W | shutdown | (none)                   |  | W->C | error   | jobId, message            |
+------+----------+--------------------------+  +------+---------+---------------------------+

IPC SERIALIZATION BOUNDARY: All Field values -> decimal strings. All proofs -> proof.toJSON().
All BigInts -> .toString(). NO o1js objects cross the IPC boundary — only JSON-safe data.

SECTION C: JOB DISPATCH AND FIFO QUEUE                                                    1604
-------------------------------------------------------------------------------------------------
pool.prove(request) -> Promise<ProvingJobResult>
         |
         v
  Idle worker available?
         |                               |
        YES                              NO
         |                               |
         v                               v
  dispatchJob(worker, job):        jobQueue.push(job)  (FIFO)
    worker.busy = true             When ANY worker finishes:
    pendingJobs.set(id)              drainQueue() -> pop next
    Set proveTimeout (5 min)         -> dispatch to idle worker
    Send ProveMessage via IPC
         |
         +-- SUCCESS: ResultMessage -> resolve promise -> recycle check
         +-- ERROR:   ErrorMessage  -> reject promise -> drainQueue()
         +-- TIMEOUT: 5 min timer   -> reject promise -> drainQueue()

  CRASH HANDLING:                           TIMEOUT HANDLING:
  Worker exits unexpectedly                 proveTimeout fires (5 min)
    1. Reject in-flight job                   1. Clear from pendingJobs
    2. totalJobsFailed++                      2. worker.busy = false
    3. restartCount++                         3. totalJobsFailed++
    4. restartCount < 3?                      4. job.reject(Error)
       YES: spawn -> compile -> drainQueue    5. drainQueue()
       NO:  worker permanently removed
  All workers compile same programs — any worker can prove any job. No affinity.
```
