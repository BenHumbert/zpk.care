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

import { Field, Poseidon, Encoding } from 'o1js';
import { deriveMemberWalletId, memberWalletPreimage } from '../src/wallets/wallet-derivation.js';
import { hashString, hashDate } from '../src/zkp/hash-utils.js';

// Generate test vectors for Kotlin Poseidon port validation
const testMember = { cardholderId: 'TEST001', dateOfBirth: '19900115', genderCode: 1, firstName: 'John', lastName: 'Doe' };
const testKey = 'TestEnrollmentKey1234567890ABCDEF';
const TEST_SALT = 'ab'.repeat(32); // C1: member derivation takes the identity salt
const wid = deriveMemberWalletId(testMember, testKey, Field(0), TEST_SALT);
console.log('memberWalletId:', wid.toString());
const preimage = memberWalletPreimage(testMember, testKey, Field(0), TEST_SALT);
console.log('memberPreimage:', preimage.map(x => x.toString()));

// Individual hash steps
console.log('hashString(TEST001):', hashString('TEST001').toString());
console.log('hashDate(19900115):', hashDate('19900115').toString());
console.log('hashString(John):', hashString('John').toString());
console.log('hashString(Doe):', hashString('Doe').toString());
console.log('hashString(enrollmentKey):', hashString(testKey).toString());

// stringToFields encoding (how strings become Fields before Poseidon)
console.log('stringToFields(TEST001):', Encoding.stringToFields('TEST001').map(x => x.toString()));
console.log('stringToFields(John):', Encoding.stringToFields('John').map(x => x.toString()));
console.log('stringToFields(hello):', Encoding.stringToFields('hello').map(x => x.toString()));
console.log('stringToFields(a):', Encoding.stringToFields('a').map(x => x.toString()));

// Primitive Poseidon test vectors
console.log('Poseidon([0]):', Poseidon.hash([Field(0)]).toString());
console.log('Poseidon([1]):', Poseidon.hash([Field(1)]).toString());
console.log('Poseidon([0,1,2]):', Poseidon.hash([Field(0), Field(1), Field(2)]).toString());
console.log('Poseidon([42]):', Poseidon.hash([Field(42)]).toString());

// Field modulus (Pallas base field)
console.log('FIELD_MODULUS:', Field.ORDER.toString());
