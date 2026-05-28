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

// Prescription Flow (L8)

export {
  RX_STATUS_ACTIVE,
  RX_STATUS_ADJUDICATED,
  RX_STATUS_PARTIALLY_FILLED,
  RX_STATUS_FILLED,
  RX_STATUS_CANCELLED,
  RX_STATUS_REJECTED,
  RX_STATUS_REVERSED,
  RX_STATUS_TRANSFERRED,
  RX_STATUS_DISPENSED,
  EMERGENCY_FILL_HASH,
  PrescriptionData,
  buildPrescriptionData,
  PrescriptionStatusData,
  buildPrescriptionStatusData,
  isValidStatusTransition,
  assertValidStatusTransition,
} from './prescription-data.js';
export type {
  PrescriptionLocalData,
  PrescriptionStatusLocalData,
} from './prescription-data.js';

export {
  PrescriptionOutput,
  PrescriptionProgram,
  PrescriptionProof,
} from './prescription-program.js';

export { PrescriptionService } from './prescription-service.js';
export type {
  PrescriptionResult,
  StatusUpdateResult,
  TransferResult,
} from './prescription-service.js';

export { PrescriptionVerificationService } from './prescription-verification-service.js';
export type {
  PrescriptionHoldingResult,
  PrescriptionDataResult,
  StatusHistoryEntry,
  FullPrescriptionCheckResult,
} from './prescription-verification-service.js';
