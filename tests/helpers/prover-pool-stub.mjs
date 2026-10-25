/*
 * Copyright 2026 Ben Humbert
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * A prover worker without o1js, and the process that runs a real ProofPool or ProvingPool of them: the fixture for
 * tests/pools-always-settle.test.ts.
 *
 * Forked by a pool, with an IPC channel, this file is a worker. It speaks the protocol the two pools share
 * (src/adjudication/proof-pool-worker.ts and src/l2/l2-proving-worker.ts): compile is answered with ready, and each
 * prove with a result that carries this process's pid. PROVER_POOL_STUB_COMPILE set to 'compile-failed' makes a worker
 * answer compile with an error and keep running, as both real workers do when their compile throws. A worker proves its
 * jobs one at a time in arrival order, as a worker whose proof holds its CPU does, and a job's `stub` field shapes it:
 * `delayMs`, how long it takes (10 ms by default); `hang`, never answered, nor is anything sent to that worker after it;
 * `exitMs`, the worker crashes that long into it.
 *
 * Started by the test, without one, it is the pool's parent. Jest cannot load the engine's pool, which finds its worker
 * through import.meta.url, so the pool runs here, loaded through tsx's tsImport. The engine's pool forks its workers
 * with tsx's loader; the L2 pool forks them with this process's execArgv, which is empty, so they run under plain Node.
 *
 * The first argument is the case, as JSON: the pool ('proof', the engine's, or 'proving', the L2 batch pool), its size
 * and options, the scenario, and `forks`, each worker's compile behaviour in the order the pool forks them ('ready', the
 * default, or 'compile-failed'). The scenarios:
 *  - last-worker-lost: the only worker crashes 100 ms into a job, with a second job queued behind it; then a third job.
 *  - recycle: one job, after which the only worker is recycled; then two more, one at a time.
 *  - timeout: a job that hangs past the pool's prove timeout, then two ordinary jobs, one at a time.
 *  - honest: three waves of four jobs of 20 ms, each wave submitted at once.
 * A job's outcome is 'proved', with the pid of the worker that answered, or 'refused', with the message, and in either
 * case how many milliseconds after its submission it settled; a job not settled within `waitMs` is 'pending'.
 *
 * Every fork the pool makes and every exit of a forked worker are recorded by wrapping child_process.fork, as
 * tests/helpers/verify-pool-stub.mjs does. Each scenario then waits, at most `waitMs`, for the workers it expects to be
 * gone to exit (or, for honest, for the pool to hold `size` ready workers again). The fixture prints one line,
 * RESULT_MARKER and then JSON: what the scenario saw, the pids forked and exited, the pool's status, its workers'
 * statuses, isRunning() and, where the pool has it, canTakeWork(); then it shuts the pool down and exits.
 */
import { createRequire, syncBuiltinESMExports } from 'module';
import { fileURLToPath } from 'url';

const RESULT_MARKER = '@@prover-pool ';

if (process.send) {
  const jobs = [];
  let proving = false;
  const proveNext = () => {
    if (proving || jobs.length === 0) return;
    const { jobId, request } = jobs.shift();
    const stub = (request && request.stub) || {};
    proving = true;
    if (stub.hang) return; // only the pool can end this one, and every job sent after it waits behind it
    if (stub.exitMs !== undefined) {
      setTimeout(() => process.exit(1), stub.exitMs);
      return;
    }
    const delayMs = stub.delayMs ?? 10;
    setTimeout(() => {
      process.send({
        type: 'result',
        jobId,
        result: {
          proofJson: null, publicOutput: null, batchProofJson: '{}', batchOutput: {},
          proveTimeMs: delayMs, workerId: -1, pid: process.pid,
        },
      });
      proving = false;
      proveNext();
    }, delayMs);
  };
  process.on('message', (msg) => {
    switch (msg.type) {
      case 'compile':
        if (process.env.PROVER_POOL_STUB_COMPILE === 'compile-failed') {
          process.send({ type: 'error', jobId: '__compile__', message: 'the stub was told to fail its compile' });
        } else {
          process.send({ type: 'ready', compileTimeMs: 0, programs: [] });
        }
        break;
      case 'prove':
        jobs.push(msg);
        proveNext();
        break;
      case 'shutdown':
        process.exit(0);
    }
  });
  process.on('disconnect', () => process.exit(0));
} else {
  try {
    const result = await drive(JSON.parse(process.argv[2] ?? '{}'));
    process.stdout.write(RESULT_MARKER + JSON.stringify(result) + '\n', () => process.exit(0));
  } catch (e) {
    console.error('the prover pool driver failed:', e);
    process.exit(1);
  }
}

async function drive({ pool: kind, size = 1, options = {}, scenario, forks = [], waitMs = 10_000 }) {
  const pids = [];
  const exitedPids = [];
  const childProcess = createRequire(import.meta.url)('child_process');
  const realFork = childProcess.fork;
  childProcess.fork = function recordedFork(modulePath, args, forkOptions) {
    const behaviour = forks[pids.length] ?? 'ready';
    const child = realFork.call(this, modulePath, args, {
      ...forkOptions,
      env: { ...forkOptions.env, PROVER_POOL_STUB_COMPILE: behaviour },
    });
    pids.push(child.pid ?? null);
    child.once('exit', () => { exitedPids.push(child.pid); });
    return child;
  };
  syncBuiltinESMExports();

  const { tsImport } = await import('tsx/esm/api');
  let pool;
  if (kind === 'proof') {
    const { ProofPool } = await tsImport('../../src/adjudication/proof-pool.js', import.meta.url);
    pool = new ProofPool(size, { shutdownGraceMs: 300, ...options });
  } else {
    const { ProvingPool } = await tsImport('../../src/l2/l2-proving-pool.js', import.meta.url);
    pool = new ProvingPool(size, { compileConcurrency: size, shutdownGraceMs: 300, ...options });
  }
  pool.setWorkerScriptPath(fileURLToPath(import.meta.url));

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  /** Submits one job and settles with its outcome; it never rejects. */
  const submit = (stub) => {
    const submittedAt = Date.now();
    const request = kind === 'proof'
      ? { program: 'Stub', method: 'prove', args: [], stub }
      : { transitionProofJsons: [], latestChainHash: '0', stub };
    return pool.prove(request, 'a stub job').then(
      (r) => ({ result: 'proved', pid: r.pid, ms: Date.now() - submittedAt }),
      (e) => ({ result: 'refused', message: e instanceof Error ? e.message : String(e), ms: Date.now() - submittedAt }),
    );
  };
  /** The outcome, or 'pending' if it has not settled within waitMs. */
  const within = (outcome) => Promise.race([outcome, sleep(waitMs).then(() => ({ result: 'pending' }))]);
  /** Waits, at most waitMs, until `done` holds; says whether it did. */
  const waitFor = async (done) => {
    const until = Date.now() + waitMs;
    while (!done()) {
      if (Date.now() > until) return false;
      await sleep(10);
    }
    return true;
  };
  const allExited = () => exitedPids.length === pids.length;

  await pool.start();
  let seen;
  switch (scenario) {
    case 'last-worker-lost': {
      const crashing = submit({ exitMs: 100 });
      const queued = submit({});
      seen = { crashing: await within(crashing), queued: await within(queued) };
      seen.later = await within(submit({}));
      seen.allExited = await waitFor(allExited);
      break;
    }
    case 'recycle': {
      seen = { first: await within(submit({})) };
      seen.queued = await within(submit({}));
      seen.later = await within(submit({}));
      seen.allExited = await waitFor(allExited);
      break;
    }
    case 'timeout': {
      seen = { hung: await within(submit({ hang: true })) };
      seen.next = await within(submit({}));
      seen.afterwards = await within(submit({}));
      seen.hungExited = await waitFor(() => exitedPids.includes(pids[0]));
      break;
    }
    case 'honest': {
      const outcomes = [];
      for (let wave = 0; wave < 3; wave++) {
        outcomes.push(...await Promise.all(Array.from({ length: 4 }, () => within(submit({ delayMs: 20 })))));
      }
      seen = {
        proved: outcomes.filter((o) => o.result === 'proved').length,
        refused: outcomes.filter((o) => o.result === 'refused').length,
        pending: outcomes.filter((o) => o.result === 'pending').length,
      };
      seen.settled = await waitFor(() => pids.length - exitedPids.length === size
        && pool.getWorkerStatuses().length === size
        && pool.getWorkerStatuses().every((w) => w.status === 'idle'));
      break;
    }
    default:
      throw new Error(`no such scenario: ${scenario}`);
  }
  const result = {
    ...seen,
    forks: pids.length,
    exits: exitedPids.length,
    pids,
    exitedPids: [...exitedPids],
    status: pool.getStatus(),
    workers: pool.getWorkerStatuses(),
    isRunning: pool.isRunning(),
    canTakeWork: typeof pool.canTakeWork === 'function' ? pool.canTakeWork() : null,
  };
  await pool.shutdown();
  return result;
}
