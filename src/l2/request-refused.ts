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
 * A refusal the caller is meant to read.
 *
 * The RPC server hides the message of an unexpected error behind "Internal error", which is right
 * for a bug and wrong for a rule: a caller told "no" should be told why. A handler that refuses a
 * well-formed request on a rule (an entity owned by another key, a node registering the wrong kind
 * of entity, an attestation for a revoked wallet) throws this, and the server answers with its
 * message and code. The default code is the server's `RPC_FORBIDDEN` (-32004): the request was
 * understood and is not allowed.
 */
export class RequestRefused extends Error {
  readonly code: number;

  constructor(message: string, code = -32004) {
    super(message);
    this.name = 'RequestRefused';
    this.code = code;
  }
}
