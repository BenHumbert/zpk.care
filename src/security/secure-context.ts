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

import { Field } from 'o1js';
import { scrubObject } from './secure-scrub.js';
import {
  deriveMemberWalletId,
  derivePrescriberWalletId,
  derivePharmacyWalletId,
  deriveRepresentativeWalletId,
  memberWalletPreimage,
  prescriberWalletPreimage,
  pharmacyWalletPreimage,
  representativeWalletPreimage,
} from '../wallets/wallet-derivation.js';
import type { MemberLocalData } from '../models/member.js';
import type { PrescriberLocalData } from '../models/prescriber.js';
import type { PharmacyLocalData } from '../models/pharmacy.js';
import type { RepresentativeLocalData } from '../wallets/wallet-derivation.js';

/**
 * Secure Context — Transient PHI/PII Processing
 *
 * This is the ONLY way raw data should flow through our system.
 *
 * Pattern:
 *   1. User enters raw data + enrollment key (external to our system)
 *   2. A mutable COPY is passed into a SecureContext function
 *   3. The function computes wallet ID and preimage Fields
 *   4. The raw data copy AND enrollment key are immediately scrubbed
 *   5. Only cryptographic artifacts are returned
 *   6. The caller should also null out their original references
 *
 * After this function returns, no PHI/PII and no enrollment key
 * exists in our application's reachable object graph.
 */

/** Result of a secure wallet derivation — contains only hashes */
export interface SecureWalletResult {
  walletId: Field;
  /** Preimage Fields for proof generation. Call dispose() when done. */
  preimage: Field[];
  /** Zeroes out the preimage Fields. Call after proof generation. */
  dispose: () => void;
}

/**
 * Securely derive a member wallet ID.
 *
 * Takes a MUTABLE copy of the raw member data, the enrollment key, and
 * the groupIdHash (already a Field — no raw data to scrub).
 * After derivation, the input object is scrubbed and the enrollment
 * key reference is cleared. The caller MUST NOT reuse the inputs.
 */
export function secureMemberDerivation(
  localData: MemberLocalData,
  enrollmentKey: string,
  groupIdHash: Field,
): SecureWalletResult {
  // Step 1: Compute cryptographic values while data is live
  const walletId = deriveMemberWalletId(localData, enrollmentKey, groupIdHash);
  const preimage = memberWalletPreimage(localData, enrollmentKey, groupIdHash);

  // Step 2: Immediately scrub the raw data
  scrubObject(localData as unknown as Record<string, unknown>);
  // Note: enrollmentKey is a string parameter — we can't mutate it,
  // but we've consumed it and the caller should null their reference.

  // Step 3: Return only cryptographic artifacts
  return {
    walletId,
    preimage,
    dispose() {
      for (let i = 0; i < preimage.length; i++) {
        preimage[i] = Field(0);
      }
      preimage.length = 0;
    },
  };
}

/**
 * Securely derive a prescriber wallet ID.
 * Input is scrubbed after derivation.
 */
export function securePrescriberDerivation(
  localData: PrescriberLocalData,
  enrollmentKey: string,
): SecureWalletResult {
  const walletId = derivePrescriberWalletId(localData, enrollmentKey);
  const preimage = prescriberWalletPreimage(localData, enrollmentKey);

  scrubObject(localData as unknown as Record<string, unknown>);

  return {
    walletId,
    preimage,
    dispose() {
      for (let i = 0; i < preimage.length; i++) {
        preimage[i] = Field(0);
      }
      preimage.length = 0;
    },
  };
}

/**
 * Securely derive a pharmacy wallet ID.
 * Input is scrubbed after derivation.
 */
export function securePharmacyDerivation(
  localData: PharmacyLocalData,
  enrollmentKey: string,
): SecureWalletResult {
  const walletId = derivePharmacyWalletId(localData, enrollmentKey);
  const preimage = pharmacyWalletPreimage(localData, enrollmentKey);

  scrubObject(localData as unknown as Record<string, unknown>);

  return {
    walletId,
    preimage,
    dispose() {
      for (let i = 0; i < preimage.length; i++) {
        preimage[i] = Field(0);
      }
      preimage.length = 0;
    },
  };
}

/**
 * Securely derive a representative wallet ID (AOR).
 * Input is scrubbed after derivation.
 */
export function secureRepresentativeDerivation(
  localData: RepresentativeLocalData,
  enrollmentKey: string,
): SecureWalletResult {
  const walletId = deriveRepresentativeWalletId(localData, enrollmentKey);
  const preimage = representativeWalletPreimage(localData, enrollmentKey);

  scrubObject(localData as unknown as Record<string, unknown>);

  return {
    walletId,
    preimage,
    dispose() {
      for (let i = 0; i < preimage.length; i++) {
        preimage[i] = Field(0);
      }
      preimage.length = 0;
    },
  };
}
