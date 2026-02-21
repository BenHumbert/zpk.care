# zkpCare vs. Shandong (US11411737B2): Circuit-as-Adjudicator Distinction

## The Core Claim

In zkpCare, **ZK circuit constraints ARE the adjudication rules**. No adjudication authority exists. The proof IS the result.

This is not a marketing distinction — it is a verifiable architectural difference traceable to specific lines of code where `Provable.if()`, `.assertEquals()`, `.lessThanOrEqual()`, and `Poseidon.hash()` enforce healthcare business rules as mathematical constraints inside a zero-knowledge circuit. The prover cannot produce a valid proof without satisfying every constraint. The verifier learns the result (patient pay, plan pay) without seeing any claim data. No intermediary, smart contract, or adjudication engine makes a decision after the proof is generated.

---

## What Shandong Does

Shandong's architecture:
1. ZKP authenticates data (proves data is genuine, unaltered)
2. Authenticated data is submitted to a smart contract
3. The smart contract (or an on-chain process) **adjudicates** — it reads the claim data, applies rules, and computes the payment

The ZKP is a **gatekeeper**. It answers: "Is this data authentic?" Then a separate authority answers: "What should we pay?"

## What zkpCare Does

zkpCare's architecture:
1. The ZK circuit **simultaneously** authenticates data AND computes the adjudication result
2. The proof's public output contains `patientPayCents` and `planPayCents` — the adjudication IS the proof
3. No smart contract, no adjudication engine, no authority reads the claim data
4. The blockchain receives a single recursive proof and updates two Merkle roots — it never sees the claim

The ZKP is the **adjudicator**. Authentication and adjudication are fused into a single circuit execution. The answer to "Is this data authentic?" and "What should we pay?" is one atomic mathematical object.

---

## Evidence from Code: The 22-Step Adjudication Circuit

The following is from `src/fulfillment/accumulator-fulfillment-program.ts`, method `proveFulfillmentWithAccumulator`. Each step is an in-circuit constraint — not a service-layer check, not a smart contract rule, but a mathematical assertion that the prover must satisfy to produce a valid SNARK.

### Steps 1-2: NFT Integrity (Authentication)

```typescript
// Step 1 (line 122): NFT type must be PRESCRIPTION
nftData.nftType.assertEquals(NFT_TYPE_PRESCRIPTION, 'NFT type must be PRESCRIPTION');

// Step 2 (line 128): NFT is not revoked
nftData.revoked.assertEquals(Field(0), 'NFT is revoked');
```

These are authentication constraints. Shandong also authenticates data. **Not yet novel.**

### Steps 2b: Pharmacy Identity Binding (Authentication)

```typescript
// Step 2b (lines 131-139): Pharmacy wallet identity binding
const computedPharmacyWalletId = Poseidon.hash([
  DOMAIN_TAG_PHARMACY,
  pharmacyQualifier,
  pharmacyServiceProviderIdHash,
  pharmacyEnrollmentKeyHash,
]);
computedPharmacyWalletId.assertEquals(
  fulfillmentData.pharmacyWalletId,
  'Pharmacy wallet identity binding failed',
);
```

The pharmacy proves it is who it claims to be by demonstrating knowledge of preimage fields that hash to its walletId. Shandong uses ZKP for identity too. **Still not yet novel.**

### Steps 3-12: Cross-NFT Data Integrity (Authentication + Structural Verification)

```typescript
// Step 3 (line 143): Forest root integrity — proves all 6 domain trees are consistent
computedForestRoot.assertEquals(nftData.forestRoot, 'Forest root mismatch');

// Step 4 (line 150): Prescription exists in MEDICATION tree (Merkle inclusion proof)
medicationWitness.calculateRoot(rxCommitment).assertEquals(forestRoots.medicationRoot);

// Step 5 (line 159): Latest status exists in TRANSACTION tree
statusWitness.calculateRoot(latestStatus.commitment()).assertEquals(forestRoots.transactionRoot);

// Step 6 (line 167): Status must be FILLED or PARTIALLY_FILLED
isFilled.or(isPartiallyFilled).assertTrue('Prescription must be FILLED or PARTIALLY_FILLED');

// Step 8 (line 182): Fulfillment links to correct prescription (no cross-contamination)
fulfillmentData.prescriptionHash.assertEquals(rxCommitment);

// Step 9 (line 188): NDC drug code matches prescription
fulfillmentData.ndcHash.assertEquals(prescriptionData.ndcHash, 'NDC does not match prescription');

// Step 10 (line 194): Quantity within formulary limits (FWA guard)
fulfillmentData.quantityDispensed.lessThanOrEqual(formularyEntry.maxQuantityPerFill)
  .assertTrue('Quantity exceeds max per fill');

// Step 10b (line 199): Quantity dispensed <= quantity prescribed (anti-fraud)
fulfillmentData.quantityDispensed.lessThanOrEqual(prescriptionData.quantityPrescribed)
  .assertTrue('Quantity dispensed exceeds quantity prescribed');

// Step 11 (line 204): Formulary entry exists in formulary tree
formularyWitness.calculateRoot(formularyEntry.commitment()).assertEquals(formularyRoot);

// Step 12 (line 212): Formulary NDC matches claim NDC
formularyEntry.ndcHash.assertEquals(fulfillmentData.ndcHash);
```

These verify the structural integrity of cross-NFT references — the prescription NFT, the formulary, the medication data. Some of this is novel (dual-NFT Merkle forest verification), but the killer distinction begins at Step 13.

### Steps 13-15: Cross-Patient Eligibility Binding (Novel)

```typescript
// Step 13 (line 220): Eligibility NFT is correct type and not revoked
eligNftData.nftType.assertEquals(NFT_TYPE_ELIGIBILITY);
eligNftData.revoked.assertEquals(Field(0), 'Elig NFT is revoked');

// Step 13b (line 228): THE PATIENT IDENTITY BINDING
// Prevents using a different patient's accumulator state (H1 security fix)
prescriptionData.memberWalletId.assertEquals(
  eligNftData.subjectWalletId,
  'Prescription patient does not match eligibility NFT subject',
);

// Step 14 (line 234): Eligibility forest root integrity
eligComputedRoot.assertEquals(eligNftData.forestRoot, 'Elig forest root mismatch');

// Step 15 (line 241): Accumulator state exists in eligibility ACCESS_CONTROL tree
accumulatorWitness.calculateRoot(accumulator.commitment())
  .assertEquals(eligForestRoots.accessControlRoot);
```

**This is already beyond Shandong.** The circuit enforces that the accumulator (deductible paid, OOP paid) belongs to the same patient as the prescription. A prover cannot substitute someone else's accumulator. This is not a smart contract check — it is a constraint that must be satisfied before the proof can even exist.

### Step 16: THE ADJUDICATION (Entirely Novel — No Equivalent in Shandong)

This is the heart of the distinction. The following code runs **inside the ZK circuit**. It is not a service-layer calculation. It is not a smart contract. It is a set of mathematical constraints that the prover must satisfy. The result (`patientPay`, `planPay`) becomes part of the proof's public output — it is cryptographically bound to the verified inputs.

#### 16a: Deductible Phase Detection

```typescript
// Lines 262-278: Deductible calculation — IN-CIRCUIT
const hasDeductible = accumulator.deductibleAmountCents.greaterThan(Field(0));
const deductibleMet = accumulator.deductiblePaidCents
  .greaterThanOrEqual(accumulator.deductibleAmountCents);
const inDeductiblePhase = hasDeductible.and(deductibleMet.not());

const remainingDeductible = Provable.if(
  inDeductiblePhase,
  accumulator.deductibleAmountCents.sub(accumulator.deductiblePaidCents),
  Field(0),
);

// Deductible portion = min(total, remainingDeductible)
const deductiblePay = Provable.if(
  total.lessThan(remainingDeductible),
  total,
  remainingDeductible,
);
```

`Provable.if()` is an o1js circuit primitive. It creates a conditional constraint — both branches are computed, and the circuit selects the correct one based on the boolean. This is not an if-statement that runs on a server. This is a constraint that becomes part of the proof's R1CS representation.

#### 16b: Split Payment (Deductible Straddling)

```typescript
// Lines 283-301: When a claim straddles the deductible boundary
const afterDeductible = total.sub(deductiblePay);

const copayOnRemainder = Provable.if(
  afterDeductible.lessThan(copay),
  afterDeductible,
  copay,
);

const normalPay = Provable.if(total.lessThan(copay), total, copay);

const basePay = Provable.if(
  inDeductiblePhase,
  deductiblePay.add(copayOnRemainder),
  normalPay,
);
```

This handles a real healthcare scenario: a $500 deductible with $480 already paid, a $55 claim. The circuit computes: $20 toward remaining deductible + copay on the remaining $35. No adjudication authority makes this decision. The math is the authority.

#### 16c: Annual Benefit Maximum Cap

```typescript
// Lines 303-328: Benefit exhaustion mid-claim
const hasBenefitMax = accumulator.annualBenefitMaxCents.greaterThan(Field(0));
const benefitFullyExhausted = hasBenefitMax.and(
  accumulator.annualBenefitUsedCents
    .greaterThanOrEqual(accumulator.annualBenefitMaxCents),
);

const remainingBenefit = Provable.if(
  benefitFullyExhausted,
  Field(0),
  Provable.if(
    hasBenefitMax,
    accumulator.annualBenefitMaxCents.sub(accumulator.annualBenefitUsedCents),
    basePlanPay,
  ),
);

const cappedPlanPay = Provable.if(
  hasBenefitMax.and(basePlanPay.greaterThan(remainingBenefit)),
  remainingBenefit,
  basePlanPay,
);
```

#### 16d: Out-of-Pocket Maximum Cap (ACA Compliance)

```typescript
// Lines 333-358: OOPM mid-claim cap — ACA regulatory requirement
const hasOopm = accumulator.oopMaxCents.greaterThan(Field(0));
const oopFullyMet = hasOopm.and(
  accumulator.oopPaidCents
    .greaterThanOrEqual(accumulator.oopMaxCents),
);

const remainingOopm = Provable.if(
  oopFullyMet,
  Field(0),
  Provable.if(
    hasOopm,
    accumulator.oopMaxCents.sub(accumulator.oopPaidCents),
    postBenefitPay,
  ),
);

// Final patient pay: capped at remaining OOPM
const patientPay = Provable.if(
  hasOopm.and(postBenefitPay.greaterThan(remainingOopm)),
  remainingOopm,
  postBenefitPay,
);

const planPay = total.sub(patientPay);
```

**This is the ACA out-of-pocket maximum — a federal regulatory requirement — enforced as a ZK circuit constraint.** If a patient has hit their $8,000 OOP max, the circuit mathematically prevents any further patient payment. No authority decides this. The constraint is baked into the proof system.

### Steps 17-22: Settlement Commitment & State Mutation

```typescript
// Step 17 (lines 372-378): Settlement commitment — cryptographic receipt
const settlementCommitment = Poseidon.hash([
  fulfillmentCommitment,
  patientPay,
  planPay,
  deductibleCredit,
]);

// Step 18 (lines 382-390): Accumulator update — IN-CIRCUIT
const newAccumulatorCommitment = Poseidon.hash([
  accumulator.planYear,
  accumulator.deductibleAmountCents,
  accumulator.deductiblePaidCents.add(deductibleCredit),   // ← running deductible
  accumulator.oopMaxCents,
  accumulator.oopPaidCents.add(patientPay),                // ← running OOP
  accumulator.annualBenefitMaxCents,
  accumulator.annualBenefitUsedCents.add(planPay),         // ← running benefit used
]);

// Steps 19-22: Compute new Merkle roots for both NFTs (prescription + eligibility)
// The eligibility NFT's forest root changes because the accumulator leaf changed
```

The accumulator update is also in-circuit. The new deductible paid, OOP paid, and benefit used values are computed by the proof. The next claim will use these values as inputs, creating a cryptographic chain where each claim's adjudication is provably based on the correct running totals.

### The Public Output: The Proof IS the Result

```typescript
// Lines 421-433: Public output
return {
  publicOutput: new AccumulatorFulfillmentOutput({
    prescriptionHash: rxCommitment,
    oldForestRoot: nftData.forestRoot,
    newForestRoot,
    entryCommitment: fulfillmentCommitment,
    patientPayCents: patientPay,       // ← ADJUDICATION RESULT
    planPayCents: planPay,             // ← ADJUDICATION RESULT
    operationType: FULFILL_OP_CLAIM,
    newEligibilityForestRoot: newEligForestRoot,
    deductibleCreditCents: deductibleCredit,
    ndcHash: fulfillmentData.ndcHash,
  }),
};
```

`patientPayCents` and `planPayCents` are public outputs of the ZK proof. They are not computed by a smart contract after the proof is verified. They are not computed by an adjudication engine. They emerge from the circuit constraints themselves. Anyone can verify the proof and read these values, but nobody — not even the prover — can produce a proof where these values don't match the constraint-enforced calculation.

---

## The Distinction, Precisely

| Aspect | Shandong (US11411737B2) | zkpCare |
|--------|------------------------|---------|
| **What the ZKP proves** | "This data is authentic" | "This data is authentic AND this is the correct payment split" |
| **Who adjudicates** | A smart contract reads the data and applies rules | Nobody. The circuit constraints ARE the rules. |
| **What the blockchain sees** | Claim data (even if ZK-verified) → adjudication logic on-chain | A single recursive proof → two Merkle root updates. Zero claim data. |
| **Can the adjudication be wrong?** | Yes — if the smart contract has a bug, it can produce incorrect results from valid data | No — if the proof verifies, the adjudication is mathematically correct by construction |
| **Can the adjudicator be corrupted?** | Yes — the smart contract can be modified, the node operator can manipulate | No adjudicator exists to corrupt. The circuit is immutable math. |
| **Regulatory compliance** | Checked by the smart contract at runtime | Baked into the circuit. ACA OOPM cap is a `Provable.if()` constraint. |
| **Separation of authentication and adjudication** | Two distinct steps: ZKP → smart contract | Fused: authentication constraints and adjudication constraints are interleaved in the same circuit |
| **Public output** | "Data is valid" (boolean) | "Data is valid, patient pays $X, plan pays $Y, deductible credit $Z, new accumulator root R" |

---

## Why This Matters for Patentability

Shandong's ZKP answers a yes/no question: "Is this data authentic?" The adjudication decision is made by a separate computational entity (smart contract) that has access to the cleartext claim data.

zkpCare's ZKP answers a computational question: "Given these verified inputs (prescription, formulary, accumulator, pharmacy identity, patient identity), what is the correct patient/plan pay split?" The answer is a mathematical consequence of the circuit constraints. No entity ever sees the cleartext claim data and makes a decision based on it. The decision is a property of the proof itself.

This is not an incremental improvement on Shandong. It is a fundamentally different computational model:

- **Shandong**: Data → ZKP(authentication) → Authority(adjudication) → Result
- **zkpCare**: Data → ZKP(authentication + adjudication) → Result

The authority is removed from the pipeline. The proof is the result. This is verifiable by examining the circuit code: every `Provable.if()`, every `.assertEquals()`, every `.lessThanOrEqual()` in the 22-step circuit is a healthcare adjudication rule encoded as a mathematical constraint. An examiner can trace each line to a specific claims processing rule (deductible phase, copay calculation, benefit cap, OOPM cap) and verify that no external authority participates in the decision.

---

## Output Evidence

From the actual sequencer log during a fill:

```
[proof] [3/3] Generating AccumulatorFulfillment.proveFulfillmentWithAccumulator...
[info]        THE CLAIM: Dual-NFT fulfillment with accumulator update
[info]        15 private inputs verified in a single ZK circuit

[proof] [3/3] AccumulatorFulfillment proof generated (48.23s)

ADJUDICATION (ZK-enforced in-circuit):
  Service Date:  02/19/2026
  Phase:         DEDUCTIBLE (not yet met)
  Total Cost:    $55.00
  Patient Pay:   $55.00    ← computed by circuit constraint
  Plan Pay:      $0.00     ← computed by circuit constraint

ACCUMULATOR (BEFORE → AFTER):
  Deductible:    $0.00 → $55.00 / $500.00
  Out-of-Pocket: $0.00 → $55.00 / $8,000.00
```

The patient pay of $55.00 and plan pay of $0.00 are not decisions made by an adjudication engine. They are public outputs of a ZK proof whose constraints enforce: "If deductiblePaidCents < deductibleAmountCents, then patientPay = min(totalCost, remainingDeductible)." The $55.00 is a mathematical fact proven by the circuit.
