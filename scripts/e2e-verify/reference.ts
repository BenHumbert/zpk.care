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
 * Independent reference implementations used by the end-to-end verifier.
 *
 * These deliberately re-derive values in plain arithmetic (bigint) or by calling
 * the hash primitives directly, so a bug in a circuit or route shows up as a
 * mismatch instead of being copied into the expected value.
 */

export interface AccumulatorState {
  deductibleAmountCents: bigint;
  deductiblePaidCents: bigint;
  oopMaxCents: bigint;
  oopPaidCents: bigint;
  annualBenefitMaxCents: bigint;
  annualBenefitUsedCents: bigint;
}

export interface AdjudicationExpectation {
  total: bigint;
  patientPay: bigint;
  planPay: bigint;
  deductibleCredit: bigint;
  phase: 'deductible' | 'copay' | 'benefit-capped' | 'oop-capped';
}

const min = (a: bigint, b: bigint) => (a < b ? a : b);

/**
 * Plain-arithmetic restatement of AccumulatorFulfillmentProgram step 16
 * (src/fulfillment/accumulator-fulfillment-program.ts:264-384), written from the
 * plan rules rather than copied from the circuit:
 *   1. Deductible first: patient pays min(total, remaining deductible).
 *   2. Then copay on whatever is left (or min(total, copay) when no deductible is owed).
 *   3. The plan never pays past the annual benefit maximum; the patient picks up the rest.
 *   4. The patient never pays past the out-of-pocket maximum; the plan picks up the rest.
 */
export function expectedAdjudication(
  ingredientCostCents: bigint,
  dispensingFeeCents: bigint,
  copayCents: bigint,
  acc: AccumulatorState,
): AdjudicationExpectation {
  const total = ingredientCostCents + dispensingFeeCents;
  let phase: AdjudicationExpectation['phase'] = 'copay';

  const owesDeductible = acc.deductibleAmountCents > 0n && acc.deductiblePaidCents < acc.deductibleAmountCents;
  const remainingDeductible = owesDeductible ? acc.deductibleAmountCents - acc.deductiblePaidCents : 0n;
  const deductiblePay = min(total, remainingDeductible);
  let patient: bigint;
  if (owesDeductible) {
    phase = 'deductible';
    patient = deductiblePay + min(total - deductiblePay, copayCents);
  } else {
    patient = min(total, copayCents);
  }

  // Annual benefit maximum (0 = no limit).
  if (acc.annualBenefitMaxCents > 0n) {
    const remainingBenefit = acc.annualBenefitUsedCents >= acc.annualBenefitMaxCents
      ? 0n : acc.annualBenefitMaxCents - acc.annualBenefitUsedCents;
    const plan = total - patient;
    if (plan > remainingBenefit) { patient = total - remainingBenefit; phase = 'benefit-capped'; }
  }

  // Out-of-pocket maximum (0 = no limit).
  if (acc.oopMaxCents > 0n) {
    const remainingOop = acc.oopPaidCents >= acc.oopMaxCents ? 0n : acc.oopMaxCents - acc.oopPaidCents;
    if (patient > remainingOop) { patient = remainingOop; phase = 'oop-capped'; }
  }

  return {
    total,
    patientPay: patient,
    planPay: total - patient,
    deductibleCredit: min(deductiblePay, patient),
    phase,
  };
}

/** Recursively collect every string/number leaf under an object, with its JSON path. */
export function leaves(obj: unknown, path = '$', out: Array<{ path: string; value: string }> = []) {
  if (obj === null || obj === undefined) return out;
  if (typeof obj === 'string' || typeof obj === 'number' || typeof obj === 'bigint' || typeof obj === 'boolean') {
    out.push({ path, value: String(obj) });
  } else if (Array.isArray(obj)) {
    obj.forEach((v, i) => leaves(v, `${path}[${i}]`, out));
  } else if (typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) leaves(v, `${path}.${k}`, out);
  }
  return out;
}

/** Find where any of the given secrets appear inside a blob of text (case-insensitive for words). */
export function findSecrets(text: string, secrets: Record<string, string>) {
  const hits: Array<{ secret: string; index: number; context: string }> = [];
  const lower = text.toLowerCase();
  for (const [name, value] of Object.entries(secrets)) {
    if (!value || value.length < 4) continue;
    let i = lower.indexOf(value.toLowerCase());
    while (i !== -1 && hits.filter(h => h.secret === name).length < 5) {
      hits.push({ secret: name, index: i, context: text.slice(Math.max(0, i - 60), i + value.length + 60).replace(/\s+/g, ' ') });
      i = lower.indexOf(value.toLowerCase(), i + 1);
    }
  }
  return hits;
}
