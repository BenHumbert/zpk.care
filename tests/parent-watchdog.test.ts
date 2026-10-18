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
 * A spawned tenant must not outlive the process that spawned it — phase A item A7. Eight orphaned
 * employer nodes and HR Tools from four harness runs were found alive on one machine; the
 * orchestrator's graceful shutdown never ran because the parent was killed hard.
 */
import path from 'path';
import { spawn } from 'child_process';
import { isProcessAlive, parentPidFromEnv, watchParent } from '../src/nodes/parent-watchdog.js';

describe('across processes: the case the live run cannot distinguish', () => {
  /*
   * When the insurer was killed hard on a live network, its tenant was gone within two seconds.
   * That could have been the watchdog or the broken stdout pipe; from outside they look the same.
   * The orphans this exists for were quiet servers with nothing to write, so the pipe would not have
   * saved them. This child has no pipes at all, and must still leave.
   */
  test('a quiet child with no pipes exits on its own when the PID it watches disappears', async () => {
    const REPO = path.resolve(__dirname, '..');
    const parent = spawn(process.execPath, ['-e', 'setInterval(function () {}, 1000)'], { stdio: 'ignore', windowsHide: true });
    await new Promise((r) => setTimeout(r, 300));
    const child = spawn(process.execPath, ['--import', 'tsx', path.join(REPO, 'tests', 'helpers', 'watch-parent-child.ts')], {
      cwd: REPO,
      env: { ...process.env, ZKTRIDENT_PARENT_PID: String(parent.pid) },
      stdio: 'ignore',
      windowsHide: true,
    });
    const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
    // Time to load tsx and arm the watch; the child must still be running while the parent lives.
    await new Promise((r) => setTimeout(r, 5_000));
    expect(child.exitCode).toBeNull();
    parent.kill();
    const outcome = await Promise.race([exited, new Promise<string>((r) => setTimeout(() => r('still running after 15 s'), 15_000))]);
    if (outcome !== 0) { try { child.kill(); } catch { /* best effort */ } }
    expect(outcome).toBe(0);
  }, 40_000);
});

describe('isProcessAlive', () => {
  test('this process is alive and an impossible PID is not', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-5)).toBe(false);
    expect(isProcessAlive(2 ** 22 + 12345)).toBe(false);
  });
});

describe('watchParent', () => {
  test('fires once when the parent disappears, then stops looking', () => {
    const ticks: Array<() => void> = [];
    const fakeSetInterval = ((fn: () => void) => { ticks.push(fn); return { unref() { /* noop */ } }; }) as unknown as typeof setInterval;
    const cleared: unknown[] = [];
    const fakeClearInterval = ((t: unknown) => { cleared.push(t); }) as unknown as typeof clearInterval;
    let alive = true;
    let gone = 0;
    watchParent({
      parentPid: 4242,
      intervalMs: 10,
      onGone: () => { gone++; },
      isAlive: () => alive,
      setInterval: fakeSetInterval,
      clearInterval: fakeClearInterval,
    });
    expect(ticks).toHaveLength(1);
    ticks[0]();
    expect(gone).toBe(0);
    alive = false;
    ticks[0]();
    expect(gone).toBe(1);
    expect(cleared).toHaveLength(1);
    ticks[0]();                 // a late tick after the timer was cleared does nothing more
    expect(gone).toBe(1);
  });

  test('stop() cancels the watch', () => {
    const cleared: unknown[] = [];
    const stop = watchParent({
      parentPid: 1,
      onGone: () => { throw new Error('must not fire'); },
      isAlive: () => true,
      setInterval: ((_fn: () => void) => ({ unref() { /* noop */ } })) as unknown as typeof setInterval,
      clearInterval: ((t: unknown) => { cleared.push(t); }) as unknown as typeof clearInterval,
    });
    stop();
    expect(cleared).toHaveLength(1);
  });
});

describe('parentPidFromEnv', () => {
  test('reads a positive integer and nothing else', () => {
    expect(parentPidFromEnv({ ZKTRIDENT_PARENT_PID: '1234' })).toBe(1234);
    expect(parentPidFromEnv({})).toBeNull();
    expect(parentPidFromEnv({ ZKTRIDENT_PARENT_PID: 'abc' })).toBeNull();
    expect(parentPidFromEnv({ ZKTRIDENT_PARENT_PID: '0' })).toBeNull();
    expect(parentPidFromEnv({ ZKTRIDENT_PARENT_PID: '-3' })).toBeNull();
  });
});
