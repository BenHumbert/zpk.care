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
 * The NFC reader as the adjudication routes see it.
 *
 * The routes forward a reader's events to the console over SSE and accept write requests for it.
 * They do not care which hardware is behind it. The USB bridge for the MIKROE-2540
 * (`visualizer/engine/nfc-bridge.ts`) implements this interface and keeps its native dependency
 * in the visualizer's own package; the production boot never constructs a reader, so a sequencer
 * carries no USB code. Anything that implements this interface can be passed to
 * `registerInteractiveRoutes` as the reader.
 */

export type NfcBridgeState = 'disconnected' | 'initializing' | 'polling' | 'tag_present' | 'writing' | 'error';

export interface NfcBridgeStatus {
  state: NfcBridgeState;
  devicePath: string | null;
  tagUid: string | null;
  pendingWrite: string | null;
  error: string | null;
}

export interface NfcTagEvent {
  type: 'tag:detected' | 'tag:read' | 'tag:written' | 'tag:removed' | 'tag:error';
  uid?: string;
  walletId?: string;
  attestation?: Record<string, unknown>;
  timestamp: number;
  error?: string;
}

/** What a tag may carry: a bare wallet ID (legacy) or a credential attestation. */
export type NdefPayload =
  | { type: 'member-id'; walletId: string }
  | { type: 'credential-attestation'; attestation: Record<string, unknown> };

export type NfcTagEventName = NfcTagEvent['type'];

/** The surface the routes use. An `EventEmitter`-based reader satisfies it as written. */
export interface NfcReader {
  on(event: 'status', handler: (status: NfcBridgeStatus) => void): unknown;
  on(event: NfcTagEventName, handler: (event: NfcTagEvent) => void): unknown;
  getStatus(): NfcBridgeStatus;
  queueWrite(payload: NdefPayload): Promise<void>;
  cancelWrite(): void;
}
