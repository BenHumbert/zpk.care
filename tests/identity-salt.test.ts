/**
 * Salted identity fields — plan item C1, finding A-1.
 *
 * The audit inverted every member's name and birth date from the unsalted per-field hashes. The salt
 * goes into each identity field hash off-circuit; the wallet is still the Poseidon of the domain tag
 * and the six field hashes, so every circuit that re-derives a wallet is untouched.
 */
import { Field, Poseidon } from 'o1js';
import { hashString, hashDate, hashIdentityField, hashIdentityDate, isIdentitySalt } from '../src/zkp/hash-utils.js';
import {
  deriveMemberWalletId, memberWalletPreimage, memberTransitionPreimage, generateIdentitySalt, DOMAIN_TAG_MEMBER, paddedPreimage,
} from '../src/wallets/wallet-derivation.js';
import { secureMemberDerivation } from '../src/security/secure-context.js';
import { fixtureIdentitySalt, MEMBERS } from '../src/data/index.js';
import type { MemberLocalData } from '../src/models/member.js';

const alice: MemberLocalData = { cardholderId: 'CH-001', dateOfBirth: '19900115', genderCode: 2, firstName: 'Alice', lastName: 'Member' };
const KEY = 'a-real-enrollment-key-of-32-bytes-base64url';
const GROUP = hashString('GRP-TEST');

describe('the salted field hashes', () => {
  const salt = generateIdentitySalt();

  test('a salt is 32 bytes of hex and fresh each time', () => {
    expect(isIdentitySalt(salt)).toBe(true);
    expect(generateIdentitySalt()).not.toBe(salt);
    expect(isIdentitySalt('short')).toBe(false);
    expect(isIdentitySalt(undefined)).toBe(false);
  });

  test('differ from the unsalted hashes and from each other under different salts', () => {
    expect(hashIdentityField('Alice', salt).toString()).not.toBe(hashString('Alice').toString());
    expect(hashIdentityDate('19900115', salt).toString()).not.toBe(hashDate('19900115').toString());
    const other = generateIdentitySalt();
    expect(hashIdentityField('Alice', salt).toString()).not.toBe(hashIdentityField('Alice', other).toString());
    expect(hashIdentityDate('19900115', salt).toString()).not.toBe(hashIdentityDate('19900115', other).toString());
  });

  test('are deterministic for one salt, and refuse a malformed one', () => {
    expect(hashIdentityField('Alice', salt).toString()).toBe(hashIdentityField('Alice', salt).toString());
    expect(() => hashIdentityField('Alice', 'nope')).toThrow(/identitySalt/);
    expect(() => hashIdentityDate('19900115', '')).toThrow(/identitySalt/);
  });

  test('a dictionary of unsalted hashes no longer matches a salted field (the A-1 attack)', () => {
    const dictionary = new Map(['Alice', 'Bob', 'Carol'].map((n) => [hashString(n).toString(), n]));
    expect(dictionary.get(hashIdentityField('Alice', salt).toString())).toBeUndefined();
  });
});

describe('member wallet derivation with the salt', () => {
  const salt = generateIdentitySalt();

  test('the wallet is the Poseidon of the domain tag and the six salted fields', () => {
    const preimage = memberWalletPreimage(alice, KEY, GROUP, salt);
    expect(preimage).toHaveLength(6);
    expect(preimage[5].toString()).toBe(GROUP.toString());
    expect(preimage[0].toString()).toBe(hashIdentityField('CH-001', salt).toString());
    expect(preimage[1].toString()).toBe(hashIdentityDate('19900115', salt).toString());
    expect(preimage[4].toString()).toBe(hashIdentityField(KEY, salt).toString());
    expect(deriveMemberWalletId(alice, KEY, GROUP, salt).toString()).toBe(Poseidon.hash([DOMAIN_TAG_MEMBER, ...preimage]).toString());
  });

  test('the transition preimage is the padded wallet preimage, and both follow the salt', () => {
    expect(memberTransitionPreimage(alice, KEY, GROUP, salt).map(String)).toEqual(paddedPreimage(DOMAIN_TAG_MEMBER, memberWalletPreimage(alice, KEY, GROUP, salt)).map(String));
    const other = generateIdentitySalt();
    expect(deriveMemberWalletId(alice, KEY, GROUP, other).toString()).not.toBe(deriveMemberWalletId(alice, KEY, GROUP, salt).toString());
    expect(deriveMemberWalletId(alice, KEY, Field(0), salt).toString()).not.toBe(deriveMemberWalletId(alice, KEY, GROUP, salt).toString());
  });

  test('derivation refuses a missing salt', () => {
    expect(() => memberWalletPreimage(alice, KEY, GROUP, '' as string)).toThrow(/identitySalt/);
    expect(() => deriveMemberWalletId(alice, KEY, GROUP, 'xyz')).toThrow(/identitySalt/);
  });

  test('the device helper derives with the salt and scrubs the raw fields', () => {
    const local = { ...alice };
    const result = secureMemberDerivation(local, KEY, GROUP, salt);
    expect(result.walletId.toString()).toBe(deriveMemberWalletId(alice, KEY, GROUP, salt).toString());
    expect(local.firstName).toBe('');
    expect(local.dateOfBirth).toBe('');
    result.dispose();
    expect(result.preimage).toHaveLength(0);
  });
});

describe('fixture people', () => {
  test('get a salt that is a function of the fixture, 32 bytes of hex, distinct per person', () => {
    const salts = MEMBERS.map((m) => fixtureIdentitySalt(m));
    for (const s of salts) expect(isIdentitySalt(s)).toBe(true);
    expect(new Set(salts).size).toBe(salts.length);
    expect(fixtureIdentitySalt(MEMBERS[0])).toBe(fixtureIdentitySalt(MEMBERS[0]));
  });
});
