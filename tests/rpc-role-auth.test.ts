/**
 * The sequencer authorises by principal and role — plan item A9 (remainder), finding A-14.
 *
 * A real L2RpcServer on a random port, with the operator's bearer token configured and two node
 * keys registered by the in-process API the launcher uses. The operator's bearer keeps working with
 * keys registered (alternatives, not modes); a node's signature passes exactly the methods and
 * routes its role lists and is refused the operator's with 403; a replay, a tampered body and the
 * old constant-message signature format are all refused; a handler behind the route gate still
 * receives the body the signature covered.
 */
import { Field, MerkleTree } from 'o1js';
import { createHash, sign as ed25519Sign } from 'crypto';
import { InMemoryStore } from '../src/storage/local-store.js';
import { WALLET_TREE_HEIGHT } from '../src/wallets/wallet-state.js';
import { L2Node } from '../src/l2/l2-node.js';
import { L2RpcServer, RPC_UNAUTHORIZED, RPC_FORBIDDEN } from '../src/l2/l2-rpc-server.js';
import { L2Client, DEFAULT_L2_CLIENT_OPTIONS } from '../src/l2/l2-client.js';
import { generateNodeKey } from '../src/security/node-roles.js';
import { signRequest, privateKeyFromSeedHex } from '../src/security/signed-request.js';
import { readRequestBody } from '../src/security/request-body.js';

jest.setTimeout(60_000);

const OPERATOR = 'operator-bearer-for-tests';
const emptyRoot = new MerkleTree(WALLET_TREE_HEIGHT).getRoot();

let server: L2RpcServer;
let url: string;
const insurer = generateNodeKey('insurer');
const member = generateNodeKey('member');
const stranger = generateNodeKey('stranger');

interface RpcReply { status: number; error?: { code: number; message: string }; result?: unknown }

async function rpcWith(headers: Record<string, string>, body: string): Promise<RpcReply> {
  const r = await fetch(`${url}/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
  const text = await r.text();
  let parsed: any = null;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  return { status: r.status, error: parsed?.error, result: parsed?.result };
}
const envelope = (method: string, params: Record<string, unknown> = {}) => JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
const signedBy = (key: { nodeId: string; seedHex: string }, body: string, path = '/rpc', method = 'POST') =>
  signRequest({ signerId: key.nodeId, privateKey: privateKeyFromSeedHex(key.seedHex), method, path, body });
const bearer = { Authorization: `Bearer ${OPERATOR}` };
const passedTheGate = (reply: RpcReply) => reply.error?.code !== RPC_UNAUTHORIZED && reply.error?.code !== RPC_FORBIDDEN;

beforeAll(async () => {
  const node = new L2Node({ batchIntervalMs: 999_999, autoSettle: false, nodeId: 'seq-under-test' }, new InMemoryStore(), emptyRoot, emptyRoot, Field(0));
  server = new L2RpcServer(node, { port: 0, host: '127.0.0.1', adminToken: OPERATOR, enableSSE: false });
  server.registerNodeKey(insurer.nodeId, insurer.publicKeyHex, 'insurer');
  server.registerNodeKey(member.nodeId, member.publicKeyHex, 'member');
  // An engine-style admin route: the handler reads the body itself, as the engine's handlers do.
  server.registerRoute('POST', '/interactive/update-formulary', async (req, res) => {
    const body = await readRequestBody(req);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ echoed: body }));
  }, { adminOnly: true });
  await server.start();
  url = `http://127.0.0.1:${server.getPort()}`;
});

afterAll(async () => {
  await server.stop();
});

describe('the operator\'s bearer', () => {
  test('still opens every admin method and route with node keys registered', async () => {
    const snap = await rpcWith(bearer, envelope('l2_requestSnapshot'));
    expect(passedTheGate(snap)).toBe(true);
    const clear = await fetch(`${url}/viz/clear`, { method: 'POST', headers: bearer });
    expect(clear.status).toBe(200);
    const route = await fetch(`${url}/interactive/update-formulary`, { method: 'POST', headers: { ...bearer, 'Content-Type': 'application/json' }, body: '{"a":1}' });
    expect(route.status).toBe(200);
    expect(await route.json()).toEqual({ echoed: '{"a":1}' });
  });

  test('a wrong bearer is 401 and does not fall through to the signature path', async () => {
    const body = envelope('l2_requestSnapshot');
    const r = await rpcWith({ Authorization: 'Bearer wrong', ...signedBy(insurer, body) }, body);
    expect(r.error?.code).toBe(RPC_UNAUTHORIZED);
  });

  test('no credential at all is 401 on an admin method and nothing on an open one', async () => {
    const r = await rpcWith({}, envelope('l2_requestSnapshot'));
    expect(r.error?.code).toBe(RPC_UNAUTHORIZED);
    const open = await rpcWith({}, envelope('l2_getAdminKeys'));
    expect(passedTheGate(open)).toBe(true);
    expect(Array.isArray(open.result)).toBe(true);
  });
});

describe('a node\'s key', () => {
  test('the insurer passes its own methods and is refused the operator\'s with 403', async () => {
    const mine = envelope('l2_deletePlan', { planId: 'PLAN-THAT-DOES-NOT-EXIST' });
    const ok = await rpcWith(signedBy(insurer, mine), mine);
    expect(passedTheGate(ok)).toBe(true);
    const theirs = envelope('l2_forceBatch');
    const no = await rpcWith(signedBy(insurer, theirs), theirs);
    expect(no.error?.code).toBe(RPC_FORBIDDEN);
    expect(no.error?.message).toMatch(/role insurer may not call l2_forceBatch/);
  });

  test('the member may register its encryption key and nothing else', async () => {
    const mine = envelope('l2_registerEntity', { walletId: '1', publicKey: 'x' });
    const ok = await rpcWith(signedBy(member, mine), mine);
    expect(passedTheGate(ok)).toBe(true);
    const theirs = envelope('l2_credentialProvider', { walletId: '1' });
    const no = await rpcWith(signedBy(member, theirs), theirs);
    expect(no.error?.code).toBe(RPC_FORBIDDEN);
  });

  test('an unregistered signer is 401, whatever it signs', async () => {
    const body = envelope('l2_registerEntity', { walletId: '1' });
    const r = await rpcWith(signedBy(stranger, body), body);
    expect(r.error?.code).toBe(RPC_UNAUTHORIZED);
    expect(r.error?.message).toMatch(/unknown signer/);
  });

  test('the signature covers the body: a tampered envelope is refused', async () => {
    const signedBody = envelope('l2_deletePlan', { planId: 'A' });
    const sentBody = envelope('l2_deletePlan', { planId: 'B' });
    const r = await rpcWith(signedBy(insurer, signedBody), sentBody);
    expect(r.error?.code).toBe(RPC_UNAUTHORIZED);
    expect(r.error?.message).toMatch(/content hash/);
  });

  test('a replayed signature is refused the second time', async () => {
    const body = envelope('l2_deletePlan', { planId: 'REPLAY' });
    const headers = signedBy(insurer, body);
    const first = await rpcWith(headers, body);
    expect(passedTheGate(first)).toBe(true);
    const second = await rpcWith(headers, body);
    expect(second.error?.code).toBe(RPC_UNAUTHORIZED);
  });

  test('the old constant-message and method|paramsHash formats are no longer accepted', async () => {
    const body = envelope('l2_deletePlan', { planId: 'LEGACY' });
    const ts = String(Date.now());
    const paramsHash = createHash('sha256').update(JSON.stringify({ planId: 'LEGACY' })).digest('hex');
    const legacy = ed25519Sign(null, Buffer.from(`l2_deletePlan|${paramsHash}|${ts}`), privateKeyFromSeedHex(insurer.seedHex)).toString('hex');
    const r = await rpcWith({ 'X-Admin-Signature': `${insurer.nodeId}:${ts}:${legacy}` }, body);
    expect(r.error?.code).toBe(RPC_UNAUTHORIZED);
    const constant = ed25519Sign(null, Buffer.from(`admin-endpoint|${createHash('sha256').update('{}').digest('hex')}|${ts}`), privateKeyFromSeedHex(insurer.seedHex)).toString('hex');
    const route = await fetch(`${url}/viz/clear`, { method: 'POST', headers: { 'X-Admin-Signature': `${insurer.nodeId}:${ts}:${constant}` } });
    expect(route.status).toBe(401);
  });
});

describe('admin-gated HTTP routes', () => {
  test('the insurer may call the engine actions its role lists, and the handler receives the signed body', async () => {
    const body = JSON.stringify({ ndcHash: '1', newTier: 2 });
    const headers = signedBy(insurer, body, '/interactive/update-formulary');
    const r = await fetch(`${url}/interactive/update-formulary`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ echoed: body });
  });

  test('the insurer is refused an operator route with 403, and the member is refused the insurer\'s', async () => {
    const r = await fetch(`${url}/viz/clear`, { method: 'POST', headers: signedBy(insurer, '', '/viz/clear') });
    expect(r.status).toBe(403);
    expect((await r.json()).error).toMatch(/role insurer may not call POST \/viz\/clear/);
    const body = JSON.stringify({ ndcHash: '1' });
    const m = await fetch(`${url}/interactive/update-formulary`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...signedBy(member, body, '/interactive/update-formulary') }, body });
    expect(m.status).toBe(403);
  });

  test('a signature over another path or an unsigned call is 401', async () => {
    const body = JSON.stringify({ ndcHash: '1' });
    const wrongPath = await fetch(`${url}/interactive/update-formulary`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...signedBy(insurer, body, '/interactive/plan-year-rollover') }, body });
    expect(wrongPath.status).toBe(401);
    const bare = await fetch(`${url}/interactive/update-formulary`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    expect(bare.status).toBe(401);
  });
});

describe('the client', () => {
  test('signs with the node key in the shared format, and the role decides', async () => {
    const asInsurer = new L2Client({ ...DEFAULT_L2_CLIENT_OPTIONS, sequencerUrl: url, maxRetries: 0, adminPrivateKeyHex: insurer.seedHex, adminNodeId: insurer.nodeId });
    // The gate passed (the handler's own complaint is about the parameters, not the credential).
    await expect(asInsurer.updateProviderStatus('1', 2)).rejects.toThrow(/RPC error -326/);
    // The gate refused: the method is the operator's, so the handler never ran.
    await expect(asInsurer.forceBatch()).rejects.toThrow(new RegExp(`RPC error ${RPC_FORBIDDEN}`));
    const asStranger = new L2Client({ ...DEFAULT_L2_CLIENT_OPTIONS, sequencerUrl: url, maxRetries: 0, adminPrivateKeyHex: stranger.seedHex, adminNodeId: stranger.nodeId });
    await expect(asStranger.updateProviderStatus('1', 2)).rejects.toThrow(new RegExp(`RPC error ${RPC_UNAUTHORIZED}`));
  });
});

describe('registry hygiene', () => {
  test('node keys registered for this boot are listed with their role and never persisted', () => {
    const listed = server.getAdminKeyRegistry().get('insurer');
    expect(listed?.role).toBe('insurer');
    expect(listed?.ephemeral).toBe(true);
    const persisted = server.getAdminRegistryState();
    expect(persisted.keys.find((k) => k.nodeId === 'insurer')).toBeUndefined();
    expect(persisted.keys.find((k) => k.nodeId === 'member')).toBeUndefined();
  });

  test('a node id with the header separator or a malformed key is refused at registration', () => {
    expect(() => server.registerNodeKey('a:b', insurer.publicKeyHex, 'member')).toThrow();
    expect(() => server.registerNodeKey('ok', 'nothex', 'member')).toThrow();
  });
});
