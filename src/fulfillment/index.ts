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

// Fulfillment Flow (L9)

export {
  FulfillmentData,
  buildFulfillmentData,
  ReversalData,
  buildReversalData,
} from './fulfillment-data.js';
export type {
  FulfillmentLocalData,
  ReversalLocalData,
} from './fulfillment-data.js';

export {
  FulfillmentOutput,
  FULFILL_OP_CLAIM,
  FULFILL_OP_REVERSAL,
  FulfillmentProgram,
  FulfillmentProof,
} from './fulfillment-program.js';

export { FulfillmentService } from './fulfillment-service.js';
export type {
  FulfillmentResult,
  ReversalResult,
} from './fulfillment-service.js';

export { FulfillmentVerificationService } from './fulfillment-verification-service.js';
export type {
  FulfillmentVerificationResult,
  ReversalVerificationResult,
  ClaimHistoryEntry,
  FullFulfillmentCheckResult,
} from './fulfillment-verification-service.js';

export {
  AccumulatorFulfillmentOutput,
  AccumulatorFulfillmentProgram,
  AccumulatorFulfillmentProof,
} from './accumulator-fulfillment-program.js';

export { AccumulatorFulfillmentService } from './accumulator-fulfillment-service.js';
export type {
  AccumulatorFulfillmentResult,
  AccumulatorReversalResult,
} from './accumulator-fulfillment-service.js';
