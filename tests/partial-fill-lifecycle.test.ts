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
 * A pharmacy can fill part of a script and finish it later (finding A-148).
 *
 * What was wrong: since the lifecycle of March (2899a44) the pharmacy marks a script FILLED (prepared) before it
 * dispenses, and the engine's dispense proves the script's status moving from FILLED, or from PARTIALLY_FILLED after
 * an earlier part, to PARTIALLY_FILLED (part of the quantity) or DISPENSED (the rest). The status table and the
 * circuit allowed FILLED -> DISPENSED and PARTIALLY_FILLED -> PARTIALLY_FILLED only, so the first partial fill of any
 * script failed in the prover ("Invalid prescription status transition") and a script partly filled could never be
 * finished. No live run fills part of a script, and the suites that do stub the prover.
 *
 * What is true now: both transitions are in the table and in the circuit.
 */
import {
  assertValidStatusTransition,
  isValidStatusTransition,
  RX_STATUS_DISPENSED,
  RX_STATUS_FILLED,
  RX_STATUS_PARTIALLY_FILLED,
} from '../src/prescription/prescription-data.js';

describe('the prescription lifecycle lets a pharmacy fill part of a script and finish it later', () => {
  test.each([
    ['the first part, after the script was prepared', RX_STATUS_FILLED, RX_STATUS_PARTIALLY_FILLED],
    ['another part', RX_STATUS_PARTIALLY_FILLED, RX_STATUS_PARTIALLY_FILLED],
    ['the last part', RX_STATUS_PARTIALLY_FILLED, RX_STATUS_DISPENSED],
    ['the whole script at once', RX_STATUS_FILLED, RX_STATUS_DISPENSED],
  ])('%s: the table and the circuit allow it', (_label, from, to) => {
    expect(isValidStatusTransition(from.toBigInt(), to.toBigInt())).toBe(true);
    expect(() => assertValidStatusTransition(from, to)).not.toThrow();
  });
});
