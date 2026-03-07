#!/usr/bin/env npx tsx
/**
 * extract-poseidon-constants.ts — Extract Poseidon constants + test vectors from o1js
 *
 * Extracts the MDS matrix and round constants from o1js's Poseidon implementation
 * for porting to Kotlin. Also generates test vectors.
 *
 * Usage:
 *   npx tsx scripts/extract-poseidon-constants.ts
 */
import { Field, Poseidon } from 'o1js';
import fs from 'fs';
import path from 'path';

// o1js Poseidon uses the Kimchi/Pasta constants
// We need to find them in the module internals
// The constants are compiled into the WASM blob but we can extract them
// by analyzing the hash behavior or from the o1js source

// First, generate test vectors
console.log('=== POSEIDON TEST VECTORS ===');
console.log('Field modulus (Pallas):', Field.ORDER.toString());
console.log('');

const vectors = [
  { input: [0n], label: 'hash([0])' },
  { input: [1n], label: 'hash([1])' },
  { input: [42n], label: 'hash([42])' },
  { input: [0n, 1n, 2n], label: 'hash([0,1,2])' },
  { input: [1n, 2n, 3n], label: 'hash([1,2,3])' },
  { input: [123456789n, 987654321n], label: 'hash([123456789,987654321])' },
];

for (const v of vectors) {
  const result = Poseidon.hash(v.input.map(x => Field(x)));
  console.log(`${v.label} = ${result.toString()}`);
}

// Now try to extract the actual Poseidon parameters
// o1js uses Poseidon with width=3 (rate=2, capacity=1) on the Pallas base field
// The constants come from the Pasta specification

// We can extract round constants by probing the permutation
// Or we can read them from the o1js node_modules source
const o1jsDir = path.resolve('node_modules/o1js');
const possiblePaths = [
  'dist/node/bindings/crypto/constants.js',
  'src/bindings/crypto/constants.ts',
  'dist/node/lib/provable/crypto/poseidon.js',
  'src/lib/provable/crypto/poseidon.ts',
];

console.log('\n=== SEARCHING FOR CONSTANTS ===');
for (const p of possiblePaths) {
  const full = path.join(o1jsDir, p);
  if (fs.existsSync(full)) {
    console.log('Found:', p);
    const content = fs.readFileSync(full, 'utf8');
    // Look for round constants or MDS matrix patterns
    if (content.includes('roundConstants') || content.includes('mds')) {
      console.log('  Contains round constants/MDS references');
      // Try to find the actual values
      const mdsMatch = content.match(/mds\s*[=:]\s*\[/);
      if (mdsMatch) console.log('  Found MDS matrix definition');
      const rcMatch = content.match(/roundConstants\s*[=:]\s*\[/);
      if (rcMatch) console.log('  Found round constants definition');
    }
  }
}

// Try direct WASM binding access
try {
  // @ts-ignore
  const poseidonInternal = Poseidon as any;
  console.log('\nPoseidon internals:', Object.getOwnPropertyNames(poseidonInternal));
  if (poseidonInternal.Sponge) {
    console.log('Poseidon.Sponge:', Object.getOwnPropertyNames(poseidonInternal.Sponge));
  }
} catch (e) {
  console.log('Could not access Poseidon internals:', e);
}

// The Pasta Poseidon constants are publicly documented
// We can hardcode them from the specification
// See: https://github.com/o1-labs/proof-systems/blob/master/poseidon/src/pasta/fp/params.rs
console.log('\n=== PASTA POSEIDON PARAMETERS ===');
console.log('Width: 3 (rate=2, capacity=1)');
console.log('Full rounds: 8 (4 before + 4 after partial)');
console.log('Partial rounds: 56');
console.log('Alpha (S-box exponent): 7');
console.log('Field: Pallas base field (Fp)');
console.log('');
console.log('Constants source: https://github.com/o1-labs/proof-systems/blob/master/poseidon/src/pasta/fp/');
