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
 * How the HR Tool texts an employee: the enrollment PIN, and notices about the employee's invite (A-109, owner decision
 * 2026-11-03).
 *
 * The HR Tool sends each text itself, so no person at HR sees a PIN, and it is the one place that holds an employee's
 * mobile number. Never the employer node, which runs on the operator's machine, and never the plan: a plan holding
 * phone numbers beside wallets could put names to wallets, and the ledger keeps each wallet's drugs in plain text.
 *
 * Which service is HR_TOOL_TEXT_SERVICE:
 *   outbox — each text is one JSON line in HR_TOOL_TEXT_OUTBOX (default <data dir>/text-outbox.jsonl), readable by its
 *            owner only. For a demonstration and the live harness, where the employee's phone is that file.
 * A real SMS provider plugs in here once the operator has an account. With no service set the HR Tool issues no
 * invite, since an invite whose PIN reaches nobody is no invite.
 */
import { appendFileSync, chmodSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';

export interface TextMessage {
  /** The employee's mobile number, as normalizeMobile keeps it */
  to: string;
  body: string;
}

export interface TextService {
  /** What the HR Tool's start banner calls this service */
  readonly description: string;
  send(message: TextMessage): Promise<void>;
}

/** Texts written to a local file, one JSON line each: a demonstration's phone. */
export class OutboxTextService implements TextService {
  readonly description: string;

  constructor(readonly file: string) {
    this.description = `outbox (demonstration): texts are written to ${file}`;
  }

  async send(message: TextMessage): Promise<void> {
    mkdirSync(dirname(this.file), { recursive: true });
    appendFileSync(this.file, JSON.stringify({ at: new Date().toISOString(), to: message.to, body: message.body }) + '\n', { mode: 0o600 });
    try { chmodSync(this.file, 0o600); } catch { /* a file system without modes */ }
  }
}

/** The text service HR_TOOL_TEXT_SERVICE names, or null when none is set; an unknown name stops the start. */
export function textServiceFromEnv(env: NodeJS.ProcessEnv, dataDir: string): TextService | null {
  const kind = env.HR_TOOL_TEXT_SERVICE?.trim();
  if (!kind) return null;
  if (kind === 'outbox') return new OutboxTextService(env.HR_TOOL_TEXT_OUTBOX?.trim() || join(dataDir, 'text-outbox.jsonl'));
  throw new Error(`HR_TOOL_TEXT_SERVICE must be "outbox" or unset, not "${kind}"`);
}

/** A mobile number as the HR Tool keeps it: digits, 8 to 15, with an optional leading +; null when it is not one. */
export function normalizeMobile(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const compact = raw.replace(/[\s().-]/g, '');
  return /^\+?\d{8,15}$/.test(compact) ? compact : null;
}

/** What a screen, an answer or another text shows of a number: its last four digits. */
export function maskMobile(mobile: string): string {
  return '•••' + mobile.slice(-4);
}

/** The texts, worded once. */
export const TEXTS = {
  pin: (pin: string): string =>
    `zpk.care: your enrollment PIN is ${pin}. Enter it in the zpk.care app with the invite your employer sent you. ` +
    'No one from HR or your health plan will ever ask you for it.',
  replacedPin: (pin: string): string =>
    `zpk.care: your new enrollment PIN is ${pin}, for the new invite your employer is sending you. Your earlier invite no longer works. ` +
    'No one from HR or your health plan will ever ask you for it.',
  mobileChanged: (maskedNew: string): string =>
    `zpk.care: the mobile number for your enrollment invite was changed to ${maskedNew}. If you did not ask for this, tell your HR department.`,
};
