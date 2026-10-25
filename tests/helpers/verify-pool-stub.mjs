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
 * A verifier worker without o1js, and the process that runs a real VerifyPool of them: the fixture for
 * tests/verify-pool-restarts.test.ts.
 *
 * Forked by the pool, with an IPC channel, this file is a worker. It speaks the VerifyRequest / VerifyResponse
 * protocol of src/l2/l2-verify-worker.ts: compile is answered with a fixed key hash, after
 * VERIFY_POOL_STUB_READY_MS when that is set, and every verify with valid: true, except a proof marked
 * { hang: true }, which is never answered. VERIFY_POOL_STUB_COMPILE makes a worker answer compile with
 * compile-failed, as the real worker does and then keeps running, or not answer it at all ('silent'). A proof
 * marked { disconnect: true } is answered, and then the worker closes its channel and stays up until it is killed
 * (at most 5 s), as a dying worker does on Windows between its disconnect and its exit.
 *
 * Started by the test, without one, it is the pool's parent. Jest cannot load the pool: the pool finds its worker
 * through import.meta.url, which Jest's CommonJS transform refuses. So the pool runs here, loaded through tsx's
 * tsImport. That leaves this process's execArgv empty, and the pool forks its workers with that execArgv, so each
 * worker is this file under plain Node: about 40 ms a fork against about 200 ms with the tsx loader, which matters
 * for a run of 200 recycles.
 *
 * The first argument is the case, as JSON: a scenario name, the pool's options and the scenario's own numbers. The
 * scenarios are start (the start alone), verify-many (verifications one at a time, to the first refusal), batches
 * (the same in batches, the pool left to settle after each), stream (submissions at a steady interval, none waiting
 * for the one before), queued-timeout (a job that times out while the only worker is starting), hang (a verification
 * never answered), send-fails (a send that throws) and channel-closed (a send to a worker whose channel has closed).
 * `forks` gives each worker's compile behaviour in the order the pool forks them: 'ready', the default,
 * 'compile-failed', 'silent', or 'spawn-fails', a process that cannot be started at all.
 *
 * Every fork the pool makes, every exit of a forked worker and every process that never started are counted by
 * wrapping child_process.fork, as tests/helpers/spawn-employer-tenant.ts does for spawn. The wrapper also keeps the
 * most processes alive at once, and, from the moment start() has resolved, the most and the fewest ready workers
 * the pool reported after any message from a worker and after any verdict. It listens for no 'error' event: one
 * would stand in for the pool's own listener. The pool's replacement-limit alarms are counted from console.error.
 * It prints one line, RESULT_MARKER and then JSON: what the scenario saw, those counts, whether the pool settled,
 * and pool.stats().
 */
import { createRequire, syncBuiltinESMExports } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
import { format } from 'util';

const RESULT_MARKER = '@@verify-pool ';
const STUB_VK_HASH = 'stub-transition-vk';

if (process.send) {
  const exitOnDisconnect = () => process.exit(0);
  process.on('message', (msg) => {
    switch (msg.type) {
      case 'compile': {
        const behaviour = process.env.VERIFY_POOL_STUB_COMPILE ?? 'ready';
        if (behaviour === 'silent') break; // only the pool's ready timeout ends this one
        if (behaviour === 'compile-failed') {
          process.send({ type: 'compile-failed', message: 'the stub was told to fail its compile' });
          break;
        }
        const readyDelayMs = Number(process.env.VERIFY_POOL_STUB_READY_MS ?? 0);
        setTimeout(() => process.send({ type: 'ready', vkHash: STUB_VK_HASH, compileMs: readyDelayMs }), readyDelayMs);
        break;
      }
      case 'verify':
        if (msg.proofJson && msg.proofJson.hang) break; // only the pool's deadline ends this one
        process.send({ type: 'result', id: msg.id, valid: true, verifyMs: 0 }, () => {
          // The channel closes only once the answer has been written, and the worker stays up.
          if (!(msg.proofJson && msg.proofJson.disconnect)) return;
          process.off('disconnect', exitOnDisconnect);
          process.disconnect();
          setTimeout(() => process.exit(0), 5_000);
        });
        break;
      case 'shutdown':
        process.exit(0);
    }
  });
  process.on('disconnect', exitOnDisconnect);
} else {
  try {
    const result = await drive(JSON.parse(process.argv[2] ?? '{}'));
    process.stdout.write(RESULT_MARKER + JSON.stringify(result) + '\n', () => process.exit(0));
  } catch (e) {
    console.error('the verify pool driver failed:', e);
    process.exit(1);
  }
}

async function drive({
  scenario, pool: poolOptions, forks = [], verifications = 0, batches = [], beforeHang = 0, afterwards = 1,
  readyDelayMs = 0, intervalMs = 50, perTick = 1, recycles = 0,
}) {
  const counts = { forks: 0, exits: 0, spawnFailures: 0, maxLive: 0, maxAlive: 0, minAlive: null, alarms: 0 };
  const children = [];
  let pool = null;
  let started = false;
  const sampleAlive = () => {
    if (!started) return;
    const { alive } = pool.stats();
    counts.maxAlive = Math.max(counts.maxAlive, alive);
    counts.minAlive = Math.min(counts.minAlive ?? alive, alive);
  };
  const childProcess = createRequire(import.meta.url)('child_process');
  const realFork = childProcess.fork;
  childProcess.fork = function countedFork(modulePath, args, options) {
    const behaviour = forks[counts.forks] ?? 'ready';
    const forkOptions = { ...options, env: { ...options.env, VERIFY_POOL_STUB_COMPILE: behaviour } };
    if (behaviour === 'spawn-fails') {
      forkOptions.execPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'no-such-node');
    }
    const child = realFork.call(this, modulePath, args, forkOptions);
    children.push(child);
    counts.forks++;
    // A process that never started has no pid, and sends no exit.
    if (child.pid === undefined) counts.spawnFailures++;
    else child.once('exit', () => { counts.exits++; });
    counts.maxLive = Math.max(counts.maxLive, counts.forks - counts.exits - counts.spawnFailures);
    // Sampled once every listener for the message, the pool's included, has run.
    child.on('message', () => queueMicrotask(sampleAlive));
    return child;
  };
  syncBuiltinESMExports();
  const consoleError = console.error;
  console.error = (...args) => {
    if (format(...args).includes('worker replacement limit reached')) counts.alarms++;
    consoleError(...args);
  };

  const { tsImport } = await import('tsx/esm/api');
  const { VerifyPool } = await tsImport('../../src/l2/l2-verify-pool.js', import.meta.url);
  if (readyDelayMs) process.env.VERIFY_POOL_STUB_READY_MS = String(readyDelayMs);
  pool = new VerifyPool({ ...poolOptions, workerScriptPath: fileURLToPath(import.meta.url) });
  const verify = pool.asVerifier();
  const verdict = (json) => verify({ toJSON: () => json }).then(
    () => 'verified',
    (e) => (e instanceof Error ? e.message : String(e)),
  ).finally(sampleAlive);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const start = async () => {
    await pool.start();
    started = true;
  };

  let settled = true;
  /** Waits until every worker forked has exited, never started, or is ready: none starting, none on its way out. */
  const settle = async () => {
    const until = Date.now() + 10_000;
    while (counts.exits + counts.spawnFailures + pool.stats().alive !== counts.forks) {
      if (Date.now() > until) { settled = false; return; }
      await sleep(10);
    }
  };
  /** Verifications one at a time, to the first refusal. */
  const oneAtATime = async (count, from) => {
    let verified = 0;
    let refused = null;
    for (let n = 0; n < count && refused === null; n++) {
      const result = await verdict({ n: from + n });
      if (result === 'verified') verified++;
      else refused = result;
    }
    return { verified, refused };
  };

  let seen;
  switch (scenario) {
    case 'start': {
      // Only the start: 'started', or what it was refused with.
      const outcome = await start().then(() => 'started', (e) => (e instanceof Error ? e.message : String(e)));
      seen = { start: outcome };
      break;
    }
    case 'verify-many': {
      // One submission at a time, and a stop at the first refusal: a pool that has stopped would hold every
      // remaining submission for the whole timeout.
      await start();
      seen = await oneAtATime(verifications, 0);
      break;
    }
    case 'batches': {
      // The same, in batches, with the pool left to settle after each, so a worker that fails to start has been
      // dealt with before the next batch.
      await start();
      let verified = 0;
      let refused = null;
      for (const count of batches) {
        const batch = await oneAtATime(count, verified);
        verified += batch.verified;
        refused = batch.refused;
        if (refused !== null) break;
        await settle();
      }
      seen = { verified, refused };
      break;
    }
    case 'stream': {
      // `perTick` submissions at a steady interval, none waiting for the one before, until `recycles` recycled
      // workers have exited or `verifications` have been sent.
      await start();
      const pending = [];
      while (counts.exits < recycles && pending.length < verifications) {
        for (let k = 0; k < perTick; k++) pending.push(verdict({ n: pending.length }));
        await sleep(intervalMs);
      }
      const all = await Promise.all(pending);
      const refusals = all.filter((v) => v !== 'verified');
      seen = {
        submitted: all.length,
        verified: all.length - refusals.length,
        refused: refusals.length,
        firstRefusal: refusals[0] ?? null,
      };
      break;
    }
    case 'queued-timeout': {
      // The only worker is still starting, as every replacement is for a while: the job waits in the queue and
      // times out there, with no worker of its own.
      const starting = start();
      const queued = await verdict({ n: 0 });
      await starting;
      await settle();
      seen = { queued, afterwards: await verdict({ n: 1 }) };
      break;
    }
    case 'hang': {
      // `beforeHang` verifications one at a time, then the hung one, and after it `afterwards` more one at a time:
      // 'verified' if every one was, else the first refusal.
      await start();
      const before = await oneAtATime(beforeHang, 0);
      if (before.refused !== null) throw new Error(`refused before the hang: ${before.refused}`);
      const hung = await verdict({ hang: true });
      await settle();
      const after = await oneAtATime(afterwards, beforeHang + 1);
      seen = { hung, afterwards: after.refused ?? 'verified' };
      break;
    }
    case 'send-fails': {
      // JSON cannot encode a BigInt, so the send to the worker throws, which is the pool's failed-send path.
      await start();
      const unsent = await verdict({ n: 1n });
      await settle();
      seen = { unsent, afterwards: await verdict({ n: 1 }) };
      break;
    }
    case 'channel-closed': {
      // The only worker answers and then closes its channel, and the next submission is sent once this process has
      // seen the channel close: Node reports that send only by an 'error' event on the worker's ChildProcess.
      await start();
      const first = await verdict({ n: 0, disconnect: true });
      if (children[0].connected) await new Promise((resolve) => children[0].once('disconnect', resolve));
      const unsent = await verdict({ n: 1 });
      await settle();
      seen = { first, unsent, afterwards: await verdict({ n: 2 }) };
      break;
    }
    default:
      throw new Error(`no such scenario: ${scenario}`);
  }
  await settle();
  const result = { ...seen, settled, ...counts, stats: pool.stats() };
  await pool.shutdown();
  return result;
}
