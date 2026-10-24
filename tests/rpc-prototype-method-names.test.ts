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
 * A JSON-RPC method named after an Object.prototype member gets the unknown-method answer, as any unknown method does
 * (round eight of the security fixes, confirmed by its review, 2026-10-24).
 *
 * What was wrong: the sequencer's wallet gate looked a method up in WALLET_SIGNED_METHODS as a plain object
 * (L2RpcServer.walletSpokenFor), so a method named toString, constructor, __proto__, valueOf or hasOwnProperty found
 * Object.prototype's member there, and splitting it as a parameter path threw. The gate runs before the dispatcher's try,
 * so the throw reached the server's last-resort handler and the caller got a plain-text HTTP 500, where an unknown method
 * gets JSON-RPC's -32601. Round eight's sequencer lane noticed it while it added l2_getAttestation to that table; the
 * review of round eight confirmed it, with each of those names answered HTTP 500.
 *
 * Making the fix, three envelopes were found to throw the same way, before the same try: a null body (the structure
 * check read its jsonrpc), a method sent as a list (["toString"] is "toString" to a property lookup) and params sent as
 * a string to a gated method (the gates write the verified caller onto the params, which a string cannot take). Each
 * answered HTTP 500.
 *
 * Now the gate reads only the table's own methods, as the D1 table's lookup already did (memberDataSpecOf), so those
 * names reach the dispatcher and get "Unknown method"; and the structure check refuses an envelope that is not an object,
 * a method that is not a string and params that are neither an object nor a list with JSON-RPC's -32600 (a method sent
 * as a number, which the dispatcher answered as unknown, gets that answer too). Params sent as a list or as null are
 * read as before.
 *
 * A real L2RpcServer on a random port with the operator's token; no proof, no entity.
 */
import { Field } from 'o1js';
import { InMemoryStore } from '../src/storage/local-store.js';
import { L2Node } from '../src/l2/l2-node.js';
import { L2RpcServer, RPC_INVALID_REQUEST, RPC_METHOD_NOT_FOUND, RPC_UNAUTHORIZED } from '../src/l2/l2-rpc-server.js';

jest.setTimeout(60_000);

const OPERATOR = 'operator-token-for-prototype-method-names';
const WALLET = '79000000000000000123';
/** Every member Object.prototype gives a plain object, the ones named by the review first. */
const PROTOTYPE_NAMES = ['toString', 'constructor', '__proto__', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString', '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__'];

let node: L2Node;
let server: L2RpcServer;
let url: string;
let rpcId = 0;

interface Reply { status: number; text: string; error?: { code: number; message: string }; result?: any }
async function post(body: string, headers: Record<string, string> = {}): Promise<Reply> {
  const r = await fetch(`${url}/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
  const text = await r.text();
  let parsed: any = null;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  return { status: r.status, text, error: parsed?.error, result: parsed?.result };
}
const envelope = (method: unknown, params: unknown = {}) => JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params });
const bearer = { Authorization: `Bearer ${OPERATOR}` };

beforeAll(async () => {
  node = new L2Node({ batchIntervalMs: 999_999, autoSettle: false, nodeId: 'seq-prototype-names' }, new InMemoryStore(), Field(1000), Field(2000), Field(0));
  server = new L2RpcServer(node, { port: 0, host: '127.0.0.1', adminToken: OPERATOR, enableSSE: false });
  await server.start();
  url = `http://127.0.0.1:${server.getPort()}`;
});

afterAll(async () => { await server?.stop(); });

describe('the wallet gate\'s lookup', () => {
  test('reads only the table\'s own methods: a name Object.prototype carries is no method that speaks for a wallet', () => {
    for (const name of PROTOTYPE_NAMES) {
      let thrown = '';
      let spoken: string | undefined = 'not read';
      try { spoken = L2RpcServer.walletSpokenFor(name, { walletId: WALLET }); } catch (err) { thrown = (err as Error).message; }
      expect([name, thrown]).toEqual([name, '']);              // before: "where.split is not a function or its return value is not iterable"
      expect([name, spoken]).toEqual([name, undefined]);       // before: nothing; the lookup threw
    }
  });

  test('still finds the methods that speak for a wallet, and the wallet each names', () => {
    expect(L2RpcServer.walletSpokenFor('l2_requestAttestation', { walletId: WALLET })).toBe(WALLET);
    expect(L2RpcServer.walletSpokenFor('l2_getAttestation', {})).toBe('');
    expect(L2RpcServer.walletSpokenFor('l2_storeMessage', { message: { senderWalletId: WALLET } })).toBe(WALLET);
    expect(L2RpcServer.walletSpokenFor('l2_getStatus', { walletId: WALLET })).toBeUndefined();
  });
});

describe('the sequencer\'s /rpc', () => {
  test('answers a method named after an Object.prototype member as it answers any unknown method, not with an HTTP 500', async () => {
    const unknown = await post(envelope('l2_noSuchMethod'));
    expect(unknown.status).toBe(200);
    expect(unknown.error).toEqual({ code: RPC_METHOD_NOT_FOUND, message: 'Unknown method: l2_noSuchMethod' });
    for (const name of PROTOTYPE_NAMES) {
      const r = await post(envelope(name));
      expect([name, r.status]).toEqual([name, 200]);   // before: 500, the body the text "Internal Server Error"
      expect([name, r.error]).toEqual([name, { code: RPC_METHOD_NOT_FOUND, message: `Unknown method: ${name}` }]); // before: no JSON-RPC error
    }
  });

  test('still holds a method that speaks for a wallet to that wallet\'s signature', async () => {
    const r = await post(envelope('l2_requestAttestation', { walletId: WALLET }));
    expect(r.status).toBe(200);
    expect(r.error?.code).toBe(RPC_UNAUTHORIZED);
  });

  test('answers an envelope that is not an object, a method that is not a string and params that are not an object or a list with the invalid-request answer', async () => {
    const invalid = { code: RPC_INVALID_REQUEST, message: 'Invalid JSON-RPC 2.0 request' };
    const nullBody = await post('null');
    expect(nullBody.status).toBe(200);                 // before: 500; the structure check read null's jsonrpc
    expect(nullBody.error).toEqual(invalid);           // before: no JSON-RPC error
    const listMethod = await post(envelope(['toString']));
    expect(listMethod.status).toBe(200);               // before: 500; ["toString"] found Object.prototype's toString in the wallet gate's table
    expect(listMethod.error).toEqual(invalid);         // before: no JSON-RPC error
    const numberMethod = await post(envelope(7));
    expect(numberMethod.error).toEqual(invalid);       // before: { code: -32601, message: 'Unknown method: 7' }
    // params the gates write the verified caller onto: the admin gate's and the read gate's
    const adminParams = await post(envelope('l2_forceBatch', 'abc'), bearer);
    expect(adminParams.status).toBe(200);              // before: 500; the admin gate wrote _verifiedRole onto a string
    expect(adminParams.error).toEqual(invalid);        // before: no JSON-RPC error
    const readParams = await post(envelope('l2_getAuditLog', 'abc'), bearer);
    expect(readParams.status).toBe(200);               // before: 500; the read gate wrote _reader onto a string
    expect(readParams.error).toEqual(invalid);         // before: no JSON-RPC error
    expect((await post(envelope('l2_getStatus', 42))).error).toEqual(invalid); // before: the status; the params went unread
  });

  test('still reads params sent as a list or as null, and an envelope that leaves them out', async () => {
    for (const params of [[], null, undefined]) {
      const r = await post(JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'l2_getStatus', ...(params === undefined ? {} : { params }) }));
      expect([params, r.status, r.error]).toEqual([params, 200, undefined]);
      expect(r.result).toHaveProperty('totalProofsAccepted');
    }
  });
});
