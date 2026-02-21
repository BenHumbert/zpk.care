/**
 * Minimal 3-level recursion reproduction test.
 *
 * Isolates the BatchProgram.wrapTransition pickles error to determine
 * whether the root cause is:
 *   (a) 3-level recursion depth itself, OR
 *   (b) Heterogeneous method signatures (1 proof vs 2 proofs in same ZkProgram)
 *
 * Test matrix:
 *   1. ProgramA (0 proofs) → ProgramB (1 proof) → ProgramC_Uniform (1 proof only)
 *      If this PASSES: 3-level depth works when all methods have same proof count
 *
 *   2. ProgramA (0 proofs) → ProgramB (1 proof) → ProgramC_Mixed (1 proof + 2 SelfProofs)
 *      If this FAILS: the issue is heterogeneous methods + dummy proofs (Issue #1939)
 *
 * Run:
 *   NODE_OPTIONS="--max-old-space-size=8192" npx jest tests/minimal-recursion.test.ts --verbose --maxWorkers=1
 */
import { Field, Poseidon, ZkProgram, SelfProof, Struct, DynamicProof, FeatureFlags, Proof, VerificationKey } from 'o1js';

// ─── Level 1: Simple base program ─────────────────────
const ProgramA = ZkProgram({
  name: 'MinA',
  publicInput: Field,
  methods: {
    compute: {
      privateInputs: [Field],
      async method(publicVal: Field, secret: Field) {
        Poseidon.hash([secret]).assertEquals(publicVal);
      },
    },
  },
});
class ProofA extends ZkProgram.Proof(ProgramA) {}

// ─── Level 2: Wraps ProgramA proof ────────────────────
class OutputB extends Struct({ value: Field }) {}

const ProgramB = ZkProgram({
  name: 'MinB',
  publicOutput: OutputB,
  methods: {
    wrap: {
      privateInputs: [ProofA],
      async method(proofA: InstanceType<typeof ProofA>) {
        proofA.verify();
        return { publicOutput: new OutputB({ value: proofA.publicInput }) };
      },
    },
  },
});
class ProofB extends ZkProgram.Proof(ProgramB) {}

// ─── Level 3a: UNIFORM — only 1 proof per method ─────
class OutputC extends Struct({ value: Field, count: Field }) {}

const ProgramC_Uniform = ZkProgram({
  name: 'MinC_Uniform',
  publicOutput: OutputC,
  methods: {
    wrap: {
      privateInputs: [ProofB],
      async method(proofB: InstanceType<typeof ProofB>) {
        proofB.verify();
        return {
          publicOutput: new OutputC({
            value: proofB.publicOutput.value,
            count: Field(1),
          }),
        };
      },
    },
  },
});

// ─── Level 3b: MIXED — 1 proof + 2 SelfProofs ────────
const ProgramC_Mixed = ZkProgram({
  name: 'MinC_Mixed',
  publicOutput: OutputC,
  methods: {
    wrap: {
      privateInputs: [ProofB],
      async method(proofB: InstanceType<typeof ProofB>) {
        proofB.verify();
        return {
          publicOutput: new OutputC({
            value: proofB.publicOutput.value,
            count: Field(1),
          }),
        };
      },
    },
    merge: {
      privateInputs: [SelfProof, SelfProof],
      async method(
        left: SelfProof<undefined, OutputC>,
        right: SelfProof<undefined, OutputC>,
      ) {
        left.verify();
        right.verify();
        return {
          publicOutput: new OutputC({
            value: left.publicOutput.value,
            count: left.publicOutput.count.add(right.publicOutput.count),
          }),
        };
      },
    },
  },
});

// ─── Level 3c: UNIFORM PAIR — 2 proofs per method ────
// Both wrapPair (2 ProofB) and merge (2 SelfProof) take 2 proofs.
// maxProofsVerified = 2, uniform → no dummy proofs needed.
const ProgramC_UniformPair = ZkProgram({
  name: 'MinC_UniformPair',
  publicOutput: OutputC,
  methods: {
    wrapPair: {
      privateInputs: [ProofB, ProofB],
      async method(
        proof1: InstanceType<typeof ProofB>,
        proof2: InstanceType<typeof ProofB>,
      ) {
        proof1.verify();
        proof2.verify();
        // Enforce chain: proof1's output feeds into proof2
        proof1.publicOutput.value.assertEquals(proof2.publicOutput.value);
        return {
          publicOutput: new OutputC({
            value: proof1.publicOutput.value,
            count: Field(2),
          }),
        };
      },
    },
    merge: {
      privateInputs: [SelfProof, SelfProof],
      async method(
        left: SelfProof<undefined, OutputC>,
        right: SelfProof<undefined, OutputC>,
      ) {
        left.verify();
        right.verify();
        return {
          publicOutput: new OutputC({
            value: left.publicOutput.value,
            count: left.publicOutput.count.add(right.publicOutput.count),
          }),
        };
      },
    },
  },
});

// ─── Helpers ──────────────────────────────────────────
const mem = () => {
  const m = process.memoryUsage();
  return `heap=${(m.heapUsed / 1024 / 1024).toFixed(0)}MB rss=${(m.rss / 1024 / 1024).toFixed(0)}MB`;
};
const secs = (t: number) => ((Date.now() - t) / 1000).toFixed(1);

// ─── Tests ────────────────────────────────────────────
describe('Minimal 3-level recursion', () => {
  const secret = Field(42);
  const publicVal = Poseidon.hash([secret]);

  let proofA: InstanceType<typeof ProofA>;
  let proofB: InstanceType<typeof ProofB>;

  // Compile A and B (shared across both test groups)
  beforeAll(async () => {
    console.log(`\n[compile] ProgramA... (${mem()})`);
    let t = Date.now();
    await ProgramA.compile();
    console.log(`[compile] ProgramA DONE in ${secs(t)}s (${mem()})`);

    console.log(`[compile] ProgramB... (${mem()})`);
    t = Date.now();
    await ProgramB.compile();
    console.log(`[compile] ProgramB DONE in ${secs(t)}s (${mem()})`);

    // Generate shared proofs
    console.log(`[prove] ProgramA.compute...`);
    t = Date.now();
    const resultA = await ProgramA.compute(publicVal, secret);
    proofA = resultA.proof as InstanceType<typeof ProofA>;
    console.log(`[prove] ProgramA done in ${secs(t)}s`);

    console.log(`[prove] ProgramB.wrap...`);
    t = Date.now();
    const resultB = await ProgramB.wrap(proofA);
    proofB = resultB.proof as InstanceType<typeof ProofB>;
    console.log(`[prove] ProgramB done in ${secs(t)}s`);
  }, 300_000);

  test('3-level UNIFORM: ProgramC with only wrap method (maxProofsVerified=1)', async () => {
    console.log(`\n── UNIFORM test (${mem()}) ──`);
    let t = Date.now();

    console.log(`[compile] ProgramC_Uniform...`);
    await ProgramC_Uniform.compile();
    console.log(`[compile] ProgramC_Uniform DONE in ${secs(t)}s (${mem()})`);

    console.log(`[prove] ProgramC_Uniform.wrap...`);
    t = Date.now();
    const resultC = await ProgramC_Uniform.wrap(proofB);
    console.log(`[prove] ProgramC_Uniform.wrap done in ${secs(t)}s`);

    const output = resultC.proof.publicOutput as unknown as OutputC;
    expect(output.value.toString()).toBe(publicVal.toString());
    expect(output.count.toString()).toBe('1');
    console.log(`✓ UNIFORM test PASSED (${mem()})\n`);
  }, 300_000);

  test('3-level UNIFORM PAIR: ProgramC with wrapPair + merge (both 2 proofs, maxProofsVerified=2)', async () => {
    console.log(`\n── UNIFORM PAIR test (${mem()}) ──`);
    let t = Date.now();

    console.log(`[compile] ProgramC_UniformPair...`);
    await ProgramC_UniformPair.compile();
    console.log(`[compile] ProgramC_UniformPair DONE in ${secs(t)}s (${mem()})`);

    // Generate a second ProofB (from the same ProgramA proof)
    console.log(`[prove] ProgramB.wrap (second ProofB)...`);
    let s = Date.now();
    const resultB2 = await ProgramB.wrap(proofA);
    const proofB2 = resultB2.proof as InstanceType<typeof ProofB>;
    console.log(`[prove] ProgramB done in ${secs(s)}s`);

    console.log(`[prove] ProgramC_UniformPair.wrapPair...`);
    s = Date.now();
    const resultC = await ProgramC_UniformPair.wrapPair(proofB, proofB2);
    console.log(`[prove] ProgramC_UniformPair.wrapPair done in ${secs(s)}s`);

    const output = resultC.proof.publicOutput as unknown as OutputC;
    expect(output.value.toString()).toBe(publicVal.toString());
    expect(output.count.toString()).toBe('2');
    console.log(`✓ UNIFORM PAIR test PASSED (${mem()})\n`);
  }, 300_000);

  test.skip('3-level MIXED: ProgramC with wrap + merge methods (maxProofsVerified=2)', async () => {
    // KNOWN FAILURE: maxProofsVerified=2 at depth 2+ triggers Pickles wrap_main.ml bug
  }, 300_000);
});

// ═══════════════════════════════════════════════════════════
//  FLATTENED ARCHITECTURE TEST
//
//  The fix: eliminate 1 level of recursion by inlining
//  ProgramA's logic into ProgramB_Flat. This reduces the
//  chain from 3 to 2 levels, allowing maxProofsVerified=2
//  at depth 1 (which is supported).
//
//  Chain: ProgramB_Flat (depth 0, inline A logic) → ProgramC_Flat (depth 1, wrap+merge)
// ═══════════════════════════════════════════════════════════

// ─── Flattened Level 0: Inlines ProgramA's logic ─────
class OutputBFlat extends Struct({ value: Field }) {}

const ProgramB_Flat = ZkProgram({
  name: 'MinB_Flat',
  publicOutput: OutputBFlat,
  methods: {
    // Inlines the Poseidon.hash check that ProgramA did, no recursive proof
    compute: {
      privateInputs: [Field],
      async method(secret: Field) {
        const value = Poseidon.hash([secret]);
        return { publicOutput: new OutputBFlat({ value }) };
      },
    },
  },
});
class ProofBFlat extends ZkProgram.Proof(ProgramB_Flat) {}

// ─── Flattened Level 1: wrap + merge, maxProofsVerified=2 ─
class OutputCFlat extends Struct({ value: Field, count: Field }) {}

const ProgramC_Flat = ZkProgram({
  name: 'MinC_Flat',
  publicOutput: OutputCFlat,
  methods: {
    wrapPair: {
      privateInputs: [ProofBFlat, ProofBFlat],
      async method(
        proof1: InstanceType<typeof ProofBFlat>,
        proof2: InstanceType<typeof ProofBFlat>,
      ) {
        proof1.verify();
        proof2.verify();
        proof1.publicOutput.value.assertEquals(proof2.publicOutput.value);
        return {
          publicOutput: new OutputCFlat({
            value: proof1.publicOutput.value,
            count: Field(2),
          }),
        };
      },
    },
    merge: {
      privateInputs: [SelfProof, SelfProof],
      async method(
        left: SelfProof<undefined, OutputCFlat>,
        right: SelfProof<undefined, OutputCFlat>,
      ) {
        left.verify();
        right.verify();
        return {
          publicOutput: new OutputCFlat({
            value: left.publicOutput.value,
            count: left.publicOutput.count.add(right.publicOutput.count),
          }),
        };
      },
    },
  },
});

describe('Flattened 2-level recursion (the fix)', () => {
  const secret = Field(42);

  test('wrapPair + merge at depth 1 with maxProofsVerified=2', async () => {
    console.log(`\n── FLATTENED test (${mem()}) ──`);
    let t = Date.now();

    console.log(`[compile] ProgramB_Flat...`);
    let s = Date.now();
    await ProgramB_Flat.compile();
    console.log(`[compile] ProgramB_Flat DONE in ${secs(s)}s (${mem()})`);

    console.log(`[compile] ProgramC_Flat...`);
    s = Date.now();
    await ProgramC_Flat.compile();
    console.log(`[compile] ProgramC_Flat DONE in ${secs(s)}s (${mem()})`);

    // Generate 2 ProgramB_Flat proofs
    console.log(`[prove] ProgramB_Flat.compute x2...`);
    s = Date.now();
    const r1 = await ProgramB_Flat.compute(secret);
    const r2 = await ProgramB_Flat.compute(secret);
    const p1 = r1.proof as InstanceType<typeof ProofBFlat>;
    const p2 = r2.proof as InstanceType<typeof ProofBFlat>;
    console.log(`[prove] ProgramB_Flat x2 done in ${secs(s)}s`);

    // wrapPair: wraps 2 proofs
    console.log(`[prove] ProgramC_Flat.wrapPair...`);
    s = Date.now();
    const wrapResult = await ProgramC_Flat.wrapPair(p1, p2);
    console.log(`[prove] wrapPair done in ${secs(s)}s`);

    const wrapOutput = wrapResult.proof.publicOutput as unknown as OutputCFlat;
    expect(wrapOutput.count.toString()).toBe('2');

    // Generate 2 more and wrapPair for merge test
    console.log(`[prove] ProgramB_Flat.compute x2 (for merge)...`);
    s = Date.now();
    const r3 = await ProgramB_Flat.compute(secret);
    const r4 = await ProgramB_Flat.compute(secret);
    const p3 = r3.proof as InstanceType<typeof ProofBFlat>;
    const p4 = r4.proof as InstanceType<typeof ProofBFlat>;
    console.log(`[prove] ProgramB_Flat x2 done in ${secs(s)}s`);

    console.log(`[prove] ProgramC_Flat.wrapPair (second pair)...`);
    s = Date.now();
    const wrapResult2 = await ProgramC_Flat.wrapPair(p3, p4);
    console.log(`[prove] wrapPair done in ${secs(s)}s`);

    // merge: combines 2 wrapped pairs
    console.log(`[prove] ProgramC_Flat.merge...`);
    s = Date.now();
    const mergeResult = await ProgramC_Flat.merge(
      wrapResult.proof as any,
      wrapResult2.proof as any,
    );
    console.log(`[prove] merge done in ${secs(s)}s`);

    const mergeOutput = mergeResult.proof.publicOutput as unknown as OutputCFlat;
    expect(mergeOutput.count.toString()).toBe('4');

    console.log(`✓ FLATTENED test PASSED in ${secs(t)}s (${mem()})\n`);
  }, 600_000);
});
