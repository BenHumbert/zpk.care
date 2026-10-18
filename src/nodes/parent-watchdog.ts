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
 * A child process that notices when its parent is gone — phase A item A7.
 *
 * The orchestrator spawns an employer node per tenant. Its graceful shutdown kills them, but a
 * parent that is killed hard, crashes, or is stopped by a port sweep runs no handlers, and on
 * Windows nothing re-parents or signals the children. Eight such orphans from four runs were found
 * alive on one machine, holding ports and memory. So the child polls: it is told its parent's PID
 * at spawn and exits on its own when that PID no longer exists.
 *
 * `process.kill(pid, 0)` sends no signal; it asks whether the process exists. `EPERM` means it
 * exists but is not ours, which still counts as alive.
 */

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface ParentWatchdogOptions {
  parentPid: number;
  /** How often to look. */
  intervalMs?: number;
  /** Called once, the first time the parent is found gone. */
  onGone: () => void;
  /** Injectable for tests. */
  isAlive?: (pid: number) => boolean;
  /** Injectable for tests. */
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
}

/** Start watching; returns a function that stops the watch. The timer never keeps the process up. */
export function watchParent(opts: ParentWatchdogOptions): () => void {
  const isAlive = opts.isAlive ?? isProcessAlive;
  const setI = opts.setInterval ?? setInterval;
  const clearI = opts.clearInterval ?? clearInterval;
  const intervalMs = opts.intervalMs ?? 10_000;
  let fired = false;
  const timer = setI(() => {
    if (fired) return;
    if (isAlive(opts.parentPid)) return;
    fired = true;
    clearI(timer);
    opts.onGone();
  }, intervalMs);
  if (typeof (timer as { unref?: () => void }).unref === 'function') (timer as { unref: () => void }).unref();
  return () => clearI(timer);
}

/** Read the parent PID a launcher was given, or null when it was started by hand. */
export function parentPidFromEnv(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env.ZKTRIDENT_PARENT_PID;
  if (!raw) return null;
  const pid = Number(raw);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}
